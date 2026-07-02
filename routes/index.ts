import express from 'express';
import type { Router, Request, Response } from 'express';
import db from '../db/index.ts';

const router: Router = express.Router();

router.get('/', (req: Request, res: Response) => {
  res.render('home.njk');
});

interface LochLomondRow {
  recording_date: string;
  percent_full: number;
}

router.get('/lochlomond', (req: Request, res: Response) => {
  const readings = db.prepare(
    'SELECT recording_date, percent_full FROM loch_lomond ORDER BY recording_date'
  ).all() as LochLomondRow[];

  res.render('lochlomond.njk', {
    labels: readings.map((r) => r.recording_date),
    values: readings.map((r) => r.percent_full),
    lastChecked: readings.length ? readings[readings.length - 1].recording_date : null,
  });
});

export default router;
