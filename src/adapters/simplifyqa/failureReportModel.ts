/**
 * Failure Analysis v2 report model: one format-neutral view of an analysis + filter, rendered by the
 * Excel and PDF writers. Pure. Every count comes from here; protected test data is masked as `***`.
 */
import type { FailureIteration } from './failureTypes.js';
import type {
  AnalysisFilter, AnalysisTestcase, Category, CategorySummary, FailureAnalysis, PatternGroup, SuiteRef,
} from './failureAnalysisTypes.js';
import { CATEGORY_ORDER, NO_SUITE, categoryOfTestcase, filterTestcases, summarise } from './failureAnalysis.js';
import {
  FAILING_SINCE_UNAVAILABLE, FIRST_EXECUTION, HISTORY_UNAVAILABLE, NEVER_PASSED, editedText, failedRunsText, lastPassedText, whereText,
} from './failureHistory.js';
import { MIN_MASKED_LEN, maskWith } from './failureReport.js';

export { maskWith };

export type AnalysisReport = {
  title: string;
  fileStem: string;
  scope: { executions: string[]; suites: string[]; filters: string; generatedAt: string };
  summary: CategorySummary;
  /** Of the filtered view: failed test cases, their failed iterations (rows below), passed test cases. */
  totals: { failedTestcases: number; failedIterations: number; passedTestcases: number };
  /** The root-cause table: one row per pattern, most failed test cases first. */
  patterns: Array<{
    id: number; pattern: string; category: Category; confidence: string; rootCause: string;
    /** Failed test cases of the view in this pattern (counted per test case). */
    testcases: number;
    /** Every one of them as `TC-1542 (v1.0)` — not capped. */
    testcaseIds: string[];
    screenshotUrl?: string;
  }>;
  suites: Array<{ suite: string; failed: number; byCategory: Record<Category, number>; topPatterns: string[] }>;
  testcases: Array<{
    suite: string; source?: string; code: string; name: string; iteration: string; failedStep: string;
    expected?: string; actual?: string; pattern: string; category: Category; reason: string;
    lastPassed?: string; failingSince?: string; editedSincePass?: string;
    /** Raw end times behind `lastPassed` / `failingSince` (only when a real run is shown), so a sort by
     *  them is chronological rather than by display text. */
    lastPassedAt?: string; failingSinceAt?: string;
    screenshotUrl?: string; reportUrl?: string;
    /** The last passed run's screenshot of the same step, and the baseline (urls; the run's copy first). */
    lastPassedScreenshotUrl?: string; baselineUrl?: string;
    /** EVERY screenshot url of the failed step and of the same step in the last pass, in order (the
     *  single fields above are the first of each). */
    screenshotUrls?: string[]; lastPassedScreenshotUrls?: string[];
  }>;
};

const TOP_PATTERNS = 3;

const suiteLabel = (s: SuiteRef): string => s.code ?? s.name ?? (s.id !== undefined ? `SU-${s.id}` : NO_SUITE);


/** Values of every protected test data entry in the analysis (each iteration's whole-run set and
 *  its failed steps' test data), longest first. */
export function protectedValues(a: FailureAnalysis): string[] {
  const out = new Set<string>();
  for (const tc of a.testcases) {
    for (const { it } of tc.failedIterations) {
      for (const v of it.protectedValues ?? []) if (v.length >= MIN_MASKED_LEN) out.add(v);
      for (const step of [it.focus, ...it.failedSteps]) {
        for (const d of step?.testdata ?? []) {
          if (d['protected'] !== true) continue;
          const v = d['value'];
          if (v === undefined || v === null) continue;
          const s = String(v);
          if (s.length >= MIN_MASKED_LEN) out.add(s);
        }
      }
    }
  }
  return [...out].sort((x, y) => y.length - x.length);
}

/** `TC-1542 (v1.0)` — the same label as the card's root-cause table. Only the DATA parts (version /
 *  name) are masked — never the TC code. */
const testcaseLabel = (tc: AnalysisTestcase, mask: (s: string | undefined) => string | undefined): string =>
  `${tc.code ?? (tc.name !== undefined ? mask(tc.name) : tc.key)}${tc.versionName ? ` (${mask(tc.versionName)})` : ''}`;

const failedStepOf = (it: FailureIteration): string => {
  const f = it.focus;
  if (!f) return it.exception ?? '';
  return f.trail || (f.reportStep ? `step ${f.reportStep}` : f.description);
};

