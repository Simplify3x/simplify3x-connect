/**
 * The Failure Analysis v2 card: one combined FailureAnalysis rendered as deterministic markdown —
 * header (scope, totals), the root-cause table (one row per pattern, with its failed test cases), the
 * category table, then the evidence for the groups in budget (with each test case's history), and a
 * fixed instruction block for the client model. Every table
 * and count is built here by code; nothing asserts a root cause (un-verdicted groups only carry a
 * "suggested" category). Pure: never mutates the analysis — the tool layer marks `evidenceShown`
 * from `evidenceGroups`.
 */
import type { FailureIteration } from './failureTypes.js';
import {
  FAILING_SINCE_UNAVAILABLE, FIRST_EXECUTION, HISTORY_UNAVAILABLE, NEVER_PASSED, editedText, failedRunsText, lastPassedText, type TestcaseHistory,
} from './failureHistory.js';
import type {
  AnalysisFilter, AnalysisTestcase, CategorySummary, FailureAnalysis, PatternGroup, SuiteRef,
} from './failureAnalysisTypes.js';
import { NO_SUITE, filterTestcases, summarise } from './failureAnalysis.js';
import { CARD_END, iterationEvidence, readableTime, td, truncate, type Mask } from './failureReport.js';
import { maskWith, protectedValues } from './failureReportModel.js';

export const FIRST_EVIDENCE_GROUPS = 8, SAMPLES_PER_GROUP = 2, IMAGE_PAIR_GROUPS = 4, GROUP_PAGE_SIZE = 4;

export type AnalysisView = { text: string; evidenceGroups: number[]; imageRequests: Array<{ caption: string; url: string }> };

/** Characters of evidence after which further iterations get a FLOW cut to the failure. */
const EVIDENCE_BUDGET = 24_000;
/** Pattern rows per response; the rest are counted. */
export const MAX_PATTERN_ROWS = 30;
/** Test case ids per root-cause row; the rest are counted ("… +N more"). The export lists them all. */
export const MAX_TESTCASE_IDS = 12;
/** Compact per-test-case lines in a pattern view: per pattern, and per response. */
export const COMPACT_LINES_PER_PATTERN = 40, COMPACT_LINES_TOTAL = 100;

/** `first` = analyse response, `view` = re-render with filters, `card` = the classified card only
 *  (header, root-cause table with every filtered test case id, categories — no evidence, no Next:). */
export type RenderMode = 'first' | 'view' | 'card';

const execRef = (id: string, code?: string): string => code ?? `EX-${id}`;
const suiteLabel = (s: SuiteRef): string => s.code ?? (s.id !== undefined ? `SU-${s.id}` : s.name ?? NO_SUITE);
const suiteTitle = (s: SuiteRef): string => (s.code || s.id !== undefined) && s.name ? `${suiteLabel(s)} ${s.name}` : suiteLabel(s);
const suiteKey = (s: SuiteRef): string => JSON.stringify([s.id ?? null, s.code ?? null, s.name ?? null]);
const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;

function uniqueSuites(suites: SuiteRef[]): SuiteRef[] {
  const seen = new Set<string>();
  return suites.filter((s) => (seen.has(suiteKey(s)) ? false : (seen.add(suiteKey(s)), true)));
}

/** "1–12" for a contiguous run of ids, else "1, 3, 7". */
function idList(ids: number[]): string {
  if (ids.length > 2 && ids.every((id, i) => i === 0 || id === ids[i - 1]! + 1)) return `${ids[0]}–${ids[ids.length - 1]}`;
  return ids.join(', ');
}

function categoryCell(a: FailureAnalysis, g: PatternGroup): string {
  const v = a.verdicts[g.id];
  return v ? `${v.category} (${v.confidence})` : 'UNCLASSIFIED';
}

/** Masked causes carry placeholders like `<n>` / `<v>`: escaped so markdown keeps them visible. */
const escapeLt = (s: string): string => s.replace(/</g, '\\<');
/** The pattern's name (verdict name, else the masked cause), protected values masked BEFORE any cut. */
const patternName = (a: FailureAnalysis, g: PatternGroup, m: Mask): string => m(a.verdicts[g.id]?.pattern ?? g.cause);

/** "Failure pattern / root cause": `**pattern** — rootCause` with a verdict, else the cause and the
 *  suggested category. Data masked before it is cut and escaped. */
