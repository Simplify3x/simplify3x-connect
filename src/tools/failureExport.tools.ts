/**
 * `failure_analysis_export` — writes the official Excel and PDF reports (plus `analysis.json`) for a
 * stored failure analysis, with the filters applied. Counts and masking come from the report model.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveOutDir } from './outDir.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { AnalysisFilter, FailureAnalysis } from '../adapters/simplifyqa/failureAnalysisTypes.js';
import { buildReportModel, maskWith, protectedValues } from '../adapters/simplifyqa/failureReportModel.js';
import type { AnalysisReport } from '../adapters/simplifyqa/failureReportModel.js';
import { mapLimit } from '../adapters/simplifyqa/mapLimit.js';
import { buildXlsxBook } from '../export/xlsx.js';
import type { XlsxAnyCell, XlsxSheet } from '../export/xlsx.js';
import {
  EXTRA_XLSX_WIDTH, GROUP_HEADER, GROUP_XLSX_WIDTH, TC_COLUMNS, categoryCell, describeLayout, exportLayoutSchema, extraCell,
  groupKey, layoutStemSuffix, orderTestcases, resolveLayout, type ColumnCtx, type ExportLayout, type ResolvedLayout, type Section,
} from '../export/layout.js';
import { ROOT_CAUSE_HEADERS, pdfLayout, renderPdf } from '../export/pdf.js';
import type { PdfImage } from '../export/pdf.js';
import { reportToJson } from '../export/json.js';
import type { FailureAnalysisStore } from './failureAnalysisStore.js';

export type FailureExportToolsDeps = {
  getAdapter: () => ProviderAdapter | null;
  getOwnerKey: () => string | null;
  store: FailureAnalysisStore<FailureAnalysis>;
  /** False on a server other machines can reach: a caller `outDir` is then ignored (tools/outDir.ts). Default true. */
  allowOutDir?: boolean;
};

const NOT_CONNECTED =
  'Not connected to a product. Use qa_connect({ url, token, projectId }) first — failure_analysis needs a live SimplifyQA connection.';

const MAX_THUMBNAILS = 30;
const THUMB_CONCURRENCY = 5;
const THUMB_MAX_BYTES = 1_000_000;

type ImageFetcher = (url: string, maxBytes: number) => Promise<{ data: string; mimeType: string } | null>;

/**
 * The workbook mirrors the PDF: Summary (scope + category split), Root causes (same numbering and columns
 * as the PDF table), Sources (per suite / plan / standalone source) and Test cases (one row per failed
 * iteration, grouped by pattern number, with clickable report / screenshot links).
 *
 * `layout` (from the user's request) can retitle it, drop the non-summary sheets, pick / reorder the
 * test-case columns, regroup / resort rows and add AI-filled columns. Without it the workbook is the
 * standard one. Counts always come from the report model.
 */
