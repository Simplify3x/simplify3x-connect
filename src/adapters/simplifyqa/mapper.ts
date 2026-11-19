import type {
  DefectSummary, Epic, EpicSummary, Feature, FeatureSummary,
  FunctionSummary, ModuleSaved, ModuleSummary, QaFunction, ReleaseSummary, SavedRef, SprintSummary, Step,
  Story, StorySummary, Suite, SuiteSummary, TaskSummary, TcSummary, TcVersion, TestCase, QaObject, Locator,
} from '../../domain/types.js';
import { normalizeParamTokens, stripParamTokens } from '../../paramTokens.js';
import { splitAcceptanceCriteria } from '../../acText.js';
export { splitAcceptanceCriteria };

// ---------------------------------------------------------------------------
// Shared JSON pluckers. SQA endpoints wrap responses inconsistently -- one
// controller returns `{ status, data: [...] }`, another returns the bare
// array, another wraps it under `content` or the entity plural. `pickArray`
// and `str` walk a list of candidate keys and return the first hit, matching
// the tolerance the Java BackendClient built up against real responses.
// ---------------------------------------------------------------------------

export function pickArray(n: any, ...keys: string[]): any[] {
  for (const k of keys) {
    const v = n?.[k];
    if (Array.isArray(v)) return v;
  }
  return Array.isArray(n) ? n : [];
}

/** Hang `totalCount` off a mapped array as a side-band prop — SQA search responses expose it
 *  at the top level as `totalCount` (with `total`/`totalRecords` as tolerant fallbacks). Undefined
 *  when the raw response omits it (callers show `rows.length` as the total in that case). */
export function withTotal<T>(rows: T[], raw: any): T[] & { totalCount?: number } {
  const t = raw?.totalCount ?? raw?.total ?? raw?.totalRecords;
  if (typeof t === 'number') (rows as any).totalCount = t;
  return rows as T[] & { totalCount?: number };
}

