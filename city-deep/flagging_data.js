// city-deep/flagging_data.js - City Deep's own data-gathering layer for the Flagging tab (see
// flagging.js for the generic statistics engine this feeds, and recovery_groups.js/
// municipal_compare.js for the grouping/date-matching conventions reused here). Three entity types,
// matching spec sections 6/7:
//   - Municipal accounts: the 4 real COJ bulk accounts (Rittle/Mini/Industrial A/Industrial B),
//     each evaluated independently (NOT summed the way tenant_recovery.js's Industrial section
//     sums A+B - the spec wants each physical account flagged on its own, since an anomaly on just
//     one of the two Industrial accounts would otherwise wash out in a combined total).
//   - Site sections: the 3 Recovery groupings (industrial/mini/rittle - see recovery_groups.js),
//     i.e. this app's own tenant billing summed the same way the Recovery page already does.
//   - Tenants: per-tenant consumption within a section, for the "possible contributing meters"
//     drill-down (spec section 7) under an amber/red site-section flag.
const municipalCompare = require('../municipal_compare');
const recoveryGroups = require('./recovery_groups');
const flagging = require('../flagging');

function get(db, sql, params = []) { return db.prepare(sql).get(...params); }
function all(db, sql, params = []) { return db.prepare(sql).all(...params); }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// "September 2025" -> "2025-09" - municipal_statements.statement_for's own format (see
// seed_municipal.js) - needed so municipal-account series line up with the 'YYYY-MM' label format
// billing_periods already uses, for flagging.js's findSameMonthLastYear and general display.
function statementForToLabel(statementFor) {
  const m = /^(\w+)\s+(\d{4})$/.exec((statementFor || '').trim());
  if (!m) return statementFor;
  const idx = MONTHS.indexOf(m[1]);
  if (idx < 0) return statementFor;
  return `${m[2]}-${String(idx + 1).padStart(2, '0')}`;
}

// One municipal account's monthly series for one utility, ascending by statement_date. billingDays
// uses whichever reading-period columns exist for that utility (electricity and water are read on
// genuinely different cycles - see municipal_compare.js's own header comment on this).
function municipalAccountSeries(db, accountLabel, utility) {
  const acc = get(db, 'SELECT * FROM municipal_accounts WHERE label=?', [accountLabel]);
  if (!acc) return [];
  const rows = all(db, 'SELECT * FROM municipal_statements WHERE municipal_account_id=? ORDER BY statement_date', [acc.id]);
  return rows.map((r) => {
    const start = utility === 'water' ? r.water_reading_start : r.elec_reading_start;
    const end = utility === 'water' ? r.water_reading_end : r.elec_reading_end;
    const consumption = utility === 'water' ? (r.water_consumption_kl || 0) : (r.elec_consumption_kwh || 0);
    const billingDays = municipalCompare.daysBetween(start, end) || 0;
    return { label: statementForToLabel(r.statement_for), consumption, billingDays, startDate: start, endDate: end };
  }).filter((r) => r.billingDays > 0);
}

// This app's own tenant billing, summed for one Recovery section, one utility, ascending by
// billing_period.start_date. Mirrors tenant_recovery.js's siteSideForTenants but only pulls the one
// utility's consumption + the period's own dates (flagging doesn't need the Rand side at all).
function siteSectionSeries(db, sectionKey, utility) {
  const tenantNames = recoveryGroups.tenantNamesForSection(db, sectionKey);
  if (!tenantNames.length) return [];
  const periods = all(db, 'SELECT * FROM billing_periods ORDER BY start_date');
  const placeholders = tenantNames.map(() => '?').join(',');
  const col = utility === 'water' ? 'b.water_consumption_m3' : 'b.electricity_consumption_kwh';
  return periods.map((p) => {
    const row = get(db, `
      SELECT COALESCE(SUM(${col}),0) AS consumption, COUNT(DISTINCT b.tenant_id) AS tenant_count
      FROM bills b JOIN tenants t ON t.id = b.tenant_id
      WHERE t.name IN (${placeholders}) AND b.billing_period_id = ?
    `, [...tenantNames, p.id]);
    if (!row.tenant_count) return null;
    const billingDays = municipalCompare.daysBetween(p.start_date, p.end_date) || 0;
    return { label: p.label, consumption: row.consumption, billingDays, startDate: p.start_date, endDate: p.end_date };
  }).filter((r) => r && r.billingDays > 0);
}

