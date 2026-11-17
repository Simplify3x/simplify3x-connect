/**
 * The text `failure_analysis` returns for a SimplifyQA execution, and the screenshots it inlines.
 *
 * The text is two parts. The ANALYSIS CARD is built by code, in the same shape as the in-app
 * assistant's card (ai-assistant `testcase_composer.report_markdown`): counts, "Why … failed",
 * "Failed test cases" / "Failed iterations", and each failed iteration — so the tables are the same
 * every time instead of being re-written by the client's model. The EVIDENCE after it (expected /
 * actual, logs, screenshots) is for the model to write the Why / Fix per cause. Nothing here
 * asserts a root cause.
 */

import type { ExecutionFailureContext, FailureIteration, FailureStep } from './failureTypes.js';
import { trimTrace } from './failureCategory.js';

/** What `failure_analysis` returns: the card + evidence text and the inline screenshots. */
export type FailureReport = {
  text: string;
  images: Array<{ caption: string; data: string; mimeType: string }>;
};

function truncate(v: unknown, n = 240): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

/** Consecutive repeats of one log line collapsed to "line (×n)" — retries log the same error. */
function collapseRepeats(lines: string[]): string[] {
  const out: string[] = [];
  let n = 0;
  lines.forEach((l, i) => {
    n++;
    if (lines[i + 1] !== l) { out.push(n > 1 ? `${l} (×${n})` : l); n = 0; }
  });
  return out;
}

/** An API step's response and assertions — the status code alone does not say WHY the call failed
 *  (e.g. 500 with "Duplicate Name Error"). */
