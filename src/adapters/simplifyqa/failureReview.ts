/**
 * Review mode of a stored failure analysis (`failure_analysis({ analysisId, review: true, page })`):
 * EVERY failed test case, in pattern order then key order. Each one gets its failed step and the
 * same step in the last passed run at the same detail (expected / actual, test data, full API,
 * locator, logs — masked) and every relevant image of both steps: the failed screenshots, today's
 * baseline, the element thumbnail, the last passed screenshots, the passed run's baseline and (when
 * it differs) the passed step's thumbnail. Pages are filled until the next test case would pass
 * MAX_REVIEW_IMAGES (or the text budget), at least one per page. Pure: the tool layer fetches the
 * images and records `reviewedKeys`. Nothing here asserts a root cause, and nothing here computes
 * what changed between the two steps — the reader compares them.
 */
import type { FailureIteration } from './failureTypes.js';
import { REVIEW_LOG_LINES, type StepComparison } from './failureHistory.js';
import type { AnalysisTestcase, FailureAnalysis } from './failureAnalysisTypes.js';
import { NO_SUITE } from './failureAnalysis.js';
import { historyParts, testcaseLabel } from './failureAnalysisCard.js';
import { maskWith, protectedValues } from './failureReportModel.js';
import { apiLines, collapseRepeats, truncate, type Mask } from './failureReport.js';
import { looksLikeImage } from './failureImages.js';
import { stepData } from './flow.js';

export { REVIEW_LOG_LINES };
/** Images per review page at most; images per test case at most; text per page at most (chars). */
export const MAX_REVIEW_IMAGES = 18, MAX_TESTCASE_IMAGES = 12, REVIEW_TEXT_CAP = 18_000;
/** API response body shown per step; the passed step's body is cut to CUT_API_BODY_CHARS when the
 *  page is still over the cap after the logs were cut. */
const REVIEW_API_BODY_CHARS = 4_000, CUT_API_BODY_CHARS = 500;
/** Text levels tried, in order, until the page fits REVIEW_TEXT_CAP: logs are cut first, then the
 *  passed step's API body. */
const LEVELS: Level[] = [
  { logs: REVIEW_LOG_LINES, passBody: REVIEW_API_BODY_CHARS },
  { logs: 3, passBody: REVIEW_API_BODY_CHARS },
  { logs: 0, passBody: REVIEW_API_BODY_CHARS },
  { logs: 0, passBody: CUT_API_BODY_CHARS },
];
/** The level pages are packed at. */
const PACK_LEVEL: Level = { logs: 3, passBody: REVIEW_API_BODY_CHARS };
const MAX_LOG_CHARS = 500;
const MAX_OTHER_ITERATIONS = 5;

type Level = { logs: number; passBody: number };

/** One image slot. `url` set → fetch it and show `caption` above it; when it is not set or cannot be
 *  fetched, `missing` is shown in its place. */
export type ReviewImage = {
  caption: string; url?: string; missing: string;
  /** The test case label (masked) and the slot, e.g. "TC-12" / "baseline". */
  label: string; kind: string;
};
export type ReviewView = {
  text: string;
  /** Test case keys whose blocks this page rendered (to add to `reviewedKeys`). */
  testcaseKeys: string[];
  /** Their pattern groups (marked evidenceShown). */
  groups: number[];
  images: ReviewImage[];
};

const execRef = (id: string, code?: string): string => code ?? `EX-${id}`;
const isFetchable = (url: string): boolean => /^https?:\/\//i.test(url) && looksLikeImage(url);

