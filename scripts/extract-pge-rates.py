#!/usr/bin/env python3
"""Builds data/pge-rate-history.json from PG&E's published residential rate workbooks.

The historical solar savings rows (before solarSavings.ts's hand-entered RATE_PERIODS
begin) price usage with these rates. Covers, for baseline territory T, basic electric
(code B), individually metered:
  - e1:       tiered E-1 total bundled rates and the daily delivery minimum
  - eTouC:    E-TOU-C total bundled peak/off-peak rates and the baseline credit
  - baseline: baseline allowance in kWh/day, with the summer season it applies to

Workbooks are listed on https://www.pge.com/tariffs/en/rate-information/electric-rates.html
and downloaded to a cache directory (rerunning reuses them). Needs openpyxl (.xlsx)
and xlrd (older .xls):
  pip3 install openpyxl xlrd
  python3 scripts/extract-pge-rates.py [cache-dir]
"""
import json
import os
import re
import sys
import tempfile
import urllib.request

import openpyxl
import xlrd

RATES_PAGE = 'https://www.pge.com/tariffs/en/rate-information/electric-rates.html'
WORKBOOK_URL = 'https://www.pge.com/assets/rates/tariffs/'
# 2013 covers the last full year without solar, for checking the model against real
# bills. Rates from 2025 on are hand-entered in solarSavings.ts.
FIRST_DATE = '2013-01-01'
END_DATE = '2025-01-01'
OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'pge-rate-history.json')

# Baseline workbooks lay out each season's effective date and month range in prose,
# so those are entered here; the kWh figures are read from the workbook. Summer months
# are inclusive. Where a workbook staggers its seasons (e.g. new summer quantity in
# August, new winter one in November), `from` is the earlier date, since the other
# season doesn't occur in between.
BASELINE_PERIODS = [
    {'from': '2011-06-20', 'file': 'ResElecBaselineEffec_110620-140731.xls', 'summerMonths': [5, 10]},
    {'from': '2014-08-01', 'file': 'ResElecBaselineEffec_140801-181231.xlsx', 'summerMonths': [5, 10]},
    {'from': '2019-01-01', 'file': 'ResElecBaselineEffec_190101-190930.xlsx', 'summerMonths': [5, 10]},
    # Seasons changed to June-September summer starting with this winter.
    {'from': '2019-10-01', 'file': 'ResElecBaselineEffec_191001-201231.xlsx', 'summerMonths': [6, 9]},
    {'from': '2022-06-01', 'file': 'Res_Inclu_TOU_240101-240229.xlsx', 'sheet': 'ElecBaselineEffec220601', 'summerMonths': [6, 9]},
]
TERRITORY = 'T'


def iso(yymmdd):
    return f'20{yymmdd[0:2]}-{yymmdd[2:4]}-{yymmdd[4:6]}'


def next_day(date):
    import datetime
    return (datetime.date.fromisoformat(date) + datetime.timedelta(days=1)).isoformat()


