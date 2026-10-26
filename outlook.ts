// The text outlook at the top of /weather/forecast, also served as JSON at
// /api/weather/outlook (for a Siri Shortcut): a few sentences for the current period
// and the next. Days run sunrise to sunset and nights sunset to sunrise, so in the
// day it covers the rest of today and tonight, and after sunset tonight and
// tomorrow.
//
// Temperatures are our estimate (see estimate.ts) where it has the hour, otherwise
// the average of its base sources (NWS, NBM, HRRR). Wind and rain are always that
// average, from each source's latest forecast. Nights give the low and the
// temperature at 7 am, even when 7 am is after sunrise; days give the low and high,
// and the wind. Both give the chance of rain.

import db from './db/index.ts';
import { BASE_SOURCES } from './estimate.ts';
import { fromSqliteUtc, startOfHour, toSqliteUtc } from './forecast.ts';
import type { ForecastSource } from './forecast.ts';
import { sunEventsBetween } from './sun.ts';

const HOUR_MS = 3600 * 1000;
const STALE_MS = 3 * HOUR_MS; // forecasts fetched longer ago than this aren't used
const WAKE_HOUR = 7;
const CALM_MPH = 3;
const RAIN_CHANCE_PCT = 20; // below this (and no measurable amount), "no rain expected"
const RAIN_LIKELY_PCT = 60;
const MEASURABLE_IN = 0.01;

const pacificHourFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hour: 'numeric',
  hourCycle: 'h23',
});
const pacificDateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' });
const pacificTimeFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hour: 'numeric',
  minute: '2-digit',
});

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

interface OutlookHour {
  at: number; // ms, top of the hour
  tempF: number | null;
  windMph: number | null;
  windDirDeg: number | null;
  gustMph: number | null;
  precipProbPct: number | null;
  precipIn: number | null; // in the hour ending at `at`
}

export interface TempAt {
  tempF: number;
  at: string; // ISO
}

export interface OutlookWind {
  minMph: number;
  maxMph: number;
  direction: string | null; // at the strongest hour; null when calm
  strongestAt: string; // ISO
  gustMph: number | null;
}

export interface OutlookRain {
  maxChancePct: number | null;
  totalIn: number | null;
  startsAt: string | null; // ISO; first hour with at least a RAIN_CHANCE_PCT chance
}

export interface OutlookPeriod {
  kind: 'day' | 'night';
  label: string; // "Today", "Tonight", "Tomorrow"
  start: string; // ISO, sunrise or sunset (or now, for the current period)
  end: string; // ISO
  low: TempAt | null;
  high: TempAt | null; // days only
  atWake: TempAt | null; // nights only: 7 am
  wind: OutlookWind | null; // days only
  rain: OutlookRain;
  text: string;
}

export interface Outlook {
  madeAt: string; // ISO
  periods: OutlookPeriod[];
  text: string; // every period's text, with its label, for reading aloud
}

function pacificHour(ms: number): number {
  return Number(pacificHourFormat.format(new Date(ms)));
}

function pacificDate(ms: number): string {
  return pacificDateFormat.format(new Date(ms));
}

