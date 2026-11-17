import { SimplifyQaAdapter } from './adapter.js';
import { registerObjectTools } from '../../tools/objects.tools.js';

const doc = (over: Record<string, unknown> = {}) => ({
  id: 801, name: 'task_doc', type: 'Local', parameterType: 'Alphanumeric', defaultValue: '[]', description: 'docs',
  paramAttributes: { minLength: 0, maxLength: 0, prefix: '', suffix: '' }, protected: false, unique: false, concat: '', moduleId: 7, updateVersion: 3, ...over,
});

/** A backend that remembers the parameter. `applyPut` lets a test model a backend that ignores the change. */
function backend(initial = doc(), applyPut = true) {
  let current: any = { ...initial };
  const puts: any[] = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.requireProjectId = () => 19;
  a.http = {
    getJson: async (path: string) => { if (path === `/tm/parameter/${current.id}`) return [{ ...current }]; throw new Error(`unexpected GET ${path}`); },
    putJson: async (path: string, body: any) => { puts.push({ path, body }); if (applyPut) current = { ...current, ...body }; return {}; },
    postJson: async (path: string, body: any) => {
      if (path === '/tm/parameter/search') {
        const n = body.searchFields.find((f: any) => f.column === 'name')?.value;
        return { data: String(n).toLowerCase() === current.name.toLowerCase() ? [{ ...current }] : [] };
      }
      throw new Error(`unexpected POST ${path}`);
    },
  };
  return { a, puts, current: () => current };
}

describe('updateParameter', () => {
  test('Local → Runtime by name: sends the COMPLETE definition (the backend reads paramAttributes unconditionally) and verifies', async () => {
    const { a, puts, current } = backend();
    const r = await a.updateParameter('TASK_DOC', { type: 'Runtime' });
    expect(r).toMatchObject({ id: '801', name: 'task_doc', type: 'Runtime', changed: ['type Local -> Runtime'] });
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toBe('/tm/parameter/801');
    expect(puts[0].body).toMatchObject({
      name: 'task_doc', projectId: 19, moduleId: 7, type: 'Runtime', parameterType: 'Alphanumeric', defaultValue: '[]',
      paramAttributes: { minLength: 0, maxLength: 0, prefix: '', suffix: '' }, protected: false, unique: false, concat: '', updateVersion: 3,
    });
    expect(current().type).toBe('Runtime');
  });

  test('by numeric id; default value and description change; unchanged fields are carried over', async () => {
    const { a, puts } = backend();
    const r = await a.updateParameter('801', { defaultValue: '', description: 'new text' });
    expect(r.changed).toEqual(['defaultValue', 'description']);
    expect(puts[0].body.type).toBe('Local');           // not touched
    expect(puts[0].body.description).toBe('new text');
  });

  test('REFUSES when the backend did not apply it (it never reports an edit that did not land)', async () => {
    const { a } = backend(doc(), false);
    await expect(a.updateParameter('task_doc', { type: 'Runtime' })).rejects.toThrow(/still Local after the update/);
  });

  test('Global parameters are refused, both ways', async () => {
    await expect(backend(doc({ type: 'Global' })).a.updateParameter('task_doc', { defaultValue: 'x' })).rejects.toThrow(/Global/);
    await expect(backend().a.updateParameter('task_doc', { type: 'Global' as any })).rejects.toThrow(/Global/);
  });

  test('an unknown parameter and an empty change are clear errors; nothing is sent', async () => {
    const b = backend();
    await expect(b.a.updateParameter('nope', { type: 'Runtime' })).rejects.toThrow(/was not found/);
    await expect(b.a.updateParameter('task_doc', {})).rejects.toThrow(/Nothing to change/);
    expect(b.puts).toHaveLength(0);
  });
});

describe('parameter_update tool', () => {
  function tool(applied: { calls: any[] }) {
    const adapter: any = { updateParameter: async (ref: string, changes: any) => { applied.calls.push({ ref, changes }); return { id: '801', name: ref, type: changes.type ?? 'Local', defaultValue: '', changed: ['type Local -> Runtime'] }; } };
    let handler: ((a: any) => Promise<any>) | undefined;
    const server: any = { registerTool: (n: string, _c: unknown, fn: (a: any) => Promise<any>) => { if (n === 'parameter_update') handler = fn; } };
    registerObjectTools(server, { getAdapter: () => adapter });
    return (a: any) => handler!(a);
  }
  test('without confirm it only previews — the adapter is never called', async () => {
    const applied = { calls: [] as any[] };
    const res = await tool(applied)({ parameter: 'task_doc', type: 'Runtime' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/Preview only.*EVERY test case/);
    expect(applied.calls).toHaveLength(0);
  });
  test('with confirm:true it applies and reports', async () => {
    const applied = { calls: [] as any[] };
    const res = await tool(applied)({ parameter: 'task_doc', type: 'Runtime', confirm: true });
    expect(applied.calls).toEqual([{ ref: 'task_doc', changes: { type: 'Runtime' } }]);
    expect(res.content[0].text).toContain('Updated parameter "task_doc"');
  });
  test('nothing to change is an error', async () => {
    expect((await tool({ calls: [] })({ parameter: 'task_doc', confirm: true })).isError).toBe(true);
  });
});
