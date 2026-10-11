// Backyard Weather: load Open-Meteo's archive of forecasts made about a day ahead
// (HRRR, NBM, ECMWF; NWS has no archive) into forecast_snapshots as kind
// 'archive_day1'. The first run backfills from the archive's start (2024-01-19),
// about 33 requests; after that each run continues from the newest archived hour,
// so it can run from cron (see cron/backyard-weather.crontab). Only past hours are
// stored: a future hour's day-ahead value still changes as new runs come out.
//
//   node --env-file=.env scripts/collect-forecast-archive.ts

import db from '../db/index.ts';
import { ARCHIVE_START_DATE, getOpenMeteoArchive } from '../openmeteo.ts';
import { fromSqliteUtc, startOfHour, toSqliteUtc } from '../forecast.ts';
import type { Forecast } from '../forecast.ts';

const JOB_NAME = 'backyard-forecast-archive';
const DAY_MS = 24 * 3600 * 1000;
const CHUNK_DAYS = 31; // about one month per request
const PAUSE_MS = 1000; // between requests, to go easy on a free API

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

// OR IGNORE: an hour already loaded is skipped (its snapshot exists), so runs can overlap.
const insertSnapshot = db.prepare(`
  INSERT OR IGNORE INTO forecast_snapshots (source, fetched_at, issued_at, kind)
  VALUES (?, ?, NULL, 'archive_day1')
`);
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

// One snapshot per source and hour, stamped as made 24 hours before the hour.
const saveForecasts = db.transaction((forecasts: Forecast[]) => {
  let inserted = 0;
  for (const forecast of forecasts) {
    for (const hour of forecast.hours) {
      const madeAt = toSqliteUtc(new Date(fromSqliteUtc(hour.validAt).getTime() - DAY_MS));
      const { changes, lastInsertRowid } = insertSnapshot.run(forecast.source, madeAt);
      if (changes) {
        insertHour.run({ snapshotId: lastInsertRowid, ...hour });
        inserted++;
      }
    }
  }
  return inserted;
});

async function run(): Promise<string> {
  const { latest } = db.prepare(`
    SELECT MAX(h.valid_at) AS latest
    FROM forecast_hours h
    JOIN forecast_snapshots s ON s.id = h.snapshot_id
    WHERE s.kind = 'archive_day1'
  `).get() as { latest: string | null };

  // Re-request the newest archived day; the hours already stored are skipped.
  const startMs = latest
    ? startOfUtcDay(fromSqliteUtc(latest).getTime())
    : fromSqliteUtc(`${ARCHIVE_START_DATE} 00:00:00`).getTime();
  const endMs = startOfHour(new Date()).getTime();

  let requests = 0;
  let inserted = 0;
  for (let chunkStart = startMs; chunkStart < endMs; chunkStart += CHUNK_DAYS * DAY_MS) {
    if (requests) {
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    }
    const chunkEnd = Math.min(chunkStart + CHUNK_DAYS * DAY_MS, endMs);
    inserted += saveForecasts(await getOpenMeteoArchive(new Date(chunkStart), new Date(chunkEnd)));
    requests++;
  }

  const { newest } = db.prepare(`
    SELECT MAX(h.valid_at) AS newest
    FROM forecast_hours h
    JOIN forecast_snapshots s ON s.id = h.snapshot_id
    WHERE s.kind = 'archive_day1'
  `).get() as { newest: string | null };
  return `inserted ${inserted} archived forecast hours in ${requests} requests; newest ${newest ?? 'none'}`;
}

try {
  const summary = await run();
  upsertJobCheckin.run(JOB_NAME, 'ok', summary);
  log(summary);
} catch (err) {
  console.error(`${new Date().toISOString()} ${errorMessage(err)}`);
  upsertJobCheckin.run(JOB_NAME, 'error', errorMessage(err));
  process.exitCode = 1;
}
