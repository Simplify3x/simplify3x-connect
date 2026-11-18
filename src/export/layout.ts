/**
 * Prompt-driven export layout. The client AI turns the user's wording ("only code, name and reason",
 * "group by suite", "add a priority column") into an `ExportLayout`; `resolveLayout` fills in today's
 * standard report for everything not asked for. The structure stays fixed — Summary always first, the
 * section order never changes, the Code column is always present — and every count still comes from the
 * report model. Each test-case column is defined once here, for both the Excel and the PDF writer.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AnalysisReport } from '../adapters/simplifyqa/failureReportModel.js';
import type { XlsxAnyCell, XlsxRichCell, XlsxStyle } from './xlsx.js';

export type Section = 'summary' | 'rootCauses' | 'sources' | 'testCases';
export type TcColumn =
  | 'patternNo' | 'source' | 'code' | 'name' | 'iteration' | 'failedStep' | 'expected' | 'actual'
  | 'pattern' | 'category' | 'reason' | 'lastPassed' | 'failingSince' | 'editedSincePass'
  | 'report' | 'screenshot' | 'lastPassedScreenshot' | 'baseline';
export type GroupBy = 'pattern' | 'source' | 'category';
export type SortBy = 'pattern' | 'code' | 'failingSince' | 'lastPassed' | 'category';
/** A column the AI fills per test case: `values` is keyed by test case code (every iteration row of that
 *  code shows the value); codes not in the report are ignored; other rows show `default` (or blank). */
export type ExtraColumn = { header: string; values: Record<string, string>; default?: string | undefined };
export type ExportLayout = {
  title?: string | undefined; sections?: Section[] | undefined; columns?: TcColumn[] | undefined;
  groupBy?: GroupBy | undefined; sortBy?: SortBy | undefined; extraColumns?: ExtraColumn[] | undefined;
};
export type ResolvedLayout = {
  title?: string; sections: Section[]; xlsxColumns: TcColumn[]; pdfColumns: TcColumn[];
  groupBy: GroupBy; sortBy: SortBy; extraColumns: ExtraColumn[];
  /** Nothing was asked for: the standard report, unchanged. */
  isDefault: boolean;
  /** The user asked for a grouping or sort, so the PDF re-orders rows too (by default it keeps model order). */
  reorder: boolean;
};

type Row = AnalysisReport['testcases'][number];
export type ColumnCtx = { patternNo: Map<string, number> };
type ColumnDef = {
  header: string; xlsxWidth: number; pdfWidth: number;
  xlsx: (t: Row, c: ColumnCtx) => XlsxAnyCell; pdf: (t: Row, c: ColumnCtx) => string;
};

export const SECTIONS: readonly Section[] = ['summary', 'rootCauses', 'sources', 'testCases'];
const SECTION_LABEL: Record<Section, string> = { summary: 'Summary', rootCauses: 'Root causes', sources: 'Sources', testCases: 'Test cases' };
const CATEGORIES = ['APP_DEFECT', 'NEW_CHANGE', 'AUTOMATION_DATA', 'UNCLASSIFIED'] as const;
/** Header of the leading column the Excel sheet gets when grouped by anything but pattern. */
export const GROUP_HEADER = 'Group';
export const EXTRA_XLSX_WIDTH = 24;
export const EXTRA_PDF_WIDTH = 2;
export const GROUP_XLSX_WIDTH = 18;
const MAX_EXTRA = 5;

/** A category cell coloured like the PDF / card (red · amber · blue · grey). */
export const categoryCell = (c: string): XlsxRichCell =>
  ({ v: c, style: ((CATEGORIES as readonly string[]).includes(c) ? c : 'text') as XlsxStyle });

/** Every url one per line, the cell linking to the first (Excel allows one link per cell). */
export const urlsCell = (urls: string[]): XlsxAnyCell => (urls.length ? { v: urls.join('\n'), link: urls[0]! } : '');

const shots = (t: Row): string[] => t.screenshotUrls ?? (t.screenshotUrl ? [t.screenshotUrl] : []);
const lastShots = (t: Row): string[] => t.lastPassedScreenshotUrls ?? (t.lastPassedScreenshotUrl ? [t.lastPassedScreenshotUrl] : []);
const sourceOf = (t: Row): string => t.source ?? t.suite;

/** Plain-text column: the same string in both files. */
const text = (header: string, xlsxWidth: number, pdfWidth: number, get: (t: Row) => string): ColumnDef =>
  ({ header, xlsxWidth, pdfWidth, xlsx: get, pdf: get });
/** Link column: a clickable cell in Excel, the (first) url as text in the PDF. */
const LINK_PDF_WIDTH = 3;

