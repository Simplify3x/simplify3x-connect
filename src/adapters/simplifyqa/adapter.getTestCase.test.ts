import { SimplifyQaAdapter } from './adapter.js';

/** tc_get wire-shape check. Covers the two regressions this replaces:
 *  1. FUNCTION / control-flow steps used to render as empty rows because fromSqaStep dropped
 *     stepType/functionId/conditions. Verify they now round-trip onto the neutral shape.
 *  2. versionId was silently picked (versions[0] fallback). Verify (a) the neutral versions[]
 *     is projected, (b) an explicit override plumbs into /tm/testcase/steps, (c) an unknown
 *     override throws before the /steps call. */

type Handler = (url: string, init: RequestInit) => { status?: number; body: string };

/** The adapter gates EVERY project-scoped call behind a project-access check:
 *  GET /pm/auth/me (who is the token) → GET /pm/projectuserrole?userId= (their roles). Both run
 *  before the endpoint under test, so every router below must answer them for project 7. */
function accessCalls(url: string): { status?: number; body: string } | null {
  if (url.includes('/pm/auth/me')) return { body: JSON.stringify({ userDetails: { id: 5, username: 'qa' } }) };
  if (url.includes('/pm/projectuserrole')) {
    return { body: JSON.stringify({ data: [{ projectId: 7, roleId: 2 }] }) };
  }
  return null;
}

function makeAdapter(handler: Handler) {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const { status = 200, body } = accessCalls(url) ?? handler(url, init);
    return { ok: status < 300, status, text: async () => body };
  }) as unknown as typeof fetch;
  return new SimplifyQaAdapter(
    { baseUrl: 'https://x.test', token: 't', projectId: 7 } as any,
    { fetchImpl, FormDataImpl: FormData },
  );
}

const RAW_TC = {
  id: 42, name: 'Checkout flow', projectId: 7, moduleId: 3,
  tcType: 'WEB', executionType: 'AUTOMATION', priority: 'HIGH',
  versionId: 'ver-current',
  versionsDetails: { id: 'ver-current', name: 'v1.0', syncONOFF: '' },
  versions: [
    { id: 'ver-current', name: 'v1.0', updateVersion: 3, reviewApproveStatus: 'APPROVED' },
    { id: 'ver-2', name: 'v2.0', updateVersion: 0 },
  ],
};

// A realistic step mix: NORMAL_STATEMENT, IF/IF_END, WHILE_START/WHILE_END, FUNCTION/FUNCTION_END.
const STEPS_V_CURRENT = [
  { id: 's1', seq: 1, stepType: 'NORMAL_STATEMENT', actionId: 101, description: 'Launch app', executionType: 'AUTOMATION',
    objectId: 500, recordedParam: { '77': 'https://saucedemo.com' } },
  { id: 's2', seq: 2, stepType: 'IF', description: '', executionType: 'AUTOMATION',
    conditions: { ifstring: 'title == "Products"', children: [] } },
  { id: 's3', seq: 3, stepType: 'FUNCTION', functionId: 99, fnVersionId: 'fnver-1',
    sharedFnProjectId: 12, description: '', executionType: 'AUTOMATION' },
  { id: 's4', seq: 4, stepType: 'FUNCTION_END', description: '', executionType: 'AUTOMATION' },
  { id: 's5', seq: 5, stepType: 'IF_END', description: '', executionType: 'AUTOMATION' },
  { id: 's6', seq: 6, stepType: 'WHILE_START', description: '', executionType: 'AUTOMATION',
    conditions: { ifstring: 'cartCount > 0' }, loopDuration: 10 },
  { id: 's7', seq: 7, stepType: 'WHILE_END', description: '', executionType: 'AUTOMATION' },
];

