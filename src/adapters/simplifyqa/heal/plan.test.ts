import { buildHealPlan, type HealFacts } from './plan.js';
import type { HealProposal } from '../../../domain/heal.js';

const facts = (over: Partial<HealFacts> = {}): HealFacts => ({
  tcId: 'TC-123',
  currentVersionId: 'v1',
  steps: [
    { n: 1, actionType: 'launchApplication', description: 'open the app', stepType: 'web', technologyType: 'WEB' },
    { n: 2, actionType: 'click', description: 'sign in', objectId: '8812', objectTemplateId: '3', actionObjectTemplateId: '5', stepType: 'web', technologyType: 'WEB' },
    { n: 3, actionType: 'enterText', description: 'type ${randomName}', objectId: '8813', objectTemplateId: '3', actionObjectTemplateId: '3', stepType: 'web', technologyType: 'WEB' },
    { n: 4, actionType: 'executeRestAPI', description: 'call the API', stepType: 'api', technologyType: 'API', isApiRequest: true },
    { n: 5, actionType: 'executeQuery', description: 'read the DB', stepType: 'database', technologyType: 'DATABASE' },
    { n: 6, actionType: 'Store from JSON', description: 'get value from JSON and store it', stepType: 'api', technologyType: 'API' },
  ],
  objects: {
    '8812': { id: '8812', objectTemplateId: '3', locators: [{ name: 'css', value: '#login', unique: true }] },
    '8813': { id: '8813', objectTemplateId: '3', locators: [{ name: 'id', value: 'name-field' }] },
  },
  actionNames: [
    'click', 'entertext', 'selectitem', 'launchapplication',
    'longpress', 'executequery', 'updatequery', 'executerestapi',
  ],
  actionNamesByTech: {
    WEB: ['click', 'entertext', 'selectitem', 'launchapplication'],
    ANDROID: ['click', 'entertext', 'longpress'],
    DATABASE: ['executequery', 'updatequery'],
    API: ['execute rest api', 'store from json', 'get value from json'],
  },
  actionNamesByTemplate: {
    '3': ['click', 'entertext', 'selectitem', 'launchapplication'],
    '5': ['click', 'entertext', 'longpress'],
    '7': ['executequery', 'updatequery'],
  },
  actionUniqueIds: ['db-2', 'db-3'],
  failingIterations: [2],
  ...over,
});

const diagnosis = { family: 'locator' as const, confidence: 0.9 };

