import { SimplifyQaAdapter } from './adapter.js';

/** Smallest end-to-end check on the STEPSTOFN wire shape. Backend contract mirrors
 *  create-new-fn-modal.component.ts:88-197: operation=STEPSTOFN, type=FN, verData carries
 *  {tdCopy, testcaseId, fromParent:'TC', selVersionId}, steps split by executionType, each
 *  step resequenced 1..N with type='FN' and moduleId=<newFn moduleId>, server-assigned ids
 *  stripped, parameterIds narrowed to numeric refs. If any of those regress the backend either
 *  overwrites the wrong function or rejects the payload — pin them here. */

type Handler = (url: string, init: RequestInit) => { status?: number; body: string };

/** The adapter's project-access guard runs before ANY project-scoped request, so the mock router
 *  has to answer the two calls it makes: `GET /pm/auth/me` (which user the token belongs to) and
 *  `GET /pm/projectuserrole?userId=` (the roles that user holds). Without them the guard fails
 *  closed with "Could not verify your access to project 7". Payload shapes mirror the real backend. */
const CALLER_ID = 36;
const PROJECT_ID = 7;

function projectAccess(url: string): { status?: number; body: string } | null {
  if (url.includes('/pm/auth/me')) {
    return { body: JSON.stringify({
      userDetails: { id: CALLER_ID, username: 'qa.user', email: 'qa.user@x.test', userType: 'user' },
    }) };
  }
  if (url.includes('/pm/projectuserrole') && url.includes(`userId=${CALLER_ID}`)) {
    return { body: JSON.stringify({
      data: [{ userId: CALLER_ID, projectId: PROJECT_ID, roleId: 2, deleted: false }],
    }) };
  }
  return null;
}

function makeAdapter(handler: Handler) {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const { status = 200, body } = projectAccess(url) ?? handler(url, init);
    return { ok: status < 300, status, text: async () => body };
  }) as unknown as typeof fetch;
  return new SimplifyQaAdapter(
    { baseUrl: 'https://x.test', token: 't', projectId: 7 } as any,
    { fetchImpl, FormDataImpl: FormData },
  );
}

test('STEPSTOFN payload extracts picked steps into a new FN under moduleId', async () => {
  let captured: any = null;
  const rawTc = {
    id: 42, projectId: 7, moduleId: 3, tcType: 'WEB', executionType: 'AUTOMATION',
    versionId: 'ver-current',
    versionsDetails: { id: 'ver-current', name: 'v1.0' },
  };
  const rawSteps = [
    { id: 'a', seq: 1, description: 'Launch', executionType: 'AUTOMATION',
      technologyType: 'WEB', versionId: 'ver-current', parameterIds: [11, 'nope', 22] },
    { id: 'b', seq: 2, description: 'Login', executionType: 'AUTOMATION',
      technologyType: 'WEB', versionId: 'ver-current' },
    { id: 'c', seq: 3, description: 'Skip me', executionType: 'AUTOMATION',
      technologyType: 'WEB', versionId: 'ver-current' },
    { id: 'd', seq: 4, description: 'Manual check', executionType: 'MANUAL',
      technologyType: 'WEB', versionId: 'ver-current' },
  ];

  const adapter = makeAdapter((url, init) => {
    if (url.includes('/tm/testcase/getById/42')) return { body: JSON.stringify({ data: rawTc }) };
    if (url.includes('/tm/testcase/steps')) return { body: JSON.stringify({ data: rawSteps }) };
    if (init.method === 'POST' && url.endsWith('/tm/function')) {
      captured = JSON.parse(String((init.body as FormData).get('functionObj')));
      return { body: JSON.stringify({ data: { id: 99, code: 'FN_99' } }) };
    }
    throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
  });

  const ref = await adapter.saveStepsAsFunction('TC_42', {
    stepSeqs: [1, 2, 4],
    name: 'Login flow',
    moduleId: 8,
    copyTestData: true,
  });

  expect(captured.operation).toBe('STEPSTOFN');
  expect(captured.type).toBe('FN');
  expect(captured.tcfnObj).toEqual({
    name: 'Login flow',
    projectId: 7,
    moduleId: 8,
    executionType: 'DUO',          // both buckets populated (seq 1,2 AUTOMATION + seq 4 MANUAL)
    fnType: 'WEB',
    reviewApproveStatus: '',
  });
  expect(captured.versionsDetails).toEqual({ name: 'v1.0', id: '', syncONOFF: '' });
  expect(captured.verData).toEqual({
    tdCopy: true, testcaseId: 42, fromParent: 'TC', selVersionId: 'ver-current',
  });

  // Split by executionType, resequenced 1..N per bucket order.
  expect(captured.steps.automationSteps).toHaveLength(2);
  expect(captured.steps.manualSteps).toHaveLength(1);
  const [a1, a2] = captured.steps.automationSteps;
  expect(a1.seq).toBe(1); expect(a1.description).toBe('Launch');
  expect(a2.seq).toBe(2); expect(a2.description).toBe('Login');
  // Server-assigned refs stripped.
  expect(a1.id).toBeUndefined(); expect(a1.versionId).toBeUndefined();
  // Retyped for FN, filed under the new function's module.
  expect(a1.type).toBe('FN'); expect(a1.moduleId).toBe(8);
  // Non-numeric parameterIds dropped.
  expect(a1.parameterIds).toEqual([11, 22]);
  // Manual bucket resequenced from 1 as well.
  expect(captured.steps.manualSteps[0].seq).toBe(3);
  expect(captured.steps.manualSteps[0].description).toBe('Manual check');

  expect(ref.id).toBe('99');
  expect(ref.created).toBe(true);
});

