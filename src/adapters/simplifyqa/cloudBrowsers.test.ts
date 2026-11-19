import { SimplifyQaAdapter } from './adapter.js';
import { registerRunTools } from '../../tools/run.tools.js';
import { registerExecutionPlanTools } from '../../tools/executionPlan.tools.js';

/**
 * DE-2384: running a test case / suite / execution plan (or scheduling one) in the CLOUD must offer — and send — only the UI's cloud
 * browsers: Chrome Headless, Firefox Headless, Edge Headless. The MCP used to ask chrome / firefox / webkit, and sent CHROMIUM_HEADLESS /
 * MSEDGE_HEADLESS / WEBKIT_HEADLESS (none of which exist) or, for a suite, an empty platform.
 */
const HEADLESS = /^(CHROME|FIREFOX|EDGE)_HEADLESS$/;

describe('a cloud TC run sends a real headless browser', () => {
  const build = (browser?: string) => (Object.create(SimplifyQaAdapter.prototype) as any).buildRunPlatform('WEB', 'CLOUD', browser === undefined ? {} : { browser });
  test.each([
    ['chrome', 'CHROME_HEADLESS'], ['chromium', 'CHROME_HEADLESS'], ['firefox', 'FIREFOX_HEADLESS'],
    ['msedge', 'EDGE_HEADLESS'], ['edge', 'EDGE_HEADLESS'], ['Firefox Headless', 'FIREFOX_HEADLESS'],
  ])('"%s" → %s', (given, id) => {
    // the UI binds the picked browser's key into BOTH id and name
    expect(build(given)).toEqual([{ name: id, id, technologyType: 'WEB', type: 'NONE' }]);
  });
  test('no browser → Chrome Headless; one the cloud picker does not offer is refused with the three that exist', () => {
    expect(build()[0].id).toBe('CHROME_HEADLESS');
    expect(() => build('webkit')).toThrow(/not a browser a CLOUD stack offers.*Chrome Headless, Firefox Headless, Edge headless/s);
    expect(() => build('safari')).toThrow(/Chrome Headless/);
  });
  test('a LOCAL run is unchanged', () => {
    expect((Object.create(SimplifyQaAdapter.prototype) as any).buildRunPlatform('WEB', 'LOCAL', { browser: 'firefox' })).toEqual([{ name: 'FIREFOX', id: 'FIREFOX', technologyType: 'WEB', type: 'NONE' }]);
  });
});

describe('a cloud SUITE run', () => {
  const row = (t: number, executionPlatform: Record<string, unknown> = {}) => ({ testcaseId: t, versionId: `v${t}`, stepId: `s${t}`, seq: t, executionPlatform });
  function backend(rows: any[], tcType: Record<number, string> = {}) {
    const writes: Array<{ path: string; body: any }> = [];
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.cfg = { baseUrl: 'http://backend' };
    a.requireProjectId = () => 19;
    a.fetchRawSuite = async () => ({ id: 28, code: 'SU-28', name: 'mcp suit', projectId: 19, suiteType: 'AUTOMATION', testCases: rows });
    a.fetchRawTestcase = async (id: string) => ({ id: Number(id), code: `TC-${id}`, name: `case ${id}`, tcType: tcType[Number(id)] ?? 'WEB', moduleId: 3, versions: [{ id: `v${id}`, name: 'v1.0' }] });
    a.listCloudRunners = async () => [{ online: true, cloudType: 'VM' }];
    a.lookupProjectName = async () => 'Sandbox';
    a.resolveEnvironment = async () => 'general';
    a.assertRunMode = async () => undefined;
    a.runReportUrl = () => 'https://app/report';
    a.http = {
      postJson: async (path: string, body: any) => {
        if (path === '/pm/module/search') return { data: [] };
        if (path === '/exec/execution') { writes.push({ path, body }); return { data: { id: '901' } }; }
        throw new Error(`unexpected POST ${path}`);
      },
    };
    return { a, writes };
  }
  const platforms = (writes: any[]) => writes[0].body.executionItems.map((i: any) => i.platform?.[0]?.id);

  test('a test case freshly added to the suite has no cloud browser: the run is refused with the question to ask, and nothing is created', async () => {
    const { a, writes } = backend([row(39), row(44)]);
    await expect(a.startSuiteRun('SU-28', { mode: 'cloud', environment: 'general' }))
      .rejects.toThrow(/ASK the user which browser.*on the cloud — Chrome Headless, Firefox Headless, Edge Headless.*TC-39, TC-44/s);
    expect(writes).toEqual([]);
  });
  test('the browser asked for goes to EVERY web test case; an API test case is left alone', async () => {
    const { a, writes } = backend([row(39), row(44), row(46)], { 46: 'API' });
    await a.startSuiteRun('SU-28', { mode: 'cloud', environment: 'general', browser: 'firefox' });
    expect(platforms(writes)).toEqual(['FIREFOX_HEADLESS', 'FIREFOX_HEADLESS', 'API']);
    expect(platforms(writes).filter((p: string) => p !== 'API').every((p: string) => HEADLESS.test(p))).toBe(true);   // real UI keys only
  });
  test('a saved headless cloud browser is kept when none is asked for; a saved non-headless one is not trusted', async () => {
    const kept = backend([row(39, { CLOUD: { id: 'EDGE_HEADLESS', name: 'Edge headless', technologyType: 'WEB', type: 'NONE' } })]);
    await kept.a.startSuiteRun('SU-28', { mode: 'cloud', environment: 'general' });
    expect(platforms(kept.writes)).toEqual(['EDGE_HEADLESS']);
    const stale = backend([row(39, { CLOUD: { id: 'CHROME', name: 'Chrome' } })]);
    await expect(stale.a.startSuiteRun('SU-28', { mode: 'cloud', environment: 'general' })).rejects.toThrow(/ASK the user which browser/);
  });
  test('a browser the cloud does not offer is refused', async () => {
    const { a, writes } = backend([row(39)]);
    await expect(a.startSuiteRun('SU-28', { mode: 'cloud', environment: 'general', browser: 'webkit' })).rejects.toThrow(/Chrome Headless/);
    expect(writes).toEqual([]);
  });
});

