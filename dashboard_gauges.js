// dashboard_gauges.js - "Billed to Tenants" vs "Recovered" gauge totals shown on the tenant-model
// Dashboard (City Deep / Wingfield - see properties.js's billingModel), one pair per utility
// (Electricity in kWh, Water in kL), for whichever billing period the dashboard's own period
// selector has picked. Client's own spec (2026-09-21):
//   Billed to tenants (electricity) = Sum of kWh billed to tenants this period - sum of solar credit
//   Recovered (electricity)         = Municipal statement kWh + Solar (Fortress) kWh
//   Billed to tenants (water)       = Sum of kL billed to tenants this period (no solar equivalent)
//   Recovered (water)               = Municipal statement kL
// "Just totals" - no per-tenant or per-section breakdown, no percentage, just the 4 numbers (2 for
// a property with no solar installation, e.g. Wingfield).
//
// Reuses the exact same building blocks the Recovery page already uses (tenant_recovery.js,
// city-deep/recovery_groups.js, solar.js) rather than re-deriving anything, so these totals always
// agree with what the Recovery page itself would show for the same period.
const tenantRecovery = require('./tenant_recovery');
const recoveryGroups = require('./city-deep/recovery_groups');
const solar = require('./solar');

function round1(n) { return Math.round((n || 0) * 10) / 10; }

// City Deep spans 3 municipal accounts/sections (Industrial Park, Rittle, Mini Park - see
// city-deep/recovery_groups.js) - municipal kWh/kL is summed across all 3 for one property-wide
// total. The "billed to tenants" side is passed in already (see below) rather than recomputed here,
// since dashboardData() in server.js already has the simpler property-wide SUM(bills.*) query that
// matches the client's literal "Sum of kWh" wording exactly (no need to reproduce it via the
// per-section tenant-name grouping tenant_recovery.js uses for the Recovery page's own breakdown).
function cityDeepMunicipalTotals(db, period) {
  let elecKwh = 0, waterKl = 0;
  for (const section of recoveryGroups.SECTIONS) {
    const municipal = tenantRecovery.municipalSideFor(db, section.siteNameForMunicipal, period.start_date, period.end_date);
    if (municipal) { elecKwh += municipal.elecKwh; waterKl += municipal.waterKl; }
  }
  return { elecKwh, waterKl };
}

// Sum of solar.js's per-tenant "Solar Used" kWh (see solar.js header comment - how much of that
// tenant's already-billed electricity came from the on-site solar installation rather than the
// municipal grid) across all 7 solar-linked tenant groups, for one billing period. This is the
// "solar credit" the client's formula subtracts from gross billed kWh, and the "Solar (Fortress)"
// figure added to the municipal side - the on-screen Solar Billing Slips report is the only place
// this app already tracks solar kWh (city-deep/solar_cost.js only has Rand invoice totals, no kWh),
// so it's reused here rather than re-extracting kWh from the Fortress invoices by hand.
function solarKwhForPeriod(db, periodId) {
  const slips = solar.getSolarSlips(db, periodId);
  return slips.reduce((s, slip) => s + (slip.total.solarUsed.kwh || 0), 0);
}

// `billedTotals` = { elecKwh, waterKl } already computed by the caller (server.js's dashboardData -
// the plain SUM(bills.electricity_consumption_kwh)/SUM(bills.water_consumption_m3) for the period,
// across every tenant regardless of section). Returns null if there's no current period at all.
function gaugesForProperty(db, propSlug, period, billedTotals) {
  if (!period) return null;
  if (propSlug === 'city-deep') {
    const municipal = cityDeepMunicipalTotals(db, period);
    const solarKwh = solarKwhForPeriod(db, period.id);
    return {
      hasSolar: true,
      elecBilledKwh: round1(billedTotals.elecKwh - solarKwh),
      elecRecoveredKwh: round1(municipal.elecKwh + solarKwh),
      solarKwh: round1(solarKwh),
      waterBilledKl: round1(billedTotals.waterKl),
      waterRecoveredKl: round1(municipal.waterKl),
    };
  }
  if (propSlug === 'wingfield') {
    const municipal = tenantRecovery.municipalSideFor(db, 'Wingfield Business Park', period.start_date, period.end_date);
    return {
      hasSolar: false,
      elecBilledKwh: round1(billedTotals.elecKwh),
      elecRecoveredKwh: round1(municipal ? municipal.elecKwh : 0),
      waterBilledKl: round1(billedTotals.waterKl),
      waterRecoveredKl: round1(municipal ? municipal.waterKl : 0),
    };
  }
  return null; // flat_site properties don't use this dashboard at all (see views.js's nav gate)
}

module.exports = { gaugesForProperty };
