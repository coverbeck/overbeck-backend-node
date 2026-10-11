import { fetchWithRetry, forecastWindow, toSqliteUtc } from './forecast.ts';
import type { Forecast, ForecastHour, ForecastSource } from './forecast.ts';

// Open-Meteo's forecast API (free for non-commercial use, no key, CC-BY 4.0). One
// request returns every model; each variable comes back as its own array suffixed
// with the model name (e.g. temperature_2m_gfs_hrrr), aligned with hourly.time.
// OPEN_METEO_LAT/LON are private (.env only) and must never be shown publicly.

const MODELS: Record<string, ForecastSource> = {
  gfs_hrrr: 'om_hrrr', // NOAA HRRR, 3 km, updated hourly, 18h ahead (48h on 00/06/12/18Z runs)
  ncep_nbm_conus: 'om_nbm', // National Blend of Models, 2.5 km, updated hourly
  ecmwf_ifs025: 'om_ecmwf', // ECMWF IFS, ~25 km, updated every 6 hours
};

const VARIABLES = [
  'temperature_2m',
  'dew_point_2m',
  'relative_humidity_2m',
  'cloud_cover',
  'cloud_cover_low',
  'wind_speed_10m',
  'wind_direction_10m',
  'precipitation_probability',
  // Average over the preceding hour (Open-Meteo's convention), unlike the station's
  // instantaneous solarradiation reading.
  'shortwave_radiation',
] as const;

type Variable = typeof VARIABLES[number];

interface ForecastResponse {
  hourly: { time: number[] } & Record<string, Array<number | null> | undefined>;
}

function coords(): { latitude: string; longitude: string } {
  const latitude = process.env.OPEN_METEO_LAT;
  const longitude = process.env.OPEN_METEO_LON;
  if (!latitude || !longitude) {
    throw new Error('OPEN_METEO_LAT and OPEN_METEO_LON must be set');
  }
  return { latitude, longitude };
}

const COMMON_PARAMS = {
  models: Object.keys(MODELS).join(','),
  temperature_unit: 'fahrenheit',
  wind_speed_unit: 'mph',
  timeformat: 'unixtime',
  timezone: 'GMT',
};

async function fetchHourly(url: string): Promise<ForecastResponse['hourly']> {
  const response = await fetchWithRetry(url);
  if (!response.ok) {
    throw new Error(`Open-Meteo API returned ${response.status}: ${await response.text()}`);
  }
  const { hourly } = await response.json() as ForecastResponse;
  return hourly;
}

// Splits a response into one forecast per model, keeping the hours in [start, end).
// `suffix` comes between the variable and model names (e.g. '_previous_day1').
// With skipEmptyHours, hours with no temperature are left out, for the archive,
// where a model's history has gaps.
function toForecasts(
  hourly: ForecastResponse['hourly'],
  suffix: string,
  start: number,
  end: number,
  skipEmptyHours: boolean,
): Forecast[] {
  const forecasts: Forecast[] = [];
  for (const [model, source] of Object.entries(MODELS)) {
    const series = (variable: Variable) => hourly[`${variable}${suffix}_${model}`] ?? [];
    const temp = series('temperature_2m');
    if (temp.every((v) => v === null)) {
      continue;
    }

    const hours: ForecastHour[] = [];
    hourly.time.forEach((seconds, i) => {
      const t = seconds * 1000;
      if (t < start || t >= end || (skipEmptyHours && temp[i] == null)) {
        return;
      }
      hours.push({
        validAt: toSqliteUtc(new Date(t)),
        tempF: temp[i] ?? null,
        dewpointF: series('dew_point_2m')[i] ?? null,
        humidityPct: series('relative_humidity_2m')[i] ?? null,
        skyCoverPct: series('cloud_cover')[i] ?? null,
        lowCloudPct: series('cloud_cover_low')[i] ?? null,
        windMph: series('wind_speed_10m')[i] ?? null,
        windDirDeg: series('wind_direction_10m')[i] ?? null,
        precipProbPct: series('precipitation_probability')[i] ?? null,
        solarWm2: series('shortwave_radiation')[i] ?? null,
      });
    });
    forecasts.push({ source, issuedAt: null, hours });
  }
  return forecasts;
}

// Open-Meteo doesn't report the model run time in the forecast response, so issuedAt
// is null. Models with no temperature data at all (e.g. an outage) are left out.
export async function getOpenMeteoForecasts(now: Date, hoursAhead: number): Promise<Forecast[]> {
  const params = new URLSearchParams({
    ...coords(),
    ...COMMON_PARAMS,
    hourly: VARIABLES.join(','),
    forecast_hours: String(hoursAhead), // starts at the current hour
  });
  const hourly = await fetchHourly(`https://api.open-meteo.com/v1/forecast?${params}`);
  const { start, end } = forecastWindow(now, hoursAhead);
  return toForecasts(hourly, '', start, end, false);
}

// Earliest `_previous_day1` data, checked 2026-10-07.
export const ARCHIVE_START_DATE = '2024-01-19'; // HRRR; ECMWF from 2024-02-04, NBM 2024-10-09

// Forecasts made about a day ahead, from Open-Meteo's Previous Runs API: for each
// hour, the model run from 24 hours before the latest run covering it. Low cloud
// isn't archived. Covers the hours in [start, end), requested as whole UTC days.
// Each model's forecast holds only the hours it has data for.
export async function getOpenMeteoArchive(start: Date, end: Date): Promise<Forecast[]> {
  const params = new URLSearchParams({
    ...coords(),
    ...COMMON_PARAMS,
    hourly: VARIABLES.filter((v) => v !== 'cloud_cover_low').map((v) => `${v}_previous_day1`).join(','),
    start_date: start.toISOString().slice(0, 10),
    end_date: new Date(end.getTime() - 1).toISOString().slice(0, 10),
  });
  const hourly = await fetchHourly(`https://previous-runs-api.open-meteo.com/v1/forecast?${params}`);
  return toForecasts(hourly, '_previous_day1', start.getTime(), end.getTime(), true);
}
