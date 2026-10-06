// Estimates whether the solar panels have paid for themselves, one NEM True-Up year
// at a time back to the August 2014 install, from PG&E's bill history (net kWh per
// bill) and Enphase's daily production totals. solarSavings.ts models 2025 on from
// hourly data; this works at bill level so it can reach years with no interval data.
//
// Without solar, each bill's usage is its net kWh plus what the panels produced in
// those days. That's priced at PG&E's total bundled rates (data/pge-rate-history.json
// through 2024, solarSavings.ts's RATE_PERIODS after) on the plan the house would have
// been on: tiered E-1 until PG&E's default move to E-TOU-C, then E-TOU-C, with the
// peak (4-9pm) share of usage taken from the hourly data since 2025. Usage is spread
// evenly over a bill's days, and each day gets its own rates and baseline allowance.
// 3CE's generation rates are ignored; all years are treated as PG&E bundled service.
//
// With solar, a True-Up year costs the larger of its NEM charges and the delivery
// minimum bill (a year-end credit is forfeited). The NEM charges come from the bills
// (usage_charges, then total_nem_charges from late 2022), or from solarSavings.ts's
// hourly model where the bill has none. From about 2018 the bills' NEM charges cover
// PG&E delivery only, since 3CE bills generation separately, but the house nets out
// well under the minimum every year, so the minimum is what the year costs.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CITY_TAX_RATE, RATES_EFFECTIVE_FROM, SOLAR_COMPLETE_INTERVALS, isPeakHour, ratePeriodFor, seasonFor, trueUpYearFor } from './solarSavings.ts';
import type { HourlyUsage, Season, SeasonRates } from './solarSavings.ts';

// What the system cost after incentives.
export const SOLAR_NET_COST = 5735;

// The first bill under NEM; the bill before it ends when the meter was switched over.
const NEM_START = '2014-08-15';

// PG&E moved non-solar E-1 customers to E-TOU-C by county between April 2021 and early
// 2022, each with a year of bill protection (paying the lesser of the two plans). We
// don't know this county's date, so it's approximated.
export const NO_SOLAR_TOU_FROM = '2022-06-01';

interface E1Period {
  from: string;
  to: string;
  minimumPerDay: number;
  tiers: { upToPercentOfBaseline: number | null; rate: number }[];
}

interface ETouCPeriod {
  from: string;
  to: string;
  minimumPerDay: number;
  summer: SeasonRates;
  winter: SeasonRates;
  baselineCredit: number; // negative in the workbooks
}

interface BaselinePeriod {
  from: string;
  summerMonths: [number, number];
  winterKwhPerDay: number;
  summerKwhPerDay: number;
}

interface RateHistory {
  e1: E1Period[];
  eTouC: ETouCPeriod[];
  baseline: BaselinePeriod[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RATE_HISTORY = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'pge-rate-history.json'), 'utf8'),
) as RateHistory;

function periodFor<T extends { from: string }>(periods: T[], date: string): T {
  let period: T | undefined;
  for (const p of periods) {
    if (p.from <= date) period = p;
  }
  if (!period) throw new Error(`no rates for ${date}`);
  return period;
}

function baselineKwhFor(date: string): number {
  const b = periodFor(RATE_HISTORY.baseline, date);
  const month = Number(date.slice(5, 7));
  const [first, last] = b.summerMonths;
  return month >= first && month <= last ? b.summerKwhPerDay : b.winterKwhPerDay;
}

function minimumPerDayFor(date: string): number {
  return date < RATES_EFFECTIVE_FROM ? periodFor(RATE_HISTORY.e1, date).minimumPerDay : ratePeriodFor(date).minDeliveryPerDay;
}

// E-TOU-C rates for one day, as positive $/kWh.
function eTouCFor(date: string): { rates: SeasonRates; baselineCredit: number } {
  const season = seasonFor(date);
  if (date >= RATES_EFFECTIVE_FROM) {
    const p = ratePeriodFor(date);
    return { rates: p[season], baselineCredit: p.baselineCredit };
  }
  const p = periodFor(RATE_HISTORY.eTouC, date);
  return { rates: p[season], baselineCredit: -p.baselineCredit };
}

