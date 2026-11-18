/**
 * `failure_analysis` (analyse + view) and `failure_analysis_classify` — Failure Analysis v2 on SimplifyQA.
 *
 * Analyse builds one FailureAnalysis from several codes / executions (failureAnalysisRun.runAnalysis),
 * stores it under the caller's owner key and returns the first view (card + evidence + image pairs).
 * View re-renders a stored analysis with filters — no re-fetch; review pages through every failed test case
 * (failureReview.ts) with its images. Classify records the client model's
 * verdicts (failureAnalysis.applyVerdicts) and returns the classified card. Counts and % are code; the
 * MCP never asserts a root cause itself.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, okWithImages, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import { runAnalysis, type FailureAnalysisSource } from '../adapters/simplifyqa/failureAnalysisRun.js';
import { CATEGORY_DEFINITIONS, renderAnalysisView, type AnalysisView } from '../adapters/simplifyqa/failureAnalysisCard.js';
import { MAX_INLINE_IMAGE_BYTES } from '../adapters/simplifyqa/failureReport.js';
import { applyVerdicts, type VerdictInput } from '../adapters/simplifyqa/failureAnalysis.js';
import type { AnalysisFilter, FailureAnalysis } from '../adapters/simplifyqa/failureAnalysisTypes.js';
import { renderReviewPage, reviewedLine, type ReviewView } from '../adapters/simplifyqa/failureReview.js';
import { mapLimit } from '../adapters/simplifyqa/mapLimit.js';
import type { FailureAnalysisStore } from './failureAnalysisStore.js';

const REVIEW_FETCH_CONCURRENCY = 4;

export type FailureToolsDeps = {
  getAdapter: () => ProviderAdapter | null;
  /** Owner scope for stored analyses (token hash + project); null when not connected. */
  getOwnerKey: () => string | null;
  store: FailureAnalysisStore<FailureAnalysis>;
};

const NOT_CONNECTED =
  'Not connected to a product. Use qa_connect({ url, token, projectId }) first — failure_analysis needs a live SimplifyQA connection.';
const SQA_ONLY = 'failure_analysis is available only on a SimplifyQA connection.';
const CLASSIFIED_TAIL = 'Classified. Reply now: start with this card exactly as shown, then Why / Fix for each pattern.';

const notAvailable = (id: string): string =>
  `Analysis ${id} is not available (expired, or from another connection/project). Run failure_analysis again.`;

/** The number in an id / business key ("TC-12" → "12"); anything without one is kept as given. */
const idNumber = (id: string): string => /\d+/.exec(id)?.[0] ?? id;

/** SimplifyQA implements the v2 source; Walnut does not (no failure history). */
function asSource(adapter: ProviderAdapter): FailureAnalysisSource | null {
  const a = adapter as Partial<FailureAnalysisSource>;
  return typeof a.getFailureHistory === 'function' && typeof a.getExecutionFailures === 'function'
    ? (adapter as unknown as FailureAnalysisSource)
    : null;
}

/** Marks the groups whose evidence a response showed; returns the analysis unchanged when none are new. */
function markShown(a: FailureAnalysis, ids: number[]): FailureAnalysis {
  const shown = new Set(ids);
  if (!a.groups.some((g) => shown.has(g.id) && !g.evidenceShown)) return a;
  return { ...a, groups: a.groups.map((g) => (shown.has(g.id) && !g.evidenceShown ? { ...g, evidenceShown: true } : g)) };
}

/** The view's text plus its image pairs (failed / last passed), each captioned; failed fetches are skipped. */
async function withImages(source: FailureAnalysisSource, v: AnalysisView, includeImages: boolean | undefined) {
  if (includeImages === false || !v.imageRequests.length) return ok(v.text);
  const images: Array<{ caption: string; data: string; mimeType: string }> = [];
  for (const req of v.imageRequests) {
    try {
      const img = await source.fetchFailureImage(req.url, MAX_INLINE_IMAGE_BYTES);
      if (img) images.push({ caption: req.caption, ...img });
    } catch {
      // A missing screenshot never fails the analysis.
    }
  }
  // Text only, no structuredContent: clients that find a structured result hand THAT to the
  // model instead of the text, and the card and evidence are in the text.
  return images.length ? okWithImages(v.text, images) : ok(v.text);
}

/** A review page: its text, then each image slot in order — the captioned image, or its text note
 *  when the slot has no image or the fetch fails. Fetched 4 at a time with the 1 MB cap, in order. */