describe('a cloud EXECUTION PLAN run', () => {
  const entry = (tc: number, id = 'CHROME') => ({
    testcaseId: tc, code: `TC-${tc}`, executionType: 'AUTOMATION', expAssignedTo: 5, status: 'NOTEXECUTED', tcType: 'WEB', tcVersionId: 1,
    stepId: tc + 1000, tcName: `case ${tc}`, executionPlatform: { id, name: id, technologyType: 'WEB', type: 'NONE' },
  });
  function backend(entries: any[]) {
    const writes: Array<{ m: string; path: string; body: any }> = [];
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.cfg = { baseUrl: 'http://backend' };
    a.requireProjectId = () => 19;
    a.readOwnPlan = async () => ({ id: 68, code: 'PL-68', executionId: 900, releaseId: null, iterationId: null });
    a.listPlanEntries = async () => entries;
    a.listCloudRunners = async () => [{ online: true, cloudType: 'VM' }];
    a.ensureUserId = async () => '5';
    a.detectExecutionOS = () => 'WINDOWS';
    a.http = {
      postJson: async (path: string, body: any) => {
        if (path === '/exec/execution/search') return { data: [{ id: 900, code: 'EX-900', executionItems: entries.map((e) => ({ id: e.testcaseId, assignTo: 5, versionId: 1, stepId: e.stepId, technologyType: 'WEB' })) }] };
        if (path === '/exec/execution') { writes.push({ m: 'POST', path, body }); return { data: { id: '901' } }; }
        throw new Error(`unexpected POST ${path}`);
      },
      putJson: async (path: string, body: any) => { writes.push({ m: 'PUT', path, body }); return {}; },
    };
    return { a, writes };
  }
  test('local-style saved browsers are not sent to the cloud: the run asks first and writes nothing', async () => {
    const { a, writes } = backend([entry(39), entry(44)]);
    await expect(a.startExecutionPlanRun('PL-68', { mode: 'cloud' })).rejects.toThrow(/ASK the user which browser.*Chrome Headless, Firefox Headless, Edge Headless.*TC-39, TC-44/s);
    expect(writes).toEqual([]);
  });
  test('with a browser every web test case runs in that headless browser', async () => {
    const { a, writes } = backend([entry(39), entry(44)]);
    await a.startExecutionPlanRun('PL-68', { mode: 'cloud', browser: 'edge' });
    const body = writes.find((w) => w.path === '/exec/execution')!.body;
    expect(body.executionItems.map((i: any) => i.platform[0].id)).toEqual(['EDGE_HEADLESS', 'EDGE_HEADLESS']);
  });
  test('a saved headless browser is kept; a LOCAL plan run is unchanged (it never asks)', async () => {
    const kept = backend([entry(39, 'FIREFOX_HEADLESS')]);
    await kept.a.startExecutionPlanRun('PL-68', { mode: 'cloud' });
    expect(kept.writes.find((w) => w.path === '/exec/execution')!.body.executionItems[0].platform[0].id).toBe('FIREFOX_HEADLESS');
    const local = backend([entry(39)]);
    local.a.probeLocalAgentDetailed = async () => ({ up: true, url: 'x' });
    local.a.resolveLocalAgentId = async () => 'agent-1';
    await local.a.startExecutionPlanRun('PL-68', { mode: 'local' });
    expect(local.writes.find((w) => w.path === '/exec/execution')!.body.executionItems[0].platform[0].id).toBe('CHROME');
  });
});