def fetch(cache_dir, name):
    path = os.path.join(cache_dir, name)
    if not os.path.exists(path):
        req = urllib.request.Request(WORKBOOK_URL + name, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as res, open(path, 'wb') as f:
            f.write(res.read())
    return path


def sheets(path):
    """Yields (sheet name, rows as lists of cell values) for .xls or .xlsx."""
    if path.endswith('.xls'):
        wb = xlrd.open_workbook(path)
        for sh in wb.sheets():
            yield sh.name, [[sh.cell_value(r, c) for c in range(sh.ncols)] for r in range(sh.nrows)]
    else:
        wb = openpyxl.load_workbook(path, data_only=True)
        for ws in wb.worksheets:
            yield ws.title, [list(r) for r in ws.iter_rows(values_only=True)]


def text(cell):
    return re.sub(r'\s+', ' ', str(cell)).strip() if cell is not None else ''


def number(cell):
    return round(cell, 6) if isinstance(cell, (int, float)) and not isinstance(cell, bool) else None


def tier_limit(header):
    """Upper bound of a tier as a percent of baseline; None for the open-ended top tier."""
    if 'over' in header.lower():
        return None
    percents = [int(p) for p in re.findall(r'(\d+)%', header)]
    return max(percents) if percents else 100


def parse_e1(rows):
    header = rows[1]
    data = next(r for r in rows[:8] if text(r[1]).startswith('Tiered Energy Charges'))
    tiers = []
    for col, h in enumerate(header):
        h = text(h)
        if not h or h.startswith('ES'):
            continue
        rate = number(data[col])
        if rate is None:
            raise ValueError(f'no E-1 rate under tier header {h!r}')
        limit = tier_limit(h)
        # Some periods repeat a rate across adjacent tiers; collapse them.
        if tiers and tiers[-1]['rate'] == rate:
            tiers[-1]['upToPercentOfBaseline'] = limit
        else:
            tiers.append({'upToPercentOfBaseline': limit, 'rate': rate})
    if tiers[-1]['upToPercentOfBaseline'] is not None:
        raise ValueError('top E-1 tier is not open-ended')
    return {'minimumPerDay': number(data[2]), 'tiers': tiers}


def parse_e_tou_c(rows):
    start = next((i for i, r in enumerate(rows) if re.search(r'Schedule E-TOU-C(?!\d)', text(r[0]))), None)
    if start is None:
        return None
    result = {'minimumPerDay': number(rows[start][2])}
    season = None
    for r in rows[start:start + 4]:
        cells = [text(c) for c in r]
        if 'Summer' in cells:
            season = 'summer'
        elif 'Winter' in cells:
            season = 'winter'
        label = 'peak' if 'Peak' in cells else 'offPeak'
        label_col = cells.index('Peak' if label == 'peak' else 'Off-Peak')
        values = [number(c) for c in r[label_col + 1:]]
        rate, credit = values[0], values[1]
        result.setdefault(season, {})[label] = rate
        if credit is not None:
            prior = result.setdefault('baselineCredit', credit)
            if prior != credit:
                raise ValueError('E-TOU-C baseline credit differs between seasons')
    return result


def parse_baseline(rows):
    code_b = next(i for i, r in enumerate(rows) if '(Code B)' in [text(c) for c in r])
    row = next(r for r in rows[code_b:] if text(r[0]) == TERRITORY)
    cells = [c for c in row if c not in (None, '')]
    # TERRITORY, winter individual, winter master, TERRITORY, summer individual, summer master
    return {'winterKwhPerDay': float(str(cells[1]).rstrip('*')), 'summerKwhPerDay': float(str(cells[4]).rstrip('*'))}


def main():
    cache_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), 'pge-rate-workbooks')
    os.makedirs(cache_dir, exist_ok=True)

    req = urllib.request.Request(RATES_PAGE, headers={'User-Agent': 'Mozilla/5.0'})
    page = urllib.request.urlopen(req).read().decode('utf-8', 'replace')
    names = sorted(set(re.findall(r'Res(?:_Inclu_TOU)?_\d{6}-\d{6}\.xlsx?', page)))

    e1, e_tou_c = [], []
    for name in sorted(names, key=lambda n: re.search(r'(\d{6})-', n).group(1)):
        start, end = re.search(r'(\d{6})-(\d{6})', name).groups()
        date_from, date_to = iso(start), next_day(iso(end))
        if date_to <= FIRST_DATE or date_from >= END_DATE:
            continue
        _, rows = next(sheets(fetch(cache_dir, name)))
        source = {'from': date_from, 'to': date_to, 'source': name}
        e1.append({**source, **parse_e1(rows)})
        tou = parse_e_tou_c(rows)
        if tou:
            e_tou_c.append({**source, **tou})

    for periods in (e1, e_tou_c):
        for a, b in zip(periods, periods[1:]):
            if a['to'] != b['from']:
                raise ValueError(f"gap or overlap between {a['source']} and {b['source']}")

    baseline = []
    for p in BASELINE_PERIODS:
        path = fetch(cache_dir, p['file'])
        rows = next(rs for name, rs in sheets(path) if name.startswith(p.get('sheet', '')))
        baseline.append({'from': p['from'], 'source': p['file'], 'summerMonths': p['summerMonths'], **parse_baseline(rows)})

    out = {
        'description': 'PG&E residential total bundled rates (non-CARE) and baseline allowances for '
                       f'territory {TERRITORY}, basic electric, from {RATES_PAGE}. '
                       'Generated by scripts/extract-pge-rates.py; do not edit by hand. '
                       'Dates: from inclusive, to exclusive.',
        'territory': TERRITORY,
        'e1': e1,
        'eTouC': e_tou_c,
        'baseline': baseline,
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, 'w') as f:
        json.dump(out, f, indent=2)
        f.write('\n')
    print(f'{len(e1)} E-1 periods, {len(e_tou_c)} E-TOU-C periods, {len(baseline)} baseline periods -> {os.path.relpath(OUT_PATH)}')


if __name__ == '__main__':
    main()
