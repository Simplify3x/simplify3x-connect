import { z } from 'zod';

/**
 * Zod mirrors of src/domain/types.ts, used ONLY as MCP tool inputSchemas.
 * `validateTestCase` (src/domain/validate.ts) deliberately does not check
 * `controlFlow.kind` -- these schemas are the only gate on that literal
 * union, per the design brief ("zod is the only gate").
 */

export const zLocator = z.object({
  name: z.string(),
  value: z.string(),
  unique: z.boolean().optional().describe(
    'true makes this the object\'s DEFAULT locator (the one the UI marks as default and the executor uses first); ' +
      'only one default exists — it is cleared on the others. object_update also has `defaultLocator` (by name).',
  ),
});

/** One raw column filter, passed straight through to the backend's searchFields protocol — escape
 *  hatch for project-configurable columns with no dedicated typed parameter. */
export const zRawFilter = z.object({
  column: z.string().describe('Backend field name to filter on, e.g. "priority", "moduleId", "customFields.Team".'),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.array(z.number())])
    .describe('Exact-match value (or substring when `regEx` is true).'),
  regEx: z.boolean().optional().describe('Substring/regex match instead of exact equality.'),
});

export const zCondition = z.object({
  type: z.string(),
  selector: z.string().optional(),
  objectId: z.string().optional(),
  text: z.string().optional(),
  variableName: z.string().optional(),
  variableValue: z.string().optional(),
});

export const zControlFlow = z.object({
  /** SQA raw stepType (uppercase). Common values: IF, ELSE_IF, ELSE, IF_END,
   *  FOR_START, FOR_END, WHILE_START, WHILE, WHILE_END, DO, DO_WHILE,
   *  ITERATOR_START, ITERATOR_END, LOOP, LOOP_ITERATION_START, LOOP_ITERATION_END,
   *  FUNCTION_END, SWITCH_TO_WEB/ANDROID/IOS/API/DB/MAINFRAME/DESKTOP/SAP.
   *  Wide string (not enum) so backend adds don't require a schema change. */
  kind: z.string(),
  condition: zCondition.optional(),
  /** Human-readable expression as the SQA UI shows it (e.g. `count > 5 && status == "active"`).
   *  Emitted as `conditions.ifstring` on the wire. */
  conditionText: z.string().optional(),
  blockId: z.string().optional(),
  maxIterations: z.number().int().positive().optional(),
});

// 'manual' is the non-execution axis (manual TCs / manual steps in a DUO TC). Every
// other value picks an execution technology. Angular's step-card routing branches
// on 'manual' vs anything-else, so a manual add_step MUST use 'manual' here or the
// row renders as an empty automation card (no actionId).
export const zStepType = z.enum(['manual', 'web', 'api', 'control_flow', 'function', 'function_end', 'database', 'android', 'ios', 'mainframe', 'desktop', 'sap']);

export const zFlags = z.object({
  skip: z.boolean().optional(),
  screenshot: z.boolean().optional(),
  continueOnFailure: z.boolean().optional(),
  optional: z.boolean().optional(),
});

export const zObjectRef = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  locators: z.array(zLocator).optional(),
  thumbnail_url: z.string().optional(),
  pageScreenShot_url: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  pageScreenshotUrl: z.string().optional(),
});

export const zFunctionCall = z.object({
  /** SQA `functionId` (numeric id of the child function TC, as a string). */
  testCaseId: z.string(),
  testCaseName: z.string().optional(),
  testCaseCode: z.string().optional(),
  /** SQA `fnVersionId` — the specific version of the referenced function pinned by this call. */
  versionId: z.string().optional(),
  /** SQA `sharedFnProjectId` — set when the FN lives in a different project (shared function). */
  sharedProjectId: z.string().optional(),
  inputParams: z.record(z.string(), z.unknown()).optional(),
  continueOnFailure: z.boolean().optional(),
});

/** A step with no `n` -- callers never assign step numbers; DraftStore renumbers
 * contiguously from 1 after every op. Used for add_step and tc_draft_create's
 * initial `steps`. */
