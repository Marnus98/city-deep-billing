// dashboard_gauges.js - "Billed to Tenants vs Recovered" gauge totals shown on every property's own
// Dashboard (2026-09-21 client asks: one dashboard per site, a period selector that offers every
// individual month AND a "Year to Date" option per year, the existing kWh/kL gauges, and a new Rand
// gauge with a net over/under recovery figure below it).
//
// Works for BOTH billing models (see properties.js):
//   'tenant'    - City Deep (3 municipal accounts/sections - see city-deep/recovery_groups.js - plus
//                 a real solar installation) and Wingfield (1 section, no solar).
//   'flat_site' - every other property (8 Field Street, Bob Martin, Loper Road, AutoZone, Cranbrook
//                 Flavours, and the 5 Loper Ave sites) - whole-site billing, no tenants, no solar.
// Reuses the exact same building blocks the Recovery page already uses (tenant_recovery.js,
// flat_site_recovery.js, city-deep/recovery_groups.js, city-deep/solar_cost.js, solar.js) so these
// totals always agree with what the Recovery page itself would show for the same period(s).
//
// Client's formulas (2026-09-21 and 2026-09-28):
//   Electricity billed  = Sum of kWh billed to tenants - sum of solar credit kWh
//   Electricity recovered = Municipal kWh + Solar kWh (from the Solar Billing Slips report - see
//     the note below on why kWh comes from there and not city-deep/solar_cost.js)
//   Water billed/recovered = same idea, no solar involved
//   Rand billed  = tenant billing (elec+water+sewer, excl VAT) for the period(s)
//   Rand recovered = municipal statement cost (excl VAT) + the real solar invoice cost (Rand, from
//     city-deep/solar_cost.js - the ACTUAL Capital Propfund invoice amount, unlike the kWh gauge
//     above which has no real "Rand-metered" kWh source and so reuses the Solar Billing Slips
//     report's kWh instead)
//   Net over/under recovery = Rand billed - Rand recovered (shown as its own line under the Rand
//     gauge - positive = over-recovered, negative = under-recovered, same sign convention every
//     other Recovery view in this app already uses)
// "Just totals" (2026-09-21) - no percentages, the gauge bars are only a visual comparison aid.
const tenantRecovery = require('./tenant_recovery');
const recoveryGroups = require('./city-deep/recovery_groups');
const solar = require('./solar');
const solarCost = require('./city-deep/solar_cost');
const flatSiteRecovery = require('./flat_site_recovery');

function get(db, sql, params = []) { return db.prepare(sql).get(...params); }
function all(db, sql, params = []) { return db.prepare(sql).all(...params); }
function round1(n) { return Math.round((n || 0) * 10) / 10; }
function round2(n) { return Math.round(((n || 0) + Number.EPSILON) * 100) / 100; }

// ---------------- period/label discovery (drives the dropdown) ----------------
// Every distinct 'YYYY-MM' label this property has ANY data for - billing_periods for a tenant-model
// property, the union of site_billing_slips/municipal_statement_slips labels for flat_site (see
// flat_site_recovery.js's own allLabels, reused directly there).
function allLabelsForProperty(db, billingModel) {
  if (billingModel === 'tenant') return all(db, 'SELECT DISTINCT label FROM billing_periods').map((r) => r.label).sort();
  return flatSiteRecovery.allLabels(db);
}

// Dropdown options for the gauge period selector: newest year first, a "<year> - Year to Date" entry
// leading each year's own group, then that year's months newest-first. `selected` (optional) marks
// which option's `value` should render pre-selected.
function periodOptionsForProperty(db, billingModel) {
  const labels = allLabelsForProperty(db, billingModel);
  const years = [...new Set(labels.map((l) => l.slice(0, 4)))].sort().reverse();
  const options = [];
  for (const year of years) {
    options.push({ value: `ytd:${year}`, text: `${year} - Year to Date` });
    const monthsThisYear = labels.filter((l) => l.startsWith(year)).sort().reverse();
    for (const m of monthsThisYear) options.push({ value: m, text: m });
  }
  return options;
}

// The single most recent month label - used as the default selector on first page load (before the
// client has picked anything from the dropdown), same "defaults to latest" convention the rest of
// this app's period pickers already use.
function latestLabel(db, billingModel) {
  const labels = allLabelsForProperty(db, billingModel);
  return labels.length ? labels[labels.length - 1] : null;
}

// ---------------- per-billing-model totals, accumulated across 1+ periods/labels ----------------
function emptyTotals(hasSolar) {
  return {
    hasSolar,
    elecBilledKwh: 0, elecRecoveredKwh: 0, solarKwh: 0,
    waterBilledKl: 0, waterRecoveredKl: 0,
    billedRand: 0, recoveredRand: 0, solarCostRand: 0,
  };
}

