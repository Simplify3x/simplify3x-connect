import { SimplifyQaAdapter } from './adapter.js';

/**
 * SU-28 ("mcp suit"): set up Stack execution and run it — driven through the REAL configureSuiteStacks /
 * startSuiteRun against a stateful fake backend, with the wire shape the UI's Execute dialog sends for a suite
 * stack run (mode STACK, no items, SERIAL, the live local agent, the project's cloud type).
 */
const ROWS = [39, 44, 46, 47].map((t, i) => ({ testcaseId: t, versionId: `v${t}`, stepId: `s${t}`, seq: i + 1, executionPlatform: {} }));

function backend(opts: { cloud?: Array<{ online: boolean; cloudType?: string }>; agentUp?: boolean; suiteType?: string; rows?: any[] } = {}) {
  let flow: any;
  const writes: Array<{ m: string; path: string; body: any }> = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: 'http://backend' };
  a.requireProjectId = () => 19;
  a.fetchRawSuite = async () => ({ id: 28, code: 'SU-28', name: 'mcp suit', projectId: 19, suiteType: opts.suiteType ?? 'AUTOMATION', testCases: opts.rows ?? ROWS });
  a.fetchRawTestcase = async (id: string) => ({ id: Number(id), code: `TC-${id}`, name: `case ${id}`, tcType: 'WEB', moduleId: 3, versions: [{ id: `v${id}`, name: 'v1.0' }] });
  a.listCloudRunners = async () => opts.cloud ?? [];
  a.probeLocalAgentDetailed = async () => ({ up: opts.agentUp ?? true, url: 'http://localhost:4040' });
  a.resolveLocalAgentId = async () => 'agent-local-1';
  a.lookupProjectName = async () => 'Sandbox';
  a.resolveEnvironment = async () => 'general';
  a.assertRunMode = async () => undefined;
  a.runReportUrl = () => 'https://app/report';
  a.http = {
    getJson: async (path: string) => {
      if (path === '/tm/executionFlow/SU/28/STACK') { if (!flow) throw new Error('404'); return { data: flow }; }
      throw new Error(`unexpected GET ${path}`);
    },
    postJson: async (path: string, body: any) => {
      if (path === '/tm/executionFlow') { flow = { ...body, id: 77 }; writes.push({ m: 'POST', path, body }); return { data: flow }; }
      if (path === '/exec/execution') { writes.push({ m: 'POST', path, body }); return { data: { id: '901' } }; }
      throw new Error(`unexpected POST ${path}`);
    },
    putJson: async (path: string, body: any) => {
      writes.push({ m: 'PUT', path, body });
      if (path === '/tm/executionFlow') flow = { ...body };
      return {};
    },
  };
  return { a, writes };
}
const runBody = (w: Array<{ path: string; body: any }>) => w.find((x) => x.path === '/exec/execution')?.body;

describe('suite stack setup', () => {
  test('the suite\'s test cases are spread round-robin over N stacks, saved against the suite (SU / STACK) and read back', async () => {
    const { a, writes } = backend({ cloud: [{ online: true, cloudType: 'VM' }] });
    const res = await a.configureSuiteStacks('SU-28', { count: 2 });
    expect(res.created).toBe(true);
    expect(res.stacks.map((s: any) => [s.name, s.mode, s.codes])).toEqual([
      ['Stack 1', 'CLOUD', ['TC-39', 'TC-46']], ['Stack 2', 'CLOUD', ['TC-44', 'TC-47']],
    ]);
    const saved = writes[0]!.body;
    expect([saved.parentType, saved.flowType, saved.parentId, saved.projectId]).toEqual(['SU', 'STACK', 28, 19]);
    expect(saved.stacks[0].items[0]).toMatchObject({ id: 39, versionId: 'v39', stepId: 's39', versionName: 'v1.0', type: 'TC' });
  });

  test('saving again updates the same canvas (PUT with its id)', async () => {
    const { a, writes } = backend();
    await a.configureSuiteStacks('SU-28', { count: 2 });
    expect((await a.configureSuiteStacks('SU-28', { count: 2 })).created).toBe(false);
    expect(writes.map((w) => w.m)).toEqual(['POST', 'PUT']);
    expect(writes[1]!.body.id).toBe(77);
  });

  test('more stacks than test cases, a manual suite and an empty suite are each refused with the reason', async () => {
    await expect(backend({ rows: ROWS.slice(0, 2) }).a.configureSuiteStacks('SU-28', { count: 3 })).rejects.toThrow(/cannot fill 3 stacks/);
    await expect(backend({ suiteType: 'MANUAL' }).a.configureSuiteStacks('SU-28', { count: 1 })).rejects.toThrow(/manual suite/);
    await expect(backend({ rows: [] }).a.configureSuiteStacks('SU-28', { count: 1 })).rejects.toThrow(/no saved test cases/);
  });
});

