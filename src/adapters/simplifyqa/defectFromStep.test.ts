import { SimplifyQaAdapter } from './adapter.js';
import { registerDefectFromStepTools } from '../../tools/defectFromStep.tools.js';

/**
 * EX-170: TC-41 "intentional failure tc" (v1.0) failed at step 7. "Log a defect from step 7" and "link step 7 to DE-60" — driven through the
 * REAL logDefectFromStep / linkDefectToStep against a fake backend that behaves like the product:
 *  - POST /exec/stepResult?from=reports on an existing step result $sets ONLY status, testdata, actualResult, screenShots, defectIds
 *    (anything not sent becomes null — the trap this code must avoid);
 *  - POST /pm/defect refuses a missing name / state / priority and returns the bare document;
 *  - the write-back onto the test case's defectId list can fail without a word.
 */
const ALLOWED_DEFECT = new Set(['name', 'description', 'ownerId', 'projectId', 'state', 'priority', 'severity', 'moduleId', 'userstoryId', 'selectedTestCase',
  'releaseId', 'iterationId', 'attachments', 'networkLogs', 'fromExecution', 'updateVersion']);
const SHOT = { name: 'shot7', original_name: 'Screenshot-7-1.png', url: '/download/SCREENSHOT/170/Screenshot-7-1.png', size: 4096, fileSize: '4KB', type: 'image/png' };

const stepRow = (seq: number, status: string, over: Record<string, unknown> = {}) => ({
  id: `sr${seq}`, stepId: `s${seq}`, seq, reportSeq: seq, stepType: 'NORMAL_STATEMENT', type: 'TC', parentId: 41, executionRunId: 'run1', executionType: 'AUTOMATION', versionId: '410',
  status, description: `step ${seq} text`, testdata: [], actualResult: '', screenShots: [], attachments: [], defectIds: [], platform: [{ name: 'Chrome' }], deleted: false,
  executionId: 170, customerId: 3, ...over,
});
const rows = () => [
  stepRow(1, 'PASSED', { description: 'Launch OrangeHRM' }),
  stepRow(2, 'INFO', { stepType: 'FUNCTION', description: '' }),
  stepRow(3, 'PASSED', { description: 'Login', testdata: [{ paramName: 'user', value: 'Admin' }] }),
  stepRow(7, 'FAILED', {
    description: 'Verify expected_heading in OrangeHRM Dashboard header', testdata: [{ paramName: 'expected_heading', value: 'Dashboard Home' }],
    exception: 'Expected "Dashboard Home" but the header shows "Dashboard"', screenShots: [SHOT], actualResult: 'Dashboard', networkLogs: [],
  }),
];
const tcDoc = (over: Record<string, unknown> = {}) => ({ id: 41, code: 'TC-41', name: 'intentional failure tc', projectId: 19, deleted: false, moduleId: 3, versions: [{ id: 410, name: 'v1.0' }], versionId: '410', defectId: [], ...over });

