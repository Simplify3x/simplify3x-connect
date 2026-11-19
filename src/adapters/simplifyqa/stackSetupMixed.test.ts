import { randomUUID } from 'node:crypto';
import { SimplifyQaAdapter } from './adapter.js';
import { distributeCases, pickBrowser, resolveStacks } from './stackSetup.js';

/**
 * DE-2359: "configure the 1st stack as local, the 2nd as cloud and the 3rd as remote, and put the test cases where I say" —
 * through the REAL configurePlanStacks / configureSuiteStacks against a fake backend that enforces the REAL executionFlow
 * validator (test-management execution-flow.validation.js): `viewMode` must be 'grid' | 'canvas' (the MCP used to send `false`, which
 * the backend rejects), stack `mode` LOCAL | REMOTE | CLOUD, an update needs the flow's uuid.
 */
const ME = 5;
const entry = (tc: number, over: Record<string, unknown> = {}) => ({
  testcaseId: tc, code: `TC-${tc}`, executionType: 'AUTOMATION', expAssignedTo: ME, status: 'NOTEXECUTED', tcType: 'WEB',
  tcVersionId: 1, stepId: tc + 1000, tcName: `case ${tc}`, executionPlatform: { id: 'CHROME', name: 'Chrome', technologyType: 'WEB', type: 'NONE' }, ...over,
});
const ENTRIES = [39, 44, 46, 47].map((t) => entry(t));
const MACHINES = [
  { id: 'mach-1', name: 'my-laptop', isThisMachine: true }, { id: 'mach-2', name: 'build-box-2', isThisMachine: false },
];

function validateFlow(body: any, update: boolean): void {
  const bad = (m: string): never => { throw new Error(`400 Validation error: ${m}`); };
  if (!['EP', 'SU'].includes(body.parentType)) bad('parentType');
  if (body.flowType !== 'STACK') bad('flowType');
  if (!['grid', 'canvas'].includes(body.viewMode)) bad('"viewMode" must be one of [grid, canvas]');
  if (update && !/^[0-9a-f-]{36}$/i.test(String(body.id))) bad('"id" must be a valid GUID');
  if (!Array.isArray(body.stacks)) bad('stacks');
  for (const s of body.stacks) {
    if (typeof s.id !== 'string' || typeof s.name !== 'string') bad('stack id/name');
    if (s.mode !== undefined && !['LOCAL', 'REMOTE', 'CLOUD'].includes(s.mode)) bad('stack mode');
    if (s.agentId !== null && s.agentId !== undefined && !['string', 'number'].includes(typeof s.agentId)) bad('stack agentId');
    for (const it of s.items ?? []) if (it.executionType && !['MANUAL', 'AUTOMATION', 'DUO'].includes(it.executionType)) bad('item executionType');
  }
}

function backend(opts: { entries?: any[]; cloud?: boolean; localAgent?: string | null } = {}) {
  let flow: any;
  const writes: Array<{ m: string; body: any }> = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: 'http://backend' };
  a.requireProjectId = () => 19;
  a.readOwnPlan = async () => ({ id: 68, code: 'PL-68', executionId: 900 });
  a.listPlanEntries = async () => opts.entries ?? ENTRIES;
  a.listCloudRunners = async () => (opts.cloud === false ? [] : [{ online: true, cloudType: 'VM' }]);
  a.listLocalAgents = async () => MACHINES;
  a.resolveLocalAgentId = async () => { if (opts.localAgent === null) throw new Error('no agent'); return opts.localAgent ?? 'mach-1'; };
  a.http = {
    getJson: async (path: string) => {
      if (path === '/tm/executionFlow/EP/68/STACK') { if (!flow) throw new Error('404'); return { data: flow }; }
      throw new Error(`unexpected GET ${path}`);
    },
    postJson: async (path: string, body: any) => {
      if (path === '/tm/executionFlow') { validateFlow(body, false); flow = { ...body, id: randomUUID() }; writes.push({ m: 'POST', body }); return { data: flow }; }
      throw new Error(`unexpected POST ${path}`);
    },
    putJson: async (path: string, body: any) => {
      if (path === '/tm/executionFlow') { validateFlow(body, true); flow = { ...body }; writes.push({ m: 'PUT', body }); return { data: flow }; }
      throw new Error(`unexpected PUT ${path}`);
    },
  };
  return { a, writes, flow: () => flow };
}
const shape = (res: any) => res.stacks.map((s: any) => [s.name, s.mode, s.codes]);