function rootCauseCell(a: FailureAnalysis, g: PatternGroup, m: Mask): string {
  const v = a.verdicts[g.id];
  return v
    ? `**${escapeLt(td(m(v.pattern), 120))}** — ${escapeLt(td(m(v.rootCause), 300))}`
    : `${escapeLt(td(m(g.cause), 260))} (suggested: ${g.suggested.category ?? '—'})`;
}

/** `TC-1542 (v1.0)`. Only the DATA parts (version / name) are masked — never the TC code. */
export const testcaseLabel = (tc: AnalysisTestcase, m: Mask): string =>
  `${tc.code ?? (tc.name !== undefined ? m(tc.name) : tc.key)}${tc.versionName ? ` (${m(tc.versionName)})` : ''}`;

/** A table cell escaped like `td`, but never cut: a cut would drop ids without saying so. */
const cellNoCut = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** One row per pattern in scope: its failed test cases (of `tcs`), most first; capped at 30 rows.
 *  Test case ids are capped at 12 per row, with a pointer to the pattern view / export (a pattern
 *  view lists every test case once, in its compact list under the evidence). */
function rootCauseTable(a: FailureAnalysis, groups: PatternGroup[], tcs: AnalysisTestcase[], m: Mask): string[] {
  const byKey = new Map(tcs.map((t) => [t.key, t]));
  const rows = groups
    .map((g) => ({ g, mine: g.testcaseKeys.map((k) => byKey.get(k)).filter((t): t is AnalysisTestcase => t !== undefined) }))
    .sort((x, y) => y.mine.length - x.mine.length || x.g.id - y.g.id);
  const out = [
    '| # | Failure pattern / root cause | Category | Failed TCs | Test cases (version) |',
    '|---|---|---|---|---|',
  ];
  for (const { g, mine } of rows.slice(0, MAX_PATTERN_ROWS)) {
    const labels = [...new Set(mine.map((t) => escapeLt(testcaseLabel(t, m))))];
    const cap = MAX_TESTCASE_IDS;
    const more = labels.length - cap;
    const ids = `${labels.slice(0, cap).join(', ')}`
      + `${more > 0 ? `, … +${more} more (failure_analysis({ analysisId: "${a.id}", pattern: [${g.id}] }) or the export)` : ''}`;
    out.push(`| ${g.id} | ${rootCauseCell(a, g, m)} | ${categoryCell(a, g)} | ${mine.length} | ${cellNoCut(ids)} |`);
  }
  if (rows.length > MAX_PATTERN_ROWS) {
    out.push('', `+${rows.length - MAX_PATTERN_ROWS} more patterns — filter with pattern / category / suiteId, or use failure_analysis_export for the full list.`);
  }
  return out;
}

function categoryTable(rows: CategorySummary): string[] {
  const total = rows.reduce((n, r) => n + r.testcases, 0);
  return [
    '| Category | Test cases | % |', '|---|---|---|',
    ...rows.map((r) => `| ${r.category} | ${r.testcases} | ${r.percent}% |`),
    `| **Total** | ${total} | ${total ? 100 : 0}% |`,
  ];
}

/** A test case's history, short ("last passed 30 Oct 2026 in EX-462 (SU-5 Name)", "failing since
 *  EX-480 (3 runs)", "<edited> v3 → v4"); the exports carry the full text. The EX / SU / PL refs
 *  are scaffold and never masked; the suite / plan and version NAMES are data. */
export function historyParts(h: TestcaseHistory | undefined, versionName: string | undefined, m: Mask, edited: string): string[] {
  if (!h) return [];
  if (h.status === 'unknown') return [HISTORY_UNAVAILABLE];
  const e = h.editedSincePass;
  const maskedEdit = e ? {
    ...e,
    ...(e.fromName !== undefined ? { fromName: m(e.fromName) } : {}),
    ...(e.toName !== undefined ? { toName: m(e.toName) } : {}),
  } : undefined;
  return [
    h.status === 'first-execution' ? FIRST_EXECUTION
      : h.status === 'never-passed' ? NEVER_PASSED
        : h.lastPassed ? `last passed ${lastPassedText(h.lastPassed, { short: true, mask: m })}` : undefined,
    h.failingSince
      ? `failing since ${execRef(h.failingSince.executionId, h.failingSince.executionCode)} (${failedRunsText(h.failingSince)})`
      : h.failingSinceUnavailable ? FAILING_SINCE_UNAVAILABLE : undefined,
    maskedEdit ? `${edited} ${editedText(maskedEdit, versionName !== undefined ? m(versionName) : undefined)}` : undefined,
  ].filter((x): x is string => !!x);
}

