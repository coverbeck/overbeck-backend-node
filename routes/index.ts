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
import { requireSession, setSessionCookie, verifyLogin } from '../middleware/session.ts';

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

interface BillingPeriodRow {
  start_date: string;
  end_date: string;
}

interface PeriodWindow {
  shortLabel: [string, string];
  fullLabel: string;
  windowStart: string;
  windowEnd: string | null; // exclusive; null means open-ended (still in progress)
}

function todayPacific(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Counts how many days of [startDate, endDate] (inclusive) fall in each calendar month,
// in chronological order. Dates are treated as plain calendar days (parsed as UTC) since
// they carry no time-of-day/timezone meaning here.
function daysInMonthBuckets(startDate: string, endDate: string): Array<[string, number]> {
  const bucketMap = new Map<string, number>();
  let cur = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cur.getTime() <= end.getTime()) {
    const key = cur.toISOString().slice(0, 7); // YYYY-MM
    bucketMap.set(key, (bucketMap.get(key) ?? 0) + 1);
    cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000);
  }
  return [...bucketMap.entries()];
}

function monthYear(key: string): { year: number; month: number } {
  const [year, month] = key.split('-').map(Number);
  return { year, month: month - 1 };
}

// Whichever calendar month accounts for the most days in the period (its "primary" month).
// Returned as two lines (Chart.js renders a string[] tick label as centered, wrapped lines).
function formatShortLabel(startDate: string, endDate: string): [string, string] {
  const buckets = daysInMonthBuckets(startDate, endDate);
  const primary = buckets.reduce((max, cur) => (cur[1] > max[1] ? cur : max));
  const { year, month } = monthYear(primary[0]);
  return [MONTH_ABBR[month], String(year).slice(2)];
}

function formatFullLabel(startDate: string, endDate: string): string {
  const format = (dateStr: string) => {
    const [year, month, day] = dateStr.split('-').map(Number);
    return `${MONTH_FULL[month - 1]} ${day}, ${year}`;
  };
  return `${format(startDate)} - ${format(endDate)}`;
}

// PG&E's own bill timeIntervals overlap by a day at each boundary (bill N's end_date is
// one day after bill N+1's start_date), so periods are chained using each other's start_date
// rather than each period's own end_date, which would double-count the boundary day.
function buildPeriodWindows(periods: BillingPeriodRow[]): PeriodWindow[] {
  if (periods.length === 0) return [];

  const windows: PeriodWindow[] = periods.map((p, i) => {
    const next = periods[i + 1];
    return {
      shortLabel: formatShortLabel(p.start_date, p.end_date),
      fullLabel: formatFullLabel(p.start_date, p.end_date),
      windowStart: p.start_date,
      windowEnd: next ? next.start_date : p.end_date,
    };
  });

  const lastEndDate = periods[periods.length - 1].end_date;
  const today = todayPacific();
  if (lastEndDate < today) {
    windows.push({
      shortLabel: formatShortLabel(lastEndDate, today),
      fullLabel: `${formatFullLabel(lastEndDate, today)} (in progress)`,
      windowStart: lastEndDate,
      windowEnd: null,
    });
  }

  return windows;
}

function inWindow(date: string, window: PeriodWindow): boolean {
  return date >= window.windowStart && (window.windowEnd === null || date < window.windowEnd);
}

function safeRedirectTarget(raw: unknown): string {
  if (typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//')) {
    return raw;
  }
  return '/electric-usage';
}

router.get('/login', (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  res.render('login.njk', {
    redirect: safeRedirectTarget(req.query.redirect),
  });
});

router.post('/login', (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  const { username, password } = req.body as { username?: string; password?: string };
  const redirect = safeRedirectTarget((req.body as { redirect?: string }).redirect);

  if (typeof username !== 'string' || typeof password !== 'string' || !verifyLogin(username, password)) {
    res.status(401).render('login.njk', { redirect, error: 'Incorrect username or password.' });
    return;
  }

  setSessionCookie(res);
  res.redirect(redirect);
});

