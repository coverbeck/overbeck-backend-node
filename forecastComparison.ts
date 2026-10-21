import db from './db/index.ts';
import { fromSqliteUtc, startOfHour, toSqliteUtc } from './forecast.ts';
import type { ForecastSource } from './forecast.ts';
import { sunEventsBetween } from './sun.ts';

// Data for the /weather/forecast charts: the station's readings over the last few
// days alongside each source's forecast, from the start of the range through the
// end of the latest forecast. For each hour, a source's line shows the latest
// forecast it made at least `leadHours` before that hour, so past hours show what
// the forecast said in advance rather than a forecast fetched after the fact.
// Leads up to 12 hours use the live fetches; the 24-hour lead uses Open-Meteo's
// archive of day-ahead forecasts (kind 'archive_day1'), which has no NWS.

const HOUR_MS = 3600 * 1000;
const FORECAST_HOURS = 18;
const MATCH_MS = 5 * 60 * 1000; // a station reading within 5 minutes counts as "at" the hour

// Temperature within this many °F of the dew point: dew or fog likely.
export const FOG_SPREAD_F = 2;

// An hour with at least this much rain (the gauge's resolution) counts as rainy,
// for the station and for a forecast alike.
const WET_IN = 0.01;

export const RANGE_DAYS = [1, 3, 7] as const;
export const LEAD_HOURS = [0, 6, 12, 24] as const;
const ARCHIVE_LEAD_HOURS = 24;
export type RangeDays = (typeof RANGE_DAYS)[number];
export type LeadHours = (typeof LEAD_HOURS)[number];

export const SOURCE_LABELS: Record<ForecastSource, string> = {
  nws: 'NWS',
  om_hrrr: 'HRRR',
  om_nbm: 'NBM',
  om_ecmwf: 'ECMWF',
  estimate: 'Our estimate',
};
const SOURCE_ORDER: ForecastSource[] = ['estimate', 'nws', 'om_hrrr', 'om_nbm', 'om_ecmwf'];

export type LineKey = ForecastSource | 'average';

// x is an ISO 8601 UTC timestamp, which Chart.js's time scale parses directly.
export interface ChartPoint {
  x: string;
  y: number | null;
}

export interface ForecastLine {
  key: LineKey;
  label: string;
  temp: ChartPoint[];
  dewpoint: ChartPoint[];
  spread: ChartPoint[]; // temperature minus dew point
  skyCover: ChartPoint[];
  lowCloud: ChartPoint[]; // empty when the source has no low-cloud forecast
  // Rain amount (inches) and chance (%) for each hour, plotted at the middle of the
  // hour they cover. HRRR's chance is left out: Open-Meteo copies it from NBM.
  rain: ChartPoint[];
  rainChance: ChartPoint[];
}

export interface ScoreRow {
  key: LineKey;
  label: string;
  hours: number;
  // Bias is the mean of forecast minus actual, e.g. "+1.3°"; miss is the mean
  // absolute error, e.g. "2.1°". Dew point is "–" when there's nothing to compare.
  tempBias: string;
  tempMiss: string;
  dewpointBias: string;
  dewpointMiss: string;
}

// How each forecast's rain did over the past hours in the range: totals, rainy
// hours it caught, missed and wrongly forecast, and its average chance of rain in
// the hours that turned out rainy and dry ("–" without a chance forecast).
export interface RainScoreRow {
  key: LineKey;
  label: string;
  hours: number;
  forecastTotal: string; // e.g. "0.42 in"
  recordedTotal: string;
  caught: number;
  missed: number;
  falseAlarms: number;
  chanceWhenRainy: string; // e.g. "64%"
  chanceWhenDry: string;
}

export interface RainSummary {
  any: boolean; // rain recorded, or forecast by any line, anywhere in the range
  maxChancePct: number | null;
}

export interface TimeRange {
  start: string; // ISO
  end: string; // ISO
}

// Night (dusk to dawn) and civil twilight bands within the range, plus each sunrise
// and sunset in it for the tooltips.
export interface SunBands {
  night: TimeRange[];
  twilight: TimeRange[];
  events: { type: 'sunrise' | 'sunset'; at: string }[]; // at: ISO
}

// One source's temperature forecast at each lead, for comparing how a forecast
// changes as the hour gets closer.
export interface LeadSeries {
  lead: LeadHours;
  temp: ChartPoint[];
}

export interface LeadComparison {
  key: LineKey;
  label: string;
  leads: LeadSeries[];
}

