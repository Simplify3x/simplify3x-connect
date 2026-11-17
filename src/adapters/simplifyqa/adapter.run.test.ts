import os from 'node:os';
import { SimplifyQaAdapter } from './adapter.js';

/** Run dispatch + run status + history. The existing startRun.* suites cover mode/agent fidelity,
 *  the SUITE wire shape and version resolution; this file pins the rest of the RUN path:
 *    - the TESTCASE execution envelope (which keys the validator rejects when wrong),
 *    - run-id / report-URL parsing and the "no id" refusal,
 *    - environment resolution (display name → stored KEY) and the unknown-environment refusal,
 *    - the pre-dispatch refusals (LOCAL with no agent, REMOTE with no agentId),
 *    - getRun status mapping (TC steps + suite rollup), listRecentRuns/history tallies. */

type Handler = (url: string, init: RequestInit) => { status?: number; body: string };
type Call = { method: string; url: string; body?: any };

type Options = {
  rawTc?: Record<string, any>;
  envs?: any[];
  execResponse?: { status?: number; body: string };
  execDoc?: Record<string, any> | null;
  projectName?: string;
  roster?: any[];
};

const CALLER_ID = 36;
const PROJECT_ID = 7;

const WEB_TC = {
  id: 42,
  name: 'Checkout flow',
  code: 'TC_42',
  projectId: 7,
  moduleId: 3,
  userstoryId: 0,
  tcType: 'WEB',
  executionType: 'AUTOMATION',
  description: 'Pay with a saved card',
  prerequisite: 'User is signed in',
  tags: [4, 8],
  versions: [{ id: 'ver-1', name: 'v1.0' }],
};

function makeAdapter(opts: Options = {}, cfg: Record<string, any> = {}) {
  const calls: Call[] = [];
  const handler: Handler = (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ method, url, ...(init.body !== undefined ? { body: JSON.parse(String(init.body)) } : {}) });

    // Project-access guard.
    if (url.includes('/pm/auth/me')) {
      return { body: JSON.stringify({
        userDetails: { id: CALLER_ID, username: 'qa.user', email: 'qa.user@x.test', userType: 'user' },
      }) };
    }
    if (url.includes('/pm/projectuserrole') && url.includes(`userId=${CALLER_ID}`)) {
      return { body: JSON.stringify({ data: [{ userId: CALLER_ID, projectId: PROJECT_ID, roleId: 2, deleted: false }] }) };
    }
    if (url.includes('/pm/project/search')) {
      return { body: JSON.stringify({ data: [{ id: PROJECT_ID, name: opts.projectName ?? 'Proj Seven' }] }) };
    }
    if (url.includes('/tm/testcase/getById/42')) {
      return { body: JSON.stringify({ data: opts.rawTc ?? WEB_TC }) };
    }
    if (url.includes('/pm/fields/8')) {
      return { body: JSON.stringify(opts.envs ?? [{ key: 'general', name: 'General' }]) };
    }
    if (url.includes('/pm/module/search')) {
      return { body: JSON.stringify({ data: [{ id: 3, name: 'Auth' }] }) };
    }
    if (url.includes('/tm/machineRegistration/search')) {
      return { body: JSON.stringify({ data: opts.roster ?? [] }) };
    }
    if (url.includes('/exec/execution/search')) {
      if (opts.execDoc === null) return { status: 500, body: JSON.stringify({ message: 'read-back failed' }) };
      return { body: JSON.stringify({ data: [opts.execDoc ?? { id: 555, mode: 'CLOUD' }] }) };
    }
    if (method === 'POST' && url.endsWith('/exec/execution')) {
      return opts.execResponse ?? { body: JSON.stringify({ data: { id: 555 } }) };
    }
    return { status: 404, body: JSON.stringify({ message: `unexpected ${method} ${url}` }) };
  };

  const fetchImpl = (async (url: string, init: RequestInit) => {
    const { status = 200, body } = handler(url, init);
    return { ok: status < 300, status, text: async () => body };
  }) as unknown as typeof fetch;

  const adapter = new SimplifyQaAdapter(
    { baseUrl: 'https://x.test', token: 't', projectId: PROJECT_ID, ...cfg } as any,
    { fetchImpl, FormDataImpl: FormData },
  );
  return { adapter, calls };
}

