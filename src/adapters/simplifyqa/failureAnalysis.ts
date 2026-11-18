/**
 * Failure Analysis v2: combines several executions' failure contexts into one analysis — pattern
 * groups across executions, failed test cases (the counting unit) with history, a SUGGESTED category
 * per group, and the category summary. Pure; counts and percentages are computed here only.
 */
import type { ExecutionFailureContext, FailureIteration, FailureTestcaseEntry } from './failureTypes.js';
import type { StepComparison, TestcaseHistory } from './failureHistory.js';
import { groupByPattern, patternCause, patternSignature, type PatternCandidate } from './failurePatterns.js';
import { suggestCategory } from './failureSuggest.js';
import { GENERIC_NOTES } from './executionFailures.js';
import type {
  AnalysisFilter, AnalysisTestcase, Category, CategorySummary, FailureAnalysis, PatternGroup, SuiteRef, Verdict,
} from './failureAnalysisTypes.js';

export const CATEGORY_ORDER: readonly Category[] = ['APP_DEFECT', 'NEW_CHANGE', 'AUTOMATION_DATA', 'UNCLASSIFIED'];
export const NO_SUITE = '(no suite)';

const iterationKey = (executionId: string, runId: string): string => `${executionId}:${runId}`;
const testcaseKey = (executionId: string, e: FailureTestcaseEntry): string =>
  `${executionId}:${JSON.stringify([e.executionItemId, e.versionId ?? null, e.stepId ?? null])}`;

const TESTCASE_TYPES = new Set(['tc', 'testcase', 'testcases', 'test_case', 'test-case']);
const PLAN_TYPES = new Set(['testplan', 'test_plan', 'test-plan', 'executionplan', 'plan']);

/**
 * The code shown as a test case's source: SU-<id> for a suite, the test plan / other source as
 * `<TYPE>-<id>`, the test case's own code when it was added individually, `Standalone` for a TC run.
 */
function sourceCodeOf(exec: ExecutionFailureContext['execution'], e: FailureTestcaseEntry): string {
  const type = String(exec.type ?? '').toUpperCase();
  if (type === 'SUITE') return exec.executionTypeCode ?? (exec.executionTypeId !== undefined ? `SU-${exec.executionTypeId}` : NO_SUITE);
  if (type !== 'EXECUTIONPLAN') return 'Standalone';
  const m = /^(\S+)\s+(\S+)/.exec(e.source ?? '');
  const own = e.code ?? 'Added individually';
  if (!m) return own;
  const lower = m[1]!.toLowerCase();
  if (TESTCASE_TYPES.has(lower)) return own;
  if (lower === 'suite') return `SU-${m[2]}`;
  return `${PLAN_TYPES.has(lower) ? 'TESTPLAN' : m[1]!.toUpperCase()}-${m[2]}`;
}

/** The suite a test case belongs to (suite filter / suite sections). */
function suiteOf(exec: ExecutionFailureContext['execution'], e: FailureTestcaseEntry): SuiteRef {
  const type = String(exec.type ?? '').toUpperCase();
  if (type === 'SUITE') {
    return {
      ...(exec.executionTypeId !== undefined ? { id: String(exec.executionTypeId) } : {}),
      ...(exec.executionTypeCode ? { code: exec.executionTypeCode } : {}),
      ...(exec.executionTypeName ? { name: exec.executionTypeName } : {}),
    };
  }
  const m = type === 'EXECUTIONPLAN' ? /^SUITE\s+(\S+)/i.exec(e.source ?? '') : null;
  if (m?.[1]) return { id: m[1] };
  return { name: NO_SUITE };
}

const byLabel = (a: { it: FailureIteration }, b: { it: FailureIteration }): number =>
  a.it.label.localeCompare(b.it.label, undefined, { numeric: true });

