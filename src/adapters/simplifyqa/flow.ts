/**
 * The steps leading to a failure, small enough for a model to read — so it can reason like a
 * tester over the whole test case flow, not just the failed step. Ported from ai-assistant
 * `src/tools/_lib/flow.py` (with smaller limits: the MCP shows one FLOW per cause inside one
 * tool result, where the in-app analysis sends one FLOW per model call).
 *
 * One line per step: report number, status, description, the test data it used, engine flags —
 * indented under its function. Control flow is shown as what it is (`[IF → false] … — steps
 * 12–18 skipped`, `[LOOP → 3 iterations]`, `[SWITCH] switch to API`), never as a failure. Steps
 * left out become one `… steps a–b not shown: n steps, all passed …` line, so nothing disappears
 * silently. Pure: raw step-result rows in, lines out.
 */

import { cleanLogLines, isNoiseLine } from './failureCategory.js';
import { INFO_STEP_TYPES, reportStepLabel, UNREACHED_STATUSES } from './stepRules.js';

/** A run with this many real steps or fewer is shown whole. */
export const SHOW_ALL = 60;
/** Real steps kept before / after the main failure in a longer run. */
export const WINDOW_BEFORE = 25;
export const WINDOW_AFTER = 5;
/** Step lines per FLOW (the "… not shown …" lines are not counted). */
export const MAX_FLOW_LINES = 90;
/** Other failures each keep this window (before, after) while there is room. */
const OTHER_WINDOW: [number, number] = [1, 1];
/** A test-data value is cut here; parameters shown per step. Long enough that two iterations
 *  sending the same value (a test case name, an id) can be seen to be the same. */
const VALUE_CHARS = 120;
const MAX_PARAMS = 6;
/** Warnings from passed steps. */
export const MAX_WARNINGS = 15;
const WARNING_CHARS = 200;
/** A breakdown: from one failure on, this share of the counted steps failed, at least MIN. */
const BREAKDOWN_SHARE = 0.8;
const BREAKDOWN_MIN = 5;
/** Written steps listed as [not run]. */
export const MAX_NOT_RUN = 8;

const CONTROL = new Set(['IF', 'ELSE_IF', 'ELSE', 'WHILE', 'BREAK', 'CONTINUE']);
const LOOP_STARTS = new Set(['ITERATOR_START', 'FOR_START', 'WHILE_START', 'DO']);

