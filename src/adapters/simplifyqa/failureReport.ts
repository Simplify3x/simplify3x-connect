/**
 * Shared pieces of the failure-analysis evidence: per-iteration evidence blocks (flow, expected /
 * actual, API response, logs, screenshots) and the table / time helpers the analysis card uses.
 * Nothing here asserts a root cause.
 */

import type { FailureIteration, FailureStep } from './failureTypes.js';
import { trimTrace } from './failureCategory.js';

export function truncate(v: unknown, n = 240): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

/** Protected test data is shown as this, everywhere. */
export const MASK = '***';
/** Shorter protected values are not masked inside free text (they would hit ids and counts). */
export const MIN_MASKED_LEN = 3;

/** A function that replaces protected values inside one DATA string (never the card scaffold). */
export type Mask = (s: string) => string;
const noMask: Mask = (s) => s;

/** Values (>= MIN_MASKED_LEN chars) of the protected test data entries of these step-result rows. */
export function protectedOf(rows: unknown[]): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    const tdRows = (r as { testdata?: unknown } | null | undefined)?.testdata;
    for (const d of Array.isArray(tdRows) ? tdRows : []) {
      if (!d || typeof d !== 'object' || (d as Record<string, unknown>)['protected'] !== true) continue;
      const v = (d as Record<string, unknown>)['value'];
      if (v === undefined || v === null) continue;
      const t = String(v);
      if (t.length >= MIN_MASKED_LEN) out.add(t);
    }
  }
  return [...out];
}

/** Replaces every value (longest first) with `***`; undefined stays undefined. */
export function maskWith(values: Iterable<string>): (s: string | undefined) => string | undefined {
  const list = [...new Set(values)].filter((v) => v.length >= MIN_MASKED_LEN).sort((x, y) => y.length - x.length);
  return (s) => {
    if (s === undefined || !list.length) return s;
    let r = s;
    for (const v of list) r = r.split(v).join(MASK);
    return r;
  };
}

/** Every string inside `v` (objects / arrays, recursively) masked; other values unchanged. */
export function maskDeep<T>(v: T, mask: Mask): T {
  if (typeof v === 'string') return mask(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, mask)) as unknown as T;
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, maskDeep(x, mask)])) as T;
  }
  return v;
}

/** Consecutive repeats of one log line collapsed to "line (×n)" — retries log the same error. */
export function collapseRepeats(lines: string[]): string[] {
  const out: string[] = [];
  let n = 0;
  lines.forEach((l, i) => {
    n++;
    if (lines[i + 1] !== l) { out.push(n > 1 ? `${l} (×${n})` : l); n = 0; }
  });
  return out;
}

/** An API step's response and assertions — the status code alone does not say WHY the call failed
 *  (e.g. 500 with "Duplicate Name Error"). `bodyChars` bounds the body; `indent` nests the lines
 *  (the review shows them under a step). */
