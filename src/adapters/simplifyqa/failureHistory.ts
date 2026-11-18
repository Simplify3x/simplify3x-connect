/**
 * Level-1 failure history: for each failed test case of an execution, its last PASSED run and how
 * long it has been failing — searched across EVERY execution of the test case (standalone, any
 * suite, any plan) before the analysed one. Pure rules over run rows of `/exec/report/search`;
 * the searches themselves are `ExecutionFailureAnalysis.failureHistory`.
 */
import { notDeleted } from './mapper.js';
import { iterationLabel } from './stepRules.js';
import type { ExecutionFailureContext, FailureArtifact } from './failureTypes.js';

/** Passed runs read per test case (newest first). */
export const PASSED_SEARCH_LIMIT = 10;
/** Failed runs read per test case to count and dedupe the failing stretch (oldest first). */
export const FAILED_SEARCH_LIMIT = 50;

/** The execution a run belonged to, as shown to the reader ("EX-51030 (SU-116 Name)"). */
export type HistoryExecution = {
  executionId: string;
  executionCode?: string;
  /** 'TESTCASE' (standalone) | 'SUITE' | 'EXECUTIONPLAN'. */
  executionType?: string;
  executionTypeCode?: string;
  executionTypeName?: string;
};

/** A passed run of the test case: the run, its execution and its iteration label (ITR-n). */
export type PassedRun = { runId: string; executionId: string; iteration?: string; endedAt?: string };

export type TestcaseHistory = {
  /** `never-passed`: earlier FAILED runs and no pass. `first-execution`: no earlier run at all.
   *  `unknown`: the run search failed — never reported as first-execution or never-passed. */
  status: 'passed-before' | 'never-passed' | 'first-execution' | 'unknown';
  lastPassed?: HistoryExecution & {
    runId: string; endedAt?: string; versionId?: string;
    /** The recent passed runs (newest first), so a comparison can use the same iteration. */
    runs?: PassedRun[];
  };
  /** The FAILED stretch after the last pass (every earlier failure when it never passed): its
   *  oldest run's execution, and how many failed runs (deduped). `more`: the count was capped. */
  failingSince?: HistoryExecution & { endedAt?: string; failedRuns: number; more?: boolean };
  /** The failed-run search failed: "failing since" is not known (never silently left out). */
  failingSinceUnavailable?: true;
  /** versionId of the last pass -> today's, with the version names when they could be read. */
  editedSincePass?: { from: string; to: string; fromName?: string; toName?: string };
};

/** How an unreadable history is shown (card and export). */
export const HISTORY_UNAVAILABLE = 'history unavailable';
export const NEVER_PASSED = 'never passed';
export const FIRST_EXECUTION = 'first execution';
export const FAILING_SINCE_UNAVAILABLE = 'failing since unavailable';

/** "v3 → v4" by version NAME when known (today's name may be passed in), else by id — the same
 *  text in the card and the export. */
export function editedText(e: NonNullable<TestcaseHistory['editedSincePass']>, currentName?: string): string {
  return `${e.fromName ?? e.from} → ${e.toName ?? currentName ?? e.to}`;
}

const statusOf = (r: any): string => String(r?.status ?? '').toUpperCase();
const textOf = (v: unknown): string | undefined => (v === undefined || v === null || v === '' ? undefined : String(v));
const timeOf = (v: unknown): number => {
  const t = typeof v === 'string' || typeof v === 'number' ? Date.parse(String(v)) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
};
/** endTime order: newest first (stable for ties). */
const newestFirst = (a: any, b: any): number => {
  const d = timeOf(b?.endTime) - timeOf(a?.endTime);
  return Number.isNaN(d) ? 0 : d;
};

/**
 * Run rows, one per run id: a run appears twice — in its own execution and as a copy in the parent
 * execution (`parentExecutionCopy`, same id and endTime); the row WITHOUT the copy flag is kept.
 * Deleted rows are dropped. Newest first by endTime.
 */
export function dedupeRuns(rows: any[]): any[] {
  const byId = new Map<string, any>();
  for (const r of notDeleted(rows)) {
    const id = textOf(r?.id);
    if (!id) continue;
    const seen = byId.get(id);
    if (!seen || (seen.parentExecutionCopy === true && r?.parentExecutionCopy !== true)) byId.set(id, r);
  }
  return [...byId.values()].sort(newestFirst);
}

/** What bounds "earlier": before execution id `before`, not one of today's own runs (`exclude`),
 *  and ended before this execution started (`startedAt`, when known). */
