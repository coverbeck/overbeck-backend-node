import db from './db/index.ts';
import { BASE_SOURCES } from './estimate.ts';
import { fromSqliteUtc, nextPacificDayStart, pacificDate, pacificDayStart, toSqliteUtc } from './forecast.ts';
import type { ForecastSource } from './forecast.ts';
import { SOURCE_LABELS } from './forecastComparison.ts';
import type { LineKey } from './forecastComparison.ts';

// How each forecast's day-ahead rain total compared with what the station recorded,
// for every whole day (midnight to midnight Pacific) since the station started saving
// daily totals. A day's forecast is the one as of 8 pm the evening before, which is
// what the outlook says then. When an Open-Meteo source has no live forecast from that
// evening, its total comes from Open-Meteo's day-ahead archive instead (each hour
// as forecast about 24 hours before), and is marked as such. NWS isn't archived.

const HOUR_MS = 3600 * 1000;
const EVENING_BEFORE_MS = 4 * HOUR_MS; // 8 pm: midnight less 4 hours, whatever the DST
const STALE_MS = 3 * HOUR_MS; // an evening forecast fetched longer before 8 pm isn't used
// A day with at least this much rain counts as rainy, for the station and a forecast
// alike: above the 0.01–0.04 in that a passing shower or dew leaves in the gauge.
const RAIN_DAY_IN = 0.05;
// The station needs this share of its 5-minute readings for a day's total to count.
const STATION_COVERAGE = 0.9;
const SOURCES: ForecastSource[] = ['nws', 'om_hrrr', 'om_nbm', 'om_ecmwf'];

export interface RainHistoryTotal {
  inches: number;
  archived: boolean; // from the day-ahead archive, not the evening's live forecast
}

export interface RainHistoryDay {
  date: string; // YYYY-MM-DD
  stationIn: number;
  totals: (RainHistoryTotal | null)[]; // one per RainHistory column
}

// One forecast's record over the days it and the station both have: rainy days it
// caught and missed, dry days it had as rainy, its average error on rainy days
// (bias is forecast minus recorded, e.g. "-0.21 in"; miss is the absolute error),
// and its total against the station's over those days.
export interface RainHistoryScore {
  key: LineKey;
  label: string;
  days: number;
  rainyDays: number;
  caught: number;
  missed: number;
  falseAlarms: number;
  rainyBias: string;
  rainyMiss: string;
  forecastTotal: string;
  recordedTotal: string;
}

export interface RainHistory {
  since: string | null; // YYYY-MM-DD, the first day scored
  dayCount: number;
  columns: { key: LineKey; label: string }[]; // the outlook's average, then each source
  days: RainHistoryDay[]; // newest first; only days rainy at the station or in a forecast
  scores: RainHistoryScore[];
}

interface SnapshotRow {
  id: number;
  source: ForecastSource;
  fetched_at: string;
}

interface HourRow {
  source: ForecastSource;
  valid_at: string;
  precip_in: number;
}

