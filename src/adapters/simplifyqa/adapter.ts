import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConnectedQaConfig } from '../../config.js';
import type { MakeClientOptions, QaHttp } from '../http.js';
import { ApiError, makeClient } from '../http.js';
import type { ListResult, ProjectInfo, ProjectPrivileges } from '../types.js';
import type {
  ActionDef, CloudRunner, CopyTestdataResult, DatasetInfo, DefaultIteration, DefectQuery, DefectSummary, EntityRef,
  EnvInfo, Epic, EpicInput, EpicQuery, EpicSummary, EpicUpdate,
  Feature, FeatureInput, FeatureQuery, FeatureSummary, FeatureUpdate,
  Formula, FormulaCall, FunctionQuery, FunctionSummary, QaFunction, JournalOp, JournalView,
  LocalAgent, Locator, MemberOp, MobileDevice, ModuleCreateInput, ModuleDeleteResult, ModuleDependency,
  ModuleDetail, ModuleSaved, ModuleSummary, ModuleTreeInput, ModuleUpdateInput, ObjectQuery,
  ProjectSummary, QaObject, ReleaseQuery,
  ReleaseSummary, RunOptions, RunRef, RunStatus, RunTarget, SaveGeneratedIterations,
  SaveGeneratedIterationsResult, SavedRef, SprintQuery, SprintSummary,
  BacklogDeleteResult, BacklogKind, ReportFile, ReportKind, Step, Story, StoryInput, StoryQuery, StorySummary, StoryUpdate,
  Suite, SuiteSummary, TaskQuery, TaskSummary, TcQuery, TcSummary, TestCase, UserQuery,
  UserSummary, VersionDeleteInput, VersionDeleteResult, TcVersionDep, FnVersionDep,
  ScheduleAction, ScheduleInfo, ScheduleOptions, ScheduleRef, ScheduleUpdate,
  TestdataIterationRow, TestdataRows,
} from '../../domain/types.js';
import { RemoteMcpAdapter } from '../remoteMcp/adapter.js';
import { atLeast, findRuns, isPlainStep, pickNonOverlapping, type FnCandidate, type MinConfidence } from './functionMatch.js';
import { resolveValuesFromEnv, SqaSearchEngine, type SqaQueryRequest, type SqaQueryResult, type SqaWhere } from './searchEngine.js';
import { apiFailureReason } from './apiFailureReason.js';
import { buildDesktopConditionRows, seedDesktopConditionOperands } from './desktopConditions.js';
import { apiTransportFailure, dbFailureHint, emptyReadWarning, unresolvedPlaceholders } from './stepDiagnostics.js';
import { duplicateSteps } from '../../drafts/duplicate.js';
import { mergeApiPatch } from '../../drafts/apiPatch.js';
import { matchStepNumbers } from '../../drafts/bulk.js';
import { resolveCollection } from './searchRegistry.js';
import { ExecutionFailureAnalysis, fetchFailureImage } from './executionFailures.js';
import { failureImages, renderExecution } from './failureReport.js';
import { log } from '../../log.js';
import type { HealApplyMode, HealPlan, HealProposeInput, HealReport } from '../../domain/heal.js';
import { applyHealPlan as applyHealPlanCore, type HealApplyDeps, type HealTestDataPatch } from './heal/apply.js';
import type { HealFacts, HealObjectFact } from './heal/plan.js';
import {
  applyCollectionSteps, buildTestcasePayload, deriveTcType, extractApiParamNames, extractParamNames, extractValueParamNames, fromSqaStep, isApiRequestStep, runtimeSlotValue,
  looksSensitive, normalizeSuiteEntry, notDeleted, numericId, paramDefault, pickArray, str,
  SUITE_UPDATE_ALLOWED_KEYS, TECH_BY_STEPTYPE,
  toDefectSummary, toEpic, toEpicSummary, toFeature, toFeatureSummary,
  toFunction, toFunctionSummary, toModuleSaved, toModuleSummary, toObject, toImageUrl, toReleaseSummary,
  toSavedRef, toSprintSummary, toStory, toStorySummary, toSuite, toSuiteSummary, toTaskSummary,
  toTcSummary, toTestCase, toVersionEntries, withTotal,
} from './mapper.js';

/** Test seam identical to WalnutAdapter's — swap transport, keep real headers. */
export type SimplifyQaTransport = Pick<MakeClientOptions, 'fetchImpl' | 'FormDataImpl' | 'BlobImpl'>;

/** A DESKTOP save reuses only DESKTOP objects. Matching by name alone merged desktop locators into an iOS object
 *  that happened to share the name ("Login"); a new DESKTOP object is created instead. Every other technology
 *  keeps matching by name alone. */
function reusableFor(technology: string, c: { objectType?: string | undefined }): boolean {
  return technology.toUpperCase() !== 'DESKTOP' || (c.objectType ?? '').toUpperCase() === 'DESKTOP';
}

/** `candidate` is `name` as the backend stores a clashing name: "<name>_<n>" (compared case-insensitively). */
function isSuffixedName(candidate: string, name: string): boolean {
  const c = candidate.trim().toLowerCase();
  const n = name.toLowerCase();
  return c.startsWith(`${n}_`) && /^\d+$/.test(c.slice(n.length + 1));
}


/** Normalise an action name/display name for punctuation- and space-insensitive matching
 *  ("Store from JSON" / "StoreFromJSON" / "store-from-json" all → "storefromjson"). */
function actionNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** True when both locator lists hold the same name/value pairs AND the same default (`unique`) locator.
 *  `unique` is only compared when the incoming list flags one — an omitted flag means "leave as is". */
function sameLocatorSet(
  existing: ReadonlyArray<{ name: string; value: string; unique?: boolean | undefined }>,
  incoming: ReadonlyArray<{ name: string; value: string; unique?: boolean | undefined }>,
): boolean {
  const key = (l: { name: string; value: string }) => `${l.name}::${l.value}`;
  const existingKeys = new Set(existing.map(key));
  const incomingKeys = new Set(incoming.map(key));
  if (existingKeys.size !== incomingKeys.size || ![...existingKeys].every((k) => incomingKeys.has(k))) return false;
  const incomingDefault = incoming.find((l) => l.unique === true);
  if (!incomingDefault) return true;
  const existingDefault = existing.find((l) => l.unique === true);
  return existingDefault?.name === incomingDefault.name && existingDefault.value === incomingDefault.value
    && existing.filter((l) => l.unique === true).length === 1;
}

/** DESKTOP (plan.md P7): the same name/value pairs AND the same `unique` flags. An older object whose Xpath is flagged
 *  unique is never reused for a P7 set that flags nothing: the plugin would search only that one locator. */
function sameDesktopLocators(
  existing: ReadonlyArray<{ name: string; value: string; unique?: boolean | undefined }>,
  incoming: ReadonlyArray<{ name: string; value: string; unique?: boolean | undefined }>,
): boolean {
  if (!sameLocatorSet(existing, incoming)) return false;
  const flagged = (ls: ReadonlyArray<{ name: string; value: string; unique?: boolean | undefined }>) =>
    ls.filter((l) => l.unique === true).map((l) => `${l.name}::${l.value}`).sort().join('\n');
  return flagged(existing) === flagged(incoming);
}

/** SQA run-row status → neutral RunStatus.state. */
/** SQA cloud container type. The UI sends the chosen cloud machine's type; VM is the default when
 *  the runner row carried none. Anything else would be rejected by the execution validator. */
function normalizeCloudType(v?: string): 'VM' | 'AZURE' | 'KUBERNETES' {
  const t = (v ?? '').toUpperCase();
  return t === 'AZURE' || t === 'KUBERNETES' || t === 'VM' ? t : 'VM';
}

function mapRunState(s: string): RunStatus['state'] {
  switch (s.toUpperCase()) {
    case 'PASSED': return 'passed';
    case 'FAILED': return 'failed';
    case 'SKIPPED': return 'skipped';
    case 'NOTEXECUTED': return 'notExecuted';
    case 'STOPPED': return 'stopped';
    case 'ERROR': return 'error';
    case 'RUNNING':
    case 'INPROGRESS': return 'running';
    case 'QUEUED': return 'queued';
    case '': return 'queued'; // no status yet assigned — genuinely not started
    default: return 'error';
  }
}

/** Formula names round-trip with parens on ("FIRST_NAME()") from the backend and sometimes with a full
 *  signature ("FIRST_NAME(country,sex)") from a caller. Reduce both to the bare identifier. */
function bareFormulaName(s: string): string {
  return s.replace(/\s*\(.*\)\s*$/, '').trim();
}

/**
 * Normalise a formula expression to the engine's CANONICAL form, where EVERY function call — including
 * nested ones — is prefixed with `=`. The agent's parser (`FormulaNodeConverter`) only matches `=FUNC(...)`,
 * and that is also what the UI's formula builder stores (`FormulaNode.toString()` emits `=` on every node).
 * Callers (and the AI) naturally write Excel-style nesting WITHOUT the inner `=` — e.g.
 * `=CONCATENATE(ALPHABET(3),NUMERIC(3))` — which the engine rejects ("No valid function found") and which,
 * when stored, breaks the Test Data UI + execution. This rewrites it to
 * `=CONCATENATE(=ALPHABET(3),=NUMERIC(3))`.
 *
 * Only an identifier directly followed by `(` becomes a function (so bare words and `{{paramId}}` refs are
 * untouched), and content inside double quotes is left verbatim (so string literals like
 * `CONCATENATE("Total(x)")` are not mangled). A function that already has a leading `=` is not doubled.
 */
export function normalizeFormulaExpression(expr: string): string {
  if (!expr || typeof expr !== 'string') return expr;
  const s = expr.trim();
  let out = '';
  let inQuote = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (inQuote) {
      out += ch;
      if (ch === '\\' && i + 1 < s.length) { out += s[i + 1]; i += 2; continue; }
      if (ch === '"') inQuote = false;
      i++;
      continue;
    }
    if (ch === '"') { inQuote = true; out += ch; i++; continue; }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j]!)) j++;
      let k = j;
      while (k < s.length && /\s/.test(s[k]!)) k++;
      if (k < s.length && s[k] === '(') {
        // identifier directly followed by `(` → a function call; ensure a single leading `=`.
        if (out.replace(/\s+$/, '').slice(-1) !== '=') out += '=';
      }
      out += s.slice(i, j);
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** The engine matches function names CASE-SENSITIVELY against its enum ("CONCATENATE"), while a
 *  recorder / AI naturally writes "concatenate" or "First_Name" — which the engine rejects with
 *  "No valid function found". Rewrite every `name(` to the canonical spelling; quoted text is left
 *  untouched and unknown names are left as written (the validity check below reports them). */
export function canonicalizeFormulaNames(expr: string, knownUpper: ReadonlySet<string>): string {
  let out = '';
  let inQuote = false;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (inQuote) {
      out += ch;
      if (ch === '\\' && i + 1 < expr.length) { out += expr[++i]!; continue; }
      if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') { inQuote = true; out += ch; continue; }
    if (!/[A-Za-z_]/.test(ch)) { out += ch; continue; }
    let j = i;
    while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j]!)) j++;
    const word = expr.slice(i, j);
    const upper = word.toUpperCase();
    out += expr[j] === '(' && knownUpper.has(upper) ? upper : word;
    i = j - 1;
  }
  return out;
}

/** The backend catalog declares some engine formulas with NO parameters, so a model guesses the
 *  arguments (the classic `=TODAY(ddmmyyyy)`). Fill in what the ENGINE accepts — only for blank
 *  entries, so a real backend/custom definition always wins. */
export function withEngineArgHints(f: Formula): Formula {
  const bare = f.name.replace(/\s*\(.*\)\s*$/, '').trim().toUpperCase();
  if ((f.parameters ?? []).some((p) => p.keyName.trim() !== '')) return f;
  if (bare === 'TODAY') {
    return { ...f, signature: 'TODAY("d+365")',
      details: "Today's date as dd/MM/yyyy. Optional offset given as a QUOTED string: unit d|m|y + operation +|- + amount. "
        + 'Examples: "d+365" (a year ahead), "m-1" (a month back), "y+2". No bare words like ddmmyyyy.',
      example: '=TODAY("d+365") returns today + 365 days.',
      parameters: [{ keyName: 'offset', description: 'Quoted offset string, e.g. "d+365" / "m-1" / "y+2". Omit for today.' }] };
  }
  if (bare === 'NOW') {
    return { ...f, signature: 'NOW()', details: 'Current date and time based on the system format. Takes no arguments.',
      example: '=NOW()', parameters: [] };
  }
  return f;
}

/** FALLBACK ONLY. Formulas are evaluated by the agent's formula engine (`POST /formula/convert`) — the same one the
 *  UI and the executor use, so every catalog formula works with no list kept here. This table and the set below
 *  describe the smaller backend route `/tm/customFormula`, used solely when the agent cannot be reached.
 *
 *  Query keys /tm/customFormula expects per formula, positionally — they are NOT the formula's declared
 *  keyNames. Mirrors the SQA UI (wfTestdataView.ts). Anything absent takes at most one arg as `value`. */
const FORMULA_ARG_KEYS: Record<string, string[]> = {
  FIRST_NAME: ['country', 'sex', 'min_len', 'max_len'],
  LAST_NAME: ['country', 'sex', 'min_len', 'max_len'],
  FULL_NAME: ['country', 'sex', 'min_len', 'max_len'],
  MIDDLE_NAME: ['country', 'sex', 'min_len', 'max_len'],
  PREFIX: ['sex'],
  DATE_OF_BIRTH: ['pattern', 'min_age', 'max_age'],
};

/**
 * The authoritative set of formula names the AGENT's engine (`FunctionType` / `FunctionFactory`) can evaluate —
 * including aliases. This is the single source of truth for "is this a real formula", so the recorder/AI can
 * only use formulas that actually exist and cannot invent one (e.g. the hallucinated `RANDOM_NAME()`). It is a
 * static mirror of the Java enum (low-churn); PROJECT/CUSTOM formulas are added at validation time from the
 * live backend list, and any `CUSTOM_*` name is allowed by prefix.
 */
const ENGINE_FORMULA_NAMES = new Set<string>([
  // arithmetic
  'SUM', 'SUBTRACT', 'MULTIPLY', 'MODULUS', 'MOD', 'MAX', 'MIN', 'DIVISION', 'DIV', 'AVERAGE',
  // text
  'CONCATENATE', 'CONCAT', 'LEFT', 'RIGHT', 'MID', 'LOWER', 'UPPER', 'PROPER', 'SPLIT', 'REPLACE', 'REPEAT', 'LENGTH',
  // random / id
  'NUMERIC', 'NUMBER', 'ALPHA_NUMERIC', 'ALPHABET', 'ALPHABETS', 'UUID', 'PICK_RANDOM', 'FLIP',
  // date / time
  'NOW', 'TODAY', 'DAY', 'MONTH', 'YEAR', 'TIME', 'HOUR', 'MINUTE', 'SECOND', 'FORMAT_DATE', 'FORMAT_TIME', 'DAY_OF_WEEK',
  // logic / comparison
  'CONTAINS', 'EQUALS', 'EQ', 'EQUALS_IGNORE_CASE', 'EQIGNC', 'GREATER_THAN_EQUALS', 'GTE', 'GREATER_THAN', 'GT',
  'LESS_THAN_EQUALS', 'LTE', 'LESS_THAN', 'LT', 'NOT_EQUALS', 'NEQ', 'EMPTY', 'BLANK', 'IF_ELSE',
  // synthetic / person
  'CREDIT_CARD_CVV', 'CREDIT_CARD_NUMBER', 'CREDIT_CARD_EXPIRY', 'CURRENCY_CODE', 'CURRENCY_NAME', 'CURRENCY_SYMBOL',
  'FIRST_NAME', 'LAST_NAME', 'FULL_NAME', 'MIDDLE_NAME', 'PREFIX', 'GENDER', 'PHONE_NUMBER', 'DATE_OF_BIRTH',
  'COUNTRY_NAME', 'COUNTRY_CODE', 'STATE', 'CITY', 'STREET', 'ADDRESS', 'TIMEZONE', 'ZIPCODE', 'EMAIL', 'EMAIL_ID',
  // excel / misc
  'READ_FROM_EXCEL', 'READ_CELL', 'READ_ROW', 'READ_COLUMN', 'ONCE', 'USER_PREFERENCE',
]);

/** Extract every function name (an identifier directly followed by `(`) from a formula expression, skipping
 *  content inside double quotes so string literals like `"Total(x)"` are not treated as calls. */
export function extractFunctionNames(expr: string): string[] {
  if (!expr) return [];
  const names: string[] = [];
  let inQuote = false;
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i]!;
    if (inQuote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') inQuote = false;
      i++; continue;
    }
    if (ch === '"') { inQuote = true; i++; continue; }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j]!)) j++;
      let k = j;
      while (k < expr.length && /\s/.test(expr[k]!)) k++;
      if (expr[k] === '(') names.push(expr.slice(i, j));
      i = j; continue;
    }
    i++;
  }
  return names;
}

/** True when `name` is a real formula: a built-in engine function, a `CUSTOM_*`, or a live backend/project
 *  formula (passed in as an upper-cased set). */
function isKnownFormula(name: string, backendUpper: Set<string>): boolean {
  const u = name.toUpperCase();
  return ENGINE_FORMULA_NAMES.has(u) || u.startsWith('CUSTOM_') || backendUpper.has(u);
}

/** Build a "did you mean" hint for an unknown formula name against the known set. */
function nearFormulaNames(name: string, known: string[]): string[] {
  const core = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const near = known.filter((n) => {
    const c = n.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return c.includes(core) || core.includes(c) || (core.length > 3 && c.startsWith(core.slice(0, 4)));
  });
  return [...new Set(near)].slice(0, 6);
}

/** The formulas backend `/tm/customFormula` answers (customFormula.controller.js). Any other formulaName gets NO
 *  response from that route, so it is only ever used for these, and only when the agent cannot be reached. */
const LEGACY_ROUTE_FORMULAS = new Set([
  'CREDIT_CARD_CVV', 'CREDIT_CARD_NUMBER', 'CURRENCY_CODE', 'CURRENCY_NAME', 'CURRENCY_SYMBOL',
  'FIRST_NAME', 'LAST_NAME', 'FULL_NAME', 'MIDDLE_NAME', 'PREFIX', 'PHONE_NUMBER', 'COUNTRY_CODE', 'TIMEZONE',
  'ADDRESS', 'STREET', 'CITY', 'STATE', 'ZIPCODE', 'DATE_OF_BIRTH', 'COUNTRY_NAME',
]);

/** Normalise a formula document from `/tm/syncFormulas/fetch` into the neutral Formula shape. Returns
 *  null when the doc is missing a name — a nameless formula cannot be called. `scope` is inferred:
 *  DEFAULT → 'default'; CUSTOM with a matching projectId → 'project'; CUSTOM otherwise → 'customer'. */
function normalizeFormula(doc: any, projectId: number): Formula | null {
  if (!doc || typeof doc !== 'object') return null;
  const name = str(doc, 'name');
  if (!name) return null;
  const type: 'DEFAULT' | 'CUSTOM' = str(doc, 'type') === 'CUSTOM' ? 'CUSTOM' : 'DEFAULT';
  const docPid = Number(doc.projectId ?? 0);
  const scope: Formula['scope'] =
    type === 'DEFAULT' ? 'default' : docPid && docPid === projectId ? 'project' : 'customer';
  const desc = (doc.description && typeof doc.description === 'object') ? doc.description : {};
  const params: Formula['parameters'] = Array.isArray(desc.parameters)
    ? desc.parameters
        .map((p: any) => (p && typeof p === 'object' && typeof p.keyName === 'string')
          ? { keyName: p.keyName, description: str(p, 'value', 'description') ?? undefined, dataType: str(p, 'dataType') ?? undefined }
          : null)
        .filter((p: any): p is Formula['parameters'][number] => p !== null)
    : [];
  return {
    name,
    uniqueId: str(doc, 'uniqueId') ?? name,
    type,
    scope,
    signature: str(desc, 'name') ?? `${name}()`,
    details: str(desc, 'details') ?? undefined,
    example: str(desc, 'example') ?? undefined,
    parameters: params,
  };
}

/** SQA per-step status → neutral step status. Matches RunState terminals ('passed'/'failed'/
 *  'skipped'/'stopped') so the same icon/formatting logic works for top-level state AND per-step
 *  rows (run.tools.ts:180 keys off these values — the earlier 'pass'/'fail' names left every
 *  step icon defaulting to '•'). Non-terminal SQA states (INFO, INPROGRESS, NOTEXECUTED) pass
 *  through lowercased so the tool can still surface them as diagnostic text. */
function mapStepStatus(s: string): string {
  switch (s.toUpperCase()) {
    case 'PASSED': return 'passed';
    case 'FAILED': return 'failed';
    case 'SKIPPED': return 'skipped';
    case 'STOPPED': return 'stopped';
    default: return s.toLowerCase();
  }
}

/** Allowed keys for save-as-new-version. The update joi validator
 *  (testcaseValidator.js updateTcBodyValidation, ~line 187) is a STRICT allow-list — a raw doc's
 *  extras (`code`, `createdBy`, `updatedBy`, `stepCount`, `versions`, ...) crash the save with
 *  "is not allowed". Kept as string arrays so a schema drift is a one-line fix. */
const TCFNOBJ_ALLOWED_KEYS = [
  'id', 'name', 'projectId', 'deleted', 'moduleId', 'userstoryId', 'obsolete', 'tcType', 'mbType',
  'executionType', 'description', 'prerequisite', 'updateVersion', 'linkedIssues', 'attachments',
  'tags', 'suiteId', 'defectId', 'customFields', 'reviewApproveStatus', 'copiedFromTcId',
  'projectLevelCopy', 'originalExecutinType', 'projectLevelcopiedFrom', 'mailersList',
  'configuration', 'executionPlatform',
] as const;

// FN update validator (functionValidator.js `updateFnBodyValidation.tcfnObj`) diverges from the TC
// one in three ways that MATTER for SAVENEWVERSION: `fnType` REQUIRED (not `tcType`);
// `obsolete`/`suiteId`/`defectId`/`configuration`/`executionPlatform`/`tcType`/`mbType` NOT
// allowed; `copiedFromFnId` in place of `copiedFromTcId`. Sending TC's list to `/tm/function`
// trips joi with "not allowed" on obsolete and "required" on fnType.
const TCFNOBJ_FN_ALLOWED_KEYS = [
  'id', 'name', 'projectId', 'deleted', 'moduleId', 'userstoryId', 'fnType',
  'executionType', 'description', 'prerequisite', 'updateVersion', 'linkedIssues', 'attachments',
  'tags', 'customFields', 'reviewApproveStatus', 'copiedFromFnId', 'projectLevelCopy',
  'projectLevelcopiedFrom', 'mailersList', 'originalExecutinType', 'isMigrated', 'oldCode',
] as const;

// The editable fields of each backlog item — the SAME set the UI's epic/feature/story form sends
// when it saves (and therefore when it uploads the attachments picked in that form). An attachment
// upload has to re-save the item, so the PUT must carry these, not the whole raw document.
const EPIC_FORM_KEYS = [
  'name', 'projectIds', 'state', 'tags', 'ownerId', 'plannedStartDate', 'plannedEndDate',
  'actualStartDate', 'actualEndDate', 'estimatedEffort', 'actualEffort', 'remainingEffort',
  'description', 'customFields', 'linkedIssues', 'mailersList', 'plannedBudget', 'achievedStoryCount',
  'teamId', 'subProjectId', 'azureId', 'azureUrl', 'jiraIssueId', 'jiraIssueKey', 'jiraIssueLink',
] as const;
const FEATURE_FORM_KEYS = [
  'name', 'epicId', 'projectIds', 'ownerId', 'state', 'estimatedEffort', 'actualEffort',
  'remainingEffort', 'plannedStartDate', 'plannedEndDate', 'actualStartDate', 'actualEndDate',
  'description', 'priority', 'customFields', 'linkedIssues', 'tags', 'mailersList', 'teamId',
  'subProjectId', 'azureId', 'azureUrl', 'jiraIssueId', 'jiraIssueKey', 'jiraIssueLink',
] as const;
const STORY_FORM_KEYS = [
  'name', 'ownerId', 'epicId', 'featureId', 'type', 'moduleId', 'associatedUserStory',
  'impactedUserStory', 'estimatedEffort', 'actualEffort', 'remainingEffort', 'state', 'releaseId',
  'iterationId', 'deploymentStatus', 'plannedDeploymentDate', 'plannedStartDate', 'plannedEndDate',
  'actualDeploymentDate', 'description', 'acceptanceCriteria', 'customFields', 'priority',
  'linkedIssues', 'tags', 'teamId', 'mailersList', 'subProjectId', 'versionId', 'azureId', 'azureUrl',
  'jiraIssueId', 'jiraIssueKey', 'jiraIssueLink',
] as const;
const BACKLOG_ATTACHMENT_SPECS = {
  epic: { path: '/pm/epic', objKey: 'epicObj', parentType: 'EP', keys: EPIC_FORM_KEYS },
  feature: { path: '/pm/feature', objKey: 'featureObj', parentType: 'FT', keys: FEATURE_FORM_KEYS },
  userstory: { path: '/pm/userstory', objKey: 'userstoryObj', parentType: 'US', keys: STORY_FORM_KEYS },
} as const;

const STEP_ALLOWED_KEYS = [  'projectId', 'sharedFnProjectId', 'moduleId', 'apiData', 'lastActiveTab', 'userstoryId',
  'updateVersion', 'type', 'parentId', 'objectId', 'stepType', 'functionId', 'actionId',
  'parameterIds', 'objectParameterIds', 'parameterizedParamIds', 'attachments', 'compareFiles',
  'compareFileType', 'deviceId', 'deleted', 'ignoreObject', 'browserType', 'technologyType', 'seq',
  'captureScreenshot', 'screenshotEnabled', 'fnVersionId', 'description', 'expectedResult',
  'conditions', 'stepLevelActions', 'skipParamInReport', 'paramLoopduration', 'showGroups',
  'isConditional', 'if', 'else', 'loop', 'isLoop', 'loopType', 'startFor', 'endFor',
  'loopDuration', 'executionType', 'switchToAndroidData', 'switchToIOSData',
  'isDebug', 'manualStepsTopreview', 'sharedFnProjectName', 'isMigrated', 'customFields',
  // ponytail: id / versionId are in the schema but always stripped for SAVENEWVERSION — the
  // backend re-assigns them to the fresh version row, and keeping the old id would resurrect it.
  // ponytail: recordedParam is intentionally dropped — the FE clears it on every save-as-new
  // (testcase.component.ts:1370 `if (shouldClearRecordedParam) step.recordedParam = {}`) so the
  // backend's prepareDataObjet doesn't burn recorded values into fresh ITR-1 rows. MCP has no
  // recording flow, so nothing needs it kept.
] as const;

function pick(obj: any, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** Guard against feeding an FN business key into a TC-only endpoint (or vice-versa). `numericId`
 *  strips ANY alpha prefix — so "FN-22" → "22" and would silently target TC-22 if the caller
 *  routed to the wrong tool. Reject any business key whose prefix doesn't match the expected
 *  entity kind. Numeric ids and unrecognized-prefix strings pass through (leave that to backend). */
function assertBusinessKeyKind(id: string, expected: 'TC' | 'FN'): void {
  const m = id?.match(/^([A-Za-z]+)[_-]\d+$/);
  if (!m) return;
  const prefix = m[1]!.toUpperCase();
  if ((expected === 'TC' && prefix === 'FN') || (expected === 'FN' && prefix === 'TC')) {
    const otherTool = expected === 'TC'
      ? 'this is a function key — use the fn_* tool (fn_clone, fn_save_as_new_version, get_function, delete_function)'
      : 'this is a test-case key — use the tc_* tool (tc_clone, tc_save_as_new_version, tc_get, tc_delete)';
    throw new Error(`Refusing to run against ${id}: ${otherTool}.`);
  }
}

/** Coerce a raw {[projectId]: [ids]} map from a dep row into a plain Record<string, number[]>.
 *  Absent/malformed inputs collapse to `{}`. */
function toDepMap(v: unknown): Record<string, number[]> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, number[]> = {};
  for (const [k, arr] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(arr)) out[k] = arr.filter((n): n is number => Number.isFinite(n));
  }
  return out;
}

/** Normalise a raw dep row from PUT /tm/tcfnversion/delete into the neutral shape. Key set is
 *  narrower for FN — the service emits `{tcArr, fnArr, wfArr}` there vs the TC keyset. */
function normalizeVersionDep(row: any, parentType: 'TC' | 'FN'): TcVersionDep | FnVersionDep {
  const id = Number(row?.id ?? 0);
  if (parentType === 'FN') {
    return {
      id,
      tcArr: toDepMap(row?.tcArr),
      fnArr: toDepMap(row?.fnArr),
      wfArr: toDepMap(row?.wfArr),
    };
  }
  const name = typeof row?.versionName === 'string' ? row.versionName : undefined;
  return {
    id,
    ...(name ? { versionName: name } : {}),
    defectArr: toDepMap(row?.defectArr),
    suiteArr: toDepMap(row?.suiteArr),
    epArr: toDepMap(row?.epArr),
    scenarioArr: toDepMap(row?.scenarioArr),
    schedulerArr: toDepMap(row?.schedulerArr),
    pipelineArr: toDepMap(row?.pipelineArr),
    workflowArr: toDepMap(row?.workflowArr),
  };
}

/** True when every `*Arr` on the row is an empty map — i.e. no references block the delete.
 *  Mirrors the UI's own check (testcase.component.ts:2142 / function.component.ts:1617). */
function versionDepIsEmpty(dep: TcVersionDep | FnVersionDep): boolean {
  const maps: Array<Record<string, unknown>> = 'tcArr' in dep && 'wfArr' in dep && !('defectArr' in dep)
    ? [dep.tcArr, dep.fnArr, dep.wfArr]
    : [
        (dep as TcVersionDep).defectArr, (dep as TcVersionDep).suiteArr,
        (dep as TcVersionDep).epArr, (dep as TcVersionDep).scenarioArr,
        (dep as TcVersionDep).schedulerArr, (dep as TcVersionDep).pipelineArr,
        (dep as TcVersionDep).workflowArr,
      ];
  return maps.every((m) => Object.keys(m).length === 0);
}

/** Calls that work in any project: who you are, your memberships, and the project list — the access
 *  check itself uses them, and they let a user stuck in a project without a role find their own. */
const ACCESS_FREE_PATHS = ['/pm/auth/me', '/pm/projectuserrole', '/pm/project/search', '/pm/roles/search'];

/** Every request waits for `gate` first, except ACCESS_FREE_PATHS. All QaHttp methods take the path first. */
function gateHttp(http: QaHttp, gate: () => Promise<void>): QaHttp {
  return new Proxy(http, {
    get(target, key, receiver) {
      const v = Reflect.get(target, key, receiver);
      if (typeof v !== 'function') return v;
      return async (path: string, ...rest: unknown[]) => {
        if (!ACCESS_FREE_PATHS.includes(path.split('?')[0]!)) await gate();
        return v.call(target, path, ...rest);
      };
    },
  });
}

/** A named item a suite depends on (schedule, pipeline, execution plan, test plan). */
export type SuiteRef = { id: string; code?: string; name?: string };
export type SuiteBlockers = { schedules: SuiteRef[]; pipelines: SuiteRef[]; executionPlans: SuiteRef[]; testPlans: SuiteRef[] };
/** Execution settings `PUT /tm/suites/settings/:id` accepts (UAT updateSuiteSettingsBodyValidation). */
export type SuiteSettings = {
  autoDefectLog?: boolean; autoReExecCount?: number; autoReExecTriggerOn?: string; newBrowserSession?: boolean;
  terminateOnFailure?: boolean; minimumContainerCount?: number; maximumContainerCount?: number;
};
/** The execution doc's `globalConfiguration` for a SUITE run. The suite's Settings panel stores the
 *  auto re-execution count / trigger, new-browser-session and terminate-on-failure as SUITE FIELDS;
 *  carrying only `rawSuite.globalConfiguration` (usually absent) made every MCP-started run use 0
 *  re-executions even though Settings showed 2. Explicit run opts win, then the suite fields. */
export function suiteRunGlobalConfig(
  rawSuite: Record<string, any>,
  opts: { terminateOnFailure?: boolean | undefined; maxConcurrent?: number | undefined } = {},
): Record<string, unknown> {
  const gc = rawSuite?.['globalConfiguration'] ?? {};
  const reExec = Number(rawSuite?.['autoReExecCount'] ?? gc.RE_EXECUTION_COUNT ?? 0);
  return {
    TERMINATE_ON_FAIL: opts.terminateOnFailure ?? rawSuite?.['terminateOnFailure'] ?? gc.TERMINATE_ON_FAIL ?? false,
    NEW_BROWSER_SESSION: rawSuite?.['newBrowserSession'] ?? gc.NEW_BROWSER_SESSION ?? false,
    RE_EXECUTION_COUNT: Number.isFinite(reExec) ? reExec : 0,
    RE_EXECUTION_TYPE: str(rawSuite, 'autoReExecTriggerOn') ?? gc.RE_EXECUTION_TYPE ?? 'AFTER_TESTCASE',
    MINIMUM_CONTAINER_COUNT: gc.MINIMUM_CONTAINER_COUNT ?? 1,
    MAXIMUM_CONTAINER_COUNT: opts.maxConcurrent ?? gc.MAXIMUM_CONTAINER_COUNT ?? 5,
  };
}

/** Read-back shape of a suite's Settings panel (execution type + execution/auto-defect settings). */
export type SuiteSettingsView = {
  id: string; code?: string | undefined; name?: string | undefined;
  executionType?: string | undefined;
  autoReExecCount: number; autoDefectLog: boolean; autoReExecTriggerOn?: string | undefined;
  newBrowserSession: boolean; terminateOnFailure: boolean;
  minimumContainerCount?: number | null | undefined; maximumContainerCount?: number | null | undefined;
};
const SUITE_SETTING_KEYS = [
  'autoDefectLog', 'autoReExecCount', 'autoReExecTriggerOn', 'newBrowserSession', 'terminateOnFailure',
  'minimumContainerCount', 'maximumContainerCount',
] as const satisfies readonly (keyof SuiteSettings)[];

/** Execution-plan fields the MCP can set (UAT createEpBody / updateEpBody). `environment` is a name or
 *  key, sent as `environmentType`. */
export type ExecutionPlanInput = {
  name: string; plannedStartDate: string; plannedEndDate: string; environment: string;
  releaseId?: number | null; iterationId?: number | null; teamIds?: number[]; planners?: number[];
  autoReExecCount?: number; autoReExecTriggerOn?: string; autoDefectLog?: boolean; newBrowserSession?: boolean;
  terminateOnFailure?: boolean;
};
const EP_OPTIONAL_KEYS = [
  'releaseId', 'iterationId', 'teamIds', 'planners', 'autoReExecCount', 'autoReExecTriggerOn', 'autoDefectLog',
  'newBrowserSession', 'terminateOnFailure',
] as const satisfies readonly (keyof ExecutionPlanInput)[];
/** Every key `PUT /tm/executionplan` accepts (UAT updateEpBody) — the body is built from these only. */
const EP_UPDATE_KEYS = [
  'id', 'name', 'projectId', 'releaseId', 'iterationId', 'teamIds', 'planners', 'plannedStartDate', 'plannedEndDate',
  'environmentType', 'copiedFrom', 'reviewApproveStatus', 'updateVersion', 'autoReExecCount', 'autoReExecTriggerOn',
  'autoDefectLog', 'newBrowserSession', 'terminateOnFailure',
] as const;
/** The SimplifyQA UI makes a plan read-only in these review states (executionplan.component.html:106). */
const EP_READ_ONLY_STATUSES = ['REVIEW PENDING', 'APPROVE PENDING', 'REVIEWED', 'APPROVED'];

/** What to add to a plan: test cases and/or every live test case of suites, optionally assigned. */
export type PlanEntryInput = { tcIds?: string[]; suiteIds?: string[]; assignTo?: string; assignDate?: string };
/** One plan entry, as shown before removing it. */
export type PlanEntryRef = { id: string; code: string; tcName: string; assignedTo?: number };

/** What a plan run started: the new execution id, the test cases sent, and those left out (with why). */
export type PlanRunRef = { runId: string; started: string[]; skipped: Array<{ code: string; reason: string }> };
/** Technologies the UI runs on their own technology "platform" (execution-popup-modal.component.ts:1209). */
const PLAN_SPECIAL_TECH = ['API', 'MAINFRAME', 'SAP', 'DESKTOP', 'DATABASE'];
/** Keys the UI strips from the shell execution before re-posting it (execution-popup-modal.component.ts:1263-1278). */
const PLAN_RUN_DROP_KEYS = [
  '_id', 'id', 'customerId', 'deleted', 'createdAt', 'createdBy', 'authkey', 'code', 'childExecutions', 'exception',
  'agentStartTime', 'agentEndTime', 'executionDuration', 'executionFlow', 'updatedAt', 'updatedBy', 'childExecution',
];

/** A test case's version for a plan entry. The entry validator requires a real `tcVersionId`, so a
 *  missing one is refused, never guessed (unlike suite entries, which tolerate a default). With
 *  `optional`, return what exists and let the caller decide. */
function testcaseVersion(raw: any, optional = false): { versionId: string; versionName: string } {
  let versionId = str(raw, 'versionId', 'selectedVersionId');
  let versionName = str(raw, 'versionName', 'selectedVersionName');
  if ((!versionId || !versionName) && Array.isArray(raw?.versions) && raw.versions.length) {
    versionId ??= str(raw.versions[0], 'id', '_id');
    versionName ??= str(raw.versions[0], 'name');
  }
  if (!versionId && !optional) throw new Error(`${str(raw, 'code') ?? `TC-${raw?.id}`} has no version to add.`);
  return { versionId: versionId ?? '', versionName: versionName ?? 'v1.0' };
}

/** Refused suite delete: something still uses it (the caller lists `blockers`). */
export class SuiteBlockedError extends Error {
  constructor(readonly suite: SuiteRef, readonly blockers: SuiteBlockers) {
    super(`${suite.code ?? suite.id} is still in use and was not deleted.`);
    this.name = 'SuiteBlockedError';
  }
}

const toRef = (r: any): SuiteRef => {
  const code = str(r, 'code');
  const name = str(r, 'name');
  return { id: str(r, 'id') ?? '', ...(code ? { code } : {}), ...(name ? { name } : {}) };
};

/** Keys `PUT /sh/scheduler/:id` accepts (UAT updateSchedulerValidations; Joi rejects any other, and
 *  `tz` is create-only) — an edit body is built from these, never by stripping the stored doc. */
const SCHEDULE_UPDATE_KEYS = [
  'id', 'code', 'platForm', 'projectId', 'environment', 'iterationId', 'recurrenceType', 'reccurenceData',
  'nextRecurrenceTime', 'lastExecutionTime', 'releaseId', 'name', 'scheduleStartDate', 'scheduleEndDate',
  'schedulerType', 'schedulerTcIds', 'schedulerSuIds', 'agentId', 'executionMode', 'executionStyle', 'parentId',
  'parentVersionId', 'status', 'offset', 'cancelled', 'mode', 'updateVersion', 'flag', 'retryConfig', 'cloudType',
  'lastExecutionStatus', 'lastFailureReason',
] as const;
const RECURRENCE_KEYS = ['startDate', 'endDate', 'interval', 'daysOfWeek', 'dayOfMonth', 'occurencePosition'] as const;
const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

/** SimplifyQA recurrence for a neutral cadence, as the scheduler form builds it. Day of week / month are
 *  taken in `timeZone` (the user's), so "weekly" from a Tuesday morning in India is a Tuesday. */
function sqaRecurrence(type: ScheduleOptions['scheduleType'], start: string, end: string | null | undefined, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', day: 'numeric' }).formatToParts(new Date(start));
  const weekday = (parts.find((p) => p.type === 'weekday')?.value ?? '').toUpperCase();
  const day = Number(parts.find((p) => p.type === 'day')?.value);
  const once = !type || type === 'once';
  const recurrenceType = once ? 'ONCE' : type === 'weekdays' ? 'WEEKLY' : type.toUpperCase();
  return {
    recurrenceType,
    scheduleEndDate: once ? start : (end ?? null),
    reccurenceData: {
      startDate: start,
      endDate: once ? null : (end ?? null),
      interval: 1,
      daysOfWeek: type === 'weekdays' ? WEEKDAYS.slice(1, 6) : type === 'weekly' ? [weekday] : [],
      dayOfMonth: type === 'monthly' && Number.isFinite(day) ? day : null,
      occurencePosition: '',
    },
  };
}

/** A pipeline the MCP can create (createPipelinesValidations). `parentId` is the test case or suite. */
export type PipelineInput = {
  name: string; pipelineType: 'TC' | 'SU'; parentId: string; releaseId?: string; sprintId?: string;
  mode: 'local' | 'remote' | 'cloud'; agentId?: string; environment?: string; browser?: string; description?: string;
};
export type PipelineUpdate = { name?: string; description?: string; releaseId?: string; sprintId?: string; environment?: string; agentId?: string; mode?: 'local' | 'remote' | 'cloud' };
/** Keys `PUT /pl/pipelines/:id` accepts (updatePipelinesValidations; Joi rejects any other). */
const PIPELINE_UPDATE_KEYS = [
  'id', 'code', 'platForm', 'projectId', 'environment', 'iterationId', 'releaseId', 'name', 'pipelineType', 'parentId',
  'agentId', 'parentVersion', 'executionMode', 'executionStyle', 'description', 'mode', 'cloudType',
] as const;

/** Neutral browser names → SimplifyQA platform ids (the UI's CHROME / EDGE / FIREFOX / SAFARI). */
const SQA_BROWSERS: Readonly<Record<string, string>> = {
  chrome: 'CHROME', chromium: 'CHROME', msedge: 'EDGE', edge: 'EDGE', firefox: 'FIREFOX', webkit: 'SAFARI', safari: 'SAFARI',
};
function sqaBrowser(browser?: string): string {
  if (!browser) return 'CHROME';
  const id = SQA_BROWSERS[browser.trim().toLowerCase()];
  if (!id) throw new Error(`Unknown browser "${browser}" — use chrome, edge, firefox or safari.`);
  return id;
}
/** The platform a test case runs on, as the scheduler form derives it from `tcType`: its browser for
 *  WEB, its own technology for API / MAINFRAME / SAP / DESKTOP / DATABASE. Mobile needs a device the
 *  MCP can't pick, so it is refused. */
function tcPlatform(tc: any, browser?: string): unknown[] {
  const tech = String(tc?.tcType ?? 'WEB').toUpperCase();
  if (tech === 'WEB') {
    const b = sqaBrowser(browser);
    return [{ id: b, name: b, type: 'NONE', technologyType: 'WEB' }];
  }
  if (PLAN_SPECIAL_TECH.includes(tech)) return [{ id: tech, name: tech, type: 'NONE', technologyType: tech }];
  throw new Error(`${tc?.code ?? `TC-${tc?.id}`} is a ${tech} test case: schedule it from SimplifyQA, where you pick the device.`);
}
/** A suite schedule / pipeline platform, as the Scheduler and Pipeline forms build it: one entry per
 *  technology among the suite's live test cases (the scheduler keys it by technologyType at run time) —
 *  the browser for WEB, the technology itself for API / MAINFRAME / SAP / DESKTOP / DATABASE. A suite
 *  doc has no platform of its own. Mobile needs a device the MCP can't pick, so it is refused. */
function suitePlatform(suite: any, browser: string | undefined, verb: string): unknown[] {
  const code = suite?.code ?? `SU-${suite?.id}`;
  const rows = (Array.isArray(suite?.testCases) ? suite.testCases : []).filter((r: any) => r && r.deleted !== true);
  if (!rows.length) throw new Error(`${code} has no test cases to run.`);
  const techs = [...new Set<string>(rows.map((r: any) => String(r.tcType ?? 'WEB').toUpperCase()))];
  const mobile = techs.filter((t) => t !== 'WEB' && !PLAN_SPECIAL_TECH.includes(t));
  if (mobile.length) throw new Error(`${code} has ${mobile.join(' / ')} test cases: ${verb} from SimplifyQA, where you pick the device.`);
  return techs.map((t) => {
    if (t !== 'WEB') return { id: t, name: t, type: 'NONE', technologyType: t };
    const b = sqaBrowser(browser);
    return { id: b, name: b, type: 'NONE', technologyType: 'WEB' };
  });
}
/** A plan entry's platform: the validator allows only these keys, and suite rows store it per mode
 *  (`{LOCAL, REMOTE, CLOUD}`) — plans run locally, so LOCAL. Nothing usable → undefined (not sent). */
const ENTRY_PLATFORM_KEYS = ['id', 'name', 'technologyType', 'type', 'osVersion', 'cloudDeviceType'];
function entryPlatform(p: any): Record<string, unknown> | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const src = p.LOCAL && typeof p.LOCAL === 'object' ? p.LOCAL : p;
  if (!src.id) return undefined;
  return Object.fromEntries(ENTRY_PLATFORM_KEYS.filter((k) => k in src).map((k) => [k, src[k]]));
}
/** A stored end date that means something (the backend stores `new Date(null)` = 1970 for "none"). */
function realEndDate(v: unknown): string | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const t = Date.parse(String(v));
  return Number.isFinite(t) && new Date(t).getUTCFullYear() > 1971 ? String(v) : undefined;
}
const NEEDS_END_DATE = 'A recurring schedule needs an end date (endDate).';

const NEEDS_PROJECT =
  'No project selected. Find your projects with sqa_query({ op:"search", collection:"projects", ' +
  'where:[{ field:"member", value:true }] }), then qa_switch_project({ projectId }) to choose one — ' +
  'test cases, runs and objects are all scoped to a project.';

/**
 * SimplifyQaAdapter — DIRECT-to-backend REST driver for SimplifyQA, mirroring WalnutAdapter's
 * design. Reads (list/get for projects/testcases/suites/stories/modules/releases/sprints/objects)
 * hit the SimplifyQA backend REST directly via a `QaHttp` bound to `cfg.baseUrl`. Anything not yet
 * ported (writes, testdata, run dispatch, marketplace, and the recording surface) delegates to
 * the LOCAL AGENT's `/mcp` (`cfg.url`) via a lazily-built RemoteMcpAdapter — same "graceful hop"
 * pattern walnut uses for recording. When the hop is not configured, unported ops surface a clear
 * error instead of failing silently.
 *
 * This class deliberately does not `implements ProviderAdapter` (walnut trick): the factory casts
 * it, and tools that call ported methods get direct REST; tools that call unported methods get
 * the hop (or a clear error). Each porting step replaces one more delegation with a direct call.
 */
export type ActionCatalogEntry = {
  id: number;
  objectRequired: boolean;
  objectTemplate?: number | undefined;
  displayName?: string | undefined;
  /** Backend camelCase action name (e.g. "launchApplication"); display name is separate. */
  name?: string | undefined;
  /** Technology this action belongs to (WEB / ANDROID / API / DATABASE / …), from its objectTemplate. */
  technology?: string | undefined;
  /** Plugin `@Deprecated` row (uniqueId starts with `deprecated-`) — never resolve a step BY NAME to one. */
  deprecated?: boolean | undefined;
};

export class SimplifyQaAdapter {
  private readonly http: QaHttp;
  private agentHop: RemoteMcpAdapter | null = null;
  // Formula list rarely changes during a session; cache the fetch response so the model can call
  // tc_list_formulas without paying a round trip each time. Instance-scoped: switchProject rebuilds
  // the adapter (see connection.ts), which drops this cache with it — no manual invalidation needed.
  // We store the in-flight PROMISE, not the resolved array: several concurrent evaluateFormula calls
  // (from the Promise.all in saveGeneratedIterations) all await the same fetch instead of each firing
  // their own /tm/syncFormulas/fetch before the cache is populated.
  private formulaCache: Promise<Formula[]> | null = null;
  // Generic collection query engine (sqa_query). One instance per adapter so the custom-field
  // cache survives across calls; switchProject rebuilds the adapter, dropping the cache.
  private sqaEngine: SqaSearchEngine | null = null;
  // Same rationale for the backlog default state/priority per parentId (1=Epic, 2=Feature, 3=Story).
  // Fields config barely changes mid-session; cache the in-flight promise so parallel creates share it.
  private backlogDefaultsCache: Map<number, Promise<{ state?: string; priority?: string }>> = new Map();
  // Who the caller IS, resolved from the token itself. Precedence: explicit QA_MCP_USER_ID →
  // `userId` claim (session JWT) → GET /pm/auth/me (the only endpoint that maps an API key to its
  // user; SQA API keys are encrypted JWTs the client cannot decode). Cached as an in-flight
  // promise: several tools resolve "me" concurrently and must share one /pm/auth/me call.
  private userIdPromise: Promise<string | undefined> | null = null;

  constructor(
    private readonly cfg: ConnectedQaConfig,
    transport?: SimplifyQaTransport,
  ) {
    if (!cfg.baseUrl) {
      throw new Error(
        'SimplifyQaAdapter requires a baseUrl — set QA_BASE_URL or use a JWT with a `url` claim.',
      );
    }
    const http = makeClient({
      baseUrl: cfg.baseUrl,
      headers: () => this.headers(),
      ...transport,
    });
    // Every call in a selected project first proves the user has a role in it — however the project
    // was chosen (switch, connect, QA_MCP_PROJECT_ID, remembered). Admins included, as in the UI.
    this.http = cfg.projectId ? gateHttp(http, () => this.projectAccess()) : http;
  }

  private accessOk: Promise<void> | null = null;

  /** Resolves when the user has a role in the selected project. Only success is remembered: a
   *  refusal or a failed lookup is re-checked on the next call (fail closed meanwhile). */
  private projectAccess(): Promise<void> {
    this.accessOk ??= this.checkProjectAccess().catch((e) => {
      this.accessOk = null;
      throw e;
    });
    return this.accessOk;
  }

  private async checkProjectAccess(): Promise<void> {
    const pid = String(this.cfg.projectId).trim();
    let roles: Map<number, number>;
    try {
      const userId = await this.ensureUserId();
      if (!userId) throw new Error('user unknown');
      roles = await this.memberRoles(userId);
    } catch {
      throw new Error(
        `Could not verify your access to project ${pid}, so this is refused. Try again; if your user ` +
        'cannot be identified from the token, set QA_MCP_USER_ID.',
      );
    }
    if (!roles.has(Number.parseInt(pid, 10))) {
      throw new Error(
        `You don't have access to project ${pid}: you have no role in it. Find your projects with ` +
        'sqa_query({ op:"search", collection:"projects", where:[{ field:"member", value:true }] }), ' +
        'then qa_switch_project({ projectId }).',
      );
    }
  }

  // Auth headers mirror the Java RequestContext: bearer + x-project-id. `x-project-id` is only
  // spread in when a project is selected — a session can be connected before one is chosen.
  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.token}`,
      ...(this.cfg.projectId ? { 'x-project-id': this.cfg.projectId } : {}),
    };
  }

  /** Public session context for MCP viewer/recorder windows that need to authenticate the sqa-ui
   *  they load. cfg itself stays private; this getter is the one seam through which tc_edit_open
   *  and record tools can forward token + baseUrl + projectId to Electron without asking the LLM. */
  public async getSessionContext(): Promise<{ token: string; baseUrl: string; projectId?: string; userId?: string }> {
    // Constructor already rejected missing baseUrl, so `!` is safe here. userId is resolved from
    // the token when QA_MCP_USER_ID is absent — the embedded SQA UI filters its lists by it.
    const userId = await this.ensureUserId();
    return {
      token: this.cfg.token,
      baseUrl: this.cfg.baseUrl!,
      ...(this.cfg.projectId ? { projectId: this.cfg.projectId } : {}),
      ...(userId ? { userId } : {}),
    };
  }

  private requireProjectId(): number {
    if (!this.cfg.projectId) throw new Error(NEEDS_PROJECT);
    const n = Number.parseInt(String(this.cfg.projectId).trim(), 10);
    if (!Number.isFinite(n)) throw new Error(`Invalid projectId ${this.cfg.projectId} — expected a numeric id.`);
    return n;
  }

  // Standard SQA `searchFields` payload builder — the SAME shape every /search endpoint expects.
  // Every list op below uses this instead of hand-writing the same 6-line boilerplate.
  /** A search payload. Soft-deleted rows are ALWAYS excluded, as the AI assistant's reads do:
   *  `deleted:false` is set here and a caller's own `deleted` entry is dropped, never sent. */
  private searchBody(
    fields: Array<{ column: string; value: string | number | boolean | number[] | string[] | { $in: number[] }; regEx?: boolean | undefined }>,
    opts: { startIndex?: number; limit?: number; selectFields?: string[]; rawOffset?: boolean } = {},
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      searchFields: [
        { column: 'deleted', value: false },
        ...fields.filter((f) => f.column !== 'deleted').map((f) => ({
          column: f.column,
          value: f.value,
          ...(f.regEx ? { regEx: true } : {}),
        })),
      ],
      startIndex: opts.startIndex ?? 0,
      limit: opts.limit ?? 100,
    };
    if (opts.selectFields) body['selectFields'] = opts.selectFields;
    // test-management's search treats `startIndex` as a PAGE number (skip = limit × startIndex) unless
    // `skipStartIndex` is set, which makes it a raw row offset. Opt-in per call so other endpoints keep
    // their existing behaviour.
    if (opts.rawOffset) body['skipStartIndex'] = 1;
    return body;
  }

  // ---------------------------------------------------------------------- Generic collection query

  private engine(): SqaSearchEngine {
    if (!this.sqaEngine) this.sqaEngine = this.newEngine(this.requireProjectId());
    return this.sqaEngine;
  }

  private newEngine(projectId: number): SqaSearchEngine {
    const me = Number.parseInt(this.cfg.userId?.trim() || this.jwtUserId() || '', 10);
    return new SqaSearchEngine(this.http, projectId, {
      resolveValues: resolveValuesFromEnv(process.env),
      ...(Number.isFinite(me) ? { currentUserId: me } : {}),
    });
  }

  /** With no project selected, collections that are not project-scoped (projects, users, teams …)
   *  and the catalog are still readable; anything project-scoped asks for a project first. */
  private engineFor(req: SqaQueryRequest): SqaSearchEngine {
    if (this.cfg.projectId) return this.engine();
    const c = req.collection ? resolveCollection(req.collection) : undefined;
    const projectFree = req.op === 'catalog' || req.scopeProjectIds !== undefined ||
      (c?.scope === 'none' && (req.op === 'search' || req.op === 'count' || req.op === 'get'));
    if (!projectFree) throw new Error(NEEDS_PROJECT);
    return this.newEngine(0); // never sent: scope 'none' adds no project filter
  }

  /** `projects` + `member:true` (not a stored field) → `id in <your role projects>`, plus your role
   *  per project for the rows. Returns null when you have no role anywhere, so the caller can answer
   *  without a search. */
  private async applyMemberFilter(req: SqaQueryRequest): Promise<{ req: SqaQueryRequest; roles?: Map<number, number> } | null> {
    const c = req.collection ? resolveCollection(req.collection) : undefined;
    const m = c?.name === 'projects' ? req.where?.find((w) => w.field === 'member') : undefined;
    if (!m) return { req };
    const userId = await this.ensureUserId();
    if (!userId) throw new Error('Cannot tell who you are on this connection, so `member` cannot be applied — set QA_MCP_USER_ID.');
    const roles = await this.memberRoles(userId);
    if (!roles.size) return null;
    return { req: { ...req, where: [...(req.where ?? []).filter((w) => w !== m), { field: 'id', op: 'in', value: [...roles.keys()] }] }, roles };
  }

  /** `users` + where projectIds = <id>: the MEMBERS of that project. A user row carries no project,
   *  so membership is read from project_user_role (GET /pm/projectuserrole?projectId=) and turned
   *  into `id in [...]`; each row gets `roleId` + `roleName` in that project. Allowed only for an
   *  admin or a member of that project (the endpoint itself does not check). Returns null when the
   *  request is not a project-members query. */
  private async applyProjectMembersFilter(req: SqaQueryRequest): Promise<SqaQueryResult | null> {
    const c = req.collection ? resolveCollection(req.collection) : undefined;
    if (c?.name !== 'users' || (req.op !== 'search' && req.op !== 'count')) return null;
    const isProject = (w: SqaWhere) => w.field === 'projectIds' || w.field === 'projectId';
    const pf = (req.where ?? []).filter(isProject);
    if (!pf.length) return null;
    const asked = [...new Set(pf.flatMap((w) => (Array.isArray(w.value) ? w.value : [w.value]))
      .map((v) => Number(v)).filter((n) => Number.isFinite(n)))];
    if (!asked.length) throw new Error('projectIds needs a numeric project id.');

    if (!(await this.isCallerAdmin())) {
      const userId = await this.ensureUserId();
      const mine = userId ? await this.memberRoles(userId) : new Map<number, number>();
      const notMine = asked.filter((p) => !mine.has(p));
      if (notMine.length) {
        throw new Error(`You are not a member of project ${notMine.join(', ')}, so its members are not shown. ` +
          'Tell the user that; an admin, or a member of that project, can list them.');
      }
    }

    // userId -> roleId (first role seen across the asked projects)
    const roleOf = new Map<number, number>();
    for (const pid of asked) {
      const raw = await this.http.getJson<any>(`/pm/projectuserrole?projectId=${pid}`);
      for (const r of pickArray(raw, 'data', 'content')) {
        if (r?.deleted === true) continue;
        const uid = Number(r?.userId);
        if (Number.isFinite(uid) && !roleOf.has(uid)) roleOf.set(uid, Number(r?.roleId));
      }
    }
    const ids = [...roleOf.keys()];
    const scoped: SqaQueryRequest = {
      ...req,
      where: [...(req.where ?? []).filter((w) => !isProject(w)), { field: 'id', op: 'in', value: ids.length ? ids : [-1] }],
    };
    const scopeNote = `Members of project ${asked.join(', ')} (from its user-role assignments).`;
    const engine = this.engineFor(scoped);
    if (req.op === 'count') return { op: 'count', ...(await engine.count(scoped)), scopeNote };
    const out = await engine.search(scoped);
    return { op: 'search', ...out, rows: await this.withRoles(out.rows, roleOf), scopeNote };
  }

  /** Is the caller an admin (userType holds "admin")? Read from the user's own row — the token does
   *  not carry it — and reused for a minute, so an admin <-> non-admin change shows up quickly. */
  private adminCache: { at: number; value: boolean } | null = null;
  private static readonly ADMIN_TTL_MS = 60_000;
  private async isCallerAdmin(): Promise<boolean> {
    if (this.adminCache && Date.now() - this.adminCache.at < SimplifyQaAdapter.ADMIN_TTL_MS) return this.adminCache.value;
    let value = false;
    try {
      const userId = await this.ensureUserId();
      if (userId) {
        const raw = await this.http.postJson<any>('/pm/users/search',
          this.searchBody([{ column: 'id', value: Number(userId) }], { selectFields: ['id', 'userType'], limit: 1, rawOffset: true }));
        const t = pickArray(raw, 'data', 'content')[0]?.userType;
        value = Array.isArray(t) ? t.includes('admin') : t === 'admin';
      }
    } catch { value = false; /* unknown → treat as non-admin (the narrower answer) */ }
    this.adminCache = { at: Date.now(), value };
    return value;
  }

  /** users / projects: for an admin the backend returns the whole account, so say that instead of
   *  the registry's "only those who share a project with you". undefined = keep the registry note. */
  private async adminVisibilityNote(req: SqaQueryRequest): Promise<string | undefined> {
    const c = req.collection ? resolveCollection(req.collection) : undefined;
    if (c?.name !== 'users' && c?.name !== 'projects') return undefined;
    if (!(await this.isCallerAdmin())) return undefined;
    return c.name === 'users'
      ? 'Every user in the account (you are an admin).'
      : 'Every project in the account (you are an admin).';
  }

  /** `allProjects:true` on a release-like collection (releases, sprints, epics, features — rows that
   *  belong to projects through `projectIds` or a release): search / count across every project you
   *  have a role in, without switching. A `projectId`/`projectIds` filter narrows to those of your
   *  projects; it can never widen past them. Admins included — "my projects", as in the UI. */
  private async applyAllProjects(req: SqaQueryRequest): Promise<SqaQueryResult> {
    const c = req.collection ? resolveCollection(req.collection) : undefined;
    if (!c || (c.scope !== 'projectIds' && c.scope !== 'release')) {
      const ok = ['releases', 'sprints', 'epics', 'features'].join(', ');
      throw new Error(`allProjects works on ${ok} only — ${req.collection ?? 'this collection'} is read one project at a time (qa_switch_project).`);
    }
    if (req.op !== 'search' && req.op !== 'count') {
      throw new Error('allProjects works with op:"search" and op:"count" only.');
    }
    const userId = await this.ensureUserId();
    if (!userId) throw new Error('Cannot tell who you are on this connection, so allProjects cannot be applied — set QA_MCP_USER_ID.');

    const isProjectFilter = (w: SqaWhere) => w.field === 'projectId' || w.field === 'projectIds';
    const asked = (req.where ?? []).filter(isProjectFilter)
      .flatMap((w) => (Array.isArray(w.value) ? w.value : [w.value]))
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n));
    const where0 = (req.where ?? []).filter((w) => !isProjectFilter(w));

    // An ADMIN sees every project in the account (as in the UI), so allProjects means the whole
    // account — not only the projects they happen to hold a role in.
    if (await this.isCallerAdmin()) {
      const scoped: SqaQueryRequest = asked.length
        ? { ...req, where: where0, scopeProjectIds: asked }
        : { ...req, where: where0, scopeAll: true };
      const scopeNote = asked.length
        ? `Across projects ${asked.join(', ')} (you are an admin).`
        : 'Every one in the account, across all projects (you are an admin).';
      const engine = this.engineFor(scoped);
      if (req.op === 'count') return { op: 'count', ...(await engine.count(scoped)), scopeNote };
      return { op: 'search', ...(await engine.search(scoped)), scopeNote };
    }

    let ids = [...(await this.memberRoles(userId)).keys()];
    if (asked.length) ids = ids.filter((id) => asked.includes(id));

    const scoped: SqaQueryRequest = { ...req, where: where0, scopeProjectIds: ids };
    const scopeNote = asked.length
      ? `Across ${ids.length} of the projects you have a role in (${ids.join(', ')}), not just the active one.`
      : `Across all ${ids.length} projects you have a role in, not just the active one.`;
    const engine = this.engineFor(scoped);
    if (req.op === 'count') return { op: 'count', ...(await engine.count(scoped)), scopeNote };
    return { op: 'search', ...(await engine.search(scoped)), scopeNote };
  }

  /** "Default Business Unit", as the SimplifyQA header shows it: not a stored record (id null) but
   *  the label for YOUR projects that have no business unit. Added to a plain business-unit list /
   *  count when you have such a project; `related` on id "default" lists those projects. Returns
   *  null when the request is not one of these. */
  private async defaultBusinessUnit(req: SqaQueryRequest): Promise<SqaQueryResult | null> {
    const c = req.collection ? resolveCollection(req.collection) : undefined;
    if (c?.name !== 'businessUnits') return null;
    const defaultId = /^(default|null|none)$/i.test(String(req.id ?? '').trim());
    const plain = !req.where?.length;
    if (!((req.op === 'related' && defaultId && req.relation === 'projects') || (plain && (req.op === 'search' || req.op === 'count')))) return null;

    const userId = await this.ensureUserId();
    const ids = userId ? [...(await this.memberRoles(userId)).keys()] : [];
    const mine = ids.length
      ? pickArray(await this.http.postJson<any>('/pm/project/search',
        this.searchBody([{ column: 'id', value: ids }], { selectFields: ['id', 'code', 'name', 'businessUnitId'], limit: ids.length, rawOffset: true })),
      'data', 'content', 'projects')
      : [];
    const unassigned = mine.filter((p: any) => p?.businessUnitId === null || p?.businessUnitId === undefined || p?.businessUnitId === '');

    if (req.op === 'related') {
      const rows = unassigned.map((p: any) => ({ id: p.id, code: p.code, name: p.name }));
      return { op: 'related', collection: 'projects', rows, totalCount: rows.length, returned: rows.length, offset: 0 };
    }
    const engine = this.engineFor(req);
    if (req.op === 'count') {
      const out = await engine.count(req);
      return { op: 'count', ...out, total: out.total + (unassigned.length ? 1 : 0) };
    }
    const out = await engine.search(req);
    if (!unassigned.length) return { op: 'search', ...out };
    const row = { id: null, name: 'Default Business Unit', description: `Your ${unassigned.length} project(s) with no business unit — related "projects" with id "default".` };
    return { op: 'search', ...out, rows: [...out.rows, row], totalCount: (out.totalCount ?? out.rows.length) + 1, returned: out.returned + 1 };
  }

  /** Adds `roleId` + `roleName` (your role in that project) to member:true project rows. A failed
   *  role-name lookup leaves `roleName` out; the rows are still returned. */
  private async withRoles(rows: Record<string, unknown>[], roles: Map<number, number>): Promise<Record<string, unknown>[]> {
    const roleIds = [...new Set(roles.values())];
    const names = new Map<number, string>();
    try {
      const raw = await this.http.postJson<any>('/pm/roles/search',
        this.searchBody([{ column: 'id', value: roleIds }], { selectFields: ['id', 'name'], limit: roleIds.length, rawOffset: true }));
      for (const r of pickArray(raw, 'data', 'content')) {
        const id = Number(str(r, 'id')); const name = str(r, 'name');
        if (Number.isFinite(id) && name) names.set(id, name);
      }
    } catch { /* role names are a nice-to-have */ }
    return rows.map((row) => {
      const roleId = roles.get(Number(row['id']));
      if (roleId === undefined) return row;
      const roleName = names.get(roleId);
      return { ...row, roleId, ...(roleName ? { roleName } : {}) };
    });
  }

  /**
   * ONE generic read surface over every SQA collection. Backs the `sqa_query` tool:
   *   catalog       -> collections, fields, relations, descriptions
   *   custom_fields -> custom fields for a collection (label -> key -> customFields.<key>)
   *   search        -> compiled searchFields + rows
   *   get           -> one row, optionally expanding steps/versions/members
   *   related       -> follow a relation (story -> testcases, testcase -> defects, ...)
   *
   * Always injects `deleted:false` and the active project; never exposes deleted rows.
   */
  async sqaQuery(input: SqaQueryRequest): Promise<SqaQueryResult> {
    // Never trust a caller-supplied scope; only applyAllProjects sets it.
    const { scopeProjectIds: _ignored, scopeAll: _ignoredAll, ...clean } = input;
    if (clean.allProjects) return this.applyAllProjects(clean);
    const projectMembers = await this.applyProjectMembersFilter(clean);
    if (projectMembers) return projectMembers;
    const member = await this.applyMemberFilter(clean);
    if (!member) {
      const collection = 'projects';
      if (input.op === 'count') return { op: 'count', collection, total: 0 };
      return { op: 'search', collection, rows: [], totalCount: 0, returned: 0, offset: 0 };
    }
    const { req, roles } = member;
    if (roles && req.op === 'search') {
      const out = await this.engineFor(req).search(req);
      return { op: 'search', ...out, rows: await this.withRoles(out.rows, roles) };
    }
    const bu = await this.defaultBusinessUnit(req);
    if (bu) return bu;
    switch (req.op) {
      case 'catalog':
        return { op: 'catalog', collections: this.engineFor(req).catalog(req.collection) };
      case 'custom_fields': {
        if (!req.collection) throw new Error('`collection` is required for op:"custom_fields".');
        return {
          op: 'custom_fields',
          collection: req.collection,
          fields: await this.engineFor(req).customFields(req.collection),
        };
      }
      case 'search': {
        const out = await this.engineFor(req).search(req);
        const scopeNote = await this.adminVisibilityNote(req);
        return { op: 'search', ...out, ...(scopeNote ? { scopeNote } : {}) };
      }
      case 'count': {
        const out = await this.engineFor(req).count(req);
        const scopeNote = await this.adminVisibilityNote(req);
        return { op: 'count', ...out, ...(scopeNote ? { scopeNote } : {}) };
      }
      case 'related': {
        // Execution step results need the run UUID/step ladder, not a raw subresource GET.
        const c = req.collection ? resolveCollection(req.collection) : undefined;
        if (c?.name === 'executions' && req.relation === 'steps' && req.id) {
          const run = await this.getRun(String(req.id));
          const rows = (run.stepResults ?? []) as unknown as Record<string, unknown>[];
          return {
            op: 'related',
            collection: 'executions',
            rows,
            totalCount: rows.length,
            returned: rows.length,
            offset: 0,
          };
        }
        return { op: 'related', ...(await this.engineFor(req).related(req)) };
      }
      case 'get': {
        if (!req.collection) throw new Error('`collection` is required for op:"get".');
        if (!req.id) throw new Error('`id` is required for op:"get".');
        const c = resolveCollection(req.collection);
        if (!c) throw new Error(`Unknown collection "${req.collection}".`);
        // Runs need the UUID/step ladder in the existing getRun implementation, not a raw row.
        if (c.name === 'executions') {
          const run = await this.getRun(String(req.id));
          return { op: 'get', collection: 'executions', row: run as unknown as Record<string, unknown> };
        }
        return this.engineFor(req).getWithExpand(req);
      }
      default:
        throw new Error(`Unsupported op "${String((req as { op?: unknown }).op)}".`);
    }
  }

  // ---------------------------------------------------------------------- Info + projects

  /** Validates baseUrl + token + (optional) project by running the same list_projects search the
   *  Java `infoResult` uses to resolve the project name — no separate /info endpoint on SQA.
   *  `counts` is a best-effort row count per entity type (test cases/suites/stories/objects), read
   *  from each `/search` endpoint's own `totalCount` (see searchTotalCount) — mirrors what Walnut's
   *  info() already returns via its own `counts`. */
  async info(): Promise<ProjectInfo> {
    // The counts below swallow errors, so refuse a project without a role explicitly here: this is
    // what qa_switch_project / qa_connect validate with.
    if (this.cfg.projectId) await this.projectAccess();
    const projects = await this.listProjects();
    const projectId = this.cfg.projectId ?? '';
    const found = projects.find((p) => p.id === projectId);
    const [testCases, suites, stories, objects] = await Promise.all([
      this.searchTotalCount('/tm/testcase/search'),
      this.searchTotalCount('/tm/suites/search'),
      this.searchTotalCount('/pm/userstory/search'),
      this.searchTotalCount('/tm/object/search'),
    ]);
    return {
      provider: 'simplifyqa',
      projectId,
      projectName: found?.name ?? '',
      counts: { testCases, suites, stories, objects },
    };
  }

  /** Projects the caller can access. Three code paths in priority order:
   *
   *  1. Config-supplied `QA_MCP_USER_ID` (explicit override) → user-scoped two-step via
   *     `/pm/projectuserrole`.
   *  2. Session JWT with a `userId` claim → same two-step.
   *  3. `GET /pm/auth/me` — resolves the user from the token itself (works for API keys, which
   *     are encrypted JWTs the client cannot decode) → same two-step.
   *  4. None of the above (e.g. an older deployment without /me) → direct `/pm/project/search`,
   *     paged to the end. The backend scopes by token owner where it can (tenant-wide for admins);
   *     `totalCount` uses `rows.length` (backend's top-level count is unreliable).
   *
   *  The two-step avoids both problems: correct user scoping AND an accurate count. */
  async listProjects(): Promise<ListResult<ProjectSummary>> {
    const userId = await this.ensureUserId();
    return userId ? this.listProjectsForUser(userId) : this.listProjectsDirect();
  }

  /** projectId → roleId for every project `userId` has a role in. */
  private async memberRoles(userId: string): Promise<Map<number, number>> {
    const rolesRaw = await this.http.getJson<any>(`/pm/projectuserrole?userId=${encodeURIComponent(userId)}`);
    const out = new Map<number, number>();
    for (const r of pickArray(rolesRaw, 'data', 'content')) {
      const projectId = Number.parseInt(str(r, 'projectId') ?? '', 10);
      if (Number.isFinite(projectId) && !out.has(projectId)) out.set(projectId, Number.parseInt(str(r, 'roleId') ?? '', 10));
    }
    return out;
  }

  /** projectId|userId → resolved privileges. A role changes rarely; a recording preflight should not
   *  cost three round trips every time the agent asks. Instance-scoped, so switchProject drops it. */
  private privilegesCache = new Map<string, { at: number; value: ProjectPrivileges }>();
  private static readonly PRIVILEGES_TTL_MS = 5 * 60_000;

  /**
   * What the caller may do in a project — the SAME resolution the backend's
   * `checkPrivilegesForApi` runs, so a positive answer here is exactly the answer the write
   * endpoints will give:
   *
   *   1. `/pm/auth/me` → the user behind the token (an expired/invalid token fails here).
   *   2. `/pm/projectuserrole?userId=` → the roleId this user holds in the project (no row = no access).
   *   3. `/pm/roles/search` for that role → its `privileges[]`.
   *
   * `tokenValid:false` = the token is dead; `hasRole:false` = live token, no role in this project.
   * Both are answers, not errors, so the caller can report them instead of crashing.
   */
  async getProjectPrivileges(projectId?: string): Promise<ProjectPrivileges> {
    const pid = String(projectId ?? this.cfg.projectId ?? '').trim();
    if (!pid) throw new Error(NEEDS_PROJECT);
    const pidNum = Number.parseInt(pid, 10);

    let userId: string | undefined;
    try {
      userId = await this.ensureUserId();
    } catch {
      userId = undefined;
    }
    if (!userId) {
      // Fail closed like the project-access guard: no identity, no provable role.
      return { projectId: pid, hasRole: false, tokenValid: false, privileges: [] };
    }

    const cacheKey = `${pid}|${userId}`;
    const hit = this.privilegesCache.get(cacheKey);
    if (hit && Date.now() - hit.at < SimplifyQaAdapter.PRIVILEGES_TTL_MS) return hit.value;

    let value: ProjectPrivileges;
    try {
      const roleId = (await this.memberRoles(userId)).get(pidNum);
      if (roleId == null || !Number.isFinite(roleId)) {
        value = { projectId: pid, userId, hasRole: false, tokenValid: true, privileges: [] };
      } else {
        const body = this.searchBody(
          [
            { column: 'id', value: [roleId] },
            { column: 'projectId', value: [pidNum] },
          ],
          { selectFields: ['id', 'name', 'privileges'], limit: 1 },
        );
        const raw = await this.http.postJson<any>('/pm/roles/search', body);
        const role = pickArray(raw, 'data', 'content')[0] as Record<string, unknown> | undefined;
        const roleName = str(role, 'name');
        const privilegeRows = role?.['privileges'];
        value = {
          projectId: pid,
          userId,
          roleId,
          ...(roleName ? { roleName } : {}),
          hasRole: true,
          tokenValid: true,
          privileges: Array.isArray(privilegeRows) ? privilegeRows.map((p) => String(p)) : [],
        };
      }
    } catch (e) {
      // A dead token is the one failure we can name exactly; anything else is a transport problem
      // and must surface as an error rather than as a silent "no privileges".
      const msg = e instanceof Error ? e.message : String(e);
      if (/\b401\b|unauthori[sz]ed|invalid.?token|token.?expired/i.test(msg)) {
        return { projectId: pid, hasRole: false, tokenValid: false, privileges: [] };
      }
      throw e;
    }

    this.privilegesCache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  private async listProjectsForUser(userId: string): Promise<ListResult<ProjectSummary>> {
    const projectIds = [...(await this.memberRoles(userId)).keys()];
    if (projectIds.length === 0) return withTotal([], { totalCount: 0 });
    const body = this.searchBody(
      [
        { column: 'id', value: projectIds },
        { column: 'deleted', value: false },
      ],
      { selectFields: ['id', 'code', 'name'], limit: projectIds.length },
    );
    const raw = await this.http.postJson<any>('/pm/project/search', body);
    const rows = pickArray(raw, 'data', 'content', 'projects');
    const projects = rows.map((n: any) => {
      const code = str(n, 'code');
      return {
        id: str(n, 'id', '_id', 'projectId') ?? '',
        ...(code ? { code } : {}),
        name: str(n, 'name', 'projectName') ?? '',
      };
    });
    return withTotal(projects, { totalCount: projects.length });
  }

  /** Best-effort row count for an entity `/search` endpoint — posts a minimal (limit 1) project-scoped
   *  search and reads the `totalCount` the backend returns alongside `data` (the same envelope shape
   *  every /search endpoint in this codebase uses, confirmed via the real sqa-ui
   *  `{ totalCount: number, data: [...] }` response typing). Never throws — counts are a nice-to-have
   *  for project_info, not worth failing the whole call over; any failure (or a missing totalCount)
   *  falls back to 0 / the returned row count. */
  private async searchTotalCount(path: string): Promise<number> {
    try {
      const projectId = this.requireProjectId();
      const body = this.searchBody(
        [{ column: 'deleted', value: false }, { column: 'projectId', value: projectId }],
        { limit: 1 },
      );
      const raw = await this.http.postJson<any>(path, body);
      if (typeof raw?.totalCount === 'number') return raw.totalCount;
      return pickArray(raw, 'data', 'content').length;
    } catch {
      return 0;
    }
  }

  private async listProjectsDirect(): Promise<ListResult<ProjectSummary>> {
    // Page to the end: one page (limit 100) would cap both the list and the count at 100.
    const PAGE = 100;
    const MAX_PAGES = 50;
    const seen = new Set<string>();
    const rows: any[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = this.searchBody(
        [{ column: 'deleted', value: false }],
        { selectFields: ['id', 'code', 'name'], startIndex: page * PAGE, limit: PAGE, rawOffset: true },
      );
      const got = pickArray(await this.http.postJson<any>('/pm/project/search', body), 'data', 'content', 'projects');
      for (const n of got) {
        const id = str(n, 'id', '_id', 'projectId') ?? '';
        if (!seen.has(id)) { seen.add(id); rows.push(n); }
      }
      if (got.length < PAGE) break;
    }
    const projects = rows.map((n: any) => {
      const code = str(n, 'code');
      return {
        id: str(n, 'id', '_id', 'projectId') ?? '',
        ...(code ? { code } : {}),
        name: str(n, 'name', 'projectName') ?? '',
      };
    });
    // ponytail: backend `totalCount` on /pm/project/search is unreliable (counts pre-filter). Trust
    // rows.length instead — every page was read above.
    return withTotal(projects, { totalCount: projects.length });
  }

  /** Decode the `userId` claim from the SQA JWT payload WITHOUT verifying the signature. Backend
   *  re-verifies on every call; this only needs the id for `/pm/projectuserrole`. Returns undefined
   *  on any parse failure or when the token isn't a JWT. */
  private jwtUserId(): string | undefined {
    const token = this.cfg.token;
    if (!token) return undefined;
    try {
      const t = token.startsWith('Bearer ') ? token.slice(7).trim() : token.trim();
      const seg = t.split('.')[1];
      if (!seg) return undefined;
      let b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
      b64 += '='.repeat((4 - (b64.length % 4)) % 4);
      const claims = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>;
      const v = claims['userId'] ?? claims['id'] ?? claims['sub'];
      if (typeof v === 'string' && v.length) return v;
      if (typeof v === 'number') return String(v);
      return undefined;
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------------------- Test cases (read)

  async listTestCases(q: TcQuery): Promise<ListResult<TcSummary>> {
    const projectId = this.requireProjectId();
    const fields: Array<{ column: string; value: any; regEx?: boolean | undefined }> = [
      { column: 'deleted', value: false },
      { column: 'projectId', value: projectId },
    ];
    if (q.search) fields.push({ column: 'name', value: q.search, regEx: true });
    // SQA test cases have NO `status`/`priority`/`stepCount` columns (checked against the backend
    // fields config + live rows on 2026-10-23). Reject rather than silently return zero rows.
    if (q.status) {
      throw new Error(
        'SimplifyQA test cases have no `status` field. Use `reviewApproveStatus` or a custom field ' +
          '(call sqa_query({ op:"custom_fields", collection:"testcases" })).',
      );
    }
    const phantom = (q.filters ?? []).find(
      (f) => f.column === 'status' || f.column === 'priority' || f.column === 'stepCount',
    );
    if (phantom) {
      throw new Error(
        `SimplifyQA test cases have no \`${phantom.column}\` field. Use \`reviewApproveStatus\`, ` +
          'a custom field via sqa_query, or remove this filter.',
      );
    }
    const createdBy = await this.resolveUserFilter(q.createdBy);
    if (createdBy != null) fields.push({ column: 'createdBy', value: createdBy });
    const updatedBy = await this.resolveUserFilter(q.updatedBy);
    if (updatedBy != null) fields.push({ column: 'updatedBy', value: updatedBy });
    if (q.storyId) fields.push({ column: 'userstoryId', value: Number.parseInt(numericId(q.storyId), 10) });
    if (q.moduleId) fields.push({ column: 'moduleId', value: Number.parseInt(numericId(q.moduleId), 10) });
    if (typeof q.obsolete === 'boolean') fields.push({ column: 'obsolete', value: q.obsolete });
    if (q.filters?.length) fields.push(...q.filters);
    const body = this.searchBody(fields, {
      startIndex: q.offset ?? 0,
      limit: q.limit ?? 100,
      rawOffset: true,
      // No priority/status/stepCount: those columns do not exist on SQA testcase rows.
      selectFields: ['id', 'code', 'name', 'tcType', 'executionType', 'obsolete'],
    });
    const raw = await this.http.postJson<any>('/tm/testcase/search', body);
    const rows = pickArray(raw, 'data', 'content', 'testCases');
    return withTotal(rows.map(toTcSummary), raw);
  }

  /** "me" → the caller's own numeric id (see ensureUserId); numeric string → number; anything
   *  else → undefined. Callers should have resolved a name to a numeric id via `list_users`. */
  private async resolveUserFilter(v: string | undefined): Promise<number | undefined> {
    if (!v) return undefined;
    const raw = v === 'me' ? ((await this.ensureUserId()) ?? '') : v.trim();
    if (!raw) return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : undefined;
  }

  /**
   * The caller's numeric SQA userId, resolved from whatever we already have:
   *   1. `QA_MCP_USER_ID` (explicit override — kept for old deployments and read-only setups),
   *   2. a `userId` claim on a session JWT,
   *   3. `GET /pm/auth/me` (works for API keys; one call per adapter instance, cached).
   * Returns undefined when none work — callers then fall back to unscoped behaviour rather than
   * failing the tool. A failed lookup is not cached: the project-access check fails closed on it,
   * so one network blip must not refuse every call until a reconnect.
   */
  private ensureUserId(): Promise<string | undefined> {
    const configured = this.cfg.userId?.trim();
    if (configured) return Promise.resolve(configured);
    const claim = this.jwtUserId();
    if (claim) return Promise.resolve(claim);
    if (!this.userIdPromise) {
      const p = this.fetchUserIdFromMe();
      this.userIdPromise = p;
      void p.then((id) => { if (!id && this.userIdPromise === p) this.userIdPromise = null; });
    }
    return this.userIdPromise;
  }

  /** This user's UI preferences (`GET /pm/preference/:userId`). The COLUMN preferences of the list
   *  views live here as arrays of visible fields: `epicFilter`, `featureFilter`, `userstoryFilter`,
   *  `defectFilter`, … Updating them is exactly what the UI's column-preference tick does. */
  async getUserPreferences(): Promise<Record<string, unknown>> {
    const userId = await this.ensureUserId();
    if (!userId) throw new Error('Could not identify your user from the token (set QA_MCP_USER_ID).');
    const raw = await this.http.getJson<any>(`/pm/preference/${userId}`);
    const doc = raw?.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : raw;
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc as Record<string, unknown> : {};
  }

  /** Partial preference update (`PUT /pm/preference/:userId`) — send only the keys you change. */
  async updateUserPreferences(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const userId = await this.ensureUserId();
    if (!userId) throw new Error('Could not identify your user from the token (set QA_MCP_USER_ID).');
    const raw = await this.http.putJson<any>(`/pm/preference/${userId}`, patch);
    const doc = raw?.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : raw;
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc as Record<string, unknown> : {};
  }

  /** Field catalogue of an entity's list view (`fieldType=allFields`) — e.g. entity 1 = Epic,
   *  2 = Feature, 3 = User Story. Used to resolve a column label ("Created On") to its key/shape. */
  async listViewFields(entityId: number, fieldType = 'allFields'): Promise<Array<Record<string, unknown>>> {
    const projectId = this.requireProjectId();
    const raw = await this.http.getJson<any>(`/pm/fields/${entityId}?projectId=${projectId}&fieldType=${encodeURIComponent(fieldType)}`);
    const rows = Array.isArray(raw) ? raw : pickArray(raw, 'data', 'fields', 'content');
    return Array.isArray(rows)
      ? (rows.filter((r: unknown) => !!r && typeof r === 'object') as Array<Record<string, unknown>>)
      : [];
  }

  /** `GET /pm/auth/me` → `{ userDetails: { id, username, email, … }, userPreference, … }`.
   *  Only `userDetails.id` is read: the payload also carries an agent token and the full
   *  preference/privilege set, which must never be logged or persisted. */
  private async fetchUserIdFromMe(): Promise<string | undefined> {
    try {
      const raw = await this.http.getJson<any>('/pm/auth/me');
      const details = raw?.userDetails ?? raw?.data?.userDetails ?? raw?.data ?? raw;
      const id = str(details, 'id', 'userId');
      if (id) {
        log(`identity: resolved user ${id} from /pm/auth/me (QA_MCP_USER_ID not set)`);
        return id;
      }
      log('identity: /pm/auth/me returned no userDetails.id — project scope falls back to /pm/project/search');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`identity: /pm/auth/me unavailable (${msg}) — set QA_MCP_USER_ID to scope projects and resolve "me"`);
    }
    return undefined;
  }

  /** Neutral test case, steps included. Accepts numeric id or business code (`TC_123`).
   *  `versionId` overrides which version's steps to load — omit to accept the TC's currently-
   *  selected version. When the resolved version differs from the doc's current selection, we
   *  also patch `currentVersionId` on the returned tc so callers can render "showing version X". */
  async getTestCase(id: string, versionId?: string): Promise<TestCase> {
    const raw = await this.fetchRawTestcase(id);
    if (!raw || Object.keys(raw).length === 0) {
      throw new Error(`test case ${id} not found`);
    }
    const tc = toTestCase(raw);
    // If the caller pinned a version, validate it exists on the TC — otherwise the /steps call
    // just returns an empty array for an unknown id and the user sees "no steps" for a typo.
    if (versionId) {
      const known = (tc.versions ?? []).some((v) => v.id === versionId);
      if (!known) throw new Error(`version ${versionId} not found on test case ${id}`);
    }
    let rows: any[] = [];
    try { rows = await this.fetchStepsCollection(id, raw, versionId); } catch { /* fall through — inline steps stay */ }
    const withSteps = rows.length > 0 ? applyCollectionSteps(tc, rows) : tc;
    // Overlay currentVersionId to the resolved one and flip isCurrent flags on versions[]. Apply
    // even when rows are empty — a caller who pinned versionId still expects the header + versions[]
    // to reflect that choice (a legitimately-empty version shouldn't fall back to the TC's default).
    // ponytail: mirror fetchStepsCollection's resolution ladder — the raw doc from /tm/testcase/getById
    // does NOT include a top-level versionId, only a `versions[]` array. Without the versions[0] fallback,
    // tc.currentVersionId stays undefined → tc_save emits versionsDetails.id:"" → backend mints a
    // phantom version and orphans the saved steps.
    const resolvedVer = versionId ?? tc.currentVersionId ?? (Array.isArray(tc.versions) ? tc.versions[0]?.id : undefined);
    const patched: TestCase = { ...withSteps, ...(resolvedVer ? { currentVersionId: resolvedVer } : {}) };
    if (resolvedVer && patched.versions?.length) {
      patched.versions = patched.versions.map((v) => ({ ...v, isCurrent: v.id === resolvedVer }));
    }
    if (rows.length > 0) {
      await Promise.all([
        this.hydrateFunctionNames(patched),
        this.hydrateObjectNames(patched),
      ]);
    }
    return patched;
  }

  private async fetchRawTestcase(id: string): Promise<any> {
    const raw = await this.http.getJson<any>(`/tm/testcase/getById/${numericId(id)}`);
    let doc: any = raw?.data ?? raw;
    if (Array.isArray(doc)) doc = doc.length > 0 ? doc[0] : {};
    return doc && typeof doc === 'object' ? doc : {};
  }

  private async fetchStepsCollection(tcId: string, rawTc: any, versionOverride?: string): Promise<any[]> {
    const projectId = this.requireProjectId();
    const tcNum = numericId(tcId);
    // Resolution order: explicit override → TC's currently-selected version (any of 4 field
    // names, depending on the read model — Java tries all four) → first entry in versions[].
    let versionId: string | undefined = versionOverride;
    if (!versionId) {
      versionId =
        str(rawTc, 'versionId', 'selectedVersionId') ??
        (rawTc?.versionsDetails && typeof rawTc.versionsDetails === 'object'
          ? str(rawTc.versionsDetails, 'id', '_id', 'versionId')
          : undefined);
      if (!versionId && Array.isArray(rawTc?.versions) && rawTc.versions.length > 0) {
        versionId = str(rawTc.versions[0], 'id', '_id');
      }
    }
    if (!versionId) return [];
    const path =
      '/tm/testcase/steps' +
      `?projectId=${projectId}` +
      `&tcfnId=${tcNum}` +
      `&versionId=${encodeURIComponent(versionId)}` +
      '&type=TC';
    const body = await this.http.getJson<any>(path);
    const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
    return rows as any[];
  }


  private async hydrateFunctionNames(tc: TestCase): Promise<void> {
    const ids = new Set<string>();
    for (const s of tc.steps) {
      if (s.stepType === 'function' && s.functionCall?.testCaseId) {
        ids.add(s.functionCall.testCaseId);
      }
    }
    if (!ids.size) return;
    try {
      const projectId = this.requireProjectId();
      const body = this.searchBody([
        { column: 'deleted', value: false },
        { column: 'projectId', value: projectId },
        { column: 'id', value: [...ids].map((x) => Number.parseInt(x, 10)).filter(Number.isFinite), regEx: false },
      ]);
      const raw = await this.http.postJson<any>('/tm/function/search', body);
      const rows = pickArray(raw, 'data', 'content', 'functions');
      const byId = new Map<string, { code?: string | undefined; name: string }>();
      for (const r of rows) {
        const rid = str(r, 'id', '_id', 'functionId');
        if (!rid) continue;
        byId.set(rid, { code: str(r, 'code'), name: str(r, 'name', 'title') ?? '' });
      }
      const versionNamesById = new Map<string, Map<string, string>>();
      await Promise.all([...ids].map(async (fnId) => {
        try {
          const versionRows = await this.fetchFunctionVersionRows(fnId);
          const versions = toVersionEntries(versionRows);
          versionNamesById.set(fnId, new Map(versions.map((v) => [v.id, v.name])));
        } catch {
          // Non-fatal per function: that step's version falls back to the bare uuid.
        }
      }));
      for (const s of tc.steps) {
        if (s.stepType !== 'function' || !s.functionCall) continue;
        const hit = byId.get(s.functionCall.testCaseId);
        if (hit) {
          if (hit.code) s.functionCall.testCaseCode = hit.code;
          if (hit.name) s.functionCall.testCaseName = hit.name;
        }
        const versionId = s.functionCall.versionId;
        if (versionId) {
          const versionName = versionNamesById.get(s.functionCall.testCaseId)?.get(versionId);
          if (versionName) s.functionCall.versionName = versionName;
        }
      }
    } catch {
      // Non-fatal: fall back to bare id in the render.
    }
  }

  /** For every step with an objectRef, resolve the object's display name (`disname`) via
   *  /tm/object/search (batched by distinct objectId). Mutates `objectRef.name` in place. Mirrors the
   *  FE's `defaultFieldsMap.get('objectId').map` behavior used by the Excel export
   *  (tcfn.service.js:2876) so the tool surface matches the UI.
   *
   *  An id that does NOT come back from the search (deleted, or never existed) is flagged
   *  `objectRef.missing = true` — this must NOT be silently indistinguishable from "the object
   *  exists but has no disname set" (see the "show me the objects in this test case" incident:
   *  falling back to the bare id with no signal made a genuinely-deleted object's step look
   *  identical to a normal one). Only a hard failure of the search call itself (network/auth) skips
   *  this — we can't tell missing-from-deleted apart from missing-from-can't-check in that case. */
  /** Object display names / thumbnails are what make a step renderable AND what the function matcher
   *  compares (`action|object name`). Takes anything with `steps` so a FUNCTION's steps can be hydrated
   *  exactly like a test case's. */
  private async hydrateObjectNames(tc: { steps: Step[] }): Promise<void> {
    const ids = new Set<string>();
    for (const s of tc.steps) {
      if (s.objectRef?.id && (!s.objectRef.name || !s.objectRef.thumbnailUrl)) ids.add(s.objectRef.id);
    }
    if (!ids.size) return;
    try {
      const projectId = this.requireProjectId();
      const body = this.searchBody([
        { column: 'deleted', value: false },
        { column: 'projectId', value: projectId },
        { column: 'id', value: [...ids].map((x) => Number.parseInt(x, 10)).filter(Number.isFinite), regEx: false },
      ]);
      const raw = await this.http.postJson<any>('/tm/object/search', body);
      const rows = pickArray(raw, 'data', 'content', 'objects');
      const byId = new Map<string, string>();
      const imgById = new Map<string, { thumbnailUrl?: string; pageScreenshotUrl?: string }>();
      // Locators too: a live-recording step carries the captured locators, not the object id, so the
      // function matcher compares them to recognise the same element even when the labels differ.
      const locById = new Map<string, Array<{ name: string; value: string }>>();
      for (const r of rows) {
        const rid = str(r, 'id', '_id');
        if (!rid) continue;
        const name = str(r, 'disname', 'description', 'placeholder');
        if (name) byId.set(rid, name);
        const attrs = Array.isArray(r?.attributes) ? r.attributes : [];
        const locs = attrs
          .filter((a: any) => typeof a?.name === 'string' && typeof a?.value === 'string' && a.value !== '')
          .map((a: any) => ({ name: String(a.name), value: String(a.value) }));
        if (locs.length) locById.set(rid, locs);
        const thumbnailUrl = toImageUrl(r?.thumbnail_url, this.cfg.baseUrl);
        const pageScreenshotUrl = toImageUrl(r?.pageScreenShot_url, this.cfg.baseUrl);
        if (thumbnailUrl || pageScreenshotUrl) {
          imgById.set(rid, { ...(thumbnailUrl ? { thumbnailUrl } : {}), ...(pageScreenshotUrl ? { pageScreenshotUrl } : {}) });
        }
      }
      for (const s of tc.steps) {
        if (!s.objectRef?.id) continue;
        const img = imgById.get(s.objectRef.id);
        if (img) Object.assign(s.objectRef, img);
        if (!s.objectRef.locators?.length) {
          const locs = locById.get(s.objectRef.id);
          if (locs) s.objectRef.locators = locs;
        }
        if (s.objectRef.name) continue;
        const name = byId.get(s.objectRef.id);
        if (name) s.objectRef.name = name;
        else s.objectRef.missing = true;
      }
    } catch {
      // Search call itself failed — can't distinguish missing-from-deleted vs. couldn't-check, so
      // don't flag anything; the bare id still renders (existing best-effort behavior).
    }
  }

  // ---------------------------------------------------------------------- Suites (read)

  async listSuites(): Promise<ListResult<SuiteSummary>> {
    const projectId = this.requireProjectId();
    const body = this.searchBody([
      { column: 'deleted', value: false },
      { column: 'projectId', value: projectId },
    ]);
    const raw = await this.http.postJson<any>('/tm/suites/search', body);
    const rows = pickArray(raw, 'data', 'content', 'suites');
    return withTotal(rows.map(toSuiteSummary), raw);
  }

  async getSuite(id: string): Promise<Suite> {
    const raw = await this.http.getJson<any>(`/tm/suites/${numericId(id)}`);
    let doc: any = raw?.data ?? raw;
    if (Array.isArray(doc)) doc = doc.length > 0 ? doc[0] : {};
    return toSuite(doc && typeof doc === 'object' ? doc : {});
  }

  // ---------------------------------------------------------------------- Stories (read)

  async listStories(q: StoryQuery): Promise<ListResult<StorySummary>> {
    const projectId = this.requireProjectId();
    const fields: Array<{ column: string; value: any; regEx?: boolean | undefined }> = [
      { column: 'deleted', value: false },
      { column: 'projectId', value: projectId },
    ];
    if (q.search) fields.push({ column: 'name', value: q.search, regEx: true });
    // SQA's userstory FK for sprint is `iterationId` — spec uses the neutral name `sprintId`.
    if (q.sprintId) fields.push({ column: 'iterationId', value: Number.parseInt(q.sprintId, 10) });
    if (q.releaseId) fields.push({ column: 'releaseId', value: Number.parseInt(q.releaseId, 10) });
    const createdBy = await this.resolveUserFilter(q.createdBy);
    if (createdBy != null) fields.push({ column: 'createdBy', value: createdBy });
    const updatedBy = await this.resolveUserFilter(q.updatedBy);
    if (updatedBy != null) fields.push({ column: 'updatedBy', value: updatedBy });
    const ownerId = await this.resolveUserFilter(q.ownerId);
    if (ownerId != null) fields.push({ column: 'ownerId', value: ownerId });
    if (q.filters?.length) fields.push(...q.filters);
    const body = this.searchBody(fields, { limit: q.limit ?? 50 });
    const raw = await this.http.postJson<any>('/pm/userstory/search', body);
    const rows = pickArray(raw, 'data', 'content', 'userStories', 'stories');
    return withTotal(rows.map(toStorySummary), raw);
  }

  async getStory(id: string): Promise<Story> {
    const resolvedId = await this.resolveStoryNumericId(id);
    const raw = await this.http.getJson<any>(`/pm/userstory/${resolvedId}`);
    const doc = Array.isArray(raw)
      ? (raw.length > 0 ? raw[0] : {})
      : (raw?.data && typeof raw.data === 'object' ? raw.data : raw);
    return toStory(doc && typeof doc === 'object' ? doc : {});
  }

  /** A US_XXX business key → the numeric userstoryId via `/pm/userstory/search`. Numeric passes
   *  through. SQA's GET-by-id parseInts the path, so a raw key would 404. */
  private async resolveStoryNumericId(ref: string): Promise<string> {
    if (!ref) return ref;
    if (/^\d+$/.test(ref)) return ref;
    const body = this.searchBody([{ column: 'code', value: ref }], { startIndex: 0, limit: 1 });
    const raw = await this.http.postJson<any>('/pm/userstory/search', body);
    const rows = pickArray(raw, 'data', 'content', 'userStories', 'stories');
    if (rows.length === 0) throw new Error(`Story not found for business key: ${ref}`);
    return str(rows[0], 'id', '_id', 'userstoryId') ?? ref;
  }

  // ---------------------------------------------------------------------- Defects (read)

  /** `POST /pm/defect/search` — same searchFields protocol as userstory/testcase search. */
  async listDefects(q: DefectQuery): Promise<ListResult<DefectSummary>> {
    const projectId = this.requireProjectId();
    const fields: Array<{ column: string; value: any; regEx?: boolean | undefined }> = [
      { column: 'deleted', value: false },
      { column: 'projectId', value: projectId },
    ];
    if (q.search) fields.push({ column: 'name', value: q.search, regEx: true });
    if (q.tcId) fields.push({ column: 'selectedTestCase.testcaseId', value: [Number.parseInt(numericId(q.tcId), 10)] });
    if (q.storyId) fields.push({ column: 'userstoryId', value: Number.parseInt(numericId(q.storyId), 10) });
    if (q.state) fields.push({ column: 'state', value: q.state });
    // ownerId is an array field — match with Mongo $in, not bare equality.
    const assignedTo = await this.resolveUserFilter(q.assignedTo);
    if (assignedTo != null) fields.push({ column: 'ownerId', value: { $in: [assignedTo] } });
    const createdBy = await this.resolveUserFilter(q.createdBy);
    if (createdBy != null) fields.push({ column: 'createdBy', value: createdBy });
    if (q.filters?.length) fields.push(...q.filters);
    const body = this.searchBody(fields, { limit: q.limit ?? 50, startIndex: q.offset ?? 0 });
    const raw = await this.http.postJson<any>('/pm/defect/search', body);
    const rows = pickArray(raw, 'data', 'content', 'defects');
    return withTotal(rows.map(toDefectSummary), raw);
  }

  // ---------------------------------------------------------------------- Tasks (read)

  /** `POST /pm/task/search` — same searchFields protocol as defect/userstory search. */
  async listTasks(q: TaskQuery): Promise<ListResult<TaskSummary>> {
    const projectId = this.requireProjectId();
    const fields: Array<{ column: string; value: any; regEx?: boolean | undefined }> = [
      { column: 'deleted', value: false },
      { column: 'projectId', value: projectId },
    ];
    if (q.search) fields.push({ column: 'name', value: q.search, regEx: true });
    if (q.storyId) fields.push({ column: 'userstoryId', value: Number.parseInt(numericId(q.storyId), 10) });
    if (q.state) fields.push({ column: 'state', value: q.state });
    const assignedTo = await this.resolveUserFilter(q.assignedTo);
    if (assignedTo != null) fields.push({ column: 'ownerId', value: { $in: [assignedTo] } });
    const createdBy = await this.resolveUserFilter(q.createdBy);
    if (createdBy != null) fields.push({ column: 'createdBy', value: createdBy });
    if (q.filters?.length) fields.push(...q.filters);
    const body = this.searchBody(fields, { limit: q.limit ?? 50, startIndex: q.offset ?? 0 });
    const raw = await this.http.postJson<any>('/pm/task/search', body);
    const rows = pickArray(raw, 'data', 'content', 'tasks');
    return withTotal(rows.map(toTaskSummary), raw);
  }

  // ---------------------------------------------------------------------- Backlog defaults

  /** Fetch the project's default `state` and `priority` for a backlog entity.
   *  parentId: 1 = Epic, 2 = Feature, 3 = User Story. Two-source resolution, in order:
   *
   *    1. `/pm/fields/:parentId?fieldType=defaultFld` — pick the field value marked `isDefault: true`;
   *       fall back to the first non-archived value (seed ships with `isDefault: false` everywhere
   *       until a customer configures one).
   *    2. If either state or priority is still missing, hit the entity's `/search` endpoint for one
   *       existing row in the project and steal its state / priority. Real data is a more reliable
   *       signal than the fields config, which is customer-scoped for Epic/Feature (parentIds 1/2)
   *       and can be missing entirely on customers that pre-date the seeding step.
   *
   *  Returns the value's `.key` (uppercase enum like `PROPOSED`, `MEDIUM`) — that is what the entity
   *  row stores; the field metadata declares `keyname: "key"` / `type: "KEY"` and the SQA UI binding
   *  (see epic-form.component.html: `keyname="key" type="KEY" [displayKeys]="{'field':'value'}"`) confirms
   *  key is stored, `.value` is only for display. Both sources are wrapped in try/catch: a transient
   *  upstream error must not block create; the backend surfaces its own error if invalid. */
  private async getBacklogDefaults(parentId: 1 | 2 | 3): Promise<{ state?: string; priority?: string }> {
    const cached = this.backlogDefaultsCache.get(parentId);
    if (cached) return cached;
    const projectId = this.requireProjectId();
    const p = (async () => {
      const out: { state?: string; priority?: string } = {};

      // Source 1: /pm/fields config.
      try {
        const raw = await this.http.getJson<any>(
          `/pm/fields/${parentId}?fieldType=defaultFld&projectId=${projectId}`,
        );
        const fields: any[] = Array.isArray(raw) ? raw : pickArray(raw, 'data', 'content', 'fields');
        const pick = (key: string): string | undefined => {
          const field = fields.find((f) => f?.key === key);
          const values: any[] = Array.isArray(field?.values) ? field.values : [];
          const chosen = values.find((v) => v?.isDefault === true && v?.archive !== true)
            ?? values.find((v) => v?.archive !== true);
          // Entity rows persist the uppercase enum (value.key). value.value is display-only.
          const stored = str(chosen ?? {}, 'key', 'value');
          return stored && stored.length > 0 ? stored : undefined;
        };
        const s = pick('state');
        const pr = pick('priority');
        if (s) out.state = s;
        if (pr) out.priority = pr;
      } catch { /* fall through to Source 2 */ }

      // Source 2: fall back to state/priority from an existing entity of the same kind in this project.
      // Epic has no priority field, so we only need state for parentId=1.
      const needsPriority = parentId !== 1 && !out.priority;
      if (!out.state || needsPriority) {
        try {
          const path = parentId === 1 ? '/pm/epic/search'
            : parentId === 2 ? '/pm/feature/search'
            : '/pm/userstory/search';
          // Story rows carry a scalar `projectId`; Epic/Feature rows carry an array `projectIds`.
          const filters: Array<{ column: string; value: any; regEx?: boolean | undefined }> = [
            { column: 'deleted', value: false },
            parentId === 3
              ? { column: 'projectId', value: projectId }
              : { column: 'projectIds', value: projectId },
          ];
          const body = this.searchBody(filters, { startIndex: 0, limit: 1 });
          const raw = await this.http.postJson<any>(path, body);
          const rows = pickArray(raw, 'data', 'content');
          const row = rows[0];
          if (row) {
            if (!out.state) {
              const s = str(row, 'state', 'status');
              if (s) out.state = s;
            }
            if (needsPriority) {
              const pr = str(row, 'priority');
              if (pr) out.priority = pr;
            }
          }
        } catch { /* leave out.state / out.priority absent; caller can override */ }
      }
      return out;
    })();
    this.backlogDefaultsCache.set(parentId, p);
    return p;
  }

  // ---------------------------------------------------------------------- Stories (write)

  async createStory(input: StoryInput): Promise<SavedRef> {
    const defaults = await this.getBacklogDefaults(3);
    const state = input.state ?? defaults.state;
    const priority = input.priority ?? defaults.priority;
    const body = {
      ...input,
      // SQA userstory expects a singular numeric projectId; fill from the connected project when omitted.
      projectId: input.projectId ?? this.requireProjectId(),
      ...(state ? { state } : {}),
      ...(priority ? { priority } : {}),
      customFields: input.customFields ?? {},
    };
    const raw = await this.http.postJson<any>('/pm/userstory', body);
    return toSavedRef(raw, true);
  }

  async updateStory(id: string, patch: StoryUpdate): Promise<SavedRef> {
    const resolvedId = await this.resolveStoryNumericId(id);
    // The backend's update controller runs its privilege check with `req.body.projectId`; a partial
    // patch that omits it makes that call throw (HTTP 500), which is why a story edit has to carry the
    // project. Default to the connected project — the story being edited belongs to it.
    const body = { projectId: this.requireProjectId(), ...patch };
    const raw = await this.http.putJson<any>(`/pm/userstory/${resolvedId}`, body);
    return toSavedRef(raw ?? { id: resolvedId }, false);
  }

  /** Attach ONE file to an epic / feature / user story. The backend has no standalone upload
   *  endpoint: the UI uploads files WITH the entity save (multipart `epicObj`/`featureObj`/
   *  `userstoryObj` + `filename1`), so this re-saves the item with its existing fields + attachments
   *  and the new file. Reads the attachments back and returns them. */
  async addAttachment(input: {
    entityType: 'epic' | 'feature' | 'userstory';
    itemId: string;
    fileName: string;
    contentType?: string | undefined;
    data: Uint8Array;
  }): Promise<{ id?: string; name: string; attachments: Array<Record<string, unknown>> }> {
    const spec = BACKLOG_ATTACHMENT_SPECS[input.entityType];
    const numeric = input.entityType === 'epic' ? await this.resolveEpicNumericId(input.itemId)
      : input.entityType === 'feature' ? await this.resolveFeatureNumericId(input.itemId)
      : await this.resolveStoryNumericId(input.itemId);
    const raw = await this.http.getJson<any>(`${spec.path}/${numeric}`);
    const doc = Array.isArray(raw) ? (raw.length ? raw[0] : {}) : (raw?.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : raw);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error(`${input.entityType} ${input.itemId} was not found in this project.`);
    }
    const obj: Record<string, unknown> = {};
    for (const k of spec.keys) if (doc[k] !== undefined) obj[k] = doc[k];
    if (input.entityType === 'epic') obj['id'] = doc['id'] ?? Number(numeric);
    if (input.entityType === 'userstory') obj['projectId'] = this.requireProjectId();
    obj['updateVersion'] = doc['updateVersion'] ?? 0;
    // Existing attachments (id-bearing rows) must be sent back or the save replaces the list.
    // They live on the attachment sub-resource, not on the item document.
    const existingAttachments = await this.entityAttachments(input.entityType, numeric);
    obj['attachments'] = existingAttachments.map((a) => { const c = { ...a }; delete c['file']; return c; });
    if (!this.http.putMultipartWithFiles) throw new Error('This connection cannot upload attachments.');
    await this.http.putMultipartWithFiles(
      `${spec.path}/${numeric}`, spec.objKey, obj,
      [{ partName: 'filename1', fileName: input.fileName, ...(input.contentType ? { contentType: input.contentType } : {}), data: input.data }],
    );
    const attachments = await this.entityAttachments(input.entityType, numeric);
    const saved = attachments.some((a) => String(a['original_name'] ?? a['name'] ?? '') === input.fileName);
    if (!saved) {
      throw new Error(
        `Uploaded "${input.fileName}" to ${input.entityType} ${input.itemId}, but reading the attachments back did not find it. ` +
        `Attachments now: ${attachments.map((a) => String(a['original_name'] ?? a['name'] ?? '')).join(', ') || '(none)'}`,
      );
    }
    return { ...(doc['id'] !== undefined ? { id: String(doc['id']) } : {}), name: input.fileName, attachments };
  }

  /** Attachments of an epic / feature / user story (`/pm/attachment/:id/:parentType`). */
  async entityAttachments(entityType: 'epic' | 'feature' | 'userstory', id: string): Promise<Array<Record<string, unknown>>> {
    const spec = BACKLOG_ATTACHMENT_SPECS[entityType];
    const projectId = this.requireProjectId();
    const raw = await this.http.getJson<any>(`/pm/attachment/${numericId(id)}/${spec.parentType}?projectId=${projectId}`);
    const rows = Array.isArray(raw) ? raw : pickArray(raw, 'data', 'content', 'attachments');
    return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>).filter((a) => a?.['deleted'] !== true) : [];
  }

  /** Remove one attachment (by id or stored/original name) from an epic / feature / user story.
   *  Mirrors the UI: mark the row `deleted:true` and re-save the item (multipart, no file part). */
  async removeAttachment(input: {
    entityType: 'epic' | 'feature' | 'userstory';
    itemId: string;
    attachment: string;
  }): Promise<{ removed: boolean; attachments: Array<Record<string, unknown>> }> {
    const spec = BACKLOG_ATTACHMENT_SPECS[input.entityType];
    const numeric = input.entityType === 'epic' ? await this.resolveEpicNumericId(input.itemId)
      : input.entityType === 'feature' ? await this.resolveFeatureNumericId(input.itemId)
      : await this.resolveStoryNumericId(input.itemId);
    const raw = await this.http.getJson<any>(`${spec.path}/${numeric}`);
    const doc = Array.isArray(raw) ? (raw.length ? raw[0] : {}) : (raw?.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : raw);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${input.entityType} ${input.itemId} was not found.`);
    const rows = await this.entityAttachments(input.entityType, numeric);
    const wanted = input.attachment.trim();
    const match = rows.find((a) => String(a['id']) === wanted || String(a['original_name'] ?? a['name'] ?? '') === wanted);
    if (!match) {
      throw new Error(
        `No attachment "${input.attachment}" on ${input.entityType} ${input.itemId}. Attachments: ` +
        (rows.map((a) => String(a['original_name'] ?? a['name'] ?? a['id'])).join(', ') || '(none)'),
      );
    }
    const obj: Record<string, unknown> = {};
    for (const k of spec.keys) if (doc[k] !== undefined) obj[k] = doc[k];
    if (input.entityType === 'epic') obj['id'] = doc['id'] ?? Number(numeric);
    if (input.entityType === 'userstory') obj['projectId'] = this.requireProjectId();
    obj['updateVersion'] = doc['updateVersion'] ?? 0;
    obj['attachments'] = rows.map((a) => {
      const c = { ...a };
      delete c['file'];
      if (String(c['id']) === String(match['id'])) c['deleted'] = true;
      return c;
    });
    if (!this.http.putMultipart) throw new Error('This connection cannot update attachments.');
    await this.http.putMultipart(`${spec.path}/${numeric}`, spec.objKey, obj);
    const attachments = await this.entityAttachments(input.entityType, numeric);
    const removed = !attachments.some((a) => String(a['id']) === String(match['id']));
    if (!removed) throw new Error(`Tried to delete "${input.attachment}" but it is still listed after the save.`);
    return { removed, attachments };
  }

  // ---------------------------------------------------------------------- Epics

  async listEpics(q: EpicQuery): Promise<ListResult<EpicSummary>> {
    const projectId = this.requireProjectId();
    const fields: Array<{ column: string; value: any; regEx?: boolean }> = [
      { column: 'deleted', value: false },
      // Epic is multi-project in SQA — filter for members of the current project via $in.
      { column: 'projectIds', value: projectId },
    ];
    if (q.search) fields.push({ column: 'name', value: q.search, regEx: true });
    if (q.state) fields.push({ column: 'state', value: q.state });
    const createdBy = await this.resolveUserFilter(q.createdBy);
    if (createdBy != null) fields.push({ column: 'createdBy', value: createdBy });
    const updatedBy = await this.resolveUserFilter(q.updatedBy);
    if (updatedBy != null) fields.push({ column: 'updatedBy', value: updatedBy });
    const ownerId = await this.resolveUserFilter(q.ownerId);
    if (ownerId != null) fields.push({ column: 'ownerId', value: ownerId });
    const body = this.searchBody(fields, {
      startIndex: q.offset ?? 0,
      limit: q.limit ?? 50,
    });
    const raw = await this.http.postJson<any>('/pm/epic/search', body);
    const rows = pickArray(raw, 'data', 'content', 'epics');
    return withTotal(rows.map(toEpicSummary), raw);
  }

  async getEpic(id: string): Promise<Epic> {
    const resolvedId = await this.resolveEpicNumericId(id);
    const raw = await this.http.getJson<any>(`/pm/epic/${resolvedId}`);
    const doc = Array.isArray(raw)
      ? (raw.length > 0 ? raw[0] : {})
      : (raw?.data && typeof raw.data === 'object' ? raw.data : raw);
    return toEpic(doc && typeof doc === 'object' ? doc : {});
  }

  async createEpic(input: EpicInput): Promise<SavedRef> {
    const defaults = await this.getBacklogDefaults(1);
    const state = input.state ?? defaults.state;
    const body = {
      ...input,
      projectIds: input.projectIds ?? [this.requireProjectId()],
      ...(state ? { state } : {}),
      customFields: input.customFields ?? {},
    };
    const raw = await this.http.postJson<any>('/pm/epic', body);
    return toSavedRef(raw, true);
  }

  async updateEpic(id: string, patch: EpicUpdate): Promise<SavedRef> {
    const resolvedId = await this.resolveEpicNumericId(id);
    const raw = await this.http.putJson<any>(`/pm/epic/${resolvedId}`, patch);
    return toSavedRef(raw ?? { id: resolvedId }, false);
  }

  /** EP_XXX business key → numeric epic id via `/pm/epic/search`. Numeric passes through. */
  private async resolveEpicNumericId(ref: string): Promise<string> {
    if (!ref) return ref;
    if (/^\d+$/.test(ref)) return ref;
    const body = this.searchBody([{ column: 'code', value: ref }], { startIndex: 0, limit: 1 });
    const raw = await this.http.postJson<any>('/pm/epic/search', body);
    const rows = pickArray(raw, 'data', 'content', 'epics');
    if (rows.length === 0) throw new Error(`Epic not found for business key: ${ref}`);
    return str(rows[0], 'id', '_id', 'epicId') ?? ref;
  }

  // ---------------------------------------------------------------------- Features

  async listFeatures(q: FeatureQuery): Promise<ListResult<FeatureSummary>> {
    const projectId = this.requireProjectId();
    const fields: Array<{ column: string; value: any; regEx?: boolean }> = [
      { column: 'deleted', value: false },
      { column: 'projectIds', value: projectId },
    ];
    if (q.search) fields.push({ column: 'name', value: q.search, regEx: true });
    if (q.state) fields.push({ column: 'state', value: q.state });
    if (q.epicId) fields.push({ column: 'epicId', value: Number.parseInt(q.epicId, 10) });
    const createdBy = await this.resolveUserFilter(q.createdBy);
    if (createdBy != null) fields.push({ column: 'createdBy', value: createdBy });
    const updatedBy = await this.resolveUserFilter(q.updatedBy);
    if (updatedBy != null) fields.push({ column: 'updatedBy', value: updatedBy });
    const ownerId = await this.resolveUserFilter(q.ownerId);
    if (ownerId != null) fields.push({ column: 'ownerId', value: ownerId });
    const body = this.searchBody(fields, {
      startIndex: q.offset ?? 0,
      limit: q.limit ?? 50,
    });
    const raw = await this.http.postJson<any>('/pm/feature/search', body);
    const rows = pickArray(raw, 'data', 'content', 'features');
    return withTotal(rows.map(toFeatureSummary), raw);
  }

  async getFeature(id: string): Promise<Feature> {
    const resolvedId = await this.resolveFeatureNumericId(id);
    const raw = await this.http.getJson<any>(`/pm/feature/${resolvedId}`);
    const doc = Array.isArray(raw)
      ? (raw.length > 0 ? raw[0] : {})
      : (raw?.data && typeof raw.data === 'object' ? raw.data : raw);
    return toFeature(doc && typeof doc === 'object' ? doc : {});
  }

  async createFeature(input: FeatureInput): Promise<SavedRef> {
    const defaults = await this.getBacklogDefaults(2);
    const state = input.state ?? defaults.state;
    const priority = input.priority ?? defaults.priority;
    const body = {
      ...input,
      projectIds: input.projectIds ?? [this.requireProjectId()],
      ...(state ? { state } : {}),
      ...(priority ? { priority } : {}),
      customFields: input.customFields ?? {},
    };
    const raw = await this.http.postJson<any>('/pm/feature', body);
    return toSavedRef(raw, true);
  }

  async updateFeature(id: string, patch: FeatureUpdate): Promise<SavedRef> {
    const resolvedId = await this.resolveFeatureNumericId(id);
    const raw = await this.http.putJson<any>(`/pm/feature/${resolvedId}`, patch);
    return toSavedRef(raw ?? { id: resolvedId }, false);
  }

  /** FT_XXX business key → numeric feature id via `/pm/feature/search`. Numeric passes through. */
  private async resolveFeatureNumericId(ref: string): Promise<string> {
    if (!ref) return ref;
    if (/^\d+$/.test(ref)) return ref;
    const body = this.searchBody([{ column: 'code', value: ref }], { startIndex: 0, limit: 1 });
    const raw = await this.http.postJson<any>('/pm/feature/search', body);
    const rows = pickArray(raw, 'data', 'content', 'features');
    if (rows.length === 0) throw new Error(`Feature not found for business key: ${ref}`);
    return str(rows[0], 'id', '_id', 'featureId') ?? ref;
  }

  // ---------------------------------------------------------------------- Modules, releases, sprints

  /** Pages internally until the server returns a short page (or the total is reached) — the tool
   *  has no limit/offset of its own and always wants the WHOLE project tree; `searchBody`'s default
   *  page size (100) previously truncated any project with more modules than that silently. */
  async listModules(): Promise<ListResult<ModuleSummary>> {
    const projectId = this.requireProjectId();
    const PAGE = 100;
    const SAFETY_CAP = 5000;
    const rows: any[] = [];
    let totalCount: number | undefined;
    let startIndex = 0;
    for (;;) {
      const body = this.searchBody(
        [
          { column: 'projectId', value: projectId },
          { column: 'deleted', value: false },
        ],
        { selectFields: ['id', 'code', 'name', 'parentId', 'isRoot', 'childIds'], startIndex, limit: PAGE },
      );
      const raw = await this.http.postJson<any>('/pm/module/search', body);
      const page = pickArray(raw, 'data', 'content', 'modules');
      if (totalCount === undefined) {
        const t = raw?.totalCount ?? raw?.total ?? raw?.totalRecords;
        if (typeof t === 'number') totalCount = t;
      }
      rows.push(...page);
      if (page.length < PAGE) break;
      if (rows.length >= SAFETY_CAP) break;
      if (totalCount !== undefined && rows.length >= totalCount) break;
      startIndex += PAGE;
    }
    const mapped = rows.map(toModuleSummary) as ListResult<ModuleSummary>;
    if (totalCount !== undefined) mapped.totalCount = totalCount;
    return mapped;
  }

  /** GET /pm/module/:id — server returns an array; empty array → NotFound. */
  async getModule(id: string): Promise<ModuleDetail> {
    const raw = await this.http.getJson<any>(`/pm/module/${numericId(id)}`);
    const rows = Array.isArray(raw) ? raw : pickArray(raw, 'data', 'content');
    const doc = rows[0];
    if (!doc) throw new Error(`Module ${id} not found.`);
    const summary = toModuleSummary(doc);
    const code = str(doc, 'code');
    const description = str(doc, 'description');
    const projectId = doc?.projectId != null ? String(doc.projectId) : undefined;
    const childIds = Array.isArray(doc?.childIds)
      ? doc.childIds.filter((n: unknown): n is number => Number.isFinite(n))
      : undefined;
    const isRoot = typeof doc?.isRoot === 'boolean' ? doc.isRoot : undefined;
    return {
      ...summary,
      ...(code ? { code } : {}),
      ...(description ? { description } : {}),
      ...(childIds ? { childIds } : {}),
      ...(projectId ? { projectId } : {}),
      ...(isRoot !== undefined ? { isRoot } : {}),
    };
  }

  /** POST /pm/module — server validates: name+isRoot+projectId required; parentId ignored when
   *  isRoot:true. Duplicate name per project is rejected server-side. When `input.children` is
   *  present, walks the subtree depth-first: creates the root, then each child under the id
   *  returned for its parent. `childIds:[]` matches the working UI payload byte-for-byte.
   *  Backend has no tx endpoint: on mid-walk failure the returned tree carries `failedAt`, and
   *  every node BEFORE that point is already persisted. */
  async createModule(input: ModuleCreateInput): Promise<ModuleSaved> {
    const root = await this.postOneModule(input.name, input.isRoot, input.projectId, input.description, input.parentId);
    if (!input.isRoot && input.parentId) {
      root.linkWarning = await this.checkChildLinked(input.parentId, root.id);
    }
    if (input.children?.length) {
      root.children = await this.createSubtree(input.children, root.id, input.projectId, input.name, root);
    }
    return root;
  }

  private async checkChildLinked(parentId: string, childId: string): Promise<string | undefined> {
    try {
      const parent = await this.getModule(parentId);
      const numChildId = Number.parseInt(childId, 10);
      if (parent.childIds?.includes(numChildId)) return undefined;
      return `Created with parentId=${parentId}, but a fresh read of module ${parentId} does not yet list ` +
        `${childId} in its childIds — it may not appear under its parent in the Module screen tree until that catches up.`;
    } catch {
      return undefined;
    }
  }

  /** Depth-first walk of a subtree. Stops at the first failure — everything already POSTed stays
   *  (no rollback endpoint upstream) and the failure is bubbled back on the root via `failedAt`. */
  private async createSubtree(
    children: ModuleTreeInput[],
    parentId: string,
    projectId: string,
    parentPath: string,
    root: ModuleSaved,
  ): Promise<ModuleSaved[]> {
    const out: ModuleSaved[] = [];
    for (const child of children) {
      const path = `${parentPath}/${child.name}`;
      if (root.failedAt) return out;
      let saved: ModuleSaved;
      try {
        saved = await this.postOneModule(child.name, false, projectId, child.description, parentId);
      } catch (e) {
        root.failedAt = { path, error: e instanceof Error ? e.message : String(e) };
        return out;
      }
      saved.linkWarning = await this.checkChildLinked(parentId, saved.id);
      if (child.children?.length) {
        saved.children = await this.createSubtree(child.children, saved.id, projectId, path, root);
      }
      out.push(saved);
    }
    return out;
  }

  private async postOneModule(
    name: string,
    isRoot: boolean,
    projectId: string,
    description: string | undefined,
    parentId: string | undefined,
  ): Promise<ModuleSaved> {
    const payload: Record<string, unknown> = {
      name,
      isRoot,
      projectId: Number.parseInt(projectId, 10),
      childIds: [],
    };
    if (description) payload['description'] = description;
    if (!isRoot && parentId) payload['parentId'] = Number.parseInt(parentId, 10);
    const raw = await this.http.postJson<any>('/pm/module', payload);
    return toModuleSaved(raw, name);
  }


  async updateModule(id: string, patch: ModuleUpdateInput): Promise<SavedRef> {
    const resolvedId = numericId(id);
    let raw: any;
    if (patch.name !== undefined || patch.description !== undefined) {
      const projectId = patch.projectId
        ? Number.parseInt(numericId(patch.projectId), 10)
        : this.requireProjectId();
      const body: Record<string, unknown> = { projectId };
      if (patch.name !== undefined) body['name'] = patch.name;
      if (patch.description !== undefined) body['description'] = patch.description;
      raw = await this.http.putJson<any>(`/pm/module/${resolvedId}`, body);
    }
    if (patch.parentId !== undefined) {
      await this.reparentModule(resolvedId, patch.parentId);
    }
    return toSavedRef(raw ?? { id: resolvedId }, false);
  }

  private async reparentModule(id: string, newParentId: string): Promise<void> {
    if (newParentId === '') {
      await this.http.putJson<any>(`/pm/module/bulkupdate/${id}`, { isRoot: true });
      return;
    }
    const targetId = numericId(newParentId);
    if (targetId === id) {
      throw new Error(`Cannot set module ${id} as its own parent.`);
    }
    const all = await this.listModules();
    const childrenOf = new Map<string, string[]>();
    for (const m of all) if (m.parentId) childrenOf.set(m.parentId, [...(childrenOf.get(m.parentId) ?? []), m.id]);
    const descendants = new Set<string>();
    const stack = [...(childrenOf.get(id) ?? [])];
    while (stack.length) {
      const next = stack.pop()!;
      if (descendants.has(next)) continue;
      descendants.add(next);
      stack.push(...(childrenOf.get(next) ?? []));
    }
    if (descendants.has(targetId)) {
      throw new Error(`Cannot move module ${id} under ${targetId} — it is already a descendant of ${id} (would detach the subtree).`);
    }
    if (!all.some((m) => m.id === targetId)) {
      throw new Error(`Parent module ${targetId} not found.`);
    }
    await this.http.putJson<any>(`/pm/module/bulkupdate/${id}`, { parentId: Number.parseInt(targetId, 10), isRoot: false });
  }

  /** PDF reports for one execution — the same `/reports/pdfV2/*` endpoints the SimplifyQA UI downloads
   *  from, so content and format match the UI. The path values (`type`/`executionType`/`executionStyle`)
   *  come from the execution doc, exactly as the UI takes them from its `displayDataExecution`.
   *  Protected-parameter masking is done by the report service itself — nothing is re-rendered here. */
  async downloadReports(input: { runId: string; kinds: ReportKind[]; outDir: string }): Promise<{ scope: 'testcase' | 'suite'; runLabel: string; files: ReportFile[]; notes: string[] }> {
    const projectId = this.requireProjectId();
    const execNum = Number.parseInt(numericId(input.runId), 10);
    if (!Number.isFinite(execNum)) throw new Error(`"${input.runId}" is not a valid execution id.`);
    if (!this.http.getBinary) throw new Error('This connection cannot download binary reports.');
    const execDoc = await this.fetchExecDoc(execNum, projectId);
    if (!execDoc) throw new Error(`Execution ${input.runId} was not found in this project.`);
    const state = mapRunState(str(execDoc, 'status') ?? '');
    if (state === 'queued' || state === 'running') {
      throw new Error(`Execution ${input.runId} is still ${state} — reports can only be generated once it has completed.`);
    }
    const isSuite = String(execDoc.type ?? '').toUpperCase() === 'SUITE';
    const type = str(execDoc, 'type') ?? '';
    const executionType = str(execDoc, 'executionType') ?? '';
    const executionStyle = str(execDoc, 'executionStyle') ?? '';
    const code = str(execDoc, 'executionTypeCode') ?? (isSuite ? 'SUITE' : 'TC');
    const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    const enc = encodeURIComponent;
    const safe = (v: string) => v.replace(/[^\w.\-()\s]+/g, '_').trim() || 'report';
    await mkdir(input.outDir, { recursive: true });
    const files: ReportFile[] = [];
    const notes: string[] = [];

    const fetchPdf = async (path: string, what: string): Promise<Uint8Array> => {
      let res: { data: Uint8Array; contentType: string };
      try {
        res = await this.http.getBinary!(path);
      } catch (e) {
        throw new Error(`${what}: report generation failed — ${e instanceof Error ? e.message : String(e)}`);
      }
      const head = Buffer.from(res.data.subarray(0, 5)).toString('latin1');
      if (!head.startsWith('%PDF')) {
        throw new Error(`${what}: the report service did not return a PDF (${res.contentType || 'unknown type'}): ${Buffer.from(res.data.subarray(0, 200)).toString('utf8')}`);
      }
      return res.data;
    };
    const save = async (kind: ReportKind, label: string, fileName: string, data: Uint8Array) => {
      const path = join(input.outDir, safe(fileName));
      await writeFile(path, data);
      files.push({ kind, label, path, bytes: data.byteLength });
    };
    const needTcValues = () => {
      if (!type || !executionType || !executionStyle) {
        throw new Error(`Execution ${input.runId} is missing type/executionType/executionStyle (got "${type}"/"${executionType}"/"${executionStyle}") — cannot build the report request.`);
      }
    };
    const tcUrl = (kind: 'detailed' | 'summary', runUuid: string) =>
      `/reports/pdfV2/tc-${kind === 'detailed' ? 'detail' : 'summary'}/${projectId}/${execNum}/${enc(type)}/${enc(executionType)}/${enc(executionStyle)}/${enc(runUuid)}?tz=${tz}`;
    const pickRun = (runs: any[]): any => runs.find((r) => String(r?.status ?? '').toUpperCase() === 'FAILED') ?? runs[0];
    const kindWord = (k: ReportKind) => (k === 'detailed' ? 'Detailed' : 'Summary');

    if (!isSuite) {
      if (input.kinds.includes('suite')) throw new Error('The suite report is only available for a suite execution; this is a test case execution.');
      const rawRuns = await this.http.getJson<any>(`/exec/report/${execNum}/${projectId}`);
      const runs = Array.isArray(rawRuns) ? notDeleted(rawRuns) : rawRuns;
      if (!Array.isArray(runs) || runs.length === 0) throw new Error(`Execution ${input.runId} has no run results to report on.`);
      const chosen = pickRun(runs);
      const runUuid = str(chosen, 'id', '_id') ?? '';
      if (!runUuid) throw new Error(`Execution ${input.runId}: could not find the run id for its results.`);
      if (runs.length > 1) notes.push(`Execution ${execNum} has ${runs.length} runs; used ${String(chosen?.status ?? '').toUpperCase() === 'FAILED' ? 'the first FAILED one' : 'the first one'} (${runUuid}).`);
      needTcValues();
      for (const kind of input.kinds) {
        const data = await fetchPdf(tcUrl(kind as 'detailed' | 'summary', runUuid), `${kind} report`);
        await save(kind, `${kindWord(kind)} report for ${code}`, `${code}_EX-${execNum}(${kindWord(kind)}).pdf`, data);
      }
      return { scope: 'testcase', runLabel: `EX-${execNum}`, files, notes };
    }

    // SUITE
    const suiteNum = Number(execDoc.executionTypeId ?? 0);
    for (const kind of input.kinds) {
      if (kind === 'suite') {
        const data = await fetchPdf(`/reports/pdfV2/su/${enc(type)}/${projectId}/${execNum}?tz=${tz}`, 'suite overall report');
        await save('suite', `Suite overall report for ${code}`, `${code}_EX-${execNum}.pdf`, data);
        continue;
      }
      needTcValues();
      const items: any[] = Array.isArray(execDoc.executionItems) ? execDoc.executionItems : [];
      if (!items.length) throw new Error(`Suite execution ${input.runId} has no test cases to report on.`);
      for (const it of items) {
        const name = str(it, 'name') ?? `TC_${str(it, 'testcaseId') ?? '?'}`;
        const raw = await this.http.postJson<any>('/reports/execution/getExecutionRuns', {
          type: 'SU', projectId, parentId: suiteNum, executionId: execNum,
          tcId: Number.parseInt(numericId(str(it, 'testcaseId') ?? ''), 10),
          ...(str(it, 'versionId') ? { tcVersionId: str(it, 'versionId') } : {}),
          ...(str(it, 'stepId') ? { stepId: str(it, 'stepId') } : {}),
        });
        const runs: any[] = Array.isArray(raw?.data) ? raw.data : [];
        const runUuid = runs.length ? (str(pickRun(runs), 'id', '_id') ?? '') : '';
        if (!runUuid) { notes.push(`${name}: no run results (not executed) — skipped.`); continue; }
        const data = await fetchPdf(tcUrl(kind, runUuid), `${kind} report for ${name}`);
        await save(kind, `${kindWord(kind)} report for ${name}`, `${name}_EX-${execNum}(${kindWord(kind)}).pdf`, data);
      }
    }
    return { scope: 'suite', runLabel: `EX-${execNum}`, files, notes };
  }

  /** PATCH /pm/{epic|feature|userstory|defect|task} with `{ids, projectId, isDelete}`. Epic / feature /
   *  story / defect are two-phase (`isDelete:false` returns the per-id dependency rows, and `isDelete:true`
   *  silently skips ids that still have dependents, returning those rows again). Task has no dry-run and
   *  no dependency check. `deleted` is therefore decided by the response shape: dependency rows come
   *  back as an ARRAY, a real delete does not. */
  async deleteBacklogItem(input: { kind: BacklogKind; id: string; confirm?: boolean }): Promise<BacklogDeleteResult> {
    const path = { epic: '/pm/epic', feature: '/pm/feature', story: '/pm/userstory', defect: '/pm/defect', task: '/pm/task' }[input.kind];
    const id = Number.parseInt(numericId(input.id), 10);
    if (!Number.isFinite(id)) throw new Error(`deleteBacklogItem: "${input.id}" is not a numeric id.`);
    const projectId = this.requireProjectId();
    const confirm = input.confirm === true;
    if (input.kind === 'task') {
      if (!confirm) return { dryRun: true, deleted: false, dependencies: [] };
      await this.http.patchJson<any>(path, { ids: [id], projectId });
      return { dryRun: false, deleted: true, dependencies: [] };
    }
    const raw = await this.http.patchJson<any>(path, { ids: [id], projectId, isDelete: confirm });
    const data = raw?.data ?? raw;
    const rows: any[] = Array.isArray(data) ? data : [];
    const dependencies = rows
      .filter((r) => r && typeof r === 'object')
      .map((r) => {
        const counts: Record<string, number[]> = {};
        for (const [k, v] of Object.entries(r)) if (k.endsWith('Arr') && Array.isArray(v) && v.length) counts[k] = v as number[];
        return { id: Number(r.id), counts };
      });
    const blocked = dependencies.some((d) => Object.keys(d.counts).length > 0);
    return { dryRun: !confirm, deleted: confirm && !Array.isArray(data) && !blocked, dependencies };
  }

  /** PATCH /pm/module — two-phase per module.controller.js:94. `confirm:false` returns the per-id
   *  dependency footprint (test cases, functions, params, objects, defects, user stories). `confirm:true`
   *  triggers the actual delete: server drops only ids with EMPTY dependencies; ids with references are
   *  silently skipped — we still return that list so the caller can act on it.
   *  ponytail: one method, `confirm` flag; mirrors the backend's two-call contract. */
  async deleteModule(input: { ids: string[]; projectId: string; confirm?: boolean }): Promise<ModuleDeleteResult> {
    const numIds = input.ids.map((id) => Number.parseInt(numericId(id), 10));
    const projectId = Number.parseInt(input.projectId, 10);
    const isDelete = input.confirm === true;
    const raw = await this.http.patchJson<any>(
      '/pm/module',
      { ids: numIds, projectId, isDelete },
    );
    const arr = Array.isArray(raw) ? raw : pickArray(raw, 'data', 'content');
    const dependencies: ModuleDependency[] = arr
      .filter((r: any) => r && typeof r === 'object')
      .map((r: any) => ({
        id: Number(r.id),
        tcArr: Array.isArray(r.tcArr) ? r.tcArr : [],
        fnArr: Array.isArray(r.fnArr) ? r.fnArr : [],
        parameterArr: Array.isArray(r.parameterArr) ? r.parameterArr : [],
        objArr: Array.isArray(r.objArr) ? r.objArr : [],
        defectArr: Array.isArray(r.defectArr) ? r.defectArr : [],
        usArr: Array.isArray(r.usArr) ? r.usArr : [],
      }));
    return { dryRun: !isDelete, dependencies };
  }

  /** PUT /tm/tcfnversion/delete — soft-delete ONE version of a TC or FN. Two-phase per
   *  tcfnversion.service.js:30 — `isDelete:false` (or `isDelete:true` with non-empty deps) →
   *  returns the dependency array unchanged; `isDelete:true` with EMPTY deps → soft-deletes the
   *  tcfn_version row + its steps + testdata + testdata iterations.
   *
   *  ponytail: one method, `confirm` flag. Response shape decides `deleted`: if every dep row is
   *  fully empty (all `*Arr` are `{}` maps), the server actually deleted; otherwise it refused
   *  and just handed back the deps. We do not assume — we inspect. */
  async deleteVersion(input: VersionDeleteInput): Promise<VersionDeleteResult> {
    const projectId = this.requireProjectId();
    const parentType = input.kind === 'tc' ? 'TC' : 'FN';
    const isDelete = input.confirm === true;
    const body = {
      id: input.versionId,
      parentId: Number.parseInt(numericId(input.parentId), 10),
      parentType,
      projectId,
      name: input.versionName,
      isDelete,
    };
    const raw = await this.http.putJson<any>('/tm/tcfnversion/delete', body);
    const data = raw?.data ?? raw;
    // Distinguish "dep array" from "delete result": the service returns an ARRAY of dep rows for
    // the dry-run + refused-delete branches, and a single mongo doc (findOneAndUpdate result) for
    // the successful delete branch. Array → parse deps; single doc → deleted.
    if (Array.isArray(data)) {
      const dependencies = data
        .filter((r: any) => r && typeof r === 'object')
        .map((r: any) => normalizeVersionDep(r, parentType));
      const hasBlockers = dependencies.some((d) => !versionDepIsEmpty(d));
      return { dryRun: !isDelete, deleted: false, dependencies, hasBlockers };
    }
    // Single doc → successful delete (or upsert-echo when nothing matched, but the service only
    // reaches that branch after emptyIds.push).
    return { dryRun: false, deleted: true, dependencies: [], hasBlockers: false };
  }

  /** `list_releases` has no limit/offset of its own — it always wants the WHOLE visible set — so
   *  page internally past `searchBody`'s default 100 instead of silently truncating (same fix as
   *  listModules). */
  async listReleases(q: ReleaseQuery): Promise<ListResult<ReleaseSummary>> {
    const fields: Array<{ column: string; value: any }> = [{ column: 'deleted', value: false }];
    if (q.scope === 'project') fields.push({ column: 'projectIds', value: this.requireProjectId() });
    const PAGE = 100;
    const SAFETY_CAP = 5000;
    const rows: any[] = [];
    let totalCount: number | undefined;
    let startIndex = 0;
    for (;;) {
      const body = this.searchBody(fields, { startIndex, limit: PAGE });
      const raw = await this.http.postJson<any>('/pm/release/search', body);
      const page = pickArray(raw, 'data', 'content', 'releases');
      if (totalCount === undefined) {
        const t = raw?.totalCount ?? raw?.total ?? raw?.totalRecords;
        if (typeof t === 'number') totalCount = t;
      }
      rows.push(...page);
      if (page.length < PAGE) break;
      if (rows.length >= SAFETY_CAP) break;
      if (totalCount !== undefined && rows.length >= totalCount) break;
      startIndex += PAGE;
    }
    const mapped = rows.map(toReleaseSummary) as ListResult<ReleaseSummary>;
    if (totalCount !== undefined) mapped.totalCount = totalCount;
    return mapped;
  }

  /** Same unconditional-pagination fix as listReleases — `list_sprints` has no limit/offset either. */
  async listSprints(q: SprintQuery): Promise<ListResult<SprintSummary>> {
    const fields: Array<{ column: string; value: any }> = [{ column: 'deleted', value: false }];
    if (q.releaseId) fields.push({ column: 'releaseId', value: Number.parseInt(q.releaseId, 10) });
    const PAGE = 100;
    const SAFETY_CAP = 5000;
    const rows: any[] = [];
    let totalCount: number | undefined;
    let startIndex = 0;
    for (;;) {
      const body = this.searchBody(fields, { startIndex, limit: PAGE });
      const raw = await this.http.postJson<any>('/pm/sprint/search', body);
      const page = pickArray(raw, 'data', 'content', 'sprints');
      if (totalCount === undefined) {
        const t = raw?.totalCount ?? raw?.total ?? raw?.totalRecords;
        if (typeof t === 'number') totalCount = t;
      }
      rows.push(...page);
      if (page.length < PAGE) break;
      if (rows.length >= SAFETY_CAP) break;
      if (totalCount !== undefined && rows.length >= totalCount) break;
      startIndex += PAGE;
    }
    const mapped = rows.map(toSprintSummary) as ListResult<SprintSummary>;
    if (totalCount !== undefined) mapped.totalCount = totalCount;
    return mapped;
  }

  /** POST /pm/users/search — the customer's users (router mounted at `/pm/users`, plural — see
   *  project-management/express-app.js:181). Backend auto-scopes non-admin callers to users in
   *  their assigned projects. Optional `projectId` narrows to that project's members; optional
   *  `search` is a case-insensitive regex over `name`. */
  async listUsers(q: UserQuery): Promise<ListResult<UserSummary>> {
    const fields: Array<{ column: string; value: any; regEx?: boolean }> = [
      { column: 'deleted', value: false },
    ];
    if (q.search) fields.push({ column: 'name', value: q.search, regEx: true });
    if (q.projectId) fields.push({ column: 'projectIds', value: Number.parseInt(q.projectId, 10) });
    const body = this.searchBody(fields, {
      startIndex: q.offset ?? 0,
      limit: q.limit ?? 100,
      selectFields: ['id', 'name', 'email', 'username', 'status'],
    });
    const raw = await this.http.postJson<any>('/pm/users/search', body);
    const rows = pickArray(raw, 'data', 'content', 'users');
    const users: UserSummary[] = rows.map((n: any) => {
      const name = str(n, 'name');
      const email = str(n, 'email');
      const username = str(n, 'username');
      const status = str(n, 'status');
      return {
        id: str(n, 'id', '_id', 'userId') ?? '',
        ...(name ? { name } : {}),
        ...(email ? { email } : {}),
        ...(username ? { username } : {}),
        ...(status ? { status } : {}),
      };
    });
    return withTotal(users, raw);
  }

  /** Resolve a mixed list of user references (numeric id, email, or full name) to numeric user ids.
   *  Used for Watch Lists (the UI's email button stores `mailersList.users` as ids). */
  async resolveUserIds(refs: Array<string | number>): Promise<number[]> {
    const out = new Set<number>();
    for (const raw of refs) {
      if (typeof raw === 'number') { out.add(raw); continue; }
      const ref = String(raw).trim();
      if (!ref) continue;
      if (/^\d+$/.test(ref)) { out.add(Number.parseInt(ref, 10)); continue; }
      const find = async (column: 'email' | 'name'): Promise<number | undefined> => {
        const rawRes = await this.http.postJson<any>('/pm/users/search', this.searchBody(
          [{ column, value: ref }],
          { startIndex: 0, limit: 20, selectFields: ['id', 'name', 'email', 'username', 'status'] },
        ));
        const rows = pickArray(rawRes, 'data', 'content', 'users');
        const hit = rows.find((u: any) => String(str(u, column) ?? '').trim().toLowerCase() === ref.toLowerCase());
        const id = hit ? Number.parseInt(str(hit, 'id', '_id', 'userId') ?? '', 10) : NaN;
        return Number.isFinite(id) ? id : undefined;
      };
      const id = (await find('email')) ?? (await find('name'));
      if (id == null) throw new Error(`No user matches "${raw}" (by email, name or id). Check the address with list_users.`);
      out.add(id);
    }
    return [...out];
  }

  /** Add users to an epic/feature/story WATCH LIST (`mailersList.users`) — exactly what the UI's
   *  email button saves. Existing watchers are preserved; the item is re-read to confirm. */
  async addWatchListUsers(input: {
    entityType: 'epic' | 'feature' | 'userstory';
    itemId: string;
    users: Array<string | number>;
  }): Promise<{ users: number[]; mailersList: Record<string, unknown> }> {
    const spec = BACKLOG_ATTACHMENT_SPECS[input.entityType];
    const numeric = input.entityType === 'epic' ? await this.resolveEpicNumericId(input.itemId)
      : input.entityType === 'feature' ? await this.resolveFeatureNumericId(input.itemId)
      : await this.resolveStoryNumericId(input.itemId);
    const ids = await this.resolveUserIds(input.users);
    const readRaw = async (): Promise<Record<string, any>> => {
      const raw = await this.http.getJson<any>(`${spec.path}/${numeric}`);
      const doc = Array.isArray(raw) ? (raw.length ? raw[0] : {}) : (raw?.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : raw);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${input.entityType} ${input.itemId} was not found.`);
      return doc;
    };
    const before = await readRaw();
    const ml = before['mailersList'] && typeof before['mailersList'] === 'object' ? before['mailersList'] : {};
    const toNums = (v: unknown): number[] => Array.isArray(v) ? v.map((x) => Number(x)).filter(Number.isFinite) : [];
    const mailersList = {
      users: [...new Set([...toNums(ml['users']), ...ids])],
      nonUsers: toNums(ml['nonUsers']),
      groups: toNums(ml['groups']),
    };
    const version = typeof before['updateVersion'] === 'number' ? before['updateVersion'] : 0;
    if (input.entityType === 'epic') await this.updateEpic(numeric, { mailersList, updateVersion: version });
    else if (input.entityType === 'feature') await this.updateFeature(numeric, { mailersList, updateVersion: version });
    else await this.updateStory(numeric, { mailersList });
    const after = await readRaw();
    const users = toNums(after['mailersList']?.['users']);
    const missing = ids.filter((id) => !users.includes(id));
    if (missing.length) throw new Error(`Tried to add user(s) ${missing.join(', ')} to the Watch List, but the read-back does not show them.`);
    return { users, mailersList: after['mailersList'] ?? {} };
  }

  /** Link an epic/feature/story to another backlog item (defect, epic, feature, story, task) with a
   *  chosen LINK TYPE — the UI's Linkages section. The link is stored in the source item's
   *  `linkedIssues` array (the same field the form saves) and read back from /pm/linkages. */
  async linkBacklogItem(input: {
    sourceType: 'epic' | 'feature' | 'userstory';
    sourceId: string;
    destType: 'epic' | 'feature' | 'userstory' | 'defect' | 'task';
    destId: string;
    linkType: string;
  }): Promise<{ linkTypeKey: string; destinationCode?: string; linkedIssues: Array<Record<string, unknown>> }> {
    const specs = {
      epic: { path: '/pm/epic', search: '/pm/epic/search', collection: 'epic', parentType: 'EP' },
      feature: { path: '/pm/feature', search: '/pm/feature/search', collection: 'feature', parentType: 'FT' },
      userstory: { path: '/pm/userstory', search: '/pm/userstory/search', collection: 'userstory', parentType: 'US' },
      defect: { path: '/pm/defect', search: '/pm/defect/search', collection: 'defect', parentType: 'DE' },
      task: { path: '/pm/task', search: '/pm/task/search', collection: 'task', parentType: 'TA' },
    } as const;
    const projectId = this.requireProjectId();
    const asDoc = (raw: any): Record<string, any> => (Array.isArray(raw) ? (raw[0] ?? {}) : (raw?.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : raw)) ?? {};
    const refOf = async (type: keyof typeof specs, ref: string): Promise<{ id: number; code?: string; name?: string }> => {
      const spec = specs[type];
      const bare = numericId(ref);
      if (/^\d+$/.test(String(bare))) {
        try {
          const doc = asDoc(await this.http.getJson<any>(`${spec.path}/${bare}`));
          const id = Number.parseInt(str(doc, 'id', '_id') ?? String(bare), 10);
          if (Number.isFinite(id)) return { id, ...(str(doc, 'code') ? { code: str(doc, 'code')! } : {}), ...(str(doc, 'name') ? { name: str(doc, 'name')! } : {}) };
        } catch { /* fall through to search */ }
      }
      for (const column of ['code', 'name'] as const) {
        const raw = await this.http.postJson<any>(spec.search, this.searchBody(
          [{ column, value: ref }],
          { startIndex: 0, limit: 20, selectFields: ['id', 'code', 'name'] },
        ));
        const rows = pickArray(raw, 'data', 'content');
        const hit = rows.find((r: any) => String(str(r, column) ?? '').trim().toLowerCase() === ref.trim().toLowerCase());
        const id = hit ? Number.parseInt(str(hit, 'id', '_id') ?? '', 10) : NaN;
        if (Number.isFinite(id)) return { id, ...(str(hit, 'code') ? { code: str(hit, 'code')! } : {}), ...(str(hit, 'name') ? { name: str(hit, 'name')! } : {}) };
      }
      throw new Error(`${type} "${ref}" was not found in this project.`);
    };

    const source = await refOf(input.sourceType, input.sourceId);
    const dest = await refOf(input.destType, input.destId);

    // Link types come from the SAME default-field catalogue the UI's Linkages dropdown uses.
    const rawTypes = await this.http.getJson<any>(`/pm/fields/10?projectId=${projectId}&fieldType=linkages`);
    const rows = Array.isArray(rawTypes) ? rawTypes : pickArray(rawTypes, 'data', 'content', 'fields');
    type Cand = { rowId: unknown; side: 'inwardType' | 'outwardType'; key: string; label: string };
    const cands: Cand[] = [];
    for (const row of rows as any[]) {
      for (const side of ['inwardType', 'outwardType'] as const) {
        const t = row?.[side];
        if (!t || typeof t !== 'object') continue;
        cands.push({ rowId: row['id'], side, key: str(t, 'key') ?? '', label: (str(t, 'value') ?? str(t, 'label') ?? str(t, 'name') ?? '').trim() });
      }
    }
    const want = input.linkType.trim().toLowerCase();
    const chosen = cands.find((c) => c.key.toLowerCase() === want || c.label.toLowerCase() === want);
    if (!chosen) {
      const options = [...new Set(cands.map((c) => c.label || c.key))].join(', ');
      throw new Error(`Unknown link type "${input.linkType}". Available link types: ${options || '(none configured)'}`);
    }

    const destType = (dest.code ?? '').split('-')[0] || specs[input.destType].parentType;
    const entry: Record<string, unknown> = {
      projectId,
      deleted: false,
      parentName: dest.name ?? '',
      destinationId: dest.id,
      destinationCode: dest.code ?? '',
      destinationType: destType,
      linkId: chosen.rowId,
      linkTypeKey: chosen.key,
      linkType: chosen.side,
      jiraIssueId: '',
      jiraIssueKey: '',
      jiraLinkId: '',
    };

    const sourceRaw = asDoc(await this.http.getJson<any>(`${specs[input.sourceType].path}/${source.id}`));
    const existing = Array.isArray(sourceRaw['linkedIssues']) ? (sourceRaw['linkedIssues'] as Array<Record<string, unknown>>) : [];
    const merged = [
      ...existing.filter((e) => !(Number(e['destinationId']) === dest.id && String(e['linkTypeKey']) === chosen.key)),
      entry,
    ];
    const version = typeof sourceRaw['updateVersion'] === 'number' ? sourceRaw['updateVersion'] : 0;
    if (input.sourceType === 'epic') await this.updateEpic(String(source.id), { linkedIssues: merged, updateVersion: version });
    else if (input.sourceType === 'feature') await this.updateFeature(String(source.id), { linkedIssues: merged, updateVersion: version });
    else await this.updateStory(String(source.id), { linkedIssues: merged });

    // Confirm from the linkages sub-resource (the item document does not echo the array).
    const rawLinks = await this.http.getJson<any>(`/pm/linkages/${source.id}/${specs[input.sourceType].parentType}?projectId=${projectId}`);
    const links = (Array.isArray(rawLinks) ? rawLinks : pickArray(rawLinks, 'data', 'content', 'linkages')) as Array<Record<string, unknown>>;
    if (!links.some((l) => Number(l['destinationId']) === dest.id && String(l['linkTypeKey']) === chosen.key)) {
      throw new Error(
        `Saved the link, but reading the Linkages back did not find ${dest.code ?? dest.id} with link type "${chosen.label || chosen.key}". ` +
        `Current links: ${links.map((l) => `${l['destinationCode'] ?? l['destinationId']} (${l['linkTypeKey']})`).join(', ') || '(none)'}`,
      );
    }
    return { linkTypeKey: chosen.key, ...(dest.code ? { destinationCode: dest.code } : {}), linkedIssues: links };
  }

  /** Create a PROJECT (`POST /pm/project`). The UI's new-project form sends a name, description and
   *  the member `users` plus a defaults block; the backend accepts the minimal shape, so start there
   *  and let the backend fill its own defaults. */
  async createProject(input: { name: string; description?: string | undefined; users?: number[] | undefined }): Promise<SavedRef> {
    const name = input.name.trim();
    if (!name) throw new Error('createProject: name is required.');
    const body = {
      name,
      description: input.description ?? '',
      users: input.users ?? [],
      // The UI's New Project form sends these report-retention defaults; the backend requires them.
      reportExpiryMonth: 150,
      pdfExpiryDays: 7,
    };
    const raw = await this.http.postJson<any>('/pm/project', body);
    return toSavedRef(raw, true);
  }

  /** `GET /pm/project/:id` — read a project back (used to confirm a create). */
  async getProjectById(id: string): Promise<Record<string, any>> {
    const raw = await this.http.getJson<any>(`/pm/project/${numericId(id)}`);
    const doc = Array.isArray(raw) ? (raw[0] ?? {}) : raw;
    return (doc?.data && typeof doc.data === 'object' && !Array.isArray(doc.data) ? doc.data : doc) ?? {};
  }

  /** Soft-delete a project — the admin Project screen's delete (`PATCH /pm/project { ids }`). */
  async deleteProject(id: string): Promise<{ deleted: boolean }> {
    const numeric = Number.parseInt(numericId(id), 10);
    if (!Number.isFinite(numeric)) throw new Error(`deleteProject: "${id}" is not a numeric id.`);
    await this.http.patchJson<any>('/pm/project', { ids: [numeric] });
    return { deleted: true };
  }

  // ------------------------------------------------------------------ Project membership
  // The project's users live in project_user_role: GET /pm/projectuserrole?projectId=<id> to read,
  // and `PUT /pm/project/<id>` with the FULL `users: [{userId, roleId}]` list to write (that is what
  // the UI's project form does — it REPLACES the list, so callers must merge, never send just the new
  // ones). Inviting a person who has no account yet is `POST /pm/users` with `projects` + `userType`.

  /** Members of a project as [{id, userId, roleId}] (GET /pm/projectuserrole?projectId=).
   *  `id` is the project_user_role ROW id — the project update matches existing rows by it. */
  async listProjectMembers(projectId: string): Promise<Array<{ id?: number; userId: number; roleId: number }>> {
    const pid = Number.parseInt(numericId(projectId), 10);
    if (!Number.isFinite(pid)) throw new Error(`listProjectMembers: "${projectId}" is not a numeric project id.`);
    const raw = await this.http.getJson<any>(`/pm/projectuserrole?projectId=${pid}`);
    return pickArray(raw, 'data', 'content')
      .filter((r: any) => r && r.deleted !== true)
      .map((r: any) => ({ id: Number(r.id), userId: Number(r.userId), roleId: Number(r.roleId) }))
      .filter((r) => Number.isFinite(r.userId) && r.userId > 0);
  }

  /** The user whose EMAIL matches exactly (case-insensitive), or null (POST /pm/users/search). */
  async findUserByEmail(email: string): Promise<{ id: number; code?: string; name?: string; email?: string } | null> {
    const wanted = email.trim().toLowerCase();
    if (!wanted) return null;
    const body = this.searchBody(
      [{ column: 'email', value: wanted, regEx: false }, { column: 'deleted', value: false }],
      { startIndex: 0, limit: 50, selectFields: ['id', 'code', 'name', 'email'], rawOffset: true },
    );
    const raw = await this.http.postJson<any>('/pm/users/search', body);
    const rows = pickArray(raw, 'data', 'content', 'users') as any[];
    const hit = rows.find((r) => String(r?.email ?? '').toLowerCase() === wanted);
    if (!hit) return null;
    const id = Number(hit.id);
    if (!Number.isFinite(id)) return null;
    return {
      id,
      ...(hit.code ? { code: String(hit.code) } : {}),
      ...(hit.name ? { name: String(hit.name) } : {}),
      ...(hit.email ? { email: String(hit.email) } : {}),
    };
  }

  /** Invite (= create) a user and, when a project+role is given, assign them to it in the same call.
   *  POST /pm/users — the UI's "Invite User" form body. The backend sends the invitation email. */
  async inviteUser(input: { email: string; name?: string | undefined; roleId?: number | undefined; projectId?: string | undefined }): Promise<{ id: number; code?: string }> {
    const email = input.email.trim().toLowerCase();
    if (!email.includes('@')) throw new Error('inviteUser: a valid email address is required.');
    const name = (input.name ?? email.split('@')[0] ?? '').trim() || email;
    const projects = input.projectId && Number.isFinite(Number(input.roleId))
      ? [{ projectId: Number.parseInt(numericId(input.projectId), 10), roleId: Number(input.roleId) }]
      : [];
    const body = { name, username: email, email, userType: ['non-admin'], projects };
    const raw = await this.http.postJson<any>('/pm/users', body);
    const doc: any = raw?.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : raw;
    const id = Number(doc?.id ?? doc?.userId ?? NaN);
    if (!Number.isFinite(id)) {
      throw new Error(`inviteUser: the backend did not return the new user's id (${JSON.stringify(raw).slice(0, 200)}).`);
    }
    return { id, ...(doc?.code ? { code: String(doc.code) } : {}) };
  }

  /** Add members to a project: merge with the existing list and PUT the full list back. */
  async addProjectMembers(projectId: string, members: Array<{ userId: number; roleId: number }>): Promise<{ added: number[]; updated: number[]; total: number }> {
    const pid = Number.parseInt(numericId(projectId), 10);
    if (!Number.isFinite(pid)) throw new Error(`addProjectMembers: "${projectId}" is not a numeric project id.`);
    const current = await this.listProjectMembers(String(pid));
    const byUser = new Map<number, { id?: number; roleId: number }>();
    for (const m of current) byUser.set(m.userId, m.id ? { id: m.id, roleId: m.roleId } : { roleId: m.roleId });
    const added: number[] = [];
    const updated: number[] = [];
    for (const m of members) {
      if (!Number.isFinite(m.userId) || m.userId <= 0) continue;
      const prev = byUser.get(m.userId);
      const roleId = Number.isFinite(m.roleId) && m.roleId > 0 ? m.roleId : (prev?.roleId ?? 1);
      if (!prev) added.push(m.userId);
      else if (prev.roleId !== roleId) updated.push(m.userId);
      byUser.set(m.userId, { ...(prev?.id ? { id: prev.id } : {}), roleId });
    }
    await this.putProjectUsers(pid, [...byUser].map(([userId, v]) => ({ ...(v.id ? { id: v.id } : {}), userId, roleId: v.roleId })));
    return { added, updated, total: byUser.size };
  }

  /** Remove members from a project (PUT the remaining list + `removedUsers`). */
  async removeProjectMembers(projectId: string, userIds: number[]): Promise<{ removed: number[]; total: number }> {
    const pid = Number.parseInt(numericId(projectId), 10);
    if (!Number.isFinite(pid)) throw new Error(`removeProjectMembers: "${projectId}" is not a numeric project id.`);
    const drop = new Set(userIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0));
    const current = await this.listProjectMembers(String(pid));
    const keep = current.filter((m) => !drop.has(m.userId));
    const removed = current.filter((m) => drop.has(m.userId)).map((m) => m.userId);
    if (!removed.length) return { removed: [], total: current.length };
    await this.putProjectUsers(pid, keep, removed);
    return { removed, total: keep.length };
  }

  /** PUT /pm/project/<id> carrying the FULL member list (the project form's update payload). */
  private async putProjectUsers(
    pid: number,
    users: Array<{ id?: number; userId: number; roleId: number }>,
    removedUsers?: number[],
  ): Promise<void> {
    const proj = await this.getProjectById(String(pid));
    const body: Record<string, unknown> = {
      name: proj['name'],
      description: proj['description'] ?? '',
      users,
    };
    if (proj['businessUnitId'] !== undefined) body['businessUnitId'] = proj['businessUnitId'];
    if (removedUsers && removedUsers.length) body['removedUsers'] = removedUsers;
    await this.http.putJson<any>(`/pm/project/${pid}`, body);
  }

  // ---------------------------------------------------------------------- Objects (read)
  async getObject(id: string, opts?: { enrichNames?: boolean }): Promise<QaObject> {
    const raw = await this.http.getJson<any>(`/tm/object/${numericId(id)}`);
    let doc: any = raw?.data ?? raw;
    if (Array.isArray(doc)) doc = doc.length > 0 ? doc[0] : {};
    const obj = toObject(doc && typeof doc === 'object' ? doc : {}, this.cfg.baseUrl);
    if (opts?.enrichNames) await this.enrichObjectNames(obj);
    return obj;
  }

  private async enrichObjectNames(obj: QaObject): Promise<void> {
    if (obj.moduleId) {
      try {
        const modules = await this.listModules();
        const match = modules.find((m) => m.id === obj.moduleId);
        if (match) obj.moduleName = match.name;
      } catch { /* best-effort */ }
    }
    if (obj.parameterIds?.length) {
      const names = await this.resolveParameterNames(obj.parameterIds);
      const resolved = obj.parameterIds.map((pid) => names.get(pid)).filter((n): n is string => !!n);
      if (resolved.length) obj.parameterNames = resolved;
    }
  }

  private async resolveParameterNames(ids: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const numIds = ids.map((i) => Number.parseInt(i, 10)).filter(Number.isFinite);
    if (!numIds.length) return map;
    try {
      const projectId = this.requireProjectId();
      const body = this.searchBody([
        { column: 'projectId', value: projectId },
        { column: 'id', value: numIds, regEx: false },
      ]);
      const raw = await this.http.postJson<any>('/tm/parameter/search', body);
      const rows = pickArray(raw, 'data', 'content');
      for (const row of rows) {
        const rid = str(row, 'id', '_id', 'parameterId');
        const name = str(row, 'name');
        if (rid && name) map.set(rid, name);
      }
    } catch { /* best-effort */ }
    return map;
  }

  // ---------------------------------------------------------------------- Deep links

  /** Report page for one run: a TESTCASE run is addressed by the TEST CASE id as `parentId` (its own executionItemId
   *  is empty for API/DB runs), a SUITE run by the suite id. */
  private runReportUrl(type: 'TESTCASE' | 'SUITE', parentId: number, runId: string, projectId: number): string {
    const base = (this.cfg.baseUrl ?? '').replace(/\/+$/, '');
    const id = Number.parseInt(numericId(runId), 10);
    return `${base}/user/reports/reports-page?type=${type}&parentId=${parentId}${Number.isFinite(id) ? `&id=${id}` : ''}&projectId=${projectId}`;
  }

  productUrlFor(entity: EntityRef): string {
    const base = (this.cfg.baseUrl ?? '').replace(/\/+$/, '');
    switch (entity.kind) {
      case 'testcase': return `${base}/user/testcase/details/${entity.id}`;
      case 'function': return `${base}/user/function/fnDetails/${entity.id}`;
      case 'suite':    return `${base}/user/suites/suite-details?id=${entity.id}`;
      // ponytail: run URL is built inline where parentId/projectId are known (see reportUrl above). Fallback stays generic.
      case 'run':      return `${base}/user/reports/reports-page?id=${entity.id}`;
    }
  }

  // ---------------------------------------------------------------------- Agent hop (recording + not-yet-ported ops)
  // Everything below either delegates to the local agent /mcp (recording surface, and writes/testdata/
  // run dispatch we haven't ported to REST yet) or fails with a clear message when the hop is unset.
  // As each step of the port lands, the corresponding delegate is replaced with a direct REST impl.

  private hop(): RemoteMcpAdapter | null {
    if (!this.cfg.url) return null;
    if (!this.agentHop) this.agentHop = new RemoteMcpAdapter(this.cfg);
    return this.agentHop;
  }

  /** Recording tool schemas from the SQA agent — mirrored so the recording passthrough can register
   *  them. No agent configured → `[]`, so no recording tools get registered. */
  async listAgentTools(): Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>> {
    const h = this.hop();
    return h ? h.listAgentTools() : [];
  }

  /** Forward a recording-tool call to the agent /mcp. Same behavior as walnut. */
  async callRaw(name: string, args: Record<string, unknown>): Promise<unknown> {
    const h = this.hop();
    if (!h) {
      throw new Error(
        "Recording needs a local SimplifyQA agent — set QA_MCP_URL to the agent's /mcp endpoint.",
      );
    }
    return h.callRaw(name, args);
  }

  // ---------------------------------------------------------------------- Test cases (write)  [Step 4]

  /** The database keeps a module as its numeric id; a prompt may give its NAME. Resolve a name (or code) to the id —
   *  never let a non-numeric value become 0, which silently saves the test case into the root module. */
  private async resolveModuleId(ref: unknown): Promise<number> {
    const raw = String(ref ?? '').trim();
    if (!raw) return 0;
    if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
    const want = raw.toLowerCase();
    const hits = (await this.listModules()).filter((m) =>
      m.name.trim().toLowerCase() === want || String((m as { code?: string }).code ?? '').trim().toLowerCase() === want);
    if (hits.length === 1) return Number.parseInt(hits[0]!.id, 10);
    if (hits.length > 1) {
      throw new Error(`Module "${raw}" matches ${hits.length} modules (${hits.map((m) => `${m.name} [id ${m.id}]`).join(', ')}). Pass the module id as folderOrModule.`);
    }
    throw new Error(`Module "${raw}" was not found in this project. Call list_modules and pass the module's id as folderOrModule — not saving, so the test case does not land in the root module by mistake.`);
  }

  /** Pin every function-call step so the saved call is self-contained: fill the function's NEWEST
   *  version id (SQA's `fnVersionId`) plus its code/name when the caller supplied only an id or FN-code
   *  ("use FN-64"). Save-time, best-effort: a failed lookup leaves the step exactly as authored, so this
   *  can never block a save. Mirrors the identity `journal_modify insert_nested` pins. */
  private async pinFunctionCalls(tc: TestCase): Promise<void> {
    const calls = (tc.steps ?? []).filter(
      (s) => s.stepType === 'function' && s.functionCall?.testCaseId
        && (!s.functionCall.versionId || !s.functionCall.testCaseCode || !s.functionCall.testCaseName),
    );
    if (!calls.length) return;
    const cache = new Map<string, { versionId?: string | undefined; code?: string | undefined; name?: string | undefined }>();
    for (const s of calls) {
      const call = s.functionCall!;
      let meta = cache.get(call.testCaseId);
      if (!meta) {
        meta = {};
        try {
          const fn = await this.getFunction(call.testCaseId);
          meta = { versionId: fn.versions?.[0]?.id, code: fn.code, name: fn.name };
        } catch { /* leave unset — the call still saves with the id it was given */ }
        cache.set(call.testCaseId, meta);
      }
      if (!call.versionId && meta.versionId) call.versionId = meta.versionId;
      if (!call.testCaseCode && meta.code) call.testCaseCode = meta.code;
      if (!call.testCaseName && meta.name) call.testCaseName = meta.name;
    }
  }

  /**
   * A test case authored from FUNCTION CALLS has no step technology of its own — each call inherits
   * the FUNCTION's `fnType` (WEB / API / ANDROID / IOS / DATABASE / MAINFRAME / …). Without this the
   * TC was saved as WEB (deriveTcType's default), so a suite of API or mobile functions silently
   * became a browser test case.
   *
   * Resolves each call's function once, stamps the technology on the call's step (so the wire rows
   * agree) and sets it on the test case. A draft that mixes technologies is rejected: SQA stores ONE
   * tcType per test case.
   */
  private async resolveFunctionTechnologies(tc: TestCase): Promise<void> {
    const calls = (tc.steps ?? []).filter((s) => {
      const c = (s as { functionCall?: { testCaseId?: string } }).functionCall;
      return !!c?.testCaseId;
    });
    if (!calls.length) return;
    const found = new Set<string>();
    for (const step of calls) {
      const call = (step as { functionCall: { testCaseId: string; technologyType?: string } }).functionCall;
      let tech = (call.technologyType ?? '').trim().toUpperCase();
      if (!tech) {
        try {
          const fn = await this.getFunction(String(call.testCaseId));
          tech = String((fn as { fnType?: string }).fnType ?? '').trim().toUpperCase();
        } catch { tech = ''; }
      }
      if (!tech) continue;
      found.add(tech);
      (step as { technologyType?: string }).technologyType = tech;
      call.technologyType = tech;
    }
    if (!found.size) return;
    if (found.size > 1) {
      throw new Error(
        `This test case calls functions of different technologies (${[...found].sort().join(', ')}). ` +
        'A SimplifyQA test case has ONE technology — split it into one test case per technology.',
      );
    }
    if (!tc.technologyType) tc.technologyType = [...found][0];
  }

  /** Two-step create: (1) resolve every `${name}` token in the steps to a project-scoped parameter id
   *  (get-or-create) plus, for AUTOMATION, each step's actionId + objectId, (2) POST /tm/testcase
   *  multipart with the assembled `testcaseObj`. */
  async createTestCase(tc: TestCase): Promise<SavedRef> {
    const projectId = this.requireProjectId();
    await this.pinFunctionCalls(tc);
    await this.resolveFunctionTechnologies(tc);
    const moduleId = await this.resolveModuleId(tc.folderOrModule);
    const userstoryId = tc.storyRef ? await this.resolveStoryNumericIdOrNull(tc.storyRef) : undefined;
    const paramAccessById = new Map<number, 'LOCAL' | 'RUNTIME'>();
    const paramIdByName = await this.resolveParamIds(projectId, moduleId, tc, paramAccessById);
    const stepResolutions = tc.category === 'automated'
      ? await this.resolveAutomationSteps(projectId, moduleId, tc)
      : undefined;
    const payload = buildTestcasePayload({
      projectId, moduleId,
      ...(userstoryId != null ? { userstoryId } : {}),
      tc,
      paramIdByName,
      paramAccessById,
      ...(stepResolutions ? { stepResolutions } : {}),
    });
    const raw = await this.http.postMultipart<any>('/tm/testcase', 'testcaseObj', payload);
    return toSavedRef(raw, true);
  }

  /** Same shape as create, but with `tcfnObj.id` set. */
  async updateTestCase(id: string, tc: TestCase): Promise<SavedRef> {
    const projectId = this.requireProjectId();
    await this.pinFunctionCalls(tc);
    await this.resolveFunctionTechnologies(tc);
    const moduleId = await this.resolveModuleId(tc.folderOrModule);
    const userstoryId = tc.storyRef ? await this.resolveStoryNumericIdOrNull(tc.storyRef) : undefined;
    const paramAccessById = new Map<number, 'LOCAL' | 'RUNTIME'>();
    const paramIdByName = await this.resolveParamIds(projectId, moduleId, tc, paramAccessById);
    const stepResolutions = tc.category === 'automated'
      ? await this.resolveAutomationSteps(projectId, moduleId, tc)
      : undefined;
    const payload = buildTestcasePayload({
      projectId, moduleId,
      ...(userstoryId != null ? { userstoryId } : {}),
      existingId: numericId(id),
      tc,
      paramIdByName,
      paramAccessById,
      ...(stepResolutions ? { stepResolutions } : {}),
    });
    await this.appendRemovedSteps(id, tc, payload);
    // `!` — putMultipart is optional on QaHttp (walnut's wrapper opts out); makeClient always provides it.
    const raw = await this.http.putMultipart!<any>('/tm/testcase', 'testcaseObj', payload);
    return toSavedRef(raw, false);
  }

  /** The backend deletes a step only when it receives it with `deleted:true`; a step that is simply
   *  absent from the payload is left untouched. So a step removed from the draft (remove_step) has to be
   *  sent back explicitly as deleted, otherwise the save "succeeds" and the step is still there.
   *  Only applies when the draft was hydrated from this test case (its steps carry `sourceId`), so a
   *  hand-built draft with no source ids can never wipe the stored steps. Best-effort: a failed lookup
   *  leaves the payload as it was. */
  private async appendRemovedSteps(id: string, tc: TestCase, payload: any): Promise<void> {
    const kept = new Set((tc.steps ?? []).map((s) => s.sourceId).filter((v): v is string => !!v));
    if (kept.size === 0) return;
    try {
      const rawTc = await this.fetchRawTestcase(id);
      const current = await this.fetchStepsCollection(id, rawTc, tc.currentVersionId);
      const tcNum = Number.parseInt(numericId(id), 10);
      for (const r of current) {
        const sid = str(r, 'id', '_id');
        if (!sid || kept.has(sid) || r?.deleted === true) continue;
        const step: Record<string, unknown> = { ...pick(r, STEP_ALLOWED_KEYS), id: sid, deleted: true, parentId: tcNum };
        const vid = str(r, 'versionId');
        if (vid) step['versionId'] = vid;
        const bucket = String(r?.executionType ?? '').toUpperCase() === 'MANUAL' ? 'manualSteps' : 'automationSteps';
        (payload.steps[bucket] as unknown[]).push(step);
      }
    } catch {
      // lookup failed — save proceeds without delete markers
    }
  }

  /** Snapshot the CURRENT server state of a testcase under a NEW version name — same TC id,
   *  new `tcfn_version` row with cloned steps. Backed by `PUT /tm/testcase` with
   *  `operation:"SAVENEWVERSION"` (see tcfn.service.js:115/242/355 for the branches). The steps
   *  we fetch from the collection are re-POSTed with their `id` stripped so the backend inserts
   *  fresh rows attached to the new version. When `tdCopy` is true, the source version's
   *  testdata iterations are cloned across environments via `verData.selVersionId`.
   *
   *  Not a mapper roundtrip: we resend the raw tcfnObj/steps we just fetched, so any fields the
   *  neutral `TestCase` type doesn't carry (custom fields, mailers, exec platform, ...) are
   *  preserved verbatim — the point of a version is "freeze what's there now". */
  async saveAsNewVersion(
    id: string,
    opts: { versionName: string; tdCopy?: boolean; sourceVersionId?: string; tc?: TestCase },
  ): Promise<SavedRef> {
    assertBusinessKeyKind(id, 'TC');
    const projectId = this.requireProjectId();
    const versionName = opts.versionName?.trim();
    if (!versionName) throw new Error('versionName is required.');

    // "Update + save as new version": the caller already edited the TC in a draft, so freeze THAT
    // content under the new version instead of re-posting the stored state. Same payload builder as
    // tc_save (objects/parameters resolved); only the version stub + operation differ — exactly what
    // the SQA UI's "Save as new version" dialog sends (edited steps + operation SAVENEWVERSION).
    if (opts.tc) {
      const tc = opts.tc;
      // tdCopy clones the SOURCE version's iterations. A caller that just says "copy the test data"
      // (no sourceVersionId) must still get it — otherwise verData has no selVersionId and the new
      // version's iteration is created EMPTY. Default to the TC's current version.
      let sourceVersionId = opts.sourceVersionId;
      if (!sourceVersionId) {
        try {
          const rawTcForVersion = await this.fetchRawTestcase(id);
          sourceVersionId =
            str(rawTcForVersion, 'versionId', 'selectedVersionId') ??
            (rawTcForVersion?.versionsDetails && typeof rawTcForVersion.versionsDetails === 'object'
              ? str(rawTcForVersion.versionsDetails, 'id', '_id', 'versionId')
              : undefined) ??
            (Array.isArray(rawTcForVersion?.versions) && rawTcForVersion.versions.length > 0
              ? str(rawTcForVersion.versions[0], 'id', '_id')
              : undefined);
        } catch { /* no pin — the backend then skips tdCopy */ }
      }
      const moduleId = await this.resolveModuleId(tc.folderOrModule);
      const userstoryId = tc.storyRef ? await this.resolveStoryNumericIdOrNull(tc.storyRef) : undefined;
      const paramAccessById = new Map<number, 'LOCAL' | 'RUNTIME'>();
      const paramIdByName = await this.resolveParamIds(projectId, moduleId, tc, paramAccessById);
      const stepResolutions = tc.category === 'automated'
        ? await this.resolveAutomationSteps(projectId, moduleId, tc)
        : undefined;
      const built = buildTestcasePayload({
        projectId,
        moduleId,
        ...(userstoryId != null ? { userstoryId } : {}),
        existingId: numericId(id),
        tc,
        paramIdByName,
        paramAccessById,
        ...(stepResolutions ? { stepResolutions } : {}),
      });
      const payload = built as Record<string, any>;
      // Empty `id` tells the backend to mint a new tcfn_version row; the backend then re-creates the
      // steps under it (tcfn.service.js deletes step ids for SAVENEWVERSION).
      payload['operation'] = 'SAVENEWVERSION';
      payload['type'] = 'TC';
      payload['verData'] = {
        tdCopy: !!opts.tdCopy,
        ...(sourceVersionId ? { selVersionId: sourceVersionId } : {}),
      };
      const vd = (payload['versionsDetails'] ?? {}) as Record<string, unknown>;
      payload['versionsDetails'] = {
        ...vd,
        name: versionName,
        id: '',
        updateVersion: 0,
        deleted: false,
        reviewApproveStatus: '',
        syncONOFF: '',
      };
      const raw = await this.http.putMultipart!<any>('/tm/testcase', 'testcaseObj', payload);
      const flat = raw?.data ?? raw ?? {};
      const savedId = str(flat, 'id', '_id', 'testcaseId') ?? numericId(id);
      const newVersionId =
        str(flat, 'versionId') ??
        (flat?.versionsDetails && typeof flat.versionsDetails === 'object'
          ? str(flat.versionsDetails, 'id')
          : undefined);
      return {
        id: savedId,
        created: false,
        productUrl: this.productUrlFor({ kind: 'testcase', id: savedId }),
        ...(newVersionId ? { artifacts: [`versionId=${newVersionId}`] } : {}),
      };
    }

    const rawTc = await this.fetchRawTestcase(id);
    if (!rawTc || Object.keys(rawTc).length === 0) {
      throw new Error(`test case ${id} not found`);
    }

    // Resolve source version: caller override → current versionId on the TC → versionsDetails.id
    // → first entry in versions[]. Falls through to '' (empty) if none — backend then skips tdCopy.
    let sourceVersionId = opts.sourceVersionId;
    if (!sourceVersionId) {
      sourceVersionId = str(rawTc, 'versionId', 'selectedVersionId', 'selVersion');
      if (!sourceVersionId && rawTc?.versionsDetails && typeof rawTc.versionsDetails === 'object') {
        sourceVersionId = str(rawTc.versionsDetails, 'id', '_id', 'versionId');
      }
      if (!sourceVersionId && Array.isArray(rawTc?.versions) && rawTc.versions.length > 0) {
        sourceVersionId = str(rawTc.versions[0], 'id', '_id');
      }
    }

    // Steps must come from the SELECTED source version, not whichever version the TC has open.
    const rawSteps = await this.fetchStepsCollection(id, rawTc, sourceVersionId);
    const automationSteps: any[] = [];
    const manualSteps: any[] = [];
    for (const s of rawSteps) {
      // Project down to the step joi allow-list (testcaseValidator.js:244-306 + :307-367). Backend
      // re-assigns id/versionId/parentId under the new version row, so drop those regardless.
      const step = pick(s, STEP_ALLOWED_KEYS);
      const et = typeof step['executionType'] === 'string' ? String(step['executionType']).toUpperCase() : '';
      if (et === 'MANUAL') manualSteps.push(step);
      else automationSteps.push(step);
    }

    // Project down to the tcfnObj joi allow-list (testcaseValidator.js:189-227). Anything else on
    // the raw doc (code, createdBy, updatedBy, stepCount, etc.) trips "is not allowed".
    const tcfnObj = pick(rawTc, TCFNOBJ_ALLOWED_KEYS);
    tcfnObj['deleted'] = false;
    tcfnObj['projectId'] = typeof tcfnObj['projectId'] === 'number' ? tcfnObj['projectId'] : projectId;
    // Required-but-boolean fields on the update schema. Coerce so the presence is guaranteed.
    if (typeof tcfnObj['obsolete'] !== 'boolean') tcfnObj['obsolete'] = false;

    // Version stub: empty `id` tells the backend to create a fresh row. SYNCOFF normalised to
    // '' matches the FE (testcase.component.ts:1399) — it's a client-side "don't inherit"
    // marker, not a server value.
    const prevSync = rawTc?.versionsDetails && typeof rawTc.versionsDetails === 'object'
      ? str(rawTc.versionsDetails, 'syncONOFF')
      : undefined;
    const versionsDetails: Record<string, unknown> = {
      name: versionName,
      id: '',
      syncONOFF: prevSync === 'SYNCOFF' ? '' : (prevSync ?? ''),
      deleted: false,
      executionType: str(rawTc, 'executionType') ?? 'AUTOMATION',
      functionProjectIds: [projectId],
      reviewApproveStatus: '',
    };

    const verData: Record<string, unknown> = {
      tdCopy: !!opts.tdCopy,
      ...(sourceVersionId ? { selVersionId: sourceVersionId } : {}),
    };

    const payload = {
      tcfnObj,
      steps: { automationSteps, manualSteps },
      versionsDetails,
      operation: 'SAVENEWVERSION',
      type: 'TC',
      verData,
    };

    const raw = await this.http.putMultipart!<any>('/tm/testcase', 'testcaseObj', payload);
    const flat = raw?.data ?? raw ?? {};
    const savedId = str(flat, 'id', '_id', 'testcaseId') ?? numericId(id);
    const newVersionId =
      str(flat, 'versionId') ??
      (flat?.versionsDetails && typeof flat.versionsDetails === 'object'
        ? str(flat.versionsDetails, 'id')
        : undefined);
    return {
      id: savedId,
      created: false,
      productUrl: this.productUrlFor({ kind: 'testcase', id: savedId }),
      ...(newVersionId ? { artifacts: [`versionId=${newVersionId}`] } : {}),
    };
  }

  /** STEPSTOFN — mirrors the FE "Save as function" flow (create-new-fn-modal.component.ts:88-197):
   *  pick a subset of the TC's steps, retype to FN, POST /tm/function multipart with the
   *  `functionObj` payload. Backend re-assigns step ids/versionId under the newly created FN version.
   *
   *  ponytail: file attachments (STEP_ATTACMENTS / STEP_COMAPAREFILES multipart entries) are NOT
   *  forwarded — MCP callers don't ship blobs. Add if a real caller needs them.
   *  ponytail: sub-step flattening (FE lines 124-127) is skipped — `/tm/testcase/steps` returns
   *  flat top-level rows; nested FN expansions aren't in that read. Handle if that changes. */
  async saveStepsAsFunction(
    tcId: string,
    opts: {
      stepSeqs: number[];
      name: string;
      moduleId: number;
      copyTestData?: boolean;
      executionType?: 'AUTOMATION' | 'MANUAL';
      versionId?: string | undefined;
    },
  ): Promise<SavedRef> {
    const projectId = this.requireProjectId();
    const name = opts.name?.trim();
    if (!name) throw new Error('name is required.');
    if (!opts.moduleId) throw new Error('moduleId is required.');
    const seqSet = new Set(opts.stepSeqs);
    if (seqSet.size === 0) throw new Error('stepSeqs is required.');

    const rawTc = await this.fetchRawTestcase(tcId);
    if (!rawTc || Object.keys(rawTc).length === 0) {
      throw new Error(`test case ${tcId} not found`);
    }
    const sourceVersionId =
      opts.versionId ||
      (str(rawTc, 'versionId', 'selectedVersionId') ??
        (rawTc?.versionsDetails && typeof rawTc.versionsDetails === 'object'
          ? str(rawTc.versionsDetails, 'id', '_id', 'versionId')
          : undefined) ??
        (Array.isArray(rawTc?.versions) && rawTc.versions.length > 0
          ? str(rawTc.versions[0], 'id', '_id')
          : undefined));

    const rawSteps = await this.fetchStepsCollection(tcId, rawTc, opts.versionId);
    const picked = rawSteps
      .filter((s: any) => seqSet.has(Number(s.seq)))
      .sort((a: any, b: any) => Number(a.seq) - Number(b.seq));
    if (picked.length === 0) {
      throw new Error(`no steps on ${tcId} match stepSeqs [${opts.stepSeqs.join(',')}]`);
    }

    const automationSteps: any[] = [];
    const manualSteps: any[] = [];
    let newSeq = 0;
    for (const s of picked) {
      const step: any = { ...s };
      // Server-assigned refs stripped so backend re-creates them under the new FN version.
      delete step.id;
      delete step._id;
      delete step.versionId;
      delete step.parentId;
      delete step.subSteps;
      delete step.deleted;
      delete step.isFunctionEdit;
      delete step.sharedFNsteps;
      delete step.sharedFnProjectId;
      step.type = 'FN';
      step.moduleId = opts.moduleId;
      step.seq = ++newSeq;
      // FE mirror (line 129-134): TM only accepts numeric parameterIds.
      if (Array.isArray(step.parameterIds)) {
        step.parameterIds = step.parameterIds.filter((p: unknown) => typeof p === 'number');
      }
      // FE mirror (line 136-150): shed conditional-step UI expansion.
      if (step.conditions?.children?.length) {
        for (const c of step.conditions.children) {
          delete c.groupedActions;
          delete c.stepActions;
          delete c.objectOfparameters;
          if (Array.isArray(c.parameterIds)) {
            c.parameterIds = c.parameterIds.filter((p: unknown) => typeof p === 'number');
          }
        }
      }
      const forced = opts.executionType;
      const bucket = forced
        ?? (String(step.executionType ?? '').toUpperCase() === 'MANUAL' ? 'MANUAL' : 'AUTOMATION');
      if (bucket === 'MANUAL') manualSteps.push(step);
      else automationSteps.push(step);
    }

    // FE mirror (line 192): DUO iff both buckets populated.
    const execType = automationSteps.length && manualSteps.length
      ? 'DUO'
      : manualSteps.length ? 'MANUAL' : 'AUTOMATION';
    // FE mirror (line 271-276): all steps share technologyType → use that, else fall back to TC's.
    const techs = new Set(picked.map((s: any) => str(s, 'technologyType')).filter(Boolean));
    const fnType = techs.size === 1
      ? [...techs][0]!
      : (str(rawTc, 'tcType') ?? 'WEB');

    const tcfnObj: Record<string, unknown> = {
      name,
      projectId,
      moduleId: opts.moduleId,
      executionType: execType,
      fnType,
      reviewApproveStatus: '',
    };
    // FE default (function.model.ts:68) — backend requires versionsDetails.name.
    const versionsDetails: Record<string, unknown> = { name: 'v1.0', id: '', syncONOFF: '' };
    // testcaseId MUST be numeric here — tcfn.service.js:1124 uses it in a Mongo query
    // against `testdata_iteration.testcaseId` (stored as a Number). A string "42" won't
    // match `42`, so tdCopy silently returns zero source iterations. FE sends a number
    // (create-new-fn-modal.component.ts:31 `@Input('tcfnId') _tcfnId: number`).
    const verData: Record<string, unknown> = {
      tdCopy: !!opts.copyTestData,
      testcaseId: Number.parseInt(numericId(tcId), 10),
      fromParent: 'TC',
      ...(sourceVersionId ? { selVersionId: sourceVersionId } : {}),
    };

    const payload = {
      tcfnObj,
      steps: { automationSteps, manualSteps },
      versionsDetails,
      operation: 'STEPSTOFN',
      type: 'FN',
      verData,
    };

    const raw = await this.http.postMultipart<any>('/tm/function', 'functionObj', payload);
    return toSavedRef(raw, true);
  }

  /** Look up the freshly-created FN's version id — STEPSTOFN's response inlines the FN but not its
   *  version, and the replace-in-TC step needs `fnVersionId`. Mirrors the FE
   *  (`create-new-fn-modal.component.ts:getFnVersion`): search `tcfnversion` by parentType=FN
   *  ordered by createdAt asc, take the first. */
  private async fetchFnVersionId(fnId: string): Promise<string> {
    const projectId = this.requireProjectId();
    const body = {
      searchFields: [
        { column: 'createdAt', sort: 'asc' },
        { column: 'deleted', value: false, regEx: false },
        { column: 'projectId', value: projectId, regEx: false },
        { column: 'parentType', value: 'FN', regEx: false },
        { column: 'parentId', value: Number.parseInt(numericId(fnId), 10), regEx: false },
      ],
      startIndex: 0,
      limit: 10000,
    };
    const raw = await this.http.postJson<any>('/tm/tcfnversion/search', body);
    const rows = pickArray(raw, 'data', 'content');
    const versionId = rows.length > 0 ? str(rows[0], 'id', '_id') : undefined;
    if (!versionId) throw new Error(`could not resolve fnVersionId for function ${fnId}`);
    return versionId;
  }

  /** Second half of extract-to-function-and-replace-in-source (FE
   *  `testcase.component.ts:createNewFns → onSave`): after the FN exists, PUT the source TC with the
   *  extracted step rows marked `deleted:true` and a synthetic FUNCTION + FUNCTION_END pair inserted
   *  at the first extracted position. The backend automatically:
   *   - drops testdata columns for params only the deleted steps referenced (allParameters skips
   *     `step.deleted:true` at tcfn.service.js:411)
   *   - injects a per-env FN cell into every TC iteration row using the FN's default iteration
   *     (tcfn.service.js:1032-1085) — so testdata rewiring is free.
   *
   *  ponytail: refuses DUO / SYNCON test cases and picks that span control-flow or nested FN
   *  brackets. Those cases (v2) need parallel mirroring into the other execution-type array and
   *  bracket-aware validation — out of scope for the first pass. */
  async replaceStepsWithFunctionCall(
    tcId: string,
    opts: {
      extractedSeqs: number[];
      functionId: string;
      fnVersionId: string;
      fnModuleId: number;
      technologyType: string;
      versionId?: string | undefined;
    },
  ): Promise<SavedRef> {
    const projectId = this.requireProjectId();
    const seqSet = new Set(opts.extractedSeqs);
    if (seqSet.size === 0) throw new Error('extractedSeqs is required.');
    const sortedSeqs = [...seqSet].sort((a, b) => a - b);
    // FE `checkStepsContinueOrNot`: picks must be a contiguous seq range or the resulting FN would
    // be non-executable and the TC layout would fracture.
    for (let i = 1; i < sortedSeqs.length; i++) {
      if (sortedSeqs[i] !== sortedSeqs[i - 1]! + 1) {
        throw new Error(`extractedSeqs must be contiguous — got [${sortedSeqs.join(',')}]`);
      }
    }

    const rawTc = await this.fetchRawTestcase(tcId);
    if (!rawTc || Object.keys(rawTc).length === 0) throw new Error(`test case ${tcId} not found`);
    // `versionsDetailsRaw` reflects the TC's CURRENTLY-SELECTED version's inline details — only
    // trustworthy when opts.versionId targets that same version (the common case). When targeting a
    // DIFFERENT version, prefer that version's own row from rawTc.versions[] for name/executionType/
    // reviewApproveStatus below; syncONOFF isn't carried per-version there, so it falls back to ''.
    const versionsDetailsRaw = rawTc?.versionsDetails && typeof rawTc.versionsDetails === 'object' ? rawTc.versionsDetails : {};
    const currentVersionId = str(rawTc, 'versionId', 'selectedVersionId') ?? str(versionsDetailsRaw, 'id', '_id', 'versionId');
    const targetsCurrentVersion = !opts.versionId || opts.versionId === currentVersionId;
    // Match the TARGET version: the explicit opts.versionId when given, otherwise the TC's current
    // version. Matching only opts.versionId made the common "no version specified" path miss the row
    // and fall back to a default name (v1.0), so a new version carried the wrong name.
    const targetVersionId = opts.versionId || currentVersionId;
    const versionMatch = Array.isArray(rawTc?.versions)
      ? rawTc.versions.find((v: any) => str(v, 'id', '_id') === targetVersionId)
      : undefined;

    const execType = String(
      (targetsCurrentVersion ? str(rawTc, 'executionType') : str(versionMatch, 'executionType')) ?? '',
    ).toUpperCase();
    if (execType === 'DUO') {
      throw new Error('DUO test cases are not yet supported for replaceInSource — split the extraction into AUTOMATION-only or MANUAL-only first.');
    }
    const syncOnOff = targetsCurrentVersion ? str(versionsDetailsRaw, 'syncONOFF') : undefined;
    if (syncOnOff === 'SYNCON') {
      throw new Error('SYNCON (mirrored automation/manual) test cases are not yet supported for replaceInSource.');
    }
    const sourceVersionId =
      opts.versionId ||
      currentVersionId ||
      (Array.isArray(rawTc?.versions) && rawTc.versions.length > 0
        ? str(rawTc.versions[0], 'id', '_id')
        : undefined);
    if (!sourceVersionId) throw new Error(`test case ${tcId} has no versionId — cannot save`);

    const rawSteps = await this.fetchStepsCollection(tcId, rawTc, opts.versionId);

    // Refuse picks that would break brackets. FUNCTION/FUNCTION_END pairs must not be half-picked;
    // control-flow starts (IF/WHILE_START/FOR_START/…) must not span the range partially.
    const CONTROL_TYPES = new Set([
      'FUNCTION', 'FUNCTION_END', 'IF', 'ELSE_IF', 'ELSE', 'IF_END',
      'FOR_START', 'FOR_END', 'WHILE_START', 'WHILE_END', 'DO', 'DO_WHILE_END',
      'ITERATOR_START', 'ITERATOR_END', 'LOOP_ITERATION_START', 'LOOP_ITERATION_END',
    ]);
    for (const s of rawSteps) {
      if (!seqSet.has(Number(s.seq))) continue;
      const t = String(s.stepType ?? '').toUpperCase();
      if (CONTROL_TYPES.has(t)) {
        throw new Error(`step seq ${s.seq} is a control-flow/FN bracket step (${t}) — extract a plain step range`);
      }
    }

    const insertAt = sortedSeqs[0]!;

    // Build the FUNCTION + FUNCTION_END pair. FE parent (testcase.component.ts:1953+1988-1994)
    // overrides `type` from 'FN' to 'TC' before splicing — the FN-call lives inside a TC, so it's
    // typed accordingly. `id`/`versionId` omitted so backend creates fresh rows.
    const stepLevelActions = {
      skip: false, captureScreenshot: false, continueOnFailure: false, skippedReport: false,
    };
    const fnCallStep: Record<string, unknown> = {
      seq: insertAt,
      stepType: 'FUNCTION',
      type: 'TC',
      functionId: Number.parseInt(numericId(opts.functionId), 10),
      fnVersionId: opts.fnVersionId,
      description: '',
      projectId,
      moduleId: opts.fnModuleId,
      executionType: execType || 'AUTOMATION',
      technologyType: opts.technologyType,
      stepLevelActions,
    };
    const fnEndStep: Record<string, unknown> = {
      seq: insertAt + 1,
      stepType: 'FUNCTION_END',
      type: 'TC',
      projectId,
      moduleId: opts.fnModuleId,
      executionType: execType || 'AUTOMATION',
      technologyType: opts.technologyType,
      stepLevelActions,
    };

    // Kept steps: preserve id/versionId/parentId (this is an update, not a fresh save) and pass
    // through as-is. Extracted steps: same, plus `deleted:true` — the backend's param collector
    // (tcfn.service.js:411) skips deleted rows, so their paramIds automatically drop from the TC's
    // rebuilt testdata columns. Do NOT strip parameterIds / objectParameterIds / parameterizedParamIds
    // from the deleted rows — those are what `allParameters` compares against to know what to prune.
    const kept: any[] = [];
    const deleted: any[] = [];
    for (const s of rawSteps) {
      const step = { ...s };
      delete step.subSteps; // transient — flat-only per the STEPSTOFN comment
      if (seqSet.has(Number(step.seq))) {
        step.deleted = true;
        delete step.objectOfparameters; // FE mirror (testcase.component.ts:1272)
        deleted.push(step);
      } else {
        kept.push(step);
      }
    }
    kept.sort((a, b) => Number(a.seq) - Number(b.seq));

    // Splice fn-call pair at the insert position. seqs 1..N are re-assigned at the end so nothing
    // downstream can misalign.
    const afterInsert = kept.filter((k) => Number(k.seq) > sortedSeqs[sortedSeqs.length - 1]!);
    const beforeInsert = kept.filter((k) => Number(k.seq) < insertAt);
    const orderedLive: any[] = [...beforeInsert, fnCallStep, fnEndStep, ...afterInsert];
    let seq = 1;
    for (const s of orderedLive) { s.seq = seq++; }

    // Backend expects both automationSteps and manualSteps buckets. Live steps route by their
    // executionType; deleted steps come along in their own bucket (FE mirror lines 1268-1284).
    const automationSteps: any[] = [];
    const manualSteps: any[] = [];
    const bucketFor = (s: any): 'AUTOMATION' | 'MANUAL' => {
      const et = String(s?.executionType ?? '').toUpperCase();
      return et === 'MANUAL' ? 'MANUAL' : 'AUTOMATION';
    };
    for (const s of orderedLive) (bucketFor(s) === 'MANUAL' ? manualSteps : automationSteps).push(s);
    for (const s of deleted) (bucketFor(s) === 'MANUAL' ? manualSteps : automationSteps).push(s);

    // tcfnObj: strict allow-list — extras trip the joi validator. Backend mirrors the FE's normal
    // update PUT (testcase.component.ts:1376+1495): `operation:"TC"`, `type:"TC"`, same versionsDetails.
    const tcfnObj = pick(rawTc, TCFNOBJ_ALLOWED_KEYS);
    tcfnObj['deleted'] = false;
    tcfnObj['id'] = Number.parseInt(numericId(tcId), 10);
    tcfnObj['projectId'] = typeof tcfnObj['projectId'] === 'number' ? tcfnObj['projectId'] : projectId;
    if (typeof tcfnObj['obsolete'] !== 'boolean') tcfnObj['obsolete'] = false;

    // Backend joi validator refuses an empty versionsDetails.name (BADREQUEST from /tm/testcase).
    // `versionsDetailsRaw` only describes the CURRENT version — when targeting a different one,
    // its name/reviewApproveStatus belong to the wrong version, so prefer `versionMatch` instead.
    // Fall back to 'v1.0' (the SQA default set by project.service.js) if nothing resolves.
    const versionName =
      (targetsCurrentVersion ? str(versionsDetailsRaw, 'name') : undefined) ??
      str(versionMatch, 'name') ??
      'v1.0';
    const reviewApproveStatus =
      (targetsCurrentVersion ? str(versionsDetailsRaw, 'reviewApproveStatus') : undefined) ??
      str(versionMatch, 'reviewApproveStatus') ??
      '';

    const versionsDetails: Record<string, unknown> = {
      name: versionName,
      id: sourceVersionId,
      deleted: false,
      syncONOFF: syncOnOff ?? '',
      executionType: execType || 'AUTOMATION',
      functionProjectIds: [projectId],
      reviewApproveStatus,
    };

    const payload = {
      tcfnObj,
      steps: { automationSteps, manualSteps },
      versionsDetails,
      operation: 'TC',
      type: 'TC',
    };

    const raw = await this.http.putMultipart!<any>('/tm/testcase', 'testcaseObj', payload);
    const flat = raw?.data ?? raw ?? {};
    const savedId = str(flat, 'id', '_id', 'testcaseId') ?? numericId(tcId);
    return {
      id: savedId,
      created: false,
      productUrl: this.productUrlFor({ kind: 'testcase', id: savedId }),
    };
  }

  /** Swap a contiguous run of a TC's steps for a call to an EXISTING function (no new function is
   *  created). Resolves what the replace needs from the function itself: its newest version, its module
   *  and — from the picked steps — the technology. Same backend effect as the FE "Save & Replace". */
  async replaceStepsWithExistingFunction(
    tcId: string,
    opts: { functionId: string; stepSeqs: number[]; versionId?: string | undefined },
  ): Promise<SavedRef> {
    const projectId = this.requireProjectId();
    const fnNum = numericId(opts.functionId);
    const fnVersionId = await this.fetchFnVersionId(opts.functionId);
    const rawFn = await this.http.getJson<any>(`/tm/function/${fnNum}/${projectId}`);
    let fnDoc: any = rawFn?.data ?? rawFn;
    if (Array.isArray(fnDoc)) fnDoc = fnDoc.length > 0 ? fnDoc[0] : {};
    const fnModuleId = Number(fnDoc?.moduleId);
    if (!Number.isFinite(fnModuleId) || fnModuleId <= 0) {
      throw new Error(`function ${opts.functionId} has no module — cannot call it from a test case`);
    }
    const rawTc = await this.fetchRawTestcase(tcId);
    const rawSteps = await this.fetchStepsCollection(tcId, rawTc, opts.versionId);
    const picked = rawSteps.filter((s: any) => opts.stepSeqs.includes(Number(s.seq)));
    const techs = new Set(picked.map((s: any) => str(s, 'technologyType')).filter(Boolean));
    const technologyType = techs.size === 1 ? [...techs][0]! : (str(rawTc, 'tcType') ?? 'WEB');
    return this.replaceStepsWithFunctionCall(tcId, {
      extractedSeqs: opts.stepSeqs,
      functionId: opts.functionId,
      fnVersionId,
      fnModuleId,
      technologyType,
      versionId: opts.versionId,
    });
  }

  /** One-shot extract-to-function-and-replace. Chains STEPSTOFN → fetch fn version id → replace in
   *  source TC. If step 2 or 3 fails after step 1 succeeded, the caller sees the fn id in the error
   *  so they can retry or clean up the phantom function. */
  async extractStepsAsFunctionAndReplace(
    tcId: string,
    opts: {
      stepSeqs: number[];
      name: string;
      moduleId: number;
      copyTestData?: boolean;
      executionType?: 'AUTOMATION' | 'MANUAL';
      versionId?: string | undefined;
    },
  ): Promise<SavedRef & { fnId: string; fnVersionId: string }> {
    const fnRef = await this.saveStepsAsFunction(tcId, opts);
    let fnVersionId: string;
    try {
      fnVersionId = await this.fetchFnVersionId(fnRef.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Function ${fnRef.id} was created but its version lookup failed — the source TC was NOT modified. ${msg}`);
    }
    // Reuse tech detection from saveStepsAsFunction (same rule: single tech across picks → that
    // tech, else fall back to the source TC's tcType).
    const rawTc = await this.fetchRawTestcase(tcId);
    const rawSteps = await this.fetchStepsCollection(tcId, rawTc, opts.versionId);
    const picked = rawSteps.filter((s: any) => opts.stepSeqs.includes(Number(s.seq)));
    const techs = new Set(picked.map((s: any) => str(s, 'technologyType')).filter(Boolean));
    const technologyType = techs.size === 1 ? [...techs][0]! : (str(rawTc, 'tcType') ?? 'WEB');
    try {
      const tcRef = await this.replaceStepsWithFunctionCall(tcId, {
        extractedSeqs: opts.stepSeqs,
        functionId: fnRef.id,
        fnVersionId,
        fnModuleId: opts.moduleId,
        technologyType,
        versionId: opts.versionId,
      });
      return { ...tcRef, fnId: fnRef.id, fnVersionId };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Function ${fnRef.id} (version ${fnVersionId}) was created but replacing steps in ${tcId} failed — clean up the function or retry with tc_replace_steps_with_function. ${msg}`);
    }
  }

  /** Soft-delete. `/tm/testcase/delete` returns HTTP 200 either way — its `data` is `true` on real
   *  delete, or an array of dependency records when the TC is still referenced by a defect, suite,
   *  execution plan, scenario, workflow, pipeline, or scheduler (nothing was deleted). Inspect the
   *  shape and throw so the tool surfaces it as a failure instead of a fake success. */
  async deleteTestCase(id: string): Promise<void> {
    const projectId = this.requireProjectId();
    const raw = await this.http.postJson<any>('/tm/testcase/delete', {
      ids: [Number.parseInt(numericId(id), 10)],
      projectId,
      isDelete: true,
    });
    const data = raw?.data;
    if (data === true) return;
    const deps = Array.isArray(data) ? data[0] : undefined;
    const list = (m: any): string[] =>
      m && typeof m === 'object' ? Object.values(m).flat().map(String) : [];
    const refs: string[] = [];
    const groups: Array<[string, string]> = [
      ['defectArr', 'defects'], ['suiteArr', 'suites'], ['epArr', 'execution plans'],
      ['scenarioArr', 'scenarios'], ['wfArr', 'workflows'], ['pipelineArr', 'pipelines'],
      ['schedulerArr', 'schedulers'],
    ];
    for (const [key, label] of groups) {
      const ids = list(deps?.[key]);
      if (ids.length) refs.push(`${label} (${ids.join(', ')})`);
    }
    throw new Error(
      refs.length
        ? `Not deleted — test case is still referenced by ${refs.join('; ')}. Remove those references first.`
        : 'Not deleted — the backend reported blocking dependencies.',
    );
  }

  /** Clone a testcase in place (same project + module) with all steps, versions, testdata,
   *  parameters, object refs, and nested function calls carried over. Backed by the SQA native
   *  the FE in-editor "Save as new TC" dialog — `PUT /tm/testcase` with `operation:SAVEASNEWTC`.
   *  Same-project only (no cross-project copy — use the FE tree menu for that). Clones ONE
   *  source version. `tdCopy:true` clones the source's testdata iterations across every env;
   *  `tdCopy:false` copies only the column structure (one empty ITR-1 per env, values fall back
   *  to project-level parameter defaultValue if any). Mirrors the FE's "COPY TEST DATA" modal. */
  async cloneTestCase(
    id: string,
    newTitle: string,
    opts: { tdCopy: boolean; sourceVersionId?: string },
  ): Promise<SavedRef> {
    assertBusinessKeyKind(id, 'TC');
    const projectId = this.requireProjectId();
    const title = newTitle?.trim();
    if (!title) throw new Error('newTitle is required for save-as-new-testcase.');

    const rawTc = await this.fetchRawTestcase(id);
    if (!rawTc || Object.keys(rawTc).length === 0) throw new Error(`test case ${id} not found`);
    const sourceId = Number.parseInt(numericId(id), 10);

    // Resolve source version — same fallback chain as saveAsNewVersion.
    let sourceVersionId = opts.sourceVersionId;
    if (!sourceVersionId) {
      sourceVersionId = str(rawTc, 'versionId', 'selectedVersionId', 'selVersion');
      if (!sourceVersionId && rawTc?.versionsDetails && typeof rawTc.versionsDetails === 'object') {
        sourceVersionId = str(rawTc.versionsDetails, 'id', '_id', 'versionId');
      }
      if (!sourceVersionId && Array.isArray(rawTc?.versions) && rawTc.versions.length > 0) {
        sourceVersionId = str(rawTc.versions[0], 'id', '_id');
      }
    }
    // Source version's NAME (SAVEASNEWTC re-uses the same version name on the copy, per FE).
    const sourceVersionName = (() => {
      if (rawTc?.versionsDetails?.id === sourceVersionId) return str(rawTc.versionsDetails, 'name');
      const match = Array.isArray(rawTc?.versions)
        ? rawTc.versions.find((v: any) => str(v, 'id', '_id') === sourceVersionId)
        : undefined;
      return match ? str(match, 'name') : str(rawTc?.versionsDetails, 'name');
    })() ?? 'v1.0';

    // Steps must come from the SELECTED source version, not whichever version the TC has open.
    const rawSteps = await this.fetchStepsCollection(id, rawTc, sourceVersionId);
    const automationSteps: any[] = [];
    const manualSteps: any[] = [];
    for (const s of rawSteps) {
      const step = pick(s, STEP_ALLOWED_KEYS);
      const et = typeof step['executionType'] === 'string' ? String(step['executionType']).toUpperCase() : '';
      if (et === 'MANUAL') manualSteps.push(step);
      else automationSteps.push(step);
    }

    const tcfnObj = pick(rawTc, TCFNOBJ_ALLOWED_KEYS);
    tcfnObj['deleted'] = false;
    tcfnObj['projectId'] = typeof tcfnObj['projectId'] === 'number' ? tcfnObj['projectId'] : projectId;
    if (typeof tcfnObj['obsolete'] !== 'boolean') tcfnObj['obsolete'] = false;
    tcfnObj['name'] = title;
    tcfnObj['copiedFromTcId'] = sourceId;

    const prevSync = rawTc?.versionsDetails && typeof rawTc.versionsDetails === 'object'
      ? str(rawTc.versionsDetails, 'syncONOFF')
      : undefined;
    const versionsDetails: Record<string, unknown> = {
      name: sourceVersionName,
      id: '',
      syncONOFF: prevSync === 'SYNCOFF' ? '' : (prevSync ?? ''),
      deleted: false,
      executionType: str(rawTc, 'executionType') ?? 'AUTOMATION',
      functionProjectIds: [tcfnObj['projectId']],
      reviewApproveStatus: '',
    };

    const verData: Record<string, unknown> = {
      tdCopy: !!opts.tdCopy,
      ...(sourceVersionId ? { selVersionId: sourceVersionId } : {}),
    };

    const payload = {
      tcfnObj,
      steps: { automationSteps, manualSteps },
      versionsDetails,
      operation: 'SAVEASNEWTC',
      type: 'TC',
      verData,
    };

    const raw = await this.http.putMultipart!<any>('/tm/testcase', 'testcaseObj', payload);
    const flat = raw?.data ?? raw ?? {};
    const newId = str(flat, 'id', '_id', 'testcaseId');
    if (!newId) throw new Error('SAVEASNEWTC succeeded but returned no id.');
    return {
      id: newId,
      created: true,
      productUrl: this.productUrlFor({ kind: 'testcase', id: newId }),
    };
  }

  // ---------------------------------------------------------------------- Functions (reusable)
  // Same tcfnObj collection as testcases — type='FN' instead of 'TC'. Search / getById / delete /
  // steps all mirror the testcase endpoints one-to-one.

  async listFunctions(q: FunctionQuery): Promise<ListResult<FunctionSummary>> {
    const projectId = this.requireProjectId();
    const fields: Array<{ column: string; value: any; regEx?: boolean }> = [
      { column: 'deleted', value: false },
      { column: 'projectId', value: projectId },
    ];
    if (q.search) fields.push({ column: 'name', value: q.search, regEx: true });
    if (q.fnType) fields.push({ column: 'fnType', value: q.fnType });
    if (q.executionType) fields.push({ column: 'executionType', value: q.executionType });
    if (q.moduleId) fields.push({ column: 'moduleId', value: Number.parseInt(numericId(q.moduleId), 10) });
    const createdBy = await this.resolveUserFilter(q.createdBy);
    if (createdBy != null) fields.push({ column: 'createdBy', value: createdBy });
    const updatedBy = await this.resolveUserFilter(q.updatedBy);
    if (updatedBy != null) fields.push({ column: 'updatedBy', value: updatedBy });
    const body = this.searchBody(fields, {
      startIndex: q.offset ?? 0,
      limit: q.limit ?? 100,
      selectFields: ['id', 'code', 'name', 'description', 'fnType', 'executionType',
                     'reviewApproveStatus', 'stepCount'],
    });
    const raw = await this.http.postJson<any>('/tm/function/search', body);
    const rows = pickArray(raw, 'data', 'content', 'functions');
    return withTotal(rows.map(toFunctionSummary), raw);
  }

  // --- Function reuse: identity-based matching ------------------------------------------------

  /** parameterId → name for the whole project, fetched once. The matcher compares parameter NAMES
   *  because the ids differ between a function and a recording of the same flow. */
  private fnParamNames: Promise<Map<number, string>> | null = null;
  private parameterNameMap(): Promise<Map<number, string>> {
    if (!this.fnParamNames) {
      this.fnParamNames = (async () => {
        const projectId = this.requireProjectId();
        const body = this.searchBody(
          [{ column: 'projectId', value: projectId }],
          { selectFields: ['id', 'name'], limit: 1000 },
        );
        const raw = await this.http.postJson<any>('/tm/parameter/search', body);
        const out = new Map<number, string>();
        for (const r of pickArray(raw, 'data', 'content')) {
          const id = Number.parseInt(str(r, 'id', '_id', 'parameterId') ?? '', 10);
          const name = str(r, 'name');
          if (Number.isFinite(id) && name) out.set(id, name);
        }
        return out;
      })().catch((e) => {
        // Don't cache a failure — the next call must retry.
        this.fnParamNames = null;
        throw e;
      });
    }
    return this.fnParamNames;
  }

  /**
   * Functions whose WHOLE BODY already appears inside this test case.
   *
   * Matched on the identifiers a step is made of — actionId, objectId, stepType, technologyType and
   * the parameter NAMES it consumes — not on display names. Candidates come from ONE query on the
   * steps collection (`POST /tm/testcase/steps` filtered to type=FN), so a project with hundreds of
   * functions is not walked one by one; only the shortlisted bodies are fetched and verified.
   *
   * Returns longest-first, non-overlapping candidates with the exact `seq`s to replace.
   */
  async functionCandidatesFor(
    tcId: string,
    opts: { versionId?: string | undefined; minConfidence?: MinConfidence | undefined } = {},
  ): Promise<FnCandidate[]> {
    const rawTc = await this.fetchRawTestcase(tcId);
    if (!rawTc || Object.keys(rawTc).length === 0) throw new Error(`test case ${tcId} not found`);
    const rawSteps = await this.fetchStepsCollection(tcId, rawTc, opts.versionId);
    const plain = rawSteps.filter(isPlainStep);
    if (plain.length < 2) return [];

    const names = await this.parameterNameMap();

    // Shortlist: every FN parent that holds a step with one of this TC's actions / elements.
    const actionIds = [...new Set(plain.map((s: any) => Number(s.actionId)).filter((n: number) => Number.isFinite(n)))];
    const objectIds = [...new Set(plain.map((s: any) => Number(s.objectId)).filter((n: number) => Number.isFinite(n)))];
    if (!actionIds.length && !objectIds.length) return [];
    const searchFields: Array<Record<string, unknown>> = [
      { column: 'deleted', value: false },
      { column: 'type', value: 'FN' },
      ...(actionIds.length ? [{ column: 'actionId', value: actionIds }] : []),
      ...(objectIds.length ? [{ column: 'objectId', value: objectIds }] : []),
    ];
    let parents: Record<string, number> = {};
    try {
      parents = await this.http.postJson<Record<string, number>>('/tm/testcase/steps', {
        searchFields, startIndex: 0, limit: 50000,
      });
    } catch {
      return [];
    }
    const pairs: Array<{ fnId: string; versionId: string }> = [];
    for (const key of Object.keys(parents ?? {})) {
      const dash = key.indexOf('-');
      if (dash <= 0) continue;
      const fnId = key.slice(0, dash);
      const versionId = key.slice(dash + 1);
      if (/^\d+$/.test(fnId) && versionId) pairs.push({ fnId, versionId });
      if (pairs.length >= 50) break;
    }
    if (!pairs.length) return [];

    // A function already called in this TC must not be suggested again.
    const alreadyCalled = new Set(
      rawSteps
        .filter((s: any) => String(s.stepType ?? '').toUpperCase() === 'FUNCTION')
        .map((s: any) => String(s.functionId ?? '')),
    );

    const found: FnCandidate[] = [];
    // Bounded concurrency + a retry: this used to fan out up to 50 functions × 3 HTTP calls at once,
    // and a SINGLE transient failure silently DROPPED that function — so a "replace all" could swap
    // some of the chosen functions and leave the rest as plain steps, reporting success.
    const CHUNK = 4;
    for (let i = 0; i < pairs.length; i += CHUNK) {
      await Promise.all(pairs.slice(i, i + CHUNK).map(async ({ fnId, versionId }) => {
        if (alreadyCalled.has(fnId)) return;
        let fnSteps: any[] = [];
        try {
          fnSteps = await this.retryOnce(() => this.fetchFunctionStepsForVersion(fnId, versionId));
        } catch {
          return; // no steps → this function genuinely cannot be matched
        }
        if (!fnSteps.length) return;
        // Metadata is ONLY the label — a failure here must never drop a real match.
        const meta = await this.getFunction(fnId).catch(() => undefined);
        const fnName = meta?.name ?? `FN-${fnId}`;
        for (const run of findRuns(rawSteps, fnSteps, (id) => names.get(id))) {
          const covered = rawSteps.slice(run.index, run.index + fnSteps.filter(isPlainStep).length);
          found.push({
            fnId,
            ...(meta?.code ? { fnCode: meta.code } : {}),
            fnName,
            fnVersionId: versionId,
            start: run.index,
            length: covered.length,
            seqs: covered.map((s: any) => Number(s.seq)),
            confidence: run.confidence,
          });
        }
      }));
    }

    const floor = opts.minConfidence ?? 'strong';
    return pickNonOverlapping(found.filter((c) => atLeast(c.confidence, floor)));
  }

  /** One retry for a transient backend blip (the SQA API intermittently answers GOAWAY / drops a
   *  connection). Used only on per-function lookups, where a miss used to silently drop a candidate. */
  private async retryOnce<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (first) {
      await new Promise((r) => setTimeout(r, 250));
      try { return await fn(); } catch { throw first; }
    }
  }

  async getFunction(id: string): Promise<QaFunction> {
    const projectId = this.requireProjectId();
    const fnNum = numericId(id);
    const raw = await this.http.getJson<any>(`/tm/function/${fnNum}/${projectId}`);
    let doc: any = raw?.data ?? raw;
    if (Array.isArray(doc)) doc = doc.length > 0 ? doc[0] : {};
    if (!doc || typeof doc !== 'object' || Object.keys(doc).length === 0) {
      throw new Error(`function ${id} not found`);
    }
    const fn = toFunction(doc);
    // Fetch version rows ONCE — reused to (a) pick the newest for the steps call and (b) hydrate
    // `fn.versions` for the caller. The FN doc from `/tm/function/:id/:pid` has NO inline versions[]
    // (unlike TC's getById), so this sibling endpoint is the only source. Non-fatal on failure.
    let versionRows: any[] = [];
    try { versionRows = await this.fetchFunctionVersionRows(fnNum); } catch { /* leave empty */ }
    const currentVersionId = versionRows.length
      ? str(versionRows[0], 'id', '_id', 'versionId')
      : undefined;
    if (versionRows.length) fn.versions = toVersionEntries(versionRows, currentVersionId);
    if (currentVersionId) {
      try {
        const rows = await this.fetchFunctionStepsForVersion(fnNum, currentVersionId);
        if (rows.length > 0) fn.steps = rows.map((s: any, i: number) => fromSqaStep(s, i + 1));
      } catch { /* leave steps empty */ }
    }
    // A FUNCTION's steps need the same hydration a test case's get: human OBJECT names are what the
    // function-reuse matcher compares against a fresh recording, and a human ACTION name is what it
    // compares against a recorded step (which carries the display name, never the numeric id).
    if (fn.steps?.length) {
      try { await this.hydrateObjectNames({ steps: fn.steps }); } catch { /* names stay bare */ }
      try { await this.resolveActionNames(fn.steps); } catch { /* ids stay numeric */ }
    }
    return fn;
  }

  /** Stamp the backend's human action name onto steps whose `actionType` is a raw numeric action id.
   *  Hydrated steps carry `actionType = String(actionId)` so a save round-trips exactly, but anything
   *  comparing a saved step to a freshly RECORDED one (which carries the display name, e.g. "Type Text")
   *  can never match a bare "106". Best-effort: an unavailable catalog leaves the id untouched. */
  private async resolveActionNames(steps: Step[]): Promise<void> {
    if (!steps.some((s) => /^\d+$/.test(String(s.actionType ?? '').trim()))) return;
    const catalog = await this.actionCatalog();
    for (const s of steps) {
      const raw = String(s.actionType ?? '').trim();
      if (!/^\d+$/.test(raw)) continue;
      const meta = catalog.get(`id::${Number.parseInt(raw, 10)}`);
      const name = meta?.displayName ?? meta?.name;
      if (name) s.actionType = name;
    }
  }

  /** Steps for one FN version. Unlike TC docs, the FN doc from `/tm/function/:id/:projectId`
   *  doesn't carry a versionId inline — callers resolve the target versionId (usually the newest,
   *  from `fetchFunctionVersionRows`) and pass it here. */
  private async fetchFunctionStepsForVersion(fnNum: string, versionId: string): Promise<any[]> {
    const projectId = this.requireProjectId();
    const qs =
      `?projectId=${projectId}` +
      `&tcfnId=${fnNum}` +
      `&versionId=${encodeURIComponent(versionId)}` +
      '&type=FN';
    // The steps COLLECTION endpoint returns the full rows (actionId / objectId / parameterIds) for a
    // function too. `/tm/function/steps` answers a thin shape (description + stepType), so a function
    // read from it had no action/object to compare and the function-reuse matcher could NEVER suggest
    // replacing recorded steps with it — the replace half silently returned nothing.
    try {
      const body = await this.http.getJson<any>(`/tm/testcase/steps${qs}`);
      const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
      if (rows.length) return rows;
    } catch { /* fall through to the legacy endpoint */ }
    const legacy = await this.http.getJson<any>(`/tm/function/steps${qs}`);
    return Array.isArray(legacy) ? legacy : Array.isArray(legacy?.data) ? legacy.data : [];
  }

  /** The function's version rows, newest-first. */
  private async fetchFunctionVersionRows(fnNum: string): Promise<any[]> {
    const projectId = this.requireProjectId();
    const raw = await this.http.getJson<any>(`/tm/function/version/${fnNum}/${projectId}`);
    const rows = pickArray(raw, 'data', 'content', 'versions');
    if (!rows.length) return [];
    return [...rows].sort(
      (a: any, b: any) => Number(b?.versionNumber ?? 0) - Number(a?.versionNumber ?? 0),
    );
  }

  /** Soft-delete a function. `/tm/function/delete` returns HTTP 200 either way — its `data` is
   *  `true` on real delete, or an array of dependency records when the FN is still referenced by a
   *  TC / FN / workflow (nothing was deleted). Inspect the shape and throw so the tool surfaces it
   *  as a failure instead of a fake success. */
  async deleteFunction(id: string): Promise<void> {
    const projectId = this.requireProjectId();
    const raw = await this.http.postJson<any>('/tm/function/delete', {
      ids: [Number.parseInt(numericId(id), 10)],
      projectId,
      isDelete: true,
    });
    const data = raw?.data;
    if (data === true) return;
    const deps = Array.isArray(data) ? data[0] : undefined;
    const list = (m: any): string[] =>
      m && typeof m === 'object' ? Object.values(m).flat().map(String) : [];
    const tcs = list(deps?.tcArr);
    const fns = list(deps?.fnArr);
    const wfs = list(deps?.wfArr);
    const refs: string[] = [];
    if (tcs.length) refs.push(`test cases (${tcs.join(', ')})`);
    if (fns.length) refs.push(`functions (${fns.join(', ')})`);
    if (wfs.length) refs.push(`workflows (${wfs.join(', ')})`);
    throw new Error(
      refs.length
        ? `Not deleted — function is still referenced by ${refs.join('; ')}. Remove those references first.`
        : 'Not deleted — the backend reported blocking dependencies.',
    );
  }

  /** Save-as-new-function — same-project only. Mirrors FE's in-editor "Save as new function"
   *  dialog: `PUT /tm/function` with `operation:SAVEASNEWFN`. Clones ONE source version.
   *  `tdCopy:true` clones testdata; `tdCopy:false` copies structure only (empty ITR-1 per env). */
  async cloneFunction(
    id: string,
    newTitle: string,
    opts: { tdCopy: boolean; sourceVersionId?: string },
  ): Promise<SavedRef> {
    assertBusinessKeyKind(id, 'FN');
    const projectId = this.requireProjectId();
    const title = newTitle?.trim();
    if (!title) throw new Error('newTitle is required for save-as-new-function.');

    const fnNum = numericId(id);
    const rawFn = await this.http.getJson<any>(`/tm/function/${fnNum}/${projectId}`);
    let rawTc: any = rawFn?.data ?? rawFn;
    if (Array.isArray(rawTc)) rawTc = rawTc.length > 0 ? rawTc[0] : {};
    if (!rawTc || typeof rawTc !== 'object' || Object.keys(rawTc).length === 0) {
      throw new Error(`function ${id} not found`);
    }
    const sourceId = Number.parseInt(fnNum, 10);

    // Resolve source version — FN doc has no inline versionId, use version list.
    let sourceVersionId = opts.sourceVersionId;
    const versionRows = await this.fetchFunctionVersionRows(fnNum);
    if (!sourceVersionId && versionRows.length > 0) {
      sourceVersionId = str(versionRows[0], 'id', '_id', 'versionId');
    }
    const sourceVersionName = (() => {
      const match = versionRows.find((v: any) => str(v, 'id', '_id', 'versionId') === sourceVersionId);
      return match ? str(match, 'name') : (versionRows[0] ? str(versionRows[0], 'name') : undefined);
    })() ?? 'v1.0';

    const rawSteps = sourceVersionId
      ? await this.http.getJson<any>(
          '/tm/function/steps' +
            `?projectId=${projectId}` +
            `&tcfnId=${fnNum}` +
            `&versionId=${encodeURIComponent(sourceVersionId)}` +
            '&type=FN',
        ).then((body: any) => (Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []))
      : [];

    const automationSteps: any[] = [];
    const manualSteps: any[] = [];
    for (const s of rawSteps as any[]) {
      const step = pick(s, STEP_ALLOWED_KEYS);
      const et = typeof step['executionType'] === 'string' ? String(step['executionType']).toUpperCase() : '';
      if (et === 'MANUAL') manualSteps.push(step);
      else automationSteps.push(step);
    }

    const tcfnObj = pick(rawTc, TCFNOBJ_FN_ALLOWED_KEYS);
    tcfnObj['deleted'] = false;
    tcfnObj['projectId'] = typeof tcfnObj['projectId'] === 'number' ? tcfnObj['projectId'] : projectId;
    if (typeof tcfnObj['fnType'] !== 'string' || !tcfnObj['fnType']) {
      tcfnObj['fnType'] = str(rawTc, 'fnType', 'tcType') ?? 'WEB';
    }
    tcfnObj['name'] = title;
    tcfnObj['copiedFromFnId'] = sourceId;

    const prevSync = rawTc?.versionsDetails && typeof rawTc.versionsDetails === 'object'
      ? str(rawTc.versionsDetails, 'syncONOFF')
      : undefined;
    const versionsDetails: Record<string, unknown> = {
      name: sourceVersionName,
      id: '',
      syncONOFF: prevSync === 'SYNCOFF' ? '' : (prevSync ?? ''),
      deleted: false,
      executionType: str(rawTc, 'executionType') ?? 'AUTOMATION',
      reviewApproveStatus: '',
    };

    const verData: Record<string, unknown> = {
      tdCopy: !!opts.tdCopy,
      ...(sourceVersionId ? { selVersionId: sourceVersionId } : {}),
    };

    const payload = {
      tcfnObj,
      steps: { automationSteps, manualSteps },
      versionsDetails,
      operation: 'SAVEASNEWFN',
      type: 'FN',
      verData,
    };

    const raw = await this.http.putMultipart!<any>('/tm/function', 'functionObj', payload);
    const flat = raw?.data ?? raw ?? {};
    const newId = str(flat, 'id', '_id', 'functionId');
    if (!newId) throw new Error('SAVEASNEWFN succeeded but returned no id.');
    return {
      id: newId,
      created: true,
      productUrl: this.productUrlFor({ kind: 'function', id: newId }),
    };
  }

  /** Snapshot the CURRENT server state of a function under a NEW version name — same FN id, new
   *  `tcfn_version` row with cloned steps. Mirrors `saveAsNewVersion` (see there for the shape
   *  rationale) with `type:'FN'` and the multipart route `PUT /tm/function` / key `functionObj`.
   *  Source-version resolution goes through the FN's `/tm/function/version/:id/:pid` list — the
   *  FN doc has no inline versionId. */
  async saveAsNewFunctionVersion(
    id: string,
    opts: { versionName: string; tdCopy?: boolean; sourceVersionId?: string },
  ): Promise<SavedRef> {
    assertBusinessKeyKind(id, 'FN');
    const projectId = this.requireProjectId();
    const versionName = opts.versionName?.trim();
    if (!versionName) throw new Error('versionName is required.');

    const fnNum = numericId(id);
    const rawFn = await this.http.getJson<any>(`/tm/function/${fnNum}/${projectId}`);
    let rawTc: any = rawFn?.data ?? rawFn;
    if (Array.isArray(rawTc)) rawTc = rawTc.length > 0 ? rawTc[0] : {};
    if (!rawTc || typeof rawTc !== 'object' || Object.keys(rawTc).length === 0) {
      throw new Error(`function ${id} not found`);
    }

    // FN doc has no inline versionId — resolve from the version list. Caller override wins.
    let sourceVersionId = opts.sourceVersionId;
    if (!sourceVersionId) {
      const versionRows = await this.fetchFunctionVersionRows(fnNum);
      if (versionRows.length > 0) sourceVersionId = str(versionRows[0], 'id', '_id', 'versionId');
    }

    // Fetch steps under the resolved (or newest) version.
    const rawSteps = sourceVersionId
      ? await this.http.getJson<any>(
          '/tm/function/steps' +
            `?projectId=${projectId}` +
            `&tcfnId=${fnNum}` +
            `&versionId=${encodeURIComponent(sourceVersionId)}` +
            '&type=FN',
        ).then((body: any) => (Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []))
      : [];

    const automationSteps: any[] = [];
    const manualSteps: any[] = [];
    for (const s of rawSteps as any[]) {
      const step = pick(s, STEP_ALLOWED_KEYS);
      const et = typeof step['executionType'] === 'string' ? String(step['executionType']).toUpperCase() : '';
      if (et === 'MANUAL') manualSteps.push(step);
      else automationSteps.push(step);
    }

    const tcfnObj = pick(rawTc, TCFNOBJ_FN_ALLOWED_KEYS);
    tcfnObj['deleted'] = false;
    tcfnObj['projectId'] = typeof tcfnObj['projectId'] === 'number' ? tcfnObj['projectId'] : projectId;
    // FN update joi REQUIRES `fnType` and REJECTS `obsolete`. Guarantee fnType from the raw doc
    // (falls through to legacy `tcType` if a pre-migration FN row is missing fnType); never set
    // obsolete.
    if (typeof tcfnObj['fnType'] !== 'string' || !tcfnObj['fnType']) {
      const fallback = str(rawTc, 'fnType', 'tcType') ?? 'WEB';
      tcfnObj['fnType'] = fallback;
    }

    // Version stub mirrors function.component.ts:900-907 — empty id tells the backend to create a
    // fresh row; SYNCOFF is normalised to '' the same way as the TC path. FN update joi REJECTS
    // `functionProjectIds` (allowed on TC's versionsDetails but not FN's — see functionValidator.js
    // updateFnBodyValidation.versionsDetails), so don't include it.
    const prevSync = rawTc?.versionsDetails && typeof rawTc.versionsDetails === 'object'
      ? str(rawTc.versionsDetails, 'syncONOFF')
      : undefined;
    const versionsDetails: Record<string, unknown> = {
      name: versionName,
      id: '',
      syncONOFF: prevSync === 'SYNCOFF' ? '' : (prevSync ?? ''),
      deleted: false,
      executionType: str(rawTc, 'executionType') ?? 'AUTOMATION',
      reviewApproveStatus: '',
    };

    const verData: Record<string, unknown> = {
      tdCopy: !!opts.tdCopy,
      ...(sourceVersionId ? { selVersionId: sourceVersionId } : {}),
    };

    const payload = {
      tcfnObj,
      steps: { automationSteps, manualSteps },
      versionsDetails,
      operation: 'SAVENEWVERSION',
      type: 'FN',
      verData,
    };

    const raw = await this.http.putMultipart!<any>('/tm/function', 'functionObj', payload);
    const flat = raw?.data ?? raw ?? {};
    const savedId = str(flat, 'id', '_id', 'functionId', 'testcaseId') ?? fnNum;
    const newVersionId =
      str(flat, 'versionId') ??
      (flat?.versionsDetails && typeof flat.versionsDetails === 'object'
        ? str(flat.versionsDetails, 'id')
        : undefined);
    return {
      id: savedId,
      created: false,
      productUrl: this.productUrlFor({ kind: 'function', id: savedId }),
      ...(newVersionId ? { artifacts: [`versionId=${newVersionId}`] } : {}),
    };
  }

  /** A story the caller named must actually link. Silently saving the test case WITHOUT its story (the old
   *  behaviour, on any lookup failure) left generated test cases unlinked with no hint why — so fail loudly and
   *  let the caller fix the reference. */
  private async resolveStoryNumericIdOrNull(storyRef: string): Promise<number | undefined> {
    let n: number;
    try {
      n = Number.parseInt(await this.resolveStoryNumericId(storyRef), 10);
    } catch (e) {
      throw new Error(`Cannot link the test case to story "${storyRef}": ${e instanceof Error ? e.message : String(e)}. ` +
        'Pass the story id or business key exactly as story_get / sqa_query returned it, or omit storyRef to save it unlinked.');
    }
    if (!Number.isFinite(n)) throw new Error(`Cannot link the test case to story "${storyRef}": it did not resolve to a numeric story id.`);
    return n;
  }

  /** Resolve every param name referenced by the TC to a SQA parameter id via get-or-create.
   *  Sources: (a) `${name}` tokens in every step's description (manual + automation), and
   *  (b) keys of every automation step's `recordedParam` (action-argument names like
   *  "packageName", "activity", "keys"). Name-uniqueness is project-wide on the backend, so
   *  get-or-create means every TC using `${appUrl}` (or the same "packageName" recorded param)
   *  links to the same parameter row.
   *
   *  A KEY THAT IS ALL DIGITS IS NOT A NAME — it is an already-bound parameter ID (a step read
   *  from the backend and re-added carries `recordedParam: {"7001": "sub_ln"}`). It is mapped to
   *  itself and NEVER get-or-created; creating a parameter literally named "7001" is how a copied
   *  step lost its original parameter and bound the wrong one. */
  private async resolveParamIds(
    projectId: number, moduleId: number, tc: TestCase,
    accessById?: Map<number, 'LOCAL' | 'RUNTIME'>,
  ): Promise<Map<string, number>> {
    const paramIdByName = new Map<string, number>();
    const steps = Array.isArray(tc.steps) ? tc.steps : [];
    // DESKTOP (plan.md P9.4): an IF's literal operands become parameters of the IF step, so their values reach the
    // test data. Only DESKTOP journal steps carry desktopConditions.
    for (const st of steps) if (st.desktopConditions?.length) seedDesktopConditionOperands(st);
    // A store slot is usually ALSO named in the step description (`${task_doc}`), and descriptions are scanned
    // first — so it must already be known as Runtime there, or it is created Local and the plugin cannot write it.
    const slotNamesByStep = new Map<Step, string[]>();
    for (const st of steps) {
      const names = await this.runtimeSlotNames(st);
      slotNamesByStep.set(st, names);
      // the mapper reads the step's own list when it writes the slot's key — hand it the derived ones too
      if (names.length > (st.runtimeParameters?.length ?? 0)) st.runtimeParameters = names;
    }
    const allRuntimeNames = new Set([...slotNamesByStep.values()].flat());
    for (const s of steps) {
      // Replace-a-parameter edits: the NEW parameter is get-or-create; the OLD one must already exist (a name or an id) —
      // never create a parameter just to remove it, and never guess.
      for (const sw of s.swapParams ?? []) {
        if (!paramIdByName.has(sw.to)) {
          const toRef = sw.to.trim();
          // An all-digit "to" is an existing parameter id, not a name to create.
          if (/^\d+$/.test(toRef)) {
            const toId = Number.parseInt(toRef, 10);
            if (!Number.isFinite(toId)) throw new Error(`Cannot replace parameter "${sw.from}" with "${sw.to}": not a valid parameter id.`);
            paramIdByName.set(sw.to, toId);
          } else {
            paramIdByName.set(sw.to, await this.getOrCreateParameter(projectId, moduleId, sw.to, sw.value ?? paramDefault(sw.to, tc.data, undefined)));
          }
        }
        if (!paramIdByName.has(sw.from)) {
          const fromRef = sw.from.trim();
          const fromId = /^\d+$/.test(fromRef) ? Number.parseInt(fromRef, 10) : await this.findParameterId(projectId, fromRef);
          if (fromId == null) {
            throw new Error(`Cannot replace parameter "${sw.from}" with "${sw.to}": "${sw.from}" does not exist in this project. Check the exact name (or pass its id).`);
          }
          paramIdByName.set(sw.from, fromId);
        }
      }
      for (const name of extractParamNames(s.description)) {
        if (paramIdByName.has(name)) continue;
        // `${7001}` is an already-bound parameter id, not a name to get-or-create.
        if (/^\d+$/.test(name)) continue;
        const isSlot = allRuntimeNames.has(name);
        const defaultValue = isSlot ? runtimeSlotValue(paramDefault(name, tc.data, s.value)) : paramDefault(name, tc.data, s.value);
        const id = await this.getOrCreateParameter(projectId, moduleId, name, defaultValue, isSlot ? 'Runtime' : 'Local');
        paramIdByName.set(name, id);
      }
      if (s.recordedParam) {
        const runtimeNames = new Set(slotNamesByStep.get(s) ?? []);
        for (const [name, value] of Object.entries(s.recordedParam)) {
          if (paramIdByName.has(name)) continue;
          // An all-digit key is an EXISTING parameter id, not a name — map it to itself and never
          // create a parameter named "7001" (that junk row is exactly what a copied step bound to).
          if (/^\d+$/.test(name)) {
            const id = Number.parseInt(name, 10);
            if (Number.isFinite(id)) paramIdByName.set(name, id);
            continue;
          }
          // A store slot ("Runtime Parameter") must be a Runtime param so the agent hands the plugin a
          // writable argument; everything else stays Local.
          const isSlot = runtimeNames.has(name);
          const id = await this.getOrCreateParameter(projectId, moduleId, name,
            isSlot ? runtimeSlotValue(String(value ?? '')) : String(value ?? ''), isSlot ? 'Runtime' : 'Local');
          paramIdByName.set(name, id);
        }
        // DATABASE steps: parameters referenced inside an argument value (`${suffix}` / `{{suffix}}` in a filter) must
        // exist so the mapper can bind them (parameterizedParamIds).
        if (s.stepType === 'database') {
          for (const [argName, value] of Object.entries(s.recordedParam)) {
            for (const name of extractValueParamNames(value)) {
              if (name === argName || paramIdByName.has(name)) continue;
              // `{{7001}}` is already a bound id — never a parameter name.
              if (/^\d+$/.test(name)) continue;
              const id = await this.getOrCreateParameter(projectId, moduleId, name, paramDefault(name, tc.data, undefined),
                allRuntimeNames.has(name) ? 'Runtime' : 'Local');
              paramIdByName.set(name, id);
            }
          }
        }
      }
      // API steps keep their `{{name}}` tokens INSIDE the request object (url/headers/body/auth),
      // not in the description — scan those too so the mapper can rewrite them to `{{<paramId>}}`
      // and register parameterIds. Without this, an API request containing {{var}} saves unbound.
      if (s.stepType === 'api') {
        const apiObj = (s.api ?? (s.sourceRaw?.['apiData'] as Record<string, unknown> | undefined));
        for (const name of extractApiParamNames(apiObj)) {
          // A purely-numeric token is an ALREADY-BOUND `{{<paramId>}}` (round-tripped from the
          // backend), not a parameter name — never create a parameter for it.
          if (/^\d+$/.test(name)) continue;
          if (paramIdByName.has(name)) continue;
          const id = await this.getOrCreateParameter(projectId, moduleId, name, paramDefault(name, tc.data, undefined));
          paramIdByName.set(name, id);
        }
      }
    }
    if (accessById) {
      // The catalog's access type is what the executor keys on for RUNTIME substitution. Copy only the
      // ids this save will bind (plus every round-tripped sourceParameterId so an untouched step is
      // still classified correctly).
      const catalog = await this.resolveParameterAccessById(projectId);
      const ids = new Set<number>([...paramIdByName.values(), ...steps.flatMap((s) => s.sourceParameterIds ?? [])]);
      for (const id of ids) {
        const t = catalog.get(id);
        if (t) accessById.set(id, t);
      }
    }
    return paramIdByName;
  }

  /** Current project's parameters by id → access type ("LOCAL" / "RUNTIME") from /tm/parameter/search.
   *  Best-effort: on failure the map is empty and the step keeps the access type it already declares. */
  private async resolveParameterAccessById(projectId: number): Promise<Map<number, 'LOCAL' | 'RUNTIME'>> {
    const out = new Map<number, 'LOCAL' | 'RUNTIME'>();
    try {
      const body = this.searchBody(
        [{ column: 'projectId', value: projectId }],
        { selectFields: ['id', 'name', 'type'], limit: 100000 },
      );
      const raw = await this.http.postJson<any>('/tm/parameter/search', body);
      for (const row of pickArray(raw, 'data', 'content')) {
        const id = Number.parseInt(str(row, 'id', '_id', 'parameterId') ?? '', 10);
        const type = (str(row, 'type') ?? '').toUpperCase();
        if (Number.isFinite(id) && (type === 'RUNTIME' || type === 'LOCAL')) out.set(id, type as 'LOCAL' | 'RUNTIME');
      }
    } catch { /* best-effort: never block a save over the parameter catalog */ }
    return out;
  }

  // ---------------------------------------------------------------------- Automation resolvers

  /** POST /tm/action/search → action catalog. Cached per adapter instance: the catalog is
   *  customer-wide and rarely changes during a session. Keys (all pointing at the same row):
   *  `<lowercase name>`, `id::<n>`, `uniq::<plugin uniqueId>`, `dis::<display name>`, and
   *  `TECH::<lowercase name>` — the last one exists because a name like "click" is registered for
   *  BOTH WEB and ANDROID, and healing must never swap one technology's action for another's. */
  private actionCatalogCache: Promise<Map<string, ActionCatalogEntry>> | null = null;
  /** Populated by actionCatalog() on each fetch. Surfaced in resolveAutomationSteps error messages
   *  so a user hitting "no SQA action named X" can see what the fetch actually returned. */
  private actionCatalogFetchDiag: string = 'never fetched';

  private actionCatalog(): Promise<Map<string, ActionCatalogEntry>> {
    if (this.actionCatalogCache) return this.actionCatalogCache;
    const projectId = this.requireProjectId();
    this.actionCatalogCache = (async () => {
      // Use the SAME filter the SQA UI uses (mobile-app/angular/.../steps.model.ts:59):
      // {projectId: {$in:[0, projectId]}}. Removing it caused /tm/action/search to return 0 rows in
      // practice — the backend endpoint apparently requires it as-is despite server-side resolvers
      // using only {customerId, deleted:false}. Keep the UI's filter to stay compatible.
      const body = {
        searchFields: [
          { column: 'deleted', value: false },
          { column: 'projectId', value: { $in: [0, projectId] } },
        ],
        startIndex: 0,
        limit: 100000,
        selectFields: ['id', 'name', 'technology', 'objectTemplate', 'objectRequired'],
      };
      // Also ask for the plugin's `@Sync` uniqueId ("db-2"): action NAMES collide (executeQuery = db-2 AND
      // db-3), so a save must resolve by uniqueId when the backend exposes it. Not every backend build
      // accepts the column, so fall back to the plain field set — resolution then degrades to by-name.
      let raw: any;
      try {
        raw = await this.http.postJson<any>('/tm/action/search', { ...body, selectFields: [...body.selectFields, 'uniqueId', 'disname'] });
      } catch {
        // Older backend build: try just the display name (a recorder step arrives with the DISPLAY
        // name, e.g. "Go to URL" for the `launchApplication` action, so this key is what makes a
        // journal→draft step resolvable at save), then fall back to the minimal field set.
        try {
          raw = await this.http.postJson<any>('/tm/action/search', { ...body, selectFields: [...body.selectFields, 'disname'] });
        } catch {
          raw = await this.http.postJson<any>('/tm/action/search', body);
        }
      }
      const rows = pickArray(raw, 'data', 'content', 'actions');
      // Capture diagnostic snapshot so downstream errors can surface WHY the fetch returned 0 rows.
      try {
        const topKeys = raw && typeof raw === 'object' ? Object.keys(raw).slice(0, 10).join(',') : typeof raw;
        const totalCount = raw?.totalCount ?? raw?.total ?? 'n/a';
        const firstRowKeys = rows[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]).slice(0, 12).join(',') : 'no-rows';
        this.actionCatalogFetchDiag = `rows.length=${rows.length} totalCount=${totalCount} raw.keys=[${topKeys}] firstRowKeys=[${firstRowKeys}] projectId=${projectId}`;
      } catch { /* diagnostic must not throw */ }
      // objectTemplate → TECHNOLOGY. Action rows have no technology column; this is the same route
      // the SQA UI uses. Best-effort: an empty map just means no `TECH::name` keys.
      const templateTech = await this.objectTemplateTechById();
      const map = new Map<string, ActionCatalogEntry>();
      for (const row of rows) {
        const idStr = str(row, 'id', '_id', 'actionId');
        const name = str(row, 'name');
        if (!idStr) continue;
        const id = Number.parseInt(idStr, 10);
        if (!Number.isFinite(id)) continue;
        const objectRequired = row?.objectRequired === true;
        const otRaw = row?.objectTemplate;
        const objectTemplate = typeof otRaw === 'number' ? otRaw
          : typeof otRaw === 'string' && /^\d+$/.test(otRaw) ? Number.parseInt(otRaw, 10)
          : undefined;
        const displayName = str(row, 'disname', 'displayName') ?? undefined;
        const technology = objectTemplate !== undefined ? templateTech.get(objectTemplate) : undefined;
        const uniq = str(row, 'uniqueId', 'actionUniqueId');
        // `@Deprecated` plugin rows still exist in the catalog (and keep numeric round-trip), but a
        // step must never be RESOLVED BY NAME onto one: they often have objectRequired:false and
        // silently drop the step's object binding (the "action disappears from the step" symptom).
        const deprecated = !!uniq && /^deprecated-/i.test(uniq);
        const entry: ActionCatalogEntry = {
          id, objectRequired,
          ...(objectTemplate !== undefined ? { objectTemplate } : {}),
          ...(displayName ? { displayName } : {}),
          ...(name ? { name } : {}),
          ...(technology ? { technology } : {}),
          ...(deprecated ? { deprecated: true } : {}),
        };
        // Name keys are SKIPPED for deprecated rows so by-name / display-name / per-tech lookups can
        // only land on a live action. `id::` and `uniq::` stay so hydrated steps round-trip exactly.
        if (name && !deprecated) {
          const key = name.toLowerCase();
          const prev = map.get(key);
          const isProjectOverride = typeof row?.projectId === 'number' && row.projectId !== 0;
          if (!prev || isProjectOverride) map.set(key, entry);
          // Technology-scoped key: the one healing validates against, so a WEB step can never be
          // repointed to an ANDROID action that happens to share the name.
          if (technology) map.set(`${technology}::${key}`, entry);
        }
        // Id-keyed entry so numeric-actionType round-trip lookups are O(1) instead of a scan.
        map.set(`id::${id}`, entry);
        // Plugin-uniqueId-keyed entry: the only collision-free way to pick db-2 vs db-3 etc.
        if (uniq) map.set(`uniq::${uniq}`, entry);
        // Display-name key ("Go to URL" → launchApplication). A RECORDED step (journal → draft) carries
        // the display name, not the camelCase action name, so a save must be able to resolve it. Last
        // write wins, matching the by-name key above.
        if (displayName && !deprecated) {
          map.set(`dis::${displayName.trim().toLowerCase()}`, entry);
          // Punctuation/space-insensitive display key: the recorder's display name and the backend's
          // `disname` can differ in spacing ("Store from JSON" vs "StoreFromJSON"), which used to make
          // a recorded generic action unresolvable — i.e. the step was silently not captured on save.
          const compactDis = actionNameKey(displayName);
          if (compactDis) map.set(`dis::${compactDis}`, entry);
          // Technology-scoped display-name key — a recorded step is resolved WITHIN its technology, so
          // "Click" cannot land on an ANDROID/IOS action that happens to share the display name.
          if (technology) {
            map.set(`${technology}::dis::${displayName.trim().toLowerCase()}`, entry);
            if (compactDis) map.set(`${technology}::dis::${compactDis}`, entry);
          }
        }
      }
      return map;
    })().catch((e) => { this.actionCatalogCache = null; throw e; });
    return this.actionCatalogCache;
  }


  /** Which positional argument slots of each action are Runtime (store) slots, from the backend's own action rows
   *  (`parameters[].runtimeParameter`). A SEPARATE, failure-tolerant fetch — the main catalog request is left exactly as
   *  it was, so a backend build that rejects the extra column cannot break saving. Any failure → empty map → callers
   *  fall back to what the step itself declares. Keyed like the catalog: `uniq::<db-17>`, `id::<n>`, lowercase name. */
  private actionSlotCache: Promise<Map<string, boolean[]>> | null = null;
  private actionRuntimeSlots(): Promise<Map<string, boolean[]>> {
    if (this.actionSlotCache) return this.actionSlotCache;
    this.actionSlotCache = (async () => {
      const out = new Map<string, boolean[]>();
      try {
        const projectId = this.requireProjectId();
        const raw = await this.http.postJson<any>('/tm/action/search', {
          searchFields: [{ column: 'deleted', value: false }, { column: 'projectId', value: { $in: [0, projectId] } }],
          startIndex: 0,
          limit: 100000,
          selectFields: ['id', 'name', 'uniqueId', 'parameters'],
        });
        for (const row of pickArray(raw, 'data', 'content', 'actions')) {
          const params = Array.isArray(row?.parameters) ? row.parameters : [];
          if (!params.length) continue;
          const flags = params.map((p: any) => p?.runtimeParameter === true || String(p?.type ?? '').toLowerCase() === 'runtime');
          if (!flags.some(Boolean)) continue;
          const id = str(row, 'id', '_id', 'actionId');
          const uniq = str(row, 'uniqueId', 'actionUniqueId');
          const name = str(row, 'name');
          if (id) out.set(`id::${Number.parseInt(id, 10)}`, flags);
          if (uniq) out.set(`uniq::${uniq}`, flags);
          if (name) out.set(name.toLowerCase(), flags);
        }
      } catch { /* optional enrichment — never blocks a save */ }
      return out;
    })();
    return this.actionSlotCache;
  }

  /** Names of a DATABASE step's recordedParam entries that are the action's Runtime (store) slot: what the step declares
   *  in `runtimeParameters`, plus — when the step does not say — the entries that sit in a Runtime slot of its action AND
   *  carry no value (a store target has none; a real input always does, so an input is never mistaken for one). */
  private async runtimeSlotNames(s: Step): Promise<string[]> {
    const declared = s.runtimeParameters ?? [];
    // DESKTOP store steps (Get Text, Get Properties, Get Selected Value) have a Runtime slot the same way.
    if ((s.stepType !== 'database' && s.stepType !== 'desktop') || !s.recordedParam) return declared;
    const slots = await this.actionRuntimeSlots();
    if (slots.size === 0) return declared;
    const name = (s.actionType ?? '').trim();
    const flags = (s.actionUniqueId ? slots.get(`uniq::${s.actionUniqueId}`) : undefined)
      ?? (/^\d+$/.test(name) ? slots.get(`id::${Number.parseInt(name, 10)}`) : slots.get(name.toLowerCase()) ?? slots.get(name.toLowerCase().replace(/[\s_-]+/g, '')));
    if (!flags) return declared;
    const derived = Object.entries(s.recordedParam)
      .filter(([, value], i) => flags[i] === true && runtimeSlotValue(String(value ?? '')).trim() === '')
      .map(([key]) => key);
    return [...new Set([...declared, ...derived])];
  }

  private async resolveObjectId(
    objectRef: { name?: string | undefined; locators?: Array<{ name: string; value: string; unique?: boolean | undefined }> | undefined; thumbnail_url?: string | undefined; pageScreenShot_url?: string | undefined },
    projectId: number,
    moduleId: number,
    technology: string,
    objectTemplateId: number,
  ): Promise<{ id: number; storedName?: string }> {
    const name = (objectRef.name ?? '').trim();
    const incomingLocators = objectRef.locators ?? [];

    if (name) {
      try {
        const candidates = await this.searchObjects({ query: name, limit: 20 });
        const existing = candidates.find((c) => c.name.trim().toLowerCase() === name.toLowerCase() && reusableFor(technology, c));
        // DESKTOP (plan.md P7): a save never rewrites an object. Older test cases use it, and an update merges into its
        // attributes, keeping their unique flag and AutomationId. A different set gets its own object, below.
        const keepExisting = technology.toUpperCase() === 'DESKTOP' && existing?.id && incomingLocators.length
          && !sameDesktopLocators(existing.locators, incomingLocators);
        if (existing?.id && !keepExisting) {
          const sameLocators = sameLocatorSet(existing.locators, incomingLocators);
          if (!sameLocators && incomingLocators.length) {
            await this.updateObject(existing.id, { locators: incomingLocators });
          }
          return { id: Number.parseInt(existing.id, 10) };
        }
        // DESKTOP: another technology's object holds the name, so the backend stored ours as "<name>_<n>". Reuse that
        // object when it has exactly these locators (the same element, later in this save or in a later save).
        const suffixed = technology.toUpperCase() === 'DESKTOP' && incomingLocators.length
          ? candidates.find((c) => reusableFor(technology, c) && isSuffixedName(c.name, name)
              && sameDesktopLocators(c.locators, incomingLocators))
          : undefined;
        if (suffixed?.id) return { id: Number.parseInt(suffixed.id, 10), storedName: suffixed.name.trim() };
      } catch {
        // Lookup failed — fall through to create rather than block the save over this.
      }
    }

    const attributes = incomingLocators.map((l) => ({
      name: l.name,
      value: l.value,
      ...(l.unique === true ? { unique: true } : {}),
    }));
    const body: Record<string, unknown> = {
      projectId,
      moduleId,
      objecttemplateId: objectTemplateId,
      technology,
      disname: name,
      attributes,
      parameterId: [] as number[],
      description: '',
    };
    // Backend expects raw base64 PNG (no `data:` prefix) and stores it under /download/recording.
    const rawImage = (v?: string) => (v ?? '').replace(/^data:image\/\w+;base64,/i, '').trim();
    const thumb = rawImage(objectRef.thumbnail_url);
    const pageShot = rawImage(objectRef.pageScreenShot_url);
    if (thumb) body['thumbnail_url'] = thumb;
    if (pageShot) body['pageScreenShot_url'] = pageShot;
    const raw = await this.http.postJson<any>('/tm/object/createObjectSeq', body);
    const flat = raw?.data ?? raw;
    const id = str(flat, 'id', '_id', 'objectId');
    if (!id) throw new Error(`createObjectSeq returned no id for object "${name}": ${JSON.stringify(raw)}`);
    // The backend dedups a clashing name by suffixing it ("Sign In button" → "Sign In button_1") and
    // returns the stored `disname`. Surface it so the step can show the name actually in use.
    const storedName = (str(flat, 'disname') ?? '').trim();
    return { id: Number.parseInt(id, 10), ...(storedName && storedName !== name ? { storedName } : {}) };
  }

  /** Rewrite `from` → `to` in a step's description + objectRef.name after the backend renamed its
   *  object. Skips matches already followed by a `_N` suffix so a re-run never double-suffixes. */
  private applyObjectRename(step: Step, from: string, to: string): void {
    if (step.objectRef) step.objectRef.name = to;
    if (!step.description || !from) return;
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    step.description = step.description.replace(new RegExp(`${escaped}(?!_\\d)`, 'i'), to);
  }

  /** For every automation step, resolve `actionId` (from action name + technology) and
   *  `objectId` (via createObjectSeq get-or-create) so the mapper can emit a valid step. Runs
   *  once per save, aligned by step index. */
  private async resolveAutomationSteps(
    projectId: number, moduleId: number, tc: TestCase,
  ): Promise<Array<{ actionId: number | null; objectId: number | null | undefined }>> {
    const catalog = await this.actionCatalog();
    const steps = Array.isArray(tc.steps) ? tc.steps : [];
    // ponytail: objectId can be `undefined` here to mean "don't emit — preserve the backend value".
    // Used when an existing step (sourceId set) has no round-trip objectRef.id, e.g. because it was
    // recorded before objectRequired was flipped on the action. Emitting null would $set-clobber the DB.
    // actionId also nullable for control-flow / function / switch / function_end — those steps don't
    // have an action; buildAutomationPayload omits action/object emit when actionId is null.
    const out: Array<{ actionId: number | null; objectId: number | null | undefined }> = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!;
      // ponytail: control-flow / function / switch / function_end steps have no action to resolve.
      // Push a null-actionId slot so index alignment survives; mapper checks and skips action/object
      // emit for these. Without this, IF/FOR/WHILE/FUNCTION steps throw "missing actionType" on save.
      // Real API REQUEST steps are action-less too: Postman import and the SQA UI both persist them
      // with actionId:null and identify them by stepType:'API' + apiData. Resolving an action name
      // there would fail for a step that legitimately has none (e.g. the recorder's "API Call" is not
      // a backend action name - the seeded one is executeRestAPI).
      // An API-TECHNOLOGY step with a GENERIC action ("Store from JSON", "Get value from JSON", …)
      // is different: it has a real actionId and no request payload, and must be resolved like any
      // other action step so a heal/save cannot turn it into an empty API step.
      if (s.stepType === 'control_flow' || s.stepType === 'function' || s.stepType === 'function_end' || s.stepType === 'switch' || s.stepType === 'manual'
        || isApiRequestStep(s)) {
        // DESKTOP (plan.md P9.4): an IF's condition rows, as the recorder window's Save writes them.
        if (s.stepType === 'control_flow' && s.desktopConditions?.length) {
          s.sourceRaw = {
            ...(s.sourceRaw ?? {}),
            conditions: await buildDesktopConditionRows(s, {
              projectId,
              parameterId: (name, value, type) => this.getOrCreateParameter(projectId, moduleId, name, value, type),
              action: (uid) => catalog.get(`uniq::${uid}`),
              object: async (ref, template) => {
                const r = await this.resolveObjectId(ref, projectId, moduleId, 'DESKTOP', template);
                return { id: r.id, name: r.storedName ?? ref.name };
              },
            }),
          };
        }
        out.push({ actionId: null, objectId: null });
        continue;
      }
      const tech = (TECH_BY_STEPTYPE[s.stepType] ?? deriveTcType(tc)).toUpperCase();
      const name = (s.actionType ?? '').trim();
      if (!name) {
        throw new Error(`Automation step ${i + 1} ("${s.description}"): missing actionType — the neutral Step.actionType must name an SQA action (e.g. "Click", "Type Text", "Launch Application").`);
      }
      // Round-trip support: a TC hydrated via getTestCase carries actionType = String(actionId), so
      // on save we may see a numeric string here. Catalog is dual-keyed: `id::N` for round-trip,
      // `<lowercase name>` for model-authored by-name lookups. Tech is not in the key because
      // action rows have no top-level `technology` field (SQA UI resolves via objectTemplate lookup).
      const isNumericId = /^\d+$/.test(name);
      // A recorder step carries the plugin's uniqueId; prefer it — names are not unique ("executeQuery"
      // is db-2 AND db-3) so by-name can silently save the wrong overload.
      // Scoped to database steps: other technologies keep the existing by-name/by-id resolution untouched.
      let meta = s.stepType === 'database' && s.actionUniqueId ? catalog.get(`uniq::${s.actionUniqueId}`) : undefined;
      // DESKTOP recorder steps carry the plugin's dsk-N uniqueId as well: prefer it the same way.
      if (!meta && s.stepType === 'desktop' && s.actionUniqueId) meta = catalog.get(`uniq::${s.actionUniqueId}`);
      const nameLower = name.toLowerCase();
      const nameCompact = nameLower.replace(/[\s_-]+/g, '');
      const nameKey = actionNameKey(name);
      if (!meta) {
        meta = isNumericId
          ? catalog.get(`id::${Number.parseInt(name, 10)}`)
          : (
              // 1) SAME technology (one object template per technology) — the scoping the UI uses.
              //    Action names are not unique across technologies ("click" exists for WEB + ANDROID).
              catalog.get(`${tech}::${nameLower}`)
              ?? catalog.get(`${tech}::${nameCompact}`)
              ?? catalog.get(`${tech}::dis::${nameLower}`)
              ?? catalog.get(`${tech}::dis::${nameKey}`)
              // 2) Global fallbacks (older catalog builds, unmapped templates).
              ?? catalog.get(nameLower)
              ?? catalog.get(nameCompact)
              ?? catalog.get(`dis::${nameLower}`)
              ?? catalog.get(`dis::${nameKey}`)
            );
      }
      // A hydrated step carries the numeric action id. When that action is DEPRECATED or belongs to a
      // DIFFERENT technology/template than the step, re-resolve the SAME action name inside the step's
      // technology — otherwise the editor renders an empty Action field, the step can lose its object
      // binding, or execution may select the wrong plugin overload.
      const reResolveName = meta?.name;
      const needsReResolve = !!reResolveName && (
        meta?.deprecated === true ||
        (meta?.technology !== undefined && tech !== '' && meta.technology !== tech)
      );
      if (meta && isNumericId && needsReResolve && reResolveName) {
        const lower = reResolveName.toLowerCase();
        const sameTech = catalog.get(`${tech}::${lower}`)
          ?? catalog.get(`${tech}::${lower.replace(/[\s_-]+/g, '')}`)
          ?? catalog.get(`${tech}::dis::${lower}`)
          ?? catalog.get(`${tech}::dis::${actionNameKey(reResolveName)}`);
        if (sameTech) meta = sameTech;
      }
      // Fallback: if the by-id scan misses (action created in a different project and thus not in
      // the UI's projectId-filtered catalog), fetch it directly via GET /tm/action/:id. Only tries
      // for numeric-id lookups — model-authored name lookups have no id to fetch.
      let fallbackDiag = '';
      if (!meta && isNumericId) {
        try {
          const raw = await this.http.getJson<any>(`/tm/action/${Number.parseInt(name, 10)}`);
          const row = raw?.data && typeof raw.data === 'object' ? raw.data
            : Array.isArray(raw?.data) ? raw.data[0]
            : Array.isArray(raw) ? raw[0]
            : raw;
          const idStr = str(row, 'id', '_id', 'actionId');
          // ponytail: no `technology` gate. Catalog builder proved action rows have no top-level
          // technology field (see comment at ~line 2357); requiring it here made the fallback
          // never succeed — every cross-project action id threw "no SQA action named X".
          if (idStr) {
            const otRaw = row?.objectTemplate;
            const objectTemplate = typeof otRaw === 'number' ? otRaw
              : typeof otRaw === 'string' && /^\d+$/.test(otRaw) ? Number.parseInt(otRaw, 10)
              : undefined;
            meta = {
              id: Number.parseInt(idStr, 10),
              objectRequired: row?.objectRequired === true,
              ...(objectTemplate !== undefined ? { objectTemplate } : {}),
            };
          } else {
            fallbackDiag = ` [GET /tm/action/${name} returned no usable row (idStr=null). Raw keys: ${row && typeof row === 'object' ? Object.keys(row).join(',') : typeof row}]`;
          }
        } catch (e) {
          fallbackDiag = ` [GET /tm/action/${name} failed: ${(e as Error).message}]`;
        }
      }
      if (!meta) {
        throw new Error(`Automation step ${i + 1}: no SQA action named "${name}" for technology ${tech}. Catalog size=${catalog.size}, numericId=${isNumericId}. FetchDiag: ${this.actionCatalogFetchDiag}.${fallbackDiag}`);
      }
      let objectId: number | null | undefined = null;
      if (meta.objectRequired) {
        // Resolution ladder (first match wins):
        //   1. objectRef.id set → use directly (round-trip OR LLM referencing a known object)
        //   2. sourceId set but no objectRef.id → preserve DB value (existing step, backend may
        //      have null historically; emitting anything would $set-clobber)
        //   3. objectRef.name only (no locators) → project-scoped name lookup (LLM added a step
        //      referencing an existing Object Repository entry by name — mirrors UI dropdown)
        //   4. objectRef.name + locators → get-or-create via createObjectSeq (recorder path)
        //   5. nothing usable → throw with the three-option error so the caller can pick
        const roundTripId = s.objectRef?.id ? Number.parseInt(String(s.objectRef.id), 10) : NaN;
        // "Use object X" by NAME on an already-saved step: the saved-object rule below (2) would otherwise win and the
        // change would be silently ignored. By name = a name and no locators, and either no id was given or the id is still
        // the saved one while the name is a different one.
        const refName = s.objectRef?.name?.trim();
        const idIsSaved = !Number.isFinite(roundTripId) || String(roundTripId) === s.sourceObjectId;
        const nameDiffers = !!refName && !!s.sourceObjectName && refName.toLowerCase() !== s.sourceObjectName.trim().toLowerCase();
        if (refName && !(s.objectRef?.locators?.length) && s.sourceId && idIsSaved && (!Number.isFinite(roundTripId) || nameDiffers)) {
          const found = await this.findObjectIdByName(projectId, refName);
          if (found == null) {
            throw new Error(`Automation step ${i + 1} ("${name}"): no object named "${refName}" found in this project. Pass objectRef.id, or objectRef.locators to create one.`);
          }
          objectId = found;
        } else if (Number.isFinite(roundTripId)) {
          objectId = roundTripId;
        } else if (s.sourceId) {
          objectId = undefined;
        } else if (s.objectRef?.name && !(s.objectRef.locators?.length)) {
          const found = await this.findObjectIdByName(projectId, s.objectRef.name);
          if (found != null) {
            objectId = found;
          } else {
            throw new Error(`Automation step ${i + 1} ("${name}"): no object named "${s.objectRef.name}" found in this project. Either pass objectRef.id to reuse an existing one, or add objectRef.locators:[{name, value}, ...] to create a new object with that name.`);
          }
        } else if (s.objectRef?.name && s.objectRef.locators?.length) {
          if (meta.objectTemplate == null) {
            throw new Error(`Automation step ${i + 1} ("${name}"): action ${meta.id} has no objectTemplate — cannot create/reuse an object without knowing which template it belongs to.`);
          }
          const resolved = await this.resolveObjectId(s.objectRef, projectId, moduleId, tech, meta.objectTemplate);
          objectId = resolved.id;
          if (resolved.storedName) this.applyObjectRename(s, s.objectRef.name!.trim(), resolved.storedName);
        } else {
          throw new Error(`Automation step ${i + 1} ("${name}"): action requires an object but Step.objectRef is missing. Provide objectRef:{id} to reuse a known one, objectRef:{name} to look one up by name in the project, or objectRef:{name, locators:[{name, value}]} to create a new one.`);
        }
      }
      out.push({ actionId: meta.id, objectId });
    }
    await this.reconcileObjectParams(steps, out);
    return out;
  }

  /** The object's own parameter data: `attrIds` = the `{{id}}` tokens in its attribute values (what the backend writes to a
   *  step's `objectParameterIds`), `parameterId` = the object's parameter list (merged into the step's `parameterIds`).
   *  Null when it cannot be read — callers then change nothing. */
  private async fetchObjectParams(objectId: number): Promise<{ attrIds: number[]; parameterId: number[] } | null> {
    try {
      const raw = await this.http.postJson<any>('/tm/object/search',
        this.searchBody([{ column: 'id', value: objectId }], { selectFields: ['id', 'attributes', 'parameterId'], limit: 1 }));
      const row = pickArray(raw, 'data', 'content', 'objects')[0];
      if (!row) return null;
      const attrIds: number[] = [];
      for (const a of Array.isArray(row.attributes) ? row.attributes : []) {
        if (typeof a?.value !== 'string') continue;
        for (const m of a.value.matchAll(/\{\{(\d+)\}\}/g)) {
          const id = Number.parseInt(m[1]!, 10);
          if (!attrIds.includes(id)) attrIds.push(id);
        }
      }
      const parameterId = (Array.isArray(row.parameterId) ? row.parameterId : [])
        .filter((n: unknown): n is number => typeof n === 'number' && Number.isFinite(n));
      return { attrIds, parameterId };
    } catch {
      return null;
    }
  }

  /** After a step's object was swapped for another, the step's object-derived parameter ids must be the NEW object's:
   *  `objectParameterIds` become the new object's, the new object's parameters are added, and the old object's are dropped
   *  unless the step still uses them (a recorded value). Leaves a step alone when the object did not change or an
   *  object cannot be read — it never makes things worse than before. */
  private async reconcileObjectParams(
    steps: Step[], resolutions: Array<{ actionId: number | null; objectId: number | null | undefined }>,
  ): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!;
      const newId = resolutions[i]?.objectId;
      const oldId = s.sourceObjectId ? Number.parseInt(s.sourceObjectId, 10) : NaN;
      if (typeof newId !== 'number' || !Number.isFinite(oldId) || oldId === newId) continue;
      const [oldObj, newObj] = [await this.fetchObjectParams(oldId), await this.fetchObjectParams(newId)];
      if (!newObj) continue;
      const keep = new Set(newObj.parameterId);
      const rec = { ...(s.sourceRecordedParam ?? {}) };
      const drop = new Set((oldObj?.parameterId ?? []).filter((id) => !keep.has(id) && String(rec[String(id)] ?? '').trim() === ''));
      const ids = (s.sourceParameterIds ?? []).filter((id) => !drop.has(id));
      for (const id of newObj.parameterId) if (!ids.includes(id)) ids.push(id);
      for (const id of drop) delete rec[String(id)];
      s.sourceParameterIds = ids;
      s.sourceObjectParameterIds = newObj.attrIds;
      if (Object.keys(rec).length) s.sourceRecordedParam = rec; else delete s.sourceRecordedParam;
      s.sourceObjectId = String(newId);   // idempotent: a draft saved twice does not re-derive
    }
  }

  /** Case-insensitive project-scoped exact-name lookup. Backend duplicate-name check uses Mongo
   *  collation strength:2, so a case-sensitive search here misses params stored under different
   *  casing — the next POST then trips "Duplicate Name Error". Returns null when not found. */
  private async findParameterId(projectId: number, name: string): Promise<number | null> {
    const body = this.searchBody(
      [
        { column: 'name', value: name },
        { column: 'projectId', value: projectId },
      ],
      { startIndex: 0, limit: 10 },
    );
    // The `searchFields` shape supports `ignorecase:true` per-field; searchBody doesn't emit it,
    // so add it inline for the name column (not index 0 — searchBody puts `deleted` first).
    (body['searchFields'] as any[]).find((f) => f.column === 'name')!['ignorecase'] = true;
    const raw = await this.http.postJson<any>('/tm/parameter/search', body);
    const rows = pickArray(raw, 'data', 'content');
    for (const row of rows) {
      const rowName = str(row, 'name');
      // Case-insensitive: the search above sets ignorecase, and the backend's duplicate-name
      // collation is case-insensitive too — an exact-case compare here misses an existing "host"
      // (vs "Host") and the next POST trips "Duplicate Name Error".
      if (rowName != null && rowName.toLowerCase() === name.toLowerCase()) {
        const id = str(row, 'id', '_id', 'parameterId');
        if (id) return Number.parseInt(id, 10);
      }
    }
    return null;
  }

  /** Case-insensitive project-scoped lookup of an existing object by `disname` (the UI's Name).
   *  Lets tc_draft_update pass `objectRef:{name}` for an already-defined object without also
   *  supplying locators — mirrors what a user picking from the Object Repository dropdown does. */
  private async findObjectIdByName(projectId: number, name: string): Promise<number | null> {
    const body = this.searchBody(
      [
        { column: 'disname', value: name },
        { column: 'projectId', value: projectId },
        { column: 'deleted', value: false },
      ],
      { startIndex: 0, limit: 10 },
    );
    (body['searchFields'] as any[]).find((f) => f.column === 'disname')!['ignorecase'] = true;
    const raw = await this.http.postJson<any>('/tm/object/search', body);
    const rows = pickArray(raw, 'data', 'content', 'objects');
    for (const row of rows) {
      const rowName = str(row, 'disname');
      if (rowName?.toLowerCase() === name.toLowerCase()) {
        const id = str(row, 'id', '_id');
        if (id) return Number.parseInt(id, 10);
      }
    }
    return null;
  }

  private async getOrCreateParameter(projectId: number, moduleId: number, name: string, defaultValue: string,
    accessType: 'Local' | 'Runtime' = 'Local'): Promise<number> {
    const existing = await this.findParameterId(projectId, name);
    if (existing != null) return existing;
    const body: Record<string, unknown> = {
      name,
      projectId,
      protected: looksSensitive(name),
      ...(moduleId > 0 ? { moduleId } : {}),
      defaultValue,
      // Match the SQA UI's Add-Parameter defaults so API-created params render identically. Without
      // these the UI shows "Parameter Type*" empty and refuses to save edits.
      type: accessType,
      parameterType: 'Alphanumeric',
      description: '',
      unique: false,
      concat: '',
      paramAttributes: { minLength: 0, maxLength: 0, prefix: '', suffix: '' },
    };
    let raw: any;
    try {
      raw = await this.http.postJson<any>('/tm/parameter', body);
    } catch (e) {
      // Backend rejects a race-lost duplicate with 500 "Duplicate Name" when the concurrent search
      // missed the just-created row. Recover by re-querying — same name, project-scoped.
      const msg = e instanceof Error ? e.message : String(e);
      if (/Duplicate Name|BADREQUEST/i.test(msg)) {
        const after = await this.findParameterId(projectId, name);
        if (after != null) return after;
      }
      throw e;
    }
    // The id lives at various nesting levels depending on which path the backend took (bare doc,
    // `data`, or `message[0]` for a race-lost duplicate). Try all three.
    let id = str(raw, 'id', '_id', 'parameterId') ?? str(raw?.data, 'id', '_id', 'parameterId');
    if (!id) {
      const m = raw?.message;
      if (Array.isArray(m) && m.length > 0) id = str(m[0], 'id', '_id', 'parameterId');
      else if (m && typeof m === 'object') id = str(m, 'id', '_id', 'parameterId');
    }
    if (!id) throw new Error(`getOrCreateParameter: no id in response: ${JSON.stringify(raw)}`);
    return Number.parseInt(id, 10);
  }

  // ---------------------------------------------------------------------- Suites (write)  [Step 4]

  async createSuite(s: Suite): Promise<SavedRef> {
    const projectId = this.requireProjectId();
    const name = s.name?.trim();
    if (!name) throw new Error('name is required.');
    if (!s.members?.length) throw new Error('At least one test case is required to create a suite.');

    const entries: Record<string, unknown>[] = [];
    const categories = new Set<'MANUAL' | 'AUTOMATION'>();
    for (const m of s.members) {
      const tcNum = numericId(m.tcId);
      const raw = await this.fetchRawTestcase(tcNum);
      if (Object.keys(raw).length === 0) throw new Error(`test case ${m.tcId} not found (cannot add to suite)`);
      categories.add(String(str(raw, 'executionType') ?? '').toUpperCase() === 'MANUAL' ? 'MANUAL' : 'AUTOMATION');
      entries.push(await this.buildSuiteEntryFromTestcase(tcNum));
    }
    if (categories.size > 1) {
      throw new Error(
        'Cannot create suite: the test cases are a mix of MANUAL and AUTOMATION — a suite can only ' +
        'hold ONE category. Split them into two suites, or pick only same-category test cases.',
      );
    }
    const suiteType = [...categories][0] ?? 'AUTOMATION';
    entries.forEach((e, i) => { e['seq'] = i + 1; });

    const payload: Record<string, unknown> = {
      name,
      description: s.description ?? '',
      state: 'New',
      suiteType,
      projectId,
      autoDefectLog: false,
      autoReExecCount: 0,
      newBrowserSession: false,
      terminateOnFailure: false,
      autoReExecTriggerOn: 'AFTER_SUITE',
      minimumContainerCount: null,
      maximumContainerCount: null,
      testCases: entries,
      mailersList: {},
      tags: [],
      customFields: {},
      lastSelectedExecutionType: 'LOCAL',
      tcChanged: true,
    };

    const raw = await this.http.postMultipart<any>('/tm/suites', 'suiteObj', payload);
    const flat = raw?.data ?? raw ?? {};
    const savedId = str(flat, 'id', '_id') ?? '';
    if (!savedId) throw new Error(`Suite create returned no id: ${JSON.stringify(raw)}`);
    return {
      id: savedId,
      created: true,
      productUrl: this.productUrlFor({ kind: 'suite', id: savedId }),
    };
  }

  /** Fetch raw suite, apply add/remove/reorder ops in memory, then PUT the whole doc back with a
   *  STRICT allow-listed payload (the SQA update validator rejects unknown keys on both suite-level
   *  and testCases[] entries). */
  async updateSuiteMembers(id: string, ops: MemberOp[]): Promise<Suite> {
    if (!Array.isArray(ops)) throw new Error('ops must be an array');
    const raw = await this.fetchRawSuite(id);
    if (Object.keys(raw).length === 0) throw new Error(`suite ${id} not found`);

    const currentRows: any[] = Array.isArray(raw['testCases']) ? (raw['testCases'] as any[]) : [];
    const members: Record<string, unknown>[] = currentRows.map(normalizeSuiteEntry);

    for (const op of ops) {
      const tcNum = numericId(String(op.tcId));
      switch (op.op) {
        case 'add': {
          const already = members.some((m) => String(m['testcaseId']) === tcNum);
          if (!already) members.push(await this.buildSuiteEntryFromTestcase(tcNum));
          break;
        }
        case 'remove': {
          for (let i = members.length - 1; i >= 0; i--) {
            if (String(members[i]!['testcaseId']) === tcNum) members.splice(i, 1);
          }
          break;
        }
        case 'reorder': {
          const newOrder = op.order ?? -1;
          const idx = members.findIndex((m) => String(m['testcaseId']) === tcNum);
          if (idx < 0 || newOrder < 1 || newOrder > members.length) break;
          const [moved] = members.splice(idx, 1);
          if (moved) members.splice(newOrder - 1, 0, moved);
          break;
        }
        default: throw new Error(`suite op '${op.op}' not supported (add|remove|reorder)`);
      }
    }

    // Renumber `seq` contiguously from 1 after any mutation.
    members.forEach((m, i) => { m['seq'] = i + 1; });

    const payload: Record<string, unknown> = {};
    for (const k of SUITE_UPDATE_ALLOWED_KEYS) {
      if (raw[k] !== undefined) payload[k] = raw[k];
    }
    payload['tcChanged'] = true;
    payload['testCases'] = members;

    await this.http.putMultipart!<any>(`/tm/suites/${numericId(id)}`, 'suiteObj', payload);
    return this.getSuite(id);
  }

  /** What deleting a suite would hit. SimplifyQA's own dry run (`isDelete:false` — it deletes nothing)
   *  reports schedules and pipelines; its test-plan and workflow checks never match and it never checks
   *  execution plans, so the MCP looks those up itself. No write is made. */
  async suiteDeletePreview(id: string): Promise<{ suite: SuiteRef; blockers: SuiteBlockers }> {
    const raw = await this.readOwnSuite(id);
    const n = Number(raw['id']);
    const projectId = this.requireProjectId();
    const dry = await this.http.patchJson<any>('/tm/suites', { ids: [n], projectId, isDelete: false });
    const row = pickArray(dry, 'data').find((r: any) => Number(r?.id) === n) ?? {};
    const ids = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : []);

    const [schedules, pipelines, executionPlans, testPlans] = await Promise.all([
      this.refsByIds('/sh/scheduler/search', ids(row.schedulerArr)),
      this.refsByIds('/pl/pipelines/search', ids(row.pipelineArr)),
      // Plan entries from this suite (ids stored as numbers): added to the plan directly
      // (sourceType 'suite', sourceId) or through a test plan (subSourceType 'suite', subSourceId).
      Promise.all([
        [{ column: 'sourceType', value: 'suite' }, { column: 'sourceId', value: n }],
        [{ column: 'subSourceType', value: 'suite' }, { column: 'subSourceId', value: n }],
      ].map((by) => this.http.postJson<any>('/tm/execplantestcases/search', this.searchBody(
        [...by, { column: 'projectId', value: projectId }], { selectFields: ['execPlanId'], limit: 1000 },
      )))).then((rs) => this.refsByIds('/tm/executionplan/search',
        ids(rs.flatMap((r) => pickArray(r, 'data')).map((e: any) => e?.execPlanId)))),
      this.http.postJson<any>('/tm/scenario/search', this.searchBody(
        [{ column: 'suiteIds', value: n }, { column: 'projectId', value: projectId }],
        { selectFields: ['id', 'code', 'name'], limit: 100 },
      )).then((r) => pickArray(r, 'data').map(toRef)),
    ]);
    return { suite: toRef(raw), blockers: { schedules, pipelines, executionPlans, testPlans } };
  }

  /** Soft-delete a suite — only when nothing uses it, and proven by re-reading: SimplifyQA answers 200
   *  even when it skipped the suite (`isDelete:true` deletes only unblocked ids). */
  async deleteSuite(id: string): Promise<void> {
    const { suite, blockers } = await this.suiteDeletePreview(id);
    if (Object.values(blockers).some((b) => b.length)) throw new SuiteBlockedError(suite, blockers);
    const projectId = this.requireProjectId();
    await this.http.patchJson<any>('/tm/suites', { ids: [Number(suite.id)], projectId, isDelete: true });
    // A deleted suite's GET answers 404 (NotFoundError) — that is the proof it is gone.
    const after = await this.fetchRawSuite(suite.id).catch((e) => {
      if (e instanceof ApiError && e.status === 404) return {} as Record<string, any>;
      throw new Error(`Could not verify that ${suite.code ?? suite.id} was deleted: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (Object.keys(after).length && after['deleted'] !== true) {
      throw new Error(`SimplifyQA did not delete ${suite.code ?? suite.id} — it is still there. Check what uses it in SimplifyQA.`);
    }
  }

  /** Rename / re-describe a suite: full-document PUT from a fresh read, with its updateVersion. The
   *  members are sent back unchanged and `tcChanged:false`, so test data is not re-saved.
   *  `executionType` is the suite's Execution Type (LOCAL / REMOTE / CLOUD / STACK) and maps to the
   *  backend's `lastSelectedExecutionType` column. */
  async updateSuite(id: string, patch: { name?: string; description?: string; executionType?: string }): Promise<SavedRef> {
    const raw = await this.readOwnSuite(id);
    const payload: Record<string, unknown> = {};
    for (const k of SUITE_UPDATE_ALLOWED_KEYS) if (raw[k] !== undefined) payload[k] = raw[k];
    payload['testCases'] = (Array.isArray(raw['testCases']) ? raw['testCases'] : [])
      .filter((r: any) => r?.deleted !== true).map(normalizeSuiteEntry);
    payload['tcChanged'] = false;
    if (patch.name !== undefined) payload['name'] = patch.name;
    if (patch.description !== undefined) payload['description'] = patch.description;
    if (patch.executionType !== undefined) payload['lastSelectedExecutionType'] = patch.executionType.toUpperCase();
    await this.http.putMultipart!<any>(`/tm/suites/${raw['id']}`, 'suiteObj', payload)
      .catch((e) => this.rethrowWrite(e, raw));
    return { id: String(raw['id']), created: false, productUrl: this.productUrlFor({ kind: 'suite', id: String(raw['id']) }) };
  }

  /** Execution settings via `PUT /tm/suites/settings/:id` — the validator's required fields from a
   *  fresh read, the caller's changes, and updateVersion. Fields not sent stay as they are. */
  async updateSuiteSettings(id: string, settings: SuiteSettings): Promise<SavedRef> {
    const raw = await this.readOwnSuite(id);
    const payload: Record<string, unknown> = {
      id: raw['id'], suiteType: raw['suiteType'], projectId: raw['projectId'],
      autoReExecTriggerOn: raw['autoReExecTriggerOn'], autoReExecCount: raw['autoReExecCount'],
    };
    for (const k of SUITE_SETTING_KEYS) if (settings[k] !== undefined) payload[k] = settings[k];
    if (raw['updateVersion'] !== undefined) payload['updateVersion'] = raw['updateVersion'];
    await this.http.putMultipart!<any>(`/tm/suites/settings/${raw['id']}`, 'suiteObj', payload)
      .catch((e) => this.rethrowWrite(e, raw));
    return { id: String(raw['id']), created: false, productUrl: this.productUrlFor({ kind: 'suite', id: String(raw['id']) }) };
  }

  /** Read the suite's Settings panel: the auto re-execution count / trigger, auto-defect flag and
   *  execution type — exactly what the UI shows, so a value can be CONFIRMED after a write or after a
   *  client restart (settings live in the backend, not in the session). */
  async getSuiteSettings(id: string): Promise<SuiteSettingsView> {
    const raw = await this.readOwnSuite(id);
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : v == null || v === '' ? null : Number(v));
    const executionType = (str(raw, 'lastSelectedExecutionType') ?? str(raw, 'executionType') ?? '').toUpperCase();
    return {
      id: String(raw['id']),
      ...(str(raw, 'code') ? { code: str(raw, 'code')! } : {}),
      ...(str(raw, 'name') ? { name: str(raw, 'name')! } : {}),
      ...(executionType ? { executionType } : {}),
      autoReExecCount: num(raw['autoReExecCount']) ?? 0,
      autoDefectLog: raw['autoDefectLog'] === true,
      ...(str(raw, 'autoReExecTriggerOn') ? { autoReExecTriggerOn: str(raw, 'autoReExecTriggerOn')! } : {}),
      newBrowserSession: raw['newBrowserSession'] === true,
      terminateOnFailure: raw['terminateOnFailure'] === true,
      minimumContainerCount: num(raw['minimumContainerCount']),
      maximumContainerCount: num(raw['maximumContainerCount']),
    };
  }

  // ---------------------------------------------------------------------- Execution plans (write)

  /** `POST /tm/executionplan` with exactly the fields its validator allows (unknown keys are rejected).
   *  The environment is given by name or key and sent as its key; an unknown one is refused. */
  async createExecutionPlan(input: ExecutionPlanInput): Promise<SavedRef & { code?: string }> {
    const projectId = this.requireProjectId();
    const body: Record<string, unknown> = {
      name: input.name, projectId, plannedStartDate: input.plannedStartDate, plannedEndDate: input.plannedEndDate,
      environmentType: await this.environmentKey(input.environment),
    };
    for (const k of EP_OPTIONAL_KEYS) if (input[k] !== undefined) body[k] = input[k];
    let raw: any;
    try {
      raw = await this.http.postJson<any>('/tm/executionplan', body);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 409 || /Duplicate/i.test(e.body))) {
        throw new Error(`An execution plan named "${input.name}" already exists in project ${projectId}.`);
      }
      throw e;
    }
    const flat = raw?.data ?? raw ?? {};
    const id = str(flat, 'id') ?? '';
    if (!id) throw new Error(`Execution plan create returned no id: ${JSON.stringify(raw).slice(0, 200)}`);
    const code = str(flat, 'code');
    return { id, ...(code ? { code } : {}), created: true };
  }

  /** Full update (`PUT /tm/executionplan`) from a fresh read: the stored fields the validator allows,
   *  the caller's changes, and updateVersion. Never the partial `PUT /:id` (no version lock, and its
   *  privilege check is skipped without projectId). Refused while the plan is in review/approval. */
  async updateExecutionPlan(id: string, patch: Partial<ExecutionPlanInput>): Promise<SavedRef> {
    const plan = await this.readOwnPlan(id, { writable: true });
    const body: Record<string, unknown> = {};
    for (const k of EP_UPDATE_KEYS) if (plan[k] !== undefined) body[k] = plan[k];
    const { environment, ...rest } = patch;
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
    if (environment !== undefined) body['environmentType'] = await this.environmentKey(environment);
    await this.http.putJson<any>('/tm/executionplan', body).catch((e) => this.rethrowWrite(e, plan));
    return { id: String(plan['id']), created: false };
  }

  /** What deleting a plan would do — its entry count and any schedule that runs it. No write. */
  async executionPlanDeletePreview(id: string): Promise<{ plan: SuiteRef; entries: number; schedules: SuiteRef[] }> {
    const plan = await this.readOwnPlan(id, { writable: true });
    const projectId = this.requireProjectId();
    const n = Number(plan['id']);
    const [entriesRaw, schedRaw] = await Promise.all([
      this.http.postJson<any>('/tm/execplantestcases/search', this.searchBody(
        [{ column: 'execPlanId', value: n }, { column: 'projectId', value: projectId }], { selectFields: ['id'], limit: 1 },
      )),
      this.http.postJson<any>('/sh/scheduler/search', this.searchBody(
        [{ column: 'schedulerType', value: 'EP' }, { column: 'parentId', value: n }, { column: 'projectId', value: projectId }],
        { selectFields: ['id', 'code', 'name'], limit: 100 },
      )),
    ]);
    const entries = typeof entriesRaw?.totalCount === 'number' ? entriesRaw.totalCount : pickArray(entriesRaw, 'data').length;
    return { plan: toRef(plan), entries, schedules: pickArray(schedRaw, 'data').map(toRef) };
  }

  /** `PATCH /tm/executionplan {ids, projectId}` — only when no schedule runs the plan, then re-read to
   *  prove it is gone. SimplifyQA itself checks nothing before deleting a plan. */
  async deleteExecutionPlan(id: string): Promise<void> {
    const { plan, schedules } = await this.executionPlanDeletePreview(id);
    const label = [plan.code ?? plan.id, plan.name].filter(Boolean).join(' ');
    if (schedules.length) {
      throw new Error(`${label} can't be deleted — schedules use it: ${schedules.map((s) => [s.code ?? `#${s.id}`, s.name].filter(Boolean).join(' ')).join(', ')}.`);
    }
    const projectId = this.requireProjectId();
    await this.http.patchJson<any>('/tm/executionplan', { ids: [Number(plan.id)], projectId });
    const still = await this.http.getJson<any>(`/tm/executionplan/${plan.id}/${projectId}`).then((r) => r?.data, (e) => {
      if (e instanceof ApiError && e.status === 404) return undefined;
      throw new Error(`Could not verify that ${plan.code ?? plan.id} was deleted: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (still) throw new Error(`SimplifyQA did not delete ${plan.code ?? plan.id} — it is still there.`);
  }

  /** Add test cases (or every live test case of a suite) to a plan, built exactly like the SimplifyQA UI's
   *  source browser (source-browser.component.ts buildAddToPlanPayload): a test case is
   *  `sourceType:'testcase', sourceId:0`; a suite's test cases are `sourceType:'suite', sourceId, sourceName`
   *  with the suite row's platform and version. Everything is checked BEFORE anything is posted; a test
   *  case already in the plan for the same assignee is skipped, not duplicated. */
  async addPlanEntries(planId: string, input: PlanEntryInput): Promise<{ added: string[]; skipped: Array<{ code: string; reason: string }> }> {
    const plan = await this.readOwnPlan(planId, { writable: true });
    const projectId = this.requireProjectId();
    let assignee: number | null = null;
    if (input.assignTo !== undefined) {
      if (input.assignTo.trim().toLowerCase() === 'me') {
        const me = Number(await this.ensureUserId());
        if (!Number.isFinite(me)) throw new Error('Could not identify your user to assign the test cases to.');
        assignee = me;
      } else {
        assignee = Number(numericId(input.assignTo));
        if (!Number.isFinite(assignee)) throw new Error(`assignTo "${input.assignTo}" is not a user id.`);
      }
    }

    const candidates: Array<{ raw: any; versionId: string; versionName: string; platform: unknown; source: Record<string, unknown> }> = [];
    for (const tcId of input.tcIds ?? []) {
      const raw = await this.readOwnTestcase(tcId);
      const v = testcaseVersion(raw);
      candidates.push({ raw, ...v, platform: entryPlatform(raw.executionPlatform), source: { sourceType: 'testcase', sourceId: 0 } });
    }
    for (const suiteId of input.suiteIds ?? []) {
      const suite = await this.readOwnSuite(suiteId);
      const rows = (Array.isArray(suite['testCases']) ? suite['testCases'] : []).filter((r: any) => r?.deleted !== true);
      for (const row of rows) {
        const raw = await this.readOwnTestcase(String(row.testcaseId));
        const own = testcaseVersion(raw, /* optional */ true);
        const versionId = str(row, 'versionId') ?? own.versionId;
        if (!versionId) throw new Error(`${str(raw, 'code') ?? `TC-${row.testcaseId}`} has no version to add.`);
        candidates.push({
          raw, versionId, versionName: str(row, 'version') ?? own.versionName,
          platform: entryPlatform(row.executionPlatform) ?? entryPlatform(raw.executionPlatform),
          source: { sourceType: 'suite', sourceId: Number(suite['id']), sourceName: suite['name'] },
        });
      }
    }

    const existing = await this.listPlanEntries(Number(plan['id']));
    let seq = existing.reduce((m: number, e: any) => Math.max(m, Number(e?.seq) || 0), 0);
    const seen = new Set(existing.map((e: any) => `${Number(e?.testcaseId)}|${e?.expAssignedTo ?? null}`));
    const added: string[] = [];
    const skipped: Array<{ code: string; reason: string }> = [];
    const rows: Record<string, unknown>[] = [];
    for (const c of candidates) {
      const code = str(c.raw, 'code') ?? `TC-${c.raw.id}`;
      const key = `${Number(c.raw.id)}|${assignee}`;
      if (seen.has(key)) { skipped.push({ code, reason: 'already in the plan' }); continue; }
      seen.add(key);
      const tcDesc = str(c.raw, 'description');
      rows.push({
        testcaseId: Number(c.raw.id), code, projectId, moduleId: Number(c.raw.moduleId),
        executionType: c.raw.executionType, tcType: c.raw.tcType ?? 'WEB',
        tcVersionId: c.versionId, versionName: c.versionName, tcName: str(c.raw, 'name') ?? code,
        ...(tcDesc ? { tcDesc } : {}),
        execPlanId: Number(plan['id']), executionId: Number(plan['executionId']),
        ...(c.platform ? { executionPlatform: c.platform } : {}),
        status: 'NOTEXECUTED', ...c.source, seq: ++seq,
        ...(assignee !== null ? { expAssignedTo: assignee } : {}),
        ...(input.assignDate ? { expAssignedDate: input.assignDate } : {}),
      });
      added.push(code);
    }
    if (rows.length) await this.http.postJson<any>('/tm/execplantestcases', rows);
    return { added, skipped };
  }

  /** The plan's entries for these test cases — what removing them would delete. No write. */
  async planEntriesRemovePreview(planId: string, tcIds: string[]): Promise<{ plan: SuiteRef; entries: PlanEntryRef[] }> {
    const plan = await this.readOwnPlan(planId, { writable: true });
    const all = await this.listPlanEntries(Number(plan['id']));
    const entries: PlanEntryRef[] = [];
    for (const tcId of tcIds) {
      const n = Number(numericId(tcId));
      const hits = all.filter((e: any) => Number(e?.testcaseId) === n);
      if (!hits.length) throw new Error(`${tcId} is not in ${plan['code'] ?? `PL-${plan['id']}`}.`);
      for (const e of hits) {
        entries.push({
          id: String(e.id), code: str(e, 'code') ?? `TC-${n}`, tcName: str(e, 'tcName') ?? '',
          ...(e.expAssignedTo != null ? { assignedTo: Number(e.expAssignedTo) } : {}),
        });
      }
    }
    return { plan: toRef(plan), entries };
  }

  /** `PATCH /tm/execplantestcases {ids, execPlanId, executionId}` — this also deletes the entries' run
   *  history in SimplifyQA. SimplifyQA swallows its own errors (always 200), so the entries are re-read
   *  afterwards and any still present are reported, never hidden. */
  async removePlanEntries(planId: string, tcIds: string[]): Promise<{ removed: number; notRemoved: string[] }> {
    const { plan, entries } = await this.planEntriesRemovePreview(planId, tcIds);
    const raw = await this.readOwnPlan(planId, { writable: true });
    const ids = entries.map((e) => e.id);
    await this.http.patchJson<any>('/tm/execplantestcases', { ids, execPlanId: Number(plan.id), executionId: Number(raw['executionId']) });
    const still = (await this.listPlanEntries(Number(plan.id))).filter((e: any) => ids.includes(String(e?.id)));
    return { removed: ids.length - still.length, notRemoved: still.map((e: any) => str(e, 'code') ?? `TC-${e.testcaseId}`) };
  }

  /** Run a plan LOCALLY exactly as the SimplifyQA UI does (execute tab + execution-popup-modal 'PLAN'):
   *  find the plan's shell execution, mark it INPROGRESS, then `POST /exec/execution` with a copy of it
   *  (`type:'EXECUTIONPLAN'`, `childExecution`, `parentExecutionId`) whose items are the assigned,
   *  non-blocked AUTOMATION entries matched to the shell's items. Every refusal happens before the
   *  first write. `POST /tm/execplantestcases/execute` (dead code) is never used. */
  async startExecutionPlanRun(planId: string, opts: { agentId?: string }): Promise<PlanRunRef> {
    const plan = await this.readOwnPlan(planId);
    const code = String(plan['code'] ?? `PL-${plan['id']}`);
    const projectId = this.requireProjectId();

    const reasons: Array<{ code: string; reason: string }> = [];
    const runnable: any[] = [];
    for (const e of await this.listPlanEntries(Number(plan['id']))) {
      const c = str(e, 'code') ?? `TC-${e.testcaseId}`;
      if (String(e.executionType ?? '').toUpperCase() !== 'AUTOMATION') reasons.push({ code: c, reason: 'manual' });
      else if (e.expAssignedTo == null) reasons.push({ code: c, reason: 'not assigned' });
      else if (String(e.status ?? '').toUpperCase() === 'BLOCKED') reasons.push({ code: c, reason: 'blocked' });
      else runnable.push(e);
    }
    if (!runnable.length) {
      throw new Error(`${code} has nothing to run: ${reasons.map((r) => `${r.code} (${r.reason})`).join(', ') || 'it has no test cases'}.`);
    }
    const noPlatform = runnable.filter((e) => !PLAN_SPECIAL_TECH.includes(String(e.tcType)) && !e.executionPlatform?.id);
    if (noPlatform.length) throw new Error(`Set an execution platform first for: ${noPlatform.map((e) => str(e, 'code')).join(', ')}.`);

    const probe = await this.probeLocalAgentDetailed();
    if (!probe.up) {
      throw new Error(`Can't run ${code} locally: the SimplifyQA desktop agent at ${probe.url ?? '(no URL)'} is not reachable` +
        `${probe.reason ? ` (${probe.reason})` : ''}. Start it, then try again.`);
    }
    const agentId = await this.resolveLocalAgentId(opts.agentId);

    const shellRaw = await this.http.postJson<any>('/exec/execution/search', {
      searchFields: [
        { column: 'id', sort: 'dsc' }, { column: 'executionTypeId', value: Number(plan['id']) },
        { column: 'projectId', value: projectId }, { column: 'deleted', value: false }, { column: 'id', value: Number(plan['executionId']) },
      ],
      startIndex: 0, limit: 1,
    });
    const shell = pickArray(shellRaw, 'data')[0];
    if (!shell) throw new Error(`${code} has no execution record in SimplifyQA to run from.`);
    const shellItems: any[] = Array.isArray(shell.executionItems) ? shell.executionItems : [];

    const items: any[] = [];
    const started: string[] = [];
    const skipped: Array<{ code: string; reason: string }> = [];
    for (const e of runnable) {
      const item = shellItems.find((it) => it.id == e.testcaseId && it.assignTo == e.expAssignedTo
        && it.versionId == e.tcVersionId && it.stepId == e.stepId);
      const c = str(e, 'code') ?? `TC-${e.testcaseId}`;
      if (!item) { skipped.push({ code: c, reason: "not part of the plan's last execution" }); continue; }
      const tech = String(item.technologyType ?? e.tcType ?? '');
      const p = e.executionPlatform ?? {};
      const platform = PLAN_SPECIAL_TECH.includes(tech)
        ? [{ name: tech, id: tech, technologyType: tech, type: 'NONE' }]
        : [{ name: p.name, id: p.id, technologyType: p.technologyType, type: p.type,
          ...(p.cloudDeviceType ? { cloudDeviceType: p.cloudDeviceType } : {}), ...(p.osVersion ? { osVersion: p.osVersion } : {}) }];
      items.push({ ...item, name: e.tcName, isSelected: true, platform, configuration: {}, startTime: new Date().toISOString() });
      started.push(c);
    }
    if (!items.length) throw new Error(`${code} can't run: none of its test cases are part of the plan's last execution.`);

    const shellCode = String(shell.code ?? `#${shell.id}`);
    await this.http.putJson<any>('/exec/execution/status', { id: Number(shell.id), projectId, status: 'INPROGRESS' });
    const body: Record<string, unknown> = { ...shell };
    for (const k of PLAN_RUN_DROP_KEYS) delete body[k];
    Object.assign(body, {
      type: 'EXECUTIONPLAN', isRecordingEnabled: false, executionOS: this.detectExecutionOS(), status: 'INPROGRESS',
      executionType: 'AUTOMATION', mode: 'LOCAL', executionStyle: 'SERIAL', agentId, cloudType: 'NONE',
      releaseId: plan['releaseId'] ?? null, iterationId: plan['iterationId'] ?? null,
      childExecution: true, parentExecutionId: Number(shell.id),
      globalConfiguration: {
        TERMINATE_ON_FAIL: plan['terminateOnFailure'] ?? false, NEW_BROWSER_SESSION: plan['newBrowserSession'] ?? false,
        RE_EXECUTION_COUNT: plan['autoReExecCount'] ?? 0, RE_EXECUTION_TYPE: plan['autoReExecTriggerOn'] ?? 'AFTER_TESTCASE',
      },
      executionItems: items,
    });
    let created: any;
    try {
      created = await this.http.postJson<any>('/exec/execution', body);
    } catch (e) {
      throw new Error(`Starting ${code} failed after its execution ${shellCode} was marked INPROGRESS in SimplifyQA: ` +
        `${e instanceof Error ? e.message : String(e)}. It may show as in progress until it is reset there.`);
    }
    const runId = str(created?.data ?? created, 'id');
    if (!runId) throw new Error(`Starting ${code}: SimplifyQA returned no execution id (${shellCode} is marked INPROGRESS).`);
    return { runId, started, skipped: [...skipped] };
  }

  /** Every live entry of a plan (the search has no privilege check; scoped to the active project). */
  private async listPlanEntries(planNum: number): Promise<any[]> {
    const projectId = this.requireProjectId();
    const raw = await this.http.postJson<any>('/tm/execplantestcases/search', this.searchBody(
      [{ column: 'execPlanId', value: planNum }, { column: 'projectId', value: projectId }], { limit: 10000 },
    ));
    return pickArray(raw, 'data');
  }

  /** A live test case of the ACTIVE project with what a plan entry requires (module, execution type). */
  private async readOwnTestcase(id: string): Promise<any> {
    const raw = await this.fetchRawTestcase(id);
    if (!raw || !Object.keys(raw).length || raw.deleted === true) throw new Error(`Test case ${id} not found.`);
    const code = str(raw, 'code') ?? `TC-${raw.id}`;
    const projectId = this.requireProjectId();
    if (Number(raw.projectId) !== projectId) throw new Error(`${code} is not in project ${projectId}.`);
    if (raw.moduleId == null || !raw.executionType) throw new Error(`${code} has no module or execution type, so it can't be planned.`);
    return raw;
  }

  /** A live plan of the ACTIVE project (the project-scoped GET returns nothing otherwise). With
   *  `writable`, also refuse a plan the SimplifyQA UI shows read-only (in review / approval). */
  private async readOwnPlan(id: string, opts: { writable?: boolean } = {}): Promise<Record<string, any>> {
    const projectId = this.requireProjectId();
    const n = numericId(id);
    const plan = await this.http.getJson<any>(`/tm/executionplan/${n}/${projectId}`).then((r) => r?.data, () => undefined);
    if (!plan || typeof plan !== 'object') throw new Error(`Execution plan ${id} not found in project ${projectId}.`);
    const status = String(plan['reviewApproveStatus'] ?? '');
    if (opts.writable && EP_READ_ONLY_STATUSES.includes(status)) {
      throw new Error(`${plan['code'] ?? `PL-${plan['id']}`} is ${status} and is read-only in SimplifyQA.`);
    }
    return plan;
  }

  /** Environment name or key → its key, from the project's environment list. Unknown → refused. */
  private async environmentKey(requested: string): Promise<string> {
    const envs = await this.listEnvironments();
    const want = requested.trim().toLowerCase();
    const hit = envs.find((e) => (e.key ?? '').toLowerCase() === want) ?? envs.find((e) => e.name.toLowerCase() === want);
    if (!hit?.key) throw new Error(`Unknown environment "${requested}". Available: ${envs.map((e) => e.name).join(', ')}.`);
    return hit.key;
  }

  /** A live suite of the ACTIVE project, or a clear refusal — checked before every suite write. */
  private async readOwnSuite(id: string): Promise<Record<string, any>> {
    const raw = await this.fetchRawSuite(id);
    if (!Object.keys(raw).length || raw['deleted'] === true) throw new Error(`Suite ${id} not found.`);
    const projectId = this.requireProjectId();
    if (Number(raw['projectId']) !== projectId) {
      throw new Error(`${raw['code'] ?? `Suite ${raw['id']}`} is not in project ${projectId}.`);
    }
    return raw;
  }

  /** `{id, code, name}` for ids on a /search endpoint — best-effort: the ids alone if the lookup fails. */
  private async refsByIds(path: string, ids: number[]): Promise<SuiteRef[]> {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    try {
      const raw = await this.http.postJson<any>(path, this.searchBody(
        [{ column: 'id', value: unique }], { selectFields: ['id', 'code', 'name'], limit: unique.length },
      ));
      const found = pickArray(raw, 'data').map(toRef);
      return unique.map((i) => found.find((r) => r.id === String(i)) ?? { id: String(i) });
    } catch {
      return unique.map((i) => ({ id: String(i) }));
    }
  }

  /** A concurrency conflict becomes a plain instruction — never an automatic retry. */
  private rethrowWrite(e: unknown, raw: Record<string, any>): never {
    if (e instanceof ApiError && /CONCURRENCY/.test(e.body)) {
      throw new Error(`${raw['code'] ?? raw['id']} was changed by someone else — read it again and retry.`);
    }
    throw e;
  }

  // ---------------------------------------------------------------------- Scheduler

  /** A schedule — the scheduler form's body (scheduler-form.component.ts:363-388, +tz on create). TC:
   *  the browser as its platform; SU: one platform per technology in the suite (suitePlatform). An execution
   *  plan is refused: the Scheduler UI offers only test case and suite (its EP option is commented out). */
  async createSchedule(target: RunTarget, opts: ScheduleOptions): Promise<ScheduleRef> {
    const projectId = this.requireProjectId();
    if (target.planId) throw new Error("SimplifyQA's Scheduler only schedules a test case or a suite — run the plan now, or schedule its test cases / a suite instead.");
    if (opts.scheduleType && opts.scheduleType !== 'once' && !realEndDate(opts.endDate)) throw new Error(NEEDS_END_DATE);
    let schedulerType: 'TC' | 'SU';
    let parent: Record<string, any>;
    let platForm: unknown[];
    let parentVersionId: string | undefined;
    if (target.suiteId) {
      schedulerType = 'SU';
      parent = await this.readOwnSuite(target.suiteId);
      platForm = suitePlatform(parent, opts.browser, 'schedule it');
    } else if (target.tcId) {
      schedulerType = 'TC';
      parent = await this.fetchRawTestcase(target.tcId);
      if (!Object.keys(parent).length || parent['deleted'] === true) throw new Error(`Test case ${target.tcId} not found.`);
      if (Number(parent['projectId']) !== projectId) throw new Error(`${parent['code'] ?? `TC-${parent['id']}`} is not in project ${projectId}.`);
      parentVersionId = testcaseVersion(parent, true).versionId || undefined;
      platForm = tcPlatform(parent, opts.browser);
    } else {
      throw new Error('Nothing to schedule: give a test case or a suite.');
    }
    const timeZone = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const rec = sqaRecurrence(opts.scheduleType, opts.scheduledFor, opts.endDate, timeZone);
    const code = String(parent['code'] ?? parent['id']);
    const body: Record<string, unknown> = {
      projectId, name: `${code} schedule`, schedulerType, parentId: Number(parent['id']),
      ...(parentVersionId ? { parentVersionId } : {}),
      platForm,
      environment: opts.environmentId ? await this.environmentKey(opts.environmentId) : 'general',
      releaseId: opts.releaseId ? Number(opts.releaseId) : null,
      iterationId: opts.sprintId ? Number(opts.sprintId) : null,
      recurrenceType: rec.recurrenceType, reccurenceData: rec.reccurenceData,
      scheduleStartDate: opts.scheduledFor, scheduleEndDate: rec.scheduleEndDate,
      executionMode: opts.mode, executionStyle: opts.mode === 'local' ? 'serial' : '',
      agentId: opts.agentId ? [opts.agentId] : [],
      status: 'NOT STARTED', cancelled: false,
      offset: new Date().getTimezoneOffset(), tz: timeZone,
      retryConfig: { retryEnabled: false, retryCount: 1, retryIntervalMinutes: 5 },
    };
    const raw = await this.http.postJson<any>('/sh/scheduler', body);
    const doc = raw?.data ?? raw;
    return {
      id: String(doc?.id ?? ''),
      ...(doc?.status ? { status: String(doc.status) } : {}),
      ...(doc?.nextRecurrenceTime ? { nextRunAt: String(doc.nextRecurrenceTime) } : {}),
    };
  }

  async listSchedules(): Promise<ScheduleInfo[]> {
    const raw = await this.http.postJson<any>('/sh/scheduler/search', this.searchBody(
      [{ column: 'projectId', value: this.requireProjectId() }], { limit: 500, rawOffset: true }));
    return pickArray(raw, 'data', 'content').map((r: any) => ({
      id: String(r.id),
      target: `${r.schedulerType ?? ''} ${r.parentId ?? ''} — ${r.name ?? r.code ?? ''}`.trim(),
      scheduleType: String(r.recurrenceType ?? ''),
      status: String(r.status ?? ''),
      active: r.cancelled !== true,
      ...(r.executionMode ? { executionTarget: String(r.executionMode).toLowerCase() === 'cloud' ? 'cloud_runner' as const : 'local' as const } : {}),
      ...(Array.isArray(r.agentId) && r.agentId.length ? { agent: r.agentId.join(', ') } : {}),
      ...(r.nextRecurrenceTime ? { nextRunAt: String(r.nextRecurrenceTime) } : {}),
      ...(r.scheduleStartDate ? { scheduledFor: String(r.scheduleStartDate) } : {}),
      ...(r.tz ? { timezone: String(r.tz) } : {}),
      ...(typeof r.updateVersion === 'number' ? { updateVersion: r.updateVersion } : {}),
    }));
  }

  /** A live schedule of the ACTIVE project, read fresh. */
  private async readOwnSchedule(id: string): Promise<Record<string, any>> {
    const projectId = this.requireProjectId();
    const raw = await this.http.getJson<any>(`/sh/scheduler/${numericId(id)}`);
    // GET /sh/scheduler/:id answers with a bare array of the matching rows.
    let doc: any = raw?.data ?? raw;
    if (Array.isArray(doc)) doc = doc[0];
    if (!doc || typeof doc !== 'object' || doc.deleted === true || doc.id === undefined) throw new Error(`Schedule ${id} not found.`);
    if (Number(doc.projectId) !== projectId) throw new Error(`${doc.code ?? `Schedule ${doc.id}`} is not in project ${projectId}.`);
    return doc;
  }

  /** Full-document PUT built from the allow-list (never the stored `tz`), with updateVersion. */
  private async putSchedule(doc: Record<string, any>, changes: Record<string, unknown>): Promise<ScheduleRef> {
    const body: Record<string, unknown> = {};
    for (const k of SCHEDULE_UPDATE_KEYS) if (doc[k] !== undefined) body[k] = doc[k];
    const rec: Record<string, unknown> = {};
    for (const k of RECURRENCE_KEYS) {
      rec[k] = doc['reccurenceData']?.[k] ?? (k === 'interval' ? 1 : k === 'daysOfWeek' ? [] : k === 'occurencePosition' ? '' : null);
    }
    body['reccurenceData'] = rec;
    Object.assign(body, changes, { nextRecurrenceTime: null, updateVersion: doc['updateVersion'] ?? 0 });
    const raw = await this.http.putJson<any>(`/sh/scheduler/${doc['id']}`, body).catch((e) => this.rethrowWrite(e, doc));
    const out = raw?.data ?? raw;
    return { id: String(doc['id']), ...(out?.status ? { status: String(out.status) } : {}) };
  }

  async updateSchedule(scheduleId: string, changes: ScheduleUpdate): Promise<ScheduleRef> {
    const doc = await this.readOwnSchedule(scheduleId);
    const patch: Record<string, unknown> = {};
    if (changes.scheduledFor || changes.scheduleType || changes.endDate !== undefined) {
      const start = changes.scheduledFor ?? String(doc['scheduleStartDate']);
      const storedOnce = String(doc['recurrenceType'] ?? 'ONCE').toUpperCase() === 'ONCE';
      if (changes.scheduleType) {
        // A new cadence: rebuilt like a new schedule. Its end date is the one given, or the stored
        // one only when the schedule already recurred (a ONCE schedule's end is just its start).
        const end = realEndDate(changes.endDate) ?? (storedOnce ? undefined : realEndDate(doc['scheduleEndDate']));
        if (changes.scheduleType !== 'once' && !end) throw new Error(NEEDS_END_DATE);
        const rec = sqaRecurrence(changes.scheduleType, start, end, changes.timezone ?? doc['tz'] ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
        Object.assign(patch, {
          scheduleStartDate: start, scheduleEndDate: rec.scheduleEndDate,
          recurrenceType: rec.recurrenceType, reccurenceData: rec.reccurenceData,
        });
      } else {
        // Same cadence: keep its days / day of month, move only the start (and the end if given).
        const rec: Record<string, unknown> = {};
        for (const k of RECURRENCE_KEYS) {
          rec[k] = doc['reccurenceData']?.[k] ?? (k === 'interval' ? 1 : k === 'daysOfWeek' ? [] : k === 'occurencePosition' ? '' : null);
        }
        const end = storedOnce ? null : (realEndDate(changes.endDate) ?? realEndDate(doc['reccurenceData']?.endDate) ?? realEndDate(doc['scheduleEndDate']) ?? null);
        if (!storedOnce && !end) throw new Error(NEEDS_END_DATE);
        Object.assign(patch, {
          scheduleStartDate: start, scheduleEndDate: storedOnce ? start : end,
          reccurenceData: { ...rec, startDate: start, endDate: end },
        });
      }
      // A new start time restarts a cancelled schedule, as the UI's restart does.
      if (changes.scheduledFor && doc['cancelled'] === true) Object.assign(patch, { cancelled: false, status: 'NOT STARTED' });
    }
    if (changes.browser && doc['schedulerType'] === 'TC') {
      const b = sqaBrowser(changes.browser);
      patch['platForm'] = [{ id: b, name: b, type: 'NONE', technologyType: 'WEB' }];
    }
    if (changes.environmentId) patch['environment'] = await this.environmentKey(changes.environmentId);
    if (changes.agentId) patch['agentId'] = [changes.agentId];
    if (changes.mode) patch['executionMode'] = changes.mode;
    return this.putSchedule(doc, patch);
  }

  async controlSchedule(scheduleId: string, action: ScheduleAction): Promise<ScheduleRef> {
    if (action === 'pause') throw new Error('SimplifyQA has no pause — cancel it, or change its next run time.');
    if (action === 'resume') {
      throw new Error('SimplifyQA restarts a schedule from a new start time — give it a new start time with schedule_update.');
    }
    const doc = await this.readOwnSchedule(scheduleId);
    return this.putSchedule(doc, { cancelled: true, status: 'CANCELLED' });
  }

  /** What a delete would remove — no write. */
  async scheduleDeletePreview(scheduleId: string): Promise<{ id: string; code?: string; name?: string; target: string }> {
    const doc = await this.readOwnSchedule(scheduleId);
    return {
      id: String(doc['id']),
      ...(doc['code'] ? { code: String(doc['code']) } : {}),
      ...(doc['name'] ? { name: String(doc['name']) } : {}),
      target: `${doc['schedulerType'] ?? ''} ${doc['parentId'] ?? ''}`.trim(),
    };
  }

  /** `PATCH /sh/scheduler` takes a bare id array. */
  async deleteSchedule(scheduleId: string): Promise<void> {
    const doc = await this.readOwnSchedule(scheduleId);
    await this.http.patchJson<any>('/sh/scheduler', [Number(doc['id'])]);
  }

  // ---------------------------------------------------------------------- Test plans (scenario folders)

  /** A live test-plan folder of the ACTIVE project, read fresh. */
  private async readOwnTestPlan(id: string): Promise<Record<string, any>> {
    const projectId = this.requireProjectId();
    const raw = await this.http.getJson<any>(`/tm/scenario/${numericId(id)}`);
    let doc: any = raw?.data ?? raw;
    if (Array.isArray(doc)) doc = doc[0];
    if (!doc || typeof doc !== 'object' || doc.deleted === true || doc.id === undefined) throw new Error(`Test plan ${id} not found.`);
    if (Number(doc.projectId) !== projectId) throw new Error(`${doc.code ?? `Test plan ${doc.id}`} is not in project ${projectId}.`);
    return doc;
  }

  /** `POST /tm/scenario` — a root folder, or a sub-folder of `parentId` (which must be ours). */
  async createTestPlan(input: { name: string; parentId?: string }): Promise<SavedRef & { code?: string }> {
    const projectId = this.requireProjectId();
    const parent = input.parentId ? await this.readOwnTestPlan(input.parentId) : undefined;
    const body: Record<string, unknown> = {
      name: input.name, projectId, isRoot: !parent, childIds: [],
      ...(parent ? { parentId: Number(parent['id']) } : {}),
    };
    const raw = await this.http.postJson<any>('/tm/scenario', body);
    const doc = raw?.data ?? raw;
    return { id: String(doc?.id ?? ''), created: true, ...(doc?.code ? { code: String(doc.code) } : {}) };
  }

  /** Rename — the PUT always carries `projectId` (without it SimplifyQA upserts an orphan folder). */
  async renameTestPlan(id: string, name: string): Promise<SavedRef> {
    const doc = await this.readOwnTestPlan(id);
    await this.http.putJson<any>(`/tm/scenario/${doc['id']}`, { name, projectId: this.requireProjectId() });
    return { id: String(doc['id']), created: false };
  }

  /** Add suites / test cases. SimplifyQA appends without de-duplicating, so ones already in the folder
   *  are skipped here; nothing new → no write. Each suite / test case must be in the active project. */
  async addToTestPlan(id: string, input: { suiteIds?: string[]; tcIds?: string[] }): Promise<{ added: string[]; skipped: Array<{ code: string; reason: string }> }> {
    const doc = await this.readOwnTestPlan(id);
    const projectId = this.requireProjectId();
    const haveSuites = new Set((Array.isArray(doc['suiteIds']) ? doc['suiteIds'] : []).map(Number));
    const haveTcs = new Set((Array.isArray(doc['testcaseIds']) ? doc['testcaseIds'] : []).map((t: any) => Number(t?.id)));
    const added: string[] = [];
    const skipped: Array<{ code: string; reason: string }> = [];
    const suiteIds: number[] = [];
    for (const s of input.suiteIds ?? []) {
      const suite = await this.readOwnSuite(s);
      const n = Number(suite['id']);
      const code = String(suite['code'] ?? `SU-${n}`);
      if (haveSuites.has(n) || suiteIds.includes(n)) { skipped.push({ code, reason: 'already in the test plan' }); continue; }
      suiteIds.push(n); added.push(code);
    }
    const testcaseIds: Array<{ id: number; version: string; versionId: string }> = [];
    for (const t of input.tcIds ?? []) {
      const raw = await this.fetchRawTestcase(t);
      if (!Object.keys(raw).length || raw.deleted === true) throw new Error(`Test case ${t} not found.`);
      const n = Number(raw.id);
      const code = String(raw.code ?? `TC-${n}`);
      if (Number(raw.projectId) !== projectId) throw new Error(`${code} is not in project ${projectId}.`);
      if (haveTcs.has(n) || testcaseIds.some((x) => x.id === n)) { skipped.push({ code, reason: 'already in the test plan' }); continue; }
      const v = testcaseVersion(raw);
      testcaseIds.push({ id: n, version: v.versionName, versionId: v.versionId }); added.push(code);
    }
    if (suiteIds.length || testcaseIds.length) {
      await this.http.putJson<any>(`/tm/scenario/${doc['id']}`, {
        ...(suiteIds.length ? { suiteIds } : {}), ...(testcaseIds.length ? { testcaseIds } : {}), leafNode: true, projectId,
      });
    }
    return { added, skipped };
  }

  /** `PATCH /tm/scenario/testcase/:id` — removes ONE test case from the folder. The UI sends the
   *  folder's OWN entry (`selectedTc`) as a JSON STRING plus `leafNode`; anything less and SimplifyQA
   *  matches the wrong entry, which is why this used to be refused. The plan is re-read to confirm. */
  async removeTestcaseFromTestPlan(id: string, tcId: string, versionId?: string): Promise<{ removed: string; remaining: number[] }> {
    const doc = await this.readOwnTestPlan(id);
    const projectId = this.requireProjectId();
    const raw = await this.fetchRawTestcase(tcId);
    if (!Object.keys(raw).length || raw.deleted === true) throw new Error(`Test case ${tcId} not found.`);
    const n = Number(raw.id);
    if (Number(raw.projectId) !== projectId) throw new Error(`${raw.code ?? `TC-${n}`} is not in project ${projectId}.`);
    const code = String(raw.code ?? `TC-${n}`);
    const entries = (Array.isArray(doc['testcaseIds']) ? doc['testcaseIds'] : []) as Array<Record<string, any>>;
    const matches = entries.filter((e) => Number(e?.['id']) === n && (!versionId || String(e?.['versionId']) === String(versionId)));
    if (!matches.length) {
      throw new Error(`${code}${versionId ? ` (version ${versionId})` : ''} is not in ${doc['code'] ?? `test plan ${doc['id']}`}.`);
    }
    let left = entries.length - matches.length + (Array.isArray(doc['suiteIds']) ? doc['suiteIds'].length : 0);
    for (const entry of matches) {
      // The UI's exact payload: the folder's own testcase entry, stringified.
      await this.http.patchJson<any>(`/tm/scenario/testcase/${doc['id']}`, {
        selectedTc: JSON.stringify(entry), leafNode: left > 0,
      });
      left -= 1;
    }
    const after = await this.readOwnTestPlan(id);
    const remaining = (Array.isArray(after['testcaseIds']) ? after['testcaseIds'] : [])
      .map((e: any) => Number(e?.['id'])).filter((v: number) => Number.isFinite(v));
    const leftover = remaining.includes(n);
    if (leftover) throw new Error(`SimplifyQA answered OK but ${code} is still in ${after['code'] ?? `test plan ${doc['id']}`} — nothing was removed.`);
    return { removed: code, remaining };
  }

  /** `PATCH /tm/scenario/suite/:id` — removes one suite; it must be in the folder. */
  async removeSuiteFromTestPlan(id: string, suiteId: string): Promise<void> {
    const doc = await this.readOwnTestPlan(id);
    const n = Number(numericId(suiteId));
    const suites = (Array.isArray(doc['suiteIds']) ? doc['suiteIds'] : []).map(Number);
    if (!suites.includes(n)) throw new Error(`SU-${n} is not in ${doc['code'] ?? `test plan ${doc['id']}`}.`);
    const left = suites.length - 1 + (Array.isArray(doc['testcaseIds']) ? doc['testcaseIds'].length : 0);
    await this.http.patchJson<any>(`/tm/scenario/suite/${doc['id']}`, { suiteId: n, leafNode: left > 0 });
  }

  /** Delete preview: the folder and EVERY folder below it (SimplifyQA deletes recursively). No write. */
  async testPlanDeletePreview(id: string): Promise<{ plan: SuiteRef; subFolders: SuiteRef[] }> {
    const doc = await this.readOwnTestPlan(id);
    const raw = await this.http.postJson<any>('/tm/scenario/search', this.searchBody(
      [{ column: 'projectId', value: this.requireProjectId() }], { selectFields: ['id', 'code', 'name', 'childIds', 'parentId'], limit: 10000, rawOffset: true }));
    const all = new Map<number, any>(pickArray(raw, 'data', 'content').map((f: any) => [Number(f.id), f]));
    const out: SuiteRef[] = [];
    const walk = (fid: number, seen: Set<number>) => {
      for (const c of (Array.isArray(all.get(fid)?.childIds) ? all.get(fid).childIds : []).map(Number)) {
        if (seen.has(c) || !all.has(c)) continue;
        seen.add(c); out.push(toRef(all.get(c))); walk(c, seen);
      }
    };
    walk(Number(doc['id']), new Set([Number(doc['id'])]));
    return { plan: toRef(doc), subFolders: out };
  }

  async deleteTestPlan(id: string): Promise<void> {
    const doc = await this.readOwnTestPlan(id);
    await this.http.patchJson<any>(`/tm/scenario/${doc['id']}`, { id: Number(doc['id']) });
    // SimplifyQA answers 200 even when its recursive delete failed — prove it by re-reading.
    const still = await this.http.getJson<any>(`/tm/scenario/${doc['id']}`).then((r) => {
      let d: any = r?.data ?? r;
      if (Array.isArray(d)) d = d[0];
      return d && typeof d === 'object' && d.deleted !== true && d.id !== undefined;
    }, (e) => {
      if (e instanceof ApiError && e.status === 404) return false;
      throw new Error(`Could not verify that ${doc['code'] ?? doc['id']} was deleted: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (still) throw new Error(`SimplifyQA did not delete ${doc['code'] ?? doc['id']} — it is still there.`);
  }

  // ---------------------------------------------------------------------- Pipelines

  /** A live pipeline of the ACTIVE project, read fresh. */
  private async readOwnPipeline(id: string): Promise<Record<string, any>> {
    const projectId = this.requireProjectId();
    const raw = await this.http.getJson<any>(`/pl/pipelines/${numericId(id)}`);
    let doc: any = raw?.data ?? raw;
    if (Array.isArray(doc)) doc = doc[0];
    if (!doc || typeof doc !== 'object' || doc.deleted === true || doc.id === undefined) throw new Error(`Pipeline ${id} not found.`);
    if (Number(doc.projectId) !== projectId) throw new Error(`${doc.code ?? `Pipeline ${doc.id}`} is not in project ${projectId}.`);
    return doc;
  }

  /** `POST /pl/pipelines` with the validator's fields (createPipelinesValidations). Release and sprint
   *  are required by the backend; a suite pipeline gets one platform per technology in the suite (suitePlatform). */
  async createPipeline(input: PipelineInput): Promise<SavedRef & { code?: string }> {
    const projectId = this.requireProjectId();
    if (!input.releaseId || !input.sprintId) throw new Error('A pipeline needs a release and a sprint (releaseId, sprintId).');
    let parentId: number;
    let platForm: unknown[];
    let parentVersion: string | undefined;
    if (input.pipelineType === 'SU') {
      const suite = await this.readOwnSuite(input.parentId);
      parentId = Number(suite['id']);
      platForm = suitePlatform(suite, input.browser, 'create its pipeline');
    } else {
      const tc = await this.fetchRawTestcase(input.parentId);
      if (!Object.keys(tc).length || tc.deleted === true) throw new Error(`Test case ${input.parentId} not found.`);
      if (Number(tc.projectId) !== projectId) throw new Error(`${tc.code ?? `TC-${tc.id}`} is not in project ${projectId}.`);
      parentId = Number(tc.id);
      parentVersion = testcaseVersion(tc, true).versionId || undefined;
      platForm = tcPlatform(tc, input.browser);
    }
    const body: Record<string, unknown> = {
      name: input.name, projectId, pipelineType: input.pipelineType, parentId,
      ...(parentVersion ? { parentVersion } : {}),
      platForm,
      environment: input.environment ? await this.environmentKey(input.environment) : 'general',
      releaseId: Number(input.releaseId), iterationId: Number(input.sprintId),
      executionMode: input.mode, executionStyle: input.mode === 'local' ? 'serial' : '',
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.description ? { description: input.description } : {}),
    };
    const raw = await this.http.postJson<any>('/pl/pipelines', body);
    const doc = raw?.data ?? raw;
    return { id: String(doc?.id ?? ''), created: true, ...(doc?.code ? { code: String(doc.code) } : {}) };
  }

  /** Full-document `PUT /pl/pipelines/:id` built from the allow-list, with updateVersion. */
  async updatePipeline(id: string, patch: PipelineUpdate): Promise<SavedRef> {
    const doc = await this.readOwnPipeline(id);
    const body: Record<string, unknown> = {};
    for (const k of PIPELINE_UPDATE_KEYS) if (doc[k] !== undefined && doc[k] !== null) body[k] = doc[k];
    if (patch.name !== undefined) body['name'] = patch.name;
    if (patch.description !== undefined) body['description'] = patch.description;
    if (patch.releaseId) body['releaseId'] = Number(patch.releaseId);
    if (patch.sprintId) body['iterationId'] = Number(patch.sprintId);
    if (patch.environment) body['environment'] = await this.environmentKey(patch.environment);
    if (patch.agentId) body['agentId'] = patch.agentId;
    if (patch.mode) { body['executionMode'] = patch.mode; body['executionStyle'] = patch.mode === 'local' ? 'serial' : ''; }
    body['updateVersion'] = doc['updateVersion'] ?? 0;
    await this.http.putJson<any>(`/pl/pipelines/${doc['id']}`, body).catch((e) => this.rethrowWrite(e, doc));
    return { id: String(doc['id']), created: false };
  }

  async pipelineDeletePreview(id: string): Promise<SuiteRef> {
    return toRef(await this.readOwnPipeline(id));
  }

  /** `PATCH /pl/pipelines` takes a bare id array (the controller reads `req.body` as the ids). */
  async deletePipeline(id: string): Promise<void> {
    const doc = await this.readOwnPipeline(id);
    await this.http.patchJson<any>('/pl/pipelines', [Number(doc['id'])]);
  }

  /** `POST /pl/exec/start/:id` — never the broken `/pl/pipelines/pipelineExecution/:id`. */
  async startPipeline(id: string): Promise<{ runId: string; code?: string }> {
    const doc = await this.readOwnPipeline(id);
    const raw = await this.http.postJson<any>(`/pl/exec/start/${doc['id']}`, {});
    const run = raw?.data ?? raw;
    const runId = str(run, 'id', 'executionId', '_id');
    if (!runId) throw new Error(`SimplifyQA did not return an execution for ${doc['code'] ?? doc['id']}.`);
    return { runId, ...(str(run, 'code') ? { code: str(run, 'code')! } : {}) };
  }

  /** A SAFE summary of a pipeline execution. The raw record carries the execution's own access token
   *  (`authkey`) and internal fields, so only these named fields are returned — never the raw doc. */
  async getPipelineRun(execId: string): Promise<Record<string, unknown>> {
    const raw = await this.http.getJson<any>(`/pl/exec/status/${this.requireProjectId()}/${numericId(execId)}`);
    const doc: any = raw?.data ?? raw ?? {};
    const pick = (o: any, keys: string[]) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined && o?.[k] !== null && o?.[k] !== '').map((k) => [k, o[k]]));
    return {
      ...pick(doc, ['id', 'code', 'status', 'result', 'mode', 'executionTypeCode', 'executionTypeName', 'createdAt', 'executionTime']),
      ...(Array.isArray(doc.executionItems)
        ? { items: doc.executionItems.map((it: any) => pick(it, ['code', 'name', 'status', 'result'])) }
        : {}),
    };
  }

  async stopPipelineRun(execId: string): Promise<void> {
    await this.http.patchJson<any>(`/pl/exec/stop/${this.requireProjectId()}/${numericId(execId)}`, {});
  }

  private async fetchRawSuite(id: string): Promise<Record<string, any>> {
    const raw = await this.http.getJson<any>(`/tm/suites/${numericId(id)}`);
    let doc: any = raw?.data ?? raw;
    if (Array.isArray(doc)) doc = doc.length > 0 ? doc[0] : {};
    return doc && typeof doc === 'object' ? doc : {};
  }

  /** Mirrors sqa-ui `buildExecutionPlatform` (suites.component.ts:779) so MCP-added TCs save with
   *  the same per-row platform the UI would set — otherwise the suite trips the "select execution
   *  platform" warning at run time. Special types self-identify; WEB falls back to Chrome so
   *  suite_run doesn't send `platform: []`; mobile with no bound device stays empty (UI does same). */
  private buildExecutionPlatformForEntry(raw: Record<string, any>, tcType: string): Record<string, unknown> {
    const special = new Set(['API', 'MAINFRAME', 'SAP', 'DESKTOP', 'DATABASE']);
    if (special.has(tcType)) {
      const p = { id: tcType, name: tcType, technologyType: tcType, type: 'NONE' };
      return { LOCAL: p, REMOTE: { ...p }, CLOUD: { ...p } };
    }
    const own = raw?.['executionPlatform'];
    if (own && typeof own === 'object' && own.id) {
      return { LOCAL: own, REMOTE: {}, CLOUD: {} };
    }
    if (tcType === 'WEB') {
      return { LOCAL: { id: 'CHROME', name: 'Chrome', technologyType: 'WEB', type: 'NONE' }, REMOTE: {}, CLOUD: {} };
    }
    return { LOCAL: {}, REMOTE: {}, CLOUD: {} };
  }

  /** Assemble the strict allow-listed suite entry for an ADD op. Required fields per the SQA
   *  validator: testcaseId, code, seq (set by the caller), version, versionId, tcType. */
  private async buildSuiteEntryFromTestcase(tcNum: string): Promise<Record<string, unknown>> {
    const raw = await this.fetchRawTestcase(tcNum);
    if (Object.keys(raw).length === 0) throw new Error(`test case ${tcNum} not found (cannot add to suite)`);
    const code = str(raw, 'code', 'tcCode') ?? `TC_${tcNum}`;
    const tcType = str(raw, 'tcType') ?? 'WEB';
    let versionName = str(raw, 'versionName', 'selectedVersionName');
    let versionId = str(raw, 'versionId', 'selectedVersionId');
    if ((!versionName || !versionId) && Array.isArray(raw?.versions) && raw.versions.length > 0) {
      const v = raw.versions[0];
      versionName ??= str(v, 'name');
      versionId ??= str(v, 'id', '_id');
    }
    return {
      testcaseId: Number.parseInt(tcNum, 10),
      code,
      tcType,
      ...(raw?.projectId !== undefined ? { projectId: raw.projectId } : {}),
      version: versionName ?? 'v1.0',
      versionId: versionId ?? '',
      executionPlatform: this.buildExecutionPlatformForEntry(raw, tcType),
    };
  }

  // ---------------------------------------------------------------------- Objects (read + delete)
  // list/create/delete now go direct REST (same /tm/object base getObject already uses), mirroring
  // the testcase/suite search + soft-delete convention.

  /** name (UPPERCASE) → objecttemplateId. Rarely changes; cached per adapter instance like
   *  formulaCache. Populated from `POST /tm/objectTemplate/search` (confirmed endpoint,
   *  api-endpoints.ts `object.search`'s sibling `objectTemplate.search`). */
  private objectTemplateCache: Promise<Map<string, number>> | null = null;

  private async objectTemplatesByName(): Promise<Map<string, number>> {
    if (!this.objectTemplateCache) {
      this.objectTemplateCache = (async () => {
        const body = this.searchBody([{ column: 'deleted', value: false }], { limit: 1000 });
        const raw = await this.http.postJson<any>('/tm/objectTemplate/search', body);
        const rows = pickArray(raw, 'data', 'content', 'objectTemplates');
        const map = new Map<string, number>();
        for (const r of rows) {
          const name = str(r, 'name');
          const id = str(r, 'id', '_id');
          if (name && id) map.set(name.toUpperCase(), Number.parseInt(id, 10));
        }
        return map;
      })().catch((e) => {
        this.objectTemplateCache = null; // failure isn't memoised — a retry actually retries
        throw e;
      });
    }
    return this.objectTemplateCache;
  }

  private async resolveObjectTemplateId(technology: string): Promise<number> {
    const map = await this.objectTemplatesByName();
    const id = map.get(technology.toUpperCase());
    if (id == null) {
      throw new Error(
        `Unknown object type/technology "${technology}"` +
          (map.size ? ` — known: ${[...map.keys()].join(', ')}.` : ' — no object templates found in this project.'),
      );
    }
    return id;
  }

  /** template id → TECHNOLOGY (inverse of the name map). Action catalog rows carry only
   *  `objectTemplate`, so this is what scopes an action to its technology — names like "click"
   *  exist for WEB and ANDROID and MUST NOT be treated as interchangeable. Best-effort: a failed
   *  template fetch yields an empty map and the catalog keeps its name-only keys. */
  private async objectTemplateTechById(): Promise<Map<number, string>> {
    try {
      const byName = await this.objectTemplatesByName();
      const inv = new Map<number, string>();
      for (const [name, id] of byName) inv.set(id, name.toUpperCase());
      return inv;
    } catch {
      return new Map();
    }
  }

  /** `POST /tm/object/search` — objects visible in the current project. `q.query` free-text searches
   *  `disname` — the UI's "Name" column (confirmed against the real sqa-ui Object Repository grid;
   *  `description` is a separate, optional field and is NOT what users mean by an object's name). */
  async searchObjects(q: ObjectQuery): Promise<QaObject[]> {
    const projectId = this.requireProjectId();
    const fields: Array<{ column: string; value: any; regEx?: boolean }> = [
      { column: 'deleted', value: false },
      { column: 'projectId', value: projectId },
    ];
    if (q.query) fields.push({ column: 'disname', value: q.query, regEx: true });
    const body = this.searchBody(fields, { startIndex: q.offset ?? 0, limit: q.limit ?? 100 });
    const raw = await this.http.postJson<any>('/tm/object/search', body);
    const rows = pickArray(raw, 'data', 'content', 'objects');
    return rows.map((r) => toObject(r, this.cfg.baseUrl));
  }

  /**
   * Create a new object — `POST /tm/object`, plain JSON (NOT multipart, unlike testcase/suite writes;
   * confirmed against the real sqa-ui ObjectService.saveNewObject). `o.objectType` is REQUIRED: it
   * resolves to the object's `objecttemplateId` — structural, and (per updateObject's contract) not
   * editable after creation. `moduleId` auto-resolves to the project's "Default Module" (matching the
   * real UI's `object.component.ts` `openForm()`, which pre-selects it for every new object) — best
   * effort, never blocks creation if no such module exists or the lookup fails.
   */
  async createObject(o: QaObject): Promise<QaObject> {
    if (!o.objectType) {
      throw new Error(
        'createObject: objectType is required (e.g. "WEB", "ANDROID") — it selects the object template ' +
          'and cannot be changed after the object is created.',
      );
    }

    const wantedName = (o.name ?? '').trim();
    if (wantedName) {
      try {
        const candidates = await this.searchObjects({ query: wantedName, limit: 20 });
        const existing = candidates.find((c) => c.name.trim().toLowerCase() === wantedName.toLowerCase());
        if (existing?.id) {
          const sameLocators = sameLocatorSet(existing.locators, o.locators ?? []);
          return sameLocators || !o.locators?.length
            ? existing
            : await this.updateObject(existing.id, { locators: o.locators });
        }
      } catch {
        // Lookup failed — fall through to create rather than block the save over this.
      }
    }
    const projectId = this.requireProjectId();
    const objecttemplateId = await this.resolveObjectTemplateId(o.objectType);
    const moduleId = await this.resolveDefaultModuleId();
    const body: Record<string, unknown> = {
      disname: o.name,
      objecttemplateId,
      parameterId: [],
      projectId,
      technology: o.objectType,
      ...(moduleId != null ? { moduleId } : {}),
      attributes: o.locators.map((l) => ({ name: l.name, value: l.value, ...(l.unique ? { unique: true } : {}) })),
    };
    const raw = await this.http.postJson<any>('/tm/object', body);
    const doc = (raw?.data && typeof raw.data === 'object' ? raw.data : raw) ?? {};
    return toObject(doc, this.cfg.baseUrl);
  }

  /** The current project's module literally named "Default Module" (case-insensitive) — mirrors the
   *  real sqa-ui `object.component.ts` `openForm()` auto-selection. Best-effort: returns undefined
   *  (never throws) when no such module exists or the lookup fails, so object creation still proceeds
   *  without a module rather than being blocked by this convenience. */
  private async resolveDefaultModuleId(): Promise<number | undefined> {
    try {
      const modules = await this.listModules();
      const found = modules.find((m) => m.name?.toLowerCase() === 'default module');
      return found ? Number.parseInt(found.id, 10) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Soft-delete — `PATCH /tm/object` (NOT POST .../delete like testcase/suite; confirmed against the
   * real sqa-ui ObjectService.deleteObject), body `{ids, projectId, isDelete:true}`.
   *
   * DEPENDENCY-CHECKED first: the SAME route with `isDelete:false` is a DRY RUN that returns, per
   * object, which test cases / functions / workflows still reference it (`tcArr`/`fnArr`/`wfArr`, each
   * keyed by projectId → an array of referencing ids — mirrors the real UI's
   * deleteDependencyForObject flow, object.component.html/.ts). If anything still references it, the
   * delete is refused rather than silently breaking those test cases; only a dependency-free object
   * gets the real `isDelete:true` call.
   */
  /** `PATCH /tm/object` with `isDelete:false` — the SAME dependency-check pre-flight the real
   *  product UI fires before its own delete-confirm modal (object.component.ts onClickTableDelete):
   *  a read-only probe, no restore/undelete side effect. Split out from deleteObject so a caller
   *  (object_delete's preview step) can show this BEFORE asking the user to confirm, not just
   *  discover it as a thrown error after the fact. */
  async checkObjectDependencies(id: string): Promise<{ tcCount: number; fnCount: number; wfCount: number }> {
    const projectId = this.requireProjectId();
    const numId = Number.parseInt(numericId(id), 10);
    const checkRes = await this.http.patchJson<{ data?: Array<{ id?: number; tcArr?: Record<string, unknown[]>; fnArr?: Record<string, unknown[]>; wfArr?: Record<string, unknown[]> }> }>(
      '/tm/object',
      { ids: [numId], projectId, isDelete: false },
    );
    const row = checkRes?.data?.[0];
    const countRefs = (m: Record<string, unknown[]> | undefined): number =>
      m ? Object.values(m).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0) : 0;
    return { tcCount: countRefs(row?.tcArr), fnCount: countRefs(row?.fnArr), wfCount: countRefs(row?.wfArr) };
  }

  async deleteObject(id: string): Promise<void> {
    const projectId = this.requireProjectId();
    const numId = Number.parseInt(numericId(id), 10);
    const { tcCount, fnCount, wfCount } = await this.checkObjectDependencies(id);
    if (tcCount || fnCount || wfCount) {
      const parts: string[] = [];
      if (tcCount) parts.push(`${tcCount} test case${tcCount === 1 ? '' : 's'}`);
      if (fnCount) parts.push(`${fnCount} function${fnCount === 1 ? '' : 's'}`);
      if (wfCount) parts.push(`${wfCount} workflow${wfCount === 1 ? '' : 's'}`);
      throw new Error(
        `Cannot delete object ${id} — still used by ${parts.join(', ')}. Remove those references first ` +
          '(or review/delete them in the SimplifyQA UI, which shows exactly which ones).',
      );
    }

    await this.http.patchJson<any>('/tm/object', { ids: [numId], projectId, isDelete: true });
  }

  /**
   * Update an object — `PUT /tm/object/:id`, plain JSON (NOT multipart, unlike testcase/suite writes;
   * confirmed against the real sqa-ui ObjectService.update). The backend expects the FULL document
   * back, so this reads the current one first and echoes every field it doesn't touch
   * (disname/description/objecttemplateId/parameterId/moduleId/technology/updateVersion — the
   * optimistic-concurrency token the real form also round-trips).
   *
   * `changes.locators` UPSERTS by locator name into the existing attribute list — an entry with a
   * matching name gets its value/unique updated in place, everything else on the object is left alone,
   * and a name with no existing match is appended as a new locator.
   *
   * `technology` (object type) and `objecttemplateId` are DELIBERATELY never taken from `changes` —
   * they are always echoed back from the existing doc. Both are structural (they determine which
   * attribute set is even valid for this object), so editing them here — outside the create flow — is
   * out of scope; changing them means creating a new object, not "updating" this one.
   */
  /** Edit a project-level parameter (Local <-> Runtime, default value, description). The backend validates the WHOLE body and
   *  reads `paramAttributes.*` unconditionally, so this sends the complete current definition with the change applied - then
   *  re-reads it and throws if the change did not take (the rule for every edit here: never report an edit that did not land). */
  async updateParameter(ref: string, changes: { type?: 'Local' | 'Runtime'; defaultValue?: string; description?: string }): Promise<{
    id: string; name: string; type: string; defaultValue: string; changed: string[];
  }> {
    const projectId = this.requireProjectId();
    const refText = String(ref ?? '').trim();
    const id = /^\d+$/.test(refText) ? Number.parseInt(refText, 10) : await this.findParameterId(projectId, refText);
    if (id == null) throw new Error(`Parameter "${ref}" was not found in this project. Check the exact name (or pass its id).`);
    const read = async (): Promise<any> => {
      const raw = await this.http.getJson<any>(`/tm/parameter/${id}`);
      const row = raw?.data ?? raw;
      return Array.isArray(row) ? row[0] : row;
    };
    const cur = await read();
    if (!cur || typeof cur !== 'object') throw new Error(`Parameter ${id} could not be read.`);
    const curType = String(cur.type ?? '');
    if (curType === 'Global' || (changes.type as string | undefined) === 'Global') {
      throw new Error(`Parameter "${cur.name}" is ${curType === 'Global' ? 'Global' : 'being changed to Global'} - Global parameters hold an encrypted shared value and are not edited here. Change it in the UI.`);
    }
    if (changes.type === undefined && changes.defaultValue === undefined && changes.description === undefined) {
      throw new Error('Nothing to change - pass type, defaultValue and/or description.');
    }
    const next = {
      type: changes.type ?? curType,
      defaultValue: changes.defaultValue ?? String(cur.defaultValue ?? ''),
      description: changes.description ?? String(cur.description ?? ''),
    };
    const body: Record<string, unknown> = {
      name: cur.name,
      projectId,
      ...(typeof cur.moduleId === 'number' ? { moduleId: cur.moduleId } : {}),
      description: next.description,
      parameterType: cur.parameterType ?? 'Alphanumeric',
      defaultValue: next.defaultValue,
      paramAttributes: cur.paramAttributes && typeof cur.paramAttributes === 'object'
        ? cur.paramAttributes : { minLength: 0, maxLength: 0, prefix: '', suffix: '' },
      protected: cur.protected === true,
      type: next.type,
      unique: cur.unique === true,
      concat: String(cur.concat ?? ''),
      ...(typeof cur.updateVersion === 'number' ? { updateVersion: cur.updateVersion } : {}),
    };
    await this.http.putJson<any>(`/tm/parameter/${id}`, body);
    const after = await read();
    const changed: string[] = [];
    if (changes.type !== undefined) {
      if (String(after?.type) !== changes.type) throw new Error(`Parameter "${cur.name}" is still ${String(after?.type)} after the update - the change did not take.`);
      if (curType !== changes.type) changed.push(`type ${curType} -> ${changes.type}`);
    }
    if (changes.defaultValue !== undefined) {
      if (String(after?.defaultValue ?? '') !== changes.defaultValue) throw new Error(`Parameter "${cur.name}" default value did not change after the update.`);
      changed.push('defaultValue');
    }
    if (changes.description !== undefined) {
      if (String(after?.description ?? '') !== changes.description) throw new Error(`Parameter "${cur.name}" description did not change after the update.`);
      changed.push('description');
    }
    return { id: String(id), name: String(cur.name), type: String(after?.type ?? next.type), defaultValue: String(after?.defaultValue ?? next.defaultValue), changed };
  }

  async updateObject(id: string, changes: {
    name?: string;
    locators?: Locator[];
    description?: string;
    /** Replace the object's bound parameters by NAME (resolved via /tm/parameter/search, same
     *  lookup findParameterId uses for TC steps). Unresolved names throw naming all of them and
     *  the valid options, rather than silently saving a partial/empty list. */
    parameterNames?: string[];
    /** Resolve to moduleId via listModules — the caller supplies a name, never an id. */
    moduleName?: string;
    /** NAME of the locator to make the object's DEFAULT — one in `locators` or one already on the object, so an
     *  existing locator can be made the default without resending its value. Throws when no locator has the name. */
    defaultLocator?: string;
  }, opts?: { enrichNames?: boolean }): Promise<QaObject> {
    const numId = numericId(id);
    const raw = await this.http.getJson<any>(`/tm/object/${numId}`);
    const doc = (raw?.data && typeof raw.data === 'object' ? raw.data : raw) ?? {};
    if (!doc || typeof doc !== 'object' || Object.keys(doc).length === 0) {
      throw new Error(`object ${id} not found`);
    }
    const attributes: Array<{ name: string; value: string; unique?: boolean }> = Array.isArray(doc.attributes)
      ? doc.attributes.map((a: any) => ({
          name: String(a?.name ?? ''),
          value: String(a?.value ?? ''),
          ...(a?.unique === true ? { unique: true } : {}),
        }))
      : [];
    for (const loc of changes.locators ?? []) {
      const idx = attributes.findIndex((a) => a.name === loc.name);
      const merged = { name: loc.name, value: loc.value, ...(loc.unique !== undefined ? { unique: loc.unique } : {}) };
      if (idx >= 0) attributes[idx] = { ...attributes[idx], ...merged };
      else attributes.push(merged);
    }
    // The UI treats `unique` (the default locator) as exclusive — setting one clears it on the rest.
    const defaultLoc = (changes.locators ?? []).filter((l) => l.unique === true).pop();
    if (defaultLoc) {
      for (const a of attributes) {
        if (a.name !== defaultLoc.name && a.unique) delete a.unique;
      }
    }
    // `defaultLocator` names the default outright (wins over a `unique` flag in `locators`).
    const wantedDefault = changes.defaultLocator?.trim();
    if (wantedDefault) {
      const target = attributes.find((a) => a.name === wantedDefault)
        ?? attributes.find((a) => a.name.toLowerCase() === wantedDefault.toLowerCase());
      if (!target) {
        throw new Error(
          `Cannot make "${wantedDefault}" the default of object ${id}: it has no locator with that name. ` +
          `Its locators: ${attributes.map((a) => a.name).join(', ') || '(none)'} — add it in \`locators\` first or pass one of these.`,
        );
      }
      for (const a of attributes) {
        if (a === target) a.unique = true;
        else delete a.unique;
      }
    }

    let moduleId = doc.moduleId;
    if (changes.moduleName !== undefined) {
      const modules = await this.listModules();
      const wanted = changes.moduleName.trim().toLowerCase();
      const match = modules.find((m) => m.name.toLowerCase() === wanted);
      if (!match) {
        const options = modules.map((m) => m.name).join(', ') || '(no modules configured in this project)';
        throw new Error(`Module "${changes.moduleName}" not found on object ${id}. Valid modules: ${options}`);
      }
      moduleId = Number.parseInt(match.id, 10);
    }

    let parameterId: unknown = doc.parameterId ?? [];
    if (changes.parameterNames !== undefined) {
      const projectId = this.requireProjectId();
      const resolved: number[] = [];
      const unresolved: string[] = [];
      for (const name of changes.parameterNames) {
        const pid = await this.findParameterId(projectId, name);
        if (pid != null) resolved.push(pid);
        else unresolved.push(name);
      }
      if (unresolved.length) {
        throw new Error(
          `Parameter(s) not found on object ${id}: ${unresolved.join(', ')}. Check the exact name ` +
            '(case-insensitive), or create the parameter first in the Parameters screen.',
        );
      }
      parameterId = resolved;
    }

    // The object's recorder screenshots live on the SAME document as its locators, and PUT replaces
    // the whole object (the real UI sends both on every save). Omitting them here erased every
    // thumbnail/page screenshot the user had attached as soon as a locator was edited.
    const imageField = (v: unknown): unknown | undefined => {
      if (v === null || v === undefined) return undefined;
      if (typeof v === 'object') return Object.keys(v as Record<string, unknown>).length ? v : undefined;
      return String(v).trim() ? v : undefined;
    };
    const thumbnailUrl = imageField(doc['thumbnail_url']);
    const pageScreenShotUrl = imageField(doc['pageScreenShot_url']);

    const body: Record<string, unknown> = {
      disname: changes.name ?? doc.disname,
      description: changes.description !== undefined ? changes.description : doc.description,
      objecttemplateId: doc.objecttemplateId,
      parameterId,
      moduleId,
      technology: doc.technology,
      attributes,
      ...(thumbnailUrl !== undefined ? { thumbnail_url: thumbnailUrl } : {}),
      ...(pageScreenShotUrl !== undefined ? { pageScreenShot_url: pageScreenShotUrl } : {}),
      projectId: this.requireProjectId(),
      updateVersion: doc.updateVersion ?? 0,
    };
    const res = await this.http.putJson<any>(`/tm/object/${numId}`, body);
    const updated = (res?.data && typeof res.data === 'object' ? res.data : res) ?? doc;
    const obj = toObject(updated, this.cfg.baseUrl);
    if (opts?.enrichNames) await this.enrichObjectNames(obj);
    return obj;
  }

  // ---------------------------------------------------------------------- Actions catalog
  async actionsCatalog(platform?: string): Promise<ActionDef[]> {
    // Build from the live backend catalog (already cached per-connection). Each entry gets its
    // numeric id + objectRequired flag so callers can round-trip actionType ↔ actionId. Ignores
    // `platform` — action rows carry no top-level technology; tech disambiguation is a follow-up
    // (would need an object_templates lookup). Skips the `id::N` reverse-lookup keys.
    void platform;
    const catalog = await this.actionCatalog();
    const defs: ActionDef[] = [];
    for (const [key, meta] of catalog) {
      // Skip EVERY synthetic lookup key. The catalog is dual-keyed for resolution: `id::N`,
      // `uniq::web-1`, `dis::go to url`, and — when the row carries an objectTemplate —
      // `WEB::click` / `WEB::dis::click`. All are aliases of the real name entry. Filtering only the
      // first three leaked the technology-scoped ones, so every action with a template appeared two
      // or three times with machine strings the model cannot round-trip as a step actionType.
      if (key.includes('::')) continue;
      defs.push({
        actionType: key,
        platform: 'unknown',
        id: meta.id,
        objectRequired: meta.objectRequired,
        ...(meta.displayName ? { description: meta.displayName } : {}),
      });
    }
    return defs;
  }

  // ---------------------------------------------------------------------- Testdata generation  [Step 3]

  /** Fetch the default (template) iteration row for a TC. Fills gaps from the raw TC:
   *   - versionId: falls back through versionId → selectedVersionId → versionsDetails.id → versions[0].id
   *   - executionType (required by the backend Mongo filter): read from raw TC, default AUTOMATION
   *   - environmentType: caller value wins; else /pm/fields/8 first configured env; else 'general' */
  async getDefaultIteration(q: {
    tcId: string;
    versionId?: string;
    environmentType?: string;
    includeProtected?: boolean;
    entityType?: 'TC' | 'FN' | undefined;
  }): Promise<DefaultIteration> {
    const projectId = this.requireProjectId();
    const isFn = q.entityType === 'FN';
    const tcNum = numericId(q.tcId);
    let versionId = q.versionId;
    let execType: string | undefined;
    if (isFn) {
      // Function testdata is keyed by the function id + one of ITS versions (same getDefaultItr
      // endpoint with collection=FUNCTION — what the UI's function-step-card sends).
      const rawFn = await this.http.getJson<any>(`/tm/function/${tcNum}/${projectId}`);
      let fnDoc: any = rawFn?.data ?? rawFn;
      if (Array.isArray(fnDoc)) fnDoc = fnDoc.length > 0 ? fnDoc[0] : {};
      execType = str(fnDoc, 'executionType');
      if (!versionId) {
        const rows = await this.fetchFunctionVersionRows(tcNum);
        versionId = rows.length ? str(rows[0], 'id', '_id', 'versionId') : undefined;
      }
      if (!versionId) throw new Error(`function ${q.tcId} has no versionId — pass one explicitly`);
    } else if (!versionId || !execType) {
      const raw = await this.fetchRawTestcase(q.tcId);
      if (!versionId) {
        versionId = str(raw, 'versionId', 'selectedVersionId', 'selVersion');
        if (!versionId && raw?.versionsDetails && typeof raw.versionsDetails === 'object') {
          versionId = str(raw.versionsDetails, 'id', '_id', 'versionId');
        }
        if (!versionId && Array.isArray(raw?.versions) && raw.versions.length > 0) {
          versionId = str(raw.versions[0], 'id', '_id');
        }
      }
      execType = str(raw, 'executionType');
      if (!versionId) throw new Error(`test case ${q.tcId} has no versionId — pass one explicitly`);
    }
    if (!execType) execType = 'AUTOMATION';
    const env = await this.resolveEnvironment(projectId, q.environmentType);

    const path =
      '/tm/testdata/getDefaultItr' +
      `?projectId=${projectId}` +
      `&testcaseId=${tcNum}` +
      `&versionId=${encodeURIComponent(versionId!)}` +
      `&environmentType=${encodeURIComponent(env)}` +
      `&collection=${isFn ? 'FUNCTION' : 'TC'}` +
      `&executionType=${encodeURIComponent(execType)}`;
    const raw = await this.http.getJson<any>(path);
    const paramsMap = raw?.data?.parametersData;
    const parameters: Array<{ paramId: number; name: string; seed: string; protected?: boolean }> = [];
    if (paramsMap && typeof paramsMap === 'object' && !Array.isArray(paramsMap)) {
      for (const [key, value] of Object.entries(paramsMap)) {
        const pid = Number.parseInt(key, 10);
        if (!Number.isFinite(pid)) continue;
        // Protected params get masked below — never assign this raw value to `seed` unmasked.
        const rawValue = String((value as any)?.value ?? '');
        const meta = await this.fetchParameterMeta(pid);
        if (!meta) continue; // parameter deleted — skip
        const isProtected = meta.protected || looksSensitive(meta.name);
        // includeProtected is INTERNAL (copyTestdata): the real value never leaves the adapter on the
        // model-facing path (tc_get_testdata), which leaves it off.
        const seed = isProtected && !q.includeProtected
          ? (rawValue ? '*****' : '(empty)')
          : rawValue;
        parameters.push({ paramId: pid, name: meta.name, seed, ...(isProtected ? { protected: true } : {}) });
      }
    }
    return { tcId: q.tcId, versionId: versionId!, environmentType: env, parameters };
  }

  /** Persist N generated iteration rows. Rebuilds the name → paramId map from a fresh template
   *  fetch — no cache, because a stale id would silently write to the wrong parameter. */
  async saveGeneratedIterations(payload: SaveGeneratedIterations): Promise<SaveGeneratedIterationsResult> {
    if (!payload.rows || payload.rows.length === 0) throw new Error('rows[] required and non-empty');
    if (!payload.versionId) throw new Error('versionId required — call get_default_iteration first');
    const projectId = this.requireProjectId();
    const tcNum = numericId(payload.tcId);
    const env = payload.environmentType || 'general';

    // Reuse the caller's already-fetched template when supplied — the tc_generate_testdata tool
    // fetches it just before calling us. Skipping the re-fetch avoids a duplicate /getDefaultItr +
    // N /tm/parameter/{id} round trips per save.
    const tplParams = payload.parameters ?? (await this.getDefaultIteration({
      tcId: payload.tcId,
      versionId: payload.versionId,
      environmentType: env,
      entityType: payload.entityType,
    })).parameters;
    const nameToId = new Map<string, number>();
    for (const p of tplParams) {
      nameToId.set(p.name, p.paramId);
      // Parameter names are project-wide and matched CASE-INSENSITIVELY by the backend (an existing
      // "username" is reused for "${Username}"), so the stored spelling often differs from the one a
      // caller sends — a spreadsheet column "Username" is the same parameter as "username". Exact
      // match first, then the folded key.
      nameToId.set(p.name.trim().toLowerCase(), p.paramId);
    }
    const paramIdFor = (name: string): number | undefined =>
      nameToId.get(name) ?? nameToId.get(name.trim().toLowerCase());

    const formulas = payload.formulas ?? {};
    const formulaNames = Object.keys(formulas);

    // Per row: evaluate the row's formula columns. Many formulas mint RANDOM values, so each call must still
    // happen (no dedup across rows). The calls are issued together but evaluateFormula runs them through the
    // agent one at a time (its formula engine is not safe to call concurrently).
    const technologyType = formulaNames.length ? await this.formulaTechnology(payload.tcId) : undefined;
    const iterations: Array<{ isChecked: true; data: Array<{ paramId: number; value: string; formulaValue?: string }> }> = [];
    for (const row of payload.rows) {
      const data: Array<{ paramId: number; value: string; formulaValue?: string }> = [];
      for (const [k, v] of Object.entries(row)) {
        if (formulaNames.includes(k)) continue; // a formula covers this column — its value wins
        const pid = paramIdFor(k);
        if (pid == null) continue; // unknown param name — silently skip
        data.push({ paramId: pid, value: String(v ?? '') });
      }
      const evaluated = await Promise.all(
        formulaNames.map(async (name) => {
          const pid = paramIdFor(name);
          if (pid == null) return null;
          const { value, expression } = await this.evaluateFormula(formulas[name]!, technologyType ? { technologyType } : undefined);
          return { paramId: pid, value, formulaValue: expression };
        }),
      );
      for (const cell of evaluated) if (cell) data.push(cell);
      iterations.push({ isChecked: true, data });
    }

    const body = {
      projectId,
      data: [
        {
          type: payload.entityType === 'FN' ? 'FN' : 'TC',
          id: Number.parseInt(tcNum, 10),
          versionId: payload.versionId,
          environmentType: env,
          projectId,
          iterations,
        },
      ],
    };
    await this.http.postJson<any>('/tm/testdata/saveItrForDataGen', body);
    return { tcId: payload.tcId, inserted: iterations.length };
  }

  // ---------------------------------------------------------------- testdata at TC / SUITE level

  /** The backend `testdata` definition row for a TC / FUNCTION / SUITE (the row that owns iterations). */
  private async testdataDefinitionRow(entityType: 'TC' | 'FN' | 'SU', id: string): Promise<Record<string, any>> {
    const projectId = this.requireProjectId();
    const numId = Number.parseInt(numericId(id), 10);
    if (!Number.isFinite(numId)) throw new Error(`"${id}" is not a valid ${entityType} id.`);
    const column = entityType === 'TC' ? 'testcaseId' : entityType === 'FN' ? 'functionId' : 'suiteId';
    const raw = await this.http.postJson<any>('/tm/testdata/searchTd', {
      searchFields: [
        { column: 'deleted', value: false, regEx: false },
        { column: 'projectId', value: projectId },
        { column: 'type', value: entityType, regEx: false },
        { column, value: numId, regEx: false },
      ],
      startIndex: 0,
      limit: 20,
    });
    const rows = pickArray(raw, 'data', 'content');
    const row = rows.find((r: any) => String(r?.type ?? '').toUpperCase() === entityType) ?? rows[0];
    if (!row?.id) {
      throw new Error(
        `No ${entityType === 'SU' ? 'suite-level' : entityType === 'FN' ? 'function' : 'test-case'} testdata exists for ` +
        `${entityType === 'SU' ? 'suite' : entityType === 'FN' ? 'function' : 'test case'} ${id} in this project ` +
        `(looked up ${column}=${numId}).`,
      );
    }
    // The iteration endpoints validate `id` as a STRING — the search can return a number. Re-fetch
    // the row by id to pick up fields the list projection omits (notably `updateVersion`, which the
    // update endpoint uses for optimistic concurrency).
    let full: Record<string, any> = {};
    try {
      const one = await this.http.postJson<any>('/tm/testdata/searchTd', {
        searchFields: [{ column: 'id', value: String(row.id), regEx: false }],
        startIndex: 0,
        limit: 1,
      });
      full = pickArray(one, 'data', 'content')[0] ?? {};
    } catch { /* list row is enough if this fails */ }
    return { ...row, ...full, id: String(row.id) };
  }

  private async testdataIterationRows(
    td: Record<string, any>, entityType: 'TC' | 'FN' | 'SU', entityId: string, environmentType: string,
  ): Promise<any[]> {
    const projectId = this.requireProjectId();
    const env = await this.resolveEnvironment(projectId, environmentType);
    const column = entityType === 'TC' ? 'testcaseId' : entityType === 'FN' ? 'functionId' : 'suiteId';
    const numId = Number.parseInt(numericId(entityId), 10);
    const searchFields: Array<Record<string, unknown>> = [
      { column, value: numId, regEx: false },
      { column: 'environmentType', value: env, regEx: false },
      { column: 'deleted', value: false, regEx: false },
    ];
    const versionId = str(td, 'versionId');
    if (versionId) searchFields.push({ column: 'versionId', value: versionId, regEx: false });
    // Primary: the iteration collection itself (the same read `heal` uses). This returns every row
    // for the entity/env regardless of the testdata-definition drill-in shape.
    try {
      const raw = await this.http.postJson<any>('/tm/testdata/searchItr', {
        searchFields, startIndex: 0, limit: 1000,
      });
      const rows = pickArray(raw, 'data', 'content', 'iterations');
      if (rows.length) return rows;
    } catch { /* fall through to getIteration */ }
    // Fallback: the drill-in endpoint — `id` = the testdata definition row (string) is the accepted
    // top-level shape on some builds; `parentId` on others.
    const base = {
      environmentType: env,
      projectId: td['projectId'] ?? projectId,
      type: String(td['type'] ?? '').toUpperCase(),
      executionType: td['executionType'],
    };
    const bodies: Array<Record<string, unknown>> = [
      { ...base, id: String(td['id']) },
      { ...base, parentId: String(td['id']) },
      { ...base, id: String(td['id']), parentId: String(td['id']) },
    ];
    for (const body of bodies) {
      try {
        const raw = await this.http.postJson<any>('/tm/testdata/getIteration', body);
        const rows = pickArray(raw, 'data', 'content');
        if (rows.length) return rows;
      } catch { /* try the next accepted shape */ }
    }
    return [];
  }

  private async testdataRowsFor(
    td: Record<string, any>, entityType: 'TC' | 'FN' | 'SU', id: string, environmentType: string,
  ): Promise<TestdataRows> {
    const projectId = this.requireProjectId();
    const env = await this.resolveEnvironment(projectId, environmentType);
    const rawRows = await this.testdataIterationRows(td, entityType, id, env);
    const iterations: TestdataIterationRow[] = rawRows.map((r: any) => ({
      ...r,
      id: String(r?.id ?? ''),
      name: String(r?.name ?? ''),
      ...(Array.isArray(r?.data) ? { data: r.data } : { data: [] }),
    }));
    const paramIds = new Set<number>();
    for (const it of iterations) {
      for (const c of it.data) {
        const pid = Number(c?.paramId);
        if (Number.isFinite(pid)) paramIds.add(pid);
      }
    }
    const names = await this.resolveParameterNames([...paramIds].map(String));
    const parameterNames: Record<string, string> = {};
    for (const [pid, name] of names) parameterNames[pid] = name;
    for (const it of iterations) {
      for (const c of it.data) {
        const n = parameterNames[String(c.paramId)];
        if (n) c.name = n;
      }
    }
    const di = td?.['defaultIteration'];
    const defaultIterationId = typeof di === 'string' ? di : di?.[env] ?? di?.[environmentType];
    return {
      entityType,
      id: numericId(id),
      testdataId: String(td['id']),
      environmentType: env,
      ...(defaultIterationId ? { defaultIterationId: String(defaultIterationId) } : {}),
      iterations,
      parameterNames,
    };
  }

  /** Suite-level testdata read. This is a SEPARATE store from the member test cases' own testdata. */
  async getSuiteTestdata(q: { suiteId: string; environmentType?: string }): Promise<TestdataRows> {
    const td = await this.testdataDefinitionRow('SU', q.suiteId);
    const rows = await this.testdataRowsFor(td, 'SU', q.suiteId, q.environmentType ?? 'general');
    // `definition` is diagnostic metadata (ids/versions); harmless for callers.
    return { ...rows, definition: td } as TestdataRows & { definition: Record<string, any> };
  }

  /** Copy one suite-level iteration row into a NEW row and save it at the SUITE level only.
   *  Member test cases are never touched. */
  async copySuiteTestdataIteration(q: {
    suiteId: string; environmentType: string; from?: string; name?: string;
  }): Promise<{ iterationId: string; name: string; rows: TestdataRows }> {
    const td = await this.testdataDefinitionRow('SU', q.suiteId);
    const rows = await this.testdataRowsFor(td, 'SU', q.suiteId, q.environmentType);
    const fromKey = (q.from ?? '').trim();
    const source = (fromKey
      ? rows.iterations.find((r) => r.name === fromKey) ?? rows.iterations.find((r) => String(r.id) === fromKey)
      : undefined)
      ?? (rows.defaultIterationId ? rows.iterations.find((r) => String(r.id) === String(rows.defaultIterationId)) : undefined)
      ?? rows.iterations[0];
    if (!source) {
      throw new Error(`Suite ${q.suiteId} has no suite-level testdata rows in environment "${rows.environmentType}" to copy.`);
    }
    const existing = new Set(rows.iterations.map((r) => r.name));
    let name = (q.name ?? '').trim();
    if (!name) {
      let n = rows.iterations.length + 1;
      while (existing.has(`ITR-${n}`)) n++;
      name = `ITR-${n}`;
    }
    if (existing.has(name)) throw new Error(`Suite ${q.suiteId} already has a suite-level iteration named "${name}".`);
    const newRow: Record<string, any> = JSON.parse(JSON.stringify(source));
    // The backend validator requires an iteration id — the UI itself mints a UUID for a new row
    // (`newRow.id = uuidv4()` in testdata-management.component.ts) and sends it with
    // `newIteration: true`. A row with no id is rejected with "iterationId is required".
    newRow['id'] = randomUUID();
    delete newRow['_id'];
    newRow['name'] = name;
    newRow['environmentType'] = rows.environmentType;
    newRow['sequenceNo'] = Math.max(0, ...rows.iterations.map((r) => Number(r.sequenceNo) || 0)) + 1;
    // The new row must NOT become the suite's active/default iteration.
    newRow['isChecked'] = false;
    // The UI's add-row path also marks the row as a new iteration (with its own UUID id).
    newRow['newIteration'] = true;
    for (const k of ['_id', '__v', 'isEdit', 'showEditMode', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'deleted', 'customerId']) {
      delete newRow[k];
    }
    // Optimistic concurrency: a stale `updateVersion` is answered with 500 CONCURRENCY. Re-read the
    // testdata definition and retry — the UI does the same by reloading after a concurrency prompt.
    const updateWithRetry = async (payloadRows: Array<Record<string, any>>): Promise<any> => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        const fresh = attempt === 0 ? td : await this.testdataDefinitionRow('SU', q.suiteId);
        const body = {
          payload: payloadRows,
          testdata: { id: String(fresh['id']), defaultIteration: fresh['defaultIteration'], updateVersion: fresh['updateVersion'] ?? 0 },
        };
        try {
          return await this.http.putJson<any>('/tm/testdata/update', body);
        } catch (e) {
          lastErr = e;
          const msg = e instanceof Error ? e.message : String(e);
          if (!/CONCURRENCY|Concurrency Error/i.test(msg)) throw e;
        }
      }
      throw lastErr;
    };
    const savedRaw = await updateWithRetry([newRow]);
    let after = await this.testdataRowsFor(td, 'SU', q.suiteId, q.environmentType);
    let created = after.iterations.find((r) => r.name === name);
    if (!created) {
      // Some backend builds replace the whole iteration set on update — retry with the existing rows
      // plus the new one before declaring failure. Strip read-only fields: the update validator
      // rejects customerId / deleted / createdAt / … on rows read back from search.
      const strip = (r: Record<string, any>) => {
        const c = { ...r };
        for (const k of ['_id', '__v', 'customerId', 'deleted', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'fnMap', 'isEdit', 'newIteration', 'showEditMode']) delete c[k];
        return c;
      };
      const allRows = [newRow, ...rows.iterations.map(strip)];
      await updateWithRetry(allRows);
      after = await this.testdataRowsFor(td, 'SU', q.suiteId, q.environmentType);
      created = after.iterations.find((r) => r.name === name);
    }
    if (!created) {
      throw new Error(
        `Saved suite-level row "${name}" for suite ${q.suiteId}, but reading the testdata back did not find it. ` +
        `Backend response: ${JSON.stringify(savedRaw)?.slice(0, 400)}`,
      );
    }
    return { iterationId: String(created.id), name: String(created.name), rows: after };
  }

  /** Delete testdata iteration rows by name or id at TC / FUNCTION / SUITE level. The default row is refused. */
  async deleteTestdataIterations(q: {
    entityType: 'TC' | 'FN' | 'SU'; id: string; environmentType: string; iterations: string[];
  }): Promise<{ deleted: string[]; rows: TestdataRows }> {
    const td = await this.testdataDefinitionRow(q.entityType, q.id);
    const rows = await this.testdataRowsFor(td, q.entityType, q.id, q.environmentType);
    const wanted = q.iterations.map((s) => String(s).trim()).filter(Boolean);
    if (!wanted.length) throw new Error('iterations[] is required — pass iteration names (e.g. "ITR-2") or ids.');
    const targets: string[] = [];
    for (const w of wanted) {
      const row = rows.iterations.find((r) => r.name === w) ?? rows.iterations.find((r) => String(r.id) === w);
      if (!row) {
        throw new Error(
          `No iteration "${w}" on ${q.entityType} ${q.id}. Rows: ${rows.iterations.map((r) => r.name || r.id).join(', ') || '(none)'}.`,
        );
      }
      if (rows.defaultIterationId && String(row.id) === String(rows.defaultIterationId)) {
        throw new Error(`"${row.name || row.id}" is the DEFAULT iteration and cannot be deleted.`);
      }
      if (!targets.includes(String(row.id))) targets.push(String(row.id));
    }
    await this.http.patchJson<any>('/tm/testdata', {
      id: targets,
      testdata: {
        id: td['id'],
        defaultIteration: td['defaultIteration'],
        updateVersion: td['updateVersion'] ?? 0,
        projectId: td['projectId'] ?? this.requireProjectId(),
      },
      payload: [],
    });
    const after = await this.testdataRowsFor(td, q.entityType, q.id, q.environmentType);
    return { deleted: targets, rows: after };
  }

  /** Copy the default-iteration values of one TC onto another, matching parameters BY NAME.   *  Used by tc_automate: a manual TC converted to automated must carry the manual TC's testdata,
   *  not the values that happened to be typed during the recording. Protected source values are read
   *  unmasked internally so they can be copied — they are never returned to the model.
   *  A source parameter with an EMPTY seed is skipped, so a value the recording generated for a
   *  field the manual TC never filled is left in place. */
  async copyTestdata(q: { fromTcId: string; toTcId: string; environmentType?: string }): Promise<CopyTestdataResult> {
    if (!q.fromTcId || !q.toTcId) throw new Error('copyTestdata: fromTcId and toTcId are required');
    const source = await this.getDefaultIteration({
      tcId: q.fromTcId,
      ...(q.environmentType ? { environmentType: q.environmentType } : {}),
      includeProtected: true,
    });
    const target = await this.getDefaultIteration({
      tcId: q.toTcId,
      ...(q.environmentType ? { environmentType: q.environmentType } : {}),
    });
    const targetByLower = new Map<string, { paramId: number; name: string }>();
    for (const p of target.parameters) {
      targetByLower.set(p.name.trim().toLowerCase(), { paramId: p.paramId, name: p.name });
    }

    const row: Record<string, string> = {};   // keyed by the TARGET parameter's exact name
    const skipped: string[] = [];
    let copied = 0;
    for (const p of source.parameters) {
      const hit = targetByLower.get(p.name.trim().toLowerCase());
      if (!hit) { skipped.push(p.name); continue; }
      if (p.seed === '') continue;            // nothing seeded on the source — keep the generated value
      row[hit.name] = p.seed;
      copied++;
    }
    if (copied > 0) {
      await this.saveGeneratedIterations({
        tcId: q.toTcId,
        versionId: target.versionId,
        environmentType: target.environmentType,
        rows: [row],
        parameters: target.parameters,
      });
    }
    return {
      fromTcId: q.fromTcId,
      toTcId: q.toTcId,
      environmentType: target.environmentType,
      copied,
      skipped,
    };
  }

  /** Patch cells of a test case's DEFAULT testdata iteration by PARAMETER NAME — value and/or formula.
   *  The recorder-window Save writes these itself (persistMcpTestdata); this method exists for the
   *  journal-fallback save, so a recording's formulas are not lost when the window is unavailable.
   *  Patches the default row ONLY (never appends an iteration — that is saveGeneratedIterations), and
   *  never overwrites a formula the user already set. */
  async patchTestdataCells(input: {
    tcId: string;
    cells: Array<{ paramName: string; value: string; formulaValue?: string | undefined }>;
    versionId?: string | undefined;
    environmentType?: string | undefined;
    /** Replace an EXISTING formula. Default false keeps the journal-fallback behaviour (never clobber
     *  what the user set in the recorder window); tc_update_testdata passes true. */
    overwriteFormula?: boolean | undefined;
  }): Promise<{ patched: number; skipped: string[] }> {
    const projectId = this.requireProjectId();
    const skipped: string[] = [];
    const cells = input.cells ?? [];
    if (!cells.length) return { patched: 0, skipped };

    const tpl = await this.getDefaultIteration({
      tcId: input.tcId,
      ...(input.versionId ? { versionId: input.versionId } : {}),
      ...(input.environmentType ? { environmentType: input.environmentType } : {}),
    });
    const idByName = new Map<string, number>();
    for (const p of tpl.parameters) {
      idByName.set(p.name, p.paramId);
      idByName.set(p.name.trim().toLowerCase(), p.paramId);
    }
    const tcNum = Number.parseInt(numericId(input.tcId), 10);
    const rawTc = await this.fetchRawTestcase(input.tcId);
    const fallbackCustomerId = Number(rawTc?.customerId);
    const search = await this.http.postJson<any>('/tm/testdata/searchItr', {
      searchFields: [
        { column: 'testcaseId', value: tcNum, regEx: false },
        { column: 'versionId', value: tpl.versionId, regEx: false },
        { column: 'environmentType', value: tpl.environmentType, regEx: false },
        { column: 'deleted', value: false, regEx: false },
      ],
      startIndex: 0,
      limit: 1000,
    });
    const rows = pickArray(search, 'data', 'content', 'iterations');
    if (!Array.isArray(rows) || rows.length === 0) {
      skipped.push(`no test-data iteration for ${input.tcId} @ ${tpl.versionId} / ${tpl.environmentType}`);
      return { patched: 0, skipped };
    }
    // The DEFAULT row is the first by sequence (ITR-1); never touch the other iterations.
    const seqOf = (r: any): number => Number(r?.sequenceNo ?? r?.itr ?? 0);
    const row = [...rows].sort((a: any, b: any) => seqOf(a) - seqOf(b))[0];
    const rowCustomerId = Number(row?.customerId ?? fallbackCustomerId);
    if (!Number.isFinite(rowCustomerId)) {
      skipped.push('the default iteration carries no customerId — not patched');
      return { patched: 0, skipped };
    }
    const data: any[] = Array.isArray(row.data) ? row.data.map((c: any) => ({ ...c })) : [];
    let patched = 0;
    for (const cell of cells) {
      const paramId = idByName.get(cell.paramName) ?? idByName.get(cell.paramName.trim().toLowerCase());
      if (paramId == null) {
        skipped.push(`parameter "${cell.paramName}" is not in this version's test-data template`);
        continue;
      }
      const idx = data.findIndex((c: any) => Number(c?.paramId) === paramId);
      if (idx >= 0) {
        const cur: any = data[idx];
        const next: any = { ...cur, paramId };
        if (cell.value) next.value = cell.value;
        // A literal value wins only for the value; by default never clobber a formula the user already
        // set (journal-fallback save). An explicit update opts in with overwriteFormula.
        if (cell.formulaValue && (input.overwriteFormula === true
          || !(typeof cur?.formulaValue === 'string' && cur.formulaValue.trim()))) {
          next.formulaValue = cell.formulaValue;
        }
        data[idx] = next;
      } else {
        data.push({
          paramId,
          value: cell.value ?? '',
          ...(cell.formulaValue ? { formulaValue: cell.formulaValue } : {}),
        });
      }
      patched++;
    }
    if (!patched) return { patched: 0, skipped };
    await this.http.postJson<any>('/tm/testdata/updateItr', {
      parentId: row.parentId,
      id: row.id,
      customerId: rowCustomerId,
      projectId,
      data,
    });
    return { patched, skipped };
  }

  /** Environment key: caller wins; else fetch the project's configured envs and pick the first;
   *  else 'general' (matches the SQA UI fallback). */
  private async resolveEnvironment(projectId: number, requested?: string): Promise<string> {
    if (requested && requested.length > 0) {
      // Test data is stored per environment KEY. A display name, a different case or a typo would run against an
      // environment that has no data for the test case — so resolve it to the stored key, and refuse an unknown one with
      // the valid options. If the list cannot be read (or is empty) the value is used exactly as before.
      let known: EnvInfo[] = [];
      try { known = await this.listEnvironments(); } catch { /* use as given */ }
      if (known.length === 0) return requested;
      const want = requested.trim().toLowerCase();
      const hit = known.find((e) => (e.key ?? '').toLowerCase() === want) ?? known.find((e) => e.name.trim().toLowerCase() === want);
      if (hit) return hit.key || hit.name;
      throw new Error(`Environment "${requested}" does not exist in this project. Available: ${known.map((e) => e.name === (e.key ?? e.name) ? e.name : `${e.name} (key ${e.key})`).join(', ')}.`);
    }
    try {
      const envs = await this.http.getJson<any>(`/pm/fields/8?projectId=${projectId}&fieldType=environment`);
      if (Array.isArray(envs) && envs.length > 0) {
        const key = str(envs[0], 'key', 'value', 'name');
        if (key) return key;
      }
    } catch { /* fall through */ }
    return 'general';
  }

  /** Parameter name + protected-flag lookup. Null when the parameter is deleted or cross-project. */
  private async fetchParameterMeta(paramId: number): Promise<{ name: string; protected: boolean } | null> {
    let raw: any;
    try {
      raw = await this.http.getJson<any>(`/tm/parameter/${paramId}`);
    } catch { return null; }
    let n: any = raw?.data ?? raw;
    if (Array.isArray(n)) n = n.length > 0 ? n[0] : null;
    if (!n || typeof n !== 'object') return null;
    const name = str(n, 'name');
    if (!name) return null;
    return { name, protected: n?.protected === true };
  }

  // ---------------------------------------------------------------------- Formulas  [Step 3b]

  /** List every formula the current project can use — DEFAULT (customer-wide prefabs) unioned with
   *  CUSTOM entries scoped to the customer or this project. The backend endpoint already returns the
   *  union when called with `projectId`; we just normalise the doc shape and derive `scope` from
   *  (type + projectId). Cached per adapter instance. */
  async listFormulas(): Promise<Formula[]> {
    if (this.formulaCache) return this.formulaCache;
    const projectId = this.requireProjectId();
    const pending = (async () => {
      const raw = await this.http.getJson<any>(`/tm/syncFormulas/fetch?projectId=${projectId}`);
      const list: any[] = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
      const out: Formula[] = [];
      for (const doc of list) {
        const f = normalizeFormula(doc, projectId);
        if (f) out.push(withEngineArgHints(f));
      }
      return out;
    })().catch((e) => {
      // On failure, drop the memoised promise so a retry actually retries.
      this.formulaCache = null;
      throw e;
    });
    this.formulaCache = pending;
    return pending;
  }

  /** Serialises calls to the agent's formula engine: its controller keeps shared state (one plugin session and a
   *  busy flag), so two concurrent requests collide (the second gets an error). */
  private formulaAgentQueue: Promise<unknown> = Promise.resolve();

  /** Evaluate one formula call and return { value, expression }. The formula is evaluated by the AGENT's formula
   *  engine (`POST /formula/convert`) — the engine the UI and the executor use — so every catalog formula,
   *  nested expression and custom formula works, with no list of supported formulas kept here. The stored
   *  `expression` is positional (`=NAME("a","b")`), exactly what the SQA UI writes and the executor re-evaluates. */
  async evaluateFormula(call: FormulaCall, ctx?: { technologyType?: string }): Promise<{ value: string; expression: string }> {
    const explicit = (call.expression ?? '').trim();
    let expression: string;
    let fname = '';
    let ordered: string[] = [];
    if (explicit) {
      expression = explicit.startsWith('=') ? explicit : `=${explicit}`;
    } else {
      if (!call.name) throw new Error('A formula needs a `name` (from tc_list_formulas) or a full `expression`.');
      const all = await this.listFormulas();
      // Both sides carry parens: the backend stores DEFAULT names as "FIRST_NAME()", and models copy the
      // SIGNATURE format ("FIRST_NAME(country name,sex,min,max)"). Strip on both, compare case-insensitively.
      const needle = bareFormulaName(call.name).toUpperCase();
      const meta = all.find((f) => bareFormulaName(f.name).toUpperCase() === needle);
      const backendUpper = new Set(all.map((f) => bareFormulaName(f.name).toUpperCase()).filter(Boolean));
      // Validate against the ENGINE's real formula set (not just the backend catalog, which omits
      // ALPHABET/NUMERIC/UUID/comparisons/…). This both ACCEPTS engine-only formulas AND rejects invented
      // names like RANDOM_NAME so the AI can only use formulas that actually exist.
      if (!meta && !isKnownFormula(needle, backendUpper)) {
        // Self-correcting error: the recording agent often can't reach tc_list_formulas, so LIST the real
        // names here (and offer "did you mean" matches) instead of pointing at a tool it can't call.
        const names = [...new Set([...ENGINE_FORMULA_NAMES, ...backendUpper])];
        const near = nearFormulaNames(needle, names);
        const didYouMean = near.length ? ` Did you mean: ${near.join(', ')}.` : '';
        throw new Error(
          `"${call.name}" is not a valid formula — do NOT invent formula names.${didYouMean} ` +
          `Use one of the available formulas: ${names.join(', ')}.`,
        );
      }
      fname = meta ? bareFormulaName(meta.name) : bareFormulaName(call.name);
      // Arg keys arrive with trailing colons/whitespace ("country name:", " sex ") from both the model AND
      // the formula's own declared keyName. Normalise both sides before binding.
      // Declared keyNames are inconsistent about case and trailing colons ("Prefix", "Domain",
      // "country name:", "sex:") and the caller naturally types the SIGNATURE form ("prefix",
      // "country name"). Matching exactly dropped the argument silently: the formula then ran with
      // its own defaults, so `EMAIL_ID` with {prefix, domain} returned a RANDOM email instead of
      // john@yahoo.com. Fold case + trailing colon + whitespace on both sides.
      // Some declared keyNames carry the optional-parameter brackets in the name itself
      // ("[number2]", "[num_chars]"), so a caller passing the natural "number2" never bound and the
      // expression silently lost that argument — MULTIPLY("3","4") became MULTIPLY("3") = 3.
      // Strip a surrounding [..] on BOTH sides (declared names and caller keys).
      const argKey = (k: string) => {
        let s = k.replace(/:$/, '').trim().toLowerCase();
        const m = /^\[(.*)\]$/.exec(s);
        if (m) s = m[1]!.trim();
        return s;
      };
      const args: Record<string, string> = {};
      for (const [k, v] of Object.entries(call.args ?? {})) args[argKey(k)] = v;
      // An argument that is itself a formula call is a NESTING attempt via name+args, which cannot be
      // expressed here (args are literal values). Point the caller at `expression`, which now supports
      // nesting (the engine evaluates nested formulas; the recorder canonicalises the `=` prefixes).
      for (const [k, v] of Object.entries(args)) {
        if (/^\s*=/.test(v) || /^[A-Z][A-Z0-9_]*\(.*\)$/.test(v.trim())) {
          throw new Error(
            `Argument "${k}" of ${fname} looks like a formula (${v.slice(0, 60)}${v.length > 60 ? '…' : ''}). ` +
            'Formula arguments are literal values — pass the whole nested formula as `expression` instead, ' +
            'e.g. { expression: "=CONCATENATE(UPPER(LEFT(FIRST_NAME(),3)),NUMERIC(3))" }.',
          );
        }
      }
      // Bind by the formula's declared keyNames when we have metadata (backend formula); for an engine-only
      // formula (no metadata, e.g. ALPHABET) take the supplied values POSITIONALLY in the order given.
      ordered = meta && meta.parameters.length
        ? meta.parameters.map((p) => args[argKey(p.keyName)] ?? '')
        : Object.values(args);
      // Nothing bound at all is a caller error, not a default: say which names are expected instead
      // of producing a plausible-looking value from the wrong formula inputs.
      if (meta && meta.parameters.length && Object.keys(args).length > 0 && ordered.every((v) => v === '')) {
        const expected = meta.parameters.map((p) => p.keyName).join(', ') || '(none)';
        throw new Error(
          `None of the supplied argument name(s) ${Object.keys(call.args ?? {}).join(', ')} belong to ` +
          `formula ${fname}. Expected: ${expected}. Keys are matched case-insensitively and may omit a ` +
          'trailing colon.',
        );
      }
      // Only the arguments actually given: trailing blanks are dropped so the formula's own defaults apply.
      const given = [...ordered];
      while (given.length && given[given.length - 1] === '') given.pop();
      const quoted = given.map((a) => `"${String(a).replace(/"/g, '\\"')}"`).join(',');
      expression = `=${fname}(${quoted})`;
    }

    // Canonicalise so nested functions carry the `=` the engine parser and the Test Data UI require
    // (e.g. =CONCATENATE(ALPHABET(3),NUMERIC(3)) → =CONCATENATE(=ALPHABET(3),=NUMERIC(3))). Both the value
    // evaluation and the STORED expression use this form, so the saved formula renders + executes correctly.
    expression = normalizeFormulaExpression(expression);

    // Reject invented formula names BEFORE hitting the engine. The `expression` path is a free-form escape
    // hatch, so a hallucinated `=RANDOM_NAME()` would otherwise be forwarded and fail with a cryptic
    // "No valid function found". Validate every function name against the engine's real set (+ live backend
    // customs); on an unknown name, return a self-correcting error naming the real alternative.
    {
      let backendUpper = new Set<string>();
      try { backendUpper = new Set((await this.listFormulas()).map((f) => bareFormulaName(f.name).toUpperCase())); }
      catch { /* backend unreachable — validate against the engine set only */ }
      // Case canonicalisation: the engine's enum is upper-case and case-SENSITIVE, a recorder writes
      // "concatenate"/"First_Name". Do it BEFORE the validity check so a mis-cased real name is not
      // reported as unknown.
      expression = canonicalizeFormulaNames(expression, new Set<string>([...ENGINE_FORMULA_NAMES, ...backendUpper]));
      const used = extractFunctionNames(expression);
      const unknown = used.filter((n) => !isKnownFormula(n, backendUpper));
      if (unknown.length) {
        const names = [...new Set([...ENGINE_FORMULA_NAMES, ...backendUpper])];
        const near = nearFormulaNames(unknown[0]!, names);
        const didYouMean = near.length ? ` Did you mean: ${near.join(', ')}.` : '';
        throw new Error(
          `"${unknown[0]}" is not a valid formula — do NOT invent formula names.${didYouMean} ` +
          `Use only existing formulas: ${names.join(', ')}.`,
        );
      }
    }

    const viaAgent = await this.evaluateViaAgent(expression, ctx?.technologyType);
    if (viaAgent.ok) return { value: viaAgent.value, expression };

    // Agent not reachable: the smaller backend route can still serve the formulas it knows, so a person-info
    // formula does not stop working just because the agent is off. Anything else gets a clear error.
    if (viaAgent.unreachable && fname && LEGACY_ROUTE_FORMULAS.has(fname.toUpperCase())) {
      return { value: await this.evaluateViaBackendRoute(fname, ordered), expression };
    }
    if (viaAgent.unreachable) {
      throw new Error(
        `Cannot evaluate ${expression}: the SimplifyQA desktop agent evaluates formulas and it could not be reached ` +
        `(${viaAgent.message}). Start the agent (QA_MCP_URL points at it) and try again.`,
      );
    }
    throw new Error(viaAgent.message);
  }

  /** POST the expression to the agent's `/formula/convert` (same origin as `QA_MCP_URL`). `unreachable` means no
   *  usable answer from the agent (not configured / refused / timed out), as opposed to the agent answering that
   *  the formula itself is wrong. */
  private evaluateViaAgent(
    expression: string, technologyType?: string,
  ): Promise<{ ok: true; value: string } | { ok: false; unreachable: boolean; message: string }> {
    let origin: string | undefined;
    try { origin = this.cfg.url ? new URL(this.cfg.url).origin : undefined; } catch { origin = undefined; }
    if (!origin) return Promise.resolve({ ok: false, unreachable: true, message: 'no agent URL configured (set QA_MCP_URL)' });

    const run = async (): Promise<{ ok: true; value: string } | { ok: false; unreachable: boolean; message: string }> => {
      const projectId = this.requireProjectId();
      const projectName = await this.lookupProjectName(projectId);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30_000);
      try {
        const res = await fetch(`${origin}/formula/convert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.token}` },
          body: JSON.stringify({
            formula: expression, projectName, projectId, technologyType: (technologyType ?? 'WEB').toUpperCase(),
          }),
          signal: ac.signal,
        });
        const text = await res.text();
        let json: any;
        try { json = JSON.parse(text); } catch { json = undefined; }
        // A rejected formula also answers with `value` (the formula text) — only a 2xx value is a result.
        if (res.ok && json && json.value !== undefined && json.value !== null) return { ok: true, value: String(json.value) };
        const detail = json?.Exception ?? (!res.ok && typeof json?.value === 'string' ? json.value : undefined) ?? text.slice(0, 200);
        return { ok: false, unreachable: false, message: `The agent could not evaluate ${expression} (HTTP ${res.status}): ${detail}` };
      } catch (e) {
        const reason = ac.signal.aborted ? 'no response within 30s'
          : (e instanceof Error ? ((e as { cause?: { message?: string } }).cause?.message ?? e.message) : String(e));
        return { ok: false, unreachable: true, message: reason };
      } finally {
        clearTimeout(timer);
      }
    };
    const next = this.formulaAgentQueue.then(run, run);
    this.formulaAgentQueue = next.catch(() => undefined);
    return next;
  }

  /** The old evaluation path — backend `/tm/customFormula`, which only knows LEGACY_ROUTE_FORMULAS. Fallback only. */
  private async evaluateViaBackendRoute(fname: string, ordered: string[]): Promise<string> {
    // /tm/customFormula takes its OWN positional query keys, not the formula's display keyNames.
    const qs = new URLSearchParams({ formulaName: fname });
    const apiKeys = FORMULA_ARG_KEYS[fname.toUpperCase()] ?? ['value'];
    ordered.forEach((v, i) => { if (v !== '' && apiKeys[i]) qs.append(apiKeys[i], v); });
    // ponytail: the compute endpoint's response envelope varies between formula types
    // (`{data:{value}}` for person-info, plain string for a few); coerce defensively.
    const resp = await this.http.getJson<any>(`/tm/customFormula?${qs.toString()}`);
    return String(resp?.data?.value ?? resp?.value ?? resp?.data ?? resp ?? '');
  }

  /** The technology of the test case / function the data is for (custom formulas need it), or undefined. */
  private async formulaTechnology(tcId: string): Promise<string | undefined> {
    try {
      const raw = await this.fetchRawTestcase(tcId);
      return str(raw, 'tcType', 'fnType')?.toUpperCase();
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------------------- Run status  [Step 6]

  /** Real status of a run — reads step-level results direct from SQA REST because the desktop agent's
   *  get_run only returns queue state (often stale). For a SUITE run, returns per-TC rollup
   *  (`children[]`) instead of step details — a suite doc's `type` field flags it. start/stop still
   *  hop for v1. */
  async getRun(runId: string): Promise<RunStatus> {
    const projectId = this.requireProjectId();
    const base = (this.cfg.baseUrl ?? '').replace(/\/+$/, '');
    const runIdNum = Number.parseInt(numericId(runId), 10);

    // Top-level execution doc (carries `type` = 'TC' or 'SUITE', and `executionItems[]` for a suite).
    // One extra POST per getRun call; a suite short-circuits here so no /exec/report is needed.
    let tcExecDoc: any;
    if (Number.isFinite(runIdNum)) {
      const execDoc = await this.fetchExecDoc(runIdNum, projectId);
      tcExecDoc = execDoc;
      const execType = String(execDoc?.type ?? '').toUpperCase();
      // A suite or plan run is many test cases: report each item (a plan run is never a single TC).
      if (execDoc && (execType === 'SUITE' || execType === 'EXECUTIONPLAN')) {
        type Child = RunStatus['children'] extends (infer C)[] | undefined ? C : never;
        const items: any[] = Array.isArray(execDoc.executionItems) ? execDoc.executionItems : [];
        const children: Child[] = items.map((it) => {
          const testcaseId = str(it, 'testcaseId');
          const versionId = str(it, 'versionId');
          const stepId = str(it, 'stepId');
          const child: Child = {
            id: testcaseId ?? String(it?.id ?? ''),
            state: mapRunState(str(it, 'status') ?? ''),
            ...(testcaseId ? { testcaseId } : {}),
            ...(versionId ? { versionId } : {}),
            ...(stepId ? { stepId } : {}),
          };
          const name = str(it, 'name');
          if (name) child.title = name;
          return child;
        });
        const total = children.length;
        const done = children.filter((c) => c.state !== 'queued' && c.state !== 'running').length;
        const suiteNum = Number(execDoc.executionTypeId ?? 0);
        const startedAt = str(execDoc, 'startTime', 'createdAt');
        const endedAt = str(execDoc, 'endTime');
        return {
          runId,
          state: mapRunState(str(execDoc, 'status') ?? ''),
          ...(total > 0 ? { progress: { done, total }, children } : {}),
          ...(startedAt ? { startedAt } : {}),
          ...(endedAt ? { endedAt } : {}),
          // Same link the UI opens (executionplan.component.ts:857 uses type EXECUTIONPLAN + plan id).
          reportUrl: `${base}/user/reports/reports-page?type=${execType}&parentId=${suiteNum}&id=${runIdNum}&projectId=${projectId}`,
        };
      }
    }

    // TC path — per-step results via /exec/report + /reports/execution/getstepResult.
    // A re-execution soft-deletes the run row it replaces; only live rows are this run's results.
    const rawRuns = await this.http.getJson<any>(`/exec/report/${runId}/${projectId}`);
    const runs = Array.isArray(rawRuns) ? notDeleted(rawRuns) : rawRuns;
    if (!Array.isArray(runs) || runs.length === 0) {
      return { runId, state: 'queued' };
    }
    // Multi-TC runs return several rows; pick the first FAILED so tc_heal has a failing step to diagnose.
    let chosen: any = runs[0];
    for (const r of runs) {
      if (typeof r?.status === 'string' && r.status.toUpperCase() === 'FAILED') { chosen = r; break; }
    }
    const executionRunId = str(chosen, 'id', '_id') ?? '';
    const parentId = Number(chosen?.executionItemId ?? 0);
    const stepResults = await this.fetchStepResults(runIdNum, executionRunId, parentId, projectId);
    // The report page addresses a test-case run as (parentId = the TEST CASE id, id = the execution id) — what the
    // UI itself navigates with. `executionItemId` (used above to fetch step rows) is a different id and is empty for
    // some runs (API / DB), which made the link open an empty report.
    const reportParentId = Number(tcExecDoc?.executionTypeId) || Number(str(chosen, 'testcaseId')) || parentId;

    return {
      runId,
      state: mapRunState(str(chosen, 'status') ?? ''),
      stepResults,
      reportUrl: `${base}/user/reports/reports-page?type=TESTCASE&parentId=${reportParentId}&id=${runIdNum}&projectId=${projectId}`,
    };
  }
  private async fetchExecDoc(runIdNum: number, projectId: number): Promise<any> {
    const execBody = {
      searchFields: [
        { column: 'id', value: runIdNum, regEx: false },
        { column: 'projectId', value: projectId, regEx: false },
        { column: 'deleted', value: false },
      ],
      startIndex: 0,
      limit: 1,
    };
    const execRaw = await this.http.postJson<any>('/exec/execution/search', execBody);
    return pickArray(execRaw, 'data', 'content', 'executions')[0];
  }
  private async fetchStepResults(executionId: number, executionRunId: string, parentId: number, projectId: number): Promise<NonNullable<RunStatus['stepResults']>> {
    const stepsResp = await this.http.postJson<any>('/reports/execution/getstepResult', {
      executionId, executionRunId, parentId, projectId,
    });
    const rawSteps: any[] = Array.isArray(stepsResp?.data) ? notDeleted(stepsResp.data) : [];
    // Backend logs control-flow markers as INFO rows with `description: null` (see
    // executionStepResult.service.js insertLoopIterationStart/insertFunctionEnd/… — the same
    // executionRunId carries LOOP_ITERATION_START/END, FUNCTION_START/END, FUNCTION_ITERATION_*,
    // WHILE_START/END alongside the real action rows). Left in, they fill the text response
    // with blank `• step N:  (info)` lines that hide the actual failing step. Filter here so
    // stepResults contains only debuggable rows.
    const NOISE_STEP_TYPES = new Set([
      'LOOP_ITERATION_START', 'LOOP_ITERATION_END',
      'FUNCTION_START', 'FUNCTION_END',
      'FUNCTION_ITERATION_START', 'FUNCTION_ITERATION_END',
      'FOR_START', 'FOR_END', 'WHILE_START', 'WHILE_END',
      'ITERATOR_START', 'ITERATOR_END', 'DO',
    ]);
    const filtered = rawSteps.filter((s) => {
      const st = String(s?.stepType ?? '').toUpperCase();
      return !NOISE_STEP_TYPES.has(st);
    });
    return filtered.map((s) => {
      const step: { n: number; description: string; status: string; error?: string; warning?: string } = {
        n: typeof s?.seq === 'number' ? s.seq : 0,
        description: String(s?.description ?? ''),
        status: mapStepStatus(str(s, 'status') ?? ''),
      };
      const exc = str(s, 'exception');
      if (exc && exc.length > 0) {
        step.error = exc;
      } else {
        // SQA leaves `exception` null even on FAILED. The real cause sits in ERROR log lines
        // (e.g. "No Such Element Exception: ..."). Send ALL ERROR lines joined — a trailing
        // "JS disabled" line would otherwise mask the real NoSuchElement above it.
        const logs = s?.executionLogData?.executionLogs;
        // API step: a failed assertion raises no exception and logs no ERROR line — the reason is recorded in apiData
        // (assertion status / expected / actual, HTTP status). Without this the last INFO line ("Received HTTP
        // Response: Status=404") stood in for the error, or there was none.
        const apiWhy = step.status === 'failed' ? apiFailureReason(s?.apiData) : undefined;
        if (Array.isArray(logs) && logs.length > 0) {
          const errorLines: string[] = [];
          for (const l of logs) {
            const t = String(l ?? '');
            if (t.includes('ERROR')) errorLines.push(t);
          }
          if (errorLines.length > 0) step.error = errorLines.join('\n');
          else if (apiWhy) step.error = apiWhy;
          else step.error = String(logs[logs.length - 1] ?? '');
        } else if (apiWhy) {
          step.error = apiWhy;
        }
      }
      // Derived only from what the backend stored — see stepDiagnostics.ts. Never changes the step's status.
      const transport = apiTransportFailure(s?.apiData);
      if (step.status === 'failed') {
        if (transport && !/Could not send request:/.test(step.error ?? '')) {
          // the bare "HTTP 503 — <made-up body>" line says nothing the reason does not; any other text is kept
          const rest = step.error && !/^HTTP \d{3}\b/.test(step.error) ? `\n${step.error}` : '';
          step.error = `Could not send request: ${transport}${rest}`;
        }
        const hint = dbFailureHint(step.error);
        if (hint) step.error = `${step.error}\n→ ${hint}`;
      } else if (step.status === 'passed') {
        // A request that got no response PASSES when nothing asserts on it (the plugin stores a made-up 5xx reply).
        if (transport) {
          step.warning = `passed, but the request got no response from the server (${transport}). ` +
            'A step with no assertions passes in this case - the server may be unreachable.';
        } else {
          const empty = emptyReadWarning(step.description, s?.testdata);
          if (empty) step.warning = empty;
        }
      }
      const unresolved = unresolvedPlaceholders(s?.testdata);
      if (unresolved.length) {
        const note = `\${${unresolved.join('}, ${')}} was left as literal text in this step's data - only {{name}} is substituted at run time. Re-save the step so the parameter is bound.`;
        step.warning = step.warning ? `${step.warning} ${note}` : note;
      }
      return step;
    });
  }
  async getSuiteChildRun(suiteRunId: string, child: { testcaseId: string; versionId?: string | undefined; stepId?: string | undefined }): Promise<RunStatus> {
    const projectId = this.requireProjectId();
    const runIdNum = Number.parseInt(numericId(suiteRunId), 10);
    const execDoc = await this.fetchExecDoc(runIdNum, projectId);
    if (!execDoc) throw new Error(`Suite run ${suiteRunId} not found.`);
    const suiteNum = Number(execDoc.executionTypeId ?? 0);
    const body: Record<string, unknown> = {
      type: 'SU',
      projectId,
      parentId: suiteNum,
      executionId: runIdNum,
      tcId: Number.parseInt(numericId(child.testcaseId), 10),
      ...(child.versionId ? { tcVersionId: child.versionId } : {}),
      ...(child.stepId ? { stepId: child.stepId } : {}),
    };
    const raw = await this.http.postJson<any>('/reports/execution/getExecutionRuns', body);
    const runs: any[] = Array.isArray(raw?.data) ? raw.data : [];
    const base = (this.cfg.baseUrl ?? '').replace(/\/+$/, '');
    if (!runs.length) {
      return { runId: suiteRunId, state: 'queued' };
    }
    let chosen: any = runs[0];
    for (const r of runs) {
      if (typeof r?.status === 'string' && r.status.toUpperCase() === 'FAILED') { chosen = r; break; }
    }
    const executionRunId = str(chosen, 'id', '_id') ?? '';
    const parentId = Number(chosen?.executionItemId ?? 0);
    const stepResults = await this.fetchStepResults(runIdNum, executionRunId, parentId, projectId);
    return {
      runId: suiteRunId,
      state: mapRunState(str(chosen, 'status') ?? ''),
      stepResults,
      // A test case inside a SUITE run has no report page of its own here: `parentId` above is an internal item id
      // (not a test case id) and `runIdNum` is the SUITE's run id, so a type=TESTCASE link built from them opened
      // nothing. Link to the suite's report — the page that lists every test case in the run.
      reportUrl: `${base}/user/reports/reports-page?type=SUITE&parentId=${suiteNum}&id=${runIdNum}&projectId=${projectId}`,
    };
  }

  /** Whole-execution failure analysis (executionFailures.ts) for TC-123 / SU-123 / PL-123 or one
   *  named execution. */
  async getExecutionFailures(
    input: import('./failureTypes.js').ExecutionFailureInput,
  ): Promise<import('./failureTypes.js').ExecutionFailureContext> {
    return new ExecutionFailureAnalysis({
      http: this.http,
      projectId: this.requireProjectId(),
      baseUrl: this.baseUrl(),
      fetchExecDoc: (id, projectId) => this.fetchExecDoc(id, projectId),
      latestExecutionOf: (kind, id) => this.getLatestRunFor(kind, id),
    }).analyse(input);
  }

  /** A failure screenshot as base64 (see executionFailures.fetchFailureImage). */
  async fetchFailureImage(absoluteUrl: string, maxBytes: number): Promise<{ data: string; mimeType: string } | null> {
    return fetchFailureImage(this.http, this.baseUrl(), absoluteUrl, maxBytes);
  }

  /** The failure-analysis card + evidence text and the top causes' screenshots (failureReport.ts). */
  async getFailureReport(
    input: import('./failureTypes.js').ExecutionFailureInput & { includeImages?: boolean },
  ): Promise<import('./failureReport.js').FailureReport> {
    const { includeImages, ...analysisInput } = input;
    const ctx = await this.getExecutionFailures(analysisInput);
    const images = includeImages === false || input.includeScreenshots === false
      ? []
      : await failureImages(ctx, (url, maxBytes) => this.fetchFailureImage(url, maxBytes));
    return { text: renderExecution(ctx), images };
  }

  private baseUrl(): string {
    return (this.cfg.baseUrl ?? '').replace(/\/+$/, '');
  }

  /** Most recent execution runId for a SUITE or TC — same `/exec/execution/search` the /reports UI's
   *  current-executions view drives, filtered by `type` + the entity's numeric id, sorted id desc,
   *  limit 1. `childExecution:false` + the `parentExecutionCopy nor` clause together drop suite-child
   *  TC rows, so a TC lookup returns its LATEST STANDALONE run, not the child spawned inside a suite. */
  private async getLatestRunFor(type: 'SUITE' | 'TC' | 'EXECUTIONPLAN', id: string): Promise<string | null> {
    const projectId = this.requireProjectId();
    const num = Number.parseInt(numericId(id), 10);
    if (!Number.isFinite(num)) throw new Error(`getLatestRunFor(${type}): invalid id ${id}.`);
    // Hand-rolled payload — searchBody doesn't emit `sort` or `operator` keys the /reports search wants.
    const body = {
      searchFields: [
        { column: 'id', sort: 'dsc' },
        { column: 'deleted', value: false },
        { column: 'projectId', value: projectId, regEx: false },
        { column: 'childExecution', value: false },
        { column: 'parentExecutionCopy', value: true, operator: 'nor' },
        { column: 'type', value: type === 'TC' ? 'TESTCASE' : type, regEx: false },
        { column: 'executionTypeId', value: num, regEx: false },
      ],
      startIndex: 0,
      limit: 1,
    };
    const raw = await this.http.postJson<any>('/exec/execution/search', body);
    const rows = pickArray(raw, 'data', 'content', 'executions');
    return str(rows[0], 'id', '_id') ?? null;
  }
  async getLatestSuiteRun(suiteId: string): Promise<string | null> { return this.getLatestRunFor('SUITE', suiteId); }
  async getLatestTestcaseRun(tcId: string): Promise<string | null> { return this.getLatestRunFor('TC', tcId); }

  /** Top-N recent runs — one HTTP call, same standalone-only filters as `getLatestRunFor`. For each
   *  SUITE row the exec doc's `executionItems[]` already carries per-TC status, so the tally is
   *  computed inline (no extra call per run). TC rows omit the tally counters. Sorted newest-first
   *  by `id` (execution ids are monotonic). Bounded — callers should cap `limit` at the tool layer
   *  so a runaway request can't pull thousands of rows. */
  async listRecentRuns(type: 'SUITE' | 'TC', id: string, limit: number): Promise<import('../../domain/types.js').RunSummary[]> {
    const projectId = this.requireProjectId();
    const num = Number.parseInt(numericId(id), 10);
    if (!Number.isFinite(num)) throw new Error(`listRecentRuns(${type}): invalid id ${id}.`);
    const base = (this.cfg.baseUrl ?? '').replace(/\/+$/, '');
    const body = {
      searchFields: [
        { column: 'id', sort: 'dsc' },
        { column: 'deleted', value: false },
        { column: 'projectId', value: projectId, regEx: false },
        { column: 'childExecution', value: false },
        { column: 'parentExecutionCopy', value: true, operator: 'nor' },
        { column: 'type', value: type === 'TC' ? 'TESTCASE' : type, regEx: false },
        { column: 'executionTypeId', value: num, regEx: false },
      ],
      startIndex: 0,
      limit,
    };
    const raw = await this.http.postJson<any>('/exec/execution/search', body);
    const rows = pickArray(raw, 'data', 'content', 'executions');
    return rows.map((r: any): import('../../domain/types.js').RunSummary => {
      const runId = str(r, 'id', '_id') ?? '';
      const runIdNum = Number.parseInt(runId, 10);
      const summary: import('../../domain/types.js').RunSummary = {
        runId,
        state: mapRunState(str(r, 'status') ?? ''),
      };
      const startedAt = str(r, 'startTime', 'createdAt');
      const endedAt = str(r, 'endTime');
      if (startedAt) summary.startedAt = startedAt;
      if (endedAt) summary.endedAt = endedAt;
      if (Number.isFinite(runIdNum)) {
        const entityNum = Number(r?.executionTypeId ?? num);
        summary.reportUrl = `${base}/user/reports/reports-page?type=${type === 'SUITE' ? 'SUITE' : 'TESTCASE'}&parentId=${entityNum}&id=${runIdNum}&projectId=${projectId}`;
      }
      if (type === 'SUITE') {
        const items: any[] = Array.isArray(r?.executionItems) ? r.executionItems : [];
        let passed = 0, failed = 0, skipped = 0, notExecuted = 0;
        for (const it of items) {
          const s = String(it?.status ?? '').toUpperCase();
          if (s === 'PASSED') passed++;
          else if (s === 'FAILED') failed++;
          else if (s === 'SKIPPED') skipped++;
          else if (s === 'NOTEXECUTED') notExecuted++;
        }
        summary.totalTestCases = items.length;
        summary.passed = passed;
        summary.failed = failed;
        summary.skipped = skipped;
        summary.notExecuted = notExecuted;
      }
      return summary;
    });
  }

  /** Targeted name lookup for a single project by numeric id — the whole-list `listProjects`
   *  is paged (default 100) and API-key scoping can hide the selected project, which left
   *  callers with an empty projectName. */
  private async lookupProjectName(projectId: number): Promise<string> {
    try {
      const body = this.searchBody(
        [{ column: 'id', value: projectId }, { column: 'deleted', value: false }],
        { selectFields: ['id', 'name'], limit: 1 },
      );
      const raw = await this.http.postJson<any>('/pm/project/search', body);
      const rows = pickArray(raw, 'data', 'content', 'projects');
      return str(rows[0], 'name', 'projectName') ?? '';
    } catch {
      return '';
    }
  }

  // --- Run dispatch (direct REST) --------------------------------------------
  // Trigger, stop, and local-agent roster all speak the SQA gateway directly.
  // The desktop agent still runs the actual TC — backend RPUSHes to Redis and the
  // agent's poll loop picks it up — but the KICKOFF event no longer hops through
  // /mcp:4040. Spec: common-mcp/plan/sqa-execution-trigger.md. Cloud runners and
  // SUITE runs are not yet ported and still hop (or error clearly).
  /** The database links a run to its release / sprint by numeric id. An empty value means "none"; a NAME must never be
   *  turned into 0 (the run would silently not be linked) — say so and let the caller pass the id. */
  private idOrZero(label: string, v: string | undefined): number {
    const raw = String(v ?? '').trim();
    if (!raw) return 0;
    if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
    const coded = raw.match(/^[A-Za-z]{1,8}[-_](\d+)$/);   // a business code such as REL-5
    if (coded) return Number.parseInt(coded[1]!, 10);
    throw new Error(`${label} "${raw}" is not an id. Pass the numeric id (list_releases / list_sprints) — a name is not accepted, so the run is not silently left unlinked.`);
  }

  async startRun(target: RunTarget, opts: RunOptions): Promise<RunRef> {
    const projectId = this.requireProjectId();
    if (target.suiteId && !target.tcId) {
      return this.startSuiteRun(target.suiteId, opts);
    }
    if (!target.tcId) {
      throw new Error('startRun: target.tcId (or target.suiteId) is required.');
    }
    const tcId = target.tcId;
    const tcNum = Number.parseInt(numericId(tcId), 10);
    if (!Number.isFinite(tcNum)) throw new Error(`startRun: could not resolve numeric id for ${tcId}.`);

    const mode = (opts.mode ?? 'local').toUpperCase();
    // LOCAL fast-fail: the desktop agent is what actually executes the TC (it polls the Redis queue
    // the backend RPUSHes to). If :4040 isn't up, no roster / customer-search / dispatch will help —
    // fail here with a clear message instead of enqueuing a job nothing will drain.
    if (mode === 'LOCAL') {
      const probe = await this.probeLocalAgentDetailed();
      if (!probe.up) {
        throw new Error(
          `startRun (LOCAL): could not reach the SimplifyQA desktop agent at ${probe.url ?? '(no URL)'} ` +
          `just now (${probe.reason ?? 'unknown'}) — checked live at dispatch, not from earlier in this chat. ` +
          `If the agent shows Online in the SimplifyQA UI, retry once; otherwise start the desktop agent. ` +
          `Use mode:'cloud' to run on a cloud runner instead — it does not need the desktop agent.`,
        );
      }
    }
    const rawTc = await this.fetchRawTestcase(tcId);
    if (!rawTc || Object.keys(rawTc).length === 0) {
      throw new Error(`startRun: test case ${tcId} not found.`);
    }

    // Version resolution. When the caller supplies an override we accept EITHER the version id or
    // its name (matches the ask-user UX — a human types "v2.0", not a uuid) and hard-fail if it
    // resolves to nothing. Silent fallback would send a mismatched {versionId, versionName} to
    // /exec/execution: at best the backend 500s, at worst it silently runs the TC's current
    // version instead of the one asked for. No override → the existing fallback chain picks the
    // TC's current version, matching the UI's Version-chip default.
    const versions: any[] = Array.isArray(rawTc?.versions) ? rawTc.versions : [];
    let versionName: string | undefined;
    let versionId: string | undefined;
    if (opts.versionId) {
      const picked = versions.find((v: any) => {
        const vid = str(v, 'id', '_id');
        const vname = str(v, 'name');
        return vid === opts.versionId || vname === opts.versionId;
      });
      if (!picked) {
        if (!versions.length) {
          throw new Error(
            `startRun: test case ${tcId} has no versions available — cannot pin version "${opts.versionId}".`,
          );
        }
        const listing = versions
          .map((v: any) => `  • \`${str(v, 'id', '_id')}\` — ${str(v, 'name')}`)
          .join('\n');
        throw new Error(
          `startRun: version "${opts.versionId}" not found on ${tcId}. Available:\n${listing}`,
        );
      }
      versionId = str(picked, 'id', '_id');
      versionName = str(picked, 'name');
    } else {
      versionName = str(rawTc, 'versionName', 'selectedVersionName');
      versionId = str(rawTc, 'versionId', 'selectedVersionId');
      if ((!versionName || !versionId) && rawTc?.versionsDetails && typeof rawTc.versionsDetails === 'object') {
        versionName ??= str(rawTc.versionsDetails, 'name');
        versionId ??= str(rawTc.versionsDetails, 'id', '_id', 'versionId');
      }
      if ((!versionName || !versionId) && versions.length > 0) {
        versionName ??= str(versions[0], 'name');
        versionId ??= str(versions[0], 'id', '_id');
      }
      versionName ??= 'v1.0';
      versionId ??= '';
    }

    // ponytail: was `this.info()` — 5 round-trips (list_projects + 4 counts) for one field, and
    // returned projectName="" when the current project wasn't in the first 100-row page or was
    // filtered by API-key scope, which the /exec/execution endpoint rejects with HTTP 400.
    const projectName = await this.lookupProjectName(projectId);
    if (!projectName) {
      throw new Error(
        `startRun: could not resolve project name for projectId=${projectId}. ` +
        `The token may not have read access to this project.`,
      );
    }
    const env = await this.resolveEnvironment(projectId, opts.environment);
    const tcType = String(str(rawTc, 'tcType') ?? 'WEB').toUpperCase();
    const executionType = String(str(rawTc, 'executionType') ?? 'AUTOMATION').toUpperCase();
    const code = str(rawTc, 'code') ?? '';
    const name = str(rawTc, 'name', 'title') ?? '';
    const description = str(rawTc, 'description') ?? '';
    const prerequisite = str(rawTc, 'prerequisite', 'preconditions') ?? '';
    const moduleIdNum = typeof rawTc?.moduleId === 'number' ? rawTc.moduleId : 0;
    const userstoryIdNum = typeof rawTc?.userstoryId === 'number' ? rawTc.userstoryId : 0;
    const tags = Array.isArray(rawTc?.tags) ? rawTc.tags : [];

    // Best-effort module name — targeted id lookup (not a full listModules scan, which now caps
    // at the default 100). Story name deliberately left empty; adds a per-run round-trip for a
    // cosmetic field. ponytail: enrich if a caller ever complains.
    let moduleName = '';
    if (moduleIdNum > 0) {
      try {
        const body = this.searchBody(
          [{ column: 'id', value: moduleIdNum }, { column: 'deleted', value: false }],
          { selectFields: ['id', 'name'], limit: 1 },
        );
        const raw = await this.http.postJson<any>('/pm/module/search', body);
        const rows = pickArray(raw, 'data', 'content', 'modules');
        moduleName = str(rows[0], 'name') ?? '';
      } catch { /* leave empty */ }
    }

    const agentId = mode === 'LOCAL' ? await this.resolveLocalAgentId(opts.agentId)
                  : mode === 'REMOTE' ? await this.resolveRemoteAgentId(opts.agentId)
                  : null;
    // Multi-device parallel: when opts.devices has >1 entry, build one executionItem per device
    // under a SINGLE execution with executionStyle PARALLEL — matching the UI's multi-device flow.
    const isMultiDevice = opts.devices && opts.devices.length > 1;

    let executionItems: Array<Record<string, unknown>>;
    if (isMultiDevice) {
      executionItems = opts.devices!.map((dev, idx) => {
        const devPlatform = this.buildRunPlatform(tcType, mode, {
          deviceId: dev.deviceId,
          ...(dev.deviceName ? { deviceName: dev.deviceName } : {}),
          ...(dev.deviceType ? { deviceType: dev.deviceType } : {}),
          ...(dev.osVersion ? { osVersion: dev.osVersion } : {}),
          ...(dev.cloudDeviceType ? { cloudDeviceType: dev.cloudDeviceType } : {}),
        });
        const devStepId = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
        return {
          id: tcNum,
          name,
          description,
          versionId,
          versionName,
          seq: idx + 1,
          stepId: devStepId,
          stepCount: 0,
          technologyType: tcType,
          type: 'TC',
          platform: devPlatform,
          projectId,
          projectName,
          configuration: {},
          iterationsSelected: [],
          moduleId: moduleIdNum,
          userstoryId: userstoryIdNum,
          tags,
          code,
          prerequisite,
          moduleName,
          userstoryName: '',
        };
      });
    } else {
      const platform = this.buildRunPlatform(tcType, mode, {
        ...(opts.browser !== undefined ? { browser: opts.browser } : {}),
        ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
        ...(opts.deviceName !== undefined ? { deviceName: opts.deviceName } : {}),
        ...(opts.deviceType !== undefined ? { deviceType: opts.deviceType } : {}),
        ...(opts.osVersion !== undefined ? { osVersion: opts.osVersion } : {}),
        ...(opts.cloudDeviceType !== undefined ? { cloudDeviceType: opts.cloudDeviceType } : {}),
      });
      // UI uses `Math.random().toString(26).substr(5,6)` — plan doc confirms any string works.
      const stepId = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
      executionItems = [{
        id: tcNum,
        name,
        description,
        versionId,
        versionName,
        seq: 1,
        stepId,
        stepCount: 0,
        technologyType: tcType,
        type: 'TC',
        platform,
        projectId,
        projectName,
        configuration: {},
        iterationsSelected: [],
        moduleId: moduleIdNum,
        userstoryId: userstoryIdNum,
        tags,
        code,
        prerequisite,
        moduleName,
        userstoryName: '',
      }];
    }

    // Multi-device → PARALLEL; otherwise respect caller's strategy (default SERIAL).
    const executionStyle = isMultiDevice ? 'PARALLEL' : (opts.strategy ?? 'serial').toUpperCase();

    const body: Record<string, unknown> = {
      projectId,
      agentId,
      environmentType: env,
      executionStyle,
      executionOS: this.detectExecutionOS(),
      executionTypeId: tcNum,
      executionTypeName: name,
      executionTypeCode: code,
      mailersList: {},
      cloudType: mode === 'CLOUD' ? normalizeCloudType(opts.cloudType) : 'NONE',
      mode,
      executionCategory: 'EXECUTION',
      releaseId: this.idOrZero('releaseId', opts.releaseId),
      iterationId: this.idOrZero('sprintId', opts.sprintId),
      executionTime: '',
      status: 'INPROGRESS',
      iterationsSelected: [],
      result: '',
      globalConfiguration: {},
      isRecordingEnabled: false,
      offset: -(new Date().getTimezoneOffset()),
      type: 'TESTCASE',
      executionType,
      executionItems,
    };

    const resp = await this.http.postJson<any>('/exec/execution', body);
    const d: any = resp?.data ?? resp;
    const runId =
      str(d, 'id', 'executionId', '_id') ??
      (typeof d?.id === 'number' ? String(d.id) : undefined) ??
      (typeof d?.executionId === 'number' ? String(d.executionId) : undefined);
    if (!runId) throw new Error('startRun: backend accepted trigger but returned no run id.');
    await this.assertRunMode(runId, mode, mode === 'REMOTE' ? agentId : null);
    return { runId, reportUrl: this.runReportUrl('TESTCASE', tcNum, runId, projectId) };
  }

  /**
   * Read the created execution back and make sure the backend stored the mode (and, for REMOTE, the
   * agent) the caller asked for. Every hop — agent `start_run`, a cached config, a backend rewrite —
   * used to be able to turn a REMOTE run into a LOCAL one silently, which only surfaced later as
   * "LOCAL-SERIAL" in the report. Fail at dispatch instead. Best-effort: a read failure (mock, older
   * backend, transient 5xx) never blocks a run that the POST already accepted.
   */
  private async assertRunMode(runId: string, requestedMode: string, requestedAgentId: string | null): Promise<void> {
    const projectId = this.requireProjectId();
    const num = Number.parseInt(numericId(runId), 10);
    if (!Number.isFinite(num)) return;
    let doc: any;
    try {
      doc = await this.fetchExecDoc(num, projectId);
    } catch {
      return;
    }
    if (!doc || typeof doc !== 'object') return;
    const actualMode = String(doc.mode ?? '').toUpperCase();
    if (actualMode && actualMode !== requestedMode) {
      throw new Error(
        `Run ${runId} was created with mode ${actualMode} instead of ${requestedMode} — the ` +
        `backend/agent ignored the requested execution mode. Stop it (run_stop) and re-dispatch, ` +
        `or dispatch through the direct REST connection (QA_BASE_URL + token) instead of the agent hop.`,
      );
    }
    if (requestedMode === 'REMOTE' && requestedAgentId) {
      const actualAgent = str(doc, 'agentId');
      if (actualAgent && actualAgent !== requestedAgentId) {
        throw new Error(
          `Run ${runId} was created with agentId ${actualAgent} instead of the requested ` +
          `${requestedAgentId} — the dispatch hop rewrote the target machine.`,
        );
      }
    }
  }

  async stopRun(runId: string): Promise<void> {
    const projectId = this.requireProjectId();
    const executionId = Number.parseInt(numericId(runId), 10);
    if (!Number.isFinite(executionId)) throw new Error(`stopRun: invalid runId ${runId}.`);
    // Mirror sqa-ui reports.component.ts:2041-2054: cloud-parallel needs a dedicated killType so
    // the backend fans the Redis kill out to every child agent (executions/…/execution.service.js
    // :4610-4657). Plain STOP_EXECUTION only pushes to the parent's agentId, leaving cloud-parallel
    // child VMs running even though their DB rows read FAILED.
    const doc = await this.fetchExecDoc(executionId, projectId);
    const mode = String(doc?.mode ?? '').toUpperCase();
    const style = String(doc?.executionStyle ?? '').toUpperCase();
    const killType = mode === 'CLOUD' && style === 'PARALLEL' ? 'STOP_EXECUTION_PARALLEL_CLOUD' : 'STOP_EXECUTION';
    await this.http.postJson<any>('/exec/execution/stopExecution', { projectId, executionId, killType });
  }

  /** SUITE dispatch. Mirrors `startRun` above (which handles TC) — same `/exec/execution` endpoint,
   *  same LOCAL-agent fast-fail, same project-name / environment resolution. What differs is on the
   *  wire: `type: 'SUITE'`, `executionType` sourced from `suite.suiteType`, `mode` defaulting to
   *  `suite.executionType`, a populated `globalConfiguration` block, and one `executionItems` entry
   *  PER member — each carrying the suite row's persisted `versionId` / `stepId` / `platform` / `seq`
   *  (NOT a re-derived random step id). See sqa-ui execution-popup-modal.component.ts:621-1105 SU
   *  branch for the authoritative UI builder; every field below traces back to a line there. */
  private async startSuiteRun(suiteId: string, opts: RunOptions): Promise<RunRef> {
    const projectId = this.requireProjectId();
    const suiteNum = Number.parseInt(numericId(suiteId), 10);
    if (!Number.isFinite(suiteNum)) throw new Error(`startRun: could not resolve numeric id for ${suiteId}.`);

    const rawSuite: any = await this.fetchRawSuite(suiteId);
    if (!rawSuite || Object.keys(rawSuite).length === 0) {
      throw new Error(`startRun: suite ${suiteId} not found.`);
    }
    // Effective mode: caller pick wins (matches our tool's cascade UX); fall back to the suite doc's
    // stored `executionType`, which the UI reads unconditionally (execution-popup-modal.ts:668).
    const mode = (opts.mode ?? String(rawSuite.executionType ?? 'LOCAL')).toUpperCase();
    if (mode === 'LOCAL') {
      const probe = await this.probeLocalAgentDetailed();
      if (!probe.up) {
        throw new Error(
          `startRun (LOCAL): could not reach the SimplifyQA desktop agent at ${probe.url ?? '(no URL)'} ` +
          `just now (${probe.reason ?? 'unknown'}) — checked live at dispatch, not from earlier in this chat. ` +
          `If the agent shows Online in the SimplifyQA UI, retry once; otherwise start the desktop agent. ` +
          `Use mode:'cloud' to run on a cloud runner instead — it does not need the desktop agent.`,
        );
      }
    }

    const projectName = await this.lookupProjectName(projectId);
    if (!projectName) {
      throw new Error(
        `startRun: could not resolve project name for projectId=${projectId}. ` +
        `The token may not have read access to this project.`,
      );
    }
    const env = await this.resolveEnvironment(projectId, opts.environment);
    const suiteType = String(rawSuite.suiteType ?? 'AUTOMATION').toUpperCase();

    // Build one executionItems entry per suite row, in suite order. Silently skip rows whose TC no
    // longer exists (matches UI :880 `if (!data) return;`). Every item uses the suite row's stored
    // versionId + stepId + per-mode platform — regenerating any of those splits step correlation
    // and breaks the agent's iteration join. Missing platform for a row is not an error here (UI
    // sends `[]`) — the agent tolerates it for MANUAL suites; AUTOMATION suites without a saved
    // platform were misconfigured upstream and would fail regardless.
    const members: any[] = Array.isArray(rawSuite.testCases) ? rawSuite.testCases : [];
    const executionItems: Array<Record<string, unknown>> = [];
    let seqCounter = 0;
    for (const row of members) {
      seqCounter++;
      const memberTcId = row?.testcaseId;
      if (memberTcId === undefined || memberTcId === null) continue;
      let rawTc: any;
      try {
        rawTc = await this.fetchRawTestcase(String(memberTcId));
      } catch { continue; }
      if (!rawTc || Object.keys(rawTc).length === 0) continue;

      const tcType = String(str(rawTc, 'tcType') ?? 'WEB').toUpperCase();
      const versions: any[] = Array.isArray(rawTc?.versions) ? rawTc.versions : [];
      const rowVersionId = row?.versionId ?? row?.version;
      const versionMatch = rowVersionId
        ? versions.find((v: any) => str(v, 'id', '_id') === String(rowVersionId) || str(v, 'name') === String(rowVersionId))
        : undefined;
      const versionId = str(versionMatch, 'id', '_id') ?? (rowVersionId !== undefined ? String(rowVersionId) : '');
      const versionName = str(versionMatch, 'name') ?? str(rawTc, 'versionName', 'selectedVersionName') ?? 'v1.0';

      // Per-mode platform from the suite row. UI reads `data1.executionPlatform[mode]` (:882-965);
      // when saved, it's a single object → wrap in `[obj]`; if the row didn't save one for this
      // mode, send `[]` and let the backend reject/accept per its own rules.
      const savedPlatform = row?.executionPlatform?.[mode];
      let platform: Array<Record<string, unknown>> = [];
      if (savedPlatform && typeof savedPlatform === 'object') {
        const p: Record<string, unknown> = {
          name: savedPlatform.name,
          id: savedPlatform.id ?? savedPlatform.name,
          technologyType: String(savedPlatform.technologyType ?? tcType).toUpperCase(),
          type: savedPlatform.type ?? 'NONE',
        };
        if (savedPlatform.cloudDeviceType) p['cloudDeviceType'] = savedPlatform.cloudDeviceType;
        if (savedPlatform.osVersion) p['osVersion'] = savedPlatform.osVersion;
        platform = [p];
      } else if (['API', 'MAINFRAME', 'SAP', 'DESKTOP', 'DATABASE'].includes(tcType)) {
        platform = [{ name: tcType, id: tcType, technologyType: tcType, type: 'NONE' }];
      }

      const moduleIdNum = typeof rawTc?.moduleId === 'number' ? rawTc.moduleId : 0;
      let moduleName = '';
      if (moduleIdNum > 0) {
        try {
          const body = this.searchBody(
            [{ column: 'id', value: moduleIdNum }, { column: 'deleted', value: false }],
            { selectFields: ['id', 'name'], limit: 1 },
          );
          const raw = await this.http.postJson<any>('/pm/module/search', body);
          const rows = pickArray(raw, 'data', 'content', 'modules');
          moduleName = str(rows[0], 'name') ?? '';
        } catch { /* leave empty */ }
      }

      executionItems.push({
        id: typeof rawTc?.id === 'number' ? rawTc.id : Number.parseInt(numericId(String(memberTcId)), 10),
        name: str(rawTc, 'name', 'title') ?? '',
        description: str(rawTc, 'description') ?? '',
        versionId,
        versionName,
        seq: typeof row?.seq === 'number' ? row.seq : seqCounter,
        stepId: row?.stepId ?? '',  // MUST come from the suite row, never regenerated
        stepCount: -1,               // suite items send -1 (TC sends 0)
        technologyType: tcType,
        type: 'TC',                  // every item is 'TC'; suite-ness lives at top-level type
        platform,
        projectId,
        projectName,
        configuration: {},
        iterationsSelected: [],
        moduleId: moduleIdNum,
        userstoryId: typeof rawTc?.userstoryId === 'number' ? rawTc.userstoryId : 0,
        tags: Array.isArray(rawTc?.tags) ? rawTc.tags : [],
        code: str(rawTc, 'code') ?? '',
        prerequisite: str(rawTc, 'prerequisite', 'preconditions') ?? '',
        moduleName,
        userstoryName: '',
      });
    }

    if (executionItems.length === 0) {
      throw new Error(
        `startRun: suite ${suiteId} has no runnable test cases (all members were deleted, ` +
        `unreadable, or filtered out).`,
      );
    }

    // agentId derivation (mirrors UI :677). LOCAL always uses this machine's agent; REMOTE/CLOUD
    // pin the suite doc's saved `agentId` (or null when the suite wasn't pinned). CLOUD_AGENT
    // fallback (:771-774) promotes `cloudType` to 'SQA'.
    let agentId: string | null;
    if (mode === 'LOCAL') {
      agentId = await this.resolveLocalAgentId(opts.agentId);
    } else if (mode === 'REMOTE') {
      const preferred = opts.agentId ?? (typeof rawSuite.agentId === 'string' ? rawSuite.agentId : undefined);
      agentId = preferred ? await this.resolveRemoteAgentId(preferred) : null;
    } else {
      agentId = typeof rawSuite.agentId === 'string' && rawSuite.agentId.length > 0 ? rawSuite.agentId : null;
    }
    let cloudType: 'NONE' | 'VM' | 'AZURE' | 'KUBERNETES' | 'SQA' = mode === 'CLOUD' ? normalizeCloudType(opts.cloudType) : 'NONE';
    if (!agentId && typeof rawSuite.cloudAgentId === 'string' && rawSuite.cloudAgentId.length > 0) {
      agentId = rawSuite.cloudAgentId;
      cloudType = 'SQA';
    }

    const body: Record<string, unknown> = {
      projectId,
      environmentType: env,
      executionStyle: (opts.strategy ?? 'serial').toUpperCase(),
      executionOS: this.detectExecutionOS(),
      executionTypeId: suiteNum,
      executionTypeName: str(rawSuite, 'name') ?? '',
      executionTypeCode: str(rawSuite, 'code') ?? '',
      mailersList: rawSuite.mailersList ?? {},
      cloudType,
      mode,
      executionCategory: 'EXECUTION',
      releaseId: this.idOrZero('releaseId', opts.releaseId),
      iterationId: this.idOrZero('sprintId', opts.sprintId),
      executionTime: '',
      status: 'INPROGRESS',
      iterationsSelected: [],
      result: '',
      globalConfiguration: suiteRunGlobalConfig(rawSuite, {
        terminateOnFailure: opts.terminateOnFailure,
        maxConcurrent: opts.maxConcurrent,
      }),
      isRecordingEnabled: false,
      offset: -(new Date().getTimezoneOffset()),
      type: 'SUITE',
      executionType: suiteType,
      agentId,
      executionItems,
    };

    const resp = await this.http.postJson<any>('/exec/execution', body);
    const d: any = resp?.data ?? resp;
    const runId =
      str(d, 'id', 'executionId', '_id') ??
      (typeof d?.id === 'number' ? String(d.id) : undefined) ??
      (typeof d?.executionId === 'number' ? String(d.executionId) : undefined);
    if (!runId) throw new Error('startRun: backend accepted suite trigger but returned no run id.');
    await this.assertRunMode(runId, mode, mode === 'REMOTE' ? agentId : null);
    return { runId, reportUrl: this.runReportUrl('SUITE', suiteNum, runId, projectId) };
  }


  /** GET the agent /mcp with a 1s timeout. Any HTTP response (incl. 4xx from an MCP server rejecting
   *  a naked GET) proves the process is up; connect/DNS/timeout errors mean it is down. Replaces
   *  the customer-wide `machineRegistration` round trip when all we needed was "is LOCAL possible?". */
  async probeLocalAgent(): Promise<boolean> {
    return (await this.probeLocalAgentDetailed()).up;
  }

  /** Live probe, never cached — every dispatch re-checks. A single 1s attempt misreported a busy-but-up
   *  agent as offline (the "agent offline mid-chain" report), so: 3s per attempt, one retry, and the
   *  failure reason is returned so callers can say WHY instead of a bare "not reachable". */
  async probeLocalAgentDetailed(): Promise<{ up: boolean; url?: string; reason?: string }> {
    const url = this.cfg.url;
    if (!url) return { up: false, reason: 'no agent URL configured (set QA_MCP_URL)' };
    let reason = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 3000);
      try {
        await fetch(url, { method: 'GET', signal: ac.signal });
        return { up: true, url };
      } catch (e) {
        reason = ac.signal.aborted ? 'no response within 3s' : (e instanceof Error ? ((e as { cause?: { message?: string } }).cause?.message ?? e.message) : String(e));
      } finally {
        clearTimeout(timer);
      }
    }
    return { up: false, url, reason };
  }

  async listCloudRunners(): Promise<CloudRunner[]> {
    const projectId = this.requireProjectId();
    // The CONFIGURED cloud machines (VM/Azure/Kubernetes), NOT /pm/machineResources/search — that lists
    // RUNTIME container instances, which are empty for an on-demand VM until a run actually spins one up,
    // so cloud was wrongly reported as "no runners" even though the project has a VM. This mirrors the
    // sqa-ui execution popup's getCloudVmSettings() EXACTLY: /pm/cloudMachines/search filtered on the
    // nested `projects.projectId`, with selectFields:["projects","type"] (the backend only joins/returns
    // the projects relation — which the nested filter resolves against — when it is selected; without it
    // the search comes back empty). A configured cloud machine spins containers on demand, so it has no
    // real "offline" state: treat IDLE/RUNNING/ACTIVE/blank as available so cloud runs aren't refused.
    const body = this.searchBody(
      [{ column: 'projects.projectId', value: projectId }],
      { selectFields: ['projects', 'type'], limit: 100000 },
    );
    const raw = await this.http.postJson<any>('/pm/cloudMachines/search', body);
    const rows = pickArray(raw, 'data', 'content');
    return rows
      // The UI re-filters client-side: a machine links to projects via a nested projects[] array
      // (numbers OR {projectId} objects); keep only machines assigned to THIS project.
      .filter((n: any) => {
        const projects = (n as any)?.projects;
        if (!Array.isArray(projects)) return true; // no list to filter on → don't exclude
        return projects.some((p: any) => (typeof p === 'number' ? p : p?.projectId) === projectId);
      })
      .map((n: any) => {
        const id = str(n, 'id', '_id') ?? '';
        const status = str(n, 'status') ?? '';
        const type = str(n, 'type', 'provider');
        const online = status === '' || status === 'IDLE' || status === 'RUNNING' || status === 'ACTIVE';
        return {
          id,
          name: str(n, 'name', 'displayName') ?? id,
          online,
          ...(status ? { status } : {}),
          ...(type ? { os: type } : {}),
          // Machine type the execution must ask for (VM / AZURE / KUBERNETES). The UI sends it as
          // `cloudType` on the run payload; without it every cloud run defaults to VM.
          ...(type ? { cloudType: type.toUpperCase() } : {}),
        };
      });
  }

  /** Gather every identifier this process can claim: bare hostname, non-loopback MAC addresses,
   *  non-loopback IPs. Cached per-adapter — network interfaces do not change mid-session. */
  private localIdsCache: { hostBare: string; macs: Set<string>; ips: Set<string> } | null = null;
  private getLocalIdentifiers(): { hostBare: string; macs: Set<string>; ips: Set<string> } {
    if (this.localIdsCache) return this.localIdsCache;
    const hostFull = os.hostname().toLowerCase();
    const hostBare = hostFull.replace(/\.(local|lan|localdomain)$/, '').split('.')[0] ?? hostFull;
    const macs = new Set<string>();
    const ips = new Set<string>();
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
      if (!list) continue;
      for (const iface of list) {
        if (iface.internal) continue;
        if (iface.mac && iface.mac !== '00:00:00:00:00:00') macs.add(iface.mac.toLowerCase());
        if (iface.address) ips.add(iface.address);
      }
    }
    this.localIdsCache = { hostBare, macs, ips };
    return this.localIdsCache;
  }

  /** Does a machineRegistration row belong to the machine this MCP is running on?
   *  A single positive match on hostname, MAC, or IP is enough — the local agent registers with
   *  ALL of these, but the surviving match on the SQA row depends on OS quirks (Windows writes a
   *  padded hostname, macOS writes `foo.local`, IPs shift on Wi-Fi handoff). Any one match is
   *  proof enough; we don't try to reconcile the others. */
  private isThisMachine(
    row: any,
    ids: { hostBare: string; macs: Set<string>; ips: Set<string> } = this.getLocalIdentifiers(),
  ): boolean {
    const name = (str(row, 'machineName', 'name', 'host') ?? '').toLowerCase();
    if (ids.hostBare.length > 0 && name.length > 0 && name.includes(ids.hostBare)) return true;
    const mac = (str(row, 'macAddress') ?? '').toLowerCase();
    if (mac.length > 0 && ids.macs.has(mac)) return true;
    const ip = str(row, 'ipAddress', 'hostAddress') ?? '';
    if (ip.length > 0 && ids.ips.has(ip)) return true;
    return false;
  }

  async listLocalAgents(): Promise<LocalAgent[]> {
    // ponytail: no projectId filter — machine_registration.projectId is never written by
    // test-management/services/machine_registration.service.js (create only stamps
    // machineName/systemName/macAddress/ipAddress/platform/customerId). Filtering by projectId
    // strips every legacy row. customerId scoping is still applied server-side from the JWT.
    const body = this.searchBody(
      [{ column: 'deleted', value: false }],
      { limit: 1000 },
    );
    const raw = await this.http.postJson<any>('/tm/machineRegistration/search', body);
    const rows = pickArray(raw, 'data', 'content', 'agents', 'machines');
    // ponytail: mirror sqa-ui/machine-registration.component.ts:169. The DB `active` flag is only
    // written to `true` on FIRST registration (fire-and-forget in executions/services/
    // executionQueue.service.js:49) and back to `false` by a 7s-stale cron. Every subsequent poll
    // is a no-op for the DB — a still-polling agent frequently shows `active:false`. Executions
    // service is off-limits for the fix, so when the row belongs to THIS machine (any of hostname
    // / MAC / IP matches), trust that over the stale DB flag.
    const ids = this.getLocalIdentifiers();
    return rows.map((n: any) => {
      const id = str(n, 'id', '_id', 'agentId') ?? '';
      const agentName = str(n, 'machineName', 'name', 'host');
      const owner = str(n, 'owner', 'userName', 'createdBy');
      const hostAddr = str(n, 'macAddress', 'hostAddress');
      const dbActive = typeof n?.active === 'boolean' ? n.active : false;
      const isMyBox = this.isThisMachine(n, ids);
      return {
        id,
        ...(agentName ? { name: agentName } : {}),
        online: dbActive || isMyBox,
        ...(isMyBox ? { isThisMachine: true } : {}),
        ...(owner ? { owner } : {}),
        ...(hostAddr ? { host: hostAddr } : {}),
      };
    });
  }

  /** Mobile devices for the project — the union of:
   *  (a) the LOCAL roster from `/tm/mobileDevices/search` (adb-visible reals, emulators,
   *      simulators registered via the desktop agent) — same source the UI's "Real Devices /
   *      Emulators / Simulators" tabs read; `active` is a last-known connection flag stale by
   *      design (the desktop agent writes it, a 7s-stale cron flips it back).
   *  (b) the CLOUD roster from whichever farm the project has integrated — probed in the same
   *      order as the UI (`execution-popup-modal-v2.component.ts:198-204`): LambdaTest,
   *      BrowserStack, SauceLabs, SimplifyQA Device Farm. First provider that answers with a
   *      non-empty list wins (matches the UI's `mobileIntergation.type` single-provider model —
   *      one cloud provider per project). Cloud rows carry `deviceType:'CLOUD_DEVICE'` and a
   *      `cloudDeviceType` tag so `tc_run` knows which farm to submit to.
   *  A failure fetching one source doesn't kill the other — the tool logs and returns whatever
   *  it could resolve. */
  async listMobileDevices(platform: 'ANDROID' | 'IOS'): Promise<MobileDevice[]> {
    const local = await this.fetchLocalMobileDevices(platform).catch(() => []);
    const cloud = await this.fetchCloudMobileDevices(platform).catch(() => []);
    return [...local, ...cloud];
  }

  private async fetchLocalMobileDevices(platform: 'ANDROID' | 'IOS'): Promise<MobileDevice[]> {
    const body = this.searchBody(
      [
        { column: 'deleted', value: false },
        { column: 'technologyType', value: platform },
      ],
      { limit: 1000 },
    );
    const raw = await this.http.postJson<any>('/tm/mobileDevices/search', body);
    const rows = pickArray(raw, 'data', 'content', 'devices');
    return rows.map((n: any): MobileDevice => {
      const id = str(n, 'deviceId', 'udid', 'id', '_id') ?? '';
      const name = str(n, 'deviceName', 'name', 'model') ?? id;
      const rawType = String(str(n, 'deviceType') ?? 'REAL_DEVICE').toUpperCase();
      // SQA stores "REAL" | "EMULATOR" | "SIMULATOR" — normalise "REAL" → "REAL_DEVICE" so the
      // adapter's downstream wire mapping stays consistent with the executor's enum.
      const deviceType: MobileDevice['deviceType'] =
        rawType === 'REAL' ? 'REAL_DEVICE'
        : (rawType as MobileDevice['deviceType']);
      const osVersion = str(n, 'osVersion');
      const status = str(n, 'status');
      const agentId = str(n, 'agentId');
      // Build a full display name: Manufacturer-Model-Serial (e.g. "Oppo-Cph2375-Ab1fe936").
      // The backend may store manufacturer/brand; fall back to model+id when unavailable.
      // Also check 'make' (some backends use that field name for manufacturer).
      const manufacturer = str(n, 'manufacturer', 'brand', 'make');
      const model = str(n, 'model', 'deviceName', 'name') ?? '';
      const parts: string[] = [];
      if (manufacturer) parts.push(manufacturer);
      if (model && model !== id) parts.push(model);
      if (id) parts.push(id);
      const displayName = parts.length > 1 ? parts.join('-') : undefined;
      // Diagnostic: log raw device fields so we can verify what the backend returns.
      log(`[mcp][devices] local device: id=${id} name=${name} manufacturer=${manufacturer ?? '(none)'} model=${model} displayName=${displayName ?? '(none)'} raw_keys=${Object.keys(n).join(',')}`);

      return {
        id, name, platform, deviceType,
        ...(displayName ? { displayName } : {}),
        ...(osVersion ? { osVersion } : {}),
        ...(typeof n?.active === 'boolean' ? { active: n.active } : {}),
        ...(status ? { status } : {}),
        ...(agentId ? { agentId } : {}),
      };
    });
  }

  /** Probe cloud farms in the UI's order and return the first non-empty match. One provider per
   *  project (the UI's `mobileIntergation.type` model), so no need to merge across farms. Every
   *  fetch is wrapped so a 404/401 from one provider doesn't kill the whole list. */
  private async fetchCloudMobileDevices(platform: 'ANDROID' | 'IOS'): Promise<MobileDevice[]> {
    // Order matches execution-popup-modal-v2:198-204 (SauceLabs → BrowserStack → LambdaTest).
    // SQA Device Farm is the fallback the UI only reaches when LambdaTest is inactive (line 203).
    const attempts: Array<[MobileDevice['cloudDeviceType'], () => Promise<MobileDevice[]>]> = [
      ['SAUCE_LABS', () => this.fetchSauceLabsMobileDevices(platform)],
      ['BROWSER_STACK', () => this.fetchBrowserStackMobileDevices(platform)],
      ['LAMBDA_TEST', () => this.fetchLambdaTestMobileDevices(platform)],
      ['SIMPLIFY_QA_DEVICE_FORM', () => this.fetchDeviceFarmMobileDevices(platform)],
    ];
    for (const [, fetcher] of attempts) {
      const rows = await fetcher().catch(() => [] as MobileDevice[]);
      if (rows.length) return rows;
    }
    return [];
  }

  private async fetchSauceLabsMobileDevices(platform: 'ANDROID' | 'IOS'): Promise<MobileDevice[]> {
    const projectId = this.requireProjectId();
    const raw = await this.http.getJson<any>(
      `/tm/marketPlace/sauceLabsDevices/SAUCE_LABS?projectId=${encodeURIComponent(projectId)}`,
    );
    const rows = pickArray(raw, 'data', 'content', 'devices');
    // SauceLabs returns OS as UPPERCASE ("IOS"/"ANDROID") — mirror execution-popup-modal-v2:447-448.
    const wanted = platform.toUpperCase();
    return rows
      .filter((n: any) => String(n?.os ?? '').toUpperCase() === wanted)
      .map((n: any): MobileDevice => {
        const id = str(n, 'id', 'udid', 'name') ?? '';
        const name = str(n, 'name', 'deviceName', 'model') ?? id;
        const osVersion = str(n, 'osVersion', 'os_version');
        return {
          id, name, platform, deviceType: 'CLOUD_DEVICE', cloudDeviceType: 'SAUCE_LABS',
          ...(osVersion ? { osVersion } : {}),
        };
      });
  }

  private async fetchBrowserStackMobileDevices(platform: 'ANDROID' | 'IOS'): Promise<MobileDevice[]> {
    const projectId = this.requireProjectId();
    const raw = await this.http.getJson<any>(
      `/tm/testdata/browserStackDevices/BROWSER_STACK?projectId=${encodeURIComponent(projectId)}`,
    );
    const rows = pickArray(raw, 'data', 'content', 'devices');
    // BrowserStack returns OS as lowercase ("ios"/"android") — mirror execution-popup-modal-v2:434-435.
    const wanted = platform.toLowerCase();
    return rows
      .filter((n: any) => String(n?.os ?? '').toLowerCase() === wanted)
      .map((n: any): MobileDevice => {
        const id = str(n, 'id', 'device') ?? '';
        const name = str(n, 'device', 'name') ?? id;
        const osVersion = str(n, 'os_version', 'osVersion');
        return {
          id, name, platform, deviceType: 'CLOUD_DEVICE', cloudDeviceType: 'BROWSER_STACK',
          ...(osVersion ? { osVersion } : {}),
        };
      });
  }

  private async fetchLambdaTestMobileDevices(platform: 'ANDROID' | 'IOS'): Promise<MobileDevice[]> {
    const projectId = this.requireProjectId();
    const raw = await this.http.getJson<any>(
      `/tm/marketPlace/lambdaTestDevices/LAMBDA_TEST?projectId=${encodeURIComponent(projectId)}`,
    );
    const rows = pickArray(raw, 'data', 'content', 'devices');
    // LambdaTest returns OS as lowercase in `platformName`/`os` — mirror the mapping in
    // execution-popup-modal-v2:472-493 (which composes a friendly display name + slug id).
    const wantedLower = platform.toLowerCase();
    const seen = new Set<string>();
    const mapped: MobileDevice[] = [];
    for (const d of rows) {
      const os = String(d?.platformName ?? d?.os ?? '').toLowerCase();
      if (os !== wantedLower) continue;
      const baseName = str(d, 'deviceName', 'name') ?? '';
      const version = str(d, 'version', 'platformVersion', 'osVersion') ?? '';
      const displayName = version
        ? `${baseName} (${os === 'ios' ? 'iOS' : 'Android'} ${version})`
        : baseName;
      const udid = str(d, 'udid');
      const slug = `${baseName}_${version}_${os}`.toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
      const id = udid ? `cloud_${udid}` : `cloud_${slug}`;
      if (seen.has(id)) continue;
      seen.add(id);
      mapped.push({
        id, name: displayName, platform, deviceType: 'CLOUD_DEVICE', cloudDeviceType: 'LAMBDA_TEST',
        ...(version ? { osVersion: version } : {}),
      });
    }
    return mapped;
  }

  private async fetchDeviceFarmMobileDevices(platform: 'ANDROID' | 'IOS'): Promise<MobileDevice[]> {
    const projectId = this.requireProjectId();
    // SimplifyQA Device Farm is Appium-backed — endpoint mirrors marketPlace.route.js:25. The UI's
    // `getCloudFormDevicesForExec()` reads the same source when LambdaTest is inactive.
    const raw = await this.http.getJson<any>(
      `/tm/marketPlace/deviceFarmDevices/SIMPLIFY_QA_DEVICE_FORM?projectId=${encodeURIComponent(projectId)}`,
    );
    const rows = pickArray(raw, 'data', 'content', 'devices');
    // Farm rows include `platform` (ANDROID/IOS) and `sdk` (osVersion). Mirror device-dropdown.ts:413-419.
    const wanted = platform.toUpperCase();
    return rows
      .filter((n: any) => String(n?.platform ?? '').toUpperCase() === wanted)
      .map((n: any): MobileDevice => {
        const id = str(n, 'udid', 'id') ?? '';
        const name = str(n, 'name', 'deviceName') ?? id;
        const osVersion = str(n, 'sdk', 'osVersion');
        return {
          id, name, platform, deviceType: 'CLOUD_DEVICE', cloudDeviceType: 'SIMPLIFY_QA_DEVICE_FORM',
          ...(osVersion ? { osVersion } : {}),
        };
      });
  }

  /**
   * Pick THE ACTING USER'S OWN agent — never row [0] of a shared-tenant roster (which would
   * silently dispatch a local run to a teammate's box, and the run would sit queued until TTL
   * because it lands in a Redis key that no local agent on the caller's machine polls).
   *
   * SQA's `machineRegistration` row carries no owner_user_id column (unlike walnut, which matches
   * the JWT `id` claim to `owner_user_id`), so we identify "your" agent by physical identity:
   * hostname, MAC address, or IP — any one match against `os.networkInterfaces()` on the box this
   * MCP is running on. When exactly one row is "this machine", pick it regardless of the DB
   * `active` flag (that flag is stale by design — see listLocalAgents for the executionQueue bug).
   *
   * ponytail: multi-identifier heuristic. Upgrade to owner-user-id match if the backend adds that
   * column to machineRegistration (mirror walnut's `resolveLocalAgentCredential` at that point).
   */
  private async resolveLocalAgentId(preferred?: string): Promise<string> {
    const agents = await this.listLocalAgents();
    if (agents.length === 0) {
      throw new Error(
        'startRun (LOCAL): no local agent registered. Register a machine in the SimplifyQA UI ' +
        'first, or pass mode: "cloud" if a cloud runner is provisioned.',
      );
    }
    // Priority 1: rows that physically match this machine. Ignore the DB `active` flag — a running
    // agent frequently shows `active:false` between the 5s stale-cron and the next heartbeat, and
    // the executions service is off-limits for the real fix.
    const mine = agents.filter((a) => a.isThisMachine);
    // Explicit agentId: only accept it when it belongs to THIS machine. LOCAL dispatches to the
    // desktop agent on this box (there is exactly one per machine); a teammate's credentialId under
    // mode:'local' was the silent-misroute bug isThisMachine exists to prevent.
    if (preferred && preferred.length > 0) {
      if (mine.some((a) => a.id === preferred)) return preferred;
      const listing = agents.map((a) => `  - ${a.name ?? a.id} \`${a.id}\`${a.isThisMachine ? ' (this machine)' : ''}`).join('\n');
      throw new Error(
        `startRun (LOCAL): agentId "${preferred}" is not registered from THIS machine. LOCAL mode ` +
        `dispatches to this box's own desktop agent — teammate agents are for a REMOTE run. ` +
        `Omit agentId to auto-pick this machine's agent, or use mode:'cloud' for a cloud runner.\n` +
        `Registered agents:\n${listing}`,
      );
    }
    if (mine.length === 1) return mine[0]!.id;
    if (mine.length > 1) {
      const listing = mine.map((a) => `  - ${a.name ?? a.id} \`${a.id}\``).join('\n');
      throw new Error(
        `startRun (LOCAL): multiple agents registered from this machine. Pass \`agentId\` to ` +
        `pick one:\n${listing}`,
      );
    }
    // No physical match for this machine and no preferred — LOCAL cannot proceed.
    const roster = agents.map((a) => `  - ${a.name ?? a.id} \`${a.id}\`${a.online ? '' : ' (offline)'}`).join('\n');
    throw new Error(
      `startRun (LOCAL): no agent registered from this machine (hostname / MAC / IP did not match ` +
      `any row). Launch the SimplifyQA desktop agent on this box, or use mode:'remote' to run on a ` +
      `teammate's agent.\nRegistered agents:\n${roster}`,
    );
  }

  /** REMOTE dispatches to ANOTHER machine's desktop agent — must pin a specific credentialId (auto-pick
   *  across machines is the exact silent-misroute this exists to prevent). Enforces:
   *  (1) preferred is present, (2) it exists in the roster, (3) it is NOT this machine. A "remote" run
   *  aimed at this box would execute on the same agent LOCAL uses, so its report would read REMOTE
   *  while the work happened here — reject it and let the caller choose LOCAL or another machine. */
  private async resolveRemoteAgentId(preferred?: string): Promise<string> {
    if (!preferred || preferred.length === 0) {
      throw new Error(
        `startRun (REMOTE): agentId is required. REMOTE dispatches to a specific machine — ` +
        `there is no auto-pick. Call remote_agents to see the roster and pass one as \`agentId\`.`,
      );
    }
    const agents = await this.listLocalAgents();
    const picked = agents.find((a) => a.id === preferred);
    if (!picked) {
      throw new Error(
        `startRun (REMOTE): agentId "${preferred}" is not a registered agent. Call remote_agents ` +
        `for the current roster.`,
      );
    }
    if (picked.isThisMachine) {
      throw new Error(
        `startRun (REMOTE): agentId "${preferred}" is THIS machine's own agent — use mode:'local' ` +
        `for a run on this box, or pick a different machine for a REMOTE run.`,
      );
    }
    return preferred;
  }

  private detectExecutionOS(): 'WINDOWS' | 'MAC' | 'LINUX' {
    if (process.platform === 'win32') return 'WINDOWS';
    if (process.platform === 'darwin') return 'MAC';
    return 'LINUX';
  }

  private buildRunPlatform(
    tcType: string, mode: string, opts: {
      browser?: string; deviceId?: string; deviceName?: string; deviceType?: string;
      osVersion?: string; cloudDeviceType?: string;
    },
  ): Array<Record<string, unknown>> {
    const t = tcType.toUpperCase();
    if (t === 'WEB') {
      if (mode === 'CLOUD') {
        const key = `${(opts.browser ?? 'CHROME').toUpperCase()}_HEADLESS`;
        return [{ name: key, id: key, technologyType: 'WEB', type: 'NONE' }];
      }
      const b = (opts.browser ?? 'CHROME').toUpperCase();
      return [{ name: b, id: b, technologyType: 'WEB', type: 'NONE' }];
    }
    if (t === 'ANDROID' || t === 'IOS') {
      // Executor's AndroidSessionFactory.buildLocal calls requireDeviceId — no default. Fail
      // loud so the caller sees the fix (list devices, pick one) instead of a queued/error hang.
      if (!opts.deviceId) {
        throw new Error(
          `${t} test cases need \`deviceId\`. Call mobile_list_devices to see the available ` +
          `devices, then re-run with \`deviceId\` set to the adb serial (LOCAL) or marketplace ` +
          `device name (CLOUD).`,
        );
      }
      // Default LOCAL to REAL_DEVICE when caller doesn't say — mirrors the pre-deviceType shape.
      // CLOUD gets CLOUD_DEVICE for the same reason. Explicit deviceType wins over both.
      const type = opts.deviceType ?? (mode === 'CLOUD' ? 'CLOUD_DEVICE' : 'REAL_DEVICE');
      const isCloud = type.startsWith('CLOUD_');
      // ponytail: LambdaTest cloud runs work without app-URL preload for most flows — the
      // executor derives creds from the project's LT integration server-side. If a run fails
      // with "app not found" we'll port the UI's preloadLambdaAppMap flow (execution-popup-
      // modal-v2:613-641) and stamp appUrl/userName/accessKey here.
      const platformName = opts.deviceName || opts.deviceId;
      log(`[mcp][platform] buildRunPlatform: deviceName=${opts.deviceName ?? '(none)'} deviceId=${opts.deviceId} → platform.name=${platformName}`);
      return [{
        name: platformName, id: opts.deviceId, technologyType: t, type,
        ...(opts.osVersion ? { osVersion: opts.osVersion } : {}),
        ...(isCloud && opts.cloudDeviceType ? { cloudDeviceType: opts.cloudDeviceType } : {}),
      }];
    }
    return [{ name: t, id: t, technologyType: t, type: 'NONE' }];
  }

  // --- Environments + datasets -------------------------------------------
  /** Direct REST — same endpoint `resolveEnvironment` uses. Works without an agent hop.
   *  `key` is what testdata iterations store as `environmentType`; `id` is the uuid used by run dispatch. */
  async listEnvironments(): Promise<EnvInfo[]> {
    const projectId = this.requireProjectId();
    // Let fetch failures propagate rather than reading as "zero environments".
    const raw = await this.http.getJson<any>(`/pm/fields/8?projectId=${projectId}&fieldType=environment`);
    const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
    const out: EnvInfo[] = [];
    for (const e of arr) {
      if (!e || typeof e !== 'object' || e.deleted) continue;
      const key = str(e, 'key', 'value') ?? '';
      const name = str(e, 'name', 'label') ?? key;
      const id = str(e, 'id', '_id') ?? key;
      if (!key && !name) continue;
      out.push({ id, name, key, ...(key === 'general' ? { isDefault: true } : {}) });
    }
    return out;
  }
  async listDatasets(tcId?: string): Promise<DatasetInfo[]> {
    const h = this.hop();
    return h?.listDatasets ? h.listDatasets(tcId) : [];
  }

  // --- Journal (recording seed lives on the agent's FS) ------------------
  // The agent keeps the recording journal. When it is NOT reachable (not running / no URL) the steps are
  // still readable and editable straight from the backend, the same way the SQA UI does it — so these two
  // fall back to REST instead of failing. When the agent IS up its behaviour is unchanged.
  private agentUnreachable(e: unknown): boolean {
    const m = e instanceof Error ? e.message : String(e);
    return /Could not reach the product MCP|fetch failed|ECONNREFUSED/i.test(m);
  }

  async readJournal(tcId: string): Promise<JournalView> {
    const h = this.hop();
    if (h) {
      try { return await h.readJournal(tcId); } catch (e) { if (!this.agentUnreachable(e)) throw e; }
    }
    return this.stepsView(tcId);
  }

  async editJournal(tcId: string, ops: JournalOp[]): Promise<JournalView> {
    // Every step-editing op is applied straight to the saved test case. Sent through the agent, an edit
    // either opened the recorder window (SCRPY) and never landed, or — as with a plain `update_step` on
    // a saved TC — hit the agent's JOURNAL editor, which only knows recording journals and rejected a
    // test-case id with "update_step: n out of range". Only ops this module cannot apply itself
    // (wrap_in_if / wrap_in_loop / …) still take the hop.
    const direct = new Set(['set_meta', 'add_step', 'update_step', 'update_steps', 'add_assertions', 'remove_step', 'remove_steps', 'move_step', 'insert_nested', 'duplicate_step']);
    // main's narrow condition (add/duplicate/update_steps/api-edit) is superseded: every op this set
    // covers is now applied directly, which also fixes the plain `update_step` on a saved TC.
    if (ops.length > 0 && ops.every((o) => direct.has(o.op))) {
      return this.editStepsDirect(tcId, ops);
    }
    const h = this.hop();
    if (h) {
      try { return await h.editJournal(tcId, ops); } catch (e) {
        // Fall back to the saved steps when the agent is unreachable OR its journal does not know
        // these steps at all (a TC created from a draft/journey rather than recorded has no journal
        // entries, and the agent answers "update_step: n out of range"). Anything else is a real error.
        const m = e instanceof Error ? e.message : String(e);
        const journalMiss = /out of range|no step\s+\d+|step\s+\d+\s+(?:not found|does not exist)/i.test(m);
        if (!this.agentUnreachable(e) && !journalMiss) throw e;
      }
    }
    return this.editStepsDirect(tcId, ops);
  }

  private async stepsView(tcId: string): Promise<JournalView> {
    const tc = await this.getTestCase(tcId);
    return { tcId, source: 'steps', steps: tc.steps ?? [] };
  }

  /** Agent-free step edit: read the test case, apply remove / update / move by step number, renumber, and
   *  save through updateTestCase (which sends removed steps back with `deleted:true`, as the UI does). */
  private async editStepsDirect(tcId: string, ops: JournalOp[]): Promise<JournalView> {
    let tc = await this.getTestCase(tcId);
    log(`[mcp][editStepsDirect] tcId=${tcId} technologyType=${tc.technologyType ?? '(none)'} executionPlatform=${tc.executionPlatform ? JSON.stringify(tc.executionPlatform) : '(none)'} steps=${tc.steps?.length ?? 0} ops=${ops.map(o => o.op).join(',')}`);
    let steps = [...(tc.steps ?? [])];
    for (const op of ops) {
      if (op.op === 'set_meta') {
        // Test-case metadata is a plain REST update — it must never need the agent. `steps` is
        // deliberately stripped: steps are managed only by the step ops below.
        const metaPatch = { ...(op.patch as Record<string, unknown>) };
        delete metaPatch['steps'];
        tc = { ...tc, ...metaPatch } as typeof tc;
      } else if (op.op === 'remove_step') {
        if (!steps.some((x) => x.n === op.n)) throw new Error(`remove_step: no step ${op.n} on ${tcId} (it has ${steps.length}).`);
        steps = steps.filter((x) => x.n !== op.n);
      } else if (op.op === 'remove_steps') {
        // Bulk delete — resolved against the CURRENT steps, so the caller can pass a range in any
        // order without renumbering surprises. One save; unrelated steps are untouched.
        const want = new Set(op.numbers);
        const missing = [...want].filter((n) => !steps.some((x) => x.n === n));
        if (missing.length) throw new Error(`remove_steps: no step ${missing.join(', ')} on ${tcId} (it has ${steps.length}).`);
        steps = steps.filter((x) => !want.has(x.n));
      } else if (op.op === 'add_assertions') {
        // Append assertions to an EXISTING API step — nothing else on the step (object / action /
        // parameters / request / existing assertions) is touched. This is the deterministic form of
        // `update_step { patch: { api: { addAssertions } } }`, so an agent asked to "add only the
        // assertions" cannot accidentally rebuild the step.
        const i = steps.findIndex((x) => x.n === op.n);
        if (i < 0) throw new Error(`add_assertions: no step ${op.n} on ${tcId} (it has ${steps.length}).`);
        const cur = steps[i]!;
        const rawApi = (cur.sourceRaw as Record<string, unknown> | undefined)?.['apiData'];
        if (cur.stepType !== 'api' && !(cur.api && typeof cur.api === 'object') && !(rawApi && typeof rawApi === 'object')) {
          throw new Error(`add_assertions: step ${op.n} on ${tcId} is a ${cur.stepType} step, not an API step — assertions only exist on API steps.`);
        }
        steps[i] = { ...cur, api: mergeApiPatch(cur, { api: { addAssertions: op.assertions } } as Partial<Step>) } as Step;
      } else if (op.op === 'update_step' || op.op === 'update_steps') {
        // one step (update_step) or every step a bulk edit matches (update_steps) — each patched exactly the same way
        const targets = op.op === 'update_step' ? [op.n] : matchStepNumbers(steps, op.where);
        for (const n of targets) {
          const i = steps.findIndex((x) => x.n === n);
          if (i < 0) throw new Error(`update_step: no step ${n} on ${tcId} (it has ${steps.length}).`);
          const cur = steps[i]!;
          const patch = op.patch as Partial<Step>;
          steps[i] = {
            ...cur, ...patch,
            ...(patch.flags ? { flags: { ...cur.flags, ...patch.flags } } : {}),
            // api edits (assertions, URL, headers, body) change the saved request in place instead of replacing it
            ...(patch.api ? { api: mergeApiPatch(cur, patch) } : {}),
            // A patch that names an object but gives no id means "use THAT object": keeping the saved id (as a plain merge does)
            // would make the old object win and the change vanish.
            ...(patch.objectRef
              ? { objectRef: patch.objectRef.id === undefined && patch.objectRef.name ? { ...patch.objectRef } : { ...cur.objectRef, ...patch.objectRef } }
              : {}),
          } as Step;
          // A recorded step pins its action by plugin uniqueId, which the save prefers over the name — a changed
          // action must drop the old pin, or the new action name is silently ignored.
          if (patch.actionType !== undefined && patch.actionUniqueId === undefined) delete steps[i]!.actionUniqueId;
        }
      } else if (op.op === 'move_step') {
        const i = steps.findIndex((x) => x.n === op.n);
        if (i < 0) throw new Error(`move_step: no step ${op.n} on ${tcId} (it has ${steps.length}).`);
        const [moved] = steps.splice(i, 1);
        steps.splice(Math.max(0, Math.min(steps.length, op.to - 1)), 0, moved!);
      } else if (op.op === 'duplicate_step') {
        // Copy the WHOLE saved step (bindings, values, object, flags, settings — nothing rebuilt from a summary).
        const copies = duplicateSteps(steps, op.n, op.through);
        const pos = op.at ?? op.seq;
        const idx = pos != null ? Math.max(0, Math.min(steps.length, pos - 1)) : steps.length;
        if (idx > 0 && steps[idx - 1]?.stepType === 'function') {
          throw new Error(`duplicate_step: position ${idx + 1} is inside the function call at step ${idx}.`);
        }
        steps.splice(idx, 0, ...copies);
      } else if (op.op === 'add_step') {
        // Insert a NEW step at `at` (1-based; default = append) without touching the others - they only shift down.
        // Works for steps that need no captured element (Minimum Wait, other waits, generic actions); the action is
        // resolved to its catalog id by the automation payload builder when the test case is saved.
        // A real API REQUEST step has no action at all (actionId:null) — it must be addable without one.
        if (!op.step?.actionType && !isApiRequestStep(op.step)) throw new Error('add_step: step.actionType is required (e.g. "Minimum Wait").');
        const pos = op.at ?? op.seq;
        const idx = pos != null ? Math.max(0, Math.min(steps.length, pos - 1)) : steps.length;
        if (idx > 0 && steps[idx - 1]?.stepType === 'function') {
          throw new Error(`add_step: position ${idx + 1} is inside the function call at step ${idx}.`);
        }
        steps.splice(idx, 0, { ...(op.step as Step), n: 0 });
      } else if (op.op === 'insert_nested') {
        // Same shape the UI inserts (steps.component.ts addStep 'FUNCTION'): a FUNCTION step directly
        // followed by its FUNCTION_END, with the function's newest version pinned (function-step-card
        // onSelectFunction). The automation payload builder turns the neutral pair into wire steps.
        if (tc.category !== 'automated') {
          throw new Error(
            `insert_nested: ${tcId} is a manual test case — nested function calls can only be added to automated test cases.`,
          );
        }
        const fn = await this.getFunction(op.tcId);
        const fnVersionId = fn.versions?.[0]?.id;
        if (!fnVersionId) throw new Error(`insert_nested: function ${op.tcId} has no version to pin.`);
        const idx = op.at != null ? Math.max(0, Math.min(steps.length, op.at - 1)) : steps.length;
        if (steps[idx - 1]?.stepType === 'function') {
          throw new Error(`insert_nested: position ${idx + 1} is inside the function call at step ${idx}.`);
        }
        const fnStep: Step = {
          n: 0, stepType: 'function', actionType: 'function',
          description: op.name ?? fn.description ?? '',
          functionCall: { testCaseId: numericId(op.tcId), versionId: fnVersionId },
        };
        const endStep: Step = { n: 0, stepType: 'function_end', actionType: 'function_end', description: '' };
        steps.splice(idx, 0, fnStep, endStep);
      } else {
        throw new Error(
          `The SimplifyQA desktop agent is not reachable, and '${op.op}' needs it. Without the agent these ops work ` +
          'straight on the saved test case: set_meta, add_step, update_step, update_steps, remove_step, remove_steps, move_step, ' +
          'duplicate_step and insert_nested. Only wrap_in_if / wrap_in_loop still need the agent.',
        );
      }
      steps = steps.map((x, k) => ({ ...x, n: k + 1 }));
    }
    await this.updateTestCase(tcId, { ...tc, steps });
    return this.stepsView(tcId);
  }

  // ---------------------------------------------------------------------- Self-healing
  /** `heal_propose` on the product server: replay + DOM evidence + proposals. Read-only — it never
   *  writes, so a failed proposal cannot leave a half-healed test case behind. Healing is
   *  browser-bound, so it needs the local agent (QA_MCP_URL), not just the REST base URL. */
  async proposeHeal(input: HealProposeInput): Promise<unknown> {
    const h = this.hop();
    if (!h) {
      throw new Error(
        "Healing needs a local SimplifyQA agent — set QA_MCP_URL to the agent's /mcp endpoint, then retry.",
      );
    }
    const res = (await h.callRaw('heal_propose', input as unknown as Record<string, unknown>)) as {
      structuredContent?: unknown;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (res?.structuredContent && typeof res.structuredContent === 'object') return res.structuredContent;
    const text = res?.content?.find((c) => c?.type === 'text')?.text ?? '';
    if (!text.trim()) throw new Error('heal_propose returned an empty response');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`heal_propose did not return JSON: ${text.slice(0, 300)}`);
    }
  }

  /** Everything the pure planner needs, read live (objects, actions, steps, failing iterations). */
  async getHealFacts(tcId: string, opts?: { runId?: string | undefined }): Promise<HealFacts> {
    const tc = await this.getTestCase(tcId);
    const catalog = await this.actionCatalog();

    // Names grouped per technology. `id::` / `uniq::` / `dis::` are index keys, not technologies.
    // Both the camelCase name and the display name ("Select Item From Dropdown") are accepted, and
    // the technology comes from the action row's objectTemplate (see actionCatalog).
    const actionNames = new Set<string>();
    const byTechSets: Record<string, Set<string>> = {};
    const byTemplateSets: Record<string, Set<string>> = {};
    const actionUniqueIds: string[] = [];
    const seenEntries = new Set<ActionCatalogEntry>();
    for (const [key, entry] of catalog) {
      if (key.startsWith('uniq::')) actionUniqueIds.push(key.slice('uniq::'.length));
      if (seenEntries.has(entry)) continue;
      seenEntries.add(entry);
      for (const n of [entry.name, entry.displayName]) {
        if (!n) continue;
        const lower = n.trim().toLowerCase();
        actionNames.add(lower);
        if (entry.technology) (byTechSets[entry.technology] ??= new Set()).add(lower);
        if (entry.objectTemplate !== undefined) (byTemplateSets[String(entry.objectTemplate)] ??= new Set()).add(lower);
      }
    }
    const actionNamesByTech: Record<string, string[]> = {};
    for (const [tech, names] of Object.entries(byTechSets)) actionNamesByTech[tech] = [...names];
    const actionNamesByTemplate: Record<string, string[]> = {};
    for (const [tpl, names] of Object.entries(byTemplateSets)) actionNamesByTemplate[tpl] = [...names];

    // A hydrated SQA step carries the numeric action ID in `actionType` (fromSqaStep keeps the raw
    // FK), so resolve it to the catalog NAME before any comparison or validation. When the catalog
    // misses that id (action created in another project / project-filtered list), fetch the row —
    // otherwise the step looks action-less and a heal cannot name what it is replacing.
    const resolvedActionNames = new Map<string, string>();
    const actionNameOf = async (s: Step): Promise<string> => {
      const raw = (s.actionType ?? '').trim();
      if (!/^\d+$/.test(raw)) {
        return catalog.get(raw.toLowerCase())?.name ?? catalog.get(`dis::${raw.toLowerCase()}`)?.name ?? raw;
      }
      const cached = resolvedActionNames.get(raw);
      if (cached) return cached;
      const meta = catalog.get(`id::${raw}`);
      if (meta?.name) {
        resolvedActionNames.set(raw, meta.name);
        return meta.name;
      }
      try {
        const row: any = await this.http.getJson<any>(`/tm/action/${raw}`);
        const name = row?.data?.name ?? row?.name;
        if (name) {
          resolvedActionNames.set(raw, String(name));
          return String(name);
        }
      } catch {
        /* keep the raw id — the planner will then skip an action change for this step */
      }
      resolvedActionNames.set(raw, raw);
      return raw;
    };

    const objectIds = [
      ...new Set((tc.steps ?? []).map((s) => s.objectRef?.id).filter((id): id is string => !!id)),
    ].slice(0, 50);

    const objects: Record<string, HealObjectFact | undefined> = {};
    for (const objectId of objectIds) {
      const object = await this.getObject(objectId);
      objects[objectId] = {
        id: objectId,
        ...(object.objectTemplateId ? { objectTemplateId: object.objectTemplateId } : {}),
        locators: (object.locators ?? []).map((l) => ({
          name: l.name,
          value: l.value,
          ...(l.unique === true ? { unique: true } : {}),
        })),
      };
    }

    let failingIterations: number[] | undefined;
    if (opts?.runId) {
      try {
        const projectId = this.requireProjectId();
        const raw = await this.http.getJson<any>(`/exec/report/${numericId(opts.runId)}/${projectId}`);
        const rows = Array.isArray(raw) ? notDeleted(raw) : [];
        const chosen = rows.find((r: any) => String(r?.status ?? '').toUpperCase() === 'FAILED') ?? rows[0];
        const itr = Number(chosen?.itr ?? chosen?.sequenceNo);
        if (Number.isFinite(itr) && itr > 0) failingIterations = [itr];
      } catch {
        /* iteration gating is best-effort — the planner then accepts the supplied iterations */
      }
    }

    const stepFacts: HealFacts['steps'] = [];
    for (const s of tc.steps ?? []) {
      const objectId = s.objectRef?.id;
      const objectTemplateId = objectId ? objects[objectId]?.objectTemplateId : undefined;
      const rawAction = (s.actionType ?? '').trim();
      const actionMeta = /^\d+$/.test(rawAction)
        ? catalog.get(`id::${rawAction}`)
        : (catalog.get(rawAction.toLowerCase()) ?? catalog.get(`dis::${rawAction.toLowerCase()}`));
      stepFacts.push({
        n: s.n,
        actionType: await actionNameOf(s),
        description: s.description,
        stepType: s.stepType,
        ...(isApiRequestStep(s) ? { isApiRequest: true } : {}),
        ...(s.technologyType ? { technologyType: s.technologyType } : {}),
        ...(objectTemplateId ? { objectTemplateId } : {}),
        ...(actionMeta?.objectTemplate !== undefined ? { actionObjectTemplateId: String(actionMeta.objectTemplate) } : {}),
        ...(actionMeta?.deprecated === true ? { actionDeprecated: true } : {}),
        ...(s.actionUniqueId ? { actionUniqueId: s.actionUniqueId } : {}),
        ...(objectId ? { objectId } : {}),
      });
    }

    return {
      tcId,
      ...(tc.currentVersionId ? { currentVersionId: tc.currentVersionId } : {}),
      steps: stepFacts,
      objects,
      actionNames: [...actionNames],
      actionNamesByTech,
      actionNamesByTemplate,
      ...(actionUniqueIds.length ? { actionUniqueIds } : {}),
      ...(failingIterations ? { failingIterations } : {}),
    };
  }

  async applyHealPlan(plan: HealPlan, opts?: { mode?: HealApplyMode | undefined }): Promise<HealReport> {
    const deps: HealApplyDeps = {
      getTestCase: (id) => this.getTestCase(id),
      getObject: (id) => this.getObject(id),
      updateObject: (id, changes) => this.updateObject(id, changes),
      saveAsNewVersion: (id, o) => this.saveAsNewVersion(id, o),
      patchTestDataCells: (input) => this.patchHealTestData(input),
    };
    return applyHealPlanCore(deps, plan, opts ?? {});
  }

  /** Patch cells of the FAILING iterations only, via the existing test-data endpoints:
   *  POST /tm/testdata/searchItr (read) → POST /tm/testdata/updateItr (write that one row). */
  private async patchHealTestData(input: HealTestDataPatch): Promise<{ patched: number; skipped: string[] }> {
    const projectId = this.requireProjectId();
    const tcNum = Number.parseInt(numericId(input.tcId), 10);
    const rawTc = await this.fetchRawTestcase(input.tcId);
    const fallbackCustomerId = Number(rawTc?.customerId);
    const skipped: string[] = [];

    const tpl = await this.getDefaultIteration({
      tcId: input.tcId,
      versionId: input.versionId,
      environmentType: input.environmentType,
    });
    const idByName = new Map<string, number>();
    for (const p of tpl.parameters) {
      idByName.set(p.name, p.paramId);
      idByName.set(p.name.trim().toLowerCase(), p.paramId);
    }

    const search = await this.http.postJson<any>('/tm/testdata/searchItr', {
      searchFields: [
        { column: 'testcaseId', value: tcNum, regEx: false },
        { column: 'versionId', value: input.versionId, regEx: false },
        { column: 'environmentType', value: input.environmentType, regEx: false },
        { column: 'deleted', value: false, regEx: false },
      ],
      startIndex: 0,
      limit: 10000,
    });
    const rows = pickArray(search, 'data', 'content', 'iterations');
    if (!Array.isArray(rows) || rows.length === 0) {
      return { patched: 0, skipped: [`no test-data iterations for ${input.tcId} @ ${input.versionId} / ${input.environmentType}`] };
    }

    const itrOf = (row: any): number => Number(row?.sequenceNo ?? row?.itr);
    let patched = 0;
    for (const update of input.updates) {
      const paramId = idByName.get(update.paramName) ?? idByName.get(update.paramName.trim().toLowerCase());
      if (paramId == null) {
        skipped.push(`parameter "${update.paramName}" is not in this version's test-data template`);
        continue;
      }
      const targets = rows.filter((row: any) => update.iterations.includes(itrOf(row)));
      if (targets.length === 0) {
        skipped.push(`iteration ${update.iterations.join(',')} not found (have ${rows.map(itrOf).join(',')})`);
        continue;
      }
      for (const row of targets) {
        const rowCustomerId = Number(row?.customerId ?? fallbackCustomerId);
        if (!Number.isFinite(rowCustomerId)) {
          skipped.push(`iteration ${itrOf(row)} carries no customerId — not patched`);
          continue;
        }
        const data: any[] = Array.isArray(row.data) ? row.data.map((c: any) => ({ ...c })) : [];
        const idx = data.findIndex((c: any) => Number(c?.paramId) === paramId);
        if (idx >= 0) {
          const cell: Record<string, unknown> = { ...data[idx], paramId, value: update.value };
          delete cell['formulaValue']; // a literal value wins over the stored formula expression
          data[idx] = cell;
        } else {
          data.push({ paramId, value: update.value });
        }
        await this.http.postJson<any>('/tm/testdata/updateItr', {
          parentId: row.parentId,
          id: row.id,
          customerId: rowCustomerId,
          projectId,
          data,
        });
        patched++;
      }
    }
    return { patched, skipped };
  }

}
