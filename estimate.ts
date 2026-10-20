// Backyard Weather: our own hourly temperature estimate, made from the latest live
// forecasts. The base is the average of NWS, NBM and HRRR for each hour (whichever
// of them were fetched that hour). For each hour ahead, the estimate is the base
// minus its expected error:
//
//   expected error = bias + fade × (the base's error right now) + hour-of-day bias
//
// All of it is fitted from the last ESTIMATE_WINDOW_DAYS of live forecasts against
// the station. Bias and fade are fitted separately for each group of lead times.
// "Right now" is the top of the current hour: the base's forecast for it minus the
// station's reading. The bias is how far the base has run high or low at that lead;
// the fade is how much of the current error tends to carry into an hour that far
// ahead (0 to 1). The hour-of-day bias is what's left after those, averaged by
// Pacific hour, for daytime hours only. While live data is thin, all of it is
// scaled down.
//
// Backtest on Oct 12–20, 2026 (average miss, leads 1–17 h): the earlier HRRR-based
// estimate missed by 2.41° (2.03° overnight); this one by 1.95° (1.62° overnight).
// HRRR alone missed by 2.57°, NWS by 2.14°. ECMWF (3.39°) is left out of the base.

import db from './db/index.ts';
import { fromSqliteUtc, startOfHour, toSqliteUtc } from './forecast.ts';
import type { ForecastSource } from './forecast.ts';
import { hourlyStationValues } from './forecastComparison.ts';
import type { StationRow } from './forecastComparison.ts';

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const ESTIMATE_WINDOW_DAYS = 14;
export const BASE_SOURCES: readonly ForecastSource[] = ['nws', 'om_nbm', 'om_hrrr'];
// Groups of hours ahead, each with its own bias and fade. The forecast window is
// the current hour plus 17 more; the current hour itself isn't estimated, since the
// station already knows it.
const LEAD_GROUPS: ReadonlyArray<readonly [number, number]> = [[1, 3], [4, 9], [10, 17]];
// The bias and fade get weight runs / (runs + TRUST_RUNS): half after two days of
// hourly runs, 7/8 after two weeks. (168, a week to half weight, was slightly worse
// in the Oct 2026 backtest.)
const TRUST_RUNS = 48;
// The hour-of-day bias at each hour gets weight days / (days + HOUR_TRUST_DAYS),
// counting the days with a miss at that hour. Overnight hours (10pm–8am) get none:
// in two backtests it made the overnight estimate slightly worse, while cutting
// the afternoon and evening miss (2.56° to 2.31° in Oct 2026).
const HOUR_TRUST_DAYS = 3;
const isDaytime = (hour: number) => hour >= 8 && hour < 22;

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

// The base forecast from one hour's fetches: its time and its temperature by hour
// (ms → °F), averaged over the base sources fetched that hour.
export interface BaseRun {
  fetchedAt: number;
  sources: ForecastSource[];
  temps: Map<number, number>;
}

export interface Correction {
  leads: readonly [number, number];
  samples: number; // forecast hours fitted
  runs: number; // base runs they came from
  bias: number; // °F, after scaling by trust
  fade: number; // 0–1, after scaling by trust
  trust: number;
}

// The base's remaining average error (°F) at each Pacific hour of the day, indexed
// 0–23, after the bias and fade, scaled by trust; 0 overnight.
export type HourBias = number[];

export interface EstimateHour {
  validAt: number;
  baseF: number;
  tempF: number;
}

// The base's error at the top of the hour it was fetched in, or null without both
// values.
function currentError(run: BaseRun, station: Map<number, number>): number | null {
  const hour = startOfHour(new Date(run.fetchedAt)).getTime();
  const forecast = run.temps.get(hour);
  const actual = station.get(hour);
  return forecast === undefined || actual === undefined ? null : forecast - actual;
}

function leadOf(run: BaseRun, validAt: number): number {
  return Math.round((validAt - startOfHour(new Date(run.fetchedAt)).getTime()) / HOUR_MS);
}

const groupFor = (corrections: Correction[], lead: number) =>
  corrections.find(({ leads }) => lead >= leads[0] && lead <= leads[1]);

// Each run in the window before nowMs that can be scored: its current error and
// its hours ahead that the station has readings for by nowMs, so a fit only uses
// what was known then.
function* scoredRuns(runs: BaseRun[], station: Map<number, number>, nowMs: number) {
  const windowStart = nowMs - ESTIMATE_WINDOW_DAYS * DAY_MS;
  for (const run of runs) {
    if (run.fetchedAt < windowStart || run.fetchedAt > nowMs) {
      continue;
    }
    const error = currentError(run, station);
    if (error === null) {
      continue;
    }
    const hours: { validAt: number; lead: number; forecast: number; actual: number }[] = [];
    for (const [validAt, forecast] of run.temps) {
      const actual = station.get(validAt);
      if (validAt <= nowMs && actual !== undefined) {
        hours.push({ validAt, lead: leadOf(run, validAt), forecast, actual });
      }
    }
    yield { run, error, hours };
  }
}

