import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import type { Router, Request, Response } from 'express';
import { marked } from 'marked';
import db from '../db/index.ts';
import { getCurrentWeather, getPublicStationReading, REFERENCE_STATIONS, PARKS } from '../weather.ts';
import type { WeatherReading, PublicStationReading } from '../weather.ts';
import { getForecastComparison, LEAD_HOURS, RANGE_DAYS } from '../forecastComparison.ts';
import { requireAuth } from '../middleware/auth.ts';
import { requireSession, setSessionCookie, verifyLogin } from '../middleware/session.ts';
import { computeNemYears, computeSolarSavings, RATES_EFFECTIVE_FROM } from '../solarSavings.ts';
import { computePayback, estimateYearsFromBills, peakShareFromHourly } from '../solarPayback.ts';

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
  let weather: WeatherReading | null = null;
  let weatherError: string | null = null;
  try {
    weather = await getCurrentWeather();
  } catch (err) {
    weatherError = err instanceof Error ? err.message : 'Unknown error fetching weather';
  }

  const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY || null;
  const weatherMapLat = process.env.WEATHER_MAP_LAT ? Number(process.env.WEATHER_MAP_LAT) : null;
  const weatherMapLon = process.env.WEATHER_MAP_LON ? Number(process.env.WEATHER_MAP_LON) : null;

  const referenceStations = (await Promise.all(
    REFERENCE_STATIONS.map(async (station) => {
      const reading = await getPublicStationReading(station.slug);
      return reading && { ...reading, group: station.group };
    })
  )).filter((s): s is PublicStationReading & { group: 'derby' | 'brommer' } => Boolean(s));

  res.render('weather.njk', {
    activeTab: 'current',
    weather,
    weatherError,
    googleMapsApiKey,
    weatherMapLat,
    weatherMapLon,
    referenceStations,
    parks: PARKS,
  });
});

router.get('/weather/forecast', (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  const days = RANGE_DAYS.find((d) => d === Number(req.query.days)) ?? 1;
  const lead = LEAD_HOURS.find((h) => h === Number(req.query.lead)) ?? 0;
  res.render('weather-forecast.njk', {
    activeTab: 'forecast',
    days,
    lead,
    rangeDays: RANGE_DAYS,
    leadHours: LEAD_HOURS,
    comparison: getForecastComparison(new Date(), days, lead),
  });
});

