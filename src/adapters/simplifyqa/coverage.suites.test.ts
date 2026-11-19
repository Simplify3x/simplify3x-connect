import { SimplifyQaAdapter, SuiteBlockedError } from './adapter.js';
/** SUITE / PLAN / SCHEDULE / PIPELINE write paths.
 *
 *  These are strict payload contracts: SimplifyQA's update validators reject unknown keys, so the
 *  adapter builds every body from an allow-list and renumbers membership. The assertions below are on
 *  the actual multipart/JSON body that reaches the backend, plus the call ORDER for the two-phase
 *  (preview → confirm) deletes. Nothing here reads a fixture back as if it were a result. */

type Reply = {
  status?: number;
  body: string;
};

type Handler = (url: string, init: RequestInit) => Reply | undefined;

type Call = {
  method: string;
  url: string;
  body: any;
  raw: any;
};

const ME = { userDetails: { id: 36, username: 'qa.user', email: 'qa.user@x.test', userType: 'user' } };

const ROLES = { data: [{ userId: 36, projectId: 7, roleId: 2, deleted: false }] };

function response({ status = 200, body }: Reply) {
  return { ok: status < 300, status, text: async () => body };
}

function makeAdapter(handler: Handler = () => undefined) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    let body: any = undefined;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url, body, raw: init.body });
    const out = handler(url, init);
    if (out)
      return response(out);
    if (url.includes('/pm/auth/me'))
      return response({ body: JSON.stringify(ME) });
    if (url.includes('/pm/projectuserrole?userId='))
      return response({ body: JSON.stringify(ROLES) });
    return response({ status: 404, body: JSON.stringify({ message: `unexpected ${method} ${url}` }) });
  }) as unknown as typeof fetch;
  const adapter = new SimplifyQaAdapter({ baseUrl: 'https://x.test', token: 't', projectId: 7 } as any, { fetchImpl, FormDataImpl: FormData });
  return { adapter, calls };
}

function part(call: Call, partName: string): any {
  const raw = (call.raw as FormData).get(partName);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

const fdPart = (init: RequestInit, name: string) => JSON.parse(String((init.body as FormData).get(name)));

const byPath = (calls: Call[], method: string, suffix: string) => calls.filter((c) => c.method === method && c.url.split('?')[0]!.endsWith(suffix));

const TC_RAW = (id: number, over: Record<string, unknown> = {}) => ({
  id, code: `TC-${id}`, name: `Case ${id}`, projectId: 7, moduleId: 3, tcType: 'WEB',
  executionType: 'AUTOMATION', versionId: `v${id}`, versionName: 'v1.0',
  executionPlatform: { id: 'CHROME', name: 'Chrome', technologyType: 'WEB', type: 'NONE' },
  ...over,
});

// ---------------------------------------------------------------- suites

test('createSuite builds the allow-listed suiteObj with per-row platforms and seq', async () => {
  const { adapter, calls } = makeAdapter((url, init) => {
    if (url.includes('/tm/testcase/getById/55'))
      return { body: JSON.stringify({ data: TC_RAW(55) }) };
    if (url.includes('/tm/testcase/getById/66'))
      return { body: JSON.stringify({ data: TC_RAW(66, { tcType: 'API' }) }) };
    if (url.endsWith('/tm/suites') && init.method === 'POST')
      return { body: JSON.stringify({ data: { id: 300 } }) };
    return undefined;
  });
  const ref = await adapter.createSuite({
    name: 'Smoke',
    description: 'nightly',
    members: [{ tcId: '55', order: 1 }, { tcId: '66', order: 2 }],
  });
  expect(ref).toEqual({
    id: '300', created: true, productUrl: 'https://x.test/user/suites/suite-details?id=300',
  });
  const save = byPath(calls, 'POST', '/tm/suites')[0]!;
  expect(save.url).toBe('https://x.test/tm/suites');
  expect(part(save, 'suiteObj')).toEqual({
    name: 'Smoke',
    description: 'nightly',
    state: 'New',
    suiteType: 'AUTOMATION',
    projectId: 7,
    autoDefectLog: false,
    autoReExecCount: 0,
    newBrowserSession: false,
    terminateOnFailure: false,
    autoReExecTriggerOn: 'AFTER_SUITE',
    minimumContainerCount: null,
    maximumContainerCount: null,
    testCases: [
      {
        testcaseId: 55, code: 'TC-55', tcType: 'WEB', projectId: 7, version: 'v1.0', versionId: 'v55',
        executionPlatform: {
          LOCAL: { id: 'CHROME', name: 'Chrome', technologyType: 'WEB', type: 'NONE' }, REMOTE: {}, CLOUD: {},
        },
        seq: 1,
      },
      {
        testcaseId: 66, code: 'TC-66', tcType: 'API', projectId: 7, version: 'v1.0', versionId: 'v66',
        executionPlatform: {
          LOCAL: { id: 'API', name: 'API', technologyType: 'API', type: 'NONE' },
          REMOTE: { id: 'API', name: 'API', technologyType: 'API', type: 'NONE' },
          CLOUD: { id: 'API', name: 'API', technologyType: 'API', type: 'NONE' },
        },
        seq: 2,
      },
    ],
    mailersList: {},
    tags: [],
    customFields: {},
    lastSelectedExecutionType: 'LOCAL',
    tcChanged: true,
  });
});

test('createSuite refuses an empty suite, an unknown test case and a MANUAL/AUTOMATION mix', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.includes('/tm/testcase/getById/55'))
      return { body: JSON.stringify({ data: TC_RAW(55, { executionType: 'AUTOMATION' }) }) };
    if (url.includes('/tm/testcase/getById/66'))
      return { body: JSON.stringify({ data: TC_RAW(66, { executionType: 'MANUAL' }) }) };
    if (url.includes('/tm/testcase/getById/77'))
      return { body: JSON.stringify({ data: {} }) };
    return undefined;
  });
  await expect(adapter.createSuite({ name: '  ', members: [{ tcId: '55', order: 1 }] })).rejects.toThrow('name is required.');
  await expect(adapter.createSuite({ name: 'Smoke', members: [] })).rejects.toThrow('At least one test case is required to create a suite.');
  await expect(adapter.createSuite({ name: 'Smoke', members: [{ tcId: '77', order: 1 }] })).rejects.toThrow('test case 77 not found (cannot add to suite)');
  await expect(adapter.createSuite({ name: 'Smoke', members: [{ tcId: '55', order: 1 }, { tcId: '66', order: 2 }] })).rejects.toThrow('Cannot create suite: the test cases are a mix of MANUAL and AUTOMATION');
  expect(byPath(calls, 'POST', '/tm/suites')).toHaveLength(0);
});

