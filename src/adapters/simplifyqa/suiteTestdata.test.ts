import { SimplifyQaAdapter } from './adapter.js';

/** Adapter with a stateful fake backend for the SUITE-level testdata endpoints. */
function setup() {
  const td = {
    id: 'td-1', type: 'SU', suiteId: 24, projectId: 2, executionType: 'AUTOMATION',
    defaultIteration: { general: 'itr-1' }, updateVersion: 3,
  };
  let rows: any[] = [{
    id: 'itr-1', name: 'ITR-1', sequenceNo: 1, isChecked: true, type: 'SU', environmentType: 'general',
    data: [{ paramId: 101, value: 'GRP-1' }, { paramId: 102, value: 'LOB-1' }],
  }];
  const calls: Array<{ method: string; path: string; body: any }> = [];
  let nextId = 1;
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: 'https://x', projectId: '2' };
  a.requireProjectId = () => 2;
  a.resolveEnvironment = async (_p: number, env: string) => env || 'general';
  a.resolveParameterNames = async (ids: string[]) => new Map(ids.map((id) => [id, id === '101' ? 'casegroupname' : id === '102' ? 'lob_runtime' : id]));
  a.http = {
    postJson: async (path: string, body: any) => {
      calls.push({ method: 'POST', path, body });
      if (path === '/tm/testdata/searchTd') return { data: [td] };
      if (path === '/tm/testdata/getIteration') return { data: rows };
      throw new Error(`unexpected POST ${path}`);
    },
    putJson: async (path: string, body: any) => {
      calls.push({ method: 'PUT', path, body });
      if (path === '/tm/testdata/update') {
        for (const r of body.payload) {
          // The real backend mints the iteration id for a row sent without one.
          if (!r.id) r.id = `itr-new-${nextId++}`;
          rows = [r, ...rows.filter((x) => x.id !== r.id)];
        }
        td.updateVersion += 1;
        return { ok: true };
      }
      throw new Error(`unexpected PUT ${path}`);
    },
    patchJson: async (path: string, body: any) => {
      calls.push({ method: 'PATCH', path, body });
      if (path === '/tm/testdata') {
        rows = rows.filter((r) => !body.id.includes(r.id));
        return { ok: true };
      }
      throw new Error(`unexpected PATCH ${path}`);
    },
  };
  return { a, calls, rows: () => rows, td };
}

describe('suite-level testdata', () => {
  test('read returns the suite rows with parameter names and the default marker', async () => {
    const { a } = setup();
    const out = await a.getSuiteTestdata({ suiteId: 'SU-24', environmentType: 'general' });
    expect(out.entityType).toBe('SU');
    expect(out.id).toBe('24');
    expect(out.testdataId).toBe('td-1');
    expect(out.defaultIterationId).toBe('itr-1');
    expect(out.iterations.map((r: any) => r.name)).toEqual(['ITR-1']);
    expect(out.parameterNames['101']).toBe('casegroupname');
    expect(out.iterations[0].data[0].name).toBe('casegroupname');
  });

  test('copy ITR-1 → ITR-2 saves ONE new suite row and reads it back', async () => {
    const { a, calls, rows } = setup();
    const out = await a.copySuiteTestdataIteration({ suiteId: 'SU-24', environmentType: 'general', from: 'ITR-1', name: 'ITR-2' });
    expect(out.name).toBe('ITR-2');
    expect(out.rows.iterations.map((r: any) => r.name).sort()).toEqual(['ITR-1', 'ITR-2']);
    const copy = out.rows.iterations.find((r: any) => r.name === 'ITR-2')!;
    expect(copy.sequenceNo).toBe(2);
    expect(copy.isChecked).toBe(false);                       // default stays ITR-1
    expect(copy.data.map((c: any) => c.value)).toEqual(['GRP-1', 'LOB-1']);
    // the save went to /tm/testdata/update with the SUITE testdata id
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe('/tm/testdata/update');
    expect(put.body.testdata.id).toBe('td-1');
    expect(put.body.payload).toHaveLength(1);
    expect(put.body.payload[0].newIteration).toBe(true);   // required by the save validator
    expect(typeof put.body.payload[0].id).toBe('string');  // client-minted UUID, like the UI
    expect(put.body.payload[0].isChecked).toBe(false);
    expect(rows().some((r: any) => r.name === 'ITR-2')).toBe(true);
  });

  test('a duplicate row name is refused', async () => {
    const { a } = setup();
    await expect(a.copySuiteTestdataIteration({ suiteId: 'SU-24', environmentType: 'general', name: 'ITR-1' }))
      .rejects.toThrow(/already has a suite-level iteration named "ITR-1"/);
  });

  test('delete refuses the default row and deletes a named row', async () => {
    const { a, calls, rows } = setup();
    await a.copySuiteTestdataIteration({ suiteId: 'SU-24', environmentType: 'general', name: 'ITR-2' });
    await expect(a.deleteTestdataIterations({ entityType: 'SU', id: 'SU-24', environmentType: 'general', iterations: ['ITR-1'] }))
      .rejects.toThrow(/DEFAULT iteration/);
    const res = await a.deleteTestdataIterations({ entityType: 'SU', id: 'SU-24', environmentType: 'general', iterations: ['ITR-2'] });
    expect(res.deleted).toHaveLength(1);
    expect(res.rows.iterations.map((r: any) => r.name)).toEqual(['ITR-1']);
    const patch = calls.find((c) => c.method === 'PATCH' && c.path === '/tm/testdata')!;
    expect(patch.body.testdata.id).toBe('td-1');
    expect(rows().map((r: any) => r.name)).toEqual(['ITR-1']);
  });

  test('a test-case-level delete uses the TC testdata definition (to undo accidental copies)', async () => {
    const { a } = setup();
    const td = { id: 'td-tc', type: 'TC', testcaseId: 631, projectId: 2, executionType: 'AUTOMATION', defaultIteration: { general: 'itr-tc-1' }, updateVersion: 5 };
    const rowsTc = [
      { id: 'itr-tc-1', name: 'ITR-1', data: [] },
      { id: 'itr-tc-2', name: 'ITR-2', data: [] },
    ];
    const deleted: string[] = [];
    a.http.postJson = async (path: string) => {
      if (path === '/tm/testdata/searchTd') return { data: [td] };
      if (path === '/tm/testdata/getIteration') return { data: rowsTc.filter((r) => !deleted.includes(r.id)) };
      throw new Error(`unexpected POST ${path}`);
    };
    a.http.patchJson = async (_path: string, body: any) => { deleted.push(...body.id); return { ok: true }; };
    const res = await a.deleteTestdataIterations({ entityType: 'TC', id: 'TC-631', environmentType: 'general', iterations: ['ITR-2'] });
    expect(deleted).toEqual(['itr-tc-2']);
    expect(res.rows.iterations.map((r: any) => r.name)).toEqual(['ITR-1']);
  });
});
