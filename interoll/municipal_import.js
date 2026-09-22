// interoll/municipal_import.js - imports 63 Loper Ave - Interoll's actual Ekurhuleni municipal
// account statement (as opposed to import_history.js, which is what HolmStone bills the client -
// see db.js's municipal_tariffs/municipal_statement_slips for why these live in a separate set of
// tables). Source: 1 real "COPY TAX INVOICE" statement (account 1702329895, "METBOARD PROPERTIES
// LTD", 63 LOPER STREET), invoiced 2026-08-29, reading period 26/07/01-26/08/01.
//
// See flat_site_tariff_shapes.js's EKURHULENI_MUNICIPAL_SIMPLE_LOPER_AVE header comment for the
// shape shared with RCL Group and Colorobbia's own municipal statements, and the extraction method.
//
// Every current-period line below reconciles EXACTLY (to the cent) against the statement's own
// printed "TOTAL CURRENT LEVY 33118.39" - the "BALANCE BROUGHT FORWARD"/"SUB TOTAL" carry-forward
// lines are deliberately excluded, same convention as every other property's municipal import.
//
// Safe to re-run on every boot: the statement is looked up by its unique label ('2026-07') and
// skipped if already present - see municipal_seed_helpers.js.
const { open, migrate } = require('../db');
const { EKURHULENI_MUNICIPAL_SIMPLE_LOPER_AVE } = require('../flat_site_tariff_shapes');
const { seedMunicipalTariff, seedMunicipalStatement } = require('../municipal_seed_helpers');

const TARIFF_NAME = 'Ekurhuleni_Municipal_Account_63 Loper Ave - Interoll';

const MONTHS = [
  { label: '2026-07', startDate: '2026-07-01', endDate: '2026-08-01', waterStartDate: '2026-07-02', waterEndDate: '2026-08-05',
    rates: {
      property_rates: 11889.15,
      capacity_charge: 8391.00,
      fixed_charge: 36.95,
      energy_charge: 7928.95 / 2366.850,
      refuse_business: 604.33,
      refuse_litter: 426.86,
      water: 763.14 / 14,
      sewer: 308.98 / 14,
    },
    readings: { energy_charge: 2366.850, water: 14, sewer: 14 } },
];

function main(dbFile = 'interoll.db') {
  const db = open(dbFile);
  migrate(db);
  let created = 0;
  for (const m of MONTHS) {
    const tariffId = seedMunicipalTariff(db, {
      tariffName: TARIFF_NAME, effectiveFrom: m.startDate, shape: EKURHULENI_MUNICIPAL_SIMPLE_LOPER_AVE, rates: m.rates,
    });
    const slipId = seedMunicipalStatement(db, tariffId, {
      label: m.label, startDate: m.startDate, endDate: m.endDate,
      waterStartDate: m.waterStartDate, waterEndDate: m.waterEndDate, readings: m.readings,
    });
    if (slipId) created++;
  }
  if (created) console.log(`Interoll municipal account import: ${created} statement(s) added (Jul 2026).`);
  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
