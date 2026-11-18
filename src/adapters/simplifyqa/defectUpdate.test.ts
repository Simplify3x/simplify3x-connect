import { SimplifyQaAdapter } from './adapter.js';
import { registerDefectUpdateTool } from '../../tools/defectUpdate.tools.js';

/**
 * "Set DE-61's User Story to US-25 and Test Case to TC-41 (v1.0)" — driven through the REAL updateDefect against a fake backend that behaves
 * like the project-management defect service: partial PUT (whole-body key validation, version check, $set), selectedTestCase entries as the
 * form stores them, and a write-back onto the test case's `defectId` list that — as in the product — can fail without telling anyone.
 */
const ALLOWED = new Set(['name', 'description', 'ownerId', 'projectId', 'featureId', 'state', 'priority', 'severity', 'category', 'moduleId', 'userstoryId',
  'selectedTestCase', 'releaseId', 'iterationId', 'estimatedEffort', 'tags', 'customFields', 'updateVersion']);
const USERS = [{ id: 42, name: 'Rohini K', email: 'rohini.k@simplify3x.com' }];
const RELEASES = [{ id: 5, code: 'RE-5', name: 'demo release', state: 'New', projectIds: [19] }];
const SPRINTS = [{ id: 6, code: 'SP-6', name: 'prefixXzQsuffix', state: 'New', releaseId: 5 }];

const defect = (over: Record<string, unknown> = {}) => ({
  id: 61, code: 'DE-61', name: 'deNzPfect', projectId: 19, deleted: false, state: 'New', priority: 'Low', severity: 'Minor', ownerId: [], releaseId: 5, iterationId: 6,
  userstoryId: null, selectedTestCase: [], updateVersion: 3, ...over,
});
const tc = (id: number, code: string, versions: any[], over: Record<string, unknown> = {}) => ({ id, code, name: `${code} name`, projectId: 19, deleted: false, versions, versionId: String(versions[0].id), defectId: [], ...over });

