import { autoDefectLogRunNote } from './autoDefectLog.js';
import { registerExecutionPlanTools } from './executionPlan.tools.js';
import { registerRunTools } from './run.tools.js';
import { SimplifyQaAdapter } from '../adapters/simplifyqa/adapter.js';

/**
 * DE-2378 (reopened): a suite / execution-plan run must say whether a failed step will log a defect — and if not, WHY (the
 * project's admin switch is off, the admin has not set the assignee / priority / state, or the suite/plan's own flag is off) and the
 * exact call that turns it on. The backend skips the defect silently in every one of those cases.
 */
const status = (adminEnabled: boolean, configMissing: string[] = []) => async () => ({ adminEnabled, configMissing });
const probe = (flag: boolean | undefined, st: (() => Promise<any>) | undefined) => ({ autoDefectLogOf: async () => flag, autoDefectLogStatus: st });

describe('autoDefectLogRunNote', () => {
  test('flag on + admin off → says no defect will be logged and what the admin must do', async () => {
    const n = await autoDefectLogRunNote(probe(true, status(false)), 'suite', 'SU-28');
    expect(n).toMatch(/on for this suite.*admin switch is off.*will NOT log defects.*Ask a project admin/s);
  });
  test('flag on + admin on but assignee / priority / state not set → names what is missing', async () => {
    const n = await autoDefectLogRunNote(probe(true, status(true, ['assignee', 'state'])), 'plan', 'PL-68');
    expect(n).toMatch(/has not set the assignee \/ state.*may not be created/);
  });
  test('flag off + admin on → says it is off and gives the exact call for a suite and for a plan', async () => {
    expect(await autoDefectLogRunNote(probe(false, status(true)), 'suite', 'SU-28')).toMatch(/OFF for this suite.*suite_manage .*autoDefectLog:true/s);
    expect(await autoDefectLogRunNote(probe(false, status(true)), 'plan', 'PL-68')).toMatch(/OFF for this execution plan.*execution_plan .*autoDefectLog:true/s);
  });
  test('everything on and configured, flag off with admin off, or anything unreadable → nothing is added', async () => {
    expect(await autoDefectLogRunNote(probe(true, status(true)), 'suite', 'SU-28')).toBeUndefined();
    expect(await autoDefectLogRunNote(probe(false, status(false)), 'suite', 'SU-28')).toBeUndefined();
    expect(await autoDefectLogRunNote(probe(undefined, status(true)), 'suite', 'SU-28')).toBeUndefined();
    expect(await autoDefectLogRunNote(probe(true, async () => undefined), 'suite', 'SU-28')).toBeUndefined();
    expect(await autoDefectLogRunNote({}, 'suite', 'SU-28')).toBeUndefined();
    expect(await autoDefectLogRunNote(probe(true, async () => { throw new Error('boom'); }), 'suite', 'SU-28')).toBeUndefined();
  });
});

describe('the adapter reads both halves', () => {
  const adapterWith = (project: any, rows: Record<string, any> = {}) => {
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.requireProjectId = () => 19;
    a.readOwnSuite = async () => rows['suite'] ?? (() => { throw new Error('nope'); })();
    a.readOwnPlan = async () => rows['plan'] ?? (() => { throw new Error('nope'); })();
    a.http = { getJson: async () => ({ data: project }) };
    return a;
  };
  test('admin switch + which of assignee / priority / state the admin has not set', async () => {
    const full = { generalSettings: { defectManagement: { autoDefectFlag: true, configAutologgedDefect: { assigneeId: 5, priority: 'High', state: 'New' } } } };
    expect(await adapterWith(full).autoDefectLogStatus()).toEqual({ adminEnabled: true, configMissing: [] });
    const partial = { generalSettings: { defectManagement: { autoDefectFlag: true, configAutologgedDefect: { assigneeId: null, priority: '', status: 'Open' } } } };
    expect(await adapterWith(partial).autoDefectLogStatus()).toEqual({ adminEnabled: true, configMissing: ['assignee', 'priority'] });
  });
  test('the suite\'s / plan\'s own flag; unreadable → undefined', async () => {
    const a = adapterWith({}, { suite: { autoDefectLog: true }, plan: { autoDefectLog: false } });
    expect(await a.autoDefectLogOf('suite', 'SU-28')).toBe(true);
    expect(await a.autoDefectLogOf('plan', 'PL-68')).toBe(false);
    expect(await adapterWith({}).autoDefectLogOf('suite', 'SU-28')).toBeUndefined();
  });
  test('a suite settings save carries the two fields the validator requires even when the suite lacks them', async () => {
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    const sent: any[] = [];
    a.readOwnSuite = async () => ({ id: 28, suiteType: 'AUTOMATION', projectId: 19 });
    a.productUrlFor = () => 'u';
    a.http = { putMultipart: async (_p: string, _k: string, payload: any) => { sent.push(payload); return {}; } };
    await a.updateSuiteSettings('SU-28', { autoDefectLog: true });
    expect(sent[0]).toMatchObject({ autoDefectLog: true, autoReExecTriggerOn: 'AFTER_SUITE', autoReExecCount: 0 });
  });
});

describe('the run replies carry the note', () => {
  const capture = () => {
    const handlers = new Map<string, (a: any) => Promise<any>>();
    const server: any = { registerTool: (n: string, _c: unknown, h: any) => { handlers.set(n, h); } };
    return { server, get: (n: string) => handlers.get(n)! };
  };
  const text = (r: any) => String(r.content?.[0]?.text ?? '');

  test('execution_plan run: the plan\'s reply ends with why failures will not log defects', async () => {
    const cap = capture();
    const adapter: any = {
      createExecutionPlan: 1, updateExecutionPlan: 1, executionPlanDeletePreview: 1, deleteExecutionPlan: 1, addPlanEntries: 1,
      planEntriesRemovePreview: 1, removePlanEntries: 1,
      startExecutionPlanRun: async () => ({ runId: '901', started: ['TC-39'], skipped: [] }),
      autoDefectLogOf: async () => true, autoDefectLogStatus: status(false),
    };
    registerExecutionPlanTools(cap.server, { getAdapter: () => adapter });
    const r = await cap.get('execution_plan')({ action: 'run', planId: 'PL-68', mode: 'local' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/Started PL-68.*\n.*Track it.*\n⚠️ Auto defect logging is on for this execution plan.*admin switch is off/s);
  });

  test('suite_run: the suite\'s reply says auto defect logging is off and how to turn it on', async () => {
    const cap = capture();
    const adapter: any = {
      startRun: async () => ({ runId: '77' }),
      listCloudRunners: async () => [],
      autoDefectLogOf: async () => false, autoDefectLogStatus: status(true),
    };
    registerRunTools(cap.server, { getAdapter: () => adapter, getProjectId: () => null });
    const r = await cap.get('suite_run')({ suiteId: 'SU-28', when: 'immediate', mode: 'stack', environment: 'general', releaseId: '', sprintId: '' });
    expect(text(r)).toMatch(/Started suite SU-28.*Run id `77`/s);
    expect(text(r)).toMatch(/ℹ️ Auto defect logging is OFF for this suite.*suite_manage .*autoDefectLog:true/s);
  });
});
