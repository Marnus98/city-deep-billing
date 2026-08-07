// flat_site_tariff_shapes.js - the starter line-item template for each tariff shape seen across
// flat_site properties so far. Only ever consulted when a site's *very first* tariff version is
// being created (by that site's seed/import script) - once site_tariff_items rows exist in the
// database, the app is fully data-driven from there (server.js/views.js/pdf.js never import this
// file), so adding a brand new shape later never requires touching those layers, just adding a new
// entry here and a new site-specific import script.
//
// Each shape is an ordered array of { key, label, unit, factorType, fixedReading, hasComment,
// section }. `key` must stay stable for a given site once readings exist against it (it's the
// join key in site_slip_readings) - safe to reorder/relabel here for a *future* site using the
// same shape, but never rename an existing site's keys after the fact.
//
// factorType picks which of a tariff's 4 correction factors (kva/peak/standard/offpeak) grosses up
// this row's reading before the rate is applied (see calc_flat_site.js) - null means no correction
// (flat charges, and anything that isn't a kVA/kWh quantity the client's meters are known to
// under-read on, e.g. reactive energy).
//
// Water/Sewer are appended to every shape for consistency with how 8 Field Street works (rate 0
// until filled in, readings added later via the Edit page) - not every site necessarily bills
// water through this app, but there's no harm in the rows sitting at R0 unused.
const WATER_SEWER_ITEMS = [
  { key: 'water', label: 'Water Consumption', unit: 'R/kL', factorType: null, fixedReading: null, hasComment: false, section: 'water' },
  { key: 'sewer', label: 'Sewer', unit: 'R/kL', factorType: null, fixedReading: null, hasComment: false, section: 'water' },
];

// Ekurhuleni Tariff E TOU - 8 Field Street, Bob Martin, Cranbrook Flavours all bill on this shape
// (same line items/order, different rates and correction factors per site).
const EKURHULENI_E_TOU = [
  { key: 'fixed_charge', label: 'Fixed Charge', unit: 'R/c', factorType: null, fixedReading: 1, hasComment: false, section: 'electricity' },
  { key: 'network_access', label: 'Network Access', unit: 'R/kVA', factorType: 'kva', fixedReading: null, hasComment: true, section: 'electricity' },
  { key: 'network_demand', label: 'Network Demand', unit: 'R/kVA', factorType: 'kva', fixedReading: null, hasComment: true, section: 'electricity' },
  { key: 'peak_high', label: 'Peak Energy - High Demand', unit: 'R/kWh', factorType: 'peak', fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'peak_low', label: 'Peak Energy - Low Demand', unit: 'R/kWh', factorType: 'peak', fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'standard_high', label: 'Standard Energy - High Demand', unit: 'R/kWh', factorType: 'standard', fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'standard_low', label: 'Standard Energy - Low Demand', unit: 'R/kWh', factorType: 'standard', fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'offpeak_high', label: 'Off-Peak Energy - High Demand', unit: 'R/kWh', factorType: 'offpeak', fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'offpeak_low', label: 'Off-Peak Energy - Low Demand', unit: 'R/kWh', factorType: 'offpeak', fixedReading: null, hasComment: false, section: 'electricity' },
  ...WATER_SEWER_ITEMS,
];