export function str(n: any, ...keys: string[]): string | undefined {
  if (n == null) return undefined;
  for (const k of keys) {
    const v = n[k];
    if (typeof v === 'string' && v.length) return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

/** Rows a reader may see: soft-deleted ones (`deleted: true`) dropped — the AI assistant's
 *  `deleted ≠ true` rule, for endpoints that return rows without filtering them (reports, steps). */
export function notDeleted<T>(rows: T[]): T[] {
  return rows.filter((r) => (r as { deleted?: unknown } | null)?.deleted !== true);
}

/** Accept a numeric id ("523") or a business code ("TC_523" / "US-897") — SQA REST paths
 *  parseInt the segment, so a raw business key yields NaN → 404. Strips to the numeric run. */
export function numericId(id: string): string {
  if (!id) return '';
  const m = id.match(/(\d+)/);
  return m ? m[1]! : id;
}

/** Map raw `tcfn_version` rows → neutral `TcVersion[]`. Shared between TC (versions inlined on
 *  the `/tm/testcase/getById` doc) and FN (versions come from `/tm/function/version/:id/:pid`).
 *  `currentVersionId` stamps `isCurrent:true` on the matching entry — pass undefined if unknown. */
export function toVersionEntries(rawVersions: any[], currentVersionId?: string): TcVersion[] {
  return (Array.isArray(rawVersions) ? rawVersions : [])
    .map((v) => {
      const vid = str(v, 'id', '_id');
      if (!vid) return null;
      const name = str(v, 'name') ?? vid;
      const entry: TcVersion = { id: vid, name };
      if (typeof v?.updateVersion === 'number') entry.updateVersion = v.updateVersion;
      const rev = str(v, 'reviewApproveStatus'); if (rev) entry.reviewApproveStatus = rev;
      const ex = str(v, 'executionType'); if (ex) entry.executionType = ex;
      if (currentVersionId && vid === currentVersionId) entry.isCurrent = true;
      return entry;
    })
    .filter((v): v is TcVersion => v !== null);
}

/** SQA priority is UPPERCASE on the wire; neutral is lowercase. Unknown → 'medium'. */
export function mapPriority(p: unknown): TestCase['priority'] {
  const s = typeof p === 'string' ? p.toLowerCase() : '';
  return s === 'critical' || s === 'high' || s === 'medium' || s === 'low'
    ? (s as TestCase['priority']) : 'medium';
}

// ---------------------------------------------------------------------------
// Steps. SQA stores step docs in two shapes with mostly-overlapping fields:
//   • the `/tm/testcase/steps` COLLECTION (source of truth today), and
//   • the INLINE `steps.manualSteps` / `steps.automationSteps` array on the TC doc
//     (legacy, drifts against the collection).
// Both use the same field names, so ONE mapper covers both. See adapter.ts
// getTestCase for the read strategy (collection wins; inline is a fallback).
// ---------------------------------------------------------------------------

export const STEP_BLOCK_END_TYPES: ReadonlySet<string> = new Set([
  'ELSE', 'ELSE_IF', 'IF_END', 'FOR_END', 'WHILE', 'WHILE_END', 'ITERATOR_END',
  'LOOP_ITERATION_END', 'FUNCTION_END',
]);

export const STEP_LOOP_START_TYPES: ReadonlySet<string> = new Set([
  'FOR_START', 'WHILE_START', 'ITERATOR_START', 'LOOP_ITERATION_START', 'DO',
]);

// SQA raw `stepType` → neutral Step.stepType + Step.controlFlow.kind. Enumerated from the
// backend's own union (tcfn.service.js:2176 stepTypeMapping + validators). Everything not in
// SIMPLE / CF_KINDS falls through as a plain automation step.
const NEUTRAL_BY_TECH: Record<string, Step['stepType']> = {
  ANDROID: 'android', IOS: 'ios', MAINFRAME: 'mainframe', DESKTOP: 'desktop', SAP: 'sap',
};
const SIMPLE_STEP_KINDS: Record<string, Step['stepType']> = {
  NORMAL_STATEMENT: 'web',
  API: 'api',
  COMPARE: 'compare',
};
const CF_KINDS = new Set([
  'IF', 'ELSE', 'ELSE_IF', 'IF_END',
  'WHILE_START', 'WHILE', 'WHILE_END',
  'DO', 'DO_WHILE',
  'FOR_START', 'FOR_END', 'LOOP',
  'ITERATOR_START', 'ITERATOR_END',
  'LOOP_ITERATION_START', 'LOOP_ITERATION_END',
  'BREAK', 'CONTINUE',
]);
const SWITCH_KINDS = new Set([
  'SWITCH_TO_API', 'SWITCH_TO_DB', 'SWITCH_TO_WEB', 'SWITCH_TO_MAINFRAME',
  'SWITCH_TO_DESKTOP', 'SWITCH_TO_SAP', 'SWITCH_TO_IOS', 'SWITCH_TO_ANDROID',
]);

/** Round-trip whitelist: raw backend fields we preserve verbatim on the neutral Step so save
 *  re-emits control-flow / function / switch / api structure intact. Subset of the backend's
 *  step joi allow-list (testcaseValidator.js:244-306) MINUS fields the mapper always computes
 *  fresh (id, parentId, versionId, seq, actionId, objectId, description, expectedResult,
 *  technologyType, projectId, moduleId, type, deleted, recordedParam, parameterIds,
 *  objectParameterIds). `stepLevelActions` (skip / screenshot / continue-on-failure / skippedReport) and
 *  `browserType` are NOT recomputed from anything, so they must round-trip or every re-save of an existing
 *  step silently resets them. Duplicated (not imported from adapter.ts)
 *  to avoid a circular import — mapper is a leaf module. */
const STEP_ROUND_TRIP_KEYS = [
  'stepLevelActions', 'browserType',
  'sharedFnProjectId', 'apiData', 'lastActiveTab', 'userstoryId',
  'stepType', 'functionId', 'fnVersionId', 'sharedFnProjectName',
  'parameterizedParamIds', 'attachments', 'compareFiles', 'compareFileType',
  'deviceId', 'ignoreObject', 'captureScreenshot', 'screenshotEnabled',
  'conditions', 'skipParamInReport', 'paramLoopduration', 'showGroups',
  'isConditional', 'if', 'else', 'loop', 'isLoop', 'loopType', 'startFor', 'endFor',
  'loopDuration', 'switchToAndroidData', 'switchToIOSData',
  'isDebug', 'manualStepsTopreview', 'isMigrated', 'customFields',
] as const;

function pickRoundTrip(s: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!s || typeof s !== 'object') return out;
  for (const k of STEP_ROUND_TRIP_KEYS) if (s[k] !== undefined) out[k] = s[k];
  return out;
}

/** Squash a step's `recordedParam: { <paramId>: value }` map into a single readable cell
 *  ("packageName=us.zoom, activity=..."). Names would be nicer than ids, but the id→name
 *  resolution requires the project parameter dictionary — deferred; the raw id is unambiguous
 *  and keeps this pure. */
function formatRecordedParam(rp: unknown): string | undefined {
  if (!rp || typeof rp !== 'object') return undefined;
  const entries = Object.entries(rp as Record<string, unknown>).filter(([, v]) => v != null && v !== '');
  if (!entries.length) return undefined;
  return entries.map(([k, v]) => `${k}=${String(v)}`).join(', ');
}

export function fromSqaStep(s: any, fallbackSeq: number): Step {
  const sid = str(s, 'id', '_id', 'stepId');
  const description = s?.description ?? '';
  const expectedResult = s?.expectedResult ?? undefined;
  const actionType = str(s, 'actionId', 'actionType') ?? '';
  const seq = typeof s?.seq === 'number' ? s.seq : fallbackSeq;
  const rawStepType = String(s?.stepType ?? '').toUpperCase();

  // Neutral stepType routing. Manual TCs have executionType:'MANUAL' at the STEP level — that's
  // the only reliable signal for the neutral 'manual' bucket (validators show `executionType`
  // is a per-step string). Otherwise SIMPLE_STEP_KINDS wins, then CF, then FUNCTION, then a
  // safe automation fallback.
  let stepType: Step['stepType'] = 'web';
  if (str(s, 'executionType')?.toUpperCase() === 'MANUAL') stepType = 'manual';
  // DB is action-bound like web and rides NORMAL_STATEMENT; the technologyType is the reliable signal
  // (raw stepType may be NORMAL_STATEMENT). Detect before SIMPLE_STEP_KINDS so it isn't misrouted to web.
  else if (str(s, 'technologyType')?.toUpperCase() === 'DATABASE' || rawStepType === 'DATABASE') stepType = 'database';
  // The same for the other technologies — a saved Android / iOS / Mainframe / Desktop / SAP action step is NORMAL_STATEMENT
  // too, and without this it hydrated as 'web' and a re-save stamped it technologyType WEB.
  else if (rawStepType === 'NORMAL_STATEMENT' && NEUTRAL_BY_TECH[str(s, 'technologyType')?.toUpperCase() ?? '']) {
    stepType = NEUTRAL_BY_TECH[str(s, 'technologyType')!.toUpperCase()]!;
  }
  else if (SIMPLE_STEP_KINDS[rawStepType]) stepType = SIMPLE_STEP_KINDS[rawStepType]!;
  else if (rawStepType === 'FUNCTION') stepType = 'function';
  else if (rawStepType === 'FUNCTION_END') stepType = 'function_end';
  else if (CF_KINDS.has(rawStepType)) stepType = 'control_flow';
  else if (SWITCH_KINDS.has(rawStepType)) stepType = 'switch';

  // Object linkage: SQA stores it as either scalar `objectId` OR nested `object.id`.
  // Preserving the FK is what lets tc_heal / object_update_locators find the shared object.
  let objectId: string | undefined = str(s, 'objectId');
  if (!objectId && s?.object && typeof s.object === 'object') {
    objectId = str(s.object, 'id');
  }
  const objectName = s?.object && typeof s.object === 'object' ? str(s.object, 'name') : undefined;

  // ponytail: preserve backend parameterIds so round-trip save doesn't wipe FK linkages that
  // weren't derived from description ${tokens} (e.g. a "Go to URL" step with parameterIds:[841]
  // even though the description has no token).
  const sourceParameterIds: number[] = Array.isArray(s?.parameterIds)
    ? s.parameterIds.filter((n: unknown): n is number => typeof n === 'number' && Number.isFinite(n))
    : [];
  const sourceObjectParameterIds: number[] = Array.isArray(s?.objectParameterIds)
    ? s.objectParameterIds.filter((n: unknown): n is number => typeof n === 'number' && Number.isFinite(n))
    : [];
  // ponytail: preserve backend recordedParam as-is (id-keyed) so a save that doesn't touch values
  // re-emits them intact. LLM patches via Step.recordedParam (name-keyed) override at save time.
  const sourceRecordedParam: Record<string, string> = {};
  if (s?.recordedParam && typeof s.recordedParam === 'object') {
    for (const [k, v] of Object.entries(s.recordedParam as Record<string, unknown>)) {
      if (typeof v === 'string') sourceRecordedParam[k] = v;
      else if (typeof v === 'number' || typeof v === 'boolean') sourceRecordedParam[k] = String(v);
    }
  }

  // ponytail: preserve every backend field that's on the joi allow-list but that the mapper
  // doesn't recompute. This is what makes IF/FOR/WHILE/FUNCTION/SWITCH/API steps round-trip.
  const sourceRaw = pickRoundTrip(s);

  // Step flags as the neutral model names them, so a reader sees which steps are skipped etc. (only the ones that are on)
  const sla = s?.stepLevelActions && typeof s.stepLevelActions === 'object' ? s.stepLevelActions : {};
  const flags: NonNullable<Step['flags']> = {
    ...(sla.skip === true ? { skip: true } : {}),
    ...(sla.captureScreenshot === true ? { screenshot: true } : {}),
    ...(sla.continueOnFailure === true ? { continueOnFailure: true } : {}),
  };
  const browserType = str(s, 'browserType');
  // The backend's own technology for THIS step is authoritative (a DB step and a web step are both
  // NORMAL_STATEMENT on the wire); fall back to the stepType→tech table for rows that omit it.
  const stepTechnology = (str(s, 'technologyType') ?? TECH_BY_STEPTYPE[stepType] ?? '').toUpperCase();

  const step: Step = {
    n: seq,
    description,
    actionType,
    technologyType: stepTechnology || undefined,
    stepType,
    ...(Object.keys(flags).length ? { flags } : {}),
    ...(browserType ? { browserType } : {}),
    ...(sid ? { sourceId: sid } : {}),
    ...(expectedResult ? { expectedResult } : {}),
    ...(sourceParameterIds.length ? { sourceParameterIds } : {}),
    ...(sourceObjectParameterIds.length ? { sourceObjectParameterIds } : {}),
    ...(Object.keys(sourceRecordedParam).length ? { sourceRecordedParam } : {}),
    ...(Object.keys(sourceRaw).length ? { sourceRaw } : {}),
  };
  // An API step's request + assertions, so a reader sees them and an edit can change them in place.
  if (stepType === 'api' && s?.apiData && typeof s.apiData === 'object' && !Array.isArray(s.apiData)) {
    step.api = JSON.parse(JSON.stringify(s.apiData)) as Record<string, unknown>;
  }
  if (objectId && objectId.toLowerCase() !== 'null') {
    step.objectRef = { id: objectId, ...(objectName ? { name: objectName } : {}) };
    step.sourceObjectId = objectId;
    if (objectName) step.sourceObjectName = objectName;
  }

  // Control-flow: keep the RAW SQA kind on controlFlow.kind so the renderer can label it exactly
  // as the UI does. `conditions.ifstring` is the human-readable expression the SQA UI shows in the
  // condition column — carry it into conditionText. SWITCH steps carry the target technology in the
  // raw kind (SWITCH_TO_API / SWITCH_TO_DB / …): losing it on a draft save silently turns the switch
  // into an empty statement, so the API/DB plugin never activates.
  if (stepType === 'control_flow' || stepType === 'function_end' || stepType === 'switch') {
    const conditionText = str(s?.conditions, 'ifstring');
    step.controlFlow = {
      kind: rawStepType === 'FUNCTION_END' ? 'FUNCTION_END' : rawStepType,
      ...(conditionText ? { conditionText } : {}),
      ...(typeof s?.loopDuration === 'number' ? { maxIterations: s.loopDuration } : {}),
    };
  }

  // FUNCTION step — carry every field the ROUND-TRIP save + a human render need. Backend
  // sends functionId as a number, fnVersionId as a string uuid; the neutral surface is string.
  if (stepType === 'function') {
    const fnId = str(s, 'functionId');
    const fnVersion = str(s, 'fnVersionId');
    const sharedProject = str(s, 'sharedFnProjectId');
    const sharedName = str(s, 'sharedFnProjectName');
    if (fnId) {
      step.functionCall = {
        testCaseId: fnId,
        ...(fnVersion ? { versionId: fnVersion } : {}),
        ...(sharedProject ? { sharedProjectId: sharedProject } : {}),
        ...(sharedName ? { testCaseName: sharedName } : {}),
      };
    }
  }

  // Value column: prefer recordedParam summary (concrete values) → falls through to parameterIds
  // which surface as `${name}` tokens in the description already.
  const recordedSummary = formatRecordedParam(s?.recordedParam);
  if (recordedSummary) step.value = recordedSummary;

  return step;
}

// ---------------------------------------------------------------------------
// Test cases.
// `toTestCase` is the projection off the RAW /tm/testcase/getById doc — it
// reads inline steps as a fallback. `applyCollectionSteps` replaces those with
// the steps-collection view when that fetch succeeds, matching what the SQA UI
// + execution + save paths use today.
// ---------------------------------------------------------------------------

const TC_PRESERVE_KEYS = ['tags', 'customFields', 'mailersList', 'linkedIssues', 'defectId', 'suiteId'] as const;

export function toTestCase(doc: any): TestCase {
  const id = str(doc, 'id', '_id', 'testcaseId');
  const execType = str(doc, 'executionType') ?? '';
  const category: TestCase['category'] =
    execType.toUpperCase() === 'MANUAL' ? 'manual' : 'automated';
  const description = str(doc, 'description');
  const preconditions = str(doc, 'prerequisite', 'preconditions');
  // storyRef + folderOrModule come off SQA as raw ints (userstoryId / moduleId). Project into
  // neutral strings so `tc_automate` (SQA branch) can pre-fill the recording guide.
  const userstoryId = typeof doc?.userstoryId === 'number' && doc.userstoryId > 0
    ? String(doc.userstoryId) : undefined;
  const moduleId = typeof doc?.moduleId === 'number' && doc.moduleId > 0
    ? String(doc.moduleId) : undefined;

  // Inline steps as fallback: prefer manualSteps for manual TCs, else automationSteps.
  const stepsNode = doc?.steps;
  let rawSteps: any[] = [];
  if (stepsNode && typeof stepsNode === 'object') {
    if (Array.isArray(stepsNode?.manualSteps) && stepsNode.manualSteps.length) rawSteps = stepsNode.manualSteps;
    else if (Array.isArray(stepsNode?.automationSteps)) rawSteps = stepsNode.automationSteps;
    else if (Array.isArray(stepsNode)) rawSteps = stepsNode as any[];
  }
  const steps = rawSteps.map((s: any, i: number) => fromSqaStep(s, i + 1));

  // Versions: `/tm/testcase/getById` hangs a `versions[]` array on the doc (tcfn.service.js:1489),
  // one entry per non-deleted tcfn_version. Current-version resolution mirrors the FE:
  // `versionId` / `selectedVersionId` on the doc wins, else the doc's `versionsDetails.id`.
  const currentVersionId =
    str(doc, 'versionId', 'selectedVersionId') ??
    (doc?.versionsDetails && typeof doc.versionsDetails === 'object'
      ? str(doc.versionsDetails, 'id', '_id', 'versionId')
      : undefined);
  const versions = toVersionEntries(Array.isArray(doc?.versions) ? doc.versions : [], currentVersionId);
  const technologyType = str(doc, 'tcType');
  // Raw test-case fields the neutral model has no field for — carried through an edit untouched (see TestCase.sourceTc).
  const sourceTc: Record<string, unknown> = {};
  for (const k of TC_PRESERVE_KEYS) if (doc?.[k] !== undefined && doc[k] !== null) sourceTc[k] = doc[k];

  return {
    ...(id ? { id } : {}),
    title: str(doc, 'name', 'title') ?? '',
    ...(description ? { description } : {}),
    category,
    ...(preconditions ? { preconditions } : {}),
    ...(userstoryId ? { storyRef: userstoryId } : {}),
    ...(moduleId ? { folderOrModule: moduleId } : {}),
    ...(technologyType ? { technologyType } : {}),
    // Retired-by-sync flag. The FULL read must carry it too (the list summary mapper already did):
    // story_sync_testcases reads a test case with getTestCase and skips the already-obsolete ones —
    // without this it re-proposed the same obsolete item on every run.
    ...(typeof doc?.obsolete === 'boolean' ? { obsolete: doc.obsolete as boolean } : {}),
    ...(doc?.executionPlatform && typeof doc.executionPlatform === 'object' ? { executionPlatform: doc.executionPlatform } : {}),
    ...(Object.keys(sourceTc).length ? { sourceTc } : {}),
    steps,
    ...(versions.length ? { versions } : {}),
    ...(currentVersionId ? { currentVersionId } : {}),
    ...(typeof doc?.updateVersion === 'number' ? { updateVersion: doc.updateVersion } : {}),
  };
}

/** Overwrite `tc.steps` with the mapped collection-endpoint rows when non-empty. */
export function applyCollectionSteps(tc: TestCase, rows: any[]): TestCase {
  if (!Array.isArray(rows) || rows.length === 0) return tc;
  const mapped = rows.map((s: any, i: number) => fromSqaStep(s, i + 1));
  return { ...tc, steps: mapped };
}

// ---------------------------------------------------------------------------
// Functions (reusable). Same `tcfnObj` collection as TCs — type='FN' instead of 'TC'.
// Payload shape overlaps with TCs (id/code/name/description/executionType/status), plus
// `fnType` (WEB/API/ANDROID/IOS) in place of `tcType`.
// ---------------------------------------------------------------------------

export function toFunctionSummary(row: any): FunctionSummary {
  const id = str(row, 'id', '_id', 'functionId') ?? '';
  const code = str(row, 'code');
  const name = str(row, 'name', 'title') ?? '';
  const description = str(row, 'description');
  const fnType = str(row, 'fnType', 'tcType');
  const executionType = str(row, 'executionType');
  const status = str(row, 'reviewApproveStatus', 'status');
  const stepCount = typeof row?.stepCount === 'number' ? (row.stepCount as number) : undefined;
  return {
    id,
    ...(code ? { code } : {}),
    name,
    ...(description ? { description } : {}),
    ...(fnType ? { fnType } : {}),
    ...(executionType ? { executionType } : {}),
    ...(status ? { status } : {}),
    ...(stepCount !== undefined ? { stepCount } : {}),
  };
}

/** Full function doc → neutral QaFunction. Steps are attached separately by the adapter (fetched
 *  from /tm/function/steps, same collection endpoint TCs use — just type='FN'). */
export function toFunction(row: any): QaFunction {
  const summary = toFunctionSummary(row);
  return { ...summary, steps: [] };
}

export function toTcSummary(row: any): TcSummary {
  const id = str(row, 'id', '_id', 'testcaseId') ?? '';
  const code = str(row, 'code');
  const title = str(row, 'name', 'title') ?? '';
  // SQA testcase rows have no priority/status/stepCount columns; do not fabricate defaults.
  const stepCount = typeof row?.stepCount === 'number' ? row.stepCount as number : undefined;
  const technologyType = str(row, 'tcType');
  const executionType = str(row, 'executionType');
  const obsolete = typeof row?.obsolete === 'boolean' ? row.obsolete as boolean : undefined;
  return {
    id,
    ...(code ? { code } : {}),
    title,
    ...(stepCount !== undefined ? { stepCount } : {}),
    ...(technologyType ? { technologyType } : {}),
    ...(executionType ? { executionType } : {}),
    ...(obsolete !== undefined ? { obsolete } : {}),
  };
}

// ---------------------------------------------------------------------------
// Suites.
// ---------------------------------------------------------------------------

export function toSuiteSummary(row: any): SuiteSummary {
  const id = str(row, 'id', '_id', 'suiteId') ?? '';
  const name = str(row, 'name', 'suiteName') ?? '';
  const memberCount = Array.isArray(row?.testCases) ? row.testCases.length : undefined;
  const suiteType = str(row, 'suiteType');
  const executionType = str(row, 'lastSelectedExecutionType') ?? str(row, 'executionType');
  return {
    id,
    name,
    ...(memberCount !== undefined ? { memberCount } : {}),
    ...(suiteType ? { suiteType } : {}),
    ...(executionType ? { executionType: executionType.toUpperCase() } : {}),
  };
}

export function toSuite(doc: any): Suite {
  const id = str(doc, 'id', '_id', 'suiteId');
  const description = str(doc, 'description');
  const executionType = (str(doc, 'lastSelectedExecutionType') ?? str(doc, 'executionType'))?.toUpperCase();
  const rawMembers: any[] = Array.isArray(doc?.testCases) ? doc.testCases : [];
  const members = rawMembers.map((tc: any, i: number) => ({
    tcId: str(tc, 'testcaseId', 'id', '_id') ?? '',
    order: typeof tc?.seq === 'number' ? tc.seq : i + 1,
    ...(str(tc, 'version') ? { version: str(tc, 'version')! } : {}),
    ...(str(tc, 'versionId') ? { versionId: str(tc, 'versionId')! } : {}),
  }));
  return {
    ...(id ? { id } : {}),
    name: str(doc, 'name', 'suiteName') ?? '',
    ...(description ? { description } : {}),
    ...(executionType ? { executionType } : {}),
    members,
  };
}

// ---------------------------------------------------------------------------
// User stories (`pm/userstory`). Business key comes back as `code` on SQA
// (US_123 / US-897), so `key` in the neutral shape is populated from `code`.
// ---------------------------------------------------------------------------

export function toStorySummary(row: any): StorySummary {
  const id = str(row, 'id', '_id', 'userstoryId') ?? '';
  const key = str(row, 'code', 'key', 'userStoryCode');
  const title = str(row, 'name', 'title', 'storyName') ?? '';
  const status = str(row, 'status', 'state');
  const priority = str(row, 'priority');
  return {
    id,
    ...(key ? { key } : {}),
    title,
    ...(status ? { status } : {}),
    ...(priority ? { priority } : {}),
  };
}

export function toDefectSummary(row: any): DefectSummary {
  const id = str(row, 'id', '_id') ?? '';
  const code = str(row, 'code');
  const title = str(row, 'name', 'title') ?? '';
  const state = str(row, 'state', 'status');
  const severity = str(row, 'severity');
  const priority = str(row, 'priority');
  // `ownerId` is an ARRAY on the defect row (a defect can have several assignees) — see
  // defect-interface.ts `ownerId: number[]` — unlike the single-value `ownerId` on stories/testcases.
  const assignedTo = Array.isArray(row?.ownerId)
    ? row.ownerId.map((v: any) => String(v ?? '')).filter((v: string) => v.length > 0)
    : undefined;
  const tcIds = Array.isArray(row?.selectedTestCase)
    ? row.selectedTestCase
        .map((tc: any) => (typeof tc === 'object' ? str(tc, 'testcaseId') : String(tc ?? '')))
        .filter((v: string | undefined): v is string => !!v)
    : undefined;
  return {
    id,
    ...(code ? { code } : {}),
    title,
    ...(state ? { state } : {}),
    ...(severity ? { severity } : {}),
    ...(priority ? { priority } : {}),
    ...(assignedTo?.length ? { assignedTo } : {}),
    ...(tcIds?.length ? { tcIds } : {}),
  };
}

/** Maps a `/pm/task/search` row (see `Itask` in sqa-ui) to the neutral shape. `ownerId` is an array
 *  on the task row, same as on a defect. */
export function toTaskSummary(row: any): TaskSummary {
  const id = str(row, 'id', '_id') ?? '';
  const code = str(row, 'code');
  const title = str(row, 'name', 'title') ?? '';
  const state = str(row, 'state', 'status');
  const priority = str(row, 'priority');
  const assignedTo = Array.isArray(row?.ownerId)
    ? row.ownerId.map((v: any) => String(v ?? '')).filter((v: string) => v.length > 0)
    : undefined;
  const defectId = typeof row?.defectId === 'number' && row.defectId > 0 ? String(row.defectId) : undefined;
  return {
    id,
    ...(code ? { code } : {}),
    title,
    ...(state ? { state } : {}),
    ...(priority ? { priority } : {}),
    ...(assignedTo?.length ? { assignedTo } : {}),
    ...(defectId ? { defectId } : {}),
  };
}

export function toStory(doc: any): Story {
  const base = toStorySummary(doc);
  const description = str(doc, 'description', 'storyDescription');
  // Acceptance criteria: array of blobs/objects, or one HTML/newline string (see the splitter).
  const rawAc = doc?.acceptanceCriteria ?? doc?.acceptance_criteria;
  const ac = splitAcceptanceCriteria(rawAc);
  // Parent + scope links — surfaced so gap_analysis / impact_analysis can walk defect→sprint→release
  // without an extra listStories round-trip. `iterationId` is SQA's server-side sprint column.
  const sprintId = str(doc, 'iterationId');
  const releaseId = str(doc, 'releaseId');
  const epicId = str(doc, 'epicId');
  const featureId = str(doc, 'featureId');
  return {
    ...base,
    ...(description ? { description } : {}),
    ...(ac && ac.length ? { acceptanceCriteria: ac } : {}),
    ...(sprintId ? { sprintId } : {}),
    ...(releaseId ? { releaseId } : {}),
    ...(epicId ? { epicId } : {}),
    ...(featureId ? { featureId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Epics (`pm/epic`) and features (`pm/feature`). Business keys come back as
// `code` (EP_XXX / FT_XXX); numeric doc id is `id` (with `_id` as fallback).
// ---------------------------------------------------------------------------

export function toEpicSummary(row: any): EpicSummary {
  const id = str(row, 'id', '_id', 'epicId') ?? '';
  const key = str(row, 'code', 'key');
  const name = str(row, 'name', 'epicName') ?? '';
  const state = str(row, 'state', 'status');
  return {
    id,
    ...(key ? { key } : {}),
    name,
    ...(state ? { state } : {}),
  };
}

export function toEpic(doc: any): Epic {
  const base = toEpicSummary(doc);
  const description = str(doc, 'description');
  const plannedStartDate = str(doc, 'plannedStartDate');
  const plannedEndDate = str(doc, 'plannedEndDate');
  const rawEffort = doc?.estimatedEffort;
  const rawOwner = doc?.ownerId;
  return {
    ...base,
    ...(description ? { description } : {}),
    ...(typeof rawEffort === 'number' ? { estimatedEffort: rawEffort } : {}),
    ...(typeof rawOwner === 'number' ? { ownerId: rawOwner } : {}),
    ...(plannedStartDate ? { plannedStartDate } : {}),
    ...(plannedEndDate ? { plannedEndDate } : {}),
  };
}

export function toFeatureSummary(row: any): FeatureSummary {
  const id = str(row, 'id', '_id', 'featureId') ?? '';
  const key = str(row, 'code', 'key');
  const name = str(row, 'name', 'featureName') ?? '';
  const state = str(row, 'state', 'status');
  const priority = str(row, 'priority');
  const epicId = str(row, 'epicId');
  return {
    id,
    ...(key ? { key } : {}),
    name,
    ...(state ? { state } : {}),
    ...(priority ? { priority } : {}),
    ...(epicId ? { epicId } : {}),
  };
}

export function toFeature(doc: any): Feature {
  const base = toFeatureSummary(doc);
  const description = str(doc, 'description');
  const plannedStartDate = str(doc, 'plannedStartDate');
  const plannedEndDate = str(doc, 'plannedEndDate');
  const rawEffort = doc?.estimatedEffort;
  const rawOwner = doc?.ownerId;
  return {
    ...base,
    ...(description ? { description } : {}),
    ...(typeof rawEffort === 'number' ? { estimatedEffort: rawEffort } : {}),
    ...(typeof rawOwner === 'number' ? { ownerId: rawOwner } : {}),
    ...(plannedStartDate ? { plannedStartDate } : {}),
    ...(plannedEndDate ? { plannedEndDate } : {}),
  };
}

// ---------------------------------------------------------------------------
// Modules, releases, sprints.
// ---------------------------------------------------------------------------

export function toModuleSummary(row: any): ModuleSummary {
  const id = str(row, 'id', 'moduleId', '_id') ?? '';
  const name = str(row, 'name', 'moduleName') ?? '';
  const parentId = str(row, 'parentId', 'parent', 'parentModuleId');
  const isRoot = typeof row?.isRoot === 'boolean' ? row.isRoot : undefined;
  const childIds = Array.isArray(row?.childIds)
    ? row.childIds.filter((n: unknown): n is number => Number.isFinite(n))
    : undefined;
  return {
    id,
    name,
    ...(parentId && parentId !== '0' ? { parentId } : {}),
    ...(isRoot !== undefined ? { isRoot } : {}),
    ...(childIds ? { childIds } : {}),
  };
}

/** Map the POST /pm/module response to a `ModuleSaved`. Throws when the server accepts the request
 *  but hands back no id — that "silent success" is the bug that let broken subtree creates report
 *  success. Callers rely on `id` for downstream operations, so anything less is a failure. */
export function toModuleSaved(raw: any, requestedName: string): ModuleSaved {
  const doc = (raw?.data ?? raw) ?? {};
  const id = str(doc, 'id', '_id', 'moduleId') ?? '';
  if (!id) {
    throw new Error(
      `create_module: server returned 2xx but no id for "${requestedName}" — module NOT created`,
    );
  }
  const code = str(doc, 'code');
  const name = str(doc, 'name', 'moduleName') ?? requestedName;
  const parentId = str(doc, 'parentId', 'parent', 'parentModuleId');
  const isRoot = typeof doc?.isRoot === 'boolean' ? doc.isRoot : parentId == null;
  const childIds = Array.isArray(doc?.childIds)
    ? doc.childIds.filter((n: unknown): n is number => Number.isFinite(n))
    : undefined;
  return {
    id,
    name,
    isRoot,
    created: true,
    ...(code ? { code } : {}),
    ...(parentId && parentId !== '0' ? { parentId } : {}),
    ...(childIds ? { childIds } : {}),
  };
}

export function toReleaseSummary(row: any): ReleaseSummary {
  const id = str(row, 'id', '_id', 'releaseId') ?? '';
  const name = str(row, 'name', 'releaseName') ?? '';
  const state = str(row, 'state', 'status');
  const plannedStartDate = str(row, 'plannedStartDate');
  const plannedEndDate = str(row, 'plannedEndDate');
  return {
    id,
    name,
    ...(state ? { state } : {}),
    ...(plannedStartDate ? { plannedStartDate } : {}),
    ...(plannedEndDate ? { plannedEndDate } : {}),
  };
}

export function toSprintSummary(row: any): SprintSummary {
  const id = str(row, 'id', '_id', 'sprintId') ?? '';
  const name = str(row, 'name', 'sprintName') ?? '';
  const releaseId = str(row, 'releaseId');
  const state = str(row, 'state', 'status');
  const plannedStartDate = str(row, 'plannedStartDate');
  const plannedEndDate = str(row, 'plannedEndDate');
  return {
    id,
    name,
    ...(releaseId ? { releaseId } : {}),
    ...(state ? { state } : {}),
    ...(plannedStartDate ? { plannedStartDate } : {}),
    ...(plannedEndDate ? { plannedEndDate } : {}),
  };
}

// ---------------------------------------------------------------------------
// Objects — the shared object (locator) library. `attributes[]` is the SQA
// wire shape; the neutral QaObject exposes it as `locators`.
// ---------------------------------------------------------------------------

/** Stored image refs are `{ url: '/download/recording/.../<file>' }` with no extension and a path
 *  relative to the SimplifyQA host; the UI appends `.png`. Return an absolute, loadable URL. */
export function toImageUrl(ref: any, baseUrl?: string): string | undefined {
  const raw = typeof ref === 'string' ? ref : typeof ref?.url === 'string' ? ref.url : '';
  if (!raw.trim()) return undefined;
  if (/^(data:|blob:)/i.test(raw)) return raw;
  const withExt = /\.(png|jpe?g|gif|webp)$/i.test(raw) ? raw : `${raw}.png`;
  if (/^https?:\/\//i.test(withExt)) return withExt;
  if (!baseUrl) return withExt;
  return `${baseUrl.replace(/\/+$/, '')}/${withExt.replace(/^\/+/, '')}`;
}

export function toObject(doc: any, baseUrl?: string): QaObject {
  const id = str(doc, 'id', '_id');
  const rawAttrs: any[] = Array.isArray(doc?.attributes) ? doc.attributes : [];
  const locators: Locator[] = rawAttrs
    .filter((a) => typeof a?.name === 'string' && typeof a?.value === 'string')
    .map((a) => ({
      name: String(a.name),
      value: String(a.value),
      ...(a.unique === true ? { unique: true } : {}),
    }));
  const name = str(doc, 'disname', 'description', 'placeholder') ?? '';
  const objectType = str(doc, 'technology');
  const description = str(doc, 'description');
  const moduleId = doc?.moduleId != null ? String(doc.moduleId) : undefined;
  const parameterIds = Array.isArray(doc?.parameterId)
    ? doc.parameterId.map((p: unknown) => String(p)).filter((p: string) => p && p !== 'null')
    : undefined;
  const thumbnailUrl = toImageUrl(doc?.thumbnail_url, baseUrl);
  const pageScreenshotUrl = toImageUrl(doc?.pageScreenShot_url, baseUrl);
  const objectTemplateId = doc?.objecttemplateId != null
    ? String(doc.objecttemplateId)
    : (doc?.objectTemplateId != null ? String(doc.objectTemplateId) : undefined);
  return {
    ...(id ? { id } : {}),
    name,
    ...(objectType ? { objectType } : {}),
    locators,
    ...(objectTemplateId ? { objectTemplateId } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(pageScreenshotUrl ? { pageScreenshotUrl } : {}),
    ...(description ? { description } : {}),
    ...(moduleId ? { moduleId } : {}),
    ...(parameterIds?.length ? { parameterIds } : {}),
  };
}

// ---------------------------------------------------------------------------
// Write-side helpers. `${name}` token extraction + secret detection + payload
// builders for POST/PUT /tm/testcase (`testcaseObj`).
// ---------------------------------------------------------------------------

// Mirrors the UI's PARAM_TOKEN_RE: SQA parameter names may contain spaces ("prefix value_4").
const PARAM_TOKEN = /\$\{([^{}]+?)\}/g;

/** Unique `${name}` tokens in a step description, in first-seen order. */
export function extractParamNames(description: string | undefined): string[] {
  if (!description) return [];
  const seen: string[] = [];
  for (const m of description.matchAll(PARAM_TOKEN)) {
    const name = m[1]!;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/** Parameter names referenced INSIDE a DATABASE step's argument value (a filter, query, document, …), as `${name}`
 *  or `{{name}}`, in first-seen order. Purely numeric `{{123}}` is an already-bound id, not a name. */
export function extractValueParamNames(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return [];
  const seen: string[] = [];
  for (const re of [PARAM_TOKEN, /\{\{([^{}]+?)\}\}/g]) {
    for (const m of value.matchAll(re)) {
      const name = m[1]!.trim();
      if (name && !/^\d+$/.test(name) && !seen.includes(name)) seen.push(name);
    }
  }
  return seen;
}

/** A Runtime (store) parameter's test-data value is its STORAGE KEY: blank means "use the parameter's own name". A
 *  placeholder such as `[]` / `{}` / `null` written there by a prompt as an "initial value" would instead make `[]` the
 *  key — shared by every store slot that does the same, so one step's empty result overwrites another's data and later
 *  reads come back `[]`. Placeholders become blank; a real, deliberate key is kept. */
export function runtimeSlotValue(value: string | undefined): string {
  const v = (value ?? '').trim();
  return /^(\[\s*\]|\{\s*\}|null|undefined|""|'')$/i.test(v) ? '' : (value ?? '');
}

/** An API step's request after a parameter replacement: every `{{<oldId>}}` (or `{{<oldName>}}`) becomes the new one and the
 *  step's `inputParameters` entry follows, so the request, its input list and `parameterIds` all agree. */
function swapApiParams(
  node: Record<string, unknown>,
  swaps: Array<{ fromId: number; toId: number; from: string; to: string }>,
): Record<string, unknown> {
  if (!swaps.length) return node;
  let json = JSON.stringify(node);
  for (const w of swaps) {
    json = json.split(`{{${w.fromId}}}`).join(`{{${w.toId}}}`).split(`{{${w.from}}}`).join(`{{${w.to}}}`);
  }
  const out = JSON.parse(json) as Record<string, unknown>;
  if (Array.isArray(out['inputParameters'])) {
    out['inputParameters'] = (out['inputParameters'] as Array<Record<string, unknown>>).map((p) => {
      const w = swaps.find((x) => p['id'] === x.fromId);
      return w ? { ...p, id: w.toId, name: w.to } : p;
    });
  }
  return out;
}

/** Put the test case's saved tags / custom fields / mailers / linked issues / defects / suites back on an UPDATE payload.
 *  The builders start from empty defaults; without this every re-save of an existing test case reset them. A create has no
 *  saved copy, so nothing changes there. */
function withSavedTcFields(tcfnObj: Record<string, unknown>, tc: TestCase): Record<string, unknown> {
  const merged = tc.sourceTc ? { ...tcfnObj, ...tc.sourceTc } : { ...tcfnObj };
  // Neutral fields the caller can legitimately CHANGE (journal_modify set_meta) must win over the
  // copied raw doc — otherwise editing tags/… looks successful but the old value is re-sent.
  if (tc.tags !== undefined) merged['tags'] = tc.tags;
  return merged;
}

/** Bind the parameters referenced inside a DATABASE step's argument value.
 *  The agent only substitutes `{{name}}` there, and only for parameters listed in the step's `parameterizedParamIds`
 *  (ParameterizedArgument) — a `${name}` stays literal text, so e.g. a Mongo filter on `…-${suffix}` matched nothing.
 *  Rewrites each `${name}` / `{{name}}` whose name resolves to a known parameter into `{{name}}` and returns the ids;
 *  unknown names and the argument's own name are left exactly as written. */
export function bindValueParams(
  value: string, paramIdByName: Map<string, number>, selfName?: string,
): { value: string; ids: number[] } {
  const ids: number[] = [];
  const bind = (whole: string, raw: string): string => {
    const name = raw.trim();
    const id = /^\d+$/.test(name) || name === selfName ? undefined : paramIdByName.get(name);
    if (id == null) return whole;
    if (!ids.includes(id)) ids.push(id);
    return `{{${name}}}`;
  };
  const out = value
    .replace(/\{\{([^{}]+?)\}\}/g, (w, n: string) => bind(w, n))
    .replace(/\$\{([^{}]+?)\}/g, (w, n: string) => bind(w, n));
  return { value: out, ids };
}

/** `{{name}}` token used INSIDE an API request object (url / headers / body / auth / query) — the
 *  SQA API editor's placeholder syntax, distinct from the `${name}` used in step DESCRIPTIONS.
 *  The editor persists these bound to numeric parameter ids as `{{<paramId>}}`. */
// Must mirror the UI's PARAM_TOKEN_RE: SQA parameter names may contain spaces
// (e.g. "prefix value_4", "expected partial text_17"). A narrower regex silently
// leaves those tokens unresolved, so they never become {{<id>}} / inputParameters.
const API_PARAM_TOKEN = /\{\{([^{}]+?)\}\}/g;

/**
 * The API-TC assertion editor is keyed by the RESPONSE JSON, not the live request syntax:
 *   statusCode / responseTime / responseSize
 *   response.<body.path>          (body keys are under `response`)
 *   <header-name> with `key`      (Received Headers tab)
 * MCP callers naturally use `$.body.x` / `$.headers.X-Foo` (the live resolver's syntax), so
 * translate those to the editor shape before persisting. Without this the assertions are stored
 * but the editor's pathValidation cannot map them, making them look missing.
 */
/**
 * The assertion editor's condition enum is `LESSER_THAN` / `LESSER_THAN_OR_EQUAL_TO`
 * (testcase-management/assertion/assertion.model.ts) — NOT `LESS_THAN`. An assertion persisted with
 * the wrong token renders with a blank condition in the UI (and can look like it was never added),
 * so every common synonym is folded onto the enum on save.
 */
export function canonicalApiCondition(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const k = raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
  const map: Record<string, string> = {
    LESS_THAN: 'LESSER_THAN',
    LESSER: 'LESSER_THAN',
    LT: 'LESSER_THAN',
    LESS_THAN_OR_EQUAL_TO: 'LESSER_THAN_OR_EQUAL_TO',
    LESS_THAN_OR_EQUALS: 'LESSER_THAN_OR_EQUAL_TO',
    LESSER_THAN_OR_EQUALS: 'LESSER_THAN_OR_EQUAL_TO',
    LTE: 'LESSER_THAN_OR_EQUAL_TO',
    GREATER_THAN_OR_EQUALS: 'GREATER_THAN_OR_EQUAL_TO',
    GTE: 'GREATER_THAN_OR_EQUAL_TO',
    EQUALS_TO: 'EQUALS',
    EQUAL: 'EQUALS',
    NOT_EQUAL: 'NOT_EQUALS',
    NOT_EQUALS_TO: 'NOT_EQUALS',
    NOT_CONTAINS: 'DOES_NOT_CONTAIN',
    IS_EMPTY: 'EQUAL_TO_EMPTY',
    IS_NOT_EMPTY: 'NOT_EMPTY',
    IS_NULL: 'EQUAL_TO_NULL',
    IS_NOT_NULL: 'NOT_EQUAL_TO_NULL',
  };
  return map[k] ?? k;
}

/**
 * Fill the API request/document defaults the SQA editor expects. An API step authored by a model
 * (`add_step` with just `{ requestData: { httpData: { url, method } } }`) is otherwise saved with a
 * PARTIAL `apiData`: the API popup then indexes `requestStyle` / `query_params` / `headers` /
 * `authorization` / `body.data` and throws while loading or saving, so its edits never persist and
 * its parameter list never renders. Emitting the full shape keeps every step openable/saveable.
 */
function normalizeApiDataShape(apiData: Record<string, unknown>): void {
  if (!apiData || typeof apiData !== 'object' || Array.isArray(apiData)) return;
  if (typeof apiData['requestStyle'] !== 'string' || !apiData['requestStyle']) apiData['requestStyle'] = 'HTTP';
  let requestData = apiData['requestData'];
  if (!requestData || typeof requestData !== 'object' || Array.isArray(requestData)) {
    requestData = {};
    apiData['requestData'] = requestData;
  }
  const rd = requestData as Record<string, unknown>;
  if (!rd['grpcData'] || typeof rd['grpcData'] !== 'object' || Array.isArray(rd['grpcData'])) rd['grpcData'] = {};
  if (apiData['requestStyle'] === 'HTTP') {
    let httpData = rd['httpData'];
    if (!httpData || typeof httpData !== 'object' || Array.isArray(httpData)) {
      httpData = {};
      rd['httpData'] = httpData;
    }
    const h = httpData as Record<string, unknown>;
    if (typeof h['url'] !== 'string') h['url'] = '';
    if (typeof h['method'] !== 'string' || !h['method']) h['method'] = 'GET';
    if (!Array.isArray(h['query_params'])) h['query_params'] = [];
    if (!Array.isArray(h['path_params'])) h['path_params'] = [];
    if (!Array.isArray(h['headers'])) h['headers'] = [];
    if (!h['authorization'] || typeof h['authorization'] !== 'object' || Array.isArray(h['authorization'])) {
      h['authorization'] = {
        type: 'NO_AUTHORIZATION',
        bearerToken: { value: '' },
        apiKey: { key: '', value: '', type: 'REQUEST_HEADER' },
        basicAuth: { username: '', password: '' },
      };
    }
    if (!h['body'] || typeof h['body'] !== 'object' || Array.isArray(h['body'])) {
      h['body'] = {
        type: 'NONE',
        data: {
          payload: '',
          graphqlVariables: '',
          FORM_DATA: [{ key: '', value: '', description: '', active: false, formDataKey: 'TEXT' }],
          X_WWW_FORM_URLENCODED: [{ key: '', value: '', description: '', active: false }],
        },
      };
    }
  }
  if (!Array.isArray(apiData['inputParameters'])) apiData['inputParameters'] = [];
  if (!Array.isArray(apiData['responseParameters'])) apiData['responseParameters'] = [];
  if (!Array.isArray(apiData['assertions'])) apiData['assertions'] = [];
}

function normalizeApiAssertions(raw: unknown): unknown[] {  if (!Array.isArray(raw)) return [];
  const special = new Set(['statusCode', 'responseTime', 'responseSize', 'responseBody']);  const lastSegment = (path: string): string => {
    const noIndex = path.replace(/\[[^\]]*\]/g, '');
    const parts = noIndex.split('.').filter(Boolean);
    return parts[parts.length - 1] ?? path;
  };
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const o = { ...(entry as Record<string, unknown>) };
    const rawPath = typeof o['path'] === 'string' ? o['path'].trim() : '';
    const explicitKey = typeof o['key'] === 'string' ? o['key'].trim() : '';
    let path = rawPath;
    let key = explicitKey;
    if (special.has(rawPath)) {
      key = explicitKey || rawPath;
    } else if (rawPath.startsWith('$.headers.')) {
      // The execution plugin resolves headers from `responseHeaders.<name>` (Constants.RESPONSE_HEADERKEY).
      key = rawPath.slice('$.headers.'.length).trim();
      path = `responseHeaders.${key}`;
    } else if (rawPath.startsWith('response.')) {
      key = explicitKey || lastSegment(rawPath.slice('response.'.length));
    } else if (rawPath.startsWith('$.body.')) {
      const rest = rawPath.slice('$.body.'.length);
      path = `response.${rest}`;
      key = explicitKey || lastSegment(rest);
    } else if (rawPath.startsWith('$.')) {
      const rest = rawPath.slice(2);
      path = `response.${rest}`;
      key = explicitKey || lastSegment(rest);
    } else if (rawPath.startsWith('responseHeaders.')) {
      // Already in the saved shape — leave it (re-normalizing would double the prefix on every re-save).
      key = explicitKey || rawPath.slice('responseHeaders.'.length);
    } else if (explicitKey) {
      // Header-style assertion supplied as { key, path }.
      path = rawPath ? `responseHeaders.${rawPath}` : `responseHeaders.${explicitKey}`;
    } else {
      path = `response.${rawPath}`;
      key = lastSegment(rawPath);
    }
    return {
      ...o,
      path,
      ...(key ? { key } : {}),
      ...(o['condition'] !== undefined ? { condition: canonicalApiCondition(o['condition']) } : {}),
      ...(o['caseSensitive'] === undefined ? { caseSensitive: false } : {}),
    };
  });
}


/** Recursively collect unique `{{name}}` tokens from every string in an API request object. */
export function extractApiParamNames(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') {
    for (const m of node.matchAll(API_PARAM_TOKEN)) {
      const name = m[1]!;
      if (!out.includes(name)) out.push(name);
    }
  } else if (Array.isArray(node)) {
    for (const v of node) extractApiParamNames(v, out);
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node as Record<string, unknown>)) extractApiParamNames(v, out);
  }
  return out;
}

/** Map a `body.type` to the editor's `lastActiveTab.subTab` (mirrors apiImport.service.js). */
const API_BODY_SUBTAB: Record<string, string> = {
  JSON: 'JSON', FORM_DATA: 'FORM_DATA', X_WWW_FORM_URLENCODED: 'X_WWW_FORM_URLENCODED',
  TEXT: 'TEXT', XML: 'XML', GRAPHQL: 'GRAPHQL',
};

/**
 * Deep-clone an API request object, rewriting each `{{name}}` token whose name was resolved to a
 * parameter into `{{<paramId>}}` — the exact form the SQA UI/Postman importer persists. An
 * unresolvable token is left untouched (better to surface it than to silently drop the request).
 * Collects the ordered unique `{id,name}` pairs substituted (drives `parameterIds` +
 * `apiData.inputParameters`).
 */
function substituteApiParams(
  node: unknown,
  paramIdByName: Map<string, number>,
  params: Array<{ id: number; name: string }>,
): unknown {
  if (typeof node === 'string') {
    return node.replace(API_PARAM_TOKEN, (whole, name: string) => {
      const id = paramIdByName.get(name);
      if (id == null) return whole;
      if (!params.some((p) => p.id === id)) params.push({ id, name });
      return `{{${id}}}`;
    });
  }
  if (Array.isArray(node)) return node.map((v) => substituteApiParams(v, paramIdByName, params));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = substituteApiParams(v, paramIdByName, params);
    }
    return out;
  }
  return node;
}

/** `body.type` of an API request object, or undefined when absent (→ lastActiveTab.subTab NONE). */
function apiBodyType(apiData: Record<string, unknown>): string | undefined {
  const httpData = (apiData['requestData'] as Record<string, unknown> | undefined)?.['httpData'] as Record<string, unknown> | undefined;
  const body = httpData?.['body'] as Record<string, unknown> | undefined;
  const type = body?.['type'];
  return typeof type === 'string' ? type : undefined;
}

/** Auto-mask heuristic: names containing password/secret/token/apikey/auth/credential get
 *  `protected:true` on parameter creation. A missed real secret is worse than a false positive
 *  the user can uncheck in the UI. */
export function looksSensitive(name: string): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  return n.includes('password') || n.includes('passwd') || n.includes('secret')
    || n.includes('token') || n.includes('apikey') || n.includes('api_key')
    || n.includes('auth') || n.includes('credential')
    || n.includes('confirm') || n.includes('retype') || n.includes('reenter')
    || n.includes('re-enter') || n.includes('repeat') || n.includes('pwd');
}

