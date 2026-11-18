import { SimplifyQaAdapter } from './adapter.js';
import { registerDefectUpdateTool } from '../../tools/defectUpdate.tools.js';

/**
 * "Log a defect through the MCP" — driven through the REAL createDefect against a fake backend that behaves like the project-management defect
 * service: name / state / priority / projectId required, no unknown keys, a duplicate name refused, mandatory custom fields enforced for a defect not
 * logged from an execution, the bare document returned, and a write-back onto the test case that can fail without a word.
 */
const ALLOWED = new Set(['name', 'description', 'ownerId', 'projectId', 'state', 'priority', 'severity', 'category', 'moduleId', 'userstoryId', 'selectedTestCase',
  'releaseId', 'iterationId', 'estimatedEffort', 'customFields', 'fromExecution', 'attachments', 'networkLogs']);
const USERS = [{ id: 42, name: 'Rohini K', email: 'rohini.k@simplify3x.com' }];
const RELEASES = [{ id: 5, code: 'RE-5', name: 'demo release', state: 'New', projectIds: [19] }];
const SPRINTS = [{ id: 6, code: 'SP-6', name: 'sprint six', state: 'New', releaseId: 5 }];
const tc = (id: number, code: string, versions: any[]) => ({ id, code, name: `${code} name`, projectId: 19, deleted: false, versions, versionId: String(versions[0].id), defectId: [] as number[] });

function backend(opts: { defects?: any[]; tcs?: any[]; writeBack?: 'works' | 'fails'; noPrivilege?: boolean; mandatory?: string[]; fieldsFail?: boolean; dropWrites?: boolean } = {}) {
  const defects = opts.defects ?? [];
  const tcs = opts.tcs ?? [tc(41, 'TC-41', [{ id: 410, name: 'v1.0' }])];
  const posts: any[] = [];
  const puts: any[] = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: 'http://backend' };
  a.requireProjectId = () => 19;
  a.ensureUserId = async () => '7';
  a.resolveModuleId = async (ref: string) => { if (/^default module$/i.test(ref)) return 3; if (/^qa$/i.test(ref)) return 8; throw new Error(`Module "${ref}" was not found`); };
  a.resolveStoryNumericId = async (ref: string) => { if (ref === 'US_25') return '25'; throw new Error(`Story not found for business key: ${ref}`); };
  a.http = {
    postJson: async (path: string, body: any) => {
      const f = (col: string) => (body?.searchFields ?? []).find((x: any) => x.column === col);
      if (path === '/pm/defect/search') {
        let r = defects.filter((d) => !d.deleted);
        if (f('name')?.regEx) r = r.filter((d) => new RegExp(f('name').value, 'i').test(d.name));
        return { data: r };
      }
      if (path === '/pm/release/search') return { data: RELEASES };
      if (path === '/pm/sprint/search') return { data: SPRINTS };
      if (path === '/tm/testcase/search') return { data: tcs.filter((t) => t.code === f('code')?.value) };
      if (path === '/pm/users/search') {
        const q = body.searchFields.find((x: any) => x.column === 'email' || x.column === 'name');
        return { data: USERS.filter((u) => String((u as any)[q.column]).toLowerCase() === String(q.value).toLowerCase()) };
      }
      if (path === '/pm/defect') {
        posts.push(body);
        if (opts.noPrivilege) throw new Error("Don't Have Privileges to access resources (INVALIDTOKEN)");
        const bad = Object.keys(body).filter((k) => !ALLOWED.has(k));
        for (const k of ['name', 'state', 'priority', 'projectId']) if (!body[k]) throw new Error(`Validation error: "${k}" is required`);
        if (bad.length) throw new Error(`Validation error: "${bad[0]}" is not allowed`);
        for (const k of opts.mandatory ?? []) if (body.customFields?.[k] === undefined) throw new Error(`Mandatory custom field "${k}" is required`);
        const row = { id: 61 + defects.length, code: `DE-${61 + defects.length}`, deleted: false, updateVersion: 0, ...body };
        if (!opts.dropWrites) defects.push(row);
        if (opts.writeBack !== 'fails') for (const e of body.selectedTestCase ?? []) { const t = tcs.find((x) => x.id === e.testcaseId); if (t && !t.defectId.includes(row.id)) t.defectId.push(row.id); }
        return row;
      }
      throw new Error(`unexpected POST ${path}`);
    },
    getJson: async (path: string) => {
      let m = /^\/pm\/defect\/(\d+)$/.exec(path);
      if (m) { const d = defects.find((x) => String(x.id) === m![1]); return d ? [d] : []; }
      m = /^\/tm\/testcase\/getById\/(\d+)$/.exec(path);
      if (m) { const t = tcs.find((x) => String(x.id) === m![1]); return { data: t ? [t] : [] }; }
      if (/^\/pm\/fields\/9\?/.test(path)) {
        if (opts.fieldsFail) throw new Error('boom');
        return [
          { key: 'state', values: [{ key: 'New', value: 'New', isDefault: true }, { key: 'Closed', value: 'Closed' }] },
          { key: 'priority', values: [{ key: 'Low', value: 'Low' }, { key: 'Medium', value: 'Medium', isDefault: true }] },
          { key: 'severity', values: [{ key: 'Minor', value: 'Minor' }, { key: 'Critical', value: 'Critical' }] },
          { key: 'category', values: [{ key: 'Functional', value: 'Functional' }, { key: 'UI', value: 'UI' }] },
        ];
      }
      throw new Error(`unexpected GET ${path}`);
    },
    putJson: async (path: string, body: any) => {
      puts.push({ path, body });
      const bu = /^\/tm\/testcase\/bulkupdate\/(\d+)$/.exec(path);
      if (bu) { if (opts.writeBack === 'fails') throw new Error('still failing'); tcs.find((x) => String(x.id) === bu[1])!.defectId = body.defectId; return {}; }
      throw new Error(`unexpected PUT ${path}`);
    },
  };
  return { a, posts, puts, defects, tcs };
}