export const TC_COLUMNS: Record<TcColumn, ColumnDef> = {
  patternNo: {
    header: 'Pattern #', xlsxWidth: 9, pdfWidth: 0.8,
    xlsx: (t, c) => c.patternNo.get(t.pattern) ?? '', pdf: (t, c) => String(c.patternNo.get(t.pattern) ?? ''),
  },
  source: text('Source', 12, 1, sourceOf),
  code: text('Code', 10, 1, (t) => t.code),
  name: text('Name', 36, 2, (t) => t.name),
  iteration: text('Iteration', 9, 1, (t) => t.iteration),
  failedStep: text('Failed step', 30, 2, (t) => t.failedStep),
  expected: text('Expected', 28, 1.8, (t) => t.expected ?? ''),
  actual: text('Actual', 28, 1.8, (t) => t.actual ?? ''),
  pattern: text('Pattern', 30, 2, (t) => t.pattern),
  category: { header: 'Category', xlsxWidth: 18, pdfWidth: 2.4, xlsx: (t) => categoryCell(t.category), pdf: (t) => t.category },
  reason: text('Reason', 60, 3, (t) => t.reason),
  lastPassed: text('Last passed', 32, 1, (t) => t.lastPassed ?? ''),
  failingSince: text('Failing since', 28, 1.2, (t) => t.failingSince ?? ''),
  editedSincePass: text('Edited since pass', 18, 1.2, (t) => t.editedSincePass ?? ''),
  report: {
    header: 'Report', xlsxWidth: 22, pdfWidth: LINK_PDF_WIDTH,
    xlsx: (t) => (t.reportUrl ? { v: 'Open report', link: t.reportUrl } : ''), pdf: (t) => t.reportUrl ?? '',
  },
  screenshot: {
    header: 'Screenshot', xlsxWidth: 40, pdfWidth: LINK_PDF_WIDTH,
    xlsx: (t) => urlsCell(shots(t)), pdf: (t) => shots(t)[0] ?? '',
  },
  lastPassedScreenshot: {
    header: 'Last passed run screenshot', xlsxWidth: 40, pdfWidth: LINK_PDF_WIDTH,
    xlsx: (t) => urlsCell(lastShots(t)), pdf: (t) => lastShots(t)[0] ?? '',
  },
  baseline: {
    header: 'Baseline (execution time)', xlsxWidth: 40, pdfWidth: LINK_PDF_WIDTH,
    xlsx: (t) => urlsCell(t.baselineUrl ? [t.baselineUrl] : []), pdf: (t) => t.baselineUrl ?? '',
  },
};
const TC_COLUMN_KEYS = Object.keys(TC_COLUMNS) as [TcColumn, ...TcColumn[]];

/** Today's Excel test-case columns, in today's order. */
export const DEFAULT_XLSX_COLUMNS: TcColumn[] = [...TC_COLUMN_KEYS];
/** Today's PDF test-case columns (no pattern number, no links). */
export const DEFAULT_PDF_COLUMNS: TcColumn[] = [
  'source', 'code', 'name', 'iteration', 'failedStep', 'expected', 'actual', 'pattern', 'category', 'reason',
  'lastPassed', 'failingSince', 'editedSincePass',
];

const RESERVED_HEADERS = new Set([...Object.values(TC_COLUMNS).map((c) => c.header.toLowerCase()), GROUP_HEADER.toLowerCase()]);

export const exportLayoutSchema = z.object({
  title: z.string().trim().min(1).max(120).optional().describe('Report title (Summary sheet + PDF cover).'),
  sections: z.array(z.enum(SECTIONS as [Section, ...Section[]])).optional()
    .describe('Sections to include. Summary is always kept and the order is always Summary, Root causes, Sources, Test cases.'),
  columns: z.array(z.enum(TC_COLUMN_KEYS)).optional()
    .describe('Test-case columns in the order wanted. "code" is always included.'),
  groupBy: z.enum(['pattern', 'source', 'category']).optional().describe('Group test-case rows. Default: pattern.'),
  sortBy: z.enum(['pattern', 'code', 'failingSince', 'lastPassed', 'category']).optional()
    .describe('Sort rows inside each group (code breaks ties). lastPassed / failingSince sort by date, oldest first. Default: pattern.'),
  extraColumns: z.array(z.object({
    header: z.string().trim().min(1).max(40),
    values: z.record(z.string(), z.string()).describe('Test case code → text, e.g. { "TC-1542": "P1" }.'),
    default: z.string().optional().describe('Text for test cases not in values. Default: blank.'),
  }).strict()).max(MAX_EXTRA).optional()
    .describe(`Up to ${MAX_EXTRA} AI-filled columns appended to the test-case table.`),
}).strict().superRefine((l, ctx) => {
  const seen = new Set<string>();
  (l.extraColumns ?? []).forEach((x, i) => {
    const h = x.header.toLowerCase();
    if (RESERVED_HEADERS.has(h)) {
      ctx.addIssue({ code: 'custom', path: ['extraColumns', i, 'header'], message: `"${x.header}" is already a column; use "columns" to show it.` });
    } else if (seen.has(h)) {
      ctx.addIssue({ code: 'custom', path: ['extraColumns', i, 'header'], message: `Duplicate extra column "${x.header}".` });
    }
    seen.add(h);
  });
});

