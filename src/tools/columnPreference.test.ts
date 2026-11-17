import { registerPreferenceTools } from './preference.tools.js';

/** A fake store: per-entity field catalogue + the user's preference document. */
function setup(prefs: Record<string, any> = {}) {
  const writes: Array<Record<string, any>> = [];
  const fields: Record<number, any[]> = {
    1: [
      { key: 'code', label: 'ID', isDefault: true },
      { key: 'name', label: 'Name', isDefault: true },
      { key: 'createdAt', label: 'Created On', controlType: 'DATE-TIME' },
    ],
    2: [
      { key: 'code', label: 'ID', isDefault: true },
      { key: 'name', label: 'Name', isDefault: true },
      { key: 'createdAt', label: 'Created On', controlType: 'DATE-TIME' },
    ],
    3: [
      { key: 'code', label: 'ID', isDefault: true },
      { key: 'createdAt', label: 'Created On', controlType: 'DATE-TIME' },
    ],
  };
  let doc: Record<string, any> = { ...prefs };
  const adapter: any = {
    getUserPreferences: async () => JSON.parse(JSON.stringify(doc)),
    updateUserPreferences: async (patch: Record<string, any>) => {
      writes.push(patch);
      doc = { ...doc, ...JSON.parse(JSON.stringify(patch)) };
      return doc;
    },
    listViewFields: async (id: number) => fields[id] ?? [],
  };
  let handler: ((a: any) => Promise<any>) | undefined;
  const server: any = { registerTool: (n: string, _c: unknown, fn: (a: any) => Promise<any>) => { if (n === 'column_preference') handler = fn; } };
  registerPreferenceTools(server, { getAdapter: () => adapter });
  return { call: (a: any) => handler!(a), writes, doc: () => doc };
}

describe('column_preference', () => {
  test('enables Created On on all three lists, seeding defaults when no preference exists', async () => {
    const { call, writes, doc } = setup();
    const res = await call({ action: 'set', lists: ['epic', 'feature', 'userstory'], column: 'Created On' });
    expect(res.isError).toBeFalsy();
    const patch = writes[0]!;
    expect(patch['epicFilter'].map((f: any) => f.key)).toEqual(['code', 'name', 'createdAt']);
    expect(patch['featureFilter'].map((f: any) => f.key)).toEqual(['code', 'name', 'createdAt']);
    expect(patch['userstoryFilter'].map((f: any) => f.key)).toEqual(['code', 'createdAt']);
    expect(patch['epicFilter'].find((f: any) => f.key === 'createdAt')).toMatchObject({ label: 'Created On', isChecked: true });
    expect(doc()['epicFilter'].some((f: any) => f.key === 'createdAt')).toBe(true);
  });

  test('accepts the column KEY as well as the label', async () => {
    const res = await setup().call({ action: 'set', lists: ['epic'], column: 'createdAt' });
    expect(res.isError).toBeFalsy();
  });

  test('enabled:false hides the column and keeps the rest', async () => {
    const { call, doc } = setup({ epicFilter: [{ key: 'code', label: 'ID' }, { key: 'createdAt', label: 'Created On' }] });
    const res = await call({ action: 'set', lists: ['epic'], column: 'Created On', enabled: false });
    expect(res.isError).toBeFalsy();
    expect(doc()['epicFilter'].map((f: any) => f.key)).toEqual(['code']);
  });

  test('an unknown column is refused BEFORE anything is written', async () => {
    const { call, writes } = setup();
    const res = await call({ action: 'set', lists: ['epic'], column: 'Nope' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/No column "Nope" on the Epics list/);
    expect(writes).toHaveLength(0);
  });

  test('action get reports the saved columns', async () => {
    const { call } = setup({ userstoryFilter: [{ key: 'createdAt', label: 'Created On' }] });
    const res = await call({ action: 'get', lists: ['userstory'] });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.lists[0].columns).toEqual([{ key: 'createdAt', label: 'Created On' }]);
  });
});
