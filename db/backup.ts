import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import db from './index.ts';

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

const rawPath = path.join(os.tmpdir(), `overbeck-${timestamp()}.db`);
const gzPath = `${rawPath}.gz`;

await db.backup(rawPath);
await pipeline(fs.createReadStream(rawPath), zlib.createGzip(), fs.createWriteStream(gzPath));
fs.unlinkSync(rawPath);

console.log(gzPath);