describe('suite stack run', () => {
  test('sent as the UI sends it — mode STACK, no items, SERIAL, project cloud type, type SUITE', async () => {
    const { a, writes } = backend({ cloud: [{ online: true, cloudType: 'AZURE' }] });
    await a.configureSuiteStacks('SU-28', { count: 2 });
    const ref = await a.startSuiteRun('SU-28', { mode: 'stack', environment: 'general' });
    const body = runBody(writes);
    expect(ref.runId).toBe('901');
    expect([body.type, body.mode, body.executionStyle, body.cloudType, body.agentId, body.executionTypeId]).toEqual(['SUITE', 'STACK', 'SERIAL', 'AZURE', null, 28]);
    expect(body.executionItems).toEqual([]);
  });

  test('LOCAL stacks need no cloud machine; the live local agent is sent (cloudType NONE)', async () => {
    const { a, writes } = backend({ cloud: [] });
    await a.configureSuiteStacks('SU-28', { count: 2, mode: 'LOCAL' });
    await a.startSuiteRun('SU-28', { mode: 'stack', environment: 'general' });
    expect([runBody(writes).mode, runBody(writes).cloudType, runBody(writes).agentId]).toEqual(['STACK', 'NONE', 'agent-local-1']);
  });

  test('refused BEFORE anything is created: no saved setup, a CLOUD stack without a cloud machine, local stacks with the agent down', async () => {
    const none = backend();
    await expect(none.a.startSuiteRun('SU-28', { mode: 'stack' })).rejects.toThrow(/stack_setup/);

    const noCloud = backend({ cloud: [] });
    await noCloud.a.configureSuiteStacks('SU-28', { count: 2 });
    noCloud.writes.length = 0;
    await expect(noCloud.a.startSuiteRun('SU-28', { mode: 'stack' })).rejects.toThrow(/CLOUD stack\(s\).*no cloud machine/s);
    expect(noCloud.writes).toEqual([]);

    const down = backend({ agentUp: false });
    await down.a.configureSuiteStacks('SU-28', { count: 2, mode: 'LOCAL' });
    down.writes.length = 0;
    await expect(down.a.startSuiteRun('SU-28', { mode: 'stack' })).rejects.toThrow(/desktop agent.*not reachable/s);
    expect(down.writes).toEqual([]);
  });

  test('a stack with no test case is refused (the backend would skip or fail it)', async () => {
    const { a, writes } = backend({ cloud: [{ online: true }] });
    await a.configureSuiteStacks('SU-28', { count: 2 });
    const flow = await a.getSuiteStacks('SU-28');
    flow.stacks[1].items = [];
    writes.length = 0;
    await expect(a.startSuiteRun('SU-28', { mode: 'stack' })).rejects.toThrow(/at least one test case/);
    expect(writes).toEqual([]);
  });

  test('a normal (non-stack) run is unchanged: items are sent, strategy honoured', async () => {
    const { a, writes } = backend();
    await a.startSuiteRun('SU-28', { mode: 'cloud', strategy: 'parallel', environment: 'general' });
    const body = runBody(writes);
    expect([body.mode, body.executionStyle]).toEqual(['CLOUD', 'PARALLEL']);
    expect(body.executionItems).toHaveLength(4);
  });
});
