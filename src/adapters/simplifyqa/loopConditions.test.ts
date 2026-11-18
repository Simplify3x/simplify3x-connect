import { SimplifyQaAdapter } from './adapter.js';
import { normalizeLoopKinds, loopBlockProblems } from './loopConditions.js';
import { lintAutomatedTestCase } from '../../tools/testCaseLint.js';
import { DraftStore } from '../../drafts/store.js';

/**
 * TC-45 "while loop tc": a WHILE around the Add Employee steps, condition "Element is Displayed (Add Employee tab)",
 * and a DO-WHILE the same way — driven through the REAL createTestCase against a stateful fake backend.
 */
const ACTIONS = [
  { id: 11, name: 'click', uniqueId: 'web-1', objectRequired: true, objectTemplate: 3, disname: 'Click' },
  { id: 46, name: 'elementIsDisplayed', uniqueId: 'web-46', objectRequired: true, objectTemplate: 3, disname: 'Element is Displayed' },
  { id: 47, name: 'elementIsEnabled', uniqueId: 'web-47', objectRequired: true, objectTemplate: 3, disname: 'Element is Enabled' },
];
const OBJECTS: Record<string, string> = { '88': 'Add Employee tab', '89': 'Save button', '501': 'PIM menu' };

function backend() {
  let saved: any;
  const a: any = new SimplifyQaAdapter({
    mode: 'connected', provider: 'simplifyqa', token: 't', projectId: '19', baseUrl: 'http://backend', walnutAuth: 'key', caps: new Set(),
  } as any);
  a.http = {
    postJson: async (path: string, body: any) => {
      if (path === '/tm/action/search') return { data: ACTIONS };
      if (path === '/tm/object/search') {
        const name = body.searchFields?.find((f: any) => f.column === 'disname')?.value;
        const hit = Object.entries(OBJECTS).find(([, n]) => n.toLowerCase() === String(name).toLowerCase());
        return { data: hit ? [{ id: Number(hit[0]), disname: hit[1] }] : [] };
      }
      if (path === '/tm/parameter/search') return { data: [] };
      throw new Error(`unexpected POST ${path}`);
    },
    postMultipart: async (_p: string, _f: string, payload: any) => { saved = payload; return { id: 45, code: 'TC-45' }; },
    getJson: async (path: string) => {
      const m = /\/tm\/object\/(\d+)$/.exec(path);
      if (m) return OBJECTS[m[1]!] ? { data: { id: Number(m[1]), name: OBJECTS[m[1]!], disname: OBJECTS[m[1]!], attributes: [] } } : { data: {} };
      throw new Error(`unexpected GET ${path}`);
    },
  };
  return { a, saved: () => saved };
}

const click = (n: number, obj = '501') => ({ n, description: `click ${n}`, stepType: 'web', actionType: 'click', objectRef: { id: obj } });
const cf = (kind: string, extra: Record<string, unknown> = {}) => ({ n: 0, description: kind, stepType: 'control_flow', actionType: kind, controlFlow: { kind, ...extra } });
const tc = (steps: any[]) => ({ title: 'while loop tc', priority: 'medium', category: 'automated', technologyType: 'WEB', folderOrModule: '7', steps });
const squash = (s: string) => s.replace(/\s+/g, ' ');