test('updateSuiteMembers applies add/remove/reorder (ids stripped, seq renumbered) and guards bad input', async () => {
  {
    let suiteDoc: any = {
      id: 300, code: 'SU-300', name: 'Smoke', projectId: 7, suiteType: 'AUTOMATION', state: 'New',
      lastSelectedExecutionType: 'LOCAL', updateVersion: 3, stepCount: 9, customFields: {},
      testCases: [
        { id: 'row-a', testcaseId: 12, code: 'TC-12', seq: 1, tcType: 'WEB', version: 'v1.0', versionId: 'v12', executionPlatform: { LOCAL: { id: 'CHROME' } }, deleted: false },
        { id: 'row-b', testcaseId: 13, code: 'TC-13', seq: 2, tcType: 'WEB', version: 'v1.0', versionId: 'v13' },
      ],
    };
    const { adapter, calls } = makeAdapter((url, init) => {
      if (url.endsWith('/tm/suites/300') && (init.method ?? 'GET') === 'GET')
        return { body: JSON.stringify({ data: suiteDoc }) };
      if (url.includes('/tm/testcase/getById/55'))
        return { body: JSON.stringify({ data: TC_RAW(55) }) };
      if (url.endsWith('/tm/suites/300') && init.method === 'PUT') {
        suiteDoc = { ...suiteDoc, testCases: fdPart(init, 'suiteObj').testCases };
        return { body: JSON.stringify({ data: { id: 300 } }) };
      }
      return undefined;
    });
    const out = await adapter.updateSuiteMembers('300', [
      { op: 'add', tcId: 'TC-55' },
      { op: 'remove', tcId: '12' },
      { op: 'reorder', tcId: '13', order: 1 },
    ]);
    const save = byPath(calls, 'PUT', '/tm/suites/300')[0]!;
    const payload = part(save, 'suiteObj');
    expect(payload).toEqual({
      id: 300,
      name: 'Smoke',
      projectId: 7,
      suiteType: 'AUTOMATION',
      state: 'New',
      lastSelectedExecutionType: 'LOCAL',
      updateVersion: 3,
      customFields: {},
      tcChanged: true,
      testCases: [
        {
          testcaseId: 13, code: 'TC-13', seq: 1, tcType: 'WEB', version: 'v1.0', versionId: 'v13',
        },
        {
          testcaseId: 55, code: 'TC-55', seq: 2, tcType: 'WEB', projectId: 7, version: 'v1.0', versionId: 'v55',
          executionPlatform: {
            LOCAL: { id: 'CHROME', name: 'Chrome', technologyType: 'WEB', type: 'NONE' }, REMOTE: {}, CLOUD: {},
          },
        },
      ],
    });
    // Audit/derived suite keys (`stepCount`) and per-row ids are NOT on the wire.
    expect(payload.stepCount).toBeUndefined();
    expect(payload.testCases.map((r: any) => r.id)).toEqual([undefined, undefined]);
    // The returned suite is the RE-READ document.
    expect(out).toEqual({
      id: '300',
      name: 'Smoke',
      executionType: 'LOCAL',
      members: [
        { tcId: '13', order: 1, version: 'v1.0', versionId: 'v13' },
        { tcId: '55', order: 2, version: 'v1.0', versionId: 'v55' },
      ],
    });
  }
  {
    let suiteDoc: any = {
      id: 300, code: 'SU-300', projectId: 7, name: 'Smoke',
      testCases: [{ testcaseId: 12, code: 'TC-12', seq: 1, tcType: 'WEB', version: 'v1.0', versionId: 'v12' }],
    };
    let tcLookups = 0;
    const { adapter, calls } = makeAdapter((url, init) => {
      if (url.endsWith('/tm/suites/300') && (init.method ?? 'GET') === 'GET')
        return { body: JSON.stringify({ data: suiteDoc }) };
      if (url.endsWith('/tm/suites/301') && (init.method ?? 'GET') === 'GET')
        return { body: JSON.stringify({ data: {} }) };
      if (url.includes('/tm/testcase/getById/')) {
        tcLookups++;
        return { body: JSON.stringify({ data: TC_RAW(12) }) };
      }
      if (url.endsWith('/tm/suites/300') && init.method === 'PUT') {
        suiteDoc = { ...suiteDoc, testCases: fdPart(init, 'suiteObj').testCases };
        return { body: JSON.stringify({ data: { id: 300 } }) };
      }
      return undefined;
    });
    await expect(adapter.updateSuiteMembers('300', null as any)).rejects.toThrow('ops must be an array');
    await expect(adapter.updateSuiteMembers('301', [])).rejects.toThrow('suite 301 not found');
    // Adding an existing member is a no-op (no lookup, no duplicate row).
    await adapter.updateSuiteMembers('300', [{ op: 'add', tcId: '12' }]);
    expect(tcLookups).toBe(0);
    expect(part(byPath(calls, 'PUT', '/tm/suites/300')[0]!, 'suiteObj').testCases).toHaveLength(1);
    // An out-of-range reorder is ignored, and an unknown op is refused before anything is written.
    await adapter.updateSuiteMembers('300', [{ op: 'reorder', tcId: '12', order: 5 }]);
    expect(part(byPath(calls, 'PUT', '/tm/suites/300')[1]!, 'suiteObj').testCases).toEqual([
      { testcaseId: 12, code: 'TC-12', seq: 1, tcType: 'WEB', version: 'v1.0', versionId: 'v12' },
    ]);
    await expect(adapter.updateSuiteMembers('300', [{ op: 'shuffle', tcId: '12' } as any])).rejects.toThrow("suite op 'shuffle' not supported (add|remove|reorder)");
    expect(byPath(calls, 'PUT', '/tm/suites/300')).toHaveLength(2);
  }
});

