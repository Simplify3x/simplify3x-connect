import { registerDiscoveryTools } from './discovery.tools.js';

/** Minimal server stub that captures the handler of one tool. */
function setup() {
  const calls: any[] = [];
  const suite = { id: '33', name: 'Probe suite', members: [{ tcId: '143', order: 1, version: 'V1', versionId: 'v1-id' }] };
  const adapter: any = {
    updateSuiteMembers: async (_id: string, ops: any[]) => {
      calls.push(ops);
      if (ops.some((o) => o.version === 'V9')) throw new Error('TC-143 has no version "V9". Available versions: V1, V2.');
      return suite;
    },
    getTestCase: async (id: string) => ({ id, title: 'Sample TC' }),
  };
  const handlers: Record<string, (a: any) => Promise<any>> = {};
  const server: any = {
    registerTool: (n: string, _c: unknown, fn: (a: any) => Promise<any>) => { handlers[n] = fn; },
    // discovery registers many tools; only the suite-add handler is exercised here
  };
  registerDiscoveryTools(server, { getAdapter: () => adapter } as any);
  return { add: (a: any) => handlers['suite_add_testcases']!(a), calls };
}

describe('suite_add_testcases — version pinning', () => {
  test('testCases carry the requested version into the member op', async () => {
    const { add, calls } = setup();
    const res = await add({ suiteId: '33', testCases: [{ tcId: 'TC-143', version: 'V2' }] });
    expect(res.isError).toBeFalsy();
    expect(calls[0]).toEqual([{ op: 'add', tcId: 'TC-143', version: 'V2' }]);
  });

  test('tcIds still add with the current version (no version fields on the op)', async () => {
    const { add, calls } = setup();
    await add({ suiteId: '33', tcIds: ['TC-143'] });
    expect(calls[0]).toEqual([{ op: 'add', tcId: 'TC-143' }]);
  });

  test('an unknown version is an error, not a silent v1.0 row', async () => {
    const { add } = setup();
    const res = await add({ suiteId: '33', testCases: [{ tcId: 'TC-143', version: 'V9' }] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/no version "V9"/);
  });

  test('needs at least one test case', async () => {
    const { add } = setup();
    const res = await add({ suiteId: '33' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/tcIds or testCases/);
  });
});
