/**
 * PDF writer for the Failure Analysis report. `pdfLayout` turns the format-neutral AnalysisReport into
 * blocks (pure); `renderPdf` draws them with pdfkit (A4 landscape, Helvetica, repeated table headers).
 */
import PDFDocument from 'pdfkit';
import type { AnalysisReport } from '../adapters/simplifyqa/failureReportModel.js';
import {
  EXTRA_PDF_WIDTH, TC_COLUMNS, describeLayout, extraCell, groupKey, orderTestcases, resolveLayout,
  type ColumnCtx, type ResolvedLayout,
} from './layout.js';

export type PdfImage = { patternId: number; data: Buffer };
export type PdfBlock =
  | { kind: 'cover'; title: string; lines: string[] }
  | { kind: 'heading'; text: string }
  | { kind: 'table'; headers: string[]; rows: string[][]; widths: number[]; /** Column indexes never clipped at MAX_CELL_CHARS. */ unclipped?: number[] }
  | { kind: 'bars'; items: Array<{ label: string; value: number }> }
  | { kind: 'image'; patternId: number; caption: string };

const MARGIN = 36;
const FONT = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';
const CELL_PAD = 3;
const CELL_FONT = 7.5;
const MAX_CELL_CHARS = 240;
export const PDF_CELL_FONT = CELL_FONT;
export const PDF_CELL_PAD = CELL_PAD;
export const PDF_USABLE_WIDTH = 841.89 - MARGIN * 2;
const IMG_MAX_W_FRAC = 0.9;
const IMG_MIN_FRAC = 0.85;
const IMG_PAD = 6;
const IMG_GAP = 12;
const CAPTION_H = 14;

export type ImageBox = { x: number; w: number; h: number; newPage: boolean };

/** Pure box math for a screenshot block: <=90% of content width, centred, aspect kept, height capped by
 *  the tighter of the full usable height (contentH) and the space left; a fit under 85% of the full-page
 *  size moves it to a new page. */
