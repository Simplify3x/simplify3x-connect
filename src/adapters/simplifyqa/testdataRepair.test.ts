import { SimplifyQaAdapter } from './adapter.js';

/** TC-12817: v1.0 got cells `{paramId, value}` with no `type` (the recorder window wrote them into the first
 *  test-data header it found, whichever version that was). v2.0 is healthy. */
function fixture() {
  const rows: Record<string, any[]> = {
    v1: [{ id: 'itr-1', parentId: 'td-1', customerId: 7, data: [
      { paramId: 11, type: 'OB', value: 'Admin', stepId: 's1', stepSeq: 1 },
      { paramId: 12, value: 'admin123' },                       // typeless
    ] }],
    v2: [{ id: 'itr-2', parentId: 'td-2', customerId: 7, data: [
      { paramId: 11, type: 'OB', value: 'Admin', stepId: 's9', stepSeq: 1 },
    ] }],
  };
  const writes: any[] = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.requireProjectId = () => 40;
  a.fetchRawTestcase = async () => ({ id: 12817, customerId: 7, versions: [{ id: 'v1', name: 'v1.0' }, { id: 'v2', name: 'v2.0' }] });
  a.fetchStepsCollection = async (_id: string, _raw: any, versionId: string) =>
    versionId === 'v1' ? [{ id: 's1', seq: 1, parameterIds: [11] }, { id: 's2', seq: 2, parameterIds: [12] }] : [];
  a.http = {
    postJson: async (path: string, body: any) => {
      if (path === '/tm/testdata/searchItr') {
        const v = body.searchFields.find((f: any) => f.column === 'versionId').value;
        return { data: rows[v] };
      }
      if (path === '/tm/testdata/updateItr') { writes.push(body); return {}; }
      throw new Error(`unexpected ${path}`);
    },
  };
  return { a, writes };
}

describe('repairTestdataCells', () => {
  test('gives a typeless cell its type and step, touches only the broken version, keeps every value', async () => {
    const { a, writes } = fixture();
    const r = await a.repairTestdataCells('TC-12817');
    expect(r).toEqual({ checked: 2, repaired: 1, versions: ['v1.0'] });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ id: 'itr-1', parentId: 'td-1', customerId: 7, projectId: 40 });
    expect(writes[0].data).toEqual([
      { paramId: 11, type: 'OB', value: 'Admin', stepId: 's1', stepSeq: 1 },
      { paramId: 12, type: 'OB', value: 'admin123', stepId: 's2', stepSeq: 2 },
    ]);
  });

  test('healthy test data is left alone (no write)', async () => {
    const { a, writes } = fixture();
    await a.repairTestdataCells('TC-12817');
    writes.length = 0;
    const again = fixture();
    again.a.http.postJson = async (p: string) => p === '/tm/testdata/searchItr'
      ? { data: [{ id: 'i', parentId: 't', customerId: 7, data: [{ paramId: 1, type: 'OB', value: 'x' }] }] }
      : (() => { throw new Error('must not write'); })();
    expect(await again.a.repairTestdataCells('TC-12817')).toMatchObject({ repaired: 0, versions: [] });
  });
});
