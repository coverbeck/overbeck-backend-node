// Backyard Weather: our own hourly temperature estimate, made from the latest live
// HRRR forecast and corrected using only live data (no archive). For each hour
// ahead, the estimate is HRRR minus its expected error, where the expected error is
// fitted from the last ESTIMATE_WINDOW_DAYS of live HRRR forecasts against the
// station, separately for each group of lead times:
//
//   expected error = bias + fade × (HRRR's error right now)
//
// "Right now" is the top of the current hour: HRRR's forecast for it minus the
// station's reading. The bias is how far HRRR has run high or low at that lead; the
// fade is how much of the current error tends to carry into an hour that far ahead
// (0 to 1). While data is thin, both are scaled down toward plain HRRR.

import db from './db/index.ts';
import { fromSqliteUtc, startOfHour, toSqliteUtc } from './forecast.ts';
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

// HRRR's error at the top of the hour it was fetched in, or null without both values.
function currentError(run: HrrrRun, station: Map<number, number>): number | null {
  const hour = startOfHour(new Date(run.fetchedAt)).getTime();
  const forecast = run.temps.get(hour);
  const actual = station.get(hour);
  return forecast === undefined || actual === undefined ? null : forecast - actual;
}

function leadOf(run: HrrrRun, validAt: number): number {
  return Math.round((validAt - startOfHour(new Date(run.fetchedAt)).getTime()) / HOUR_MS);
}

// Fits each lead group's bias and fade from runs fetched in the window before
// nowMs, against station readings up to nowMs, so it only uses what was known then.
export function fitCorrections(runs: HrrrRun[], station: Map<number, number>, nowMs: number): Correction[] {
  const windowStart = nowMs - ESTIMATE_WINDOW_DAYS * 24 * HOUR_MS;
  return LEAD_GROUPS.map((leads) => {
    const xs: number[] = []; // HRRR's error at fetch time
    const ys: number[] = []; // its error for the hour ahead
    let runCount = 0;
    for (const run of runs) {
      if (run.fetchedAt < windowStart || run.fetchedAt > nowMs) {
        continue;
      }
      const x = currentError(run, station);
      if (x === null) {
        continue;
      }
      let used = false;
      for (const [validAt, forecast] of run.temps) {
        const lead = leadOf(run, validAt);
        const actual = station.get(validAt);
        if (lead >= leads[0] && lead <= leads[1] && validAt <= nowMs && actual !== undefined) {
          xs.push(x);
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

// The estimate for each hour of the run after the current one, or null when the
// station has no reading at the top of the current hour to compare against.
export function estimateFromRun(
  run: HrrrRun,
  station: Map<number, number>,
  corrections: Correction[],
): EstimateHour[] | null {
  const error = currentError(run, station);
  if (error === null) {
    return null;
  }
  const hours: EstimateHour[] = [];
  for (const [validAt, hrrrF] of [...run.temps].sort(([a], [b]) => a - b)) {
    const lead = leadOf(run, validAt);
    const correction = corrections.find(({ leads }) => lead >= leads[0] && lead <= leads[1]);
    if (correction) {
      hours.push({ validAt, hrrrF, tempF: hrrrF - (correction.bias + correction.fade * error) });
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

// The station's temperature at each top of the hour from `since` on.
export function loadStationTemps(since: Date): Map<number, number> {
  const rows = db.prepare(
    'SELECT observed_at, temp_f, dewpoint_f, humidity_pct FROM station_readings WHERE observed_at >= ? ORDER BY observed_at'
  ).all(toSqliteUtc(new Date(since.getTime() - HOUR_MS))) as StationRow[];
  return hourlyStationValues(rows, (row) => row.temp_f);
}