function inches(value: number, signed = false): string {
  const rounded = value.toFixed(2);
  const sign = signed && Number(rounded) > 0 ? '+' : '';
  return `${sign}${rounded === '-0.00' ? '0.00' : rounded} in`;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

// Each whole day's station total, keyed by its midnight, for the days with enough
// readings. Ambient's daily total resets at midnight, so a day's total is its largest.
function stationDays(): Map<number, number> {
  const rows = db.prepare(`
    SELECT observed_at, rain_daily_in FROM station_readings WHERE rain_daily_in IS NOT NULL ORDER BY observed_at
  `).all() as { observed_at: string; rain_daily_in: number }[];
  const byDay = new Map<number, { max: number; count: number }>();
  for (const row of rows) {
    // A reading at midnight closes the day before, like a forecast hour ending then.
    const dayStart = pacificDayStart(fromSqliteUtc(row.observed_at).getTime() - 1);
    const day = byDay.get(dayStart) ?? { max: 0, count: 0 };
    day.max = Math.max(day.max, row.rain_daily_in);
    day.count++;
    byDay.set(dayStart, day);
  }
  const totals = new Map<number, number>();
  for (const [dayStart, { max, count }] of byDay) {
    const dayHours = (nextPacificDayStart(dayStart) - dayStart) / HOUR_MS;
    if (count >= dayHours * 12 * STATION_COVERAGE) {
      totals.set(dayStart, max);
    }
  }
  return totals;
}

// Sums one day's hours (those ending after its midnight through the next), or null
// unless every hour has an amount.
function dayTotal(hours: Map<string, number>, dayStart: number, dayEnd: number): number | null {
  let total = 0;
  for (let end = dayStart + HOUR_MS; end <= dayEnd; end += HOUR_MS) {
    const value = hours.get(toSqliteUtc(new Date(end)));
    if (value === undefined) {
      return null;
    }
    total += value;
  }
  return total;
}

export function getRainHistory(now: Date): RainHistory {
  const station = stationDays();
  const todayStart = pacificDayStart(now.getTime());
  const dayStarts = [...station.keys()].filter((d) => d < todayStart).sort((a, b) => a - b);
  const columns = [
    { key: 'average' as LineKey, label: 'Average' },
    ...SOURCES.map((source) => ({ key: source as LineKey, label: SOURCE_LABELS[source] })),
  ];
  if (!dayStarts.length) {
    return { since: null, dayCount: 0, columns, days: [], scores: [] };
  }
  const first = toSqliteUtc(new Date(dayStarts[0] - EVENING_BEFORE_MS - STALE_MS));
  const last = toSqliteUtc(new Date(todayStart));

  const snapshots = db.prepare(`
    SELECT id, source, fetched_at FROM forecast_snapshots
    WHERE kind = 'live' AND fetched_at >= ? AND fetched_at <= ? AND source IN (${SOURCES.map(() => '?').join(', ')})
    ORDER BY fetched_at
  `).all(first, last, ...SOURCES) as SnapshotRow[];
  const snapshotHours = db.prepare(
    'SELECT valid_at, precip_in FROM forecast_hours WHERE snapshot_id = ? AND valid_at > ? AND valid_at <= ? AND precip_in IS NOT NULL'
  );
  // Ordered by fetch time, so the last row for each source and hour is the latest.
  const archived = new Map<ForecastSource, Map<string, number>>();
  for (const row of db.prepare(`
    SELECT s.source, h.valid_at, h.precip_in FROM forecast_hours h
    JOIN forecast_snapshots s ON s.id = h.snapshot_id
    WHERE s.kind = 'archive_day1' AND h.valid_at > ? AND h.valid_at <= ? AND h.precip_in IS NOT NULL
    ORDER BY s.fetched_at
  `).all(toSqliteUtc(new Date(dayStarts[0])), last) as HourRow[]) {
    const hours = archived.get(row.source) ?? new Map<string, number>();
    hours.set(row.valid_at, row.precip_in);
    archived.set(row.source, hours);
  }

  const allDays = dayStarts.map((dayStart) => {
    const dayEnd = nextPacificDayStart(dayStart);
    const evening = dayStart - EVENING_BEFORE_MS;
    const bySource = SOURCES.map((source): RainHistoryTotal | null => {
      const snapshot = snapshots.filter((s) => {
        const fetched = fromSqliteUtc(s.fetched_at).getTime();
        return s.source === source && fetched <= evening && fetched > evening - STALE_MS;
      }).at(-1);
      if (snapshot) {
        const rows = snapshotHours.all(
          snapshot.id, toSqliteUtc(new Date(dayStart)), toSqliteUtc(new Date(dayEnd)),
        ) as { valid_at: string; precip_in: number }[];
        const total = dayTotal(new Map(rows.map((r) => [r.valid_at, r.precip_in])), dayStart, dayEnd);
        if (total !== null) {
          return { inches: total, archived: false };
        }
      }
      const hours = archived.get(source);
      const total = hours ? dayTotal(hours, dayStart, dayEnd) : null;
      return total === null ? null : { inches: total, archived: true };
    });
    // The outlook's average: NWS, HRRR and NBM, only when all three have the day.
    const base = BASE_SOURCES.map((source) => bySource[SOURCES.indexOf(source)]);
    const average: RainHistoryTotal | null = base.every((t) => t !== null)
      ? { inches: mean(base.map((t) => t.inches)) ?? 0, archived: base.some((t) => t.archived) }
      : null;
    const totals = [average, ...bySource].map((t) => t && { ...t, inches: Math.round(t.inches * 100) / 100 });
    return { date: pacificDate(dayStart), stationIn: station.get(dayStart) ?? 0, totals };
  });

  const scores = columns.map(({ key, label }, i) => {
    const pairs = allDays.flatMap((day) => {
      const total = day.totals[i];
      return total ? [{ forecast: total.inches, recorded: day.stationIn }] : [];
    });
    const rainy = pairs.filter((p) => p.recorded >= RAIN_DAY_IN);
    const bias = mean(rainy.map((p) => p.forecast - p.recorded));
    const miss = mean(rainy.map((p) => Math.abs(p.forecast - p.recorded)));
    return {
      key,
      label,
      days: pairs.length,
      rainyDays: rainy.length,
      caught: rainy.filter((p) => p.forecast >= RAIN_DAY_IN).length,
      missed: rainy.filter((p) => p.forecast < RAIN_DAY_IN).length,
      falseAlarms: pairs.filter((p) => p.recorded < RAIN_DAY_IN && p.forecast >= RAIN_DAY_IN).length,
      rainyBias: bias === null ? '–' : inches(bias, true),
      rainyMiss: miss === null ? '–' : inches(miss),
      forecastTotal: inches(pairs.reduce((sum, p) => sum + p.forecast, 0)),
      recordedTotal: inches(pairs.reduce((sum, p) => sum + p.recorded, 0)),
    };
  });

  const days = allDays
    .filter((day) => day.stationIn >= RAIN_DAY_IN || day.totals.some((t) => t && t.inches >= RAIN_DAY_IN))
    .reverse();
  return { since: allDays[0].date, dayCount: allDays.length, columns, days, scores };
}
