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
//   - Tenants: every tenant property-wide, run through the full classifier (see
//     tenant_model_flagging.js's allTenantSeries) - plus a per-section "possible contributing
//     meters" drill-down (spec section 7) under an amber/red site-section flag.
//
// The genuinely City-Deep-specific parts are just: which 4 municipal accounts exist, and how
// recovery_groups.js's 3 sections map to tenant-name lists. Everything else (municipal series math,
// tenant series math, annotation lookup) is shared with any other tenant-model property - see
// ../tenant_model_flagging.js, factored out once Wingfield needed the same thing (2026-08-25).
const recoveryGroups = require('./recovery_groups');
const flagging = require('../flagging');
const tenantModel = require('../tenant_model_flagging');
const municipalCompare = require('../municipal_compare');

function get(db, sql, params = []) { return db.prepare(sql).get(...params); }
function all(db, sql, params = []) { return db.prepare(sql).all(...params); }

// This app's own tenant billing, summed for one Recovery section, one utility - thin wrapper around
// tenant_model_flagging.js's generic tenantGroupSeries, just resolving the section key to its own
// tenant-name list first (see recovery_groups.js).
function siteSectionSeries(db, sectionKey, utility) {
  return tenantModel.tenantGroupSeries(db, recoveryGroups.tenantNamesForSection(db, sectionKey), utility);
}

// Per-tenant series within a section, one utility, ascending by billing_period.start_date - used
// only for the "possible contributing meters" drill-down table under a flagged section (spec
// section 7), not run through the full flagging.js classifier (no green/amber/red needed there,
// just latest vs a simple trailing average). Distinct from tenant_model_flagging.js's
// allTenantSeries (property-wide, keyed by id, always classified) - this one is scoped to a single
// section and keyed by name purely for this drill-down's own display purposes.
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

// The property's own "current period" - the latest billing_period that actually has tenant bills
// generated for it (always created every month regardless of whether a municipal statement has
// arrived yet - see seed.js's generateBill). This is what a municipal account's own latest label
// gets compared against below to decide whether it's showing this month's real figures or a stale
// prior month (see flagging.js's header comment on this feature).
function currentPeriodLabel(db) {
  const row = get(db, 'SELECT label FROM billing_periods ORDER BY start_date DESC LIMIT 1');
  return row ? row.label : null;
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
// every municipal account, every Recovery section, and every tenant, each utility, evaluated
// against `settings` (see flagging.js's getSettings). A row is only included if it has at least one
// real month of data (a brand-new account/section with nothing billed yet is simply absent, not
// shown as green).
function buildAllFlagRows(db, settings) {
  const cpLabel = currentPeriodLabel(db);
  const municipalRows = [];
  for (const acc of MUNICIPAL_ACCOUNTS) {
    for (const utility of ['electricity', 'water']) {
      const series = tenantModel.municipalAccountSeries(db, acc.label, utility);
      if (!series.length) {
        municipalRows.push(flagging.noDataRow({ entityType: 'municipal_account', entityKey: acc.label, title: acc.title, utility }, cpLabel));
        continue;
      }
      const result = flagging.evaluate(series, settings, utility);
      const annotation = tenantModel.getAnnotation(db, 'municipal_account', acc.label, utility, result.stats.latest.label);
      const noCurrentData = !!cpLabel && result.stats.latest.label !== cpLabel;
      municipalRows.push({ entityType: 'municipal_account', entityKey: acc.label, title: acc.title, utility, series, ...result, annotation, noCurrentData, currentPeriodLabel: cpLabel });
    }
  }
  const sectionRows = [];
  for (const sec of recoveryGroups.SECTIONS) {
    for (const utility of ['electricity', 'water']) {
      const series = siteSectionSeries(db, sec.key, utility);
      if (!series.length) continue;
      const result = flagging.evaluate(series, settings, utility);
      const annotation = tenantModel.getAnnotation(db, 'site_section', sec.key, utility, result.stats.latest.label);
      const contributingTenants = result.level !== 'green' ? buildContributingTenants(db, sec.key, utility, result.stats.latest.label) : null;
      sectionRows.push({ entityType: 'site_section', entityKey: sec.key, title: sec.title, utility, series, ...result, annotation, contributingTenants });
    }
  }
  // Every tenant, property-wide, both utilities - a real flag per tenant (not just the passive
  // contributing-tenants drill-down above), specifically covering month-vs-previous-month per the
  // client's own framing (flagging.js's classify() already checks pctVsPrevious against
  // mom_amber_pct/mom_red_pct alongside the baseline check - no engine change needed, just surfacing
  // it here as a first-class row). entityType 'tenant' matches db.js's flag_annotations comment.
  const tenantRows = [];
  for (const utility of ['electricity', 'water']) {
    for (const t of tenantModel.allTenantSeries(db, utility)) {
      const result = flagging.evaluate(t.series, settings, utility);
      const annotation = tenantModel.getAnnotation(db, 'tenant', String(t.tenantId), utility, result.stats.latest.label);
      const title = t.unit ? `${t.tenantName} (${t.unit})` : t.tenantName;
      tenantRows.push({ entityType: 'tenant', entityKey: String(t.tenantId), title, utility, series: t.series, ...result, annotation });
    }
  }
  return { municipalRows, sectionRows, tenantRows };
}

module.exports = {
  siteSectionSeries, tenantSeriesInSection, MUNICIPAL_ACCOUNTS,
  buildContributingTenants, buildAllFlagRows,
};