const executionPost = (calls: Call[]): Call | undefined =>
  calls.find((c) => c.method === 'POST' && c.url.endsWith('/exec/execution'));

const expectedOs = process.platform === 'win32' ? 'WINDOWS' : process.platform === 'darwin' ? 'MAC' : 'LINUX';

test('startRun posts the TESTCASE execution envelope and returns the report link', async () => {
  const { adapter, calls } = makeAdapter();
  const ref = await adapter.startRun({ tcId: 'TC_42' }, {
    mode: 'cloud', environment: 'general', browser: 'chromium', cloudType: 'AZURE',
  });

  expect(ref.runId).toBe('555');
  expect(ref.reportUrl).toBe(
    'https://x.test/user/reports/reports-page?type=TESTCASE&parentId=42&id=555&projectId=7',
  );

  const posted = executionPost(calls)!;
  expect(posted.url).toBe('https://x.test/exec/execution');
  expect(posted.body).toMatchObject({
    projectId: 7,
    type: 'TESTCASE',
    executionCategory: 'EXECUTION',
    executionType: 'AUTOMATION',
    mode: 'CLOUD',
    agentId: null,
    cloudType: 'AZURE',
    executionTypeId: 42,
    executionTypeName: 'Checkout flow',
    executionTypeCode: 'TC_42',
    executionStyle: 'SERIAL',
    status: 'INPROGRESS',
    result: '',
    iterationsSelected: [],
    mailersList: {},
    globalConfiguration: {},
    isRecordingEnabled: false,
    releaseId: 0,
    iterationId: 0,
    executionOS: expectedOs,
    offset: -new Date().getTimezoneOffset(),
  });

  expect(posted.body.executionItems).toHaveLength(1);
  const item = posted.body.executionItems[0];
  expect(item).toMatchObject({
    id: 42,
    name: 'Checkout flow',
    description: 'Pay with a saved card',
    versionId: 'ver-1',
    versionName: 'v1.0',
    seq: 1,
    stepCount: 0,
    technologyType: 'WEB',
    type: 'TC',
    platform: [{ name: 'CHROMIUM_HEADLESS', id: 'CHROMIUM_HEADLESS', technologyType: 'WEB', type: 'NONE' }],
    projectId: 7,
    projectName: 'Proj Seven',
    configuration: {},
    iterationsSelected: [],
    moduleId: 3,
    userstoryId: 0,
    tags: [4, 8],
    code: 'TC_42',
    prerequisite: 'User is signed in',
    moduleName: 'Auth',
    userstoryName: '',
  });
  // A fresh 6-char step correlation id, never the suite-row value.
  expect(item.stepId).toMatch(/^[a-z0-9]{6}$/);
});

test('startRun (LOCAL) stamps the caller\'s strategy, browser and this machine\'s agent', async () => {
  const { adapter, calls } = makeAdapter({
    execDoc: { id: 556, mode: 'LOCAL', agentId: 'agent-self' },
    roster: [{ id: 'agent-self', machineName: `VIGNESH [ ${os.hostname().toUpperCase()} ]`, active: true }],
  }, { url: 'data:text/plain,ok' });

  const ref = await adapter.startRun({ tcId: 'TC_42' }, {
    mode: 'local', environment: 'general', browser: 'firefox', strategy: 'parallel',
  });

  expect(ref.runId).toBe('555');
  const body = executionPost(calls)!.body;
  expect(body.mode).toBe('LOCAL');
  expect(body.agentId).toBe('agent-self');
  expect(body.executionStyle).toBe('PARALLEL');
  expect(body.cloudType).toBe('NONE');
  expect(body.executionItems[0].platform).toEqual([
    { name: 'FIREFOX', id: 'FIREFOX', technologyType: 'WEB', type: 'NONE' },
  ]);
});

