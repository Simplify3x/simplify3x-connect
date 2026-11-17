/**
 * What an EXECUTED SimplifyQA step / run means — the product's rules, ported from the AI assistant
 * (AI/ai-assistant `src/analysis/rootcause.py` + `src/tools/_lib/suite/batch.py`) so both explain a
 * failure the same way. Pure functions, no I/O.
 */

import type { FailureStep, FailureStepState } from './failureTypes.js';

/**
 * A step of one of these types is rendered as INFO by the execution report whatever status it
 * carries — its PASSED/FAILED is a condition's truth value or nothing, never an outcome. Two layers
 * decide INFO (executionStepResult.service.js writes status INFO for some types at insert;
 * reportPayloadV2.service.js re-labels these 25 at render) and neither list contains the other, so
 * `isInfoStep` checks both. Do not narrow this from observation — an earlier assistant draft
 * dropped the SWITCH_TO_* types and reported a FAILED SWITCH_TO_ANDROID as a root cause.
 */
export const INFO_STEP_TYPES = new Set([
  'LOOP_ITERATION_START', 'LOOP_ITERATION_END',
  'IF', 'ELSE_IF', 'ELSE', 'IF_END',
  'BREAK', 'CONTINUE', 'WHILE_START', 'WHILE_END', 'DO', 'WHILE',
  'FOR_START', 'FOR_END',
  'FUNCTION_ITERATION_START', 'FUNCTION_ITERATION_END',
  'SWITCH_TO_API', 'SWITCH_TO_DB', 'SWITCH_TO_WEB', 'SWITCH_TO_MAINFRAME',
  'SWITCH_TO_DESKTOP', 'SWITCH_TO_SAP', 'SWITCH_TO_IOS', 'SWITCH_TO_ANDROID',
  'FUNCTION_END',
]);

/** Created but never reached: IF/ELSE_IF/ELSE are inserted with '', an early stop leaves NOTEXECUTED. */
export const UNREACHED_STATUSES = new Set(['', 'NOTEXECUTED', 'NOT_EXECUTED']);

const up = (v: unknown): string => String(v ?? '').trim().toUpperCase();

export function isInfoStep(status: unknown, stepType: unknown): boolean {
  return up(status) === 'INFO' || INFO_STEP_TYPES.has(up(stepType));
}

/** SQA step status + type → failure-analysis state. INFO wins over any stored status. */
export function failureState(status: unknown, stepType?: unknown): FailureStepState {
  if (isInfoStep(status, stepType)) return 'info';
  const s = up(status);
  if (UNREACHED_STATUSES.has(s)) return 'not_executed';
  switch (s) {
    case 'PASSED': return 'passed';
    case 'FAILED': return 'failed';
    case 'SKIPPED': return 'skipped';
    case 'ERROR': return 'error';
    default: return 'unknown';
  }
}

const isFailedState = (s: FailureStep): boolean => s.state === 'failed' || s.state === 'error';

/**
 * The steps that actually went wrong, in order. A FUNCTION heading row is FAILED because a step
 * inside it failed and comes first in report order, so listing it repeats the same failure — it is
 * kept only when nothing else failed, because then it IS the failure.
 */
export function realFailures(steps: FailureStep[]): FailureStep[] {
  const failed = steps.filter(isFailedState);
  const inner = failed.filter((s) => up(s.stepType) !== 'FUNCTION');
  return inner.length ? inner : failed;
}

/**
 * Where a FAILED run went wrong when no step reports FAILED: testers mark manual runs failed at the
 * run level. The last step that actually ran is the best "where"; the run's exception is the "why".
 */
export function lastTouchedStep(steps: FailureStep[]): FailureStep | undefined {
  const touched = steps.filter((s) => s.state !== 'info' && s.state !== 'not_executed' && s.state !== 'unknown');
  return touched[touched.length - 1] ?? steps[steps.length - 1];
}

// ------------------------------------------------------------------------- step numbers
// Ported from ai-assistant `_lib/execlib.report_number` and `_lib/suite/runfacts.where_trail`.

/**
 * The step number the PDF report prints, or undefined where it prints none: an automated step's
 * `displaySeq` (`19.19.8`), a manual step's `reportSeq`. Blank for iteration markers (`x.0`) and
 * anything not above 0 (FUNCTION_END's "0"). Never `seq` — it restarts at 1 inside a function.
 */
export function reportStepLabel(raw: { displaySeq?: unknown; reportSeq?: unknown }, automated: boolean): string | undefined {
  const v = automated ? raw.displaySeq : raw.reportSeq;
  const text = v === undefined || v === null ? '' : String(v).trim();
  if (!text || text.endsWith('.0')) return undefined;
  const n = Number(text);
  if (Number.isFinite(n) && n <= 0) return undefined;
  return text;
}

/** The function-call rows a step sits inside, outermost first, found by its label: 19.19.8 is
 *  inside the call labelled 19.19, inside 19 — the nearest FUNCTION row before it with that label. */
export function functionPath(steps: FailureStep[], index: number): number[] {
  const parts = String(steps[index]?.reportStep ?? '').split('.');
  const path: number[] = [];
  for (let n = 1; n < parts.length; n++) {
    const prefix = parts.slice(0, n).join('.');
    for (let j = index - 1; j >= 0; j--) {
      if (up(steps[j]!.stepType) === 'FUNCTION' && steps[j]!.reportStep === prefix) { path.push(j); break; }
    }
  }
  return path;
}

