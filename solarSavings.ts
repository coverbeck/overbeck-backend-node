// Estimates how much solar generation saved per billing period, by modeling the
// variable part of the electric bill twice under PG&E rate plan E-TOU-C: once with
// actual net usage (import - export), and once as if there were no panels (net usage
// plus the solar generated in that hour). Both use the same rate plan; the difference
// is the savings.
//
// Modeled lines: TOU energy charges (net kWh per season/peak bucket x rate), the
// baseline credit, PCIA, and city tax. Validated against two real bills (Jul 27-Aug 25
// and Mar 30-Apr 27, 2026) to within ~0.5%. Deliberately left out: PG&E's Generation
// Credit and 3CE's generation charge, which roughly cancel each other (the credit backs
// out the generation 3CE supplies), and the flat Base Services Charge, which doesn't
// vary with usage. Annual True-Up effects (PG&E forfeits any year-end credit) are also
// out of scope for a per-period number.

// Rates effective 2026-03-01 (Advice 7846-E), unchanged since. Periods starting before
// this date are skipped rather than modeled with the wrong rates.
export const RATES_EFFECTIVE_FROM = '2026-03-01';

interface SeasonRates {
  peak: number; // $/kWh, 4-9pm every day
  offPeak: number; // $/kWh
  baselineKwhPerDay: number; // Territory T, Code B (not all-electric)
}

const SUMMER: SeasonRates = { peak: 0.52240, offPeak: 0.39940, baselineKwhPerDay: 6.5 };
const WINTER: SeasonRates = { peak: 0.39757, offPeak: 0.36757, baselineKwhPerDay: 7.5 };
const BASELINE_CREDIT_PER_KWH = 0.08140;
const PCIA_PER_KWH = 0.03679; // 2018 vintage residential, calendar year 2026
const CITY_TAX_RATE = 0.085;

// Same completeness threshold fetch-enphase.js uses: a date counts as fully fetched
// once it has at least this many of its 288 five-minute intervals.
const SOLAR_COMPLETE_INTERVALS = 250;

// Summer = June 1 - Sept 30, winter = Oct 1 - May 31.
function seasonFor(date: string): SeasonRates {
  const month = Number(date.slice(5, 7));
  return month >= 6 && month <= 9 ? SUMMER : WINTER;
}

// Peak is 4-9pm, i.e. the hour buckets starting 16:00 through 20:00.
function isPeakHour(startTime: string): boolean {
  const hour = Number(startTime.slice(0, 2));
  return hour >= 16 && hour <= 20;
}

export interface HourlyUsage {
  usageDate: string;
  startTime: string; // HH:00
  importKwh: number;
  exportKwh: number;
}

export interface SavingsWindow {
  label: string;
  windowStart: string;
  windowEnd: string | null; // exclusive; null means still in progress
}

export interface SavingsRow {
  label: string;
  inProgress: boolean;
  days: number;
  solarDays: number; // days in the period with complete solar data
  solarKwh: number | null; // null when solar data is incomplete for the period
  exportKwh: number;
  actualCost: number;
  noSolarCost: number | null;
  savings: number | null;
}

// Models the variable part of one period's electric bill from hourly net usage.
// netKwh may be negative (a net-export hour); export credits at the same rate within
// the same bucket, matching how the bill nets each TOU window.
function modelBill(hours: Array<{ usageDate: string; startTime: string; netKwh: number }>, days: Map<string, SeasonRates>): number {
  let energy = 0;
  let totalNet = 0;
  for (const h of hours) {
    const season = seasonFor(h.usageDate);
    energy += h.netKwh * (isPeakHour(h.startTime) ? season.peak : season.offPeak);
    totalNet += h.netKwh;
  }

  // Baseline allowance is per day by season, so a period spanning June 1 or Oct 1 is prorated.
  let allowance = 0;
  for (const season of days.values()) allowance += season.baselineKwhPerDay;
  const baselineCredit = -BASELINE_CREDIT_PER_KWH * Math.min(Math.max(totalNet, 0), allowance);

  const pcia = PCIA_PER_KWH * totalNet;
  return (energy + baselineCredit + pcia) * (1 + CITY_TAX_RATE);
}

export function computeSolarSavings(
  windows: SavingsWindow[],
  hourly: HourlyUsage[],
  solarKwhByHour: Map<string, number>, // key: `${date} ${HH:00}`
  solarIntervalCountByDate: Map<string, number>,
): SavingsRow[] {
  const rows: SavingsRow[] = [];

  for (const window of windows) {
    if (window.windowStart < RATES_EFFECTIVE_FROM) continue;

    const hours = hourly.filter((h) =>
      h.usageDate >= window.windowStart && (window.windowEnd === null || h.usageDate < window.windowEnd));
    if (hours.length === 0) continue;

    const days = new Map<string, SeasonRates>();
    for (const h of hours) days.set(h.usageDate, seasonFor(h.usageDate));
    const solarDays = [...days.keys()].filter(
      (d) => (solarIntervalCountByDate.get(d) ?? 0) >= SOLAR_COMPLETE_INTERVALS).length;
    const solarComplete = solarDays === days.size;

    const actualHours = hours.map((h) => ({ ...h, netKwh: h.importKwh - h.exportKwh }));
    const actualCost = modelBill(actualHours, days);

    let solarKwh: number | null = null;
    let noSolarCost: number | null = null;
    if (solarComplete) {
      const solarFor = (h: HourlyUsage) => solarKwhByHour.get(`${h.usageDate} ${h.startTime}`) ?? 0;
      // Without panels, every kWh generated in an hour would have come from the grid instead.
      const noSolarHours = actualHours.map((h) => ({ ...h, netKwh: h.netKwh + solarFor(h) }));
      solarKwh = actualHours.reduce((sum, h) => sum + solarFor(h), 0);
      noSolarCost = modelBill(noSolarHours, days);
    }

    rows.push({
      label: window.label,
      inProgress: window.windowEnd === null,
      days: days.size,
      solarDays,
      solarKwh,
      exportKwh: hours.reduce((sum, h) => sum + h.exportKwh, 0),
      actualCost,
      noSolarCost,
      savings: noSolarCost === null ? null : noSolarCost - actualCost,
    });
  }

  return rows;
}