/** Pick a default value for a param: `tc.data[name]` wins; else the step's own `value`; else "". */
export function paramDefault(name: string, data: Record<string, string> | undefined, stepValue: string | undefined): string {
  if (data && Object.prototype.hasOwnProperty.call(data, name)) return String(data[name] ?? '');
  return stepValue ?? '';
}

/** Inputs to the payload builder for POST/PUT /tm/testcase. All resolution (project id, module
 *  id, storyRef → userstoryId, name → paramId) happens in the adapter and is passed in here. */
export type BuildTestcasePayloadInputs = {
  projectId: number;
  moduleId: number;
  userstoryId?: number;
  /** For UPDATE, the numeric TC id (already stripped of any TC_ prefix). */
  existingId?: string;
  tc: TestCase;
  /** name → SQA parameter id, populated by the adapter's get-or-create loop before this runs. */
  paramIdByName: Map<string, number>;
  /** parameter id → the catalog's access type ("LOCAL" / "RUNTIME"). The API executor substitutes a
   *  RUNTIME parameter from the runtime store; persisting a runtime-backed request parameter as LOCAL
   *  made the first run send the recorded literal instead of the value an earlier step stored. */
  paramAccessById?: Map<number, string>;
  /** AUTOMATION-only: per step (aligned by tc.steps index) the numeric SQA `actionId` +
   *  `objectId` the adapter resolved before this call. `objectId` is null when the action does
   *  not need one. Ignored on manual saves. */
  stepResolutions?: Array<{ actionId: number | null; objectId: number | null | undefined }>;
};

