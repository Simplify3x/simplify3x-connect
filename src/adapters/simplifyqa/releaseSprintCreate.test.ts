import { SimplifyQaAdapter } from './adapter.js';
import { registerReleaseSprintTools } from '../../tools/releaseSprint.tools.js';

/**
 * "Create release 'mcp release' and sprint 'mcp sprint' under it, 16 Nov 2026, 2 hours" — driven through the REAL
 * createReleaseOrSprint against a fake backend that enforces the project-management validators (required fields, at least one
 * owner, unknown keys refused, admin-only POST) and assigns the next RE-xx / SP-xx.
 */
const STATES = [{ key: 'New', value: 'New' }, { key: 'In-progress', value: 'In-progress' }, { key: 'Completed', value: 'Completed' }];
const USERS = [{ id: 7, name: 'Pratik S', email: 'pratik.s@simplify3x.com' }, { id: 42, name: 'Rohini K', email: 'rohini.k@simplify3x.com' }];
const REQUIRED_RELEASE = ['name', 'plannedStartDate', 'state', 'plannedEndDate', 'estimatedEffort', 'projectIds', 'ownerIds'];
const REQUIRED_SPRINT = ['name', 'plannedStartDate', 'plannedEndDate', 'estimatedEffort', 'releaseId', 'state', 'ownerIds'];
const ALLOWED = new Set([...REQUIRED_RELEASE, ...REQUIRED_SPRINT, 'description', 'customFields']);

function backend(opts: { notAdmin?: boolean; dropWrites?: boolean; releases?: any[]; sprints?: any[]; states?: any[] } = {}) {
  const releases = opts.releases ?? [];
  const sprints = opts.sprints ?? [];
  const posts: Array<{ path: string; body: any }> = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: 'http://backend' };
  a.requireProjectId = () => 19;
  a.ensureUserId = async () => '7';
  a.http = {
    postJson: async (path: string, body: any) => {
      if (path === '/pm/release/search') return { data: releases.filter((r) => !r.deleted && r.projectIds.includes(19)) };
      if (path === '/pm/sprint/search') return { data: sprints };
      if (path === '/pm/users/search') {
        const f = body.searchFields.find((x: any) => x.column === 'email' || x.column === 'name');
        return { data: USERS.filter((u) => String((u as any)[f.column]).toLowerCase() === String(f.value).toLowerCase()) };
      }
      if (path === '/pm/release' || path === '/pm/sprint') {
        posts.push({ path, body });
        if (opts.notAdmin) throw new Error("User doesn't have admin privileges (INVALIDUSERTYPE)");
        const isRelease = path === '/pm/release';
        const bad = Object.keys(body).filter((k) => !ALLOWED.has(k));
        if (bad.length) throw new Error(`Validation error: "${bad[0]}" is not allowed`);
        const missing = (isRelease ? REQUIRED_RELEASE : REQUIRED_SPRINT).filter((k) => body[k] === undefined || body[k] === null);
        if (missing.length) throw new Error(`Validation error: "${missing[0]}" is required`);
        if (!body.ownerIds.length) throw new Error('Validation error: "owners" must contain at least 1 items');
        if (typeof body.description !== 'string' && !isRelease) throw new Error('Validation error: "Description" must be a string');
        if (!isRelease && !releases.some((r) => r.id === body.releaseId)) throw new Error(`Release not found with the id ${body.releaseId}`);
        const list = isRelease ? releases : sprints;
        const row = { id: (isRelease ? 44 : 0) + list.length + 1, code: `${isRelease ? 'RE' : 'SP'}-${(isRelease ? 44 : 0) + list.length + 1}`, deleted: false, customerId: 3, ...body };
        if (!opts.dropWrites) list.push(row);
        return { status: true, data: row };
      }
      throw new Error(`unexpected POST ${path}`);
    },
    getJson: async (path: string) => {
      if (/^\/pm\/fields\/(11|12)\?/.test(path)) return [{ key: 'state', values: opts.states ?? STATES }];
      throw new Error(`unexpected GET ${path}`);
    },
  };
  return { a, posts, releases, sprints };
}

const REL = { name: 'mcp release', plannedStartDate: '2026-11-16', plannedEndDate: '2026-11-16', estimatedEffort: 2 };
const SPR = { name: 'mcp sprint', plannedStartDate: '2026-11-16', plannedEndDate: '2026-11-16', estimatedEffort: 2 };

describe('the reported case: release then sprint', () => {
  test('release "mcp release": project, dates, effort as given; state New and owner = me by default; returns RE-xx', async () => {
    const { a, posts } = backend();
    const r = await a.createReleaseOrSprint('release', REL);
    expect(posts[0]!.path).toBe('/pm/release');
    expect(posts[0]!.body).toEqual({
      name: 'mcp release', state: 'New', ownerIds: [7], description: '', projectIds: [19],
      plannedStartDate: '2026-11-16', plannedEndDate: '2026-11-16', estimatedEffort: 2,
    });
    expect(r).toMatchObject({ code: 'RE-45', name: 'mcp release', state: 'New', plannedStartDate: '2026-11-16', plannedEndDate: '2026-11-16', estimatedEffort: 2, ownerIds: [7] });
    expect(r.warnings).toEqual([]);
  });

  test('sprint "mcp sprint" under that release (by code or by name): releaseId is the numeric id; returns SP-xx', async () => {
    for (const ref of ['RE-45', 'mcp release', '45']) {
      const { a, posts } = backend();
      await a.createReleaseOrSprint('release', REL);
      const r = await a.createReleaseOrSprint('sprint', { ...SPR, releaseId: ref });
      expect(posts[1]!.path).toBe('/pm/sprint');
      expect(posts[1]!.body).toEqual({
        name: 'mcp sprint', state: 'New', ownerIds: [7], description: '', releaseId: 45,
        plannedStartDate: '2026-11-16', plannedEndDate: '2026-11-16', estimatedEffort: 2,
      });
      expect(r).toMatchObject({ code: 'SP-1', name: 'mcp sprint', release: 'RE-45', state: 'New' });
    }
  });

  test('owners by email / name, an explicit state, a description', async () => {
    const { a, posts } = backend();
    await a.createReleaseOrSprint('release', { ...REL, owners: ['rohini.k@simplify3x.com', 'Pratik S'], state: 'in progress', description: 'for MCP runs' });
    expect(posts[0]!.body).toMatchObject({ ownerIds: [42, 7], state: 'In-progress', description: 'for MCP runs' });
  });
});

