import { SimplifyQaAdapter } from './adapter.js';
import { registerReleaseSprintTools } from '../../tools/releaseSprint.tools.js';

/**
 * "Close release RE-44 'release mcp'": driven through the REAL updateReleaseOrSprint against a fake backend that behaves like the
 * project-management service (admin-only PUT, whole-body validation that refuses unknown keys, $set, concurrency version).
 */
const STATES = [{ key: 'New', value: 'New' }, { key: 'In-progress', value: 'In-progress' }, { key: 'Completed', value: 'Completed' }, { key: 'Released', value: 'Released' }];
const ALLOWED_RELEASE = new Set(['name', 'plannedStartDate', 'state', 'plannedEndDate', 'estimatedEffort', 'projectIds', 'ownerIds', 'description',
  'actualStartDate', 'actualEndDate', 'remainingEffort', 'actualEffort', 'customFields', 'azureReleaseId', 'jiraReleaseId', 'updateVersion']);

const release = (over: Record<string, unknown> = {}) => ({
  _id: 'x', id: 44, code: 'RE-44', customerId: 3, deleted: false, createdAt: '2026-01-01T00:00:00Z', createdBy: 5,
  name: 'release mcp', state: 'New', plannedStartDate: '2026-11-01T00:00:00.000Z', plannedEndDate: '2026-12-01T00:00:00.000Z',
  estimatedEffort: 10, projectIds: [19], ownerIds: [5], description: null, actualStartDate: null, actualEndDate: null, updateVersion: 2, ...over,
});
const sprint = (id: number, state: string, releaseId = 44) => ({
  id, code: `SP-${id}`, name: `sprint ${id}`, state, releaseId, plannedStartDate: '2026-11-01T00:00:00.000Z', plannedEndDate: '2026-11-15T00:00:00.000Z',
  estimatedEffort: 5, ownerIds: [5], description: 'd', updateVersion: 0, customerId: 3, deleted: false,
});

function backend(opts: { releases?: any[]; sprints?: any[]; states?: any[]; putError?: Error; ignorePut?: boolean } = {}) {
  const releases = opts.releases ?? [release()];
  const sprints = opts.sprints ?? [];
  const puts: Array<{ path: string; body: any }> = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: 'http://backend' };
  a.requireProjectId = () => 19;
  a.http = {
    postJson: async (path: string) => {
      if (path === '/pm/release/search') return { data: releases.filter((r) => !r.deleted && r.projectIds.includes(19)) };
      if (path === '/pm/sprint/search') return { data: sprints };
      throw new Error(`unexpected POST ${path}`);
    },
    getJson: async (path: string) => {
      if (/^\/pm\/fields\/(11|12)\?/.test(path)) return [{ key: 'state', fieldType: 'defaultFld', values: opts.states ?? STATES }];
      throw new Error(`unexpected GET ${path}`);
    },
    putJson: async (path: string, body: any) => {
      puts.push({ path, body });
      if (opts.putError) throw opts.putError;
      const bad = Object.keys(body).filter((k) => !ALLOWED_RELEASE.has(k) && !['releaseId', 'azureSprintPath', 'azureSprintId', 'jiraSprintId'].includes(k));
      if (bad.length) throw new Error(`Validation error: "${bad[0]}" is not allowed`);
      const m = /^\/pm\/(release|sprint)\/(\d+)$/.exec(path)!;
      const list = m[1] === 'release' ? releases : sprints;
      const row = list.find((r) => String(r.id) === m[2])!;
      if (body.updateVersion !== (row.updateVersion ?? 0)) throw new Error('CONCURRENCY');
      if (!opts.ignorePut) Object.assign(row, body, { updateVersion: (row.updateVersion ?? 0) + 1 });
      return { status: true };
    },
  };
  return { a, puts, releases, sprints };
}

describe('close release RE-44', () => {
  test('state New → Completed, only validator keys are sent, end date set, read back', async () => {
    const { a, puts, releases } = backend();
    const r = await a.updateReleaseOrSprint('release', 'RE-44', { close: true });
    expect(puts).toHaveLength(1);
    expect(puts[0]!.path).toBe('/pm/release/44');
    const body = puts[0]!.body;
    expect(Object.keys(body).every((k) => ALLOWED_RELEASE.has(k))).toBe(true);     // no id / code / customerId / _id / deleted
    expect(body).toMatchObject({ name: 'release mcp', state: 'Completed', estimatedEffort: 10, projectIds: [19], ownerIds: [5], updateVersion: 2, description: '' });
    expect(typeof body.actualEndDate).toBe('string');
    expect(r).toMatchObject({ id: '44', code: 'RE-44', stateBefore: 'New', stateAfter: 'Completed', written: true });
    expect(r.changed).toEqual(expect.arrayContaining(['state', 'actualEndDate']));
    expect(releases[0]!.state).toBe('Completed');
  });

  test('found by id and by exact name too; the closed state is the project\'s own (Released when there is no Completed)', async () => {
    for (const ref of ['44', 'release mcp', 'RELEASE MCP']) {
      const { a } = backend({ states: [{ key: 'New', value: 'New' }, { key: 'Released', value: 'Released' }] });
      expect((await a.updateReleaseOrSprint('release', ref, { close: true })).stateAfter).toBe('Released');
    }
  });

  test('an explicit state is matched loosely and an unknown one is refused with the valid ones', async () => {
    const { a } = backend();
    expect((await a.updateReleaseOrSprint('release', 'RE-44', { state: 'in progress' })).stateAfter).toBe('In-progress');
    await expect(backend().a.updateReleaseOrSprint('release', 'RE-44', { state: 'Banana' })).rejects.toThrow(/not a release state.*New, In-progress, Completed, Released/s);
  });

  test('already in that state: nothing is written', async () => {
    const { a, puts } = backend({ releases: [release({ state: 'Completed', actualEndDate: '2026-11-10T00:00:00Z' })] });
    const r = await a.updateReleaseOrSprint('release', 'RE-44', { close: true });
    expect(r.written).toBe(false);
    expect(puts).toEqual([]);
  });

  test('closing warns about sprints that are not completed, and ignores other releases\' sprints', async () => {
    const { a } = backend({ sprints: [sprint(1, 'Completed'), sprint(2, 'In-progress'), sprint(9, 'New', 99)] });
    const r = await a.updateReleaseOrSprint('release', 'RE-44', { close: true });
    expect(r.warnings.join(' ')).toMatch(/1 sprint\(s\).*SP-2 \[In-progress\]/);
    expect(r.warnings.join(' ')).not.toMatch(/SP-9/);
  });
});