/** Every failed test case in review order: its main pattern's position, then its key. */
export function reviewOrder(a: FailureAnalysis): AnalysisTestcase[] {
  const rank = new Map(a.groups.map((g, i) => [g.id, i]));
  const r = (tc: AnalysisTestcase): number => rank.get(tc.primaryGroup) ?? Number.MAX_SAFE_INTEGER;
  return [...a.testcases].sort((x, y) => r(x) - r(y) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

/** The keys already reviewed that are failed test cases of this analysis. */
const reviewedOf = (a: FailureAnalysis, extra: string[] = []): Set<string> => {
  const keys = new Set(a.testcases.map((t) => t.key));
  return new Set([...(a.reviewedKeys ?? []), ...extra].filter((k) => keys.has(k)));
};

/** "Reviewed k/total test cases individually." while the review is incomplete; undefined once done. */
export function reviewedLine(a: FailureAnalysis): string | undefined {
  const total = a.testcases.length;
  const k = reviewedOf(a).size;
  return total && k < total ? `Reviewed ${k}/${total} test cases individually.` : undefined;
}

/** The iteration a test case is reviewed by: its first in its main pattern, else its first. */
function mainIteration(a: FailureAnalysis, tc: AnalysisTestcase): { key: string; it: FailureIteration } | undefined {
  const g = a.groups.find((x) => x.id === tc.primaryGroup);
  return tc.failedIterations.find((f) => g?.iterationKeys.includes(f.key)) ?? tc.failedIterations[0];
}

const suiteText = (tc: AnalysisTestcase): string =>
  tc.suite.code ?? (tc.suite.id !== undefined ? `SU-${tc.suite.id}` : tc.suite.name ?? NO_SUITE);

function logBlock(lines: string[] | undefined, n: number, m: Mask, indent: string): string[] {
  // Retries log the same line again and again: consecutive repeats collapse to "line (×n)".
  const tail = collapseRepeats((lines ?? []).map((l) => m(l))).slice(-n);
  if (!n || !tail.length) return [];
  return [`${indent}- Logs (last ${tail.length}):`, `${indent}  \`\`\`text`, ...tail.map((l) => `${indent}  ${truncate(l, MAX_LOG_CHARS)}`), `${indent}  \`\`\``];
}

/** "Locator: `…`" — the locator a step used (it can embed test data, so it is masked). */
const locatorLine = (locator: string | undefined, m: Mask): string[] =>
  (locator ? [`  - Locator: \`${truncate(m(locator), 300)}\``] : []);

function failedStepLines(it: FailureIteration, logs: number, m: Mask): string[] {
  const s = it.focus;
  if (!s) {
    return [`- **Failed step:** none — the run failed with no failed step${it.exception ? `: ${truncate(m(it.exception), 400)}` : ''}`];
  }
  const where = s.trail ?? (s.reportStep ? `step ${s.reportStep}` : `step ${s.seq}`);
  const out = [`- **Failed step:** ${where}${s.reportStep ? ` (report step ${s.reportStep})` : ''} — ${truncate(m(s.description), 200)} \`${s.status}\``];
  if (s.objectName || s.actionName) out.push(`  - Object: ${m(s.objectName ?? '-')} · Action: ${m(s.actionName ?? '-')}`);
  out.push(...locatorLine(s.locator, m));
  if (s.expected !== undefined) out.push(`  - Expected: ${truncate(m(s.expected), 400)}`);
  if (s.actual !== undefined) out.push(`  - Actual: ${truncate(m(s.actual), 400)}`);
  const errors = [...new Set([s.cause, ...s.errorLines, s.exception].filter((x): x is string => !!x))].slice(0, 3);
  for (const e of errors) out.push(`  - Error: ${truncate(m(e), 300)}`);
  const data = stepData({ testdata: s.testdata });
  if (data) out.push(`  - Test data: ${truncate(m(data), 300)}`);
  out.push(...apiLines(s.apiData, m, { bodyChars: REVIEW_API_BODY_CHARS, indent: '  ' }));
  out.push(...logBlock(s.logTail, logs, m, '  '));
  return out;
}

/** A failure with no failed step (run-level, or no step id) has nothing to compare with the last pass. */
const NO_STEP = 'no failed step to compare';
const noStep = (it: FailureIteration): boolean => !it.focus?.stepId;

function passedStepLines(
  tc: AnalysisTestcase, it: FailureIteration, cmp: StepComparison | null | undefined, level: Level, m: Mask,
): string[] {
  if (noStep(it) && tc.history?.lastPassed) return [`- **Same step in the last passed run:** ${NO_STEP}`];
  if (!cmp) {
    return tc.history?.lastPassed
      ? ['- **Same step in the last passed run:** not compared']
      : ['- **Same step in the last passed run:** no last passed run'];
  }
  const ref = execRef(cmp.executionId, cmp.executionCode);
  if (!cmp.found) return [`- **Same step in the last passed run (${ref}):** this step does not exist in the passed version`];
  const out = [`- **Same step in the last passed run (${ref}):** ${cmp.status ?? 'status not recorded'}`];
  out.push(...locatorLine(cmp.locator, m));
  if (cmp.expected !== undefined) out.push(`  - Expected: ${truncate(m(cmp.expected), 400)}`);
  if (cmp.actual !== undefined) out.push(`  - Actual: ${truncate(m(cmp.actual), 400)}`);
  if (cmp.expected === undefined && cmp.actual === undefined && cmp.value) out.push(`  - Value: ${truncate(m(cmp.value), 400)}`);
  if (cmp.data) out.push(`  - Test data: ${truncate(m(cmp.data), 300)}`);
  // The full API (status, body, assertions) as for the failed step; an analysis stored before the
  // API was kept in full has only its one-line summary.
  const api = apiLines(cmp.apiData, m, { bodyChars: level.passBody, indent: '  ' });
  if (api.length) out.push(...api);
  else if (cmp.api) out.push(`  - API: ${truncate(m(cmp.api), 300)}`);
  out.push(...logBlock(cmp.logs, level.logs, m, '  '));
  return out;
}

/** The note for an image slot with no usable value when the step was read ("<slot> skipped: …"). */
const skippedNote = (notes: string[] | undefined, what: string): string | undefined =>
  notes?.find((n) => n.startsWith(`${what} skipped: `))?.slice(what.length + ' skipped: '.length);

/** Distinct urls among the slots — what a test case costs in images. */
const sentCount = (slots: ReviewImage[]): number => new Set(slots.flatMap((s) => (s.url ? [s.url] : []))).size;

/**
 * Every image slot of one test case, in the fixed order: the failed screenshots (this run), today's
 * baseline, the element thumbnail, the last passed screenshots, the passed run's baseline, and the
 * passed step's thumbnail (a note when it is today's). Over MAX_TESTCASE_IMAGES, a step's
 * screenshots are cut to its first and last (the larger step first). Captions carry the masked
 * label (a name when there is no code).
 */
function testcaseImages(a: FailureAnalysis, tc: AnalysisTestcase, m: Mask): ReviewImage[] {
  const f = mainIteration(a, tc);
  const label = tc.code ?? (tc.name !== undefined ? m(tc.name) : tc.key);
  const it = f?.it;
  const s = it?.focus;
  const cmp = f ? a.comparisons[f.key] : undefined;
  const slot = (kind: string, caption: string, url: string | undefined, none: string): ReviewImage => {
    if (url === undefined) return { caption, label, kind, missing: `${label} · ${kind}: ${none}` };
    if (!isFetchable(url)) return { caption, label, kind, missing: `${label} · ${kind}: not an image ("${truncate(url, 80)}")` };
    return { caption, label, kind, url, missing: `${caption}: could not be fetched` };
  };
  const note = (kind: string, text: string): ReviewImage => ({ caption: `${label} · ${kind}`, label, kind, missing: `${label} · ${kind}: ${text}` });
  const numbered = (n: number, i: number): string => (n > 1 ? ` ${i + 1}/${n}` : '');

  const execCode = a.executions.find((e) => String(e.id) === tc.executionId)?.code;
  const shotStep = it ? [it.focus, ...it.failedSteps].find((x) => x?.screenshots.some((y) => y.absoluteUrl)) : undefined;
  const shotUrls = (shotStep?.screenshots ?? []).map((y) => y.absoluteUrl).filter((u) => !!u);
  const failedShots = shotUrls.length
    ? shotUrls.map((u, i) => slot('failed screenshot', `${label} · failed screenshot${numbered(shotUrls.length, i)} (${execRef(tc.executionId, execCode)}, this run)`, u, 'none recorded'))
    : [slot('failed screenshot', `${label} · failed screenshot (${execRef(tc.executionId, execCode)}, this run)`, undefined, 'none recorded')];
  const today = [
    slot('baseline', `${label} · baseline (execution time, this run — page with the element boxed in red)`, s?.recordedBaseline, skippedNote(s?.imageNotes, 'baseline') ?? 'none recorded'),
    slot('element thumbnail', `${label} · element thumbnail (recording time)`, s?.recordedThumbnail, skippedNote(s?.imageNotes, 'element thumbnail') ?? 'none recorded'),
  ];

  const compared = !!cmp && cmp.found && !(it && noStep(it));
  const passNone = !tc.history?.lastPassed ? 'no last passed run'
    : it && noStep(it) ? NO_STEP
      : !cmp ? 'not compared'
        : !cmp.found ? 'this step does not exist in the passed version' : 'none recorded';
  const passRef = cmp ? execRef(cmp.executionId, cmp.executionCode) : '';
  const passUrls = compared ? (cmp!.screenshots ?? (cmp!.screenshot ? [cmp!.screenshot] : [])).map((y) => y.absoluteUrl).filter((u) => !!u) : [];
  const passShots = passUrls.length
    ? passUrls.map((u, i) => slot('last passed', `${label} · last passed screenshot${numbered(passUrls.length, i)} (${passRef})`, u, passNone))
    : [slot('last passed', compared || (cmp && !(it && noStep(it))) ? `${label} · last passed screenshot (${passRef})` : `${label} · last passed`, undefined, passNone)];
  const passed: ReviewImage[] = [];
  if (compared) {
    passed.push(slot('passed baseline', `${label} · baseline (execution time, last passed ${passRef})`, cmp!.baseline?.baseline,
      skippedNote(cmp!.imageNotes, 'baseline') ?? 'none recorded'));
    const thumb = cmp!.baseline?.thumbnail;
    if (thumb !== undefined) {
      passed.push(thumb === s?.recordedThumbnail
        ? note('passed thumbnail', 'same element thumbnail as today')
        : slot('passed thumbnail', `${label} · element thumbnail of the passed step (recording time)`, thumb, 'none recorded'));
    }
  }

  // Over the per-test-case cap: cut the step with more screenshots to its first and last, then the other.
  const all = (): ReviewImage[] => [...failed, ...today, ...pass, ...passed];
  let failed = failedShots;
  let pass = passShots;
  const cut = (shots: ReviewImage[], kind: string): ReviewImage[] => {
    const sent = shots.filter((x) => x.url);
    if (sent.length <= 2) return shots;
    return [sent[0]!, note(kind, `+${sent.length - 2} more screenshots (links in the export)`), sent[sent.length - 1]!];
  };
  const order = sentCount(failedShots) >= sentCount(passShots) ? ['failed', 'pass'] : ['pass', 'failed'];
  for (const which of order) {
    if (sentCount(all()) <= MAX_TESTCASE_IMAGES) break;
    if (which === 'failed') failed = cut(failed, 'failed screenshot');
    else pass = cut(pass, 'last passed');
  }
  return all();
}

function testcaseBlock(a: FailureAnalysis, tc: AnalysisTestcase, level: Level, m: Mask): string {
  const f = mainIteration(a, tc);
  const head = [
    testcaseLabel(tc, m),
    tc.code !== undefined && tc.name !== undefined ? truncate(m(tc.name), 80) : undefined,
    `pattern #${tc.primaryGroup}`,
    suiteText(tc),
  ].filter((x): x is string => !!x);
  const out = [`### ${head.join(' · ')}`];
  if (f) out.push(`- **Iteration:** ${f.it.iteration ?? f.it.label} · key \`${f.key}\``);
  const others = tc.failedIterations.filter((x) => x !== f);
  if (others.length) {
    const groupOf = (k: string): number | undefined => a.groups.find((g) => g.iterationKeys.includes(k))?.id;
    const shown = others.slice(0, MAX_OTHER_ITERATIONS).map((x) => `${x.it.iteration ?? x.it.label} (pattern #${groupOf(x.key) ?? '?'})`);
    out.push(`- **Also failed:** ${shown.join(', ')}${others.length > shown.length ? `, +${others.length - shown.length} more` : ''}`);
  }
  const hist = historyParts(tc.history, tc.versionName, m, 'edited since pass');
  out.push(`- **History:** ${hist.length ? hist.join(' · ') : 'not read'}`);
  if (f) out.push(...failedStepLines(f.it, level.logs, m), ...passedStepLines(tc, f.it, a.comparisons[f.key], level, m));
  return out.join('\n');
}

const maskOf = (a: FailureAnalysis): Mask => {
  const masker = maskWith(protectedValues(a));
  return (x) => masker(x) ?? x;
};

/**
 * The review pages, in review order: each is filled with test cases until the next one would take
 * the page past MAX_REVIEW_IMAGES images (a test case costs its distinct images, at most
 * MAX_TESTCASE_IMAGES) or past the text budget (blocks measured with 3 log lines); at least one
 * test case per page. Depends only on the analysis, so every page agrees on the paging.
 */
export function reviewPages(a: FailureAnalysis): AnalysisTestcase[][] {
  const m = maskOf(a);
  // Room for the page around the blocks, at its WORST: every note, an out-of-range line and the
  // longest footer ("Not reviewed yet" listing every page). Measured with the test case count as
  // the page count (never fewer pages than that), so a packed page never has to drop a block — a
  // dropped block would be dropped again on every visit and never be reviewed.
  const budget = REVIEW_TEXT_CAP - pageChrome(a, a.testcases.length).length;
  const pages: AnalysisTestcase[][] = [];
  let cur: AnalysisTestcase[] = [];
  let images = 0;
  let size = 0;
  for (const tc of reviewOrder(a)) {
    const cost = sentCount(testcaseImages(a, tc, m));
    const len = testcaseBlock(a, tc, PACK_LEVEL, m).length + 2;
    if (cur.length && (images + cost > MAX_REVIEW_IMAGES || size + len > budget)) {
      pages.push(cur);
      cur = [];
      images = 0;
      size = 0;
    }
    cur.push(tc);
    images += cost;
    size += len;
  }
  if (cur.length) pages.push(cur);
  return pages;
}

const KB = Math.round(REVIEW_TEXT_CAP / 1000);
const headOf = (a: FailureAnalysis): string => `**Failure analysis \`${a.id}\` — review of every failed test case**`;

function introOf(a: FailureAnalysis, page: number, pages: number, first: number, last: number, total: number, requested: number): string[] {
  const intro = [
    headOf(a),
    `Page ${page} of ${pages} · failed test cases ${first}–${last} of ${total}, in pattern order.`,
    'For each test case: compare the last passed step with the failed step side by side — expected, actual, test data, API status / body / assertions, locator, logs, version — and the images below (failed screenshots, today\'s baseline, the element thumbnail, the last passed screenshots, the passed run\'s baseline). '
      + 'State what changed and what stayed the same in one line (e.g. "same data, same locator, same page; only the actual message changed"), then decide the category. Evidence for classifying — do not paste.',
  ];
  if (requested !== page) intro.push(`Page ${requested} does not exist; showing page ${page} of ${pages}.`);
  return intro;
}

/** The footer: how many are reviewed, then Next / the pages not reviewed yet / what to do now. */
function footerOf(a: FailureAnalysis, page: number, pages: number, total: number, reviewed: number, missing: number[]): string[] {
  const out = [`Reviewed ${reviewed}/${total} failed test cases.`];
  if (page < pages) {
    out.push(`Next: failure_analysis({ analysisId: "${a.id}", review: true, page: ${page + 1} })`);
  } else if (missing.length) {
    out.push(`Not reviewed yet: page ${missing.join(', ')} — failure_analysis({ analysisId: "${a.id}", review: true, page: ${missing[0]} }).`);
  } else {
    out.push('Review complete. For every test case you should now have one line of what changed and what stayed the same between the last passed and the failed step. Now call failure_analysis_classify ONCE with a verdict for every pattern — use `splitOut` for test cases whose review shows a different cause and `mergeInto` for groups that share one — then reply with the classified card.');
  }
  return out;
}

function notesOf(level: Level, dropped: number): string[] {
  return [
    ...(level.logs < REVIEW_LOG_LINES ? [`_(log lines cut to ${level.logs} per step to keep this page under ${KB} KB.)_`] : []),
    ...(level.passBody < REVIEW_API_BODY_CHARS ? [`_(the last passed step's API body cut to ${level.passBody} characters to keep this page under ${KB} KB.)_`] : []),
    ...(dropped ? [`_(${dropped} test case(s) of this page not shown — over the size cap; they are not counted as reviewed.)_`] : []),
  ];
}

/** Everything on a page around its blocks, at its longest for `pages` pages: the intro with an
 *  out-of-range line, every note, and both long footers. */
function pageChrome(a: FailureAnalysis, pages: number): string {
  const n = Math.max(1, pages);
  const total = a.testcases.length;
  const every = Array.from({ length: n }, (_, i) => i + 1);
  const footer = [footerOf(a, n, n, total, total, every), footerOf(a, n, n, total, total, [])]
    .map((f) => f.join('\n')).sort((x, y) => y.length - x.length)[0]!;
  return [
    ...introOf(a, n, n, total, total, total, Number.MAX_SAFE_INTEGER),
    ...notesOf({ logs: 0, passBody: CUT_API_BODY_CHARS }, total),
    '', '', footer, `Next: failure_analysis({ analysisId: "${a.id}", review: true, page: ${n} })`,
  ].join('\n');
}

export function renderReviewPage(a: FailureAnalysis, requested: number): ReviewView {
  const m = maskOf(a);
  const all = reviewOrder(a);
  if (!all.length) return { text: `${headOf(a)}\n\nNo failed test cases to review.`, testcaseKeys: [], groups: [], images: [] };

  const pageList = reviewPages(a);
  const pages = pageList.length;
  const page = Math.min(Math.max(1, Math.floor(requested)), pages);
  const mine = pageList[page - 1]!;
  const start = pageList.slice(0, page - 1).reduce((n, p) => n + p.length, 0);
  const pageOf = new Map(pageList.flatMap((p, i) => p.map((t) => [t.key, i + 1] as const)));
  // ---- Text: logs are cut first, then the passed step's API body; then whole test case blocks are
  // dropped from the end (never a cut inside a block, so no code fence is left open). Only the
  // blocks rendered count as reviewed. Pages are packed (reviewPages) so that a drop does not happen.
  const intro = introOf(a, page, pages, start + 1, start + mine.length, all.length, requested);
  const footerFor = (keys: string[]): string[] => {
    const reviewed = reviewedOf(a, keys);
    const missing = [...new Set(all.filter((t) => !reviewed.has(t.key)).map((t) => pageOf.get(t.key) ?? 1))].sort((x, y) => x - y);
    return footerOf(a, page, pages, all.length, reviewed.size, missing);
  };
  const kb = KB;
  const render = (level: Level, n: number): string => {
    const notes = notesOf(level, mine.length - n);
    const shown = mine.slice(0, n);
    return [...intro, ...notes, '', shown.map((tc) => testcaseBlock(a, tc, level, m)).join('\n\n'), '', ...footerFor(shown.map((t) => t.key))].join('\n');
  };
  let rendered = mine.length;
  let text = '';
  for (const level of LEVELS) {
    text = render(level, rendered);
    if (text.length <= REVIEW_TEXT_CAP) break;
  }
  const tightest = LEVELS[LEVELS.length - 1]!;
  while (text.length > REVIEW_TEXT_CAP && rendered > 1) {
    rendered--;
    text = render(tightest, rendered);
  }
  if (text.length > REVIEW_TEXT_CAP) {
    // One block alone is over the cap: cut it, close any open code fence, keep the footer.
    const footer = footerFor([mine[0]!.key]).join('\n');
    const tail = `\n…(cut to stay under ${kb} KB)\n\n${footer}`;
    let body = text.slice(0, REVIEW_TEXT_CAP - tail.length - 8);
    if ((body.match(/```/g) ?? []).length % 2 === 1) body += '\n```';
    text = `${body}${tail}`;
  }
  const shown = mine.slice(0, rendered);

  // ---- Images of the rendered test cases: every slot, a url sent once per page, at most MAX_REVIEW_IMAGES.
  const images: ReviewImage[] = [];
  const firstCaption = new Map<string, string>();
  let sent = 0;
  for (const tc of shown) {
    for (const img of testcaseImages(a, tc, m)) {
      if (img.url === undefined) { images.push(img); continue; }
      const { url: _url, ...rest } = img;
      const dup = firstCaption.get(img.url);
      if (dup !== undefined) { images.push({ ...rest, missing: `${img.label} · ${img.kind}: same image as ${dup}` }); continue; }
      if (sent >= MAX_REVIEW_IMAGES) {
        images.push({ ...rest, missing: `${img.label} · ${img.kind}: not sent (${MAX_REVIEW_IMAGES} images per page)` });
        continue;
      }
      firstCaption.set(img.url, img.caption);
      sent++;
      images.push(img);
    }
  }

  return {
    text,
    testcaseKeys: shown.map((t) => t.key),
    groups: [...new Set(shown.map((t) => t.primaryGroup))].filter((g) => a.groups.some((x) => x.id === g)).sort((x, y) => x - y),
    images,
  };
}