describe('heal planner', () => {
  test('accepts an appended locator and orders domains parameter → object → action → testdata', () => {
    const proposals: HealProposal[] = [
      { domain: 'testdata', op: 'set_cell', paramName: 'randomName', iterations: [2], value: 'Taks_new' },
      { domain: 'action', op: 'repoint_action', step: 2, actionType: 'selectItem' },
      { domain: 'object', op: 'append_locator', objectId: '8812', step: 2, locator: { name: 'css', value: '#login button.submit' } },
      { domain: 'parameter', op: 'create', name: 'randomName' },
    ];
    const plan = buildHealPlan({ tcId: 'TC-123', diagnosis, proposals, facts: facts() });

    expect(plan.changes.map((c) => c.domain)).toEqual(['parameter', 'object', 'action', 'testdata']);
    expect(plan.diagnosis.healable).toBe(true);
    expect(plan.skipped).toHaveLength(0);
    expect(plan.baseVersionId).toBe('v1');
  });

  test('set_default may reference a locator appended earlier in the same plan', () => {
    const plan = buildHealPlan({
      tcId: 'TC-123',
      diagnosis,
      facts: facts(),
      proposals: [
        { domain: 'object', op: 'append_locator', objectId: '8812', locator: { name: 'xpath', value: '//button' } },
        { domain: 'object', op: 'set_default', objectId: '8812', locatorName: 'xpath' },
      ],
    });
    expect(plan.changes).toHaveLength(2);
    expect(plan.changes[1]?.detail['locatorName']).toBe('xpath');
  });

  test('drops a locator that is already identical on the object', () => {
    const plan = buildHealPlan({
      tcId: 'TC-123',
      diagnosis,
      facts: facts(),
      proposals: [{ domain: 'object', op: 'append_locator', objectId: '8812', locator: { name: 'css', value: '#login' } }],
    });
    expect(plan.changes).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toContain('already has');
  });

  test('drops an object change aimed at a step that uses a DIFFERENT object', () => {
    const plan = buildHealPlan({
      tcId: 'TC-123',
      diagnosis,
      facts: facts(),
      proposals: [{ domain: 'object', op: 'append_locator', objectId: '8813', step: 2, locator: { name: 'css', value: '.x' } }],
    });
    expect(plan.changes).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toContain('uses object 8812');
  });

  test('action repoint must exist in the catalog and differ from the current action', () => {
    const plan = buildHealPlan({
      tcId: 'TC-123',
      diagnosis,
      facts: facts(),
      proposals: [
        { domain: 'action', op: 'repoint_action', step: 2, actionType: 'notARealAction' },
        { domain: 'action', op: 'repoint_action', step: 1, actionType: 'launchApplication' },
        { domain: 'action', op: 'repoint_action', step: 99, actionType: 'click' },
      ],
    });
    expect(plan.changes).toHaveLength(0);
    expect(plan.skipped.map((s) => s.reason).join(' | ')).toContain('not in this project');
    expect(plan.skipped.map((s) => s.reason).join(' | ')).toContain('already uses');
    expect(plan.skipped.map((s) => s.reason).join(' | ')).toContain('does not exist');
  });

  test('an action registered only for ANOTHER technology is refused (step without an object)', () => {
    const plan = buildHealPlan({
      tcId: 'TC-123',
      diagnosis,
      facts: facts(),
      proposals: [{ domain: 'action', op: 'repoint_action', step: 1, actionType: 'longPress' }],
    });
    expect(plan.changes).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toContain('belongs to ANDROID');
  });

  test('an action registered under ANOTHER object template is refused', () => {
    const plan = buildHealPlan({
      tcId: 'TC-123',
      diagnosis,
      facts: facts(),
      proposals: [{ domain: 'action', op: 'repoint_action', step: 2, actionType: 'longPress' }],
    });
    expect(plan.changes).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toContain('belongs to object template 5');
  });

  test('an action from the same object template is accepted', () => {
    const plan = buildHealPlan({
      tcId: 'TC-123',
      diagnosis,
      facts: facts(),
      proposals: [{ domain: 'action', op: 'repoint_action', step: 2, actionType: 'selectItem' }],
    });
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]?.detail['actionType']).toBe('selectItem');
  });

  test('a WEB step accepts a WEB action', () => {
    const plan = buildHealPlan({
      tcId: 'TC-123',
      diagnosis,
      facts: facts(),
      proposals: [{ domain: 'action', op: 'repoint_action', step: 2, actionType: 'selectItem' }],
    });
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]?.detail['actionType']).toBe('selectItem');
  });

  test('an API request step has no action to heal', () => {
    const plan = buildHealPlan({
      tcId: 'TC-123',
      diagnosis: { family: 'action_mismatch', confidence: 0.7 },
      facts: facts(),
      proposals: [{ domain: 'action', op: 'repoint_action', step: 4, actionType: 'selectItem' }],
    });
    expect(plan.changes).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toContain('API request step');
  });

  test('a generic-action API step IS healed (kept generic, never converted to an API request)', () => {
    const plan = buildHealPlan({
      tcId: 'TC-123',
      diagnosis: { family: 'action_mismatch', confidence: 0.7 },
      facts: facts(),
      proposals: [{ domain: 'action', op: 'repoint_action', step: 6, actionType: 'Get value from JSON' }],
    });
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]?.detail['actionType']).toBe('Get value from JSON');
    expect(plan.skipped).toHaveLength(0);
  });

  test('a DATABASE repoint without actionUniqueId is refused', () => {
    const plan = buildHealPlan({
      tcId: 'TC-123',
      diagnosis: { family: 'action_mismatch', confidence: 0.7 },
      facts: facts(),
      proposals: [{ domain: 'action', op: 'repoint_action', step: 5, actionType: 'updateQuery' }],
    });
    expect(plan.changes).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toContain('needs actionUniqueId');
  });

  test('a DATABASE repoint carries its uniqueId (same name, different overload)', () => {
    const plan = buildHealPlan({
      tcId: 'TC-123',
      diagnosis: { family: 'action_mismatch', confidence: 0.7 },
      facts: facts(),
      proposals: [{ domain: 'action', op: 'repoint_action', step: 5, actionType: 'executeQuery', actionUniqueId: 'db-3' }],
    });
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]?.detail['actionUniqueId']).toBe('db-3');
  });

  test('same NAME but a mismatched action template is rewritten (the blank-action fix)', () => {
    const plan = buildHealPlan({
      tcId: 'TC-123',
      diagnosis: { family: 'action_mismatch', confidence: 0.8 },
      facts: facts(),
      proposals: [{ domain: 'action', op: 'repoint_action', step: 2, actionType: 'click' }],
    });
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]?.detail['actionType']).toBe('click');
  });

  test('same name + same template is a no-op', () => {
    const plan = buildHealPlan({
      tcId: 'TC-123',
      diagnosis: { family: 'action_mismatch', confidence: 0.8 },
      facts: facts(),
      proposals: [{ domain: 'action', op: 'repoint_action', step: 3, actionType: 'enterText' }],
    });
    expect(plan.changes).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toContain('already uses');
  });

  test('a DEPRECATED action is rewritten even when name and template match', () => {
    const f = facts();
    f.steps = f.steps.map((s) => (s.n === 3 ? { ...s, actionDeprecated: true } : s));
    const plan = buildHealPlan({
      tcId: 'TC-123',
      diagnosis: { family: 'action_mismatch', confidence: 0.8 },
      facts: f,
      proposals: [{ domain: 'action', op: 'repoint_action', step: 3, actionType: 'enterText' }],
    });
    expect(plan.changes).toHaveLength(1);
  });

  test('a parameter name that is not a valid token is dropped', () => {
    const plan = buildHealPlan({
      tcId: 'TC-123',
      diagnosis,
      facts: facts(),
      proposals: [{ domain: 'parameter', op: 'create', name: '${oops}' }],
    });
    expect(plan.changes).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toContain('not a valid parameter name');
  });

  test('test data may only target iterations that failed in this run', () => {
    const plan = buildHealPlan({
      tcId: 'TC-123',
      diagnosis,
      facts: facts(),
      proposals: [{ domain: 'testdata', op: 'set_cell', paramName: 'randomName', iterations: [1], value: 'x' }],
    });
    expect(plan.changes).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toContain('did not fail');
  });

  test('a non-healable family proposes nothing and explains why', () => {
    const plan = buildHealPlan({
      tcId: 'TC-123',
      diagnosis: { family: 'app_bug', confidence: 0.8 },
      facts: facts(),
      proposals: [{ domain: 'object', op: 'append_locator', objectId: '8812', locator: { name: 'css', value: '.x' } }],
    });
    expect(plan.changes).toHaveLength(0);
    expect(plan.diagnosis.healable).toBe(false);
    expect(plan.skipped[0]?.reason).toContain('not healable');
  });

  test('respects a domain allow-list', () => {
    const plan = buildHealPlan({
      tcId: 'TC-123',
      diagnosis: { family: 'param_binding', confidence: 0.8 },
      facts: facts(),
      domains: ['parameter', 'testdata'],
      proposals: [
        { domain: 'object', op: 'append_locator', objectId: '8812', locator: { name: 'css', value: '.x' } },
        { domain: 'parameter', op: 'create', name: 'randomName' },
      ],
    });
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]?.domain).toBe('parameter');
    expect(plan.skipped[0]?.reason).toContain('not requested');
  });

  test('planId is deterministic for identical inputs', () => {
    const proposals: HealProposal[] = [{ domain: 'parameter', op: 'create', name: 'randomName' }];
    const a = buildHealPlan({ tcId: 'TC-123', diagnosis, facts: facts(), proposals });
    const b = buildHealPlan({ tcId: 'TC-123', diagnosis, facts: facts(), proposals });
    expect(a.planId).toBe(b.planId);
  });
});
