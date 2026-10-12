// Sunrise, sunset and civil twilight for the weather charts, from NOAA's solar
// calculator formulas (within about a minute at mid-latitudes). Uses Santa Cruz's
// town coordinates, not the station's, so the times shown on the public page don't
// narrow down the station's location; the difference is seconds.

const LATITUDE = 36.974;
const LONGITUDE = -122.031; // east positive
const DAY_MS = 24 * 3600 * 1000;
const MINUTE_MS = 60 * 1000;
const RAD = Math.PI / 180;

// The sun's center below the horizon at each event, as a zenith angle: sunrise and
// sunset allow for refraction and the sun's radius; civil twilight ends at 6° below.
const SUNRISE_ZENITH = 90.833;
const CIVIL_ZENITH = 96;

export interface SunEvent {
  type: 'dawn' | 'sunrise' | 'sunset' | 'dusk';
  at: number; // ms
}

// The equation of time (minutes) and the sun's declination (radians) at a moment,
// from the Meeus-based formulas in NOAA's solar calculator spreadsheet. (NOAA's
// shorter fractional-year series ran about 3 minutes off in spring.)
function solarPosition(ms: number): { eqTime: number; decl: number } {
  const t = (ms / DAY_MS + 2440587.5 - 2451545) / 36525; // Julian centuries since J2000
  const meanLong = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const center = Math.sin(meanAnomaly * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t))
    + Math.sin(2 * meanAnomaly * RAD) * (0.019993 - 0.000101 * t)
    + Math.sin(3 * meanAnomaly * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const apparentLong = meanLong + center - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const obliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
    + 0.00256 * Math.cos(omega * RAD);
  const y = Math.tan((obliquity / 2) * RAD) ** 2;
  const l0 = meanLong * RAD;
  const m = meanAnomaly * RAD;
  return {
    eqTime: (4 / RAD) * (y * Math.sin(2 * l0) - 2 * eccentricity * Math.sin(m)
      + 4 * eccentricity * y * Math.sin(m) * Math.cos(2 * l0) - 0.5 * y * y * Math.sin(4 * l0)
      - 1.25 * eccentricity * eccentricity * Math.sin(2 * m)),
    decl: Math.asin(Math.sin(obliquity * RAD) * Math.sin(apparentLong * RAD)),
  };
}

// One event in the UTC day starting at dayStartMs: rising (morning) or setting, at
// the given zenith. Computed twice, the second time with the sun's position at the
// first estimate, since it moves noticeably over a day around the equinoxes.
function eventTime(dayStartMs: number, zenith: number, rising: boolean): number {
  let at = dayStartMs + DAY_MS / 2;
  for (let pass = 0; pass < 2; pass++) {
    const { eqTime, decl } = solarPosition(at);
    const hourAngle = Math.acos(Math.cos(zenith * RAD) / (Math.cos(LATITUDE * RAD) * Math.cos(decl))
      - Math.tan(LATITUDE * RAD) * Math.tan(decl)) / RAD;
    const minutes = 720 - 4 * (LONGITUDE + (rising ? hourAngle : -hourAngle)) - eqTime;
    at = dayStartMs + Math.round(minutes) * MINUTE_MS;
  }
  return at;
}

// Events for the UTC day starting at dayStartMs. Sunset and dusk in Pacific evenings
// fall after midnight UTC, so they come out later than dayStartMs + 24 h.
function sunEvents(dayStartMs: number): SunEvent[] {
  return [
    { type: 'dawn', at: eventTime(dayStartMs, CIVIL_ZENITH, true) },
    { type: 'sunrise', at: eventTime(dayStartMs, SUNRISE_ZENITH, true) },
    { type: 'sunset', at: eventTime(dayStartMs, SUNRISE_ZENITH, false) },
    { type: 'dusk', at: eventTime(dayStartMs, CIVIL_ZENITH, false) },
  ];
}

// Every event from startMs to endMs, in time order.
export function sunEventsBetween(startMs: number, endMs: number): SunEvent[] {
  const events: SunEvent[] = [];
  for (let day = Math.floor(startMs / DAY_MS) * DAY_MS - DAY_MS; day <= endMs; day += DAY_MS) {
    events.push(...sunEvents(day));
  }
  return events.filter(({ at }) => at >= startMs && at <= endMs).sort((a, b) => a.at - b.at);
}
