import type { Condition, Locator, QaObject, Step, Story, StorySummary, Suite, SuiteSummary, TcSummary, TestCase } from '../../domain/types.js';

export type CfKind = NonNullable<Step['controlFlow']>['kind'];

// The single source of truth for control-flow action_type <-> kind. Exported (and
// inverted into CF_TO_WALNUT below) so the forward direction never hand-writes a
// second literal that could silently drift out of lockstep with this one.
export const WALNUT_TO_CF: Record<string, CfKind> = {
  if_start: 'if',
  else: 'else',
  if_end: 'if_end',
  while_start: 'while',
  while_end: 'while_end',
};

/** Inverse of WALNUT_TO_CF (neutral controlFlow.kind -> walnut action_type),
 * derived once from the same table -- never maintained by hand. */
export const CF_TO_WALNUT: Record<CfKind, string> = Object.fromEntries(
  Object.entries(WALNUT_TO_CF).map(([wire, kind]) => [kind, wire]),
) as Record<CfKind, string>;

/**
 * MUST stay in step with the agent's copy (walnut-agent mcp/qa/adapters/walnut/mapper.ts) and with
 * Step['stepType']. An omission here does NOT fail loudly — normalizeStepType() below silently
 * rewrites the unknown value to 'web'.
 *
 * That silence already cost a real failure: 'ios' was added to the agent's set and to the action
 * catalogs but not here, so an iOS step arrived as step_type 'ios' + action_type 'ios_start_app',
 * got rewritten to 'web' on the way through, and the saved test case then routed to PLAYWRIGHT at
 * execution — a browser opened for an iOS test and step 1 failed with "Action type ios_start_app is
 * not supported by the available browser-based toolset".
 */
const KNOWN_STEP_TYPES: ReadonlySet<string> = new Set([
  'web', 'android', 'ios', 'control_flow', 'function', 'database', 'mainframe',
]);

/**
 * Walnut's wire uses upper-case `'API'` for API steps; the neutral model uses
 * lower-case `'api'`. Any other recognized value passes through unchanged; an
 * absent/unrecognized value defaults to `'web'` (mirrors the backend's own
 * `step_type` schema default in models/schemas.ts).
 */
function normalizeStepType(raw: unknown): Step['stepType'] {
  if (raw === 'API') return 'api';
  if (typeof raw === 'string' && KNOWN_STEP_TYPES.has(raw)) return raw as Step['stepType'];
  return 'web';
}

function fromWalnutCondition(raw: any): Condition | undefined {
  if (!raw) return undefined;
  return {
    type: raw.type,
    selector: raw.selector ?? undefined,
    objectId: raw.object_id ?? undefined,
    text: raw.text ?? undefined,
    variableName: raw.variableName ?? undefined,
    variableValue: raw.variableValue ?? undefined,
  };
}

function fromWalnutFlags(raw: any): Step['flags'] | undefined {
  const sla = raw.stepLevelActions;
  const hasIsOptional = raw.is_optional !== undefined && raw.is_optional !== null;
  if (!sla && !hasIsOptional) return undefined;
  return {
    ...(sla
      ? { skip: !!sla.skip, screenshot: !!sla.captureScreenshot, continueOnFailure: !!sla.continueOnFailure }
      : {}),
    ...(hasIsOptional ? { optional: !!raw.is_optional } : {}),
  };
}

/**
 * Maps one walnut wire `test_steps[]` entry (models/schemas.ts `step` schema shape)
 * to a neutral `Step`.
 */
export function fromWalnutStep(raw: any): Step {
  const n = raw.step_number;
  const description = raw.step_description ?? '';
  const actionType = raw.action_type;
  const expectedResult = raw.expected_result ?? undefined;
  const flags = fromWalnutFlags(raw);
  const cfKind = WALNUT_TO_CF[actionType];

  const sourceId = raw._id != null ? String(raw._id) : undefined;

  if (cfKind) {
    return {
      n,
      ...(sourceId ? { sourceId } : {}),
      description,
      actionType,
      stepType: 'control_flow',
      expectedResult,
      controlFlow: {
        kind: cfKind,
        condition: fromWalnutCondition(raw.condition),
        blockId: raw.block_id ?? undefined,
        maxIterations: raw.max_iterations ?? undefined,
      },
      flags,
    };
  }

  const fcd = raw.function_call_data;
  return {
    n,
    ...(sourceId ? { sourceId } : {}),
    description,
    actionType,
    stepType: normalizeStepType(raw.step_type),
    objectRef: raw.object_id != null ? { id: String(raw.object_id) } : undefined,
    value: raw.input_value ?? undefined,
    expectedResult,
    api: raw.api_request_data ?? undefined,
    db: raw.db_request_data ?? undefined,
    // Nested test-case call — carry the child binding so it survives a read→edit→save round-trip.
    ...(fcd && fcd.test_case_id != null
      ? {
          functionCall: {
            testCaseId: String(fcd.test_case_id),
            testCaseName: fcd.function_name ?? undefined,
            inputParams: fcd.input_params ?? undefined,
            continueOnFailure: fcd.continue_on_failure ?? undefined,
          },
        }
      : {}),
    flags,
  };
}