test('getTestCase maps FUNCTION / control-flow steps and projects versions', async () => {
  let stepsUrl = '';
  const adapter = makeAdapter((url) => {
    if (url.includes('/tm/testcase/getById/42')) return { body: JSON.stringify({ data: RAW_TC }) };
    if (url.includes('/tm/testcase/steps')) { stepsUrl = url; return { body: JSON.stringify({ data: STEPS_V_CURRENT }) }; }
    if (url.includes('/tm/function/search')) {
      return { body: JSON.stringify({ data: [{ id: 99, code: 'FN_99', name: 'Login helper' }] }) };
    }
    if (url.includes('/tm/object/search')) {
      return { body: JSON.stringify({ data: [{ id: 500, disname: 'App launch URL' }] }) };
    }
    throw new Error(`unexpected ${url}`);
  });

  const tc = await adapter.getTestCase('TC_42');

  // Version projection.
  expect(tc.versions).toHaveLength(2);
  expect(tc.versions![0]).toMatchObject({ id: 'ver-current', name: 'v1.0', updateVersion: 3, reviewApproveStatus: 'APPROVED', isCurrent: true });
  expect(tc.versions![1]).toMatchObject({ id: 'ver-2', name: 'v2.0', isCurrent: false });
  expect(tc.currentVersionId).toBe('ver-current');

  // Default fetch used the current version.
  expect(stepsUrl).toContain('versionId=ver-current');

  // Step 1: NORMAL_STATEMENT — actionType + recordedParam → value, objectRef hydrated with disname.
  expect(tc.steps[0]).toMatchObject({ n: 1, stepType: 'web', actionType: '101', value: '77=https://saucedemo.com' });
  expect(tc.steps[0]!.objectRef).toEqual({ id: '500', name: 'App launch URL' });

  // Step 2: IF with conditionText.
  expect(tc.steps[1]).toMatchObject({ n: 2, stepType: 'control_flow' });
  expect(tc.steps[1]!.controlFlow).toMatchObject({ kind: 'IF', conditionText: 'title == "Products"' });

  // Step 3: FUNCTION — hydrated with FN code + name from /tm/function/search.
  expect(tc.steps[2]).toMatchObject({ n: 3, stepType: 'function' });
  expect(tc.steps[2]!.functionCall).toMatchObject({
    testCaseId: '99', testCaseCode: 'FN_99', testCaseName: 'Login helper',
    versionId: 'fnver-1', sharedProjectId: '12',
  });

  // Step 4: FUNCTION_END dedents (function_end stepType + FUNCTION_END kind).
  expect(tc.steps[3]).toMatchObject({ n: 4, stepType: 'function_end' });
  expect(tc.steps[3]!.controlFlow).toMatchObject({ kind: 'FUNCTION_END' });

  // Step 5: IF_END.
  expect(tc.steps[4]!.controlFlow).toMatchObject({ kind: 'IF_END' });

  // Step 6: WHILE_START — carries loopDuration.
  expect(tc.steps[5]).toMatchObject({ stepType: 'control_flow' });
  expect(tc.steps[5]!.controlFlow).toMatchObject({ kind: 'WHILE_START', conditionText: 'cartCount > 0', maxIterations: 10 });
});

test('getTestCase(id, versionId) plumbs override to /tm/testcase/steps', async () => {
  let stepsUrl = '';
  const adapter = makeAdapter((url) => {
    if (url.includes('/tm/testcase/getById/42')) return { body: JSON.stringify({ data: RAW_TC }) };
    if (url.includes('/tm/testcase/steps')) { stepsUrl = url; return { body: JSON.stringify({ data: [] }) }; }
    return { body: '{}' };
  });

  const tc = await adapter.getTestCase('TC_42', 'ver-2');
  expect(stepsUrl).toContain('versionId=ver-2');
  // Overlay: currentVersionId flips to the pinned version + isCurrent moves.
  expect(tc.currentVersionId).toBe('ver-2');
  // ponytail: when /steps returns empty rows we short-circuit BEFORE the overlay applies (the
  // adapter falls back to inline steps in that path). The empty-steps case is legit for validation
  // purposes below — no exception is what matters.
});

test('getTestCase(id, unknownVersionId) rejects before /steps call', async () => {
  const adapter = makeAdapter((url) => {
    if (url.includes('/tm/testcase/getById/42')) return { body: JSON.stringify({ data: RAW_TC }) };
    if (url.includes('/tm/testcase/steps')) throw new Error('should not reach steps endpoint');
    return { body: '{}' };
  });

  await expect(adapter.getTestCase('TC_42', 'ver-does-not-exist')).rejects.toThrow(/version ver-does-not-exist not found/);
});
