/**
 * Failure Analysis v2 orchestration: several codes / executions analysed with ONE shared failed-run
 * budget, then history per execution, step comparisons for every failed iteration that passed
 * before, and one FailureAnalysis (failureAnalysis.buildAnalysis). No model calls.
 */
import type { ExecutionFailureContext, ExecutionFailureInput, FailureIteration } from './failureTypes.js';
import { createHistoryCache, type HistoryCache, type StepComparison, type StepRowsCache, type TestcaseHistory } from './failureHistory.js';
import type { FailureAnalysis } from './failureAnalysisTypes.js';
import { buildAnalysis } from './failureAnalysis.js';
import { parseEntityCode } from './stepRules.js';
import { mapLimit } from './mapLimit.js';

/** Failed iterations analysed per analysis, shared across its executions in the order given. */
export const MAX_ANALYSIS_RUNS = 300;
/** Cause groups per execution whose representative keeps full logs. */
const DETAILED_GROUPS = 25;
/** Log lines per step at most in an analysis — the response goes into the client model's context. */
export const MAX_ANALYSIS_LOG_LINES = 200;
export const HISTORY_NOTE =
  'History: last passed / failing since are searched across every execution of the test case (standalone, any suite, any plan) before this execution.';
const COMPARE_CONCURRENCY = 5;
/** Failed comparisons named in the notes; the rest are counted. */
const MAX_COMPARE_NOTES = 5;

export type FailureAnalysisSource = {
  getExecutionFailures(i: ExecutionFailureInput): Promise<ExecutionFailureContext>;
  getFailureHistory(ctx: ExecutionFailureContext, cache?: HistoryCache): Promise<Map<string, TestcaseHistory>>;
  compareWithLastPass(it: FailureIteration, h: TestcaseHistory, executionItemId: string, rows?: StepRowsCache): Promise<StepComparison | null>;
  fetchFailureImage(url: string, maxBytes: number): Promise<{ data: string; mimeType: string } | null>;
};

export type RunAnalysisInput = { codes?: string[]; executionIds?: string[];
  /** One code INSIDE one execution (the legacy `{ code, executionId }` call) — analysed first. */
  codeInExecution?: { code: string; executionId: string };
  compareWithLastPass?: boolean; includeLogs?: boolean; maxLogLines?: number; includeScreenshots?: boolean };

