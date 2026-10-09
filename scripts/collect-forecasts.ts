// Backyard Weather: fetch the current NWS and Open-Meteo (HRRR, NBM, ECMWF)
// forecasts and store one snapshot per source. Run from cron; see
// cron/backyard-weather.crontab. One source failing doesn't stop the others from
// being saved, but the run is reported as an error (exit code 1, job_checkins).
//
//   node --env-file=.env scripts/collect-forecasts.ts

import db from '../db/index.ts';
import { getNwsForecast } from '../nws.ts';
import { getOpenMeteoForecasts } from '../openmeteo.ts';
import { toSqliteUtc } from '../forecast.ts';
import type { Forecast, ForecastSource } from '../forecast.ts';

const JOB_NAME = 'backyard-forecasts';
const HOURS_AHEAD = 18;
const EXPECTED_SOURCES: ForecastSource[] = ['nws', 'om_hrrr', 'om_nbm', 'om_ecmwf'];

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const insertSnapshot = db.prepare(
  'INSERT INTO forecast_snapshots (source, fetched_at, issued_at) VALUES (?, ?, ?)'
);
const insertHour = db.prepare(`
  INSERT INTO forecast_hours (
    snapshot_id, valid_at, temp_f, dewpoint_f, humidity_pct, sky_cover_pct, low_cloud_pct,
    wind_mph, wind_dir_deg, precip_prob_pct, solar_wm2
  ) VALUES (
    @snapshotId, @validAt, @tempF, @dewpointF, @humidityPct, @skyCoverPct, @lowCloudPct,
    @windMph, @windDirDeg, @precipProbPct, @solarWm2
  )
`);
const upsertJobCheckin = db.prepare(`
  INSERT INTO job_checkins (job_name, checked_at, status, message)
  VALUES (?, datetime('now'), ?, ?)
  ON CONFLICT(job_name) DO UPDATE SET
    checked_at = excluded.checked_at,
    status = excluded.status,
    message = excluded.message
`);

const saveForecast = db.transaction((forecast: Forecast, fetchedAt: string) => {
  const { lastInsertRowid } = insertSnapshot.run(forecast.source, fetchedAt, forecast.issuedAt);
  for (const hour of forecast.hours) {
    insertHour.run({ snapshotId: lastInsertRowid, ...hour });
  }
});

async function run(): Promise<{ saved: string[]; errors: string[] }> {
  const now = new Date();
  const fetchedAt = toSqliteUtc(now);
  const saved: string[] = [];
  const errors: string[] = [];
  const savedSources = new Set<ForecastSource>();

  const fetches: Array<[string, Promise<Forecast[]>]> = [
    ['NWS', getNwsForecast(now, HOURS_AHEAD).then((forecast) => [forecast])],
    ['Open-Meteo', getOpenMeteoForecasts(now, HOURS_AHEAD)],
  ];
  const results = await Promise.allSettled(fetches.map(([, promise]) => promise));

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      errors.push(`${fetches[i][0]}: ${errorMessage(result.reason)}`);
      return;
    }
    for (const forecast of result.value) {
      if (!forecast.hours.length) {
        continue; // reported as missing below
      }
      saveForecast(forecast, fetchedAt);
      savedSources.add(forecast.source);
      saved.push(`${forecast.source} ${forecast.hours.length}h`);
    }
  });

  // Covers a model Open-Meteo returned no data for, and a source with no hours in
  // the window, as well as the failed fetches already reported above.
  const missing = EXPECTED_SOURCES.filter((source) => !savedSources.has(source));
  if (missing.length) {
    errors.push(`missing: ${missing.join(', ')}`);
  }
  return { saved, errors };
}

try {
  const { saved, errors } = await run();
  const summary = [`saved ${saved.join(', ') || 'nothing'}`, ...errors].join('; ');
  upsertJobCheckin.run(JOB_NAME, errors.length ? 'error' : 'ok', summary);
  if (errors.length) {
    console.error(`${new Date().toISOString()} ${summary}`);
    process.exitCode = 1;
  } else {
    log(summary);
  }
} catch (err) {
  console.error(`${new Date().toISOString()} ${errorMessage(err)}`);
  upsertJobCheckin.run(JOB_NAME, 'error', errorMessage(err));
  process.exitCode = 1;
}
