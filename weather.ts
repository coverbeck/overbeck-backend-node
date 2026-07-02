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
