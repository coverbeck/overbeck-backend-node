// The text outlook at the top of /weather/forecast, also served as JSON at
// /api/weather/outlook (for a Siri Shortcut): a few sentences for the current period
// and the next. Days run sunrise to sunset and nights sunset to sunrise, so in the
// day it covers the rest of today and tonight, and after sunset tonight and
// tomorrow.
//
// Temperatures are our estimate (see estimate.ts) where it has the hour, otherwise
// the average of its base sources (NWS, NBM, HRRR). Wind and rain are always that
// average, from each source's latest forecast. Each period starts from the
// temperature after sunset or sunrise, or the station's current reading once it's
// under way (live from Ambient, like the Current page, else the latest saved one;
// the :10 job saves readings only hourly). Nights go on to the low and the temperature at 7 am (even when that's
// after sunrise); days to the high and the temperature at sunset, then the wind.
// Both give the chance of rain.

import db from './db/index.ts';
import { BASE_SOURCES } from './estimate.ts';
import { fromSqliteUtc, startOfHour, toSqliteUtc } from './forecast.ts';
import type { ForecastSource } from './forecast.ts';
import { sunEventsBetween } from './sun.ts';
import { getCurrentWeather } from './weather.ts';

const HOUR_MS = 3600 * 1000;
const STALE_MS = 3 * HOUR_MS; // forecasts fetched longer ago than this aren't used
const WAKE_HOUR = 7;
const CURRENT_MS = 30 * 60 * 1000; // a station reading this recent counts as current
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

export interface Opening extends TempAt {
  current: boolean; // the station's reading now, rather than a forecast hour
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
  opening: Opening;
  low: TempAt | null; // nights only
  atWake: TempAt | null; // nights only: 7 am
  high: TempAt | null; // days only
  atSunset: TempAt | null; // days only: the last hour before sunset
  wind: OutlookWind | null; // days only
  rain: OutlookRain;
  text: string;
}