export function buildReportModel(a: FailureAnalysis, filter: AnalysisFilter, now: Date): AnalysisReport {
  const mask = maskWith(protectedValues(a));
  const tcs = filterTestcases(a, filter);
  const groupById = new Map<number, PatternGroup>(a.groups.map((g) => [g.id, g]));
  const groupOfIteration = new Map<string, PatternGroup>();
  for (const g of a.groups) for (const k of g.iterationKeys) groupOfIteration.set(k, g);
  const reportUrlOf = new Map(a.executions.map((e) => [String(e.id), e.reportUrl]));

  const patternName = (g: PatternGroup | undefined): string =>
    g ? (mask(a.verdicts[g.id]?.pattern ?? g.cause) ?? '') : 'UNCLASSIFIED';
  const categoryOfGroup = (g: PatternGroup | undefined): Category =>
    (g && a.verdicts[g.id]?.category) || 'UNCLASSIFIED';

  const wanted = filter.pattern === undefined ? undefined : ([] as number[]).concat(filter.pattern);

  // testcases: one row per failed iteration (only those in the pattern filter, if any)
  const rows: AnalysisReport['testcases'] = [];
  for (const tc of tcs) {
    const h = tc.history;
    // Full text: "30 Oct 2026 in EX-51030 (SU-116 Name)" / "EX-51200 (PL-98 Name), 3 runs". Suite /
    // plan and version names are data (masked); the EX / SU / PL refs are scaffold (never masked).
    const named = { mask: (s: string) => mask(s) ?? '' };
    const lastPassed = h?.status === 'unknown' ? HISTORY_UNAVAILABLE
      : h?.status === 'never-passed' ? NEVER_PASSED
        : h?.status === 'first-execution' ? FIRST_EXECUTION
          : h?.lastPassed ? lastPassedText(h.lastPassed, named) : undefined;
    const lastPassedAt = h?.status === 'unknown' || h?.status === 'never-passed' || h?.status === 'first-execution'
      ? undefined : h?.lastPassed?.endedAt;
    const failingSince = h?.failingSince
      ? `${whereText(h.failingSince, named)}, ${failedRunsText(h.failingSince)}`
      : h?.failingSinceUnavailable ? FAILING_SINCE_UNAVAILABLE : undefined;
    const e = h?.editedSincePass;
    const edited = e
      ? editedText({
        ...e,
        ...(e.fromName !== undefined ? { fromName: mask(e.fromName) ?? '' } : {}),
        ...(e.toName !== undefined ? { toName: mask(e.toName) ?? '' } : {}),
      }, mask(tc.versionName))
      : undefined;
    const reportUrl = reportUrlOf.get(tc.executionId);
    for (const { key, it } of tc.failedIterations) {
      const g = groupOfIteration.get(key);
      if (wanted && !(g && wanted.includes(g.id))) continue;
      const verdict = g ? a.verdicts[g.id] : undefined;
      const reason = mask(verdict?.rootCause ?? it.focus?.cause ?? it.exception ?? '') ?? '';
      const expected = mask(it.focus?.expected);
      const actual = mask(it.focus?.actual);
      // Every screenshot of the failed step (the focus, else the first failed step that has some — as
      // the review shows them) and of the same step in the last pass.
      const shotStep = [it.focus, ...(it.failedSteps ?? [])].find((s) => s?.screenshots?.some((y) => y.absoluteUrl));
      const shots = (shotStep?.screenshots ?? []).map((y) => y.absoluteUrl).filter((u): u is string => !!u);
      const shot = shots[0];
      const cmp = a.comparisons[key];
      const passShots = (cmp?.screenshots ?? (cmp?.screenshot ? [cmp.screenshot] : [])).map((y) => y.absoluteUrl).filter((u): u is string => !!u);
      const passShot = passShots[0];
      // The baseline of the failed step (the run's copy first; its thumbnail when there is no full baseline), else
      // the passed step's.
      const baseline = it.focus?.recordedBaseline ?? it.focus?.recordedThumbnail
        ?? cmp?.baseline?.baseline ?? cmp?.baseline?.thumbnail;
      rows.push({
        suite: suiteLabel(tc.suite),
        source: tc.sourceCode ?? suiteLabel(tc.suite),
        code: tc.code ?? '',
        name: mask(tc.name) ?? '',
        iteration: it.iteration ?? it.label,
        failedStep: mask(failedStepOf(it)) ?? '',
        ...(expected !== undefined ? { expected } : {}),
        ...(actual !== undefined ? { actual } : {}),
        pattern: patternName(g),
        category: categoryOfGroup(g),
        reason,
        ...(lastPassed !== undefined ? { lastPassed } : {}),
        ...(failingSince !== undefined ? { failingSince } : {}),
        ...(lastPassedAt ? { lastPassedAt } : {}),
        ...(h?.failingSince?.endedAt ? { failingSinceAt: h.failingSince.endedAt } : {}),
        ...(edited !== undefined ? { editedSincePass: edited } : {}),
        ...(shot ? { screenshotUrl: shot } : {}),
        ...(reportUrl ? { reportUrl } : {}),
        ...(passShot ? { lastPassedScreenshotUrl: passShot } : {}),
        ...(baseline ? { baselineUrl: baseline } : {}),
        ...(shots.length ? { screenshotUrls: shots } : {}),
        ...(passShots.length ? { lastPassedScreenshotUrls: passShots } : {}),
      });
    }
  }

  // patterns (the root-cause table): groups that still have a filtered test case, most first
  const patterns: AnalysisReport['patterns'] = [];
  for (const g of a.groups) {
    if (wanted && !wanted.includes(g.id)) continue;
    const inGroup = tcs.filter((tc) => tc.groups.includes(g.id));
    if (!inGroup.length) continue;
    const v = a.verdicts[g.id];
    const rep = a.testcases.flatMap((t) => t.failedIterations).find((f) => f.key === g.representativeKey);
    const shot = rep?.it.focus?.screenshots[0]?.absoluteUrl;
    patterns.push({
      id: g.id,
      pattern: patternName(g),
      category: categoryOfGroup(g),
      confidence: v?.confidence ?? 'unverified',
      rootCause: v ? (mask(v.rootCause) ?? '') : `(suggested: ${g.suggested.category ?? '—'})`,
      testcases: inGroup.length,
      testcaseIds: [...new Set(inGroup.map((tc) => testcaseLabel(tc, mask)))],
      ...(shot ? { screenshotUrl: shot } : {}),
    });
  }
  patterns.sort((x, y) => y.testcases - x.testcases || x.id - y.id);

  // suites (grouped by source: a section per suite / plan / source)
  const bySuite = new Map<string, AnalysisTestcase[]>();
  for (const tc of tcs) {
    const k = tc.sourceCode ?? suiteLabel(tc.suite);
    bySuite.set(k, [...(bySuite.get(k) ?? []), tc]);
  }
  const suites: AnalysisReport['suites'] = [...bySuite].map(([suite, list]) => {
    const byCategory = Object.fromEntries(CATEGORY_ORDER.map((c) => [c, 0])) as Record<Category, number>;
    const perPattern = new Map<string, number>();
    for (const tc of list) {
      byCategory[categoryOfTestcase(a, tc)] += 1;
      const name = patternName(groupById.get(tc.primaryGroup));
      perPattern.set(name, (perPattern.get(name) ?? 0) + 1);
    }
    const topPatterns = [...perPattern].sort((x, y) => y[1] - x[1]).slice(0, TOP_PATTERNS).map(([n]) => n);
    return { suite, failed: list.length, byCategory, topPatterns };
  });

  const filterParts: string[] = [];
  if (filter.suiteId !== undefined) filterParts.push(`suite ${filter.suiteId}`);
  if (wanted) filterParts.push(`pattern ${wanted.join(', ')}`);
  if (filter.category !== undefined) filterParts.push(`category ${filter.category}`);

  // failure-analysis_<suite|all>[_<category>][_p<ids>]_<analysisId>_<date>: different filters or
  // analyses never overwrite each other's files.
  const date = now.toISOString().slice(0, 10);
  const safe = (v: string): string => v.replace(/[^A-Za-z0-9_-]/g, '');
  const stem = [
    'failure-analysis',
    safe(filter.suiteId ?? '') || 'all',
    filter.category,
    wanted ? `p${wanted.join('-')}` : undefined,
    safe(a.id) || undefined,
    date,
  ].filter((p): p is string => !!p).join('_');

  return {
    title: 'Failure Analysis Report',
    fileStem: stem,
    scope: {
      executions: a.executions.map((e) => e.code ?? String(e.id)),
      suites: [...bySuite.keys()],
      filters: filterParts.length ? filterParts.join(' · ') : 'none',
      generatedAt: now.toISOString(),
    },
    summary: summarise(a, filter),
    totals: { failedTestcases: tcs.length, failedIterations: rows.length, passedTestcases: a.passedTestcases },
    patterns,
    suites,
    testcases: rows,
  };
}