function apiLines(apiData: unknown): string[] {
  const a = apiData as { responseData?: any; assertions?: unknown } | undefined;
  if (!a || typeof a !== 'object') return [];
  const out: string[] = [];
  const res = a.responseData;
  if (res && (res.statusCode !== undefined || res.responseBody)) {
    const body = res.responseBody === undefined || res.responseBody === null ? '' : String(res.responseBody).replace(/\s+/g, ' ');
    out.push(`- **API response:** status ${res.statusCode ?? '?'}${body ? ` · body \`${truncate(body, 500)}\`` : ''}`);
  }
  const checks = (Array.isArray(a.assertions) ? a.assertions : []).filter((c: any) => c && typeof c === 'object') as any[];
  if (checks.length) {
    out.push('- **Assertions:**');
    for (const c of checks.slice(0, 10)) {
      out.push(`  - ${c.key ?? c.path ?? '?'} ${c.condition ?? ''} · expected "${truncate(String(c.expectedValue ?? ''), 120)}" · actual "${truncate(String(c.actualValue ?? ''), 120)}" · ${c.status ?? ''}`);
    }
  }
  return out;
}

function stepText(s: FailureStep, index: number, withLogs = true): string {
  const where = s.trail ?? (s.reportStep ? `TC step ${s.reportStep}` : `step ${s.seq}`);
  const head = `### ${index + 1}. ${where}${s.reportStep ? ` (report step ${s.reportStep})` : ''} — ${s.description}  \`${s.status}\``;
  const lines: string[] = [head];
  if (s.objectName || s.actionName) {
    lines.push(`- **Object:** ${s.objectName ?? '-'} · **Action:** ${s.actionName ?? '-'}`);
  }
  if (s.locator) lines.push(`- **Locator:** \`${truncate(s.locator, 300)}\``);
  if (s.expected !== undefined) lines.push(`- **Expected:** ${truncate(s.expected, 400)}`);
  if (s.actual !== undefined) lines.push(`- **Actual:** ${truncate(s.actual, 400)}`);
  if (s.exception) lines.push(`- **Exception:** ${truncate(s.exception, 600)}`);
  lines.push(...apiLines(s.apiData));
  if (s.errorLines.length) {
    lines.push('- **Failure evidence:**');
    for (const e of s.errorLines.slice(0, 8)) lines.push(`  - ${truncate(e, 500)}`);
    if (s.errorLines.length > 8) lines.push(`  - … ${s.errorLines.length - 8} more`);
  }
  if (s.testdata?.length) {
    const td = s.testdata
      .map((t) => {
        const name = String(t['paramName'] ?? t['runtimeKey'] ?? 'param');
        const value = t['protected'] ? '***' : String(t['value'] ?? '');
        return `${name}=${value}`;
      })
      .slice(0, 8)
      .join(', ');
    lines.push(`- **Test data:** ${truncate(td, 500)}`);
  }
  if (s.screenshots.length) {
    lines.push('- **Screenshots:**');
    for (const a of s.screenshots.slice(0, 5)) {
      lines.push(`  - [${a.name ?? a.originalName ?? 'screenshot'}](${a.absoluteUrl})`);
    }
  }
  if (s.recordedBaseline) lines.push(`- **Recorded baseline:** ${s.recordedBaseline}`);
  if (s.executedThumbnail) lines.push(`- **Executed thumbnail:** ${s.executedThumbnail}`);
  if (withLogs && s.logs.length) {
    const tail = collapseRepeats(s.logs.slice(-12).map((l) => l.replace(/\s+$/, '')));
    lines.push(`- **Logs (last ${Math.min(12, s.logs.length)} of ${s.logCount}):**`);
    lines.push('```text');
    lines.push(...tail);
    lines.push('```');
  }
  return lines.join('\n');
}

/** Screenshots returned inline: one per cause group (its representative's failure screenshot), top
 *  groups only — each image costs the client model ~1–1.5k tokens of context. */
export const MAX_INLINE_IMAGES = 5;
const MAX_INLINE_IMAGE_BYTES = 1_000_000;

/** Which screenshot shows each group's failure: the representative's focus step first, then its
 *  other failed steps. Groups without a screenshot are skipped (their links stay in the text). */
export function pickGroupScreenshots(ctx: ExecutionFailureContext, max = MAX_INLINE_IMAGES): Array<{ caption: string; url: string }> {
  const byRunId = new Map<string, FailureIteration>();
  for (const t of ctx.testcases) for (const it of t.failedIterations) byRunId.set(it.runId, it);
  const out: Array<{ caption: string; url: string }> = [];
  for (const g of ctx.groups) {
    if (out.length >= max) break;
    const it = byRunId.get(g.representativeRunId);
    const step = [it?.focus, ...(it?.failedSteps ?? [])].find((s) => s?.screenshots.some((a) => a.absoluteUrl));
    const shot = step?.screenshots.find((a) => a.absoluteUrl);
    if (!step || !shot) continue;
    out.push({
      caption: `**Screenshot — cause group ${g.id}:** ${g.representative} · step ${step.displaySeq ?? step.seq} "${truncate(step.description, 120)}"`,
      url: shot.absoluteUrl,
    });
  }
  return out;
}

/** A table cell: no pipes or newlines, "—" when empty. */
function td(v: unknown, n = 160): string {
  const s = v === undefined || v === null || v === '' ? '—' : truncate(String(v), n);
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** "Failed at": the trail in the test case, with the report's own number. */
function failedAt(it: FailureIteration): string {
  const f = it.focus;
  if (!f) return it.readError ? 'steps could not be read' : 'never started — no steps were recorded for this run';
  const where = f.trail ?? (f.reportStep ? `TC step ${f.reportStep}` : `step ${f.seq}`);
  const report = f.reportStep && f.trail && f.trail !== `TC step ${f.reportStep}` ? ` (report step ${f.reportStep})` : '';
  return `${where}${report}${it.source === 'run_level' ? ' — last step that ran' : ''}`;
}

/** The error shown for an iteration: its step's cause, else the step / run exception. */
const errorOf = (it: FailureIteration): string | undefined =>
  it.focus?.cause ?? it.focus?.exception ?? it.exception ?? it.readError;

/** One failed iteration's block inside the card (the in-app card's "Each failed …" block). */
function iterationCard(it: FailureIteration): string[] {
  const name = [it.testcaseCode ?? it.label, it.testcaseName].filter(Boolean).join(' — ');
  const tail = [it.versionName, it.iteration, it.platform, it.group !== undefined ? `cause #${it.group}` : undefined]
    .filter(Boolean).join(' · ');
  const lines = ['', `**${name}**${tail ? ` (${tail})` : ''}`, `**Failed at:** ${failedAt(it)}  `];
  if (it.focus?.description) lines.push(`**What failed:** ${truncate(it.focus.description, 300)}  `);
  const error = errorOf(it);
  if (error) lines.push(`**Error:** \`${truncate(error, 400).replace(/`/g, "'")}\`  `);
  if (it.source === 'run_level') lines.push('No step reported FAILED — the run was marked failed at run level (manual verdict or a stop).  ');
  return lines;
}

