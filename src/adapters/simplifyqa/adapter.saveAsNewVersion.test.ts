import { SimplifyQaAdapter } from './adapter.js';

/** Smallest end-to-end check on the SAVENEWVERSION wire shape. Backend contract
 *  (tcfn.service.js:115/242/355 + FE testcase.component.ts:1388-1400): version must have empty
 *  id and the caller's name, step ids must be stripped, operation must be SAVENEWVERSION,
 *  verData carries {tdCopy, selVersionId}. If any of those regress, the backend either
 *  overwrites the wrong version or rejects the payload — pin them here. */

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

test('SAVENEWVERSION payload snapshots raw tcfnObj/steps under a new version', async () => {
  let captured: any = null;
  const rawTc = {
    id: 42,
    name: 'Login smoke',
    projectId: 7,
    moduleId: 3,
    obsolete: false,
    tcType: 'WEB',
    executionType: 'AUTOMATION',
    versionId: 'ver-current',
    versionsDetails: { id: 'ver-current', name: 'v1.0', syncONOFF: 'SYNCOFF' },
    createdAt: '2024-01-01',
    updatedAt: '2024-06-01',
    customFields: { foo: 'bar' },
    // Fields NOT on the update joi allow-list — must be dropped.
    code: 'TC_42',
    createdBy: 36,
    updatedBy: 36,
    stepCount: 2,
    _id: 'mongo-oid',
  };
  const rawSteps = [
    { id: 'step-a', seq: 1, description: 'Launch', executionType: 'AUTOMATION',
      actionId: 178, versionId: 'ver-current',
      // Fields NOT on the step allow-list — must be dropped.
      _id: 'oid-a', createdBy: 36, code: 'STP_1' },
    { id: 'step-b', seq: 2, description: 'Click', executionType: 'MANUAL',
      versionId: 'ver-current', _id: 'oid-b', createdBy: 36 },
  ];

  const adapter = makeAdapter((url, init) => {
    if (url.includes('/tm/testcase/getById/42')) {
      return { body: JSON.stringify({ data: rawTc }) };
    }
    if (url.includes('/tm/testcase/steps')) {
      return { body: JSON.stringify({ data: rawSteps }) };
    }
    if (init.method === 'PUT' && url.endsWith('/tm/testcase')) {
      const fd = init.body as FormData;
      captured = JSON.parse(String(fd.get('testcaseObj')));
      return { body: JSON.stringify({ data: { id: 42, versionId: 'ver-new' } }) };
    }
    throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
  });

  const ref = await adapter.saveAsNewVersion('TC_42', {
    versionName: 'v2.0',
    tdCopy: true,
  });

  expect(captured.operation).toBe('SAVENEWVERSION');
  expect(captured.type).toBe('TC');
  expect(captured.versionsDetails).toEqual({
    name: 'v2.0',
    id: '',
    syncONOFF: '',                        // SYNCOFF normalised to '' (matches FE line 1399)
    deleted: false,
    executionType: 'AUTOMATION',
    functionProjectIds: [7],
    reviewApproveStatus: '',
  });
  expect(captured.verData).toEqual({ tdCopy: true, selVersionId: 'ver-current' });
  expect(captured.tcfnObj.id).toBe(42);
  expect(captured.tcfnObj.name).toBe('Login smoke');
  expect(captured.tcfnObj.customFields).toEqual({ foo: 'bar' });
  // Every non-allow-listed field must be dropped (this is what tripped the 400).
  for (const k of ['code', 'createdBy', 'updatedBy', 'stepCount', '_id',
                   'createdAt', 'updatedAt', 'versionsDetails', 'versionId']) {
    expect(captured.tcfnObj[k]).toBeUndefined();
  }

  // Step ids stripped; correctly split by executionType.
  expect(captured.steps.automationSteps).toHaveLength(1);
  expect(captured.steps.manualSteps).toHaveLength(1);
  for (const k of ['id', '_id', 'versionId', 'createdBy', 'code']) {
    expect(captured.steps.automationSteps[0][k]).toBeUndefined();
    expect(captured.steps.manualSteps[0][k]).toBeUndefined();
  }
  expect(captured.steps.automationSteps[0].actionId).toBe(178);

  expect(ref.id).toBe('42');
  expect(ref.created).toBe(false);
  expect(ref.productUrl).toBe('https://x.test/user/testcase/details/42');
  expect(ref.artifacts).toEqual(['versionId=ver-new']);
});

