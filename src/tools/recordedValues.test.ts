import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DraftStore } from '../drafts/store.js';
import { buildServer } from '../server.js';
import { backfillRecordedValues, recordedValuesOf, warnEmptyObjectParameters } from './recordedValues.js';

const view = (steps: any[]): any => ({ tcId: 's', source: 'journal', steps });

function adapter(params: Array<{ paramId: number; name: string; seed: string; protected?: boolean }>, patched = 1) {
  const calls: any[] = [];
  const a: any = {
    getDefaultIteration: async () => ({ tcId: '1', versionId: 'v1', environmentType: 'general', parameters: params }),
    patchTestdataCells: async (input: any) => { calls.push(input); return { patched: input.cells.length && patched, skipped: [] }; },
  };
  return { a, calls };
}

describe('recordedValuesOf', () => {
  it('collects typed values by lower-cased name and skips ids, blanks and sensitive names', () => {
    const m = recordedValuesOf(view([
      { recordedParam: { menu_name: 'PIM', password: 'x', '123': 'y', empty: '  ' } },
      { recordedParam: { menu_name: 'Admin', Url: 'http://a' } },
    ]));
    expect([...m.entries()]).toEqual([['menu_name', 'PIM'], ['url', 'http://a']]);
  });
});

describe('recordedValuesOf — object parameters (the recorder\'s own step shape)', () => {
  it('reads recValue from the step\'s objectParameters, as the agent log shows it', () => {
    const m = recordedValuesOf(view([
      // from the agent log: step 7, "Click side menu item (parameterized: menu_name)"
      { recordedParam: {}, objectParameters: [{ protected: false, recValue: 'PIM', name: 'menu_name', id: 33707, type: 'Local' }], objectParameterIds: [33707] },
    ]));
    expect([...m.entries()]).toEqual([['menu_name', 'PIM']]);
  });

  it('skips a protected object parameter, a blank value and a malformed entry', () => {
    const m = recordedValuesOf(view([
      { objectParameters: [{ name: 'secret_menu', recValue: 'x', protected: true }, { name: 'blank', recValue: '  ' }, null, { recValue: 'orphan' }] },
    ]));
    expect(m.size).toBe(0);
  });
});

describe('backfillRecordedValues', () => {
  const recorded = new Map([['menu_name', 'PIM'], ['username', 'Admin']]);

  it('fills an EMPTY cell (the object parameter) and leaves filled ones alone', async () => {
    const { a, calls } = adapter([
      { paramId: 1, name: 'menu_name', seed: '' },
      { paramId: 2, name: 'username', seed: 'Admin' },
    ]);
    const note = await backfillRecordedValues(a, '12862', recorded);
    expect(calls).toHaveLength(1);
    expect(calls[0].cells).toEqual([{ paramName: 'menu_name', value: 'PIM' }]);
    expect(note).toContain('menu_name = PIM');
  });

  it('never writes a protected parameter and does nothing when nothing is empty', async () => {
    const { a, calls } = adapter([{ paramId: 1, name: 'menu_name', seed: '*****', protected: true }, { paramId: 2, name: 'username', seed: 'x' }]);
    expect(await backfillRecordedValues(a, '1', recorded)).toBe('');
    expect(calls).toEqual([]);
  });

  it('reports instead of throwing when the check fails', async () => {
    const a: any = { getDefaultIteration: async () => { throw new Error('boom'); }, patchTestdataCells: async () => ({}) };
    expect(await backfillRecordedValues(a, '1', recorded)).toContain('boom');
  });
});

describe('recordedValuesOf — the value by id', () => {
  it('takes the value from an id-keyed recordedParam entry when recValue is absent', () => {
    const m = recordedValuesOf(view([{ recordedParam: { '33707': 'PIM' }, objectParameters: [{ name: 'menu_name', id: 33707, type: 'Local' }] }]));
    expect([...m.entries()]).toEqual([['menu_name', 'PIM']]);
  });
});