describe('log a defect', () => {
  test('only a name: state and priority are the project\'s defaults, the Default module is used, and the answer says what was defaulted', async () => {
    const { a, posts, defects } = backend();
    const r = await a.createDefect({ name: 'Login button misaligned' });
    expect(posts[0]).toEqual({ projectId: 19, name: 'Login button misaligned', state: 'New', priority: 'Medium', description: '', moduleId: 3, customFields: {} });
    expect(r).toMatchObject({ defectCode: 'DE-61', name: 'Login button misaligned', state: 'New', priority: 'Medium', testCases: [] });
    expect(r.defaults).toEqual(['state New', 'priority Medium']);
    expect(defects).toHaveLength(1);
  });

  test('every field: description, severity, category, assignee, release / sprint, USER STORY, TEST CASE (with its version), module, effort, custom fields', async () => {
    const { a, posts, tcs } = backend();
    const r = await a.createDefect({
      name: 'Heading wrong on dashboard', description: 'seen on UAT', state: 'new', priority: 'low', severity: 'critical', category: 'ui',
      assignee: 'rohini.k@simplify3x.com', releaseId: 'RE-5', sprintId: 'SP-6', storyId: 'US-25', testCases: ['TC-41:v1.0'], module: 'QA', estimatedEffort: 2,
      customFields: { env: 'UAT' },
    });
    expect(posts[0]).toEqual({
      projectId: 19, name: 'Heading wrong on dashboard', description: 'seen on UAT', state: 'New', priority: 'Low', severity: 'Critical', category: 'UI',
      ownerId: [42], releaseId: 5, iterationId: 6, userstoryId: 25, moduleId: 8, estimatedEffort: 2, customFields: { env: 'UAT' },
      selectedTestCase: [{ code: 'TC-41', deleted: false, name: 'TC-41 name', testcaseId: 41, testcaseVersion: [{ deleted: false, version: 410, versionName: 'v1.0' }] }],
    });
    expect(r).toMatchObject({ defectCode: 'DE-61', severity: 'Critical', testCases: ['TC-41 (v1.0)'], storyId: 25 });
    expect(r.defaults).toEqual([]);
    expect(tcs[0]!.defectId).toEqual([61]);
  });

  test('"me" as the assignee; a module name the project does not have falls back to nothing instead of failing', async () => {
    const { a, posts } = backend();
    a.resolveModuleId = async () => { throw new Error('no such module'); };
    await a.createDefect({ name: 'Another defect', assignee: 'me' });
    expect(posts[0].ownerId).toEqual([7]);
    expect(posts[0]).not.toHaveProperty('moduleId');
  });

  test('the test case\'s own list: a silent write-back failure is repaired; if that fails too it is reported', async () => {
    const fixed = backend({ writeBack: 'fails' });
    fixed.a.http.putJson = async (path: string, body: any) => { fixed.puts.push({ path, body }); fixed.tcs[0]!.defectId = body.defectId; return {}; };
    const r1 = await fixed.a.createDefect({ name: 'Needs repair', testCases: ['TC-41'] });
    expect(fixed.puts.map((p) => p.path)).toEqual(['/tm/testcase/bulkupdate/41']);
    expect(r1.warnings).toEqual([]);
    const broken = backend({ writeBack: 'fails' });
    const r2 = await broken.a.createDefect({ name: 'Cannot repair', testCases: ['TC-41'] });
    expect(r2.warnings.join(' ')).toMatch(/TC-41 \(v1\.0\).*does not show DE-61/);
  });
});