test('suiteDeletePreview reports every blocker; deleteSuite refuses a blocked suite and verifies a real delete', async () => {
  {
    const suiteRaw = { id: 300, code: 'SU-300', name: 'Smoke', projectId: 7, testCases: [] };
    const { adapter, calls } = makeAdapter((url, init) => {
      if (url.endsWith('/tm/suites/300'))
        return { body: JSON.stringify({ data: suiteRaw }) };
      if (url.endsWith('/tm/suites') && init.method === 'PATCH') {
        return { body: JSON.stringify({ data: [{ id: 300, schedulerArr: [7], pipelineArr: [8] }] }) };
      }
      if (url.endsWith('/sh/scheduler/search'))
        return { body: JSON.stringify({ data: [{ id: 7, code: 'SCH-7', name: 'nightly' }] }) };
      if (url.endsWith('/pl/pipelines/search'))
        return { body: JSON.stringify({ data: [{ id: 8, code: 'PIP-8' }] }) };
      if (url.endsWith('/tm/execplantestcases/search')) {
        const body = JSON.parse(String(init.body));
        const bySuite = body.searchFields.some((f: any) => f.column === 'sourceId');
        return { body: JSON.stringify({ data: bySuite ? [{ execPlanId: 20 }] : [] }) };
      }
      if (url.endsWith('/tm/executionplan/search'))
        return { body: JSON.stringify({ data: [{ id: 20, code: 'PL-20' }] }) };
      if (url.endsWith('/tm/scenario/search'))
        return { body: JSON.stringify({ data: [{ id: 30, code: 'TP-30', name: 'Folder' }] }) };
      return undefined;
    });
    const preview = await adapter.suiteDeletePreview('SU_300');
    expect(preview).toEqual({
      suite: { id: '300', code: 'SU-300', name: 'Smoke' },
      blockers: {
        schedules: [{ id: '7', code: 'SCH-7', name: 'nightly' }],
        pipelines: [{ id: '8', code: 'PIP-8' }],
        executionPlans: [{ id: '20', code: 'PL-20' }],
        testPlans: [{ id: '30', code: 'TP-30', name: 'Folder' }],
      },
    });
    // The dry run is the UI's own `isDelete:false` probe — never a delete.
    expect(byPath(calls, 'PATCH', '/tm/suites')[0]!.body).toEqual({ ids: [300], projectId: 7, isDelete: false });
    const err = await adapter.deleteSuite('300').catch((e) => e);
    expect(err).toBeInstanceOf(SuiteBlockedError);
    expect(err.message).toBe('SU-300 is still in use and was not deleted.');
    expect(err.blockers.executionPlans).toEqual([{ id: '20', code: 'PL-20' }]);
    // No isDelete:true was ever sent — the refusal re-ran the same dry-run probe only.
    expect(byPath(calls, 'PATCH', '/tm/suites').map((c) => c.body)).toEqual([
      { ids: [300], projectId: 7, isDelete: false },
      { ids: [300], projectId: 7, isDelete: false },
    ]);
  }
  {
    let deleted = false;
    const clean = (url: string, init: RequestInit) => {
      if (url.endsWith('/tm/suites/300') && (init.method ?? 'GET') === 'GET') {
        return deleted ? { status: 404, body: '{}' } : { body: JSON.stringify({ data: { id: 300, code: 'SU-300', projectId: 7, testCases: [] } }) };
      }
      if (url.endsWith('/tm/suites') && init.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        if (body.isDelete === true)
          deleted = true;
        return { body: JSON.stringify({ data: [{ id: 300 }] }) };
      }
      if (url.endsWith('/sh/scheduler/search') || url.endsWith('/pl/pipelines/search')
        || url.endsWith('/tm/execplantestcases/search') || url.endsWith('/tm/executionplan/search')
        || url.endsWith('/tm/scenario/search')) {
        return { body: JSON.stringify({ data: [] }) };
      }
      return undefined;
    };
    const ok = makeAdapter(clean);
    await expect(ok.adapter.deleteSuite('300')).resolves.toBeUndefined();
    expect(byPath(ok.calls, 'PATCH', '/tm/suites').map((c) => c.body)).toEqual([
      { ids: [300], projectId: 7, isDelete: false },
      { ids: [300], projectId: 7, isDelete: true },
    ]);
    // A 200 that deleted nothing (the backend silently skips) is reported, not swallowed.
    const stubborn = makeAdapter((url, init) => {
      if (url.endsWith('/tm/suites/300'))
        return { body: JSON.stringify({ data: { id: 300, code: 'SU-300', projectId: 7, testCases: [] } }) };
      if (url.endsWith('/tm/suites') && init.method === 'PATCH')
        return { body: JSON.stringify({ data: [{ id: 300 }] }) };
      if (url.endsWith('/sh/scheduler/search') || url.endsWith('/pl/pipelines/search')
        || url.endsWith('/tm/execplantestcases/search') || url.endsWith('/tm/executionplan/search')
        || url.endsWith('/tm/scenario/search')) {
        return { body: JSON.stringify({ data: [] }) };
      }
      return undefined;
    });
    await expect(stubborn.adapter.deleteSuite('300')).rejects.toThrow('SimplifyQA did not delete SU-300 — it is still there.');
  }
});

test('updateSuite renames / re-types from a fresh read (tcChanged:false) and maps a CONCURRENCY conflict', async () => {
  const suiteRaw = {
    id: 300, code: 'SU-300', name: 'Smoke', projectId: 7, suiteType: 'AUTOMATION', updateVersion: 4,
    lastSelectedExecutionType: 'LOCAL', testCases: [
      { id: 'row-a', testcaseId: 12, code: 'TC-12', seq: 1, tcType: 'WEB', version: 'v1.0', versionId: 'v12', updateVersion: 9 },
      { id: 'row-b', testcaseId: 13, code: 'TC-13', seq: 2, tcType: 'WEB', version: 'v1.0', versionId: 'v13', deleted: true },
    ],
  };
  let conflict = false;
  const { adapter, calls } = makeAdapter((url, init) => {
    if (url.endsWith('/tm/suites/300') && (init.method ?? 'GET') === 'GET')
      return { body: JSON.stringify({ data: suiteRaw }) };
    if (url.endsWith('/tm/suites/300') && init.method === 'PUT') {
      return conflict
        ? { status: 500, body: JSON.stringify({ message: 'CONCURRENCY: version mismatch' }) }
        : { body: JSON.stringify({ data: { id: 300 } }) };
    }
    return undefined;
  });
  const ref = await adapter.updateSuite('300', { name: 'Smoke v2', description: 'd', executionType: 'cloud' });
  expect(ref).toEqual({ id: '300', created: false, productUrl: 'https://x.test/user/suites/suite-details?id=300' });
  expect(part(byPath(calls, 'PUT', '/tm/suites/300')[0]!, 'suiteObj')).toEqual({
    id: 300,
    name: 'Smoke v2',
    description: 'd',
    projectId: 7,
    suiteType: 'AUTOMATION',
    updateVersion: 4,
    lastSelectedExecutionType: 'CLOUD',
    testCases: [{ testcaseId: 12, code: 'TC-12', seq: 1, tcType: 'WEB', version: 'v1.0', versionId: 'v12' }],
    tcChanged: false,
  });
  conflict = true;
  await expect(adapter.updateSuite('300', { name: 'again' })).rejects.toThrow('SU-300 was changed by someone else — read it again and retry.');
});

test('updateSuiteSettings writes only the settings allow-list; getSuiteSettings reads the panel back', async () => {
  const suiteRaw = {
    id: 300, code: 'SU-300', name: 'Smoke', projectId: 7, suiteType: 'AUTOMATION', updateVersion: 6,
    autoReExecTriggerOn: 'AFTER_TESTCASE', autoReExecCount: 2, autoDefectLog: true, newBrowserSession: false,
    terminateOnFailure: true, minimumContainerCount: null, maximumContainerCount: 4, lastSelectedExecutionType: 'CLOUD',
    testCases: [],
  };
  const { adapter, calls } = makeAdapter((url, init) => {
    if (url.endsWith('/tm/suites/300'))
      return { body: JSON.stringify({ data: suiteRaw }) };
    if (url.endsWith('/tm/suites/settings/300') && init.method === 'PUT')
      return { body: JSON.stringify({ data: { id: 300 } }) };
    return undefined;
  });
  expect(await adapter.getSuiteSettings('300')).toEqual({
    id: '300', code: 'SU-300', name: 'Smoke', executionType: 'CLOUD',
    autoReExecCount: 2, autoDefectLog: true, autoReExecTriggerOn: 'AFTER_TESTCASE',
    newBrowserSession: false, terminateOnFailure: true,
    minimumContainerCount: null, maximumContainerCount: 4,
  });
  const ref = await adapter.updateSuiteSettings('300', { autoReExecCount: 3, terminateOnFailure: false });
  expect(ref.created).toBe(false);
  expect(part(byPath(calls, 'PUT', '/tm/suites/settings/300')[0]!, 'suiteObj')).toEqual({
    id: 300, suiteType: 'AUTOMATION', projectId: 7,
    autoReExecTriggerOn: 'AFTER_TESTCASE', autoReExecCount: 3, terminateOnFailure: false,
    updateVersion: 6,
  });
});