describe('mixed platforms: stack 1 local, stack 2 cloud, stack 3 remote', () => {
  test('each stack carries its own platform, browser key and machine, as the UI saves them', async () => {
    const { a, writes } = backend();
    const res = await a.configurePlanStacks('PL-68', {
      stackConfigs: [{ mode: 'local' }, { mode: 'cloud' }, { mode: 'remote', agentId: 'build-box-2', browser: 'firefox' }],
    });
    expect(shape(res)).toEqual([['Stack 1', 'LOCAL', ['TC-39', 'TC-47']], ['Stack 2', 'CLOUD', ['TC-44']], ['Stack 3', 'REMOTE', ['TC-46']]]);
    const [local, cloud, remote] = writes[0]!.body.stacks;
    expect([local.mode, local.agentId, cloud.mode, cloud.agentId, remote.mode, remote.agentId]).toEqual(['LOCAL', 'mach-1', 'CLOUD', null, 'REMOTE', 'mach-2']);
    expect(local.executionPlatform.LOCAL.browser).toMatchObject({ key: 'CHROME', id: 'CHROME', name: 'CHROME' });
    expect(cloud.executionPlatform.CLOUD.browser).toMatchObject({ key: 'CHROME_HEADLESS' });
    expect(remote.executionPlatform.REMOTE.browser).toMatchObject({ key: 'FIREFOX' });
    expect(local.items[0].platform).toEqual([{ name: 'CHROME', id: 'CHROME', technologyType: 'WEB', type: 'NONE' }]);
    expect(cloud.items[0].platform[0].id).toBe('CHROME_HEADLESS');
    expect(res.stacks[2]).toMatchObject({ agentId: 'mach-2', browser: 'FIREFOX' });
  });

  test('the backend validator accepts what is sent (viewMode is "grid"), and an update reuses the flow\'s uuid', async () => {
    const { a, writes } = backend();
    await a.configurePlanStacks('PL-68', { count: 2 });
    expect(writes[0]!.body.viewMode).toBe('grid');
    await a.configurePlanStacks('PL-68', { count: 2 });
    expect(writes.map((w) => w.m)).toEqual(['POST', 'PUT']);
    expect(writes[1]!.body.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test('a LOCAL stack with no registered agent still saves, and says so', async () => {
    const { a } = backend({ localAgent: null });
    const res = await a.configurePlanStacks('PL-68', { stackConfigs: [{ mode: 'local' }, { mode: 'cloud' }] });
    expect(res.stacks[0].agentId).toBeUndefined();
    expect(res.notes?.join(' ')).toMatch(/No local agent is registered/);
  });
});

describe('distribution as the user wants it', () => {
  test('named test cases go to the named stack; the rest follows', async () => {
    const { a } = backend();
    const res = await a.configurePlanStacks('PL-68', {
      stackConfigs: [{ mode: 'local', testCases: ['TC-39', 'tc-44'] }, { mode: 'cloud', testCases: ['46', 'TC-47'] }],
    });
    expect(shape(res)).toEqual([['Stack 1', 'LOCAL', ['TC-39', 'TC-44']], ['Stack 2', 'CLOUD', ['TC-46', 'TC-47']]]);
    expect(res.unassigned).toBeUndefined();
  });

  test('test cases nobody named are reported as not on any stack', async () => {
    const res = await backend().a.configurePlanStacks('PL-68', { stackConfigs: [{ testCases: ['TC-39'] }, { testCases: ['TC-44'] }] });
    expect(res.unassigned).toEqual(['TC-46', 'TC-47']);
  });

  test('append adds a stack: with nothing named everything is re-spread; with test cases named only those move', async () => {
    const spread = backend();
    await spread.a.configurePlanStacks('PL-68', { stackConfigs: [{ mode: 'local' }, { mode: 'cloud' }] });
    const res = await spread.a.configurePlanStacks('PL-68', { append: true, stackConfigs: [{ mode: 'remote', agentId: 'mach-2' }] });
    expect(shape(res)).toEqual([['Stack 1', 'LOCAL', ['TC-39', 'TC-47']], ['Stack 2', 'CLOUD', ['TC-44']], ['Stack 3', 'REMOTE', ['TC-46']]]);
    expect(res.stacks[0].agentId).toBe('mach-1');          // the saved stacks keep their platform

    const named = backend();
    await named.a.configurePlanStacks('PL-68', { stackConfigs: [{ mode: 'local' }, { mode: 'cloud' }] });
    const moved = await named.a.configurePlanStacks('PL-68', { append: true, stackConfigs: [{ mode: 'cloud', testCases: ['TC-47'] }] });
    expect(shape(moved)).toEqual([['Stack 1', 'LOCAL', ['TC-39', 'TC-46']], ['Stack 2', 'CLOUD', ['TC-44']], ['Stack 3', 'CLOUD', ['TC-47']]]);
  });
});

describe('what is refused (nothing is written)', () => {
  const cases: Array<[string, any, RegExp]> = [
    ['a remote stack with no machine', { stackConfigs: [{ mode: 'remote' }] }, /needs agentId/],
    ['an unknown machine', { stackConfigs: [{ mode: 'remote', agentId: 'ghost' }] }, /No machine "ghost".*my-laptop.*build-box-2/s],
    ['a machine on a non-remote stack', { stackConfigs: [{ mode: 'local', agentId: 'mach-2' }] }, /only for a REMOTE stack/],
    ['a test case that is not in the plan', { stackConfigs: [{ testCases: ['TC-99'] }, { testCases: ['TC-39'] }] }, /TC-99 is not a test case of this setup/],
    ['a test case on two stacks', { stackConfigs: [{ testCases: ['TC-39'] }, { testCases: ['TC-39'] }] }, /runs on one stack/],
    ['test cases named for only some stacks', { stackConfigs: [{ testCases: ['TC-39'] }, {}] }, /not for stack 2/],
    ['more stacks than test cases', { count: 5 }, /cannot fill 5 stacks/],
    ['a stack count that disagrees with the configs', { count: 3, stackConfigs: [{}, {}] }, /must match/],
    ['a cloud browser that does not exist', { stackConfigs: [{ mode: 'cloud', browser: 'safari' }] }, /not a browser a CLOUD stack offers.*Chrome Headless/s],
    ['nothing saying how many', {}, /how many stacks/],
  ];
  test.each(cases)('%s', async (_n, input, msg) => {
    const { a, writes } = backend();
    await expect(a.configurePlanStacks('PL-68', input)).rejects.toThrow(msg);
    expect(writes).toEqual([]);
  });

  test('append with no saved setup', async () => {
    await expect(backend().a.configurePlanStacks('PL-68', { append: true, count: 1 })).rejects.toThrow(/no saved stack setup to add to/);
  });
});

describe('pure pieces', () => {
  test('browser names → the UI picker keys (cloud is headless)', () => {
    expect(pickBrowser('chrome', 'LOCAL').key).toBe('CHROME');
    expect(pickBrowser('Chromium', 'REMOTE').key).toBe('CHROME');
    expect(pickBrowser('chrome headless', 'LOCAL').key).toBe('CHROME_HEADLESS');
    expect(pickBrowser('msedge', 'LOCAL').key).toBe('EDGE');
    expect(pickBrowser('webkit', 'LOCAL').key).toBe('SAFARI');
    expect(pickBrowser('firefox', 'CLOUD')).toMatchObject({ key: 'FIREFOX_HEADLESS', name: 'Firefox Headless' });
    expect(pickBrowser(undefined, 'CLOUD').key).toBe('CHROME_HEADLESS');
  });

  test('resolveStacks: configs set the count; a bare count makes identical stacks; remote needs its machine', () => {
    expect(resolveStacks({ count: 2 }).map((s) => s.mode)).toEqual(['CLOUD', 'CLOUD']);
    expect(resolveStacks({ stackConfigs: [{ mode: 'local' }, { mode: 'remote', agentId: 'x' }] }).map((s) => s.mode)).toEqual(['LOCAL', 'REMOTE']);
    expect(() => resolveStacks({ count: 2, mode: 'REMOTE' })).toThrow(/needs its machine/);
  });

  test('distributeCases: round-robin by default', () => {
    const cs = [{ code: 'TC-1', id: '1' }, { code: 'TC-2', id: '2' }, { code: 'TC-3', id: '3' }];
    expect(distributeCases(cs, [{}, {}]).buckets).toEqual([[0, 2], [1]]);
  });
});

describe('running a setup that has a REMOTE stack', () => {
  const runPlan = (stacks: any[]) => {
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.getSuiteStacks = async () => ({ stacks });
    a.listCloudRunners = async () => [];
    a.probeLocalAgentDetailed = async () => { throw new Error('the local agent must not be needed'); };
    return a.suiteStackRunPlan({ id: 28, code: 'SU-28', suiteType: 'AUTOMATION' }, {});
  };
  test('a remote stack with no machine is refused, naming it', async () => {
    await expect(runPlan([{ name: 'Stack 1', mode: 'REMOTE', agentId: null, items: [{}] }])).rejects.toThrow(/REMOTE stack\(s\) with no machine chosen \(Stack 1\)/);
  });
  test('remote-only stacks run without a local agent or a cloud machine', async () => {
    await expect(runPlan([{ name: 'Stack 1', mode: 'REMOTE', agentId: 'mach-2', items: [{}] }])).resolves.toEqual({ agentId: null, cloudType: 'NONE' });
  });
});

describe('a suite takes the same setup', () => {
  test('suite stacks: per-stack platform, named test cases, and the validator\'s viewMode', async () => {
    let flow: any;
    const writes: any[] = [];
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.cfg = { baseUrl: 'http://backend' };
    a.requireProjectId = () => 19;
    a.readOwnSuite = async () => ({ id: 28, code: 'SU-28', suiteType: 'AUTOMATION', testCases: [39, 44, 46].map((t) => ({ testcaseId: t, versionId: `v${t}`, stepId: `s${t}`, seq: t })) });
    a.fetchRawTestcase = async (id: string) => ({ id: Number(id), code: `TC-${id}`, name: `case ${id}`, tcType: 'WEB', versions: [{ id: `v${id}`, name: 'v1.0' }] });
    a.listCloudRunners = async () => [{ online: true, cloudType: 'VM' }];
    a.listLocalAgents = async () => MACHINES;
    a.resolveLocalAgentId = async () => 'mach-1';
    a.http = {
      getJson: async (path: string) => { if (path === '/tm/executionFlow/SU/28/STACK' && flow) return { data: flow }; throw new Error('404'); },
      postJson: async (_p: string, body: any) => { validateFlow(body, false); flow = { ...body, id: randomUUID() }; writes.push(body); return { data: flow }; },
    };
    const res = await a.configureSuiteStacks('SU-28', { stackConfigs: [{ mode: 'cloud', testCases: ['TC-39'] }, { mode: 'remote', agentId: 'build-box-2', testCases: ['TC-44', 'TC-46'] }] });
    expect(shape(res)).toEqual([['Stack 1', 'CLOUD', ['TC-39']], ['Stack 2', 'REMOTE', ['TC-44', 'TC-46']]]);
    expect(writes[0].stacks[1].agentId).toBe('mach-2');
    expect(writes[0].viewMode).toBe('grid');
  });
});