describe('refused or explained instead of an opaque failure', () => {
  test('bad inputs are refused before anything is sent', async () => {
    const { a, posts } = backend();
    await expect(a.createDefect({ name: 'ab' })).rejects.toThrow(/3–500 characters/);
    await expect(a.createDefect({ name: 'Bad state', state: 'Banana' })).rejects.toThrow(/not a defect state.*New, Closed/s);
    await expect(a.createDefect({ name: 'Bad severity', severity: 'Huge' })).rejects.toThrow(/not a defect severity.*Minor, Critical/s);
    await expect(a.createDefect({ name: 'Bad story', storyId: 'US-404' })).rejects.toThrow(/No user story "US-404"/);
    await expect(a.createDefect({ name: 'Bad assignee', assignee: 'nobody@nowhere.com' })).rejects.toThrow(/No user matches/);
    await expect(a.createDefect({ name: 'Bad tc', testCases: ['TC-99'] })).rejects.toThrow(/No test case "TC-99"/);
    await expect(a.createDefect({ name: 'Bad version', testCases: ['TC-41:v9'] })).rejects.toThrow(/no version "v9"/);
    await expect(a.createDefect({ name: 'Bad release', releaseId: 'RE-99' })).rejects.toThrow(/No release "RE-99"/);
    expect(posts).toEqual([]);
  });

  test('a duplicate name; no privilege; the project\'s mandatory custom fields; the defaults unreadable; a write that was not stored', async () => {
    const dup = backend({ defects: [{ id: 60, code: 'DE-60', name: 'Login button misaligned', deleted: false }] });
    await expect(dup.a.createDefect({ name: 'login button MISALIGNED' })).rejects.toThrow(/already exists in this project: DE-60/);
    expect(dup.posts).toEqual([]);
    await expect(backend({ noPrivilege: true }).a.createDefect({ name: 'Denied defect' })).rejects.toThrow(/needs the "add_defect" privilege/);
    const mand = backend({ mandatory: ['env'] });
    await expect(mand.a.createDefect({ name: 'Needs custom field' })).rejects.toThrow(/requires custom fields.*Mandatory custom field "env".*customFields/s);
    await mand.a.createDefect({ name: 'Has custom field', customFields: { env: 'UAT' } });
    expect(mand.posts.at(-1).customFields).toEqual({ env: 'UAT' });
    await expect(backend({ fieldsFail: true }).a.createDefect({ name: 'No defaults' })).rejects.toThrow(/could not be read, and state is required/);
    const given = backend({ fieldsFail: true });
    await given.a.createDefect({ name: 'Values given', state: 'Open', priority: 'High' });
    expect(given.posts[0]).toMatchObject({ state: 'Open', priority: 'High' });
    await expect(backend({ dropWrites: true }).a.createDefect({ name: 'Lost defect' })).rejects.toThrow(/could not be read back/);
  });
});

describe('the defect_create tool', () => {
  const tool = (adapter: any) => {
    const h: Record<string, (a: any) => Promise<any>> = {};
    registerDefectUpdateTool({ registerTool: (n: string, _d: unknown, fn: any) => { h[n] = fn; } } as any, { getAdapter: () => adapter });
    return h['defect_create']!;
  };
  const text = (r: any): string => r.content.map((c: any) => c.text).join('\n');

  test('names the defect, what it carries, what was defaulted, and says it was read back', async () => {
    const r = await tool(backend().a)({ name: 'Heading wrong', testCases: ['TC-41:v1.0'], storyId: 'US-25' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/Logged defect DE-61 "Heading wrong" — state New, priority Medium, test case TC-41 \(v1\.0\), user story #25\. Read back from SimplifyQA/);
    expect(text(r)).toMatch(/Defaulted \(not given\): state New; priority Medium\./);
  });

  test('errors and not-connected come back as messages', async () => {
    expect(text(await tool(backend().a)({ name: 'x' }))).toMatch(/3–500 characters/);
    expect(text(await tool(null)({ name: 'A defect' }))).toMatch(/Not connected/);
  });
});