test('executionType override forces all picked steps into one bucket', async () => {
  let captured: any = null;
  const adapter = makeAdapter((url, init) => {
    if (url.includes('/tm/testcase/getById/42')) {
      return { body: JSON.stringify({ data: {
        id: 42, projectId: 7, tcType: 'WEB', versionId: 'v1',
        versionsDetails: { id: 'v1', name: 'v1' },
      } }) };
    }
    if (url.includes('/tm/testcase/steps')) {
      return { body: JSON.stringify({ data: [
        { id: 'a', seq: 1, executionType: 'AUTOMATION', technologyType: 'WEB', versionId: 'v1' },
        { id: 'b', seq: 2, executionType: 'MANUAL', technologyType: 'WEB', versionId: 'v1' },
      ] }) };
    }
    if (init.method === 'POST' && url.endsWith('/tm/function')) {
      captured = JSON.parse(String((init.body as FormData).get('functionObj')));
      return { body: JSON.stringify({ data: { id: 100 } }) };
    }
    throw new Error(`unexpected ${url}`);
  });

  await adapter.saveStepsAsFunction('42', {
    stepSeqs: [1, 2], name: 'Forced', moduleId: 5, executionType: 'AUTOMATION',
  });

  expect(captured.tcfnObj.executionType).toBe('AUTOMATION');
  expect(captured.steps.automationSteps).toHaveLength(2);
  expect(captured.steps.manualSteps).toHaveLength(0);
});

test('rejects empty name / missing moduleId / empty stepSeqs / unknown seqs', async () => {
  const okStubs = (url: string) => {
    if (url.includes('/tm/testcase/getById/42')) {
      return { body: JSON.stringify({ data: { id: 42, versionId: 'v1', versionsDetails: { id: 'v1' } } }) };
    }
    if (url.includes('/tm/testcase/steps')) {
      return { body: JSON.stringify({ data: [{ id: 'a', seq: 1, executionType: 'AUTOMATION', versionId: 'v1' }] }) };
    }
    return { body: '{}' };
  };
  const adapter = makeAdapter(okStubs);
  await expect(adapter.saveStepsAsFunction('42', { stepSeqs: [1], name: '  ', moduleId: 5 }))
    .rejects.toThrow(/name/);
  await expect(adapter.saveStepsAsFunction('42', { stepSeqs: [1], name: 'x', moduleId: 0 }))
    .rejects.toThrow(/moduleId/);
  await expect(adapter.saveStepsAsFunction('42', { stepSeqs: [], name: 'x', moduleId: 5 }))
    .rejects.toThrow(/stepSeqs/);
  await expect(adapter.saveStepsAsFunction('42', { stepSeqs: [99], name: 'x', moduleId: 5 }))
    .rejects.toThrow(/match stepSeqs/);
});
