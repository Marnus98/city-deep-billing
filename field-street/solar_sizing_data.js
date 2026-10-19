// solar_sizing_data.js - reads what the Solar Sizing page needs from the ACTIVE property's database
// (8 Field Street): the last 12 months of billed Peak / Standard / Off-peak kWh and kVA from the
// tenant billing slips (site_billing_slips + site_slip_readings, NOT municipal statements), and the
// LATEST tariff version's rates (site_tariffs / site_tariff_items) so the model always prices at the
// current tariff. Read-only: nothing here writes to the database.
//
// `all` and `get` are the same per-request helpers server.js uses everywhere (they run against the
// signed-in user's current property database).
function loadSolarSizingData(all, get) {
  const slips = all('SELECT id, label FROM site_billing_slips ORDER BY label DESC LIMIT 12');
  const months = [];
  for (const s of slips) {
    const m = {};
    for (const r of all('SELECT item_key, reading FROM site_slip_readings WHERE slip_id=?', [s.id])) m[r.item_key] = Number(r.reading) || 0;
    const mm = Number(String(s.label).slice(5, 7));
    if (!mm) continue;
    months.push({
      label: s.label, m: mm,
      p: (m.peak_high || 0) + (m.peak_low || 0),
      s: (m.standard_high || 0) + (m.standard_low || 0),
      o: (m.offpeak_high || 0) + (m.offpeak_low || 0),
      kva: m.network_demand || 0,
    });
  }
  months.sort((a, b) => (a.label < b.label ? -1 : 1));

  const tariff = get('SELECT * FROM site_tariffs ORDER BY id DESC LIMIT 1');
  const rate = {};
  if (tariff) {
    for (const it of all('SELECT item_key, rate FROM site_tariff_items WHERE tariff_id=?', [tariff.id])) rate[it.item_key] = Number(it.rate) || 0;
  }
  return {
    months,
    tariffName: tariff ? tariff.tariff_name : null,
    effectiveFrom: tariff ? tariff.effective_from : null,
    rates: {
      ph: rate.peak_high || 0, pl: rate.peak_low || 0,
      sh: rate.standard_high || 0, sl: rate.standard_low || 0,
      oh: rate.offpeak_high || 0, ol: rate.offpeak_low || 0,
    },
    fixed: { demand: rate.network_demand || 0, nac: rate.network_access || 0, basic: rate.fixed_charge || 0 },
  };
}

module.exports = { loadSolarSizingData };