/** Neutral Step.stepType → SQA `technologyType` on the step + `tcType` on the TC.
 *  Exported so the adapter's per-step resolver keys the action catalog by the same technology
 *  labels the mapper writes into the step. */
export const TECH_BY_STEPTYPE: Record<string, string> = {
  web: 'WEB',
  android: 'ANDROID',
  ios: 'IOS',
  api: 'API',
  database: 'DATABASE',
  mainframe: 'MAINFRAME',
  desktop: 'DESKTOP',
  sap: 'SAP',
};

/**
 * True when a neutral `stepType: 'api'` step is a real API REQUEST (it carries an `api` payload),
 * as opposed to an API-TECHNOLOGY step that uses a generic action (e.g. "Store from JSON" —
 * `actionId: 140`, `stepType: 'API'`, no `apiData`). The backend stores both under `stepType: 'API'`
 * + `technologyType: 'API'`, so the request payload — not the step/technology type — is what tells
 * them apart. Getting this wrong saves a generic action step as an action-less API step (its action
 * and parameters vanish) and turns it into an empty API request.
 */
export function isApiRequestStep(s: {
  stepType?: string | undefined;
  api?: unknown;
  sourceRaw?: unknown;
}): boolean {
  if (s.stepType !== 'api') return false;
  const isRequest = (v: unknown): boolean => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const o = v as Record<string, unknown>;
    return o['requestData'] !== undefined || o['requestStyle'] !== undefined;
  };
  const raw = s.sourceRaw && typeof s.sourceRaw === 'object' ? (s.sourceRaw as Record<string, unknown>) : undefined;
  return isRequest(s.api) || isRequest(raw?.['apiData']);
}