describe('WHILE with a condition (the reported TC-45 case)', () => {
  test('"while" + "end_while" save as WHILE_START / WHILE_END, with a real element check and its text', async () => {
    const { a, saved } = backend();
    await a.createTestCase(tc([
      click(1),
      cf('while', { maxIterations: 2, condition: { type: 'element_displayed', objectId: '88' } }),
      click(3, '89'), click(4, '89'),
      cf('end_while'),
    ]));
    const steps = saved().steps.automationSteps;
    expect(steps.map((s: any) => s.stepType)).toEqual(['NORMAL_STATEMENT', 'WHILE_START', 'NORMAL_STATEMENT', 'NORMAL_STATEMENT', 'WHILE_END']);
    const cond = steps[1].conditions;
    expect(cond.children).toHaveLength(1);
    expect(cond.children[0]).toMatchObject({
      type: 'TC', stepType: 'NORMAL_STATEMENT', condition: 'AND', actionId: 46, objectId: 88, selectedObject: [88],
      parameterIds: [], objectParameterIds: [], executionType: 'AUTOMATION', technologyType: 'WEB', seq: 1, deleted: false,
    });
    expect(squash(cond.ifstring)).toBe('WHILE_START ( (Element is Displayed ( Add Employee tab )) )');
    // the product has no per-step maximum, so it is not written as if it had one
    expect(steps[1].loopDuration).toBeUndefined();
    expect(steps[4].conditions.children).toEqual([]);
  });

  test('the same by object NAME, with two checks joined AND / OR', async () => {
    const { a, saved } = backend();
    await a.createTestCase(tc([
      cf('while', { conditions: [{ type: 'element_displayed', objectName: 'Add Employee tab', logical: 'OR' }, { type: 'element_enabled', objectId: '89' }] }),
      click(2), cf('end_while'),
    ]));
    const cond = saved().steps.automationSteps[0].conditions;
    expect(cond.children.map((c: any) => [c.actionId, c.objectId, c.condition, c.seq])).toEqual([[46, 88, 'OR', 1], [47, 89, 'AND', 2]]);
    expect(squash(cond.ifstring)).toBe('WHILE_START ( (Element is Displayed ( Add Employee tab )) || (Element is Enabled ( Save button )) )');
  });
});

describe('DO-WHILE', () => {
  test('"do" … "end_do_while": DO opens with no condition, the closing WHILE carries it', async () => {
    const { a, saved } = backend();
    await a.createTestCase(tc([
      cf('do'), click(2, '89'),
      cf('end_do_while', { condition: { type: 'element_displayed', objectId: '88' } }),
    ]));
    const steps = saved().steps.automationSteps;
    expect(steps.map((s: any) => s.stepType)).toEqual(['DO', 'NORMAL_STATEMENT', 'WHILE']);
    expect(steps[0].conditions.children).toEqual([]);
    expect(steps[2].conditions.children[0]).toMatchObject({ actionId: 46, objectId: 88 });
    expect(squash(steps[2].conditions.ifstring)).toBe('WHILE ( (Element is Displayed ( Add Employee tab )) )');
  });

  test('"do_while" twice: the first opens, the second closes (and takes the condition)', async () => {
    const { a, saved } = backend();
    await a.createTestCase(tc([
      cf('do_while'), click(2, '89'),
      cf('do_while', { condition: { type: 'element_displayed', objectId: '88' } }),
    ]));
    expect(saved().steps.automationSteps.map((s: any) => s.stepType)).toEqual(['DO', 'NORMAL_STATEMENT', 'WHILE']);
  });
});

