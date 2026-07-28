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
//
// 'Refinery' is Wingfield's own single City of Ekurhuleni account (2210755502) -> 'Wingfield
// Business Park' (its only site). Adding it here works with zero other changes to this file: this
// module always operates on whatever db is currently active (see server.js's AsyncLocalStorage-
// based currentDb()), and each property's municipal_accounts table only ever contains that
// property's own account rows anyway (physical db-per-property isolation, see properties.js) - so
// City Deep's 4-account mapping and Wingfield's 1-account mapping never collide or interfere.
const SITE_MAP = {
  Mini: 'Mini Park',
  'Industrial A': 'Industrial Park',
  'Industrial B': 'Industrial Park',
  Rittle: 'City Deep',
  Refinery: 'Wingfield Business Park',
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

// ---------- "All Accounts (Combined)" mode ----------
// Every distinct COJ "Statement for" label seen across all 4 accounts, most recent first - used
// to populate the period picker when the combined view is selected.
function allStatementLabels(db) {
  return all(db, `SELECT statement_for, MAX(statement_date) AS latest_date
    FROM municipal_statements GROUP BY statement_for ORDER BY latest_date DESC`);
}

const NUMERIC_FIELDS = [
  'elec_consumption_kwh', 'elec_consumption_kvarh', 'elec_excl_vat', 'elec_vat', 'elec_incl_vat',
  'elec_off_peak_kwh', 'elec_off_peak_rand', 'elec_peak_kwh', 'elec_peak_rand',
  'elec_standard_kwh', 'elec_standard_rand', 'elec_energy_kwh', 'elec_energy_rand',
  'elec_demand_kva', 'elec_demand_rand', 'elec_reactive_kvarh', 'elec_reactive_rand',
  'elec_service_rand', 'elec_network_surcharge_rand',
  'water_consumption_kl', 'water_excl_vat', 'water_vat', 'water_incl_vat',
  'sanitation_excl_vat', 'sanitation_vat', 'sanitation_incl_vat',
  'refuse_excl_vat', 'refuse_vat', 'refuse_incl_vat',
  'sundry_excl_vat', 'sundry_vat', 'sundry_incl_vat',
  'property_rates_excl_vat', 'property_rates_vat', 'property_rates_incl_vat',
  'grand_total_incl_vat',
];

// Sums the exact-match statement (by "Statement for" label) across every one of the 4 accounts
// into one synthetic statement-shaped object with the same field names municipalAccountsPage
// already knows how to render. Accounts with no statement under that exact label are listed in
// `missingAccounts` rather than silently skipped, since that changes what the combined total means.
function buildCombinedStatement(db, statementFor) {
  const rows = all(db, `SELECT ms.*, ma.label AS account_label FROM municipal_statements ms
    JOIN municipal_accounts ma ON ma.id = ms.municipal_account_id WHERE ms.statement_for = ?`, [statementFor]);
  const combined = { statement_for: statementFor, invoice_number: null, statement_date: null, elec_tariff_type: 'mixed' };
  for (const f of NUMERIC_FIELDS) combined[f] = 0;
  let earliestElecStart = null, latestElecEnd = null, earliestWaterStart = null, latestWaterEnd = null;
  const matchedAccounts = [];
  for (const r of rows) {
    for (const f of NUMERIC_FIELDS) combined[f] += r[f] || 0;
    if (r.elec_reading_start && (!earliestElecStart || r.elec_reading_start < earliestElecStart)) earliestElecStart = r.elec_reading_start;
    if (r.elec_reading_end && (!latestElecEnd || r.elec_reading_end > latestElecEnd)) latestElecEnd = r.elec_reading_end;
    if (r.water_reading_start && (!earliestWaterStart || r.water_reading_start < earliestWaterStart)) earliestWaterStart = r.water_reading_start;
    if (r.water_reading_end && (!latestWaterEnd || r.water_reading_end > latestWaterEnd)) latestWaterEnd = r.water_reading_end;
    matchedAccounts.push(r.account_label);
  }
  combined.elec_reading_start = earliestElecStart; combined.elec_reading_end = latestElecEnd;
  combined.water_reading_start = earliestWaterStart; combined.water_reading_end = latestWaterEnd;
  const missingAccounts = Object.keys(SITE_MAP).filter((l) => !matchedAccounts.includes(l));
  return { statement: combined, matchedAccounts, missingAccounts };
}

// Sums this app's own internally-billed electricity/water across *every* tenant, any site, for one
// billing period - the "our total spend" side of the combined all-accounts comparison.
function ourAllSitesTotals(db, periodId) {
  const consumption = get(db, `
    SELECT COALESCE(SUM(b.electricity_consumption_kwh),0) AS elec_kwh, COALESCE(SUM(b.water_consumption_m3),0) AS water_kl,
      COUNT(DISTINCT b.tenant_id) AS tenant_count
    FROM bills b WHERE b.billing_period_id = ?
  `, [periodId]);
  const charges = get(db, `
    SELECT COALESCE(SUM(CASE WHEN bli.utility_type='electricity' THEN bli.amount END),0) AS elec_rand,
      COALESCE(SUM(CASE WHEN bli.utility_type='water' THEN bli.amount END),0) AS water_rand
    FROM bill_line_items bli JOIN bills b ON b.id = bli.bill_id WHERE b.billing_period_id = ?
  `, [periodId]);
  return { ...consumption, ...charges };
}

// Combined-mode comparison: utility side is all 4 accounts (best-overlap matched per account, same
// method as cojSiteTotals), our side is every tenant on every site.
function buildComparisonAll(db, combinedStatement) {
  const anchorStart = combinedStatement.elec_reading_start || combinedStatement.water_reading_start;
  const anchorEnd = combinedStatement.elec_reading_end || combinedStatement.water_reading_end;
  const match = bestOverlappingPeriod(db, anchorStart, anchorEnd);
  if (!match) return { siteName: 'All sites', period: null };
  const ours = ourAllSitesTotals(db, match.period.id);
  const accounts = all(db, 'SELECT * FROM municipal_accounts');
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
      elecKwh += best.elec_consumption_kwh || 0; elecRand += best.elec_incl_vat || 0;
      waterKl += best.water_consumption_kl || 0; waterRand += (best.water_incl_vat || 0) + (best.sanitation_incl_vat || 0);
      matched.push({ account: acc.label, statement_for: best.statement_for, overlapDays: Math.round(bestDays) });
    }
  }
  return { siteName: 'All sites', period: match.period, overlapDays: Math.round(match.overlapDays), ours, coj: { elecKwh, elecRand, waterKl, waterRand, matched } };
}

