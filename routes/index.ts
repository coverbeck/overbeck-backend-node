import express from 'express';
import type { Router, Request, Response } from 'express';
import db from '../db/index.ts';
import { getCurrentWeather } from '../weather.ts';
import type { WeatherReading } from '../weather.ts';

const router: Router = express.Router();

router.get('/', (req: Request, res: Response) => {
  res.render('home.njk');
});

interface LochLomondRow {
  recording_date: string;
  percent_full: number;
}

router.get('/weather', async (req: Request, res: Response) => {
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

export default router;
