import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const csvPath = path.join(__dirname, 'loch_lomond_seed.csv');
const rows: string[][] = fs.readFileSync(csvPath, 'utf8')
  .trim()
  .split('\n')
  .map((line) => line.split(','));

const insert = db.prepare(
  'INSERT OR IGNORE INTO loch_lomond (recording_date, percent_full) VALUES (?, ?)'
);

const insertAll = db.transaction((rows: string[][]) => {
  for (const [recordingDate, percentFull] of rows) {
    insert.run(recordingDate, Number(percentFull));
  }
});

insertAll(rows);

const { count } = db.prepare('SELECT COUNT(*) AS count FROM loch_lomond').get() as { count: number };
console.log(`loch_lomond now has ${count} rows`);
