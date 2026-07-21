// pdf.js - a minimal, dependency-free PDF writer.
// Only what's needed for a clean, single-page A4 billing slip: text (Helvetica / Helvetica-Bold,
// base-14 fonts so nothing needs to be embedded), straight lines and filled rectangles.
// Written by hand because this sandbox's package registry access was too unreliable to install
// a PDF library (see README "Known environment limitations") - production deployments should
// swap this for pdfkit/puppeteer once normal npm access is available; the raw PDF this produces
// is fully spec-valid in the meantime (verified by re-rendering it with poppler/pdftoppm).

function escapePdfText(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

const PAGE_W = 595.28; // A4 pt
const PAGE_H = 841.89;

class PDFDoc {
  constructor() {
    this.ops = [];
    this.page = { width: PAGE_W, height: PAGE_H };
  }
  text(x, y, str, { size = 10, bold = false } = {}) {
    const font = bold ? 'F2' : 'F1';
    this.ops.push(`BT /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${escapePdfText(str)}) Tj ET`);
    return this;
  }
  line(x1, y1, x2, y2, width = 0.75) {
    this.ops.push(`${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
    return this;
  }
  rect(x, y, w, h, { fill } = {}) {
    if (fill) {
      const [r, g, b] = fill;
      this.ops.push(`${r} ${g} ${b} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
    } else {
      this.ops.push(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S`);
    }
    return this;
  }
  build() {
    const content = this.ops.join('\n');
    const objects = [];
    objects.push('<< /Type /Catalog /Pages 2 0 R >>'); // 1
    objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'); // 2
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.page.width} ${this.page.height}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`); // 3
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); // 4
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'); // 5
    const streamBytes = Buffer.byteLength(content, 'utf8');
    objects.push(`<< /Length ${streamBytes} >>\nstream\n${content}\nendstream`); // 6

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

// Builds the billing slip PDF for one bill. `data` shape - see server.js buildBillPdfData().
function buildBillingSlipPdf(data) {
  const doc = new PDFDoc();
  const left = 42, right = PAGE_W - 42;
  let y = PAGE_H - 50;

  doc.text(left, y, 'CITY DEEP INDUSTRIAL PARK', { size: 16, bold: true }); y -= 14;
  doc.text(left, y, 'Utility Billing Statement', { size: 10 }); y -= 8;
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

  doc.line(left, y, right, y); y -= 16;
  doc.text(right - 220, y, 'Subtotal (excl. VAT)', {}); doc.text(right - 70, y, money(data.subtotal)); y -= 14;
  doc.text(right - 220, y, `VAT (${(data.vatRate * 100).toFixed(0)}%)`, {}); doc.text(right - 70, y, money(data.vatAmount)); y -= 14;
  doc.line(right - 220, y + 8, right, y + 8);
  doc.text(right - 220, y, 'TOTAL PAYABLE', { bold: true, size: 12 }); doc.text(right - 90, y, money(data.total), { bold: true, size: 12 }); y -= 26;

  doc.line(left, y, right, y); y -= 16;
  doc.text(left, y, 'Banking Details:', { bold: true }); y -= 13;
  doc.text(left, y, data.bankingDetails || 'Bank: (to be supplied)   Account: (to be supplied)   Branch code: (to be supplied)', { size: 9 }); y -= 20;
  if (data.notes) { doc.text(left, y, 'Notes: ' + data.notes, { size: 9 }); y -= 16; }
  doc.text(left, 30, `Bill status: ${data.status.toUpperCase()}  |  Generated: ${data.generatedAt}  |  This is a system-generated statement.`, { size: 7 });

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

module.exports = { PDFDoc, buildBillingSlipPdf, money };