/** Groups in scope of the filter, in id order. */
function scopedGroups(a: FailureAnalysis, filter: AnalysisFilter, tcs: AnalysisTestcase[]): PatternGroup[] {
  const keys = new Set(tcs.map((t) => t.key));
  const wanted = filter.pattern === undefined ? undefined : ([] as number[]).concat(filter.pattern);
  // A category filter already narrowed `tcs` (by each test case's main pattern): the rows are the
  // groups holding any of them — the same rule as the export.
  return a.groups.filter((g) =>
    (wanted === undefined || wanted.includes(g.id))
    && g.testcaseKeys.some((k) => keys.has(k)));
}

/** The "Next:" call, keeping the view's other filters. */
function nextCall(a: FailureAnalysis, filter: AnalysisFilter, more: { pattern: number[] } | { page: number }): string {
  const args = [`analysisId: "${a.id}"`];
  if (filter.view) args.push(`view: "${filter.view}"`);
  if (filter.suiteId !== undefined) args.push(`suiteId: "${filter.suiteId}"`);
  if (filter.category !== undefined) args.push(`category: "${filter.category}"`);
  args.push('pattern' in more ? `pattern: [${more.pattern.join(', ')}]` : `page: ${more.page}`);
  return `Next: failure_analysis({ ${args.join(', ')} })`;
}

function emptyMessage(a: FailureAnalysis, filter: AnalysisFilter): string {
  const what: string[] = [];
  const lists: string[] = [];
  if (filter.suiteId !== undefined) {
    what.push(filter.suiteId);
    lists.push(`Suites: ${uniqueSuites(a.testcases.map((t) => t.suite)).map(suiteLabel).join(', ') || 'none'}.`);
  }
  if (filter.pattern !== undefined) {
    const p = ([] as number[]).concat(filter.pattern);
    what.push(`${p.length === 1 ? 'pattern' : 'patterns'} ${p.join(', ')}`);
    lists.push(`Patterns: ${a.groups.length ? idList(a.groups.map((g) => g.id)) : 'none'}.`);
  }
  if (filter.category !== undefined) {
    what.push(`category ${filter.category}`);
    const present = summarise(a).filter((r) => r.testcases > 0).map((r) => r.category);
    lists.push(`Categories: ${present.join(', ') || 'none'}.`);
  }
  return `No failures for ${what.join(', ') || 'this view'} in this analysis. ${lists.join(' ')}`.trim();
}

/** First screenshot of the representative's focus / failed steps. */
function failedShot(it: FailureIteration, m: Mask): { url: string; where: string } | undefined {
  const step = [it.focus, ...it.failedSteps].find((s) => s?.screenshots.some((x) => x.absoluteUrl));
  const shot = step?.screenshots.find((x) => x.absoluteUrl);
  return step && shot ? { url: shot.absoluteUrl, where: `step ${step.displaySeq ?? step.seq} "${truncate(m(step.description), 120)}"` } : undefined;
}

/** What each category means — the same wording in the card and the tool descriptions. */
export const CATEGORY_DEFINITIONS = [
  'APP_DEFECT — the application does something wrong with an unchanged test and unchanged data.',
  'NEW_CHANGE — the application changed on purpose (screen, label, flow, rule or expected value), so the test is now outdated.',
  'AUTOMATION_DATA — script, locator, timing/synchronisation, test data, configuration, environment/device, or a manual stop.',
];