/**
 * Maps a walnut `GET /api/test-cases/:id` response document (test-cases.ts:5125,
 * TestCaseSchema-shaped) to the neutral `TestCase`.
 */
export function fromWalnutTc(doc: any): TestCase {
  const id = doc.test_case_id ?? (doc._id != null ? String(doc._id) : undefined);
  const category: TestCase['category'] =
    doc.test_category === 'manual' || doc.test_category === 'playwright' ? doc.test_category : 'automated';
  return {
    id,
    title: doc.title,
    description: doc.description ?? undefined,
    objective: doc.objective ?? undefined,
    priority: doc.priority,
    status: doc.status ?? undefined,
    category,
    preconditions: doc.preconditions ?? undefined,
    expectedOutcome: doc.expected_outcome ?? undefined,
    // Story linkage (story_id → user_stories); may be a raw ObjectId or a populated doc. Carried so a
    // read→edit→save round-trip (and the manual→automated promote) keeps the test case linked to its story.
    storyRef: doc.story_id != null ? String(doc.story_id?._id ?? doc.story_id) : undefined,
    tags: doc.tags ?? [],
    // Passthrough for the optimistic-concurrency PUT retry -- dropping this
    // silently overwrites concurrent edits.
    version: doc.version ?? undefined,
    steps: (doc.test_steps ?? []).map(fromWalnutStep),
  };
}

