import db from './db/index.ts';
import { fromSqliteUtc, startOfHour, toSqliteUtc } from './forecast.ts';
import type { ForecastSource } from './forecast.ts';

// Data for the /weather/forecast charts: the station's readings over the last few
// days alongside each source's forecast, from the start of the range through the
// end of the latest forecast. For each hour, a source's line shows the latest
// forecast it made at least `leadHours` before that hour, so past hours show what
// the forecast said in advance rather than a forecast fetched after the fact.
// Leads up to 12 hours use the live fetches; the 24-hour lead uses Open-Meteo's
// archive of day-ahead forecasts (kind 'archive_day1'), which has no NWS.

const HOUR_MS = 3600 * 1000;
const FORECAST_HOURS = 18;
const MATCH_MS = 5 * 60 * 1000; // a station reading within 5 minutes counts as "at" the hour
const OVERNIGHT_START_HOUR = 22; // Pacific, matches the Siri answer's window
const OVERNIGHT_END_HOUR = 8;

// Temperature within this many °F of the dew point: dew or fog likely.
export const FOG_SPREAD_F = 2;

export const RANGE_DAYS = [1, 3, 7] as const;
export const LEAD_HOURS = [0, 6, 12, 24] as const;
const ARCHIVE_LEAD_HOURS = 24;
export type RangeDays = (typeof RANGE_DAYS)[number];
export type LeadHours = (typeof LEAD_HOURS)[number];

export const SOURCE_LABELS: Record<ForecastSource, string> = {
  nws: 'NWS',
  om_hrrr: 'HRRR',
  om_nbm: 'NBM',
  om_ecmwf: 'ECMWF',
};
const SOURCE_ORDER: ForecastSource[] = ['nws', 'om_hrrr', 'om_nbm', 'om_ecmwf'];

export type LineKey = ForecastSource | 'average';

// x is an ISO 8601 UTC timestamp, which Chart.js's time scale parses directly.
export interface ChartPoint {
  x: string;
  y: number | null;
}

export interface ForecastLine {
  key: LineKey;
  label: string;
  temp: ChartPoint[];
  dewpoint: ChartPoint[];
  spread: ChartPoint[]; // temperature minus dew point
  skyCover: ChartPoint[];
  lowCloud: ChartPoint[]; // empty when the source has no low-cloud forecast
}

export interface ScoreRow {
  key: LineKey;
  label: string;
  hours: number;
  // Bias is the mean of forecast minus actual, e.g. "+1.3°"; miss is the mean
  // absolute error, e.g. "2.1°". Dew point is "–" when there's nothing to compare.
  tempBias: string;
  tempMiss: string;
  dewpointBias: string;
  dewpointMiss: string;
}

export interface TimeRange {
  start: string; // ISO
  end: string; // ISO
}

// One source's temperature forecast at each lead, for comparing how a forecast
// changes as the hour gets closer.
export interface LeadSeries {
  lead: LeadHours;
  temp: ChartPoint[];
}

export interface LeadComparison {
  key: LineKey;
  label: string;
  leads: LeadSeries[];
}

export interface ForecastComparison {
  now: string; // ISO
  range: TimeRange; // the charts' x axis
  nights: TimeRange[]; // overnight (10pm–8am Pacific) bands within the range
  lastFetchedAt: string | null; // ISO
  station: { temp: ChartPoint[]; dewpoint: ChartPoint[]; spread: ChartPoint[]; humidity: ChartPoint[] };
  lines: ForecastLine[]; // the average first, then each source
  scores: ScoreRow[]; // best temperature first
  fogSpreadF: number;
  leadComparison: LeadComparison[]; // the average, then sources in SOURCE_ORDER
}

interface ForecastRow {
  source: ForecastSource;
  valid_at: string;
  temp_f: number | null;
  dewpoint_f: number | null;
  sky_cover_pct: number | null;
  low_cloud_pct: number | null;
}

interface StationRow {
  observed_at: string;
  temp_f: number | null;
  dewpoint_f: number | null;
  humidity_pct: number | null;
}