function backend(opts: { defects?: any[]; tcs?: any[]; writeBack?: 'works' | 'fails' | 'repairable'; noPrivilege?: boolean; staleOnce?: boolean; ignorePut?: boolean; fieldsFail?: boolean } = {}) {
  const defects = opts.defects ?? [defect()];
  const tcs = opts.tcs ?? [tc(41, 'TC-41', [{ id: 410, name: 'v1.0' }])];
  const puts: Array<{ path: string; body: any }> = [];
  let stale = opts.staleOnce === true;
  const writeBack = opts.writeBack ?? 'works';
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: 'http://backend' };
  a.requireProjectId = () => 19;
  a.ensureUserId = async () => '7';
  a.http = {
    postJson: async (path: string, body: any) => {
      const f = (col: string) => (body.searchFields ?? []).find((x: any) => x.column === col);
      if (path === '/pm/defect/search') {
        let rows = defects.filter((d) => !d.deleted);
        if (f('code')) rows = rows.filter((d) => d.code === f('code').value);
        if (f('name')?.regEx) rows = rows.filter((d) => new RegExp(f('name').value, 'i').test(d.name));
        return { data: rows };
      }
      if (path === '/pm/userstory/search') return { data: String(f('code')?.value).toUpperCase().replace('_', '-') === 'US-25' && f('code').value === 'US_25' ? [{ id: 25, code: 'US_25' }] : [] };
      if (path === '/tm/testcase/search') return { data: tcs.filter((t) => t.code === f('code')?.value) };
      if (path === '/pm/users/search') {
        const q = (body.searchFields).find((x: any) => x.column === 'email' || x.column === 'name');
        return { data: USERS.filter((u) => String((u as any)[q.column]).toLowerCase() === String(q.value).toLowerCase()) };
      }
      if (path === '/pm/release/search') return { data: RELEASES };
      if (path === '/pm/sprint/search') return { data: SPRINTS };
      throw new Error(`unexpected POST ${path}`);
    },
    getJson: async (path: string) => {
      let m = /^\/pm\/defect\/(\d+)$/.exec(path);
      if (m) { const d = defects.find((x) => String(x.id) === m![1]); return d ? [d] : []; }
      m = /^\/tm\/testcase\/getById\/(\d+)$/.exec(path);
      if (m) { const t = tcs.find((x) => String(x.id) === m![1]); return t ? { data: [t] } : { data: [] }; }
      if (/^\/pm\/fields\/9\?/.test(path)) {
        if (opts.fieldsFail) throw new Error('boom');
        return [
          { key: 'state', values: [{ key: 'New', value: 'New' }, { key: 'In-progress', value: 'In-progress' }, { key: 'Closed', value: 'Closed' }] },
          { key: 'priority', values: [{ key: 'Low', value: 'Low' }, { key: 'High', value: 'High' }] },
          { key: 'severity', values: [{ key: 'Minor', value: 'Minor' }, { key: 'Critical', value: 'Critical' }] },
        ];
      }
      throw new Error(`unexpected GET ${path}`);
    },
    putJson: async (path: string, body: any) => {
      puts.push({ path, body });
      let m = /^\/tm\/testcase\/bulkupdate\/(\d+)$/.exec(path);
      if (m) {
        if (writeBack === 'fails') throw new Error('still failing');
        const t = tcs.find((x) => String(x.id) === m![1])!;
        t.defectId = body.defectId;
        return {};
      }
      if (opts.noPrivilege) throw new Error("Don't Have Privileges to access resources (INVALIDTOKEN)");
      const bad = Object.keys(body).filter((k) => !ALLOWED.has(k));
      if (bad.length) throw new Error(`validation error: "${bad[0]}" is not allowed`);
      const row = defects.find((x) => `/pm/defect/${x.id}` === path)!;
      if (stale) { stale = false; row.updateVersion += 1; }
      if (body.updateVersion !== row.updateVersion) throw new Error('Concurrency Error (CONCURRENCY)');
      if (!opts.ignorePut) {
        Object.assign(row, body, { updateVersion: row.updateVersion + 1 });
        if (writeBack === 'works') for (const e of body.selectedTestCase ?? []) { const t = tcs.find((x) => x.id === e.testcaseId); if (t && !t.defectId.includes(row.id)) t.defectId.push(row.id); }
        // 'repairable' / 'fails': the backend's write-back onto the test case is swallowed, so nothing is written there
      }
      return { status: true };
    },
  };
  return { a, puts, defects, tcs };
}

describe('DE-61: USER STORY = US-25 and TEST CASE = TC-41 (v1.0)', () => {
  test('the form fields are set as the form stores them, the defect reads back, the test case lists the defect', async () => {
    const { a, puts, defects, tcs } = backend();
    // the story's business key in this project is written with an underscore: US-25 is found through the other separator
    const r = await a.updateDefect('DE-61', { storyId: 'US-25', testCases: ['TC-41:v1.0'] });
    expect(puts).toHaveLength(1);
    expect(puts[0]!.path).toBe('/pm/defect/61');
    expect(puts[0]!.body).toEqual({
      projectId: 19, updateVersion: 3, userstoryId: 25,
      selectedTestCase: [{ code: 'TC-41', deleted: false, name: 'TC-41 name', testcaseId: 41, testcaseVersion: [{ deleted: false, version: 410, versionName: 'v1.0' }] }],
    });
    expect(r.written).toBe(true);
    expect(r.changes).toEqual([
      { field: 'user story', from: '(none)', to: 'US-25' },
      { field: 'test case', from: '(none)', to: 'TC-41 (v1.0)' },
    ]);
    expect(r.warnings).toEqual([]);
    expect([defects[0]!.userstoryId, defects[0]!.selectedTestCase[0].testcaseId]).toEqual([25, 41]);
    expect(tcs[0]!.defectId).toEqual([61]);
  });

  test('when the backend\'s write-back onto the test case silently fails, it is redone through the same endpoint', async () => {
    const { a, puts, tcs } = backend({ writeBack: 'repairable' });
    // the fake lets the bulkupdate repair through ('repairable' only skips the backend's own write-back)
    const r = await a.updateDefect('DE-61', { testCases: ['TC-41'] });
    expect(puts.map((p) => p.path)).toEqual(['/pm/defect/61', '/tm/testcase/bulkupdate/41']);
    expect(puts[1]!.body).toEqual({ projectId: 19, defectId: [61] });
    expect(tcs[0]!.defectId).toEqual([61]);
    expect(r.warnings).toEqual([]);
  });

  test('if the repair fails too, the result says the test case does not show the defect', async () => {
    const { a } = backend({ writeBack: 'fails' });
    const r = await a.updateDefect('DE-61', { testCases: ['TC-41'] });
    expect(r.written).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/TC-41 \(v1\.0\).*does not show DE-61/);
  });
});

