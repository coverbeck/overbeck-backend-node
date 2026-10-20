// Backyard Weather: make and save our temperature estimate (see estimate.ts) for the
// hours ahead, as a forecast snapshot with source 'estimate'. Saved when made, so
// the charts score it the way it was, not refit with later data. Run from cron after
// the :05 forecast fetch and the :10 station fetch; see cron/backyard-weather.crontab.
//
//   node --env-file=.env scripts/collect-estimate.ts

import db from '../db/index.ts';
import {
  ESTIMATE_WINDOW_DAYS,
  estimateFromRun,
  fitCorrections,
  fitHourBias,
  loadBaseRuns,
  loadStationTemps,
} from '../estimate.ts';
import type { Correction } from '../estimate.ts';
import { startOfHour, toSqliteUtc } from '../forecast.ts';

const JOB_NAME = 'backyard-estimate';
const HOUR_MS = 3600 * 1000;

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function signed(value: number): string {
  const rounded = value.toFixed(1);
  return `${Number(rounded) > 0 ? '+' : ''}${rounded === '-0.0' ? '0.0' : rounded}°`;
}

function describe(correction: Correction): string {
  const [from, to] = correction.leads;
  return `${from}–${to}h bias ${signed(correction.bias)} fade ${correction.fade.toFixed(2)} (${correction.runs} runs, trust ${correction.trust.toFixed(2)})`;
}

const insertSnapshot = db.prepare(
  "INSERT INTO forecast_snapshots (source, fetched_at, issued_at) VALUES ('estimate', ?, NULL)"
);
const insertHour = db.prepare('INSERT INTO forecast_hours (snapshot_id, valid_at, temp_f) VALUES (?, ?, ?)');
const upsertJobCheckin = db.prepare(`
  INSERT INTO job_checkins (job_name, checked_at, status, message)
  VALUES (?, datetime('now'), ?, ?)
  ON CONFLICT(job_name) DO UPDATE SET
    checked_at = excluded.checked_at,
    status = excluded.status,
    message = excluded.message
`);

const saveEstimate = db.transaction((madeAt: string, hours: { validAt: number; tempF: number }[]) => {
  const { lastInsertRowid } = insertSnapshot.run(madeAt);
  for (const hour of hours) {
    insertHour.run(lastInsertRowid, toSqliteUtc(new Date(hour.validAt)), Math.round(hour.tempF * 10) / 10);
  }
});

function run(): string {
  const now = new Date();
  const since = new Date(now.getTime() - ESTIMATE_WINDOW_DAYS * 24 * HOUR_MS);
  const runs = loadBaseRuns(since);
  const latest = runs.at(-1);
  if (!latest || latest.fetchedAt < startOfHour(now).getTime()) {
    throw new Error('no forecast fetched this hour');
  }
  const station = loadStationTemps(since);
  const corrections = fitCorrections(runs, station, now.getTime());
  const hourBias = fitHourBias(runs, station, corrections, now.getTime());
  const hours = estimateFromRun(latest, station, corrections, hourBias);
  if (!hours) {
    throw new Error('no station reading at the top of the hour');
  }
  saveEstimate(toSqliteUtc(now), hours);
  const hourRange = `hour-of-day bias ${signed(Math.min(...hourBias))} to ${signed(Math.max(...hourBias))}`;
  return `saved ${hours.length}h from ${latest.sources.join('+')}; ${corrections.map(describe).join('; ')}; ${hourRange}`;
}

try {
  const summary = run();
  upsertJobCheckin.run(JOB_NAME, 'ok', summary);
  log(summary);
} catch (err) {
  console.error(`${new Date().toISOString()} ${errorMessage(err)}`);
  upsertJobCheckin.run(JOB_NAME, 'error', errorMessage(err));
  process.exitCode = 1;
}
