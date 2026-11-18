/**
 * Whole-execution failure analysis for SimplifyQA (`failure_analysis`). Reads exactly ONE
 * execution — the named one, or the latest standalone (TC) / parent (SU, PL) execution of a code —
 * analyses every FAILED run (= iteration), groups iterations by cause, and builds the FLOW for each
 * cause's representative. The pure rules live in stepRules.ts / flow.ts / failureCategory.ts; this
 * module is the I/O around them. It does not assert a root cause.
 */

import type { QaHttp } from '../http.js';
import { notDeleted, pickArray, str } from './mapper.js';
import { mapLimit } from './mapLimit.js';
import {
  causeSignature, currentRuns, EXECUTION_TYPE_BY_KIND, failureState, groupBy, iterationLabel, lastTouchedStep,
  numberSteps, parseEntityCode, realFailures, reportStepLabel, runKey, runLabel,
} from './stepRules.js';
import { apiBrief, buildFlow, functionCallsLine, notRunLines, stepData } from './flow.js';
import {
  createHistoryCache, executionInfo, FAILED_SEARCH_LIMIT, REVIEW_LOG_LINES, failingSinceOf, lastPassedOf, PASSED_SEARCH_LIMIT, passedRunFor,
  pickComparisonRow, type HistoryCache, type StepRowsCache, type HistoryExecution, type StepComparison, type TestcaseHistory,
} from './failureHistory.js';
import { maskDeep, maskWith, protectedOf, type Mask } from './failureReport.js';
import { normaliseImageUrl } from './failureImages.js';
import { categoryOf, cleanLogLines, extractCause, isNoiseLine, trimTrace } from './failureCategory.js';
import type {
  ExecutionFailureContext, ExecutionFailureInput, FailureArtifact, FailureFlow, FailureGroup, FailureIteration,
  FailureStep, FailureTestcaseEntry,
} from './failureTypes.js';

/** Log lines kept per failed step by default — the tail nearest the failure (ai-assistant FAILURE_LOG_TAIL). */
export const FAILURE_LOG_TAIL = 30;
/** Longest test case description kept (after markup is stripped). */
export const MAX_DESCRIPTION_CHARS = 500;

