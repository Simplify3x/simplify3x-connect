import { SimplifyQaAdapter } from './adapter.js';

/**
 * PL-68: add 2 stacks, auto-distribute TC-39/44/46/47 across them, run on the cloud — driven through the REAL
 * configurePlanStacks / startExecutionPlanRun against a stateful fake backend.
 */
const ME = 5;
const entry = (tc: number, over: Record<string, unknown> = {}) => ({
  testcaseId: tc, code: `TC-${tc}`, executionType: 'AUTOMATION', expAssignedTo: ME, status: 'NOTEXECUTED', tcType: 'WEB',
  tcVersionId: 1, stepId: tc + 1000, tcName: `case ${tc}`, executionPlatform: { id: 'chrome', name: 'Chrome', technologyType: 'WEB', type: 'NONE' },
  ...over,
});
const ENTRIES = [39, 44, 46, 47].map((t) => entry(t));

function backend(opts: { cloud?: Array<{ online: boolean; cloudType?: string }>; entries?: any[]; me?: string | undefined; agentUp?: boolean } = {}) {
  let flow: any;
  const writes: Array<{ m: string; path: string; body: any }> = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: 'http://backend' };
  a.requireProjectId = () => 19;
  a.readOwnPlan = async () => ({ id: 68, code: 'PL-68', executionId: 900, releaseId: null, iterationId: null });
  a.listPlanEntries = async () => opts.entries ?? ENTRIES;
  a.listCloudRunners = async () => opts.cloud ?? [];
  a.ensureUserId = async () => ('me' in opts ? opts.me : String(ME));
  a.probeLocalAgentDetailed = async () => ({ up: opts.agentUp ?? true, url: 'http://localhost:4040' });
  a.resolveLocalAgentId = async () => 'agent-local-1';
  a.http = {
    getJson: async (path: string) => {
      if (path === '/tm/executionFlow/EP/68/STACK') { if (!flow) throw new Error('404'); return { data: flow }; }
      throw new Error(`unexpected GET ${path}`);
    },
    postJson: async (path: string, body: any) => {
      if (path === '/tm/executionFlow') { flow = { ...body, id: 77 }; writes.push({ m: 'POST', path, body }); return { data: flow }; }
      if (path === '/exec/execution/search') {
        return { data: [{ id: 900, code: 'EX-900', executionItems: (opts.entries ?? ENTRIES).map((e: any) => ({
          id: e.testcaseId, assignTo: e.expAssignedTo, versionId: e.tcVersionId, stepId: e.stepId, technologyType: 'WEB' })) }] };
      }
      if (path === '/exec/execution') { writes.push({ m: 'POST', path, body }); return { data: { id: '901' } }; }
      throw new Error(`unexpected POST ${path}`);
    },
    putJson: async (path: string, body: any) => {
      writes.push({ m: 'PUT', path, body });
      if (path === '/tm/executionFlow') flow = { ...body };
      return {};
    },
  };
  return { a, writes, flow: () => flow };
}
const runBody = (w: Array<{ path: string; body: any }>) => w.find((x) => x.path === '/exec/execution')?.body;

describe('stack setup: 2 stacks, auto-distribution', () => {
  test('TC-39/44/46/47 are spread round-robin over two CLOUD stacks and the saved canvas is read back', async () => {
    const { a, writes } = backend({ cloud: [{ online: true, cloudType: 'VM' }] });
    const res = await a.configurePlanStacks('PL-68', { count: 2 });
    expect(res.created).toBe(true);
    expect(res.stacks.map((s: any) => [s.name, s.mode, s.codes])).toEqual([
      ['Stack 1', 'CLOUD', ['TC-39', 'TC-46']], ['Stack 2', 'CLOUD', ['TC-44', 'TC-47']],
    ]);
    expect(res.cloudAvailable).toBe(true);
    const saved = writes[0]!.body;
    expect([saved.parentType, saved.flowType, saved.parentId, saved.projectId]).toEqual(['EP', 'STACK', 68, 19]);
    expect(saved.stacks[0].items[0].assignTo).toBe(ME);   // the backend runs a stack only for the user its items are assigned to
  });

  test('saving again updates the same canvas (PUT with its id), it does not add a second one', async () => {
    const { a, writes } = backend();
    await a.configurePlanStacks('PL-68', { count: 2 });
    const again = await a.configurePlanStacks('PL-68', { count: 2 });
    expect(again.created).toBe(false);
    expect(writes.map((w) => w.m)).toEqual(['POST', 'PUT']);
    expect(writes[1]!.body.id).toBe(77);
  });

  test('with no cloud machine configured the result says CLOUD stacks cannot run yet', async () => {
    const { a } = backend({ cloud: [] });
    expect((await a.configurePlanStacks('PL-68', { count: 2 })).cloudAvailable).toBe(false);
    expect((await backend({ cloud: [] }).a.configurePlanStacks('PL-68', { count: 2, mode: 'LOCAL' })).cloudAvailable).toBeUndefined();
  });
});

