// Shared pieces for the Backyard Weather API clients (nws.ts, openmeteo.ts, and the
// station history in weather.ts): the common forecast shape, SQLite time formatting,
// and fetch with retry.

export type ForecastSource = 'nws' | 'om_hrrr' | 'om_nbm' | 'om_ecmwf';

// One forecast hour, in the units stored in forecast_hours (°F, mph, percent).
export interface ForecastHour {
  validAt: string; // UTC, SQLite format, start of the hour
  tempF: number | null;
  dewpointF: number | null;
  humidityPct: number | null;
  skyCoverPct: number | null;
  lowCloudPct: number | null;
  windMph: number | null;
  windDirDeg: number | null;
  precipProbPct: number | null;
  solarWm2: number | null; // shortwave radiation, W/m²
}

export interface Forecast {
  source: ForecastSource;
  issuedAt: string | null; // UTC, SQLite format; null when the source doesn't say
  hours: ForecastHour[];
}

const HOUR_MS = 3600 * 1000;

// 'YYYY-MM-DD HH:MM:SS' in UTC, matching SQLite's datetime('now').
export function toSqliteUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function fromSqliteUtc(value: string): Date {
  return new Date(`${value.replace(' ', 'T')}Z`);
}

export function startOfHour(date: Date): Date {
  return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);
}

// The window of forecast hours to keep: from the start of the current hour, for
// hoursAhead hours. Includes the current hour, which the tonight endpoint compares
// against the station's current reading.
export function forecastWindow(now: Date, hoursAhead: number): { start: number; end: number } {
  const start = startOfHour(now).getTime();
  return { start, end: start + hoursAhead * HOUR_MS };
}

const RETRY_DELAYS_MS = [2000, 5000, 15000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// fetch that retries network errors, 429s and 5xx responses with backoff, since the
// scripts run unattended and a transient failure would otherwise lose that hour's
// forecast. Other 4xx responses are returned as-is (retrying won't help).
export async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, init);
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
        return response;
      }
      await response.body?.cancel();
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) {
        throw err;
      }
    }
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}
