import { SimplifyQaAdapter } from './adapter.js';
import { registerReleaseSprintTools } from '../../tools/releaseSprint.tools.js';

/**
 * release_delete / sprint_delete: driven through the REAL preview + delete against a fake backend that behaves like the
 * project-management service — `PATCH /pm/release|sprint { id:[…] }` is admin-only, answers 201 and just flags rows deleted,
 * and checks NOTHING that still uses them (so the MCP must).
 */
const rel = (id: number, extra: Record<string, unknown> = {}) => ({ id, code: `RE-${id}`, name: `release ${id}`, state: 'Completed', projectIds: [19], deleted: false, ...extra });
const spr = (id: number, releaseId: number) => ({ id, code: `SP-${id}`, name: `sprint ${id}`, state: 'Completed', releaseId, deleted: false });

type Items = Record<string, any[]>;
function backend(o: { releases?: any[]; sprints?: any[]; items?: Items; admin?: boolean; failSearch?: string; ignorePatch?: boolean; patchError?: Error } = {}) {
  const releases = o.releases ?? [rel(45)];
  const sprints = o.sprints ?? [spr(64, 45)];
  const items: Items = o.items ?? {};
  const patches: Array<{ path: string; body: any }> = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: 'http://backend' };
  a.requireProjectId = () => 19;
  a.ensureUserId = async () => '5';
  const colOf = (body: any, c: string) => body.searchFields.find((f: any) => f.column === c)?.value;
  a.http = {
    postJson: async (path: string, body: any) => {
      if (o.failSearch === path) throw new Error('503 upstream');
      if (path === '/pm/release/search') return { data: releases.filter((r) => !r.deleted && r.projectIds.includes(19)) };
      if (path === '/pm/sprint/search') return { data: sprints.filter((s) => !s.deleted) };
      if (path === '/pm/users/search') return { data: [{ id: 5, userType: o.admin === false ? ['non-admin'] : ['admin'] }] };
      if (path === '/pm/project/search') return { data: [{ id: 20, code: 'PR-20', name: 'Other project' }] };
      if (items[path]) {
        const col = ['releaseId', 'iterationId'].find((c) => colOf(body, c) !== undefined)!;
        return { data: items[path]!.filter((r) => String(r[col]) === String(colOf(body, col))) };
      }
      return { data: [] };   // every other collection is empty
    },
    patchJson: async (path: string, body: any) => {
      patches.push({ path, body });
      if (o.patchError) throw o.patchError;
      if (!o.ignorePatch) {
        const list = path === '/pm/release' ? releases : sprints;
        for (const r of list) if (body.id.includes(r.id)) r.deleted = true;
      }
      return { status: true, msg: 'Delete Successfull' };
    },
  };
  return { a, patches, releases, sprints };
}

describe('release / sprint delete — preview', () => {
  test('a release with a sprint, a story and a plan lists all three and nothing is written', async () => {
    const { a, patches } = backend({ items: {
      '/pm/userstory/search': [{ id: 7, code: 'US-7', name: 's', releaseId: 45 }],
      '/tm/executionplan/search': [{ id: 3, code: 'PL-3', name: 'p', releaseId: 45 }],
    } });
    const p = await a.releaseOrSprintDeletePreview('release', 'RE-45');
    expect(p.blockers.sprints.map((s: any) => s.code)).toEqual(['SP-64']);
    expect(p.blockers.stories.map((s: any) => s.code)).toEqual(['US-7']);
    expect(p.blockers.executionPlans.map((s: any) => s.code)).toEqual(['PL-3']);
    expect(p.callerIsAdmin).toBe(true);
    expect(patches).toEqual([]);
  });

  test('a sprint is matched on iterationId, not releaseId', async () => {
    const { a } = backend({ items: { '/pm/task/search': [{ id: 9, code: 'TK-9', name: 't', iterationId: 64 }, { id: 10, code: 'TK-10', name: 'x', iterationId: 65 }] } });
    const p = await a.releaseOrSprintDeletePreview('sprint', 'SP-64');
    expect(p.blockers.tasks.map((s: any) => s.code)).toEqual(['TK-9']);
  });

  test('a release also used by another project is a blocker; a lookup that fails stops everything', async () => {
    const shared = backend({ releases: [rel(45, { projectIds: [19, 20] })], sprints: [] });
    expect((await shared.a.releaseOrSprintDeletePreview('release', 'RE-45')).blockers.otherProjects.map((p: any) => p.code)).toEqual(['PR-20']);
    const broken = backend({ failSearch: '/pm/defect/search' });
    await expect(broken.a.releaseOrSprintDeletePreview('release', 'RE-45')).rejects.toThrow(/Could not check the defects.*Nothing was deleted/s);
  });
});