test('sourceVersionId override wins over the current version on the TC', async () => {
  let captured: any = null;
  const adapter = makeAdapter((url, init) => {
    if (url.includes('/tm/testcase/getById/42')) {
      return { body: JSON.stringify({ data: {
        id: 42, projectId: 7, executionType: 'MANUAL',
        versionId: 'ver-current', versionsDetails: { id: 'ver-current', name: 'v1.0' },
      } }) };
    }
    if (url.includes('/tm/testcase/steps')) return { body: JSON.stringify({ data: [] }) };
    if (init.method === 'PUT') {
      captured = JSON.parse(String((init.body as FormData).get('testcaseObj')));
      return { body: JSON.stringify({ data: { id: 42 } }) };
    }
    throw new Error(`unexpected ${url}`);
  });

  await adapter.saveAsNewVersion('42', {
    versionName: 'v3.0',
    tdCopy: false,
    sourceVersionId: 'ver-picked',
  });

  expect(captured.verData).toEqual({ tdCopy: false, selVersionId: 'ver-picked' });
});

test('rejects empty versionName', async () => {
  const adapter = makeAdapter(() => ({ body: '{}' }));
  await expect(
    adapter.saveAsNewVersion('42', { versionName: '   ' }),
  ).rejects.toThrow(/versionName/);
});

test('SAVENEWVERSION with an EDITED tc freezes that content (update + new version)', async () => {
  let captured: any = null;
  const rawTc = {
    id: 42,
    name: 'Checkout manual',
    projectId: 7,
    moduleId: 3,
    obsolete: false,
    tcType: 'WEB',
    executionType: 'MANUAL',
    versionId: 'ver-current',
    versionsDetails: { id: 'ver-current', name: 'v1.0', syncONOFF: 'SYNCOFF' },
  };

  const adapter = makeAdapter((url, init) => {
    if (url.includes('/tm/testcase/getById/42')) {
      return { body: JSON.stringify({ data: rawTc }) };
    }
    if (init.method === 'PUT' && url.endsWith('/tm/testcase')) {
      const fd = init.body as FormData;
      captured = JSON.parse(String(fd.get('testcaseObj')));
      return { body: JSON.stringify({ data: { id: 42, versionId: 'ver-new' } }) };
    }
    throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
  });

  const ref = await adapter.saveAsNewVersion('TC_42', {
    versionName: 'v2.0',
    tdCopy: true,
    tc: {
      id: 'TC_42',
      title: 'Checkout manual',
      category: 'manual',
      folderOrModule: '3',
      steps: [
        { n: 1, description: 'User fills the checkout form', actionType: 'manualStep', stepType: 'web' },
        { n: 2, description: 'User lands on the order overview', actionType: 'manualStep', stepType: 'web', expectedResult: 'Order overview visible' },
      ],
    } as any,
  });

  expect(ref.id).toBe('42');
  expect(ref.artifacts).toEqual(['versionId=ver-new']);
  expect(captured.operation).toBe('SAVENEWVERSION');
  expect(captured.versionsDetails).toMatchObject({ name: 'v2.0', id: '', updateVersion: 0, deleted: false });
  // tdCopy now always carries selVersionId, defaulted to the TC's CURRENT version; without it the
  // backend creates the new version's iteration EMPTY.
  expect(captured.verData).toEqual({ tdCopy: true, selVersionId: 'ver-current' });
  expect(captured.tcfnObj.id).toBe(42);
  // The EDITED steps are what gets frozen — not the stored state.
  expect(captured.steps.manualSteps.map((s: any) => s.description)).toEqual([
    'User fills the checkout form',
    'User lands on the order overview',
  ]);
  expect(captured.steps.automationSteps).toEqual([]);
});
