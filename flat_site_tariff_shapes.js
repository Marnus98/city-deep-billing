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

module.exports = { EKURHULENI_E_TOU, EKURHULENI_INDUSTRIAL_C, CITY_POWER_LV_TOU, EKURHULENI_MUNICIPAL_E_TOU_8FS };
