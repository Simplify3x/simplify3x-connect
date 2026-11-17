import { SimplifyQaAdapter } from './adapter.js';

/** startSuiteRun — assert the exact wire shape that /exec/execution wants for `type: 'SUITE'`.
 *  Each field below traces to a line in sqa-ui execution-popup-modal.component.ts (SU branch,
 *  621-1105). A single wrong key or wrong casing here 400s the validator, so the assertions
 *  are exhaustive on the fields that differ from the TC payload — top-level `type`, the
 *  `globalConfiguration` block, and each item's `stepId` / `stepCount` / `versionId` / `platform`
 *  coming from the suite row rather than being regenerated. */

type Handler = (url: string, init: RequestInit) => { status?: number; body: string };

function makeAdapter(handler: Handler) {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const { status = 200, body } = handler(url, init);
    return { ok: status < 300, status, text: async () => body };
  }) as unknown as typeof fetch;
  return new SimplifyQaAdapter(
    { baseUrl: 'https://x.test', token: 't', projectId: 7 } as any,
    { fetchImpl, FormDataImpl: FormData },
  );
}

const RAW_TC = {
  id: 101, name: 'Login OK', code: 'TC_101', projectId: 7, moduleId: 3, userstoryId: 0,
  tcType: 'WEB', executionType: 'AUTOMATION', description: 'Login flow', prerequisite: '',
  tags: [7, 9],
  versions: [{ id: 'v-uuid-1', name: 'v1.0' }, { id: 'v-uuid-2', name: 'v2.0' }],
};

const RAW_SUITE = {
  id: 17, name: 'Login regression', code: 'SUI-17',
  suiteType: 'AUTOMATION',
  executionType: 'LOCAL',              // suite-doc mode; overridden by opts.mode in these tests
  mailersList: { to: ['qa@example.com'] },
  agentId: 'suite-remote-agent',       // used when mode=REMOTE and caller doesn't override
  globalConfiguration: {
    TERMINATE_ON_FAIL: false, NEW_BROWSER_SESSION: false,
    RE_EXECUTION_COUNT: 2, RE_EXECUTION_TYPE: 'AFTER_TESTCASE',
    MINIMUM_CONTAINER_COUNT: 1, MAXIMUM_CONTAINER_COUNT: 5,
  },
  testCases: [
    {
      testcaseId: 101, versionId: 'v-uuid-2', stepId: 'sr-step-abc123', seq: 1,
      executionPlatform: {
        CLOUD: { name: 'CHROME_HEADLESS', id: 'CHROME_HEADLESS', technologyType: 'WEB', type: 'NONE' },
        LOCAL: { name: 'CHROME', id: 'CHROME', technologyType: 'WEB', type: 'NONE' },
      },
    },
  ],
};

function pipeline(rawSuite: any, rawTc: any, captureExec: (body: any) => void): Handler {
  return (url, init) => {
    // Project-access gate: GET /pm/auth/me → GET /pm/projectuserrole runs before any project-scoped call.
    if (url.includes('/pm/auth/me')) return { body: JSON.stringify({ userDetails: { id: 21, username: 'qa' } }) };
    if (url.includes('/pm/projectuserrole')) {
      return { body: JSON.stringify({ data: [{ projectId: 7, roleId: 2 }] }) };
    }
    if (url.includes('/tm/suites/17')) return { body: JSON.stringify({ data: [rawSuite] }) };
    if (url.includes('/tm/testcase/getById/101')) return { body: JSON.stringify({ data: rawTc }) };
    if (url.includes('/pm/project/search')) return { body: JSON.stringify({ data: [{ id: 7, name: 'Proj Seven' }] }) };
    if (url.includes('/pm/fields/8')) return { body: JSON.stringify([{ key: 'general' }]) };
    if (url.includes('/pm/module/search')) return { body: JSON.stringify({ data: [{ id: 3, name: 'Auth' }] }) };
    if (init.method === 'POST' && url.endsWith('/exec/execution')) {
      captureExec(JSON.parse(String(init.body)));
      return { body: JSON.stringify({ data: { id: 555 } }) };
    }
    throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
  };
}