export type EarlierBound = { before: number; exclude?: ReadonlySet<string>; startedAt?: string };

/**
 * Deduped rows that are earlier history. Dropped:
 * - a `parentExecutionCopy` row whose original is not among the rows — the original ran at or after
 *   the bound (e.g. today's runs of a plan child, copied into the plan that has a lower id);
 * - a row that ended at or after this execution started (today's runs, concurrent sibling runs).
 */
function earlierRows(rows: any[], bound: EarlierBound): any[] {
  const exclude = bound.exclude ?? new Set<string>();
  const started = bound.startedAt === undefined ? Infinity : timeOf(bound.startedAt);
  const limit = started === -Infinity ? Infinity : started;
  return dedupeRuns(rows).filter((r) => Number(r?.executionId) < bound.before
    && !exclude.has(String(r?.id))
    && r?.parentExecutionCopy !== true
    && timeOf(r?.endTime) < limit);
}

/**
 * The last pass from passed-run rows: the newest PASSED run before `before`, preferring the same
 * iteration label as the failing iteration when one is among the rows.
 */
export function lastPassedOf(
  rows: any[], opts: EarlierBound & { iteration?: string },
): TestcaseHistory['lastPassed'] {
  const passed = earlierRows(rows, opts).filter((r) => statusOf(r) === 'PASSED');
  const chosen = (opts.iteration ? passed.find((r) => iterationLabel(r) === opts.iteration) : undefined) ?? passed[0];
  if (!chosen) return undefined;
  const run = (r: any): PassedRun => {
    const itr = iterationLabel(r);
    const endedAt = textOf(r?.endTime);
    return { runId: String(r.id), executionId: String(r.executionId), ...(itr ? { iteration: itr } : {}), ...(endedAt ? { endedAt } : {}) };
  };
  const versionId = textOf(chosen.versionId);
  const endedAt = textOf(chosen.endTime);
  return {
    executionId: String(chosen.executionId),
    runId: String(chosen.id),
    ...(endedAt ? { endedAt } : {}),
    ...(versionId ? { versionId } : {}),
    ...(passed.length > 1 ? { runs: passed.map(run) } : {}),
  };
}

/**
 * The failing stretch from failed-run rows read NEWEST first: FAILED earlier runs that ended after
 * `after` (the newest pass's endTime), deduped; the oldest one is "failing since". The bound is
 * applied here, not by the server (its search treats a string value as an exact match). `more`:
 * the read was full (`limit` rows) and its oldest row is still after the pass — the stretch may
 * go back further, so the count is a floor.
 */
export function failingSinceOf(
  rows: any[], opts: EarlierBound & { after?: string; limit?: number },
): TestcaseHistory['failingSince'] {
  const after = opts.after === undefined ? -Infinity : timeOf(opts.after);
  const earlier = earlierRows(rows, opts);
  const failed = earlier.filter((r) => statusOf(r) === 'FAILED' && timeOf(r?.endTime) > after);
  const oldest = failed[failed.length - 1];
  if (!oldest) return undefined;
  const endedAt = textOf(oldest.endTime);
  const oldestRead = Math.min(...rows.map((r) => timeOf(r?.endTime)));
  const more = opts.limit !== undefined && rows.length >= opts.limit && oldestRead > after;
  return {
    executionId: String(oldest.executionId),
    ...(endedAt ? { endedAt } : {}),
    failedRuns: failed.length,
    ...(more ? { more: true } : {}),
  };
}

/** The where-it-ran fields of an execution doc. */
export function executionInfo(doc: any): Omit<HistoryExecution, 'executionId'> {
  const code = textOf(doc?.code);
  const type = textOf(doc?.type)?.toUpperCase();
  const typeCode = textOf(doc?.executionTypeCode);
  const typeName = textOf(doc?.executionTypeName);
  return {
    ...(code ? { executionCode: code } : {}),
    ...(type ? { executionType: type } : {}),
    ...(typeCode ? { executionTypeCode: typeCode } : {}),
    ...(typeName ? { executionTypeName: typeName } : {}),
  };
}

/**
 * Searches shared by one analysis, so a test case failing in several of its executions is searched
 * once: `before` is the newest analysed execution; each execution then keeps only the rows that
 * ran before IT. Values are promises so concurrent lookups share one request.
 */
export type HistoryCache = {
  before: number;
  runs: Map<string, Promise<{ rows: any[]; total?: number }>>;
  executions: Map<string, Promise<any>>;
};