router.get('/electric-usage', requireSession, (req: Request, res: Response) => {
  const electricDaily = db.prepare(`
    SELECT usage_date, SUM(import_kwh) AS import_kwh, SUM(export_kwh) AS export_kwh, SUM(cost) AS cost
    FROM electric_usage
    GROUP BY usage_date
    ORDER BY usage_date
  `).all() as ElectricDailyRow[];

  const gasDaily = db.prepare(
    'SELECT usage_date, therms, cost FROM gas_usage ORDER BY usage_date'
  ).all() as GasDailyRow[];

  const billingPeriods = db.prepare(
    'SELECT start_date, end_date FROM billing_periods ORDER BY start_date ASC'
  ).all() as BillingPeriodRow[];

  const windows = buildPeriodWindows(billingPeriods);

  const periodRows = windows.map((window) => {
    let importKwh = 0;
    let exportKwh = 0;
    let electricCostSum = 0;
    let hasElectric = false;
    for (const row of electricDaily) {
      if (inWindow(row.usage_date, window)) {
        importKwh += row.import_kwh;
        exportKwh += row.export_kwh;
        electricCostSum += row.cost;
        hasElectric = true;
      }
    }

    let therms = 0;
    let gasCostSum = 0;
    let hasGas = false;
    for (const row of gasDaily) {
      if (inWindow(row.usage_date, window)) {
        therms += row.therms;
        gasCostSum += row.cost;
        hasGas = true;
      }
    }

    return {
      shortLabel: window.shortLabel,
      fullLabel: window.fullLabel,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      importKwh,
      exportKwh,
      electricCost: electricCostSum,
      therms,
      gasCost: gasCostSum,
      hasData: hasElectric || hasGas,
    };
  }).filter((row) => row.hasData);

  res.render('electric-usage.njk', {
    periodLabels: periodRows.map((r) => r.shortLabel),
    periodFullLabels: periodRows.map((r) => r.fullLabel),
    periodWindowStarts: periodRows.map((r) => r.windowStart),
    periodWindowEnds: periodRows.map((r) => r.windowEnd),
    electricImportByPeriod: periodRows.map((r) => r.importKwh),
    electricExportByPeriod: periodRows.map((r) => r.exportKwh),
    electricCostByPeriod: periodRows.map((r) => r.electricCost),
    gasThermsByPeriod: periodRows.map((r) => r.therms),
    gasCostByPeriod: periodRows.map((r) => r.gasCost),
    electricDailyDates: electricDaily.map((r) => r.usage_date),
    electricDailyImportKwh: electricDaily.map((r) => r.import_kwh),
    electricDailyExportKwh: electricDaily.map((r) => r.export_kwh),
    electricDailyCost: electricDaily.map((r) => r.cost),
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

interface BillingPeriodInput {
  startDate: string;
  endDate: string;
}

function isBillingPeriod(period: unknown): period is BillingPeriodInput {
  if (typeof period !== 'object' || period === null) return false;
  const p = period as Record<string, unknown>;
  return (
    typeof p.startDate === 'string' && USAGE_DATE_PATTERN.test(p.startDate) &&
    typeof p.endDate === 'string' && USAGE_DATE_PATTERN.test(p.endDate)
  );
}

const insertBillingPeriod = db.prepare(
  'INSERT OR IGNORE INTO billing_periods (start_date, end_date) VALUES (?, ?)'
);

const insertBillingPeriods = db.transaction((periods: BillingPeriodInput[]) => {
  let inserted = 0;
  for (const p of periods) {
    if (insertBillingPeriod.run(p.startDate, p.endDate).changes > 0) {
      inserted++;
    }
  }
  return inserted;
});

router.post('/api/billing-periods', requireAuth, (req: Request, res: Response) => {
  const { periods } = (req.body ?? {}) as { periods?: unknown };

  if (!Array.isArray(periods)) {
    res.status(400).json({ error: 'periods must be an array' });
    return;
  }

  for (const period of periods) {
    if (!isBillingPeriod(period)) {
      res.status(400).json({ error: 'invalid billing period', period });
      return;
    }
  }

  const inserted = periods.length ? insertBillingPeriods(periods as BillingPeriodInput[]) : 0;

  res.status(201).json({
    received: periods.length,
    inserted,
    duplicates: periods.length - inserted,
  });
});

router.get('/api/electric-usage/hourly', requireSession, (req: Request, res: Response) => {
  const date = req.query.date;
  if (typeof date !== 'string' || !USAGE_DATE_PATTERN.test(date)) {
    res.status(400).json({ error: 'date query param must be in YYYY-MM-DD format' });
    return;
  }

  const rows = db.prepare(
    'SELECT start_time, end_time, import_kwh, export_kwh, cost FROM electric_usage WHERE usage_date = ? ORDER BY start_time'
  ).all(date) as { start_time: string; end_time: string; import_kwh: number; export_kwh: number; cost: number }[];

  res.json({
    date,
    startTime: rows.map((r) => r.start_time),
    endTime: rows.map((r) => r.end_time),
    importKwh: rows.map((r) => r.import_kwh),
    exportKwh: rows.map((r) => r.export_kwh),
    cost: rows.map((r) => r.cost),
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
