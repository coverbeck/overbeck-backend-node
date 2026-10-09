import { fetchWithRetry, forecastWindow, toSqliteUtc } from './forecast.ts';
import type { Forecast, ForecastHour } from './forecast.ts';

// NWS raw grid data (api.weather.gov/gridpoints/{office}/{x},{y}) rather than the
// forecastHourly endpoint: it has sky cover, which forecastHourly lacks, and its
// values aren't rounded. Each layer is a list of metric values, each covering an
// ISO-8601 interval like "2026-10-08T05:00:00+00:00/PT3H", which gets expanded
// into one value per hour.

interface GridLayer {
  uom?: string;
  values: Array<{ validTime: string; value: number | null }>;
}

interface GridpointsResponse {
  properties: {
    updateTime: string;
    temperature: GridLayer;
    dewpoint: GridLayer;
    relativeHumidity: GridLayer;
    skyCover: GridLayer;
    windSpeed: GridLayer;
    windDirection: GridLayer;
    probabilityOfPrecipitation: GridLayer;
  };
}

const HOUR_MS = 3600 * 1000;

// "P1DT6H" -> 30. NWS intervals are whole hours (days and/or hours).
function durationHours(duration: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?)?$/.exec(duration);
  if (!match) {
    throw new Error(`Unexpected NWS duration "${duration}"`);
  }
  return Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0);
}

function converter(uom: string | undefined): (value: number) => number {
  switch (uom) {
    case 'wmoUnit:degC':
      return (c) => c * 9 / 5 + 32;
    case 'wmoUnit:km_h-1':
      return (kmh) => kmh / 1.609344;
    case 'wmoUnit:m_s-1':
      return (ms) => ms * 2.236936;
    case 'wmoUnit:percent':
    case 'wmoUnit:degree_(angle)':
      return (v) => v;
    default:
      throw new Error(`Unexpected NWS unit "${uom}"`);
  }
}

// Hour start (ms) -> value, converted to °F / mph / percent / degrees.
function expandLayer(layer: GridLayer): Map<number, number | null> {
  const convert = converter(layer.uom);
  const hourly = new Map<number, number | null>();
  for (const { validTime, value } of layer.values) {
    const [start, duration] = validTime.split('/');
    const startMs = Date.parse(start);
    for (let i = 0; i < durationHours(duration); i++) {
      hourly.set(startMs + i * HOUR_MS, value === null ? null : convert(value));
    }
  }
  return hourly;
}

export async function getNwsForecast(now: Date, hoursAhead: number): Promise<Forecast> {
  const grid = process.env.NWS_GRID;
  const userAgent = process.env.NWS_USER_AGENT;
  if (!grid || !userAgent) {
    throw new Error('NWS_GRID and NWS_USER_AGENT must be set');
  }

  const response = await fetchWithRetry(`https://api.weather.gov/gridpoints/${grid}`, {
    headers: { 'User-Agent': userAgent, Accept: 'application/geo+json' },
  });
  if (!response.ok) {
    throw new Error(`NWS API returned ${response.status}`);
  }
  const { properties: p } = await response.json() as GridpointsResponse;

  const temp = expandLayer(p.temperature);
  const dewpoint = expandLayer(p.dewpoint);
  const humidity = expandLayer(p.relativeHumidity);
  const skyCover = expandLayer(p.skyCover);
  const windSpeed = expandLayer(p.windSpeed);
  const windDir = expandLayer(p.windDirection);
  const precipProb = expandLayer(p.probabilityOfPrecipitation);

  const hours: ForecastHour[] = [];
  const { start, end } = forecastWindow(now, hoursAhead);
  for (let t = start; t < end; t += HOUR_MS) {
    if (!temp.has(t)) {
      continue; // past the end of the forecast, or a gap
    }
    hours.push({
      validAt: toSqliteUtc(new Date(t)),
      tempF: temp.get(t) ?? null,
      dewpointF: dewpoint.get(t) ?? null,
      humidityPct: humidity.get(t) ?? null,
      skyCoverPct: skyCover.get(t) ?? null,
      lowCloudPct: null, // NWS doesn't forecast low cloud separately
      windMph: windSpeed.get(t) ?? null,
      windDirDeg: windDir.get(t) ?? null,
      precipProbPct: precipProb.get(t) ?? null,
      solarWm2: null, // not in the NWS grid data
    });
  }

  return { source: 'nws', issuedAt: toSqliteUtc(new Date(p.updateTime)), hours };
}
