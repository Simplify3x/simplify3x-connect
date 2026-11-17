import { SimplifyQaAdapter } from './adapter.js';

/** Wire-shape check for the replace-in-source PUT that follows STEPSTOFN. Mirrors the FE
 *  testcase.component.ts:createNewFns + onSave flow: extracted steps are soft-deleted (kept in
 *  the payload with `deleted:true` — backend's param collector drops their columns), a
 *  FUNCTION + FUNCTION_END pair splices in at the first extracted seq, live steps get
 *  resequenced 1..N, operation is "TC" / type is "TC", versionsDetails carries the source
 *  versionId. If any of those regress the backend either rejects the PUT or leaves testdata in
 *  an inconsistent state. */

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

test('replaceStepsWithFunctionCall soft-deletes picks and splices FUNCTION+FUNCTION_END', async () => {
  let putCaptured: any = null;
  const rawTc = {
    id: 42, projectId: 7, moduleId: 3, tcType: 'WEB', executionType: 'AUTOMATION',
    versionId: 'ver-current', obsolete: false,
    versionsDetails: { id: 'ver-current', name: 'v1.0', syncONOFF: '' },
  };
  const rawSteps = [
    { id: 'a', seq: 1, description: 'Launch', executionType: 'AUTOMATION',
      technologyType: 'WEB', versionId: 'ver-current', parameterIds: [11] },
    { id: 'b', seq: 2, description: 'Login', executionType: 'AUTOMATION',
      technologyType: 'WEB', versionId: 'ver-current', parameterIds: [22, 33] },
    { id: 'c', seq: 3, description: 'Verify', executionType: 'AUTOMATION',
      technologyType: 'WEB', versionId: 'ver-current' },
    { id: 'd', seq: 4, description: 'Assert', executionType: 'AUTOMATION',
      technologyType: 'WEB', versionId: 'ver-current' },
  ];

  const adapter = makeAdapter((url, init) => {
    if (url.includes('/tm/testcase/getById/42')) return { body: JSON.stringify({ data: rawTc }) };
    if (url.includes('/tm/testcase/steps')) return { body: JSON.stringify({ data: rawSteps }) };
    if (init.method === 'PUT' && url.endsWith('/tm/testcase')) {
      putCaptured = JSON.parse(String((init.body as FormData).get('testcaseObj')));
      return { body: JSON.stringify({ data: { id: 42 } }) };
    }
    throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
  });

  await adapter.replaceStepsWithFunctionCall('TC_42', {
    extractedSeqs: [2, 3],
    functionId: '99',
    fnVersionId: 'fnver-1',
    fnModuleId: 8,
    technologyType: 'WEB',
  });

  expect(putCaptured.operation).toBe('TC');
  expect(putCaptured.type).toBe('TC');
  expect(putCaptured.tcfnObj.id).toBe(42);
  expect(putCaptured.tcfnObj.deleted).toBe(false);
  expect(putCaptured.versionsDetails.id).toBe('ver-current');
  expect(putCaptured.versionsDetails.functionProjectIds).toEqual([7]);

  const auto = putCaptured.steps.automationSteps;
  // Two live steps (seq 1, seq 4) + FUNCTION + FUNCTION_END + two deleted rows = 6 entries.
  expect(auto).toHaveLength(6);

  const live = auto.filter((s: any) => !s.deleted);
  const deleted = auto.filter((s: any) => s.deleted);
  expect(deleted).toHaveLength(2);
  expect(deleted.map((s: any) => s.id).sort()).toEqual(['b', 'c']);
  // Deleted rows KEEP parameterIds — backend needs them to prune testdata columns.
  const delWithParams = deleted.find((s: any) => s.id === 'b');
  expect(delWithParams.parameterIds).toEqual([22, 33]);

  // Live: [Launch (kept), FUNCTION, FUNCTION_END, Assert (kept)] — resequenced 1..4.
  expect(live).toHaveLength(4);
  expect(live[0].id).toBe('a');
  expect(live[0].seq).toBe(1);
  expect(live[1].stepType).toBe('FUNCTION');
  expect(live[1].type).toBe('TC');
  expect(live[1].functionId).toBe(99);
  expect(live[1].fnVersionId).toBe('fnver-1');
  expect(live[1].moduleId).toBe(8);
  expect(live[1].seq).toBe(2);
  expect(live[2].stepType).toBe('FUNCTION_END');
  expect(live[2].seq).toBe(3);
  expect(live[3].id).toBe('d');
  expect(live[3].seq).toBe(4);
});

test('rejects non-contiguous extractedSeqs', async () => {
  const adapter = makeAdapter((url) => {
    if (url.includes('/tm/testcase/getById/42')) {
      return { body: JSON.stringify({ data: {
        id: 42, versionId: 'v1', versionsDetails: { id: 'v1', name: 'v1', syncONOFF: '' },
        executionType: 'AUTOMATION',
      } }) };
    }
    if (url.includes('/tm/testcase/steps')) return { body: JSON.stringify({ data: [] }) };
    return { body: '{}' };
  });
  await expect(adapter.replaceStepsWithFunctionCall('42', {
    extractedSeqs: [1, 3], functionId: '99', fnVersionId: 'v', fnModuleId: 5, technologyType: 'WEB',
  })).rejects.toThrow(/contiguous/);
});

