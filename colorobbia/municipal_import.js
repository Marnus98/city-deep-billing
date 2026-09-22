// colorobbia/municipal_import.js - imports Colorobbia's actual Ekurhuleni municipal account
// statement (as opposed to import_history.js, which is what HolmStone bills the client - see
// db.js's municipal_tariffs/municipal_statement_slips for why these live in a separate set of
// tables). Source: 1 real "COPY TAX INVOICE" statement (account 1702343564, "METBOARD PROP LTD.",
// 13 BRUSSELS AVENUE), invoiced 2026-08-29, reading period 26/07/01-26/08/01.
//
// NOTE: Colorobbia's registered site name in properties.js is "122 Loper - Colorobbia", but this
// municipal account is billed to "13 BRUSSELS AVENUE" - see flat_site_tariff_shapes.js's
// EKURHULENI_MUNICIPAL_SIMPLE_LOPER_AVE header comment. Also note this statement's own "REFUSE:
// BUSINESS 240L X1 PER WEEK x 0 units" line still carries the full R604.33 charge despite printing
// "x 0 units" - a flat charge on this statement, not actually driven by the unit count (same flat
// R604.33 appears unchanged on Interoll/RCL Group's own statements too, which print "x 1 units").
//
// See flat_site_tariff_shapes.js's EKURHULENI_MUNICIPAL_SIMPLE_LOPER_AVE header comment for the
// shape shared with Interoll and RCL Group's own municipal statements, and the extraction method.
//
// Every current-period line below reconciles EXACTLY (to the cent) against the statement's own
// printed "TOTAL CURRENT LEVY 42083.75" - the "BALANCE BROUGHT FORWARD"/"SUB TOTAL" carry-forward
// lines are deliberately excluded, same convention as every other property's municipal import.
//
// Safe to re-run on every boot: the statement is looked up by its unique label ('2026-07') and
// skipped if already present - see municipal_seed_helpers.js.
const { open, migrate } = require('../db');
const { EKURHULENI_MUNICIPAL_SIMPLE_LOPER_AVE } = require('../flat_site_tariff_shapes');
const { seedMunicipalTariff, seedMunicipalStatement } = require('../municipal_seed_helpers');

const TARIFF_NAME = 'Ekurhuleni_Municipal_Account_13 Brussels Avenue - Colorobbia';

const MONTHS = [
  { label: '2026-07', startDate: '2026-07-01', endDate: '2026-08-01', waterStartDate: '2026-07-02', waterEndDate: '2026-08-05',
    rates: {
      property_rates: 13923.00,
      capacity_charge: 12586.50,
      fixed_charge: 36.95,
      energy_charge: 8912.96 / 2660.585,
      refuse_business: 604.33,
      refuse_litter: 432.37,
      water: 1362.75 / 25,
      sewer: 551.75 / 25,
    },
    readings: { energy_charge: 2660.585, water: 25, sewer: 25 } },
];

function main(dbFile = 'colorobbia.db') {
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
  if (created) console.log(`Colorobbia municipal account import: ${created} statement(s) added (Jul 2026).`);
  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