export function borderBox(b: ImageBox, pad = IMG_PAD): { x: number; w: number; h: number } {
  return { x: b.x - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
}

export function imageBox(imgW: number, imgH: number, contentW: number, contentH: number, spaceLeft: number, left = 0): ImageBox {
  const maxW = contentW * IMG_MAX_W_FRAC;
  const fullCap = contentH;
  const scale = (cap: number): { w: number; h: number } => {
    const k = Math.min(maxW / imgW, cap / imgH);
    return { w: imgW * k, h: imgH * k };
  };
  const full = scale(fullCap);
  const fit = scale(Math.max(1, Math.min(fullCap, spaceLeft)));
  const newPage = fit.h < full.h * IMG_MIN_FRAC;
  const { w, h } = newPage ? full : fit;
  return { x: left + (contentW - w) / 2, w, h, newPage };
}
const BAR_MAX_W = 360;

/** Characters above 0xFF that the standard fonts' WinAnsi encoding can still draw. */
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ•˜™š›œžŸ');
const PDF_REPLACEMENTS: Record<string, string> = {
  '→': '->', '←': '<-', '–': '-', '—': '-', '‘': "'", '’': "'", '‚': "'", '“': '"', '”': '"', '„': '"', '×': 'x',
  '…': '...', '•': '*', ' ': ' ',
};

/**
 * Text the built-in Helvetica (WinAnsi) can draw: arrows / dashes / smart quotes mapped to ASCII, and
 * any other character it cannot encode (CJK, emoji, …) replaced by "?" — one per character.
 */
export function pdfText(s: string): string {
  let out = '';
  for (const ch of s) {
    const mapped = PDF_REPLACEMENTS[ch];
    if (mapped !== undefined) out += mapped;
    else if (ch.codePointAt(0)! <= 0xff || WIN_ANSI_EXTRA.has(ch)) out += ch;
    else out += '?';
  }
  return out;
}

/** Relative column widths (scaled to the page width). Category columns are sized to fit AUTOMATION_DATA on one line. */
export const SUMMARY_WIDTHS = [3, 1, 1];
export const ROOT_CAUSE_WIDTHS = [0.5, 3, 4.6, 2.2, 1.2, 0.9, 3.8];
export const TESTCASE_WIDTHS = [1, 1, 2, 1, 2, 1.8, 1.8, 2, 2.4, 3, 1, 1.2, 1.2];

/** Every text of a block passed through pdfText. */
function sanitizeBlock(b: PdfBlock): PdfBlock {
  switch (b.kind) {
    case 'cover': return { ...b, title: pdfText(b.title), lines: b.lines.map(pdfText) };
    case 'heading': return { ...b, text: pdfText(b.text) };
    case 'table': return { ...b, headers: b.headers.map(pdfText), rows: b.rows.map((r) => r.map(pdfText)) };
    case 'bars': return { ...b, items: b.items.map((i) => ({ ...i, label: pdfText(i.label) })) };
    case 'image': return { ...b, caption: pdfText(b.caption) };
  }
}

/** The root-cause table's columns — the same in the PDF and the Excel "Patterns" sheet. */
export const ROOT_CAUSE_HEADERS = ['#', 'Failure pattern', 'Root cause', 'Category', 'Confidence', 'Failed TCs', 'Test cases (version)'];

/**
 * The report as blocks. `layout` (from the user's request) can retitle it, drop the non-summary sections,
 * pick / reorder the test-case columns, group the test cases under one heading per group, resort them and
 * add AI-filled columns. Without it the PDF is the standard one (rows in report-model order).
 */
export function pdfLayout(r: AnalysisReport, layout: ResolvedLayout = resolveLayout()): PdfBlock[] {
  const described = describeLayout(layout);
  const want = new Set(layout.sections);
  const blocks: PdfBlock[] = [
    {
      kind: 'cover', title: layout.title ?? r.title,
      lines: [
        `Scope: ${r.scope.executions.join(', ') || 'none'}`,
        `Sources: ${r.scope.suites.join(', ') || 'none'}`,
        `Filters: ${r.scope.filters}`,
        ...(described ? [`Layout: ${described}`] : []),
        `Generated at: ${r.scope.generatedAt}`,
      ],
    },
    { kind: 'heading', text: 'Summary' },
    {
      kind: 'table', headers: ['Category', 'Test cases', 'Percent'], widths: SUMMARY_WIDTHS,
      rows: r.summary.map((s) => [s.category, String(s.testcases), `${s.percent}%`]),
    },
    { kind: 'bars', items: r.summary.map((s) => ({ label: s.category, value: s.percent })) },
  ];
  if (want.has('rootCauses')) {
    blocks.push(
      { kind: 'heading', text: 'Failure patterns / root causes' },
      {
        kind: 'table', headers: ROOT_CAUSE_HEADERS,
        widths: ROOT_CAUSE_WIDTHS,
        // Every test case id is listed in the export (the card caps them at 12).
        unclipped: [6],
        rows: r.patterns.map((p, i) => [
          String(i + 1), p.pattern, p.rootCause, p.category, p.confidence, String(p.testcases), p.testcaseIds.join(', '),
        ]),
      },
    );
    r.patterns.forEach((p, i) => {
      if (p.screenshotUrl) blocks.push({ kind: 'image', patternId: p.id, caption: `Pattern ${i + 1}: ${p.pattern}` });
    });
  }
  if (want.has('sources')) {
    for (const s of r.suites) {
      blocks.push({ kind: 'heading', text: `Source: ${s.suite}` });
      blocks.push({
        kind: 'table', headers: ['Failed', 'App defect', 'New change', 'Automation/data', 'Unclassified', 'Top patterns'],
        widths: [1, 1, 1, 1.3, 1.2, 5],
        rows: [[
          String(s.failed), String(s.byCategory.APP_DEFECT ?? 0), String(s.byCategory.NEW_CHANGE ?? 0),
          String(s.byCategory.AUTOMATION_DATA ?? 0), String(s.byCategory.UNCLASSIFIED ?? 0), s.topPatterns.join(', '),
        ]],
      });
    }
  }
  if (want.has('testCases')) {
    const ctx: ColumnCtx = { patternNo: new Map(r.patterns.map((p, i) => [p.pattern, i + 1])) };
    const cols = layout.pdfColumns.map((k) => TC_COLUMNS[k]);
    const headers = [...cols.map((c) => c.header), ...layout.extraColumns.map((x) => x.header)];
    const widths = [...cols.map((c) => c.pdfWidth), ...layout.extraColumns.map(() => EXTRA_PDF_WIDTH)];
    const toRow = (t: AnalysisReport['testcases'][number]): string[] =>
      [...cols.map((c) => c.pdf(t, ctx)), ...layout.extraColumns.map((x) => extraCell(t, x))];
    const rows = layout.reorder ? orderTestcases(r.testcases, layout, ctx) : r.testcases;
    if (layout.groupBy === 'pattern') {
      blocks.push({ kind: 'heading', text: 'Test cases' });
      blocks.push({ kind: 'table', headers, widths, rows: rows.map(toRow) });
    } else {
      // Rows are already ordered by group, so each group is one contiguous run.
      const groups = new Map<string, AnalysisReport['testcases']>();
      for (const t of rows) {
        const k = groupKey(t, layout.groupBy, ctx);
        const g = groups.get(k);
        if (g) g.push(t); else groups.set(k, [t]);
      }
      for (const [k, g] of groups) {
        blocks.push({ kind: 'heading', text: `Test cases: ${k}` });
        blocks.push({ kind: 'table', headers, widths, rows: g.map(toRow) });
      }
    }
  }
  return blocks.map(sanitizeBlock);
}

const clip = (s: string): string => (s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS - 3)}...` : s);

export async function renderPdf(blocks: PdfBlock[], images: PdfImage[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const imageOf = new Map(images.map((i) => [i.patternId, i.data]));
  const usableW = (): number => doc.page.width - MARGIN * 2;
  const bottom = (): number => doc.page.height - MARGIN;
  const ensure = (h: number): void => { if (doc.y + h > bottom()) doc.addPage(); };

  const drawTable = (b: Extract<PdfBlock, { kind: 'table' }>): void => {
    const total = b.widths.reduce((a, c) => a + c, 0) || 1;
    const w = b.widths.map((x) => (x / total) * usableW());
    const rowHeight = (cells: string[], bold: boolean): number => {
      doc.font(bold ? FONT_BOLD : FONT).fontSize(CELL_FONT);
      let h = 0;
      cells.forEach((c, i) => { h = Math.max(h, doc.heightOfString(c, { width: (w[i] ?? 50) - CELL_PAD * 2 })); });
      return h + CELL_PAD * 2;
    };
    const drawRow = (cells: string[], bold: boolean, fill: boolean): void => {
      const h = Math.min(rowHeight(cells, bold), bottom() - MARGIN - 20);
      if (doc.y + h > bottom()) {
        doc.addPage();
        if (!bold) drawRow(b.headers, true, true);
      }
      const y = doc.y;
      let x = MARGIN;
      cells.forEach((c, i) => {
        const cw = w[i] ?? 50;
        if (fill) doc.rect(x, y, cw, h).fill('#e6e9ef');
        doc.rect(x, y, cw, h).lineWidth(0.4).stroke('#b0b6c3');
        doc.fillColor('#111').font(bold ? FONT_BOLD : FONT).fontSize(CELL_FONT)
          .text(c, x + CELL_PAD, y + CELL_PAD, { width: cw - CELL_PAD * 2, height: h - CELL_PAD * 2, ellipsis: true });
        x += cw;
      });
      doc.x = MARGIN;
      doc.y = y + h;
    };
    ensure(40);
    drawRow(b.headers, true, true);
    for (const row of b.rows) drawRow(b.headers.map((_, i) => (b.unclipped?.includes(i) ? row[i] ?? '' : clip(row[i] ?? ''))), false, false);
    doc.moveDown(0.8);
    doc.x = MARGIN;
  };

  for (const b of blocks) {
    switch (b.kind) {
      case 'cover':
        doc.font(FONT_BOLD).fontSize(26).fillColor('#111').text(b.title, MARGIN, doc.y + 20);
        doc.moveDown(0.8);
        for (const l of b.lines) doc.font(FONT).fontSize(11).fillColor('#333').text(l, MARGIN, doc.y, { width: usableW() });
        doc.moveDown(1.5);
        break;
      case 'heading':
        ensure(60);
        doc.font(FONT_BOLD).fontSize(14).fillColor('#111').text(b.text, MARGIN, doc.y, { width: usableW() });
        doc.moveDown(0.4);
        break;
      case 'table':
        drawTable(b);
        break;
      case 'bars': {
        const max = Math.max(1, ...b.items.map((i) => i.value));
        for (const it of b.items) {
          ensure(18);
          const y = doc.y;
          doc.font(FONT).fontSize(9).fillColor('#111').text(it.label, MARGIN, y + 2, { width: 130, lineBreak: false });
          doc.rect(MARGIN + 140, y, Math.max(1, (it.value / max) * BAR_MAX_W), 11).fill('#4a78c2');
          doc.fillColor('#111').text(`${it.value}%`, MARGIN + 150 + BAR_MAX_W, y + 2, { lineBreak: false });
          doc.x = MARGIN;
          doc.y = y + 16;
        }
        doc.moveDown(0.6);
        break;
      }
      case 'image': {
        const data = imageOf.get(b.patternId);
        if (!data) break;
        try {
          const img = (doc as unknown as { openImage(d: Buffer): { width: number; height: number } }).openImage(data);
          const contentH = doc.page.height - MARGIN * 2;
          const chrome = CAPTION_H + 4 + IMG_PAD * 2;
          const calc = (): ImageBox => imageBox(img.width, img.height, usableW(), contentH - chrome, bottom() - doc.y - chrome, MARGIN);
          if (calc().newPage) { doc.addPage(); doc.x = MARGIN; doc.y = MARGIN; }
          const box = calc();
          doc.font(FONT).fontSize(8).fillColor('#333').text(b.caption, MARGIN, doc.y, { width: usableW(), lineBreak: false });
          const top = doc.y + 4;
          const bb = borderBox(box);
          doc.roundedRect(bb.x, top, bb.w, bb.h, 8).lineWidth(0.75).stroke('#d0d7de');
          doc.image(data, box.x, top + IMG_PAD, { fit: [box.w, box.h], align: 'center' });
          doc.x = MARGIN;
          doc.y = top + bb.h + IMG_GAP;
        } catch {
          // an undecodable image is skipped rather than failing the report
        }
        break;
      }
    }
  }
  doc.end();
  return done;
}