/** Technologies that don't bind a real device/browser at save time — the backend defaults
 *  executionPlatform for them (or ignores it). Keeps the WEB-only guard below from firing on
 *  tcTypes where there's nothing to default. */
const NO_PLATFORM_TECHS = new Set(['API', 'DATABASE', 'MAINFRAME', 'DESKTOP', 'SAP']);

/** Pick the tcType from the first step whose stepType we recognize as an automation technology.
 *  Falls back to WEB — matches the SQA UI's default when the user starts a fresh automation TC. */
export function deriveTcType(tc: TestCase): string {
  // A saved test case already has its type; recomputing it from the first step mis-types a mixed one (API then DB).
  if (tc.technologyType) return tc.technologyType.toUpperCase();
  for (const s of tc.steps ?? []) {
    // A step may carry its technology explicitly. Function-call steps do: their technology is the
    // FUNCTION's own (WEB/API/ANDROID/IOS/…), resolved from the function catalog at save time —
    // a function call has no technology of its own to read from `stepType`.
    const stepTech = (s as { technologyType?: string }).technologyType;
    if (stepTech) return stepTech.toUpperCase();
    const tech = TECH_BY_STEPTYPE[s.stepType];
    if (tech) return tech;
  }
  // Refuse to guess: an all-function test case whose functions could not be resolved used to be
  // silently saved as WEB, so an API/Android/iOS function suite became a browser test case.
  const steps = tc.steps ?? [];
  const onlyFunctions = steps.length > 0
    && steps.every((s) => s.stepType === 'function' || s.stepType === 'function_end');
  if (onlyFunctions) {
    throw new Error(
      'This test case is built only from function calls, so its technology is the functions\' own. ' +
      'Pass `technologyType` (WEB | API | ANDROID | IOS | DATABASE | MAINFRAME | DESKTOP | SAP) on the draft, ' +
      'or save it while the function catalog is reachable so it can be resolved from the functions\' fnType. ' +
      'Saving it as WEB would run a non-web suite through the browser runner.',
    );
  }
  return 'WEB';
}

/** SQA-empty `mailersList` shape — the frontend and joi validator expect the three arrays, not
 *  a bare `{}`. Verified against the real create payload for TC-584. */
const EMPTY_MAILERS = { users: [] as unknown[], nonUsers: [] as unknown[], groups: [] as unknown[] };

/** Locate the version entry the neutral TestCase currently points at, so update payloads carry
 *  the REAL versionId (not `''`, which the backend interprets as "create a new version" —
 *  see tcfn.service.js:233 — and produces the empty-steps-after-save symptom). Returns an empty
 *  object when unresolved; callers then fall back to `id:''` (correct for CREATE). */
