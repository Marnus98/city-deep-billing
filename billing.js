// billing.js - generates bills for a billing period from data already stored in the database
// (meter_assignments + meter_readings), as opposed to seed.js, which generates bills directly
// from imported Excel rows (march.json/april.json). This is what the "capture readings" screens
// (server.js /readings routes) use for any month that doesn't come from an Excel import - i.e.
// every month going forward from the two that were imported.
//
// Business rules are identical to seed.js's generateBill(): same calc.js engine, same tariff
// lookup shape, same treatment of common-area rows and split kWh/kVArh/kVA allocation. The one
// difference worth flagging: the water levy for common-area tenants is computed here via
// calc.waterLevyAmount() (a formula), whereas seed.js carries over the exact dollar figure the
// source workbook itself computed. That's the one area of the reconciliation that wasn't fully
// closed out (see README "Reconciliation results") - treat manually-entered months' water levy
// line as a best-effort figure worth spot-checking against your own records for the first month
// or two.
const calc = require('./calc');

function get(db, sql, params = []) { return db.prepare(sql).get(...params); }
function all(db, sql, params = []) { return db.prepare(sql).all(...params); }
function run(db, sql, params = []) { return db.prepare(sql).run(...params); }

function activeTariffParams(db, utilityType, code, asOfDate) {
  const tariff = get(db, 'SELECT * FROM tariffs WHERE utility_type=? AND (code IS ?)', [utilityType, code]);
  if (!tariff) return null;
  const version = get(db,
    `SELECT * FROM tariff_versions WHERE tariff_id=? AND effective_from<=?
     AND (effective_to IS NULL OR effective_to>?) ORDER BY effective_from DESC LIMIT 1`,
    [tariff.id, asOfDate, asOfDate]);
  return version ? JSON.parse(version.params_json) : null;
}

