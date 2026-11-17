import { SimplifyQaAdapter } from './adapter.js';
import { HEAL_CONTRACT_VERSION, type HealChange, type HealPlan } from '../../domain/heal.js';

/** HEAL path: `getHealFacts` (the live evidence the pure planner reasons about) and
 *  `applyHealPlan` (the change-set → ONE new test-case version).
 *
 *  Facts must be read, never guessed: a hydrated SQA step carries the numeric action FK, the
 *  shared object carries the locators, and the ONLY allowed test-data iterations are the ones the
 *  failing run actually executed. Apply must merge object changes, save one SAVENEWVERSION, patch
 *  the failing iterations, and report — never half-apply silently. */

type Call = { method: string; url: string; body?: any; form?: FormData };

const CALLER_ID = 36;
const PROJECT_ID = 7;

const RAW_TC = {
  id: 42,
  name: 'Checkout flow',
  code: 'TC_42',
  projectId: 7,
  moduleId: 0,
  userstoryId: 0,
  tcType: 'WEB',
  executionType: 'AUTOMATION',
  versionId: 'ver-1',
  versions: [{ id: 'ver-1', name: 'v1.0' }],
};

const RAW_STEPS = [
  {
    id: 'st-1', seq: 1, description: 'Launch the app', actionId: 178,
    stepType: 'NORMAL_STATEMENT', executionType: 'AUTOMATION', technologyType: 'WEB',
  },
  {
    id: 'st-2', seq: 2, description: 'Click the pay button', actionId: 181,
    objectId: '901', object: { id: '901', name: 'Pay button' },
    stepType: 'NORMAL_STATEMENT', executionType: 'AUTOMATION', technologyType: 'WEB',
  },
];

const OBJECT_901 = {
  id: 901,
  disname: 'Pay button',
  objecttemplateId: 1,
  technology: 'WEB',
  attributes: [
    { name: 'xpath', value: '//button[@id="pay"]' },
    { name: 'css', value: '#pay', unique: true },
  ],
};

const ACTION_ROWS = [
  { id: 178, name: 'launchApplication', disname: 'Launch Application', objectTemplate: 1, objectRequired: false },
  { id: 181, name: 'click', disname: 'Click', objectTemplate: 1, objectRequired: true },
];

function makeAdapter(overrides: { tc?: any; steps?: any[]; actions?: any[]; object?: any; report?: any } = {}) {
  const calls: Call[] = [];
  // Stateful object document: a PUT is visible to the next GET (so a rollback can be asserted).
  let objectDoc: any = JSON.parse(JSON.stringify(overrides.object ?? OBJECT_901));
  const handler = (url: string, init: RequestInit): { status?: number; body: string } => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body !== undefined && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const call: Call = { method, url, ...(body !== undefined ? { body } : {}) };
    if (init.body instanceof FormData) call.form = init.body;
    calls.push(call);

    if (url.includes('/pm/auth/me')) {
      return { body: JSON.stringify({
        userDetails: { id: CALLER_ID, username: 'qa.user', email: 'qa.user@x.test', userType: 'user' },
      }) };
    }
    if (url.includes('/pm/projectuserrole') && url.includes(`userId=${CALLER_ID}`)) {
      return { body: JSON.stringify({ data: [{ userId: CALLER_ID, projectId: PROJECT_ID, roleId: 2, deleted: false }] }) };
    }
    if (url.includes('/tm/testcase/getById/42')) {
      return { body: JSON.stringify({ data: overrides.tc ?? RAW_TC }) };
    }
    if (url.includes('/tm/testcase/steps')) {
      return { body: JSON.stringify({ data: overrides.steps ?? RAW_STEPS }) };
    }
    if (url.includes('/tm/action/search')) {
      return { body: JSON.stringify({ data: overrides.actions ?? ACTION_ROWS }) };
    }
    if (url.includes('/tm/objectTemplate/search')) {
      return { body: JSON.stringify({ data: [{ id: 1, name: 'WEB' }] }) };
    }
    if (url === 'https://x.test/tm/object/901') {
      if (method === 'PUT') {
        objectDoc = { ...objectDoc, ...(body?.attributes ? { attributes: body.attributes } : {}) };
        return { body: JSON.stringify({ data: objectDoc }) };
      }
      return { body: JSON.stringify({ data: objectDoc }) };
    }
    if (url.includes('/tm/object/search')) {
      return { body: JSON.stringify({ data: [objectDoc] }) };
    }
    if (url.includes('/exec/report/')) {
      if (overrides.report === 'fail') return { status: 500, body: JSON.stringify({ message: 'report unavailable' }) };
      return { body: JSON.stringify(overrides.report ?? [
        { id: 'run-a', status: 'PASSED', itr: 1 },
        { id: 'run-b', status: 'FAILED', itr: 2 },
      ]) };
    }
    if (method === 'PUT' && url.endsWith('/tm/testcase')) {
      if (overrides.report === 'saveFail') return { status: 400, body: JSON.stringify({ message: 'validation failed' }) };
      return { body: JSON.stringify({ data: { id: 42, versionId: 'ver-2' } }) };
    }
    if (url.includes('/pm/fields/8')) {
      return { body: JSON.stringify([{ key: 'general', name: 'General' }]) };
    }
    if (url.includes('/tm/testdata/getDefaultItr')) {
      return { body: JSON.stringify({ data: { parametersData: { '501': { value: 'Pay' } } } }) };
    }
    if (url.includes('/tm/parameter/501')) {
      return { body: JSON.stringify({ data: { id: 501, name: 'button', protected: false } }) };
    }
    if (url.includes('/tm/testdata/searchItr')) {
      return { body: JSON.stringify({ data: [
        { id: 'itr-1', parentId: 'td-1', sequenceNo: 1, customerId: 9, data: [{ paramId: 501, value: 'Pay' }] },
        { id: 'itr-2', parentId: 'td-1', sequenceNo: 2, customerId: 9, data: [{ paramId: 501, value: 'Pay' }] },
      ] }) };
    }
    if (url.includes('/tm/testdata/updateItr')) {
      return { body: JSON.stringify({ data: { ok: true } }) };
    }
    return { status: 404, body: JSON.stringify({ message: `unexpected ${method} ${url}` }) };
  };

  const fetchImpl = (async (url: string, init: RequestInit) => {
    const { status = 200, body } = handler(url, init);
    return { ok: status < 300, status, text: async () => body };
  }) as unknown as typeof fetch;

  const adapter = new SimplifyQaAdapter(
    { baseUrl: 'https://x.test', token: 't', projectId: PROJECT_ID } as any,
    { fetchImpl, FormDataImpl: FormData },
  );
  return { adapter, calls };
}

