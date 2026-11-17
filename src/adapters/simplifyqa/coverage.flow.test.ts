/**
 * Wave-2 coverage: the FLOW renderer (`flow.ts`) and the pure heal planner (`heal/plan.ts`).
 *
 * flow.ts turns a run's raw step-result rows into the lines a model reads. plan.ts validates the
 * product's proposals against live facts and emits the ordered change-set — which changes are
 * allowed, which are refused and why, and the blast radius.
 */
import {
  apiBrief, buildFlow, functionCallsLine, MAX_NOT_RUN, notRunLines, plain, SHOW_ALL, stepData,
} from './flow.js';
import { MAX_WARNINGS, WINDOW_AFTER, WINDOW_BEFORE } from './flow.js';
import { buildHealPlan, type HealFacts, type HealStepFact } from './heal/plan.js';
import type { HealDiagnosis, HealProposal } from '../../domain/heal.js';

const row = (over: Record<string, unknown>) => ({
  status: 'PASSED', stepType: 'NORMAL_STATEMENT', description: 'step', ...over,
});

describe('flow.buildFlow — a short run is shown whole', () => {
  test('renders statuses, control flow, function nesting, test data and flags; warnings come from passed steps', () => {
    const rows = [
      row({
        id: 'r1', stepId: 'w1', displaySeq: '1', description: 'Launch <b>app</b>',
        testdata: [{ paramName: 'url', value: 'https://x' }],
        executionLogData: { executionLogs: ['2026-10-13 10:00:00.000 - WARN : slow start'] },
      }),
      row({ id: 'r2', stepId: 'w2', displaySeq: '2', stepType: 'LOOP_ITERATION_START', description: '', loop: { iteratorCount: 1 } }),
      row({ id: 'r3', stepId: 'w3', displaySeq: '3', stepType: 'FUNCTION', description: 'Login', functionData: { functionName: 'Login' } }),
      row({ id: 'r4', stepId: 'w4', displaySeq: '3.1', description: 'Enter credentials', selfHealed: true }),
      row({ id: 'r5', stepId: 'w5', displaySeq: '3.2', stepType: 'FUNCTION_END', description: '', status: 'INFO' }),
      row({
        id: 'r6', stepId: 'w6', displaySeq: '4', stepType: 'IF', status: 'FAILED',
        description: 'Is logged in?', conditions: { evaluatedConditionString: 'user exists' },
      }),
      row({ id: 'r7', stepId: 'w7', displaySeq: '5', status: 'NOTEXECUTED', description: 'Dashboard' }),
      row({ id: 'r8', stepId: 'w8', displaySeq: '6', stepType: 'IF_END', status: 'INFO', description: '' }),
      row({
        id: 'r9', stepId: 'w9', displaySeq: '7', status: 'FAILED', description: 'Click Pay',
        testdata: [{ paramName: 'card', value: '4111 1111', protected: true }],
        defectIds: ['DE-1'],
        apiData: { assertions: [{ status: 'FAILED' }, { status: 'PASSED' }, { status: false }] },
      }),
      row({ id: 'r10', stepId: 'w10', displaySeq: '8', stepType: 'SWITCH_TO_API', description: 'API' }),
      row({ id: 'r11', stepId: 'w11', displaySeq: '9', stepType: 'ITERATOR_START', description: 'for each row', loop: { loopIteration: 3, evaluatedConditionString: 'rows' } }),
      row({ id: 'r12', stepId: 'w12', displaySeq: '10', status: 'NOTEXECUTED', description: 'row' }),
    ];
    const flow = buildFlow(rows, { automated: true, focusId: 'r9' });

    expect(flow.lines).toEqual([
      '1 [PASSED] Launch app | url=https://x',
      '  · iteration 1',
      '3 [PASSED] function "Login"',
      '  3.1 [PASSED] Enter credentials [self-healed]',
      '4 [IF → false] user exists — step 5 skipped',
      '5 [NOTEXECUTED] Dashboard',
      // ITERATOR_START is not in INFO_STEP_TYPES, so the loop row counts as the last step that ran.
      '7 [FAILED · continued] Click Pay | card=*** [defects: DE-1] [assertions: 2 of 3 failed]',
      '8 [SWITCH] switch to API',
      '9 [LOOP → 3 iterations] rows',
      '10 [NOTEXECUTED] row',
    ]);
    expect(flow.warnings).toEqual(['step 1: 10:00:00 WARN slow start']);
    expect(flow.breakdown).toBeUndefined();
    expect([...flow.furthestStepIds]).toEqual(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w10', 'w11']);
    expect(MAX_WARNINGS).toBe(15);
    expect(SHOW_ALL).toBe(60);

    // A false IF whose report labels are not plain numbers still says its block was skipped.
    const manual = buildFlow([
      row({ id: 'm1', reportSeq: 'a', status: 'FAILED', stepType: 'IF', description: 'branch' }),
      row({ id: 'm2', reportSeq: 'b', status: 'NOTEXECUTED', description: 'inside' }),
      row({ id: 'm3', reportSeq: 'c', stepType: 'IF_END', status: 'INFO', description: '' }),
    ], { automated: false });
    expect(manual.lines).toEqual([
      'a [IF → false] branch — its block was skipped',
      'b [NOTEXECUTED] inside',
    ]);

    // No IF_END at all → no skip hint. Nested IFs: the outer block's range skips both inner rows.
    const noEnd = buildFlow([row({ id: 'n1', displaySeq: '1', status: 'FAILED', stepType: 'IF', description: 'branch' })], { automated: true });
    expect(noEnd.lines).toEqual(['1 [IF → false] branch']);
    const nested = buildFlow([
      row({ id: 'n1', displaySeq: '1', status: 'FAILED', stepType: 'IF', description: 'outer' }),
      row({ id: 'n2', displaySeq: '2', status: 'PASSED', stepType: 'IF', description: 'inner' }),
      row({ id: 'n3', displaySeq: '3', stepType: 'IF_END', status: 'INFO' }),
      row({ id: 'n4', displaySeq: '4', status: 'PASSED', description: 'after' }),
      row({ id: 'n5', displaySeq: '5', stepType: 'IF_END', status: 'INFO' }),
    ], { automated: true });
    expect(nested.lines).toEqual([
      '1 [IF → false] outer — steps 2–4 skipped',
      '2 [IF → true] inner',
      '4 [PASSED] after',
    ]);
  });
});

describe('flow.buildFlow — a long run keeps the failure window', () => {
  test('windows around the failure, keeps its enclosing block, and names the gap and the breakdown', () => {
    const rows: any[] = [
      row({ id: 'r0', stepId: 'w0', displaySeq: '1', stepType: 'IF', description: 'setup done', conditions: { evaluatedConditionString: 'setup done' } }),
      row({ id: 'r1', stepId: 'w1', displaySeq: '2', stepType: 'FUNCTION', description: 'Login', functionData: { functionName: 'Login' } }),
    ];
    for (let i = 2; i < 40; i++) {
      rows.push(row({ id: `r${i}`, stepId: `w${i}`, displaySeq: String(i + 1), description: `step ${i + 1}` }));
    }
    rows.push(row({
      id: 'r40', stepId: 'w40', displaySeq: '2.1', status: 'FAILED', description: 'Click inside Login',
      executionLogData: { executionLogs: ['2026-10-13 10:00:00.000 - ERROR : no such element'] },
    }));
    for (let i = 41; i < 70; i++) {
      rows.push(row({ id: `r${i}`, stepId: `w${i}`, displaySeq: String(i + 1), status: i < 65 ? 'FAILED' : 'PASSED', description: `step ${i + 1}` }));
    }

    const flow = buildFlow(rows, { automated: true, focusId: 'r40' });
    expect(flow.lines).toContain('2 [PASSED] function "Login"');
    // The IF is still open at the failure, so it is shown even though it sits outside the window.
    expect(flow.lines[0]).toBe('1 [IF → true] setup done');
    expect(flow.lines).toContain('  2.1 [FAILED · continued] Click inside Login');
    expect(flow.lines.some((l) => /^… steps 3–\d+ not shown: \d+ steps, all passed …$/.test(l))).toBe(true);
    expect(flow.lines.some((l) => /^… steps \d+–70 not shown: \d+ steps, all passed …$/.test(l))).toBe(true);
    expect(flow.breakdown).toBe('from step 2.1 on, 25 of 30 steps failed');
    // Bounded: the lines kept per flow, plus the "not shown" lines, never the whole 70-step run.
    expect(flow.lines.length).toBeLessThan(100);
    expect(WINDOW_BEFORE).toBe(25);
    expect(WINDOW_AFTER).toBe(5);
  });
});

describe('flow.notRunLines — what the test was going to do next', () => {
  test('numbers the written steps (FUNCTION_END takes none), keeps IF, drops INFO rows and caps the list', () => {
    const written = [
      { id: 'w1', seq: 1, description: 'Launch' },
      { id: 'w2', seq: 2, description: 'Login', stepType: 'FUNCTION', functionData: { functionName: 'Login' } },
      { id: 'w3', seq: 3, stepType: 'FUNCTION_END' },
      { id: 'w4', seq: 4, description: 'Enter' },
      { id: 'w5', seq: 5, stepType: 'LOOP_ITERATION_START' },
      { id: 'w6', seq: 6, stepType: 'IF', conditions: { ifstring: 'user exists' } },
      { id: 'w7', seq: 7, description: 'Click <i>Pay</i>' },
      { id: 'w8', seq: 8, description: 'Sign out' },
      { id: 'w9', seq: 9, description: 'Step 9' },
      { id: 'w10', seq: 10, description: 'Step 10' },
      { id: 'w11', seq: 11, description: 'Step 11' },
      { id: 'w12', seq: 12, description: 'Step 12' },
    ];
    expect(notRunLines(written, new Set())).toEqual([]);
    expect(notRunLines(written, new Set(['w1']))).toEqual([
      '2 [not run] function "Login"',
      '3 [not run] Enter',
      '5 [not run] IF user exists',
      '6 [not run] Click Pay',
      '7 [not run] Sign out',
      '8 [not run] Step 9',
      '9 [not run] Step 10',
      '10 [not run] Step 11',
      '… 1 more written steps not run …',
    ]);
    expect(notRunLines(written, new Set(['w11']))).toEqual(['11 [not run] Step 12']);
    expect(MAX_NOT_RUN).toBe(8);
  });

  test('functionCallsLine compares a call with earlier calls; stepData/apiBrief stay on one line', () => {
    const rows = [
      row({ id: 'a', displaySeq: '1', stepType: 'FUNCTION', description: 'Login', functionData: { functionId: 'fn-1', functionName: 'Login' } }),
      row({ id: 'b', displaySeq: '1.1', description: 'Inside' }),
      row({ id: 'c', displaySeq: '2', stepType: 'FUNCTION', status: 'FAILED', description: 'Login', functionData: { functionId: 'fn-1', functionName: 'Login' } }),
      row({ id: 'd', displaySeq: '2.1', status: 'FAILED', description: 'Click' }),
    ];
    expect(functionCallsLine(rows, 2)).toBe('function "Login": this is call 2 of 2; earlier calls: 1 passed');
    expect(functionCallsLine(rows, 0)).toBe('function "Login": this is call 1 of 2 (the first call)');
    expect(functionCallsLine(rows, 1)).toBeUndefined();
    expect(functionCallsLine([rows[0]!], 0)).toBeUndefined();
    expect(functionCallsLine([], 0)).toBeUndefined();
    // The name falls back to the description when the row carries no function data.
    expect(functionCallsLine([
      row({ stepType: 'FUNCTION', description: 'Setup' }),
      row({ stepType: 'FUNCTION', description: 'Setup' }),
    ], 1)).toBe('function "Setup": this is call 2 of 2; earlier calls: 1 passed');

    // stepData / apiBrief keep one readable line.
    const long = 'x'.repeat(200);
    expect(stepData({ testdata: [
      { paramName: 'a', value: 'x  y', protected: false },
      { runtimeKey: 'b', value: null },
      { value: 'loose' },
      { paramName: 'p', value: 'secret', protected: true },
      { paramName: 'long', value: long },
      null,
      'not an object',
    ] })).toBe(`a=x y; b=; loose; p=***; long=${'x'.repeat(120)}…`);
    expect(stepData({})).toBe('');

    expect(apiBrief({ responseData: { statusCode: 500, responseBody: '{"message": "bad"}' } }))
      .toBe('API 500: {"message": "bad"}');
    expect(apiBrief({ responseData: { statusCode: 500, responseBody: '{"message": "bad"}' } }, 10)).toBe('API 500: {"message"…');
    expect(apiBrief({ responseData: { statusCode: 204 } })).toBe('API 204');
    expect(apiBrief({})).toBe('');
    expect(apiBrief({ responseData: {} })).toBe('');
    expect(plain('<p>Hello&nbsp;<b>world</b></p>')).toBe('Hello world');
  });
});

// ------------------------------------------------------------------------------- heal plan

const STEPS: HealStepFact[] = [
  { n: 1, actionType: 'launchApplication', description: 'Launch', stepType: 'normal_statement', technologyType: 'WEB', objectTemplateId: 'tpl-1' },
  {
    n: 2, actionType: 'click', description: 'Click Pay', stepType: 'normal_statement', technologyType: 'WEB',
    objectTemplateId: 'tpl-1', actionObjectTemplateId: 'tpl-2', objectId: '8812',
  },
  { n: 3, actionType: 'executeQuery', description: 'Query', stepType: 'normal_statement', technologyType: 'DATABASE', actionUniqueId: 'db-2' },
  { n: 4, actionType: 'storeJson', description: 'Store from JSON', stepType: 'normal_statement', technologyType: 'API' },
  { n: 5, actionType: 'request', description: 'API request', stepType: 'api', isApiRequest: true, technologyType: 'API' },
  { n: 6, actionType: 'if', description: 'If', stepType: 'control_flow' },
  { n: 7, actionType: 'click', description: 'Click (no object)', stepType: 'normal_statement', technologyType: 'WEB', objectTemplateId: 'tpl-1' },
  { n: 9, actionType: 'click', description: 'Click, technology scope', stepType: 'normal_statement', technologyType: 'WEB' },
  { n: 10, actionType: 'click', description: 'Click, unknown technology', stepType: 'normal_statement', technologyType: 'IOS' },
];

const FACTS: HealFacts = {
  tcId: 'TC-42',
  currentVersionId: 'ver-1',
  steps: STEPS,
  objects: {
    '8812': { id: '8812', objectTemplateId: 'tpl-1', locators: [{ name: 'xpath', value: '//button' }, { name: 'css', value: '.old' }] },
    '9000': { id: '9000', locators: [] },
  },
  actionNames: ['launchApplication', 'click', 'executeQuery', 'storeJson', 'hover', 'type', 'weirdAction'],
  actionNamesByTech: {
    WEB: ['launchapplication', 'click', 'hover'],
    DATABASE: ['executequery', 'executequerybyname'],
    API: ['storejson', 'type'],
  },
  actionNamesByTemplate: { 'tpl-1': ['launchapplication', 'click'], 'tpl-9': ['hover'] },
  actionUniqueIds: ['db-2', 'db-3'],
  failingIterations: [2],
  usingTestcasesByObject: { '8812': ['TC-7', 'TC-8'] },
  usageScanned: 120,
  usageTruncated: true,
};

const diagnosis = (over: Partial<HealDiagnosis> = {}): HealDiagnosis => ({
  family: 'object_state', confidence: 0.9, reason: 'the locator moved', ...over,
});

function planOf(proposals: HealProposal[], over: {
  family?: HealDiagnosis['family']; domains?: Array<'object' | 'action' | 'parameter' | 'testdata'>;
  facts?: Partial<HealFacts>; runId?: string; now?: Date;
} = {}) {
  return buildHealPlan({
    tcId: 'TC-42',
    ...(over.runId ? { runId: over.runId } : {}),
    diagnosis: diagnosis(over.family ? { family: over.family } : {}),
    proposals,
    facts: { ...FACTS, ...(over.facts ?? {}) },
    ...(over.domains ? { domains: over.domains } : {}),
    ...(over.now ? { now: over.now } : {}),
  });
}

describe('heal.plan — object changes', () => {
  test('validates locators and property patches, refuses what cannot resolve, and reports the blast radius', () => {
    const proposals: HealProposal[] = [
      { domain: 'object', op: 'append_locator', objectId: '8812', locator: { name: 'css', value: '.new' }, reason: 'moved' },
      { domain: 'object', op: 'set_default', objectId: '8812', locatorName: 'CSS' },
      { domain: 'object', op: 'append_locator', objectId: '8812', locator: { name: 'data-testid', value: 'pay', unique: true } },
      { domain: 'object', op: 'set_default', objectId: '8812', locatorName: 'id' },
      { domain: 'object', op: 'set_default', objectId: '8812', locatorName: '  ' },
      { domain: 'object', op: 'append_locator', objectId: '8812', locator: { name: ' ', value: 'x' } },
      { domain: 'object', op: 'append_locator', objectId: '8812', locator: { name: 'css', value: '.old' } },
      { domain: 'object', op: 'update_property', objectId: '8812', property: { name: 'Pay', description: '', parameterNames: [] } },
      { domain: 'object', op: 'update_property', objectId: '8812', property: { parameterNames: [] } },
      { domain: 'object', op: 'append_locator', objectId: '9999', locator: { name: 'css', value: '.x' } },
      { domain: 'object', op: 'append_locator', objectId: '8812', step: 99, locator: { name: 'css', value: '.y' } },
      { domain: 'object', op: 'append_locator', objectId: '8812', step: 1, locator: { name: 'css', value: '.z' } },
      { domain: 'object', op: 'append_locator', objectId: '8812', locator: { name: 'css', value: '.new' }, reason: 'moved' },
      { domain: 'action', op: 'repoint_action', step: 2, actionType: 'Click' },
    ];

    const now = new Date('2026-11-17T09:00:00.000Z');
    const plan = planOf(proposals, { domains: ['object'], runId: 'run-9', now });

    expect(plan.contractVersion).toBe(1);
    expect(plan.planId).toMatch(/^[0-9a-f]{32}$/);
    expect(plan.tcId).toBe('TC-42');
    expect(plan.runId).toBe('run-9');
    expect(plan.baseVersionId).toBe('ver-1');
    expect(plan.createdAt).toBe('2026-11-17T09:00:00.000Z');
    expect(plan.diagnosis).toEqual({ family: 'object_state', confidence: 0.9, reason: 'the locator moved', healable: true });

    expect(plan.changes).toEqual([
      {
        domain: 'object', op: 'append_locator', target: 'object 8812',
        detail: { objectId: '8812', locator: { name: 'css', value: '.new' } },
        before: { name: 'css', value: '.old' }, reason: 'moved',
      },
      { domain: 'object', op: 'set_default', target: 'object 8812', detail: { objectId: '8812', locatorName: 'CSS' } },
      {
        domain: 'object', op: 'append_locator', target: 'object 8812',
        detail: { objectId: '8812', locator: { name: 'data-testid', value: 'pay', unique: true } },
      },
      {
        domain: 'object', op: 'update_property', target: 'object 8812',
        detail: { objectId: '8812', property: { name: 'Pay', description: '' } },
      },
    ]);

    expect(plan.skipped.map((s) => s.reason)).toEqual([
      'object 8812 has no locator "id" (not even after this plan\'s additions)',
      'set_default needs a locatorName',
      'locator needs a non-empty name and value',
      'object 8812 already has css=".old"',
      'update_property needs at least one of name / description / parameterNames',
      'object 9999 was not found in this project',
      'step 99 does not exist on TC-42',
      'step 1 uses object (none), not 8812',
      'duplicate proposal',
      'domain "action" was not requested for this heal',
    ]);
    expect(plan.skipped[0]).toEqual({
      reason: 'object 8812 has no locator "id" (not even after this plan\'s additions)',
      domain: 'object', op: 'set_default', target: '8812',
    });
    expect(plan.blastRadius).toEqual({
      objects: [{ objectId: '8812', sharedWithTestcases: ['TC-7', 'TC-8'], scanned: 120, truncated: true }],
    });

    // A patch that changes nothing is refused, and an unrelated object is still reported.
    const empty = planOf([
      { domain: 'object', op: 'update_property', objectId: '9000', property: {} },
      { domain: 'object', op: 'append_locator', objectId: '9000', locator: { name: 'css', value: '.x' } },
    ], { facts: { usingTestcasesByObject: undefined, usageScanned: undefined, usageTruncated: undefined } });
    expect(empty.diagnosis.healable).toBe(true);
    expect(empty.blastRadius.objects).toEqual([
      { objectId: '9000', sharedWithTestcases: [], scanned: 0, truncated: false },
    ]);
    expect(empty.skipped[0]!.reason).toBe('update_property needs at least one of name / description / parameterNames');
  });
});

describe('heal.plan — action repoints', () => {
  test('scopes an action to the step\'s template / technology, demands a DB uniqueId and rewrites a mismatch', () => {
    const proposals: HealProposal[] = [
      // Same name, but the step's current action belongs to another template → still rewritten.
      { domain: 'action', op: 'repoint_action', step: 2, actionType: 'Click' },
      { domain: 'action', op: 'repoint_action', step: 2, actionType: 'hover' },
      { domain: 'action', op: 'repoint_action', step: 1, actionType: 'type' },
      { domain: 'action', op: 'repoint_action', step: 1, actionType: 'nonsense' },
      // No template on the step → technology scope.
      { domain: 'action', op: 'repoint_action', step: 4, actionType: 'Click' },
      { domain: 'action', op: 'repoint_action', step: 4, actionType: 'executeQuery' },
      { domain: 'action', op: 'repoint_action', step: 4, actionType: 'nonsense' },
      // DATABASE must name the plugin uniqueId.
      { domain: 'action', op: 'repoint_action', step: 3, actionType: 'executeQuery' },
      { domain: 'action', op: 'repoint_action', step: 3, actionType: 'executeQuery', actionUniqueId: 'db-9' },
      { domain: 'action', op: 'repoint_action', step: 3, actionType: 'executeQuery', actionUniqueId: 'db-3' },
      { domain: 'action', op: 'repoint_action', step: 3, actionType: 'executeQuery', actionUniqueId: 'db-2' },
      // Steps with no action at all.
      { domain: 'action', op: 'repoint_action', step: 5, actionType: 'Click' },
      { domain: 'action', op: 'repoint_action', step: 6, actionType: 'Click' },
      { domain: 'action', op: 'repoint_action', step: 44, actionType: 'Click' },
      { domain: 'action', op: 'repoint_action', step: 2, actionType: '  ' },
      // Same name, no mismatch → nothing to do.
      { domain: 'action', op: 'repoint_action', step: 1, actionType: 'launchApplication' },
      // Second call of the same function under a technology that lacks it.
      { domain: 'action', op: 'repoint_action', step: 7, actionType: 'type' },
      // A name the catalog knows but no technology registers, and one it does not know at all.
      { domain: 'action', op: 'repoint_action', step: 1, actionType: 'weirdAction' },
      { domain: 'action', op: 'repoint_action', step: 9, actionType: 'weirdAction' },
      { domain: 'action', op: 'repoint_action', step: 10, actionType: 'nonsense' },
    ];

    const plan = planOf(proposals, { family: 'action_mismatch', domains: ['action'] });
    expect(plan.changes).toEqual([
      {
        domain: 'action', op: 'repoint_action', target: 'step 2',
        detail: { step: 2, actionType: 'Click' }, before: { actionType: 'click' },
      },
      {
        domain: 'action', op: 'repoint_action', target: 'step 3',
        detail: { step: 3, actionType: 'executeQuery', actionUniqueId: 'db-3' }, before: { actionType: 'executeQuery' },
      },
    ]);
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      'action "hover" belongs to object template tpl-9, but step 2 uses template tpl-1',
      'action "type" is not available for object template tpl-1 (step 1)',
      'action "nonsense" is not in this project\'s catalog',
      'action "Click" belongs to WEB, but step 4 is API',
      'action "executeQuery" belongs to DATABASE, but step 4 is API',
      'action "nonsense" is not in this project\'s catalog',
      'database step 3 needs actionUniqueId (e.g. "db-2") — "executeQuery" is registered more than once',
      'actionUniqueId "db-9" is not in this project\'s catalog',
      'step 3 already uses "executeQuery" (db-2)',
      'step 5 is an API request step — it has no action; fix the request/assertions instead',
      'step 6 is a control_flow step — it has no action to heal',
      'step 44 does not exist on TC-42',
      'repoint_action needs an actionType',
      'step 1 already uses "launchApplication"',
      'action "type" is not available for object template tpl-1 (step 7)',
      'action "weirdAction" is not available for object template tpl-1 (step 1)',
      'action "weirdAction" is not registered for WEB (step 9)',
      'action "nonsense" is not in this project\'s catalog',
    ]);
    expect(plan.skipped.every((s) => s.domain === 'action' && s.op === 'repoint_action')).toBe(true);
    expect(plan.changes.every((c) => !('actionUniqueId' in c.detail) || c.detail['actionUniqueId'] === 'db-3')).toBe(true);

    // A deprecated action is rewritten even when its name matches.
    const deprecatedFacts: Partial<HealFacts> = {
      steps: [{ n: 8, actionType: 'click', description: 'Click', stepType: 'normal_statement', technologyType: 'WEB', objectTemplateId: 'tpl-1', actionDeprecated: true }],
    };
    const deprecated = planOf([{ domain: 'action', op: 'repoint_action', step: 8, actionType: 'click' }], { family: 'action_mismatch', facts: deprecatedFacts });
    expect(deprecated.changes).toHaveLength(1);
    expect(deprecated.changes[0]!.before).toEqual({ actionType: 'click' });
    expect(deprecated.skipped).toEqual([]);
  });
});

