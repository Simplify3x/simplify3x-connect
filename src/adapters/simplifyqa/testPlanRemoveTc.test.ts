import { SimplifyQaAdapter } from './adapter.js';

/** Adapter with a stateful fake backend for `PATCH /tm/scenario/testcase/:id`. */
function setup() {
  const entry = { id: 900, version: 'v1.0', versionId: 'v-900', code: 'TC-900', name: 'Login flow' };
  const plan: any = {
    id: 9, code: 'TP-9', name: 'Falcon Release Plan', projectId: 1, deleted: false,
    suiteIds: [24], testcaseIds: [entry, { id: 901, version: 'v1.0', versionId: 'v-901', code: 'TC-901' }],
    childIds: [10], leafNode: true,
  };
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: 'https://x', projectId: '1' };
  a.requireProjectId = () => 1;
  a.http = {
    getJson: async (path: string) => {
      if (path === '/tm/scenario/9') return plan;
      if (path === '/tm/testcase/getById/900') return { id: 900, code: 'TC-900', projectId: 1 };
      if (path === '/tm/testcase/getById/999') return {};
      throw new Error(`unexpected GET ${path}`);
    },
    patchJson: async (path: string, body: any) => {
      calls.push({ method: 'PATCH', path, body });
      if (path === '/tm/scenario/testcase/9') {
        // Like the real backend: it removes the entry the payload names.
        const selected = JSON.parse(body.selectedTc);
        plan.testcaseIds = plan.testcaseIds.filter((e: any) => !(e.id === selected.id && e.versionId === selected.versionId));
        plan.leafNode = body.leafNode;
        return { ok: true, leafNode: body.leafNode };
      }
      throw new Error(`unexpected PATCH ${path}`);
    },
  };
  return { a: a as SimplifyQaAdapter, plan, calls };
}

describe('removeTestcaseFromTestPlan', () => {
  test('sends the folder\'s own entry as a JSON string and removes only that test case', async () => {
    const { a, plan, calls } = setup();
    const res = await a.removeTestcaseFromTestPlan('TP-9', 'TC-900');
    expect(res.removed).toBe('TC-900');
    expect(res.remaining).toEqual([901]);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.path).toBe('/tm/scenario/testcase/9');
    // The UI's wire shape — the whole entry, stringified — not just an id.
    expect(call.body.selectedTc).toBe(JSON.stringify({ id: 900, version: 'v1.0', versionId: 'v-900', code: 'TC-900', name: 'Login flow' }));
    expect(call.body.leafNode).toBe(true);
    // Suites and sub-folders untouched.
    expect(plan.suiteIds).toEqual([24]);
    expect(plan.childIds).toEqual([10]);
  });

  test('refuses a test case that is not in the plan, and writes nothing', async () => {
    const { a, calls } = setup();
    // 901 is in the plan but the fake backend has no testcase doc for it -> found check fails first
    await expect(a.removeTestcaseFromTestPlan('TP-9', 'TC-999')).rejects.toThrow(/not found/);
    expect(calls).toHaveLength(0);
  });

  test('reports when the backend answered but the plan still contains the case', async () => {
    const { a } = setup();
    (a as any).http.patchJson = async () => ({ ok: true }); // no-op backend
    await expect(a.removeTestcaseFromTestPlan('TP-9', 'TC-900')).rejects.toThrow(/still in TP-9/);
  });
});