// Ekurhuleni Industrial Tariff C (230/400V) - Loper Road - Sandvic. Same municipality as the E TOU
// shape above, but a genuinely different tariff: "Basic Charge" not "Fixed Charge", a single
// "Demand Charge" instead of split Network Access/Network Demand, and all three High-demand energy
// rows grouped before the Low-demand rows instead of paired peak/standard/off-peak - row order here
// mirrors the client's own statement exactly.
const EKURHULENI_INDUSTRIAL_C = [
  { key: 'basic_charge', label: 'Basic Charge', unit: 'R/c', factorType: null, fixedReading: 1, hasComment: false, section: 'electricity' },
  { key: 'peak_high', label: 'Peak Energy - High Demand', unit: 'R/kWh', factorType: 'peak', fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'standard_high', label: 'Standard Energy - High Demand', unit: 'R/kWh', factorType: 'standard', fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'offpeak_high', label: 'Off-Peak Energy - High Demand', unit: 'R/kWh', factorType: 'offpeak', fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'peak_low', label: 'Peak Energy - Low Demand', unit: 'R/kWh', factorType: 'peak', fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'standard_low', label: 'Standard Energy - Low Demand', unit: 'R/kWh', factorType: 'standard', fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'offpeak_low', label: 'Off-Peak Energy - Low Demand', unit: 'R/kWh', factorType: 'offpeak', fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'network_access', label: 'Network Access', unit: 'R/kVA', factorType: 'kva', fixedReading: null, hasComment: true, section: 'electricity' },
  { key: 'demand_charge', label: 'Demand Charge', unit: 'R/kVA', factorType: 'kva', fixedReading: null, hasComment: true, section: 'electricity' },
  ...WATER_SEWER_ITEMS,
];

// Loper Road - Sandvic's 2026/2027 tariff year (effective Jul 2026) - the same municipality/site as
// EKURHULENI_INDUSTRIAL_C above, but the statement itself collapses the three-way Peak/Standard/
// Off-Peak energy split into a single "Total Energy" figure per High/Low demand season - a
// genuinely different line-item structure the old shape can't represent (not a rate change on the
// same rows). Given its own shape/tariff version rather than forcing the collapsed total into one
// of the old peak/standard/offpeak keys, which would show a misleading row label on the bill.
const EKURHULENI_INDUSTRIAL_C_LOPER_ROAD_2026_27 = [
  { key: 'basic_charge', label: 'Basic Charge', unit: 'R/c', factorType: null, fixedReading: 1, hasComment: false, section: 'electricity' },
  { key: 'total_energy_high', label: 'Total Energy - High Demand', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'total_energy_low', label: 'Total Energy - Low Demand', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'network_access', label: 'Network Access', unit: 'R/kVA', factorType: null, fixedReading: null, hasComment: true, section: 'electricity' },
  { key: 'demand_charge', label: 'Demand Charge', unit: 'R/kVA', factorType: null, fixedReading: null, hasComment: true, section: 'electricity' },
  ...WATER_SEWER_ITEMS,
];

