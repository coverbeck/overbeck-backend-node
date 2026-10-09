// Backyard Weather: store the Ambient station's 5-minute readings since the newest
// one already stored. Run from cron; see cron/backyard-weather.crontab. Works at
// any frequency: each run catches up from where the last one left off, so a missed
// run (or a server outage) is filled in by the next one. On an empty table it
// starts with the last day of readings.
//
//   node --env-file=.env scripts/collect-station.ts

import db from '../db/index.ts';
import { getStationHistory, getStationMac } from '../weather.ts';
import type { StationReading } from '../weather.ts';
import { fromSqliteUtc } from '../forecast.ts';

const JOB_NAME = 'backyard-station';

// Each request returns up to 288 readings (one day at 5 minutes) ending at endDate.
// Stepping by a little less than a day leaves some overlap, so readings that aren't
// exactly 5 minutes apart can't fall between requests. Overlaps are ignored on insert.
const STEP_MS = 23 * 3600 * 1000;

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const insertReading = db.prepare(`
  INSERT OR IGNORE INTO station_readings (
    observed_at, temp_f, dewpoint_f, humidity_pct, wind_mph, gust_mph, wind_dir_deg,
    solar_wm2, uv, pressure_in, rain_hourly_in
  ) VALUES (
    @observedAt, @tempF, @dewpointF, @humidityPct, @windMph, @gustMph, @windDirDeg,
    @solarWm2, @uv, @pressureIn, @rainHourlyIn
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

const saveReadings = db.transaction((readings: StationReading[]) => {
  let inserted = 0;
  for (const reading of readings) {
    inserted += insertReading.run(reading).changes;
  }
  return inserted;
});

async function run(): Promise<string> {
  const { latest } = db.prepare(
    'SELECT MAX(observed_at) AS latest FROM station_readings'
  ).get() as { latest: string | null };

  const mac = await getStationMac();
  const nowMs = Date.now();
  let endMs = latest ? Math.min(fromSqliteUtc(latest).getTime() + STEP_MS, nowMs) : nowMs;
  let requests = 0;
  let inserted = 0;
  for (;;) {
    inserted += saveReadings(await getStationHistory(mac, new Date(endMs)));
    requests++;
    if (endMs >= nowMs) {
      break;
    }
    endMs = Math.min(endMs + STEP_MS, nowMs);
  }

  const { newest } = db.prepare(
    'SELECT MAX(observed_at) AS newest FROM station_readings'
  ).get() as { newest: string | null };
  return `inserted ${inserted} readings in ${requests} requests; newest ${newest ?? 'none'}`;
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
