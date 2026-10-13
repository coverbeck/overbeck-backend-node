// Backyard Weather: our own hourly temperature estimate, made from the latest live
// HRRR forecast. For each hour ahead, the estimate is HRRR minus its expected error:
//
//   expected error = hour-of-day bias + bias + fade × (HRRR's error right now)
//
// The hour-of-day bias is how much HRRR's error at that hour of the day (Pacific)
// differs from its all-day average at this time of year, from Open-Meteo's archive of
// day-ahead forecasts (e.g. it runs cooler on fall afternoons than at other hours).
// Only that shape comes from the archive, not the overall level, since the live
// forecasts have run warmer than the day-ahead ones.
//
// The rest is fitted, after removing the hour-of-day bias, from the last
// ESTIMATE_WINDOW_DAYS of live HRRR forecasts against the station, separately for
// each group of lead times. "Right now" is the top of the current hour: HRRR's
// forecast for it minus the station's reading. The bias is how far HRRR has run high
// or low at that lead; the fade is how much of the current error tends to carry into
// an hour that far ahead (0 to 1). While live data is thin, those two are scaled
// down; the hour-of-day bias isn't, since the archive has years.

import db from './db/index.ts';
import { fromSqliteUtc, startOfHour, toSqliteUtc } from './forecast.ts';
import { ARCHIVE_START_DATE } from './openmeteo.ts';
import { hourlyStationValues } from './forecastComparison.ts';
import type { StationRow } from './forecastComparison.ts';

const HOUR_MS = 3600 * 1000;
export const ESTIMATE_WINDOW_DAYS = 14;
// Groups of hours ahead, each with its own bias and fade. The forecast window is
// the current hour plus 17 more; the current hour itself isn't estimated, since the
// station already knows it.
const LEAD_GROUPS: ReadonlyArray<readonly [number, number]> = [[1, 3], [4, 9], [10, 17]];
// The corrections get weight runs / (runs + TRUST_RUNS): half with a week of hourly
// HRRR runs, two thirds with two weeks. A backtest on the first three days of live
// data (Oct 2026) found HRRR's bias swung from about -1° to +1° from day to day, so
// full weight on a few days' bias made the estimate worse than plain HRRR; the
// slow ramp keeps it close to HRRR until there's more data.
const TRUST_RUNS = 168;
// "This time of year" for the hour-of-day bias: archive days within this many days
// of the date, in every year. Tests (Oct 2026): on a year of day-ahead forecasts,
// using only earlier years each day, the shape plus a 14-day level cut HRRR's miss
// from 2.49° to 2.43°; on the first live week, the estimate's miss went from 1.41°
// to 1.35° (afternoons 1.61° to 1.49°, overnight unchanged), vs 1.39° for HRRR. A
// modest gain: most daytime error is the day's weather, not a steady pattern.
const SEASON_DAYS = 30;
const DAY_MS = 24 * HOUR_MS;

const pacificHourFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hour: 'numeric',
  hourCycle: 'h23',
});
const pacificHours = new Map<number, number>();

// The Pacific hour of the day (0–23) at an instant; memoized, since the fit asks
// about the same hours many times.
function pacificHour(ms: number): number {
  let hour = pacificHours.get(ms);
  if (hour === undefined) {
    hour = Number(pacificHourFormat.format(new Date(ms)));
    pacificHours.set(ms, hour);
  }
  return hour;
}

// How much HRRR's average error (°F) at each Pacific hour of the day, indexed 0–23,
// differs from its average over all hours.
export type HourBias = number[];

// One live HRRR fetch: its time and its temperature forecast by hour (ms → °F).
export interface HrrrRun {
  fetchedAt: number;
  temps: Map<number, number>;
}

export interface Correction {
  leads: readonly [number, number];
  samples: number; // forecast hours fitted
  runs: number; // HRRR runs they came from
  bias: number; // °F, after scaling by trust
  fade: number; // 0–1, after scaling by trust
  trust: number;
}

export interface EstimateHour {
  validAt: number;
  hrrrF: number;
  tempF: number;
}

// HRRR's error at the top of the hour it was fetched in, less the hour-of-day bias,
// or null without both values.
function currentError(run: HrrrRun, station: Map<number, number>, hourBias: HourBias): number | null {
  const hour = startOfHour(new Date(run.fetchedAt)).getTime();
  const forecast = run.temps.get(hour);
  const actual = station.get(hour);
  return forecast === undefined || actual === undefined ? null : forecast - hourBias[pacificHour(hour)] - actual;
}

function leadOf(run: HrrrRun, validAt: number): number {
  return Math.round((validAt - startOfHour(new Date(run.fetchedAt)).getTime()) / HOUR_MS);
}