function plan(changes: HealChange[], extra: Partial<HealPlan> = {}): HealPlan {
  return {
    contractVersion: HEAL_CONTRACT_VERSION,
    planId: 'abcdef1234567890',
    tcId: 'TC_42',
    baseVersionId: 'ver-1',
    diagnosis: { family: 'object_state', confidence: 0.9, healable: true },
    changes,
    skipped: [],
    blastRadius: { objects: [] },
    createdAt: '2026-03-01T00:00:00.000Z',
    ...extra,
  };
}

const APPEND_LOCATOR: HealChange = {
  domain: 'object',
  op: 'append_locator',
  target: 'object 901',
  detail: { objectId: '901', locator: { name: 'id', value: 'pay-btn' } },
  reason: 'locator no longer matches',
};

const SET_DEFAULT: HealChange = {
  domain: 'object',
  op: 'set_default',
  target: 'object 901',
  detail: { objectId: '901', locatorName: 'id' },
  reason: 'the new locator is the stable one',
};

const REPOINT_ACTION: HealChange = {
  domain: 'action',
  op: 'repoint_action',
  target: 'step 2',
  detail: { step: 2, actionType: 'click', actionUniqueId: 'web-7' },
};

const SET_CELL: HealChange = {
  domain: 'testdata',
  op: 'set_cell',
  target: 'ITR-2',
  detail: { paramName: 'button', iterations: [2], value: 'Pay now' },
};

test('getHealFacts resolves the numeric action FK to its catalog name and reads the shared object', async () => {
  const { adapter, calls } = makeAdapter();

  const facts = await adapter.getHealFacts('TC_42', { runId: '555' });

  expect(facts.tcId).toBe('TC_42');
  expect(facts.currentVersionId).toBe('ver-1');
  expect(facts.steps).toEqual([
    {
      n: 1, actionType: 'launchApplication', description: 'Launch the app',
      stepType: 'web', technologyType: 'WEB', actionObjectTemplateId: '1',
    },
    {
      n: 2, actionType: 'click', description: 'Click the pay button',
      stepType: 'web', technologyType: 'WEB', actionObjectTemplateId: '1', objectId: '901', objectTemplateId: '1',
    },
  ]);
  // Object template + technology come from the catalog, never from the step row alone.
  expect(facts.actionNames).toEqual(expect.arrayContaining(['launchapplication', 'launch application', 'click']));
  expect(facts.actionNamesByTech!['WEB']).toEqual(
    expect.arrayContaining(['launchapplication', 'launch application', 'click']),
  );
  expect(facts.actionNamesByTemplate!['1']).toEqual(expect.arrayContaining(['click']));

  expect(facts.objects['901']).toEqual({
    id: '901',
    objectTemplateId: '1',
    locators: [
      { name: 'xpath', value: '//button[@id="pay"]' },
      { name: 'css', value: '#pay', unique: true },
    ],
  });
  // ONLY the iteration the failing run executed may be patched.
  expect(facts.failingIterations).toEqual([2]);
  expect(calls.some((c) => c.url.endsWith('/tm/object/901'))).toBe(true);
});

