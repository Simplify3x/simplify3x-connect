import { SimplifyQaAdapter } from './adapter.js';

/** Wire-shape check for SAVENEWVERSION on functions. The FN path diverges from TC in two spots
 *  the backend actually cares about: (a) `type:'FN'` on the payload; (b) the FN doc has no inline
 *  versionId, so source-version resolution must go through `/tm/function/version/:id/:pid` (the
 *  newest version's id is what tdCopy hangs off). Pin both here plus the multipart key. */

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

function makeAdapter(handler: Handler, onRequest?: (url: string) => void) {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    onRequest?.(url);
    const { status = 200, body } = projectAccess(url) ?? handler(url, init);
    return { ok: status < 300, status, text: async () => body };
  }) as unknown as typeof fetch;
  return new SimplifyQaAdapter(
    { baseUrl: 'https://x.test', token: 't', projectId: 7 } as any,
    { fetchImpl, FormDataImpl: FormData },
  );
}

test('SAVENEWVERSION for FN posts type:FN, multipart key functionObj, selVersionId from newest version', async () => {
  let captured: any = null;
  let capturedKey: string | null = null;
  const rawFn = {
    id: 55,
    name: 'Login helper',
    projectId: 7,
    moduleId: 4,
    fnType: 'WEB',
    executionType: 'AUTOMATION',
    versionsDetails: { syncONOFF: 'SYNCOFF' },
    // Must be stripped by FN allow-list (obsolete/tcType are TC-only and joi rejects on FN update).
    obsolete: false, tcType: 'WEB', suiteId: [1], configuration: [],
    code: 'FN_55', createdBy: 3, stepCount: 1,
  };
  const versionRows = [
    { id: 'ver-old', name: 'v1.0', versionNumber: 1 },
    { id: 'ver-new', name: 'v2.0', versionNumber: 2 },
  ];
  const rawSteps = [
    { id: 'stp-a', seq: 1, description: 'Type', executionType: 'AUTOMATION', actionId: 12,
      versionId: 'ver-new', code: 'STP_1' },
  ];

  const adapter = makeAdapter((url, init) => {
    if (url.includes('/tm/function/55/7')) return { body: JSON.stringify({ data: rawFn }) };
    if (url.includes('/tm/function/version/55/7')) return { body: JSON.stringify({ data: versionRows }) };
    if (url.includes('/tm/function/steps') && url.includes('versionId=ver-new') && url.includes('type=FN')) {
      return { body: JSON.stringify({ data: rawSteps }) };
    }
    if (init.method === 'PUT' && url.endsWith('/tm/function')) {
      const fd = init.body as FormData;
      capturedKey = fd.get('functionObj') != null ? 'functionObj' : 'testcaseObj';
      captured = JSON.parse(String(fd.get('functionObj')));
      return { body: JSON.stringify({ data: { id: 55, versionId: 'ver-brandnew' } }) };
    }
    throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
  });

  const ref = await adapter.saveAsNewFunctionVersion('FN_55', {
    versionName: 'v3.0',
    tdCopy: true,
  });

  expect(capturedKey).toBe('functionObj');
  expect(captured.type).toBe('FN');
  expect(captured.operation).toBe('SAVENEWVERSION');
  expect(captured.versionsDetails).toEqual({
    name: 'v3.0',
    id: '',
    syncONOFF: '',                        // SYNCOFF normalised to '' (matches FE line 906)
    deleted: false,
    executionType: 'AUTOMATION',
    reviewApproveStatus: '',
  });
  // FN update joi REJECTS `functionProjectIds` on versionsDetails — don't send it (TC path does).
  expect(captured.versionsDetails.functionProjectIds).toBeUndefined();
  // Newest version's id (sorted by versionNumber desc) drives tdCopy.
  expect(captured.verData).toEqual({ tdCopy: true, selVersionId: 'ver-new' });
  expect(captured.tcfnObj.id).toBe(55);
  expect(captured.tcfnObj.name).toBe('Login helper');
  expect(captured.tcfnObj.fnType).toBe('WEB');           // REQUIRED by FN update joi
  // TC-only fields must be stripped — FN update joi rejects them as "not allowed".
  for (const k of ['obsolete', 'tcType', 'suiteId', 'configuration',
                   'code', 'createdBy', 'stepCount']) {
    expect(captured.tcfnObj[k]).toBeUndefined();
  }

  expect(captured.steps.automationSteps).toHaveLength(1);
  expect(captured.steps.manualSteps).toHaveLength(0);
  for (const k of ['id', 'versionId', 'code']) {
    expect(captured.steps.automationSteps[0][k]).toBeUndefined();
  }

  expect(ref.id).toBe('55');
  expect(ref.created).toBe(false);
  // productUrlFor now builds the REAL SQA UI routes (function -> /user/function/fnDetails/), not the
  // old flat /function/<id> shape; the sibling test-case expectation already uses /user/... too.
  expect(ref.productUrl).toBe('https://x.test/user/function/fnDetails/55');
  expect(ref.artifacts).toEqual(['versionId=ver-brandnew']);
});

test('sourceVersionId override skips the version-list fetch', async () => {
  let captured: any = null;
  let versionListHit = false;
  const adapter = makeAdapter((url, init) => {
    if (url.includes('/tm/function/55/7')) {
      return { body: JSON.stringify({ data: { id: 55, projectId: 7, executionType: 'MANUAL' } }) };
    }
    if (url.includes('/tm/function/version/')) { versionListHit = true; return { body: '[]' }; }
    if (url.includes('/tm/function/steps') && url.includes('versionId=ver-picked')) {
      return { body: JSON.stringify({ data: [] }) };
    }
    if (init.method === 'PUT') {
      captured = JSON.parse(String((init.body as FormData).get('functionObj')));
      return { body: JSON.stringify({ data: { id: 55 } }) };
    }
    throw new Error(`unexpected ${url}`);
  });

  await adapter.saveAsNewFunctionVersion('55', {
    versionName: 'v4.0',
    tdCopy: false,
    sourceVersionId: 'ver-picked',
  });

  expect(versionListHit).toBe(false);
  expect(captured.verData).toEqual({ tdCopy: false, selVersionId: 'ver-picked' });
});

test('rejects empty versionName', async () => {
  const adapter = makeAdapter(() => ({ body: '{}' }));
  await expect(
    adapter.saveAsNewFunctionVersion('55', { versionName: '   ' }),
  ).rejects.toThrow(/versionName/);
});

test('rejects a TC business key routed to the FN endpoint (prefix guard)', async () => {
  // Without the guard, numericId("TC-55") -> "55" and the request would silently target
  // /tm/function/55 — a totally different entity if FN-55 also exists. See the FN-22 incident.
  // It must refuse BEFORE any I/O: not the function endpoint, and not even the access check
  // (/pm/auth/me + /pm/projectuserrole) that gates a project-scoped call.
  const requests: string[] = [];
  let httpHits = 0;
  const adapter = makeAdapter(() => { httpHits++; return { body: '{}' }; },
    (url) => requests.push(url));
  await expect(
    adapter.saveAsNewFunctionVersion('TC_55', { versionName: 'v2' }),
  ).rejects.toThrow(/test-case key.*tc_/i);
  expect(httpHits).toBe(0);
  expect(requests).toEqual([]);
});
