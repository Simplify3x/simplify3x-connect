import { SimplifyQaAdapter } from './adapter.js';
import { registerTaskTools } from '../../tools/tasks.tools.js';

/**
 * "Update TA-3 'mcp task': planned start date 17 Nov 2026, assign to rohini.k@simplify3x.com" — driven through the REAL updateTask
 * against a fake backend that behaves like the project-management task service (partial PUT, whole-body key validation, required
 * projectId, version check, add_task privilege, $set).
 */
const ALLOWED = new Set(['name', 'priority', 'defectId', 'ownerId', 'userstoryId', 'state', 'releaseId', 'iterationId', 'actualStartDate', 'actualEndDate',
  'plannedStartDate', 'plannedEndDate', 'type', 'estimatedEffort', 'actualEffort', 'remainingEffort', 'tags', 'description', 'customFields', 'projectId', 'updateVersion']);

const task = (over: Record<string, unknown> = {}) => ({
  _id: 'x', id: 3, code: 'TA-3', projectId: 19, customerId: 3, deleted: false, name: 'mcp task', state: 'New', priority: 'Low', ownerId: [],
  plannedStartDate: '2026-11-05T00:00:00.000Z', plannedEndDate: '2026-11-30T00:00:00.000Z', estimatedEffort: 4, updateVersion: 1, ...over,
});
const USERS = [{ id: 42, name: 'Rohini K', email: 'rohini.k@simplify3x.com' }, { id: 7, name: 'Pratik S', email: 'pratik.s@simplify3x.com' }];

function backend(opts: { tasks?: any[]; noPrivilege?: boolean; staleOnce?: boolean; ignorePut?: boolean; values?: boolean } = {}) {
  const tasks = opts.tasks ?? [task()];
  const puts: Array<{ path: string; body: any }> = [];
  let stale = opts.staleOnce === true;
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: 'http://backend' };
  a.requireProjectId = () => 19;
  a.ensureUserId = async () => '7';
  a.http = {
    postJson: async (path: string, body: any) => {
      if (path === '/pm/task/search') {
        let rows = tasks.filter((t) => !t.deleted);
        for (const f of body.searchFields ?? []) {
          if (f.column === 'code') rows = rows.filter((t) => t.code === f.value);
          if (f.column === 'name' && f.regEx) rows = rows.filter((t) => new RegExp(f.value, 'i').test(t.name));
          if (f.column === 'projectId') rows = rows.filter((t) => t.projectId === f.value);
        }
        return { data: rows };
      }
      if (path === '/pm/users/search') {
        const f = body.searchFields.find((x: any) => x.column === 'email' || x.column === 'name');
        return { data: USERS.filter((u) => String((u as any)[f.column]).toLowerCase() === String(f.value).toLowerCase()) };
      }
      throw new Error(`unexpected POST ${path}`);
    },
    getJson: async (path: string) => {
      let m = /^\/pm\/task\/(\d+)$/.exec(path);
      if (m) { const t = tasks.find((x) => String(x.id) === m![1]); return t ? { data: t } : { data: null }; }
      if (/^\/pm\/fields\/4\?/.test(path)) {
        if (opts.values === false) throw new Error('boom');
        return [
          { key: 'state', values: [{ key: 'New', value: 'New' }, { key: 'In-progress', value: 'In-progress' }, { key: 'Completed', value: 'Completed' }] },
          { key: 'priority', values: [{ key: 'Low', value: 'Low' }, { key: 'Medium', value: 'Medium' }, { key: 'High', value: 'High' }] },
        ];
      }
      throw new Error(`unexpected GET ${path}`);
    },
    putJson: async (path: string, body: any) => {
      puts.push({ path, body });
      if (opts.noPrivilege) throw new Error("Don't Have Privileges to access resources (INVALIDTOKEN)");
      const bad = Object.keys(body).filter((k) => !ALLOWED.has(k));
      if (bad.length) throw new Error(`validation error: "${bad[0]}" is not allowed`);
      if (typeof body.projectId !== 'number') throw new Error('validation error: "PROJECT ID" is required');
      const row = tasks.find((x) => `/pm/task/${x.id}` === path)!;
      if (stale) { stale = false; row.updateVersion += 1; }
      if (body.updateVersion !== row.updateVersion) throw new Error('Concurrency Error (CONCURRENCY)');
      if (!opts.ignorePut) Object.assign(row, body, { updateVersion: row.updateVersion + 1 });
      return { status: true };
    },
  };
  return { a, puts, tasks };
}