// ---------------------------------------------------------------- execution plans

const PLAN_RAW = (over: Record<string, unknown> = {}) => ({
  id: 20, code: 'PL-20', name: 'Sprint plan', projectId: 7, plannedStartDate: '2026-01-01',
  plannedEndDate: '2026-01-31', environmentType: 'qa', releaseId: null, iterationId: null,
  reviewApproveStatus: '', updateVersion: 3, executionId: 900, terminateOnFailure: false,
  newBrowserSession: false, autoReExecCount: 0, autoReExecTriggerOn: 'AFTER_TESTCASE',
  ...over,
});

const ENV_REPLY = { body: JSON.stringify([{ id: 'env-1', name: 'QA', key: 'qa' }, { id: 'env-2', name: 'General', key: 'general' }]) };

test('createExecutionPlan resolves the environment name to its key and sends only validator fields', async () => {
  const { adapter, calls } = makeAdapter((url, init) => {
    if (url.includes('/pm/fields/8'))
      return ENV_REPLY;
    if (url.endsWith('/tm/executionplan') && init.method === 'POST')
      return { body: JSON.stringify({ data: { id: 20, code: 'PL-20' } }) };
    return undefined;
  });
  const ref = await adapter.createExecutionPlan({
    name: 'Sprint plan',
    plannedStartDate: '2026-01-01',
    plannedEndDate: '2026-01-31',
    environment: 'QA',
    releaseId: 3,
    teamIds: [4, 5],
    planners: [36],
    autoReExecCount: 2,
    terminateOnFailure: true,
  });
  expect(ref).toEqual({ id: '20', code: 'PL-20', created: true });
  expect(byPath(calls, 'POST', '/tm/executionplan')[0]!.body).toEqual({
    name: 'Sprint plan',
    projectId: 7,
    plannedStartDate: '2026-01-01',
    plannedEndDate: '2026-01-31',
    environmentType: 'qa',
    releaseId: 3,
    teamIds: [4, 5],
    planners: [36],
    autoReExecCount: 2,
    terminateOnFailure: true,
  });
  const dup = makeAdapter((url, init) => {
    if (url.includes('/pm/fields/8'))
      return ENV_REPLY;
    if (url.endsWith('/tm/executionplan') && init.method === 'POST')
      return { status: 409, body: JSON.stringify({ message: 'Duplicate name' }) };
    return undefined;
  });
  await expect(dup.adapter.createExecutionPlan({
    name: 'Sprint plan', plannedStartDate: '2026-01-01', plannedEndDate: '2026-01-31', environment: 'General',
  })).rejects.toThrow('An execution plan named "Sprint plan" already exists in project 7.');
  const unknownEnv = makeAdapter((url) => (url.includes('/pm/fields/8') ? ENV_REPLY : undefined));
  await expect(unknownEnv.adapter.createExecutionPlan({
    name: 'X', plannedStartDate: '2026-01-01', plannedEndDate: '2026-01-31', environment: 'staging',
  })).rejects.toThrow('Unknown environment "staging". Available: QA, General.');
});

test('updateExecutionPlan rebuilds the body from the allow-list and refuses a plan in review', async () => {
  const { adapter, calls } = makeAdapter((url, init) => {
    if (url.endsWith('/tm/executionplan/20/7'))
      return { body: JSON.stringify({ data: PLAN_RAW() }) };
    if (url.includes('/pm/fields/8'))
      return ENV_REPLY;
    if (url.endsWith('/tm/executionplan') && init.method === 'PUT')
      return { body: JSON.stringify({ data: { id: 20 } }) };
    return undefined;
  });
  const ref = await adapter.updateExecutionPlan('20', { name: 'Renamed', environment: 'General', planners: [36, 41] });
  expect(ref).toEqual({ id: '20', created: false });
  expect(byPath(calls, 'PUT', '/tm/executionplan')[0]!.body).toEqual({
    id: 20,
    name: 'Renamed',
    projectId: 7,
    plannedStartDate: '2026-01-01',
    plannedEndDate: '2026-01-31',
    environmentType: 'general',
    releaseId: null,
    iterationId: null,
    reviewApproveStatus: '',
    updateVersion: 3,
    terminateOnFailure: false,
    newBrowserSession: false,
    autoReExecCount: 0,
    autoReExecTriggerOn: 'AFTER_TESTCASE',
    planners: [36, 41],
  });
  const locked = makeAdapter((url) => (url.endsWith('/tm/executionplan/20/7')
    ? { body: JSON.stringify({ data: PLAN_RAW({ reviewApproveStatus: 'APPROVED' }) }) }
    : undefined));
  await expect(locked.adapter.updateExecutionPlan('20', { name: 'x' })).rejects.toThrow('PL-20 is APPROVED and is read-only in SimplifyQA.');
});

test('executionPlanDeletePreview counts entries/schedules; delete refuses a scheduled plan and verifies a real delete', async () => {
  let scheduled = true;
  let deleted = false;
  const { adapter, calls } = makeAdapter((url, init) => {
    if (url.endsWith('/tm/executionplan/20/7')) {
      return deleted ? { status: 404, body: '{}' } : { body: JSON.stringify({ data: PLAN_RAW() }) };
    }
    if (url.endsWith('/tm/execplantestcases/search'))
      return { body: JSON.stringify({ totalCount: 4, data: [] }) };
    if (url.endsWith('/sh/scheduler/search')) {
      return { body: JSON.stringify({ data: scheduled ? [{ id: 7, code: 'SCH-7', name: 'nightly' }] : [] }) };
    }
    if (url.endsWith('/tm/executionplan') && init.method === 'PATCH') {
      deleted = true;
      return { body: JSON.stringify({ data: true }) };
    }
    return undefined;
  });
  expect(await adapter.executionPlanDeletePreview('20')).toEqual({
    plan: { id: '20', code: 'PL-20', name: 'Sprint plan' },
    entries: 4,
    schedules: [{ id: '7', code: 'SCH-7', name: 'nightly' }],
  });
  await expect(adapter.deleteExecutionPlan('20')).rejects.toThrow("PL-20 Sprint plan can't be deleted — schedules use it: SCH-7 nightly.");
  expect(byPath(calls, 'PATCH', '/tm/executionplan')).toHaveLength(0);
  scheduled = false;
  await expect(adapter.deleteExecutionPlan('20')).resolves.toBeUndefined();
  expect(byPath(calls, 'PATCH', '/tm/executionplan')[0]!.body).toEqual({ ids: [20], projectId: 7 });
});