// City Power (City of Johannesburg) Industrial LV TOU incl. surcharge - AutoZone. A different
// municipality entirely from the Ekurhuleni shapes above, with two charges neither Ekurhuleni shape
// has: Excess Reactive (R/kVArh - no correction factor defined, reactive power isn't a quantity the
// site-vs-municipal-meter factor was calibrated against) and a Network Surcharge that City Power
// bills as a flat rate on *total* energy - on the client's own statements its reading is simply the
// sum of that month's Peak+Standard+Off-Peak kWh readings, so it's entered the same way as every
// other row (retype that total) rather than the app computing it automatically.
const CITY_POWER_LV_TOU = [
  { key: 'service_charge', label: 'Service Charge', unit: 'R/c', factorType: null, fixedReading: 1, hasComment: false, section: 'electricity' },
  { key: 'capacity_charge', label: 'Capacity Charge', unit: 'R/c', factorType: null, fixedReading: 1, hasComment: false, section: 'electricity' },
  { key: 'demand_charge', label: 'Demand Charge', unit: 'R/kVA', factorType: 'kva', fixedReading: null, hasComment: true, section: 'electricity' },
  { key: 'excess_reactive', label: 'Excess Reactive', unit: 'R/kVArh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'peak_high', label: 'Peak Energy - High Demand', unit: 'R/kWh', factorType: 'peak', fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'peak_low', label: 'Peak Energy - Low Demand', unit: 'R/kWh', factorType: 'peak', fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'standard_high', label: 'Standard Energy - High Demand', unit: 'R/kWh', factorType: 'standard', fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'standard_low', label: 'Standard Energy - Low Demand', unit: 'R/kWh', factorType: 'standard', fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'offpeak_high', label: 'Off-Peak Energy - High Demand', unit: 'R/kWh', factorType: 'offpeak', fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'offpeak_low', label: 'Off-Peak Energy - Low Demand', unit: 'R/kWh', factorType: 'offpeak', fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'network_surcharge', label: 'Network Surcharge (City Power)', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  ...WATER_SEWER_ITEMS,
];

// Ekurhuleni municipal account statement shape for 8 Field Street - the actual invoice the
// municipality sends (see field-street/municipal_import.js), as opposed to EKURHULENI_E_TOU above
// (what HolmStone bills the client off the site's own meters). Same electricity line items as
// EKURHULENI_E_TOU, plus Property Rates and Refuse Removal, which only ever appear on the
// municipal side - never billed through to the client this way. factorType is null throughout:
// these are the municipality's own meter readings already, nothing to gross up (see
// municipal_statement_slips.apply_correction_factor, off by default).
const EKURHULENI_MUNICIPAL_E_TOU_8FS = [
  { key: 'property_rates', label: 'Property Rates (Industrial)', unit: 'R/c', factorType: null, fixedReading: 1, hasComment: false, section: 'municipal', vatExempt: true },
  { key: 'fixed_charge', label: 'Fixed Charge', unit: 'R/c', factorType: null, fixedReading: 1, hasComment: false, section: 'electricity' },
  { key: 'network_access', label: 'Network Access Charge', unit: 'R/kVA', factorType: null, fixedReading: null, hasComment: true, section: 'electricity' },
  { key: 'network_demand', label: 'Network Demand', unit: 'R/kVA', factorType: null, fixedReading: null, hasComment: true, section: 'electricity' },
  { key: 'peak_high', label: 'Peak Energy - High Demand', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'peak_low', label: 'Peak Energy - Low Demand', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'standard_high', label: 'Standard Energy - High Demand', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'standard_low', label: 'Standard Energy - Low Demand', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'offpeak_high', label: 'Off-Peak Energy - High Demand', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'offpeak_low', label: 'Off-Peak Energy - Low Demand', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'refuse', label: 'Refuse Removal', unit: 'R/c', factorType: null, fixedReading: 1, hasComment: false, section: 'municipal' },
  ...WATER_SEWER_ITEMS,
];

// Ekurhuleni municipal account statement shape for Bob Martin (see bob-martin/municipal_import.js) -
// structurally close to EKURHULENI_MUNICIPAL_E_TOU_8FS above but one genuine difference on this
// site's actual statements: Refuse Removal is billed as two separate line items ("Business" bin
// collection and area-wide "Litter-picking"), not one combined figure.
//
// "Network Access Charge" shares its Reading with Network Demand (both read off the same kVA
// meter) - its own cost barely tracks that reading month to month (mid-R56,000s regardless of kVA
// moving around), so the "rate" shown here is only cost/reading for display consistency with the
// rest of the app (same convention field-street's municipal import already uses for this exact
// line) - not necessarily how Ekurhuleni's own tariff book computes it.
const EKURHULENI_MUNICIPAL_D1_TOU_BOB_MARTIN = [
  { key: 'property_rates', label: 'Property Rates (Industrial)', unit: 'R/c', factorType: null, fixedReading: 1, hasComment: false, section: 'municipal', vatExempt: true },
  { key: 'fixed_charge', label: 'Fixed Charge', unit: 'R/c', factorType: null, fixedReading: 1, hasComment: false, section: 'electricity' },
  { key: 'network_access', label: 'Network Access Charge', unit: 'R/kVA', factorType: null, fixedReading: null, hasComment: true, section: 'electricity' },
  { key: 'network_demand', label: 'Network Demand', unit: 'R/kVA', factorType: null, fixedReading: null, hasComment: true, section: 'electricity' },
  { key: 'peak_high', label: 'Peak Energy - High Demand', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'peak_low', label: 'Peak Energy - Low Demand', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'standard_high', label: 'Standard Energy - High Demand', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'standard_low', label: 'Standard Energy - Low Demand', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'offpeak_high', label: 'Off-Peak Energy - High Demand', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'offpeak_low', label: 'Off-Peak Energy - Low Demand', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'refuse_business', label: 'Refuse Removal - Business', unit: 'R/c', factorType: null, fixedReading: 1, hasComment: false, section: 'municipal' },
  { key: 'refuse_litter', label: 'Refuse Removal - Litter-picking', unit: 'R/c', factorType: null, fixedReading: 1, hasComment: false, section: 'municipal' },
  ...WATER_SEWER_ITEMS,
];

// City of Johannesburg municipal account statement shape for AutoZone (see
// autozone/municipal_import.js) - a genuinely different municipality/format from the Ekurhuleni
// shapes above (City of Johannesburg + City Power + Johannesburg Water + PIKITUP, each its own
// VAT-registered sub-account on one combined statement). factorType is null throughout: these are
// the municipality's own meter readings already, nothing to gross up.
//
// Peak/Standard/Off-Peak ARE printed directly on this statement (unlike Ekurhuleni's), so no
// implied-rate classification is needed there. The _high variants exist for the same reason they do
// on the client's own site-billing shapes: some reading periods straddle a mid-cycle tariff/season
// change and the statement itself prints two rate rows for the same category that cycle (see e.g.
// May 2026's dual Off-Peak/Peak/Standard rows) - both _low and _high can be non-zero in the same
// month here, unlike a strict winter/summer split.
//
// "Reactive Energy Charge" is its own line (usually R0.0000/kVArh, i.e. free, except when reactive
// demand exceeds a threshold - Jan 2026 is the one month in this batch where it's actually billed).
//
// "Network Surcharge" isn't printed with its own rate/reading on the statement (just a Rand total),
// but it reconciles cleanly to 0.06 x total kWh consumed every month - shown here as an implied
// R/kWh rate against that same total for display consistency with the rest of the app.
//
// Water/Sewer: Johannesburg Water bills off a single combined meter/register here (unlike Bob
// Martin's two physical meters) - reading = that register's own KL difference most months. One
// exception: see the water/sewer INTERIM REVERSAL note in autozone/municipal_import.js for March
// 2026, and the mid-cycle Step-1/Step-2 tariff-change blend for June 2026 - both handled as an
// implied blended R/kL rate against that month's own reading, same convention as the water blends
// already used elsewhere in this app.
const AUTOZONE_COJ_MUNICIPAL = [
  { key: 'property_rates', label: 'Property Rates (Industrial)', unit: 'R/c', factorType: null, fixedReading: 1, hasComment: false, section: 'municipal', vatExempt: true },
  { key: 'peak_high', label: 'Peak Energy - High Demand', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'peak_low', label: 'Peak Energy - Low Demand', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'standard_high', label: 'Standard Energy - High Demand', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'standard_low', label: 'Standard Energy - Low Demand', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'offpeak_high', label: 'Off-Peak Energy - High Demand', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'offpeak_low', label: 'Off-Peak Energy - Low Demand', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'surcharge_tou', label: 'Surcharge - TOU', unit: 'R/c', factorType: null, fixedReading: 1, hasComment: false, section: 'electricity' },
  { key: 'reactive_energy', label: 'Reactive Energy Charge', unit: 'R/kVArh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'network_surcharge', label: 'Network Surcharge (City Power)', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'demand_charge', label: 'Demand Charge', unit: 'R/kVA', factorType: null, fixedReading: null, hasComment: true, section: 'electricity' },
  { key: 'service_charge', label: 'Service Charge', unit: 'R/c', factorType: null, fixedReading: 1, hasComment: false, section: 'electricity' },
  { key: 'water', label: 'Water Consumption', unit: 'R/kL', factorType: null, fixedReading: null, hasComment: false, section: 'water' },
  { key: 'demand_management_levy', label: 'Demand Management Levy', unit: 'R/c', factorType: null, fixedReading: 1, hasComment: false, section: 'water' },
  { key: 'sewer', label: 'Sewer', unit: 'R/kL', factorType: null, fixedReading: null, hasComment: false, section: 'water' },
  { key: 'refuse', label: 'Refuse Removal (PIKITUP)', unit: 'R/c', factorType: null, fixedReading: 1, hasComment: false, section: 'municipal' },
  { key: 'sundry_surcharge', label: 'Sundry Surcharge (excl. Property Rates)', unit: 'R/c', factorType: null, fixedReading: 1, hasComment: false, section: 'municipal' },
];

// Ekurhuleni municipal account statement shape for Loper Road - Sandvic (see
// loper-road/municipal_import.js) - structurally quite different from the other two Ekurhuleni
// municipal shapes above, because this statement bills electricity completely differently from how
// HolmStone bills the client for the same site: no Peak/Standard/Off-Peak TOU split at all, just one
// flat "Energy Charge" meter reading (meter S021409628) alongside a separate Demand meter (meter
// D021409628) - confirmed across all 4 months in this batch reconciling exactly to each statement's
// own "TOTAL CURRENT LEVY" figure with no TOU breakdown anywhere on the page. No Property Rates line
// either (unlike 8 Field Street/Bob Martin/AutoZone) - this account genuinely doesn't bill it.
//
// "Network Access Charge" is a flat R3,507.92 every single month in this batch regardless of the
// Demand meter's kVA moving around - same "barely tracks its own reading" behaviour already flagged
// for Bob Martin's identical line item; reading here reuses the Demand meter's own kVA purely for
// display consistency with the rest of the app, not because Ekurhuleni's tariff book actually prices
// it that way.
//
// Refuse Removal is two separate flat lines here too, like Bob Martin, but with different labels
// ("Litterpicking" priced per m2 of the unit, "Environmental Levy" a flat account-wide charge) -
// kept as two line items since the statement never merges them.
//
// Water/Sewer: two physical meters (100064836, 10351198), combined into one reading/cost per month
// exactly like Bob Martin's two-meter site - one meter reads a real, moving consumption most months
// (10351198, steady ~54-62kL/month), the other normally reads Cons=0 (100064836, effectively idle)
// except March 2026 where it briefly shows an INTERIM 1kL. Rate is a clean flat R49.11/kL for water
// and R18.91/kL for sewer across all 4 months (no sliding scale, no mid-cycle change) - the exact
// same two rates already seen on Bob Martin's own statements, consistent with both being Ekurhuleni
// accounts on the same tariff book. Each statement double-prints a second, R0.00 Sewer line
// alongside the real one (same harmless duplicate-line quirk already seen on Bob Martin's
// statements) - not imported, since it never carries a reading or cost.
const EKURHULENI_MUNICIPAL_INDUSTRIAL_C_LOPER_ROAD = [
  { key: 'fixed_charge', label: 'Fixed Charge', unit: 'R/c', factorType: null, fixedReading: 1, hasComment: false, section: 'electricity' },
  { key: 'energy_charge', label: 'Energy Charge', unit: 'R/kWh', factorType: null, fixedReading: null, hasComment: false, section: 'electricity' },
  { key: 'demand_charge', label: 'Demand Charge', unit: 'R/kVA', factorType: null, fixedReading: null, hasComment: true, section: 'electricity' },
  { key: 'network_access', label: 'Network Access Charge', unit: 'R/kVA', factorType: null, fixedReading: null, hasComment: true, section: 'electricity' },
  { key: 'refuse_litter', label: 'Refuse Removal - Litterpicking', unit: 'R/c', factorType: null, fixedReading: 1, hasComment: false, section: 'municipal' },
  { key: 'refuse_levy', label: 'Refuse Removal - Environmental Levy', unit: 'R/c', factorType: null, fixedReading: 1, hasComment: false, section: 'municipal' },
  ...WATER_SEWER_ITEMS,
];

module.exports = {
  EKURHULENI_E_TOU, EKURHULENI_INDUSTRIAL_C, EKURHULENI_INDUSTRIAL_C_LOPER_ROAD_2026_27, CITY_POWER_LV_TOU,
  EKURHULENI_MUNICIPAL_E_TOU_8FS, EKURHULENI_MUNICIPAL_D1_TOU_BOB_MARTIN, AUTOZONE_COJ_MUNICIPAL,
  EKURHULENI_MUNICIPAL_INDUSTRIAL_C_LOPER_ROAD,
};
