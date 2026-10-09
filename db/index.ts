import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const db = new Database(path.join(__dirname, '..', 'overbeck.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS loch_lomond (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recording_date TEXT NOT NULL UNIQUE,
    percent_full REAL NOT NULL,
    water_level REAL,
    daily_production REAL,
    created_timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const lochLomondColumns = new Set(
  (db.prepare('PRAGMA table_info(loch_lomond)').all() as { name: string }[]).map((c) => c.name)
);
if (!lochLomondColumns.has('water_level')) {
  db.exec('ALTER TABLE loch_lomond ADD COLUMN water_level REAL');
}
if (!lochLomondColumns.has('daily_production')) {
  db.exec('ALTER TABLE loch_lomond ADD COLUMN daily_production REAL');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS electric_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usage_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    import_kwh REAL NOT NULL,
    export_kwh REAL NOT NULL,
    cost REAL NOT NULL,
    created_timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(usage_date, start_time)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS gas_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usage_date TEXT NOT NULL UNIQUE,
    therms REAL NOT NULL,
    cost REAL NOT NULL,
    created_timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS billing_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    created_timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(start_date, end_date)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS solar_generation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    generation_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    generation_kwh REAL NOT NULL,
    created_timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(generation_date, start_time)
  )
`);

// Whole-day production totals from Enphase's energy_lifetime endpoint, back to the
// system's 2014 install. Kept apart from solar_generation's 5-minute intervals so a
// daily row is never counted as one interval (or double-counted alongside them).
db.exec(`
  CREATE TABLE IF NOT EXISTS solar_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    generation_date TEXT NOT NULL UNIQUE,
    generation_kwh REAL NOT NULL,
    created_timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    updated_timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// One row per PG&E electric bill segment, from the Opower bill history (back to 2007).
// end_date is exclusive: PG&E's interval ends at midnight, so the bill's last day is
// the day before. What the dollar fields mean changes over time (single NEM amount
// before late 2022, split NEM/minimum fields after, Base Services Charge from 2026-03);
// they're stored as PG&E reports them, nullable where a field didn't exist yet.
db.exec(`
  CREATE TABLE IF NOT EXISTS electric_bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    net_kwh REAL,
    import_kwh REAL,
    export_kwh REAL,
    usage_charges REAL,
    current_amount REAL,
    total_nem_charges REAL,
    deferred_nem_charges REAL,
    energy_purchased REAL,
    total_energy_costs REAL,
    estimated INTEGER NOT NULL DEFAULT 0,
    created_timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    updated_timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(start_date, end_date)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS job_checkins (
    job_name TEXT PRIMARY KEY,
    checked_at TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT
  )
`);

// Backyard Weather. All times are UTC in SQLite's 'YYYY-MM-DD HH:MM:SS' format,
// matching datetime('now'), so they compare correctly as text.

// One row per forecast fetch, per source/model. Every hourly fetch is kept even
// when the source hasn't updated, since "what did the forecast say at 9pm" is
// what gets evaluated.
db.exec(`
  CREATE TABLE IF NOT EXISTS forecast_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL CHECK (source IN ('nws', 'om_hrrr', 'om_nbm', 'om_ecmwf')),
    fetched_at TEXT NOT NULL,
    issued_at TEXT,
    created_timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source, fetched_at)
  )
`);

// The next 18 hours of each snapshot, converted to °F / mph to match
// station_readings. low_cloud_pct is null for NWS (not forecast) and NBM
// (Open-Meteo returns none).
db.exec(`
  CREATE TABLE IF NOT EXISTS forecast_hours (
    snapshot_id INTEGER NOT NULL REFERENCES forecast_snapshots(id),
    valid_at TEXT NOT NULL,
    temp_f REAL,
    dewpoint_f REAL,
    humidity_pct REAL,
    sky_cover_pct REAL,
    low_cloud_pct REAL,
    wind_mph REAL,
    wind_dir_deg REAL,
    precip_prob_pct REAL,
    PRIMARY KEY (snapshot_id, valid_at)
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_forecast_hours_valid_at ON forecast_hours(valid_at)');

// Ambient station history at full 5-minute resolution. Columns are nullable
// since individual sensors can drop out.
db.exec(`
  CREATE TABLE IF NOT EXISTS station_readings (
    observed_at TEXT PRIMARY KEY,
    temp_f REAL,
    dewpoint_f REAL,
    humidity_pct REAL,
    wind_mph REAL,
    gust_mph REAL,
    wind_dir_deg REAL,
    solar_wm2 REAL,
    uv REAL,
    pressure_in REAL,
    rain_hourly_in REAL,
    created_timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Each GET /api/weather/tonight answer with its inputs, to evaluate the
// prediction against the raw forecast and the actual low.
db.exec(`
  CREATE TABLE IF NOT EXISTS tonight_predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requested_at TEXT NOT NULL,
    snapshot_id INTEGER REFERENCES forecast_snapshots(id),
    station_temp_f REAL,
    offset_f REAL,
    forecast_low_f REAL,
    forecast_low_at TEXT,
    predicted_low_f REAL,
    response_text TEXT NOT NULL
  )
`);

export default db;
