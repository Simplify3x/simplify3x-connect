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
import { categoryOf, cleanLogLines, extractCause, isNoiseLine, trimTrace } from './failureCategory.js';
import type {
  ExecutionFailureContext, ExecutionFailureInput, FailureArtifact, FailureFlow, FailureGroup, FailureIteration,
  FailureStep, FailureTestcaseEntry,
} from './failureTypes.js';

/** Log lines kept per failed step by default — the tail nearest the failure (ai-assistant FAILURE_LOG_TAIL). */
export const FAILURE_LOG_TAIL = 30;
/** Distinct error lines kept per failed step. */
const MAX_ERROR_LINES = 5;
/** Failed iterations analysed per execution (the assistant's MAX_RUNS); the rest are counted only. */
const MAX_FAILURE_RUNS = 300;
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

function absUrl(base: string, value: string): string {
  if (!value) return '';
  return value.startsWith('/') ? `${base}${value}` : value;
}

/** One raw step-result row → the failure-analysis step (cleaned, tailed logs; cause; category). */
function normalizeFailureStep(s: any, base: string, opts: StepOptions): FailureStep {
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
  const locator = logField(allLogs, /Locator Used\s+LocatorName:\s*(.+?)\s*$/i);
  const fnName = str(s?.functionData ?? {}, 'functionName', 'functionCode');
  const cause = failedStep ? extractCause(s) : undefined;
  const recordedBaseline = absUrl(base, str(s, 'recordedBaseLinePath') ?? '');
  const recordedThumbnail = absUrl(base, str(s, 'recordedThumbnailPath') ?? '');
  const executedThumbnail = absUrl(base, str(s, 'executedThumbnailPath') ?? '');
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
    logCount: allLogs.length,
    screenshots,
    ...(recordedBaseline ? { recordedBaseline } : {}),
    ...(recordedThumbnail ? { recordedThumbnail } : {}),
    ...(executedThumbnail ? { executedThumbnail } : {}),
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
    const toAnalyse = failedRuns.slice(0, MAX_FAILURE_RUNS);

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
          it.exception = execException;
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
      if (id <= MAX_DETAILED_GROUPS) representatives.add(rep.it);
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
      notes.push(`${failedRuns.length - toAnalyse.length} more failed iterations were not analysed (limit ${MAX_FAILURE_RUNS}).`);
    }
    const unread = analysed.filter((a) => a.it.readError).length;
    if (unread) notes.push(`${unread} failed iteration(s) could not be read; they are grouped by their run-level exception.`);
    if (groups.length > MAX_DETAILED_GROUPS) {
      notes.push(`Full logs are kept for the representatives of the first ${MAX_DETAILED_GROUPS} cause groups only.`);
    }
    if (analysed.some((a) => a.it.source === 'run_level' && !a.it.readError)) {
      notes.push('Some iterations failed with no failed step (manual verdict or a stop) — their focus is the last step that ran, and the cause is the run-level exception.');
    }
    if (analysed.some((a) => a.it.failedSteps.some((s) => s.screenshots.length))) {
      notes.push('Screenshot URLs are SQA artifact paths; they need the SQA bearer token to download.');
    }

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
    const rows = await this.fetchStepRows(execNum, String(run.id), Number(run.executionItemId ?? 0));
    const focusId = it.focus?.rowId;
    const built = buildFlow(rows, { automated, ...(focusId ? { focusId } : {}) });
    const out: FailureFlow = { lines: built.lines, warnings: built.warnings };
    if (built.breakdown) out.breakdown = built.breakdown;

    // What the test was going to do next — only when the run stopped at this failure (nothing
    // executed after it).
    const focusIdx = focusId ? rows.findIndex((r) => String(r?.id) === String(focusId)) : -1;
    const stopped = focusIdx >= 0 && !rows.slice(focusIdx + 1).some((r) => /^(PASSED|FAILED)$/i.test(String(r?.status ?? '')));
    if (it.source === 'step' && stopped) {
      const notRun = notRunLines(await ctx.written(), built.furthestStepIds);
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
        const prows = await this.fetchStepRows(execNum, String(p.id), Number(p.executionItemId ?? 0));
        const same = prows.find((r) => String(r?.stepId ?? '') === stepId);
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
    const { http, projectId } = this.deps;
    const tcIds = [...new Set(entries.map((e) => Number(e.executionItemId)).filter((n) => Number.isFinite(n) && n > 0))];
    const versionIds = [...new Set(entries.map((e) => e.versionId).filter((v): v is string => !!v))];
    const search = async (path: string, column: string, ids: Array<string | number>, select: string[]) => {
      if (!ids.length) return [] as any[];
      const raw = await http.postJson<any>(path, {
        searchFields: [{ column: 'deleted', value: false }, { column: 'projectId', value: projectId }, { column, value: ids }],
        startIndex: 0, limit: ids.length, skipStartIndex: 1, selectFields: select,
      });
      return pickArray(raw, 'data', 'content');
    };
    const [tcs, versions] = await Promise.all([
      search('/tm/testcase/search', 'id', tcIds, ['id', 'code', 'name']).catch(() => []),
      search('/tm/tcfnversion/search', 'id', versionIds, ['id', 'name']).catch(() => []),
    ]);
    const tcName = new Map(tcs.map((t: any) => [String(t.id), str(t, 'name')]));
    const vName = new Map(versions.map((v: any) => [String(v.id), str(v, 'name')]));
    for (const e of entries) {
      const n = e.name ?? tcName.get(e.executionItemId);
      if (n) e.name = n;
      const v = e.versionId ? vName.get(e.versionId) : undefined;
      if (v) e.versionName = v;
    }
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
      ...(str(run, 'exception') ? { exception: str(run, 'exception')! } : {}),
      source: 'none',
      failedSteps: [],
      stepCounts: { total: 0, passed: 0, failed: 0, skipped: 0, notExecuted: 0 },
    };
    try {
      const all = await this.fetchStepRows(execNum, String(run.id), Number(run.executionItemId ?? 0));
      const steps = keepStepRows(all).map((s) => normalizeFailureStep(s, base, opts));
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