/** Characters of FLOW text across all causes — past it, a cause keeps only its failure window. */
const FLOW_BUDGET = 24_000;
/** Lines kept around the failure when the budget is spent. */
const FLOW_TIGHT_LINES = 12;

/** The whole-test-case context of one representative (flow.ts). `tight` keeps only the lines around
 *  the failure. */
function flowText(it: FailureIteration, tight: boolean): string[] {
  const f = it.flow;
  if (!f) return [];
  if (!f.lines.length) return ['#### FLOW', '_No steps were recorded for this run — it never started. The reason is the run / execution exception above._'];
  let lines = f.lines;
  if (tight) {
    const at = lines.findIndex((l) => l.includes('[FAILED'));
    lines = at < 0 ? lines.slice(-FLOW_TIGHT_LINES) : lines.slice(Math.max(0, at - FLOW_TIGHT_LINES + 3), at + 3);
  }
  const out = ['#### FLOW (report step [status] description | test data)', '```text', ...lines.map((l) => truncate(l, 400)), '```'];
  if (tight) out.push('_(FLOW cut to the failure to keep the result small.)_');
  if (f.breakdown) out.push(`- **Broke down:** ${f.breakdown} — the run broke down at that step.`);
  if (f.notRun?.length) out.push('- **Written steps not run** (what the test was going to do next):', ...f.notRun.map((l) => `  - ${l}`));
  if (f.functionCalls) out.push(`- **Function calls:** ${f.functionCalls}`);
  if (f.otherIterations?.length) out.push('- **Other iterations of this test case:**', ...f.otherIterations.map((l) => `  - ${l}`));
  if (f.warnings.length) out.push('- **Warnings from steps that PASSED** (clues, not proof):', ...f.warnings.map((l) => `  - ${l}`));
  return out;
}

/** Failed steps given full detail per representative; the rest are one line each. */
const DETAILED_STEPS = 3;

/** One failed iteration's full evidence (after the card): flow, expected/actual, logs, screenshots.
 *  Logs only for the step that explains the cause (the focus). */