export function resolveLayout(l: ExportLayout = {}): ResolvedLayout {
  const isDefault = Object.values(l).every((v) => v === undefined);
  const wantSections = new Set(l.sections ?? SECTIONS);
  const sections = SECTIONS.filter((s) => s === 'summary' || wantSections.has(s));
  let columns: TcColumn[] | undefined;
  if (l.columns) {
    columns = [...new Set(l.columns)];
    if (!columns.includes('code')) columns.unshift('code');
  }
  return {
    ...(l.title !== undefined ? { title: l.title } : {}),
    sections,
    xlsxColumns: columns ?? [...DEFAULT_XLSX_COLUMNS],
    pdfColumns: columns ?? [...DEFAULT_PDF_COLUMNS],
    groupBy: l.groupBy ?? 'pattern',
    sortBy: l.sortBy ?? 'pattern',
    extraColumns: (l.extraColumns ?? []).map((x) => ({ ...x, values: { ...x.values } })),
    isDefault,
    reorder: l.groupBy !== undefined || l.sortBy !== undefined,
  };
}

export function extraCell(t: Row, x: ExtraColumn): string {
  return Object.prototype.hasOwnProperty.call(x.values, t.code) ? x.values[t.code]! : (x.default ?? '');
}

export function groupKey(t: Row, g: GroupBy, c: ColumnCtx): string {
  if (g === 'source') return sourceOf(t);
  if (g === 'category') return t.category;
  const n = c.patternNo.get(t.pattern);
  return n !== undefined ? `${n}. ${t.pattern}` : t.pattern;
}

const byText = (a: string | undefined, b: string | undefined): number => {
  if (!a) return b ? 1 : 0; // empty last
  if (!b) return -1;
  return a.localeCompare(b, undefined, { numeric: true });
};
/** Oldest first; a row without a (parseable) time after every row with one; 0 when neither has one. */
const byTime = (a: string | undefined, b: string | undefined): number => {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (Number.isNaN(ta)) return Number.isNaN(tb) ? 0 : 1;
  if (Number.isNaN(tb)) return -1;
  return ta - tb;
};
const catRank = (c: string): number => {
  const i = (CATEGORIES as readonly string[]).indexOf(c);
  return i < 0 ? CATEGORIES.length : i;
};
const patRank = (t: Row, c: ColumnCtx): number => c.patternNo.get(t.pattern) ?? 999;

function compareBy(key: GroupBy | SortBy, x: Row, y: Row, c: ColumnCtx): number {
  switch (key) {
    case 'pattern': return patRank(x, c) - patRank(y, c);
    case 'category': return catRank(x.category) - catRank(y.category);
    case 'source': return byText(sourceOf(x), sourceOf(y));
    case 'code': return byText(x.code, y.code);
    case 'failingSince': return byTime(x.failingSinceAt, y.failingSinceAt) || byText(x.failingSince, y.failingSince);
    case 'lastPassed': return byTime(x.lastPassedAt, y.lastPassedAt) || byText(x.lastPassed, y.lastPassed);
  }
}

/** Rows grouped by `groupBy`, then sorted by `sortBy`, then by code. Stable for equal keys. */
export function orderTestcases(rows: Row[], l: ResolvedLayout, c: ColumnCtx): Row[] {
  return [...rows].sort((x, y) =>
    compareBy(l.groupBy, x, y, c) || compareBy(l.sortBy, x, y, c) || x.code.localeCompare(y.code, undefined, { numeric: true }));
}

/** One line saying what was customised, or null for the standard report. */
export function describeLayout(l: ResolvedLayout): string | null {
  if (l.isDefault) return null;
  const parts: string[] = [];
  if (l.title !== undefined) parts.push(`title "${l.title}"`);
  if (l.sections.length !== SECTIONS.length) parts.push(`sections ${l.sections.map((s) => SECTION_LABEL[s]).join(', ')}`);
  if (l.xlsxColumns.join() !== DEFAULT_XLSX_COLUMNS.join()) parts.push(`columns ${l.xlsxColumns.map((k) => TC_COLUMNS[k].header).join(', ')}`);
  if (l.groupBy !== 'pattern') parts.push(`grouped by ${l.groupBy}`);
  if (l.sortBy !== 'pattern') parts.push(`sorted by ${l.sortBy}`);
  if (l.extraColumns.length) parts.push(`extra ${l.extraColumns.map((x) => x.header).join(', ')}`);
  return parts.length ? parts.join('; ') : 'standard';
}

/** `''` for the standard report; otherwise `_layout-<6 hex>`, stable for the same layout, so a custom
 *  export never overwrites the standard one (or a different custom one). */
export function layoutStemSuffix(l: ResolvedLayout): string {
  if (l.isDefault) return '';
  const { isDefault: _d, reorder: _r, ...rest } = l;
  return `_layout-${createHash('sha1').update(JSON.stringify(rest)).digest('hex').slice(0, 6)}`;
}
