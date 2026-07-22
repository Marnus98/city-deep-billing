// municipal_compare.js - "our billing vs the utility" comparison shown alongside the raw
// municipal statement breakdown (municipal_accounts route/page).
//
// Two things make this a real matching problem rather than a simple join:
//  1. COJ's reading period for a statement almost never lines up with this app's own billing
//     period boundaries (different meter-read dates entirely) - so periods are matched by which
//     of our billing_periods has the greatest date-overlap with COJ's own reading period, not by
//     any label.
//  2. The "Industrial Park" site is fed by *two* separate COJ bulk accounts (559304053 and
//     559304060, labelled "Industrial A"/"Industrial B" here) - so comparing against just one of
//     them would understate the utility side. Both are summed whenever either is being viewed.
//
// Mapping confirmed directly by the client: Mini -> 'Mini Park', Industrial A/B -> 'Industrial
// Park' (combined), Rittle -> 'City Deep' (this site doesn't have any tenants imported yet, so
// the comparison will legitimately show "no internal data" for Rittle until it does).
const SITE_MAP = {
  Mini: 'Mini Park',
  'Industrial A': 'Industrial Park',
  'Industrial B': 'Industrial Park',
  Rittle: 'City Deep',
};

function get(db, sql, params = []) { return db.prepare(sql).get(...params); }
function all(db, sql, params = []) { return db.prepare(sql).all(...params); }

function daysOverlap(aStart, aEnd, bStart, bEnd) {
  const s = aStart > bStart ? aStart : bStart;
  const e = aEnd < bEnd ? aEnd : bEnd;
  const days = (new Date(e) - new Date(s)) / 86400000;
  return days > 0 ? days : 0;
}

// Finds the billing_period whose [start_date,end_date] overlaps [readingStart,readingEnd] the
// most (in days). Returns null if there's no overlap at all with any period.
function bestOverlappingPeriod(db, readingStart, readingEnd) {
  if (!readingStart || !readingEnd) return null;
  const periods = all(db, 'SELECT * FROM billing_periods');
  let best = null, bestDays = 0;
  for (const p of periods) {
    const d = daysOverlap(readingStart, readingEnd, p.start_date, p.end_date);
    if (d > bestDays) { bestDays = d; best = p; }
  }
  return best ? { period: best, overlapDays: bestDays } : null;
}

// Sums this app's own internally-billed electricity/water for every tenant on `siteName`, for one
// billing period. Deliberately two separate queries rather than one JOIN across bills and
// bill_line_items: bills:bill_line_items is 1:many, so summing bills.electricity_consumption_kwh
// in the same row set as the line-item join would fan out and multiply it by however many line
// items each bill has - confirmed as a real bug during testing (consumption came out ~19x too
// high). Rand totals are safe to sum straight from bill_line_items since that's already the
// correct granularity.
function ourSiteTotals(db, siteName, periodId) {
  const consumption = get(db, `
    SELECT
      COALESCE(SUM(b.electricity_consumption_kwh), 0) AS elec_kwh,
      COALESCE(SUM(b.water_consumption_m3), 0) AS water_kl,
      COUNT(DISTINCT b.tenant_id) AS tenant_count
    FROM bills b
    JOIN tenants t ON t.id = b.tenant_id
    JOIN sites s ON s.id = t.site_id
    WHERE s.name = ? AND b.billing_period_id = ?
  `, [siteName, periodId]);
  const charges = get(db, `
    SELECT
      COALESCE(SUM(CASE WHEN bli.utility_type='electricity' THEN bli.amount END), 0) AS elec_rand,
      COALESCE(SUM(CASE WHEN bli.utility_type='water' THEN bli.amount END), 0) AS water_rand
    FROM bill_line_items bli
    JOIN bills b ON b.id = bli.bill_id
    JOIN tenants t ON t.id = b.tenant_id
    JOIN sites s ON s.id = t.site_id
    WHERE s.name = ? AND b.billing_period_id = ?
  `, [siteName, periodId]);
  return { ...consumption, ...charges };
}

// Sums COJ's own billed electricity/water (incl. VAT) across every municipal account mapped to
// `siteName`, using - for each such account - whichever of its statements best overlaps the given
// anchor reading period (so Industrial A and Industrial B don't have to be on exactly the same
// statement cadence to be combined correctly).
function cojSiteTotals(db, siteName, anchorStart, anchorEnd) {
  const accountLabels = Object.keys(SITE_MAP).filter((l) => SITE_MAP[l] === siteName);
  const accounts = all(db, 'SELECT * FROM municipal_accounts WHERE label IN (' + accountLabels.map(() => '?').join(',') + ')', accountLabels);
  let elecKwh = 0, elecRand = 0, waterKl = 0, waterRand = 0;
  const matched = [];
  for (const acc of accounts) {
    const statements = all(db, 'SELECT * FROM municipal_statements WHERE municipal_account_id=?', [acc.id]);
    let best = null, bestDays = 0;
    for (const s of statements) {
      const d = daysOverlap(anchorStart, anchorEnd, s.elec_reading_start || s.water_reading_start, s.elec_reading_end || s.water_reading_end);
      if (d > bestDays) { bestDays = d; best = s; }
    }
    if (best) {
      elecKwh += best.elec_consumption_kwh || 0;
      elecRand += best.elec_incl_vat || 0;
      waterKl += best.water_consumption_kl || 0;
      waterRand += (best.water_incl_vat || 0) + (best.sanitation_incl_vat || 0);
      matched.push({ account: acc.label, statement_for: best.statement_for, overlapDays: Math.round(bestDays) });
    }
  }
  return { elecKwh, elecRand, waterKl, waterRand, matched };
}

// Top-level entry point: given the municipal statement currently being viewed, build the "ours vs
// utility" comparison for its site. Returns null if this account isn't mapped to a site, or if no
// internal billing period overlaps its reading dates at all.
function buildComparison(db, statement, accountLabel) {
  const siteName = SITE_MAP[accountLabel];
  if (!siteName) return null;

  const anchorStart = statement.elec_reading_start || statement.water_reading_start;
  const anchorEnd = statement.elec_reading_end || statement.water_reading_end;
  const match = bestOverlappingPeriod(db, anchorStart, anchorEnd);
  if (!match) return { siteName, period: null };

  const ours = ourSiteTotals(db, siteName, match.period.id);
  const coj = cojSiteTotals(db, siteName, anchorStart, anchorEnd);
  return { siteName, period: match.period, overlapDays: Math.round(match.overlapDays), ours, coj };
}

module.exports = { SITE_MAP, buildComparison, bestOverlappingPeriod, ourSiteTotals, cojSiteTotals };
