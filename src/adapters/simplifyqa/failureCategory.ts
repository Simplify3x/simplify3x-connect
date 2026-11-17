/**
 * A failed step's failure category — "Element not found", "Assertion failed", … — by fixed rules,
 * never a guess. Ported from ai-assistant `src/analysis/failures.py` (FAMILIES, _RULES, classify,
 * extract_cause) so the MCP and the in-app analysis label a failure the same way.
 */

export type FailureFamily =
  | 'session' | 'authoring' | 'timeout' | 'interaction' | 'locator' | 'assertion' | 'config' | 'manual' | 'unrecognised';

/** family → category label. (The assistant's "who usually owns it" is left to the model, which
 *  says whose problem it is from the evidence.) */
export const FAMILIES: Record<FailureFamily, string> = {
  manual: 'Stopped manually',
  session: 'Browser session died',
  authoring: 'Test definition is invalid',
  timeout: 'Timed out waiting',
  interaction: 'Element found but not usable',
  locator: 'Element not found',
  assertion: 'Assertion failed',
  config: 'Disabled by configuration',
  unrecognised: 'Unrecognised failure',
};

/** (family, priority, needles): the LONGEST matching needle wins; priority only breaks ties. */
const RULES: Array<[FailureFamily, number, string[]]> = [
  ['assertion', 5, [
    'expectedvalue', 'actualvalue', 'expected value', 'actual value', 'actual was', 'assertion',
    'does not match', 'mismatch', 'validation failed', 'verify failed', 'verification failed',
  ]],
  ['session', 4, [
    'invalid session id', 'session not created', 'session deleted', 'unable to connect to',
    'connection refused', 'chrome not reachable', 'unreachable browser', 'target closed',
    'browser has closed', 'no such window', 'session timed out',
  ]],
  ['authoring', 4, [
    'brackets are not matched', 'arguments length does not match', 'method not found',
    'while converting parameters', 'unsupported operation', 'illegal argument', 'number format exception',
    'cannot be cast', 'invalid selector', 'malformed parameter',
  ]],
  ['interaction', 3, [
    'click intercepted', 'not interactable', 'not clickable', 'obscured', 'would receive the click',
    'element is disabled', 'stale element',
  ]],
  ['locator', 2, [
    'no such element', 'unable to locate element', 'element is not displayed', 'no such element found',
    'element not found', 'could not find element', 'element is not visible', 'not present in dom',
  ]],
  ['timeout', 2, ['operation failed after retrying', 'wait timed out', 'expected condition failed', 'timed out', 'timeout']],
  ['config', 1, ['is disabled', 'disabled;', 'not configured', 'not enabled', 'not supported for this']],
];

/** ERROR-level lines, anchored on the log's level field (a WARN line mentioning "error" is not one). */
const ERROR_LINE_RES = [
  /^.*?\s[-–]\s*(?:ERROR|FATAL|SEVERE)\b\s*:\s*(.+)$/i,
  /^\s*\[?(?:ERROR|FATAL|SEVERE)\]?\s*:?\s+(.+)$/i,
];

/** ERROR lines that describe a recovery attempt or a side failure, not the cause. Deliberately
 *  narrow: a pattern here removes a candidate cause outright. The screenshot lines are MCP-side
 *  additions — the agent logs a failed screenshot capture ("executor is null") AFTER the real
 *  failure (a failed comparison), and taking it as the cause grouped runs under the wrong reason. */
const NON_CAUSE = [
  'object recognition is disabled', 'skipping javascript execution', 'attempting javascript',
  'attempting fallback', 'falling back to',
  'executor is null', 'failed to take screenshot', 'unable to take screenshot', 'error while taking screenshot',
  'unable to capture screenshot', 'failed to capture screenshot',
];

/** A log/error line that is never the reason a step failed (see NON_CAUSE). */
export function isNoiseLine(line: string): boolean {
  const low = line.toLowerCase();
  return NON_CAUSE.some((n) => low.includes(n));
}

// ------------------------------------------------------------------------- trimming
// Ported from ai-assistant `_lib/execlib.py` (_EXC_TRACE, _PROVENANCE, clean_log_line): what failed
// is the message; where the JVM / driver happened to be standing is noise and costs tokens.