describe('what is refused instead of saved wrong', () => {
  const run = (steps: any[]) => backend().a.createTestCase(tc(steps));
  test('an unknown check, a value compare, a missing object, a condition on a closer', async () => {
    await expect(run([cf('while', { condition: { type: 'banana', objectId: '88' } }), click(2), cf('end_while')]))
      .rejects.toThrow(/no element-check action matches "banana"/);
    await expect(run([cf('while', { condition: { type: 'value_equals', variableName: 'x', variableValue: '1' } }), click(2), cf('end_while')]))
      .rejects.toThrow(/comparing a value.*can't be saved/s);
    await expect(run([cf('while', { condition: { type: 'element_displayed' } }), click(2), cf('end_while')]))
      .rejects.toThrow(/give its objectId/);
    await expect(run([cf('while', { condition: { type: 'element_displayed', objectId: '9999' } }), click(2), cf('end_while')]))
      .rejects.toThrow(/object 9999 was not found/);
    await expect(run([cf('while', { condition: { type: 'element_displayed', objectId: '88' } }), click(2), cf('end_while', { condition: { type: 'element_displayed', objectId: '88' } })]))
      .rejects.toThrow(/WHILE_END takes no condition/);
  });
});

describe('kinds, lint and edits', () => {
  const step = (kind: string, extra: Record<string, unknown> = {}): any => ({ n: 1, description: '', stepType: 'control_flow', actionType: kind, controlFlow: { kind, ...extra } });

  test('normalizeLoopKinds settles the ambiguous words by the open block and leaves stored steps alone', () => {
    const steps = [step('while'), step('end_while'), step('DO'), step('WHILE'), step('while')];
    normalizeLoopKinds(steps);
    expect(steps.map((s) => s.controlFlow.kind)).toEqual(['WHILE_START', 'WHILE_END', 'DO', 'WHILE', 'WHILE_START']);
    const stored = { ...step('WHILE'), sourceRaw: { stepType: 'WHILE' } };
    normalizeLoopKinds([stored]);
    expect(stored.controlFlow.kind).toBe('WHILE');
  });

  test('block problems: an unclosed WHILE, a stray WHILE_END, a bare WHILE with no DO', () => {
    const p = (kinds: string[]) => { const s = kinds.map((k) => step(k)); normalizeLoopKinds(s); return loopBlockProblems(s); };
    expect(p(['while', 'end_while'])).toEqual([]);
    expect(p(['do', 'end_do_while'])).toEqual([]);
    expect(p(['while'])[0]).toMatch(/WHILE has no WHILE_END/);
    expect(p(['end_while'])[0]).toMatch(/no WHILE_START/);
    expect(p(['end_do_while'])[0]).toMatch(/no DO is open/);
  });

  test('lint: no condition, and maxIterations (not a SimplifyQA setting)', () => {
    const w = lintAutomatedTestCase(tc([cf('while', { maxIterations: 2, conditionText: 'x' }), click(2), cf('end_while')]) as any);
    expect(w.some((x) => /WHILE_START has no condition/.test(x))).toBe(true);
    expect(w.some((x) => /no per-step maximum.*maxIterations 2/.test(x))).toBe(true);
    const ok = lintAutomatedTestCase(tc([cf('while', { condition: { type: 'element_displayed', objectId: '88' } }), click(2), cf('end_while')]) as any);
    expect(ok.filter((x) => /WHILE|DO/.test(x))).toEqual([]);
  });

  test('a stored loop that is saved again without a new condition keeps the one it has', async () => {
    const { a, saved } = backend();
    const kept = { children: [{ type: 'TC', stepType: 'NORMAL_STATEMENT', actionId: 46, objectId: 88 }], ifstring: 'WHILE_START ( (Element is Displayed ( Add Employee tab )) )' };
    await a.createTestCase(tc([
      { ...cf('WHILE_START'), sourceRaw: { stepType: 'WHILE_START', conditions: kept } }, click(2, '89'),
      { ...cf('WHILE_END'), sourceRaw: { stepType: 'WHILE_END' } },
    ]));
    const steps = saved().steps.automationSteps;
    expect(steps.map((s: any) => s.stepType)).toEqual(['WHILE_START', 'NORMAL_STATEMENT', 'WHILE_END']);
    expect(steps[0].conditions).toEqual(kept);
  });

  test('editing only the condition of a saved WHILE keeps its kind (the patch merges, it does not replace)', () => {
    const store = new DraftStore();
    const id = store.create({ title: 't', priority: 'medium', category: 'automated', steps: [{ n: 1, ...step('WHILE_START'), blockId: 'b1' }] } as any);
    store.applyOps(id, [{ op: 'update_step', n: 1, patch: { controlFlow: { condition: { type: 'element_displayed', objectId: '88' } } } }] as any);
    const d: any = store.get(id)!;
    expect(d.tc.steps[0].controlFlow.kind).toBe('WHILE_START');
    expect(d.tc.steps[0].controlFlow.condition.objectId).toBe('88');
  });
});