function backend(opts: { runs?: any[]; stepRows?: any[]; writeBack?: 'works' | 'repairable' | 'fails'; noPrivilege?: boolean; dropScreens?: boolean; defects?: any[]; tcs?: any[]; fieldsFail?: boolean } = {}) {
  const steps = opts.stepRows ?? rows();
  const defects = opts.defects ?? [{ id: 60, code: 'DE-60', name: 'known login bug', projectId: 19, deleted: false, state: 'New', priority: 'Low', selectedTestCase: [], updateVersion: 0 }];
  const tcs = opts.tcs ?? [tcDoc()];
  const posts: Array<{ path: string; body: any }> = [];
  const puts: Array<{ path: string; body: any }> = [];
  const writeBack = opts.writeBack ?? 'works';
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: 'http://backend' };
  a.requireProjectId = () => 19;
  a.ensureUserId = async () => '7';
  a.http = {
    postJson: async (path: string, body: any) => {
      const f = (col: string) => (body?.searchFields ?? []).find((x: any) => x.column === col);
      if (path === '/exec/execution/search') return { data: [{ id: 170, code: 'EX-170', type: 'TC', executionTypeId: 41, releaseId: 5, iterationId: 6, environment: 'UAT', projectId: 19 }] };
      if (path === '/reports/execution/getstepResult') return { data: steps };
      if (path.startsWith('/exec/stepResult?')) {
        posts.push({ path, body });
        for (const el of body) {
          const row = steps.find((s) => s.id === el.id)!;
          // exactly what the backend $sets — anything not sent becomes null
          Object.assign(row, { status: el.status ?? null, testdata: el.testdata ?? null, actualResult: el.actualResult ?? null,
            screenShots: opts.dropScreens ? null : (el.screenShots ?? null), defectIds: el.defectIds ?? null });
        }
        return 'Created Successfully.';
      }
      if (path === '/pm/defect/search') {
        let r = defects.filter((d) => !d.deleted);
        if (f('code')) r = r.filter((d) => d.code === f('code').value);
        if (f('name')?.regEx) r = r.filter((d) => new RegExp(f('name').value, 'i').test(d.name));
        return { data: r };
      }
      if (path === '/tm/testcase/search') return { data: tcs.filter((t) => t.code === f('code')?.value) };
      if (path === '/pm/users/search') return { data: [] };
      if (path === '/pm/defect') {
        posts.push({ path, body });
        if (opts.noPrivilege) throw new Error("Don't Have Privileges to access resources (INVALIDTOKEN)");
        const bad = Object.keys(body).filter((k) => !ALLOWED_DEFECT.has(k));
        if (bad.length) throw new Error(`Validation error: "${bad[0]}" is not allowed`);
        for (const k of ['name', 'state', 'priority', 'projectId']) if (!body[k]) throw new Error(`Validation error: "${k}" is required`);
        const row = { id: 61 + defects.length - 1, code: `DE-${61 + defects.length - 1}`, deleted: false, updateVersion: 0, ...body };
        defects.push(row);
        if (writeBack === 'works') for (const e of body.selectedTestCase ?? []) { const t = tcs.find((x) => x.id === e.testcaseId); if (t && !t.defectId.includes(row.id)) t.defectId.push(row.id); }
        return row;
      }
      throw new Error(`unexpected POST ${path}`);
    },
    getJson: async (path: string) => {
      if (path === '/exec/report/170/19') return opts.runs ?? [{ id: 'run1', status: 'FAILED', executionItemId: 41, testcaseId: 41, versionId: '410' }];
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
        ];
      }
      throw new Error(`unexpected GET ${path}`);
    },
    putJson: async (path: string, body: any) => {
      puts.push({ path, body });
      const bu = /^\/tm\/testcase\/bulkupdate\/(\d+)$/.exec(path);
      if (bu) { if (writeBack === 'fails') throw new Error('still failing'); tcs.find((x) => String(x.id) === bu[1])!.defectId = body.defectId; return {}; }
      const d = defects.find((x) => `/pm/defect/${x.id}` === path)!;
      Object.assign(d, body, { updateVersion: d.updateVersion + 1 });
      if (writeBack === 'works') for (const e of body.selectedTestCase ?? []) { const t = tcs.find((x) => x.id === e.testcaseId); if (t && !t.defectId.includes(d.id)) t.defectId.push(d.id); }
      return {};
    },
  };
  return { a, posts, puts, steps, defects, tcs };
}