test('plan entries: add skips/dedupes with assignTo:"me"; remove previews then reports what survived', async () => {
  {
    const suiteDoc = {
      id: 300, code: 'SU-300', name: 'Smoke', projectId: 7,
      testCases: [{ testcaseId: 66, versionId: 'v9', version: 'v9.0', tcType: 'WEB', executionPlatform: { id: 'FIREFOX', name: 'Firefox', technologyType: 'WEB', type: 'NONE' } }],
    };
    const { adapter, calls } = makeAdapter((url, init) => {
      if (url.endsWith('/tm/executionplan/20/7'))
        return { body: JSON.stringify({ data: PLAN_RAW() }) };
      if (url.includes('/tm/testcase/getById/55'))
        return { body: JSON.stringify({ data: TC_RAW(55) }) };
      if (url.includes('/tm/testcase/getById/66')) {
        return { body: JSON.stringify({ data: TC_RAW(66, { moduleId: 4, name: 'Suite case', description: 'desc' }) }) };
      }
      if (url.endsWith('/tm/suites/300'))
        return { body: JSON.stringify({ data: suiteDoc }) };
      if (url.endsWith('/tm/execplantestcases/search')) {
        return { body: JSON.stringify({ data: [{ id: 'e1', testcaseId: 55, expAssignedTo: 36, seq: 4 }] }) };
      }
      if (url.endsWith('/tm/execplantestcases') && init.method === 'POST')
        return { body: JSON.stringify({ data: [] }) };
      return undefined;
    });
    const out = await adapter.addPlanEntries('20', {
      tcIds: ['TC-55'], suiteIds: ['SU_300'], assignTo: 'me', assignDate: '2026-01-10',
    });
    expect(out).toEqual({ added: ['TC-66'], skipped: [{ code: 'TC-55', reason: 'already in the plan' }] });
    expect(byPath(calls, 'POST', '/tm/execplantestcases')[0]!.body).toEqual([
      {
        testcaseId: 66, code: 'TC-66', projectId: 7, moduleId: 4,
        executionType: 'AUTOMATION', tcType: 'WEB',
        tcVersionId: 'v9', versionName: 'v9.0', tcName: 'Suite case', tcDesc: 'desc',
        execPlanId: 20, executionId: 900,
        executionPlatform: { id: 'FIREFOX', name: 'Firefox', technologyType: 'WEB', type: 'NONE' },
        status: 'NOTEXECUTED', sourceType: 'suite', sourceId: 300, sourceName: 'Smoke', seq: 5, expAssignedTo: 36,
        expAssignedDate: '2026-01-10',
      },
    ]);
  }
  {
    let entries = [{ id: 'e1', testcaseId: 55, code: 'TC-55', tcName: 'Case 55', expAssignedTo: 36, seq: 1 }];
    const { adapter, calls } = makeAdapter((url, init) => {
      if (url.endsWith('/tm/executionplan/20/7'))
        return { body: JSON.stringify({ data: PLAN_RAW() }) };
      if (url.endsWith('/tm/execplantestcases/search'))
        return { body: JSON.stringify({ data: entries }) };
      if (url.endsWith('/tm/execplantestcases') && init.method === 'PATCH') {
        entries = [];
        return { body: JSON.stringify({ data: [] }) };
      }
      return undefined;
    });
    expect(await adapter.planEntriesRemovePreview('20', ['TC-55'])).toEqual({
      plan: { id: '20', code: 'PL-20', name: 'Sprint plan' },
      entries: [{ id: 'e1', code: 'TC-55', tcName: 'Case 55', assignedTo: 36 }],
    });
    await expect(adapter.planEntriesRemovePreview('20', ['TC-99'])).rejects.toThrow('TC-99 is not in PL-20.');
    expect(await adapter.removePlanEntries('20', ['TC-55'])).toEqual({ removed: 1, notRemoved: [] });
    expect(byPath(calls, 'PATCH', '/tm/execplantestcases')[0]!.body).toEqual({
      ids: ['e1'], execPlanId: 20, executionId: 900,
    });
  }
});

test('startExecutionPlanRun refuses a plan with nothing runnable, before any write', async () => {
  const manualOnly = makeAdapter((url) => {
    if (url.endsWith('/tm/executionplan/20/7'))
      return { body: JSON.stringify({ data: PLAN_RAW() }) };
    if (url.endsWith('/tm/execplantestcases/search')) {
      return { body: JSON.stringify({ data: [
            { id: 'e1', testcaseId: 55, code: 'TC-55', executionType: 'MANUAL', expAssignedTo: 36 },
            { id: 'e2', testcaseId: 56, code: 'TC-56', executionType: 'AUTOMATION', expAssignedTo: null },
            { id: 'e3', testcaseId: 57, code: 'TC-57', executionType: 'AUTOMATION', expAssignedTo: 36, status: 'BLOCKED' },
          ] }) };
    }
    return undefined;
  });
  await expect(manualOnly.adapter.startExecutionPlanRun('20', {})).rejects.toThrow('PL-20 has nothing to run: TC-55 (manual), TC-56 (not assigned), TC-57 (blocked).');
  expect(manualOnly.calls.some((c) => c.method === 'PUT' || c.url.includes('/exec/execution'))).toBe(false);
  const noPlatform = makeAdapter((url) => {
    if (url.endsWith('/tm/executionplan/20/7'))
      return { body: JSON.stringify({ data: PLAN_RAW() }) };
    if (url.endsWith('/tm/execplantestcases/search')) {
      return { body: JSON.stringify({ data: [
            { id: 'e1', testcaseId: 55, code: 'TC-55', executionType: 'AUTOMATION', expAssignedTo: 36, tcType: 'WEB' },
          ] }) };
    }
    return undefined;
  });
  await expect(noPlatform.adapter.startExecutionPlanRun('20', {})).rejects.toThrow('Set an execution platform first for: TC-55.');
});

// ---------------------------------------------------------------- schedules

