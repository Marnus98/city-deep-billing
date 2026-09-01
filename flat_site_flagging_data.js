// flat_site_flagging_data.js - shared Flagging data layer for every flat_site property (8 Field
// Street, Bob Martin, Loper Road, AutoZone, Cranbrook Flavours, ADH Machine Tool, Zelvio Global,
// Interoll, RCL Group, Colorobbia - see properties.js's billingModel: 'flat_site'). One module for
// all of them since they're structurally identical (site_tariffs/site_billing_slips +, where
// hasMunicipalStatements is set, municipal_tariffs/municipal_statement_slips - see db.js's shared
// migrate() and flat_site_recovery.js's own header comment on this schema).
//
// A flat_site property has no tenants and no sub-sections at all - the whole property is one billed
// entity - so unlike city-deep/flagging_data.js or wingfield/flagging_data.js there is never a
// tenantRows bucket here (always an empty array). Just two entities, each evaluated per utility:
//   - municipalRows: the real municipal statement's own consumption (municipal_statement_slips via
//     flat_site_recovery.js's municipalSideFor) - only populated when the property actually has
//     municipal statements imported (properties.js's hasMunicipalStatements flag; the underlying
//     table exists in every property's db regardless, per db.js's shared schema, it's just empty
//     for the 4 properties with no municipal_import.js yet).
//   - sectionRows: HolmStone's own client billing (site_billing_slips via siteSideFor) - always
//     populated, this is what get invoiced to the tenant every month regardless of whether a
//     municipal statement exists to compare against.
// Sewer is deliberately not flagged separately - flagging.js's classify() only knows 'electricity'/
// 'water' (see db.js's flag_annotations utility_type CHECK), and sewer consumption tracks water 1:1
// at every flat_site property (same meter reading feeds both) so a water flag already covers it.
const municipalCompare = require('./municipal_compare');
const flatSiteRecovery = require('./flat_site_recovery');
const flagging = require('./flagging');

function all(db, sql, params = []) { return db.prepare(sql).all(...params); }

// One side's (site or municipal) monthly series for one utility, ascending by label - `sideFor` is
// flat_site_recovery.js's siteSideFor or municipalSideFor, `labelsSql` picks which table's own
// labels to iterate (a label with no row on this side is simply skipped, same "absent rather than
// silently zero" convention buildRecoveryRows already uses).
function seriesFor(db, table, sideFor, utility) {
  const labels = all(db, `SELECT DISTINCT label FROM ${table} ORDER BY label`).map((r) => r.label);
  return labels.map((label) => {
    const f = sideFor(db, label);
    if (!f) return null;
    const consumption = utility === 'water' ? f.waterKl : f.elecKwh;
    // Municipal water sometimes has its own reading dates (waterStartDate/waterEndDate); the site
    // side never does (client billing runs water on the same calendar cycle as electricity) - see
    // flat_site_recovery.js's figuresFromCalc header comment on this split.
    const start = (utility === 'water' && f.waterStartDate) ? f.waterStartDate : f.startDate;
    const end = (utility === 'water' && f.waterEndDate) ? f.waterEndDate : f.endDate;
    const billingDays = municipalCompare.daysBetween(start, end) || 0;
    return { label, consumption, billingDays, startDate: start, endDate: end };
  }).filter((r) => r && r.billingDays > 0);
}

const getAnnotation = (db, entityType, entityKey, utility, periodLabel) => db.prepare(
  'SELECT * FROM flag_annotations WHERE entity_type=? AND entity_key=? AND utility_type=? AND period_label=?',
).get(entityType, entityKey, utility, periodLabel) || null;

// See city-deep/flagging_data.js's own currentPeriodLabel() for what this is and why - here the
// always-current source is client billing (site_billing_slips), since a flat_site property has no
// tenants/billing_periods table at all.
function currentPeriodLabel(db) {
  const row = db.prepare('SELECT label FROM site_billing_slips ORDER BY label DESC LIMIT 1').get();
  return row ? row.label : null;
}

// Top-level entry point, same { municipalRows, sectionRows, tenantRows } shape as the tenant-model
// properties' own buildAllFlagRows, so server.js/views.js/pdf.js need zero property-type branching
// beyond picking which module to call (see server.js's currentPropFlagRows).
function buildAllFlagRows(db, settings, propertyName, hasMunicipalStatements) {
  const municipalRows = [];
  if (hasMunicipalStatements) {
    const cpLabel = currentPeriodLabel(db);
    for (const utility of ['electricity', 'water']) {
      const series = seriesFor(db, 'municipal_statement_slips', flatSiteRecovery.municipalSideFor, utility);
      if (!series.length) {
        municipalRows.push(flagging.noDataRow({ entityType: 'municipal_account', entityKey: 'municipal', title: `${propertyName} (Municipal)`, utility }, cpLabel));
        continue;
      }
      const result = flagging.evaluate(series, settings, utility);
      const annotation = getAnnotation(db, 'municipal_account', 'municipal', utility, result.stats.latest.label);
      const noCurrentData = !!cpLabel && result.stats.latest.label !== cpLabel;
      // `series` carried through on the row (not just fed into evaluate() above) so a chart-based
      // view (see views.js's trendChartCard) can plot the full monthly history, not just the single
      // latest-vs-baseline figure classify() itself returns.
      municipalRows.push({ entityType: 'municipal_account', entityKey: 'municipal', title: `${propertyName} (Municipal)`, utility, series, ...result, annotation, noCurrentData, currentPeriodLabel: cpLabel });
    }
  }

  const sectionRows = [];
  for (const utility of ['electricity', 'water']) {
    const series = seriesFor(db, 'site_billing_slips', flatSiteRecovery.siteSideFor, utility);
    if (!series.length) continue;
    const result = flagging.evaluate(series, settings, utility);
    const annotation = getAnnotation(db, 'site_section', 'site', utility, result.stats.latest.label);
    sectionRows.push({ entityType: 'site_section', entityKey: 'site', title: `${propertyName} (Client Billing)`, utility, series, ...result, annotation, contributingTenants: null });
  }

  return { municipalRows, sectionRows, tenantRows: [] };
}

module.exports = { buildAllFlagRows };