describe('the TEST CASE field', () => {
  const two = () => backend({ tcs: [tc(41, 'TC-41', [{ id: 410, name: 'v1.0' }, { id: 411, name: 'v2.0' }], { versionId: '411' }), tc(42, 'TC-42', [{ id: 420, name: 'v1.0' }])] });

  test('no version given: the test case\'s current one, and the answer says which', async () => {
    const { a, puts } = two();
    const r = await a.updateDefect('DE-61', { testCases: ['TC-41'] });
    expect(puts[0]!.body.selectedTestCase[0].testcaseVersion[0]).toMatchObject({ version: 411, versionName: 'v2.0' });
    expect(r.warnings.join(' ')).toMatch(/TC-41: no version given, used v2\.0 \(the test case has v1\.0, v2\.0\)/);
  });

  test('adding keeps what is there; the same test case with another version replaces its entry; remove and clear', async () => {
    const { a, defects } = two();
    await a.updateDefect('DE-61', { testCases: ['TC-41:v1.0'] });
    await a.updateDefect('DE-61', { testCases: ['TC-42'] });
    expect(defects[0]!.selectedTestCase.map((e: any) => e.code)).toEqual(['TC-41', 'TC-42']);
    await a.updateDefect('DE-61', { testCases: ['TC-41:v2.0'] });
    expect(defects[0]!.selectedTestCase.map((e: any) => `${e.code}:${e.testcaseVersion[0].versionName}`)).toEqual(['TC-41:v2.0', 'TC-42:v1.0']);
    const rm = await a.updateDefect('DE-61', { removeTestCases: ['TC-42'] });
    expect(defects[0]!.selectedTestCase.map((e: any) => e.code)).toEqual(['TC-41']);
    expect(rm.warnings.join(' ')).toMatch(/does not remove the defect from the removed test case/);
    await a.updateDefect('DE-61', { clearTestCases: true });
    expect(defects[0]!.selectedTestCase).toEqual([]);
  });

  test('unknown test case or version is refused before anything is sent', async () => {
    const { a, puts } = two();
    await expect(a.updateDefect('DE-61', { testCases: ['TC-99'] })).rejects.toThrow(/No test case "TC-99"/);
    await expect(a.updateDefect('DE-61', { testCases: ['TC-41:v9.9'] })).rejects.toThrow(/no version "v9\.9". Versions: v1\.0, v2\.0/);
    expect(puts).toEqual([]);
  });
});