test('createSchedule writes the scheduler form body for a TC and a suite, and refuses a plan / missing end date / mobile', async () => {
  {
    const { adapter, calls } = makeAdapter((url, init) => {
      if (url.includes('/tm/testcase/getById/55'))
        return { body: JSON.stringify({ data: TC_RAW(55) }) };
      if (url.endsWith('/sh/scheduler') && init.method === 'POST') {
        return { body: JSON.stringify({ data: { id: 77, status: 'NOT STARTED', nextRecurrenceTime: '2026-01-05T09:00:00.000Z' } }) };
      }
      return undefined;
    });
    const ref = await adapter.createSchedule({ tcId: '55' }, {
      scheduleType: 'once',
      scheduledFor: '2026-01-05T09:00:00.000Z',
      mode: 'local',
      browser: 'firefox',
      timezone: 'Asia/Kolkata',
      releaseId: '3',
      sprintId: '4',
    });
    expect(ref).toEqual({ id: '77', name: 'TC-55 schedule', status: 'NOT STARTED', nextRunAt: '2026-01-05T09:00:00.000Z' });
    expect(byPath(calls, 'POST', '/sh/scheduler')[0]!.body).toEqual({
      projectId: 7,
      name: 'TC-55 schedule',
      schedulerType: 'TC',
      parentId: 55,
      parentVersionId: 'v55',
      platForm: [{ id: 'FIREFOX', name: 'FIREFOX', type: 'NONE', technologyType: 'WEB' }],
      environment: 'general',
      releaseId: 3,
      iterationId: 4,
      recurrenceType: 'ONCE',
      reccurenceData: { startDate: '2026-01-05T09:00:00.000Z', endDate: null, interval: 1, daysOfWeek: [], dayOfMonth: null, occurencePosition: '' },
      scheduleStartDate: '2026-01-05T09:00:00.000Z',
      scheduleEndDate: '2026-01-05T09:00:00.000Z',
      executionMode: 'local',
      executionStyle: 'serial',
      agentId: [],
      status: 'NOT STARTED',
      cancelled: false,
      offset: expect.any(Number),
      tz: 'Asia/Kolkata',
      retryConfig: { retryEnabled: false, retryCount: 1, retryIntervalMinutes: 5 },
    });
  }
  {
    const { adapter, calls } = makeAdapter((url) => {
      if (url.includes('/tm/testcase/getById/55'))
        return { body: JSON.stringify({ data: TC_RAW(55, { tcType: 'ANDROID' }) }) };
      return undefined;
    });
    await expect(adapter.createSchedule({ planId: '20' }, { scheduleType: 'once', scheduledFor: '2026-01-05T09:00:00.000Z', mode: 'local' }))
      .rejects.toThrow("SimplifyQA's Scheduler only schedules a test case or a suite");
    await expect(adapter.createSchedule({ tcId: '55' }, { scheduleType: 'daily', scheduledFor: '2026-01-05T09:00:00.000Z', mode: 'local' }))
      .rejects.toThrow('A recurring schedule needs an end date (endDate).');
    await expect(adapter.createSchedule({ tcId: '55' }, { scheduleType: 'once', scheduledFor: '2026-01-05T09:00:00.000Z', mode: 'local' }))
      .rejects.toThrow('TC-55 is a ANDROID test case: schedule it from SimplifyQA, where you pick the device.');
    await expect(adapter.createSchedule({}, { scheduleType: 'once', scheduledFor: '2026-01-05T09:00:00.000Z', mode: 'local' }))
      .rejects.toThrow('Nothing to schedule: give a test case or a suite.');
    expect(byPath(calls, 'POST', '/sh/scheduler')).toHaveLength(0);
  }
  {
    const suiteRaw = {
      id: 300, code: 'SU-300', name: 'Smoke', projectId: 7,
      testCases: [{ testcaseId: 55, tcType: 'WEB' }, { testcaseId: 66, tcType: 'API' }, { testcaseId: 99, tcType: 'WEB', deleted: true }],
    };
    const { adapter, calls } = makeAdapter((url, init) => {
      if (url.endsWith('/tm/suites/300') && (init.method ?? 'GET') === 'GET')
        return { body: JSON.stringify({ data: suiteRaw }) };
      if (url.endsWith('/sh/scheduler') && init.method === 'POST')
        return { body: JSON.stringify({ data: { id: 78 } }) };
      return undefined;
    });
    expect(await adapter.createSchedule({ suiteId: 'SU_300' }, {
      scheduleType: 'once', scheduledFor: '2026-01-05T09:00:00.000Z', mode: 'cloud',
    })).toEqual({ id: '78', name: 'SU-300 schedule' });
    const body = byPath(calls, 'POST', '/sh/scheduler')[0]!.body;
    expect(body.schedulerType).toBe('SU');
    expect(body.parentId).toBe(300);
    expect(body.parentVersionId).toBeUndefined();
    // a CLOUD schedule: the web test cases get the cloud (headless) browser
    expect(body.platForm).toEqual([
      { id: 'CHROME_HEADLESS', name: 'CHROME_HEADLESS', type: 'NONE', technologyType: 'WEB' },
      { id: 'API', name: 'API', type: 'NONE', technologyType: 'API' },
    ]);
    expect(body.executionStyle).toBe('');
    const mobile = makeAdapter((url, init) => {
      if (url.endsWith('/tm/suites/300') && (init.method ?? 'GET') === 'GET') {
        return { body: JSON.stringify({ data: { ...suiteRaw, testCases: [{ testcaseId: 55, tcType: 'IOS' }] } }) };
      }
      return undefined;
    });
    await expect(mobile.adapter.createSchedule({ suiteId: '300' }, {
      scheduleType: 'once', scheduledFor: '2026-01-05T09:00:00.000Z', mode: 'local',
    })).rejects.toThrow('SU-300 has IOS test cases: schedule it from SimplifyQA, where you pick the device.');
  }
});

