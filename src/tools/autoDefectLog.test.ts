import { registerSuiteManageTools } from './suiteManage.tools.js';
import { registerExecutionPlanTools } from './executionPlan.tools.js';
import { SimplifyQaAdapter } from '../adapters/simplifyqa/adapter.js';

/**
 * DE-2378: suite / execution plan auto defect logging must tell the user to enable the project's ADMIN
 * switch instead of silently saving a flag that never logs anything — and must work once it is on.
 */
type H = (a: any) => Promise<any>;
function tools(adminEnabled: boolean | undefined, autoDefectLogOn = false) {
  const handlers = new Map<string, H>();
  const server: any = { registerTool: (n: string, _c: unknown, h: H) => { handlers.set(n, h); } };
  const calls: string[] = [];
  const adapter: any = {
    autoDefectLogStatus: async () => (adminEnabled === undefined ? undefined : { adminEnabled }),
    suiteDeletePreview: async () => ({}), deleteSuite: async () => undefined,
    updateSuite: async () => { calls.push('updateSuite'); },
    updateSuiteSettings: async (_id: string, s: any) => { calls.push(`updateSuiteSettings:${JSON.stringify(s)}`); },
    getSuiteSettings: async () => ({ id: '28', code: 'SU-28', autoReExecCount: 0, autoDefectLog: autoDefectLogOn, newBrowserSession: false, terminateOnFailure: false }),
    createExecutionPlan: async () => { calls.push('createPlan'); return { id: '5', code: 'EP-5' }; },
    updateExecutionPlan: async (_id: string, f: any) => { calls.push(`updatePlan:${JSON.stringify(f)}`); },
    executionPlanDeletePreview: async () => ({}), deleteExecutionPlan: async () => undefined, addPlanEntries: async () => ({}),
    planEntriesRemovePreview: async () => ({}), removePlanEntries: async () => ({}), startExecutionPlanRun: async () => ({}),
  };
  registerSuiteManageTools(server, { getAdapter: () => adapter });
  registerExecutionPlanTools(server, { getAdapter: () => adapter });
  return { suite: handlers.get('suite_manage')!, plan: handlers.get('execution_plan')!, calls };
}
const text = (r: any) => String(r.content?.[0]?.text ?? '');
const EP = { name: 'p', plannedStartDate: '2026-01-01', plannedEndDate: '2026-01-02', environment: 'general' };

describe('auto defect logging — admin switch off', () => {
  test('suite: enabling it is refused with the admin instruction and nothing is written', async () => {
    const t = tools(false);
    const r = await t.suite({ action: 'update', suiteId: 'SU-28', settings: { autoDefectLog: true } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not enabled for this project.*admin/is);
    expect(t.calls).toEqual([]);
  });

  test('execution plan: create and update with autoDefectLog:true are refused and nothing is written', async () => {
    const t = tools(false);
    const c = await t.plan({ action: 'create', ...EP, autoDefectLog: true });
    const u = await t.plan({ action: 'update', planId: 'EP-5', autoDefectLog: true });
    expect([c.isError, u.isError]).toEqual([true, true]);
    expect(text(c)).toMatch(/Auto Defect Logging/);
    expect(t.calls).toEqual([]);
  });

  test('turning it OFF, or changing other settings, is never blocked', async () => {
    const t = tools(false);
    expect((await t.suite({ action: 'update', suiteId: 'SU-28', settings: { autoDefectLog: false } })).isError).toBeFalsy();
    expect((await t.plan({ action: 'update', planId: 'EP-5', autoDefectLog: false, name: 'x' })).isError).toBeFalsy();
    expect((await t.plan({ action: 'create', ...EP })).isError).toBeFalsy();
    expect(t.calls).toHaveLength(3);
  });

  test('suite get: a flag that is on but cannot log says why', async () => {
    const r = await tools(false, true).suite({ action: 'get', suiteId: 'SU-28' });
    expect(text(r)).toMatch(/No defect will be logged.*admin/is);
    expect(text(await tools(true, true).suite({ action: 'get', suiteId: 'SU-28' }))).not.toMatch(/No defect will be logged/);
  });
});

describe('auto defect logging — admin switch on (or unreadable)', () => {
  test.each([true, undefined])('suite and plan save autoDefectLog:true when the admin state is %s', async (admin) => {
    const t = tools(admin);
    expect((await t.suite({ action: 'update', suiteId: 'SU-28', settings: { autoDefectLog: true } })).isError).toBeFalsy();
    expect((await t.plan({ action: 'update', planId: 'EP-5', autoDefectLog: true })).isError).toBeFalsy();
    expect(t.calls).toEqual(['updateSuiteSettings:{"autoDefectLog":true}', 'updatePlan:{"autoDefectLog":true}']);
  });
});

describe('autoDefectLogStatus (adapter)', () => {
  const adapterWith = (project: any) => {
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.requireProjectId = () => 19;
    a.http = { getJson: async () => { if (project instanceof Error) throw project; return { data: project }; } };
    return a;
  };
  test('reads generalSettings.defectManagement.autoDefectFlag; unreadable → undefined', async () => {
    expect(await adapterWith({ generalSettings: { defectManagement: { autoDefectFlag: true } } }).autoDefectLogStatus()).toEqual({ adminEnabled: true });
    expect(await adapterWith({ generalSettings: { defectManagement: { autoDefectFlag: false } } }).autoDefectLogStatus()).toEqual({ adminEnabled: false });
    expect(await adapterWith({}).autoDefectLogStatus()).toEqual({ adminEnabled: false });
    expect(await adapterWith(new Error('403')).autoDefectLogStatus()).toBeUndefined();
  });
});