describe('running the plan', () => {
  test('stack run: sent as the UI sends it — mode STACK, no items on the wire, cloudType from the project, SERIAL', async () => {
    const { a, writes } = backend({ cloud: [{ online: true, cloudType: 'AZURE' }] });
    await a.configurePlanStacks('PL-68', { count: 2 });
    const ref = await a.startExecutionPlanRun('PL-68', { mode: 'stack' });
    const body = runBody(writes);
    expect(ref.runId).toBe('901');
    expect(ref.started).toEqual(['TC-39', 'TC-44', 'TC-46', 'TC-47']);
    expect([body.type, body.mode, body.executionStyle, body.cloudType, body.agentId]).toEqual(['EXECUTIONPLAN', 'STACK', 'SERIAL', 'AZURE', null]);
    expect(body.executionItems).toEqual([]);
  });

  test('stack run on LOCAL stacks needs no cloud machine; the live local agent is pushed (cloudType NONE)', async () => {
    const { a, writes } = backend({ cloud: [] });
    await a.configurePlanStacks('PL-68', { count: 2, mode: 'LOCAL' });
    await a.startExecutionPlanRun('PL-68', { mode: 'stack' });
    const body = runBody(writes);
    expect([body.mode, body.cloudType, body.agentId]).toEqual(['STACK', 'NONE', 'agent-local-1']);
  });

  test('stack run with a CLOUD stack and no cloud machine is refused before anything is written, and says why', async () => {
    const { a, writes } = backend({ cloud: [] });
    await a.configurePlanStacks('PL-68', { count: 2 });
    writes.length = 0;
    await expect(a.startExecutionPlanRun('PL-68', { mode: 'stack' })).rejects.toThrow(/CLOUD stack\(s\).*no cloud machine configured.*stackMode:"local"/s);
    expect(writes).toEqual([]);
  });

  test('stack run when no stack test case is assigned to the person running it is refused (the backend would run nothing)', async () => {
    const { a, writes } = backend({ cloud: [{ online: true }], me: '99' });
    await a.configurePlanStacks('PL-68', { count: 2 });
    writes.length = 0;
    await expect(a.startExecutionPlanRun('PL-68', { mode: 'stack' })).rejects.toThrow(/assigned to you.*execute nothing/s);
    expect(writes).toEqual([]);
  });

  test('stack run with no saved stack setup points at stack_setup', async () => {
    await expect(backend().a.startExecutionPlanRun('PL-68', { mode: 'stack' })).rejects.toThrow(/stack_setup/);
  });

  test('cloud run needs a configured cloud machine; with one it asks for that machine type', async () => {
    await expect(backend({ cloud: [] }).a.startExecutionPlanRun('PL-68', { mode: 'cloud' })).rejects.toThrow(/No cloud machine/);
    const { a, writes } = backend({ cloud: [{ online: true, cloudType: 'KUBERNETES' }] });
    await a.startExecutionPlanRun('PL-68', { mode: 'cloud' });
    const body = runBody(writes);
    expect([body.mode, body.cloudType, body.agentId, body.executionItems.length]).toEqual(['CLOUD', 'KUBERNETES', null, 4]);
  });

  test('remote run needs the other machine\'s agent id, and is sent as REMOTE (not as a cloud run)', async () => {
    await expect(backend().a.startExecutionPlanRun('PL-68', { mode: 'remote' })).rejects.toThrow(/needs agentId/);
    const { a, writes } = backend();
    await a.startExecutionPlanRun('PL-68', { mode: 'remote', agentId: 'agent-9' });
    const body = runBody(writes);
    expect([body.mode, body.agentId, body.cloudType]).toEqual(['REMOTE', 'agent-9', 'NONE']);
  });

  test('local run is unchanged', async () => {
    const { a, writes } = backend();
    await a.startExecutionPlanRun('PL-68', {});
    const body = runBody(writes);
    expect([body.mode, body.agentId, body.cloudType, body.executionItems.length]).toEqual(['LOCAL', 'agent-local-1', 'NONE', 4]);
  });
});