function cityDeepTotalsForPeriods(db, periods) {
  let billedElecKwh = 0, billedWaterKl = 0, municElecKwh = 0, municWaterKl = 0;
  let billedRand = 0, municipalRand = 0, solarCostRand = 0, solarKwh = 0;
  for (const period of periods) {
    for (const section of recoveryGroups.SECTIONS) {
      const tenantNames = recoveryGroups.tenantNamesForSection(db, section.key);
      const site = tenantNames.length ? tenantRecovery.siteSideForTenants(db, tenantNames, period.id) : null;
      const municipal = tenantRecovery.municipalSideFor(db, section.siteNameForMunicipal, period.start_date, period.end_date);
      if (site) { billedElecKwh += site.elecKwh; billedWaterKl += site.waterKl; billedRand += site.elecRand + site.waterRand + site.sewerRand; }
      if (municipal) { municElecKwh += municipal.elecKwh; municWaterKl += municipal.waterKl; municipalRand += municipal.elecRand + municipal.waterRand + municipal.sewerRand; }
      solarCostRand += solarCost.solarCostForSection(db, section.key)(period.label);
    }
    const slips = solar.getSolarSlips(db, period.id);
    solarKwh += slips.reduce((s, slip) => s + (slip.total.solarUsed.kwh || 0), 0);
  }
  return {
    hasSolar: true,
    elecBilledKwh: round1(billedElecKwh - solarKwh), elecRecoveredKwh: round1(municElecKwh + solarKwh), solarKwh: round1(solarKwh),
    waterBilledKl: round1(billedWaterKl), waterRecoveredKl: round1(municWaterKl),
    billedRand: round2(billedRand), recoveredRand: round2(municipalRand + solarCostRand), solarCostRand: round2(solarCostRand),
  };
}

function wingfieldTotalsForPeriods(db, periods) {
  let billedElecKwh = 0, billedWaterKl = 0, municElecKwh = 0, municWaterKl = 0, billedRand = 0, municipalRand = 0;
  for (const period of periods) {
    const site = tenantRecovery.siteSideFor(db, 'Wingfield Business Park', period.id);
    const municipal = tenantRecovery.municipalSideFor(db, 'Wingfield Business Park', period.start_date, period.end_date);
    if (site) { billedElecKwh += site.elecKwh; billedWaterKl += site.waterKl; billedRand += site.elecRand + site.waterRand + site.sewerRand; }
    if (municipal) { municElecKwh += municipal.elecKwh; municWaterKl += municipal.waterKl; municipalRand += municipal.elecRand + municipal.waterRand + municipal.sewerRand; }
  }
  return {
    hasSolar: false,
    elecBilledKwh: round1(billedElecKwh), elecRecoveredKwh: round1(municElecKwh), solarKwh: 0,
    waterBilledKl: round1(billedWaterKl), waterRecoveredKl: round1(municWaterKl),
    billedRand: round2(billedRand), recoveredRand: round2(municipalRand), solarCostRand: 0,
  };
}

function flatSiteTotalsForLabels(db, labels) {
  let billedElecKwh = 0, billedWaterKl = 0, municElecKwh = 0, municWaterKl = 0, billedRand = 0, municipalRand = 0;
  for (const label of labels) {
    const site = flatSiteRecovery.siteSideFor(db, label);
    const municipal = flatSiteRecovery.municipalSideFor(db, label);
    if (site) { billedElecKwh += site.elecKwh; billedWaterKl += site.waterKl; billedRand += site.elecRand + site.waterRand + site.sewerRand; }
    if (municipal) { municElecKwh += municipal.elecKwh; municWaterKl += municipal.waterKl; municipalRand += municipal.elecRand + municipal.waterRand + municipal.sewerRand; }
  }
  return {
    hasSolar: false,
    elecBilledKwh: round1(billedElecKwh), elecRecoveredKwh: round1(municElecKwh), solarKwh: 0,
    waterBilledKl: round1(billedWaterKl), waterRecoveredKl: round1(municWaterKl),
    billedRand: round2(billedRand), recoveredRand: round2(municipalRand), solarCostRand: 0,
  };
}

// `selector` is either a plain 'YYYY-MM' label or 'ytd:YYYY' (every label starting with that year).
// Returns null only if the property/db is unknown; an unmatched single label or an empty YTD year
// still returns a valid (all-zero) totals object, same "flag a genuine gap, don't hide it" style
// null-vs-zero distinction used everywhere else, kept simple here since the gauge cards already show
// R0/0 plainly rather than needing a separate "no data" state.
function gaugesForSelector(propertyDbs, propSlug, billingModel, selector) {
  const db = propertyDbs.get(propSlug);
  if (!db || !selector) return null;
  const isYtd = selector.startsWith('ytd:');
  const year = isYtd ? selector.slice(4) : null;

  if (billingModel === 'tenant') {
    const periods = isYtd
      ? all(db, 'SELECT * FROM billing_periods WHERE label LIKE ? ORDER BY label', [`${year}-%`])
      : (() => { const p = get(db, 'SELECT * FROM billing_periods WHERE label=?', [selector]); return p ? [p] : []; })();
    if (propSlug === 'city-deep') return { ...cityDeepTotalsForPeriods(db, periods), selector };
    if (propSlug === 'wingfield') return { ...wingfieldTotalsForPeriods(db, periods), selector };
    return { ...emptyTotals(false), selector };
  }

  // flat_site
  const labels = isYtd ? flatSiteRecovery.allLabels(db).filter((l) => l.startsWith(year)) : [selector];
  return { ...flatSiteTotalsForLabels(db, labels), selector };
}

module.exports = { periodOptionsForProperty, latestLabel, gaugesForSelector };