export interface ForecastComparison {
  now: string; // ISO
  range: TimeRange; // the charts' x axis
  sun: SunBands;
  lastFetchedAt: string | null; // ISO
  station: {
    temp: ChartPoint[];
    dewpoint: ChartPoint[];
    spread: ChartPoint[];
    humidity: ChartPoint[];
    rain: ChartPoint[]; // inches in each past hour, at the middle of the hour
  };
  lines: ForecastLine[]; // the average first, then our estimate, then each source
  scores: ScoreRow[]; // best temperature first
  rain: RainSummary;
  rainScores: RainScoreRow[]; // fewest missed and false-alarm hours first
  fogSpreadF: number;
  leadComparison: LeadComparison[]; // the average, then SOURCE_ORDER
}

interface ForecastRow {
  source: ForecastSource;
  valid_at: string;
  temp_f: number | null;
  dewpoint_f: number | null;
  sky_cover_pct: number | null;
  low_cloud_pct: number | null;
  precip_in: number | null;
  precip_prob_pct: number | null;
}

export interface StationRow {
  observed_at: string;
  temp_f: number | null;
  dewpoint_f: number | null;
  humidity_pct: number | null;
}

interface RainRow {
  observed_at: string;
  rain_hourly_in: number | null; // a rate, in/h
  rain_daily_in: number | null;
}

function toIso(sqliteUtc: string): string {
  return fromSqliteUtc(sqliteUtc).toISOString();
}