type Part = { ctx: ExecutionFailureContext; history: Map<string, TestcaseHistory> };

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runAnalysis(
  src: FailureAnalysisSource,
  input: RunAnalysisInput,
  meta: { id: string; owner: string; now: number},
): Promise<FailureAnalysis> {
  const options = {
    ...(input.includeLogs !== undefined ? { includeLogs: input.includeLogs } : {}),
    ...(input.maxLogLines !== undefined ? { maxLogLines: Math.min(input.maxLogLines, MAX_ANALYSIS_LOG_LINES) } : {}),
    ...(input.includeScreenshots !== undefined ? { includeScreenshots: input.includeScreenshots } : {}),
  };
  const requests: Array<{ label: string; ref: { code: string } | { executionId: string } | { code: string; executionId: string } }> = [
    ...(input.codeInExecution
      ? [{ label: `${input.codeInExecution.code} in ${input.codeInExecution.executionId}`, ref: { ...input.codeInExecution } }]
      : []),
    ...(input.codes ?? []).map((code) => ({ label: code, ref: { code } })),
    ...(input.executionIds ?? []).map((executionId) => ({ label: executionId, ref: { executionId } })),
  ];
  if (!requests.length) throw new Error('Provide at least one code (TC-123 / SU-123 / PL-123) or executionId.');

  // ---------------------------------------------------------------- 1. contexts, one budget
  const notes: string[] = [];
  const contexts: ExecutionFailureContext[] = [];
  let remaining = MAX_ANALYSIS_RUNS;
  /** Input label that analysed each execution — by id and by EX code. */
  const analysedBy = new Map<string, string>();
  const sameAs = (key: string | undefined): string | undefined => (key === undefined ? undefined : analysedBy.get(key.trim().toUpperCase()));
  for (const { label, ref } of requests) {
    if ('code' in ref && !parseEntityCode(ref.code)) {
      notes.push(`${label}: not a TC-/SU-/PL- code`);
      continue;
    }
    // A plain execution input already analysed (by id or EX code): nothing read, no budget spent.
    const known = 'executionId' in ref && !('code' in ref) ? sameAs(ref.executionId) : undefined;
    if (known !== undefined) {
      notes.push(`${label}: same execution as ${known}`);
      continue;
    }
    if (remaining <= 0) {
      notes.push(`${label}: not analysed — the ${MAX_ANALYSIS_RUNS} failed-run limit was reached`);
      continue;
    }
    try {
      const ctx = await src.getExecutionFailures({ ...ref, ...options, maxFailedRuns: remaining, detailedGroups: DETAILED_GROUPS });
      // A code that resolves to an execution already analysed: dropped, and its runs are not counted.
      const dup = sameAs(String(ctx.execution.id));
      if (dup !== undefined) {
        notes.push(`${label}: same execution as ${dup}`);
        continue;
      }
      analysedBy.set(String(ctx.execution.id).toUpperCase(), label);
      if (ctx.execution.code) analysedBy.set(ctx.execution.code.toUpperCase(), label);
      analysedBy.set(`EX-${ctx.execution.id}`.toUpperCase(), label);
      remaining -= ctx.counts.analysedRuns;
      contexts.push(ctx);
    } catch (e) {
      notes.push(`${label}: ${messageOf(e)}`);
    }
  }
  if (!contexts.length) throw new Error(notes.join('\n'));


  const finish = (a: FailureAnalysis): FailureAnalysis => ({ ...a, notes: [...a.notes, ...notes] });

  if (input.compareWithLastPass === false) {
    return finish(buildAnalysis(contexts.map((ctx) => ({ ctx, history: new Map() })), {}, meta));
  }

  // ---------------------------------------------------------------- 2. history, once per execution
  const parts: Part[] = [];
  const unknownHistory = (ctx: ExecutionFailureContext): Map<string, TestcaseHistory> =>
    new Map(ctx.testcases.map((t) => [String(t.executionItemId), { status: 'unknown' } as TestcaseHistory]));
  // One cache for the whole analysis: a test case failing in several executions is searched once.
  const cache = createHistoryCache(contexts);
  for (const ctx of contexts) {
    const ref = ctx.execution.code ?? `EX-${ctx.execution.id}`;
    try {
      const history = await src.getFailureHistory(ctx, cache);
      if ([...history.values()].some((h) => h.status === 'unknown')) {
        notes.push(`${ref}: history could not be read for some test cases (run search failed) — shown as "history unavailable".`);
      }
      if ([...history.values()].some((h) => h.failingSinceUnavailable)) {
        notes.push(`${ref}: failing since could not be read for some test cases (failed-run search failed) — shown as "failing since unavailable".`);
      }
      parts.push({ ctx, history });
    } catch (e) {
      notes.push(`${ref}: history could not be read — ${messageOf(e)}; shown as "history unavailable".`);
      parts.push({ ctx, history: unknownHistory(ctx) });
    }
  }
  notes.push(HISTORY_NOTE);

  // ---------------------------------------------------------------- 3. comparisons for EVERY failed iteration
  // Every failed iteration with a last pass is compared (the review reads each failed test case);
  // one step-rows read per passed run, shared through `rows`.
  const byKey = new Map<string, { it: FailureIteration; executionItemId: string; history?: TestcaseHistory }>();
  for (const { ctx, history } of parts) {
    const execId = String(ctx.execution.id);
    for (const e of ctx.testcases) {
      const h = history.get(String(e.executionItemId));
      for (const it of e.failedIterations) {
        const key = `${execId}:${it.runId}`;
        if (!byKey.has(key)) byKey.set(key, { it, executionItemId: String(e.executionItemId), ...(h ? { history: h } : {}) });
      }
    }
  }
  const wanted = [...byKey.keys()].filter((k) => byKey.get(k)?.history?.lastPassed);
  const comparisons: Record<string, StepComparison | null> = {};
  const rows: StepRowsCache = new Map();
  const compareErrors: string[] = [];
  await mapLimit(wanted, COMPARE_CONCURRENCY, async (key) => {
    const { it, executionItemId, history } = byKey.get(key)!;
    try {
      comparisons[key] = await src.compareWithLastPass(it, history!, executionItemId, rows);
    } catch (e) {
      comparisons[key] = null;
      compareErrors.push(`${it.label}: comparison with the last pass failed — ${messageOf(e)}`);
    }
  });
  // Every failed iteration is compared now: a few failures are named, the rest counted.
  notes.push(...compareErrors.slice(0, MAX_COMPARE_NOTES));
  if (compareErrors.length > MAX_COMPARE_NOTES) {
    notes.push(`… ${compareErrors.length - MAX_COMPARE_NOTES} more comparisons with the last pass failed.`);
  }

  // ---------------------------------------------------------------- 4. build: suggestions use them
  return finish(buildAnalysis(parts, comparisons, meta));
}
