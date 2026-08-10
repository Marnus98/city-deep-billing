// pdf.js - a minimal, dependency-free PDF writer.
// Only what's needed for a clean, single-page A4 billing slip: text (Helvetica / Helvetica-Bold,
// base-14 fonts so nothing needs to be embedded), straight lines, filled rectangles and (now) a
// single embedded logo image (see logo_asset.js / registerImage()).
// Written by hand because this sandbox's package registry access was too unreliable to install
// a PDF library (see README "Known environment limitations") - production deployments should
// swap this for pdfkit/puppeteer once normal npm access is available; the raw PDF this produces
// is fully spec-valid in the meantime (verified by re-rendering it with poppler/pdftoppm).
const LOGO = require('./logo_asset');
const { daysBetween, LONG_PERIOD_DAYS } = require('./municipal_compare');

function escapePdfText(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// Standard Helvetica / Helvetica-Bold glyph widths (per 1000-unit em square, from the base-14 AFM
// metrics every PDF viewer ships with). Only the characters that actually appear in money strings
// and column headers are listed - textWidth() below falls back to the digit width (556) for
// anything else, which is close enough for the all-caps/number text this app ever right-aligns.
const HELV_WIDTHS = {
  ' ': 278, ',': 278, '.': 278, '-': 333, '/': 278, ':': 278, R: 722, K: 722, L: 556, W: 944, h: 556,
  0: 556, 1: 556, 2: 556, 3: 556, 4: 556, 5: 556, 6: 556, 7: 556, 8: 556, 9: 556,
};
const HELV_BOLD_WIDTHS = {
  ' ': 278, ',': 278, '.': 278, '-': 333, '/': 278, ':': 278, R: 722, K: 722, L: 611, W: 1000, h: 611,
  0: 556, 1: 556, 2: 556, 3: 556, 4: 556, 5: 556, 6: 556, 7: 556, 8: 556, 9: 556,
};
function textWidth(str, { bold = false, size = 10 } = {}) {
  const table = bold ? HELV_BOLD_WIDTHS : HELV_WIDTHS;
  let units = 0;
  for (const ch of String(str ?? '')) units += table[ch] ?? 556;
  return (units / 1000) * size;
}

const PAGE_W = 595.28; // A4 pt
const PAGE_H = 841.89;

class PDFDoc {
  constructor() {
    this.pages = [[]]; // one ops array per page - see newPage()
    this.page = { width: PAGE_W, height: PAGE_H };
    this.images = new Map(); // key -> { width, height, hex } - see registerImage()/image()
  }
  get currentOps() { return this.pages[this.pages.length - 1]; }
  // Starts a new page (used to put the 12-month trend chart on its own page so it never has to
  // fight the electricity/water tables above it for vertical space).
  newPage() { this.pages.push([]); return this; }
  // Registers a raw-RGB image (see logo_asset.js for how the source bitmap is prepared) as a PDF
  // Image XObject, keyed by `key` so the same image can be referenced from multiple draw() calls
  // or pages without re-embedding it. The whole build() pipeline works on plain JS strings that
  // get utf8-encoded at the very end (see build()), so raw image bytes can't be dropped in as-is
  // (multi-byte utf8 would corrupt them) - hex-encoding keeps the stream pure ASCII while staying
  // spec-valid via the standard /ASCIIHexDecode + /FlateDecode filter chain.
  registerImage(key, { width, height, deflatedRgbBase64 }) {
    if (!this.images.has(key)) {
      const hex = Buffer.from(deflatedRgbBase64, 'base64').toString('hex').toUpperCase();
      this.images.set(key, { width, height, hex });
    }
    return key;
  }
  // Draws a previously-registered image into the box (x, y) to (x+w, y+h) - y is the BOTTOM edge,
  // matching the `rect()` convention below, not the top.
  image(x, y, w, h, key) {
    this.currentOps.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /${key} Do Q`);
    return this;
  }
  text(x, y, str, { size = 10, bold = false, angle = 0 } = {}) {
    const font = bold ? 'F2' : 'F1';
    if (angle) {
      // Rotated text (used for the vertical "Rand" axis label) needs its own little transform
      // matrix around the BT/ET block rather than the plain Td translation used everywhere else.
      const rad = (angle * Math.PI) / 180;
      const cos = Math.cos(rad).toFixed(4), sin = Math.sin(rad).toFixed(4), nsin = (-Math.sin(rad)).toFixed(4);
      this.currentOps.push(`q ${cos} ${sin} ${nsin} ${cos} ${x.toFixed(2)} ${y.toFixed(2)} cm BT /${font} ${size} Tf 0 0 Td (${escapePdfText(str)}) Tj ET Q`);
    } else {
      this.currentOps.push(`BT /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${escapePdfText(str)}) Tj ET`);
    }
    return this;
  }
  line(x1, y1, x2, y2, width = 0.75, { color } = {}) {
    const colorOp = color ? `${color[0]} ${color[1]} ${color[2]} RG ` : '';
    this.currentOps.push(`${colorOp}${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
    return this;
  }
  rect(x, y, w, h, { fill } = {}) {
    if (fill) {
      const [r, g, b] = fill;
      this.currentOps.push(`${r} ${g} ${b} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
    } else {
      this.currentOps.push(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S`);
    }
    return this;
  }
  build() {
    const objects = [];
    const catalogIdx = objects.length; objects.push(null); // 1
    const pagesIdx = objects.length; objects.push(null); // 2
    const f1Idx = objects.length; objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); // 3
    const f2Idx = objects.length; objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'); // 4

    // Image XObjects (e.g. the HolmStone logo) - registered once via registerImage(), referenced
    // by every page's /Resources so any page can `Do` them regardless of which page called image().
    const imageObjNums = {};
    for (const [key, img] of this.images) {
      const idx = objects.length;
      objects.push(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter [/ASCIIHexDecode /FlateDecode] /Length ${img.hex.length + 1} >>\nstream\n${img.hex}>\nendstream`);
      imageObjNums[key] = idx + 1;
    }
    const xobjectDict = Object.keys(imageObjNums).length
      ? ` /XObject << ${Object.entries(imageObjNums).map(([k, n]) => `/${k} ${n} 0 R`).join(' ')} >>`
      : '';

    const pageObjNums = [];
    for (const pageOps of this.pages) {
      const pageIdx = objects.length; objects.push(null); // reserved, filled in below
      const contentIdx = objects.length;
      const content = pageOps.join('\n');
      const streamBytes = Buffer.byteLength(content, 'utf8');
      objects.push(`<< /Length ${streamBytes} >>\nstream\n${content}\nendstream`);
      objects[pageIdx] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.page.width} ${this.page.height}] /Resources << /Font << /F1 ${f1Idx + 1} 0 R /F2 ${f2Idx + 1} 0 R >>${xobjectDict} >> /Contents ${contentIdx + 1} 0 R >>`;
      pageObjNums.push(pageIdx + 1);
    }
    objects[catalogIdx] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[pagesIdx] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => n + ' 0 R').join(' ')}] /Count ${pageObjNums.length} >>`;

    let out = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((obj, i) => {
      offsets.push(Buffer.byteLength(out, 'utf8'));
      out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    });
    const xrefStart = Buffer.byteLength(out, 'utf8');
    out += `xref\n0 ${objects.length + 1}\n`;
    out += '0000000000 65535 f \n';
    for (let i = 1; i <= objects.length; i++) {
      out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    }
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
    return Buffer.from(out, 'utf8');
  }
}

function money(n) {
  // Manual formatting (not toLocaleString) because the PDF base-14 fonts only support the
  // WinAnsi/Latin-1 glyph range - locale thousands separators can fall outside it and render
  // as a stray glyph.
  const v = Number(n || 0);
  const neg = v < 0;
  const fixed = Math.abs(v).toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}R ${withCommas}.${decPart}`;
}