/** The group holding most of its failed iterations; tie → the group of its first failed iteration in label order. */
export function primaryGroupOf(tc: AnalysisTestcase, groups: PatternGroup[]): number {
  const groupOfKey = new Map<string, number>();
  for (const g of groups) for (const k of g.iterationKeys) groupOfKey.set(k, g.id);
  const counts = new Map<number, number>();
  for (const f of tc.failedIterations) {
    const g = groupOfKey.get(f.key);
    if (g !== undefined) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const max = Math.max(0, ...counts.values());
  if (max === 0) return 0;
  for (const f of [...tc.failedIterations].sort(byLabel)) {
    const g = groupOfKey.get(f.key);
    if (g !== undefined && counts.get(g) === max) return g;
  }
  return 0;
}

export function buildAnalysis(
  parts: Array<{ ctx: ExecutionFailureContext; history: Map<string, TestcaseHistory> }>,
  comparisons: Record<string, StepComparison | null>,
  meta: { id: string; owner: string; now: number},
): FailureAnalysis {
  const seen = new Set<string>();
  const unique = parts.filter((p) => {
    const id = String(p.ctx.execution.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const testcases: AnalysisTestcase[] = [];
  const candidates: PatternCandidate[] = [];
  const tcOfIteration = new Map<string, AnalysisTestcase>();

  for (const { ctx, history } of unique) {
    const execId = String(ctx.execution.id);
    const reps = new Set(ctx.groups.map((g) => String(g.representativeRunId)));
    for (const e of ctx.testcases) {
      if (!e.failedIterations.length) continue;
      const hist = history.get(String(e.executionItemId));
      const tc: AnalysisTestcase = {
        key: testcaseKey(execId, e),
        executionId: execId,
        suite: suiteOf(ctx.execution, e),
        sourceCode: sourceCodeOf(ctx.execution, e),
        ...(e.code !== undefined ? { code: e.code } : {}),
        ...(e.name !== undefined ? { name: e.name } : {}),
        ...(e.description !== undefined ? { description: e.description } : {}),
        ...(e.versionName !== undefined ? { versionName: e.versionName } : {}),
        failedIterations: e.failedIterations.map((it) => ({ key: iterationKey(execId, it.runId), it })),
        ...(hist ? { history: hist } : {}),
        groups: [],
        primaryGroup: 0,
      };
      testcases.push(tc);
      for (const f of tc.failedIterations) {
        tcOfIteration.set(f.key, tc);
        candidates.push({ key: f.key, it: f.it, wasRepresentative: reps.has(String(f.it.runId)) });
      }
    }
  }

  const groups: PatternGroup[] = groupByPattern(candidates).map((g, i) => {
    const id = i + 1;
    const rep = g.representative;
    const sig = patternSignature(rep.it);
    const testcaseKeys: string[] = [];
    const suites: SuiteRef[] = [];
    const suiteSeen = new Set<string>();
    for (const m of g.members) {
      const tc = tcOfIteration.get(m.key)!;
      if (!testcaseKeys.includes(tc.key)) testcaseKeys.push(tc.key);
      if (!tc.groups.includes(id)) tc.groups.push(id);
      const sk = JSON.stringify([tc.suite.id ?? null, tc.suite.code ?? null, tc.suite.name ?? null]);
      if (!suiteSeen.has(sk)) { suiteSeen.add(sk); suites.push(tc.suite); }
    }
    return {
      id,
      signature: g.signature,
      cause: patternCause(rep.it, g.members.map((m) => m.it)),
      family: sig.family,
      iterationKeys: g.members.map((m) => m.key),
      testcaseKeys,
      suites,
      representativeKey: rep.key,
      sampleKeys: g.samples.map((s) => s.key),
      suggested: suggestCategory(rep.it, tcOfIteration.get(rep.key)?.history, comparisons[rep.key]),
      evidenceShown: false,
    };
  });

  for (const tc of testcases) {
    tc.groups.sort((a, b) => a - b);
    tc.primaryGroup = primaryGroupOf(tc, groups);
  }

  return {
    id: meta.id,
    owner: meta.owner,
    createdAt: meta.now,
    executions: unique.map((p) => p.ctx.execution),
    testcases,
    groups,
    verdicts: {},
    comparisons,
    passedTestcases: unique.reduce((n, p) => n + (p.ctx.counts.passedTestcases ?? 0), 0),
    notes: analysisNotes(unique.map((p) => p.ctx)),
  };
}

/** Each execution's own notes prefixed with its ref ("EX-900: …"); notes that read the same for
 *  every execution appear once, unprefixed. */
function analysisNotes(contexts: ExecutionFailureContext[]): string[] {
  const out: string[] = [];
  const generic: string[] = [];
  for (const ctx of contexts) {
    const ref = ctx.execution.code ?? `EX-${ctx.execution.id}`;
    for (const n of ctx.notes) {
      if (GENERIC_NOTES.has(n)) { if (!generic.includes(n)) generic.push(n); } else out.push(`${ref}: ${n}`);
    }
  }
  return [...out, ...generic];
}

export function categoryOfTestcase(a: FailureAnalysis, tc: AnalysisTestcase): Category {
  return a.verdicts[tc.primaryGroup]?.category ?? 'UNCLASSIFIED';
}

/** 'SU-12' or '12' against a SuiteRef's id / code. */
function suiteMatches(s: SuiteRef, want: string): boolean {
  const w = want.trim().toUpperCase();
  const num = w.replace(/^SU-/, '');
  return (s.id !== undefined && s.id.toUpperCase() === num)
    || (s.code !== undefined && (s.code.toUpperCase() === w || s.code.toUpperCase() === `SU-${num}`));
}

export function filterTestcases(a: FailureAnalysis, filter: AnalysisFilter = {}): AnalysisTestcase[] {
  const patterns = filter.pattern === undefined ? undefined : ([] as number[]).concat(filter.pattern);
  return a.testcases.filter((tc) =>
    (filter.suiteId === undefined || suiteMatches(tc.suite, filter.suiteId))
    && (patterns === undefined || tc.groups.some((g) => patterns.includes(g)))
    && (filter.category === undefined || categoryOfTestcase(a, tc) === filter.category));
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Each failed test case counted once, by its primary group's verdict; percents sum to 100. */
export function summarise(a: FailureAnalysis, filter?: AnalysisFilter): CategorySummary {
  const tcs = filterTestcases(a, filter);
  const counts = new Map<Category, number>(CATEGORY_ORDER.map((c) => [c, 0]));
  for (const tc of tcs) {
    const c = categoryOfTestcase(a, tc);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const total = tcs.length;
  const rows: CategorySummary = CATEGORY_ORDER.map((category) => {
    const n = counts.get(category) ?? 0;
    return { category, testcases: n, percent: total ? round1((n / total) * 100) : 0 };
  });
  if (total) {
    const diff = round1(100 - rows.reduce((s, r) => s + r.percent, 0));
    if (diff !== 0) {
      const largest = rows.reduce((best, r) => (r.testcases > best.testcases ? r : best), rows[0]!);
      largest.percent = round1(largest.percent + diff);
    }
  }
  return rows;
}

/**
 * A client verdict for one pattern group, optionally merging it into another group (`mergeInto`) or
 * splitting iterations out into a new group (`splitOut`, iteration keys). When `mergeInto` is present
 * the entry's pattern / rootCause / category / confidence are ignored (the source group disappears).
 */
export type VerdictInput = Verdict & { mergeInto?: number; splitOut?: string[] };

const suiteKey = (s: SuiteRef): string => JSON.stringify([s.id ?? null, s.code ?? null, s.name ?? null]);

/**
 * Validates every entry, then applies splits, merges and verdicts (in that order) to a structural
 * clone. The input analysis is never mutated; any error returns all errors found and no analysis.
 */
export function applyVerdicts(
  a: FailureAnalysis, input: VerdictInput[],
): { ok: true; analysis: FailureAnalysis } | { ok: false; errors: string[] } {
  const ids = new Set(a.groups.map((g) => g.id));
  const known = [...ids].sort((x, y) => x - y).join(', ');
  const byId = new Map(a.groups.map((g) => [g.id, g]));
  const errors: string[] = [];

  const mergeSources = new Set<number>();
  for (const v of input) if (v.mergeInto !== undefined && ids.has(v.group)) mergeSources.add(v.group);
  /** target → groups merged into it in this call */
  const mergedInto = new Map<number, number[]>();
  for (const v of input) {
    if (v.mergeInto === undefined || !ids.has(v.group)) continue;
    mergedInto.set(v.mergeInto, [...(mergedInto.get(v.mergeInto) ?? []), v.group]);
  }

  const claimed = new Map<number, Set<string>>();
  const seenGroups = new Set<number>();
  const dupReported = new Set<number>();
  for (const v of input) {
    if (seenGroups.has(v.group)) {
      if (!dupReported.has(v.group)) { dupReported.add(v.group); errors.push(`group ${v.group}: appears more than once in this call`); }
      continue;
    }
    seenGroups.add(v.group);
    const g = byId.get(v.group);
    if (!g) { errors.push(`group ${v.group}: no such group (groups: ${known})`); continue; }
    if (v.mergeInto !== undefined) {
      if (v.mergeInto === v.group) errors.push(`group ${v.group}: cannot merge into itself`);
      else if (!ids.has(v.mergeInto)) errors.push(`group ${v.group}: mergeInto ${v.mergeInto}: no such group`);
      else if (mergeSources.has(v.mergeInto)) {
        errors.push(`group ${v.group}: mergeInto ${v.mergeInto}: target is itself merged in this call`);
      }
    } else if (!g.evidenceShown) {
      errors.push(`group ${v.group}: evidence not shown yet — fetch it with failure_analysis({ analysisId, pattern: [${v.group}] })`);
    } else {
      // After the merges the target's evidence counts as shown only if every merged-in group's was.
      for (const srcId of mergedInto.get(v.group) ?? []) {
        if (byId.get(srcId)?.evidenceShown) continue;
        errors.push(`group ${srcId}: evidence not shown yet — fetch it with failure_analysis({ analysisId, pattern: [${srcId}] }) before merging it into group ${v.group} and giving that group a verdict`);
      }
    }
    if (v.splitOut?.length) {
      const own = new Set(g.iterationKeys);
      const taken = claimed.get(v.group) ?? new Set<string>();
      claimed.set(v.group, taken);
      for (const k of new Set(v.splitOut)) {
        if (!own.has(k)) errors.push(`group ${v.group}: splitOut ${k}: not in this group`);
        else if (taken.has(k)) errors.push(`group ${v.group}: splitOut ${k}: already split out in this call`);
        else taken.add(k);
      }
      if (taken.size >= own.size && [...own].every((k) => taken.has(k))) {
        errors.push(`group ${v.group}: splitOut would empty the group`);
      }
    }
  }
  if (errors.length) return { ok: false, errors };

  const out = structuredClone(a);
  const tcOfIteration = new Map<string, AnalysisTestcase>();
  for (const tc of out.testcases) for (const f of tc.failedIterations) tcOfIteration.set(f.key, tc);
  const groupById = (id: number): PatternGroup => out.groups.find((g) => g.id === id)!;
  const derive = (keys: string[]): { testcaseKeys: string[]; suites: SuiteRef[] } => {
    const testcaseKeys: string[] = [];
    const suites: SuiteRef[] = [];
    const seen = new Set<string>();
    for (const k of keys) {
      const tc = tcOfIteration.get(k);
      if (!tc) continue;
      if (!testcaseKeys.includes(tc.key)) testcaseKeys.push(tc.key);
      if (!seen.has(suiteKey(tc.suite))) { seen.add(suiteKey(tc.suite)); suites.push(tc.suite); }
    }
    return { testcaseKeys, suites };
  };

  // 1. splits (new ids ascend in input order)
  for (const v of input) {
    const keys = [...new Set(v.splitOut ?? [])];
    if (!keys.length) continue;
    const parent = groupById(v.group);
    const id = Math.max(0, ...out.groups.map((g) => g.id)) + 1;
    parent.iterationKeys = parent.iterationKeys.filter((k) => !keys.includes(k));
    if (keys.includes(parent.representativeKey)) parent.representativeKey = parent.iterationKeys[0]!;
    parent.sampleKeys = parent.sampleKeys.filter((k) => !keys.includes(k) && k !== parent.representativeKey);
    Object.assign(parent, derive(parent.iterationKeys));
    out.groups.push({
      id,
      signature: parent.signature,
      cause: parent.cause,
      family: parent.family,
      iterationKeys: keys,
      ...derive(keys),
      representativeKey: keys[0]!,
      sampleKeys: keys.slice(1, 3),
      suggested: { category: null, because: `split out of group ${v.group}` },
      evidenceShown: parent.evidenceShown,
    });
  }

  // 2. merges
  for (const v of input) {
    if (v.mergeInto === undefined) continue;
    const src = groupById(v.group);
    const dst = groupById(v.mergeInto);
    dst.iterationKeys = [...new Set([...dst.iterationKeys, ...src.iterationKeys])];
    dst.testcaseKeys = [...new Set([...dst.testcaseKeys, ...src.testcaseKeys])];
    const seen = new Set(dst.suites.map(suiteKey));
    for (const s of src.suites) if (!seen.has(suiteKey(s))) { seen.add(suiteKey(s)); dst.suites.push(s); }
    // A merged-in group whose evidence was never shown makes the target unseen: the verdict gate must not be bypassed by merging.
    dst.evidenceShown = dst.evidenceShown && src.evidenceShown;
    out.groups = out.groups.filter((g) => g.id !== v.group);
    delete out.verdicts[v.group];
  }

  // 3. verdicts
  for (const v of input) {
    if (v.mergeInto !== undefined) continue;
    out.verdicts[v.group] = { group: v.group, pattern: v.pattern, rootCause: v.rootCause, category: v.category, confidence: v.confidence };
  }

  for (const tc of out.testcases) {
    const mine = new Set(tc.failedIterations.map((f) => f.key));
    tc.groups = out.groups.filter((g) => g.iterationKeys.some((k) => mine.has(k))).map((g) => g.id).sort((x, y) => x - y);
    tc.primaryGroup = primaryGroupOf(tc, out.groups);
  }
  return { ok: true, analysis: out };
}
