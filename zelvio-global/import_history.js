// zelvio-global/import_history.js - seeds 55 Loper Ave - Zelvio Global's database with its full
// known billing history (July - August 2026). Renamed from this site's original seed.js
// (2026-09-02) once a second month arrived - see adh-machine-tool/import_history.js's own header
// comment for the full renaming rationale (same pattern applied to all 5 "Loper Ave" template sites).
//
// July 2026, taken from the client's own workbook ("55 Loper - Zelvio Global - July 2026.xlsx",
// Ekurhuleni Tariff B (<=150A)) - a loose-standing flat_site property, same model as 8 Field Street /
// adh-machine-tool. Same "Loper Ave" tenant template as adh-machine-tool (see
// flat_site_tariff_shapes.js's EKURHULENI_TARIFF_B header comment for the shared-template formula
// quirks found across all 5 sites on this template).
//
// Billing period: "Range: 17 June 2026 - 03 Aug 2026" (47 days), identical to adh-machine-tool's own
// first period - same reading cycle, same building. Labelled '2026-07' (July has 31 of the 47 days).
//
// Rates (100.23 basic, 3.7982/3.0949 energy, 28.96 capacity, 54.51 water, 0.682 common area, 22.07
// sewer) are taken straight from the workbook's own Tariffs tab (2026/2027 column) - correct, and
// what every month on this tariff version (including August) uses.
//
// July's readings for capacity_charge/water/water_common_area/sewer/sewer_common_area are
// back-solved (not the workbook's own Reading column) so Reading x Rate reproduces that workbook's
// own Cost column exactly, preserving its R20,661.86 Sub Total (Excl VAT) - same 2026-08-20 client
// decision as adh-machine-tool. Only that slip's readings carry the adjustment; August's workbook has
// no such glitch, so its readings below are the real figures.
//
// Safe to re-run on every boot - see flat_site_seed_helpers.js.
const { open, migrate } = require('../db');
const { seedUsers: seedUsersShared } = require('../shared_seed_users');
const { EKURHULENI_TARIFF_B } = require('../flat_site_tariff_shapes');
const { seedTariff, seedSlip } = require('../flat_site_seed_helpers');

const FACTORS = { kva_factor: 1, peak_factor: 1, standard_factor: 1, offpeak_factor: 1 };

const TARIFF_NAME = 'Ekurhuleni_Tariff_B_Zelvio Global';

const RATES = {
  basic_charge: 100.23, energy_high: 3.7982, energy_low: 3.0949, capacity_charge: 28.96,
  water: 54.51, water_common_area: 0.682, sewer: 22.07, sewer_common_area: 0.682,
};

function main(dbFile = 'zelvio-global.db') {
  const db = open(dbFile);
  migrate(db);
  if (seedUsersShared(db)) console.log('Seeded users: admin/admin123, billing/billing123, reviewer/reviewer123, viewer/viewer123');

  const tariffId = seedTariff(db, {
    tariffName: TARIFF_NAME,
    effectiveFrom: '2026-07-01',
    shape: EKURHULENI_TARIFF_B,
    rates: RATES,
    factors: FACTORS,
    notes: 'Initial tariff, taken from the client-provided "55 Loper - Zelvio Global - July 2026.xlsx" '
      + 'workbook (Ekurhuleni_ Tariff B (<=150A)), 2026/2027 tariff-year column, effective 2026-07-01.',
  });

  const julSlipId = seedSlip(db, tariffId, {
    label: '2026-07', startDate: '2026-06-17', endDate: '2026-08-03', applyCorrectionFactor: 0,
    readings: {
      basic_charge: 1,
      energy_high: 1617, energy_low: 0,
      // Back-solved: 450 x 28.96 = R13,032.00, matching the workbook's own Cost cell (its Reading
      // column shows 150A).
      capacity_charge: 450,
      // Back-solved: 17.691673 x 54.51 = R964.37 (workbook's own Cost cell; its Reading column shows
      // the true 19.637kL reading, but its Cost formula used last year's 49.11 rate instead).
      water: 17.691673,
      // Back-solved: 54.51 x 0.682 = R37.18 (workbook's own Cost cell; its formula appears to have
      // used this year's water rate, 54.51, in place of the actual reading).
      water_common_area: 54.51,
      // Back-solved: 16.825359 x 22.07 = R371.34 (workbook's own Cost cell; used last year's 18.91
      // sewer rate instead of this year's 22.07).
      sewer: 16.825359,
      // Back-solved: 22.07 x 0.682 = R15.05 (same "rate used as reading" quirk as water_common_area).
      sewer_common_area: 22.07,
    },
  });
  if (julSlipId) console.log('55 Loper Ave - Zelvio Global: seeded initial tariff + July 2026 billing slip.');

  // August 2026: real statement from the client's "55 Loper - Zelvio Global - August 2026.xlsx" -
  // same rate card as July. Client re-uploaded a corrected version of this workbook 2026-09-04 (the
  // first upload's water/sewer consumption readings were wrong - see the water/sewer comments
  // below); electricity (energy_high, capacity_charge) is unchanged from the first upload. The
  // Capacity Charge / Common Area lines' own "rate used as reading" glitch persists unchanged in the
  // corrected workbook too - still back-solved (Cost / Rate) same as every other month. Sub Total
  // (Excl VAT) is now R21,307.55 (was R20,995.64 on the first, wrong upload).
  const aug26TariffId = seedTariff(db, {
    tariffName: TARIFF_NAME, effectiveFrom: '2026-08-01', shape: EKURHULENI_TARIFF_B, rates: RATES, factors: FACTORS,
    notes: 'Real statement from "55 Loper - Zelvio Global - August 2026.xlsx" - same rate card as '
      + 'July. Client re-uploaded a corrected version 2026-09-04 (water/sewer readings only); the '
      + 'Capacity Charge / Common Area "rate used as reading" glitch persists unchanged, no '
      + 'correction factor.',
  });
  const aug26SlipId = seedSlip(db, aug26TariffId, {
    label: '2026-08', startDate: '2026-08-03', endDate: '2026-09-02', applyCorrectionFactor: 0,
    readings: {
      basic_charge: 1,
      energy_high: 1403.9999999999782, energy_low: 0,
      // Back-solved: 450 x 28.96 = R13,032.00 (workbook's own Cost cell; its Reading column shows 150A).
      capacity_charge: 450,
      // 36.4380000000001 x 54.51 = R1,986.24, matching the corrected workbook's own Cost cell
      // exactly (Cost = Rate x Reading directly this time, no back-solving needed - client's
      // 2026-09-04 correction fixed the reading itself. Was 32.82829168959833 on the first, wrong
      // upload).
      water: 36.4380000000001,
      // Back-solved: 54.51 x 0.682 = R37.18 (same "rate used as reading" quirk as July - unaffected
      // by the 2026-09-04 water/sewer correction).
      water_common_area: 54.51,
      // 36.4380000000001 x 22.07 = R804.19, matching the corrected workbook's own Cost cell exactly
      // (was 31.220778432261078 on the first, wrong upload - same fix as water above).
      sewer: 36.4380000000001,
      // Back-solved: 22.07 x 0.682 = R15.05 (same "rate used as reading" quirk as July - unaffected
      // by the 2026-09-04 water/sewer correction).
      sewer_common_area: 22.07,
    },
  });
  if (aug26SlipId) console.log('55 Loper Ave - Zelvio Global: August 2026 slip added.');

  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