describe('update TA-3 (the reported case)', () => {
  test('planned start date + assignee by email: a partial PUT with only those fields, read back', async () => {
    const { a, puts, tasks } = backend();
    const r = await a.updateTask('TA-3', { plannedStartDate: '2026-11-17', assignee: 'rohini.k@simplify3x.com' });
    expect(puts).toHaveLength(1);
    expect(puts[0]!.path).toBe('/pm/task/3');
    expect(puts[0]!.body).toEqual({ projectId: 19, updateVersion: 1, plannedStartDate: '2026-11-17', ownerId: [42] });
    expect(r.written).toBe(true);
    expect(r.changes).toEqual([
      { field: 'planned start', from: '2026-11-05', to: '2026-11-17' },
      { field: 'assignee', from: 'Unassigned', to: 'rohini.k@simplify3x.com' },
    ]);
    expect(tasks[0]!.ownerId).toEqual([42]);
    expect(String(tasks[0]!.plannedStartDate).slice(0, 10)).toBe('2026-11-17');
  });

  test('the task can be named by id or by exact name, and "me" / a name / unassign work for the assignee', async () => {
    for (const ref of ['3', 'mcp task', 'MCP TASK']) {
      expect((await backend().a.updateTask(ref, { priority: 'High' })).code).toBe('TA-3');
    }
    expect((await backend().a.updateTask('TA-3', { assignee: 'me' })).changes[0]!.to).toBe('me');
    const named = backend();
    await named.a.updateTask('TA-3', { assignee: 'Rohini K' });
    expect(named.tasks[0]!.ownerId).toEqual([42]);
    const un = backend({ tasks: [task({ ownerId: [42] })] });
    await un.a.updateTask('TA-3', { unassign: true });
    expect(un.tasks[0]!.ownerId).toEqual([]);
  });

  test('state / priority are matched to the project\'s own values; an unknown one is refused with the valid ones', async () => {
    const { a, tasks } = backend();
    await a.updateTask('TA-3', { state: 'in progress', priority: 'medium' });
    expect([tasks[0]!.state, tasks[0]!.priority]).toEqual(['In-progress', 'Medium']);
    await expect(backend().a.updateTask('TA-3', { state: 'Banana' })).rejects.toThrow(/not a task state.*New, In-progress, Completed/s);
  });

  test('nothing different → nothing written', async () => {
    const { a, puts } = backend();
    const r = await a.updateTask('TA-3', { plannedStartDate: '2026-11-05', priority: 'low', name: 'mcp task' });
    expect(r.written).toBe(false);
    expect(puts).toEqual([]);
  });
});

describe('refused or reported instead of saved wrong', () => {
  test('an assignee who matches nobody is refused before anything is sent', async () => {
    const { a, puts } = backend();
    await expect(a.updateTask('TA-3', { assignee: 'nobody@nowhere.com' })).rejects.toThrow(/No user matches/);
    expect(puts).toEqual([]);
  });

  test('a start after the end is refused unless the end moves too', async () => {
    const { a, puts } = backend();
    await expect(a.updateTask('TA-3', { plannedStartDate: '2026-12-15' })).rejects.toThrow(/start \(2026-12-15\) would be after the planned end \(2026-11-30\)/);
    expect(puts).toEqual([]);
    await a.updateTask('TA-3', { plannedStartDate: '2026-12-15', plannedEndDate: '2026-12-31' });
    expect(puts).toHaveLength(1);
  });

  test('bad inputs: unknown / ambiguous / other-project task, bad date, short name, effort', async () => {
    await expect(backend().a.updateTask('TA-99', { priority: 'High' })).rejects.toThrow(/No task "TA-99"/);
    await expect(backend({ tasks: [task(), task({ id: 4, code: 'TA-4' })] }).a.updateTask('mcp task', { priority: 'High' })).rejects.toThrow(/matches 2 tasks/);
    await expect(backend({ tasks: [task({ projectId: 77 })] }).a.updateTask('3', { priority: 'High' })).rejects.toThrow(/No task/);
    await expect(backend().a.updateTask('TA-3', { plannedStartDate: '17/11/2026' })).rejects.toThrow(/must be a date like 2026-11-17/);
    await expect(backend().a.updateTask('TA-3', { name: 'ab' })).rejects.toThrow(/at least 3 characters/);
    await expect(backend().a.updateTask('TA-3', { estimatedEffort: 10000 })).rejects.toThrow(/between 0 and 9999/);
  });

  test('no add_task privilege: a clear message', async () => {
    await expect(backend({ noPrivilege: true }).a.updateTask('TA-3', { priority: 'High' })).rejects.toThrow(/needs the "add_task" privilege/);
  });

  test('a stale version is retried once with the fresh one', async () => {
    const { a, puts, tasks } = backend({ staleOnce: true });
    await a.updateTask('TA-3', { priority: 'High' });
    expect(puts.map((p) => p.body.updateVersion)).toEqual([1, 2]);
    expect(tasks[0]!.priority).toBe('High');
  });

  test('a save the backend did not apply is reported, not claimed', async () => {
    await expect(backend({ ignorePut: true }).a.updateTask('TA-3', { priority: 'High' })).rejects.toThrow(/"priority" was sent as "High" but reads back as "Low"/);
  });

  test('works when the project\'s state / priority values cannot be read (passed through)', async () => {
    const { a, tasks } = backend({ values: false });
    await a.updateTask('TA-3', { state: 'Whatever' });
    expect(tasks[0]!.state).toBe('Whatever');
  });
});

describe('the task_update tool', () => {
  const tool = (adapter: any) => {
    let handler: (a: any) => Promise<any> = async () => undefined;
    registerTaskTools({ registerTool: (name: string, _d: unknown, h: any) => { if (name === 'task_update') handler = h; } } as any, { getAdapter: () => adapter });
    return handler;
  };
  const text = (r: any): string => r.content.map((c: any) => c.text).join('\n');

  test('lists each change and says it was read back', async () => {
    const r = await tool(backend().a)({ taskId: 'TA-3', plannedStartDate: '2026-11-17', assignee: 'rohini.k@simplify3x.com' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/Updated task TA-3 "mcp task" and read it back/);
    expect(text(r)).toMatch(/planned start: 2026-11-05 → 2026-11-17/);
    expect(text(r)).toMatch(/assignee: Unassigned → rohini\.k@simplify3x\.com/);
  });

  test('needs a change; assignee and unassign together are refused; not connected', async () => {
    const h = tool(backend().a);
    expect(text(await h({ taskId: 'TA-3' }))).toMatch(/needs something to change/);
    expect(text(await h({ taskId: 'TA-3', assignee: 'me', unassign: true }))).toMatch(/either assignee or unassign/);
    expect(text(await tool(null)({ taskId: 'TA-3', priority: 'High' }))).toMatch(/Not connected/);
  });
});
