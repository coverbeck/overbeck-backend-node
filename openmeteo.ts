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

// Open-Meteo doesn't report the model run time in the forecast response, so issuedAt
// is null. Models with no temperature data at all (e.g. an outage) are left out.
export async function getOpenMeteoForecasts(now: Date, hoursAhead: number): Promise<Forecast[]> {
  const lat = process.env.OPEN_METEO_LAT;
  const lon = process.env.OPEN_METEO_LON;
  if (!lat || !lon) {
    throw new Error('OPEN_METEO_LAT and OPEN_METEO_LON must be set');
  }

  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: VARIABLES.join(','),
    models: Object.keys(MODELS).join(','),
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    timeformat: 'unixtime',
    timezone: 'GMT',
    forecast_hours: String(hoursAhead), // starts at the current hour
  });
  const response = await fetchWithRetry(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!response.ok) {
    throw new Error(`Open-Meteo API returned ${response.status}: ${await response.text()}`);
  }
  const { hourly } = await response.json() as ForecastResponse;

  const { start, end } = forecastWindow(now, hoursAhead);
  const forecasts: Forecast[] = [];
  for (const [model, source] of Object.entries(MODELS)) {
    const series = (variable: Variable) => hourly[`${variable}_${model}`] ?? [];
    const temp = series('temperature_2m');
    if (temp.every((v) => v === null)) {
      continue;
    }

    const hours: ForecastHour[] = [];
    hourly.time.forEach((seconds, i) => {
      const t = seconds * 1000;
      if (t < start || t >= end) {
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