async function withReviewImages(source: FailureAnalysisSource, v: ReviewView, includeImages: boolean | undefined) {
  if (includeImages === false) return ok(v.text);
  const parts = await mapLimit(v.images, REVIEW_FETCH_CONCURRENCY, async (slot) => {
    let img: { data: string; mimeType: string } | null = null;
    if (slot.url !== undefined) {
      try {
        img = await source.fetchFailureImage(slot.url, MAX_INLINE_IMAGE_BYTES);
      } catch {
        img = null; // A missing image never fails the review.
      }
    }
    return img ? { caption: slot.caption, ...img } : { caption: slot.missing };
  });
  // The same bytes under another url are sent once: a passed step's thumbnail that is today's says
  // "same element thumbnail as today"; any other duplicate says which image it repeats.
  const seen = new Map<string, { caption: string; kind: string }>();
  const deduped = parts.map((p, i) => {
    if (!('data' in p)) return p;
    const slot = v.images[i]!;
    const first = seen.get(p.data);
    if (first === undefined) { seen.set(p.data, { caption: slot.caption, kind: slot.kind }); return p; }
    const why = slot.kind === 'passed thumbnail' && first.kind === 'element thumbnail' ? 'same element thumbnail as today' : `same image as ${first.caption}`;
    return { caption: `${slot.label} · ${slot.kind}: ${why}` };
  });
  return okWithImages(v.text, deduped);
}

/** Records a review page on the stored analysis: its test cases in `reviewedKeys`, their groups shown. */
function markReviewed(a: FailureAnalysis, v: ReviewView): FailureAnalysis {
  const before = a.reviewedKeys ?? [];
  const added = v.testcaseKeys.filter((k) => !before.includes(k));
  const marked = markShown(a, v.groups);
  return added.length ? { ...marked, reviewedKeys: [...before, ...added] } : marked;
}

const VERDICT = z.object({
  group: z.number().int(),
  pattern: z.string().min(1),
  rootCause: z.string().min(1),
  category: z.enum(['APP_DEFECT', 'NEW_CHANGE', 'AUTOMATION_DATA']),
  confidence: z.enum(['high', 'medium', 'low']),
  mergeInto: z.number().int().optional(),
  splitOut: z.array(z.string()).optional(),
});
const CLASSIFY_SHAPE = {
  analysisId: z.string().min(1).describe('Id from failure_analysis (FA-xxxxxxxx).'),
  verdicts: z.array(VERDICT).min(1).describe(
    'One entry per pattern group: { group, pattern (short name), rootCause (one or two sentences, from the evidence), ' +
    'category (APP_DEFECT | NEW_CHANGE | AUTOMATION_DATA), confidence (high | medium | low), mergeInto? (same pattern as that group), ' +
    'splitOut? (iteration keys "<executionId>:<runId>" that do not belong here → their own group) }.',
  ),
};

const DESCRIPTION =
  'Analyse FAILED SimplifyQA executions — test cases, suites, execution plans — together. ' +
  'ANALYSE: `codes` (TC-123 / SU-123 / PL-123, each → its latest execution) and/or `executionIds` (id or EX code); `code` / `executionId` work too. ' +
  'Returns an `analysisId` (FA-…), a card (scope, failures by category with counts and %, patterns, failed test cases) and evidence per pattern.\n' +
  'VIEW: pass `analysisId` (no re-fetch) with `view` ("consolidated" | "suite"), `suiteId`, `pattern` (n or [n,…]), `category` or `page`.\n' +
  'REVIEW: `{ analysisId, review: true, page? }` — every failed test case, as many per page as fit 18 images: its failed step and the same step in the last pass at the same detail (expected / actual, test data, full API, locator, logs), ' +
  'with every screenshot of both steps, the baseline of both runs and the element thumbnail.\n' +
  'Images: the failed screenshot is this run. The baseline is the execution-time reference page with the target element boxed in red. The thumbnail is the target element as recorded. Same page as the baseline but the element missing or different from the thumbnail means the element or locator changed. A different page (error, blank, another screen) means the flow did not reach it. Recorded images show recording-time data: compare layout and element, not values.\n\n' +
  'Do this, in order:\n' +
  '(1) Read the card and the evidence.\n' +
  '(2) Page the remaining groups with `pattern:[…]` exactly as the card\'s "Next:" line says, until every pattern\'s evidence has been read.\n' +
  '(3) Review every failed test case with `review: true`, following its "Next:" line until done: compare the last passed step with the failed step (data, API, locator, logs, version, every image) and state what changed and what stayed the same.\n' +
  '(4) Call `failure_analysis_classify` ONCE with a verdict for ALL groups (`splitOut` test cases whose review shows another cause; `mergeInto` groups that share one).\n' +
  '(5) Reply starting with the classified card exactly as returned (same tables and rows, never reworded), then Why / Fix per pattern from the evidence.\n' +
  `Categories: ${CATEGORY_DEFINITIONS.join(' ')}\n` +
  'A "suggested:" category is a rule hint, not a verdict. For Excel / PDF files use `failure_analysis_export`.';

