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

export default db;