function toIso(sqliteUtc: string): string {
  return fromSqliteUtc(sqliteUtc).toISOString();
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

function formatDegrees(value: number, signed: boolean): string {
  const rounded = value.toFixed(1);
  const sign = signed && Number(rounded) > 0 ? '+' : '';
  return `${sign}${rounded === '-0.0' ? '0.0' : rounded}°`;
}

// Floored at 0: a station can report a dew point slightly above the temperature.
function spread(temp: number | null, dewpoint: number | null): number | null {
  return temp === null || dewpoint === null ? null : Math.max(0, temp - dewpoint);
}

function sourceLine(source: ForecastSource, rows: ForecastRow[]): ForecastLine {
  const series = (value: (row: ForecastRow) => number | null): ChartPoint[] =>
    rows.map((row) => ({ x: toIso(row.valid_at), y: value(row) }));
  const hasLowCloud = rows.some((row) => row.low_cloud_pct !== null);
  return {
    key: source,
    label: SOURCE_LABELS[source],
    temp: series((row) => row.temp_f),
    dewpoint: series((row) => row.dewpoint_f),
    spread: series((row) => spread(row.temp_f, row.dewpoint_f)),
    skyCover: series((row) => row.sky_cover_pct),
    lowCloud: hasLowCloud ? series((row) => row.low_cloud_pct) : [],
  };
}

// Equal-weight average of whichever sources forecast each hour. Low cloud isn't
// averaged: only HRRR and ECMWF forecast it.
function averageLine(lines: ForecastLine[]): ForecastLine {
  const average = (pick: (line: ForecastLine) => ChartPoint[]): ChartPoint[] => {
    const byHour = new Map<string, number[]>();
    for (const line of lines) {
      for (const point of pick(line)) {
        const values = byHour.get(point.x) ?? [];
        if (point.y !== null) {
          values.push(point.y);
        }
        byHour.set(point.x, values);
      }
    }
    return [...byHour.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([x, values]) => ({ x, y: mean(values) }));
  };
  return {
    key: 'average',
    label: 'Average',
    temp: average((line) => line.temp),
    dewpoint: average((line) => line.dewpoint),
    spread: average((line) => line.spread),
    skyCover: average((line) => line.skyCover),
    lowCloud: [],
  };
}

interface ErrorStats {
  hours: number;
  bias: number;
  miss: number;
}

// Forecast error over the hours that have passed, against the station reading at
// the top of each hour.
function errorStats(points: ChartPoint[], actuals: Map<number, number>, nowMs: number): ErrorStats | null {
  const errors: number[] = [];
  for (const point of points) {
    const ms = Date.parse(point.x);
    const actual = actuals.get(ms);
    if (ms <= nowMs && point.y !== null && actual !== undefined) {
      errors.push(point.y - actual);
    }
  }
  const bias = mean(errors);
  const miss = mean(errors.map(Math.abs));
  return bias === null || miss === null ? null : { hours: errors.length, bias, miss };
}

// Station value at each top of the hour: the nearest reading within 5 minutes.
function hourlyStationValues(rows: StationRow[], value: (row: StationRow) => number | null): Map<number, number> {
  const best = new Map<number, { distance: number; value: number }>();
  for (const row of rows) {
    const v = value(row);
    if (v === null) {
      continue;
    }
    const ms = fromSqliteUtc(row.observed_at).getTime();
    const hour = Math.round(ms / HOUR_MS) * HOUR_MS;
    const distance = Math.abs(ms - hour);
    const current = best.get(hour);
    if (distance <= MATCH_MS && (!current || distance < current.distance)) {
      best.set(hour, { distance, value: v });
    }
  }
  return new Map([...best].map(([hour, { value: v }]) => [hour, v]));
}

function scoreRows(lines: ForecastLine[], stationRows: StationRow[], nowMs: number): ScoreRow[] {
  const stationTemp = hourlyStationValues(stationRows, (row) => row.temp_f);
  const stationDewpoint = hourlyStationValues(stationRows, (row) => row.dewpoint_f);
  const rows: { line: ForecastLine; temp: ErrorStats; dewpoint: ErrorStats | null }[] = [];
  for (const line of lines) {
    const temp = errorStats(line.temp, stationTemp, nowMs);
    if (temp) {
      rows.push({ line, temp, dewpoint: errorStats(line.dewpoint, stationDewpoint, nowMs) });
    }
  }
  return rows
    .sort((a, b) => a.temp.miss - b.temp.miss)
    .map(({ line, temp, dewpoint }) => ({
      key: line.key,
      label: line.label,
      hours: temp.hours,
      tempBias: formatDegrees(temp.bias, true),
      tempMiss: formatDegrees(temp.miss, false),
      dewpointBias: dewpoint ? formatDegrees(dewpoint.bias, true) : '–',
      dewpointMiss: dewpoint ? formatDegrees(dewpoint.miss, false) : '–',
    }));
}

const pacificHour = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hour: 'numeric',
  hourCycle: 'h23',
});