describe('release / sprint delete — delete', () => {
  test('an unused sprint, then its release, are deleted and proven gone by re-reading', async () => {
    const { a, patches, releases, sprints } = backend();
    expect((await a.deleteReleaseOrSprint('sprint', 'SP-64')).code).toBe('SP-64');
    expect(patches[0]).toEqual({ path: '/pm/sprint', body: { id: [64] } });
    expect(sprints[0]!.deleted).toBe(true);
    expect((await a.deleteReleaseOrSprint('release', 'RE-45')).code).toBe('RE-45');
    expect(patches[1]).toEqual({ path: '/pm/release', body: { id: [45] } });
    expect(releases[0]!.deleted).toBe(true);
  });

  test('a record that is still used is refused BEFORE any PATCH', async () => {
    const { a, patches } = backend();
    await expect(a.deleteReleaseOrSprint('release', 'RE-45')).rejects.toThrow(/still in use/);
    expect(patches).toEqual([]);
  });

  test('a non-admin gets a plain message; a 201 that deleted nothing is reported, not believed', async () => {
    const denied = backend({ sprints: [], patchError: new Error("User doesn't have admin privileges INVALIDUSERTYPE") });
    await expect(denied.a.deleteReleaseOrSprint('release', 'RE-45')).rejects.toThrow(/needs an admin user.*Nothing was deleted/s);
    const silent = backend({ sprints: [], ignorePatch: true });
    await expect(silent.a.deleteReleaseOrSprint('release', 'RE-45')).rejects.toThrow(/still listed — nothing was deleted/);
  });
});

describe('release_delete / sprint_delete tools', () => {
  function tools(be: ReturnType<typeof backend>) {
    const handlers = new Map<string, (a: any) => Promise<any>>();
    registerReleaseSprintTools({ registerTool: (n: string, _c: unknown, h: any) => { handlers.set(n, h); } } as any, { getAdapter: () => be.a });
    return handlers;
  }
  const text = (r: any) => String(r.content?.[0]?.text ?? '');

  test('step 1 previews and deletes nothing; step 2 with confirm deletes', async () => {
    const be = backend({ sprints: [spr(64, 45)] });
    const h = tools(be);
    const pre = await h.get('sprint_delete')!({ sprintId: 'SP-64' });
    expect(text(pre)).toMatch(/About to delete sprint.*SP-64.*Nothing has been deleted yet/s);
    expect(be.patches).toEqual([]);
    const done = await h.get('sprint_delete')!({ sprintId: 'SP-64', confirm: true });
    expect(text(done)).toMatch(/Deleted sprint SP-64/);
    expect(be.patches).toHaveLength(1);
  });

  test('a release that still has a sprint is refused even with confirm, listing it', async () => {
    const be = backend();
    const r = await tools(be).get('release_delete')!({ releaseId: 'RE-45', confirm: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/still used by.*sprints \(1\): SP-64/s);
    expect(be.patches).toEqual([]);
  });

  test('the preview warns when the connected user is not an admin; a missing id is asked for', async () => {
    const h = tools(backend({ sprints: [], admin: false }));
    expect(text(await h.get('release_delete')!({ releaseId: 'RE-45' }))).toMatch(/does not look like a SimplifyQA admin/);
    expect((await h.get('release_delete')!({})).isError).toBe(true);
  });
});
