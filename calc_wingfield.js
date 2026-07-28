// calc_wingfield.js - Wingfield Business Park's billing formulas. Deliberately separate from
// calc.js (City Deep's engine): Wingfield's tariff is structurally simpler - a flat monthly basic
// charge, a capacity charge based on the tenant's breaker (Amp) rating, and a single active
// energy rate per kWh (the source workbook already resolves low/high season into one "Active
// Tariff" cell - see extract_wingfield.py's tariff_raw dump, cell B8). No stepped blocks, no
// demand kVA/kVArh charges, no network levy/business surcharge - none of those exist in
// Wingfield's tariff structure, so reusing calc.js would mean carrying dead parameters around.
//
// Same philosophy as calc.js though: independently recompute from raw consumption + tariff
// rates (not a copy of the workbook's own cached numbers), then seed_wingfield.js stores the
// workbook's own totals in excel_reference purely for the /reconciliation report to compare
// against - see README "Wingfield Business Park" section for the one open reconciliation item
// (the "Common area" water block, off by a few thousand Rand most months since Jan 2026).

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

function buildWingfieldTariffParams(tariffRaw) {
  const B = (n) => (tariffRaw[`B${n}`] ? tariffRaw[`B${n}`].B : null);
  return {
    basicCharge: B(3),          // R/month, flat, per meter with a service connection
    capacityRatePerAmp: B(4),   // R per Amp of breaker/capacity rating
    energyRate: B(8),           // R/kWh - the season-resolved "Active Tariff"
    waterRate: B(12),           // R/kL
    sanitationRate: B(13),      // R/kL
  };
}

// One electricity meter row -> line items. `sign` follows the same convention as calc.js: -1 for
// export/credit meters (a small number of sub-meters physically sit on one tenant's DB but are
// billed to a different tenant - see seed_wingfield.js's signAndCharges for how sign is detected).
// `hasBasicCharge` and `breakerAmp` (pass null to suppress the capacity line) mirror the source
// sheet leaving those columns blank on specific rows - confirmed against 13 months of data that
// this is a real, consistent business rule (e.g. the whole "Common Area/Refinery" block never
// carries a capacity charge, only basic + energy) and not a one-off gap - reproduced here rather
// than assumed. The two charges are deliberately independent (not both gated on one flag): a row
// can have a basic charge with no capacity charge, or neither, exactly as the source shows.
function calcElectricityMeterLine({ consumptionKwh, breakerAmp, sign = 1, hasBasicCharge = true, tariff }) {
  const lineItems = [];
  const qty = (consumptionKwh || 0) * sign;

  if (hasBasicCharge && tariff.basicCharge != null) {
    lineItems.push({ category: 'basic_charge', description: 'Basic charge', quantity: null, rate: tariff.basicCharge, amount: round2(tariff.basicCharge * sign) });
  }
  if (breakerAmp && tariff.capacityRatePerAmp != null) {
    const amt = breakerAmp * tariff.capacityRatePerAmp * sign;
    lineItems.push({ category: 'capacity_charge', description: `Capacity charge (${breakerAmp}A breaker)`, quantity: breakerAmp, rate: tariff.capacityRatePerAmp, amount: round2(amt) });
  }
  if (tariff.energyRate != null) {
    const amt = qty * tariff.energyRate;
    lineItems.push({ category: 'energy_charge', description: 'Energy charge', quantity: round2(qty), rate: tariff.energyRate, amount: round2(amt) });
  }
  return { lineItems, total: round2(lineItems.reduce((s, li) => s + li.amount, 0)) };
}

// One water meter row -> line items (water usage + sanitation, both billed on the same kL reading
// - Wingfield has no separate sanitation meter, same as City Deep).
function calcWaterMeterLine({ consumptionKl, tariff }) {
  const lineItems = [];
  const qty = consumptionKl || 0;
  if (tariff.waterRate != null) {
    lineItems.push({ category: 'water_charge', description: 'Water charge', quantity: round2(qty), rate: tariff.waterRate, amount: round2(qty * tariff.waterRate) });
  }
  if (tariff.sanitationRate != null) {
    lineItems.push({ category: 'sanitation_charge', description: 'Sanitation charge', quantity: round2(qty), rate: tariff.sanitationRate, amount: round2(qty * tariff.sanitationRate) });
  }
  return { lineItems, total: round2(lineItems.reduce((s, li) => s + li.amount, 0)) };
}

function sumLineItems(items) { return round2(items.reduce((s, li) => s + li.amount, 0)); }

module.exports = { buildWingfieldTariffParams, calcElectricityMeterLine, calcWaterMeterLine, sumLineItems, round2 };
