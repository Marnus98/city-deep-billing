// calc.js - the billing calculation engine.
// Reproduces, line for line, the formulas documented in Phase 1 (City_Deep_Workbook_Analysis_Phase1.docx)
// from 'Electrical Billing' and 'Water Billing'. Inputs are plain numbers so this module has
// no dependency on the database and can be unit-tested / reconciled in isolation.
//
// Electricity tariff params shape (tariff_code 1 = flat/demand, 2 = stepped):
//   type 1: { serviceCharge, energyRate, demandKva, demandKvarh, surchargePct }
//   type 2: { serviceCharge, capacityCharge, blocks:[{upTo,rate}...], surchargePct, networkLevy, businessSurchargePct }
// Water params shape:
//   { tier1Limit, tier1Rate, tier2Rate, surchargePct, sanitationRate, sanitationSurchargePct, waterLevyBase }

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// ---- Electricity: one meter-assignment row -> array of bill_line_items ----
function calcElectricityMeterLine({
  rawConsumptionKwh, rawKvarh, rawKva,
  allocationPct, kvarhAllocationPct, kvaAllocationPct,
  tariffCode, serviceChargeFlag, sign,
  carriesNetworkLevy, isCommonArea, energyOnly, capacityChargeOverride,
  tariff1, tariff2, yChargeEnabled
}) {
  // 'energyOnly' reproduces a handful of manually-adjusted rows in the source workbook (e.g. the
  // combined SA Wireless credit line on the Teraoka 6C bill) where the service/capacity/demand/
  // surcharge formulas were hand-overridden to 0, leaving only the energy charge live. This is a
  // genuine one-off manual adjustment in the source data, not a general rule - detected during
  // import (see seed.js) and preserved here as an explicit, visible flag rather than silently
  // guessed at by the formula engine.
  if (energyOnly) { serviceChargeFlag = false; }
  // Energy (kWh), reactive (kVARh) and demand (kVA) can each carry a *different* allocation
  // fraction on the same meter row - e.g. a mini-substation bulk/feeder meter is billed 0% of
  // energy (because each tenant's own sub-meter already bills that) but 100% of demand (because
  // demand can only be measured at the feeder). Treating all three as one shared percentage
  // silently zeroes out demand charges on those rows - confirmed against Unit 3 HUDACO Trading.
  const Q = (rawConsumptionKwh || 0) * allocationPct;                         // billable kWh
  const R = (rawKvarh || 0) * (kvarhAllocationPct != null ? kvarhAllocationPct : allocationPct); // billable kVARh
  const S = (rawKva || 0) * (kvaAllocationPct != null ? kvaAllocationPct : allocationPct);        // billable kVA
  const K = serviceChargeFlag ? 1 : 0;
  const L = sign;
  const items = [];

  let serviceCharge = 0, capacityCharge = 0, energyCharge = 0, demandKva = 0, demandKvarh = 0,
      networkSurcharge = 0, businessSurcharge = 0, networkLevy = 0;

  // Business surcharge (Tariff!B26, 2%) and Network Levy (Tariff!B25) are both applied from a
  // single shared cell regardless of which of the two electricity tariffs the meter is on -
  // confirmed against the source workbook, where AA/AB formulas are identical on T=1 and T=2 rows.
  if (tariffCode === 1) {
    const t = tariff1;
    serviceCharge = t.serviceCharge * K * L;
    energyCharge = Q * t.energyRate * L;
    demandKva = t.demandKva * S * K * L;
    demandKvarh = yChargeEnabled ? (t.demandKvarh * R * K * L) : 0;
    networkSurcharge = t.surchargePct * Q * L;
  } else {
    const t = tariff2;
    serviceCharge = t.serviceCharge * K * L;
    // A handful of tenants carry a fixed capacity charge that doesn't match the standard tariff
    // rate in *any* month, even as the standard rate itself changes - e.g. Unit 4 ATC SA Wireless
    // Infrastructure is charged a flat R661.90/month every single month from July 2025 through
    // June 2026, confirmed against 12 consecutive workbooks. That's a genuine per-tenant
    // negotiated/grandfathered rate baked into the source data, not noise - captured at import
    // time (see seed.js) and applied here instead of the standard rate when present.
    capacityCharge = (capacityChargeOverride != null ? capacityChargeOverride : t.capacityCharge) * K * L;
    energyCharge = stepEnergyCharge(Q, t.blocks) * L;
    networkSurcharge = t.surchargePct * Q * L;
  }
  businessSurcharge = (serviceCharge + capacityCharge + energyCharge + demandKva) * tariff2.businessSurchargePct * L * K;
  if (energyOnly) { networkSurcharge = 0; businessSurcharge = 0; }
  // The common-area allocation row on every tenant block never carries the electrical surcharge
  // in the source workbook (Z is hand-set to 0 there, confirmed on both Industrial Park and Mini
  // Park common-area rows) even though the formula is present and live on every other row.
  if (isCommonArea) { networkSurcharge = 0; }
  if (carriesNetworkLevy) {
    networkLevy = tariff2.networkLevy;
  }

  if (serviceCharge) items.push({ category: 'service_charge', description: isCommonArea ? 'Service charge (common area)' : 'Service charge', quantity: null, rate: null, amount: round2(serviceCharge) });
  if (capacityCharge) items.push({ category: 'capacity_charge', description: 'Capacity charge', quantity: null, rate: null, amount: round2(capacityCharge) });
  items.push({ category: 'energy_charge', description: isCommonArea ? 'Energy charge (common area share)' : 'Energy charge', quantity: round2(Q), rate: null, amount: round2(energyCharge) });
  if (demandKva) items.push({ category: 'demand_kva', description: 'Demand charge (kVA)', quantity: round2(S), rate: null, amount: round2(demandKva) });
  if (demandKvarh) items.push({ category: 'demand_kvarh', description: 'Demand charge (kVARh)', quantity: round2(R), rate: null, amount: round2(demandKvarh) });
  if (networkSurcharge) items.push({ category: 'network_surcharge', description: 'Electrical surcharge', quantity: null, rate: null, amount: round2(networkSurcharge) });
  if (businessSurcharge) items.push({ category: 'business_surcharge', description: 'Business surcharge', quantity: null, rate: null, amount: round2(businessSurcharge) });
  if (networkLevy) items.push({ category: 'network_levy', description: 'Network levy', quantity: null, rate: null, amount: round2(networkLevy) });

  return { lineItems: items, billableKwh: Q, billableKvarh: R, billableKva: S };
}