router.get('/weather/loch-lomond', (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  const readings = db.prepare(
    'SELECT recording_date, percent_full FROM loch_lomond ORDER BY recording_date'
  ).all() as LochLomondRow[];

  res.render('weather-loch-lomond.njk', {
    activeTab: 'loch-lomond',
    labels: readings.map((r) => r.recording_date),
    values: readings.map((r) => r.percent_full),
    lastChecked: readings.length ? formatFriendlyDate(readings[readings.length - 1].recording_date) : null,
    lochLomondCheckin: getJobCheckin('loch-lomond'),
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

interface SolarDailyRow {
  generation_date: string;
  generation_kwh: number;
}

interface BillingPeriodRow {
  start_date: string;
  end_date: string;
}

interface PeriodWindow {
  shortLabel: string;
  fullLabel: string;
  rangeLabel: string;
  windowStart: string;
  windowEnd: string | null; // exclusive; null means open-ended (still in progress)
}

function todayPacific(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

interface JobCheckinRow {
  checked_at: string;
  status: string;
  message: string | null;
}

interface JobCheckin {
  checkedAtDate: string;
  status: string;
  message: string | null;
}

function getJobCheckin(jobName: string): JobCheckin | null {
  const row = db.prepare(
    'SELECT checked_at, status, message FROM job_checkins WHERE job_name = ?'
  ).get(jobName) as JobCheckinRow | undefined;
  if (!row) return null;

  const checkedAtDate = new Date(`${row.checked_at.replace(' ', 'T')}Z`)
    .toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  return { checkedAtDate: formatFriendlyDate(checkedAtDate), status: row.status, message: row.message };
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// e.g. "Friday, July 24". Dates are treated as plain calendar days (parsed as
// UTC) since they carry no time-of-day/timezone meaning here.
function formatFriendlyDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const weekday = WEEKDAY_FULL[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday}, ${MONTH_FULL[month - 1]} ${day}`;
}

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
// The year is only appended for January, since consecutive periods are otherwise always in
// the same year and repeating it on every tick label is redundant.
function formatShortLabel(startDate: string, endDate: string): string {
  const buckets = daysInMonthBuckets(startDate, endDate);
  const primary = buckets.reduce((max, cur) => (cur[1] > max[1] ? cur : max));
  const { year, month } = monthYear(primary[0]);
  return month === 0 ? `${MONTH_ABBR[month]} ${String(year).slice(2)}` : MONTH_ABBR[month];
}

function formatFullLabel(startDate: string, endDate: string): string {
  const format = (dateStr: string) => {
    const [year, month, day] = dateStr.split('-').map(Number);
    return `${MONTH_FULL[month - 1]} ${day}, ${year}`;
  };
  return `${format(startDate)} - ${format(endDate)}`;
}

// Compact form of formatFullLabel, e.g. "Jul 27 - Aug 27, 2026", for table cells.
function formatRangeLabel(startDate: string, endDate: string): string {
  const format = (dateStr: string) => {
    const [, month, day] = dateStr.split('-').map(Number);
    return `${MONTH_ABBR[month - 1]} ${day}`;
  };
  return `${format(startDate)} - ${format(endDate)}, ${endDate.slice(0, 4)}`;
}

// PG&E's own bill timeIntervals overlap by a day at each boundary (bill N's end_date is
// one day after bill N+1's start_date), so periods are chained using each other's start_date
// rather than each period's own end_date, which would double-count the boundary day.
function buildPeriodWindows(periods: BillingPeriodRow[], lastDataDate: string | null): PeriodWindow[] {
  if (periods.length === 0) return [];

  const windows: PeriodWindow[] = periods.map((p, i) => {
    const next = periods[i + 1];
    return {
      shortLabel: formatShortLabel(p.start_date, p.end_date),
      fullLabel: formatFullLabel(p.start_date, p.end_date),
      rangeLabel: formatRangeLabel(p.start_date, p.end_date),
      windowStart: p.start_date,
      windowEnd: next ? next.start_date : p.end_date,
    };
  });

  // The newest period has no successor to chain to, so its end comes back a day to
  // where the next one will start.
  const lastEndDate = previousDay(periods[periods.length - 1].end_date);
  windows[windows.length - 1].windowEnd = lastEndDate;
  const today = todayPacific();
  if (lastEndDate < today) {
    // Label the in-progress period through the last date we actually have data
    // for, not through today — PG&E's data (especially gas) can lag a day or
    // more behind the calendar date this page happens to be checked on.
    const labelEndDate = lastDataDate && lastDataDate > lastEndDate ? lastDataDate : lastEndDate;
    windows.push({
      shortLabel: formatShortLabel(lastEndDate, labelEndDate),
      fullLabel: `${formatFullLabel(lastEndDate, labelEndDate)} (in progress)`,
      rangeLabel: formatRangeLabel(lastEndDate, labelEndDate),
      windowStart: lastEndDate,
      windowEnd: null,
    });
  }

  return windows;
}

function previousDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
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

  const solarDaily = db.prepare(`
    SELECT generation_date, SUM(generation_kwh) AS generation_kwh
    FROM solar_generation
    GROUP BY generation_date
    ORDER BY generation_date
  `).all() as SolarDailyRow[];

  const billingPeriods = db.prepare(
    'SELECT start_date, end_date FROM billing_periods ORDER BY start_date ASC'
  ).all() as BillingPeriodRow[];

  const lastDataDate = [
    electricDaily.length ? electricDaily[electricDaily.length - 1].usage_date : null,
    gasDaily.length ? gasDaily[gasDaily.length - 1].usage_date : null,
  ].filter((d): d is string => d !== null).sort().at(-1) ?? null;

  const windows = buildPeriodWindows(billingPeriods, lastDataDate);

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

    let solarKwh = 0;
    let hasSolar = false;
    for (const row of solarDaily) {
      if (inWindow(row.generation_date, window)) {
        solarKwh += row.generation_kwh;
        hasSolar = true;
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
      // null (not 0) when this period has no solar data yet, distinguishing "not backfilled"
      // from "generated zero" — same convention as the daily solarKwhByDate lookup.
      solarKwh: hasSolar ? solarKwh : null,
      hasData: hasElectric || hasGas,
    };
  }).filter((row) => row.hasData);

  const hourlyUsage = (db.prepare(`
    SELECT usage_date, start_time, import_kwh, export_kwh
    FROM electric_usage
    WHERE usage_date >= ?
    ORDER BY usage_date, start_time
  `).all(RATES_EFFECTIVE_FROM) as { usage_date: string; start_time: string; import_kwh: number; export_kwh: number }[])
    .map((r) => ({ usageDate: r.usage_date, startTime: r.start_time, importKwh: r.import_kwh, exportKwh: r.export_kwh }));

  // Same 5-minute -> hour-bucket rollup as /api/electric-usage/hourly.
  const solarHourlyRows = db.prepare(`
    SELECT generation_date, substr(start_time, 1, 2) || ':00' AS hour_start, SUM(generation_kwh) AS generation_kwh
    FROM solar_generation
    WHERE generation_date >= ?
    GROUP BY generation_date, hour_start
  `).all(RATES_EFFECTIVE_FROM) as { generation_date: string; hour_start: string; generation_kwh: number }[];

  const solarCountRows = db.prepare(`
    SELECT generation_date, COUNT(*) AS count
    FROM solar_generation
    WHERE generation_date >= ?
    GROUP BY generation_date
  `).all(RATES_EFFECTIVE_FROM) as { generation_date: string; count: number }[];

  const solarKwhByHour = new Map(solarHourlyRows.map((r) => [`${r.generation_date} ${r.hour_start}`, r.generation_kwh]));
  const solarIntervalCountByDate = new Map(solarCountRows.map((r) => [r.generation_date, r.count]));
  const savingsRows = computeSolarSavings(
    windows.map((w) => ({ label: w.rangeLabel, windowStart: w.windowStart, windowEnd: w.windowEnd })),
    hourlyUsage,
    solarKwhByHour,
    solarIntervalCountByDate,
  );

  const bills = db.prepare(`
    SELECT start_date, end_date, net_kwh, usage_charges, total_nem_charges
    FROM electric_bills
    WHERE net_kwh IS NOT NULL
    ORDER BY start_date
  `).all() as { start_date: string; end_date: string; net_kwh: number; usage_charges: number | null; total_nem_charges: number | null }[];
  const solarDailyHistory = db.prepare(
    'SELECT generation_date, generation_kwh FROM solar_daily'
  ).all() as { generation_date: string; generation_kwh: number }[];
  // From 2025 the hourly model's bundled-rate bill with solar stands in for the bills'
  // NEM charges, which by then cover PG&E delivery only (and are gone after March 2026).
  const modeledBills = computeSolarSavings(
    bills.filter((b) => b.start_date >= RATES_EFFECTIVE_FROM)
      .map((b) => ({ label: b.start_date, windowStart: b.start_date, windowEnd: b.end_date })),
    hourlyUsage,
    solarKwhByHour,
    solarIntervalCountByDate,
  );
  const billYears = estimateYearsFromBills(
    bills.map((b) => ({
      startDate: b.start_date,
      endDate: b.end_date,
      netKwh: b.net_kwh,
      nemCharges: b.start_date >= RATES_EFFECTIVE_FROM ? null : b.total_nem_charges ?? b.usage_charges,
    })),
    new Map(solarDailyHistory.map((r) => [r.generation_date, r.generation_kwh])),
    peakShareFromHourly(hourlyUsage, solarKwhByHour, solarIntervalCountByDate),
    new Map(modeledBills.map((r) => [r.windowStart, r.actualCost])),
  );
  const payback = computePayback(billYears, computeNemYears(savingsRows));

  res.render('electric-usage.njk', {
    payback,
    periodLabels: periodRows.map((r) => r.shortLabel),
    periodFullLabels: periodRows.map((r) => r.fullLabel),
    periodWindowStarts: periodRows.map((r) => r.windowStart),
    periodWindowEnds: periodRows.map((r) => r.windowEnd),
    electricImportByPeriod: periodRows.map((r) => r.importKwh),
    electricExportByPeriod: periodRows.map((r) => r.exportKwh),
    electricCostByPeriod: periodRows.map((r) => r.electricCost),
    gasThermsByPeriod: periodRows.map((r) => r.therms),
    gasCostByPeriod: periodRows.map((r) => r.gasCost),
    solarKwhByPeriod: periodRows.map((r) => r.solarKwh),
    electricDailyDates: electricDaily.map((r) => r.usage_date),
    electricDailyImportKwh: electricDaily.map((r) => r.import_kwh),
    electricDailyExportKwh: electricDaily.map((r) => r.export_kwh),
    electricDailyCost: electricDaily.map((r) => r.cost),
    solarDailyDates: solarDaily.map((r) => r.generation_date),
    solarDailyKwh: solarDaily.map((r) => r.generation_kwh),
    lastElectric: electricDaily.length ? formatFriendlyDate(electricDaily[electricDaily.length - 1].usage_date) : null,
    lastGas: gasDaily.length ? formatFriendlyDate(gasDaily[gasDaily.length - 1].usage_date) : null,
    electricUsageCheckin: getJobCheckin('electric-usage'),
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

const JOB_NAME_PATTERN = /^[a-z0-9-]+$/;

const upsertJobCheckin = db.prepare(`
  INSERT INTO job_checkins (job_name, checked_at, status, message)
  VALUES (?, datetime('now'), ?, ?)
  ON CONFLICT(job_name) DO UPDATE SET
    checked_at = excluded.checked_at,
    status = excluded.status,
    message = excluded.message
`);

router.post('/api/job-checkins', requireAuth, (req: Request, res: Response) => {
  const { jobName, status, message } = req.body ?? {};

  if (typeof jobName !== 'string' || !JOB_NAME_PATTERN.test(jobName)) {
    res.status(400).json({ error: 'jobName must be a non-empty lowercase alphanumeric/hyphen string' });
    return;
  }
  if (status !== 'ok' && status !== 'error') {
    res.status(400).json({ error: 'status must be "ok" or "error"' });
    return;
  }
  if (message !== undefined && message !== null && typeof message !== 'string') {
    res.status(400).json({ error: 'message must be a string if provided' });
    return;
  }

  upsertJobCheckin.run(jobName, status, message ?? null);
  res.status(200).json({ jobName, status, message: message ?? null });
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

interface SolarReadingInput {
  generationDate: string;
  startTime: string;
  endTime: string;
  generationKwh: number;
}

function isSolarReading(reading: unknown): reading is SolarReadingInput {
  if (typeof reading !== 'object' || reading === null) return false;
  const r = reading as Record<string, unknown>;
  return (
    typeof r.generationDate === 'string' && USAGE_DATE_PATTERN.test(r.generationDate) &&
    typeof r.startTime === 'string' && r.startTime.length > 0 &&
    typeof r.endTime === 'string' && r.endTime.length > 0 &&
    isFiniteNumber(r.generationKwh)
  );
}

const insertSolarReading = db.prepare(
  'INSERT OR IGNORE INTO solar_generation (generation_date, start_time, end_time, generation_kwh) VALUES (?, ?, ?, ?)'
);

const insertSolarReadings = db.transaction((readings: SolarReadingInput[]) => {
  let inserted = 0;
  for (const r of readings) {
    if (insertSolarReading.run(r.generationDate, r.startTime, r.endTime, r.generationKwh).changes > 0) {
      inserted++;
    }
  }
  return inserted;
});

router.post('/api/solar-generation', requireAuth, (req: Request, res: Response) => {
  const { readings } = (req.body ?? {}) as { readings?: unknown };

  if (!Array.isArray(readings)) {
    res.status(400).json({ error: 'readings must be an array' });
    return;
  }

  for (const reading of readings) {
    if (!isSolarReading(reading)) {
      res.status(400).json({ error: 'invalid solar reading', reading });
      return;
    }
  }

  const inserted = readings.length ? insertSolarReadings(readings as SolarReadingInput[]) : 0;

  res.status(201).json({
    received: readings.length,
    inserted,
    duplicates: readings.length - inserted,
  });
});

router.get('/api/solar-generation/latest', requireAuth, (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');

  const latest = db.prepare(
    'SELECT generation_date, start_time FROM solar_generation ORDER BY generation_date DESC, start_time DESC LIMIT 1'
  ).get() as { generation_date: string; start_time: string } | undefined;

  res.json({
    latest: latest ? { generationDate: latest.generation_date, startTime: latest.start_time } : null,
  });
});

router.get('/api/solar-generation/dates', requireAuth, (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');

  // Counts (not just presence) so callers can tell a fully-backfilled date apart from
  // one that only got a partial day's worth of readings (e.g. a date that was fetched
  // while it was still "today" and never completed) — see fetch-enphase.js's
  // completeness check, which skipped this distinction until 2026-09-03 and got a date
  // permanently stuck with a partial day's data as a result.
  const rows = db.prepare(
    'SELECT generation_date, COUNT(*) AS count FROM solar_generation GROUP BY generation_date ORDER BY generation_date'
  ).all() as { generation_date: string; count: number }[];

  res.json({
    dates: rows.map((r) => r.generation_date),
    counts: Object.fromEntries(rows.map((r) => [r.generation_date, r.count])),
  });
});

interface SolarDailyInput {
  generationDate: string;
  generationKwh: number;
}

function isSolarDaily(reading: unknown): reading is SolarDailyInput {
  if (typeof reading !== 'object' || reading === null) return false;
  const r = reading as Record<string, unknown>;
  return (
    typeof r.generationDate === 'string' && USAGE_DATE_PATTERN.test(r.generationDate) &&
    isFiniteNumber(r.generationKwh)
  );
}

const selectSolarDaily = db.prepare('SELECT generation_kwh FROM solar_daily WHERE generation_date = ?');
const insertSolarDaily = db.prepare('INSERT INTO solar_daily (generation_date, generation_kwh) VALUES (?, ?)');
const updateSolarDaily = db.prepare(
  "UPDATE solar_daily SET generation_kwh = ?, updated_timestamp = datetime('now') WHERE generation_date = ?"
);

// Upserts rather than INSERT OR IGNORE: a day fetched before it ended holds a partial
// total, and a later fetch should replace it.
const upsertSolarDailies = db.transaction((readings: SolarDailyInput[]) => {
  let inserted = 0;
  let updated = 0;
  for (const r of readings) {
    const existing = selectSolarDaily.get(r.generationDate) as { generation_kwh: number } | undefined;
    if (!existing) {
      insertSolarDaily.run(r.generationDate, r.generationKwh);
      inserted++;
    } else if (existing.generation_kwh !== r.generationKwh) {
      updateSolarDaily.run(r.generationKwh, r.generationDate);
      updated++;
    }
  }
  return { inserted, updated };
});

router.post('/api/solar-daily', requireAuth, (req: Request, res: Response) => {
  const { readings } = (req.body ?? {}) as { readings?: unknown };

  if (!Array.isArray(readings)) {
    res.status(400).json({ error: 'readings must be an array' });
    return;
  }

  for (const reading of readings) {
    if (!isSolarDaily(reading)) {
      res.status(400).json({ error: 'invalid solar daily reading', reading });
      return;
    }
  }

  const { inserted, updated } = readings.length
    ? upsertSolarDailies(readings as SolarDailyInput[])
    : { inserted: 0, updated: 0 };

  res.status(201).json({
    received: readings.length,
    inserted,
    updated,
    unchanged: readings.length - inserted - updated,
  });
});

const ELECTRIC_BILL_AMOUNT_FIELDS = [
  'netKwh',
  'importKwh',
  'exportKwh',
  'usageCharges',
  'currentAmount',
  'totalNemCharges',
  'deferredNemCharges',
  'energyPurchased',
  'totalEnergyCosts',
] as const;

type ElectricBillAmountField = (typeof ELECTRIC_BILL_AMOUNT_FIELDS)[number];

type ElectricBillInput = {
  startDate: string;
  endDate: string;
  estimated: boolean;
} & Record<ElectricBillAmountField, number | null>;

function isElectricBill(bill: unknown): bill is ElectricBillInput {
  if (typeof bill !== 'object' || bill === null) return false;
  const b = bill as Record<string, unknown>;
  return (
    typeof b.startDate === 'string' && USAGE_DATE_PATTERN.test(b.startDate) &&
    typeof b.endDate === 'string' && USAGE_DATE_PATTERN.test(b.endDate) &&
    b.startDate < b.endDate &&
    typeof b.estimated === 'boolean' &&
    ELECTRIC_BILL_AMOUNT_FIELDS.every((field) => b[field] === null || isFiniteNumber(b[field]))
  );
}

interface ElectricBillRow {
  net_kwh: number | null;
  import_kwh: number | null;
  export_kwh: number | null;
  usage_charges: number | null;
  current_amount: number | null;
  total_nem_charges: number | null;
  deferred_nem_charges: number | null;
  energy_purchased: number | null;
  total_energy_costs: number | null;
  estimated: number;
}

function electricBillValues(b: ElectricBillInput): ElectricBillRow {
  return {
    net_kwh: b.netKwh,
    import_kwh: b.importKwh,
    export_kwh: b.exportKwh,
    usage_charges: b.usageCharges,
    current_amount: b.currentAmount,
    total_nem_charges: b.totalNemCharges,
    deferred_nem_charges: b.deferredNemCharges,
    energy_purchased: b.energyPurchased,
    total_energy_costs: b.totalEnergyCosts,
    estimated: b.estimated ? 1 : 0,
  };
}

const ELECTRIC_BILL_COLUMNS = [
  'net_kwh', 'import_kwh', 'export_kwh', 'usage_charges', 'current_amount',
  'total_nem_charges', 'deferred_nem_charges', 'energy_purchased', 'total_energy_costs', 'estimated',
] as const satisfies readonly (keyof ElectricBillRow)[];

const selectElectricBill = db.prepare(
  `SELECT ${ELECTRIC_BILL_COLUMNS.join(', ')} FROM electric_bills WHERE start_date = ? AND end_date = ?`
);
const insertElectricBill = db.prepare(`
  INSERT INTO electric_bills (start_date, end_date, ${ELECTRIC_BILL_COLUMNS.join(', ')})
  VALUES (@start_date, @end_date, ${ELECTRIC_BILL_COLUMNS.map((c) => `@${c}`).join(', ')})
`);
const updateElectricBill = db.prepare(`
  UPDATE electric_bills
  SET ${ELECTRIC_BILL_COLUMNS.map((c) => `${c} = @${c}`).join(', ')}, updated_timestamp = datetime('now')
  WHERE start_date = @start_date AND end_date = @end_date
`);

// Upserts so a rerun picks up any later PG&E correction to a bill's amounts.
const upsertElectricBills = db.transaction((bills: ElectricBillInput[]) => {
  let inserted = 0;
  let updated = 0;
  for (const b of bills) {
    const values = { start_date: b.startDate, end_date: b.endDate, ...electricBillValues(b) };
    const existing = selectElectricBill.get(b.startDate, b.endDate) as ElectricBillRow | undefined;
    if (!existing) {
      insertElectricBill.run(values);
      inserted++;
    } else if (ELECTRIC_BILL_COLUMNS.some((c) => existing[c] !== values[c])) {
      updateElectricBill.run(values);
      updated++;
    }
  }
  return { inserted, updated };
});

router.post('/api/electric-bills', requireAuth, (req: Request, res: Response) => {
  const { bills } = (req.body ?? {}) as { bills?: unknown };

  if (!Array.isArray(bills)) {
    res.status(400).json({ error: 'bills must be an array' });
    return;
  }

  for (const bill of bills) {
    if (!isElectricBill(bill)) {
      res.status(400).json({ error: 'invalid electric bill', bill });
      return;
    }
  }

  const { inserted, updated } = bills.length
    ? upsertElectricBills(bills as ElectricBillInput[])
    : { inserted: 0, updated: 0 };

  res.status(201).json({
    received: bills.length,
    inserted,
    updated,
    unchanged: bills.length - inserted - updated,
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

  // solar_generation is stored at 5-minute granularity; roll up into the same hour buckets
  // (start_time "HH:00") that electric_usage already uses, so the two align by index.
  const solarByHourRows = db.prepare(`
    SELECT substr(start_time, 1, 2) || ':00' AS hour_start, SUM(generation_kwh) AS generation_kwh
    FROM solar_generation
    WHERE generation_date = ?
    GROUP BY hour_start
  `).all(date) as { hour_start: string; generation_kwh: number }[];
  const solarKwhByHour = new Map(solarByHourRows.map((r) => [r.hour_start, r.generation_kwh]));

  res.json({
    date,
    startTime: rows.map((r) => r.start_time),
    endTime: rows.map((r) => r.end_time),
    importKwh: rows.map((r) => r.import_kwh),
    exportKwh: rows.map((r) => r.export_kwh),
    cost: rows.map((r) => r.cost),
    // null (not 0) when this hour has no solar data yet, same convention as the daily/period rollups.
    solarKwh: rows.map((r) => solarKwhByHour.get(r.start_time) ?? null),
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