test('getHealFacts falls back to GET /tm/action/:id for an id the catalog misses, and keeps an unresolvable id raw', async () => {
  const steps = [
    { seq: 1, description: 'Open URL', actionType: 'Launch Application', stepType: 'NORMAL_STATEMENT', technologyType: 'WEB' },
    { seq: 2, description: 'Custom', actionId: 999, stepType: 'NORMAL_STATEMENT', technologyType: 'WEB' },
    { seq: 3, description: 'Gone', actionId: 404, stepType: 'NORMAL_STATEMENT', technologyType: 'WEB' },
  ];
  const calls: Call[] = [];
  const handler = (url: string): { status?: number; body: string } => {
    calls.push({ method: 'GET', url });
    if (url.includes('/pm/auth/me')) return { body: JSON.stringify({ userDetails: { id: CALLER_ID } }) };
    if (url.includes('/pm/projectuserrole')) return { body: JSON.stringify({ data: [{ projectId: PROJECT_ID, roleId: 2 }] }) };
    if (url.includes('/tm/testcase/getById/42')) return { body: JSON.stringify({ data: RAW_TC }) };
    if (url.includes('/tm/testcase/steps')) return { body: JSON.stringify({ data: steps }) };
    if (url.includes('/tm/action/search')) return { body: JSON.stringify({ data: ACTION_ROWS }) };
    if (url.includes('/tm/objectTemplate/search')) return { body: JSON.stringify({ data: [{ id: 1, name: 'WEB' }] }) };
    if (url.endsWith('/tm/action/999')) {
      return { body: JSON.stringify({ data: { id: 999, name: 'waitForText', objectRequired: false } }) };
    }
    if (url.endsWith('/tm/action/404')) return { status: 404, body: JSON.stringify({ message: 'not found' }) };
    return { status: 404, body: JSON.stringify({ message: `unexpected ${url}` }) };
  };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    void init;
    const { status = 200, body } = handler(url);
    return { ok: status < 300, status, text: async () => body };
  }) as unknown as typeof fetch;
  const adapter = new SimplifyQaAdapter(
    { baseUrl: 'https://x.test', token: 't', projectId: PROJECT_ID } as any,
    { fetchImpl, FormDataImpl: FormData },
  );

  const facts = await adapter.getHealFacts('TC_42');

  expect(facts.steps.map((s) => s.actionType)).toEqual(['launchApplication', 'waitForText', '404']);
  expect(facts.failingIterations).toBeUndefined(); // no runId asked for
  expect(calls.some((c) => c.url.endsWith('/tm/action/999'))).toBe(true);
});

test('getHealFacts treats failing iterations as best-effort — an unreadable report is not fatal', async () => {
  const { adapter } = makeAdapter({ report: 'fail' });
  const facts = await adapter.getHealFacts('TC_42', { runId: '555' });
  expect(facts.failingIterations).toBeUndefined();
  expect(facts.steps).toHaveLength(2);
});

test('applyHealPlan with no changes reports why and never writes', async () => {
  const { adapter, calls } = makeAdapter();
  const report = await adapter.applyHealPlan(plan([], {
    diagnosis: { family: 'timeout', confidence: 0.7, healable: false },
  }));

  expect(report.applied).toEqual([]);
  expect(report.skipped).toEqual([{ reason: 'not healable: timeout' }]);
  expect(report.versionId).toBeUndefined();
  expect(report.partial).toBeUndefined();
  expect(calls).toEqual([]); // not even the test case is read
});

test('applyHealPlan refuses a plan built against a stale base version', async () => {
  const { adapter, calls } = makeAdapter();
  await expect(
    adapter.applyHealPlan(plan([APPEND_LOCATOR], { baseVersionId: 'ver-0' })),
  ).rejects.toThrow(/heal plan is stale[\s\S]*ver-0[\s\S]*ver-1/);
  expect(calls.some((c) => c.method === 'PUT')).toBe(false);
});