describe('a cloud SCHEDULE uses the cloud browsers too', () => {
  const START = '2026-11-17T09:00:00.000Z';
  function backend() {
    const posts: any[] = [];
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.cfg = { baseUrl: 'http://backend' };
    a.requireProjectId = () => 19;
    a.fetchRawTestcase = async () => ({ id: 22, code: 'TC-22', projectId: 19, deleted: false, tcType: 'WEB', versions: [{ id: '1', name: 'v1.0' }], versionId: '1' });
    a.http = {
      postJson: async (path: string, body: any) => {
        if (path === '/sh/scheduler/search') return { data: [] };
        if (path === '/sh/scheduler') { posts.push(body); return { data: { id: 13, ...body } }; }
        throw new Error(`unexpected POST ${path}`);
      },
    };
    return { a, posts };
  }
  const base = { scheduledFor: START, timezone: 'UTC' };
  test('cloud → FIREFOX_HEADLESS; local → FIREFOX; cloud with safari is refused before anything is created', async () => {
    const c = backend();
    await c.a.createSchedule({ tcId: 'TC-22' }, { ...base, mode: 'cloud', browser: 'firefox' });
    expect(c.posts[0].platForm).toEqual([{ name: 'FIREFOX_HEADLESS', id: 'FIREFOX_HEADLESS', technologyType: 'WEB', type: 'NONE' }]);
    const l = backend();
    await l.a.createSchedule({ tcId: 'TC-22' }, { ...base, mode: 'local', agentId: 'agent-1', browser: 'firefox' });
    expect(l.posts[0].platForm[0].id).toBe('FIREFOX');
    const bad = backend();
    await expect(bad.a.createSchedule({ tcId: 'TC-22' }, { ...base, mode: 'cloud', browser: 'safari' })).rejects.toThrow(/Chrome Headless/);
    expect(bad.posts).toEqual([]);
  });
});

describe('the tools ask the right question', () => {
  const capture = () => {
    const handlers = new Map<string, (a: any) => Promise<any>>();
    const server: any = { registerTool: (n: string, _c: unknown, h: any) => { handlers.set(n, h); } };
    return { server, get: (n: string) => handlers.get(n)! };
  };
  const text = (r: any) => String(r.content?.[0]?.text ?? '');
  const tc = { id: '42', title: 'Checkout flow', priority: 'high', category: 'automated', tcType: 'WEB', currentVersionId: 'ver-1', versions: [{ id: 'ver-1', name: 'v1.0', isCurrent: true }], steps: [] };
  const args = { tcId: '42', when: 'immediate', mode: 'cloud', releaseId: '', sprintId: '', environment: 'qa' };

  test('tc_run in the cloud asks for Chrome / Firefox / Edge Headless — and never chrome / webkit', async () => {
    const cap = capture();
    registerRunTools(cap.server, { getAdapter: () => ({ getTestCase: async () => tc, startRun: async () => ({ runId: '1' }), cloudBrowserOptions: () => ['Chrome Headless', 'Firefox Headless', 'Edge Headless'] }) as any, getProjectId: () => null });
    const r = await cap.get('tc_run')(args);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/on the cloud — Chrome Headless \/ Firefox Headless \/ Edge Headless/);
    expect(text(r)).not.toMatch(/webkit \//);
  });
  test('tc_run for a provider with no cloud list, and a local run, keep the usual question', async () => {
    const cap = capture();
    registerRunTools(cap.server, { getAdapter: () => ({ getTestCase: async () => tc, startRun: async () => ({ runId: '1' }) }) as any, getProjectId: () => null });
    expect(text(await cap.get('tc_run')(args))).toMatch(/chromium \/ chrome \/ msedge \/ firefox \/ webkit/);
    const local = capture();
    registerRunTools(local.server, { getAdapter: () => ({ getTestCase: async () => tc, startRun: async () => ({ runId: '1' }), cloudBrowserOptions: () => ['Chrome Headless'] }) as any, getProjectId: () => null });
    expect(text(await local.get('tc_run')({ ...args, mode: 'local' }))).toMatch(/chromium \/ chrome \/ msedge \/ firefox \/ webkit/);
  });
  test('execution_plan run passes the browser to the run and shows the ask when it is missing', async () => {
    const cap = capture();
    const seen: any[] = [];
    const adapter: any = {
      createExecutionPlan: 1, updateExecutionPlan: 1, executionPlanDeletePreview: 1, deleteExecutionPlan: 1, addPlanEntries: 1, planEntriesRemovePreview: 1, removePlanEntries: 1,
      startExecutionPlanRun: async (_id: string, o: any) => {
        seen.push(o);
        if (!o.browser) throw new Error('ASK the user which browser to run PL-68 in on the cloud — Chrome Headless, Firefox Headless, Edge Headless');
        return { runId: '9', started: ['TC-39'], skipped: [] };
      },
    };
    registerExecutionPlanTools(cap.server, { getAdapter: () => adapter });
    const asked = await cap.get('execution_plan')({ action: 'run', planId: 'PL-68', mode: 'cloud' });
    expect(asked.isError).toBe(true);
    expect(text(asked)).toMatch(/ASK the user which browser/);
    const ok = await cap.get('execution_plan')({ action: 'run', planId: 'PL-68', mode: 'cloud', browser: 'firefox' });
    expect(ok.isError).toBeFalsy();
    expect(seen[1]).toMatchObject({ mode: 'cloud', browser: 'firefox' });
  });
});