test('startRun parses a run id from executionId and refuses an answer with no id', async () => {
  const ok = makeAdapter({ execResponse: { body: JSON.stringify({ data: { executionId: 4242 } }) } }).adapter;
  const ref = await ok.startRun({ tcId: 'TC_42' }, { mode: 'cloud', environment: 'general' });
  expect(ref.runId).toBe('4242');
  expect(ref.reportUrl).toContain('&id=4242&projectId=7');

  const { adapter } = makeAdapter({ execResponse: { body: JSON.stringify({ data: {} }) } });
  await expect(
    adapter.startRun({ tcId: 'TC_42' }, { mode: 'cloud', environment: 'general' }),
  ).rejects.toThrow(/backend accepted trigger but returned no run id/);
});

test('startRun resolves an environment DISPLAY NAME to its stored key', async () => {
  const envs = [
    { key: 'general', name: 'General' },
    { key: 'uat', name: 'UAT' },
  ];
  const { adapter, calls } = makeAdapter({ envs });
  await adapter.startRun({ tcId: 'TC_42' }, { mode: 'cloud', environment: 'uat' });
  expect(executionPost(calls)!.body.environmentType).toBe('uat');

  const second = makeAdapter({ envs });
  await second.adapter.startRun({ tcId: 'TC_42' }, { mode: 'cloud', environment: 'UAT' });
  expect(executionPost(second.calls)!.body.environmentType).toBe('uat');
});

test('startRun with no environment uses the project\'s first configured env key', async () => {
  const { adapter, calls } = makeAdapter({
    envs: [{ key: 'stage', name: 'Staging' }, { key: 'general', name: 'General' }],
  });
  await adapter.startRun({ tcId: 'TC_42' }, { mode: 'cloud' });
  expect(executionPost(calls)!.body.environmentType).toBe('stage');
});

test('startRun refuses an unknown environment, naming the valid ones, without dispatching', async () => {
  const { adapter, calls } = makeAdapter({
    envs: [{ key: 'general', name: 'General' }, { key: 'uat', name: 'UAT' }],
  });
  await expect(
    adapter.startRun({ tcId: 'TC_42' }, { mode: 'cloud', environment: 'staging' }),
  ).rejects.toThrow(/Environment "staging" does not exist in this project[\s\S]*UAT \(key uat\)/);
  expect(executionPost(calls)).toBeUndefined();
});

test('startRun (LOCAL) refuses before reading the test case when no agent URL is configured', async () => {
  const { adapter, calls } = makeAdapter();
  await expect(
    adapter.startRun({ tcId: 'TC_42' }, { mode: 'local', environment: 'general' }),
  ).rejects.toThrow(/could not reach the SimplifyQA desktop agent[\s\S]*no agent URL configured/);
  expect(executionPost(calls)).toBeUndefined();
  expect(calls.some((c) => c.url.includes('/tm/testcase/getById/42'))).toBe(false);
});

test('startRun (REMOTE) refuses without an agentId — there is no cross-machine auto-pick', async () => {
  const { adapter, calls } = makeAdapter();
  await expect(
    adapter.startRun({ tcId: 'TC_42' }, { mode: 'remote', environment: 'general' }),
  ).rejects.toThrow(/agentId is required/);
  expect(executionPost(calls)).toBeUndefined();
  expect(calls.some((c) => c.url.includes('/tm/machineRegistration/search'))).toBe(false);
});

test('a MANUAL test case is dispatched with executionType MANUAL (no client-side refusal)', async () => {
  const { adapter, calls } = makeAdapter({ rawTc: { ...WEB_TC, executionType: 'MANUAL' } });
  await adapter.startRun({ tcId: 'TC_42' }, { mode: 'cloud', environment: 'general' });
  expect(executionPost(calls)!.body.executionType).toBe('MANUAL');
});

