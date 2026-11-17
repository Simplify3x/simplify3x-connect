import { buildTestcasePayload, fromSqaStep } from './mapper.js';
import { DraftStore } from '../../drafts/store.js';
import { SimplifyQaAdapter } from './adapter.js';

/** The resolver the real save runs: an edited action name / object id → the ids written to the backend. */
function resolver() {
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.requireProjectId = () => 19;
  a.http = {
    postJson: async (path: string) => {
      if (path === '/tm/action/search') return { data: [
        { id: 11, name: 'click', objectRequired: true, objectTemplate: 3 },
        { id: 22, name: 'close', objectRequired: false },
        { id: 33, name: 'doubleClick', objectRequired: true, objectTemplate: 3 },
      ] };
      throw new Error(`unexpected ${path}`);
    },
    getJson: async (path: string) => { throw new Error(`unexpected GET ${path}`); },
  };
  return a;
}
const webStep = (over: Record<string, unknown>) =>
  ({ n: 1, description: 'x', stepType: 'web', actionType: '11', objectRef: { id: '501' }, ...over });
const tcOf = (steps: any[]) => ({ title: 't', priority: 'medium', category: 'automated', steps } as any);

/** What the backend stores for an existing step, then edited the way a prompt would (update_step patch) and saved. */
const stored = (over: Record<string, unknown> = {}) => ({
  id: 's1', seq: 1, description: 'Click Login', stepType: 'NORMAL_STATEMENT', technologyType: 'WEB',
  actionId: 11, objectId: 501, parameterIds: [701], objectParameterIds: [], recordedParam: { '701': 'admin' },
  stepLevelActions: { skip: true, captureScreenshot: true, continueOnFailure: true, skippedReport: true },
  ...over,
});

const save = (steps: any[], paramIdByName = new Map<string, number>(), resolutions?: any[]) =>
  (buildTestcasePayload({
    projectId: 19, moduleId: 7, existingId: '42',
    tc: { id: 'TC_42', title: 't', priority: 'medium', category: 'automated', steps } as any,
    paramIdByName,
    stepResolutions: resolutions ?? steps.map(() => ({ actionId: 11, objectId: 501 })),
  } as any) as any).steps.automationSteps;