const up = (v: unknown) => String(v ?? '').trim().toUpperCase();
const typeOf = (r: any) => up(r?.stepType);
const statusOf = (r: any) => up(r?.status) || 'UNKNOWN';
/** HTML descriptions → plain text. */
export const plain = (v: unknown) => String(v ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** A step with an outcome of its own (not INFO). */
const real = (r: any) => up(r?.status) !== 'INFO' && !INFO_STEP_TYPES.has(typeOf(r));
/** A real step the run executed (not left NOTEXECUTED / SKIPPED behind it). */
const ran = (r: any) => real(r) && !UNREACHED_STATUSES.has(up(r?.status)) && statusOf(r) !== 'SKIPPED';
/** A step with a verdict of its own — not INFO, not a FUNCTION heading. */
const counted = (r: any) => real(r) && typeOf(r) !== 'FUNCTION';

export type FlowOptions = { automated: boolean; focusId?: unknown };

function labelOf(r: any, automated: boolean): string {
  return reportStepLabel(r ?? {}, automated) ?? '-';
}

function indentOf(label: string): string {
  return '  '.repeat((label.match(/\./g) ?? []).length);
}

/** `name=value; …` — protected values masked, long ones cut. */
export function stepData(r: any): string {
  const items: string[] = [];
  for (const e of (Array.isArray(r?.testdata) ? r.testdata : []).slice(0, MAX_PARAMS)) {
    if (!e || typeof e !== 'object') continue;
    let value = e.protected ? '***' : e.value === null || e.value === undefined ? '' : String(e.value).split(/\s+/).join(' ');
    if (value.length > VALUE_CHARS) value = `${value.slice(0, VALUE_CHARS)}…`;
    const name = String(e.paramName ?? e.runtimeKey ?? '').trim();
    items.push(name ? `${name}=${value}` : value);
  }
  return items.join('; ');
}

/** An API step's response in one line: `API 500: {"message":"Duplicate Name Error",…}`. '' when the
 *  step is not an API call. */
export function apiBrief(apiData: any, bodyChars = 160): string {
  const res = apiData?.responseData;
  if (!res || (res.statusCode === undefined && !res.responseBody)) return '';
  const body = res.responseBody === undefined || res.responseBody === null ? '' : String(res.responseBody).split(/\s+/).join(' ');
  return `API ${res.statusCode ?? '?'}${body ? `: ${body.length > bodyChars ? `${body.slice(0, bodyChars)}…` : body}` : ''}`;
}

function flags(r: any): string {
  let out = '';
  if (r?.selfHealed) out += ' [self-healed]';
  const defects = (Array.isArray(r?.defectIds) ? r.defectIds : []).filter(Boolean);
  if (defects.length) out += ` [defects: ${defects.join(', ')}]`;
  const checks = (Array.isArray(r?.apiData?.assertions) ? r.apiData.assertions : []).filter((a: any) => a && typeof a === 'object');
  if (checks.length) {
    const failed = checks.filter((a: any) => up(a.status) === 'FAILED' || a.status === false).length;
    out += ` [assertions: ${failed} of ${checks.length} failed]`;
  }
  return out;
}

function functionName(r: any): string {
  return String(r?.functionData?.functionName ?? r?.functionData?.functionCode ?? '').trim() || plain(r?.description) || 'function';
}

/** For a false IF: " — steps A–B skipped", from its matching IF_END. */
function skipped(rows: any[], index: number, automated: boolean): string {
  let depth = 0;
  for (const later of rows.slice(index + 1)) {
    const kind = typeOf(later);
    if (kind === 'IF') depth++;
    else if (kind === 'IF_END') {
      if (depth === 0) {
        const [s, e] = [labelOf(rows[index], automated), labelOf(later, automated)];
        if (/^\d+$/.test(s) && /^\d+$/.test(e) && Number(e) > Number(s) + 1) {
          const [a, b] = [Number(s) + 1, Number(e) - 1];
          return ` — ${a === b ? `step ${a}` : `steps ${a}–${b}`} skipped`;
        }
        return ' — its block was skipped';
      }
      depth--;
    }
  }
  return '';
}

function rowLines(rows: any[], i: number, automated: boolean, tags: Map<number, string>): string[] {
  const r = rows[i];
  const kind = typeOf(r);
  const label = labelOf(r, automated);
  const ind = indentOf(label);
  if (LOOP_STARTS.has(kind)) {
    const loop = r?.loop ?? {};
    const n = loop.loopIteration;
    const times = typeof n === 'number' && n >= 0 ? `${n} iteration${n === 1 ? '' : 's'}` : 'loop';
    const cond = String(loop.evaluatedConditionString ?? loop.conditionString ?? '').trim();
    return [`${ind}${label} [LOOP → ${times}]${cond ? ` ${cond}` : ''}`];
  }
  if (kind === 'LOOP_ITERATION_START') {
    const n = r?.loop?.iteratorCount;
    return typeof n === 'number' && n > 0 ? [`  · iteration ${n}`] : [];
  }
  if (CONTROL.has(kind)) {
    const cond = String(r?.conditions?.evaluatedConditionString ?? plain(r?.description) ?? kind).trim() || kind;
    const outcome = ({ PASSED: 'true', FAILED: 'false' } as Record<string, string>)[statusOf(r)] ?? statusOf(r).toLowerCase();
    return [`${ind}${label} [${kind} → ${outcome}] ${cond}${outcome === 'false' && kind === 'IF' ? skipped(rows, i, automated) : ''}`];
  }
  if (kind.startsWith('SWITCH_TO_')) return [`${ind}${label} [SWITCH] switch to ${kind.slice('SWITCH_TO_'.length)}`];
  if (!real(r)) return [];
  if (kind === 'FUNCTION') return [`${ind}${label} [${statusOf(r)}] function "${functionName(r)}"`];
  const data = stepData(r);
  return [`${ind}${label} [${tags.get(i) ?? statusOf(r)}] ${plain(r?.description)}`.trimEnd() + (data ? ` | ${data}` : '') + flags(r)];
}

/** One line for a run of steps left out — nothing when none of them count. */
function gapLine(rows: any[], automated: boolean): string[] {
  const c = rows.filter(counted);
  if (!c.length) return [];
  const [first, last] = [labelOf(c[0], automated), labelOf(c[c.length - 1], automated)];
  const tally = new Map<string, number>();
  for (const r of c) tally.set(statusOf(r).toLowerCase(), (tally.get(statusOf(r).toLowerCase()) ?? 0) + 1);
  const how = tally.size === 1 && tally.has('passed') && c.length > 1 ? 'all passed' : [...tally].map(([s, n]) => `${n} ${s}`).join(', ');
  return [`… ${c.length === 1 ? `step ${first}` : `steps ${first}–${last}`} not shown: ${c.length} step${c.length === 1 ? '' : 's'}, ${how} …`];
}

/** Row `i` plus `before` real steps ahead of it and `after` behind it. */
function around(rows: any[], i: number, before: number, after: number): Set<number> {
  let start = i;
  for (let j = i - 1, n = 0; j >= 0 && n < before; j--) { start = j; n += real(rows[j]) ? 1 : 0; }
  let end = i;
  for (let j = i + 1, n = 0; j < rows.length && n < after; j++) { end = j; n += real(rows[j]) ? 1 : 0; }
  const out = new Set<number>();
  for (let k = start; k <= end; k++) out.add(k);
  return out;
}

/** The failed steps; a FUNCTION heading only when nothing inside it failed. */
function failedIdx(rows: any[]): number[] {
  const failed = rows.map((r, i) => (statusOf(r) === 'FAILED' && real(r) ? i : -1)).filter((i) => i >= 0);
  const work = failed.filter((i) => typeOf(rows[i]) !== 'FUNCTION');
  return work.length ? work : failed;
}

/** The rows that open a block the failure at `index` sits inside: its function calls (by label
 *  prefix) and the IF / loop rows before it whose block has not closed yet. */
function enclosing(rows: any[], index: number, automated: boolean): number[] {
  const label = labelOf(rows[index], automated);
  const out: number[] = [];
  const parts = label.split('.');
  for (let n = 1; n < parts.length; n++) {
    const prefix = parts.slice(0, n).join('.');
    for (let j = index - 1; j >= 0; j--) {
      if (typeOf(rows[j]) === 'FUNCTION' && labelOf(rows[j], automated) === prefix) { out.push(j); break; }
    }
  }
  const open: number[] = [];
  const closes: Record<string, string> = { IF_END: 'IF', FOR_END: 'FOR_START', WHILE_END: 'WHILE_START', ITERATOR_END: 'ITERATOR_START' };
  for (let j = 0; j < index; j++) {
    const kind = typeOf(rows[j]);
    if (kind === 'IF' || LOOP_STARTS.has(kind)) open.push(j);
    else if (closes[kind]) {
      for (let k = open.length - 1; k >= 0; k--) if (typeOf(rows[open[k]!]) === closes[kind]) { open.splice(k); break; }
    } else if (kind === 'WHILE') {
      for (let k = open.length - 1; k >= 0; k--) if (typeOf(rows[open[k]!]) === 'DO') { open.splice(k); break; }
    }
  }
  return [...out, ...open];
}

export type Flow = {
  /** The FLOW lines. */
  lines: string[];
  /** "from step N on, f of t steps failed" — the run broke down at N. */
  breakdown?: string;
  /** ERROR/WARN lines logged by steps that PASSED — clues, not proof. */
  warnings: string[];
  /** The furthest written step the run reached (`seq`), for the [not run] list. */
  furthestStepIds: Set<string>;
};

/** The FLOW of one run (rows in report order). */
export function buildFlow(rows: any[], opts: FlowOptions): Flow {
  const automated = opts.automated;
  const failed = failedIdx(rows);
  const lastRan = rows.reduce((m, r, i) => (ran(r) ? i : m), -1);
  const tags = new Map<number, string>();
  for (const i of failed) tags.set(i, `FAILED · ${i < lastRan ? 'continued' : 'stopped the run'}`);
  const focus = rows.findIndex((r) => opts.focusId !== undefined && String(r?.id) === String(opts.focusId));
  const main = focus >= 0 ? focus : failed.find((i) => tags.get(i)!.endsWith('stopped the run')) ?? failed[0] ?? lastRan;

  const keep = new Set<number>();
  if (rows.filter(real).length <= SHOW_ALL) {
    rows.forEach((_, i) => keep.add(i));
  } else if (main >= 0) {
    for (const i of around(rows, main, WINDOW_BEFORE, WINDOW_AFTER)) keep.add(i);
    for (const i of enclosing(rows, main, automated)) keep.add(i);
    for (const f of failed) {
      if ([...keep].filter((k) => real(rows[k])).length >= MAX_FLOW_LINES) break;
      for (const i of around(rows, f, OTHER_WINDOW[0], OTHER_WINDOW[1])) keep.add(i);
    }
  }

  const lines: string[] = [];
  let gap: any[] = [];
  let shown = 0;
  rows.forEach((r, i) => {
    if (keep.has(i) && shown < MAX_FLOW_LINES) {
      lines.push(...gapLine(gap, automated));
      gap = [];
      const out = rowLines(rows, i, automated, tags);
      shown += out.length;
      lines.push(...out);
    } else {
      gap.push(r);
    }
  });
  lines.push(...gapLine(gap, automated));

  // A breakdown: from one failure on, nearly every counted step failed.
  let breakdown: string | undefined;
  for (const f of failed) {
    const after = rows.slice(f).filter(counted);
    const bad = after.filter((r) => statusOf(r) === 'FAILED').length;
    if (bad >= BREAKDOWN_MIN && bad / after.length >= BREAKDOWN_SHARE) {
      breakdown = `from step ${labelOf(rows[f], automated)} on, ${bad} of ${after.length} steps failed`;
      break;
    }
  }

  const warnings: string[] = [];
  for (const r of rows) {
    if (warnings.length >= MAX_WARNINGS) break;
    if (statusOf(r) !== 'PASSED' || !real(r)) continue;
    for (const l of (Array.isArray(r?.executionLogData?.executionLogs) ? r.executionLogData.executionLogs : []).flatMap(cleanLogLines)) {
      if (!/\b(ERROR|WARN|WARNING)\b/.test(l) || isNoiseLine(l)) continue;
      warnings.push(`step ${labelOf(r, automated)}: ${l.slice(0, WARNING_CHARS)}`);
      if (warnings.length >= MAX_WARNINGS) break;
    }
  }

  const furthestStepIds = new Set<string>(rows.slice(0, lastRan + 1).map((r) => String(r?.stepId ?? '')).filter(Boolean));
  return { lines, ...(breakdown ? { breakdown } : {}), warnings, furthestStepIds };
}

/**
 * The written steps the run never reached — what the test was going to do next. `written` is the
 * test case's own steps (in `seq` order); the run reached the furthest written step whose id one
 * of its rows carries. Report numbers count every written row but FUNCTION_END.
 */
export function notRunLines(written: any[], reachedStepIds: Set<string>): string[] {
  let number = 0;
  const numbered = written.map((w) => {
    if (typeOf(w) !== 'FUNCTION_END') number++;
    return { w, number };
  });
  let furthest = -1;
  numbered.forEach(({ w }, i) => { if (reachedStepIds.has(String(w?.id ?? ''))) furthest = i; });
  if (furthest < 0) return [];
  const rest = numbered.slice(furthest + 1).filter(({ w }) => !INFO_STEP_TYPES.has(typeOf(w)) || typeOf(w) === 'IF');
  const out = rest.slice(0, MAX_NOT_RUN).map(({ w, number: n }) => {
    const kind = typeOf(w);
    const text = kind === 'IF' || kind === 'ELSE_IF' || kind === 'ELSE'
      ? `${kind} ${String(w?.conditions?.ifstring ?? plain(w?.description))}`.trim()
      : kind === 'FUNCTION' ? `function "${functionName(w)}"` : plain(w?.description) || kind.toLowerCase() || 'step';
    return `${n} [not run] ${text}`;
  });
  if (rest.length > MAX_NOT_RUN) out.push(`… ${rest.length - MAX_NOT_RUN} more written steps not run …`);
  return out;
}

/**
 * How this call of a function compares with its other calls in the run: earlier calls that passed
 * point at this call's data or state, not at the function itself.
 */
export function functionCallsLine(rows: any[], callIndex: number): string | undefined {
  const call = rows[callIndex];
  if (!call || typeOf(call) !== 'FUNCTION') return undefined;
  const key = String(call?.functionData?.functionId ?? functionName(call));
  const calls = rows.map((r, i) => ({ r, i }))
    .filter(({ r }) => typeOf(r) === 'FUNCTION' && String(r?.functionData?.functionId ?? functionName(r)) === key);
  if (calls.length < 2) return undefined;
  const nth = calls.findIndex(({ i }) => i === callIndex) + 1;
  const earlier = calls.filter(({ i }) => i < callIndex).map(({ r }) => statusOf(r).toLowerCase());
  const tally = [...new Set(earlier)].map((s) => `${earlier.filter((x) => x === s).length} ${s}`).join(', ');
  return `function "${functionName(call)}": this is call ${nth} of ${calls.length}${earlier.length ? `; earlier calls: ${tally}` : ' (the first call)'}`;
}