// Per-tenant series within a section, one utility, ascending by billing_period.start_date - used
// only for the "possible contributing meters" drill-down table under a flagged section (spec
// section 7), not run through the full flagging.js classifier (no green/amber/red needed there,
// just latest vs a simple trailing average).
function tenantSeriesInSection(db, sectionKey, utility) {
  const tenantNames = recoveryGroups.tenantNamesForSection(db, sectionKey);
  const col = utility === 'water' ? 'b.water_consumption_m3' : 'b.electricity_consumption_kwh';
  const periods = all(db, 'SELECT * FROM billing_periods ORDER BY start_date');
  const byTenant = {};
  for (const name of tenantNames) {
    const tenant = get(db, 'SELECT * FROM tenants WHERE name=?', [name]);
    if (!tenant) continue;
    const series = periods.map((p) => {
      const row = get(db, `SELECT ${col} AS consumption FROM bills b WHERE b.tenant_id=? AND b.billing_period_id=?`, [tenant.id, p.id]);
      if (!row) return null;
      const billingDays = municipalCompare.daysBetween(p.start_date, p.end_date) || 0;
      return { label: p.label, consumption: row.consumption || 0, billingDays };
    }).filter((r) => r && r.billingDays > 0);
    if (series.length) byTenant[name] = series;
  }
  return byTenant;
}

// The 4 real COJ accounts at City Deep, in display order - separate from recovery_groups.js's 3
// Recovery sections (Industrial A/B are one Recovery section but two physical accounts here).
const MUNICIPAL_ACCOUNTS = [
  { label: 'Industrial A', title: 'Industrial A (559304053)' },
  { label: 'Industrial B', title: 'Industrial B (559304060)' },
  { label: 'Mini', title: 'Mini (559304078)' },
  { label: 'Rittle', title: 'Rittle (559304085)' },
];

// The persisted human review trail for one flag (see db.js's flag_annotations header comment) -
// null if nobody's commented on this account/section+utility+month yet.
function getAnnotation(db, entityType, entityKey, utility, periodLabel) {
  return db.prepare('SELECT * FROM flag_annotations WHERE entity_type=? AND entity_key=? AND utility_type=? AND period_label=?')
    .get(entityType, entityKey, utility, periodLabel) || null;
}

// "Possible contributing meters" (spec section 7) - every tenant in `sectionKey` with at least one
// prior month of history, sorted by |variance| descending so the most likely explanation for a
// site-level flag surfaces first. Deliberately NOT run through flagging.js's full classifier (no
// green/amber/red needed at tenant level, just latest-vs-recent-average) since this is explanatory
// context under an already-flagged section, not a flag in its own right.
function buildContributingTenants(db, sectionKey, utility, latestLabel) {
  const byTenant = tenantSeriesInSection(db, sectionKey, utility);
  const rows = [];
  for (const [name, series] of Object.entries(byTenant)) {
    const idx = series.findIndex((s) => s.label === latestLabel);
    if (idx < 1) continue; // need at least one prior month to compare against
    const latest = series[idx];
    const prior = series.slice(0, idx).slice(-6);
    if (!prior.length) continue;
    const avg = prior.reduce((s, r) => s + r.consumption, 0) / prior.length;
    const variance = avg > 0 ? ((latest.consumption - avg) / avg) * 100 : null;
    rows.push({ name, latest: latest.consumption, avg, variance });
  }
  rows.sort((a, b) => Math.abs(b.variance || 0) - Math.abs(a.variance || 0));
  return rows;
}

// Top-level entry point for both the on-screen Flagging page and the PDF export - one pass over
// every municipal account and every Recovery section, each utility, evaluated against `settings`
// (see flagging.js's getSettings). A row is only included if it has at least one real month of
// data (a brand-new account/section with nothing billed yet is simply absent, not shown as green).
function buildAllFlagRows(db, settings) {
  const municipalRows = [];
  for (const acc of MUNICIPAL_ACCOUNTS) {
    for (const utility of ['electricity', 'water']) {
      const series = municipalAccountSeries(db, acc.label, utility);
      if (!series.length) continue;
      const result = flagging.evaluate(series, settings, utility);
      const annotation = getAnnotation(db, 'municipal_account', acc.label, utility, result.stats.latest.label);
      municipalRows.push({ entityType: 'municipal_account', entityKey: acc.label, title: acc.title, utility, ...result, annotation });
    }
  }
  const sectionRows = [];
  for (const sec of recoveryGroups.SECTIONS) {
    for (const utility of ['electricity', 'water']) {
      const series = siteSectionSeries(db, sec.key, utility);
      if (!series.length) continue;
      const result = flagging.evaluate(series, settings, utility);
      const annotation = getAnnotation(db, 'site_section', sec.key, utility, result.stats.latest.label);
      const contributingTenants = result.level !== 'green' ? buildContributingTenants(db, sec.key, utility, result.stats.latest.label) : null;
      sectionRows.push({ entityType: 'site_section', entityKey: sec.key, title: sec.title, utility, ...result, annotation, contributingTenants });
    }
  }
  return { municipalRows, sectionRows };
}

module.exports = {
  statementForToLabel, municipalAccountSeries, siteSectionSeries, tenantSeriesInSection, MUNICIPAL_ACCOUNTS,
  getAnnotation, buildContributingTenants, buildAllFlagRows,
};