// Rain values are for the hour ending at valid_at; they're plotted at its middle.
function midHourIso(hourEndMs: number): string {
  return new Date(hourEndMs - HOUR_MS / 2).toISOString();
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

function formatDegrees(value: number, signed: boolean): string {
  const rounded = value.toFixed(1);
  const sign = signed && Number(rounded) > 0 ? '+' : '';
  return `${sign}${rounded === '-0.0' ? '0.0' : rounded}°`;
}

// Floored at 0: a station can report a dew point slightly above the temperature.
function spread(temp: number | null, dewpoint: number | null): number | null {
  return temp === null || dewpoint === null ? null : Math.max(0, temp - dewpoint);
}

// Our estimate is temperature only, so its other series are left empty.
function sourceLine(source: ForecastSource, rows: ForecastRow[]): ForecastLine {
  const series = (value: (row: ForecastRow) => number | null): ChartPoint[] =>
    source === 'estimate' ? [] : rows.map((row) => ({ x: toIso(row.valid_at), y: value(row) }));
  const rainSeries = (value: (row: ForecastRow) => number | null): ChartPoint[] =>
    source === 'estimate'
      ? []
      : rows.map((row) => ({ x: midHourIso(fromSqliteUtc(row.valid_at).getTime()), y: value(row) }));
  const temp = rows.map((row) => ({ x: toIso(row.valid_at), y: row.temp_f }));
  const hasLowCloud = rows.some((row) => row.low_cloud_pct !== null);
  return {
    key: source,
    label: SOURCE_LABELS[source],
    temp,
    dewpoint: series((row) => row.dewpoint_f),
    spread: series((row) => spread(row.temp_f, row.dewpoint_f)),
    skyCover: series((row) => row.sky_cover_pct),
    lowCloud: hasLowCloud ? series((row) => row.low_cloud_pct) : [],
    rain: rainSeries((row) => row.precip_in),
    rainChance: source === 'om_hrrr' ? [] : rainSeries((row) => row.precip_prob_pct),
  };
}

// Equal-weight average of whichever sources forecast each hour. Low cloud isn't
// averaged: only HRRR and ECMWF forecast it.
function averageLine(lines: ForecastLine[]): ForecastLine {
  const average = (pick: (line: ForecastLine) => ChartPoint[]): ChartPoint[] => {
    const byHour = new Map<string, number[]>();
    for (const line of lines) {
      for (const point of pick(line)) {
        const values = byHour.get(point.x) ?? [];
        if (point.y !== null) {
          values.push(point.y);
        }
        byHour.set(point.x, values);
      }
    }
    return [...byHour.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([x, values]) => ({ x, y: mean(values) }));
  };
  return {
    key: 'average',
    label: 'Average',
    temp: average((line) => line.temp),
    dewpoint: average((line) => line.dewpoint),
    spread: average((line) => line.spread),
    skyCover: average((line) => line.skyCover),
    lowCloud: [],
    rain: average((line) => line.rain),
    rainChance: average((line) => line.rainChance),
  };
}

interface ErrorStats {
  hours: number;
  bias: number;
  miss: number;
}

// Forecast error over the hours that have passed, against the station reading at
// the top of each hour.
function errorStats(points: ChartPoint[], actuals: Map<number, number>, nowMs: number): ErrorStats | null {
  const errors: number[] = [];
  for (const point of points) {
    const ms = Date.parse(point.x);
    const actual = actuals.get(ms);
    if (ms <= nowMs && point.y !== null && actual !== undefined) {
      errors.push(point.y - actual);
    }
  }
  const bias = mean(errors);
  const miss = mean(errors.map(Math.abs));
  return bias === null || miss === null ? null : { hours: errors.length, bias, miss };
}

// Station value at each top of the hour: the nearest reading within 5 minutes.
export function hourlyStationValues(rows: StationRow[], value: (row: StationRow) => number | null): Map<number, number> {
  const best = new Map<number, { distance: number; value: number }>();
  for (const row of rows) {
    const v = value(row);
    if (v === null) {
      continue;
    }
    const ms = fromSqliteUtc(row.observed_at).getTime();
    const hour = Math.round(ms / HOUR_MS) * HOUR_MS;
    const distance = Math.abs(ms - hour);
    const current = best.get(hour);
    if (distance <= MATCH_MS && (!current || distance < current.distance)) {
      best.set(hour, { distance, value: v });
    }
  }
  return new Map([...best].map(([hour, { value: v }]) => [hour, v]));
}

function scoreRows(lines: ForecastLine[], stationRows: StationRow[], nowMs: number): ScoreRow[] {
  const stationTemp = hourlyStationValues(stationRows, (row) => row.temp_f);
  const stationDewpoint = hourlyStationValues(stationRows, (row) => row.dewpoint_f);
  const rows: { line: ForecastLine; temp: ErrorStats; dewpoint: ErrorStats | null }[] = [];
  for (const line of lines) {
    const temp = errorStats(line.temp, stationTemp, nowMs);
    if (temp) {
      rows.push({ line, temp, dewpoint: errorStats(line.dewpoint, stationDewpoint, nowMs) });
    }
  }
  return rows
    .sort((a, b) => a.temp.miss - b.temp.miss)
    .map(({ line, temp, dewpoint }) => ({
      key: line.key,
      label: line.label,
      hours: temp.hours,
      tempBias: formatDegrees(temp.bias, true),
      tempMiss: formatDegrees(temp.miss, false),
      dewpointBias: dewpoint ? formatDegrees(dewpoint.bias, true) : '–',
      dewpointMiss: dewpoint ? formatDegrees(dewpoint.miss, false) : '–',
    }));
}

// Rain in each complete hour through nowMs, keyed by the hour's end. From the
// day's running total where the station reported it for the hour and the reading
// before it (the total resets at local midnight), else from the average rain rate
// over the hour's readings, the only option for readings before 2026-10-20.
function hourlyStationRain(rows: RainRow[], nowMs: number): Map<number, number> {
  const byHour = new Map<number, RainRow[]>();
  for (const row of rows) {
    const hourEnd = Math.ceil(fromSqliteUtc(row.observed_at).getTime() / HOUR_MS) * HOUR_MS;
    byHour.set(hourEnd, [...(byHour.get(hourEnd) ?? []), row]);
  }

  const rain = new Map<number, number>();
  let previous: RainRow | undefined;
  for (const [hourEnd, readings] of [...byHour].sort(([a], [b]) => a - b)) {
    const totals = [previous, ...readings].map((row) => row?.rain_daily_in ?? null);
    const recent = previous && fromSqliteUtc(previous.observed_at).getTime() >= hourEnd - HOUR_MS - 15 * 60 * 1000;
    if (hourEnd <= nowMs) {
      if (recent && totals.every((t) => t !== null)) {
        let amount = 0;
        for (let i = 1; i < totals.length; i++) {
          const [before, after] = [totals[i - 1] as number, totals[i] as number];
          amount += after >= before ? after - before : after;
        }
        rain.set(hourEnd, amount);
      } else {
        const rates = readings.map((row) => row.rain_hourly_in).filter((r) => r !== null);
        // At least half the hour's 12 readings, so a gap doesn't pass for a dry hour.
        if (rates.length >= 6) {
          rain.set(hourEnd, mean(rates) ?? 0);
        }
      }
    }
    previous = readings[readings.length - 1];
  }
  return rain;
}

function formatInches(value: number): string {
  return `${value.toFixed(2)} in`;
}

function formatPercent(values: number[]): string {
  const average = mean(values);
  return average === null ? '–' : `${Math.round(average)}%`;
}

function rainScoreRows(lines: ForecastLine[], actuals: Map<number, number>): RainScoreRow[] {
  const rows: (RainScoreRow & { wrong: number; totalGap: number })[] = [];
  for (const line of lines) {
    const chances = new Map(line.rainChance.map((p) => [Date.parse(p.x), p.y]));
    let hours = 0;
    let forecastTotal = 0;
    let recordedTotal = 0;
    let caught = 0;
    let missed = 0;
    let falseAlarms = 0;
    const chanceWhenRainy: number[] = [];
    const chanceWhenDry: number[] = [];
    for (const point of line.rain) {
      const ms = Date.parse(point.x);
      const actual = actuals.get(ms + HOUR_MS / 2);
      if (point.y === null || actual === undefined) {
        continue;
      }
      hours++;
      forecastTotal += point.y;
      recordedTotal += actual;
      const [rainy, forecastRainy] = [actual >= WET_IN, point.y >= WET_IN];
      if (rainy && forecastRainy) caught++;
      if (rainy && !forecastRainy) missed++;
      if (!rainy && forecastRainy) falseAlarms++;
      const chance = chances.get(ms);
      if (chance !== null && chance !== undefined) {
        (rainy ? chanceWhenRainy : chanceWhenDry).push(chance);
      }
    }
    if (hours) {
      rows.push({
        key: line.key,
        label: line.label,
        hours,
        forecastTotal: formatInches(forecastTotal),
        recordedTotal: formatInches(recordedTotal),
        caught,
        missed,
        falseAlarms,
        chanceWhenRainy: formatPercent(chanceWhenRainy),
        chanceWhenDry: formatPercent(chanceWhenDry),
        wrong: missed + falseAlarms,
        totalGap: Math.abs(forecastTotal - recordedTotal),
      });
    }
  }
  return rows
    .sort((a, b) => a.wrong - b.wrong || a.totalGap - b.totalGap)
    .map(({ wrong: _wrong, totalGap: _totalGap, ...row }) => row);
}

// Bands between consecutive sun events, clipped to the range: dusk to dawn is
// night, dawn to sunrise and sunset to dusk are twilight. Events from a day either
// side give the bands that start or end outside the range.
function sunBands(startMs: number, endMs: number): SunBands {
  const events = sunEventsBetween(startMs - 24 * HOUR_MS, endMs + 24 * HOUR_MS);
  const bands: SunBands = { night: [], twilight: [], events: [] };
  for (let i = 0; i + 1 < events.length; i++) {
    const [from, to] = [events[i], events[i + 1]];
    const kind = from.type === 'dusk' ? bands.night : from.type === 'dawn' || from.type === 'sunset' ? bands.twilight : null;
    const bandStart = Math.max(from.at, startMs);
    const bandEnd = Math.min(to.at, endMs);
    if (kind && bandStart < bandEnd) {
      kind.push({ start: new Date(bandStart).toISOString(), end: new Date(bandEnd).toISOString() });
    }
  }
  for (const { type, at } of events) {
    if ((type === 'sunrise' || type === 'sunset') && at >= startMs && at <= endMs) {
      bands.events.push({ type, at: new Date(at).toISOString() });
    }
  }
  return bands;
}

// The average line followed by each source's line, from `start` on, using for each
// hour the latest forecast made at least leadHours before it. The average is of the
// fetched forecasts only, not our estimate.
function forecastLines(start: string, leadHours: LeadHours): ForecastLine[] {
  // Ordered by fetch time, so for each source and hour the last row seen is the
  // latest forecast made at least leadHours before that hour.
  const rows = db.prepare(`
    SELECT s.source, h.valid_at, h.temp_f, h.dewpoint_f, h.sky_cover_pct, h.low_cloud_pct,
      h.precip_in, h.precip_prob_pct
    FROM forecast_hours h
    JOIN forecast_snapshots s ON s.id = h.snapshot_id
    WHERE h.valid_at >= ? AND s.fetched_at <= datetime(h.valid_at, ?) AND s.kind = ?
    ORDER BY s.fetched_at
  `).all(
    start,
    `-${leadHours} hours`,
    leadHours === ARCHIVE_LEAD_HOURS ? 'archive_day1' : 'live',
  ) as ForecastRow[];

  const latest = new Map<string, ForecastRow>();
  for (const row of rows) {
    latest.set(`${row.source} ${row.valid_at}`, row);
  }
  const bySource = new Map<ForecastSource, ForecastRow[]>();
  for (const row of latest.values()) {
    bySource.set(row.source, [...(bySource.get(row.source) ?? []), row]);
  }

  const sourceLines: ForecastLine[] = [];
  for (const source of SOURCE_ORDER) {
    const hours = (bySource.get(source) ?? []).sort((a, b) => a.valid_at.localeCompare(b.valid_at));
    if (hours.length) {
      sourceLines.push(sourceLine(source, hours));
    }
  }
  const fetched = sourceLines.filter((line) => line.key !== 'estimate');
  return fetched.length ? [averageLine(fetched), ...sourceLines] : sourceLines;
}

export function getForecastComparison(now: Date, days: RangeDays, leadHours: LeadHours): ForecastComparison {
  const startMs = startOfHour(now).getTime() - days * 24 * HOUR_MS;
  const endMs = startOfHour(now).getTime() + FORECAST_HOURS * HOUR_MS;
  const start = toSqliteUtc(new Date(startMs));

  const linesByLead = new Map(LEAD_HOURS.map((lead) => [lead, forecastLines(start, lead)]));
  const lines = linesByLead.get(leadHours) ?? [];
  // Every line found at any lead (the archive has no NWS, and live data may not reach
  // back through the whole range), with only the leads that have data.
  const allLines = [...linesByLead.values()].flat();
  const leadComparison = (['average', ...SOURCE_ORDER] as LineKey[]).flatMap((key) => {
    const line = allLines.find((l) => l.key === key);
    if (!line) {
      return [];
    }
    const leads = LEAD_HOURS.map((lead) => ({
      lead,
      temp: linesByLead.get(lead)?.find((l) => l.key === key)?.temp ?? [],
    })).filter(({ temp }) => temp.length);
    return [{ key, label: line.label, leads }];
  });

  const stationRows = db.prepare(
    'SELECT observed_at, temp_f, dewpoint_f, humidity_pct FROM station_readings WHERE observed_at >= ? ORDER BY observed_at'
  ).all(start) as StationRow[];
  const scores = scoreRows(lines, stationRows, now.getTime());

  // One reading before the range, for the first hour's change in the daily total.
  const rainRows = db.prepare(`
    SELECT observed_at, rain_hourly_in, rain_daily_in FROM station_readings
    WHERE observed_at >= (SELECT COALESCE(MAX(observed_at), ?) FROM station_readings WHERE observed_at < ?)
    ORDER BY observed_at
  `).all(start, start) as RainRow[];
  const stationRain = new Map(
    [...hourlyStationRain(rainRows, now.getTime())].filter(([hourEnd]) => hourEnd > startMs)
  );
  const rainPoints = [...stationRain].map(([hourEnd, y]) => ({ x: midHourIso(hourEnd), y }));
  const chances = lines.flatMap((line) => line.rainChance.map((p) => p.y)).filter((y) => y !== null);
  const rain: RainSummary = {
    any: [...rainPoints, ...lines.flatMap((line) => line.rain)].some((p) => p.y !== null && p.y >= WET_IN),
    maxChancePct: chances.length ? Math.max(...chances) : null,
  };

  const { lastFetchedAt } = db.prepare(
    "SELECT MAX(fetched_at) AS lastFetchedAt FROM forecast_snapshots WHERE kind = 'live'"
  ).get() as { lastFetchedAt: string | null };

  const stationSeries = (value: (row: StationRow) => number | null): ChartPoint[] =>
    stationRows.map((row) => ({ x: toIso(row.observed_at), y: value(row) }));

  return {
    now: now.toISOString(),
    range: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
    sun: sunBands(startMs, endMs),
    lastFetchedAt: lastFetchedAt && toIso(lastFetchedAt),
    station: {
      temp: stationSeries((row) => row.temp_f),
      dewpoint: stationSeries((row) => row.dewpoint_f),
      spread: stationSeries((row) => spread(row.temp_f, row.dewpoint_f)),
      humidity: stationSeries((row) => row.humidity_pct),
      rain: rainPoints,
    },
    lines,
    scores,
    rain,
    rainScores: rain.any ? rainScoreRows(lines, stationRain) : [],
    fogSpreadF: FOG_SPREAD_F,
    leadComparison,
  };
}