export function xlsxSheets(r: AnalysisReport, layout: ResolvedLayout = resolveLayout()): XlsxSheet[] {
  // Pattern numbers as the PDF shows them (1..n in root-cause order), so both files agree.
  const patternNo = new Map(r.patterns.map((p, i) => [p.pattern, i + 1]));
  const ctx: ColumnCtx = { patternNo };
  const total = r.summary.reduce((n, s) => n + s.testcases, 0);
  const testcases = orderTestcases(r.testcases, layout, ctx);
  const described = describeLayout(layout);
  const grouped = layout.groupBy !== 'pattern';
  const cols = layout.xlsxColumns.map((k) => TC_COLUMNS[k]);
  const sheets: Record<Section, XlsxSheet> = {
    summary: {
      name: 'Summary',
      title: layout.title ?? r.title,
      notes: [
        `Scope: ${r.scope.executions.join(', ') || 'none'}`,
        `Sources: ${r.scope.suites.join(', ') || 'none'}`,
        `Filters: ${r.scope.filters}`,
        ...(described ? [`Layout: ${described}`] : []),
        `Generated at: ${r.scope.generatedAt}`,
        `Failed test cases: ${r.totals.failedTestcases} · Failed iterations: ${r.totals.failedIterations} · Passed test cases: ${r.totals.passedTestcases}`,
      ],
      headers: ['Category', 'Test cases', 'Percent'],
      widths: [28, 14, 12],
      autoFilter: false,
      rows: r.summary.map((s) => [categoryCell(s.category), s.testcases, { v: `${s.percent}%`, style: 'number' as const }]),
      totals: [['Total', total, '100%']],
    },
    rootCauses: {
      name: 'Root causes',
      title: 'Failure patterns / root causes',
      headers: ROOT_CAUSE_HEADERS,
      widths: [5, 34, 70, 20, 12, 10, 48],
      rows: r.patterns.map((p, i) => [
        i + 1, { v: p.pattern, style: 'bold' as const }, p.rootCause, categoryCell(p.category), p.confidence, p.testcases, p.testcaseIds.join(', '),
      ]),
    },
    sources: {
      name: 'Sources',
      title: 'Failures by source (suite / plan / standalone)',
      headers: ['Source', 'Failed', 'App defect', 'New change', 'Automation/data', 'Unclassified', 'Top patterns'],
      widths: [18, 9, 11, 11, 15, 13, 80],
      rows: r.suites.map((s) => [
        s.suite, s.failed, s.byCategory.APP_DEFECT ?? 0, s.byCategory.NEW_CHANGE ?? 0,
        s.byCategory.AUTOMATION_DATA ?? 0, s.byCategory.UNCLASSIFIED ?? 0, s.topPatterns.join('\n'),
      ]),
    },
    testCases: {
      name: 'Test cases',
      title: `Failed test cases (one row per failed iteration, grouped by ${grouped ? layout.groupBy : 'pattern #'})`,
      headers: [
        ...(grouped ? [GROUP_HEADER] : []), ...cols.map((c) => c.header), ...layout.extraColumns.map((x) => x.header),
      ],
      widths: [
        ...(grouped ? [GROUP_XLSX_WIDTH] : []), ...cols.map((c) => c.xlsxWidth), ...layout.extraColumns.map(() => EXTRA_XLSX_WIDTH),
      ],
      // Link columns carry every screenshot url of each step, one per line in its cell.
      rows: testcases.map((t): XlsxAnyCell[] => [
        ...(grouped ? [groupKey(t, layout.groupBy, ctx)] : []),
        ...cols.map((c) => c.xlsx(t, ctx)),
        ...layout.extraColumns.map((x) => extraCell(t, x)),
      ]),
    },
  };
  return layout.sections.map((s) => sheets[s]);
}

async function fetchThumbnails(r: AnalysisReport, fetchImage: ImageFetcher | undefined): Promise<PdfImage[]> {
  if (!fetchImage) return [];
  const wanted = r.patterns.filter((p) => p.screenshotUrl).slice(0, MAX_THUMBNAILS);
  const got = await mapLimit(wanted, THUMB_CONCURRENCY, async (p): Promise<PdfImage | null> => {
    try {
      const img = await fetchImage(p.screenshotUrl!, THUMB_MAX_BYTES);
      return img ? { patternId: p.id, data: Buffer.from(img.data, 'base64') } : null;
    } catch {
      return null;
    }
  });
  return got.filter((x): x is PdfImage => x !== null);
}

