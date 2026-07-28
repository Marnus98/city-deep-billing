// pdf.js - a minimal, dependency-free PDF writer.
// Only what's needed for a clean, single-page A4 billing slip: text (Helvetica / Helvetica-Bold,
// base-14 fonts so nothing needs to be embedded), straight lines, filled rectangles and (now) a
// single embedded logo image (see logo_asset.js / registerImage()).
// Written by hand because this sandbox's package registry access was too unreliable to install
// a PDF library (see README "Known environment limitations") - production deployments should
// swap this for pdfkit/puppeteer once normal npm access is available; the raw PDF this produces
// is fully spec-valid in the meantime (verified by re-rendering it with poppler/pdftoppm).
const LOGO = require('./logo_asset');

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

  const totals = series.map((s) => (s.elec || 0) + (s.water || 0) + (s.sanitation || 0));
  const maxVal = Math.max(1, ...totals);
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
    doc.text(x + i * colWidth + colWidth / 2 - 16, chartBottom - 14, shortMonthLabel(s.label), { size: 6.5 });
  });

  doc.line(x, chartBottom, x + width, chartBottom, 0.75);
}

// Single-series bar chart - same visual language as drawTrendChart (gridlines, value-above-bar
// labels, month labels) but only one colour/category, scaled to its OWN max rather than a shared
// stacked max, so a category with much smaller values (e.g. Water/Sanitation next to Electricity,
// or kL next to kWh) isn't squashed flat at the bottom of the chart. `formatValue` defaults to the
// Rand formatter but can be swapped for qtyShort() to reuse this same chart for consumption trends.
function drawSingleSeriesChart(doc, { x, y, width, height, series, seriesKey, color, formatValue = moneyShort }) {
  const values = series.map((s) => s[seriesKey] || 0);
  const maxVal = Math.max(1, ...values);
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
    const val = s[seriesKey] || 0;
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
function drawTripleTrendCharts(doc, { x, y, width, series }) {
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
    drawSingleSeriesChart(doc, { x: x + 46, y: cy, width: width - 46, height: chartHeight, series, seriesKey: def.key, color: def.color });
    cy -= chartHeight + 14 + 26;
  }
}

// Two stacked single-series charts (Electricity kWh / Water kL) - same layout as
// drawTripleTrendCharts but for physical consumption instead of Rand cost, so a tenant can see
// usage trends independent of tariff changes. Water consumption is stored in m3 in the schema,
// which is numerically identical to kL (1 m3 = 1 kL), so waterM3 is simply labelled "kL".
function drawConsumptionTrendCharts(doc, { x, y, width, series }) {
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
  doc.text(left, y, 'Account No:', { bold: true }); doc.text(left + 90, y, data.accountNumber || '-');
  doc.text(right - 180, y, 'Reading Period:', { bold: true }); doc.text(right - 100, y, `${data.startDate} to ${data.endDate}`); y -= 15;
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
  doc.line(right - 220, y + 8, right, y + 8);
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
  catLine(`Electricity (${data.elecReadingStart || '?'} to ${data.elecReadingEnd || '?'})`, fmtQty(data.elecConsumptionKwh, 'kWh'), data.elecExclVat, data.elecVat, data.elecInclVat);
  for (const l of data.elecLines || []) catLine(l.label, fmtQty(l.qty, l.unit || ''), l.rand, null, l.rand, { indent: true });
  catLine(`Water (${data.waterReadingStart || '?'} to ${data.waterReadingEnd || '?'})`, fmtQty(data.waterConsumptionKl, 'KL'), data.waterExclVat, data.waterVat, data.waterInclVat);
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

module.exports = { PDFDoc, buildBillingSlipPdf, buildMunicipalStatementPdf, money };