test('getRun maps a failed TC step, its stored exception and the step-level report link', async () => {
  const calls: Call[] = [];
  const handler: Handler = (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ method, url, ...(init.body !== undefined ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url.includes('/pm/auth/me')) return { body: JSON.stringify({ userDetails: { id: CALLER_ID } }) };
    if (url.includes('/pm/projectuserrole')) return { body: JSON.stringify({ data: [{ projectId: PROJECT_ID, roleId: 2 }] }) };
    if (url.includes('/exec/execution/search')) {
      return { body: JSON.stringify({ data: [{ id: 555, type: 'TC', executionTypeId: 42 }] }) };
    }
    if (url.includes('/exec/report/555/7')) {
      return { body: JSON.stringify([
        { id: 'exec-run-1', status: 'FAILED', executionItemId: 900, testcaseId: 42 },
        { id: 'exec-run-0', status: 'PASSED', deleted: true },
      ]) };
    }
    if (url.includes('/reports/execution/getstepResult')) {
      return { body: JSON.stringify({ data: [
        { seq: 1, description: 'Launch the app', status: 'PASSED', exception: null },
        { seq: 2, description: 'Click Pay', status: 'FAILED', exception: 'NoSuchElement: #pay' },
        { seq: 3, stepType: 'LOOP_ITERATION_START', description: null, status: 'INFO' },
        { seq: 4, stepType: 'FUNCTION_END', description: null, status: 'INFO' },
      ] }) };
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

  const status = await adapter.getRun('555');

  expect(status.state).toBe('failed');
  expect(status.stepResults).toHaveLength(2); // INFO control-flow rows are dropped
  expect(status.stepResults![0]).toEqual({ n: 1, description: 'Launch the app', status: 'passed' });
  expect(status.stepResults![1]).toEqual({
    n: 2, description: 'Click Pay', status: 'failed', error: 'NoSuchElement: #pay',
  });
  expect(status.reportUrl).toBe(
    'https://x.test/user/reports/reports-page?type=TESTCASE&parentId=42&id=555&projectId=7',
  );
  // The step rows are fetched with the execution id + the failing item's executionRunId/parentId.
  const stepCall = calls.find((c) => c.url.includes('/reports/execution/getstepResult'))!;
  expect(stepCall.body).toEqual({ executionId: 555, executionRunId: 'exec-run-1', parentId: 900, projectId: 7 });
});

test('getRun surfaces ERROR log lines when the backend leaves `exception` null', async () => {
  // getRun only needs the report rows + step rows, so a dedicated adapter whose FAILED step
  // carries ERROR log lines instead of an exception.
  const withLogs = new SimplifyQaAdapter(
    { baseUrl: 'https://x.test', token: 't', projectId: PROJECT_ID } as any,
    {
      fetchImpl: (async (url: string, init: RequestInit) => {
        void init;
        if (url.includes('/pm/auth/me')) return { ok: true, status: 200, text: async () => JSON.stringify({ userDetails: { id: CALLER_ID } }) };
        if (url.includes('/pm/projectuserrole')) return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ projectId: PROJECT_ID, roleId: 2 }] }) };
        if (url.includes('/exec/execution/search')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 555, type: 'TC', executionTypeId: 42 }] }) };
        }
        if (url.includes('/exec/report/555/7')) {
          return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 'run-a', status: 'FAILED', executionItemId: 1 }]) };
        }
        if (url.includes('/reports/execution/getstepResult')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ data: [
            {
              seq: 1, description: 'Click Pay', status: 'FAILED', exception: null,
              executionLogData: { executionLogs: ['INFO step started', 'ERROR No Such Element Exception: #pay'] },
            },
            { seq: 2, description: 'Logout', status: 'PASSED', exception: null, executionLogData: { executionLogs: [] } },
          ] }) };
        }
        return { ok: false, status: 404, text: async () => '{}' };
      }) as unknown as typeof fetch,
      FormDataImpl: FormData,
    },
  );

  const status = await withLogs.getRun('555');
  expect(status.stepResults![0]!.error).toBe('ERROR No Such Element Exception: #pay');
  expect(status.stepResults![1]!.error).toBeUndefined();
  expect(status.state).toBe('failed');
});