// Fits each lead group's bias and fade from runs fetched in the window before
// nowMs, against station readings up to nowMs, so it only uses what was known then.
// Errors are measured after removing the hour-of-day bias.
export function fitCorrections(
  runs: HrrrRun[],
  station: Map<number, number>,
  hourBias: HourBias,
  nowMs: number,
): Correction[] {
  const windowStart = nowMs - ESTIMATE_WINDOW_DAYS * 24 * HOUR_MS;
  return LEAD_GROUPS.map((leads) => {
    const xs: number[] = []; // HRRR's error at fetch time
    const ys: number[] = []; // its error for the hour ahead
    let runCount = 0;
    for (const run of runs) {
      if (run.fetchedAt < windowStart || run.fetchedAt > nowMs) {
        continue;
      }
      const x = currentError(run, station, hourBias);
      if (x === null) {
        continue;
      }
      let used = false;
      for (const [validAt, forecast] of run.temps) {
        const lead = leadOf(run, validAt);
        const actual = station.get(validAt);
        if (lead >= leads[0] && lead <= leads[1] && validAt <= nowMs && actual !== undefined) {
          xs.push(x);
          ys.push(forecast - hourBias[pacificHour(validAt)] - actual);
          used = true;
        }
      }
      runCount += used ? 1 : 0;
    }
    const n = xs.length;
    if (!n) {
      return { leads, samples: 0, runs: 0, bias: 0, fade: 0, trust: 0 };
    }
    const meanX = xs.reduce((sum, v) => sum + v, 0) / n;
    const meanY = ys.reduce((sum, v) => sum + v, 0) / n;
    let covariance = 0;
    let variance = 0;
    for (let i = 0; i < n; i++) {
      covariance += (xs[i] - meanX) * (ys[i] - meanY);
      variance += (xs[i] - meanX) ** 2;
    }
    const fade = variance > 0 ? Math.min(1, Math.max(0, covariance / variance)) : 0;
    const bias = meanY - fade * meanX;
    const trust = runCount / (runCount + TRUST_RUNS);
    return { leads, samples: n, runs: runCount, bias: bias * trust, fade: fade * trust, trust };
  });
}

// The estimate for each hour of the run after the current one, or null when the
// station has no reading at the top of the current hour to compare against.
export function estimateFromRun(
  run: HrrrRun,
  station: Map<number, number>,
  hourBias: HourBias,
  corrections: Correction[],
): EstimateHour[] | null {
  const error = currentError(run, station, hourBias);
  if (error === null) {
    return null;
  }
  const hours: EstimateHour[] = [];
  for (const [validAt, hrrrF] of [...run.temps].sort(([a], [b]) => a - b)) {
    const lead = leadOf(run, validAt);
    const correction = corrections.find(({ leads }) => lead >= leads[0] && lead <= leads[1]);
    if (correction) {
      const expectedError = hourBias[pacificHour(validAt)] + correction.bias + correction.fade * error;
      hours.push({ validAt, hrrrF, tempF: hrrrF - expectedError });
    }
  }
  return hours;
}

// Live HRRR runs fetched from `since` on, oldest first.
export function loadHrrrRuns(since: Date): HrrrRun[] {
  const rows = db.prepare(`
    SELECT s.fetched_at, h.valid_at, h.temp_f
    FROM forecast_snapshots s
    JOIN forecast_hours h ON h.snapshot_id = s.id
    WHERE s.source = 'om_hrrr' AND s.kind = 'live' AND s.fetched_at >= ? AND h.temp_f IS NOT NULL
    ORDER BY s.fetched_at
  `).all(toSqliteUtc(since)) as { fetched_at: string; valid_at: string; temp_f: number }[];
  const runs = new Map<string, HrrrRun>();
  for (const row of rows) {
    const run = runs.get(row.fetched_at) ?? { fetchedAt: fromSqliteUtc(row.fetched_at).getTime(), temps: new Map() };
    run.temps.set(fromSqliteUtc(row.valid_at).getTime(), row.temp_f);
    runs.set(row.fetched_at, run);
  }
  return [...runs.values()];
}

// The station's temperature at each top of the hour from `since` on (before
// `until`, if given).
export function loadStationTemps(since: Date, until?: Date): Map<number, number> {
  const rows = db.prepare(
    'SELECT observed_at, temp_f, dewpoint_f, humidity_pct FROM station_readings WHERE observed_at >= ? AND observed_at < ? ORDER BY observed_at'
  ).all(
    toSqliteUtc(new Date(since.getTime() - HOUR_MS)),
    until ? toSqliteUtc(new Date(until.getTime() + HOUR_MS)) : '9999-12-31 23:59:59',
  ) as StationRow[];
  return hourlyStationValues(rows, (row) => row.temp_f);
}

// HRRR's average day-ahead error at each Pacific hour of the day, from the archive
// over the SEASON_DAYS either side of nowMs's date in each year since the archive
// starts, up to nowMs, less the average over all hours. All zeros without data.
export function loadHourBias(nowMs: number): HourBias {
  const totals = Array.from({ length: 24 }, () => ({ count: 0, sum: 0 }));
  const archive = db.prepare(`
    SELECT h.valid_at, h.temp_f
    FROM forecast_snapshots s
    JOIN forecast_hours h ON h.snapshot_id = s.id
    WHERE s.source = 'om_hrrr' AND s.kind = 'archive_day1'
      AND h.valid_at >= ? AND h.valid_at < ? AND h.temp_f IS NOT NULL
  `);
  const now = new Date(nowMs);
  const firstYear = Number(ARCHIVE_START_DATE.slice(0, 4));
  for (let year = firstYear; year <= now.getUTCFullYear(); year++) {
    const sameDate = Date.UTC(year, now.getUTCMonth(), now.getUTCDate());
    const start = new Date(sameDate - SEASON_DAYS * DAY_MS);
    const end = new Date(Math.min(sameDate + SEASON_DAYS * DAY_MS, nowMs));
    if (start >= end) {
      continue;
    }
    const station = loadStationTemps(start, end);
    const rows = archive.all(toSqliteUtc(start), toSqliteUtc(end)) as { valid_at: string; temp_f: number }[];
    for (const row of rows) {
      const validAt = fromSqliteUtc(row.valid_at).getTime();
      const actual = station.get(validAt);
      if (actual !== undefined) {
        const total = totals[pacificHour(validAt)];
        total.count++;
        total.sum += row.temp_f - actual;
      }
    }
  }
  if (totals.some(({ count }) => !count)) {
    return totals.map(() => 0);
  }
  const byHour = totals.map(({ count, sum }) => sum / count);
  const allHours = byHour.reduce((total, value) => total + value, 0) / byHour.length;
  return byHour.map((value) => value - allHours);
}