function currentVersionFor(tc: TestCase): { id?: string; name?: string; updateVersion?: number } {
  const id = tc.currentVersionId;
  if (!id || !Array.isArray(tc.versions)) return {};
  const v = tc.versions.find((entry) => entry.id === id);
  return v ? { id: v.id, name: v.name, ...(typeof v.updateVersion === 'number' ? { updateVersion: v.updateVersion } : {}) } : {};
}

/**
 * Assemble the `testcaseObj` payload for POST/PUT /tm/testcase (multipart). Branches on
 * `tc.category`: manual → `steps.manualSteps` (legacy behavior), automated → `steps.automationSteps`
 * with resolved actionId/objectId/parameterIds. See `buildManualPayload` and
 * `buildAutomationPayload` below for the per-branch shapes; both share the wrapper.
 */
export function buildTestcasePayload(inputs: BuildTestcasePayloadInputs): Record<string, unknown> {
  return inputs.tc.category === 'automated'
    ? buildAutomationPayload(inputs)
    : buildManualPayload(inputs);
}

/**
 * Manual TC payload. Mirrors Java's `buildTestcasePayload` exactly on wire shape:
 *   - `tcfnObj` — TC-level meta. `deleted` is required on UPDATE and rejected on CREATE.
 *   - `versionsDetails` — a minimal `{name:'v1.0', id:''}` stub matches what the SQA UI sends
 *     for a fresh TC; UPDATE also carries `deleted:false` because the validator requires it.
 *   - `steps.manualSteps` — one entry per neutral step; `automationSteps` is emitted empty.
 *   - Every step gets `parameterIds[]` for the `${name}` tokens in its description.
 */
function buildManualPayload(inputs: BuildTestcasePayloadInputs): Record<string, unknown> {
  const { projectId, moduleId, userstoryId, existingId, tc, paramIdByName } = inputs;

  // ponytail: emit the same field set as the SQA UI payload, always — validators + $set on the
  // backend depend on presence, even for empty defaults. Loader-mutator-saver semantics.
  const tcfnObj: Record<string, unknown> = {
    ...(existingId ? { id: Number.parseInt(existingId, 10) } : {}),
    name: tc.title ?? '',
    userstoryId: userstoryId ?? null,
    defectId: [] as number[],
    suiteId: [] as number[],
    description: stripParamTokens(normalizeParamTokens(tc.description ?? '') ?? '') ?? '',
    projectId,
    tcType: 'WEB',
    executionType: 'MANUAL',
    // Round-trip the flag: an edit/re-save must never silently RESET `obsolete` to false (that used to
    // revive a TC the story sync had retired). Revival is explicit: set_meta { obsolete: false }.
    obsolete: tc.obsolete === true,
    linkedIssues: [] as unknown[],
    moduleId,
    prerequisite: stripParamTokens(normalizeParamTokens(tc.preconditions ?? '') ?? '') ?? '',
    customFields: {},
    tags: [] as unknown[],
    mailersList: EMPTY_MAILERS,
    updateVersion: tc.updateVersion ?? 0,
    ...(existingId ? { deleted: false } : {}),
  };

  // On UPDATE, use the CURRENT version's real id/name/updateVersion so the backend updates
  // that version row instead of minting a new one (empty `id` triggers create at tcfn.service.js:233).
  const curVer = existingId ? currentVersionFor(tc) : {};
  const versionsDetails: Record<string, unknown> = {
    name: curVer.name ?? 'v1.0',
    id: curVer.id ?? '',
    syncONOFF: '',
    manualStepsTopreview: false,
    updateVersion: curVer.updateVersion ?? 0,
    executionType: 'MANUAL',
    reviewApproveStatus: '',
    functionProjectIds: [projectId],
    ...(existingId ? { deleted: false } : {}),
  };

  const manualSteps: Array<Record<string, unknown>> = [];
  const steps = Array.isArray(tc.steps) ? tc.steps : [];
  steps.forEach((s, i) => {
    // `${{name}}` (API-style) must never reach the product: it renders literally and never binds
    // a parameter. Normalise to the product's `${name}` form first, THEN strip the braces for the
    // manual prose (a human reads/executes these) — the parameter binding is carried separately.
    const descRaw = normalizeParamTokens(s.description ?? '') ?? '';
    const desc = stripParamTokens(descRaw) ?? '';
    const expected = stripParamTokens(normalizeParamTokens(s.expectedResult ?? '') ?? '') ?? '';
    const paramIds: number[] = [];
    const recordedParam: Record<string, string> = {};
    for (const name of extractParamNames(descRaw)) {
      const id = paramIdByName.get(name);
      if (id == null) continue;
      paramIds.push(id);
      recordedParam[String(id)] = paramDefault(name, tc.data, undefined);
    }
    // Round-trip: a HYDRATED step keeps its backend parameterIds even when the prose no longer
    // carries ${tokens} (the manual mapper strips them for readability). Without this, re-saving a
    // loaded manual TC — e.g. saving an updated VERSION — silently drops every parameter binding and
    // its test data (the new version's iteration came out empty).
    if (paramIds.length === 0) {
      for (const id of (s.sourceParameterIds ?? [])) {
        if (typeof id === 'number' && Number.isFinite(id) && !paramIds.includes(id)) paramIds.push(id);
      }
      for (const [k, v] of Object.entries(s.sourceRecordedParam ?? {})) {
        if (recordedParam[k] == null) recordedParam[k] = String(v);
      }
    }
    const rawSlaManual = (s.sourceRaw?.['stepLevelActions'] as Record<string, unknown> | undefined) ?? {};
    const step: Record<string, unknown> = {
      // ponytail: `deleted` is required on UPDATE and REJECTED on CREATE by the backend validator
      // (steps.manualSteps[*].deleted) — emit it only when updating, mirroring tcfnObj above.
      ...(existingId ? { deleted: false } : {}),
      // ponytail: pass through the backend step uuid on round-trip. Missing `id` sends every step
      // down the backend's CREATE branch (tcfn.service.js:355), which mints a fresh uuid and
      // orphans the original row — duplication instead of update.
      ...(s.sourceId ? { id: s.sourceId } : {}),
      // ponytail: same rationale as buildAutomationPayload — parentId + versionId are part of the
      // update filter at tcfn.service.js:406; omitting them causes the upsert to insert an orphan.
      ...(existingId ? { parentId: Number.parseInt(existingId, 10) } : {}),
      ...(existingId && curVer.id ? { versionId: curVer.id } : {}),
      projectId,
      moduleId,
      type: 'TC',
      stepType: 'NORMAL_STATEMENT',
      seq: i + 1,
      description: desc,
      expectedResult: expected,
      executionType: 'MANUAL',
      // Step-level flags (skip / capture screenshot / continue-on-failure) are valid on MANUAL
      // steps too — the validators allow the field. Without this, enabling Skip on a manual TC
      // looked successful but was silently dropped on save.
      stepLevelActions: {
        ...rawSlaManual,
        skip: s.flags?.skip ?? rawSlaManual['skip'] ?? false,
        captureScreenshot: s.flags?.screenshot ?? rawSlaManual['captureScreenshot'] ?? false,
        continueOnFailure: s.flags?.continueOnFailure ?? rawSlaManual['continueOnFailure'] ?? false,
        skippedReport: rawSlaManual['skippedReport'] ?? false,
      },
      // ponytail: always emit — matches UI payload shape. UI sends `[]`/`{}` on every step, backend
      // joi validators + $set semantics assume presence.
      parameterIds: paramIds,
      recordedParam,
    };
    manualSteps.push(step);
  });

  return {
    tcfnObj: withSavedTcFields(tcfnObj, tc),
    versionsDetails,
    steps: { automationSteps: [], manualSteps },
    operation: 'TC',
    type: 'TC',
  };
}

/**
 * Automation TC payload. Mirrors the shape observed on a saved SQA automation TC (TC-584, WEB +
 * ANDROID validation samples):
 *   - `tcfnObj.executionType: 'AUTOMATION'` + `originalExecutinType: 'AUTOMATION'`.
 *   - `tcfnObj.tcType` derived from the first automation step's `stepType` (web / android / …).
 *   - `tcfnObj.executionPlatform` — WEB defaults to Chrome server-side (omitted here), non-WEB
 *     REQUIRES `tc.executionPlatform` from the caller (device serial + name).
 *   - `steps.automationSteps[]` — one entry per neutral step. Each carries the resolved
 *     `actionId` (numeric FK to the SQA `action` collection) + `objectId` (numeric FK to the
 *     shared `object` collection, or null when the action doesn't need one) + `parameterIds` +
 *     `recordedParam:{<id>:value}` (drives the default iteration on save).
 *   - Always-present step defaults (`conditions`, `loop`, `stepLevelActions`, `attachments`)
 *     are emitted every time — the joi validator + backend read these unconditionally on
 *     execution, and the sample confirms they're present on simple straight-line steps too.
 *
 * Straight-line only in this cut — FUNCTION / IF / FOR / WHILE / API / SWITCH are ponytail-
 * deferred to a follow-up (need a real control-flow sample to validate the `conditions.children[]`
 * shape end-to-end).
 */
