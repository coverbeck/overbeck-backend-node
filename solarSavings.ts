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
// out the generation 3CE supplies), and the flat daily charge (Minimum Delivery Charge,
// then Base Services Charge from March 2026), which doesn't vary with usage.
//
// Per-period numbers ignore NEM's annual True-Up, so computeNemYears settles each
// True-Up year separately: the year's bill with solar is the larger of its summed
// period bills and the minimum delivery charge (a year-end credit is forfeited, not
// paid out). The no-solar side never drops that low, so it's just the sum.

interface SeasonRates {
  peak: number; // $/kWh, 4-9pm every day
  offPeak: number; // $/kWh
}

interface RatePeriod {
  from: string; // first day these rates apply, YYYY-MM-DD
  summer: SeasonRates;
  winter: SeasonRates;
  baselineCredit: number; // $/kWh, applied to net usage up to the baseline allowance
  pcia: number; // $/kWh, 2018 vintage residential
  minDeliveryPerDay: number; // $/day delivery minimum bill; 0 once the Base Services Charge replaced it
}

// Total bundled E-TOU-C rates from PG&E's Res_Inclu_TOU_*.xlsx rate tables. PCIA
// changes each January; 2025's is derived from a real bill's PCIA line (it isn't
// printed as a rate), 2026's is the published figure.
const RATE_PERIODS: RatePeriod[] = [
  {
    from: '2025-01-01',
    summer: { peak: 0.60729, offPeak: 0.50429 },
    winter: { peak: 0.49312, offPeak: 0.46312 },
    baselineCredit: 0.10135,
    pcia: 0.0067,
    minDeliveryPerDay: 0.39167,
  },
  {
    from: '2025-03-01',
    summer: { peak: 0.62569, offPeak: 0.50269 },
    winter: { peak: 0.50086, offPeak: 0.47086 },
    baselineCredit: 0.10301,
    pcia: 0.0067,
    minDeliveryPerDay: 0.40317,
  },
  {
    from: '2025-09-01',
    summer: { peak: 0.61457, offPeak: 0.49157 },
    winter: { peak: 0.48974, offPeak: 0.45974 },
    baselineCredit: 0.10084,
    pcia: 0.0067,
    minDeliveryPerDay: 0.40317,
  },
  {
    from: '2026-01-01',
    summer: { peak: 0.58943, offPeak: 0.46643 },
    winter: { peak: 0.46460, offPeak: 0.43460 },
    baselineCredit: 0.09566,
    pcia: 0.03679,
    minDeliveryPerDay: 0.40317,
  },
  {
    from: '2026-03-01',
    summer: { peak: 0.52240, offPeak: 0.39940 },
    winter: { peak: 0.39757, offPeak: 0.36757 },
    baselineCredit: 0.08140,
    pcia: 0.03679,
    minDeliveryPerDay: 0,
  },
];

// Periods starting before this date are skipped rather than modeled with unknown rates.
export const RATES_EFFECTIVE_FROM = RATE_PERIODS[0].from;

// Territory T, Code B (not all-electric); unchanged since 2022-06-01.
const BASELINE_KWH_PER_DAY = { summer: 6.5, winter: 7.5 };
const CITY_TAX_RATE = 0.085;

// Same completeness threshold fetch-enphase.js uses: a date counts as fully fetched
// once it has at least this many of its 288 five-minute intervals.
const SOLAR_COMPLETE_INTERVALS = 250;

type Season = 'summer' | 'winter';

// Summer = June 1 - Sept 30, winter = Oct 1 - May 31.
function seasonFor(date: string): Season {
  const month = Number(date.slice(5, 7));
  return month >= 6 && month <= 9 ? 'summer' : 'winter';
}

function ratePeriodIndexFor(date: string): number {
  let index = 0;
  for (let i = 0; i < RATE_PERIODS.length; i++) {
    if (RATE_PERIODS[i].from <= date) index = i;
  }
  return index;
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
  windowStart: string;
  inProgress: boolean;
  days: number;
  solarDays: number; // days in the period with complete solar data
  solarKwh: number | null; // null when solar data is incomplete for the period
  exportKwh: number;
  actualCost: number;
  noSolarCost: number | null;
  savings: number | null;
  minDeliveryCost: number; // the period's delivery minimum bill, with tax
}

interface NetHour {
  usageDate: string;
  startTime: string;
  netKwh: number;
}