test('applyHealPlan merges the object change, saves ONE new version and patches only the failing iteration', async () => {
  const { adapter, calls } = makeAdapter();

  const report = await adapter.applyHealPlan(plan([APPEND_LOCATOR, SET_DEFAULT, REPOINT_ACTION, SET_CELL]));

  expect(report.versionId).toBe('ver-2');
  expect(report.productUrl).toBe('https://x.test/user/testcase/details/42');
  expect(report.applied.map((c) => c.domain)).toEqual(['object', 'object', 'action', 'testdata']);
  expect(report.skipped).toEqual([]);
  expect(report.partial).toBeUndefined();
  expect(report.error).toBeUndefined();

  // --- object: one merged PUT that keeps the untouched locator and makes the new one default.
  const objectPut = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/tm/object/901'))!;
  expect(objectPut.body.attributes).toEqual([
    { name: 'xpath', value: '//button[@id="pay"]' },      // untouched locator survives the merge
    { name: 'css', value: '#pay' },                       // previous default, now un-flagged
    { name: 'id', value: 'pay-btn', unique: true },       // appended and made the default
  ]);
  expect(objectPut.body).toMatchObject({
    disname: 'Pay button',
    technology: 'WEB',
    objecttemplateId: 1,
    parameterId: [],
    projectId: PROJECT_ID,
  });

  // --- one SAVENEWVERSION carrying the repointed step, with the version stub the backend needs.
  const save = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/tm/testcase'))!;
  const payload = JSON.parse(String(save.form!.get('testcaseObj')));
  expect(payload.operation).toBe('SAVENEWVERSION');
  expect(payload.type).toBe('TC');
  expect(payload.tcfnObj.id).toBe(42);
  expect(payload.versionsDetails).toMatchObject({ id: '', name: 'healed-abcdef12' });
  expect(payload.verData).toEqual({ tdCopy: true, selVersionId: 'ver-1' });
  expect(payload.steps.automationSteps).toHaveLength(2);
  expect(payload.steps.automationSteps[1]).toMatchObject({
    actionId: 181,
    objectId: 901,
    description: 'Click the pay button',
  });

  // --- test data: the DEFAULT row (ITR-1) is untouched; only the failing iteration is written.
  const updates = calls.filter((c) => c.url.includes('/tm/testdata/updateItr'));
  expect(updates).toHaveLength(1);
  expect(updates[0]!.body).toEqual({
    parentId: 'td-1',
    id: 'itr-2',
    customerId: 9,
    projectId: PROJECT_ID,
    data: [{ paramId: 501, value: 'Pay now' }],
  });
});

test('applyHealPlan reports a partial apply when the new version cannot be saved, and restores the object default', async () => {
  const { adapter, calls } = makeAdapter({ report: 'saveFail' });

  const report = await adapter.applyHealPlan(plan([APPEND_LOCATOR, SET_DEFAULT, REPOINT_ACTION, SET_CELL]));

  expect(report.partial).toBe(true);
  expect(report.error).toMatch(/HTTP 400/);
  expect(report.versionId).toBeUndefined();
  // Object changes landed (they are applied before the version save); the step + testdata changes did not.
  expect(report.applied.map((c) => c.domain)).toEqual(['object', 'object']);
  expect(calls.some((c) => c.url.includes('/tm/testdata/updateItr'))).toBe(false);

  // Rollback: the object's previous default locator is put back so the shared library is not left
  // pointing at a fix that no test case uses.
  const objectPuts = calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/tm/object/901'));
  expect(objectPuts).toHaveLength(2);
  // The second PUT is the rollback: the locator added by the failed apply stays (it is shared), but
  // the DEFAULT goes back to the one the plan replaced.
  expect(objectPuts[1]!.body.attributes).toEqual([
    { name: 'xpath', value: '//button[@id="pay"]' },
    { name: 'css', value: '#pay', unique: true },
    { name: 'id', value: 'pay-btn' },
  ]);
});

test('applyHealPlan refuses to repoint a DATABASE step without an actionUniqueId', async () => {
  const dbSteps = [
    { seq: 1, description: 'Run query', actionId: 700, stepType: 'NORMAL_STATEMENT', technologyType: 'DATABASE' },
  ];
  const { adapter, calls } = makeAdapter({ steps: dbSteps });
  const change: HealChange = {
    domain: 'action',
    op: 'repoint_action',
    target: 'step 1',
    detail: { step: 1, actionType: 'executeQuery' },
  };

  const report = await adapter.applyHealPlan(plan([change]));

  expect(report.partial).toBe(true);
  expect(report.error).toMatch(/DATABASE step — changing its action needs an actionUniqueId/);
  expect(report.versionId).toBeUndefined();
  expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/tm/testcase'))).toBe(false);
});
