import re, json, os, subprocess

SRC_DIR = "/sessions/beautiful-stoic-allen/mnt/uploads"
FILES = [
    "June 25.pdf", "July 25.pdf", "August 25.pdf", "Sep 25.pdf", "Oct 25.pdf", "Nov 25.pdf",
    "Dec 25.pdf", "Jan 26.pdf", "Feb 26.pdf", "March 26.pdf", "April 26.pdf", "May 26.pdf",
    "wingfield june ekurhuleni.pdf",
]

# A "charge row" is any line ending in 3 whitespace-separated decimal numbers (excl VAT, VAT,
# incl VAT) - deliberately label-agnostic so it also picks up the one-off "INTERIM"/"INTERIM
# REVERSAL" water & sewer adjustment lines (confirmed present in the Nov 2025/Dec 2025/Jan 2026
# statements only - an estimated-reading correction, not present every month) without needing to
# hardcode every label variant EMM's system happens to print.
CHARGE_ROW = re.compile(r"(-?[\d,]+\.\d\d)\s+(-?[\d,]+\.\d\d)\s+(-?[\d,]+\.\d\d)\s*$", re.MULTILINE)


def num(s):
    return float(s.replace(",", ""))


def to_iso(yy_mm_dd):
    # "25/06/01" -> "2025-06-01" (statements only ever fall in 2025/2026, safe to prefix "20").
    yy, mm, dd = yy_mm_dd.split("/")
    return f"20{yy}-{mm}-{dd}"


def first_reading_period(section_text):
    m = re.search(r"Curr (\d\d/\d\d/\d\d) Prev (\d\d/\d\d/\d\d)", section_text)
    if not m:
        return None
    return [to_iso(m.group(2)), to_iso(m.group(1))]  # [start, end] = [prev, curr]


# Every physical page of these statements repeats the same property-info header at the top and
# the same aging-table + remittance-advice footer at the bottom (confirmed: "Area m2 NNNNNN" and
# "30 Days ... Page: N of M" both appear once per page, verbatim, regardless of which section's
# line items that page happens to be showing). Left un-stripped, that repetition breaks section
# boundary detection outright - e.g. "ELECTRICITY SERVICE" content genuinely continues from page 1
# onto page 2, but the page-1 aging-table footer (which is NOT the true end of the electricity
# section) would otherwise be matched as if it were. Stripping each page down to just the part
# between its own header and footer - then concatenating those - reconstructs one continuous
# itemised-charges document with the boilerplate removed, which section-boundary matching can then
# be trusted to run against.
def itemized_text(full_text):
    pages = full_text.split("\f")
    chunks = []
    for page in pages:
        h = re.search(r"Area m2\s+\d+", page)
        f = re.search(r"30 Days", page)
        if not h or not f or f.start() <= h.end():
            continue
        chunks.append(page[h.end():f.start()])
    return "\n".join(chunks)


def sum_section(text, start_marker, end_markers):
    i = text.find(start_marker)
    if i == -1:
        return 0.0, 0.0, 0.0
    i += len(start_marker)
    end = len(text)
    for em in end_markers:
        j = text.find(em, i)
        if j != -1:
            end = min(end, j)
    chunk = text[i:end]
    excl = vat = incl = 0.0
    for e, v, ic in CHARGE_ROW.findall(chunk):
        excl += num(e); vat += num(v); incl += num(ic)
    return round(excl, 2), round(vat, 2), round(incl, 2)