// Compact currency formatting for chart axis ticks/labels - no decimals, but with the "R" prefix
// so each electricity/water/sanitation graph reads unambiguously as Rand on its own, without
// requiring the reader to cross-reference the "Rand" axis caption.
function moneyShort(n) {
  const v = Math.round(Number(n || 0));
  const neg = v < 0;
  return (neg ? '-R ' : 'R ') + Math.abs(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Compact quantity formatting for the consumption (kWh / kL) trend charts - same comma-grouping
// as moneyShort but with a unit suffix instead of a currency prefix.
function qtyShort(n, unit) {
  const v = Math.round(Number(n || 0));
  const neg = v < 0;
  return (neg ? '-' : '') + Math.abs(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' ' + unit;
}

const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function shortMonthLabel(label) {
  // "2026-04" -> "APR 26"
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (!m) return label;
  const [, y, mo] = m;
  return `${MONTH_ABBR[parseInt(mo, 10) - 1]} ${y.slice(2)}`;
}

// Stacked bar chart: one bar per month, split Electricity / Water / Sanitation, with the total
// (excl. VAT) labelled above each bar - reproduces the layout of the tenant's existing "Utility
// Cost Excluding VAT" report so this page looks familiar rather than inventing a new format.
// `series`: chronological array of { label, elec, water, sanitation } (label like "2026-04").
function drawTrendChart(doc, { x, y, width, height, series }) {
  const COLOR_ELEC = [0.11, 0.16, 0.34];
  const COLOR_WATER = [0.13, 0.62, 0.35];
  const COLOR_SAN = [0.93, 0.55, 0.09];

  // A month with no statement at all has elec/water/sanitation all null (see monthLabelRange/
  // monthlyTrendForSite/monthlyTrendForMunicipal in server.js) - excluded from both the max-value
  // scale and the totals-label, and its column is left blank below, rather than plotting it as a
  // genuine R0 month (which would misleadingly look identical to a month that really billed R0).
  const totals = series.map((s) => (s.elec == null ? null : (s.elec || 0) + (s.water || 0) + (s.sanitation || 0)));
  const maxVal = Math.max(1, ...totals.filter((t) => t != null));
  const chartBottom = y - height;
  const n = series.length || 1;
  const colWidth = width / n;
  const barWidth = Math.min(30, colWidth * 0.55);

  // Legend, top-right of the chart block.
  const legendItems = [['Sanitation', COLOR_SAN], ['Water', COLOR_WATER], ['Electricity', COLOR_ELEC]];
  let lx = x + width - 190;
  const ly = y + 16;
  for (const [label, color] of legendItems) {
    doc.rect(lx, ly, 7, 7, { fill: color });
    doc.text(lx + 10, ly + 1, label, { size: 8 });
    lx += 65;
  }

  // Y-axis gridlines + tick labels (4 bands), right-aligned so the "R" prefix doesn't push the
  // longer labels into the chart area.
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const v = (maxVal * t) / ticks;
    const ty = chartBottom + (height * t) / ticks;
    doc.line(x, ty, x + width, ty, 0.4, { color: [0.85, 0.85, 0.85] });
    const label = moneyShort(v);
    doc.text(x - 6 - textWidth(label, { size: 6 }), ty - 3, label, { size: 6 });
  }
  doc.text(x - 62, chartBottom + height / 2 - 15, 'Rand', { size: 8, bold: true, angle: 90 });

  series.forEach((s, i) => {
    const colX = x + i * colWidth + (colWidth - barWidth) / 2;
    // No statement this month at all - leave the column blank (no bars, no total label) but still
    // print the month tick below, so the gap reads as "no data" rather than "nothing happened".
    if (s.elec != null) {
      const elecH = ((s.elec || 0) / maxVal) * height;
      const waterH = ((s.water || 0) / maxVal) * height;
      const sanH = ((s.sanitation || 0) / maxVal) * height;
      let by = chartBottom;
      doc.rect(colX, by, barWidth, elecH, { fill: COLOR_ELEC }); by += elecH;
      doc.rect(colX, by, barWidth, waterH, { fill: COLOR_WATER }); by += waterH;
      doc.rect(colX, by, barWidth, sanH, { fill: COLOR_SAN }); by += sanH;
      const total = totals[i];
      if (total > 0) {
        const label = moneyShort(total);
        doc.text(colX + barWidth / 2 - textWidth(label, { size: 6, bold: true }) / 2, by + 4, label, { size: 6, bold: true });
      }
    } else {
      doc.text(colX + barWidth / 2 - textWidth('no data', { size: 6 }) / 2, chartBottom + 4, 'no data', { size: 6 });
    }
    doc.text(x + i * colWidth + colWidth / 2 - 16, chartBottom - 14, shortMonthLabel(s.label), { size: 6.5 });
  });

  doc.line(x, chartBottom, x + width, chartBottom, 0.75);
}

// Single-series bar chart - same visual language as drawTrendChart (gridlines, value-above-bar
// labels, month labels) but only one colour/category, scaled to its OWN max rather than a shared
// stacked max, so a category with much smaller values (e.g. Water/Sanitation next to Electricity,
// or kL next to kWh) isn't squashed flat at the bottom of the chart. `formatValue` defaults to the
// Rand formatter but can be swapped for qtyShort() to reuse this same chart for consumption trends.
function drawSingleSeriesChart(doc, { x, y, width, height, series, seriesKey, color, formatValue = moneyShort, maxOverride }) {
  // null (see monthLabelRange/monthlyTrendForSite/monthlyTrendForMunicipal in server.js) means no
  // statement at all that month - excluded from the max-value scale, and its column is left blank
  // below instead of plotted as a genuine 0.
  //
  // maxOverride - lets the caller force this chart's Y-axis to a scale computed from somewhere
  // other than just this one series (see server.js's site-billing-pdf/municipal-billing-pdf
  // routes: the tenant billing PDF and the municipal statement PDF for the same property/category
  // now share one axis, computed from BOTH trends' data, so a bar is visually comparable between
  // the two documents instead of each PDF silently rescaling to its own numbers).
  const values = series.map((s) => s[seriesKey]).filter((v) => v != null);
  const maxVal = maxOverride != null ? Math.max(1, maxOverride) : Math.max(1, ...values);
  const chartBottom = y - height;
  const n = series.length || 1;
  const colWidth = width / n;
  const barWidth = Math.min(28, colWidth * 0.55);

  const ticks = 3;
  for (let t = 0; t <= ticks; t++) {
    const v = (maxVal * t) / ticks;
    const ty = chartBottom + (height * t) / ticks;
    doc.line(x, ty, x + width, ty, 0.4, { color: [0.85, 0.85, 0.85] });
    const label = formatValue(v);
    doc.text(x - 6 - textWidth(label, { size: 6 }), ty - 3, label, { size: 6 });
  }

  series.forEach((s, i) => {
    const colX = x + i * colWidth + (colWidth - barWidth) / 2;
    const val = s[seriesKey];
    if (val == null) {
      doc.text(colX + barWidth / 2 - textWidth('no data', { size: 6 }) / 2, chartBottom + 4, 'no data', { size: 6 });
      doc.text(x + i * colWidth + colWidth / 2 - 16, chartBottom - 12, shortMonthLabel(s.label), { size: 6 });
      return;
    }
    const h = (val / maxVal) * height;
    doc.rect(colX, chartBottom, barWidth, h, { fill: color });
    if (val > 0) {
      const label = formatValue(val);
      doc.text(colX + barWidth / 2 - textWidth(label, { size: 6, bold: true }) / 2, chartBottom + h + 4, label, { size: 6, bold: true });
    }
    doc.text(x + i * colWidth + colWidth / 2 - 16, chartBottom - 12, shortMonthLabel(s.label), { size: 6 });
  });

  doc.line(x, chartBottom, x + width, chartBottom, 0.75);
}

// Three stacked single-series charts (Electricity / Water / Sanitation), each with its own colour
// swatch + label as a mini-heading and its own Y-axis scale - replaces the single combined
// stacked-bar chart so each utility's trend is legible on its own terms instead of all three
// competing for the same axis.
function drawTripleTrendCharts(doc, { x, y, width, series, maxOverrides }) {
  const COLOR_ELEC = [0.11, 0.16, 0.34];
  const COLOR_WATER = [0.13, 0.62, 0.35];
  const COLOR_SAN = [0.93, 0.55, 0.09];
  const defs = [
    { key: 'elec', label: 'Electricity', color: COLOR_ELEC },
    { key: 'water', label: 'Water', color: COLOR_WATER },
    { key: 'sanitation', label: 'Sanitation', color: COLOR_SAN },
  ];
  const chartHeight = 150;
  let cy = y;
  for (const def of defs) {
    doc.rect(x, cy - 7, 7, 7, { fill: def.color });
    doc.text(x + 11, cy - 6, def.label, { size: 9.5, bold: true });
    cy -= 20;
    drawSingleSeriesChart(doc, {
      x: x + 46, y: cy, width: width - 46, height: chartHeight, series, seriesKey: def.key, color: def.color,
      maxOverride: maxOverrides ? maxOverrides[def.key] : null,
    });
    cy -= chartHeight + 14 + 26;
  }
}

// Two stacked single-series charts (Electricity kWh / Water kL) - same layout as
// drawTripleTrendCharts but for physical consumption instead of Rand cost, so a tenant can see
// usage trends independent of tariff changes. Water consumption is stored in m3 in the schema,
// which is numerically identical to kL (1 m3 = 1 kL), so waterM3 is simply labelled "kL".
function drawConsumptionTrendCharts(doc, { x, y, width, series, maxOverrides }) {
  const COLOR_ELEC = [0.11, 0.16, 0.34];
  const COLOR_WATER = [0.13, 0.62, 0.35];
  const defs = [
    { key: 'elecKwh', label: 'Electricity (kWh)', color: COLOR_ELEC, unit: 'kWh' },
    { key: 'waterM3', label: 'Water (kL)', color: COLOR_WATER, unit: 'kL' },
  ];
  const chartHeight = 170;
  let cy = y;
  for (const def of defs) {
    doc.rect(x, cy - 7, 7, 7, { fill: def.color });
    doc.text(x + 11, cy - 6, def.label, { size: 9.5, bold: true });
    cy -= 20;
    drawSingleSeriesChart(doc, {
      x: x + 46, y: cy, width: width - 46, height: chartHeight, series, seriesKey: def.key, color: def.color,
      formatValue: (v) => qtyShort(v, def.unit),
      maxOverride: maxOverrides ? maxOverrides[def.key] : null,
    });
    cy -= chartHeight + 14 + 30;
  }
}

// Builds the billing slip PDF for one bill. `data` shape - see server.js buildBillPdfData().
function buildBillingSlipPdf(data) {
  const doc = new PDFDoc();
  const left = 42, right = PAGE_W - 42;
  let y = PAGE_H - 50;
  const propertyName = (data.propertyName || 'CITY DEEP INDUSTRIAL PARK').toUpperCase();

  // Logo, top-right corner - sized so it (and its whitespace-trimmed bounding box) sits entirely
  // above the two-column tenant-info rows below, never overlapping them (see the y-jump right
  // after the title/subtitle, which clears the divider line past the logo's bottom edge).
  doc.registerImage('Logo', LOGO);
  const logoW = 90, logoH = logoW * (LOGO.height / LOGO.width);
  doc.image(right - logoW, PAGE_H - 32 - logoH, logoW, logoH, 'Logo');

  doc.text(left, y, propertyName, { size: 16, bold: true }); y -= 14;
  doc.text(left, y, 'Utility Billing Statement', { size: 10 });
  y = Math.min(y - 8, PAGE_H - 32 - logoH - 9); // clear the logo before the header divider
  doc.line(left, y, right, y); y -= 18;

  doc.text(left, y, 'Tenant:', { bold: true }); doc.text(left + 90, y, data.tenantName);
  doc.text(right - 180, y, 'Invoice No:', { bold: true }); doc.text(right - 100, y, data.invoiceNumber); y -= 15;
  doc.text(left, y, 'Unit / Site:', { bold: true }); doc.text(left + 90, y, data.unit || '-');
  doc.text(right - 180, y, 'Billing Month:', { bold: true }); doc.text(right - 100, y, data.periodLabel); y -= 15;
  const tenantDays = daysBetween(data.startDate, data.endDate);
  const tenantReadingPeriodStr = `${data.startDate} to ${data.endDate}${tenantDays != null && tenantDays > LONG_PERIOD_DAYS ? ` (${tenantDays} days)` : ''}`;
  doc.text(left, y, 'Account No:', { bold: true }); doc.text(left + 90, y, data.accountNumber || '-');
  doc.text(right - 180, y, 'Reading Period:', { bold: true }); doc.text(right - 100, y, tenantReadingPeriodStr); y -= 15;
  doc.text(left, y, 'VAT No:', { bold: true }); doc.text(left + 90, y, data.vatNumber || '-');
  doc.text(right - 180, y, 'Due Date:', { bold: true }); doc.text(right - 100, y, data.dueDate || '-'); y -= 20;

  doc.line(left, y, right, y); y -= 18;

  // Electricity block
  doc.text(left, y, 'ELECTRICITY', { size: 12, bold: true }); y -= 16;
  doc.text(left, y, `Consumption: ${data.elecConsumption} kWh`, { size: 9 }); y -= 14;
  y = drawLineItemsTable(doc, data.elecLineItems, left, right, y);
  y -= 6;

  // Water block
  doc.text(left, y, 'WATER & SANITATION', { size: 12, bold: true }); y -= 16;
  doc.text(left, y, `Consumption: ${data.waterConsumption} m3`, { size: 9 }); y -= 14;
  y = drawLineItemsTable(doc, data.waterLineItems, left, right, y);
  y -= 10;

  // Subtotal / VAT / Total - all three amounts right-aligned to the same `right` edge (using the
  // real Helvetica glyph widths from textWidth(), not a fixed left offset), so they line up in a
  // column regardless of the bold/larger TOTAL PAYABLE row being visually wider text.
  doc.line(left, y, right, y); y -= 16;
  const subtotalStr = money(data.subtotal);
  doc.text(right - 220, y, 'Subtotal (excl. VAT)', {});
  doc.text(right - textWidth(subtotalStr, { size: 10 }), y, subtotalStr); y -= 14;
  const vatStr = money(data.vatAmount);
  doc.text(right - 220, y, `VAT (${(data.vatRate * 100).toFixed(0)}%)`, {});
  doc.text(right - textWidth(vatStr, { size: 10 }), y, vatStr); y -= 14;
  doc.line(right - 220, y + 11, right, y + 11);
  const totalStr = money(data.total);
  doc.text(right - 220, y, 'TOTAL PAYABLE', { bold: true, size: 12 });
  doc.text(right - textWidth(totalStr, { size: 12, bold: true }), y, totalStr, { bold: true, size: 12 }); y -= 26;

  // Second page: rolling utility-cost (Rand) trend chart, only when there's more than one month
  // of history to show (a brand-new tenant's very first bill would just be a single flat bar).
  if (data.monthlyTrend && data.monthlyTrend.length > 1) {
    doc.newPage();
    let ty = PAGE_H - 50;
    doc.text(left, ty, propertyName, { size: 16, bold: true }); ty -= 14;
    doc.text(left, ty, `Utility Cost Excluding VAT - ${data.tenantName}`, { size: 11, bold: true }); ty -= 8;
    doc.line(left, ty, right, ty); ty -= 30;
    drawTripleTrendCharts(doc, { x: left + 46, y: ty, width: right - left - 46, series: data.monthlyTrend });

    // Third page: consumption (kWh / kL) trend, independent of tariff/Rand value entirely.
    doc.newPage();
    let cy = PAGE_H - 50;
    doc.text(left, cy, propertyName, { size: 16, bold: true }); cy -= 14;
    doc.text(left, cy, `Consumption Trend - ${data.tenantName}`, { size: 11, bold: true }); cy -= 8;
    doc.line(left, cy, right, cy); cy -= 30;
    drawConsumptionTrendCharts(doc, { x: left + 46, y: cy, width: right - left - 46, series: data.monthlyTrend });
  }

  return doc.build();
}

function drawLineItemsTable(doc, items, left, right, y) {
  doc.text(left, y, 'Description', { bold: true, size: 9 });
  doc.text(right - 90, y, 'Amount (excl.)', { bold: true, size: 9 });
  y -= 4;
  doc.line(left, y, right, y);
  y -= 12;
  for (const it of items) {
    doc.text(left, y, it.description, { size: 9 });
    doc.text(right - 90, y, money(it.amount), { size: 9 });
    y -= 12;
  }
  const subtotal = items.reduce((s, i) => s + i.amount, 0);
  doc.line(left, y + 4, right, y + 4);
  doc.text(left, y - 6, 'Section subtotal', { bold: true, size: 9 });
  doc.text(right - 90, y - 6, money(subtotal), { bold: true, size: 9 });
  return y - 20;
}

// Builds the PDF for one City of Johannesburg municipal statement (or a synthetic "All Accounts
// Combined" statement - see municipal_compare.js buildCombinedStatement). Same visual language as
// buildBillingSlipPdf: a breakdown table on page 1, a trailing trend chart on page 2 reusing the
// exact same drawTrendChart the tenant bill uses, just fed the municipal Electricity/Water/
// Sanitation totals instead of tenant-billed ones.
function buildMunicipalStatementPdf(data) {
  const doc = new PDFDoc();
  const left = 42, right = PAGE_W - 42;
  let y = PAGE_H - 50;
  const propertyName = (data.propertyName || 'CITY DEEP INDUSTRIAL PARK').toUpperCase();

  const municipalityName = data.municipalityName || 'the municipality';
  doc.text(left, y, propertyName, { size: 16, bold: true }); y -= 14;
  doc.text(left, y, `Municipal Account Statement (${municipalityName})`, { size: 10 }); y -= 8;
  doc.line(left, y, right, y); y -= 18;

  doc.text(left, y, 'Account:', { bold: true }); doc.text(left + 90, y, data.accountLabel);
  doc.text(right - 180, y, 'Statement For:', { bold: true }); doc.text(right - 90, y, data.statementFor); y -= 15;
  doc.text(left, y, 'Account No:', { bold: true }); doc.text(left + 90, y, data.accountNumber || '-');
  doc.text(right - 180, y, 'Invoice No:', { bold: true }); doc.text(right - 90, y, data.invoiceNumber || (data.matchedAccounts ? `${data.matchedAccounts.length} accounts combined` : '-')); y -= 15;
  doc.text(left, y, 'Address:', { bold: true }); doc.text(left + 90, y, data.address || '-');
  doc.text(right - 180, y, 'Issued:', { bold: true }); doc.text(right - 90, y, data.statementDate || '-'); y -= 15;
  doc.text(left, y, 'Tariff:', { bold: true });
  doc.text(left + 90, y, data.tariffType === 'TOU' ? 'Time-of-Use' : data.tariffType === 'mixed' ? 'Mixed (combined accounts)' : 'Flat-rate'); y -= 20;

  doc.line(left, y, right, y); y -= 18;

  const colCons = right - 260, colExcl = right - 175, colVat = right - 90, colTotal = right;
  const headerRow = (label1, label2) => {
    doc.text(left, y, label1 || 'Category', { bold: true, size: 9 });
    doc.text(colCons - 40, y, 'Consumption', { bold: true, size: 9 });
    doc.text(colExcl - 40, y, 'Excl. VAT', { bold: true, size: 9 });
    doc.text(colVat - 30, y, 'VAT', { bold: true, size: 9 });
    doc.text(colTotal - 55, y, 'Total', { bold: true, size: 9 });
    y -= 4; doc.line(left, y, right, y); y -= 13;
  };
  const catLine = (label, consumption, exclVat, vat, total, opts = {}) => {
    doc.text(left + (opts.indent ? 14 : 0), y, label, { size: opts.indent ? 8 : 9.5, bold: !!opts.bold });
    if (consumption != null) doc.text(colCons - 40, y, consumption, { size: opts.indent ? 8 : 9.5 });
    doc.text(colExcl - 55, y, money(exclVat), { size: opts.indent ? 8 : 9.5, bold: !!opts.bold });
    if (vat != null) doc.text(colVat - 45, y, money(vat), { size: opts.indent ? 8 : 9.5 });
    doc.text(colTotal - 70, y, money(total), { size: opts.indent ? 8 : 9.5, bold: !!opts.bold });
    y -= opts.indent ? 11 : 14;
  };

  const fmtQty = (n, unit) => n == null ? null : `${Math.abs(n) >= 1000 ? Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') : n.toFixed(1)} ${unit}`;

  headerRow();
  // Property Rates is intentionally left off this statement - it's a separate municipal charge,
  // not a utility, and the client asked for it out of the "Total Charges" picture (still recorded
  // in the DB, just not shown here or included in the total below).
  const periodSuffix = (start, end) => {
    const d = daysBetween(start, end);
    return d != null && d > LONG_PERIOD_DAYS ? `, ${d} days` : '';
  };
  catLine(`Electricity (${data.elecReadingStart || '?'} to ${data.elecReadingEnd || '?'}${periodSuffix(data.elecReadingStart, data.elecReadingEnd)})`, fmtQty(data.elecConsumptionKwh, 'kWh'), data.elecExclVat, data.elecVat, data.elecInclVat);
  for (const l of data.elecLines || []) catLine(l.label, fmtQty(l.qty, l.unit || ''), l.rand, null, l.rand, { indent: true });
  catLine(`Water (${data.waterReadingStart || '?'} to ${data.waterReadingEnd || '?'}${periodSuffix(data.waterReadingStart, data.waterReadingEnd)})`, fmtQty(data.waterConsumptionKl, 'KL'), data.waterExclVat, data.waterVat, data.waterInclVat);
  catLine('Sanitation (billed on water consumption)', fmtQty(data.waterConsumptionKl, 'KL'), data.sanitationExclVat, data.sanitationVat, data.sanitationInclVat);
  catLine('Refuse', null, data.refuseExclVat, data.refuseVat, data.refuseInclVat);
  catLine('Sundry', null, data.sundryExclVat, data.sundryVat, data.sundryInclVat);
  y -= 4; doc.line(left, y, right, y); y -= 14;
  catLine('TOTAL CHARGES', null, data.totalExclVat, data.totalVat, data.grandTotalInclVat, { bold: true });
  y -= 10;

  if (data.missingAccounts && data.missingAccounts.length) {
    doc.text(left, y, `Note: no statement found for ${data.missingAccounts.join(', ')} this month - combined totals exclude ${data.missingAccounts.length === 1 ? 'it' : 'them'}.`, { size: 7.5 });
    y -= 14;
  }
  doc.text(left, 30, `Generated: ${data.generatedAt}. This is a reformatted summary of the ${municipalityName} statement, not a replacement invoice.`, { size: 7 });

  if (data.monthlyTrend && data.monthlyTrend.length > 1) {
    doc.newPage();
    let ty = PAGE_H - 50;
    doc.text(left, ty, propertyName, { size: 16, bold: true }); ty -= 14;
    doc.text(left, ty, `Municipal Utility Cost Excluding VAT - ${data.accountLabel}`, { size: 11, bold: true }); ty -= 8;
    doc.line(left, ty, right, ty); ty -= 30;
    drawTripleTrendCharts(doc, { x: left + 40, y: ty, width: right - left - 40, series: data.monthlyTrend });
    doc.text(left, 30, `Trailing ${data.monthlyTrend.length}-statement view, ending ${data.statementFor}. Figures exclude VAT - Sanitation shown separately from Water.`, { size: 7 });
  }

  return doc.build();
}

// Builds the PDF for one flat_site billing slip - 8 Field Street, Bob Martin, Loper Road - Sandvic,
// AutoZone, Cranbrook Flavours, or any future site on this billing model (see server.js's
// /site-billing-pdf/:id and calc_flat_site.js for how `data.calc` is computed - fully data-driven
// off whatever line items that site's tariff defines, nothing here is site-specific). Same visual
// language as buildBillingSlipPdf/buildMunicipalStatementPdf, but its own 6-column table (Entry/
// Rate/Unit/Reading/Cost/Comment) since this is the one billing document in the app where the
// reading itself, the rate, and a free-text comment (the max-demand timestamp some rows carry) all
// need their own column at once - none of the existing table-drawing helpers have room for all four.
function drawSiteLineItemsTable(doc, items, left, right, y, opts = {}) {
  // The Reading column shows the meter reading after the site-vs-municipal-meter correction
  // factor has already been applied (it.adjustedReading) - i.e. the "actual" consumption the
  // tariff rate is billed against - not the raw as-entered meter reading. Raw readings still
  // live in the DB/audit trail, just not shown as a separate column here per the client's request.
  const xRate = left + 208, xUnit = left + 216, xReading = left + 323, xCost = left + 408, xComment = left + 416;
  doc.text(left, y, 'Entry', { bold: true, size: 8.5 });
  doc.text(xRate - textWidth('Rate', { bold: true, size: 8.5 }), y, 'Rate', { bold: true, size: 8.5 });
  doc.text(xUnit, y, 'Unit', { bold: true, size: 8.5 });
  doc.text(xReading - textWidth('Reading', { bold: true, size: 8.5 }), y, 'Reading', { bold: true, size: 8.5 });
  doc.text(xCost - textWidth('Cost', { bold: true, size: 8.5 }), y, 'Cost', { bold: true, size: 8.5 });
  if (!opts.noComment) doc.text(xComment, y, 'Comment', { bold: true, size: 8.5 });
  y -= 4; doc.line(left, y, right, y); y -= 12;
  for (const it of items) {
    doc.text(left, y, it.label, { size: 8.5 });
    const rateStr = money(it.rate);
    doc.text(xRate - textWidth(rateStr, { size: 8.5 }), y, rateStr, { size: 8.5 });
    doc.text(xUnit, y, it.unit, { size: 8 });
    const readingStr = it.adjustedReading.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    doc.text(xReading - textWidth(readingStr, { size: 8.5 }), y, readingStr, { size: 8.5 });
    const costStr = money(it.cost);
    doc.text(xCost - textWidth(costStr, { size: 8.5, bold: true }), y, costStr, { size: 8.5, bold: true });
    if (it.comment) doc.text(xComment, y, it.comment, { size: 7.5 });
    y -= 13;
  }
  return { y, xCost };
}

function buildSiteBillingSlipPdf(data) {
  const doc = new PDFDoc();
  const left = 42, right = PAGE_W - 42;
  let y = PAGE_H - 50;
  const propertyName = (data.propertyName || '8 FIELD STREET').toUpperCase();

  doc.registerImage('Logo', LOGO);
  const logoW = 90, logoH = logoW * (LOGO.height / LOGO.width);
  doc.image(right - logoW, PAGE_H - 32 - logoH, logoW, logoH, 'Logo');

  doc.text(left, y, propertyName, { size: 16, bold: true }); y -= 14;
  doc.text(left, y, data.subtitle || 'Utility Billing Slip', { size: 10 });
  y = Math.min(y - 8, PAGE_H - 32 - logoH - 9);
  doc.line(left, y, right, y); y -= 18;

  const slipDays = daysBetween(data.slip.start_date, data.slip.end_date);
  const readingPeriodStr = `${data.slip.start_date} to ${data.slip.end_date}${slipDays != null && slipDays > LONG_PERIOD_DAYS ? ` (${slipDays} days)` : ''}`;
  doc.text(left, y, 'Period:', { bold: true }); doc.text(left + 90, y, data.slip.label);
  doc.text(right - 180, y, 'Reading Period:', { bold: true }); doc.text(right - 100, y, readingPeriodStr); y -= 15;
  doc.text(left, y, 'Tariff:', { bold: true }); doc.text(left + 90, y, (data.tariff && data.tariff.tariff_name) || '-');
  doc.text(right - 180, y, 'Status:', { bold: true }); doc.text(right - 100, y, data.slip.status); y -= 20;

  doc.line(left, y, right, y); y -= 18;

  // Municipal-only bucket (Property Rates, Refuse) - see calc_flat_site.js's computeSlip(). Empty
  // for every existing flat_site property's own client-facing slip, so this section simply never
  // renders there; only a municipal account statement (see field-street/municipal_import.js) has
  // items here.
  if (data.calc.municipalItems && data.calc.municipalItems.length) {
    doc.text(left, y, 'MUNICIPAL CHARGES', { size: 12, bold: true }); y -= 16;
    ({ y } = drawSiteLineItemsTable(doc, data.calc.municipalItems, left, right, y, { noComment: true }));
    y -= 4; doc.line(left, y, right, y); y -= 16;
    const municipalTotalStr = money(data.calc.municipalTotal);
    doc.text(left, y, 'Total (Excl VAT)', { bold: true, size: 9.5 });
    doc.text(right - textWidth(municipalTotalStr, { size: 9.5, bold: true }), y, municipalTotalStr, { bold: true, size: 9.5 }); y -= 22;
  }

  doc.text(left, y, 'ELECTRICAL', { size: 12, bold: true }); y -= 16;
  ({ y } = drawSiteLineItemsTable(doc, data.calc.elecItems, left, right, y));
  y -= 4; doc.line(left, y, right, y); y -= 16;
  const elecTotalStr = money(data.calc.elecTotal);
  doc.text(left, y, 'Total (Excl VAT)', { bold: true, size: 9.5 });
  doc.text(right - textWidth(elecTotalStr, { size: 9.5, bold: true }), y, elecTotalStr, { bold: true, size: 9.5 }); y -= 22;

  doc.text(left, y, 'WATER & SANITATION', { size: 12, bold: true }); y -= 16;
  ({ y } = drawSiteLineItemsTable(doc, data.calc.waterItems, left, right, y, { noComment: true }));
  y -= 4; doc.line(left, y, right, y); y -= 16;
  const waterTotalStr = money(data.calc.waterTotal);
  doc.text(left, y, 'Total (Ex VAT)', { bold: true, size: 9.5 });
  doc.text(right - textWidth(waterTotalStr, { size: 9.5, bold: true }), y, waterTotalStr, { bold: true, size: 9.5 }); y -= 24;

  doc.line(left, y, right, y); y -= 16;
  const subtotalStr = money(data.calc.subtotal);
  doc.text(right - 220, y, 'Sub Total (Excl VAT)', {});
  doc.text(right - textWidth(subtotalStr, { size: 10 }), y, subtotalStr); y -= 14;
  const vatStr = money(data.calc.vatAmount);
  doc.text(right - 220, y, `VAT (${(data.calc.vatRate * 100).toFixed(0)}%)`, {});
  doc.text(right - textWidth(vatStr, { size: 10 }), y, vatStr); y -= 14;
  doc.line(right - 220, y + 11, right, y + 11);
  const totalStr = money(data.calc.total);
  doc.text(right - 220, y, 'TOTAL PAYABLE', { bold: true, size: 12 });
  doc.text(right - textWidth(totalStr, { size: 12, bold: true }), y, totalStr, { bold: true, size: 12 }); y -= 20;

  if (data.monthlyTrend && data.monthlyTrend.length > 1) {
    doc.newPage();
    let ty = PAGE_H - 50;
    doc.text(left, ty, propertyName, { size: 16, bold: true }); ty -= 14;
    doc.text(left, ty, 'Utility Cost Excluding VAT', { size: 11, bold: true }); ty -= 8;
    doc.line(left, ty, right, ty); ty -= 30;
    drawTripleTrendCharts(doc, { x: left + 46, y: ty, width: right - left - 46, series: data.monthlyTrend, maxOverrides: data.axisMaxOverrides && data.axisMaxOverrides.cost });

    doc.newPage();
    let cy = PAGE_H - 50;
    doc.text(left, cy, propertyName, { size: 16, bold: true }); cy -= 14;
    doc.text(left, cy, 'Consumption Trend', { size: 11, bold: true }); cy -= 8;
    doc.line(left, cy, right, cy); cy -= 30;
    drawConsumptionTrendCharts(doc, { x: left + 46, y: cy, width: right - left - 46, series: data.monthlyTrend, maxOverrides: data.axisMaxOverrides && data.axisMaxOverrides.consumption });
  }

  return doc.build();
}

// ---------------- recovery: tenant billing vs municipal statement (flat_site) ----------------
// See flat_site_recovery.js for the comparison logic. `rows` here is buildRecoveryRows()'s output
// (chronological ascending) - a row with either side missing (no site slip or no municipal
// statement for that label) has row.site/row.municipal null and row.recovery null; both the chart
// and tables below render those as "no data" rather than plotting/summing a false zero.

// Grouped two-bar-per-month chart (series A vs series B, e.g. Tenant vs Municipal), with the delta
// (A - B) printed above each pair, colour-coded green/red - same visual language as drawTrendChart/
// drawSingleSeriesChart (gridlines, month ticks) but two side-by-side bars per column instead of one
// stacked or single bar. `getA`/`getB`/`getDelta` are accessor functions (rather than fixed keys) so
// this one renderer covers both the Overall (combined Rand, values live at the series item's top
// level - totalSiteRand etc.) and each utility's own Rand/consumption charts (values nested under
// site/municipal/recovery) - generalised 2026-08-08 when the single combined chart was split into
// one chart per utility, per Rand AND consumption, per the client's request.
function drawGroupedComparisonChart(doc, { x, y, width, height, series, getA, getB, getDelta, hasData, formatValue = moneyShort, legendA = 'Tenant Billing', legendB = 'Municipal Statement' }) {
  const COLOR_A = [0.11, 0.16, 0.34]; // Tenant Billing - matches the Electricity navy used everywhere else
  const COLOR_B = [0.39, 0.45, 0.55]; // Municipal Statement - neutral slate, reads as "external/reference"
  const COLOR_POS = [0.05, 0.5, 0.2], COLOR_NEG = [0.75, 0.15, 0.15];

  const values = series.flatMap((s) => (hasData(s) ? [getA(s), getB(s)] : [])).filter((v) => v != null);
  const maxVal = Math.max(1, ...values);
  const chartBottom = y - height;
  const n = series.length || 1;
  const colWidth = width / n;
  const barWidth = Math.min(16, colWidth * 0.28);
  const gap = 5;

  const legendItems = [[legendA, COLOR_A], [legendB, COLOR_B]];
  let lx = x + width - 210;
  const ly = y + 16;
  for (const [label, color] of legendItems) {
    doc.rect(lx, ly, 7, 7, { fill: color });
    doc.text(lx + 10, ly + 1, label, { size: 8 });
    lx += 105;
  }
  doc.currentOps.push('0 0 0 rg'); // rect()'s fill colour otherwise bleeds into every text() draw
  // below (rg is a persistent graphics-state param, not scoped to one shape) - reset to black.

  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const v = (maxVal * t) / ticks;
    const ty = chartBottom + (height * t) / ticks;
    doc.line(x, ty, x + width, ty, 0.4, { color: [0.85, 0.85, 0.85] });
    const label = formatValue(v);
    doc.text(x - 6 - textWidth(label, { size: 6 }), ty - 3, label, { size: 6 });
  }

  series.forEach((s, i) => {
    const colCenter = x + i * colWidth + colWidth / 2;
    if (!hasData(s)) {
      doc.text(colCenter - textWidth('no data', { size: 6 }) / 2, chartBottom + 4, 'no data', { size: 6 });
      doc.text(x + i * colWidth + colWidth / 2 - 16, chartBottom - 14, shortMonthLabel(s.label), { size: 6.5 });
      return;
    }
    const aVal = getA(s) || 0, bVal = getB(s) || 0;
    const aH = (aVal / maxVal) * height;
    const bH = (bVal / maxVal) * height;
    const aX = colCenter - gap / 2 - barWidth;
    const bX = colCenter + gap / 2;
    doc.rect(aX, chartBottom, barWidth, aH, { fill: COLOR_A });
    doc.rect(bX, chartBottom, barWidth, bH, { fill: COLOR_B });

    const delta = getDelta(s) || 0;
    const recColor = delta >= 0 ? COLOR_POS : COLOR_NEG;
    const recLabel = `${delta >= 0 ? '+' : ''}${formatValue(delta)}`;
    const topH = Math.max(aH, bH);
    // doc.text() has no colour param (every other label in this app is plain black) - push the
    // coloured text op directly, same "rg" fill-colour operator doc.rect()'s fill uses, since Tj
    // paints with the current non-stroking (fill) colour by default.
    const recX = colCenter - textWidth(recLabel, { size: 6.5, bold: true }) / 2;
    const recY = chartBottom + topH + 5;
    doc.currentOps.push(`${recColor[0]} ${recColor[1]} ${recColor[2]} rg BT /F2 6.5 Tf ${recX.toFixed(2)} ${recY.toFixed(2)} Td (${escapePdfText(recLabel)}) Tj ET`);
    doc.currentOps.push('0 0 0 rg'); // reset fill colour - "rg" is a persistent graphics-state
    // parameter, not scoped to the BT/ET text block above, so every doc.text() call after this
    // point (which never sets its own colour) would otherwise silently inherit red/green.
    doc.text(x + i * colWidth + colWidth / 2 - 16, chartBottom - 14, shortMonthLabel(s.label), { size: 6.5 });
  });

  doc.line(x, chartBottom, x + width, chartBottom, 0.75);
}

const hasBothSidesPdf = (s) => s.site != null && s.municipal != null;

// Draws the Overall (combined Electricity+Water+Sewer Rand) chart, same figure this page always
// showed before the per-utility charts below were added.
function drawOverallChart(doc, { x, y, width, height, series }) {
  drawGroupedComparisonChart(doc, {
    x, y, width, height, series,
    getA: (s) => s.totalSiteRand, getB: (s) => s.totalMunicipalRand, getDelta: (s) => s.totalRecoveryRand,
    hasData: hasBothSidesPdf, formatValue: moneyShort,
  });
}

// One utility's Rand chart + consumption chart, stacked with their own mini-heading each - same
// "one chart, own axis, own heading, stacked" layout drawTripleTrendCharts/drawConsumptionTrendCharts
// already use for the billing slip's own trend page, reused here for visual consistency between the
// two documents.
function drawUtilityCharts(doc, { x, y, width, series, randKey, qtyKey, qtyLabel }) {
  const chartHeight = 130;
  let cy = y;
  doc.text(x, cy, 'Rand (Excl VAT): Tenant vs Municipal', { size: 9.5, bold: true }); cy -= 18;
  drawGroupedComparisonChart(doc, {
    x: x + 46, y: cy, width: width - 46, height: chartHeight, series,
    getA: (s) => s.site && s.site[randKey], getB: (s) => s.municipal && s.municipal[randKey], getDelta: (s) => s.recovery && s.recovery[randKey],
    hasData: hasBothSidesPdf, formatValue: moneyShort,
  });
  cy -= chartHeight + 14 + 26;
  doc.text(x, cy, `Consumption (${qtyLabel}): Tenant vs Municipal`, { size: 9.5, bold: true }); cy -= 18;
  drawGroupedComparisonChart(doc, {
    x: x + 46, y: cy, width: width - 46, height: chartHeight, series,
    getA: (s) => s.site && s.site[qtyKey], getB: (s) => s.municipal && s.municipal[qtyKey], getDelta: (s) => s.recovery && s.recovery[qtyKey],
    hasData: hasBothSidesPdf, formatValue: (v) => qtyShort(v, qtyLabel),
  });
  cy -= chartHeight + 14 + 26;
  return cy;
}

// One Tenant/Municipal/Recovery table (Rand + Qty) for one utility, `rows` newest-first.
// `periodField` picks which municipal period pair applies ('elec' or 'water') - see views.js's
// recoveryTable, this is the PDF's mirror of the same on-screen billing-range/day-count readout
// added 2026-08-08 for the client's over/under-recovery meeting.
function drawRecoveryTable(doc, { title, rows, left, right, y, randKey, qtyKey, qtyLabel, qtyDp = 2, periodField = 'elec' }) {
  const numW = (right - left - 62) / 6;
  const edges = [1, 2, 3, 4, 5, 6].map((n) => left + 62 + numW * n);
  const headers1 = [['Rand (Excl VAT)', 0, 3], ['Qty', 3, 3]];
  const sub = ['Tenant', 'Municipal', 'Recovery', 'Tenant', 'Municipal', 'Recovery'];

  // Draws the title + column header, returning the y just below it - factored out so a mid-table
  // page break (see the per-row loop below, needed now each row takes ~26pt instead of 13pt once
  // the billing-range/day-count line was added) can redraw it at the top of the new page.
  const drawHeader = (yy, withTitle) => {
    if (withTitle) { doc.text(left, yy, title, { size: 11, bold: true }); yy -= 16; }
    doc.text(left, yy, 'Month / Billing Period', { bold: true, size: 7.5 });
    for (const [label, startIdx, span] of headers1) {
      const groupLeft = startIdx === 0 ? left + 62 : edges[startIdx - 1];
      const groupRight = edges[startIdx + span - 1];
      const lw = textWidth(label, { bold: true, size: 7.5 });
      doc.text(groupLeft + (groupRight - groupLeft - lw) / 2, yy, label, { bold: true, size: 7.5 });
    }
    yy -= 10;
    sub.forEach((label, i) => {
      doc.text(edges[i] - textWidth(label, { bold: true, size: 6.5 }), yy, label, { bold: true, size: 6.5 });
    });
    yy -= 4; doc.line(left, yy, right, yy); yy -= 11;
    return yy;
  };
  y = drawHeader(y, true);

  const colorFor = (v) => (v > 0.005 ? [0.05, 0.5, 0.2] : (v < -0.005 ? [0.75, 0.15, 0.15] : [0.4, 0.4, 0.4]));
  const drawRightSigned = (val, ex, yy, fmt, dp) => {
    if (val == null) { doc.text(ex - textWidth('-', { size: 7.5 }), yy, '-', { size: 7.5 }); return; }
    const str = `${val > 0.005 ? '+' : ''}${fmt(val, dp)}`;
    const w = textWidth(str, { size: 7.5, bold: true });
    const c = colorFor(val);
    doc.currentOps.push(`${c[0]} ${c[1]} ${c[2]} rg BT /F2 7.5 Tf ${(ex - w).toFixed(2)} ${yy.toFixed(2)} Td (${escapePdfText(str)}) Tj ET`);
    doc.currentOps.push('0 0 0 rg'); // reset - see drawGroupedComparisonChart's note on "rg" being
    // a persistent (not text-block-scoped) graphics-state parameter.
  };

  const periodStr = (start, end) => {
    if (!start || !end) return 'unknown';
    const d = daysBetween(start, end);
    return `${start} to ${end}${d != null ? ` (${d}d)` : ''}`;
  };

  let flaggedAny = false;
  for (const r of rows) {
    // Page break: each row now takes ~26pt (main line + billing-range line) instead of the 13pt it
    // used to, before the billing-range/day-count readout was added - a full 12-month table no
    // longer reliably fits on one page. Redraw the column header (no title, avoids implying a new
    // table) at the top of the new page and carry on.
    if (y < 90) { doc.newPage(); y = drawHeader(PAGE_H - 50, false); }
    const site = r.site, muni = r.municipal, rec = r.recovery;
    const ourStart = site && site.startDate, ourEnd = site && site.endDate;
    const muniStart = muni && (periodField === 'water' ? (muni.waterStartDate || muni.startDate) : muni.startDate);
    const muniEnd = muni && (periodField === 'water' ? (muni.waterEndDate || muni.endDate) : muni.endDate);
    // Same long-period flag as the on-screen Recovery table (see views.js's recoveryTable) -
    // municipal statement's own period for THIS utility takes priority since that's the real bill.
    const flagged = (muniStart && daysBetween(muniStart, muniEnd) > LONG_PERIOD_DAYS)
      || (ourStart && daysBetween(ourStart, ourEnd) > LONG_PERIOD_DAYS);
    if (flagged) flaggedAny = true;
    doc.text(left, y, shortMonthLabel(r.label) + (flagged ? '*' : ''), { size: 7.5, bold: true });
    const siteRandStr = site ? money(site[randKey]) : 'no bill';
    doc.text(edges[0] - textWidth(siteRandStr, { size: 7.5 }), y, siteRandStr, { size: 7.5 });
    const muniRandStr = muni ? money(muni[randKey]) : 'no statement';
    doc.text(edges[1] - textWidth(muniRandStr, { size: 7.5 }), y, muniRandStr, { size: 7.5 });
    drawRightSigned(rec ? rec[randKey] : null, edges[2], y, money);
    const siteQtyStr = site ? site[qtyKey].toLocaleString('en-US', { minimumFractionDigits: qtyDp, maximumFractionDigits: qtyDp }) : '-';
    doc.text(edges[3] - textWidth(siteQtyStr, { size: 7.5 }), y, siteQtyStr, { size: 7.5 });
    const muniQtyStr = muni ? muni[qtyKey].toLocaleString('en-US', { minimumFractionDigits: qtyDp, maximumFractionDigits: qtyDp }) : '-';
    doc.text(edges[4] - textWidth(muniQtyStr, { size: 7.5 }), y, muniQtyStr, { size: 7.5 });
    drawRightSigned(rec ? rec[qtyKey] : null, edges[5], y, (v, dp) => v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }), qtyDp);
    y -= 10;
    // Exact billing range + day count for both sides, printed under the main row - see views.js's
    // periodLine for why this was added (client over/under-recovery meeting, hard-copy handout).
    if (site || muni) {
      doc.text(left, y, `Ours: ${periodStr(ourStart, ourEnd)}   |   Municipal: ${periodStr(muniStart, muniEnd)}`, { size: 6.5 });
      y -= 10;
    }
    y -= 6;
  }
  if (flaggedAny) {
    doc.text(left, y - 2, `* period longer than ${LONG_PERIOD_DAYS} days (combined/multi-month statement)`, { size: 6.5 });
    y -= 12;
  }
  return y;
}

