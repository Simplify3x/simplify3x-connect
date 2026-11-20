import { SimplifyQaAdapter } from './adapter.js';

/**
 * object_parameterize: the step's object locator gets `{{<paramId>}}`, the step lists the id in objectParameterIds and
 * carries the value, and the test-data cell holds it. The fake below keeps real state for the object, the parameter table,
 * the step and the default test-data row, and — like the backend's saveTestData — seeds a NEW cell from the step's recorded
 * value when the step is saved.
 */
const LOCATORS = [
  { name: 'Xpath by Role and Name', value: "//a[normalize-space()='PIM']", unique: true },
  { name: 'class', value: 'oxd-main-menu-item' },
];

function world(o: { seedOnSave?: boolean; failStepSave?: boolean; tokenised?: boolean; plain?: boolean; waitStep?: boolean } = {}) {
  const seedOnSave = o.seedOnSave !== false;
  const state = {
    attrs: LOCATORS.map((l) => ({ ...l })),
    params: new Map<string, number>(),
    nextParam: 900,
    step: { n: 7, description: 'Click side menu item PIM', sourceObjectId: '5001', objectRef: { id: '5001', name: 'Side Menu Item' } } as any,
    cell: undefined as undefined | { paramId: number; value: string },
    calls: [] as string[],
    patched: [] as any[],
  };
  if (o.plain) {   // a test case saved from a recording that typed ${menu_name}: a PLAIN parameter, an empty cell
    state.params.set('menu_name', 900);
    state.step.description = 'Click PIM menu_1 ${menu_name}';
    state.step.sourceParameterIds = [900];
    state.cell = { paramId: 900, value: '' };
  }
  if (o.tokenised) {
    state.params.set('menu_name', 900);
    state.attrs[0]!.value = "//a[normalize-space()='{{900}}']";
    state.step.sourceObjectParameterIds = [900];
    state.step.sourceRecordedParam = { '900': 'PIM' };
    state.cell = { paramId: 900, value: 'PIM' };
  }
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.requireProjectId = () => 40;
  a.resolveTcVersion = async (_t: string, v: string) => ({ id: v });
  // TC 997: step 6 "Wait until … is Present" uses the SAME object, before the clicking step 7
  const waitStep: any = o.waitStep ? { n: 6, description: 'Wait until PIM menu_1 is Present.', sourceObjectId: '5001', objectRef: { id: '5001', name: 'Side Menu Item' } } : undefined;
  const stepsNow = (): any[] => [...(waitStep ? [waitStep] : []), state.step];
  a.getTestCase = async () => ({ id: 12862, steps: stepsNow() });
  a.http = { getJson: async (p: string) => { if (p === '/tm/object/5001') return { data: { id: 5001, disname: 'Side Menu Item', moduleId: 3, attributes: state.attrs } }; throw new Error(`unexpected GET ${p}`); } };
  a.findParameterId = async (_p: number, name: string) => state.params.get(name) ?? null;
  a.getOrCreateParameter = async (_p: number, _m: number, name: string) => {
    state.calls.push(`createParam:${name}`);
    const id = state.params.get(name) ?? state.nextParam++;
    state.params.set(name, id);
    return id;
  };
  a.updateObject = async (_id: string, ch: { locators: Array<{ name: string; value: string }> }) => {
    state.calls.push('updateObject');
    for (const l of ch.locators) { const x = state.attrs.find((t) => t.name === l.name)!; x.value = l.value; }
  };
  a.editStepsDirect = async (_t: string, ops: any[]) => {
    state.calls.push('saveStep');
    if (o.failStepSave) throw new Error('backend 500');
    for (const op of ops) {
      if (waitStep && op.n === 6) Object.assign(waitStep, op.patch);
      else state.step = { ...state.step, ...op.patch };
    }
    // backend saveTestData: a NEW param gets ONE cell, on the FIRST step (by order) that lists it, seeded from THAT step's recorded value
    const owner = stepsNow().find((s) => (s.sourceObjectParameterIds ?? []).length);
    for (const id of owner?.sourceObjectParameterIds ?? []) {
      if (!state.cell || state.cell.paramId !== id) state.cell = { paramId: id, value: seedOnSave ? (owner.sourceRecordedParam?.[String(id)] ?? '') : '' };
    }
  };
  a.getDefaultIteration = async () => ({
    tcId: '12862', versionId: 'v1', environmentType: 'general',
    parameters: state.cell ? [{ paramId: state.cell.paramId, name: 'menu_name', seed: state.cell.value }] : [],
  });
  a.patchTestdataCells = async (input: any) => {
    state.patched.push(input);
    if (state.cell) state.cell.value = input.cells[0].value;
    return { patched: 1, skipped: [] };
  };
  return { a, state };
}
const run = (a: any, extra: Record<string, unknown> = {}) =>
  a.objectParameterize({ tcId: 'TC-12862', step: 7, parameterName: 'menu_name', value: 'PIM', ...extra });