describe('editing an existing step must not lose what the prompt did not touch', () => {
  test('flags (skip / screenshot / continue on failure) survive a save that does not touch them', () => {
    const step = fromSqaStep(stored(), 1);
    const [out] = save([step]);
    expect(out.stepLevelActions.skip).toBe(true);
    expect(out.stepLevelActions.captureScreenshot).toBe(true);
    expect(out.stepLevelActions.continueOnFailure).toBe(true);
  });

  test('"skip this step" / "un-skip it" works, and only changes what was asked', () => {
    const step = fromSqaStep(stored({ stepLevelActions: { skip: false, captureScreenshot: true, continueOnFailure: false } }), 1);
    step.flags = { ...(step.flags ?? {}), skip: true };
    expect(save([step])[0].stepLevelActions).toMatchObject({ skip: true, captureScreenshot: true, continueOnFailure: false });
    step.flags = { ...(step.flags ?? {}), skip: false };
    expect(save([step])[0].stepLevelActions).toMatchObject({ skip: false, captureScreenshot: true });
  });

  test('changing another step leaves this step\'s flags alone', () => {
    const a = fromSqaStep(stored({ id: 's1', seq: 1 }), 1);
    const b = fromSqaStep(stored({ id: 's2', seq: 2, actionId: 12, stepLevelActions: { skip: false } }), 2);
    b.description = 'changed';
    const out = save([a, b]);
    expect(out[0].stepLevelActions.skip).toBe(true);
    expect(out[1].stepLevelActions.skip).toBe(false);
  });

  test('changing the action and the object writes the NEW ids', () => {
    const step = fromSqaStep(stored(), 1);
    step.actionType = 'Close';
    step.objectRef = { id: '777' };
    const [out] = save([step], new Map(), [{ actionId: 22, objectId: 777 }]);
    expect(out.actionId).toBe(22);
    expect(out.objectId).toBe(777);
  });

  test('resolver: "change Click to Close" (no object needed) resolves the new action and drops the object', async () => {
    const [r] = await resolver().resolveAutomationSteps(19, 7, tcOf([webStep({ actionType: 'Close' })]));
    expect(r.actionId).toBe(22);
    expect(r.objectId == null).toBe(true);
  });

  test('resolver: "change Click to Double Click" keeps the object; swapping the object id writes the new one', async () => {
    const a = resolver();
    const [dbl] = await a.resolveAutomationSteps(19, 7, tcOf([webStep({ actionType: 'doubleClick' })]));
    expect(dbl.actionId).toBe(33);
    expect(dbl.objectId).toBe(501);
    const [swap] = await a.resolveAutomationSteps(19, 7, tcOf([webStep({ objectRef: { id: '777' } })]));
    expect(swap.actionId).toBe(11);
    expect(swap.objectId).toBe(777);
  });

  test('browserType is kept on a re-save and a prompt-set browser wins', () => {
    const step = fromSqaStep(stored({ browserType: 'FIREFOX' }), 1);
    expect(save([step])[0].browserType).toBe('FIREFOX');
    step.browserType = 'EDGE';
    expect(save([step])[0].browserType).toBe('EDGE');
  });

  test('changing a parameter value overrides only that parameter', () => {
    const step = fromSqaStep(stored({ parameterIds: [701, 702], recordedParam: { '701': 'admin', '702': 'secret' } }), 1);
    step.recordedParam = { user: 'root' };
    const [out] = save([step], new Map([['user', 701]]));
    expect(out.recordedParam['701']).toBe('root');
    expect(out.recordedParam['702']).toBe('secret');
  });
});

describe('editing a step\'s DESCRIPTION', () => {
  const base = () => fromSqaStep(stored({ description: 'Type admin in the username field', parameterIds: [701], recordedParam: { '701': 'admin' } }), 1);

  test('the new text is saved; the step\'s real data (parameters and their values) is NOT changed by it', () => {
    const step = base();
    step.description = 'Type root in the username field';
    const [out] = save([step]);
    expect(out.description).toBe('Type root in the username field');
    expect(out.parameterIds).toEqual([701]);
    expect(out.recordedParam).toEqual({ '701': 'admin' });   // the value is changed with recordedParam, not with prose
  });

  test('to change the data itself, patch recordedParam (description may follow)', () => {
    const step = base();
    step.description = 'Type root in the username field';
    step.recordedParam = { username: 'root' };
    const [out] = save([step], new Map([['username', 701]]));
    expect(out.recordedParam['701']).toBe('root');
    expect(out.description).toBe('Type root in the username field');
  });

  test('a ${param} written into the description binds that parameter to the step; removing one does not unbind it', () => {
    const step = base();
    step.description = 'Type ${password} in the field';
    const [added] = save([step], new Map([['password', 702]]));
    expect(added.parameterIds).toEqual([701, 702]);
    step.description = 'Type something in the field';
    const [removed] = save([step], new Map([['password', 702]]));
    expect(removed.parameterIds).toEqual([701]);
  });
});