/**
 * Where a step sits in the TEST CASE: `{ testcaseStep: "19", trail: "TC step 19 › Login step 3 ›
 * Enter credentials step 8" }` — the test case's own step, then each function it went into and
 * the step inside it. A step outside any function is just "TC step 7".
 */
export function stepWhere(steps: FailureStep[], index: number): { testcaseStep?: string; trail?: string } {
  const label = steps[index]?.reportStep;
  if (!label) return {};
  const path = functionPath(steps, index);
  if (!path.length) return { testcaseStep: label, trail: `TC step ${label}` };
  const top = steps[path[0]!]!.reportStep!;
  const parts = [`TC step ${top}`];
  const chain = [...path.slice(1), index];
  path.forEach((call, i) => {
    const own = String(steps[chain[i]!]!.reportStep ?? '').split('.').pop();
    const fn = steps[call]!;
    parts.push(`${fn.functionName ?? fn.description ?? 'function'} step ${own}`);
  });
  return { testcaseStep: top, trail: parts.join(' › ') };
}

/** Number every step of one run (report label, test case step, trail), in place. */
export function numberSteps(steps: FailureStep[], automated: boolean): void {
  for (const s of steps) {
    const label = reportStepLabel(s, automated);
    if (label) s.reportStep = label;
  }
  steps.forEach((s, i) => Object.assign(s, stepWhere(steps, i)));
}

/**
 * One run's identity: test case, its version, its suite entry (`stepId` — a test case added to a
 * suite twice is two entries), the test-data iteration and the platform. `itr` restarts at 1 per
 * platform, so it is not a key on its own.
 */
export function runKey(run: any): string {
  return JSON.stringify([
    run?.executionItemId ?? null,
    run?.versionId ?? null,
    run?.stepId ?? null,
    run?.itrId ?? run?.itr ?? null,
    run?.platform?.name ?? null,
  ]);
}

/** One row per run key, newest `endTime` first — the execution's current results (older copies of
 *  the same key are re-runs / shard copies, i.e. history). */
export function currentRuns(runs: any[]): any[] {
  const sorted = [...runs].sort((a, b) => String(b?.endTime ?? '').localeCompare(String(a?.endTime ?? '')));
  const seen = new Set<string>();
  const out: any[] = [];
  for (const r of sorted) {
    if (!r?.id) continue;
    const k = runKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** `ITR-2`, or the iteration's own name when it has one that is not just the test case code. */
export function iterationLabel(run: any): string | undefined {
  const name = typeof run?.itrName === 'string' ? run.itrName.trim() : '';
  if (name && name !== String(run?.code ?? '')) return name;
  return run?.itr !== undefined && run?.itr !== null ? `ITR-${run.itr}` : undefined;
}

/** `TC-12 (ITR-2, CHROME)` — a run named so two runs of one test case can be told apart. */
export function runLabel(run: any): string {
  const parts = [iterationLabel(run), run?.platform?.name].filter((p): p is string => !!p);
  const code = String(run?.code ?? '').trim();
  if (!code) return parts.join(', ');
  return parts.length ? `${code} (${parts.join(', ')})` : code;
}

/** Text with quoted values and numbers stripped, lower-cased — two messages that differ only in a
 *  quoted name, a value or a count read the same. */
export function normaliseCause(text: unknown): string {
  return String(text ?? '')
    .replace(/'[^']*'|"[^"]*"|“[^”]*”/g, '…')
    .replace(/\d+/g, '#')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .slice(0, 160);
}

/**
 * What makes two failed iterations one cause: a run-level failure groups by its exception; a step
 * failure by the step's action word plus its normalised error (the exception, else the first
 * failure log line — SQA leaves `exception` empty on most steps and writes the reason to the log).
 */
export function causeSignature(focus: FailureStep | undefined, source: 'step' | 'run_level' | 'none', runException?: string): string {
  if (source !== 'step' || !focus) return JSON.stringify(['run-level', normaliseCause(runException ?? focus?.exception)]);
  const action = (focus.description.split(/\s+/)[0] ?? '').toLowerCase();
  // `cause` is the classifier's choice (noise such as a failed screenshot capture already skipped).
  return JSON.stringify(['step', action, normaliseCause(focus.cause ?? focus.exception ?? focus.errorLines[0] ?? '')]);
}

/** Items with one key are one group; largest group first, then first seen. */
export function groupBy<T>(items: T[], key: (t: T) => string): Array<{ key: string; items: T[] }> {
  const byKey = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = byKey.get(k);
    if (list) list.push(it);
    else byKey.set(k, [it]);
  }
  const order = [...byKey.keys()];
  return [...byKey.entries()]
    .map(([k, list]) => ({ key: k, items: list }))
    .sort((a, b) => b.items.length - a.items.length || order.indexOf(a.key) - order.indexOf(b.key));
}

export type EntityCode = { kind: 'TC' | 'SU' | 'PL'; num: number; code: string };

/** `TC-123` / `SU-123` / `PL-123` (any case, `-` or `_`). PL is an execution plan here. */
export function parseEntityCode(code: string): EntityCode | null {
  const m = /^\s*(TC|SU|PL)[-_ ]?(\d+)\s*$/i.exec(code);
  if (!m) return null;
  const kind = m[1]!.toUpperCase() as EntityCode['kind'];
  return { kind, num: Number(m[2]), code: `${kind}-${m[2]}` };
}

/** Execution type stored on the execution doc for each code prefix. */
export const EXECUTION_TYPE_BY_KIND: Record<EntityCode['kind'], string> = {
  TC: 'TESTCASE',
  SU: 'SUITE',
  PL: 'EXECUTIONPLAN',
};