test('updateSchedule rebuilds the recurrence, controlSchedule cancels, and delete is a bare id array', async () => {
  const sched = {
    id: 77, code: 'SCH-77', name: 'nightly', projectId: 7, schedulerType: 'TC', parentId: 55,
    recurrenceType: 'ONCE', scheduleStartDate: '2026-01-05T09:00:00.000Z', scheduleEndDate: '2026-01-05T09:00:00.000Z',
    reccurenceData: { startDate: '2026-01-05T09:00:00.000Z', endDate: null, interval: 1, daysOfWeek: [], dayOfMonth: null, occurencePosition: '' },
    status: 'NOT STARTED', cancelled: false, executionMode: 'local', executionStyle: 'serial',
    platForm: [{ id: 'CHROME', name: 'CHROME', type: 'NONE', technologyType: 'WEB' }], agentId: [], updateVersion: 2,
    tz: 'Asia/Kolkata', offset: 0, nextRecurrenceTime: null,
  };
  const { adapter, calls } = makeAdapter((url, init) => {
    if (url.endsWith('/sh/scheduler/77') && (init.method ?? 'GET') === 'GET')
      return { body: JSON.stringify([sched]) };
    if (url.endsWith('/sh/scheduler/77') && init.method === 'PUT')
      return { body: JSON.stringify({ data: { status: 'NOT STARTED' } }) };
    if (url.endsWith('/sh/scheduler') && init.method === 'PATCH')
      return { body: JSON.stringify({ data: true }) };
    return undefined;
  });
  await adapter.updateSchedule('77', {
    scheduleType: 'monthly', scheduledFor: '2026-02-10T09:00:00.000Z', endDate: '2026-12-10T09:00:00.000Z', browser: 'edge', mode: 'cloud',
  });
  const body = byPath(calls, 'PUT', '/sh/scheduler/77')[0]!.body;
  expect(body.recurrenceType).toBe('MONTHLY');
  expect(body.scheduleStartDate).toBe('2026-02-10T09:00:00.000Z');
  expect(body.scheduleEndDate).toBe('2026-12-10T09:00:00.000Z');
  expect(body.reccurenceData).toEqual({
    startDate: '2026-02-10T09:00:00.000Z', endDate: '2026-12-10T09:00:00.000Z',
    interval: 1, daysOfWeek: [], dayOfMonth: 10, occurencePosition: '',
  });
  expect(body.platForm).toEqual([{ id: 'EDGE_HEADLESS', name: 'EDGE_HEADLESS', type: 'NONE', technologyType: 'WEB' }]);   // switched to cloud → the cloud browser
  expect(body.executionMode).toBe('cloud');
  expect(body.nextRecurrenceTime).toBeNull();
  expect(body.updateVersion).toBe(2);
  expect(body.tz).toBeUndefined();
  await expect(adapter.controlSchedule('77', 'pause')).rejects.toThrow('SimplifyQA has no pause');
  await expect(adapter.controlSchedule('77', 'resume')).rejects.toThrow('SimplifyQA restarts a schedule from a new start time');
  expect(await adapter.controlSchedule('77', 'cancel')).toEqual({ id: '77', status: 'NOT STARTED' });
  expect(byPath(calls, 'PUT', '/sh/scheduler/77')[1]!.body).toMatchObject({ cancelled: true, status: 'CANCELLED' });
  expect(await adapter.scheduleDeletePreview('77')).toEqual({
    id: '77', code: 'SCH-77', name: 'nightly', target: 'TC 55',
  });
  await adapter.deleteSchedule('77');
  expect(byPath(calls, 'PATCH', '/sh/scheduler')[0]!.body).toEqual([77]);
});

// ---------------------------------------------------------------- test plans

test('test-plan folders: create (root + child), rename, add members with de-duplication', async () => {
  const folders: Record<string, any> = {
    '30': { id: 30, code: 'TP-30', name: 'Regression', projectId: 7, childIds: [], suiteIds: [300], testcaseIds: [{ id: 55, version: 'v1.0', versionId: 'v55' }] },
  };
  const { adapter, calls } = makeAdapter((url, init) => {
    if (url.endsWith('/tm/scenario') && init.method === 'POST') {
      return { body: JSON.stringify({ data: { id: 30, code: 'TP-30' } }) };
    }
    if (url.endsWith('/tm/scenario/30') && (init.method ?? 'GET') === 'GET')
      return { body: JSON.stringify({ data: folders['30'] }) };
    if (url.endsWith('/tm/scenario/30') && init.method === 'PUT') {
      folders['30'] = { ...folders['30'], ...JSON.parse(String(init.body)) };
      return { body: JSON.stringify({ data: folders['30'] }) };
    }
    if (url.endsWith('/tm/suites/300'))
      return { body: JSON.stringify({ data: { id: 300, code: 'SU-300', projectId: 7, testCases: [] } }) };
    if (url.endsWith('/tm/suites/301'))
      return { body: JSON.stringify({ data: { id: 301, code: 'SU-301', projectId: 7, testCases: [] } }) };
    if (url.includes('/tm/testcase/getById/66'))
      return { body: JSON.stringify({ data: TC_RAW(66) }) };
    if (url.includes('/tm/testcase/getById/55'))
      return { body: JSON.stringify({ data: TC_RAW(55) }) };
    return undefined;
  });
  expect(await adapter.createTestPlan({ name: 'Regression' })).toEqual({ id: '30', code: 'TP-30', created: true });
  expect(byPath(calls, 'POST', '/tm/scenario')[0]!.body).toEqual({ name: 'Regression', projectId: 7, isRoot: true, childIds: [] });
  await adapter.createTestPlan({ name: 'Smoke', parentId: '30' });
  expect(byPath(calls, 'POST', '/tm/scenario')[1]!.body).toEqual({ name: 'Smoke', projectId: 7, isRoot: false, parentId: 30, childIds: [] });
  await adapter.renameTestPlan('30', 'Regression v2');
  expect(byPath(calls, 'PUT', '/tm/scenario/30')[0]!.body).toEqual({ name: 'Regression v2', projectId: 7 });
  const added = await adapter.addToTestPlan('30', { suiteIds: ['300', '301'], tcIds: ['55', '66'] });
  expect(added).toEqual({
    added: ['SU-301', 'TC-66'],
    skipped: [
      { code: 'SU-300', reason: 'already in the test plan' },
      { code: 'TC-55', reason: 'already in the test plan' },
    ],
  });
  expect(byPath(calls, 'PUT', '/tm/scenario/30')[1]!.body).toEqual({
    suiteIds: [301],
    testcaseIds: [{ id: 66, version: 'v1.0', versionId: 'v66' }],
    leafNode: true,
    projectId: 7,
  });
});

test('test-plan removal: one test case, one suite; preview walks the sub-folders; delete verifies', async () => {
  let folder: any = {
    id: 30, code: 'TP-30', name: 'Regression', projectId: 7, childIds: [31],
    suiteIds: [300, 301], testcaseIds: [{ id: 55, version: 'v1.0', versionId: 'v55' }],
  };
  let deleted = false;
  const { adapter, calls } = makeAdapter((url, init) => {
    if (url.endsWith('/tm/scenario/30') && (init.method ?? 'GET') === 'GET') {
      return deleted ? { status: 404, body: '{}' } : { body: JSON.stringify({ data: folder }) };
    }
    if (url.endsWith('/tm/scenario/30') && init.method === 'PATCH') {
      deleted = true;
      return { body: JSON.stringify({ data: true }) };
    }
    if (url.endsWith('/tm/scenario/testcase/30') && init.method === 'PATCH') {
      folder = { ...folder, testcaseIds: [] };
      return { body: JSON.stringify({ data: true }) };
    }
    if (url.endsWith('/tm/scenario/suite/30') && init.method === 'PATCH') {
      folder = { ...folder, suiteIds: [301] };
      return { body: JSON.stringify({ data: true }) };
    }
    if (url.endsWith('/tm/scenario/search')) {
      return { body: JSON.stringify({ data: [
            { id: 30, code: 'TP-30', name: 'Regression', childIds: [31] },
            { id: 31, code: 'TP-31', name: 'Nested', childIds: [32] },
            { id: 32, code: 'TP-32', name: 'Deep', childIds: [] },
          ] }) };
    }
    if (url.includes('/tm/testcase/getById/55'))
      return { body: JSON.stringify({ data: TC_RAW(55) }) };
    return undefined;
  });
  expect(await adapter.removeTestcaseFromTestPlan('30', '55', 'v55')).toEqual({ removed: 'TC-55', remaining: [] });
  expect(byPath(calls, 'PATCH', '/tm/scenario/testcase/30')[0]!.body).toEqual({
    selectedTc: JSON.stringify({ id: 55, version: 'v1.0', versionId: 'v55' }), leafNode: true,
  });
  await expect(adapter.removeTestcaseFromTestPlan('30', '55')).rejects.toThrow('TC-55 is not in TP-30.');
  await adapter.removeSuiteFromTestPlan('30', '300');
  expect(byPath(calls, 'PATCH', '/tm/scenario/suite/30')[0]!.body).toEqual({ suiteId: 300, leafNode: true });
  await expect(adapter.removeSuiteFromTestPlan('30', '999')).rejects.toThrow('SU-999 is not in TP-30.');
  expect(await adapter.testPlanDeletePreview('30')).toEqual({
    plan: { id: '30', code: 'TP-30', name: 'Regression' },
    subFolders: [
      { id: '31', code: 'TP-31', name: 'Nested' },
      { id: '32', code: 'TP-32', name: 'Deep' },
    ],
  });
  await expect(adapter.deleteTestPlan('30')).resolves.toBeUndefined();
  expect(byPath(calls, 'PATCH', '/tm/scenario/30')[0]!.body).toEqual({ id: 30 });
});