describe('refusals and failures say what happened', () => {
  test('unknown, ambiguous and out-of-project releases', async () => {
    await expect(backend().a.updateReleaseOrSprint('release', 'RE-99', { close: true })).rejects.toThrow(/No release "RE-99".*RE-44 "release mcp"/s);
    const two = [release(), release({ id: 45, code: 'RE-45' })];
    await expect(backend({ releases: two }).a.updateReleaseOrSprint('release', 'release mcp', { close: true })).rejects.toThrow(/matches 2 releases/);
    await expect(backend({ releases: [release({ projectIds: [77] })] }).a.updateReleaseOrSprint('release', 'RE-44', { close: true })).rejects.toThrow(/No release/);
  });

  test('a non-admin user gets a clear message', async () => {
    const { a } = backend({ putError: new Error("User doesn't have admin privileges (INVALIDUSERTYPE)") });
    await expect(a.updateReleaseOrSprint('release', 'RE-44', { close: true })).rejects.toThrow(/needs an admin user/);
  });

  test('a save the backend did not apply is reported, not claimed', async () => {
    const { a } = backend({ ignorePut: true });
    await expect(a.updateReleaseOrSprint('release', 'RE-44', { close: true })).rejects.toThrow(/reads back "New"/);
  });

  test('end before start is refused before anything is sent', async () => {
    const { a, puts } = backend();
    await expect(a.updateReleaseOrSprint('release', 'RE-44', { plannedEndDate: '2026-10-01' })).rejects.toThrow(/on or after plannedStartDate/);
    expect(puts).toEqual([]);
  });
});

describe('sprints', () => {
  test('complete a sprint: its release is kept, state Completed, end date set', async () => {
    const { a, puts, sprints } = backend({ sprints: [sprint(7, 'In-progress')] });
    const r = await a.updateReleaseOrSprint('sprint', 'SP-7', { close: true });
    expect(puts[0]!.path).toBe('/pm/sprint/7');
    expect(puts[0]!.body).toMatchObject({ releaseId: 44, state: 'Completed', name: 'sprint 7', description: 'd' });
    expect(r).toMatchObject({ code: 'SP-7', stateBefore: 'In-progress', stateAfter: 'Completed' });
    expect(r.warnings.join(' ')).toMatch(/new \/ pending stories/);
    expect(sprints[0]!.state).toBe('Completed');
  });

  test('a sprint of another project\'s release is not found', async () => {
    const { a } = backend({ sprints: [sprint(8, 'New', 99)] });
    await expect(a.updateReleaseOrSprint('sprint', 'SP-8', { close: true })).rejects.toThrow(/No sprint/);
  });
});

describe('the tools', () => {
  const tools = (adapter: any) => {
    const handlers = { release_update: async (_a: any): Promise<any> => undefined, sprint_update: async (_a: any): Promise<any> => undefined };
    registerReleaseSprintTools({
      registerTool: (name: 'release_update' | 'sprint_update', _d: unknown, h: any) => { handlers[name] = h; },
    } as any, { getAdapter: () => adapter });
    return handlers;
  };
  const text = (r: any): string => r.content.map((c: any) => c.text).join('\n');

  test('release_update close: names the before/after state and says it was read back', async () => {
    const r = await tools(backend().a).release_update({ releaseId: 'RE-44', close: true });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/Updated release RE-44 "release mcp": state New → Completed.*Read back from SimplifyQA: Completed/s);
  });

  test('needs an id and something to change; close and state together are refused', async () => {
    const h = tools(backend().a);
    expect(text(await h.release_update({ close: true }))).toMatch(/needs releaseId/);
    expect(text(await h.release_update({ releaseId: 'RE-44' }))).toMatch(/needs something to change/);
    expect(text(await h.sprint_update({ sprintId: 'SP-1', close: true, state: 'New' }))).toMatch(/either close:true or a state/);
  });

  test('not connected', async () => {
    expect(text(await tools(null).release_update({ releaseId: 'RE-44', close: true }))).toMatch(/Not connected/);
  });
});