function stepEnergyCharge(q, blocks) {
  // blocks: [{upTo:500, rate:...}, {upTo:1000, rate:...}, {upTo:2000, rate:...}, {upTo:3000, rate:...}, {upTo:Infinity, rate:...}]
  let remaining = q, prevCap = 0, total = 0;
  for (const b of blocks) {
    if (remaining <= 0) break;
    const span = Math.min(remaining, b.upTo - prevCap);
    if (span > 0) { total += span * b.rate; remaining -= span; }
    prevCap = b.upTo;
  }
  return total;
}

// ---- Water: one meter-assignment row -> array of bill_line_items ----
function calcWaterMeterLine({ rawConsumptionM3, allocationPct, waterTariff, isCommonArea }) {
  const K = (rawConsumptionM3 || 0) * allocationPct; // billable m3
  const t = waterTariff;
  const waterCharge = K <= t.tier1Limit ? K * t.tier1Rate : (t.tier1Limit * t.tier1Rate) + (K - t.tier1Limit) * t.tier2Rate;
  const waterSurcharge = waterCharge * t.surchargePct;
  const sanitation = K * t.sanitationRate;
  const sanitationSurcharge = sanitation * t.sanitationSurchargePct;
  const waterLevy = isCommonArea ? 0 : 0; // placeholder; common-area water levy applied separately per tenant (see engine.js)

  const items = [];
  items.push({ category: 'water_charge', description: 'Water charge', quantity: round2(K), rate: null, amount: round2(waterCharge) });
  if (waterSurcharge) items.push({ category: 'water_surcharge', description: 'Water surcharge', quantity: null, rate: null, amount: round2(waterSurcharge) });
  if (sanitation) items.push({ category: 'sanitation', description: 'Sanitation charge', quantity: null, rate: null, amount: round2(sanitation) });
  if (sanitationSurcharge) items.push({ category: 'sanitation_surcharge', description: 'Sanitation surcharge', quantity: null, rate: null, amount: round2(sanitationSurcharge) });

  return { lineItems: items, billableM3: K };
}

function waterLevyAmount(commonAreaPct, waterLevyBase) {
  // Reproduces Water Billing column P: 322.97 * %CommonArea * 2 (see Phase 1 Finding, Section 6.2/10).
  if (!commonAreaPct) return 0;
  return round2(waterLevyBase * commonAreaPct * 2);
}

function sumLineItems(items) {
  return round2(items.reduce((s, i) => s + i.amount, 0));
}

module.exports = { calcElectricityMeterLine, calcWaterMeterLine, waterLevyAmount, sumLineItems, round2, stepEnergyCharge };