describe('log a defect from failed step 7 of EX-170', () => {
  test('pre-filled with test case + version, steps to replicate, execution, environment, browser, error and the screenshot; linked to the step', async () => {
    const { a, posts, steps, tcs, defects } = backend();
    const r = await a.logDefectFromStep({ executionId: 'EX-170', step: 7 });

    const post = posts.find((p) => p.path === '/pm/defect')!.body;
    expect(post).toMatchObject({
      projectId: 19, state: 'New', priority: 'Medium', releaseId: 5, iterationId: 6, moduleId: 3, fromExecution: true,
      name: 'TC-41 step 7 failed: Verify expected_heading in OrangeHRM Dashboard header (EX-170)',
      selectedTestCase: [{ code: 'TC-41', deleted: false, name: 'intentional failure tc', testcaseId: 41, testcaseVersion: [{ deleted: false, version: 410, versionName: 'v1.0' }] }],
    });
    expect(post.attachments).toEqual([SHOT]);
    for (const text of ['EX-170', 'TC-41 (v1.0)', 'Failed step 7', 'Environment: UAT', 'Browser: Chrome', 'Actual:</strong> Dashboard', 'Dashboard Home', 'Steps to replicate', '[PASS]</span> 1. Launch OrangeHRM',
      '[TESTDATA]</span> : user = Admin', '[FAIL]</span> 3. Verify expected_heading']) {
      expect(post.description).toContain(text);
    }
    expect(post.description).not.toContain('FUNCTION');

    // the step result carries the defect — and everything else on it is exactly as it was
    const sr = posts.find((p) => p.path.startsWith('/exec/stepResult'))!;
    expect(sr.path).toBe('/exec/stepResult?executionId=170&projectId=19&from=reports');
    expect(sr.body).toHaveLength(1);
    expect(sr.body[0]).toMatchObject({ id: 'sr7', defectIds: [61], status: 'FAILED', screenShots: [SHOT], actualResult: 'Dashboard' });
    expect(sr.body[0]).not.toHaveProperty('customerId');
    const stored = steps.find((s) => s.id === 'sr7')!;
    expect([stored.defectIds, stored.status, stored.screenShots, stored.actualResult]).toEqual([[61], 'FAILED', [SHOT], 'Dashboard']);
    expect(stored.testdata).toEqual([{ paramName: 'expected_heading', value: 'Dashboard Home' }]);

    expect(tcs[0]!.defectId).toEqual([61]);                 // the test case lists it
    expect(defects.some((d) => d.code === 'DE-61')).toBe(true);
    expect(r).toMatchObject({ defectCode: 'DE-61', execution: 'EX-170', testCase: 'TC-41 (v1.0)', step: 7, attachments: 1, linkedToStep: true, state: 'New', priority: 'Medium' });
    expect(r.warnings).toEqual([]);
  });

  test('name, notes, state / priority / severity (checked), assignee', async () => {
    const { a, posts } = backend();
    await a.logDefectFromStep({ executionId: '170', step: 7, name: 'Dashboard heading wrong', description: 'seen on UAT', priority: 'low', severity: 'critical', state: 'new', assignee: 'me' });
    const post = posts.find((p) => p.path === '/pm/defect')!.body;
    expect(post).toMatchObject({ name: 'Dashboard heading wrong', priority: 'Low', severity: 'Critical', state: 'New', ownerId: [7] });
    expect(post.description).toContain('seen on UAT');
    await expect(backend().a.logDefectFromStep({ executionId: '170', step: 7, priority: 'Banana' })).rejects.toThrow(/not a defect priority.*Low, Medium/s);
  });

  test('the test case\'s own list: a silent write-back failure is repaired; if that fails too, it is reported', async () => {
    const fixed = backend({ writeBack: 'repairable' });
    const r1 = await fixed.a.logDefectFromStep({ executionId: 'EX-170', step: 7 });
    expect(fixed.puts.map((p) => p.path)).toEqual(['/tm/testcase/bulkupdate/41']);
    expect(fixed.tcs[0]!.defectId).toEqual([61]);
    expect(r1.warnings).toEqual([]);
    const broken = backend({ writeBack: 'fails' });
    const r2 = await broken.a.logDefectFromStep({ executionId: 'EX-170', step: 7 });
    expect(r2.warnings.join(' ')).toMatch(/TC-41 \(v1\.0\).*does not show DE-61/);
  });

  test('refused with a message: a passed step, a missing step, an unknown execution, several test cases, a duplicate name, no privilege', async () => {
    await expect(backend().a.logDefectFromStep({ executionId: 'EX-170', step: 1 })).rejects.toThrow(/Step 1 of EX-170 is passed, not failed/);
    await expect(backend().a.logDefectFromStep({ executionId: 'EX-170', step: 99 })).rejects.toThrow(/no step 99.*1:passed.*7:failed/s);
    await expect(backend().a.logDefectFromStep({ executionId: 'abc', step: 7 })).rejects.toThrow(/not an execution id/);
    const two = backend({ runs: [{ id: 'run1', executionItemId: 41, testcaseId: 41 }, { id: 'run2', executionItemId: 42, testcaseId: 42 }] });
    await expect(two.a.logDefectFromStep({ executionId: 'EX-170', step: 7 })).rejects.toThrow(/ran 2 test cases.*Say which one with `tc`/);
    const dup = backend({ defects: [{ id: 60, code: 'DE-60', name: 'TC-41 step 7 failed: Verify expected_heading in OrangeHRM Dashboard header (EX-170)', projectId: 19, deleted: false, selectedTestCase: [] }] });
    await expect(dup.a.logDefectFromStep({ executionId: 'EX-170', step: 7 })).rejects.toThrow(/already exists: DE-60.*defect_link_step/s);
    expect(dup.posts.filter((p) => p.path === '/pm/defect')).toEqual([]);
    await expect(backend({ noPrivilege: true }).a.logDefectFromStep({ executionId: 'EX-170', step: 7 })).rejects.toThrow(/needs the "add_defect" privilege/);
  });

  test('a failed step without a screenshot is logged with a warning; the project\'s defaults unreadable → asks for state / priority', async () => {
    const noShot = backend({ stepRows: rows().map((r) => (r.seq === 7 ? { ...r, screenShots: [] } : r)) });
    const r = await noShot.a.logDefectFromStep({ executionId: 'EX-170', step: 7 });
    expect(r.warnings.join(' ')).toMatch(/no screenshot/);
    await expect(backend({ fieldsFail: true }).a.logDefectFromStep({ executionId: 'EX-170', step: 7 })).rejects.toThrow(/could not be read, and state is required/);
  });
});