function savedTc(o: { cell: string; protectedCell?: boolean; stepIds?: number[] }) {
  const state = { cell: o.cell, patched: [] as any[] };
  const adapter: any = {
    getTestCase: async () => ({ id: 1, steps: [
      { n: 6, sourceObjectParameterIds: o.stepIds ?? [33707] },
      { n: 7, sourceObjectParameterIds: o.stepIds ?? [33707] },
    ] }),
    getDefaultIteration: async () => ({ tcId: '1', versionId: 'v1', environmentType: 'general', parameters: [{ paramId: 33707, name: 'menu_name', seed: state.cell, ...(o.protectedCell ? { protected: true } : {}) }] }),
    patchTestdataCells: async (input: any) => { state.patched.push(input); state.cell = input.cells[0].value; return { patched: 1, skipped: [] }; },
  };
  return { adapter, state };
}

describe('warnEmptyObjectParameters', () => {
  it('names an object parameter whose cell is empty, with the call that fixes it', async () => {
    const { adapter } = savedTc({ cell: '' });
    const note = await warnEmptyObjectParameters(adapter, '12862');
    expect(note).toContain('EMPTY test-data value: menu_name (steps 6, 7)');
    expect(note).toContain('tc_update_testdata({ tcId: "12862", cells: [{ param: "menu_name", value: "<the value the user gave>" }] })');
  });

  it('is silent when the cell has a value, the parameter is protected, or no step has an object parameter', async () => {
    expect(await warnEmptyObjectParameters(savedTc({ cell: 'PIM' }).adapter, '1')).toBe('');
    expect(await warnEmptyObjectParameters(savedTc({ cell: '', protectedCell: true }).adapter, '1')).toBe('');
    expect(await warnEmptyObjectParameters(savedTc({ cell: '', stepIds: [] }).adapter, '1')).toBe('');
  });

  it('never throws', async () => {
    const adapter: any = { getTestCase: async () => { throw new Error('boom'); }, getDefaultIteration: async () => ({}) };
    expect(await warnEmptyObjectParameters(adapter, '1')).toBe('');
  });
});

async function tcSave(adapter: any): Promise<string> {
  adapter.callRaw = async (name: string) => (name === 'core_active_recordings'
    ? { structuredContent: { recordings: [] } }
    : { structuredContent: { saved: { tcId: '12862', code: 'TC-12862' } } });
  const server = buildServer({ adapter, connection: undefined, mode: 'connected', drafts: new DraftStore(), openEditorWindow: async () => false });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(ct);
  try {
    const res: any = await client.callTool({ name: 'tc_save', arguments: { sessionId: 's-1', replaceWithFunctions: false } });
    expect(res.isError).toBeFalsy();
    return (res.content ?? []).map((c: any) => c.text ?? '').join('\n');
  } finally {
    await client.close();
    await server.close();
  }
}

describe('tc_save, TC-12862: recorder saves, the object parameter cell comes back EMPTY', () => {
  it('the agent handed over recValue → tc_save fills the cell and reports it, no warning left', async () => {
    const { adapter, state } = savedTc({ cell: '' });
    adapter.readJournal = async () => view([{ recordedParam: {}, objectParameters: [{ name: 'menu_name', recValue: 'PIM', id: 33707, type: 'Local', protected: false }], objectParameterIds: [33707] }]);
    const text = await tcSave(adapter);
    expect(state.cell).toBe('PIM');
    expect(text).toContain('Filled 1 empty test-data value(s) from the recording: menu_name = PIM');
    expect(text).not.toContain('EMPTY test-data value');
  });

  it('nothing handed over → the save still succeeds, and the reply says exactly what is empty and how to fix it', async () => {
    const { adapter, state } = savedTc({ cell: '' });
    adapter.readJournal = async () => view([{ recordedParam: {} }]);
    const text = await tcSave(adapter);
    expect(state.cell).toBe('');
    expect(text).toContain('Created test case TC-12862');
    expect(text).toContain('EMPTY test-data value: menu_name (steps 6, 7)');
  });
});