export function createHistoryCache(contexts: ExecutionFailureContext[]): HistoryCache {
  const ids = contexts.map((c) => Number(c.execution.id)).filter((n) => Number.isFinite(n));
  return { before: ids.length ? Math.max(...ids) : 0, runs: new Map(), executions: new Map() };
}

/** "30 Oct 2026" (UTC); undefined when the value is not a date. */
export function shortDate(v: string | undefined): string | undefined {
  const t = v === undefined ? NaN : Date.parse(v);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const MAX_CARD_NAME = 40;

export type WhereOptions = { short?: boolean; mask?: (s: string) => string };

/** "EX-51030 (SU-116 Name)" — or "(standalone)" for a test case execution. `short` cuts the name.
 *  Codes are scaffold; the parent's NAME is data and goes through `mask`. */
export function whereText(w: HistoryExecution, opts: WhereOptions = {}): string {
  const ref = w.executionCode ?? `EX-${w.executionId}`;
  if (w.executionType === 'TESTCASE') return `${ref} (standalone)`;
  let name = w.executionTypeName !== undefined && opts.mask ? opts.mask(w.executionTypeName) : w.executionTypeName;
  if (name !== undefined && opts.short && name.length > MAX_CARD_NAME) name = `${name.slice(0, MAX_CARD_NAME - 3)}...`;
  const parent = [w.executionTypeCode, name].filter((x): x is string => !!x).join(' ');
  return parent ? `${ref} (${parent})` : ref;
}

/** "30 Oct 2026 in EX-51030 (SU-116 Name)"; without a date, just the where. */
export function lastPassedText(lp: NonNullable<TestcaseHistory['lastPassed']>, opts: WhereOptions = {}): string {
  const date = shortDate(lp.endedAt);
  return date ? `${date} in ${whereText(lp, opts)}` : whereText(lp, opts);
}

/** "1 run" / "3 runs" / "50+ runs". */
export function failedRunsText(fs: NonNullable<TestcaseHistory['failingSince']>): string {
  return `${fs.failedRuns}${fs.more ? '+' : ''} run${fs.failedRuns === 1 && !fs.more ? '' : 's'}`;
}

/** Log lines a review shows per step (the failed step and the same step in the last pass). */
export const REVIEW_LOG_LINES = 10;

/** The failing step as it looked in the last passed run (Level 2). */
export type StepComparison = {
  executionId: string;
  executionCode?: string;
  runId: string;
  /** false -> "this step does not exist in the passed version". */
  found: boolean;
  status?: string;
  /** actual ?? expected (kept for the card and the suggestion rules). */
  value?: string;
  expected?: string;
  actual?: string;
  data?: string;
  api?: string;
  /** The passed step's API call, compact and masked: response status + body (bounded) and the
   *  assertions — rendered in the review exactly like the failed step's. */
  apiData?: unknown;
  /** The locator the passed step used (from its logs and object fields), masked. */
  locator?: string;
  /** The passed step's last 10 cleaned log lines, masked. */
  logs?: string[];
  /** The first screenshot (card / export); `screenshots` holds every one, in order. */
  screenshot?: FailureArtifact;
  screenshots?: FailureArtifact[];
  /** The passed RUN's baseline (execution time: the run's copy first) and the element thumbnail
   *  (recording time) — absolute urls on the SQA host, when present. */
  baseline?: { baseline?: string; thumbnail?: string };
  /** Why an image of the passed step was skipped ("baseline skipped: …"). */
  imageNotes?: string[];
};

/** Step-result rows of passed runs, shared by one analysis's comparisons: key `${executionId}:${runId}`. */
export type StepRowsCache = Map<string, Promise<any[]>>;

/** The passed run to compare an iteration with: the newest one with the same iteration label, else
 *  the last pass itself — with the execution it ran in (it may differ per iteration). */
export function passedRunFor(
  lp: NonNullable<TestcaseHistory['lastPassed']>, iteration: string | undefined,
): { runId: string; executionId: string } {
  const same = iteration ? lp.runs?.find((r) => r.iteration === iteration) : undefined;
  return same ? { runId: same.runId, executionId: same.executionId } : { runId: lp.runId, executionId: lp.executionId };
}

/** The step-result row of the passed run that is the same step (same `stepId`), not deleted. */
export function pickComparisonRow(rows: any[], stepId: string | undefined): any | undefined {
  if (!stepId) return undefined;
  return rows.find((r) => !r?.deleted && r?.stepId !== undefined && String(r.stepId) === stepId);
}