describe('link failed step 7 to the existing defect DE-60', () => {
  test('the step carries DE-60, DE-60 lists TC-41 (v1.0), TC-41 lists DE-60; the step\'s data is untouched', async () => {
    const { a, posts, puts, steps, defects, tcs } = backend();
    const r = await a.linkDefectToStep({ executionId: 'EX-170', step: 7, defectId: 'DE-60' });
    const stored = steps.find((s) => s.id === 'sr7')!;
    expect([stored.defectIds, stored.status, stored.screenShots, stored.actualResult]).toEqual([[60], 'FAILED', [SHOT], 'Dashboard']);
    expect(posts.filter((p) => p.path.startsWith('/exec/stepResult'))).toHaveLength(1);
    expect(puts[0]!.path).toBe('/pm/defect/60');
    expect(defects[0]!.selectedTestCase[0]).toMatchObject({ testcaseId: 41, code: 'TC-41', testcaseVersion: [{ version: 410, versionName: 'v1.0' }] });
    expect(tcs[0]!.defectId).toEqual([60]);
    expect(r).toMatchObject({ defectCode: 'DE-60', execution: 'EX-170', testCase: 'TC-41 (v1.0)', step: 7, stepLinked: true, testCaseLinked: true });
    expect(r.warnings).toEqual([]);
  });

  test('linking again changes nothing and writes nothing; an already-listed test case is not re-sent', async () => {
    const { a, posts, puts } = backend();
    await a.linkDefectToStep({ executionId: 'EX-170', step: 7, defectId: 'DE-60' });
    posts.length = 0; puts.length = 0;
    const again = await a.linkDefectToStep({ executionId: 'EX-170', step: 7, defectId: 'DE-60' });
    expect(again).toMatchObject({ stepLinked: false, testCaseLinked: false });
    expect(posts).toEqual([]);
    expect(puts).toEqual([]);
  });

  test('found by id, code or name; unknown defect, a passed step, and a step linked to several defects', async () => {
    for (const ref of ['60', 'de_60', 'known login bug']) expect((await backend().a.linkDefectToStep({ executionId: 'EX-170', step: 7, defectId: ref })).defectCode).toBe('DE-60');
    await expect(backend().a.linkDefectToStep({ executionId: 'EX-170', step: 7, defectId: 'DE-99' })).rejects.toThrow(/No defect "DE-99"/);
    await expect(backend().a.linkDefectToStep({ executionId: 'EX-170', step: 3, defectId: 'DE-60' })).rejects.toThrow(/Step 3 of EX-170 is passed/);
    const some = backend({ stepRows: rows().map((r) => (r.seq === 7 ? { ...r, defectIds: [55] } : r)) });
    await some.a.linkDefectToStep({ executionId: 'EX-170', step: 7, defectId: 'DE-60' });
    expect(some.steps.find((s) => s.id === 'sr7')!.defectIds).toEqual([55, 60]);
  });

  test('if the save were to change the step\'s own data, it is reported instead of trusted', async () => {
    const { a } = backend({ dropScreens: true });
    await expect(a.linkDefectToStep({ executionId: 'EX-170', step: 7, defectId: 'DE-60' })).rejects.toThrow(/changed the step's screenShots/);
  });
});

describe('the tools', () => {
  const tools = (adapter: any) => {
    const h = { defect_create_from_step: async (_a: any): Promise<any> => undefined, defect_link_step: async (_a: any): Promise<any> => undefined };
    registerDefectFromStepTools({ registerTool: (n: 'defect_create_from_step' | 'defect_link_step', _d: unknown, fn: any) => { h[n] = fn; } } as any, { getAdapter: () => adapter });
    return h;
  };
  const text = (r: any): string => r.content.map((c: any) => c.text).join('\n');

  test('log: names the defect, the step, the test case, and says it is linked', async () => {
    const r = await tools(backend().a).defect_create_from_step({ executionId: 'EX-170', step: 7 });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/Logged defect DE-61 ".*" from step 7 of EX-170 \(TC-41 \(v1\.0\)\).*1 attachment; linked to step 7\./);
  });

  test('link: says what changed; errors and not-connected come back as messages', async () => {
    const h = tools(backend().a);
    expect(text(await h.defect_link_step({ executionId: 'EX-170', step: 7, defectId: 'DE-60' }))).toMatch(/step 7 of EX-170 is now linked to DE-60; TC-41 \(v1\.0\) was added to the defect's test cases/);
    expect(text(await tools(backend().a).defect_link_step({ executionId: 'EX-170', step: 1, defectId: 'DE-60' }))).toMatch(/not failed/);
    expect(text(await tools(null).defect_create_from_step({ executionId: 'EX-170', step: 7 }))).toMatch(/Not connected/);
  });
});
