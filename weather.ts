interface AmbientDeviceData {
  tempf: number;
  tempinf: number;
  winddir: number;
  windspeedmph: number;
  hourlyrainin: number;
  eventrainin: number;
  dailyrainin: number;
  date: string;
}

interface AmbientDevice {
  lastData: AmbientDeviceData;
}

export interface WeatherReading {
  outdoorTemp: number;
  indoorTemp: number;
  windDirection: number;
  windSpeedMph: number;
  hourlyRain: number;
  eventRain: number;
  dailyRain: number;
  date: string;
}

export async function getCurrentWeather(): Promise<WeatherReading> {
  const applicationKey = process.env.AMBIENT_APP_KEY;
  const apiKey = process.env.AMBIENT_API_KEY;
  if (!applicationKey || !apiKey) {
    throw new Error('AMBIENT_APP_KEY and AMBIENT_API_KEY must be set');
  }

  const url = `https://api.ambientweather.net/v1/devices?applicationKey=${applicationKey}&apiKey=${apiKey}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Ambient Weather API returned ${response.status}`);
  }

  const devices = await response.json() as AmbientDevice[];
  if (!devices.length) {
    throw new Error('Ambient Weather API returned no devices');
  }

  const { lastData } = devices[0]; // only one device
  return {
    outdoorTemp: lastData.tempf,
    indoorTemp: lastData.tempinf,
    windDirection: lastData.winddir,
    windSpeedMph: lastData.windspeedmph,
    hourlyRain: lastData.hourlyrainin,
    eventRain: lastData.eventrainin,
    dailyRain: lastData.dailyrainin,
    date: lastData.date,
  };
}

interface PublicDeviceResponse {
  data: Array<{
    info: {
      name: string;
      coords: { coords: { lat: number; lon: number } };
    };
    lastData: {
      winddir: number;
      windspeedmph: number;
      created_at: number;
    };
  }>;
}

export interface PublicStationReading {
  name: string;
  lat: number;
  lon: number;
  windDirection: number;
  windSpeedMph: number;
}

const PUBLIC_STATION_MAX_AGE_MS = 2 * 60 * 60 * 1000;

// The two closest public stations (by the ambientweather.net "$publicBox" API)
// to each park, found 2026-07-18. Ambient Weather doesn't offer stable station
// IDs to search by name, only these opaque public share slugs.
export const REFERENCE_STATIONS = [
  { slug: '27f77ca065aede13b3eaa2dc667b21be', group: 'derby' },
  { slug: '7abc00032a9c9c9a1046d81805b00838', group: 'derby' },
  { slug: 'd3ffd2dfac4968b402104f42bfb27823', group: 'brommer' },
  { slug: 'd1cb2a99ba7ffc0192f686fe829632db', group: 'brommer' },
] as const;

export const PARKS = {
  derby: { name: 'Derby Park', lat: 36.9537481, lon: -122.051121 },
  brommer: { name: 'Brommer St Park', lat: 36.9709956, lon: -121.98407 },
};

// Ambient Weather's undocumented internal API (what ambientweather.net's own
// map uses), not their published developer API. Could change without notice.
export async function getPublicStationReading(slug: string): Promise<PublicStationReading | null> {
  try {
    const url = `https://lightning.ambientweather.net/devices?public.slug=${slug}`;
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }

    const { data } = await response.json() as PublicDeviceResponse;
    const device = data[0];
    if (!device) {
      return null;
    }

    if (Date.now() - device.lastData.created_at > PUBLIC_STATION_MAX_AGE_MS) {
      return null;
    }

    return {
      name: device.info.name,
      lat: device.info.coords.coords.lat,
      lon: device.info.coords.coords.lon,
      windDirection: device.lastData.winddir,
      windSpeedMph: device.lastData.windspeedmph,
    };
  } catch {
    return null;
  }
}