// ---------------------------------------------------------------- pipelines

test('pipelines: create (TC and SU), update, preview, start/status/stop and delete', async () => {
  const pipe = {
    id: 9, code: 'PIP-9', name: 'nightly', projectId: 7, pipelineType: 'TC', parentId: 55,
    platForm: [{ id: 'CHROME', name: 'CHROME', type: 'NONE', technologyType: 'WEB' }],
    environment: 'qa', releaseId: 3, iterationId: 4, executionMode: 'local', executionStyle: 'serial',
    description: 'd', updateVersion: 2,
  };
  const suiteDoc = { id: 300, code: 'SU-300', name: 'Smoke', projectId: 7, testCases: [{ testcaseId: 55, tcType: 'WEB' }] };
  const { adapter, calls } = makeAdapter((url, init) => {
    if (url.includes('/tm/testcase/getById/55'))
      return { body: JSON.stringify({ data: TC_RAW(55) }) };
    if (url.endsWith('/tm/suites/300'))
      return { body: JSON.stringify({ data: suiteDoc }) };
    if (url.endsWith('/pl/pipelines') && init.method === 'POST')
      return { body: JSON.stringify({ data: { id: 9, code: 'PIP-9' } }) };
    if (url.endsWith('/pl/pipelines/9') && (init.method ?? 'GET') === 'GET')
      return { body: JSON.stringify({ data: pipe }) };
    if (url.endsWith('/pl/pipelines/9') && init.method === 'PUT')
      return { body: JSON.stringify({ data: { id: 9 } }) };
    if (url.endsWith('/pl/pipelines') && init.method === 'PATCH')
      return { body: JSON.stringify({ data: true }) };
    if (url.endsWith('/pl/exec/start/9'))
      return { body: JSON.stringify({ data: { id: 'exec-1', code: 'EX-1' } }) };
    if (url.endsWith('/pl/exec/status/7/1')) {
      return { body: JSON.stringify({ data: {
            id: 'exec-1', code: 'EX-1', status: 'INPROGRESS', result: 'PENDING', mode: 'LOCAL', createdAt: '2026-01-01',
            executionItems: [{ code: 'TC-55', name: 'Case', status: 'PASSED', extra: 'x' }],
          } }) };
    }
    if (url.endsWith('/pl/exec/stop/7/1'))
      return { body: JSON.stringify({ data: true }) };
    return undefined;
  });
  expect(await adapter.createPipeline({
    name: 'nightly', pipelineType: 'TC', parentId: '55', releaseId: '3', sprintId: '4',
    mode: 'local', browser: 'chrome', description: 'd',
  })).toEqual({ id: '9', code: 'PIP-9', created: true });
  expect(byPath(calls, 'POST', '/pl/pipelines')[0]!.body).toEqual({
    name: 'nightly', projectId: 7, pipelineType: 'TC', parentId: 55, parentVersion: 'v55',
    platForm: [{ id: 'CHROME', name: 'CHROME', type: 'NONE', technologyType: 'WEB' }],
    environment: 'general', releaseId: 3, iterationId: 4, executionMode: 'local', executionStyle: 'serial', description: 'd',
  });
  await expect(adapter.createPipeline({ name: 'x', pipelineType: 'TC', parentId: '55', mode: 'local' }))
    .rejects.toThrow('A pipeline needs a release and a sprint (releaseId, sprintId).');
  expect(await adapter.createPipeline({
    name: 'suite nightly', pipelineType: 'SU', parentId: '300', releaseId: '3', sprintId: '4', mode: 'cloud',
  })).toEqual({ id: '9', code: 'PIP-9', created: true });
  expect(byPath(calls, 'POST', '/pl/pipelines')[1]!.body).toMatchObject({
    pipelineType: 'SU', parentId: 300, platForm: [{ id: 'CHROME', name: 'CHROME', type: 'NONE', technologyType: 'WEB' }], executionStyle: '',
  });
  expect(byPath(calls, 'POST', '/pl/pipelines')[1]!.body.parentVersion).toBeUndefined();
  await adapter.updatePipeline('9', { name: 'renamed', releaseId: '5', sprintId: '6', mode: 'cloud', agentId: 'agent-1' });
  expect(byPath(calls, 'PUT', '/pl/pipelines/9')[0]!.body).toEqual({
    id: 9, code: 'PIP-9', name: 'renamed', projectId: 7, pipelineType: 'TC', parentId: 55,
    platForm: [{ id: 'CHROME', name: 'CHROME', type: 'NONE', technologyType: 'WEB' }],
    environment: 'qa', releaseId: 5, iterationId: 6, executionMode: 'cloud', executionStyle: '', description: 'd',
    agentId: 'agent-1', updateVersion: 2,
  });
  expect(await adapter.pipelineDeletePreview('9')).toEqual({ id: '9', code: 'PIP-9', name: 'nightly' });
  expect(await adapter.startPipeline('9')).toEqual({ runId: 'exec-1', code: 'EX-1' });
  expect(await adapter.getPipelineRun('exec-1')).toEqual({
    id: 'exec-1', code: 'EX-1', status: 'INPROGRESS', result: 'PENDING', mode: 'LOCAL', createdAt: '2026-01-01',
    items: [{ code: 'TC-55', name: 'Case', status: 'PASSED' }],
  });
  await adapter.stopPipelineRun('exec-1');
  expect(byPath(calls, 'PATCH', '/pl/exec/stop/7/1')).toHaveLength(1);
  await adapter.deletePipeline('9');
  expect(byPath(calls, 'PATCH', '/pl/pipelines')[0]!.body).toEqual([9]);
});
