const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'overbeck.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS loch_lomond (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recording_date TEXT NOT NULL UNIQUE,
    percent_full REAL NOT NULL,
    created_timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

module.exports = db;