describe('changing a step\'s ACTION', () => {
  const dbResolver = () => {
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.requireProjectId = () => 19;
    a.http = { postJson: async (path: string) => {
      if (path === '/tm/action/search') return { data: [
        { id: 102, name: 'executeQuery', uniqueId: 'db-2', objectRequired: false },
        { id: 106, name: 'readData', uniqueId: 'db-6', objectRequired: false },
      ] };
      throw new Error(`unexpected ${path}`);
    } };
    return a;
  };
  const recorded = { n: 1, description: 'x', stepType: 'database', actionType: 'executeQuery', actionUniqueId: 'db-2' };

  test('the saved step stores the numeric action id; the name is only used to look it up', async () => {
    const [r] = await dbResolver().resolveAutomationSteps(19, 7, tcOf([{ ...recorded, actionUniqueId: undefined, actionType: 'readData' }]));
    expect(r.actionId).toBe(106);
  });

  test('a step that still carries its recorded actionUniqueId would ignore the new action name (the trap)', async () => {
    const [r] = await dbResolver().resolveAutomationSteps(19, 7, tcOf([{ ...recorded, actionType: 'readData' }]));
    expect(r.actionId).toBe(102);   // uniqueId wins over the name — this is why an action change must clear it
  });

  test('update_step with a new actionType clears the stale uniqueId — draft path', () => {
    const store = new DraftStore();
    const id = store.create(tcOf([{ ...recorded }]));
    const out = store.applyOps(id, [{ op: 'update_step', n: 1, patch: { actionType: 'readData' } }]);
    expect(out.tc.steps[0]!.actionType).toBe('readData');
    expect(out.tc.steps[0]!.actionUniqueId).toBeUndefined();
  });

  test('update_step without an action change keeps the uniqueId', () => {
    const store = new DraftStore();
    const id = store.create(tcOf([{ ...recorded }]));
    const out = store.applyOps(id, [{ op: 'update_step', n: 1, patch: { description: 'new text' } }]);
    expect(out.tc.steps[0]!.actionUniqueId).toBe('db-2');
  });

  test('saved-test-case path clears it as well', async () => {
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    let saved: any;
    a.getTestCase = async () => tcOf([{ ...recorded }]);
    a.updateTestCase = async (_i: string, tc: any) => { saved = tc; return {}; };
    a.hop = () => null;
    a.stepsView = async () => ({ steps: [] });
    await a.editStepsDirect('TC_1', [{ op: 'update_step', n: 1, patch: { actionType: 'readData' } }]);
    expect(saved.steps[0].actionType).toBe('readData');
    expect(saved.steps[0].actionUniqueId).toBeUndefined();
  });
});

describe('replacing one parameter with another in a step (today: only adds)', () => {
  test('patching recordedParam with the NEW name leaves the OLD parameter in its slot', () => {
    const step = fromSqaStep(stored({ description: 'Type ${username} and ${password}', parameterIds: [701, 702], recordedParam: { '701': 'admin', '702': 'pw' } }), 1);
    step.recordedParam = { admin_user: 'root' };
    const [out] = save([step], new Map([['username', 701], ['password', 702], ['admin_user', 703]]));
    // the slot order is 701 (username), 702 (password), then the new one appended — slot 1 is still `username`
    expect(out.parameterIds).toEqual([701, 702, 703]);
  });
});