/** Plain text of a description that may be HTML; non-strings and empty results give undefined. */
function cleanDescription(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > MAX_DESCRIPTION_CHARS ? `${t.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : t;
}
/** Distinct error lines kept per failed step. */
const MAX_ERROR_LINES = 5;
/** Failed iterations analysed per analysis (the assistant's MAX_RUNS); the rest are counted only. */
const MAX_FAILURE_RUNS = 300;

/** Notes that say the same thing for every execution — shown once per analysis, without an execution ref. */
export const NOTE_RUN_LEVEL =
  'Some iterations failed with no failed step (manual verdict or a stop) — their focus is the last step that ran, and the cause is the run-level exception.';
export const NOTE_SCREENSHOT_URLS = 'Screenshot URLs are SQA artifact paths; they need the SQA bearer token to download.';
export const NOTE_FULL_LOGS = 'Full logs are kept for a limited number of representative iterations; the others keep their error lines and log count.';
export const GENERIC_NOTES: ReadonlySet<string> = new Set([NOTE_RUN_LEVEL, NOTE_SCREENSHOT_URLS, NOTE_FULL_LOGS]);

/** A Mask from a set of protected values. */
function maskOf(values: Iterable<string>): Mask {
  const mv = maskWith(values);
  return (x) => mv(x) ?? x;
}

/**
 * One raw step-result row with its free-text fields masked (expected / actual / exception, logs,
 * API data, unprotected test data values) — BEFORE anything is extracted, cut or truncated, so a
 * protected value never shows even in part. Ids, urls and the protected entries themselves are left
 * alone (protected entries are always shown as *** where they are rendered).
 */
function maskRow(r: any, m: Mask): any {
  if (!r || typeof r !== 'object') return r;
  const out = { ...r };
  for (const k of ['expectedResult', 'actualResult', 'exception']) if (typeof out[k] === 'string') out[k] = m(out[k]);
  const logs = r.executionLogData?.executionLogs;
  if (Array.isArray(logs)) {
    out.executionLogData = { ...r.executionLogData, executionLogs: logs.map((l: unknown) => (typeof l === 'string' ? m(l) : l)) };
  }
  if (r.apiData) out.apiData = maskDeep(r.apiData, m);
  if (Array.isArray(r.testdata)) {
    out.testdata = r.testdata.map((d: any) =>
      (d && typeof d === 'object' && d.protected !== true && typeof d.value === 'string' ? { ...d, value: m(d.value) } : d));
  }
  return out;
}
/** Step-result reads in flight at once. */
const FAILURE_CONCURRENCY = 5;
/** Cause groups whose representative keeps full logs — the output goes into the client's context. */
const MAX_DETAILED_GROUPS = 5;

const FAILURE_LOG_RE = /(\bERROR\b|exception|validation failed|\bfailed\b|no such element|timeout|not found|assert|unable to)/i;

/** Control-flow bookkeeping rows SQA logs with an empty description — not real steps. */
const FAILURE_NOISE_STEP_TYPES = new Set([
  'LOOP_ITERATION_START', 'LOOP_ITERATION_END',
  'FUNCTION_START', 'FUNCTION_END',
  'FUNCTION_ITERATION_START', 'FUNCTION_ITERATION_END',
  'FOR_START', 'FOR_END', 'WHILE_START', 'WHILE_END',
  'ITERATOR_START', 'ITERATOR_END', 'DO',
]);

type StepOptions = { includeLogs: boolean; maxLogLines: number; includeScreenshots: boolean };

/** Image type from the file's magic bytes — SQA may serve screenshots as application/octet-stream. */
function imageMimeType(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/** Drop the SQA log timestamp/level prefix so repeated retries collapse to one message. */
function normalizeLogMessage(line: string): string {
  return line
    .replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+\s*-\s*(INFO|ERROR|WARN|DEBUG)\s*:\s*/i, '')
    .trim();
}

/** One line a reader can act on: the failed step and its error, or the run-level reason. */
function failureCauseText(it: FailureIteration): string {
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const f = it.focus;
  if (it.source === 'step' && f) {
    const why = f.cause ?? f.exception ?? f.errorLines[0] ?? f.actual ?? f.status;
    return cut(`Step ${f.reportStep ?? f.displaySeq ?? f.seq} "${f.description}" — ${normalizeLogMessage(String(why))}`, 300);
  }
  const reason = it.exception ?? it.readError ?? 'no reason recorded';
  return cut(`Run-level: ${reason}${f ? ` (last step that ran: ${f.reportStep ?? f.displaySeq ?? f.seq} "${f.description}")` : ''}`, 300);
}

/** The step rows failure detection reads: no control-flow bookkeeping rows, none without a
 *  description — except FUNCTION rows, which name the function a failure sits in. */
function keepStepRows(raw: any[]): any[] {
  return raw.filter((s) => {
    const st = String(s?.stepType ?? '').toUpperCase();
    if (st === 'FUNCTION') return true;
    return !FAILURE_NOISE_STEP_TYPES.has(st) && String(s?.description ?? '').trim().length > 0;
  });
}

function isFailureLogLine(line: string): boolean {
  return FAILURE_LOG_RE.test(line);
}

function expectedFromTestdata(td: Array<Record<string, unknown>>): string | undefined {
  for (const t of td) {
    const name = String(t['paramName'] ?? t['runtimeKey'] ?? '');
    if (/expected/i.test(name)) return String(t['value'] ?? '');
  }
  return undefined;
}

function matchesFirst(logs: string[], patterns: RegExp[]): string | undefined {
  for (const line of logs) {
    for (const re of patterns) {
      const m = re.exec(line);
      if (m) return m[1] ?? '';
    }
  }
  return undefined;
}

function expectedFromLogs(logs: string[]): string | undefined {
  return matchesFirst(logs, [
    /partial text:\s*'([^']*)'/i,
    /expected(?:\s+text|\s+value)?\s*:\s*'([^']*)'/i,
  ]);
}

function actualFromLogs(logs: string[]): string | undefined {
  return matchesFirst(logs, [
    /actual(?:\s+text|\s+value)?\s*:\s*'([^']*)'/i,
  ]);
}

function logField(logs: string[], re: RegExp): string | undefined {
  for (const line of logs) {
    const m = re.exec(line);
    if (m) return (m[1] ?? '').trim();
  }
  return undefined;
}

/** Raw image fields, most preferred first (see normalizeFailureStep). */
const BASELINE_FIELDS = ['copiedBaseLinepath', 'recordedBaseLinePath', 'recordedBaseline'];
const THUMBNAIL_FIELDS = ['recordedThumbnailPath', 'copiedThumbnailpath', 'executedThumbnailPath', 'executedThumbnail'];

/** The non-empty string values of `keys` on `row`, in `keys` order, names matched case-insensitively. */
function fieldsCI(row: any, keys: string[]): string[] {
  if (!row || typeof row !== 'object') return [];
  const byLower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    const lk = k.toLowerCase();
    if (!byLower.has(lk) || (typeof v === 'string' && v.trim())) byLower.set(lk, v);
  }
  return keys
    .map((k) => byLower.get(k.toLowerCase()))
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function absUrl(base: string, value: string): string {
  if (!value) return '';
  return value.startsWith('/') ? `${base}${value}` : value;
}

/** Longest API response body kept for the passed step of a comparison (stored with the analysis). */
export const PASSED_API_BODY_CHARS = 4_000;
/** Assertions kept for the passed step (the review shows 10), and the longest string value in each. */
const PASSED_API_ASSERTIONS = 10, PASSED_ASSERTION_CHARS = 300;

/**
 * The part of an API step the review shows, compact: the response status and body (cut to
 * `PASSED_API_BODY_CHARS`) and the assertions. undefined when there is neither.
 */
export function compactApiData(v: unknown): unknown {
  const a = v as { responseData?: any; assertions?: unknown } | undefined;
  if (!a || typeof a !== 'object') return undefined;
  const res = a.responseData;
  const body = res?.responseBody === undefined || res?.responseBody === null ? undefined
    : (typeof res.responseBody === 'string' ? res.responseBody : JSON.stringify(res.responseBody));
  const response = res && (res.statusCode !== undefined || body)
    ? { ...(res.statusCode !== undefined ? { statusCode: res.statusCode } : {}), ...(body ? { responseBody: body.slice(0, PASSED_API_BODY_CHARS) } : {}) }
    : undefined;
  const assertions = (Array.isArray(a.assertions) ? a.assertions : [])
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .slice(0, PASSED_API_ASSERTIONS)
    .map((c) => Object.fromEntries(Object.entries(c).map(([k, x]) => [k, typeof x === 'string' ? x.slice(0, PASSED_ASSERTION_CHARS) : x])));
  if (!response && !assertions.length) return undefined;
  return { ...(response ? { responseData: response } : {}), ...(assertions.length ? { assertions } : {}) };
}

/** Every match of `re` (group 1) in `logs`, in order. */
function logFields(logs: string[], re: RegExp): string[] {
  const out: string[] = [];
  for (const line of logs) {
    const m = re.exec(line);
    if (m) out.push((m[1] ?? '').trim());
  }
  return out;
}

/** "xpath and Value: //a" / "Attribute Name: Xpath1  Value: //a" → "xpath = //a". */
const locatorPair = (v: string): string => {
  const m = /^(?:Attribute Name:\s*)?(.*?)\s+(?:and\s+)?Value:\s*(.*)$/i.exec(v);
  return m ? `${m[1]!.trim()} = ${m[2]!.trim()}` : v;
};

/** The object locator fields a step-result row may carry: `locators` / `attributes`, on the row or
 *  its object (`objectData` / `object`); the default (`unique`) one first. */
function objectLocators(row: any): string | undefined {
  for (const holder of [row, row?.objectData, row?.object]) {
    if (!holder || typeof holder !== 'object') continue;
    for (const key of ['locators', 'attributes']) {
      const list = (Array.isArray(holder[key]) ? holder[key] : [])
        .filter((l: any) => l && typeof l === 'object' && typeof l.value === 'string' && l.value.trim());
      if (!list.length) continue;
      const sorted = [...list.filter((l: any) => l.unique === true), ...list.filter((l: any) => l.unique !== true)];
      return sorted.map((l: any) => `${String(l.name ?? 'locator')} = ${l.value.trim()}${l.unique === true ? ' (default)' : ''}`).join(', ');
    }
  }
  return undefined;
}

/**
 * The locator a step used: the last "Locator Used" log line (else the value after replacement),
 * the template before replacement when there was one, then the object's locator fields.
 */
export function locatorOf(logs: string[], row: any): string | undefined {
  const used = logFields(logs, /Locator Used\s+LocatorName:\s*(.+?)\s*$/i).pop();
  const after = logFields(logs, /After Replacement\s+(.+?)\s*$/i).pop();
  const before = logFields(logs, /Before Replacement\s+(.+?)\s*$/i).pop();
  const main = used ?? after;
  const parts: string[] = [];
  if (main) parts.push(`${locatorPair(main)}${before ? ` (before replacement: ${locatorPair(before)})` : ''}`);
  const obj = objectLocators(row);
  if (obj) parts.push(`object locators: ${obj}`);
  return parts.length ? parts.join(' · ') : undefined;
}

/** One raw step-result row → the failure-analysis step (cleaned, tailed logs; cause; category). */
export function normalizeFailureStep(s: any, base: string, opts: StepOptions): FailureStep {
  const status = String(s?.status ?? '').toUpperCase();
  const state = failureState(status, s?.stepType);
  const allLogs: string[] = Array.isArray(s?.executionLogData?.executionLogs)
    ? s.executionLogData.executionLogs.map((l: unknown) => String(l))
    : [];
  // Cleaned (stamp shortened, stack frames dropped, traces cut to their message) and TAILED: the
  // lines nearest the failure are the ones that explain it (ai-assistant log_tail).
  const cleaned = allLogs.flatMap(cleanLogLines);
  const logs = opts.includeLogs ? cleaned.slice(-opts.maxLogLines) : [];
  const failedStep = state === 'failed' || state === 'error';
  const errorLines = failedStep
    ? [...new Set(cleaned.filter((l) => isFailureLogLine(l) && !isNoiseLine(l)))].slice(0, MAX_ERROR_LINES)
    : [];
  const evidenceLines = errorLines.length ? errorLines : (state === 'failed' ? cleaned.slice(-3) : []);
  const td: Array<Record<string, unknown>> = Array.isArray(s?.testdata) ? s.testdata : [];
  const expected = str(s, 'expectedResult') ?? expectedFromTestdata(td) ?? expectedFromLogs(allLogs);
  const actual = str(s, 'actualResult') ?? actualFromLogs(allLogs);
  const screenshots: FailureArtifact[] = opts.includeScreenshots && Array.isArray(s?.screenShots)
    ? s.screenShots
        .map((a: any) => ({
          ...(a?.name ? { name: String(a.name) } : {}),
          ...(a?.original_name ? { originalName: String(a.original_name) } : {}),
          url: String(a?.url ?? ''),
          absoluteUrl: absUrl(base, String(a?.url ?? '')),
          ...(typeof a?.size === 'number' ? { size: a.size } : {}),
          ...(a?.fileSize ? { fileSize: String(a.fileSize) } : {}),
          ...(a?.type ? { type: String(a.type) } : {}),
        }))
        .filter((a: { url: string }) => a.url.length > 0)
    : [];
  const objectName = logField(allLogs, /Object Name:\s*(.+?)\s*$/i);
  const actionName = logField(allLogs, /Action Name\s*:\s*(.+?)\s*$/i);
  const locator = locatorOf(allLogs, s);
  const fnName = str(s?.functionData ?? {}, 'functionName', 'functionCode');
  const cause = failedStep ? extractCause(s) : undefined;
  // Baseline / thumbnails: absolute on the SQA host; placeholders ("undefined.png") and off-host
  // values are left out, each with a note (the review shows the note in place of the image).
  // Baseline = EXECUTION time: the run's copy (copiedBaseLinepath — what the report shows and what
  // "Mark as baseline" updates) first, then the recorded path. Thumbnail = RECORDING time: the
  // recorded element crop (recordedThumbnailPath) first, then the run's copy. Names are matched
  // case-insensitively (the API mixes "BaseLine" / "Baseline").
  // The first usable value wins; a note only when none is usable.
  const imageNotes: string[] = [];
  const image = (keys: string[], what: string): string | undefined => {
    let skipped: string | undefined;
    for (const raw of fieldsCI(s, keys)) {
      const r = normaliseImageUrl(base, raw);
      if (r && 'url' in r) return r.url;
      if (r && skipped === undefined) skipped = r.skipped;
    }
    if (skipped !== undefined) imageNotes.push(`${what} skipped: ${skipped}`);
    return undefined;
  };
  const recordedBaseline = image(BASELINE_FIELDS, 'baseline');
  const recordedThumbnail = image(THUMBNAIL_FIELDS, 'element thumbnail');
  // The failed step's last lines, kept for the review even where `logs` is later cleared.
  const logTail = opts.includeLogs && failedStep ? cleaned.slice(-REVIEW_LOG_LINES) : [];
  return {
    seq: typeof s?.seq === 'number' ? s.seq : 0,
    ...(typeof s?.reportSeq === 'number' || typeof s?.reportSeq === 'string' ? { reportSeq: s.reportSeq } : {}),
    ...(s?.displaySeq !== undefined ? { displaySeq: String(s.displaySeq) } : {}),
    description: String(s?.description ?? ''),
    status,
    state,
    ...(s?.stepType !== undefined ? { stepType: String(s.stepType) } : {}),
    ...(s?.type !== undefined ? { type: String(s.type) } : {}),
    ...(typeof s?.parentId === 'number' ? { parentId: s.parentId } : {}),
    ...(s?.stepId !== undefined ? { stepId: String(s.stepId) } : {}),
    ...(str(s, 'id', '_id') ? { rowId: str(s, 'id', '_id')! } : {}),
    ...(expected !== undefined ? { expected } : {}),
    ...(actual !== undefined ? { actual } : {}),
    ...(str(s, 'exception') ? { exception: trimTrace(str(s, 'exception'))! } : {}),
    errorLines: evidenceLines,
    logs,
    ...(logTail.length ? { logTail } : {}),
    logCount: allLogs.length,
    screenshots,
    ...(recordedBaseline ? { recordedBaseline } : {}),
    ...(recordedThumbnail ? { recordedThumbnail } : {}),
    ...(imageNotes.length ? { imageNotes } : {}),
    ...(td.length ? { testdata: td } : {}),
    ...(s?.networkLogs && (Array.isArray(s.networkLogs) ? s.networkLogs.length > 0 : Object.keys(s.networkLogs).length > 0) ? { networkLogs: s.networkLogs } : {}),
    ...(s?.apiData ? { apiData: s.apiData } : {}),
    ...(s?.defectIds ? { defectIds: s.defectIds } : {}),
    ...(typeof s?.selfHealed === 'boolean' ? { selfHealed: s.selfHealed } : {}),
    ...(objectName ? { objectName } : {}),
    ...(actionName ? { actionName } : {}),
    ...(locator ? { locator } : {}),
    ...(fnName ? { functionName: fnName } : {}),
    ...(cause ? { cause: cause.text } : {}),
    ...(failedStep ? { category: categoryOf(cause?.text, cause?.source) } : {}),
  };
}

/** A test case entry of an execution: test case, its version and its suite entry (`stepId`). */
const entryKey = (r: any): string => JSON.stringify([r?.executionItemId ?? null, r?.versionId ?? null, r?.stepId ?? null]);

/** What the analysis needs from the adapter. */
export type ExecutionFailureDeps = {
  http: QaHttp;
  projectId: number;
  /** SQA base URL, no trailing slash. */
  baseUrl: string;
  fetchExecDoc: (executionId: number, projectId: number) => Promise<any>;
  /** The latest standalone (TC) / parent (SUITE, EXECUTIONPLAN) execution id of an entity. */
  latestExecutionOf: (kind: 'TC' | 'SUITE' | 'EXECUTIONPLAN', id: string) => Promise<string | null>;
};

/**
 * A failure screenshot as base64, for returning inline. Only artifacts on the connected SQA host
 * are fetched (with the SQA bearer token); anything else, anything over `maxBytes`, or anything
 * that is not a PNG/JPEG/GIF/WEBP returns null so the caller falls back to the link.
 */
export async function fetchFailureImage(
  http: QaHttp,
  baseUrl: string,
  absoluteUrl: string,
  maxBytes: number,
): Promise<{ data: string; mimeType: string } | null> {
  if (!baseUrl || !absoluteUrl.startsWith(`${baseUrl}/`) || !http.getBinary) return null;
  try {
    const { data } = await http.getBinary(absoluteUrl.slice(baseUrl.length), 30_000);
    const mimeType = imageMimeType(data);
    if (!mimeType || data.byteLength === 0 || data.byteLength > maxBytes) return null;
    return { data: Buffer.from(data).toString('base64'), mimeType };
  } catch {
    return null;
  }
}

export class ExecutionFailureAnalysis {
  constructor(private readonly deps: ExecutionFailureDeps) {}

  /** Its runs are the parent's current copies (a child execution's runs are history), one per run
   *  key; every FAILED run (= iteration) gets its steps read and a failure focus; iterations are
   *  then grouped by cause, and only each group's representative keeps full logs. */
  async analyse(input: ExecutionFailureInput): Promise<ExecutionFailureContext> {
    const { projectId, baseUrl: base } = this.deps;
    const entity = input.code ? parseEntityCode(input.code) : null;
    if (input.code && !entity) {
      throw new Error(`Unrecognised code "${input.code}". Use TC-123, SU-123 or PL-123 (PL = execution plan).`);
    }
    const execRef = input.executionId?.trim() || undefined;
    if (!execRef && !entity) throw new Error('Provide a code (TC-123 / SU-123 / PL-123) or an executionId.');

    // ---------------------------------------------------------------- 1. the execution
    let execDoc: any;
    if (execRef) {
      execDoc = await this.fetchExecDocByRef(execRef);
      if (!execDoc) throw new Error(`Execution ${execRef} not found in project ${projectId}.`);
      if (entity && entity.kind !== 'TC') {
        const type = String(execDoc.type ?? '').toUpperCase();
        if (type !== EXECUTION_TYPE_BY_KIND[entity.kind] || Number(execDoc.executionTypeId) !== entity.num) {
          const ran = str(execDoc, 'executionTypeCode') ?? `${type} ${execDoc.executionTypeId ?? '?'}`;
          throw new Error(`Execution ${execRef} ran ${ran}, not ${entity.code}.`);
        }
      }
    } else {
      const kind = entity!.kind === 'TC' ? 'TC' : entity!.kind === 'SU' ? 'SUITE' : 'EXECUTIONPLAN';
      const latest = await this.deps.latestExecutionOf(kind, String(entity!.num));
      if (!latest) throw new Error(`${entity!.code} has no execution in project ${projectId}.`);
      execDoc = await this.deps.fetchExecDoc(Number(latest), projectId);
      if (!execDoc) throw new Error(`Execution ${latest} not found in project ${projectId}.`);
    }
    const execNum = Number(execDoc.id);
    const execType = String(execDoc.type ?? '').toUpperCase();

    // ---------------------------------------------------------------- 2. its runs (iterations)
    const rawRuns = await this.deps.http.getJson<any>(`/exec/report/${execNum}/${projectId}`);
    // A re-execution soft-deletes the run row it replaces: only live rows are current results.
    let runs = currentRuns(notDeleted(pickArray(rawRuns, 'data')));
    if (entity?.kind === 'TC' && execRef) {
      runs = runs.filter((r) =>
        Number(r?.executionItemId) === entity.num
        || String(r?.code ?? '').toUpperCase().replace('_', '-') === entity.code);
      if (!runs.length) throw new Error(`${entity.code} has no runs in execution ${execRef}.`);
    }
    const failedRuns = runs.filter((r) => String(r?.status ?? '').toUpperCase() === 'FAILED');
    const maxRuns = Math.max(0, input.maxFailedRuns ?? MAX_FAILURE_RUNS);
    const detailedGroups = Math.max(0, input.detailedGroups ?? MAX_DETAILED_GROUPS);
    const toAnalyse = failedRuns.slice(0, maxRuns);

    // ---------------------------------------------------------------- 3. each failed iteration
    const opts: StepOptions = {
      includeLogs: input.includeLogs !== false,
      maxLogLines: Math.max(10, Math.min(input.maxLogLines ?? FAILURE_LOG_TAIL, 2000)),
      includeScreenshots: input.includeScreenshots !== false,
    };
    const analysed = await mapLimit(toAnalyse, FAILURE_CONCURRENCY, async (run) => ({
      run,
      it: await this.analyseFailedIteration(execNum, run, base, opts),
    }));
    // A run that failed with no reason of its own takes the EXECUTION's: a manual stop or a dead
    // container is recorded once, on the execution ("…manually terminated by …"), not on each run.
    const execException = trimTrace(str(execDoc, 'exception'));
    if (execException) {
      for (const { it } of analysed) {
        if (it.source === 'run_level' && !it.exception) {
          it.exception = maskOf(it.protectedValues ?? [])(execException);
          it.category = categoryOf(execException);
        }
      }
    }

    // ---------------------------------------------------------------- 4. group by cause
    const grouped = groupBy(analysed, (a) => causeSignature(a.it.focus, a.it.source, a.it.exception));
    const representatives = new Set<FailureIteration>();
    const groups = grouped.map((g, i): FailureGroup => {
      const id = i + 1;
      for (const a of g.items) a.it.group = id;
      // Most evidence wins: a screenshot on the focus step, then logs; the newest on a tie.
      const evidence = (it: FailureIteration) => (it.focus?.screenshots.length ? 2 : 0) + (it.focus?.logCount ? 1 : 0);
      const rep = g.items.reduce((best, a) => (evidence(a.it) > evidence(best.it) ? a : best), g.items[0]!);
      if (id <= detailedGroups) representatives.add(rep.it);
      return {
        id,
        cause: failureCauseText(rep.it),
        kind: rep.it.source === 'step' ? 'step' : 'run_level',
        ...(rep.it.category ? { category: rep.it.category } : {}),
        size: g.items.length,
        testcases: [...new Set(g.items.map((a) => String(a.run?.code ?? a.run?.executionItemId ?? '')))].filter(Boolean),
        iterations: g.items.map((a) => a.it.label),
        representative: rep.it.label,
        representativeRunId: rep.it.runId,
      };
    });
    // Full logs only where they explain a group; everyone else keeps the error lines + logCount.
    for (const { it } of analysed) {
      if (representatives.has(it)) continue;
      for (const s of new Set([...it.failedSteps, ...(it.focus ? [it.focus] : [])])) s.logs = [];
    }

    // ---------------------------------------------------------------- 5. per test case entry
    const planItems: any[] = Array.isArray(execDoc.executionItems) ? execDoc.executionItems : [];
    const itByRunKey = new Map(analysed.map((a) => [runKey(a.run), a.it]));
    const entries = new Map<string, FailureTestcaseEntry>();
    for (const r of runs) {
      const key = entryKey(r);
      let e = entries.get(key);
      if (!e) {
        const item = planItems.find((p) => p?.id !== undefined && String(p.id) === String(r?.executionItemId));
        e = {
          executionItemId: String(r?.executionItemId ?? ''),
          ...(str(r, 'code') ? { code: str(r, 'code')! } : {}),
          ...(str(r, 'name', 'testcaseName') ? { name: str(r, 'name', 'testcaseName')! } : {}),
          ...(str(r, 'versionId') ? { versionId: str(r, 'versionId')! } : {}),
          ...(str(r, 'stepId') ? { stepId: str(r, 'stepId')! } : {}),
          ...(execType === 'EXECUTIONPLAN' && item?.sourceType ? { source: `${item.sourceType} ${item.sourceId ?? ''}`.trim() } : {}),
          iterations: { total: 0, passed: 0, failed: 0, other: 0 },
          failedIterations: [],
        };
        entries.set(key, e);
      }
      const st = String(r?.status ?? '').toUpperCase();
      e.iterations.total++;
      if (st === 'PASSED') e.iterations.passed++;
      else if (st === 'FAILED') e.iterations.failed++;
      else e.iterations.other++;
      const it = itByRunKey.get(runKey(r));
      if (it) e.failedIterations.push(it);
    }
    const allEntries = [...entries.values()];
    await this.nameEntries(allEntries);
    for (const e of allEntries) {
      for (const it of e.failedIterations) {
        if (e.name) it.testcaseName = e.name;
        if (e.description) it.testcaseDescription = e.description;
        if (e.versionName) it.versionName = e.versionName;
      }
    }
    // ---------------------------------------------------------------- 6. the flow, per cause
    // The whole-test-case context a tester reads, for each representative: the FLOW, what it never
    // reached, function calls and other iterations compared, warnings from passed steps.
    const writtenCache = new Map<string, Promise<any[]>>();
    await mapLimit(analysed.filter((a) => representatives.has(a.it)), FAILURE_CONCURRENCY, async ({ run, it }) => {
      try {
        it.flow = await this.runFlow(execNum, run, it, {
          siblings: runs.filter((r) => entryKey(r) === entryKey(run) && String(r.id) !== String(run.id)),
          analysed: analysed.filter((a) => entryKey(a.run) === entryKey(run) && a.it !== it).map((a) => a.it),
          written: () => {
            const key = `${run.executionItemId}:${run.versionId ?? ''}`;
            if (!writtenCache.has(key)) writtenCache.set(key, this.fetchWrittenSteps(String(run.executionItemId), str(run, 'versionId')));
            return writtenCache.get(key)!;
          },
        });
      } catch { /* the flow is context; the analysis stands without it */ }
    });

    const testcases = allEntries.filter((e) => e.iterations.failed > 0);
    const passedEntries = allEntries.filter((e) => e.iterations.total > 0 && e.iterations.passed === e.iterations.total);
    for (const e of testcases) e.failedIterations.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

    // ---------------------------------------------------------------- notes + header
    const notes: string[] = [];
    if (!runs.length) notes.push('The execution has no runs yet.');
    else if (!failedRuns.length) notes.push(`No failed iterations — all ${runs.length} run(s) are ${[...new Set(runs.map((r) => String(r?.status ?? '?')))].join('/')}.`);
    if (failedRuns.length > toAnalyse.length) {
      // The limit is the analysis's (shared by its executions), not what was left of it here.
      notes.push(`${failedRuns.length - toAnalyse.length} more failed iterations were not analysed (limit ${MAX_FAILURE_RUNS} per analysis).`);
    }
    const unread = analysed.filter((a) => a.it.readError).length;
    if (unread) notes.push(`${unread} failed iteration(s) could not be read; they are counted by their run-level exception.`);
    if (groups.length > detailedGroups) notes.push(NOTE_FULL_LOGS);
    if (analysed.some((a) => a.it.source === 'run_level' && !a.it.readError)) notes.push(NOTE_RUN_LEVEL);
    if (analysed.some((a) => a.it.failedSteps.some((s) => s.screenshots.length))) notes.push(NOTE_SCREENSHOT_URLS);

    const startedAt = str(execDoc, 'startTime', 'createdAt');
    const endedAt = str(execDoc, 'endTime');
    return {
      input: {
        ...(entity ? { code: entity.code } : {}),
        ...(execRef ? { executionId: execRef } : {}),
        resolvedBy: execRef ? 'executionId' : 'latest',
      },
      execution: {
        id: String(execNum),
        ...(str(execDoc, 'code') ? { code: str(execDoc, 'code')! } : {}),
        type: execType,
        status: String(execDoc.status ?? ''),
        ...(str(execDoc, 'executionTypeCode') ? { executionTypeCode: str(execDoc, 'executionTypeCode')! } : {}),
        ...(execDoc.executionTypeId !== undefined && execDoc.executionTypeId !== null ? { executionTypeId: String(execDoc.executionTypeId) } : {}),
        ...(str(execDoc, 'executionTypeName') ? { executionTypeName: str(execDoc, 'executionTypeName')! } : {}),
        ...(str(execDoc, 'environmentType') ? { environment: str(execDoc, 'environmentType')! } : {}),
        ...(typeof execDoc.childExecution === 'boolean' ? { childExecution: execDoc.childExecution } : {}),
        ...(startedAt ? { startedAt } : {}),
        ...(endedAt ? { endedAt } : {}),
        ...(typeof execDoc.executionDuration === 'number' ? { durationMs: execDoc.executionDuration } : {}),
        ...(str(execDoc, 'exception') ? { exception: str(execDoc, 'exception')! } : {}),
        reportUrl: `${base}/user/reports/reports-page?type=${execType}&parentId=${execDoc.executionTypeId ?? ''}&id=${execNum}&projectId=${projectId}`,
      },
      counts: {
        runs: runs.length,
        failedRuns: failedRuns.length,
        analysedRuns: analysed.length,
        testcases: allEntries.length,
        failedTestcases: testcases.length,
        passedTestcases: passedEntries.length,
      },
      ...(passedEntries.length ? { passed: passedEntries.map((e) => e.code ?? e.executionItemId) } : {}),
      groups,
      testcases,
      notes,
    };
  }

  /**
   * The failing step of `it` as it ran in the last PASSED execution of the same test case.
   * null when there is no last pass or no failed step (run-level / no step id); `found:false` when
   * the step is not in the passed run.
   */
  async compareWithLastPass(
    it: FailureIteration, history: TestcaseHistory, executionItemId: string, rowsCache?: StepRowsCache,
  ): Promise<StepComparison | null> {
    const lp = history.lastPassed;
    if (!lp) return null;
    // No failed step (run-level, or no step id): nothing to compare. null, never found:false — that
    // would read as "the step is not in the passed version" (a NEW_CHANGE hint).
    const stepId = it.focus?.stepId;
    if (!stepId || it.source === 'run_level') return null;
    // The passed run of the SAME iteration when there is one (ITR-2 with ITR-2's data), else the first.
    // It may have passed in another execution than the last pass (any suite / plan / standalone).
    const { runId, executionId } = passedRunFor(lp, it.iteration);
    const base: StepComparison = {
      executionId,
      ...(lp.executionCode && executionId === lp.executionId ? { executionCode: lp.executionCode } : {}),
      runId,
      found: false,
    };
    // One read per passed run for the whole analysis: iterations / test cases that last passed in
    // the same run share it. A failed read is not kept, so the next comparison retries.
    const cacheKey = `${executionId}:${runId}`;
    let pending = rowsCache?.get(cacheKey);
    if (!pending) {
      pending = this.fetchStepRows(Number(executionId), runId, Number(executionItemId));
      if (rowsCache) {
        rowsCache.set(cacheKey, pending);
        pending.catch(() => rowsCache.delete(cacheKey));
      }
    }
    const rows = await pending;
    const raw = pickComparisonRow(rows, stepId);
    if (!raw) return base;
    // Masked with every protected value of the passed run AND of the failing iteration.
    const row = maskRow(raw, maskOf([...protectedOf(rows), ...(it.protectedValues ?? [])]));
    const step = normalizeFailureStep(row, this.deps.baseUrl, { includeLogs: true, maxLogLines: REVIEW_LOG_LINES, includeScreenshots: true });
    const value = step.actual ?? step.expected;
    const data = stepData({ testdata: step.testdata });
    const api = apiBrief(step.apiData);
    const screenshots = step.screenshots.filter((a) => a.absoluteUrl);
    const screenshot = screenshots[0];
    const apiData = compactApiData(step.apiData);
    const baseline = {
      ...(step.recordedBaseline ? { baseline: step.recordedBaseline } : {}),
      ...(step.recordedThumbnail ? { thumbnail: step.recordedThumbnail } : {}),
    };
    return {
      ...base,
      found: true,
      status: step.status,
      ...(value ? { value } : {}),
      ...(step.expected !== undefined ? { expected: step.expected } : {}),
      ...(step.actual !== undefined ? { actual: step.actual } : {}),
      ...(data ? { data } : {}),
      ...(api ? { api } : {}),
      ...(apiData ? { apiData } : {}),
      ...(step.locator ? { locator: step.locator } : {}),
      ...(step.logs.length ? { logs: step.logs } : {}),
      ...(screenshot ? { screenshot } : {}),
      ...(screenshots.length ? { screenshots } : {}),
      ...(Object.keys(baseline).length ? { baseline } : {}),
      ...(step.imageNotes?.length ? { imageNotes: step.imageNotes } : {}),
    };
  }

  /**
   * History of each failed test case of `ctx`, searched across EVERY execution of the test case
   * (standalone, any suite, any plan) that ran before `ctx.execution`: `/exec/report/search` on the
   * run rows by `executionItemId` — the newest PASSED runs, then the FAILED runs after that pass
   * (every earlier failure when it never passed, which also tells "never passed" from "first
   * execution"). `cache` is shared by one analysis: one search per test case however many of its
   * executions it failed in, and one read per execution shown. A failed run search makes that test
   * case `unknown` — never first-execution / never-passed.
   */
  async failureHistory(ctx: ExecutionFailureContext, cache: HistoryCache = createHistoryCache([ctx])): Promise<Map<string, TestcaseHistory>> {
    const current = Number(ctx.execution.id);
    // Today's own runs (and their copies in a parent execution) are never history.
    const exclude = new Set(ctx.testcases.flatMap((t) => t.failedIterations.map((it) => it.runId)));
    // Runs that ended once this execution had started are not earlier (today's / concurrent runs).
    const startedAt = ctx.execution.startedAt;
    const bound = { before: current, exclude, ...(startedAt ? { startedAt } : {}) };
    const items = [...new Map(ctx.testcases.map((t) => [String(t.executionItemId), t])).values()];
    const out = new Map<string, TestcaseHistory>();
    await mapLimit(items, FAILURE_CONCURRENCY, async (tc) => {
      const key = String(tc.executionItemId);
      const item = Number(key);
      if (!key || !Number.isFinite(item) || !Number.isFinite(current)) {
        out.set(key, { status: 'unknown' });
        return;
      }
      let lastPassed: TestcaseHistory['lastPassed'];
      try {
        const iteration = tc.failedIterations[0]?.iteration;
        const opts = { ...bound, ...(iteration ? { iteration } : {}) };
        const shared = await this.runsOf(cache, item, 'PASSED', Math.max(cache.before, current));
        lastPassed = lastPassedOf(shared.rows, opts);
        // The shared search reaches the newest analysed execution: later passes can fill it.
        if (!lastPassed && cache.before > current && shared.rows.length >= PASSED_SEARCH_LIMIT) {
          lastPassed = lastPassedOf((await this.runsOf(cache, item, 'PASSED', current)).rows, opts);
        }
      } catch {
        out.set(key, { status: 'unknown' });
        return;
      }
      let failingSince: TestcaseHistory['failingSince'];
      let failingSinceUnavailable = false;
      try {
        // From the NEWEST pass, even when an older same-iteration pass is the one compared.
        const after = lastPassed?.runs?.[0]?.endedAt ?? lastPassed?.endedAt;
        const failed = await this.runsOf(cache, item, 'FAILED', Math.max(cache.before, current));
        failingSince = failingSinceOf(failed.rows, { ...bound, ...(after ? { after } : {}), limit: FAILED_SEARCH_LIMIT });
      } catch {
        // Without a pass, "never passed" and "first execution" cannot be told apart.
        if (!lastPassed) {
          out.set(key, { status: 'unknown' });
          return;
        }
        failingSinceUnavailable = true;
      }
      const h: TestcaseHistory = { status: lastPassed ? 'passed-before' : failingSince ? 'never-passed' : 'first-execution' };
      if (failingSinceUnavailable) h.failingSinceUnavailable = true;
      if (lastPassed) h.lastPassed = lastPassed;
      if (failingSince) h.failingSince = failingSince;
      if (lastPassed?.versionId && tc.versionId && lastPassed.versionId !== tc.versionId) {
        h.editedSincePass = {
          from: lastPassed.versionId, to: String(tc.versionId), ...(tc.versionName ? { toName: tc.versionName } : {}),
        };
      }
      out.set(key, h);
    });

    // Where it passed / started failing: each execution read once per analysis, best-effort.
    const shown: HistoryExecution[] = [...out.values()].flatMap((h) => [
      ...(h.lastPassed ? [h.lastPassed] : []), ...(h.failingSince ? [h.failingSince] : []),
    ]);
    const ids = [...new Set(shown.map((w) => w.executionId))];
    const docs = new Map(await mapLimit(ids, FAILURE_CONCURRENCY, async (id) => [id, await this.executionDoc(cache, id)] as const));
    for (const w of shown) Object.assign(w, executionInfo(docs.get(w.executionId)));
    return out;
  }

  /** One run search per (test case, status, bound) per analysis. */
  private runsOf(cache: HistoryCache, item: number, status: 'PASSED' | 'FAILED', before: number): Promise<{ rows: any[]; total?: number }> {
    const key = JSON.stringify([item, status, before]);
    let p = cache.runs.get(key);
    if (!p) {
      p = this.searchRuns(item, status, before);
      cache.runs.set(key, p);
    }
    return p;
  }

  /** `/exec/report/search` (executionRuns): runs of one test case in any execution before `before`,
   *  newest first. No date comparison is sent — the server's search treats a string value as an
   *  exact match (operators apply to integers / date-typed fields only), so a `gt` on the ISO endTime
   *  silently matched nothing; the "after the last pass" bound is applied in code. */
  private async searchRuns(item: number, status: 'PASSED' | 'FAILED', before: number): Promise<{ rows: any[]; total?: number }> {
    const passed = status === 'PASSED';
    const raw = await this.deps.http.postJson<any>('/exec/report/search', {
      searchFields: [
        { column: 'endTime', sort: 'dsc' },
        { column: 'deleted', value: false },
        { column: 'projectId', value: this.deps.projectId, regEx: false },
        { column: 'executionItemId', value: item, regEx: false },
        { column: 'status', value: status, regEx: false },
        { column: 'executionId', value: before, operator: 'lt' },
      ],
      startIndex: 0,
      limit: passed ? PASSED_SEARCH_LIMIT : FAILED_SEARCH_LIMIT,
    });
    const total = Number(raw?.totalCount ?? raw?.total);
    return { rows: pickArray(raw, 'data', 'content'), ...(Number.isFinite(total) ? { total } : {}) };
  }

  /** An execution doc, read once per analysis; null when it cannot be read. */
  private executionDoc(cache: HistoryCache, id: string): Promise<any> {
    let p = cache.executions.get(id);
    if (!p) {
      p = this.deps.fetchExecDoc(Number(id), this.deps.projectId).catch(() => null);
      cache.executions.set(id, p);
    }
    return p;
  }

  /** Version NAMES for "edited since pass" (`fromName` / `toName`), resolved the way the failure
   *  table names versions (`/tm/tcfnversion/search`); best-effort, ids stay when a lookup fails. */
  async nameHistoryVersions(history: Map<string, TestcaseHistory>): Promise<void> {
    const edits = [...history.values()].map((h) => h.editedSincePass).filter((e): e is NonNullable<typeof e> => !!e);
    const ids = [...new Set(edits.flatMap((e) => [...(e.fromName ? [] : [e.from]), ...(e.toName ? [] : [e.to])]))];
    if (!ids.length) return;
    const versions = await this.searchByIds('/tm/tcfnversion/search', ids, ['id', 'name']).catch(() => [] as any[]);
    const name = new Map(versions.map((v: any) => [String(v.id), str(v, 'name')]));
    for (const e of edits) {
      const from = e.fromName ?? name.get(e.from);
      const to = e.toName ?? name.get(e.to);
      if (from) e.fromName = from;
      if (to) e.toName = to;
    }
  }

  /**
   * One run's whole-test-case context (flow.ts): its FLOW around the failure, the written steps it
   * never reached, how this function call compares with the run's other calls of it, and how the
   * same test case's other iterations did at this step — failed ones from the analysis, and ONE
   * passed iteration read for comparison (its status and data at the same written step).
   */
  private async runFlow(
    execNum: number,
    run: any,
    it: FailureIteration,
    ctx: { siblings: any[]; analysed: FailureIteration[]; written: () => Promise<any[]> },
  ): Promise<FailureFlow> {
    const automated = String(run.type ?? '').toUpperCase() !== 'MANUAL';
    // Read again rather than kept from analyseFailedIteration: holding every failed run's raw rows
    // (full logs) until grouping is done costs far more memory than one read per representative.
    const rawRows = await this.fetchStepRows(execNum, String(run.id), Number(run.executionItemId ?? 0));
    const secrets = new Set([...protectedOf(rawRows), ...(it.protectedValues ?? [])]);
    const m = maskOf(secrets);
    const rows = rawRows.map((r) => maskRow(r, m));
    const focusId = it.focus?.rowId;
    const built = buildFlow(rows, { automated, ...(focusId ? { focusId } : {}) });
    const out: FailureFlow = { lines: built.lines, warnings: built.warnings };
    if (built.breakdown) out.breakdown = built.breakdown;

    // What the test was going to do next — only when the run stopped at this failure (nothing
    // executed after it).
    const focusIdx = focusId ? rows.findIndex((r) => String(r?.id) === String(focusId)) : -1;
    const stopped = focusIdx >= 0 && !rows.slice(focusIdx + 1).some((r) => /^(PASSED|FAILED)$/i.test(String(r?.status ?? '')));
    if (it.source === 'step' && stopped) {
      const notRun = notRunLines(await ctx.written(), built.furthestStepIds).map(m);
      if (notRun.length) out.notRun = notRun;
    }

    // This function call against the run's other calls of the same function.
    if (focusIdx > 0) {
      const label = reportStepLabel(rows[focusIdx], automated) ?? '';
      let call = -1;
      for (let j = focusIdx - 1; j >= 0; j--) {
        const l = reportStepLabel(rows[j], automated) ?? '';
        if (String(rows[j]?.stepType ?? '').toUpperCase() === 'FUNCTION' && l && label.startsWith(`${l}.`)) { call = j; break; }
      }
      const line = call >= 0 ? functionCallsLine(rows, call) : undefined;
      if (line) out.functionCalls = line;
    }

    // The same test case's other iterations at this written step.
    const stepId = it.focus?.stepId;
    const others: string[] = [];
    for (const o of ctx.analysed) {
      const at = o.failedSteps.find((s) => stepId && s.stepId === stepId);
      const data = at ? stepData({ testdata: at.testdata }) : '';
      const api = at ? apiBrief(at.apiData, 100) : '';
      others.push(at
        ? `${o.iteration ?? o.label}: failed at this step too${data ? ` with ${data}` : ''}${api ? ` — ${api}` : ''}`
        : `${o.iteration ?? o.label}: failed elsewhere (${o.focus?.reportStep ? `report step ${o.focus.reportStep}` : o.source})`);
    }
    const passed = ctx.siblings.filter((r) => String(r?.status ?? '').toUpperCase() === 'PASSED');
    if (passed.length && stepId) {
      const p = passed[0]!;
      try {
        const rawP = await this.fetchStepRows(execNum, String(p.id), Number(p.executionItemId ?? 0));
        const pm = maskOf([...secrets, ...protectedOf(rawP)]);
        const found = rawP.find((r) => String(r?.stepId ?? '') === stepId);
        const same = found ? maskRow(found, pm) : undefined;
        const data = same ? stepData(same) : '';
        // What the passing call returned — e.g. it created the record the failing ones then collide with.
        const api = same ? apiBrief(same.apiData) : '';
        others.push(`${iterationLabel(p) ?? p.id}: ${same ? `${String(same.status ?? '').toLowerCase()} at this step${data ? ` with ${data}` : ''}${api ? ` — ${api}` : ''}` : 'passed (did not reach this step)'}`);
      } catch { /* comparison is best-effort */ }
      if (passed.length > 1) others.push(`${passed.length - 1} more iteration(s) passed: ${passed.slice(1, 9).map((r) => iterationLabel(r) ?? r.id).join(', ')}`);
    }
    if (others.length) out.otherIterations = others;
    return out;
  }

  /** Test case names and version names for the failure table — one search each, best-effort (a
   *  failed lookup leaves the column empty, never the analysis). */
  private async nameEntries(entries: FailureTestcaseEntry[]): Promise<void> {
    const tcIds = [...new Set(entries.map((e) => Number(e.executionItemId)).filter((n) => Number.isFinite(n) && n > 0))];
    const versionIds = [...new Set(entries.map((e) => e.versionId).filter((v): v is string => !!v))];
    const [tcs, versions] = await Promise.all([
      this.searchByIds('/tm/testcase/search', tcIds, ['id', 'code', 'name', 'description']).catch(() => [] as any[]),
      this.searchByIds('/tm/tcfnversion/search', versionIds, ['id', 'name']).catch(() => [] as any[]),
    ]);
    const tcName = new Map(tcs.map((t: any) => [String(t.id), str(t, 'name')]));
    const tcDesc = new Map(tcs.map((t: any) => [String(t.id), cleanDescription(t.description)]));
    const vName = new Map(versions.map((v: any) => [String(v.id), str(v, 'name')]));
    for (const e of entries) {
      const n = e.name ?? tcName.get(e.executionItemId);
      if (n) e.name = n;
      const d = tcDesc.get(e.executionItemId);
      if (d) e.description = d;
      const v = e.versionId ? vName.get(e.versionId) : undefined;
      if (v) e.versionName = v;
    }
  }

  /** Rows of a TM search by id, one request; [] for no ids. */
  private async searchByIds(path: string, ids: Array<string | number>, select: string[]): Promise<any[]> {
    if (!ids.length) return [];
    const raw = await this.deps.http.postJson<any>(path, {
      searchFields: [{ column: 'deleted', value: false }, { column: 'projectId', value: this.deps.projectId }, { column: 'id', value: ids }],
      startIndex: 0, limit: ids.length, skipStartIndex: 1, selectFields: select,
    });
    return pickArray(raw, 'data', 'content');
  }

  /** One failed run → its failure focus. A run whose steps cannot be read is still returned (with
   *  `readError`) so it is counted and grouped by its run-level exception, never dropped. */
  private async analyseFailedIteration(execNum: number, run: any, base: string, opts: StepOptions): Promise<FailureIteration> {
    const itr = iterationLabel(run);
    const it: FailureIteration = {
      runId: String(run.id),
      label: runLabel(run) || String(run.id),
      status: String(run.status ?? ''),
      ...(itr ? { iteration: itr } : {}),
      ...(str(run?.platform, 'name') ? { platform: str(run.platform, 'name')! } : {}),
      ...(str(run, 'versionId') ? { versionId: str(run, 'versionId')! } : {}),
      ...(str(run, 'startTime') ? { startedAt: str(run, 'startTime')! } : {}),
      ...(str(run, 'endTime') ? { endedAt: str(run, 'endTime')! } : {}),
      ...(typeof run.executionDuration === 'number' ? { durationMs: run.executionDuration } : {}),
      source: 'none',
      failedSteps: [],
      stepCounts: { total: 0, passed: 0, failed: 0, skipped: 0, notExecuted: 0 },
    };
    try {
      const all = await this.fetchStepRows(execNum, String(run.id), Number(run.executionItemId ?? 0));
      // Every protected value typed anywhere in this run — a password entered at a PASSED step can
      // surface in a later failed step's actual value or logs. Masked before anything is extracted.
      const secrets = protectedOf(all);
      if (secrets.length) it.protectedValues = secrets;
      const m = maskOf(secrets);
      const steps = keepStepRows(all).map((s) => normalizeFailureStep(maskRow(s, m), base, opts));
      numberSteps(steps, String(run.type ?? '').toUpperCase() !== 'MANUAL');
      for (const s of steps) {
        // A FUNCTION heading carries its child's verdict — counting it says one result twice.
        if (s.state === 'info' || s.state === 'unknown' || String(s.stepType ?? '').toUpperCase() === 'FUNCTION') continue;
        it.stepCounts.total++;
        if (s.state === 'passed') it.stepCounts.passed++;
        else if (s.state === 'failed' || s.state === 'error') it.stepCounts.failed++;
        else if (s.state === 'skipped') it.stepCounts.skipped++;
        else if (s.state === 'not_executed') it.stepCounts.notExecuted++;
      }
      const failures = realFailures(steps);
      if (failures.length) {
        it.failedSteps = failures;
        it.focus = failures[0]!;
        it.source = 'step';
      } else {
        const last = lastTouchedStep(steps);
        if (last) it.focus = last;
        it.source = 'run_level';
      }
    } catch (e) {
      it.readError = e instanceof Error ? e.message : String(e);
      it.source = 'run_level';
    } finally {
      const runException = str(run, 'exception');
      if (runException) it.exception = maskOf(it.protectedValues ?? [])(runException);
      it.category = it.source === 'step' && it.focus?.category ? it.focus.category : categoryOf(it.exception);
      if (str(run, 'code')) it.testcaseCode = str(run, 'code')!;
    }
    return it;
  }

  /** Execution doc by numeric id, or by its EX code. */
  private async fetchExecDocByRef(ref: string): Promise<any> {
    const { http, projectId } = this.deps;
    if (/^\d+$/.test(ref)) return this.deps.fetchExecDoc(Number(ref), projectId);
    const raw = await http.postJson<any>('/exec/execution/search', {
      searchFields: [
        { column: 'code', value: ref.toUpperCase(), regEx: false },
        { column: 'projectId', value: projectId, regEx: false },
        { column: 'deleted', value: false },
      ],
      startIndex: 0,
      limit: 1,
    });
    return pickArray(raw, 'data', 'content', 'executions')[0];
  }

  /** Every step-result row of one run, in report order — control-flow and marker rows included
   *  (the FLOW needs them; failure detection uses `keepStepRows`). */
  private async fetchStepRows(executionId: number, executionRunId: string, parentId: number): Promise<any[]> {
    const resp = await this.deps.http.postJson<any>('/reports/execution/getstepResult', {
      executionId, executionRunId, parentId, projectId: this.deps.projectId,
    });
    return Array.isArray(resp?.data) ? notDeleted(resp.data) : [];
  }

  /** The test case's written steps for one version (what it was going to do), or [] when unreadable. */
  private async fetchWrittenSteps(testcaseId: string, versionId: string | undefined): Promise<any[]> {
    const params = new URLSearchParams({ projectId: String(this.deps.projectId), tcfnId: testcaseId, type: 'TC' });
    if (versionId) params.set('versionId', versionId);
    try {
      const raw = await this.deps.http.getJson<any>(`/tm/testcase/steps?${params.toString()}`);
      return notDeleted(pickArray(raw, 'data', 'content', 'steps'));
    } catch {
      return [];
    }
  }
}