function iterationEvidence(it: FailureIteration, tightFlow = false): string {
  const lines = [`### ${it.testcaseCode ?? it.label}${it.iteration ? ` · ${it.iteration}` : ''}${it.group !== undefined ? ` · cause #${it.group}` : ''}`];
  if (it.exception && it.exception !== errorOf(it)) lines.push(`- **Run exception:** ${truncate(trimTrace(it.exception) ?? it.exception, 400)}`);
  if (it.readError) lines.push(`- **Steps could not be read:** ${truncate(it.readError, 300)}`);
  lines.push(...flowText(it, tightFlow));
  it.failedSteps.slice(0, DETAILED_STEPS).forEach((s, i) => {
    lines.push(stepText(s, i, s === it.focus).replace(/^### /, '#### '));
  });
  const rest = it.failedSteps.slice(DETAILED_STEPS);
  if (rest.length) {
    lines.push(`- _${rest.length} more failed step(s): ${truncate(rest.map((s) => `${s.reportStep ?? s.seq} ${s.description}`).join('; '), 400)}_`);
  }
  return lines.join('\n');
}

/** How to read the evidence and answer — the in-app assistant's rules for the tester
 *  (ai-assistant `_lib/explain.py` _FAILURE_READING / _FAILURE_SHAPE_PROSE), condensed. */
const TESTER_GUIDE = [
  'HOW TO ANSWER — as the tester who has to act on this:',
  '(1) Reply with the ANALYSIS CARD — everything this result starts with, up to the first line that is only "---" — exactly as written: same title, tables, rows and columns; never summarise or reword it, and add nothing before it.',
  '(2) Then the ANSWER blocks, one per cause, in the order given: keep every label and the facts already written; replace each "…" with one or two sentences. Nothing else — no extra headings, no paragraphs between or after the blocks.',
  '  - Why: what the test was doing (from the FLOW) and the cause, traced back to the step where it STARTED — which may be well before the failed step (a value entered wrongly, an action that did not take effect, a branch not taken). Name that step by number; quote error text exactly.',
  '  - Whose problem: the test script, the test data, the application, the environment/device, or a manual stop — and how sure the evidence lets you be.',
  '  - Fix: what to change (the step / function / object and what to put there), or the defect to log (title, steps, expected vs actual).',
  '  - Next: rerun, check something, or ask someone.',
  'READING THE FLOW:',
  '  - "… steps a–b not shown: n steps, all passed …" are steps that ran; "[not run]" lines are what the test was going to do next.',
  '  - CONTROL FLOW IS NOT FAILURE: "[IF → false] … — steps a–b skipped" is the test\'s own branching (a branch not taken is stored as FAILED). Never call it a failed step; raise it only when the skipped steps set up what the real failure needed.',
  '  - "[FAILED · continued]" the run went on; "[FAILED · stopped the run]" it ended there. Later steps failing the same way follow from the first failure — explain it once. "Broke down" = treat that step as the cause of the failures after it.',
  '  - Other iterations that PASSED this step with different data, or earlier calls of the same function that passed, point at this iteration\'s data or state — not at the steps or the function.',
  '  - A step number like 4.2 is step 2 inside the function called at step 4; a function call is not an iteration (ITR-n is the test case run again with other data).',
  '  - Warnings from passed steps are clues, not proof. Do not assert a cause the evidence does not support; say what to check instead.',
].join('\n');

/** The card ends at the first line that is only this — no hidden markers: a terminal shows HTML
 *  comments as text, and the model copied them into its answer. */
export const CARD_END = '---';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-13T22:16:59.43+05:30" → "13 Oct 2026, 10:16 PM", in the time the run recorded (a UTC
 *  "…Z" time is shown in IST, the deployment's zone). Anything else is shown as given. */
export function readableTime(iso: string | undefined): string | undefined {
  if (!iso) return iso;
  let d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const zone = /([+-])(\d{2}):?(\d{2})$/.exec(iso);
  const offsetMin = zone ? (zone[1] === '-' ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3])) : 330;
  d = new Date(d.getTime() + offsetMin * 60_000);
  const h = d.getUTCHours();
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** The analysis card's wording per kind — the same headings as the in-app assistant's card. */
const WORDS = {
  testcase: { eyebrow: 'Test case failure analysis', unit: 'iteration', why: 'Why it failed', failed: 'Iterations failed', each: 'Each failed iteration' },
  suite: { eyebrow: 'Suite failure analysis', unit: 'test case', why: 'Why the suite failed', failed: 'Test cases failed', each: 'Each failed test case' },
  plan: { eyebrow: 'Execution plan failure analysis', unit: 'test case', why: 'Why the execution plan failed', failed: 'Test cases failed', each: 'Each failed test case' },
} as const;

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/**
 * The analysis card, in the in-app card's shape (ai-assistant `report_markdown`): title, meta,
 * counts; "Why … failed" (`# | Root cause | Test cases`, or `Iterations failed` for a test case);
 * "Failed test cases" (`TC ID | Version | Test case name | Iteration | Report Step No. | Test case
 * step | Failure category`) or "Failed iterations"; passed; each failed iteration. Then, outside the
 * card, the evidence and what the model should add (Why / Fix per cause).
 */
export function renderExecution(ctx: ExecutionFailureContext): string {
  const e = ctx.execution;
  const type = e.type.toUpperCase();
  const kind: keyof typeof WORDS = ctx.input.code?.startsWith('TC-') || type === 'TESTCASE'
    ? 'testcase' : type === 'EXECUTIONPLAN' ? 'plan' : 'suite';
  const w = WORDS[kind];
  const c = ctx.counts;
  const iterations = ctx.testcases.flatMap((t) => t.failedIterations);

  const title = kind === 'testcase'
    ? [iterations[0]?.testcaseCode ?? ctx.input.code ?? e.executionTypeCode, iterations[0]?.testcaseName ?? e.executionTypeName].filter(Boolean).join(' — ')
    : e.executionTypeName ?? e.executionTypeCode ?? e.code ?? `execution ${e.id}`;
  const meta = [e.code, e.environment, readableTime(e.endedAt ?? e.startedAt)].filter(Boolean).join(' · ');
  const ran = kind === 'testcase' ? c.runs : c.testcases;
  const passed = kind === 'testcase' ? c.runs - c.failedRuns : c.passedTestcases;
  const failed = kind === 'testcase' ? c.failedRuns : c.failedTestcases;
  const reasons = ctx.groups.length ? `, for ${plural(ctx.groups.length, 'reason')}` : '';

  const card: string[] = [
    `**${w.eyebrow}: ${title || `execution ${e.id}`}**`,
    ...(meta ? [meta] : []),
    `${plural(ran, w.unit)} · ${passed} passed · ${failed} failed${reasons}.`,
  ];
  if (e.exception) card.push('', `Execution exception: \`${truncate(e.exception, 300).replace(/`/g, "'")}\``);

  if (ctx.groups.length) {
    // Why it failed — one row per cause. The root cause is the category and the failed step's error.
    card.push('', `**${w.why}**`, '');
    if (kind === 'testcase') {
      card.push(`| # | Root cause | ${w.failed} |`, '|---|---|---|');
      for (const g of ctx.groups) card.push(`| ${g.id} | ${td(rootCause(g.category, g.cause), 260)} | ${td(g.iterations.join(', '), 300)} |`);
    } else {
      card.push('| # | Root cause | Test cases |', '|---|---|---|');
      for (const g of ctx.groups) card.push(`| ${g.id} | ${td(rootCause(g.category, g.cause), 260)} | ${g.testcases.length} |`);
    }

    // Every failed iteration, with the report's step number AND the test case's own step.
    if (kind === 'testcase') {
      card.push('', '**Failed iterations**', '', '| Iteration | Report Step No. | Test case step | Failure category |', '|---|---|---|---|');
      for (const it of iterations) {
        card.push(`| ${td(it.iteration ?? it.label)} | ${td(it.focus?.reportStep)} | ${td(it.focus?.trail)} | ${td(it.category)} |`);
      }
    } else {
      card.push('', '**Failed test cases**', '',
        '| TC ID | Version | Test case name | Iteration | Report Step No. | Test case step | Failure category |',
        '|---|---|---|---|---|---|---|');
      for (const it of iterations) {
        card.push(`| ${td(it.testcaseCode ?? it.label)} | ${td(it.versionName)} | ${td(it.testcaseName, 80)} | ${td(it.iteration)} | `
          + `${td(it.focus?.reportStep)} | ${td(it.focus?.trail)} | ${td(it.category)} |`);
      }
    }
  } else {
    card.push('', `No ${w.unit} failed.`);
  }

  if (kind !== 'testcase') {
    card.push('', ctx.passed?.length ? `Passed: ${ctx.passed.join(', ')}.` : `No ${w.unit} passed.`);
  }
  for (const n of ctx.notes) card.push('', n);

  if (iterations.length) {
    card.push('', `**${w.each}**`);
    for (const it of iterations) card.push(...iterationCard(it));
  }

  const out = [...card, '', CARD_END];

  // The answer's structure, one block per cause: code writes the facts (where, the exact error),
  // the model fills only the "…" — as the in-app card's Why / Fix slots are filled.
  if (ctx.groups.length) {
    const byRun = new Map(iterations.map((it) => [it.runId, it]));
    out.push('', 'ANSWER — fill in every "…" below and keep this structure exactly (labels, order, one block per cause):');
    for (const g of ctx.groups) {
      const rep = byRun.get(g.representativeRunId);
      const who = [...new Set(g.testcases)].join(', ');
      const n = g.iterations.length;
      out.push(
        '',
        `**Cause #${g.id} — ${g.category ?? 'Unrecognised failure'}** (${who}${n > 1 ? `; ${n} iterations` : ''})`,
        `- **Where it broke:** ${rep ? failedAt(rep) : '…'}`,
        `- **What went wrong:** ${rep && errorOf(rep) ? `\`${truncate(errorOf(rep)!, 300).replace(/`/g, "'")}\`` : '…'}`,
        '- **Why:** …',
        '- **Whose problem:** … (test script / test data / application / environment / manual stop) — how sure',
        '- **Fix:** …',
        '- **Next:** …',
      );
    }
  }
  if (e.reportUrl) out.push('', `Report: ${e.reportUrl}`);
  // Full evidence for ONE iteration per cause — its representative (the in-app analysis does the
  // same): every other iteration of that cause failed the same way and is already a row above.
  const byRunId = new Map(iterations.map((it) => [it.runId, it]));
  const reps = ctx.groups.map((g) => byRunId.get(g.representativeRunId)).filter((x): x is FailureIteration => !!x);

  if (reps.length) {
    out.push('', '## Evidence — one representative per cause (for writing Why / Fix; do not paste)');
    let flowChars = 0;
    for (const it of reps) {
      const g = ctx.groups.find((x) => x.representativeRunId === it.runId)!;
      const others = g.iterations.filter((l) => l !== it.label);
      const tight = flowChars > FLOW_BUDGET;
      out.push('', iterationEvidence(it, tight));
      flowChars += flowText(it, tight).join('\n').length;
      if (others.length) out.push(`- _Same cause, not repeated: ${truncate(others.join(', '), 300)}_`);
      // Defects logged against ANY iteration of this cause — often not on the representative.
      const linked = g.iterations.flatMap((label) => {
        const ofIt = iterations.find((x) => x.label === label);
        const ids = [...new Set((ofIt?.failedSteps ?? []).flatMap((s) => (Array.isArray(s.defectIds) ? s.defectIds : [])).filter(Boolean).map(String))];
        return ids.map((id) => `${id} (${ofIt?.iteration ?? label})`);
      });
      if (linked.length) out.push(`- **Linked defects (this cause):** ${[...new Set(linked)].join(', ')}`);
    }
  }
  out.push('', '---', TESTER_GUIDE);
  return out.join('\n');
}

/** "Element not found — Step 4.2 "Click Login": No such element found." */
function rootCause(category: string | undefined, cause: string): string {
  return category && category !== 'Unrecognised failure' ? `${category} — ${cause}` : cause;
}

/** The picked screenshots, fetched; any that cannot be fetched are left out (their links stay in
 *  the text). */
export async function failureImages(
  ctx: ExecutionFailureContext,
  fetchImage: (url: string, maxBytes: number) => Promise<{ data: string; mimeType: string } | null>,
): Promise<FailureReport['images']> {
  const fetched = await Promise.all(pickGroupScreenshots(ctx).map(async (p) => {
    const img = await fetchImage(p.url, MAX_INLINE_IMAGE_BYTES);
    return img ? { caption: p.caption, ...img } : null;
  }));
  return fetched.filter((i): i is NonNullable<typeof i> => i !== null);
}