// "7 am", "2 pm", "noon", or "6:12 pm" off the hour.
function clockTime(ms: number): string {
  const time = pacificTimeFormat.format(new Date(ms)).replace(':00', '').replace(' AM', ' am').replace(' PM', ' pm');
  return time === '12 pm' ? 'noon' : time === '12 am' ? 'midnight' : time;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

function present(values: Array<number | null>): number[] {
  return values.filter((v): v is number => v !== null);
}

// Wind direction averaged as vectors weighted by speed, so 350° and 10° make north.
function averageDirection(winds: Array<{ mph: number; deg: number }>): number | null {
  let x = 0;
  let y = 0;
  for (const { mph, deg } of winds) {
    x += mph * Math.sin(deg * Math.PI / 180);
    y += mph * Math.cos(deg * Math.PI / 180);
  }
  return x || y ? (Math.atan2(x, y) * 180 / Math.PI + 360) % 360 : null;
}

interface HourRow {
  source: ForecastSource;
  valid_at: string;
  temp_f: number | null;
  wind_mph: number | null;
  wind_dir_deg: number | null;
  gust_mph: number | null;
  precip_prob_pct: number | null;
  precip_in: number | null;
}

// The hours from the current one on: each base source's latest live forecast,
// averaged, with our estimate's temperature where it has one.
function loadHours(now: Date): OutlookHour[] {
  const since = toSqliteUtc(new Date(now.getTime() - STALE_MS));
  const sources: ForecastSource[] = [...BASE_SOURCES, 'estimate'];
  const rows = db.prepare(`
    SELECT s.source, h.valid_at, h.temp_f, h.wind_mph, h.wind_dir_deg, h.gust_mph,
      h.precip_prob_pct, h.precip_in
    FROM forecast_hours h
    JOIN forecast_snapshots s ON s.id = h.snapshot_id
    WHERE s.id IN (
      SELECT MAX(id) FROM forecast_snapshots
      WHERE kind = 'live' AND fetched_at >= ? AND source IN (${sources.map(() => '?').join(', ')})
      GROUP BY source
    ) AND h.valid_at >= ?
    ORDER BY h.valid_at
  `).all(since, ...sources, toSqliteUtc(startOfHour(now))) as HourRow[];

  const byHour = new Map<string, HourRow[]>();
  for (const row of rows) {
    byHour.set(row.valid_at, [...(byHour.get(row.valid_at) ?? []), row]);
  }
  return [...byHour].map(([validAt, hourRows]) => {
    const base = hourRows.filter((r) => r.source !== 'estimate');
    const estimate = hourRows.find((r) => r.source === 'estimate')?.temp_f ?? null;
    const winds = base.flatMap((r) => r.wind_mph !== null && r.wind_dir_deg !== null
      ? [{ mph: r.wind_mph, deg: r.wind_dir_deg }] : []);
    return {
      at: fromSqliteUtc(validAt).getTime(),
      tempF: estimate ?? average(present(base.map((r) => r.temp_f))),
      windMph: average(present(base.map((r) => r.wind_mph))),
      windDirDeg: averageDirection(winds),
      gustMph: average(present(base.map((r) => r.gust_mph))),
      precipProbPct: average(present(base.map((r) => r.precip_prob_pct))),
      precipIn: average(present(base.map((r) => r.precip_in))),
    };
  });
}

// The first hour with the lowest (or highest) temperature, rounded to whole degrees.
function extreme(hours: OutlookHour[], pick: 'low' | 'high'): TempAt | null {
  let best: { tempF: number; at: number } | null = null;
  for (const { at, tempF } of hours) {
    if (tempF === null) {
      continue;
    }
    const rounded = Math.round(tempF);
    if (!best || (pick === 'low' ? rounded < best.tempF : rounded > best.tempF)) {
      best = { tempF: rounded, at };
    }
  }
  return best && { tempF: best.tempF, at: new Date(best.at).toISOString() };
}

function windSummary(hours: OutlookHour[]): OutlookWind | null {
  const winds = hours.filter((h): h is OutlookHour & { windMph: number } => h.windMph !== null);
  if (!winds.length) {
    return null;
  }
  const strongest = winds.reduce((a, b) => (b.windMph > a.windMph ? b : a));
  const gusts = present(hours.map((h) => h.gustMph));
  return {
    minMph: Math.round(Math.min(...winds.map((h) => h.windMph))),
    maxMph: Math.round(strongest.windMph),
    direction: strongest.windMph >= CALM_MPH && strongest.windDirDeg !== null
      ? COMPASS[Math.round(strongest.windDirDeg / 45) % 8]
      : null,
    strongestAt: new Date(strongest.at).toISOString(),
    gustMph: gusts.length ? Math.round(Math.max(...gusts)) : null,
  };
}

// Rain over the hours in (start, end]: each hour's amount is for the hour before it.
function rainSummary(hours: OutlookHour[], startMs: number, endMs: number): OutlookRain {
  const inPeriod = hours.filter((h) => h.at > startMs && h.at <= endMs);
  const chances = present(inPeriod.map((h) => h.precipProbPct));
  const amounts = present(inPeriod.map((h) => h.precipIn));
  const first = inPeriod.find((h) => (h.precipProbPct ?? 0) >= RAIN_CHANCE_PCT);
  return {
    maxChancePct: chances.length ? Math.round(Math.max(...chances)) : null,
    totalIn: amounts.length ? Math.round(amounts.reduce((a, b) => a + b, 0) * 100) / 100 : null,
    startsAt: first ? new Date(first.at - HOUR_MS).toISOString() : null,
  };
}

function rainText(rain: OutlookRain, startMs: number): string {
  const chance = rain.maxChancePct ?? 0;
  const total = rain.totalIn ?? 0;
  if (chance < RAIN_CHANCE_PCT && total < MEASURABLE_IN) {
    return 'No rain expected.';
  }
  const startsAt = rain.startsAt ? Date.parse(rain.startsAt) : null;
  const when = startsAt !== null && startsAt > startMs + HOUR_MS ? ` after ${clockTime(startsAt)}` : '';
  const amount = total >= MEASURABLE_IN ? `, about ${total.toFixed(2)} inches` : '';
  const odds = chance >= RAIN_LIKELY_PCT ? 'Rain likely' : 'A chance of rain';
  return `${odds}${when} (${chance}%)${amount}.`;
}

function windText(wind: OutlookWind): string {
  const gusts = wind.gustMph !== null && wind.gustMph > wind.maxMph ? `, with gusts up to ${wind.gustMph} mph` : '';
  if (wind.maxMph < CALM_MPH) {
    return `Winds light, under ${CALM_MPH} mph${gusts}.`;
  }
  const speed = wind.minMph === wind.maxMph ? `at ${wind.maxMph} mph` : `at ${wind.minMph}–${wind.maxMph} mph`;
  const peak = wind.minMph === wind.maxMph ? '' : `, strongest around ${clockTime(Date.parse(wind.strongestAt))}`;
  return `Winds out of the ${wind.direction} ${speed}${peak}${gusts}.`;
}

// `firstMs` is the period's first hour; when the low is then and the day is already
// under way, it's just the next hour's temperature, not a morning low.
function dayText(low: TempAt | null, high: TempAt | null, firstMs: number, underway: boolean, endMs: number): string {
  if (!low || !high) {
    return '';
  }
  const lowAt = Date.parse(low.at);
  const highAt = Date.parse(high.at);
  if (low.tempF === high.tempF) {
    return `Steady around ${high.tempF}°.`;
  }
  if (lowAt < highAt) {
    const start = underway && lowAt === firstMs
      ? `${low.tempF}° at ${clockTime(lowAt)}`
      : `Low of ${low.tempF}° around ${clockTime(lowAt)}`;
    return `${start}, rising to a high of ${high.tempF}° around ${clockTime(highAt)}.`;
  }
  // The high has come already (the rest of the afternoon): it cools toward sunset.
  return `High of ${high.tempF}° around ${clockTime(highAt)}, cooling to ${low.tempF}° by ${clockTime(Math.min(lowAt, endMs))}.`;
}

function nightText(low: TempAt | null, atWake: TempAt | null): string {
  if (!low) {
    return atWake ? `${atWake.tempF}° at ${clockTime(Date.parse(atWake.at))}.` : '';
  }
  const lowText = `Low of ${low.tempF}° around ${clockTime(Date.parse(low.at))}`;
  if (!atWake) {
    return `${lowText}.`;
  }
  const wake = clockTime(Date.parse(atWake.at));
  if (atWake.at === low.at) {
    return `Low of ${low.tempF}° at ${wake}.`;
  }
  return atWake.tempF === low.tempF
    ? `${lowText}, still ${atWake.tempF}° at ${wake}.`
    : `${lowText}, ${atWake.tempF}° by ${wake}.`;
}

function label(kind: 'day' | 'night', startMs: number, nowMs: number): string {
  if (kind === 'night') {
    return 'Tonight';
  }
  return pacificDate(startMs) === pacificDate(nowMs) ? 'Today' : 'Tomorrow';
}

function buildPeriod(
  kind: 'day' | 'night',
  startMs: number,
  endMs: number,
  hours: OutlookHour[],
  nowMs: number,
): OutlookPeriod | null {
  // Temperatures at the hours inside the period, from the next hour on.
  // Left out unless the forecast runs to the period's last hour.
  const inPeriod = hours.filter((h) => h.at >= startMs && h.at <= endMs && h.at > nowMs);
  const lastAt = inPeriod.filter((h) => h.tempF !== null).at(-1)?.at;
  if (lastAt === undefined || lastAt < endMs - HOUR_MS) {
    return null;
  }
  const low = extreme(inPeriod, 'low');
  const rain = rainSummary(hours, Math.max(startMs, nowMs), endMs);
  const sentences: string[] = [];
  let high: TempAt | null = null;
  let atWake: TempAt | null = null;
  let wind: OutlookWind | null = null;
  if (kind === 'day') {
    high = extreme(inPeriod, 'high');
    wind = windSummary(inPeriod);
    sentences.push(dayText(low, high, inPeriod[0].at, startMs < nowMs, endMs));
    if (wind) {
      sentences.push(windText(wind));
    }
  } else {
    // The first 7 am after the night starts, even if the sun is up by then.
    const wake = hours.find((h) => h.at > startMs && h.at > nowMs && pacificHour(h.at) === WAKE_HOUR);
    atWake = wake?.tempF != null ? { tempF: Math.round(wake.tempF), at: new Date(wake.at).toISOString() } : null;
    sentences.push(nightText(low, atWake));
  }
  sentences.push(rainText(rain, Math.max(startMs, nowMs)));
  return {
    kind,
    label: label(kind, startMs, nowMs),
    start: new Date(Math.max(startMs, nowMs)).toISOString(),
    end: new Date(endMs).toISOString(),
    low,
    high,
    atWake,
    wind,
    rain,
    text: sentences.filter(Boolean).join(' '),
  };
}

// The current period and the next, or null when there's no recent forecast.
export function getOutlook(now: Date): Outlook | null {
  const nowMs = now.getTime();
  const hours = loadHours(now);
  if (!hours.length) {
    return null;
  }
  // Sunrises and sunsets from the last one before now through the next two.
  const events = sunEventsBetween(nowMs - 24 * HOUR_MS, nowMs + 48 * HOUR_MS)
    .filter((e) => e.type === 'sunrise' || e.type === 'sunset');
  const currentIndex = events.filter((e) => e.at <= nowMs).length - 1;
  const periods: OutlookPeriod[] = [];
  for (let i = currentIndex; i < currentIndex + 2 && i + 1 < events.length; i++) {
    const kind = events[i].type === 'sunrise' ? 'day' : 'night';
    const period = buildPeriod(kind, events[i].at, events[i + 1].at, hours, nowMs);
    if (period) {
      periods.push(period);
    }
  }
  if (!periods.length) {
    return null;
  }
  return {
    madeAt: now.toISOString(),
    periods,
    text: periods.map((p) => `${p.label}: ${p.text}`).join(' '),
  };
}
