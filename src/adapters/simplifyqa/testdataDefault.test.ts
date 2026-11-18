import { SimplifyQaAdapter } from './adapter.js';
import { registerTestdataTools } from '../../tools/testdata.tools.js';

/**
 * "For SU-23 in General, make ITR-2 (then ITR-3) the default" — driven through the REAL setDefaultTestdataIteration. The test data definition and its
 * rows are a small stateful fake of the backend:
 *   - the default is `defaultIteration`, a map environment → iteration id, on the DEFINITION;
 *   - `PUT /tm/testdata/update` needs at least one row (the project is read from it) and applies the definition only when `testdata.id` is NUMERIC
 *     (the real service filters on `{ id: testdata.id }`, so a string id silently matches nothing) and `updateVersion` is current.
 */
type State = { td: Record<string, any>; rows: any[] };

const row = (id: string, name: string, seq: number) => ({
  id, name, sequenceNo: seq, parentId: 123, executionType: 'AUTOMATION', type: 'SU', environmentType: 'General', projectId: 25,
  customerId: 3, createdAt: '2026-11-01', deleted: false, data: [{ paramId: 501, value: `v${seq}`, name: 'username' }],
});

function backend(opts: { td?: Record<string, any>; ignoreWrite?: boolean; staleOnce?: boolean } = {}) {
  const state: State = {
    td: { id: '123', type: 'SU', projectId: 25, updateVersion: 2, defaultIteration: { General: 'itr-1', Other: 'x9' }, ...opts.td },
    rows: [row('itr-1', 'ITR-1', 1), row('itr-2', 'ITR-2', 2), row('itr-3', 'ITR-3', 3)],
  };
  const puts: any[] = [];
  let stale = opts.staleOnce === true;
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: 'http://backend' };
  a.requireProjectId = () => 25;
  a.testdataDefinitionRow = async () => ({ ...state.td });
  a.testdataRowsFor = async (_td: any, entityType: string, id: string) => {
    const di = state.td['defaultIteration'];
    return {
      entityType, id, testdataId: String(state.td['id']), environmentType: 'General',
      ...(di && typeof di === 'object' && di['General'] ? { defaultIterationId: String(di['General']) } : typeof di === 'string' ? { defaultIterationId: di } : {}),
      iterations: state.rows.map((r) => JSON.parse(JSON.stringify(r))), parameterNames: { '501': 'username' },
    };
  };
  a.listEnvironments = async () => [{ id: 'general', key: 'general', name: 'General' }];
  a.http = {
    putJson: async (path: string, body: any) => {
      puts.push({ path, body });
      if (path !== '/tm/testdata/update') throw new Error(`unexpected PUT ${path}`);
      if (!body.payload?.length || body.payload[0].projectId === undefined) throw new Error("Don't Have Privileges to access resources (INVALIDTOKEN)");
      if (stale) { stale = false; state.td['updateVersion'] += 1; }
      if (body.testdata.updateVersion !== state.td['updateVersion']) throw new Error('Concurrency Error (CONCURRENCY)');
      if (!opts.ignoreWrite && typeof body.testdata.id === 'number') {
        state.td['defaultIteration'] = body.testdata.defaultIteration;
        state.td['updateVersion'] += 1;
      }
      return { status: true };
    },
  };
  return { a, puts, state };
}
const SU = (extra: Record<string, unknown> = {}) => ({ entityType: 'SU' as const, id: 'SU-23', environmentType: 'general', ...extra });

describe('make ITR-2 the default of SU-23 in General', () => {
  test('the definition is saved with the new default for that environment (others kept), a numeric id and one row; read back', async () => {
    const { a, puts, state } = backend();
    const r = await a.setDefaultTestdataIteration(SU({ iteration: 'ITR-2' }));
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toBe('/tm/testdata/update');
    expect(puts[0].body.testdata).toEqual({ id: 123, defaultIteration: { General: 'itr-2', Other: 'x9' }, projectId: 25, updateVersion: 2 });
    expect(puts[0].body.payload).toHaveLength(1);
    expect(puts[0].body.payload[0]).toMatchObject({ id: 'itr-2', name: 'ITR-2', projectId: 25 });
    expect(puts[0].body.payload[0]).not.toHaveProperty('customerId');
    expect(state.td['defaultIteration']).toEqual({ General: 'itr-2', Other: 'x9' });
    expect(r).toMatchObject({ iteration: 'ITR-2', previous: 'ITR-1', changed: true });
    expect(r.rows.defaultIterationId).toBe('itr-2');
  });

  test('then ITR-3 (by id), and the row the default replaced is still there', async () => {
    const { a, state } = backend();
    await a.setDefaultTestdataIteration(SU({ iteration: 'ITR-2' }));
    const r = await a.setDefaultTestdataIteration(SU({ iteration: 'itr-3' }));
    expect(r).toMatchObject({ iteration: 'ITR-3', previous: 'ITR-2', changed: true });
    expect(state.td['defaultIteration']['General']).toBe('itr-3');
    expect(r.rows.iterations.map((x: any) => x.name)).toEqual(['ITR-1', 'ITR-2', 'ITR-3']);
  });

  test('the name is matched loosely; asking for the row that already is the default changes nothing and sends nothing', async () => {
    const { a, puts } = backend();
    const same = await a.setDefaultTestdataIteration(SU({ iteration: 'itr-1' }));
    expect(same).toMatchObject({ iteration: 'ITR-1', changed: false });
    expect(puts).toEqual([]);
    expect((await a.setDefaultTestdataIteration(SU({ iteration: 'itr-2' }))).iteration).toBe('ITR-2');
  });

  test('a definition whose default is stored as a plain string becomes the environment map', async () => {
    const { a, puts } = backend({ td: { defaultIteration: 'itr-1' } });
    await a.setDefaultTestdataIteration(SU({ iteration: 'ITR-3' }));
    expect(puts[0].body.testdata.defaultIteration).toEqual({ General: 'itr-3' });
  });
});