export function registerFailureExportTools(server: McpServer, deps: FailureExportToolsDeps): void {
  server.registerTool(
    'failure_analysis_export',
    {
      title: 'Export a failure analysis to Excel / PDF',
      description:
        'Write the official report files for a stored failure analysis (from `failure_analysis`): Excel (`xlsx`) and/or PDF (`pdf`), plus `analysis.json`. ' +
        'Pass the `analysisId` it returned and the `format`. Optional filters (`suiteId`, `pattern`, `category`, `view`) are applied to every file. ' +
        'Files are saved under `outDir` (default ./qa-reports) and their paths returned. Protected test data is masked as ***. ' +
        'Optional `layout` reshapes the report to what the user asked for: `title`, `sections` (summary is always kept; order is fixed), ' +
        `test-case \`columns\` in the wanted order (keys: ${Object.keys(TC_COLUMNS).join(', ')}; code is always included), ` +
        '`groupBy` (pattern | source | category), `sortBy` (pattern | code | failingSince | lastPassed | category), and up to 5 ' +
        '`extraColumns` ({ header, values: { "<test case code>": "<text>" }, default? }) — fill extra values only from evidence you reviewed. ' +
        'Counts and percentages are always computed by the server. Omit `layout` for the standard report; a custom layout gets its own file name.',
      inputSchema: {
        analysisId: z.string().min(1).describe('Id from failure_analysis (FA-xxxxxxxx).'),
        format: z.array(z.enum(['xlsx', 'pdf'])).min(1, 'Choose at least one format: xlsx and/or pdf.')
          .describe('Which files to write: "xlsx", "pdf" or both.'),
        view: z.enum(['consolidated', 'suite']).optional(),
        suiteId: z.string().optional().describe('Only this suite.'),
        pattern: z.union([z.number(), z.array(z.number())]).optional().describe('Only these pattern ids.'),
        category: z.enum(['APP_DEFECT', 'NEW_CHANGE', 'AUTOMATION_DATA', 'UNCLASSIFIED']).optional(),
        outDir: z.string().optional().describe('Folder to save into. Default: ./qa-reports'),
        layout: exportLayoutSchema.optional().describe('Customise the report to the user request. Omit for the standard report.'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const formats = [...new Set(args.format ?? [])];
      if (!formats.length) return err('Choose at least one format: `xlsx` and/or `pdf`.');
      const adapter = deps.getAdapter();
      const owner = deps.getOwnerKey();
      if (!adapter || owner === null) return err(NOT_CONNECTED);
      const analysis = deps.store.get(args.analysisId, owner);
      if (!analysis) {
        return err(`Analysis ${args.analysisId} is not available (expired, or from another connection/project). Run failure_analysis again.`);
      }
      // Validated here too (not only by the SDK) so a bad layout is a clear error and never a partial export.
      const parsed = exportLayoutSchema.safeParse(args.layout ?? {});
      if (!parsed.success) {
        const why = parsed.error.issues.map((i) => `${['layout', ...i.path].join('.')}: ${i.message}`).join('; ');
        return err(`Invalid layout — ${why}`);
      }
      try {
        // AI-written extra-column text is masked like every other value in the report.
        const mask = maskWith(protectedValues(analysis));
        const m = (s: string): string => mask(s) ?? s;
        const asked: ExportLayout = parsed.data;
        const layout = resolveLayout({
          ...asked,
          ...(asked.title !== undefined ? { title: m(asked.title) } : {}),
          ...(asked.extraColumns ? {
            extraColumns: asked.extraColumns.map((x) => ({
              header: m(x.header),
              values: Object.fromEntries(Object.entries(x.values).map(([k, v]) => [k, m(v)])),
              ...(x.default !== undefined ? { default: m(x.default) } : {}),
            })),
          } : {}),
        });
        const described = describeLayout(layout);
        const filter: AnalysisFilter = {
          ...(args.view !== undefined ? { view: args.view } : {}),
          ...(args.suiteId !== undefined ? { suiteId: args.suiteId } : {}),
          ...(args.pattern !== undefined ? { pattern: args.pattern } : {}),
          ...(args.category !== undefined ? { category: args.category } : {}),
        };
        const report = buildReportModel(analysis, filter, new Date());
        const { dir, note: outDirNote } = resolveOutDir(args.outDir, deps.allowOutDir !== false);
        await mkdir(dir, { recursive: true });

        const out: Array<{ format: string; path: string; bytes: number }> = [];
        const write = async (ext: string, data: Buffer | string) => {
          // A custom layout gets its own stem so it never overwrites the standard (or another custom) report.
          const path = join(dir, `${report.fileStem}${layoutStemSuffix(layout)}.${ext}`);
          await writeFile(path, data);
          out.push({ format: ext, path, bytes: Buffer.byteLength(data) });
        };
        if (formats.includes('xlsx')) await write('xlsx', buildXlsxBook(xlsxSheets(report, layout)));
        if (formats.includes('pdf')) {
          const fetchImage = (adapter as { fetchFailureImage?: ImageFetcher }).fetchFailureImage?.bind(adapter);
          // Pattern thumbnails only appear in the Root causes section.
          const images = layout.sections.includes('rootCauses') ? await fetchThumbnails(report, fetchImage) : [];
          await write('pdf', await renderPdf(pdfLayout(report, layout), images));
        }
        await write('json', reportToJson(report));

        const lines = out.map((f) => `- ${f.format.toUpperCase()} — \`${f.path}\` (${(f.bytes / 1024).toFixed(0)} KB)`).join('\n');
        return ok(
          `Exported failure analysis ${analysis.id} (filters: ${report.scope.filters}${described ? `; layout: ${described}` : ''}).\n\n${lines}` +
            (outDirNote ? `\n\n${outDirNote}` : ''),
          { files: out, analysisId: analysis.id, layout: described },
        );
      } catch (e) {
        return err(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