describe('the other fields and the failure modes', () => {
  test('state / priority / severity matched to the project\'s values (an unknown one refused), assignee by email, release / sprint', async () => {
    const { a, defects } = backend();
    await a.updateDefect('DE-61', { state: 'in progress', priority: 'high', severity: 'critical', assignee: 'rohini.k@simplify3x.com' });
    expect([defects[0]!.state, defects[0]!.priority, defects[0]!.severity, defects[0]!.ownerId]).toEqual(['In-progress', 'High', 'Critical', [42]]);
    await expect(backend().a.updateDefect('DE-61', { state: 'Banana' })).rejects.toThrow(/not a defect state.*New, In-progress, Closed/s);
    const un = backend({ defects: [defect({ ownerId: [42] })] });
    await un.a.updateDefect('DE-61', { unassign: true });
    expect(un.defects[0]!.ownerId).toEqual([]);
    const rel = backend();
    await rel.a.updateDefect('DE-61', { releaseId: 'none' });
    expect([rel.defects[0]!.releaseId, rel.defects[0]!.iterationId]).toEqual([null, null]);
  });

  test('found by id, code or exact name; unknown / other-project / unknown story / unknown assignee are refused', async () => {
    for (const ref of ['61', 'DE-61', 'de_61', 'deNzPfect']) expect((await backend().a.updateDefect(ref, { priority: 'High' })).code).toBe('DE-61');
    await expect(backend().a.updateDefect('DE-99', { priority: 'High' })).rejects.toThrow(/No defect "DE-99"/);
    await expect(backend({ defects: [defect({ projectId: 77 })] }).a.updateDefect('61', { priority: 'High' })).rejects.toThrow(/No defect/);
    await expect(backend().a.updateDefect('DE-61', { storyId: 'US-404' })).rejects.toThrow(/No user story "US-404"/);
    await expect(backend().a.updateDefect('DE-61', { assignee: 'nobody@nowhere.com' })).rejects.toThrow(/No user matches/);
  });

  test('nothing different → nothing written; no privilege; a stale version is retried; an unapplied save is reported', async () => {
    const same = backend({ defects: [defect({ userstoryId: 25 })] });
    expect((await same.a.updateDefect('DE-61', { storyId: 'US-25', priority: 'low' })).written).toBe(false);
    expect(same.puts).toEqual([]);
    await expect(backend({ noPrivilege: true }).a.updateDefect('DE-61', { priority: 'High' })).rejects.toThrow(/needs the "add_defect" privilege/);
    const stale = backend({ staleOnce: true });
    await stale.a.updateDefect('DE-61', { priority: 'High' });
    expect(stale.puts.map((p) => p.body.updateVersion)).toEqual([3, 4]);
    await expect(backend({ ignorePut: true }).a.updateDefect('DE-61', { priority: 'High' })).rejects.toThrow(/"priority" was sent as "High" but reads back as "Low"/);
    const pass = backend({ fieldsFail: true });
    await pass.a.updateDefect('DE-61', { state: 'Whatever' });
    expect(pass.defects[0]!.state).toBe('Whatever');
  });
});

describe('the defect_update tool', () => {
  const tool = (adapter: any) => {
    let handler: (a: any) => Promise<any> = async () => undefined;
    registerDefectUpdateTool({ registerTool: (n: string, _d: unknown, h: any) => { if (n === 'defect_update') handler = h; } } as any, { getAdapter: () => adapter });
    return handler;
  };
  const text = (r: any): string => r.content.map((c: any) => c.text).join('\n');

  test('lists each change and says it was read back', async () => {
    const r = await tool(backend().a)({ defectId: 'DE-61', storyId: 'US-25', testCases: ['TC-41:v1.0'] });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/Updated defect DE-61 "deNzPfect" and read it back from SimplifyQA/);
    expect(text(r)).toMatch(/- user story: \(none\) → US-25/);
    expect(text(r)).toMatch(/- test case: \(none\) → TC-41 \(v1\.0\)/);
  });

  test('needs a change; assignee and unassign together are refused; not connected', async () => {
    const h = tool(backend().a);
    expect(text(await h({ defectId: 'DE-61' }))).toMatch(/needs something to change/);
    expect(text(await h({ defectId: 'DE-61', assignee: 'me', unassign: true }))).toMatch(/either assignee or unassign/);
    expect(text(await tool(null)({ defectId: 'DE-61', priority: 'High' }))).toMatch(/Not connected/);
  });
});