def extract(fname):
    text = subprocess.run(["pdftotext", "-layout", os.path.join(SRC_DIR, fname), "-"],
                           capture_output=True, text=True, check=True).stdout

    account_number = re.search(r"Account Number\s+(\d+)", text).group(1)
    m = re.search(r"([\d.]+)\s+([\d.]+)\s+(\d{4}-\d{2}-\d{2})", text)
    statement_date = m.group(3)
    due_date = re.search(r"Due Date\s+(\d{4}-\d{2}-\d{2})", text).group(1)
    mv = re.search(r"W ITKOPPIE[^\n]*?(\d{6,})", text)
    market_value = float(mv.group(1)) if mv else None
    tcl = re.search(r"TOTAL CURRENT LEVY\s+([\d.]+)", text)
    total_current_levy = num(tcl.group(1)) if tcl else None

    items = itemized_text(text)

    # Property rates - VAT-exempt (2 trailing numbers only: excl_vat, incl_vat - handled as its own
    # pattern rather than the generic 3-number CHARGE_ROW).
    pr = re.search(r"PROPERTY RATES BUSINESS & COMMERCIAL\s+([\d.]+)\s+([\d.]+)", items)
    property_rates = {"excl_vat": num(pr.group(1)), "vat": 0.0, "incl_vat": num(pr.group(2))} if pr else \
        {"excl_vat": 0.0, "vat": 0.0, "incl_vat": 0.0}

    # One-off penalty/notice fees appearing in the ledger area before "PROPERTY RATES" (seen once,
    # Oct 2025's "FINAL NOTICE" fee) - bucketed as sundry since they're neither a utility charge nor
    # part of the arrears ledger itself.
    sundry_excl = sundry_vat = sundry_incl = 0.0
    ledger_end = items.find("PROPERTY RATES")
    ledger_text = items[:ledger_end] if ledger_end != -1 else ""
    for lm in re.finditer(r"(FINAL NOTICE|PENALTY|ADMIN FEE)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)", ledger_text):
        sundry_excl += num(lm.group(2)); sundry_vat += num(lm.group(3)); sundry_incl += num(lm.group(4))

    # Wingfield's Ekurhuleni account is a Time-of-Use tariff (Peak/Standard/Off-peak), NOT flat -
    # confirmed wrong in an earlier pass of this script and corrected against a reference table the
    # client independently rebuilt from the same invoices. Each statement has exactly 3 energy
    # (kWh) charge lines read off 3 separate registers - but which physical meter-serial prefix
    # (the invoice prints "METER-NO P015523700"/"S015523700"/"O015523700"/"D015523700" tags) maps to
    # which TOU category can't be trusted from pdftotext's linearised text: a meter's own tag and
    # its reading routinely land on opposite sides of a page break, so the tag immediately
    # preceding a kWh line in the extracted text is not reliably that line's own meter.
    #
    # Instead, each line is classified by its own rate (Rand per kWh), which is unambiguous: Peak
    # is always far above Standard, which is always above Off-peak (confirmed against every month
    # the client's table covers, Jul 2025 - Jun 2026 - e.g. Aug 2025's 3 rates R10.49/R3.04/R1.86
    # sort straight into Peak/Standard/Off-peak with no overlap ever seen between categories across
    # 13 months, including the low-season/high-season rate change each month picks up
    # automatically since it's the *rate*, not a fixed threshold, driving the sort).
    kwh_lines = []
    for q, e, v, ic in re.findall(r"([\d.]+) kW h\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)", items):
        q, e, v, ic = num(q), num(e), num(v), num(ic)
        kwh_lines.append((e / q if q else 0, q, e, v, ic))
    kwh_lines.sort(key=lambda r: r[0])  # ascending rate: off-peak, standard, peak
    zero = (0.0, 0.0, 0.0, 0.0)
    off_peak = kwh_lines[0][1:] if len(kwh_lines) > 0 else zero
    standard = kwh_lines[1][1:] if len(kwh_lines) > 1 else zero
    peak = kwh_lines[2][1:] if len(kwh_lines) > 2 else zero
    energy_qty = sum(l[1] for l in kwh_lines)

    demand_qty = demand_excl = demand_vat = demand_incl = 0.0
    for q, e, v, ic in re.findall(r"([\d.]+) kVa\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)", items):
        demand_qty += num(q); demand_excl += num(e); demand_vat += num(v); demand_incl += num(ic)
    fc = re.search(r"FIXED CHARGE\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)", items)
    service_excl = num(fc.group(1)) if fc else 0.0
    nac = re.search(r"NETW ORK ACCESS CHARGE\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)", items)
    network_excl = num(nac.group(1)) if nac else 0.0

    elec_section_end = items.find("REFUSE REMOVAL")
    if elec_section_end == -1: elec_section_end = items.find("WATER SERVICE")
    if elec_section_end == -1: elec_section_end = items.find("SEWERAGE")
    elec_section_text = items[items.find("ELECTRICITY SERVICE"):elec_section_end if elec_section_end != -1 else len(items)]
    elec_excl, elec_vat, elec_incl = sum_section(items, "ELECTRICITY SERVICE", ["REFUSE REMOVAL", "WATER SERVICE", "SEWERAGE"])
    refuse_excl, refuse_vat, refuse_incl = sum_section(items, "REFUSE REMOVAL", ["WATER SERVICE", "SEWERAGE"])
    water_excl, water_vat, water_incl = sum_section(items, "WATER SERVICE", ["SEWERAGE"])
    sewer_excl, sewer_vat, sewer_incl = sum_section(items, "SEWERAGE", [])

    water_section_end = items.find("SEWERAGE", items.find("WATER SERVICE"))
    water_section_text = items[items.find("WATER SERVICE"):water_section_end if water_section_end != -1 else len(items)]
    water_qty = sum(num(q) for q in re.findall(r"(?:W ATER|INTERIM(?: REVERSAL)?) (\d+(?:\.\d+)?) ?[Kk]l", water_section_text))

    elec_reading_period = first_reading_period(elec_section_text)
    water_reading_period = first_reading_period(water_section_text)

    computed_total_incl = round(
        property_rates["incl_vat"] + elec_incl + water_incl + sewer_incl + refuse_incl + sundry_incl, 2)

    return {
        "file": fname,
        "account": account_number,
        "address": "0 Jones St, Witkoppie 64-IR",
        "market_value": market_value,
        "statement_date": statement_date,
        "statement_for": statement_date[:7],
        "due_date": due_date,
        "invoice_number": f"{account_number}-{statement_date}",
        "property_rates": property_rates,
        "electricity": {
            "reading_period": elec_reading_period,
            "consumption_kwh": round(energy_qty, 3),
            "consumption_kvarh": round(demand_qty, 3),
            "tariff_type": "TOU",
            "excl_vat": elec_excl, "vat": elec_vat, "incl_vat": elec_incl,
            "lines": {
                "off_peak_qty": round(off_peak[0], 3), "off_peak": round(off_peak[1], 2),
                "standard_qty": round(standard[0], 3), "standard": round(standard[1], 2),
                "peak_qty": round(peak[0], 3), "peak": round(peak[1], 2),
                "demand_qty": round(demand_qty, 3), "demand": round(demand_excl, 2),
                "service": round(service_excl, 2), "network_surcharge": round(network_excl, 2),
            },
        },
        "water": {
            "reading_period": water_reading_period,
            "consumption_kl": round(water_qty, 2),
            "water_excl_vat": water_excl, "sanitation_excl_vat": sewer_excl,
            "vat": round(water_vat + sewer_vat, 2),
        },
        "refuse": {"excl_vat": refuse_excl, "vat": refuse_vat, "incl_vat": refuse_incl},
        "sundry": {"excl_vat": round(sundry_excl, 2), "vat": round(sundry_vat, 2), "incl_vat": round(sundry_incl, 2)},
        "grand_total_incl_vat": computed_total_incl,
        "_total_current_levy_from_pdf": total_current_levy,
        "_reconciliation_delta": round(computed_total_incl - (total_current_levy or 0), 2),
    }


records = []
for f in FILES:
    rec = extract(f)
    records.append(rec)
    print(f"{f:15s} statement_date={rec['statement_date']} computed={rec['grand_total_incl_vat']:.2f} "
          f"pdf_total_current_levy={rec['_total_current_levy_from_pdf']} delta={rec['_reconciliation_delta']}")

out_path = "/sessions/beautiful-stoic-allen/mnt/outputs/wingfield_municipal_statements_raw.json"
with open(out_path, "w") as fh:
    json.dump(records, fh, indent=1)
print("Wrote", out_path)
