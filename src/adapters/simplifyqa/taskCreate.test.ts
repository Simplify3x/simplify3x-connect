import { SimplifyQaAdapter } from './adapter.js';
import { registerTaskTools } from '../../tools/tasks.tools.js';

/**
 * "Create a task with a title, description, estimate, release/sprint and assignee" — driven through the REAL createTask / updateTask
 * against a fake backend that enforces the project-management task rules: required name / type / estimate / planned dates, no unknown
 * keys, a duplicate name refused, release and sprint must exist, the create response is the bare document, and any failure is
 * the unhelpful "Error While Creating Task".
 */
const REQUIRED = ['projectId', 'name', 'plannedStartDate', 'plannedEndDate', 'type', 'estimatedEffort'];
const ALLOWED = new Set([...REQUIRED, 'ownerId', 'defectId', 'userstoryId', 'releaseId', 'iterationId', 'state', 'priority', 'description', 'actualEffort', 'remainingEffort',
  'tags', 'customFields', 'updateVersion', 'actualStartDate', 'actualEndDate']);
const USERS = [{ id: 7, name: 'Pratik S', email: 'pratik.s@simplify3x.com' }, { id: 42, name: 'Rohini K', email: 'rohini.k@simplify3x.com' }];
const RELEASES = [
  { id: 44, code: 'RE-44', name: 'release mcp', state: 'New', projectIds: [19], plannedStartDate: '2026-11-01T00:00:00.000Z', plannedEndDate: '2026-12-31T00:00:00.000Z', deleted: false },
  { id: 45, code: 'RE-45', name: 'other release', state: 'New', projectIds: [19], plannedStartDate: '2026-11-01T00:00:00.000Z', plannedEndDate: '2026-12-31T00:00:00.000Z', deleted: false },
];
const SPRINTS = [
  { id: 2, code: 'SP-2', name: 'mcp sprint', state: 'New', releaseId: 44, plannedStartDate: '2026-11-16T00:00:00.000Z', plannedEndDate: '2026-11-20T00:00:00.000Z' },
  { id: 3, code: 'SP-3', name: 'other sprint', state: 'New', releaseId: 45, plannedStartDate: '2026-11-16T00:00:00.000Z', plannedEndDate: '2026-11-20T00:00:00.000Z' },
];