const INSTRUCTIONS = (id: string): string => [
  'WHAT TO DO NEXT — in this order:',
  '(1) Read the card above and the evidence for every pattern shown.',
  `(2) If a "Next:" line is present, call it (failure_analysis({ analysisId: "${id}", pattern: [...] })) until you have read the evidence for every pattern.`,
  `(3) Review EVERY failed test case: failure_analysis({ analysisId: "${id}", review: true }), then each "Next:" page until done. Compare the failed step with the same step in the last pass, and all their images (failed screenshots, baselines of both runs, element thumbnail, last passed screenshots).`,
  '(4) Call failure_analysis_classify ONCE with a verdict for EVERY pattern: { group, pattern (short name), rootCause (one or two sentences, from the evidence), category (APP_DEFECT | NEW_CHANGE | AUTOMATION_DATA), confidence }. Use splitOut for test cases whose review shows a different cause, and mergeInto for groups that share a root cause. A "suggested:" category is a hint from fixed rules, not a verdict.',
  '(5) Reply with the classified card that failure_analysis_classify returns, exactly as written.',
  'CATEGORIES:',
  ...CATEGORY_DEFINITIONS.map((d) => `  - ${d}`),
  'DECIDING FROM THE REVIEW (hints, not rules):',
  "  - For every test case, first compare the last passed step and the failed step side by side: expected, actual, test data, API status / body / assertions, locator, logs, version, and the images — today's screenshot, today's baseline, the passed run's screenshot, the passed run's baseline and the element thumbnail.",
  '  - Then state what changed and what stayed the same in one line before deciding (e.g. "Same data, same locator, same page; only the actual message changed"). Then decide the category with the hints below.',
  '  - The screen differs from the baseline AND from the last pass (new labels, fields or flow) → leans NEW_CHANGE.',
  '  - The screen is the same as the last pass / baseline, but the element was not found or timing failed → AUTOMATION_DATA.',
  '  - An application error or a wrong value, with the same data and the same screen as the last pass → APP_DEFECT.',
  '  - An unreachable or blank page → APP_DEFECT (environment).',
  '  - Images: the failed screenshot is this run. The baseline is the execution-time reference page with the target element boxed in red. The thumbnail is the target element as recorded. Same page as the baseline but the element missing or different from the thumbnail means the element or locator changed. A different page (error, blank, another screen) means the flow did not reach it. Recorded images show recording-time data: compare layout and element, not values.',
  'READING THE EVIDENCE:',
  '  - "… steps a–b not shown: n steps, all passed …" are steps that ran; "[not run]" lines are what the test would have done next.',
  '  - CONTROL FLOW IS NOT FAILURE: "[IF → false] … — steps a–b skipped" is the test\'s own branching (a branch not taken is stored as FAILED). Never treat it as the failed step.',
  '  - "[FAILED · continued]" = the run went on; "[FAILED · stopped the run]" = it ended there. Later steps that fail the same way follow from the first failure. "Broke down" = treat that step as the cause.',
  '  - Other iterations that PASSED this step with different data, or earlier calls of the same function that passed, point at this iteration\'s data or state.',
  '  - 4.2 = step 2 inside the function called at step 4. ITR-n = the test case run again with other data, not a function call.',
  '  - Warnings from passed steps are clues, not proof.',
  '  - rootCause: trace the cause back to the step where it STARTED, name it by number, and quote the error text exactly.',
].join('\n');

