import db from './db/index.ts';
import { fromSqliteUtc, startOfHour, toSqliteUtc } from './forecast.ts';
import type { ForecastSource } from './forecast.ts';

// Data for the /weather/forecast charts: the station's readings over the last day
// alongside each source's forecast, from the past day through the end of its
// latest forecast. For each hour, a source's line shows the latest forecast it
// made *before* that hour began, so past hours show what the forecast said in
// advance rather than a forecast fetched after the fact.

const HOUR_MS = 3600 * 1000;
const PAST_HOURS = 24;

export const SOURCE_LABELS: Record<ForecastSource, string> = {
  nws: 'NWS',
  om_hrrr: 'HRRR',
  om_nbm: 'NBM',
  om_ecmwf: 'ECMWF',
};
const SOURCE_ORDER: ForecastSource[] = ['nws', 'om_hrrr', 'om_nbm', 'om_ecmwf'];

// x is an ISO 8601 UTC timestamp, which Chart.js's time scale parses directly.
export interface ChartPoint {
  x: string;
  y: number | null;
}

export interface SourceSeries {
  source: ForecastSource;
  label: string;
  temp: ChartPoint[];
  skyCover: ChartPoint[];
  lowCloud: ChartPoint[]; // empty when the source has no low-cloud forecast
}

export interface ForecastComparison {
  now: string; // ISO
  lastFetchedAt: string | null; // ISO
  station: { temp: ChartPoint[]; humidity: ChartPoint[] };
  sources: SourceSeries[];
}

interface ForecastRow {
  source: ForecastSource;
  valid_at: string;
  temp_f: number | null;
  sky_cover_pct: number | null;
  low_cloud_pct: number | null;
}

interface StationRow {
  observed_at: string;
  temp_f: number | null;
  humidity_pct: number | null;
}

function toIso(sqliteUtc: string): string {
  return fromSqliteUtc(sqliteUtc).toISOString();
}

export function getForecastComparison(now: Date): ForecastComparison {
  const start = toSqliteUtc(new Date(startOfHour(now).getTime() - PAST_HOURS * HOUR_MS));

  // Ordered by fetch time, so for each source and hour the last row seen is the
  // latest forecast made before that hour.
  const rows = db.prepare(`
    SELECT s.source, h.valid_at, h.temp_f, h.sky_cover_pct, h.low_cloud_pct
    FROM forecast_hours h
    JOIN forecast_snapshots s ON s.id = h.snapshot_id
    WHERE h.valid_at >= ? AND s.fetched_at <= h.valid_at
    ORDER BY s.fetched_at
  `).all(start) as ForecastRow[];

  const latest = new Map<string, ForecastRow>();
  for (const row of rows) {
    latest.set(`${row.source} ${row.valid_at}`, row);
  }
  const bySource = new Map<ForecastSource, ForecastRow[]>();
  for (const row of latest.values()) {
    bySource.set(row.source, [...(bySource.get(row.source) ?? []), row]);
  }

  const sources: SourceSeries[] = [];
  for (const source of SOURCE_ORDER) {
    const hours = (bySource.get(source) ?? []).sort((a, b) => a.valid_at.localeCompare(b.valid_at));
    if (!hours.length) {
      continue;
    }
    const series = (value: (row: ForecastRow) => number | null): ChartPoint[] =>
      hours.map((row) => ({ x: toIso(row.valid_at), y: value(row) }));
    const hasLowCloud = hours.some((row) => row.low_cloud_pct !== null);
    sources.push({
      source,
      label: SOURCE_LABELS[source],
      temp: series((row) => row.temp_f),
      skyCover: series((row) => row.sky_cover_pct),
      lowCloud: hasLowCloud ? series((row) => row.low_cloud_pct) : [],
    });
  }

  const stationRows = db.prepare(
    'SELECT observed_at, temp_f, humidity_pct FROM station_readings WHERE observed_at >= ? ORDER BY observed_at'
  ).all(start) as StationRow[];

  const { lastFetchedAt } = db.prepare(
    'SELECT MAX(fetched_at) AS lastFetchedAt FROM forecast_snapshots'
  ).get() as { lastFetchedAt: string | null };

  return {
    now: now.toISOString(),
    lastFetchedAt: lastFetchedAt && toIso(lastFetchedAt),
    station: {
      temp: stationRows.map((row) => ({ x: toIso(row.observed_at), y: row.temp_f })),
      humidity: stationRows.map((row) => ({ x: toIso(row.observed_at), y: row.humidity_pct })),
    },
    sources,
  };
}
