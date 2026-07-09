import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import type { Router, Request, Response } from 'express';
import { marked } from 'marked';
import db from '../db/index.ts';
import { getCurrentWeather } from '../weather.ts';
import type { WeatherReading } from '../weather.ts';
import { requireAuth } from '../middleware/auth.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RSO_CONTENT_DIR = path.join(__dirname, '..', 'content', 'rso');

const router: Router = express.Router();

router.get('/', (req: Request, res: Response) => {
  res.render('home.njk');
});

interface LochLomondRow {
  recording_date: string;
  percent_full: number;
}

router.get('/weather', async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  const readings = db.prepare(
    'SELECT recording_date, percent_full FROM loch_lomond ORDER BY recording_date'
  ).all() as LochLomondRow[];

  let weather: WeatherReading | null = null;
  let weatherError: string | null = null;
  try {
    weather = await getCurrentWeather();
  } catch (err) {
    weatherError = err instanceof Error ? err.message : 'Unknown error fetching weather';
  }

  res.render('weather.njk', {
    weather,
    weatherError,
    labels: readings.map((r) => r.recording_date),
    values: readings.map((r) => r.percent_full),
    lastChecked: readings.length ? readings[readings.length - 1].recording_date : null,
  });
});

interface ElectricDailyRow {
  usage_date: string;
  import_kwh: number;
  export_kwh: number;
  cost: number;
}

interface GasDailyRow {
  usage_date: string;
  therms: number;
  cost: number;
}

router.get('/electric-usage', requireAuth, (req: Request, res: Response) => {
  const electricDaily = db.prepare(`
    SELECT usage_date, SUM(import_kwh) AS import_kwh, SUM(export_kwh) AS export_kwh, SUM(cost) AS cost
    FROM electric_usage
    GROUP BY usage_date
    ORDER BY usage_date
  `).all() as ElectricDailyRow[];

  const gasDaily = db.prepare(
    'SELECT usage_date, therms, cost FROM gas_usage ORDER BY usage_date'
  ).all() as GasDailyRow[];

  res.render('electric-usage.njk', {
    electricLabels: electricDaily.map((r) => r.usage_date),
    electricImport: electricDaily.map((r) => r.import_kwh),
    electricExport: electricDaily.map((r) => r.export_kwh),
    electricCost: electricDaily.map((r) => r.cost),
    gasLabels: gasDaily.map((r) => r.usage_date),
    gasTherms: gasDaily.map((r) => r.therms),
    gasCost: gasDaily.map((r) => r.cost),
    lastElectric: electricDaily.length ? electricDaily[electricDaily.length - 1].usage_date : null,
    lastGas: gasDaily.length ? gasDaily[gasDaily.length - 1].usage_date : null,
  });
});

const RSO_FILENAME_PATTERN = /^[A-Za-z0-9_-]+\.md$/;

function renderRsoPage(res: Response, filename: string, showImage: boolean) {
  if (!RSO_FILENAME_PATTERN.test(filename)) {
    res.status(404).send('Not found');
    return;
  }

  const filePath = path.join(RSO_CONTENT_DIR, filename);
  let markdown: string;
  try {
    markdown = fs.readFileSync(filePath, 'utf8');
  } catch {
    res.status(404).send('Not found');
    return;
  }

  res.render('rso.njk', {
    contentHtml: marked.parse(markdown, { async: false }),
    showImage,
  });
}

router.get('/rso', (req: Request, res: Response) => {
  renderRsoPage(res, 'MyFather.md', true);
});

router.get('/rso/:page', (req: Request, res: Response) => {
  const page = req.params.page;
  if (typeof page !== 'string') {
    res.status(404).send('Not found');
    return;
  }
  renderRsoPage(res, page, false);
});

const RECORDING_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const insertLochLomondReading = db.prepare(
  'INSERT OR IGNORE INTO loch_lomond (recording_date, percent_full, water_level, daily_production) VALUES (?, ?, ?, ?)'
);

router.post('/api/loch-lomond', requireAuth, (req: Request, res: Response) => {
  const { recordingDate, percentFull, waterLevel, dailyProduction } = req.body ?? {};

  if (typeof recordingDate !== 'string' || !RECORDING_DATE_PATTERN.test(recordingDate)) {
    res.status(400).json({ error: 'recordingDate must be a string in YYYY-MM-DD format' });
    return;
  }
  if (typeof percentFull !== 'number' || !Number.isFinite(percentFull)) {
    res.status(400).json({ error: 'percentFull must be a finite number' });
    return;
  }
  if (waterLevel !== undefined && (typeof waterLevel !== 'number' || !Number.isFinite(waterLevel))) {
    res.status(400).json({ error: 'waterLevel must be a finite number if provided' });
    return;
  }
  if (
    dailyProduction !== undefined &&
    (typeof dailyProduction !== 'number' || !Number.isFinite(dailyProduction))
  ) {
    res.status(400).json({ error: 'dailyProduction must be a finite number if provided' });
    return;
  }

  const result = insertLochLomondReading.run(
    recordingDate,
    percentFull,
    waterLevel ?? null,
    dailyProduction ?? null
  );

  if (result.changes === 0) {
    res.status(200).json({ duplicate: true, recordingDate, percentFull, waterLevel, dailyProduction });
    return;
  }

  res.status(201).json({ duplicate: false, recordingDate, percentFull, waterLevel, dailyProduction });
});