function backend(opts: { tasks?: any[]; noPrivilege?: boolean; dropWrites?: boolean; fieldsFail?: boolean } = {}) {
  const tasks = opts.tasks ?? [];
  const posts: Array<{ path: string; body: any }> = [];
  const puts: Array<{ path: string; body: any }> = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: 'http://backend' };
  a.requireProjectId = () => 19;
  a.ensureUserId = async () => '7';
  a.resolveStoryNumericId = async (ref: string) => { const m = /(\d+)$/.exec(ref); if (!m) throw new Error(`No story ${ref}`); return m[1]; };
  a.http = {
    postJson: async (path: string, body: any) => {
      if (path === '/pm/release/search') return { data: RELEASES };
      if (path === '/pm/sprint/search') return { data: SPRINTS };
      if (path === '/pm/users/search') {
        const f = body.searchFields.find((x: any) => x.column === 'email' || x.column === 'name');
        return { data: USERS.filter((u) => String((u as any)[f.column]).toLowerCase() === String(f.value).toLowerCase()) };
      }
      if (path === '/pm/task/search') {
        let rows = tasks.filter((t) => !t.deleted);
        for (const f of body.searchFields ?? []) {
          if (f.column === 'code') rows = rows.filter((t) => t.code === f.value);
          if (f.column === 'name' && f.regEx) rows = rows.filter((t) => new RegExp(f.value, 'i').test(t.name));
        }
        return { data: rows };
      }
      if (path === '/pm/task') {
        posts.push({ path, body });
        if (opts.noPrivilege) throw new Error("Don't Have Privileges to access resources (INVALIDTOKEN)");
        const bad = Object.keys(body).filter((k) => !ALLOWED.has(k));
        const missing = REQUIRED.filter((k) => body[k] === undefined || body[k] === null || body[k] === '');
        if (bad.length || missing.length) throw new Error('Error While Creating Task');
        if (tasks.some((t) => String(t.name).toLowerCase() === String(body.name).toLowerCase())) throw new Error('Duplicate Name Error');
        if (body.releaseId != null && !RELEASES.some((r) => r.id === body.releaseId)) throw new Error('Error While Creating Task');
        if (body.iterationId != null && !SPRINTS.some((s) => s.id === body.iterationId)) throw new Error('Error While Creating Task');
        const row = { id: tasks.length + 1, code: `TS-${tasks.length + 1}`, deleted: false, customerId: 3, updateVersion: 0, ownerId: [], ...body };
        if (!opts.dropWrites) tasks.push(row);
        return row;   // the controller answers with the bare document
      }
      throw new Error(`unexpected POST ${path}`);
    },
    getJson: async (path: string) => {
      const m = /^\/pm\/task\/(\d+)$/.exec(path);
      if (m) { const t = tasks.find((x) => String(x.id) === m[1]); return t ? [t] : []; }
      if (/^\/pm\/fields\/4\?/.test(path)) {
        if (opts.fieldsFail) throw new Error('boom');
        return [
          { key: 'type', values: [{ key: 'Bug fix', value: 'Bug fix' }, { key: 'Development', value: 'Development', isDefault: true }] },
          { key: 'state', values: [{ key: 'New', value: 'New', isDefault: true }, { key: 'In-progress', value: 'In-progress' }] },
          { key: 'priority', values: [{ key: 'Low', value: 'Low' }, { key: 'Medium', value: 'Medium', isDefault: true }, { key: 'High', value: 'High' }] },
        ];
      }
      throw new Error(`unexpected GET ${path}`);
    },
    putJson: async (path: string, body: any) => {
      puts.push({ path, body });
      const bad = Object.keys(body).filter((k) => !ALLOWED.has(k));
      if (bad.length) throw new Error(`validation error: "${bad[0]}" is not allowed`);
      const row = tasks.find((x) => `/pm/task/${x.id}` === path)!;
      if (body.updateVersion !== row.updateVersion) throw new Error('CONCURRENCY');
      Object.assign(row, body, { updateVersion: row.updateVersion + 1 });
      return { status: true };
    },
  };
  return { a, posts, puts, tasks };
}