describe('object_parameterize', () => {
  it('without confirm it only previews and writes nothing', async () => {
    const { a, state } = world();
    const r = await run(a);
    expect(r).toMatchObject({ written: false, testdata: 'preview' });
    expect(r.changes).toEqual([{ locator: 'Xpath by Role and Name', before: "//a[normalize-space()='PIM']", after: "//a[normalize-space()='{{menu_name}}']" }]);
    expect(state.calls).toEqual([]);
    expect(state.attrs[0]!.value).toBe("//a[normalize-space()='PIM']");
  });

  it('confirm: the locator carries {{id}}, the step lists it as an OBJECT parameter, and test data holds PIM', async () => {
    const { a, state } = world();
    const r = await run(a, { confirm: true });
    const id = state.params.get('menu_name')!;
    expect(state.attrs[0]!.value).toBe(`//a[normalize-space()='{{${id}}}']`);
    expect(state.attrs[1]!.value).toBe('oxd-main-menu-item');                 // a locator without the text is untouched
    expect(state.step.sourceObjectParameterIds).toEqual([id]);
    expect(state.step.sourceRecordedParam).toEqual({ [String(id)]: 'PIM' });
    expect(state.cell).toEqual({ paramId: id, value: 'PIM' });
    expect(r).toMatchObject({ written: true, testdata: 'seeded', parameter: { name: 'menu_name', id } });
    expect(state.patched).toEqual([]);
  });

  it('when the backend left the cell empty it writes the value and says so', async () => {
    const { a, state } = world({ seedOnSave: false });
    const r = await run(a, { confirm: true });
    expect(r.testdata).toBe('patched');
    expect(state.cell!.value).toBe('PIM');
    expect(state.patched[0].cells).toEqual([{ paramName: 'menu_name', value: 'PIM' }]);
  });

  it('puts the object back when the step cannot be saved', async () => {
    const { a, state } = world({ failStepSave: true });
    await expect(run(a, { confirm: true })).rejects.toThrow(/locators were put back/);
    expect(state.attrs[0]!.value).toBe("//a[normalize-space()='PIM']");
  });

  it('refuses text that is in no locator, listing the locators, and writes nothing', async () => {
    const { a, state } = world();
    await expect(run(a, { replace: 'Leave', confirm: true })).rejects.toThrow(/No locator of object "Side Menu Item" contains "Leave".*Xpath by Role and Name/);
    expect(state.calls).toEqual([]);
  });

  it('running it again changes nothing twice: no second object edit, no duplicate id', async () => {
    const { a, state } = world({ tokenised: true });
    const r = await run(a, { confirm: true });
    expect(state.calls).not.toContain('updateObject');
    expect(state.step.sourceObjectParameterIds).toEqual([900]);
    expect(r.written).toBe(true);
  });

  it('a test case that already has menu_name as a PLAIN parameter (TC 997): moves it to the object, drops the token, fills the empty cell', async () => {
    const { a, state } = world({ plain: true });
    const r = await run(a, { confirm: true });
    expect(state.step.sourceObjectParameterIds).toEqual([900]);
    expect(state.step.sourceParameterIds).toEqual([]);              // no longer a plain parameter as well
    expect(state.step.description).toBe('Click PIM menu_1');       // the ${menu_name} text would re-bind it on save
    expect(state.params.size).toBe(1);                              // the existing parameter is reused, not duplicated
    expect(r.testdata).toBe('patched');                             // the cell existed (empty), so the backend kept it empty
    expect(state.cell).toEqual({ paramId: 900, value: 'PIM' });
  });

  it('TC 997: a second step on the same object (step 6) also lists the parameter, and the FIRST step carries the value', async () => {
    const { a, state } = world({ plain: true, waitStep: true });
    const r = await run(a, { step: 7, confirm: true });
    expect(r.steps).toEqual([6, 7]);
    const wait = (await a.getTestCase()).steps.find((s: any) => s.n === 6);
    expect(wait.sourceObjectParameterIds).toEqual([900]);                       // step 6 resolves the token too
    expect(wait.sourceRecordedParam).toEqual({ '900': 'PIM' });                 // and is the cell's first owner, so it holds the value
    expect(state.step.sourceObjectParameterIds).toEqual([900]);
    expect(state.cell).toEqual({ paramId: 900, value: 'PIM' });
  });

  it('a fresh test case: both steps seed the cell with the value (no empty cell from the first step)', async () => {
    const { a, state } = world({ waitStep: true });
    const r = await run(a, { confirm: true });
    expect(r.steps).toEqual([6, 7]);
    expect(r.testdata).toBe('seeded');                                          // the first owner (step 6) carried PIM — nothing had to be patched
    expect(state.cell!.value).toBe('PIM');
    expect(state.patched).toEqual([]);
  });

  it('rejects a parameter name that is not a plain name', async () => {
    const { a } = world();
    await expect(run(a, { parameterName: 'menu name!' })).rejects.toThrow(/plain name/);
  });
});