export interface Outlook {
  madeAt: string; // ISO
  periods: OutlookPeriod[];
  text: string; // every period's text, for reading aloud
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

// The station's live reading from Ambient, or null if the request fails.
export async function liveStationTemp(): Promise<TempAt | null> {
  try {
    const { outdoorTemp, date } = await getCurrentWeather();
    return { tempF: Math.round(outdoorTemp), at: new Date(date).toISOString() };
  } catch (err) {
    console.error(`Live station reading for the outlook failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// The station's latest saved temperature, if it's recent enough to call current.
function savedStationTemp(now: Date): TempAt | null {
  const row = db.prepare(`
    SELECT observed_at, temp_f FROM station_readings
    WHERE temp_f IS NOT NULL AND observed_at >= ? AND observed_at <= ?
    ORDER BY observed_at DESC LIMIT 1
  `).get(toSqliteUtc(new Date(now.getTime() - CURRENT_MS)), toSqliteUtc(now)) as
    { observed_at: string; temp_f: number } | undefined;
  return row ? { tempF: Math.round(row.temp_f), at: fromSqliteUtc(row.observed_at).toISOString() } : null;
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

function tempAt(hour: OutlookHour & { tempF: number }): TempAt {
  return { tempF: Math.round(hour.tempF), at: new Date(hour.at).toISOString() };
}

// "Sunset, at 6:12 pm", to the nearest minute.
function sunTime(event: 'sunrise' | 'sunset', ms: number): string {
  return `${event}, at ${clockTime(Math.round(ms / 60000) * 60000)}`;
}

// "Tonight's temperature will be 60° after sunset, at 6:12 pm", or "Current
// temperature is 58°". `startMs` is null when the outlook has already given the time.
function openingText(opening: Opening, label: string, kind: 'day' | 'night', startMs: number | null, firstHour: boolean): string {
  if (opening.current) {
    return `Current temperature is ${opening.tempF}°`;
  }
  const event = kind === 'night' ? 'sunset' : 'sunrise';
  const when = !firstHour
    ? `at ${clockTime(Date.parse(opening.at))}`
    : startMs === null ? `after ${event}` : `after ${sunTime(event, startMs)}`;
  return `${label}'s temperature will be ${opening.tempF}° ${when}`;
}

// "…, dropping to a low of 50° around 4 am, then 52° at 7 am." When 7 am rounds to
// the low (about half of nights, from the station's history), it's "a low of 51° by
// 7 am"; a degree above, "about the same at 7 am".
function nightText(opening: Opening, low: TempAt | null, atWake: TempAt | null): string {
  if (!low) {
    return '';
  }
  const lowTime = clockTime(Date.parse(low.at));
  if (!atWake) {
    return low.tempF < opening.tempF ? `, dropping to a low of ${low.tempF}° around ${lowTime}` : '';
  }
  const wake = clockTime(Date.parse(atWake.at));
  if (low.tempF >= opening.tempF) {
    return atWake.tempF > opening.tempF + 1
      ? `, rising to ${atWake.tempF}° by ${wake}`
      : `, holding near ${opening.tempF}° through ${wake}`;
  }
  if (atWake.tempF === low.tempF) {
    return `, dropping to a low of ${low.tempF}° by ${wake}`;
  }
  const after = atWake.tempF === low.tempF + 1 ? `about the same at ${wake}` : `then ${atWake.tempF}° at ${wake}`;
  return `, dropping to a low of ${low.tempF}° around ${lowTime}, ${after}`;
}

// "…, rising to a high of 71° around 3 pm, then 65° by sunset, at 6:12 pm."
function dayText(opening: Opening, high: TempAt | null, atSunset: TempAt | null, endMs: number): string {
  if (!high || !atSunset) {
    return '';
  }
  const sunset = sunTime('sunset', endMs);
  if (high.tempF > opening.tempF) {
    return high.at === atSunset.at
      ? `, rising to a high of ${high.tempF}° by ${sunset}`
      : `, rising to a high of ${high.tempF}° around ${clockTime(Date.parse(high.at))}, then ${atSunset.tempF}° by ${sunset}`;
  }
  // Past the warmest part of the day.
  return atSunset.tempF < opening.tempF
    ? `, cooling to ${atSunset.tempF}° by ${sunset}`
    : `, holding near ${opening.tempF}° until ${sunset}`;
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
  station: TempAt | null,
  nowMs: number,
  startNamed: boolean,
): OutlookPeriod | null {
  // Temperatures at the hours inside the period, from the next hour on.
  // Left out unless the forecast runs to the period's last hour.
  const inPeriod = hours.filter((h) => h.at >= startMs && h.at <= endMs && h.at > nowMs);
  const lastAt = inPeriod.filter((h) => h.tempF !== null).at(-1)?.at;
  if (lastAt === undefined || lastAt < endMs - HOUR_MS) {
    return null;
  }
  const temps = inPeriod.filter((h): h is OutlookHour & { tempF: number } => h.tempF !== null);
  const periodLabel = label(kind, startMs, nowMs);
  const underway = startMs < nowMs;
  const opening: Opening = underway && station
    ? { ...station, current: true }
    : { ...tempAt(temps[0]), current: false };
  const rain = rainSummary(hours, Math.max(startMs, nowMs), endMs);
  let low: TempAt | null = null;
  let atWake: TempAt | null = null;
  let high: TempAt | null = null;
  let atSunset: TempAt | null = null;
  let wind: OutlookWind | null = null;
  let temperature = openingText(opening, periodLabel, kind, startNamed ? null : startMs, !underway);
  if (kind === 'day') {
    high = extreme(inPeriod, 'high');
    atSunset = tempAt(temps[temps.length - 1]);
    wind = windSummary(inPeriod);
    temperature += dayText(opening, high, atSunset, endMs);
  } else {
    low = extreme(inPeriod, 'low');
    // The first 7 am after the night starts, even if the sun is up by then.
    const wake = hours.find((h): h is OutlookHour & { tempF: number } =>
      h.at > startMs && h.at > nowMs && h.tempF !== null && pacificHour(h.at) === WAKE_HOUR);
    atWake = wake ? tempAt(wake) : null;
    temperature += nightText(opening, low, atWake);
  }
  const sentences = [`${temperature}.`, wind ? windText(wind) : '', rainText(rain, Math.max(startMs, nowMs))];
  return {
    kind,
    label: periodLabel,
    start: new Date(Math.max(startMs, nowMs)).toISOString(),
    end: new Date(endMs).toISOString(),
    opening,
    low,
    atWake,
    high,
    atSunset,
    wind,
    rain,
    text: sentences.filter(Boolean).join(' '),
  };
}

// The current period and the next, or null when there's no recent forecast.
// `live` is the station's live reading, used when it's recent enough to call current.
export function getOutlook(now: Date, live: TempAt | null = null): Outlook | null {
  const nowMs = now.getTime();
  const hours = loadHours(now);
  if (!hours.length) {
    return null;
  }
  // Sunrises and sunsets from the last one before now through the next three. The
  // current period has no hours left in the last minutes before sunrise or sunset,
  // and then the two after it are shown.
  const events = sunEventsBetween(nowMs - 24 * HOUR_MS, nowMs + 48 * HOUR_MS)
    .filter((e) => e.type === 'sunrise' || e.type === 'sunset');
  const currentIndex = events.filter((e) => e.at <= nowMs).length - 1;
  const station = live && now.getTime() - Date.parse(live.at) <= CURRENT_MS ? live : savedStationTemp(now);
  const periods: OutlookPeriod[] = [];
  for (let i = currentIndex; i < currentIndex + 3 && i + 1 < events.length && periods.length < 2; i++) {
    const kind = events[i].type === 'sunrise' ? 'day' : 'night';
    // A day's text ends with the sunset time, so the night after it doesn't repeat it.
    const startNamed = periods.at(-1)?.kind === 'day';
    const period = buildPeriod(kind, events[i].at, events[i + 1].at, hours, station, nowMs, startNamed);
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
    text: periods.map((p) => p.text).join(' '),
  };
}