describe('create a task (the reported case)', () => {
  test('title, description, estimate, release/sprint, assignee — the rest defaulted from the project and reported', async () => {
    const { a, posts, tasks } = backend();
    const r = await a.createTask({ name: 'mcp task', description: 'made by MCP', estimatedEffort: 3, releaseId: 'RE-44', sprintId: 'SP-2', assignee: 'rohini.k@simplify3x.com' });
    expect(posts[0]!.path).toBe('/pm/task');
    expect(posts[0]!.body).toEqual({
      projectId: 19, name: 'mcp task', type: 'Development', state: 'New', priority: 'Medium', description: 'made by MCP',
      plannedStartDate: '2026-11-16', plannedEndDate: '2026-11-20', estimatedEffort: 3, ownerId: [42], releaseId: 44, iterationId: 2,
    });
    expect(r).toMatchObject({ code: 'TS-1', name: 'mcp task', type: 'Development', state: 'New', priority: 'Medium', estimatedEffort: 3, ownerIds: [42] });
    expect(r.release).toMatch(/RE-44/);
    expect(r.sprint).toMatch(/SP-2/);
    expect(r.defaults.join(' | ')).toMatch(/planned dates 2026-11-16 → 2026-11-20 \(taken from the sprint.*type Development.*state New.*priority Medium/s);
    expect(tasks[0]!.ownerId).toEqual([42]);
  });

  test('only a name and an estimate: today\'s dates, no release / owner keys at all', async () => {
    const { a, posts } = backend();
    const r = await a.createTask({ name: 'small task', estimatedEffort: 1 });
    const today = new Date().toISOString().slice(0, 10);
    expect(posts[0]!.body).toEqual({ projectId: 19, name: 'small task', type: 'Development', state: 'New', priority: 'Medium', description: '', plannedStartDate: today, plannedEndDate: today, estimatedEffort: 1 });
    expect(r.ownerIds).toEqual([]);
    expect(r.defaults.join(' ')).toMatch(/\(today\)/);
  });

  test('a sprint alone brings its release; a sprint of another release is refused; unknown ones are refused', async () => {
    const one = backend();
    await one.a.createTask({ name: 'sprint only', estimatedEffort: 1, sprintId: 'SP-2' });
    expect(one.posts[0]!.body).toMatchObject({ releaseId: 44, iterationId: 2 });
    await expect(backend().a.createTask({ name: 'mismatch', estimatedEffort: 1, releaseId: 'RE-44', sprintId: 'SP-3' })).rejects.toThrow(/belongs to release 45, not RE-44/);
    await expect(backend().a.createTask({ name: 'x1', estimatedEffort: 1, releaseId: 'RE-99' })).rejects.toThrow(/No release "RE-99"/);
    await expect(backend().a.createTask({ name: 'x2', estimatedEffort: 1, sprintId: 'SP-99' })).rejects.toThrow(/No sprint "SP-99"/);
  });

  test('a user story, "me" and an explicit type / state / priority / dates', async () => {
    const { a, posts } = backend();
    await a.createTask({ name: 'full task', estimatedEffort: 2, storyId: 'US_12', assignee: 'me', type: 'bug fix', state: 'in progress', priority: 'high', plannedStartDate: '2026-12-01' });
    expect(posts[0]!.body).toMatchObject({ userstoryId: 12, ownerId: [7], type: 'Bug fix', state: 'In-progress', priority: 'High', plannedStartDate: '2026-12-01', plannedEndDate: '2026-12-01' });
  });
});

describe('refused before the backend can answer "Error While Creating Task"', () => {
  test('required and invalid inputs', async () => {
    const { a, posts } = backend();
    await expect(a.createTask({ name: 'x', estimatedEffort: 1 })).rejects.toThrow(/2–500 characters/);
    await expect(a.createTask({ name: 'no estimate' } as any)).rejects.toThrow(/needs estimatedEffort/);
    await expect(a.createTask({ name: 'huge', estimatedEffort: 10000 })).rejects.toThrow(/between 0 and 9999/);
    await expect(a.createTask({ name: 'bad type', estimatedEffort: 1, type: 'Banana' })).rejects.toThrow(/not a task type.*Bug fix, Development/s);
    await expect(a.createTask({ name: 'bad date', estimatedEffort: 1, plannedStartDate: '17/11/2026' })).rejects.toThrow(/must be a date like/);
    await expect(a.createTask({ name: 'bad range', estimatedEffort: 1, plannedStartDate: '2026-12-05', plannedEndDate: '2026-12-01' })).rejects.toThrow(/on or after plannedStartDate/);
    await expect(a.createTask({ name: 'who', estimatedEffort: 1, assignee: 'nobody@nowhere.com' })).rejects.toThrow(/No user matches/);
    expect(posts).toEqual([]);
  });

  test('a duplicate name; the project\'s types unreadable (and not given); no privilege; a write that was not stored', async () => {
    const dup = backend({ tasks: [{ id: 1, code: 'TS-1', name: 'mcp task', deleted: false }] });
    await expect(dup.a.createTask({ name: 'MCP Task', estimatedEffort: 1 })).rejects.toThrow(/already exists in this project: TS-1/);
    expect(dup.posts).toEqual([]);
    await expect(backend({ fieldsFail: true }).a.createTask({ name: 'no types', estimatedEffort: 1 })).rejects.toThrow(/could not be read, and type is required/);
    const passthrough = backend({ fieldsFail: true });
    await passthrough.a.createTask({ name: 'typed anyway', estimatedEffort: 1, type: 'Development' });
    expect(passthrough.posts[0]!.body.type).toBe('Development');
    await expect(backend({ noPrivilege: true }).a.createTask({ name: 'denied', estimatedEffort: 1 })).rejects.toThrow(/needs the "add_task" privilege/);
    await expect(backend({ dropWrites: true }).a.createTask({ name: 'lost', estimatedEffort: 1 })).rejects.toThrow(/could not be read back/);
  });
});

describe('update a task: release, sprint, linked story, effort', () => {
  const seeded = () => backend({ tasks: [{ id: 1, code: 'TS-1', name: 'mcp task', projectId: 19, deleted: false, updateVersion: 0, ownerId: [], state: 'New', priority: 'Low', estimatedEffort: 2, plannedStartDate: '2026-11-16T00:00:00.000Z', plannedEndDate: '2026-11-20T00:00:00.000Z', releaseId: 44, iterationId: 2, userstoryId: 5 }] });

  test('a sprint of another release moves the release with it; the story and efforts change', async () => {
    const { a, puts, tasks } = seeded();
    const r = await a.updateTask('TS-1', { sprintId: 'SP-3', storyId: 'US_12', actualEffort: 1.5, remainingEffort: 0.5 });
    expect(puts[0]!.body).toEqual({ projectId: 19, updateVersion: 0, releaseId: 45, iterationId: 3, userstoryId: 12, actualEffort: 1.5, remainingEffort: 0.5 });
    expect(r.changes.map((c: any) => c.field)).toEqual(['actual effort', 'remaining effort', 'release', 'sprint', 'linked story']);
    expect([tasks[0]!.releaseId, tasks[0]!.iterationId, tasks[0]!.userstoryId]).toEqual([45, 3, 12]);
  });

  test('moving to another release without a sprint clears the old release\'s sprint; "none" clears the story', async () => {
    const { a, puts } = seeded();
    const r = await a.updateTask('TS-1', { releaseId: 'RE-45', storyId: 'none' });
    expect(puts[0]!.body).toMatchObject({ releaseId: 45, iterationId: null, userstoryId: null });
    expect(r.changes.find((c: any) => c.field === 'sprint')!.to).toMatch(/old release/);
  });

  test('"none" for the release clears the sprint too; a sprint of the wrong release is refused', async () => {
    const { a, puts } = seeded();
    await a.updateTask('TS-1', { releaseId: 'none' });
    expect(puts[0]!.body).toMatchObject({ releaseId: null, iterationId: null });
    await expect(seeded().a.updateTask('TS-1', { releaseId: 'RE-44', sprintId: 'SP-3' })).rejects.toThrow(/belongs to release 45/);
    await expect(seeded().a.updateTask('TS-1', { releaseId: 'none', sprintId: 'SP-2' })).rejects.toThrow(/cannot have a sprint without a release/);
  });

  test('nothing different → nothing written', async () => {
    const { a, puts } = seeded();
    expect((await a.updateTask('TS-1', { releaseId: 'RE-44', sprintId: 'SP-2', storyId: 'US_5' })).written).toBe(false);
    expect(puts).toEqual([]);
  });
});

describe('the task_create tool', () => {
  const tool = (adapter: any, which: 'task_create' | 'task_update' = 'task_create') => {
    let handler: (a: any) => Promise<any> = async () => undefined;
    registerTaskTools({ registerTool: (name: string, _d: unknown, h: any) => { if (name === which) handler = h; } } as any, { getAdapter: () => adapter });
    return handler;
  };
  const text = (r: any): string => r.content.map((c: any) => c.text).join('\n');

  test('says what was created, what was defaulted, and that it was read back', async () => {
    const r = await tool(backend().a)({ name: 'mcp task', estimatedEffort: 3, releaseId: 'RE-44', sprintId: 'SP-2', assignee: 'rohini.k@simplify3x.com' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/Created task TS-1 "mcp task" — Development, state New, priority Medium, 2026-11-16 → 2026-11-20, estimate 3 h, release RE-44.*sprint SP-2.*assigned to rohini\.k@simplify3x\.com\. Read back from SimplifyQA/s);
    expect(text(r)).toMatch(/Defaulted \(not given\): planned dates .*; type Development; state New; priority Medium\./);
  });

  test('errors and not-connected come back as messages; task_update takes the new fields', async () => {
    expect(text(await tool(backend().a)({ name: 'x', estimatedEffort: 1 }))).toMatch(/2–500 characters/);
    expect(text(await tool(null)({ name: 'mcp task', estimatedEffort: 1 }))).toMatch(/Not connected/);
    const seeded = backend({ tasks: [{ id: 1, code: 'TS-1', name: 'mcp task', projectId: 19, deleted: false, updateVersion: 0, ownerId: [], iterationId: null, releaseId: null }] });
    expect(text(await tool(seeded.a, 'task_update')({ taskId: 'TS-1', sprintId: 'SP-2' }))).toMatch(/release: \(none\) → RE-44|sprint: \(none\) → SP-2/);
  });
});