test('refuses DUO and SYNCON', async () => {
  const duoAdapter = makeAdapter((url) => {
    if (url.includes('/tm/testcase/getById/42')) {
      return { body: JSON.stringify({ data: {
        id: 42, versionId: 'v1', versionsDetails: { id: 'v1', name: 'v1', syncONOFF: '' },
        executionType: 'DUO',
      } }) };
    }
    return { body: '{}' };
  });
  await expect(duoAdapter.replaceStepsWithFunctionCall('42', {
    extractedSeqs: [1], functionId: '99', fnVersionId: 'v', fnModuleId: 5, technologyType: 'WEB',
  })).rejects.toThrow(/DUO/);

  const syncOnAdapter = makeAdapter((url) => {
    if (url.includes('/tm/testcase/getById/42')) {
      return { body: JSON.stringify({ data: {
        id: 42, versionId: 'v1', versionsDetails: { id: 'v1', name: 'v1', syncONOFF: 'SYNCON' },
        executionType: 'AUTOMATION',
      } }) };
    }
    return { body: '{}' };
  });
  await expect(syncOnAdapter.replaceStepsWithFunctionCall('42', {
    extractedSeqs: [1], functionId: '99', fnVersionId: 'v', fnModuleId: 5, technologyType: 'WEB',
  })).rejects.toThrow(/SYNCON/);
});

test('resolves versionsDetails.name from versions[] when not inlined (avoids joi BADREQUEST)', async () => {
  let putCaptured: any = null;
  const adapter = makeAdapter((url, init) => {
    if (url.includes('/tm/testcase/getById/42')) {
      // versionsDetails carries only id — name lives on versions[]. Real payload shape from some
      // SQA list endpoints.
      return { body: JSON.stringify({ data: {
        id: 42, projectId: 7, tcType: 'WEB', executionType: 'AUTOMATION',
        versionId: 'ver-cur',
        versionsDetails: { id: 'ver-cur' },
        versions: [{ id: 'ver-cur', name: 'v2.3' }, { id: 'ver-old', name: 'v1.0' }],
      } }) };
    }
    if (url.includes('/tm/testcase/steps')) {
      return { body: JSON.stringify({ data: [
        { id: 'a', seq: 1, executionType: 'AUTOMATION', technologyType: 'WEB', versionId: 'ver-cur' },
        { id: 'b', seq: 2, executionType: 'AUTOMATION', technologyType: 'WEB', versionId: 'ver-cur' },
      ] }) };
    }
    if (init.method === 'PUT' && url.endsWith('/tm/testcase')) {
      putCaptured = JSON.parse(String((init.body as FormData).get('testcaseObj')));
      return { body: JSON.stringify({ data: { id: 42 } }) };
    }
    throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
  });

  await adapter.replaceStepsWithFunctionCall('42', {
    extractedSeqs: [1], functionId: '99', fnVersionId: 'v', fnModuleId: 5, technologyType: 'WEB',
  });
  expect(putCaptured.versionsDetails.name).toBe('v2.3');
});

test('falls back to v1.0 when neither versionsDetails.name nor versions[].name is present', async () => {
  let putCaptured: any = null;
  const adapter = makeAdapter((url, init) => {
    if (url.includes('/tm/testcase/getById/42')) {
      return { body: JSON.stringify({ data: {
        id: 42, projectId: 7, tcType: 'WEB', executionType: 'AUTOMATION',
        versionId: 'ver-cur',
        versionsDetails: { id: 'ver-cur' },
      } }) };
    }
    if (url.includes('/tm/testcase/steps')) {
      return { body: JSON.stringify({ data: [
        { id: 'a', seq: 1, executionType: 'AUTOMATION', technologyType: 'WEB', versionId: 'ver-cur' },
      ] }) };
    }
    if (init.method === 'PUT' && url.endsWith('/tm/testcase')) {
      putCaptured = JSON.parse(String((init.body as FormData).get('testcaseObj')));
      return { body: JSON.stringify({ data: { id: 42 } }) };
    }
    throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
  });

  await adapter.replaceStepsWithFunctionCall('42', {
    extractedSeqs: [1], functionId: '99', fnVersionId: 'v', fnModuleId: 5, technologyType: 'WEB',
  });
  expect(putCaptured.versionsDetails.name).toBe('v1.0');
});

test('refuses picks that include control-flow / FN bracket step types', async () => {
  const adapter = makeAdapter((url) => {
    if (url.includes('/tm/testcase/getById/42')) {
      return { body: JSON.stringify({ data: {
        id: 42, versionId: 'v1', versionsDetails: { id: 'v1', name: 'v1', syncONOFF: '' },
        executionType: 'AUTOMATION',
      } }) };
    }
    if (url.includes('/tm/testcase/steps')) {
      return { body: JSON.stringify({ data: [
        { id: 'a', seq: 1, executionType: 'AUTOMATION', versionId: 'v1', stepType: 'plain' },
        { id: 'b', seq: 2, executionType: 'AUTOMATION', versionId: 'v1', stepType: 'IF' },
        { id: 'c', seq: 3, executionType: 'AUTOMATION', versionId: 'v1', stepType: 'plain' },
      ] }) };
    }
    return { body: '{}' };
  });
  await expect(adapter.replaceStepsWithFunctionCall('42', {
    extractedSeqs: [1, 2, 3], functionId: '99', fnVersionId: 'v', fnModuleId: 5, technologyType: 'WEB',
  })).rejects.toThrow(/control-flow/);
});