// Overnight bands, found hour by hour in Pacific time so daylight saving is handled.
function overnightBands(startMs: number, endMs: number): TimeRange[] {
  const bands: TimeRange[] = [];
  let bandStart: number | null = null;
  for (let ms = startMs; ms < endMs; ms += HOUR_MS) {
    const hour = Number(pacificHour.format(new Date(ms)));
    const overnight = hour >= OVERNIGHT_START_HOUR || hour < OVERNIGHT_END_HOUR;
    if (overnight && bandStart === null) {
      bandStart = ms;
    } else if (!overnight && bandStart !== null) {
      bands.push({ start: new Date(bandStart).toISOString(), end: new Date(ms).toISOString() });
      bandStart = null;
    }
  }
  if (bandStart !== null) {
    bands.push({ start: new Date(bandStart).toISOString(), end: new Date(endMs).toISOString() });
  }
  return bands;
}

// The average line followed by each source's line, from `start` on, using for each
// hour the latest forecast made at least leadHours before it.
function forecastLines(start: string, leadHours: LeadHours): ForecastLine[] {
  // Ordered by fetch time, so for each source and hour the last row seen is the
  // latest forecast made at least leadHours before that hour.
  const rows = db.prepare(`
    SELECT s.source, h.valid_at, h.temp_f, h.dewpoint_f, h.sky_cover_pct, h.low_cloud_pct
    FROM forecast_hours h
    JOIN forecast_snapshots s ON s.id = h.snapshot_id
    WHERE h.valid_at >= ? AND s.fetched_at <= datetime(h.valid_at, ?) AND s.kind = ?
    ORDER BY s.fetched_at
  `).all(
    start,
    `-${leadHours} hours`,
    leadHours === ARCHIVE_LEAD_HOURS ? 'archive_day1' : 'live',
  ) as ForecastRow[];

  const latest = new Map<string, ForecastRow>();
  for (const row of rows) {
    latest.set(`${row.source} ${row.valid_at}`, row);
  }
  const bySource = new Map<ForecastSource, ForecastRow[]>();
  for (const row of latest.values()) {
    bySource.set(row.source, [...(bySource.get(row.source) ?? []), row]);
  }

  const sourceLines: ForecastLine[] = [];
  for (const source of SOURCE_ORDER) {
    const hours = (bySource.get(source) ?? []).sort((a, b) => a.valid_at.localeCompare(b.valid_at));
    if (hours.length) {
      sourceLines.push(sourceLine(source, hours));
    }
  }
  return sourceLines.length ? [averageLine(sourceLines), ...sourceLines] : [];
}

export function getForecastComparison(now: Date, days: RangeDays, leadHours: LeadHours): ForecastComparison {
  const startMs = startOfHour(now).getTime() - days * 24 * HOUR_MS;
  const endMs = startOfHour(now).getTime() + FORECAST_HOURS * HOUR_MS;
  const start = toSqliteUtc(new Date(startMs));

  const linesByLead = new Map(LEAD_HOURS.map((lead) => [lead, forecastLines(start, lead)]));
  const lines = linesByLead.get(leadHours) ?? [];
  // Every line found at any lead (the archive has no NWS, and live data may not reach
  // back through the whole range), with only the leads that have data.
  const allLines = [...linesByLead.values()].flat();
  const leadComparison = (['average', ...SOURCE_ORDER] as LineKey[]).flatMap((key) => {
    const line = allLines.find((l) => l.key === key);
    if (!line) {
      return [];
    }
    const leads = LEAD_HOURS.map((lead) => ({
      lead,
      temp: linesByLead.get(lead)?.find((l) => l.key === key)?.temp ?? [],
    })).filter(({ temp }) => temp.length);
    return [{ key, label: line.label, leads }];
  });

  const stationRows = db.prepare(
    'SELECT observed_at, temp_f, dewpoint_f, humidity_pct FROM station_readings WHERE observed_at >= ? ORDER BY observed_at'
  ).all(start) as StationRow[];
  const scores = scoreRows(lines, stationRows, now.getTime());

  const { lastFetchedAt } = db.prepare(
    "SELECT MAX(fetched_at) AS lastFetchedAt FROM forecast_snapshots WHERE kind = 'live'"
  ).get() as { lastFetchedAt: string | null };

  const stationSeries = (value: (row: StationRow) => number | null): ChartPoint[] =>
    stationRows.map((row) => ({ x: toIso(row.observed_at), y: value(row) }));

  return {
    now: now.toISOString(),
    range: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
    nights: overnightBands(startMs, endMs),
    lastFetchedAt: lastFetchedAt && toIso(lastFetchedAt),
    station: {
      temp: stationSeries((row) => row.temp_f),
      dewpoint: stationSeries((row) => row.dewpoint_f),
      spread: stationSeries((row) => spread(row.temp_f, row.dewpoint_f)),
      humidity: stationSeries((row) => row.humidity_pct),
    },
    lines,
    scores,
    fogSpreadF: FOG_SPREAD_F,
    leadComparison,
  };
}