export const zNewStep = z.object({
  description: z.string(),
  actionType: z.string(),
  stepType: zStepType,
  objectRef: zObjectRef.optional(),
  value: z.string().optional(),
  expectedResult: z.string().optional(),
  controlFlow: zControlFlow.optional(),
  functionCall: zFunctionCall.optional(),
  api: z.record(z.string(), z.unknown()).optional(),
  db: z.record(z.string(), z.unknown()).optional(),
  flags: zFlags.optional(),
  /** Name-keyed value patches for this step's params: `{"url":"https://prod.acme.com"}`. Mapper
   *  resolves each name → paramId via the project parameter dict at save time; overrides
   *  matching entries in the backend's stored recordedParam. An ALL-DIGIT key is treated as an
   *  already-bound parameter ID (`{"2124":"Products"}` binds parameter 2124, it does not create
   *  a parameter named "2124"). */
  recordedParam: z.record(z.string(), z.string()).optional(),
  /** Formula expressions recorded with the values: `{"username":"=FIRST_NAME()"}`. Name-keyed like
   *  `recordedParam`; save stores the cell as `{ value, formulaValue }` so execution re-evaluates. */
  recordedParamFormula: z.record(z.string(), z.string()).optional(),
});

/** A partial patch onto an existing step (update_step). */
export const zStepPatch = zNewStep.partial().extend({
  /** Replace a parameter with another IN THE SAME SLOT of this step: `[{ from: "username", to: "admin_user", value: "root" }]`.
   *  Use this — not `recordedParam` — to change WHICH parameter a step uses (recordedParam only adds). */
  swapParams: z.array(z.object({
    from: z.string().describe('Parameter the step uses now (name, or numeric id).'),
    to: z.string().describe('Parameter to use instead (name; created when missing).'),
    value: z.string().optional().describe("The new parameter's test-data value for this step."),
  })).optional(),
});

export const zPriority = z.enum(['critical', 'high', 'medium', 'low']);
export const zCategory = z.enum(['automated', 'manual', 'playwright']);

/** set_meta's patch -- TestCase-level fields only. `steps`/`id`/`version` are
 * deliberately absent: steps are store-managed, id/version are backend
 * concerns that don't exist for an unsaved draft. */
export const zTestCaseMetaPatch = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  objective: z.string().optional(),
  priority: zPriority.optional(),
  status: z.string().optional(),
  category: zCategory.optional(),
  preconditions: z.string().optional(),
  expectedOutcome: z.string().optional(),
  /** Mark the test case obsolete (kept for history, hidden from normal lists/execution). Reversible. */
  obsolete: z.boolean().optional(),
  folderOrModule: z.string().optional(),
  storyRef: z.string().optional(),
  tags: z.array(z.string()).optional(),
  data: z.record(z.string(), z.string()).optional(),
});

const zStepWhere = z.object({
  numbers: z.array(z.number().int().positive()).optional().describe('Explicit step numbers.'),
  from: z.number().int().positive().optional().describe('Range start (inclusive).'),
  to: z.number().int().positive().optional().describe('Range end (inclusive).'),
  stepType: z.string().optional().describe('e.g. "database", "api", "web".'),
  actionType: z.string().optional().describe('Action name or id the step uses, e.g. "Click".'),
  object: z.string().optional().describe('Object name or id the step uses.'),
  descriptionContains: z.string().optional(),
  parameter: z.string().optional().describe('A parameter the step uses, by name.'),
  all: z.boolean().optional().describe('Required to patch EVERY step when no other criterion is given.'),
});

/** One API response assertion for the `add_assertions` op. */
export const zApiAssertion = z.object({
  path: z.string().min(1).describe('Response path: statusCode | responseTime | responseSize | $.body.<path> (or response.<path>) | $.headers.<Name>.'),
  condition: z.string().min(1).describe('EQUALS | NOT_EQUALS | CONTAINS | DOES_NOT_CONTAIN | NOT_EMPTY | EQUAL_TO_EMPTY | EQUAL_TO_NULL | NOT_EQUAL_TO_NULL | GREATER_THAN | LESSER_THAN | GREATER_THAN_OR_EQUAL_TO | LESSER_THAN_OR_EQUAL_TO (LESS_THAN is accepted and folded to LESSER_THAN).'),
  expectedValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  key: z.string().optional().describe('Optional editor key (header name for $.headers.<Name>; inferred otherwise).'),
}).catchall(z.unknown());