describe('swapParams: replace one parameter with another IN THE SAME SLOT', () => {
  const names = new Map([['username', 701], ['password', 702], ['admin_user', 703]]);
  const loaded = () => fromSqaStep(stored({
    description: 'Type ${username} and ${password}', parameterIds: [701, 702], recordedParam: { '701': 'admin', '702': 'pw' },
  }), 1);

  test('the new parameter takes the old one\'s slot; old value, key and description token are replaced', () => {
    const step = loaded();
    step.swapParams = [{ from: 'username', to: 'admin_user', value: 'root' }];
    const [out] = save([step], names);
    expect(out.parameterIds).toEqual([703, 702]);                       // slot 1 is now admin_user, password stays slot 2
    expect(out.recordedParam).toEqual({ '703': 'root', '702': 'pw' });  // old key gone
    expect(out.description).toBe('Type ${admin_user} and ${password}');
  });

  test('applying it again changes nothing (idempotent)', () => {
    const step = loaded();
    step.swapParams = [{ from: 'username', to: 'admin_user', value: 'root' }];
    const first = save([step], names)[0];
    const again = fromSqaStep({ ...stored(), description: first.description, parameterIds: first.parameterIds, recordedParam: first.recordedParam }, 1);
    again.swapParams = step.swapParams;
    expect(save([again], names)[0].parameterIds).toEqual([703, 702]);
  });

  test('a parameter the step does not use is an error, not a silent append', () => {
    const step = loaded();
    step.swapParams = [{ from: 'password_2', to: 'admin_user' }];
    expect(() => save([step], new Map([...names, ['password_2', 799]]))).toThrow(/does not use parameter "password_2"/);
  });

  test('{{old}} inside a DB value and the parameterized id follow the swap', () => {
    const step = fromSqaStep(stored({
      stepType: 'NORMAL_STATEMENT', technologyType: 'DATABASE', parameterIds: [701], parameterizedParamIds: [704],
      recordedParam: { '701': '{"n":"a-{{suffix}}"}' },
    }), 1);
    step.swapParams = [{ from: 'suffix', to: 'suffix2' }];
    // suffix (704) is the parameterized one; it is not a slot parameter, so it is swapped in parameterizedParamIds
    const [out] = save([step], new Map([['suffix', 704], ['suffix2', 705]]));
    expect(out.parameterizedParamIds).toEqual([705]);
  });

  test('an API request: the bound ids and inputParameters are re-pointed', () => {
    const step = fromSqaStep({
      id: 'a1', seq: 1, stepType: 'API', actionId: null, parameterIds: [701], recordedParam: { '701': 'x' },
      apiData: { requestData: { httpData: { url: 'https://h/{{701}}' } }, inputParameters: [{ id: 701, name: 'user_id' }] },
    }, 1);
    step.swapParams = [{ from: 'user_id', to: 'order_id' }];
    const [out] = save([step], new Map([['user_id', 701], ['order_id', 703]]), [{ actionId: null, objectId: null }]);
    expect(out.apiData.requestData.httpData.url).toBe('https://h/{{703}}');
    expect(out.apiData.inputParameters).toEqual([{ id: 703, name: 'order_id' }]);
    expect(out.parameterIds).toEqual([703]);
  });
});