describe('heal.plan — parameters, test data and the plan contract', () => {
  test('validates names/tokens/iterations, honours the requested domains, and orders apply', () => {
    const proposals: HealProposal[] = [
      { domain: 'testdata', op: 'set_cell', paramName: 'randomName', iterations: [2, 2], value: 'Priya' },
      { domain: 'action', op: 'repoint_action', step: 2, actionType: 'Click' },
      { domain: 'object', op: 'append_locator', objectId: '8812', locator: { name: 'css', value: '.new' } },
      { domain: 'parameter', op: 'create', name: 'randomName', defaultValue: 'X' },
      { domain: 'parameter', op: 'rebind', name: 'randomName', fromToken: 'literal' },
      { domain: 'parameter', op: 'create', name: 'bad!name' },
      { domain: 'parameter', op: 'rebind', name: 'randomName' } as HealProposal,
      { domain: 'parameter', op: 'rebind', name: 'randomName', fromToken: 'randomName' },
      { domain: 'testdata', op: 'set_cell', paramName: 'randomName', iterations: [1], value: 'nope' },
      { domain: 'testdata', op: 'set_cell', paramName: 'randomName', iterations: [1, 2], value: 'nope' },
      { domain: 'testdata', op: 'set_cell', paramName: 'randomName', iterations: [], value: 'nope' },
      { domain: 'testdata', op: 'set_cell', paramName: ' ', iterations: [2], value: 'nope' },
    ];
    const plan = planOf(proposals, { family: 'test_data' });

    expect(plan.changes.map((c) => [c.domain, c.op, c.target])).toEqual([
      ['parameter', 'create', 'parameter randomName'],
      ['parameter', 'rebind', 'parameter randomName'],
      ['object', 'append_locator', 'object 8812'],
      ['action', 'repoint_action', 'step 2'],
      ['testdata', 'set_cell', 'ITR 2'],
    ]);
    expect(plan.changes[0]!.detail).toEqual({ name: 'randomName', defaultValue: 'X' });
    expect(plan.changes[1]!.detail).toEqual({ name: 'randomName', fromToken: 'literal' });
    expect(plan.changes[4]!.detail).toEqual({ paramName: 'randomName', iterations: [2], value: 'Priya' });
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      '"bad!name" is not a valid parameter name',
      'rebind needs the literal token it replaces (fromToken)',
      'fromToken and name are identical — nothing to rebind',
      'iteration(s) 1 did not fail in this run — only failing iterations may be patched',
      'iteration(s) 1 did not fail in this run — only failing iterations may be patched',
      'set_cell needs at least one failing iteration',
      'set_cell needs a paramName',
    ]);
    expect(plan.diagnosis.healable).toBe(true);

    // A rebind that is valid is accepted, and a domain filter drops everything else.
    const rebind = planOf([
      { domain: 'parameter', op: 'rebind', name: 'randomName', fromToken: 'literal' },
      { domain: 'object', op: 'append_locator', objectId: '8812', locator: { name: 'css', value: '.new' } },
    ], { family: 'param_binding', domains: ['parameter'] });
    expect(rebind.changes).toEqual([
      { domain: 'parameter', op: 'rebind', target: 'parameter randomName', detail: { name: 'randomName', fromToken: 'literal' } },
    ]);
    expect(rebind.skipped).toEqual([{
      reason: 'domain "object" was not requested for this heal',
      domain: 'object', op: 'append_locator', target: '8812',
    }]);

    // The same plan is deterministic; a different change mints a different plan id.
    const a = planOf(proposals, { family: 'test_data' });
    const b = planOf(proposals, { family: 'test_data' });
    expect(a.planId).toBe(b.planId);
    const other = planOf([{ domain: 'parameter', op: 'create', name: 'another' }], { family: 'param_binding' });
    expect(other.planId).not.toBe(a.planId);
  });

  test('a non-healable family proposes nothing, and a healable family with no valid change is not healable', () => {
    const proposals: HealProposal[] = [
      { domain: 'object', op: 'append_locator', objectId: '8812', locator: { name: 'css', value: '.new' } },
      { domain: 'testdata', op: 'set_cell', paramName: 'randomName', iterations: [2], value: 'Priya' },
    ];
    const bug = planOf(proposals, { family: 'app_bug' });
    expect(bug.changes).toEqual([]);
    expect(bug.diagnosis.healable).toBe(false);
    expect(bug.skipped.map((s) => s.reason)).toEqual([
      'family "app_bug" is not healable — no change is proposed',
      'family "app_bug" is not healable — no change is proposed',
    ]);
    expect(bug.blastRadius).toEqual({ objects: [] });
    expect(bug.runId).toBeUndefined();

    const nothing = planOf([
      { domain: 'object', op: 'append_locator', objectId: 'nope', locator: { name: 'css', value: '.x' } },
    ], { family: 'locator' });
    expect(nothing.changes).toEqual([]);
    expect(nothing.diagnosis.healable).toBe(false);
    expect(nothing.skipped[0]!.reason).toBe('object nope was not found in this project');

    // No failing iterations recorded → test-data patches are not narrowed.
    const noFailures = planOf([
      { domain: 'testdata', op: 'set_cell', paramName: 'randomName', iterations: [1, 2], value: 'Priya' },
    ], { family: 'test_data', facts: { failingIterations: undefined } });
    expect(noFailures.changes).toHaveLength(1);
    expect(noFailures.changes[0]!.target).toBe('ITR 1,2');
  });
});