export function renderAnalysisView(a: FailureAnalysis, filter: AnalysisFilter, mode: RenderMode): AnalysisView {
  // Second net for protected test data (iterations are masked at read time; verdict text is the
  // model's): applied to each DATA string before it is escaped or cut — never to the scaffold.
  const masker = maskWith(protectedValues(a));
  const m: Mask = (x) => masker(x) ?? x;
  const tcs = filterTestcases(a, filter);
  const groups = scopedGroups(a, filter, tcs);
  const out: string[] = [`**Failure analysis \`${a.id}\`**`];

  if (!tcs.length || !groups.length) {
    out.push('', emptyMessage(a, filter));
    return { text: out.join('\n'), evidenceGroups: [], imageRequests: [] };
  }

  // ---- Header: scope, totals, filter, category table, notes.
  const execs = a.executions.filter((e) => tcs.some((t) => t.executionId === String(e.id)));
  const suites = uniqueSuites(tcs.map((t) => t.suite));
  const iterations = tcs.reduce((n, t) => n + t.failedIterations.length, 0);
  const times = execs.map((e) => readableTime(e.endedAt ?? e.startedAt)).filter(Boolean);
  out.push(
    `Scope: ${plural(execs.length, 'execution')} (${execs.map((e) => execRef(String(e.id), e.code)).join(', ')})`
      + ` · ${plural(suites.length, 'suite')} (${suites.map(suiteTitle).join(', ')})${times.length ? ` · ${times.join(', ')}` : ''}`,
    `Totals: ${plural(tcs.length, 'failed test case')} (${plural(iterations, 'iteration')}) · ${a.passedTestcases} passed · ${plural(groups.length, 'pattern')}`,
  );
  const shown: string[] = [];
  if (filter.suiteId !== undefined) shown.push(`suite ${filter.suiteId}`);
  if (filter.pattern !== undefined) shown.push(`pattern ${([] as number[]).concat(filter.pattern).join(', ')}`);
  if (filter.category !== undefined) shown.push(`category ${filter.category}`);
  if (shown.length) out.push(`Filter: ${shown.join(' · ')}`);

  // ---- Root-cause table (every pattern in scope, with its failed test cases), then the categories.
  const inScope = new Set(tcs.map((t) => t.key));
  out.push('', '**Failure patterns / root causes**', '', ...rootCauseTable(a, groups, tcs, m));
  out.push('', '**Failures by category** (each failed test case counted once, by its main pattern)', '', ...categoryTable(summarise(a, filter)));
  for (const n of a.notes) out.push('', n);

  // ---- The classified card stops here (no evidence, no Next:).
  if (mode === 'card') return { text: out.join('\n'), evidenceGroups: [], imageRequests: [] };

  // ---- Which groups get full evidence.
  let evidence: PatternGroup[];
  let rest: PatternGroup[] = [];
  let next: string | undefined;
  if (mode === 'first' || filter.pattern !== undefined) {
    evidence = groups.slice(0, FIRST_EVIDENCE_GROUPS);
    rest = groups.slice(FIRST_EVIDENCE_GROUPS);
    if (rest.length) {
      next = nextCall(a, filter, { pattern: rest.slice(0, GROUP_PAGE_SIZE).map((g) => g.id) });
    } else if (filter.pattern !== undefined) {
      // Every requested group is shown: chain on to the next in-scope groups after the highest one.
      const { pattern: _pattern, page: _page, ...base } = filter;
      const top = Math.max(...([] as number[]).concat(filter.pattern));
      const after = scopedGroups(a, base, filterTestcases(a, base)).filter((g) => g.id > top).slice(0, GROUP_PAGE_SIZE);
      if (after.length) next = nextCall(a, filter, { pattern: after.map((g) => g.id) });
    }
  } else {
    const pages = Math.ceil(groups.length / GROUP_PAGE_SIZE);
    const page = Math.min(Math.max(1, Math.floor(filter.page ?? 1)), pages);
    evidence = groups.slice((page - 1) * GROUP_PAGE_SIZE, page * GROUP_PAGE_SIZE);
    if (page < pages) next = nextCall(a, filter, { page: page + 1 });
    if (filter.page !== undefined && filter.page !== page) out.push('', `Page ${filter.page} does not exist; showing page ${page} of ${pages}.`);
  }

  // ---- Suite view: each suite's own category table (the root-cause table above covers every suite).
  if (filter.view === 'suite') {
    for (const s of suites) {
      const mine = tcs.filter((t) => suiteKey(t.suite) === suiteKey(s));
      out.push('', `### Suite ${suiteTitle(s)}`, '', ...categoryTable(summarise({ ...a, testcases: mine })));
    }
  }

  out.push('', CARD_END);

  // ---- Evidence.
  const byKey = new Map<string, FailureIteration>();
  const tcOfKey = new Map<string, AnalysisTestcase>();
  for (const t of a.testcases) for (const f of t.failedIterations) { byKey.set(f.key, f.it); tcOfKey.set(f.key, t); }
  const imageRequests: AnalysisView['imageRequests'] = [];
  let chars = 0;
  let compactShown = 0;
  out.push('', '## Evidence — per pattern: representative + samples (for classifying; do not paste)');
  evidence.forEach((g, gi) => {
    const v = a.verdicts[g.id];
    out.push('', `## Pattern ${g.id} — ${escapeLt(truncate(patternName(a, g, m), 200))}`,
      `- **Test cases:** ${g.testcaseKeys.filter((k) => inScope.has(k)).length} · **Iterations:** ${g.iterationKeys.length} · **Suites:** ${g.suites.map(suiteLabel).join(', ')}`,
      v
        ? `- **Verdict:** ${v.category} (${v.confidence}) — ${truncate(m(v.rootCause), 300)}`
        : `- **Suggested:** ${g.suggested.category ?? '—'} — ${truncate(m(g.suggested.because), 300)} (a hint from fixed rules, not a verdict)`);
    const keys = [g.representativeKey, ...g.sampleKeys.slice(0, SAMPLES_PER_GROUP)];
    const historyShown = new Set<string>();
    keys.forEach((key, ki) => {
      const it = byKey.get(key);
      if (!it) return;
      if (ki === 1) out.push('', `_Samples of pattern ${g.id}:_`);
      const block = iterationEvidence(it, ki > 0 || chars > EVIDENCE_BUDGET, m);
      chars += block.length;
      out.push('', block);
      // The test case's history (once per test case in this pattern): last pass, failing since, edits.
      const tc = tcOfKey.get(key);
      const hist = tc && !historyShown.has(tc.key) ? historyParts(tc.history, tc.versionName, m, 'edited since pass') : [];
      if (tc && hist.length) { historyShown.add(tc.key); out.push(`- **Test case history:** ${hist.join(' · ')}`); }
      const cmp = a.comparisons[key];
      if (cmp) {
        const ref = execRef(cmp.executionId, cmp.executionCode);
        const parts = [cmp.status, cmp.value, cmp.data, cmp.api].filter((x): x is string => !!x).map((x) => truncate(m(x), 300));
        out.push(cmp.found
          ? `- **Last pass (${ref}):** ${parts.join(' · ') || 'no detail recorded'}`
          : `- **Last pass (${ref}):** this step does not exist in the passed version`);
      }
    });
    const others = g.iterationKeys.length - keys.filter((k) => byKey.has(k)).length;
    if (others > 0) out.push(`- _Same pattern, not repeated: ${plural(others, 'more iteration')}_`);
    // A pattern view lists every failed test case of the pattern, one compact line each.
    if (filter.pattern !== undefined) {
      const mine = g.testcaseKeys.map((k) => tcs.find((t) => t.key === k)).filter((t): t is AnalysisTestcase => t !== undefined);
      out.push(`- **Failed test cases (${mine.length}):**`);
      // Budget (§7.5): 40 lines per pattern, 100 per response, in key order.
      const room = Math.max(0, Math.min(COMPACT_LINES_PER_PATTERN, COMPACT_LINES_TOTAL - compactShown));
      const listed = mine.slice(0, room);
      compactShown += listed.length;
      for (const tc of listed) {
        const shotUrl = tc.failedIterations
          .filter((f) => g.iterationKeys.includes(f.key))
          .map((f) => failedShot(f.it, m)?.url)
          .find((u): u is string => !!u);
        const parts = [
          escapeLt(testcaseLabel(tc, m)),
          // Without a code the label already IS the name: print it once.
          tc.code !== undefined && tc.name !== undefined ? escapeLt(truncate(m(tc.name), 60)) : undefined,
          historyParts(tc.history, tc.versionName, m, 'edited').join(' / ') || undefined,
          shotUrl ? `[screenshot](${shotUrl})` : undefined,
        ].filter((x): x is string => !!x);
        out.push(`  - ${parts.join(' · ')}`);
      }
      if (mine.length > listed.length) {
        out.push(`  … +${mine.length - listed.length} more test cases — failure_analysis_export for the full list`);
      }
    }
    // Defects logged against ANY iteration of this pattern — often not on the representative.
    const linked = g.iterationKeys.flatMap((key) => {
      const ofIt = byKey.get(key);
      const ids = [...new Set((ofIt?.failedSteps ?? []).flatMap((st) => (Array.isArray(st.defectIds) ? st.defectIds : [])).filter(Boolean).map(String))];
      return ids.map((id) => `${id} (${ofIt?.iteration ?? ofIt?.label ?? key})`);
    });
    if (linked.length) out.push(`- **Linked defects (this pattern):** ${[...new Set(linked)].join(', ')}`);

    if (gi < IMAGE_PAIR_GROUPS) {
      const rep = byKey.get(g.representativeKey);
      const failed = rep ? failedShot(rep, m) : undefined;
      const repExec = g.representativeKey.split(':')[0] ?? '';
      if (failed && rep) {
        const execCode = a.executions.find((e) => String(e.id) === repExec)?.code;
        imageRequests.push({
          caption: `**Screenshot — pattern ${g.id}, failed (${execRef(repExec, execCode)}):** ${rep.testcaseCode ?? rep.label} · ${failed.where}`,
          url: failed.url,
        });
      }
      const cmp = a.comparisons[g.representativeKey];
      const passUrl = cmp?.screenshot?.absoluteUrl;
      if (failed && cmp && passUrl) {
        imageRequests.push({
          caption: `**Screenshot — pattern ${g.id}, last passed (${execRef(cmp.executionId, cmp.executionCode)}):** same step`,
          url: passUrl,
        });
      }
    }
  });

  // Groups beyond the evidence set are listed once — in the root-cause table above — not again here.
  if (rest.length) out.push('', `_Evidence for ${plural(rest.length, 'more pattern')} is not in this response._`);
  if (next) out.push('', next);

  out.push('', '---', INSTRUCTIONS(a.id));
  return {
    text: out.join('\n'),
    evidenceGroups: evidence.map((g) => g.id),
    imageRequests: imageRequests.slice(0, IMAGE_PAIR_GROUPS * 2),
  };
}