const zAddAssertions = z.object({
  op: z.literal('add_assertions'),
  n: z.number().int().positive().describe('Step number of an EXISTING API step.'),
  assertions: z.array(zApiAssertion).min(1).describe('Assertions to APPEND to that step. The request, object, action, parameters and existing assertions are left untouched.'),
});

export const zDraftOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_meta'), patch: zTestCaseMetaPatch }),
  z.object({ op: z.literal('add_step'), at: z.number().int().positive().optional(), step: zNewStep }),
  z.object({ op: z.literal('update_step'), n: z.number().int().positive(), patch: zStepPatch }),
  zAddAssertions,
  z.object({ op: z.literal('remove_step'), n: z.number().int().positive() }),
  z.object({
    op: z.literal('remove_steps'),
    numbers: z.array(z.number().int().positive()).min(1).describe('Step numbers to delete, in any order — resolved against the current steps, so a range (5..10) is safe.'),
  }),
  z.object({ op: z.literal('move_step'), n: z.number().int().positive(), to: z.number().int().positive() }),
  z.object({ op: z.literal('update_steps'), where: zStepWhere, patch: zStepPatch }),
  z.object({
    op: z.literal('duplicate_step'),
    n: z.number().int().positive().describe('Step number to copy.'),
    through: z.number().int().positive().optional().describe('Copy steps n..through (required when step n opens an IF / loop / function block).'),
    at: z.number().int().positive().optional().describe('1-based position the copy takes (default: end of the test case).'),
  }),
]);

/** Granular modify ops for journal_modify (superset of the step ops + control-flow/nested authoring).
 *  `n`/`from`/`to` are the client-visible step numbers from journal_grep (1-based). */
export const zJournalOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_meta'), patch: zTestCaseMetaPatch }),
  z.object({
    op: z.literal('add_step'),
    at: z.number().int().positive().optional().describe('1-based position the new step takes (default: append).'),
    seq: z.number().int().positive().optional().describe('Alias of `at`.'),
    step: zNewStep,
  }),
  z.object({ op: z.literal('update_step'), n: z.number().int().positive(), patch: zStepPatch }),
  zAddAssertions,
  z.object({ op: z.literal('remove_step'), n: z.number().int().positive() }),
  z.object({
    op: z.literal('remove_steps'),
    numbers: z.array(z.number().int().positive()).min(1).describe('Step numbers to delete, in any order — resolved against the current steps, so a range (5..10) is safe.'),
  }),
  z.object({ op: z.literal('move_step'), n: z.number().int().positive(), to: z.number().int().positive() }),
  z.object({ op: z.literal('update_steps'), where: zStepWhere, patch: zStepPatch }),
  z.object({
    op: z.literal('duplicate_step'),
    n: z.number().int().positive().describe('Step number to copy — the WHOLE step is cloned (parameters, values, object, flags, settings).'),
    through: z.number().int().positive().optional().describe('Copy steps n..through (required when step n opens an IF / loop / function block).'),
    at: z.number().int().positive().optional().describe('1-based position the copy takes (default: end of the test case).'),
    seq: z.number().int().positive().optional().describe('Alias of `at`.'),
  }),
  z.object({
    op: z.literal('wrap_in_loop'),
    from: z.number().int().positive(),
    to: z.number().int().positive(),
    condition: zCondition.optional(),
    maxIterations: z.number().int().positive().optional(),
  }),
  z.object({
    op: z.literal('wrap_in_if'),
    from: z.number().int().positive(),
    to: z.number().int().positive(),
    condition: zCondition.optional(),
  }),
  z.object({
    op: z.literal('insert_nested'),
    at: z.number().int().positive().optional(),
    tcId: z.string(),
    name: z.string().optional(),
  }),
]);
