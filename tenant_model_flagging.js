// tenant_model_flagging.js - the parts of the Flagging data layer that are genuinely identical for
// EVERY tenant-model property (City Deep, Wingfield, and any future one - see properties.js's
// billingModel: 'tenant'), factored out of city-deep/flagging_data.js (the original, City-Deep-only
// pilot build - see that file's own header comment) once Wingfield needed the same thing. Each
// property's own <property>/flagging_data.js stays responsible for whatever genuinely differs
// between them: which municipal account(s) map to which "our billing" grouping (City Deep: 4
// accounts across 3 Recovery sections; Wingfield: 1 account, the whole site is one section - see
// wingfield/flagging_data.js) and buildAllFlagRows' own assembly of municipalRows/sectionRows/
// tenantRows. Nothing here reaches into recovery_groups.js or any other City-Deep-specific module.
const municipalCompare = require('./municipal_compare');

function get(db, sql, params = []) { return db.prepare(sql).get(...params); }
function all(db, sql, params = []) { return db.prepare(sql).all(...params); }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// "September 2025" -> "2025-09" - municipal_statements.statement_for's own format (see each
// property's seed_municipal.js) - needed so municipal-account series line up with the 'YYYY-MM'
// label format billing_periods already uses, for flagging.js's findSameMonthLastYear and display.
function statementForToLabel(statementFor) {
  const m = /^(\w+)\s+(\d{4})$/.exec((statementFor || '').trim());
  if (!m) return statementFor;
  const idx = MONTHS.indexOf(m[1]);
  if (idx < 0) return statementFor;
  return `${m[2]}-${String(idx + 1).padStart(2, '0')}`;
}

// One municipal account's monthly series for one utility, ascending by statement_date - works for
// any account in any property's db (municipal_accounts/municipal_statements are the same shared
// schema everywhere - see db.js's migrate()). billingDays uses whichever reading-period columns
// exist for that utility (electricity and water are read on genuinely different cycles).
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

// Every tenant's own monthly series, one utility, ascending by billing_period.start_date - covers
// every tenant in the current property's db (no site filter needed: each property's tenants live in
// their own physically separate db file - see properties.js's own header comment on this). Keyed by
// tenant.id (not name) in buildAllFlagRows so a future rename doesn't orphan its review history.
function allTenantSeries(db, utility) {
  const tenants = all(db, 'SELECT * FROM tenants ORDER BY name');
  const periods = all(db, 'SELECT * FROM billing_periods ORDER BY start_date');
  const col = utility === 'water' ? 'water_consumption_m3' : 'electricity_consumption_kwh';
  return tenants.map((t) => {
    const series = periods.map((p) => {
      const row = get(db, `SELECT ${col} AS consumption FROM bills WHERE tenant_id=? AND billing_period_id=?`, [t.id, p.id]);
      if (!row) return null;
      const billingDays = municipalCompare.daysBetween(p.start_date, p.end_date) || 0;
      return { label: p.label, consumption: row.consumption || 0, billingDays };
    }).filter((r) => r && r.billingDays > 0);
    return { tenantId: t.id, tenantName: t.name, unit: t.unit, series };
  }).filter((t) => t.series.length);
}

// This app's own tenant billing, summed across a given list of tenant names for one utility,
// ascending by billing_period.start_date - the generic "our billing" side shared by both a City
// Deep Recovery-section grouping and Wingfield's single whole-site grouping (see
// city-deep/recovery_groups.js's siteSectionSeries-equivalent and wingfield/flagging_data.js's
// wholeSiteSeries, both of which just pass a different tenant-name list into this).
function tenantGroupSeries(db, tenantNames, utility) {
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

// The persisted human review trail for one flag (see db.js's flag_annotations header comment) -
// null if nobody's commented on this account/section/tenant+utility+month yet. Same query shape
// regardless of property, so shared here rather than copied into each property's own data layer.
function getAnnotation(db, entityType, entityKey, utility, periodLabel) {
  return db.prepare('SELECT * FROM flag_annotations WHERE entity_type=? AND entity_key=? AND utility_type=? AND period_label=?')
    .get(entityType, entityKey, utility, periodLabel) || null;
}

module.exports = { statementForToLabel, municipalAccountSeries, allTenantSeries, tenantGroupSeries, getAnnotation };