describe('swapping a step\'s OBJECT', () => {
  // object 501 (old): parameterized by {{801}} / parameter 801 · object 777 (new): {{802}} / parameter 802
  const objects: Record<number, any> = {
    501: { id: 501, attributes: [{ name: 'xpath', value: '//a[@id={{801}}]' }], parameterId: [801] },
    777: { id: 777, attributes: [{ name: 'xpath', value: '//b[@id={{802}}]' }], parameterId: [802] },
  };
  const swapper = (lookupByName = (n: string) => (n.toLowerCase() === 'second button' ? 777 : null)) => {
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.requireProjectId = () => 19;
    a.http = { postJson: async (path: string, body: any) => {
      if (path === '/tm/action/search') return { data: [{ id: 11, name: 'click', objectRequired: true, objectTemplate: 3 }] };
      if (path === '/tm/object/search') {
        const byId = body.searchFields.find((f: any) => f.column === 'id')?.value;
        if (byId !== undefined) return { data: objects[byId] ? [objects[byId]] : [] };
        const nm = body.searchFields.find((f: any) => f.column === 'disname')?.value;
        const id = lookupByName(String(nm));
        return { data: id ? [{ id, disname: nm }] : [] };
      }
      throw new Error(`unexpected ${path}`);
    } };
    return a;
  };
  const loaded = () => fromSqaStep(stored({
    objectId: 501, object: { id: 501, name: 'First Button' }, parameterIds: [701, 801], objectParameterIds: [801], recordedParam: { '701': 'x' },
  }), 1);

  test('by NAME on a saved step is honoured (it used to be silently ignored)', async () => {
    const step = loaded();
    step.objectRef = { name: 'Second Button' };            // what a draft patch leaves: a name, no id
    const [r] = await swapper().resolveAutomationSteps(19, 7, tcOf([step]));
    expect(r.objectId).toBe(777);
  });

  test('by NAME when the id is still the saved one but the name is different', async () => {
    const step = loaded();
    step.objectRef = { id: '501', name: 'Second Button' };   // what the saved-test-case path leaves after a merge
    const [r] = await swapper().resolveAutomationSteps(19, 7, tcOf([step]));
    expect(r.objectId).toBe(777);
  });

  test('an unchanged object keeps the saved id and is not re-derived', async () => {
    const step = loaded();
    const [r] = await swapper().resolveAutomationSteps(19, 7, tcOf([step]));
    expect(r.objectId).toBe(501);
    expect(step.sourceObjectParameterIds).toEqual([801]);
  });

  test('an unknown name is an error', async () => {
    const step = loaded();
    step.objectRef = { name: 'Nope' };
    await expect(swapper().resolveAutomationSteps(19, 7, tcOf([step]))).rejects.toThrow(/no object named "Nope"/);
  });

  test('after a swap the step takes the NEW object\'s parameter ids and drops the old one\'s unused ones', async () => {
    const step = loaded();
    step.objectRef = { id: '777' };
    const a = swapper();
    const [r] = await a.resolveAutomationSteps(19, 7, tcOf([step]));
    expect(r.objectId).toBe(777);
    expect(step.sourceObjectParameterIds).toEqual([802]);
    expect(step.sourceParameterIds).toEqual([701, 802]);     // 801 (old object's, unused) gone; 802 added; 701 kept
    const [out] = save([step], new Map(), [r]);
    expect(out.objectParameterIds).toEqual([802]);
    expect(out.parameterIds).toEqual([701, 802]);
    // a second save of the same draft does not change it again
    const [again] = await a.resolveAutomationSteps(19, 7, tcOf([step]));
    expect(again.objectId).toBe(777);
    expect(step.sourceParameterIds).toEqual([701, 802]);
  });

  test('an old-object parameter the step still has a value for is kept', async () => {
    const step = fromSqaStep(stored({ objectId: 501, parameterIds: [701, 801], objectParameterIds: [801], recordedParam: { '701': 'x', '801': 'important' } }), 1);
    step.objectRef = { id: '777' };
    await swapper().resolveAutomationSteps(19, 7, tcOf([step]));
    expect(step.sourceParameterIds).toEqual([701, 801, 802]);
    expect(step.sourceRecordedParam).toEqual({ '701': 'x', '801': 'important' });
  });

  test('if an object cannot be read, nothing is changed (no regression)', async () => {
    const a = swapper();
    const orig = a.http.postJson;
    a.http.postJson = async (path: string, body: any) => {
      if (path === '/tm/object/search' && body.searchFields.some((f: any) => f.column === 'id')) throw new Error('boom');
      return orig(path, body);
    };
    const step = loaded();
    step.objectRef = { id: '777' };
    const [r] = await a.resolveAutomationSteps(19, 7, tcOf([step]));
    expect(r.objectId).toBe(777);
    expect(step.sourceObjectParameterIds).toEqual([801]);   // unchanged
  });
});

describe('saved-test-case edit path: objectRef patch', () => {
  const editor = (cur: any, patch: any) => {
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    let saved: any;
    a.getTestCase = async () => tcOf([{ ...cur }]);
    a.updateTestCase = async (_i: string, tc: any) => { saved = tc; return {}; };
    a.hop = () => null; a.stepsView = async () => ({ steps: [] });
    return a.editStepsDirect('TC_1', [{ op: 'update_step', n: 1, patch }]).then(() => saved.steps[0]);
  };
  const cur = { n: 1, description: 'x', stepType: 'web', actionType: '11', objectRef: { id: '501', name: 'First Button' }, sourceId: 's1' };
  test('a name without an id replaces the saved reference (the old id must not survive)', async () => {
    expect((await editor(cur, { objectRef: { name: 'Second Button' } })).objectRef).toEqual({ name: 'Second Button' });
  });
  test('an id replaces the id; a patch with both keeps both; the rest of the reference is merged as before', async () => {
    expect((await editor(cur, { objectRef: { id: '777' } })).objectRef).toEqual({ id: '777', name: 'First Button' });
    expect((await editor(cur, { objectRef: { id: '777', name: 'Second Button' } })).objectRef).toEqual({ id: '777', name: 'Second Button' });
  });
});