describe('refused instead of created wrong', () => {
  test('missing / bad fields are refused before anything is sent', async () => {
    const { a, posts } = backend();
    await expect(a.createReleaseOrSprint('release', { ...REL, name: 'ab' })).rejects.toThrow(/3–500 characters/);
    await expect(a.createReleaseOrSprint('release', { ...REL, plannedStartDate: '' })).rejects.toThrow(/needs plannedStartDate/);
    await expect(a.createReleaseOrSprint('release', { ...REL, plannedEndDate: '16/11/2026' })).rejects.toThrow(/must be a date like 2026-11-16/);
    await expect(a.createReleaseOrSprint('release', { ...REL, plannedEndDate: '2026-11-01' })).rejects.toThrow(/on or after plannedStartDate/);
    await expect(a.createReleaseOrSprint('release', { ...REL, estimatedEffort: -1 })).rejects.toThrow(/needs estimatedEffort/);
    await expect(a.createReleaseOrSprint('release', { ...REL, estimatedEffort: undefined as any })).rejects.toThrow(/needs estimatedEffort/);
    await expect(a.createReleaseOrSprint('release', { ...REL, state: 'Banana' })).rejects.toThrow(/not a release state.*New, In-progress, Completed/s);
    await expect(a.createReleaseOrSprint('release', { ...REL, owners: ['nobody@nowhere.com'] })).rejects.toThrow(/No user matches/);
    await expect(a.createReleaseOrSprint('sprint', SPR)).rejects.toThrow(/needs releaseId/);
    await expect(a.createReleaseOrSprint('sprint', { ...SPR, releaseId: 'RE-99' })).rejects.toThrow(/No release "RE-99"/);
    expect(posts).toEqual([]);
  });

  test('a duplicate name is refused (a sprint only within its own release)', async () => {
    const { a, posts } = backend();
    await a.createReleaseOrSprint('release', REL);
    await expect(a.createReleaseOrSprint('release', { ...REL, name: 'MCP Release' })).rejects.toThrow(/already exists: RE-45/);
    await a.createReleaseOrSprint('sprint', { ...SPR, releaseId: 'RE-45' });
    await expect(a.createReleaseOrSprint('sprint', { ...SPR, releaseId: 'RE-45' })).rejects.toThrow(/already exists in that release: SP-1/);
    await a.createReleaseOrSprint('release', { ...REL, name: 'other release' });
    await a.createReleaseOrSprint('sprint', { ...SPR, releaseId: 'RE-46' });   // same sprint name, different release: fine
    expect(posts.map((p) => p.path)).toEqual(['/pm/release', '/pm/sprint', '/pm/release', '/pm/sprint']);
  });

  test('a sprint outside its release\'s dates is created with a warning', async () => {
    const { a } = backend();
    await a.createReleaseOrSprint('release', { ...REL, plannedStartDate: '2026-11-16', plannedEndDate: '2026-11-20' });
    const r = await a.createReleaseOrSprint('sprint', { ...SPR, releaseId: 'RE-45', plannedStartDate: '2026-11-10', plannedEndDate: '2026-11-25' });
    expect(r.warnings.join(' ')).toMatch(/starts \(2026-11-10\) before its release.*ends \(2026-11-25\) after its release/);
  });

  test('a non-admin user gets a clear message; a write that was not stored is reported', async () => {
    await expect(backend({ notAdmin: true }).a.createReleaseOrSprint('release', REL)).rejects.toThrow(/needs an admin user/);
    await expect(backend({ dropWrites: true }).a.createReleaseOrSprint('release', REL)).rejects.toThrow(/not found when read back/);
  });
});

describe('the tools', () => {
  const tools = (adapter: any) => {
    const h = { release_create: async (_a: any): Promise<any> => undefined, sprint_create: async (_a: any): Promise<any> => undefined };
    registerReleaseSprintTools({ registerTool: (n: 'release_create' | 'sprint_create', _d: unknown, fn: any) => { if (n in h) h[n] = fn; } } as any, { getAdapter: () => adapter });
    return h;
  };
  const text = (r: any): string => r.content.map((c: any) => c.text).join('\n');

  test('release_create then sprint_create say what was created and that it was read back', async () => {
    const h = tools(backend().a);
    const rel = await h.release_create(REL);
    expect(rel.isError).toBeFalsy();
    expect(text(rel)).toMatch(/Created release RE-45 "mcp release": state New, 2026-11-16 → 2026-11-16, estimated effort 2 h\. Read back/);
    const spr = await h.sprint_create({ ...SPR, releaseId: 'RE-45' });
    expect(text(spr)).toMatch(/Created sprint SP-1 "mcp sprint" in release RE-45/);
  });

  test('errors and not-connected come back as messages', async () => {
    expect(text(await tools(backend().a).sprint_create(SPR))).toMatch(/needs releaseId/);
    expect(text(await tools(null).release_create(REL))).toMatch(/Not connected/);
  });
});
