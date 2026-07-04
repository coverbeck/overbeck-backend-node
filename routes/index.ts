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
  'INSERT OR IGNORE INTO loch_lomond (recording_date, percent_full) VALUES (?, ?)'
);

router.post('/api/loch-lomond', requireAuth, (req: Request, res: Response) => {
  const { recordingDate, percentFull } = req.body ?? {};

  if (typeof recordingDate !== 'string' || !RECORDING_DATE_PATTERN.test(recordingDate)) {
    res.status(400).json({ error: 'recordingDate must be a string in YYYY-MM-DD format' });
    return;
  }
  if (typeof percentFull !== 'number' || !Number.isFinite(percentFull)) {
    res.status(400).json({ error: 'percentFull must be a finite number' });
    return;
  }

  const result = insertLochLomondReading.run(recordingDate, percentFull);

  if (result.changes === 0) {
    res.status(200).json({ duplicate: true, recordingDate, percentFull });
    return;
  }

  res.status(201).json({ duplicate: false, recordingDate, percentFull });
});

export default router;
