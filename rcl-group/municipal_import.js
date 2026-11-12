// rcl-group/municipal_import.js - imports 65 Loper Ave - RCL Group Services' actual Ekurhuleni
// municipal account statement (as opposed to import_history.js, which is what HolmStone bills the
// client - see db.js's municipal_tariffs/municipal_statement_slips for why these live in a separate
// set of tables). Source: 1 real "COPY TAX INVOICE" statement (account 1702329900, "METBOARD
// PROPERTIES LTD", 65 LOPER STREET), invoiced 2026-08-29, reading period 26/07/01-26/08/01.
//
// See flat_site_tariff_shapes.js's EKURHULENI_MUNICIPAL_SIMPLE_LOPER_AVE header comment for the
// shape shared with Interoll and Colorobbia's own municipal statements, and the extraction method.
//
// Every current-period line below reconciles EXACTLY (to the cent) against the statement's own
// printed "TOTAL CURRENT LEVY 46388.43" - the "BALANCE BROUGHT FORWARD"/"SUB TOTAL" carry-forward
// lines are deliberately excluded, same convention as every other property's municipal import.
//
// Safe to re-run on every boot: the statement is looked up by its unique label ('2026-07') and
// skipped if already present - see municipal_seed_helpers.js.
const { open, migrate } = require('../db');
const { EKURHULENI_MUNICIPAL_SIMPLE_LOPER_AVE } = require('../flat_site_tariff_shapes');
const { seedMunicipalTariff, seedMunicipalStatement } = require('../municipal_seed_helpers');

const TARIFF_NAME = 'Ekurhuleni_Municipal_Account_65 Loper Ave - RCL Group Services';

const MONTHS = [
  { label: '2026-07', startDate: '2026-07-01', endDate: '2026-08-01', waterStartDate: '2026-07-02', waterEndDate: '2026-08-05',
    rates: {
      property_rates: 9531.60,
      capacity_charge: 12586.50,
      fixed_charge: 36.95,
      energy_charge: 17304.49 / 5165.520,
      refuse_business: 604.33,
      refuse_litter: 291.87,
      water: 872.16 / 16,
      sewer: 353.12 / 16,
    },
    readings: { energy_charge: 5165.520, water: 16, sewer: 16 } },
  // Aug 2026: statement now under new account 1712639777 (was 1702329900). TRANSFER BETWEEN ACCOUNTS lines are prior-month charges and excluded.
  { label: '2026-08', startDate: '2026-08-01', endDate: '2026-09-01',
    rates: {
      property_rates: 9531.60,
      capacity_charge: 12586.50,
      fixed_charge: 36.95,
      energy_charge: 17540.87 / 5236.080,
      refuse_business: 604.33,
      refuse_litter: 291.87,
      water: 763.14 / 14,
      sewer: 308.98 / 14,
    },
    readings: { energy_charge: 5236.080, water: { reading: 14, comment: 'INTERIM estimate, no reading dates' }, sewer: { reading: 14, comment: 'INTERIM estimate, no reading dates' } } },
  // Sep 2026 (account 1712639777, statement 2026/10/29, reading dates 26/09/01-26/10/01). The R33,275.55
  // "SUPP 2 FILE 6" journal (14 Oct, supplementary property-rates) is excluded like other carry-forward
  // items. Water/sewer: 29 kL billed less 14 kL interim reversal -> net 15 kL (R817.65 / R331.05).
  // Remaining lines reconcile to the cent: TOTAL CURRENT LEVY 92680.08 incl VAT less the supp journal.
  { label: '2026-09', startDate: '2026-09-01', endDate: '2026-10-01', waterStartDate: '2026-08-06', waterEndDate: '2026-10-05',
    rates: {
      property_rates: 16886.10,
      capacity_charge: 12586.50,
      fixed_charge: 36.95,
      energy_charge: 22304.20 / 5272.800,
      refuse_business: 604.33,
      refuse_litter: 291.87,
      water: (1580.79 - 763.14) / 15,
      sewer: (640.03 - 308.98) / 15,
    },
    readings: { energy_charge: 5272.800,
      water: { reading: 15, comment: '29 kL billed less 14 kL interim reversal (net)' },
      sewer: { reading: 15, comment: '29 kL billed less interim reversal (net 15 kL)' } } },
];

function main(dbFile = 'rcl-group.db') {
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
  if (created) console.log(`RCL Group Services municipal account import: ${created} statement(s) added (Jul 2026).`);
  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
