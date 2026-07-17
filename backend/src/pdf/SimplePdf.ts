/**
 * ApnaKhata — Minimal PDF writer (dependency-free)
 * ------------------------------------------------
 * Produces a valid single-page A4 PDF from styled text lines using the
 * built-in Helvetica/Helvetica-Bold fonts (no font embedding needed). Kept
 * intentionally tiny — enough for the Credit Risk Passport artifact, where the
 * machine-verifiable truth lives in the signed JSON, not the PDF chrome.
 */

export interface PdfLine {
  text: string;
  size?: number; // pt, default 11
  bold?: boolean;
  gap?: number; // extra vertical space (pt) before this line
  color?: [number, number, number]; // 0..1 rgb, default black
}

const PAGE_WIDTH = 595.28; // A4 @ 72dpi
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 56;
const TOP_Y = 786;

/**
 * Escape the characters that are special inside a PDF literal string, and drop
 * anything outside Latin-1 — the standard-14 fonts use WinAnsi encoding, so a
 * non-representable code point (e.g. ₹) would otherwise render as mojibake.
 */
function escapePdfText(text: string): string {
  return text
    .replace(/[^\x20-\xFF]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/** Build the page content stream (BT…ET) from the lines. */
function buildContentStream(lines: PdfLine[]): string {
  const parts: string[] = ['BT'];
  let y = TOP_Y;
  let first = true;

  for (const line of lines) {
    const size = line.size ?? 11;
    const leading = size * 1.45;
    const gap = line.gap ?? 0;
    const font = line.bold ? '/F2' : '/F1';
    const [r, g, b] = line.color ?? [0, 0, 0];

    if (first) {
      y -= gap;
      parts.push(`1 0 0 1 ${MARGIN_X.toFixed(2)} ${y.toFixed(2)} Tm`);
      first = false;
    } else {
      // Move down by leading + gap using a fresh text-matrix each line so the
      // absolute Y stays exact regardless of prior font sizes.
      y -= leading + gap;
      parts.push(`1 0 0 1 ${MARGIN_X.toFixed(2)} ${y.toFixed(2)} Tm`);
    }

    parts.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
    parts.push(`${font} ${size.toFixed(2)} Tf`);
    parts.push(`(${escapePdfText(line.text)}) Tj`);
  }

  parts.push('ET');
  return parts.join('\n');
}

/** Render the given lines to a complete PDF document as a Buffer. */
export function renderPdf(lines: PdfLine[]): Buffer {
  const content = buildContentStream(lines);
  const contentBytes = Buffer.byteLength(content, 'latin1');

  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${contentBytes} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets) {
    pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}