export function registerFailureTools(server: McpServer, deps: FailureToolsDeps): void {
  /** Connection + provider + owner checks shared by both tools. */
  const resolve = (): { source: FailureAnalysisSource; owner: string } | { error: string } => {
    const adapter = deps.getAdapter();
    if (!adapter) return { error: NOT_CONNECTED };
    const source = asSource(adapter);
    if (!source) return { error: SQA_ONLY };
    const owner = deps.getOwnerKey();
    if (owner === null) return { error: NOT_CONNECTED };
    return { source, owner };
  };

  server.registerTool(
    'failure_analysis',
    {
      title: 'Analyse failed SimplifyQA test cases, suites or execution plans',
      description: DESCRIPTION,
      inputSchema: {
        codes: z.array(z.string()).optional().describe('TC-123 / SU-123 / PL-123 — each analysed at its latest execution.'),
        code: z.string().optional().describe('One code (same as codes:[code]).'),
        executionIds: z.array(z.string()).optional().describe('Execution ids or EX codes — only these executions.'),
        executionId: z.string().optional().describe('One execution id or EX code (same as executionIds:[id]).'),
        runId: z.string().optional().describe('Same as executionId (kept for older calls).'),
        tcId: z.string().optional().describe('Test case id — same as code TC-<id>.'),
        compareWithLastPass: z.boolean().optional().describe('Compare each pattern\'s failure with the last pass (default true).'),
        analysisId: z.string().optional().describe('VIEW an existing analysis (FA-…) instead of analysing again.'),
        view: z.enum(['consolidated', 'suite']).optional().describe('View: one list (default) or per suite.'),
        suiteId: z.string().optional().describe('With analysisId: only this suite (SU-12 or 12). Without it: same as code SU-<id>.'),
        pattern: z.union([z.number().int(), z.array(z.number().int())]).optional().describe('With analysisId: these pattern groups, with full evidence.'),
        category: z.enum(['APP_DEFECT', 'NEW_CHANGE', 'AUTOMATION_DATA', 'UNCLASSIFIED']).optional().describe('With analysisId: only this category.'),
        page: z.number().int().positive().optional().describe('With analysisId: page of the groups list (or of the review with review:true).'),
        review: z.boolean().optional().describe('With analysisId: review EVERY failed test case, as many per page as fit 18 images (failed step vs the last pass, with every image of both). Follow its "Next:" line until done.'),
        includeLogs: z.boolean().optional().describe('Include execution logs (default true).'),
        maxLogLines: z.number().int().positive().max(2000).optional().describe('Cap logs per step — the lines nearest the failure are kept (default 30).'),
        includeScreenshots: z.boolean().optional().describe('Include screenshot artifact URLs (default true).'),
        includeImages: z.boolean().optional().describe('Return failed / last-passed screenshot pairs for the patterns shown as inline images (default true; analyse and view). Set false for text only.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const r = resolve();
      if ('error' in r) return err(r.error);
      const { source, owner } = r;

      // ---- View: re-render a stored analysis — no re-fetch (only the shown groups' images).
      if (args.analysisId !== undefined) {
        const stored = deps.store.get(args.analysisId, owner);
        if (!stored) return err(notAvailable(args.analysisId));
        const filter: AnalysisFilter = {
          ...(args.view !== undefined ? { view: args.view } : {}),
          ...(args.suiteId !== undefined ? { suiteId: args.suiteId } : {}),
          ...(args.pattern !== undefined ? { pattern: args.pattern } : {}),
          ...(args.category !== undefined ? { category: args.category } : {}),
          ...(args.page !== undefined ? { page: args.page } : {}),
        };
        if (args.review === true) {
          try {
            const v = renderReviewPage(stored, args.page ?? 1);
            const marked = markReviewed(stored, v);
            if (marked !== stored) deps.store.replace(marked);
            return await withReviewImages(source, v, args.includeImages);
          } catch (e) {
            return err(e instanceof Error ? e.message : String(e));
          }
        }
        try {
          const v = renderAnalysisView(stored, filter, 'view');
          const marked = markShown(stored, v.evidenceGroups);
          if (marked !== stored) deps.store.replace(marked);
          return await withImages(source, v, args.includeImages);
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      }

      // ---- Analyse: build, store, render the first view.
      const codes = [
        ...(args.codes ?? []),
        ...(args.code !== undefined ? [args.code] : []),
        ...(args.tcId !== undefined ? [`TC-${idNumber(args.tcId)}`] : []),
        ...(args.suiteId !== undefined ? [`SU-${idNumber(args.suiteId)}`] : []),
      ];
      const executionIds = [
        ...(args.executionIds ?? []),
        ...(args.executionId !== undefined ? [args.executionId] : []),
        ...(args.runId !== undefined ? [args.runId] : []),
      ];
      // Legacy `{ code, executionId }`: that code INSIDE that execution — one ref, not two scopes.
      const legacyPair = args.codes === undefined && args.executionIds === undefined
        && codes.length === 1 && executionIds.length === 1;
      if (!codes.length && !executionIds.length) {
        return err('Provide `code` / `codes` (TC-123 / SU-123 / PL-123) or `executionId` / `executionIds` (an execution id or EX code).');
      }
      try {
        const analysis = await runAnalysis(source, {
          ...(legacyPair ? { codeInExecution: { code: codes[0]!, executionId: executionIds[0]! } } : { codes, executionIds }),
          ...(args.compareWithLastPass !== undefined ? { compareWithLastPass: args.compareWithLastPass } : {}),
          ...(args.includeLogs !== undefined ? { includeLogs: args.includeLogs } : {}),
          ...(args.maxLogLines !== undefined ? { maxLogLines: args.maxLogLines } : {}),
          ...(args.includeScreenshots !== undefined ? { includeScreenshots: args.includeScreenshots } : {}),
        }, { id: deps.store.newId(), owner, now: Date.now() });
        deps.store.put(analysis);
        const v = renderAnalysisView(analysis, {}, 'first');
        deps.store.replace(markShown(analysis, v.evidenceGroups));
        return await withImages(source, v, args.includeImages);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'failure_analysis_classify',
    {
      title: 'Record verdicts for a failure analysis',
      description:
        'Record your verdict for EVERY pattern group of a failure analysis, in ONE call, after reading the evidence of all of them ' +
        '(page unseen groups with failure_analysis({ analysisId, pattern: [...] }) first — a group whose evidence was never shown is rejected) ' +
        'and reviewing every failed test case with failure_analysis({ analysisId, review: true }). Use `splitOut` for test cases whose review shows a different cause ' +
        'and `mergeInto` for groups that share a root cause. An incomplete review is accepted; the card then says how many test cases were reviewed. ' +
        'The MCP applies merges / splits, recomputes counts and %, and returns the classified card: start your reply with it exactly as returned. ' +
        'Calling again overwrites a group\'s verdict. Changes only this MCP\'s memory — nothing is written to SimplifyQA. ' +
        `Categories: ${CATEGORY_DEFINITIONS.join(' ')}`,
      inputSchema: CLASSIFY_SHAPE,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const parsed = z.object(CLASSIFY_SHAPE).safeParse(args);
      if (!parsed.success) {
        return err(parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('\n'));
      }
      const r = resolve();
      if ('error' in r) return err(r.error);
      const { analysisId, verdicts } = parsed.data;
      const stored = deps.store.get(analysisId, r.owner);
      if (!stored) return err(notAvailable(analysisId));

      const input: VerdictInput[] = verdicts.map((v) => ({
        group: v.group, pattern: v.pattern, rootCause: v.rootCause, category: v.category, confidence: v.confidence,
        ...(v.mergeInto !== undefined ? { mergeInto: v.mergeInto } : {}),
        ...(v.splitOut !== undefined ? { splitOut: v.splitOut } : {}),
      }));
      const res = applyVerdicts(stored, input);
      if (!res.ok) {
        const unseen = [...new Set(res.errors
          .map((e) => /^group (\d+): evidence not shown yet/.exec(e)?.[1])
          .filter((x): x is string => x !== undefined)
          .map(Number))].sort((x, y) => x - y);
        const lines = [...res.errors];
        if (unseen.length) {
          lines.push('', 'Fetch unseen groups with failure_analysis({ analysisId, pattern: [...] }) first.',
            `Unseen: failure_analysis({ analysisId: "${analysisId}", pattern: [${unseen.join(', ')}] })`);
        }
        return err(lines.join('\n'));
      }
      try {
        // Only the card goes back — every failed test case, no evidence, no Next: — so the reply
        // follows, not another loop. Nothing is marked: the card shows no evidence.
        deps.store.replace(res.analysis);
        // An incomplete review is never rejected (the model may run out of budget): the card says so.
        const reviewed = reviewedLine(res.analysis);
        return ok(`${renderAnalysisView(res.analysis, {}, 'card').text}${reviewed ? `\n\n${reviewed}` : ''}\n\n${CLASSIFIED_TAIL}`);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