/** Where an exception's MESSAGE ends and its stack trace begins. */
const EXC_TRACE = /stacktrace|\bat [\w.$]+\(|#\d+ 0x[0-9a-f]+|\\n\s*#\d+|\n\s*at /i;
/** Where a WebDriver message stops saying what failed and starts saying where it was sent. */
const PROVENANCE = /\s*(?:\(Session info:|Command:\s*\[|Build info:|System info:|Driver info:|For documentation on this error)/i;
/** `2026-08-26 13:57:07.081 - INFO  : msg` → `13:57:07 INFO msg`. */
const LOG_STAMP = /^[ \t]*\d{4}-\d{2}-\d{2}[ T](\d{2}:\d{2}:\d{2})(?:[.,]\d+)?[ \t]*(?:-[ \t]*)?(?:(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)\b[ \t]*)?:?[ \t]*/i;
// eslint-disable-next-line no-control-regex
const TERMINAL = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

const TRIM_CHARS = 400;
/** One log line, at most. */
const LOG_LINE_CHARS = 240;

/**
 * A Java trace logged as ONE string carries its line breaks escaped — `…\n\tat com.x(…)\nCaused
 * by: …` with a literal backslash-n — so it slips past every line-based cut. Only an escaped break
 * that is followed by a frame, a `Caused by:` or `… n more` is turned back into a real one: a
 * Windows path such as `C:\new\tmp` must stay as written.
 */
function unescapeTrace(text: string): string {
  return text
    .replace(/(?:\\r)?\\n(?=(?:\\t|\s)*at [\w.$]+\(|\s*Caused by:|(?:\\t|\s)*\.\.\. \d+ more)/g, '\n')
    .replace(/\\t(?=at [\w.$]+\()/g, '\t');
}

/** An exception / error text cut to what failed: the message (before the stack trace and the
 *  driver provenance) plus each `Caused by:` line's first line. */
export function trimTrace(text: string | undefined): string | undefined {
  if (!text) return text;
  const raw = unescapeTrace(text.replace(TERMINAL, ''));
  const lines = raw.split(/\r?\n/);
  let message = lines[0] ?? '';
  const trace = EXC_TRACE.exec(message);
  if (trace) message = message.slice(0, trace.index);
  const prov = PROVENANCE.exec(message);
  if (prov) message = message.slice(0, prov.index);
  const causes = lines
    .filter((l) => /^\s*Caused by:/.test(l))
    .map((l) => l.trim().replace(PROVENANCE, '').slice(0, 200));
  const out = [message.trim(), ...new Set(causes)].filter(Boolean).join(' | ');
  return (out || raw.trim().split(/\r?\n/)[0] || '').slice(0, TRIM_CHARS);
}

/** One log entry as the analysis reads it: stamp shortened, control codes and stack frames dropped. */
export function cleanLogLines(entry: unknown): string[] {
  // Each entry is cut as a whole first, so a trace keeps its message and its `Caused by:` lines
  // together on one line — never its frames.
  const text = unescapeTrace(String(entry ?? '').replace(TERMINAL, ''));
  const out: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) out.push(trimTrace(current.join('\n')) ?? current[0]!);
    current = [];
  };
  for (const l of text.split(/\r?\n/)) {
    if (!l.trim()) continue;
    if (/^\s*at [\w.$]+\(/.test(l) || /^\s*\.\.\. \d+ more/.test(l) || /^\s*Caused by:/.test(l)) {
      if (current.length) current.push(l); // part of the entry above it
      continue;
    }
    flush();
    current = [l.replace(LOG_STAMP, (_m, time: string, level?: string) => `${[time, level?.toUpperCase()].filter(Boolean).join(' ')} `).trimEnd()];
  }
  flush();
  return out.map((l) => (l.length > LOG_LINE_CHARS ? `${l.slice(0, LOG_LINE_CHARS - 1)}…` : l));
}

const MAX_CAUSE_CHARS = 180;

/** A run someone stopped — the in-app suite analysis's `_MANUAL` words (ai-assistant
 *  `_lib/suite/batch.py`), plus the executor's "forcefully stopped". Not a product or test failure. */
const MANUAL_STOP = /\bmanual\w*\b|\bterminated by\b|\bforcefully stopped\b/i;

export function classify(causeText: string | undefined, source?: string): FailureFamily {
  if (source === 'api_assertion') return 'assertion';
  if (!causeText) return 'unrecognised';
  if (MANUAL_STOP.test(causeText)) return 'manual';
  const low = causeText.toLowerCase();
  let best: [number, number, FailureFamily] | undefined;
  for (const [family, priority, needles] of RULES) {
    const hit = Math.max(0, ...needles.filter((n) => low.includes(n)).map((n) => n.length));
    if (hit && (!best || hit > best[0] || (hit === best[0] && priority > best[1]))) best = [hit, priority, family];
  }
  return best ? best[2] : 'unrecognised';
}

function errorMessages(lines: unknown): string[] {
  if (!Array.isArray(lines)) return [];
  const out: string[] = [];
  for (const entry of lines) {
    for (const raw of String(entry).split(/\r?\n/)) {
      for (const rx of ERROR_LINE_RES) {
        const m = rx.exec(raw);
        if (m) { out.push(m[1]!.trim()); break; }
      }
    }
  }
  return out;
}

/** The reason a raw step result failed, and where it was found: a failed API assertion (the only
 *  structured failure data), else the FIRST real ERROR log line, else `exception` / `actualResult`. */
export function extractCause(step: any): { text: string; source: string } | undefined {
  const assertions = step?.apiData?.assertions;
  if (Array.isArray(assertions)) {
    for (const a of assertions) {
      if (!a || typeof a !== 'object' || a.status === undefined || a.status === null) continue;
      const st = a.status;
      const failed = st === false || st === 0 || ['FAILED', 'FAIL', 'FALSE', '0'].includes(String(st).trim().toUpperCase());
      if (failed) {
        const text = `${a.key ?? 'assertion'}: expected ${JSON.stringify(a.expectedValue)} ${a.condition ?? '=='} actual ${JSON.stringify(a.actualValue)}`;
        return { text: text.slice(0, MAX_CAUSE_CHARS), source: 'api_assertion' };
      }
    }
  }
  const errors = errorMessages(step?.executionLogData?.executionLogs);
  const real = errors.filter((e) => !isNoiseLine(e));
  // Every error line is noise: the exception (when there is one) says more than a side failure.
  const exception = typeof step?.exception === 'string' && step.exception.trim() ? step.exception : undefined;
  const chosen = real.length ? real : exception ? [] : errors;
  if (chosen.length) return { text: (trimTrace(chosen[0]) ?? chosen[0]!).slice(0, MAX_CAUSE_CHARS), source: 'execution_log' };
  for (const field of ['exception', 'actualResult']) {
    const v = step?.[field];
    if (typeof v === 'string' && v.trim()) return { text: (trimTrace(v) ?? v).slice(0, MAX_CAUSE_CHARS), source: field };
  }
  return undefined;
}

/** The category label for a cause text (or nothing → "Unrecognised failure"). */
export function categoryOf(causeText: string | undefined, source?: string): string {
  return FAMILIES[classify(causeText, source)];
}