test('startSuiteRun sends type:SUITE plus the full globalConfiguration block', async () => {
  let capturedExec: any = null;
  const adapter = makeAdapter(pipeline(RAW_SUITE, RAW_TC, (b) => { capturedExec = b; }));

  const ref = await adapter.startRun(
    { suiteId: 'SUI-17' },
    { mode: 'cloud', environment: 'general' },
  );

  expect(ref.runId).toBe('555');
  expect(capturedExec.type).toBe('SUITE');
  expect(capturedExec.executionType).toBe('AUTOMATION');            // = suite.suiteType (NOT tc.executionType)
  expect(capturedExec.mode).toBe('CLOUD');                          // caller override
  expect(capturedExec.executionTypeId).toBe(17);
  expect(capturedExec.executionTypeName).toBe('Login regression');
  expect(capturedExec.executionTypeCode).toBe('SUI-17');
  expect(capturedExec.mailersList).toEqual({ to: ['qa@example.com'] });
  expect(capturedExec.cloudType).toBe('VM');
  expect(capturedExec.globalConfiguration).toEqual({
    TERMINATE_ON_FAIL: false,
    NEW_BROWSER_SESSION: false,
    RE_EXECUTION_COUNT: 2,
    RE_EXECUTION_TYPE: 'AFTER_TESTCASE',
    MINIMUM_CONTAINER_COUNT: 1,
    MAXIMUM_CONTAINER_COUNT: 5,
  });
  expect(capturedExec.iterationsSelected).toEqual([]);              // backend fills, we must NOT
});

test('startSuiteRun copies stepId + versionId + per-mode platform from the suite row (never random)', async () => {
  let capturedExec: any = null;
  const adapter = makeAdapter(pipeline(RAW_SUITE, RAW_TC, (b) => { capturedExec = b; }));

  await adapter.startRun(
    { suiteId: 'SUI-17' },
    { mode: 'cloud', environment: 'general' },
  );

  expect(capturedExec.executionItems).toHaveLength(1);
  const item = capturedExec.executionItems[0];
  expect(item.type).toBe('TC');                                     // items are ALWAYS TC, never SU
  expect(item.stepCount).toBe(-1);                                  // suite items send -1
  expect(item.stepId).toBe('sr-step-abc123');                       // exact suite-row value
  expect(item.versionId).toBe('v-uuid-2');
  expect(item.versionName).toBe('v2.0');
  expect(item.seq).toBe(1);
  expect(item.platform).toEqual([
    { name: 'CHROME_HEADLESS', id: 'CHROME_HEADLESS', technologyType: 'WEB', type: 'NONE' },
  ]);
  expect(item.moduleName).toBe('Auth');
  expect(item.tags).toEqual([7, 9]);
});

test('startSuiteRun maps terminateOnFailure + maxConcurrent to the globalConfiguration keys', async () => {
  let capturedExec: any = null;
  const adapter = makeAdapter(pipeline(RAW_SUITE, RAW_TC, (b) => { capturedExec = b; }));

  await adapter.startRun(
    { suiteId: 'SUI-17' },
    { mode: 'cloud', environment: 'general', terminateOnFailure: true, maxConcurrent: 12, strategy: 'parallel' },
  );

  expect(capturedExec.executionStyle).toBe('PARALLEL');
  expect(capturedExec.globalConfiguration.TERMINATE_ON_FAIL).toBe(true);
  expect(capturedExec.globalConfiguration.MAXIMUM_CONTAINER_COUNT).toBe(12);
});

test('startSuiteRun promotes cloudType to SQA and pins cloudAgentId when nothing else pins an agent', async () => {
  const suiteWithCloudAgent = { ...RAW_SUITE, agentId: '', cloudAgentId: 'cloud-agent-77' };
  let capturedExec: any = null;
  const adapter = makeAdapter(pipeline(suiteWithCloudAgent, RAW_TC, (b) => { capturedExec = b; }));

  await adapter.startRun(
    { suiteId: 'SUI-17' },
    { mode: 'cloud', environment: 'general' },
  );

  expect(capturedExec.agentId).toBe('cloud-agent-77');
  expect(capturedExec.cloudType).toBe('SQA');
});

test('startSuiteRun refuses when every member TC is missing or deleted', async () => {
  const handler: Handler = (url) => {
    // Project-access gate — see pipeline() above.
    if (url.includes('/pm/auth/me')) return { body: JSON.stringify({ userDetails: { id: 21, username: 'qa' } }) };
    if (url.includes('/pm/projectuserrole')) {
      return { body: JSON.stringify({ data: [{ projectId: 7, roleId: 2 }] }) };
    }
    if (url.includes('/tm/suites/17')) return { body: JSON.stringify({ data: [RAW_SUITE] }) };
    if (url.includes('/tm/testcase/getById/101')) return { body: JSON.stringify({ data: {} }) };  // TC not found
    if (url.includes('/pm/project/search')) return { body: JSON.stringify({ data: [{ id: 7, name: 'Proj Seven' }] }) };
    if (url.includes('/pm/fields/8')) return { body: JSON.stringify([{ key: 'general' }]) };
    throw new Error(`unexpected ${url}`);
  };
  const adapter = makeAdapter(handler);
  await expect(
    adapter.startRun({ suiteId: 'SUI-17' }, { mode: 'cloud', environment: 'general' }),
  ).rejects.toThrow(/no runnable test cases/);
});
