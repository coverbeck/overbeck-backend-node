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

export default db;