function buildAutomationPayload(inputs: BuildTestcasePayloadInputs): Record<string, unknown> {
  const { projectId, moduleId, userstoryId, existingId, tc, paramIdByName, stepResolutions, paramAccessById } = inputs;
  const tcType = deriveTcType(tc);

  // WEB: backend auto-defaults executionPlatform to Chrome (tcfn.service.js:206-213), so omit
  // when the caller didn't supply one. API / MAINFRAME / DATABASE / DESKTOP / SAP: no device/
  // browser to bind — synthesize a flat executionPlatform so the save goes through (matches the
  // special-case already used in adapter.ts:2956 for suite entries). Only ANDROID / IOS actually
  // need the caller to pick a device — but on UPDATE the backend already has the platform stored,
  // so omitting it is safe; throwing here would make journal_modify (editStepsDirect → updateTestCase)
  // fail for every Android/iOS TC whose getById response doesn't echo executionPlatform.
  if (tcType !== 'WEB' && !tc.executionPlatform) {
    if (NO_PLATFORM_TECHS.has(tcType)) {
      tc.executionPlatform = { id: tcType, name: tcType, technologyType: tcType, type: 'NONE' };
    } else if (!existingId) {
      throw new Error(
        `Automation TC "${tc.title}" needs \`executionPlatform\` for tcType=${tcType} — set ` +
          `tc.executionPlatform:{id:<deviceSerial>, name, technologyType:'${tcType}', type:'REAL_DEVICE'|'CLOUD_DEVICE'}. ` +
          `For Android, call mobile_list_devices to see the available devices.`,
      );
    }
    // UPDATE without executionPlatform: omit from payload — backend preserves the stored value.
  }

  // ponytail: mirror the real UI payload field-for-field (see the working PUT captured on 2026-09-17
   // for TC-635). Loader-mutator-saver semantics — always emit, empty defaults included.
  const tcfnObj: Record<string, unknown> = {
    ...(existingId ? { id: Number.parseInt(existingId, 10) } : {}),
    name: tc.title ?? '',
    userstoryId: userstoryId ?? null,
    defectId: [] as number[],
    suiteId: [] as number[],
    description: normalizeParamTokens(tc.description ?? '') ?? '',
    projectId,
    tcType,
    executionType: 'AUTOMATION',
    obsolete: tc.obsolete === true,
    linkedIssues: [] as unknown[],
    moduleId,
    prerequisite: normalizeParamTokens(tc.preconditions ?? '') ?? '',
    customFields: {},
    tags: [] as unknown[],
    mailersList: EMPTY_MAILERS,
    originalExecutinType: 'AUTOMATION',
    updateVersion: tc.updateVersion ?? 0,
    ...(existingId ? { deleted: false } : {}),
    ...(tc.executionPlatform ? { executionPlatform: tc.executionPlatform } : {}),
  };

  // On UPDATE, use the CURRENT version's real id/name/updateVersion so the backend updates
  // that version row instead of minting a new one (empty `id` triggers create at tcfn.service.js:233,
  // which orphans all saved steps under a fresh version and leaves the UI's view empty).
  const curVer = existingId ? currentVersionFor(tc) : {};
  const versionsDetails: Record<string, unknown> = {
    name: curVer.name ?? 'v1.0',
    id: curVer.id ?? '',
    syncONOFF: '',
    manualStepsTopreview: false,
    updateVersion: curVer.updateVersion ?? 0,
    executionType: 'AUTOMATION',
    reviewApproveStatus: '',
    functionProjectIds: [projectId],
    ...(existingId ? { deleted: false } : {}),
  };

  const automationSteps: Array<Record<string, unknown>> = [];
  const steps = Array.isArray(tc.steps) ? tc.steps : [];
  steps.forEach((s, i) => {
    const desc = s.description ?? '';
    const technologyType = TECH_BY_STEPTYPE[s.stepType] ?? tcType;
    const resolution = stepResolutions?.[i];
    // ponytail: control-flow / function / switch / manual steps have a null-actionId slot from
    // resolveAutomationSteps — they don't need action resolution to be valid.
    const isControlFlow = s.stepType === 'control_flow' || s.stepType === 'function' || s.stepType === 'function_end' || s.stepType === 'switch' || s.stepType === 'manual';
    if (!isControlFlow && !resolution) {
      throw new Error(
        `Automation TC "${tc.title}" step ${i + 1}: missing action resolution — the adapter did ` +
          'not resolve `actionId` for this step. Check that the neutral Step.actionType maps to a ' +
          'known SQA action for this technology.',
      );
    }

    // parameterIds + recordedParam resolution order:
    //   1. Seed from backend-preserved sourceParameterIds / sourceRecordedParam (round-trip
    //      intact — a save that doesn't touch anything re-emits the same values).
    //   2. Description ${tokens}: register the param id + a DEFAULT value from tc.data. Never
    //      overrides an already-seeded id — a token default must not wipe a real recorded value.
    //   3. LLM patches (s.recordedParam, name-keyed): resolve name → id and OVERRIDE. This is
    //      how "change the URL parameter to X" via tc_draft_update flows through to the wire.
    const paramIds: number[] = [...(s.sourceParameterIds ?? [])];
    const seenIds = new Set<number>(paramIds);
    const recordedParamOut: Record<string, string> = { ...(s.sourceRecordedParam ?? {}) };
    const registerId = (id: number) => {
      if (!seenIds.has(id)) { paramIds.push(id); seenIds.add(id); }
    };
    const setValue = (id: number, value: string, override: boolean) => {
      const key = String(id);
      if (override || !(key in recordedParamOut)) recordedParamOut[key] = value;
    };
    const seenNames = new Set<string>();
    const addByName = (name: string, value: string | undefined, override: boolean) => {
      if (seenNames.has(name)) return;
      seenNames.add(name);
      // A purely-numeric key is an ALREADY-BOUND parameter ID, not a parameter name. A step that was
      // read from the backend and re-added (or patched) carries `recordedParam: {"7001": "sub_ln"}`;
      // looking that up as a name would bind a different parameter literally called "7001" (and the
      // save path used to CREATE one). Bind the id the user already had.
      if (/^\d+$/.test(name)) {
        const id = Number.parseInt(name, 10);
        if (Number.isFinite(id)) {
          registerId(id);
          if (value !== undefined) setValue(id, value, override);
        }
        return;
      }
      const id = paramIdByName.get(name);
      if (id == null) return;
      registerId(id);
      if (value !== undefined) setValue(id, value, override);
    };
    // Replace-a-parameter edits (swapParams) run FIRST, on the seeded (saved) bindings: the new parameter takes the OLD
    // one's slot — appending it would leave the old parameter in the action's argument slot — and the old one's value,
    // description token, `{{name}}` references and parameterized id all follow. Idempotent: a step that already uses
    // `to` and no longer `from` is left alone.
    let descNow = desc;
    let patchRecorded = s.recordedParam;
    const srcRaw = (s.sourceRaw ?? {}) as Record<string, unknown>;
    const swappedParameterized: number[] = Array.isArray(srcRaw['parameterizedParamIds'])
      ? [...(srcRaw['parameterizedParamIds'] as number[])] : [];
    const swapsApplied: Array<{ fromId: number; toId: number; from: string; to: string }> = [];
    const swapText = (text: string, from: string, to: string): string =>
      text.split('${' + from + '}').join('${' + to + '}').split('{{' + from + '}}').join('{{' + to + '}}');
    for (const sw of s.swapParams ?? []) {
      const fromId = paramIdByName.get(sw.from);
      const toId = paramIdByName.get(sw.to);
      if (fromId == null || toId == null) {
        throw new Error(`Step ${i + 1}: cannot replace parameter "${sw.from}" with "${sw.to}" — ${fromId == null ? sw.from : sw.to} is not a known parameter.`);
      }
      if (fromId === toId) continue;
      const at = paramIds.indexOf(fromId);
      const usesInApi = JSON.stringify(s.api ?? srcRaw['apiData'] ?? {}).includes(`{{${fromId}}}`);
      if (at < 0 && !usesInApi && !swappedParameterized.includes(fromId)) {
        if (paramIds.includes(toId) || swappedParameterized.includes(toId)) continue;   // already swapped
        throw new Error(`Step ${i + 1} does not use parameter "${sw.from}", so it cannot be replaced with "${sw.to}".`);
      }
      if (at >= 0) {
        if (paramIds.includes(toId)) paramIds.splice(at, 1); else paramIds[at] = toId;
        seenIds.delete(fromId); seenIds.add(toId);
        delete recordedParamOut[String(fromId)];
        recordedParamOut[String(toId)] = sw.value ?? tc.data?.[sw.to] ?? '';
      }
      const k = swappedParameterized.indexOf(fromId);
      if (k >= 0) swappedParameterized[k] = toId;
      descNow = swapText(descNow, sw.from, sw.to);
      if (patchRecorded) {
        patchRecorded = Object.fromEntries(Object.entries(patchRecorded).map(([n, v]) => [n, typeof v === 'string' ? swapText(v, sw.from, sw.to) : v]));
      }
      swapsApplied.push({ fromId, toId, from: sw.from, to: sw.to });
    }
    // Description tokens seed defaults but don't override
    for (const name of extractParamNames(descNow)) addByName(name, tc.data?.[name] ?? s.value, false);
    // LLM patches override
    // DATABASE steps: a parameter referenced inside an argument value (a filter on `…-${suffix}`) must be written as
    // `{{name}}` and listed in parameterizedParamIds, or the agent runs it with the literal text.
    const parameterizedIds: number[] = [];
    if (patchRecorded) {
      for (const [name, value] of Object.entries(patchRecorded)) {
        let out = value;
        if (s.runtimeParameters?.includes(name)) out = runtimeSlotValue(value);
        else if (s.stepType === 'database' && typeof value === 'string') {
          const bound = bindValueParams(value, paramIdByName, name);
          out = bound.value;
          for (const id of bound.ids) if (!parameterizedIds.includes(id)) parameterizedIds.push(id);
        }
        addByName(name, out, true);
      }
    }
    const objectParamIds: number[] = [...(s.sourceObjectParameterIds ?? [])];

    // ponytail: spread the round-tripped raw fields FIRST so control-flow / function / switch /
    // api / attachments / conditions / loop / functionId / fnVersionId / apiData / etc. all
    // survive. Explicit computed fields below override where they overlap.
    const rawBase = (s.sourceRaw ?? {}) as Record<string, unknown>;
    // An API step is only "action-less" when it is a real REQUEST. An API-technology step using a
    // generic action ("Store from JSON" etc.) has an actionId and no apiData — it must keep both.
    const apiRequestStep = isApiRequestStep({ stepType: s.stepType, api: s.api, sourceRaw: rawBase });
    const rawStepType = typeof rawBase['stepType'] === 'string' ? (rawBase['stepType'] as string) : undefined;
    // stepLevelActions: merge — keep any extra flags from source, our four win where they exist.
    const rawSLA = (rawBase['stepLevelActions'] as Record<string, unknown> | undefined) ?? {};

    // ponytail: wire stepType resolution ladder for FRESH steps (no sourceRaw):
    //   1. Round-trip sourceRaw.stepType wins if present (IF/FOR/FUNCTION preserved from DB)
    //   2. Function step → 'FUNCTION' | 'FUNCTION_END'
    //   3. Control-flow step → uppercase(controlFlow.kind) (e.g. "IF", "FOR_START", "WHILE")
    //   4. Everything else → 'NORMAL_STATEMENT'
    // This is what makes `add_step({stepType: 'control_flow', controlFlow: {kind: 'IF'}})` and
    // `add_step({stepType: 'function', functionCall: {testCaseId: '99'}})` actually work.
    let wireStepType = rawStepType;
    if (!wireStepType) {
      if (s.stepType === 'function') wireStepType = 'FUNCTION';
      else if (s.stepType === 'function_end') wireStepType = 'FUNCTION_END';
      // API steps carry the backend's dedicated wire type 'API' (NOT NORMAL_STATEMENT) — that is
      // what routes the row to the api-step-card and the api plugin at execution. Postman import
      // and the SQA UI both emit 'API'.
      else if (s.stepType === 'api') wireStepType = 'API';
      else if (s.stepType === 'control_flow' && s.controlFlow?.kind) wireStepType = String(s.controlFlow.kind).toUpperCase();
      // A TECHNOLOGY SWITCH is its own neutral kind (`stepType: 'switch'`, controlFlow.kind =
      // SWITCH_TO_API / _DB / _WEB / …). Without this branch it fell through to NORMAL_STATEMENT with
      // no action, so a hybrid save wrote a plain statement and execution died with
      // "Action.displayName() because action() is null" — the switch (and every step after it) never ran.
      else if (s.stepType === 'switch' && s.controlFlow?.kind) wireStepType = String(s.controlFlow.kind).toUpperCase();
      else wireStepType = 'NORMAL_STATEMENT';
    }

    // --- API step ------------------------------------------------------------------------------
    // An API step carries its whole request in `api` (neutral) / `apiData` (wire/round-trip) and
    // needs NO action or object binding — Postman import and the SQA UI both emit actionId:null.
    // The request's `{{name}}` tokens are rewritten to `{{<paramId>}}` (the form the editor
    // persists), and the substituted ids are registered so parameterIds/recordedParam — and hence
    // the default testdata iteration (ITR-1) — are populated at save by createTcFn.
    let apiData: Record<string, unknown> | undefined;
    let apiLastActiveTab: Record<string, unknown> | undefined;
    if (apiRequestStep) {
      const source = swapApiParams((s.api ?? (rawBase['apiData'] as Record<string, unknown> | undefined)) ?? {}, swapsApplied);
      const apiParams: Array<{ id: number; name: string }> = [];
      apiData = substituteApiParams(source, paramIdByName, apiParams) as Record<string, unknown>;
      // Always persist the FULL editor shape (requestStyle / query_params / headers / authorization /
      // body.data / arrays): a partial apiData makes the API popup throw on load/save.
      normalizeApiDataShape(apiData);
      // Persist assertions in the API-TC editor's shape (response.* / header key), not the
      // MCP live-request syntax ($.body.* / $.headers.*), so they render in the Assertions tab.
      if (apiData['assertions'] !== undefined) {
        apiData['assertions'] = normalizeApiAssertions(apiData['assertions']);
      }
      // Register the substituted ids AND seed each one's default value (tc.data / the recorder's
      // name-keyed recordedParam patches), so parameterIds + recordedParam are both populated and
      // createTcFn builds the default testdata iteration (ITR-1) for the request.
      for (const { id, name } of apiParams) {
        registerId(id);
        setValue(id, String(tc.data?.[name] ?? s.recordedParam?.[name] ?? ''), false);
      }
      if (apiParams.length || paramIds.length) {
        // A parameter the recording generated/stored at runtime MUST stay RUNTIME here. The API executor builds
        // its arguments from `apiData.inputParameters`; hard-coding LOCAL made it substitute the test-data
        // placeholder (e.g. "apivalue") instead of the runtime value, so a hybrid generate → store → API step
        // sent the wrong body even though the store step had stored the value correctly.
        const runtimeNames = new Set((s.runtimeParameters ?? []).map((n) => n.toLowerCase()));
        // ROUND-TRIP: an EDIT of an existing API step must keep the binding the database already has.
        // A hydrated step does not carry `runtimeParameters`, so without this an edit would downgrade a
        // RUNTIME parameter to LOCAL and break a working hybrid test case.
        const priorInput = new Map<number, Record<string, unknown>>();
        if (Array.isArray(apiData['inputParameters'])) {
          for (const raw of apiData['inputParameters'] as Array<Record<string, unknown>>) {
            const id = typeof raw['id'] === 'number' ? (raw['id'] as number) : Number(raw['id']);
            if (!Number.isFinite(id)) continue;
            priorInput.set(id, { ...raw, id });
          }
        }
        // id → name, so a parameter bound only through recordedParam / sourceParameterIds (not a
        // {{name}} token in the request) still appears in the popup's parameter list. The popup and
        // the executor read inputParameters, not parameterIds — leaving it out made the parameters
        // look missing even though the step had them.
        const nameById = new Map<number, string>();
        for (const [name, id] of paramIdByName) if (!nameById.has(id)) nameById.set(id, name);
        for (const p of apiParams) if (!nameById.has(p.id)) nameById.set(p.id, p.name);
        const boundIds = [...new Set([...paramIds, ...apiParams.map((p) => p.id)])];
        apiData['inputParameters'] = boundIds.map((id) => {
          const prev = priorInput.get(id);
          const name = prev && typeof prev['name'] === 'string' && prev['name']
            ? prev['name'] as string
            : (nameById.get(id) ?? String(id));
          // The parameter catalog is authoritative: if it is a RUNTIME parameter, the executor must
          // take its value from the runtime store. Recording used to save it as LOCAL, so the first
          // run sent the record-time literal for step 3 (only a later UI save corrected it).
          const catalogRuntime = (paramAccessById?.get(id) ?? '').toUpperCase() === 'RUNTIME';
          const isRuntime = catalogRuntime || runtimeNames.has(name.toLowerCase());
          // Existing LOCAL entry: keep it byte-for-byte (round-trip). A RUNTIME one is upgraded.
          if (prev) return isRuntime ? { ...prev, parameterAccessType: 'RUNTIME' } : prev;
          return {
            id,
            name,
            parameterAccessType: isRuntime ? 'RUNTIME' : 'LOCAL',
            parameterDataType: 'ALPHANUMERIC',
            // Required by the executor's runtime branch: Parameter.runtimeParameterKey() is dereferenced
            // without a null check, and a missing field made the run die with an NPE.
            runtimeParameterKey: 'NONE',
          };
        });
      }
      apiLastActiveTab = { mainTab: 'body', subTab: API_BODY_SUBTAB[apiBodyType(apiData) ?? ''] ?? 'NONE' };
    }

    // FUNCTION step: derive functionId + fnVersionId from neutral functionCall when no sourceRaw
    // (LLM authored a fresh function-call step via add_step).
    // The database keeps a function call as numeric ids (functionId / fnVersionId / sharedFnProjectId); the neutral
    // functionCall is what a prompt edits, and it is the up-to-date one (a hydrated step carries both and they agree).
    // So functionCall wins over the round-tripped raw copy — otherwise "call a different function" is silently ignored —
    // and a business code like "FN_12" is turned into its id, never into NaN (which dropped the binding).
    const rawFnId = typeof rawBase['functionId'] === 'number' ? rawBase['functionId'] as number : undefined;
    const rawFnVersion = typeof rawBase['fnVersionId'] === 'string' ? rawBase['fnVersionId'] as string : undefined;
    const callId = s.functionCall?.testCaseId ? Number.parseInt(numericId(s.functionCall.testCaseId), 10) : undefined;
    if (s.functionCall?.testCaseId && !Number.isFinite(callId)) {
      throw new Error(`Step ${i + 1}: function "${s.functionCall.testCaseId}" is not a function id or code (e.g. 12 or FN_12).`);
    }
    const wireFunctionId = callId ?? rawFnId;
    const wireFnVersionId = s.functionCall?.versionId ?? rawFnVersion;
    if (callId !== undefined && rawFnId !== undefined && callId !== rawFnId && wireFnVersionId === rawFnVersion && rawFnVersion) {
      throw new Error(
        `Step ${i + 1}: the function was changed from ${rawFnId} to ${callId} but functionCall.versionId still points at the old ` +
        `function's version. Pass functionCall.versionId = a version id of function ${callId} (its newest version).`,
      );
    }
    const wireSharedFnProjectId = (s.functionCall?.sharedProjectId ? Number.parseInt(numericId(s.functionCall.sharedProjectId), 10) : undefined)
      ?? (typeof rawBase['sharedFnProjectId'] === 'number' ? rawBase['sharedFnProjectId'] as number : undefined);

    // Control-flow step: derive conditions.ifstring + loopDuration from neutral controlFlow.
    const wireConditions = rawBase['conditions']
      ?? (s.controlFlow?.conditionText ? { ifstring: s.controlFlow.conditionText, children: [] as unknown[] } : { ifstring: '', children: [] as unknown[] });
    const wireLoopDuration = (typeof rawBase['loopDuration'] === 'number' ? rawBase['loopDuration'] as number : undefined)
      // SimplifyQA has no per-step maximum for a WHILE / DO-WHILE (the agent applies one global loop limit), so a requested
      // maxIterations is not written as if it did something — the save's lint says so.
      ?? (['WHILE_START', 'WHILE_END', 'WHILE', 'DO'].includes(String(wireStepType).toUpperCase()) ? undefined : s.controlFlow?.maxIterations);
    const step: Record<string, unknown> = {
      ...rawBase,
      // ponytail: `deleted` is required on UPDATE and REJECTED on CREATE by the backend validator
      // (steps.automationSteps[*].deleted) — emit it only when updating, mirroring tcfnObj above.
      ...(existingId ? { deleted: false } : {}),
      // ponytail: pass through the backend step uuid on round-trip. Without `id`, every step
      // routes to tcfn.service.js:355 CREATE branch, mints a new uuid, orphans the original row.
      ...(s.sourceId ? { id: s.sourceId } : {}),
      // ponytail: parentId + versionId REQUIRED on update — tcfn.service.js:406 builds the update
      // filter `{id, customerId, projectId, parentId, type}` and without parentId it becomes
      // `{parentId: undefined}` → misses the existing row → upsert inserts a new orphan step
      // with no parentId. UI query `{parentId: tcId, versionId, deleted:false}` then finds nothing.
      ...(existingId ? { parentId: Number.parseInt(existingId, 10) } : {}),
      ...(existingId && curVer.id ? { versionId: curVer.id } : {}),
      projectId,
      // Only emit actionId/objectId for steps that resolve to an action (straight-line automation).
      // Control-flow / function / switch steps have no action; the sourceRaw spread carries their
      // functionId / conditions / loop instead.
      ...(resolution && resolution.actionId != null
        ? {
            actionId: resolution.actionId,
            // ponytail: undefined objectId means "preserve DB value" (existing step with no round-trip
            // objectRef.id). null is a valid emitted value (fresh step where the action doesn't need one).
            objectId: resolution.objectId === undefined ? null : resolution.objectId,
          }
        : {}),
      // API step: emit the explicit action-less shape the backend/api-card expects (Postman import
      // sets both to null), plus the request payload and the editor's active-tab hint.
      ...(apiRequestStep ? { actionId: null, objectId: null } : {}),
      ...(apiData ? { apiData } : {}),
      ...(apiLastActiveTab ? { lastActiveTab: apiLastActiveTab } : {}),
      // Round-tripped attachments (source) preserved via spread above; default to [] if fresh.
      attachments: Array.isArray(rawBase['attachments']) ? (rawBase['attachments'] as unknown[]) : ([] as unknown[]),
      conditions: wireConditions,
      description: normalizeParamTokens(descNow) ?? '',
      executionType: 'AUTOMATION',
      expectedResult: normalizeParamTokens(s.expectedResult ?? '') ?? '',
      loop: (rawBase['loop'] as unknown) ?? { loopType: 'for', loopIteration: null as number | null },
      ...(wireLoopDuration !== undefined ? { loopDuration: wireLoopDuration } : {}),
      moduleId,
      // Function-call fields — emitted only for FUNCTION steps (rawBase spread already carries
      // them for round-tripped functions; these derivations cover fresh add_step callers).
      ...(wireFunctionId !== undefined && Number.isFinite(wireFunctionId) ? { functionId: wireFunctionId } : {}),
      ...(wireFnVersionId ? { fnVersionId: wireFnVersionId } : {}),
      ...(wireSharedFnProjectId !== undefined && Number.isFinite(wireSharedFnProjectId) ? { sharedFnProjectId: wireSharedFnProjectId } : {}),
      objectParameterIds: objectParamIds,
      // a browser set (or changed) through the prompt wins; otherwise the round-tripped one from rawBase stands
      ...(s.browserType ? { browserType: s.browserType } : {}),
      // ponytail: always emit — matches UI payload shape. Sending `[]` / `{}` is how UI signals
      // "this step has no params/values"; the joi validator + backend $set semantics assume presence.
      parameterIds: paramIds,
      ...(parameterizedIds.length || swapsApplied.length
        ? { parameterizedParamIds: [...new Set([...swappedParameterized, ...parameterizedIds])] }
        : {}),
      recordedParam: recordedParamOut,
      seq: i + 1,
      stepLevelActions: {
        ...rawSLA,
        skip: s.flags?.skip ?? rawSLA['skip'] ?? false,
        captureScreenshot: s.flags?.screenshot ?? rawSLA['captureScreenshot'] ?? false,
        continueOnFailure: s.flags?.continueOnFailure ?? rawSLA['continueOnFailure'] ?? false,
        skippedReport: rawSLA['skippedReport'] ?? false,
      },
      // Wire stepType: sourceRaw wins on round-trip; for fresh steps, translated from neutral
      // stepType + controlFlow.kind + function marker (see wireStepType computation above).
      stepType: wireStepType,
      technologyType,
      type: 'TC',
    };
    automationSteps.push(step);
  });

  return {
    tcfnObj: withSavedTcFields(tcfnObj, tc),
    versionsDetails,
    steps: { automationSteps, manualSteps: [] as unknown[] },
    operation: 'TC',
    type: 'TC',
  };
}