// Generates (or regenerates) bills for every tenant that has at least one meter reading captured
// in this period, using each meter's *currently open* assignment (effective_to IS NULL) for
// allocation %, tariff code, sign, etc. Returns { billsCreated, missing } where `missing` lists
// meters that are assigned to a tenant but have no reading yet for this period (so that tenant's
// bill wasn't (re)generated).
function generateBillsForPeriod(db, periodId) {
  const period = get(db, 'SELECT * FROM billing_periods WHERE id=?', [periodId]);
  if (!period) throw new Error('Unknown billing period');

  const tariff1 = activeTariffParams(db, 'electricity', 1, period.start_date);
  const tariff2 = activeTariffParams(db, 'electricity', 2, period.start_date);
  const water = activeTariffParams(db, 'water', null, period.start_date);
  if (!tariff1 || !tariff2 || !water) {
    throw new Error('No active tariff version found for this period\'s start date - check the Tariffs page.');
  }

  const assignments = all(db, `
    SELECT ma.*, m.serial, m.utility_type, m.unit_scale, t.id as t_id, t.name as tenant_name, s.name as site_name
    FROM meter_assignments ma
    JOIN meters m ON m.id = ma.meter_id
    JOIN tenants t ON t.id = ma.tenant_id
    LEFT JOIN sites s ON s.id = t.site_id
    WHERE ma.effective_to IS NULL
    ORDER BY t.name, m.utility_type, m.serial
  `);

  const byTenant = new Map();
  for (const a of assignments) {
    if (!byTenant.has(a.t_id)) byTenant.set(a.t_id, { tenant: { id: a.t_id, name: a.tenant_name, site_name: a.site_name }, rows: [] });
    byTenant.get(a.t_id).rows.push(a);
  }

  let billsCreated = 0;
  const missing = [];

  for (const { tenant, rows } of byTenant.values()) {
    const lineItems = [];
    let elecKwhTotal = 0, waterM3Total = 0, anyReading = false;

    for (const a of rows) {
      const reading = get(db, 'SELECT * FROM meter_readings WHERE meter_id=? AND billing_period_id=?', [a.meter_id, periodId]);
      if (!reading) { missing.push({ tenant: tenant.name, serial: a.serial, utility_type: a.utility_type }); continue; }
      anyReading = true;

      if (a.utility_type === 'electricity') {
        // Some meters read a fraction of true consumption off the dial (CT ratio) and need
        // multiplying to get real kWh - e.g. one meter in the source data is x260. Historical
        // Excel-imported months get this for free (Excel's own consumption figure is used
        // directly), but readings entered here are raw dial deltas and need the multiplier
        // applied explicitly. See seed.js's getOrCreateMeter for where this is captured.
        const unitScale = a.unit_scale || 1;
        const rawConsumptionKwh = (reading.end_reading - reading.start_reading) * unitScale;
        const rawKvarh = (reading.end_reading_kvarh != null && reading.start_reading_kvarh != null)
          ? (reading.end_reading_kvarh - reading.start_reading_kvarh) * unitScale : 0;
        const rawKva = reading.kva_reading || 0;
        // Reproduces the Phase 1 finding that the kVArh demand charge only applies in the "Mini
        // Park" precinct's section of the source workbook, not "Industrial Park" - see calc.js.
        const yChargeEnabled = tenant.site_name === 'Mini Park';
        const result = calc.calcElectricityMeterLine({
          rawConsumptionKwh, rawKvarh, rawKva,
          allocationPct: a.allocation_pct,
          kvarhAllocationPct: a.allocation_pct_kvarh != null ? a.allocation_pct_kvarh : a.allocation_pct,
          kvaAllocationPct: a.allocation_pct_kva != null ? a.allocation_pct_kva : a.allocation_pct,
          tariffCode: a.tariff_code, serviceChargeFlag: !!a.service_charge_flag, sign: a.sign,
          carriesNetworkLevy: !!a.carries_network_levy, isCommonArea: !!a.is_common_area, energyOnly: !!a.energy_only,
          capacityChargeOverride: a.capacity_charge_override,
          tariff1, tariff2, yChargeEnabled,
        });
        for (const li of result.lineItems) lineItems.push({ ...li, meter_id: a.meter_id, utility_type: 'electricity' });
        elecKwhTotal += rawConsumptionKwh * a.sign * a.allocation_pct;
      } else {
        const rawConsumptionM3 = reading.end_reading - reading.start_reading;
        const result = calc.calcWaterMeterLine({
          rawConsumptionM3, allocationPct: a.allocation_pct, waterTariff: water, isCommonArea: !!a.is_common_area,
        });
        for (const li of result.lineItems) lineItems.push({ ...li, meter_id: a.meter_id, utility_type: 'water' });
        if (a.is_common_area) {
          const levy = calc.waterLevyAmount(a.allocation_pct, water.waterLevyBase);
          if (levy) lineItems.push({ category: 'water_levy', description: 'Water levy (common area)', quantity: null, rate: null, amount: levy, meter_id: a.meter_id, utility_type: 'water' });
        }
        waterM3Total += rawConsumptionM3 * a.allocation_pct;
      }
    }

    if (!anyReading) continue; // nothing captured for this tenant yet - leave any existing bill alone

    const subtotal = calc.sumLineItems(lineItems);
    const vatRate = 0.15;
    const vatAmount = calc.round2(subtotal * vatRate);
    const total = calc.round2(subtotal + vatAmount);

    run(db, 'DELETE FROM bill_line_items WHERE bill_id IN (SELECT id FROM bills WHERE tenant_id=? AND billing_period_id=?)', [tenant.id, periodId]);
    run(db, 'DELETE FROM bills WHERE tenant_id=? AND billing_period_id=?', [tenant.id, periodId]);
    run(db, `INSERT INTO bills (tenant_id, billing_period_id, status, subtotal_excl_vat, vat_rate, vat_amount, total_incl_vat,
          electricity_consumption_kwh, water_consumption_m3, invoice_number)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [tenant.id, periodId, 'draft', subtotal, vatRate, vatAmount, total, calc.round2(elecKwhTotal), calc.round2(waterM3Total),
       `CD-${period.label}-${tenant.id}`]);
    const bill = get(db, 'SELECT * FROM bills WHERE tenant_id=? AND billing_period_id=?', [tenant.id, periodId]);
    for (const li of lineItems) {
      run(db, 'INSERT INTO bill_line_items (bill_id, meter_id, utility_type, category, description, quantity, rate, amount) VALUES (?,?,?,?,?,?,?,?)',
        [bill.id, li.meter_id, li.utility_type, li.category, li.description, li.quantity, li.rate, li.amount]);
    }
    billsCreated++;
  }

  return { billsCreated, missing };
}

module.exports = { generateBillsForPeriod, activeTariffParams };