export function apiLines(apiData: unknown, m: Mask, opts: { bodyChars?: number; indent?: string } = {}): string[] {
  const a = apiData as { responseData?: any; assertions?: unknown } | undefined;
  if (!a || typeof a !== 'object') return [];
  const ind = opts.indent ?? '';
  const out: string[] = [];
  const res = a.responseData;
  if (res && (res.statusCode !== undefined || res.responseBody)) {
    const body = res.responseBody === undefined || res.responseBody === null ? '' : m(String(res.responseBody).replace(/\s+/g, ' '));
    out.push(`${ind}- **API response:** status ${res.statusCode ?? '?'}${body ? ` · body \`${truncate(body, opts.bodyChars ?? 500)}\`` : ''}`);
  }
  const checks = (Array.isArray(a.assertions) ? a.assertions : []).filter((c: any) => c && typeof c === 'object') as any[];
  if (checks.length) {
    out.push(`${ind}- **Assertions:**`);
    for (const c of checks.slice(0, 10)) {
      out.push(`${ind}  - ${m(String(c.key ?? c.path ?? '?'))} ${c.condition ?? ''} · expected "${truncate(m(String(c.expectedValue ?? '')), 120)}" · actual "${truncate(m(String(c.actualValue ?? '')), 120)}" · ${c.status ?? ''}`);
    }
  }
  return out;
}

function stepText(s: FailureStep, index: number, withLogs: boolean, m: Mask): string {
  const where = s.trail ?? (s.reportStep ? `TC step ${s.reportStep}` : `step ${s.seq}`);
  const head = `### ${index + 1}. ${where}${s.reportStep ? ` (report step ${s.reportStep})` : ''} — ${m(s.description)}  \`${s.status}\``;
  const lines: string[] = [head];
  if (s.objectName || s.actionName) {
    lines.push(`- **Object:** ${s.objectName ?? '-'} · **Action:** ${s.actionName ?? '-'}`);
  }
  if (s.locator) lines.push(`- **Locator:** \`${truncate(m(s.locator), 300)}\``);
  if (s.expected !== undefined) lines.push(`- **Expected:** ${truncate(m(s.expected), 400)}`);
  if (s.actual !== undefined) lines.push(`- **Actual:** ${truncate(m(s.actual), 400)}`);
  if (s.exception) lines.push(`- **Exception:** ${truncate(m(s.exception), 600)}`);
  lines.push(...apiLines(s.apiData, m));
  if (s.errorLines.length) {
    lines.push('- **Failure evidence:**');
    for (const e of s.errorLines.slice(0, 8)) lines.push(`  - ${truncate(m(e), 500)}`);
    if (s.errorLines.length > 8) lines.push(`  - … ${s.errorLines.length - 8} more`);
  }
  if (s.testdata?.length) {
    const td = s.testdata
      .map((t) => {
        const name = String(t['paramName'] ?? t['runtimeKey'] ?? 'param');
        const value = t['protected'] ? MASK : m(String(t['value'] ?? ''));
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
  if (s.recordedThumbnail) lines.push(`- **Element thumbnail (recording time):** ${s.recordedThumbnail}`);
  if (withLogs && s.logs.length) {
    const tail = collapseRepeats(s.logs.slice(-12).map((l) => m(l).replace(/\s+$/, '')));
    lines.push(`- **Logs (last ${Math.min(12, s.logs.length)} of ${s.logCount}):**`);
    lines.push('```text');
    lines.push(...tail);
    lines.push('```');
  }
  return lines.join('\n');
}

/** Per-image cap for inline screenshots (a client model pays ~1–1.5k tokens of context per image). */
export const MAX_INLINE_IMAGE_BYTES = 1_000_000;

/** A table cell: no pipes or newlines, "—" when empty. */
export function td(v: unknown, n = 160): string {
  const s = v === undefined || v === null || v === '' ? '—' : truncate(String(v), n);
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** The error shown for an iteration: its step's cause, else the step / run exception. */
const errorOf = (it: FailureIteration): string | undefined =>
  it.focus?.cause ?? it.focus?.exception ?? it.exception ?? it.readError;

/** Lines kept around the failure when the budget is spent. */
const FLOW_TIGHT_LINES = 12;

/** The whole-test-case context of one representative (flow.ts). `tight` keeps only the lines around
 *  the failure. */
function flowText(it: FailureIteration, tight: boolean, m: Mask): string[] {
  const f = it.flow;
  if (!f) return [];
  if (!f.lines.length) return ['#### FLOW', '_No steps were recorded for this run — it never started. The reason is the run / execution exception above._'];
  let lines = f.lines.map(m);
  if (tight) {
    const at = lines.findIndex((l) => l.includes('[FAILED'));
    lines = at < 0 ? lines.slice(-FLOW_TIGHT_LINES) : lines.slice(Math.max(0, at - FLOW_TIGHT_LINES + 3), at + 3);
  }
  const out = ['#### FLOW (report step [status] description | test data)', '```text', ...lines.map((l) => truncate(l, 400)), '```'];
  if (tight) out.push('_(FLOW cut to the failure to keep the result small.)_');
  if (f.breakdown) out.push(`- **Broke down:** ${m(f.breakdown)} — the run broke down at that step.`);
  if (f.notRun?.length) out.push('- **Written steps not run** (what the test was going to do next):', ...f.notRun.map((l) => `  - ${m(l)}`));
  if (f.functionCalls) out.push(`- **Function calls:** ${m(f.functionCalls)}`);
  if (f.otherIterations?.length) out.push('- **Other iterations of this test case:**', ...f.otherIterations.map((l) => `  - ${m(l)}`));
  if (f.warnings.length) out.push('- **Warnings from steps that PASSED** (clues, not proof):', ...f.warnings.map((l) => `  - ${m(l)}`));
  return out;
}

/** Failed steps given full detail per representative; the rest are one line each. */
const DETAILED_STEPS = 3;

/** One failed iteration's full evidence (after the card): flow, expected/actual, logs, screenshots.
 *  Logs only for the step that explains the cause (the focus). `mask` is applied to every DATA string
 *  before it is cut, so a protected value is never half-shown. No per-execution cause id is printed:
 *  the card's pattern heading names the group. */
export function iterationEvidence(it: FailureIteration, tightFlow = false, mask: Mask = noMask): string {
  const m = mask;
  const lines = [`### ${it.testcaseCode ?? it.label}${it.iteration ? ` · ${it.iteration}` : ''}`];
  if (it.testcaseDescription) lines.push(`- **Test case:** ${it.testcaseName ?? it.testcaseCode ?? it.label} — ${m(it.testcaseDescription)}`);
  if (it.exception && (it.exception !== errorOf(it) || !it.focus)) lines.push(`- **Run exception:** ${truncate(m(trimTrace(it.exception) ?? it.exception), 400)}`);
  if (it.readError) lines.push(`- **Steps could not be read:** ${truncate(it.readError, 300)}`);
  lines.push(...flowText(it, tightFlow, m));
  it.failedSteps.slice(0, DETAILED_STEPS).forEach((s, i) => {
    lines.push(stepText(s, i, s === it.focus, m).replace(/^### /, '#### '));
  });
  const rest = it.failedSteps.slice(DETAILED_STEPS);
  if (rest.length) {
    lines.push(`- _${rest.length} more failed step(s): ${truncate(m(rest.map((s) => `${s.reportStep ?? s.seq} ${s.description}`).join('; ')), 400)}_`);
  }
  return lines.join('\n');
}

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
