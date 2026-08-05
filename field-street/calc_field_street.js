// field-street/calc_field_street.js - the "flat single-site" billing calculation for 8 Field
// Street (see properties.js's billingModel: 'flat_site', and db.js's site_tariffs/
// site_billing_slips). Unlike calc.js (City Deep) or wingfield/calc_wingfield.js, there's no
// per-tenant meter allocation here at all - the whole site is billed as one fixed set of line
// items every month, always in the same order:
//
//   Fixed Charge, Network Access, Network Demand,
//   Peak Energy (High Demand), Peak Energy (Low Demand),
//   Standard Energy (High Demand), Standard Energy (Low Demand),
//   Off-Peak Energy (High Demand), Off-Peak Energy (Low Demand),
//   Water Consumption, Sewer
//
// - matching the reference statement the client provided (Ekurhuleni TOU tariff,
// "8 Field Street Main Electrical").
//
// Correction factor: the site's own installed meters read measurably lower than the
// municipality's own check meter, confirmed by the client. Readings are captured exactly as read
// off the site's own meter dial - the factor (kva_factor/peak_factor/standard_factor/
// offpeak_factor on the site_tariffs row) grosses that reading up to true consumption *only for
// the cost calculation*; the reading shown on the slip is always the raw, as-read figure, so
// there's a clear paper trail from "what we physically read" to "what we billed for". No factor
// applies to Fixed Charge (a flat monthly charge, not a metered quantity) or Water/Sewer (the
// client didn't ask for a correction there - only the electrical meters are known to under-read).
function round2(n) { return Math.round(((n || 0) + Number.EPSILON) * 100) / 100; }

// One row per line item, in the exact order the reference statement uses. `factorKey` says which
// tariff factor (if any) applies to this row's reading before the rate is multiplied in.
const ELECTRICITY_ROWS = [
  { key: 'fixed_charge', label: 'Fixed Charge', unit: 'R/c', rateField: 'fixed_charge_rate', readingField: null, fixedReading: 1, factorKey: null },
  { key: 'network_access', label: 'Network Access', unit: 'R/kVA', rateField: 'network_access_rate', readingField: 'network_access_kva', commentField: 'network_access_comment', factorKey: 'kva_factor' },
  { key: 'network_demand', label: 'Network Demand', unit: 'R/kVA', rateField: 'network_demand_rate', readingField: 'network_demand_kva', commentField: 'network_demand_comment', factorKey: 'kva_factor' },
  { key: 'peak_high', label: 'Peak Energy - High Demand', unit: 'R/kWh', rateField: 'peak_high_rate', readingField: 'peak_high_kwh', factorKey: 'peak_factor' },
  { key: 'peak_low', label: 'Peak Energy - Low Demand', unit: 'R/kWh', rateField: 'peak_low_rate', readingField: 'peak_low_kwh', factorKey: 'peak_factor' },
  { key: 'standard_high', label: 'Standard Energy - High Demand', unit: 'R/kWh', rateField: 'standard_high_rate', readingField: 'standard_high_kwh', factorKey: 'standard_factor' },
  { key: 'standard_low', label: 'Standard Energy - Low Demand', unit: 'R/kWh', rateField: 'standard_low_rate', readingField: 'standard_low_kwh', factorKey: 'standard_factor' },
  { key: 'offpeak_high', label: 'Off-Peak Energy - High Demand', unit: 'R/kWh', rateField: 'offpeak_high_rate', readingField: 'offpeak_high_kwh', factorKey: 'offpeak_factor' },
  { key: 'offpeak_low', label: 'Off-Peak Energy - Low Demand', unit: 'R/kWh', rateField: 'offpeak_low_rate', readingField: 'offpeak_low_kwh', factorKey: 'offpeak_factor' },
];

const WATER_ROWS = [
  { key: 'water', label: 'Water Consumption', unit: 'R/kL', rateField: 'water_rate', readingField: 'water_kl', factorKey: null },
  { key: 'sewer', label: 'Sewer', unit: 'R/kL', rateField: 'sewer_rate', readingField: 'sewer_kl', factorKey: null },
];

// `slip` is a site_billing_slips row (or the equivalent plain object from a not-yet-saved form),
// `tariff` a site_tariffs row. Returns { elecItems, waterItems, elecTotal, waterTotal, subtotal,
// vatAmount, total } - each item carries both the raw reading (as entered) and the cost (reading
// x factor x rate), so the slip can show its full derivation.
function computeSlip(slip, tariff) {
  // apply_correction_factor is stored as 0/1 (SQLite has no real boolean); undefined/missing
  // (e.g. a plain object built from a form that hasn't posted the checkbox yet) defaults to "on",
  // matching the column's own DB default - the factor is the normal case, not the exception.
  const applyFactor = !(slip.apply_correction_factor === 0 || slip.apply_correction_factor === false);
  const buildItems = (rows) => rows.map((r) => {
    const reading = r.fixedReading != null ? r.fixedReading : Number(slip[r.readingField] || 0);
    const rate = Number(tariff[r.rateField] || 0);
    const factor = (applyFactor && r.factorKey) ? Number(tariff[r.factorKey] || 1) : 1;
    const adjustedReading = reading * factor;
    const cost = round2(adjustedReading * rate);
    return {
      key: r.key, label: r.label, unit: r.unit, rate, reading, factor, adjustedReading, cost,
      comment: r.commentField ? (slip[r.commentField] || null) : null,
    };
  });

  const elecItems = buildItems(ELECTRICITY_ROWS);
  const waterItems = buildItems(WATER_ROWS);
  const elecTotal = round2(elecItems.reduce((s, i) => s + i.cost, 0));
  const waterTotal = round2(waterItems.reduce((s, i) => s + i.cost, 0));
  const subtotal = round2(elecTotal + waterTotal);
  const vatRate = 0.15;
  const vatAmount = round2(subtotal * vatRate);
  const total = round2(subtotal + vatAmount);

  return { elecItems, waterItems, elecTotal, waterTotal, subtotal, vatRate, vatAmount, total };
}

module.exports = { computeSlip, round2, ELECTRICITY_ROWS, WATER_ROWS };