test('getRun rolls a SUITE run up per test case and never calls /exec/report', async () => {
  const calls: Call[] = [];
  const handler: Handler = (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ method, url });
    if (url.includes('/pm/auth/me')) return { body: JSON.stringify({ userDetails: { id: CALLER_ID } }) };
    if (url.includes('/pm/projectuserrole')) return { body: JSON.stringify({ data: [{ projectId: PROJECT_ID, roleId: 2 }] }) };
    if (url.includes('/exec/execution/search')) {
      return { body: JSON.stringify({ data: [{
        id: 555,
        type: 'SUITE',
        status: 'INPROGRESS',
        executionTypeId: 17,
        startTime: '2026-01-02T10:00:00Z',
        executionItems: [
          { testcaseId: 101, name: 'Login OK', status: 'PASSED', versionId: 'v2', stepId: 'sr-1' },
          { testcaseId: 102, name: 'Logout OK', status: 'RUNNING', versionId: 'v1', stepId: 'sr-2' },
          { testcaseId: 103, name: 'Signup', status: 'NOTEXECUTED' },
        ],
      }] }) };
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

  const status = await adapter.getRun('555');

  expect(status.state).toBe('running');
  // A row counts as done once it left queued/running — NOTEXECUTED already did, RUNNING did not.
  expect(status.progress).toEqual({ done: 2, total: 3 });
  expect(status.children).toEqual([
    { id: '101', state: 'passed', testcaseId: '101', versionId: 'v2', stepId: 'sr-1', title: 'Login OK' },
    { id: '102', state: 'running', testcaseId: '102', versionId: 'v1', stepId: 'sr-2', title: 'Logout OK' },
    { id: '103', state: 'notExecuted', testcaseId: '103', title: 'Signup' },
  ]);
  expect(status.startedAt).toBe('2026-01-02T10:00:00Z');
  expect(status.reportUrl).toBe(
    'https://x.test/user/reports/reports-page?type=SUITE&parentId=17&id=555&projectId=7',
  );
  expect(calls.some((c) => c.url.includes('/exec/report'))).toBe(false);
});

test('getRun reports a run with no report rows yet as queued', async () => {
  const fetchImpl = (async (url: string) => {
    if (url.includes('/pm/auth/me')) return { ok: true, status: 200, text: async () => JSON.stringify({ userDetails: { id: CALLER_ID } }) };
    if (url.includes('/pm/projectuserrole')) return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ projectId: PROJECT_ID, roleId: 2 }] }) };
    if (url.includes('/exec/execution/search')) return { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) };
    if (url.includes('/exec/report/555/7')) return { ok: true, status: 200, text: async () => JSON.stringify([]) };
    return { ok: false, status: 404, text: async () => '{}' };
  }) as unknown as typeof fetch;
  const adapter = new SimplifyQaAdapter(
    { baseUrl: 'https://x.test', token: 't', projectId: PROJECT_ID } as any,
    { fetchImpl, FormDataImpl: FormData },
  );

  await expect(adapter.getRun('555')).resolves.toEqual({ runId: '555', state: 'queued' });
});

