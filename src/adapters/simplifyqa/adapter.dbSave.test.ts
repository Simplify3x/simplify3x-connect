import { SimplifyQaAdapter } from './adapter.js';

/** A fake QaHttp: route → handler. Records every call so a test can assert request bodies. */
function fakeHttp(routes: Record<string, (body: any) => any>) {
  const calls: Array<{ path: string; body: any }> = [];
  return {
    calls,
    postJson: async (path: string, body: any) => {
      calls.push({ path, body });
      const h = routes[path];
      if (!h) throw new Error(`unexpected POST ${path}`);
      return h(body);
    },
    getJson: async (path: string) => { throw new Error(`unexpected GET ${path}`); },
  };
}

function adapterWith(http: ReturnType<typeof fakeHttp>) {
  const a = new SimplifyQaAdapter({
    mode: 'connected', provider: 'simplifyqa', token: 't', projectId: '19', baseUrl: 'http://backend',
    walnutAuth: 'key', caps: new Set(),
  } as any);
  (a as any).http = http;
  return a as any;
}

const ACTION_ROWS = [
  { id: 101, name: 'executeQuery', uniqueId: 'db-2', objectRequired: false },
  { id: 102, name: 'executeQuery', uniqueId: 'db-3', objectRequired: false },
  { id: 103, name: 'readData', uniqueId: 'db-6', objectRequired: false },
];

const dbStep = (actionType: string, actionUniqueId?: string) => ({
  n: 1, description: 'd', actionType, stepType: 'database' as const, ...(actionUniqueId ? { actionUniqueId } : {}),
});

describe('DATABASE save: action resolution by plugin uniqueId', () => {
  test('colliding action names resolve to the exact overload via actionUniqueId', async () => {
    const http = fakeHttp({ '/tm/action/search': () => ({ data: ACTION_ROWS }) });
    const a = adapterWith(http);
    const out = await a.resolveAutomationSteps(19, 1, {
      title: 't', priority: 'medium', category: 'automated',
      steps: [dbStep('executeQuery', 'db-2'), dbStep('executeQuery', 'db-3'), dbStep('readData', 'db-6')],
    });
    expect(out.map((o: any) => o.actionId)).toEqual([101, 102, 103]);
  });

  test('asks the backend for uniqueId', async () => {
    const http = fakeHttp({ '/tm/action/search': () => ({ data: ACTION_ROWS }) });
    await adapterWith(http).actionCatalog();
    expect(http.calls[0]!.body.selectFields).toContain('uniqueId');
  });

  test('falls back to the plain field set when the backend rejects uniqueId; resolves by name', async () => {
    let n = 0;
    const http = fakeHttp({
      '/tm/action/search': (body) => {
        if (n++ === 0) { expect(body.selectFields).toContain('uniqueId'); throw new Error('bad column'); }
        expect(body.selectFields).not.toContain('uniqueId');
        return { data: [{ id: 103, name: 'readData', objectRequired: false }] };
      },
    });
    const out = await adapterWith(http).resolveAutomationSteps(19, 1, {
      title: 't', priority: 'medium', category: 'automated',
      steps: [dbStep('readData', 'db-6')],
    });
    expect(out[0].actionId).toBe(103);
    expect(n).toBe(2);
  });

  test('uniqueId preference is scoped to database steps (web keeps by-name resolution)', async () => {
    const http = fakeHttp({
      '/tm/action/search': () => ({ data: [
        { id: 1, name: 'Click', uniqueId: 'web-22', objectRequired: false },
        { id: 2, name: 'Other', uniqueId: 'web-999', objectRequired: false },
      ] }),
    });
    const out = await adapterWith(http).resolveAutomationSteps(19, 1, {
      title: 't', priority: 'medium', category: 'automated',
      steps: [{ n: 1, description: 'd', actionType: 'Click', stepType: 'web', actionUniqueId: 'web-999' }],
    });
    expect(out[0].actionId).toBe(1);   // by name, not the (wrong) uniqueId
  });
});

describe('DATABASE save: runtime parameters', () => {
  test('store slots are created as Runtime, other params as Local', async () => {
    const created: any[] = [];
    let nextId = 500;
    const http = fakeHttp({
      '/tm/parameter/search': () => ({ data: [] }),
      '/tm/parameter': (body) => { created.push(body); return { id: String(nextId++) }; },
    });
    const ids = await adapterWith(http).resolveParamIds(19, 1, {
      title: 't', priority: 'medium', category: 'automated',
      steps: [{
        n: 1, description: 'read', actionType: 'readData', stepType: 'database',
        recordedParam: { Table: 'users', rows: '' }, runtimeParameters: ['rows'],
      }],
    });
    expect(ids.get('Table')).toBe(500);
    expect(ids.get('rows')).toBe(501);
    expect(created.find((c) => c.name === 'Table').type).toBe('Local');
    expect(created.find((c) => c.name === 'rows').type).toBe('Runtime');
  });

  test('a store slot named in the description (${rows}) is still created as Runtime, not Local', async () => {
    const created: any[] = [];
    let nextId = 600;
    const http = fakeHttp({
      '/tm/parameter/search': () => ({ data: [] }),
      '/tm/parameter': (body) => { created.push(body); return { id: String(nextId++) }; },
    });
    const ids = await adapterWith(http).resolveParamIds(19, 1, {
      title: 't', priority: 'medium', category: 'automated',
      steps: [
        { n: 1, description: 'Read documents from ${Table} and store them in ${rows}', actionType: 'readData', stepType: 'database',
          recordedParam: { Table: 'users', rows: '' }, runtimeParameters: ['rows'] },
        // a later step only READS the stored value — it must not downgrade it
        { n: 2, description: 'Verify ${rows}', actionType: 'validate', stepType: 'database', recordedParam: { rows: '' } },
      ],
    });
    expect(created.filter((c) => c.name === 'rows')).toHaveLength(1);
    expect(created.find((c) => c.name === 'rows').type).toBe('Runtime');
    expect(created.find((c) => c.name === 'Table').type).toBe('Local');
    expect(ids.get('rows')).toBeDefined();
  });

  test('steps without runtimeParameters still create Local params (no regression)', async () => {
    const created: any[] = [];
    const http = fakeHttp({
      '/tm/parameter/search': () => ({ data: [] }),
      '/tm/parameter': (body) => { created.push(body); return { id: '7' }; },
    });
    await adapterWith(http).resolveParamIds(19, 1, {
      title: 't', priority: 'medium', category: 'automated',
      steps: [{ n: 1, description: 'x', actionType: 'Type Text', stepType: 'web', recordedParam: { value: 'hi' } }],
    });
    expect(created.map((c) => c.type)).toEqual(['Local']);
  });
});