// Draws one section's overview page (chart) + detail page(s) (Electricity/Water/Sewer tables).
// `section.title` is null for a single-section property (Wingfield, every flat_site property) -
// omitting it reproduces this function's pre-multi-section output exactly. For City Deep's 3
// grouped sections (see properties.js's recoveryMultiSection flag / city-deep/recovery_groups.js),
// the title is threaded into both page headers so a printed section is self-identifying on its own
// (a client flipping through a stack of hard copies from the meeting can tell Industrial Park's
// pages from Mini Park's without the cover page in hand).
// Shared page header (logo, property name, subtitle, section title if any, rule) for every page in
// a Recovery section - factored out 2026-08-08 so the Overall page and each utility's own page
// (below) all get an identical header instead of copy-pasting it 4x.
function drawRecoveryPageHeader(doc, { propertyName, section, left, right, subtitle }) {
  let y = PAGE_H - 50;
  doc.image(right - 90, PAGE_H - 32 - 90 * (LOGO.height / LOGO.width), 90, 90 * (LOGO.height / LOGO.width), 'Logo');
  const logoH = 90 * (LOGO.height / LOGO.width);
  doc.text(left, y, propertyName, { size: 16, bold: true }); y -= 14;
  doc.text(left, y, subtitle, { size: 10 }); y -= 6;
  if (section.title) { doc.text(left, y, section.title, { size: 10, bold: true }); y -= 14; }
  y = Math.min(y - 8, PAGE_H - 32 - logoH - 9);
  doc.line(left, y, right, y); y -= 16;
  return y;
}

