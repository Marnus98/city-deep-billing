// rcl-group/import_history.js - seeds 65 Loper Ave - RCL GROUP SERVICES (PTY) LTD's database with
// its full known billing history (July - August 2026). Renamed from this site's original seed.js
// (2026-09-02) once a second month arrived - see adh-machine-tool/import_history.js's own header
// comment for the full renaming rationale.
//
// July 2026, taken from the client's own workbook ("65 Loper - RCL - July 2026.xlsx", Ekurhuleni
// Tariff B (<=150A)) - a loose-standing flat_site property, same model as 8 Field Street /
// adh-machine-tool. Same "Loper Ave" tenant template as adh-machine-tool, but (like Interoll) this
// site's own statement doesn't bill a "Common Area" water/sewer surcharge - see
// flat_site_tariff_shapes.js's EKURHULENI_TARIFF_B_SIMPLE.
//
// Billing period: "Range: From 2026-07-07 00:01 to 2026-08-03 00:00" (27 days, entirely within
// July), same reading cycle as Interoll/Colorobbia. Labelled '2026-07'.
//
// Rates (100.23 basic, 3.7982/3.0949 energy, 28.96 capacity, 54.51 water, 22.07 sewer) are taken
// straight from the workbook's own Tariffs tab (2026/2027 column) - correct, and what every month on
// this tariff version (including August) uses.
//
// July's readings for capacity_charge/water/sewer are back-solved (not the workbook's own Reading
// column) so Reading x Rate reproduces that workbook's own Cost column exactly, preserving its
// R31,827.59 Sub Total (Excl VAT) - same 2026-08-20 client decision as adh-machine-tool. Only that
// slip's readings carry the adjustment; August's workbook has no such glitch, so its readings below
// are the real figures.
//
// Safe to re-run on every boot - see flat_site_seed_helpers.js.
const { open, migrate } = require('../db');
const { seedUsers: seedUsersShared } = require('../shared_seed_users');
const { EKURHULENI_TARIFF_B_SIMPLE } = require('../flat_site_tariff_shapes');
const { seedTariff, seedSlip } = require('../flat_site_seed_helpers');

const FACTORS = { kva_factor: 1, peak_factor: 1, standard_factor: 1, offpeak_factor: 1 };

const TARIFF_NAME = 'Ekurhuleni_Tariff_B_RCL Group Services';

const RATES = {
  basic_charge: 100.23, energy_high: 3.7982, energy_low: 3.0949, capacity_charge: 28.96,
  water: 54.51, sewer: 22.07,
};

function main(dbFile = 'rcl-group.db') {
  const db = open(dbFile);
  migrate(db);
  if (seedUsersShared(db)) console.log('Seeded users: admin/admin123, billing/billing123, reviewer/reviewer123, viewer/viewer123');

  const tariffId = seedTariff(db, {
    tariffName: TARIFF_NAME,
    effectiveFrom: '2026-07-01',
    shape: EKURHULENI_TARIFF_B_SIMPLE,
    rates: RATES,
    factors: FACTORS,
    notes: 'Initial tariff, taken from the client-provided "65 Loper - RCL - July 2026.xlsx" '
      + 'workbook (Ekurhuleni_ Tariff B (<=150A)), 2026/2027 tariff-year column, effective 2026-07-01.',
  });

  const julSlipId = seedSlip(db, tariffId, {
    label: '2026-07', startDate: '2026-07-07', endDate: '2026-08-03', applyCorrectionFactor: 0,
    readings: {
      basic_charge: 1,
      energy_high: 4682.099, energy_low: 0,
      // Back-solved: 450 x 28.96 = R13,032.00, matching the workbook's own Cost cell (its Reading
      // column shows 150A).
      capacity_charge: 450,
      // Back-solved: 12.077042 x 54.51 = R658.32 (workbook's own Cost cell; its Reading column shows
      // the true 13.405kL reading, but its Cost formula used last year's 49.11 rate instead).
      water: 12.077042,
      // Back-solved: 11.485662 x 22.07 = R253.49 (workbook's own Cost cell; used last year's 18.91
      // sewer rate instead of this year's 22.07).
      sewer: 11.485662,
    },
  });
  if (julSlipId) console.log('65 Loper Ave - RCL GROUP SERVICES (PTY) LTD: seeded initial tariff + July 2026 billing slip.');

  // August 2026: real statement from the client's "65 Loper - RCL - August 2026.xlsx" - same rate
  // card as July. Client re-uploaded a corrected version of this workbook 2026-09-04 (the first
  // upload's water/sewer consumption readings were wrong - see the water/sewer comments below);
  // electricity (energy_high, capacity_charge) is unchanged from the first upload. The Capacity
  // Charge "rate used as reading" glitch (Reading column shows 150A but Cost is 28.96 x 450)
  // persists unchanged in the corrected workbook too - still back-solved (Cost / Rate) same as every
  // other month. Sub Total (Excl VAT) is now R33,011.14 (was R32,891.30 on the first, wrong upload).
  const aug26TariffId = seedTariff(db, {
    tariffName: TARIFF_NAME, effectiveFrom: '2026-08-01', shape: EKURHULENI_TARIFF_B_SIMPLE, rates: RATES, factors: FACTORS,
    notes: 'Real statement from "65 Loper - RCL - August 2026.xlsx" - same rate card as July. Client '
      + 're-uploaded a corrected version 2026-09-04 (water/sewer readings only); the Capacity Charge '
      + '"rate used as reading" glitch persists unchanged, no correction factor.',
  });
  const aug26SlipId = seedSlip(db, aug26TariffId, {
    label: '2026-08', startDate: '2026-08-03', endDate: '2026-09-02', applyCorrectionFactor: 0,
    readings: {
      basic_charge: 1,
      energy_high: 4951.5, energy_low: 0,
      // Back-solved: 450 x 28.96 = R13,032.00 (workbook's own Cost cell; its Reading column shows 150A).
      capacity_charge: 450,
      // 14 x 54.51 = R763.14, matching the corrected workbook's own Cost cell exactly (Cost = Rate x
      // Reading directly this time, no back-solving needed - client's 2026-09-04 correction fixed
      // the reading itself. Was 12.613098514034123 on the first, wrong upload).
      water: 14,
      // 14 x 22.07 = R308.98, matching the corrected workbook's own Cost cell exactly (was
      // 11.995468962392389 on the first, wrong upload - same fix as water above).
      sewer: 14,
    },
  });
  if (aug26SlipId) console.log('65 Loper Ave - RCL GROUP SERVICES (PTY) LTD: August 2026 slip added.');

  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
