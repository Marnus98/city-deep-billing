// wingfield/flagging_data.js - Wingfield's own data-gathering layer for the Flagging tab, built
// once the pilot on City Deep (see city-deep/flagging_data.js) was approved and extended to every
// property (2026-08-25). Much simpler than City Deep's: Wingfield has exactly one municipal account
// ('Refinery' - see municipal_compare.js's SITE_MAP) and is its own single site/section (no
// Industrial A/B-style split, no recovery_groups.js-style multi-section grouping needed) - so
// "sectionRows" here is always exactly one row per utility: every tenant's billing summed together,
// same total the Recovery page already shows for this property (see tenant_recovery.js).
// Everything reusable (municipal series math, per-tenant series math, annotation lookup) comes from
// ../tenant_model_flagging.js, shared with city-deep/flagging_data.js.
const flagging = require('../flagging');
const tenantModel = require('../tenant_model_flagging');

function all(db, sql, params = []) { return db.prepare(sql).all(...params); }

// Wingfield's single COJ/Ekurhuleni account - see municipal_compare.js's SITE_MAP comment
// ("'Refinery' is Wingfield's own single City of Ekurhuleni account (2210755502)").
const MUNICIPAL_ACCOUNT = { label: 'Refinery', title: 'Refinery (2210755502)' };

// Every tenant's billing summed together, one utility - Wingfield's own equivalent of City Deep's
// per-Recovery-section total, just with every tenant in the one bucket since this property has no
// sub-sections. Built on the same shared tenantGroupSeries used by City Deep's own siteSectionSeries
// (see city-deep/flagging_data.js), just given every tenant's name instead of one section's list.
function wholeSiteSeries(db, utility) {
  const tenantNames = all(db, 'SELECT name FROM tenants').map((r) => r.name);
  return tenantModel.tenantGroupSeries(db, tenantNames, utility);
}

// Top-level entry point, same shape as city-deep/flagging_data.js's buildAllFlagRows - one
// municipal-account row pair, one whole-site "section" row pair, and every tenant classified
// individually (client's own month-vs-previous-month ask, see city-deep/flagging_data.js's own
// header note on this - flagging.js's classify() already checks pctVsPrevious, no engine change
// needed here either).
function buildAllFlagRows(db, settings, propertyName) {
  const municipalRows = [];
  for (const utility of ['electricity', 'water']) {
    const series = tenantModel.municipalAccountSeries(db, MUNICIPAL_ACCOUNT.label, utility);
    if (!series.length) continue;
    const result = flagging.evaluate(series, settings, utility);
    const annotation = tenantModel.getAnnotation(db, 'municipal_account', MUNICIPAL_ACCOUNT.label, utility, result.stats.latest.label);
    municipalRows.push({ entityType: 'municipal_account', entityKey: MUNICIPAL_ACCOUNT.label, title: MUNICIPAL_ACCOUNT.title, utility, series, ...result, annotation });
  }

  const sectionRows = [];
  for (const utility of ['electricity', 'water']) {
    const series = wholeSiteSeries(db, utility);
    if (!series.length) continue;
    const result = flagging.evaluate(series, settings, utility);
    const annotation = tenantModel.getAnnotation(db, 'site_section', 'whole_site', utility, result.stats.latest.label);
    sectionRows.push({ entityType: 'site_section', entityKey: 'whole_site', title: propertyName, utility, series, ...result, annotation, contributingTenants: null });
  }

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

module.exports = { MUNICIPAL_ACCOUNT, wholeSiteSeries, buildAllFlagRows };
