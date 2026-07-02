const express = require('express');
const db = require('../db');
const router = express.Router();

router.get('/', (req, res) => {
  res.render('home.njk');
});

router.get('/lochlomond', (req, res) => {
  const readings = db.prepare(
    'SELECT recording_date, percent_full FROM loch_lomond ORDER BY recording_date'
  ).all();

  res.render('lochlomond.njk', {
    labels: readings.map((r) => r.recording_date),
    values: readings.map((r) => r.percent_full),
    lastChecked: readings.length ? readings[readings.length - 1].recording_date : null,
  });
});

module.exports = router;