function daysBetween(start: string, end: string): string[] {
  const days: string[] = [];
  for (const d = new Date(`${start}T00:00:00Z`); d.toISOString().slice(0, 10) < end; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

// Prices usage spread evenly over the days [start, end), before tax. The tier limits
// and baseline credit apply to each day's share of the bill's total baseline
// allowance, which matched the 2013-14 bills before solar.
function noSolarBill(days: string[], kwh: number, peakShare: Record<Season, number>): number {
  const perDay = kwh / days.length;
  const allowancePerDay = days.reduce((sum, d) => sum + baselineKwhFor(d), 0) / days.length;
  let total = 0;
  for (const day of days) {
    if (day < NO_SOLAR_TOU_FROM) {
      let remaining = perDay;
      let tierStart = 0;
      for (const tier of periodFor(RATE_HISTORY.e1, day).tiers) {
        const tierEnd = tier.upToPercentOfBaseline === null ? Infinity : allowancePerDay * tier.upToPercentOfBaseline / 100;
        const used = Math.min(remaining, Math.max(0, tierEnd - tierStart));
        total += used * tier.rate;
        remaining -= used;
        tierStart = tierEnd;
      }
    } else {
      const { rates, baselineCredit } = eTouCFor(day);
      const share = peakShare[seasonFor(day)];
      total += perDay * (share * rates.peak + (1 - share) * rates.offPeak);
      total -= baselineCredit * Math.min(perDay, allowancePerDay);
    }
  }
  return total;
}

// The share of usage without solar (net usage plus production) that falls in the
// 4-9pm peak, by season, over the days with hourly usage and complete solar data.
export function peakShareFromHourly(
  hourly: HourlyUsage[],
  solarKwhByHour: Map<string, number>, // key: `${date} ${HH:00}`
  solarIntervalCountByDate: Map<string, number>,
): Record<Season, number> {
  const totals = { summer: { peak: 0, all: 0 }, winter: { peak: 0, all: 0 } };
  for (const h of hourly) {
    if ((solarIntervalCountByDate.get(h.usageDate) ?? 0) < SOLAR_COMPLETE_INTERVALS) continue;
    const kwh = h.importKwh - h.exportKwh + (solarKwhByHour.get(`${h.usageDate} ${h.startTime}`) ?? 0);
    const t = totals[seasonFor(h.usageDate)];
    t.all += kwh;
    if (isPeakHour(h.startTime)) t.peak += kwh;
  }
  return { summer: totals.summer.peak / totals.summer.all, winter: totals.winter.peak / totals.winter.all };
}

export interface Bill {
  startDate: string;
  endDate: string; // exclusive
  netKwh: number;
  nemCharges: number | null; // with tax; null when the bill doesn't report them
}

export interface PaybackYear {
  trueUpYear: number;
  startDate: string;
  endDate: string; // exclusive
  partial: boolean; // the first year, which starts at the install rather than a True-Up
  estimatedBills: string[]; // labels of missing bills filled in from their neighbors
  noSolarPlan: string;
  solarKwh: number;
  usageKwh: number; // estimated usage without solar
  nemCharges: number;
  minimumTotal: number;
  withSolarCost: number;
  noSolarCost: number;
  savings: number;
  cumulativeSavings: number;
}

export interface Payback {
  years: PaybackYear[]; // oldest first; settled True-Up years only
  cost: number;
  totalSavings: number;
  paidOffYear: number | null;
}

// bills: oldest first, from the bill history. modeledNemCharges: solarSavings.ts's
// modeled bill with solar (with tax) keyed by bill start date, for bills without NEM
// charges of their own.
export function computePayback(
  bills: Bill[],
  solarKwhByDate: Map<string, number>,
  peakShare: Record<Season, number>,
  modeledNemCharges: Map<string, number>,
): Payback {
  // A True-Up year has settled once a bill from the next year exists.
  const lastSettledYear = bills.length ? trueUpYearFor(bills[bills.length - 1].startDate) - 1 : 0;

  // Fill gaps in the bill history from the neighboring bills' daily averages.
  const nemBills = bills.filter((b) => b.startDate >= NEM_START);
  const filled: (Bill & { estimated: boolean })[] = [];
  for (const [i, bill] of nemBills.entries()) {
    const prev = filled.at(-1);
    if (prev && prev.endDate < bill.startDate) {
      const gapDays = daysBetween(prev.endDate, bill.startDate).length;
      const neighbors = [prev, bill];
      const perDay = (f: (b: Bill) => number) =>
        neighbors.reduce((sum, b) => sum + f(b) / daysBetween(b.startDate, b.endDate).length, 0) / neighbors.length;
      filled.push({
        startDate: prev.endDate,
        endDate: bill.startDate,
        netKwh: perDay((b) => b.netKwh) * gapDays,
        nemCharges: perDay((b) => b.nemCharges ?? 0) * gapDays,
        estimated: true,
      });
    }
    filled.push({ ...nemBills[i], estimated: false });
  }

  const byYear = new Map<number, typeof filled>();
  for (const bill of filled) {
    const year = trueUpYearFor(bill.startDate);
    if (year > lastSettledYear) continue;
    byYear.set(year, [...(byYear.get(year) ?? []), bill]);
  }

  let cumulativeSavings = 0;
  const years = [...byYear.entries()].map(([trueUpYear, yearBills], index): PaybackYear => {
    let solarKwh = 0;
    let usageKwh = 0;
    let nemCharges = 0;
    let minimumTotal = 0;
    let noSolarCost = 0;
    for (const bill of yearBills) {
      const days = daysBetween(bill.startDate, bill.endDate);
      const solar = days.reduce((sum, d) => sum + (solarKwhByDate.get(d) ?? 0), 0);
      solarKwh += solar;
      usageKwh += bill.netKwh + solar;
      nemCharges += bill.nemCharges ?? modeledNemCharges.get(bill.startDate) ?? 0;
      minimumTotal += days.reduce((sum, d) => sum + minimumPerDayFor(d), 0) * (1 + CITY_TAX_RATE);
      noSolarCost += noSolarBill(days, bill.netKwh + solar, peakShare) * (1 + CITY_TAX_RATE);
    }
    const startDate = yearBills[0].startDate;
    const endDate = yearBills[yearBills.length - 1].endDate;
    const withSolarCost = Math.max(nemCharges, minimumTotal, 0);
    const savings = noSolarCost - withSolarCost;
    cumulativeSavings += savings;
    return {
      trueUpYear,
      startDate,
      endDate,
      partial: index === 0,
      estimatedBills: yearBills.filter((b) => b.estimated).map((b) => `${b.startDate} to ${b.endDate}`),
      noSolarPlan: endDate <= NO_SOLAR_TOU_FROM ? 'E-1' : startDate >= NO_SOLAR_TOU_FROM ? 'E-TOU-C' : 'E-1, then E-TOU-C',
      solarKwh,
      usageKwh,
      nemCharges,
      minimumTotal,
      withSolarCost,
      noSolarCost,
      savings,
      cumulativeSavings,
    };
  });

  return {
    years,
    cost: SOLAR_NET_COST,
    totalSavings: cumulativeSavings,
    paidOffYear: years.find((y) => y.cumulativeSavings >= SOLAR_NET_COST)?.trueUpYear ?? null,
  };
}