const USAGE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;

interface ElectricReadingInput {
  usageDate: string;
  startTime: string;
  endTime: string;
  importKwh: number;
  exportKwh: number;
  cost: number;
}

interface GasReadingInput {
  usageDate: string;
  therms: number;
  cost: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isElectricReading(reading: unknown): reading is ElectricReadingInput {
  if (typeof reading !== 'object' || reading === null) return false;
  const r = reading as Record<string, unknown>;
  return (
    typeof r.usageDate === 'string' && USAGE_DATE_PATTERN.test(r.usageDate) &&
    typeof r.startTime === 'string' && TIME_PATTERN.test(r.startTime) &&
    typeof r.endTime === 'string' && TIME_PATTERN.test(r.endTime) &&
    isFiniteNumber(r.importKwh) &&
    isFiniteNumber(r.exportKwh) &&
    isFiniteNumber(r.cost)
  );
}

function isGasReading(reading: unknown): reading is GasReadingInput {
  if (typeof reading !== 'object' || reading === null) return false;
  const r = reading as Record<string, unknown>;
  return (
    typeof r.usageDate === 'string' && USAGE_DATE_PATTERN.test(r.usageDate) &&
    isFiniteNumber(r.therms) &&
    isFiniteNumber(r.cost)
  );
}

const insertElectricReading = db.prepare(
  'INSERT OR IGNORE INTO electric_usage (usage_date, start_time, end_time, import_kwh, export_kwh, cost) VALUES (?, ?, ?, ?, ?, ?)'
);
const insertGasReading = db.prepare(
  'INSERT OR IGNORE INTO gas_usage (usage_date, therms, cost) VALUES (?, ?, ?)'
);

const insertElectricReadings = db.transaction((readings: ElectricReadingInput[]) => {
  let inserted = 0;
  for (const r of readings) {
    if (insertElectricReading.run(r.usageDate, r.startTime, r.endTime, r.importKwh, r.exportKwh, r.cost).changes > 0) {
      inserted++;
    }
  }
  return inserted;
});

const insertGasReadings = db.transaction((readings: GasReadingInput[]) => {
  let inserted = 0;
  for (const r of readings) {
    if (insertGasReading.run(r.usageDate, r.therms, r.cost).changes > 0) {
      inserted++;
    }
  }
  return inserted;
});

router.post('/api/electric-usage', requireAuth, (req: Request, res: Response) => {
  const { electric, gas } = (req.body ?? {}) as { electric?: unknown; gas?: unknown };

  if (electric === undefined && gas === undefined) {
    res.status(400).json({ error: 'at least one of electric or gas must be provided' });
    return;
  }
  if (electric !== undefined && !Array.isArray(electric)) {
    res.status(400).json({ error: 'electric must be an array if provided' });
    return;
  }
  if (gas !== undefined && !Array.isArray(gas)) {
    res.status(400).json({ error: 'gas must be an array if provided' });
    return;
  }

  const electricReadings = (electric ?? []) as unknown[];
  const gasReadings = (gas ?? []) as unknown[];

  for (const reading of electricReadings) {
    if (!isElectricReading(reading)) {
      res.status(400).json({ error: 'invalid electric reading', reading });
      return;
    }
  }
  for (const reading of gasReadings) {
    if (!isGasReading(reading)) {
      res.status(400).json({ error: 'invalid gas reading', reading });
      return;
    }
  }

  const electricInserted = electricReadings.length
    ? insertElectricReadings(electricReadings as ElectricReadingInput[])
    : 0;
  const gasInserted = gasReadings.length ? insertGasReadings(gasReadings as GasReadingInput[]) : 0;

  res.status(201).json({
    electric: {
      received: electricReadings.length,
      inserted: electricInserted,
      duplicates: electricReadings.length - electricInserted,
    },
    gas: {
      received: gasReadings.length,
      inserted: gasInserted,
      duplicates: gasReadings.length - gasInserted,
    },
  });
});

router.get('/api/electric-usage/latest', requireAuth, (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');

  const electricLatest = db.prepare(
    'SELECT usage_date, start_time FROM electric_usage ORDER BY usage_date DESC, start_time DESC LIMIT 1'
  ).get() as { usage_date: string; start_time: string } | undefined;

  const gasLatest = db.prepare(
    'SELECT usage_date FROM gas_usage ORDER BY usage_date DESC LIMIT 1'
  ).get() as { usage_date: string } | undefined;

  res.json({
    electric: electricLatest ? { usageDate: electricLatest.usage_date, startTime: electricLatest.start_time } : null,
    gas: gasLatest ? { usageDate: gasLatest.usage_date } : null,
  });
});

export default router;