// Draws a section's Overall page (combined Electricity+Water+Sewer Rand chart), then one page per
// utility (its own Rand chart + its own consumption chart, then the existing Tenant/Municipal/
// Recovery table underneath) - split out 2026-08-08 from the old "one overview chart + one detail
// page with all 3 tables" layout, per the client's request to see each utility's own comparison, not
// just the combined total. `section.title` is null for a single-section property (Wingfield, every
// flat_site property) - omitting it reproduces this function's pre-split output on each page;
// City Deep's 3 grouped sections (see properties.js's recoveryMultiSection flag) get the section
// title threaded into every page's header so a printed section is self-identifying on its own.
function drawRecoverySection(doc, { propertyName, section, left, right }) {
  const rows = section.rows || [];
  const rowsDesc = [...rows].reverse();

  // Page 1: Overall.
  let y = drawRecoveryPageHeader(doc, { propertyName, section, left, right, subtitle: 'Recovery - Overall (Electricity + Water + Sewer)' });
  doc.text(left, y, 'Property Rates, Refuse and Sundry are excluded from every figure below - real municipal-only', { size: 7.5 });
  y -= 10;
  doc.text(left, y, 'costs, but never billed through to the client.', { size: 7.5 });
  y -= 26;
  if (rows.length) {
    drawOverallChart(doc, { x: left + 46, y, width: right - left - 46, height: 220, series: rows });
  } else {
    doc.text(left, y - 20, 'No overlapping billing/municipal data yet.', { size: 9 });
  }

  // One page per utility: Rand chart + consumption chart, then that utility's detail table.
  const utilities = [
    { label: 'Electricity', randKey: 'elecRand', qtyKey: 'elecKwh', qtyLabel: 'kWh', qtyDp: 0, periodField: 'elec' },
    { label: 'Water', randKey: 'waterRand', qtyKey: 'waterKl', qtyLabel: 'kL', qtyDp: 2, periodField: 'water' },
    { label: 'Sewer', randKey: 'sewerRand', qtyKey: 'sewerKl', qtyLabel: 'kL', qtyDp: 2, periodField: 'water' },
  ];

  let lastTy = y;
  for (const u of utilities) {
    doc.newPage();
    let ty = drawRecoveryPageHeader(doc, { propertyName, section, left, right, subtitle: `Recovery - ${u.label}` });
    if (rows.length) {
      ty = drawUtilityCharts(doc, { x: left, y: ty, width: right - left, series: rows, randKey: u.randKey, qtyKey: u.qtyKey, qtyLabel: u.qtyLabel });
      ty -= 6;
    } else {
      doc.text(left, ty - 20, 'No overlapping billing/municipal data yet.', { size: 9 });
      ty -= 40;
    }
    // The two charts above can run close to the bottom margin on a property with many months of
    // history - start the detail table fresh on the next page rather than cramming it in below.
    if (ty < 160) { doc.newPage(); ty = PAGE_H - 50; }
    ty = drawRecoveryTable(doc, { title: `${u.label} (newest first)`, rows: rowsDesc, left, right, y: ty, randKey: u.randKey, qtyKey: u.qtyKey, qtyLabel: u.qtyLabel, qtyDp: u.qtyDp, periodField: u.periodField });
    lastTy = ty;
  }
  return lastTy;
}

// `data.sections` is always an array of { title, rows } (see server.js's
// currentPropRecoverySections) - one nameless section for every existing property (identical
// output to before this was generalized for City Deep), 3 titled sections for City Deep. Each
// section gets its own overview+detail page block, in order.
function buildRecoveryPdf(data) {
  const doc = new PDFDoc();
  const left = 42, right = PAGE_W - 42;
  const propertyName = (data.propertyName || '').toUpperCase();
  const sections = data.sections || [{ title: null, rows: data.rows || [] }];

  doc.registerImage('Logo', LOGO);

  sections.forEach((section, idx) => {
    if (idx > 0) doc.newPage();
    drawRecoverySection(doc, { propertyName, section, left, right });
  });

  doc.text(left, 30, `Generated ${data.generatedAt || ''}`, { size: 7 });

  return doc.build();
}

module.exports = { PDFDoc, buildBillingSlipPdf, buildMunicipalStatementPdf, buildSiteBillingSlipPdf, buildRecoveryPdf, money };
