// zelvio-global/municipal_import.js - imports HALF of the real Ekurhuleni municipal account
// statement for 55 Loper Street (account 1702343124, "METBOARD PROPERTIES") - this account bills
// BOTH 55 Loper Ave - Zelvio Global AND 55 Loper Ave - ADH Machine Tool South Africa (PTY) Ltd under
// one physical municipal account (see adh-machine-tool/municipal_import.js for the other half, and
// flat_site_tariff_shapes.js's EKURHULENI_MUNICIPAL_TOU_55_LOPER_STREET header comment for the full
// extraction/split explanation).
//
// SPLIT METHOD (confirmed with the client 2026-09-22): a flat 50/50 split of every line item's Rand
// cost - there's no meter-serial mapping, floor-area split, or any other existing convention in
// either site's own billing history to derive a more accurate split. Every reading below is the
// REAL, full-building meter reading straight off the statement (unhalved) - only the rate (and
// therefore the resulting cost) is halved, so this site's own Municipal Account page shows the true
// physical building consumption alongside its assumed half-share of the Rand bill. ADH Machine
// Tool's own municipal_import.js uses the exact same readings and rates - the two together always
// sum back to the statement's own real, unsplit figures.
//
// Source: 1 real "COPY TAX INVOICE" statement (account 1702343124, 55 LOPER STREET), invoiced
// 2026-08-29, reading period 26/07/01-26/08/01. The FULL (unsplit) set of current-period lines
// reconciles EXACTLY (to the cent) against the statement's own "TOTAL CURRENT LEVY 38841.09" -
// confirmed before the 50/50 split was applied - see the shape's own header comment.
//
// Safe to re-run on every boot: the statement is looked up by its unique label ('2026-07') and
// skipped if already present - see municipal_seed_helpers.js.
const { open, migrate } = require('../db');
const { EKURHULENI_MUNICIPAL_TOU_55_LOPER_STREET } = require('../flat_site_tariff_shapes');
const { seedMunicipalTariff, seedMunicipalStatement } = require('../municipal_seed_helpers');

const TARIFF_NAME = 'Ekurhuleni_Municipal_Account_55 Loper Street - Shared (50% - Zelvio Global)';

// Full statement figures (excl. VAT), before the 50/50 split - kept here as plain comments so the
// halving below is easy to audit against the source PDF (identical to ADH Machine Tool's own file):
//   property_rates 18232.50, fixed_charge 3345.78, peak (291.120 kWh) 3448.93,
//   standard (850.560 kWh) 2946.08, offpeak (340.380 kWh) 728.58, reactive (0 kWh) 0.00,
//   demand (10.693 kVA) 1233.97, network_access 2885.00, refuse_business 604.33,
//   refuse_litter 507.02, water (13 kL) 708.63, water_interim (16 kL) 872.16,
//   sewer (13 kL) 286.91, sewer_interim (16 kL) 353.12 -> full total 36153.01 excl VAT / 38841.09 incl.
const MONTHS = [
  { label: '2026-07', startDate: '2026-07-01', endDate: '2026-08-01', waterStartDate: '2026-07-02', waterEndDate: '2026-08-05',
    rates: {
      property_rates: 18232.50 / 2,
      fixed_charge: 3345.78 / 2,
      peak: (3448.93 / 2) / 291.120,
      standard: (2946.08 / 2) / 850.560,
      offpeak: (728.58 / 2) / 340.380,
      reactive: 0,
      demand: (1233.97 / 2) / 10.693,
      network_access: 2885.00 / 2,
      refuse_business: 604.33 / 2,
      refuse_litter: 507.02 / 2,
      water: (708.63 / 2) / 13,
      water_interim: (872.16 / 2) / 16,
      sewer: (286.91 / 2) / 13,
      sewer_interim: (353.12 / 2) / 16,
    },
    readings: {
      peak: 291.120, standard: 850.560, offpeak: 340.380, reactive: 0,
      demand: { reading: 10.693, comment: 'Demand=10.693 (full building reading - see file header note on the 50/50 split)' },
      water: 13,
      water_interim: { reading: 16, comment: 'INTERIM estimate (Meter 66659830), not an actual meter read this cycle' },
      sewer: 13,
      sewer_interim: { reading: 16, comment: 'INTERIM estimate (mirrors the water_interim meter), not an actual meter read this cycle' },
    } },
];

function main(dbFile = 'zelvio-global.db') {
  const db = open(dbFile);
  migrate(db);
  let created = 0;
  for (const m of MONTHS) {
    const tariffId = seedMunicipalTariff(db, {
      tariffName: TARIFF_NAME, effectiveFrom: m.startDate, shape: EKURHULENI_MUNICIPAL_TOU_55_LOPER_STREET, rates: m.rates,
    });
    const slipId = seedMunicipalStatement(db, tariffId, {
      label: m.label, startDate: m.startDate, endDate: m.endDate,
      waterStartDate: m.waterStartDate, waterEndDate: m.waterEndDate, readings: m.readings,
    });
    if (slipId) created++;
  }
  if (created) console.log(`Zelvio Global municipal account import: ${created} statement(s) added (Jul 2026, 50% share of the shared 55 Loper Street account).`);
  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