// Models the variable part of one period's electric bill from hourly net usage.
// netKwh may be negative (a net-export hour); export credits at the same rate within
// the same bucket, matching how the bill nets each TOU window.
//
// Like the real bill, the period is split into segments wherever the season or the
// rates change, and each segment gets its own baseline allowance (its days x the
// season's daily quantity) and baseline credit. The credit applies to the segment's
// net usage up to the allowance, and it is not floored at zero: a net-export segment
// is charged the credit back (e.g. -107.673 kWh @ -$0.10301 = +$11.09 on the
// Jun 2025 bill).
function modelBill(hours: NetHour[]): number {
  const segments = new Map<string, { rates: RatePeriod; season: Season; days: Set<string>; energy: number; net: number }>();
  for (const h of hours) {
    const rateIndex = ratePeriodIndexFor(h.usageDate);
    const season = seasonFor(h.usageDate);
    const key = `${rateIndex} ${season}`;
    let segment = segments.get(key);
    if (!segment) {
      segment = { rates: RATE_PERIODS[rateIndex], season, days: new Set(), energy: 0, net: 0 };
      segments.set(key, segment);
    }
    const seasonRates = segment.rates[season];
    segment.days.add(h.usageDate);
    segment.energy += h.netKwh * (isPeakHour(h.startTime) ? seasonRates.peak : seasonRates.offPeak);
    segment.net += h.netKwh;
  }

  let total = 0;
  for (const s of segments.values()) {
    const allowance = s.days.size * BASELINE_KWH_PER_DAY[s.season];
    const baselineCredit = -s.rates.baselineCredit * Math.min(s.net, allowance);
    const pcia = s.rates.pcia * s.net;
    total += s.energy + baselineCredit + pcia;
  }
  return total * (1 + CITY_TAX_RATE);
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

    const days = new Set(hours.map((h) => h.usageDate));
    const solarDays = [...days].filter(
      (d) => (solarIntervalCountByDate.get(d) ?? 0) >= SOLAR_COMPLETE_INTERVALS).length;
    const solarComplete = solarDays === days.size;

    const actualHours = hours.map((h) => ({ ...h, netKwh: h.importKwh - h.exportKwh }));
    const actualCost = modelBill(actualHours);

    let solarKwh: number | null = null;
    let noSolarCost: number | null = null;
    if (solarComplete) {
      const solarFor = (h: HourlyUsage) => solarKwhByHour.get(`${h.usageDate} ${h.startTime}`) ?? 0;
      // Without panels, every kWh generated in an hour would have come from the grid instead.
      const noSolarHours = actualHours.map((h) => ({ ...h, netKwh: h.netKwh + solarFor(h) }));
      solarKwh = actualHours.reduce((sum, h) => sum + solarFor(h), 0);
      noSolarCost = modelBill(noSolarHours);
    }

    const minDeliveryCost = [...days].reduce(
      (sum, d) => sum + RATE_PERIODS[ratePeriodIndexFor(d)].minDeliveryPerDay, 0) * (1 + CITY_TAX_RATE);

    rows.push({
      label: window.label,
      windowStart: window.windowStart,
      inProgress: window.windowEnd === null,
      days: days.size,
      solarDays,
      solarKwh,
      exportKwh: hours.reduce((sum, h) => sum + h.exportKwh, 0),
      actualCost,
      noSolarCost,
      savings: noSolarCost === null ? null : noSolarCost - actualCost,
      minDeliveryCost,
    });
  }

  return rows;
}

// This account's True-Up statement comes in July: the last billing period of a NEM
// year starts in late June, and the next year's first period starts in late July.
const TRUE_UP_MONTH = 7;

function trueUpYearFor(windowStart: string): number {
  const year = Number(windowStart.slice(0, 4));
  return Number(windowStart.slice(5, 7)) >= TRUE_UP_MONTH ? year + 1 : year;
}

export interface NemYear {
  trueUpYear: number;
  inProgress: boolean;
  rows: SavingsRow[]; // oldest first
  excludesCurrentPeriod: boolean; // totals leave out the in-progress period (incomplete solar data)
  // False when the year's savings can't be settled: its first period predates our
  // usage data, or some period lacks complete solar data.
  complete: boolean;
  solarKwh: number | null;
  exportKwh: number;
  periodTotal: number; // sum of the periods' modeled bills with solar
  minDeliveryTotal: number;
  trueUpCost: number; // what the year actually costs with solar, after True-Up
  noSolarCost: number | null;
  savings: number | null;
}

// Groups billing periods (oldest first) into NEM True-Up years, oldest first.
export function computeNemYears(rows: SavingsRow[]): NemYear[] {
  const byYear = new Map<number, SavingsRow[]>();
  for (const row of rows) {
    const year = trueUpYearFor(row.windowStart);
    byYear.set(year, [...(byYear.get(year) ?? []), row]);
  }

  return [...byYear.entries()].map(([trueUpYear, allRows]) => {
    // The in-progress period's newest day usually has partial solar data, so an
    // in-progress year is totaled through its last period with complete data.
    const excludesCurrentPeriod = allRows.some((r) => r.inProgress && r.savings === null);
    const yearRows = excludesCurrentPeriod ? allRows.filter((r) => !r.inProgress) : allRows;
    const startsWithYear = yearRows.length > 0 && Number(yearRows[0].windowStart.slice(5, 7)) === TRUE_UP_MONTH;
    const complete = startsWithYear && yearRows.every((r) => r.savings !== null);
    const periodTotal = yearRows.reduce((sum, r) => sum + r.actualCost, 0);
    const minDeliveryTotal = yearRows.reduce((sum, r) => sum + r.minDeliveryCost, 0);
    const inProgress = allRows.some((r) => r.inProgress);
    // A net credit at True-Up is forfeited, and the delivery minimum bill sets a floor.
    // Neither applies until the year settles, so an in-progress year shows its running sum.
    const trueUpCost = inProgress ? periodTotal : Math.max(periodTotal, minDeliveryTotal, 0);
    const noSolarCost = complete ? yearRows.reduce((sum, r) => sum + (r.noSolarCost ?? 0), 0) : null;
    return {
      trueUpYear,
      inProgress,
      rows: allRows,
      excludesCurrentPeriod,
      complete,
      solarKwh: complete ? yearRows.reduce((sum, r) => sum + (r.solarKwh ?? 0), 0) : null,
      exportKwh: yearRows.reduce((sum, r) => sum + r.exportKwh, 0),
      periodTotal,
      minDeliveryTotal,
      trueUpCost,
      noSolarCost,
      savings: noSolarCost === null ? null : noSolarCost - trueUpCost,
    };
  });
}