// Shared by the on-screen breakdown table and the downloadable PDF so the two never drift apart:
// the non-zero electricity charge components for one statement (TOU accounts get Off-peak/Peak/
// Standard, flat-rate accounts get Energy, Demand/Reactive/Service/Network surcharge apply to
// either - combined-mode statements can have several of these non-zero at once).
function electricityLineItems(s) {
  return [
    { label: 'Off-peak', qty: s.elec_off_peak_kwh, unit: 'kWh', rand: s.elec_off_peak_rand },
    { label: 'Peak', qty: s.elec_peak_kwh, unit: 'kWh', rand: s.elec_peak_rand },
    { label: 'Standard', qty: s.elec_standard_kwh, unit: 'kWh', rand: s.elec_standard_rand },
    { label: 'Energy (flat rate)', qty: s.elec_energy_kwh, unit: 'kWh', rand: s.elec_energy_rand },
    { label: 'Demand', qty: s.elec_demand_kva, unit: 'kVA', rand: s.elec_demand_rand },
    { label: 'Reactive energy', qty: s.elec_reactive_kvarh, unit: 'kVArh', rand: s.elec_reactive_rand },
    { label: 'Service charge', qty: null, unit: null, rand: s.elec_service_rand },
    { label: 'Network surcharge', qty: null, unit: null, rand: s.elec_network_surcharge_rand },
  ].filter((l) => Math.abs(l.rand || 0) > 0.005);
}

// Trailing up-to-12-statement Electricity/Water/Sanitation trend (excl. VAT) for one municipal
// account, chronological ascending - feeds the PDF's trend chart, same shape monthlyTrendForTenant
// already produces for the tenant PDF chart ({label, elec, water, sanitation}), just re-derived
// from municipal_statements instead of bill_line_items. label is a synthetic "YYYY-MM" derived
// from statement_date so pdf.js's shortMonthLabel() (built for billing_periods.label) can format it
// the same way.
function monthlyTrendForAccount(db, accountId, asOfStatementDate) {
  const rows = all(db, `
    SELECT statement_for, statement_date, elec_excl_vat, water_excl_vat, sanitation_excl_vat
    FROM municipal_statements
    WHERE municipal_account_id = ? AND (? IS NULL OR statement_date <= ?)
    ORDER BY statement_date DESC LIMIT 12
  `, [accountId, asOfStatementDate || null, asOfStatementDate || null]);
  return rows.reverse().map((r) => ({
    label: r.statement_date ? r.statement_date.slice(0, 7).replace('/', '-') : r.statement_for,
    elec: r.elec_excl_vat || 0, water: r.water_excl_vat || 0, sanitation: r.sanitation_excl_vat || 0,
  }));
}

// Same trend, but summed across every account (for the "All Accounts Combined" PDF) - grouped by
// the synthetic YYYY-MM label so accounts on slightly different statement dates within the same
// month still land in one combined bar.
function monthlyTrendAllAccounts(db, asOfStatementDate) {
  const rows = all(db, `
    SELECT statement_for, statement_date, elec_excl_vat, water_excl_vat, sanitation_excl_vat
    FROM municipal_statements
    WHERE (? IS NULL OR statement_date <= ?)
    ORDER BY statement_date DESC
  `, [asOfStatementDate || null, asOfStatementDate || null]);
  const byLabel = new Map();
  for (const r of rows) {
    const label = r.statement_date ? r.statement_date.slice(0, 7).replace('/', '-') : r.statement_for;
    if (!byLabel.has(label)) byLabel.set(label, { label, elec: 0, water: 0, sanitation: 0 });
    const agg = byLabel.get(label);
    agg.elec += r.elec_excl_vat || 0; agg.water += r.water_excl_vat || 0; agg.sanitation += r.sanitation_excl_vat || 0;
  }
  return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label)).slice(-12);
}

module.exports = {
  SITE_MAP, buildComparison, bestOverlappingPeriod, ourSiteTotals, cojSiteTotals,
  allStatementLabels, buildCombinedStatement, ourAllSitesTotals, buildComparisonAll,
  electricityLineItems, monthlyTrendForAccount, monthlyTrendAllAccounts,
};