test('listRecentRuns tallies a SUITE history row and links each run\'s report', async () => {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = (init.method ?? 'GET').toUpperCase();
    if (init.body !== undefined) calls.push({ method, url, body: JSON.parse(String(init.body)) });
    if (url.includes('/pm/auth/me')) return { ok: true, status: 200, text: async () => JSON.stringify({ userDetails: { id: CALLER_ID } }) };
    if (url.includes('/pm/projectuserrole')) return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ projectId: PROJECT_ID, roleId: 2 }] }) };
    if (url.includes('/exec/execution/search')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [
        {
          id: 900, status: 'FAILED', executionTypeId: 17,
          startTime: '2026-02-01T09:00:00Z', endTime: '2026-02-01T09:07:00Z',
          executionItems: [
            { status: 'PASSED' }, { status: 'FAILED' }, { status: 'SKIPPED' },
            { status: 'NOTEXECUTED' }, { status: 'PASSED' },
          ],
        },
        { id: 880, status: 'PASSED', executionTypeId: 17 },
      ] }) };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  }) as unknown as typeof fetch;
  const adapter = new SimplifyQaAdapter(
    { baseUrl: 'https://x.test', token: 't', projectId: PROJECT_ID } as any,
    { fetchImpl, FormDataImpl: FormData },
  );

  const rows = await adapter.listRecentRuns('SUITE', 'SUI-17', 5);

  const search = calls.find((c) => c.url.includes('/exec/execution/search'))!;
  expect(search.body.limit).toBe(5);
  expect(search.body.searchFields).toEqual(expect.arrayContaining([
    { column: 'id', sort: 'dsc' },
    { column: 'projectId', value: PROJECT_ID, regEx: false },
    { column: 'childExecution', value: false },             // standalone runs only
    { column: 'parentExecutionCopy', value: true, operator: 'nor' },
    { column: 'type', value: 'SUITE', regEx: false },
    { column: 'executionTypeId', value: 17, regEx: false },
  ]));

  expect(rows).toEqual([
    {
      runId: '900',
      state: 'failed',
      startedAt: '2026-02-01T09:00:00Z',
      endedAt: '2026-02-01T09:07:00Z',
      reportUrl: 'https://x.test/user/reports/reports-page?type=SUITE&parentId=17&id=900&projectId=7',
      totalTestCases: 5,
      passed: 2,
      failed: 1,
      skipped: 1,
      notExecuted: 1,
    },
    {
      runId: '880',
      state: 'passed',
      reportUrl: 'https://x.test/user/reports/reports-page?type=SUITE&parentId=17&id=880&projectId=7',
      totalTestCases: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      notExecuted: 0,
    },
  ]);
});

test('getLatestTestcaseRun returns the newest id and null when there is none', async () => {
  const make = (rows: any[]) => {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (init.body !== undefined) calls.push({ method: (init.method ?? 'GET').toUpperCase(), url, body: JSON.parse(String(init.body)) });
      if (url.includes('/pm/auth/me')) return { ok: true, status: 200, text: async () => JSON.stringify({ userDetails: { id: CALLER_ID } }) };
      if (url.includes('/pm/projectuserrole')) return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ projectId: PROJECT_ID, roleId: 2 }] }) };
      if (url.includes('/exec/execution/search')) return { ok: true, status: 200, text: async () => JSON.stringify({ data: rows }) };
      return { ok: false, status: 404, text: async () => '{}' };
    }) as unknown as typeof fetch;
    const adapter = new SimplifyQaAdapter(
      { baseUrl: 'https://x.test', token: 't', projectId: PROJECT_ID } as any,
      { fetchImpl, FormDataImpl: FormData },
    );
    return { adapter, calls };
  };

  const hit = make([{ id: 771 }]);
  await expect(hit.adapter.getLatestTestcaseRun('TC_42')).resolves.toBe('771');
  const body = hit.calls.find((c) => c.url.includes('/exec/execution/search'))!.body;
  expect(body.limit).toBe(1);
  expect(body.searchFields).toEqual(expect.arrayContaining([
    { column: 'type', value: 'TESTCASE', regEx: false },
    { column: 'executionTypeId', value: 42, regEx: false },
  ]));

  const miss = make([]);
  await expect(miss.adapter.getLatestTestcaseRun('TC_42')).resolves.toBeNull();
});