/** Neutral SavedRef from a POST/PUT /tm/testcase response. Tolerates a bare doc or a `data`-wrapped
 *  response; prefers the business `code` (TC_xxx) for productUrl deep links but uses the numeric id
 *  when only that is present. */
export function toSavedRef(raw: any, created: boolean): SavedRef {
  const flat = (raw?.data ?? raw) ?? {};
  const id = str(flat, 'id', '_id', 'testcaseId') ?? '';
  return {
    id,
    created,
  };
}

// ---------------------------------------------------------------------------
// Suites (write). The update PUT reshapes the members list under a strict
// allow-list; anything else on the raw doc is rejected. Shared helpers are:
//   • normalizeSuiteEntry — copy an existing members[] row into the allow-list.
//   • Adapter builds each ADD entry by fetching the target TC, so those helpers
//     stay in the adapter (they need IO).
// ---------------------------------------------------------------------------

/** Copy an existing suite testCases[] row into the strict allow-list; drop `id`, audit fields, etc. */
export function normalizeSuiteEntry(m: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keep = ['testcaseId', 'code', 'seq', 'stepId', 'version', 'versionId', 'tcType', 'projectId', 'executionPlatform'];
  for (const k of keep) if (m?.[k] !== undefined) out[k] = m[k];
  return out;
}

/** The 15+ allow-listed suite-level keys the update validator accepts. */
export const SUITE_UPDATE_ALLOWED_KEYS: readonly string[] = [
  'id', 'name', 'description', 'state', 'suiteType', 'projectId', 'autoDefectLog',
  'autoReExecCount', 'autoReExecTriggerOn', 'newBrowserSession', 'terminateOnFailure',
  'minimumContainerCount', 'maximumContainerCount', 'copySuiteName', 'copiedFrom',
  'mailersList', 'tags', 'customFields', 'agentId', 'cloudAgentId',
  'lastSelectedExecutionType', 'updateVersion',
];

