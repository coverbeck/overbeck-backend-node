// Solar production by calendar year, for the table on /electric-usage: total and
// average per day, the lowest and highest days, the best and worst months (per day,
// so short months aren't penalized), and how much sunlight the backyard station
// measured, from its January 2024 start.
//
// Sunlight is the station's solar radiation summed over the day, in kWh/m², which is
// also "peak sun hours" (hours of 1,000 W/m² noon sun that would deliver the same
// energy). Production divided by it, kWh per sun-hour, is roughly the size in kW the
// panels are performing like. The sensor is horizontal and the panels are tilted, so
// the ratio runs higher in winter (low sun) and is only comparable between full years.

export interface SolarDay {
  date: string; // YYYY-MM-DD, Pacific
  kwh: number;
}

// Days outside this range are monitoring gaps, not weather, and are left out of the
// lowest and highest days (they still count in totals and months). From Sep 2017 to
// Jun 2018 the monitoring dropped out repeatedly: some days show ~0 and the missed
// production landed on later days (up to 20 kWh, three identical 18.51s in a row).
// The cloudiest real days are ~0.2 kWh and the best real day is 13.82 (May 2025).
export const OUTAGE_KWH = 0.1;
export const CATCH_UP_KWH = 14;

function isGlitch(day: SolarDay): boolean {
  return day.kwh < OUTAGE_KWH || day.kwh > CATCH_UP_KWH;
}

export interface DayStat {
  date: string;
  kwh: number;
}

export interface MonthStat {
  month: string; // YYYY-MM
  kwhPerDay: number;
}

export interface SolarYearStats {
  label: string; // the year, or "All years"
  firstDate: string;
  lastDate: string;
  partialStart: boolean; // data starts after Jan 1 (the install year)
  partialEnd: boolean; // year still in progress
  days: number;
  totalKwh: number;
  kwhPerDay: number;
  lowestDay: DayStat | null;
  highestDay: DayStat | null;
  bestMonth: MonthStat | null; // complete months only
  worstMonth: MonthStat | null;
  sunDays: number; // days with both production and complete station sunlight
  sunHoursPerDay: number | null;
  kwhPerSunHour: number | null;
}

export interface SolarStats {
  years: SolarYearStats[]; // newest first
  allYears: SolarYearStats | null;
  glitches: DayStat[]; // days left out of lowest/highest, oldest first
  sunlightFrom: string | null; // first day with station sunlight
  byDayOfYear: YearSeries[]; // newest first
}

// One year's daily production for the day-of-year chart: index 0 is Jan 1 and 365 is
// Dec 31 on a leap-year calendar, so dates line up across years (Feb 29 is null in
// other years). Missing days and glitches are null.
export interface YearSeries {
  year: string;
  kwh: Array<number | null>;
}

function dayOfYearIndex(date: string): number {
  const [, month, day] = date.split('-').map(Number);
  return (Date.UTC(2024, month - 1, day) - Date.UTC(2024, 0, 1)) / 86_400_000;
}

function daysInMonth(month: string): number {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m, 0)).getUTCDate();
}

function summarize(
  label: string,
  days: SolarDay[],
  sunByDate: Map<string, number>,
  partialStart: boolean,
  partialEnd: boolean,
): SolarYearStats {
  let totalKwh = 0;
  let lowestDay: DayStat | null = null;
  let highestDay: DayStat | null = null;
  const months = new Map<string, { kwh: number; days: number }>();
  let sunKwhM2 = 0;
  let sunKwh = 0;
  let sunDays = 0;
  for (const day of days) {
    totalKwh += day.kwh;
    if (!isGlitch(day)) {
      if (!lowestDay || day.kwh < lowestDay.kwh) {
        lowestDay = day;
      }
      if (!highestDay || day.kwh > highestDay.kwh) {
        highestDay = day;
      }
    }
    const month = day.date.slice(0, 7);
    const m = months.get(month) ?? { kwh: 0, days: 0 };
    m.kwh += day.kwh;
    m.days++;
    months.set(month, m);
    const sun = sunByDate.get(day.date);
    if (sun !== undefined) {
      sunKwhM2 += sun;
      sunKwh += day.kwh;
      sunDays++;
    }
  }

  let bestMonth: MonthStat | null = null;
  let worstMonth: MonthStat | null = null;
  for (const [month, m] of months) {
    if (m.days < daysInMonth(month)) {
      continue;
    }
    const stat = { month, kwhPerDay: m.kwh / m.days };
    if (!bestMonth || stat.kwhPerDay > bestMonth.kwhPerDay) {
      bestMonth = stat;
    }
    if (!worstMonth || stat.kwhPerDay < worstMonth.kwhPerDay) {
      worstMonth = stat;
    }
  }

  return {
    label,
    firstDate: days[0].date,
    lastDate: days[days.length - 1].date,
    partialStart,
    partialEnd,
    days: days.length,
    totalKwh,
    kwhPerDay: totalKwh / days.length,
    lowestDay,
    highestDay,
    bestMonth,
    worstMonth,
    sunDays,
    sunHoursPerDay: sunDays ? sunKwhM2 / sunDays : null,
    kwhPerSunHour: sunKwhM2 > 0 ? sunKwh / sunKwhM2 : null,
  };
}

// `days` are whole days of production; `sunByDate` is the station's sunlight
// (kWh/m²) for each day it covered completely.
export function computeSolarStats(days: SolarDay[], sunByDate: Map<string, number>, today: string): SolarStats {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const byYear = new Map<string, SolarDay[]>();
  for (const day of sorted) {
    const year = day.date.slice(0, 4);
    const yearDays = byYear.get(year) ?? [];
    yearDays.push(day);
    byYear.set(year, yearDays);
  }

  const currentYear = today.slice(0, 4);
  const years = [...byYear].reverse().map(([year, yearDays]) =>
    summarize(year, yearDays, sunByDate, yearDays[0].date > `${year}-01-01`, year === currentYear));

  const byDayOfYear = [...byYear].reverse().map(([year, yearDays]) => {
    const kwh: Array<number | null> = new Array(366).fill(null);
    for (const day of yearDays) {
      if (!isGlitch(day)) {
        kwh[dayOfYearIndex(day.date)] = Math.round(day.kwh * 100) / 100;
      }
    }
    return { year, kwh };
  });

  const sunDates = [...sunByDate.keys()].sort();
  return {
    years,
    allYears: sorted.length ? summarize('All years', sorted, sunByDate, false, false) : null,
    glitches: sorted.filter(isGlitch),
    sunlightFrom: sunDates[0] ?? null,
    byDayOfYear,
  };
}
