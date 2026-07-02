const fs = require('fs');
const path = require('path');
const db = require('./index');

const csvPath = path.join(__dirname, 'loch_lomond_seed.csv');
const rows = fs.readFileSync(csvPath, 'utf8')
  .trim()
  .split('\n')
  .map((line) => line.split(','));

const insert = db.prepare(
  'INSERT OR IGNORE INTO loch_lomond (recording_date, percent_full) VALUES (?, ?)'
);

const insertAll = db.transaction((rows) => {
  for (const [recordingDate, percentFull] of rows) {
    insert.run(recordingDate, Number(percentFull));
  }
});

insertAll(rows);

const { count } = db.prepare('SELECT COUNT(*) AS count FROM loch_lomond').get();
console.log(`loch_lomond now has ${count} rows`);
