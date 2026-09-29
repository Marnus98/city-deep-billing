// a-shack/import_history.js - seeds A-Shack's database with its full known billing history
// (Jan 2026 - Aug 2026), taken directly from 8 client-provided monthly workbooks ("A-Shack Monthly
// Slip <Month> 2026.xlsx"). New property added 2026-09-29 - own tariff shape
// (A_SHACK_EKURHULENI_TARIFF_B_MIX in flat_site_tariff_shapes.js), see that file's own header
// comment for the shape's full reasoning (Fixed/Capacity/High/Low Season Energy, a standalone Solar
// Energy Charge line, and water/sewer added ready for future rates per the client's 2026-09-29
// request, same as Loper Road).
//
// Each workbook has a "Billing - A-Shack" sheet (the main incomer - Fixed/Capacity/High/Low Season
// Energy) and, on 6 of the 8 months, a separate "Solar" sheet (Jul/Aug fold this into the same
// sheet, below the main incomer block) - both always reconcile exactly to the workbook's own
// printed "Total (Ex VAT)"/"Total"/"VAT" figures, so every reading/rate below is taken verbatim.
//
// Solar's rate: confirmed across all 8 months, it always matches whichever of energy_high/energy_low
// is that month's ACTIVE season rate (Jan-May: Low Season active, solar priced at that period's Low
// Season rate; Jun-Aug: High Season active, solar priced at that period's High Season rate) - see
// flat_site_tariff_shapes.js's own comment on A_SHACK_EKURHULENI_TARIFF_B_MIX for why this means
// solar_charge's rate isn't just one of two fixed RATES_* values like every other line, and instead
// gets its own tariff version whenever it changes even if every other rate stays the same (June here).
//
// Water/Sewer: not billed by the client yet - rate 0, unused, ready for the Tariff tab's Edit Rates
// flow whenever real figures are provided.
//
// Safe to re-run on every boot (see flat_site_seed_helpers.js): seedUsers/seedTariff/seedSlip are
// all idempotent, so redeploying never duplicates or clobbers anything.
const { open, migrate } = require('../db');
const { seedUsers: seedUsersShared } = require('../shared_seed_users');
const { A_SHACK_EKURHULENI_TARIFF_B_MIX } = require('../flat_site_tariff_shapes');
const { seedTariff, seedSlip } = require('../flat_site_seed_helpers');

// No correction-factor system applies here (every line item's factorType is null - see the shape's
// own comment) - these 4 values are never actually read, kept at 1 purely so seedTariff has
// something to store in site_tariffs' NOT NULL factor columns.
const FACTORS = { kva_factor: 1, peak_factor: 1, standard_factor: 1, offpeak_factor: 1 };

const TARIFF_NAME = 'A_Shack_Ekurhuleni_Tariff_B_Mix';

// Jan 2026 - May 2026: 2025/26 tariff year rates, Low Season active every month, solar priced at
// that same Low Season rate.
const RATES_2025_26_LOW = {
  fixed_charge: 101.1045, capacity_charge: 13287.06, energy_high: 3.9688, energy_low: 3.0864,
  solar_charge: 3.0864, water: 0, sewer: 0,
};
// Jun 2026: same 2025/26 tariff year base rates as above, but High Season became active that month
// (winter) - solar's rate flips to match, even though fixed/capacity/energy rates themselves didn't
// change yet (those change with the new tariff year in July, not with the season).
const RATES_2025_26_HIGH = {
  fixed_charge: 101.1045, capacity_charge: 13287.06, energy_high: 3.9688, energy_low: 3.0864,
  solar_charge: 3.9688, water: 0, sewer: 0,
};
// Jul 2026 - Aug 2026: 2026/27 tariff year rates (from the client's own "Tariff" sheet), High Season
// still active both months, solar priced at the new year's High Season rate.
const RATES_2026_27_HIGH = {
  fixed_charge: 100.23, capacity_charge: 13032, energy_high: 3.7982, energy_low: 3.0949,
  solar_charge: 3.7982, water: 0, sewer: 0,
};

// label, start_date, end_date, effective_from, rates, energyHighReading, energyLowReading, solarReading
const MONTHS = [
  ['2026-01', '2026-01-01', '2026-02-01', '2026-01-01', RATES_2025_26_LOW, 0, 3331.99999999998, 3867.92],
  ['2026-02', '2026-02-01', '2026-03-01', '2026-01-01', RATES_2025_26_LOW, 0, 2942.69999999999, 3908.52],
  ['2026-03', '2026-03-01', '2026-04-01', '2026-01-01', RATES_2025_26_LOW, 0, 4401.69599999998, 3611.47],
  ['2026-04', '2026-04-01', '2026-05-01', '2026-01-01', RATES_2025_26_LOW, 0, 4424.8, 2637.24],
  ['2026-05', '2026-05-01', '2026-06-01', '2026-01-01', RATES_2025_26_LOW, 0, 4249.80799999999, 3592.67],
  ['2026-06', '2026-06-01', '2026-07-01', '2026-06-01', RATES_2025_26_HIGH, 5075.99999999999, 0, 3165.71],
  ['2026-07', '2026-07-01', '2026-08-01', '2026-07-01', RATES_2026_27_HIGH, 4689.688, 0, 4316.08],
  ['2026-08', '2026-08-01', '2026-09-01', '2026-07-01', RATES_2026_27_HIGH, 3686.908, 0, 3348.68],
];

function main(dbFile = 'a-shack.db') {
  const db = open(dbFile);
  migrate(db);
  if (seedUsersShared(db)) console.log('Seeded users for A-Shack.');
  let created = 0;
  for (const [label, startDate, endDate, effectiveFrom, rates, highReading, lowReading, solarReading] of MONTHS) {
    const tariffId = seedTariff(db, { tariffName: TARIFF_NAME, effectiveFrom, shape: A_SHACK_EKURHULENI_TARIFF_B_MIX, rates, factors: FACTORS });
    const slipId = seedSlip(db, tariffId, {
      label, startDate, endDate,
      readings: { energy_high: highReading, energy_low: lowReading, solar_charge: solarReading },
    });
    if (slipId) created++;
  }
  if (created) console.log(`A-Shack history import: ${created} month(s) added (Jan 2026 - Aug 2026).`);
  return db;
}

module.exports = { run: main };