// Fits each lead group's bias and fade.
export function fitCorrections(runs: BaseRun[], station: Map<number, number>, nowMs: number): Correction[] {
  const scored = [...scoredRuns(runs, station, nowMs)];
  return LEAD_GROUPS.map((leads) => {
    const xs: number[] = []; // the base's error at fetch time
    const ys: number[] = []; // its error for the hour ahead
    let runCount = 0;
    for (const { error, hours } of scored) {
      let used = false;
      for (const { lead, forecast, actual } of hours) {
        if (lead >= leads[0] && lead <= leads[1]) {
          xs.push(error);
          ys.push(forecast - actual);
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

// Fits the hour-of-day bias: the average miss at each daytime Pacific hour left
// after the bias and fade, over the same window.
export function fitHourBias(
  runs: BaseRun[],
  station: Map<number, number>,
  corrections: Correction[],
  nowMs: number,
): HourBias {
  const totals = Array.from({ length: 24 }, () => ({ sum: 0, count: 0, days: new Set<number>() }));
  for (const { error, hours } of scoredRuns(runs, station, nowMs)) {
    for (const { validAt, lead, forecast, actual } of hours) {
      const correction = groupFor(corrections, lead);
      if (correction) {
        const total = totals[pacificHour(validAt)];
        total.sum += forecast - correction.bias - correction.fade * error - actual;
        total.count++;
        total.days.add(Math.floor(validAt / DAY_MS));
      }
    }
  }
  return totals.map(({ sum, count, days }, hour) =>
    isDaytime(hour) && count ? (sum / count) * (days.size / (days.size + HOUR_TRUST_DAYS)) : 0,
  );
}

// The estimate for each hour of the run after the current one, or null when the
// station has no reading at the top of the current hour to compare against.
export function estimateFromRun(
  run: BaseRun,
  station: Map<number, number>,
  corrections: Correction[],
  hourBias: HourBias,
): EstimateHour[] | null {
  const error = currentError(run, station);
  if (error === null) {
    return null;
  }
  const hours: EstimateHour[] = [];
  for (const [validAt, baseF] of [...run.temps].sort(([a], [b]) => a - b)) {
    const correction = groupFor(corrections, leadOf(run, validAt));
    if (correction) {
      const expectedError = correction.bias + correction.fade * error + hourBias[pacificHour(validAt)];
      hours.push({ validAt, baseF, tempF: baseF - expectedError });
    }
  }
  return hours;
}

// Base runs from fetches made from `since` on, oldest first: for each hour's
// fetches, the average of the base sources' forecasts for each hour ahead.
export function loadBaseRuns(since: Date): BaseRun[] {
  const rows = db.prepare(`
    SELECT s.source, s.fetched_at, h.valid_at, h.temp_f
    FROM forecast_snapshots s
    JOIN forecast_hours h ON h.snapshot_id = s.id
    WHERE s.source IN (${BASE_SOURCES.map(() => '?').join(', ')}) AND s.kind = 'live'
      AND s.fetched_at >= ? AND h.temp_f IS NOT NULL
    ORDER BY s.fetched_at
  `).all(...BASE_SOURCES, toSqliteUtc(since)) as {
    source: ForecastSource;
    fetched_at: string;
    valid_at: string;
    temp_f: number;
  }[];
  const byHour = new Map<number, { fetchedAt: number; sources: Set<ForecastSource>; temps: Map<number, number[]> }>();
  for (const row of rows) {
    const fetchedAt = fromSqliteUtc(row.fetched_at).getTime();
    const hour = startOfHour(new Date(fetchedAt)).getTime();
    const fetch = byHour.get(hour) ?? { fetchedAt, sources: new Set(), temps: new Map() };
    fetch.fetchedAt = Math.max(fetch.fetchedAt, fetchedAt);
    fetch.sources.add(row.source);
    const validAt = fromSqliteUtc(row.valid_at).getTime();
    fetch.temps.set(validAt, [...(fetch.temps.get(validAt) ?? []), row.temp_f]);
    byHour.set(hour, fetch);
  }
  return [...byHour.values()].map(({ fetchedAt, sources, temps }) => ({
    fetchedAt,
    sources: [...sources],
    temps: new Map([...temps].map(([validAt, values]) => [validAt, values.reduce((a, b) => a + b, 0) / values.length])),
  }));
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