/** Maps one walnut `GET /api/test-cases` list-row (test-cases.ts:1746 `testCases[]`) to a `TcSummary`. */
export function fromWalnutTcSummary(row: any): TcSummary {
  return {
    id: row.test_case_id ?? String(row._id),
    title: row.title,
    priority: row.priority,
    status: row.status ?? undefined,
    stepCount: row.total_steps ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Suites. The list row and the single-doc GET share the same shape (both
// `{ ...suite, testCases, totalTests, ... }`); `_id` is the id the GET /:id
// route resolves by (NOT the `SU_` business key), so it is what we surface.
// ---------------------------------------------------------------------------

/** One row of `GET /api/test-suites` → neutral SuiteSummary. */
export function fromWalnutSuiteSummary(row: any): SuiteSummary {
  return {
    id: String(row._id ?? ''),
    name: row.name ?? '',
    ...(typeof row.totalTests === 'number' ? { memberCount: row.totalTests } : {}),
  };
}

/** `GET /api/test-suites/:id` doc → neutral Suite. Members come from `testCases[]`
 *  (already null-TC-filtered by the backend), ordered by `order`; each member's
 *  `tcId` is the friendly business key when populated, else the Mongo id. */
export function fromWalnutSuite(doc: any): Suite {
  const members = (doc?.testCases ?? [])
    .filter((m: any) => m && m.testCaseId)
    .map((m: any, i: number) => ({
      tcId: m.testCaseId?.test_case_id ?? String(m.testCaseId?._id ?? m.testCaseId ?? ''),
      order: typeof m.order === 'number' ? m.order : i,
    }))
    .sort((a: { order: number }, b: { order: number }) => a.order - b.order);
  return {
    id: String(doc?._id ?? ''),
    name: doc?.name ?? '',
    ...(doc?.description ? { description: String(doc.description) } : {}),
    members,
  };
}

// ---------------------------------------------------------------------------
// User stories (Walnut `user_stories`, type 'story'). List rows and the single GET share the doc
// shape; `_id` is the id test cases link to (story_id), and `walnut_key`/`key` is the human business
// key (US_001, or an external Jira/ADO key). `key` in the list response already falls back walnut_key→…
// ---------------------------------------------------------------------------

/** One `GET /api/stories` list-row → neutral StorySummary. */
export function fromWalnutStorySummary(row: any): StorySummary {
  return {
    id: String(row?._id ?? row?.id ?? ''),
    ...(row?.key || row?.walnut_key ? { key: String(row.key ?? row.walnut_key) } : {}),
    title: row?.title ?? '',
    ...(row?.status ? { status: String(row.status) } : {}),
    ...(row?.priority ? { priority: String(row.priority) } : {}),
  };
}

/** `GET /api/stories/:id` doc (or a list row) → neutral Story, with the acceptance criteria the
 *  manual-test-case drafting reads. */
export function fromWalnutStory(doc: any): Story {
  return {
    id: String(doc?._id ?? doc?.id ?? ''),
    ...(doc?.key || doc?.walnut_key ? { key: String(doc.key ?? doc.walnut_key) } : {}),
    title: doc?.title ?? '',
    ...(doc?.description ? { description: String(doc.description) } : {}),
    ...(Array.isArray(doc?.acceptance_criteria) && doc.acceptance_criteria.length
      ? { acceptanceCriteria: doc.acceptance_criteria.map((x: any) => String(x)) }
      : {}),
    ...(doc?.status ? { status: String(doc.status) } : {}),
    ...(doc?.priority ? { priority: String(doc.priority) } : {}),
  };
}

export function fromWalnutObject(doc: any): QaObject {
  const id = doc?._id != null ? String(doc._id) : undefined;
  const rawAttrs: any[] = Array.isArray(doc?.attributes) ? doc.attributes : [];
  const locators: Locator[] = rawAttrs
    .filter((a) => typeof a?.name === 'string' && typeof a?.value === 'string')
    .map((a) => ({ name: String(a.name), value: String(a.value), ...(a.unique === true ? { unique: true } : {}) }));
  return {
    ...(id ? { id } : {}),
    name: doc?.description ?? '',
    ...(doc?.object_type ? { objectType: String(doc.object_type) } : {}),
    locators,
  };
}

// ---------------------------------------------------------------------------
// FORWARD direction: neutral -> walnut.
//
// The same shape serves BOTH (a) the backend persistence wire (`POST/PUT /api/test-cases`, which
// WalnutAdapter posts) and (b) the walnut-frontend draft the real TestStepsEditor consumes off the
// `/embed/test-case-draft#d=<payload>` URL fragment. `fromWalnutStep` is the reverse.
// ---------------------------------------------------------------------------

const PARAM_TOKEN = /\$\{([^}]+)\}/g;

/** Every distinct `${name}` token in a step description, in first-seen order. */
function detectParams(description: string | undefined): string[] {
  const found: string[] = [];
  for (const m of (description ?? '').matchAll(PARAM_TOKEN)) {
    const name = m[1]!;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/** Forward of fromWalnutCondition: neutral Condition -> walnut condition (object_id snake_case). */
function toWalnutCondition(c: Condition | undefined): Record<string, unknown> | undefined {
  if (!c) return undefined;
  return {
    type: c.type,
    ...(c.selector !== undefined ? { selector: c.selector } : {}),
    ...(c.objectId !== undefined ? { object_id: c.objectId } : {}),
    ...(c.text !== undefined ? { text: c.text } : {}),
    ...(c.variableName !== undefined ? { variableName: c.variableName } : {}),
    ...(c.variableValue !== undefined ? { variableValue: c.variableValue } : {}),
  };
}

/** Forward of fromWalnutFlags's stepLevelActions branch. `is_optional` is
 * deliberately NOT emitted -- it never appears in the editor draft payload,
 * only in the backend persistence wire shape (a different contract). */
function toWalnutFlags(flags: NonNullable<Step['flags']>): Record<string, unknown> {
  return { skip: !!flags.skip, captureScreenshot: !!flags.screenshot, continueOnFailure: !!flags.continueOnFailure };
}

/**
 * One neutral `Step` -> one walnut `test_steps[]` entry (backend wire + editor draft).
 * `fromWalnutStep` above is the reverse (see the round-trip test in
 * mapper.test.ts, which exercises both directions and asserts on
 * stepType/controlFlow.kind, the fields both shapes agree on).
 */
export function toWalnutStep(s: Step): Record<string, unknown> {
  const cf = s.controlFlow;
  const base: Record<string, unknown> = {
    step_number: s.n,
    step_type: s.stepType === 'api' ? 'API' : s.stepType,
    action_type: cf ? CF_TO_WALNUT[cf.kind] : s.actionType,
    step_description: s.description ?? '',
    // The backend `step` schema marks expected_result REQUIRED (non-empty) — an empty string makes
    // insertMany throw a 400. Manual/control-flow steps often carry none, so fall back to a neutral,
    // non-empty phrase derived from the step rather than let the save fail.
    expected_result: s.expectedResult?.trim() || `Verified: ${(s.description ?? 'step').trim() || 'step'}`,
    // Kept-step identity for the update PUT's upsert (matched by _id; new steps omit it → created).
    ...(s.sourceId ? { _id: s.sourceId } : {}),
  };

  if (s.stepType === 'control_flow' && cf) {
    const condition = toWalnutCondition(cf.condition);
    return {
      ...base,
      ...(condition ? { condition } : {}),
      ...(cf.blockId ? { block_id: cf.blockId } : {}),
      ...(cf.maxIterations != null ? { max_iterations: cf.maxIterations } : {}),
    };
  }

  const params = detectParams(s.description);
  // Real recorded locator, when this step originated from a LIVE recording
  // session rather than LLM-authored text -- `objectRef.locators` is only ever
  // populated in that path. `element.locator_type`/`locator_value` is exactly
  // the field walnut-frontend's TestStepsEditor `TestStep.element` reads
  // (TestStepsEditor.tsx ~line 2007) -- prefer the locator flagged `unique`
  // (the same selector Walnut's own replay ladder prioritizes), else the first.
  const primaryLocator = s.objectRef?.locators?.find((l) => l.unique) ?? s.objectRef?.locators?.[0];
  return {
    ...base,
    ...(s.value !== undefined ? { inputValue: s.value } : {}),
    ...(params.length ? { parameterName: params[0], detected_parameters: params } : {}),
    ...(s.api ? { api_request_data: s.api } : {}),
    ...(s.flags ? { stepLevelActions: toWalnutFlags(s.flags) } : {}),
    ...(s.objectRef?.id !== undefined ? { object_id: s.objectRef.id } : {}),
    ...(primaryLocator ? { element: { locator_type: primaryLocator.name, locator_value: primaryLocator.value } } : {}),
    // Nested test-case call — emit the wire shape the backend + editor expect (function_call_data),
    // the inverse of fromWalnutStep, so an inserted/edited nested step persists its child binding.
    ...(s.functionCall
      ? {
          function_call_data: {
            test_case_id: s.functionCall.testCaseId,
            ...(s.functionCall.testCaseName ? { function_name: s.functionCall.testCaseName } : {}),
            ...(s.functionCall.inputParams ? { input_params: s.functionCall.inputParams } : {}),
            ...(s.functionCall.continueOnFailure ? { continue_on_failure: true } : {}),
          },
        }
      : {}),
  };
}

/**
 * Default-row test data (param name -> value) derived from the steps, for the persistence path.
 *
 * Walnut resolves a web step's value at execution time from a `${param}` token in its description
 * backed by a datarow (NOT from `input_value`, which is android-only) -- see the create route's
 * dataset auto-creation. So a step that carries both a single `${param}` token AND a literal `value`
 * binds that value to that parameter. Steps with zero or multiple tokens are skipped (nothing to bind
 * unambiguously) -- the caller can still supply those via the explicit `TestCase.data` map, which
 * WalnutAdapter merges ON TOP of this. First-seen wins, mirroring the backend's own row extraction.
 */
export function deriveTestData(steps: Step[]): Record<string, string> {
  const data: Record<string, string> = {};
  for (const s of steps) {
    if (s.value === undefined || s.value === '') continue;
    const params = detectParams(s.description);
    if (params.length === 1) {
      const key = params[0]!;
      if (!(key in data)) data[key] = s.value;
    }
  }
  return data;
}

/**
 * Whole neutral TestCase -> the walnut-frontend draft payload's TestCase-level
 * fields. `tc_draft_open` layers `draftId`/`mode` on top of this -- those
 * describe the draft's hosting, not the test case itself.
 */
export function toWalnutTc(tc: TestCase): Record<string, unknown> {
  return {
    title: tc.title,
    priority: tc.priority,
    category: tc.category,
    test_steps: tc.steps.map(toWalnutStep),
  };
}