describe('refused or reported instead of assumed', () => {
  test('an unknown or empty iteration is refused with the rows that exist; nothing is sent', async () => {
    const { a, puts } = backend();
    await expect(a.setDefaultTestdataIteration(SU({ iteration: 'ITR-9' }))).rejects.toThrow(/No iteration "ITR-9" on SU SU-23.*ITR-1, ITR-2, ITR-3/s);
    await expect(a.setDefaultTestdataIteration(SU({ iteration: '  ' }))).rejects.toThrow(/iteration is required/);
    expect(puts).toEqual([]);
  });

  test('a stale version is retried once with the fresh one', async () => {
    const { a, puts } = backend({ staleOnce: true });
    await a.setDefaultTestdataIteration(SU({ iteration: 'ITR-2' }));
    expect(puts.map((p) => p.body.testdata.updateVersion)).toEqual([2, 3]);
  });

  test('a save the backend did not apply is reported with what it still shows', async () => {
    const { a } = backend({ ignoreWrite: true });
    await expect(a.setDefaultTestdataIteration(SU({ iteration: 'ITR-2' }))).rejects.toThrow(/Sent "ITR-2" as the default.*still shows "ITR-1"/s);
  });

  test('the default can no longer be deleted — and the message now says how to change it', async () => {
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.testdataDefinitionRow = async () => ({ id: '123', projectId: 25, defaultIteration: { General: 'itr-1' }, updateVersion: 0 });
    a.testdataRowsFor = async () => ({ entityType: 'SU', id: '23', testdataId: '123', environmentType: 'General', defaultIterationId: 'itr-1', iterations: [row('itr-1', 'ITR-1', 1)], parameterNames: {} });
    await expect(a.deleteTestdataIterations({ entityType: 'SU', id: 'SU-23', environmentType: 'general', iterations: ['ITR-1'] }))
      .rejects.toThrow(/"ITR-1" is the DEFAULT iteration and cannot be deleted\. Make another iteration the default first \(testdata_set_default_iteration\)/);
  });
});

describe('the testdata_set_default_iteration tool', () => {
  const tool = (adapter: any) => {
    const h: Record<string, (a: any) => Promise<any>> = {};
    registerTestdataTools({ registerTool: (n: string, _d: unknown, fn: any) => { h[n] = fn; } } as any, { getAdapter: () => adapter });
    return h['testdata_set_default_iteration']!;
  };
  const text = (r: any): string => r.content.map((c: any) => c.text).join('\n');

  test('says which row is now the default, which one it replaced, and that it was read back', async () => {
    const r = await tool(backend().a)({ entityType: 'SU', suiteId: 'SU-23', environmentType: 'general', iteration: 'ITR-2' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/ITR-2 is now the default iteration of suite SU-23 — env general \(it was ITR-1, which still exists but is no longer the default\)\. Read back from SimplifyQA\./);
    expect(text(r)).toMatch(/Rows now:/);
  });

  test('already the default; a missing id; an unlisted environment; errors and not-connected come back as messages', async () => {
    const same = await tool(backend().a)({ entityType: 'SU', suiteId: 'SU-23', environmentType: 'general', iteration: 'ITR-1' });
    expect(text(same)).toMatch(/ITR-1 is already the default iteration of suite SU-23.*nothing was changed/s);
    expect(text(await tool(backend().a)({ entityType: 'SU', environmentType: 'general', iteration: 'ITR-2' }))).toMatch(/Pass suiteId/);
    expect(text(await tool(backend().a)({ entityType: 'SU', suiteId: 'SU-23', environmentType: 'nope', iteration: 'ITR-2' }))).toMatch(/not a configured environment/);
    expect(text(await tool(backend().a)({ entityType: 'SU', suiteId: 'SU-23', environmentType: 'general', iteration: 'ITR-9' }))).toMatch(/No iteration "ITR-9"/);
    expect(text(await tool(null)({ entityType: 'SU', suiteId: 'SU-23', environmentType: 'general', iteration: 'ITR-2' }))).toMatch(/Not connected/);
  });
});
