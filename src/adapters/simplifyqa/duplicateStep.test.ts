import { buildTestcasePayload, fromSqaStep } from './mapper.js';
import { SimplifyQaAdapter } from './adapter.js';
import { DraftStore } from '../../drafts/store.js';
import { duplicateSteps } from '../../drafts/duplicate.js';

/** A fully-loaded saved step: every kind of field a copy could lose. */
const rich = (over: Record<string, unknown> = {}) => ({
  id: 'sid-2', seq: 2, description: 'Read documents from ${coll}', stepType: 'NORMAL_STATEMENT', technologyType: 'DATABASE',
  actionId: 117, objectId: 501, parameterIds: [701, 702, 703], objectParameterIds: [801],
  parameterizedParamIds: [704],
  recordedParam: { '701': 'QA_PM', '702': 'task', '703': '{"n":"a-{{suffix}}"}' },
  stepLevelActions: { skip: true, captureScreenshot: true, continueOnFailure: true, skippedReport: true },
  browserType: 'FIREFOX', attachments: [{ name: 'a.txt' }], expectedResult: 'docs returned', ...over,
});
const plain = (seq: number, over: Record<string, unknown> = {}) => ({
  id: `sid-${seq}`, seq, description: `step ${seq}`, stepType: 'NORMAL_STATEMENT', technologyType: 'WEB', actionId: 11, parameterIds: [], recordedParam: {}, ...over,
});
const cf = (seq: number, kind: string) => ({ id: `sid-${seq}`, seq, description: kind, stepType: kind, actionId: null, parameterIds: [], recordedParam: {} });

const payloadOf = (steps: any[]) => (buildTestcasePayload({
  projectId: 19, moduleId: 7, existingId: '42',
  tc: { id: 'TC_42', title: 't', priority: 'medium', category: 'automated', steps } as any,
  paramIdByName: new Map(),
  stepResolutions: steps.map((s) => (s.stepType === 'control_flow' || s.stepType === 'function' || s.stepType === 'function_end'
    ? { actionId: null, objectId: null } : { actionId: s.actionType ? Number(s.actionType) : 11, objectId: s.objectRef ? Number(s.objectRef.id) : null })),
} as any) as any).steps.automationSteps;

describe('duplicate_step copies the WHOLE step', () => {
  test('the saved copy equals the original in every field except identity and position', () => {
    const steps = [fromSqaStep(plain(1), 1), fromSqaStep(rich(), 2)];
    const copies = duplicateSteps(steps, 2);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.sourceId).toBeUndefined();            // a new row, never an overwrite of step 2

    const out = payloadOf([...steps, ...copies].map((s, i) => ({ ...s, n: i + 1 })));
    const [orig, copy] = [out[1], out[2]];
    const strip = (s: any) => { const { id, seq, ...rest } = s; return rest; };
    expect(strip(copy)).toEqual(strip(orig));
    expect(copy.id).toBeUndefined();
    expect(orig.id).toBe('sid-2');
    // spot-check the things a rebuilt-from-summary copy would lose
    expect(copy.parameterIds).toEqual([701, 702, 703]);
    expect(copy.objectParameterIds).toEqual([801]);
    expect(copy.parameterizedParamIds).toEqual([704]);
    expect(copy.recordedParam).toEqual({ '701': 'QA_PM', '702': 'task', '703': '{"n":"a-{{suffix}}"}' });
    expect(copy.stepLevelActions).toMatchObject({ skip: true, captureScreenshot: true, continueOnFailure: true });
    expect(copy.browserType).toBe('FIREFOX');
    expect(copy.objectId).toBe(501);
    expect(copy.seq).toBe(3);
  });

  test('the copy is independent: editing it does not touch the original', () => {
    const steps = [fromSqaStep(rich(), 1)];
    const [copy] = duplicateSteps(steps, 2);
    copy!.sourceRecordedParam!['701'] = 'changed';
    copy!.flags!.skip = false;
    expect(steps[0]!.sourceRecordedParam!['701']).toBe('QA_PM');
    expect(steps[0]!.flags!.skip).toBe(true);
  });

  test('a range copy (steps 1-2) keeps order', () => {
    const steps = [fromSqaStep(plain(1), 1), fromSqaStep(plain(2, { description: 'second' }), 2), fromSqaStep(plain(3), 3)];
    expect(duplicateSteps(steps, 1, 2).map((s) => s.description)).toEqual(['step 1', 'second']);
  });
});

describe('blocks are copied whole or not at all', () => {
  const block = [fromSqaStep(plain(1), 1), fromSqaStep(cf(2, 'IF'), 2), fromSqaStep(plain(3), 3), fromSqaStep(cf(4, 'IF_END'), 4)];
  test('IF…IF_END copies when the range covers it', () => {
    expect(duplicateSteps(block, 2, 4)).toHaveLength(3);
  });
  test('a block opener with no "through" is refused, naming what to give', () => {
    expect(() => duplicateSteps(block, 2)).toThrow(/opens a block \(IF\).*through.*IF_END/);
  });
  test('a range that splits a block is refused (lone closer, lone opener)', () => {
    expect(() => duplicateSteps(block, 3, 4)).toThrow(/IF_END whose opening step is outside/);
    expect(() => duplicateSteps(block, 1, 3)).toThrow(/not closed inside the range/);
  });
  test('a function call and its end copy together; a function without "through" is refused', () => {
    const fn = [fromSqaStep(plain(1, { stepType: 'FUNCTION', actionId: null, functionId: 9, fnVersionId: 'v' }), 1), fromSqaStep(cf(2, 'FUNCTION_END'), 2)];
    expect(duplicateSteps(fn, 1, 2)).toHaveLength(2);
    expect(() => duplicateSteps(fn, 1)).toThrow(/opens a block \(FUNCTION\)/);
  });
  test('an unknown step number is a clear error', () => {
    expect(() => duplicateSteps(block, 9)).toThrow(/no step numbered 9/);
    expect(() => duplicateSteps(block, 3, 99)).toThrow(/no step numbered 99/);
    expect(() => duplicateSteps(block, 4, 3)).toThrow(/comes before/);
  });
});

describe('through the draft tool and the saved-test-case tool', () => {
  test('draft op: append (default) and insert at a position, renumbered', () => {
    const store = new DraftStore();
    const d = store.create({ title: 't', priority: 'medium', category: 'automated', steps: [
      { n: 1, description: 'a', actionType: '11', stepType: 'web' }, { n: 2, description: 'b', actionType: '12', stepType: 'web', recordedParam: { u: 'x' } },
    ] } as any);
    const end = store.applyOps(d, [{ op: 'duplicate_step', n: 2 }]);
    expect(end.tc.steps.map((s) => `${s.n}:${s.description}`)).toEqual(['1:a', '2:b', '3:b']);
    expect(end.tc.steps[2]!.recordedParam).toEqual({ u: 'x' });
    const mid = store.applyOps(d, [{ op: 'duplicate_step', n: 1, at: 2 }]);
    expect(mid.tc.steps.map((s) => `${s.n}:${s.description}`)).toEqual(['1:a', '2:a', '3:b', '4:b']);
  });

  test('saved test case: journal_modify duplicate_step saves the copy through updateTestCase, without calling the agent', async () => {
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    const loaded = { id: 'TC_42', title: 't', priority: 'medium', category: 'automated', steps: [fromSqaStep(plain(1), 1), fromSqaStep(rich(), 2)] };
    let saved: any;
    a.getTestCase = async () => ({ ...loaded, steps: loaded.steps.map((s) => ({ ...s })) });
    a.updateTestCase = async (_id: string, tc: any) => { saved = tc; return { id: 'TC_42' }; };
    a.hop = () => { throw new Error('the agent must not be involved'); };
    await a.editJournal('TC_42', [{ op: 'duplicate_step', n: 2 }]);
    expect(saved.steps).toHaveLength(3);
    expect(saved.steps.map((s: any) => s.n)).toEqual([1, 2, 3]);
    expect(saved.steps[2].sourceId).toBeUndefined();
    expect(saved.steps[1].sourceId).toBe('sid-2');
    expect(saved.steps[2].sourceParameterIds).toEqual([701, 702, 703]);
  });
});

describe('"copy step 4 to position 10"', () => {
  const tcWith = (count: number) => ({ title: 't', priority: 'medium', category: 'automated',
    steps: Array.from({ length: count }, (_, i) => ({ n: i + 1, description: `s${i + 1}`, actionType: '11', stepType: 'web' })) } as any);
  const order = (d: { tc: { steps: { n: number; description: string }[] } }) => d.tc.steps.map((s) => `${s.n}:${s.description}`);

  test('12 steps: the copy becomes step 10 and the old 10, 11, 12 shift to 11, 12, 13', () => {
    const store = new DraftStore();
    const id = store.create(tcWith(12));
    const out = order(store.applyOps(id, [{ op: 'duplicate_step', n: 4, at: 10 }]));
    expect(out).toHaveLength(13);
    expect(out[9]).toBe('10:s4');
    expect(out.slice(8, 13)).toEqual(['9:s9', '10:s4', '11:s10', '12:s11', '13:s12']);
    expect(out[3]).toBe('4:s4');   // the original stays where it was
  });

  test('6 steps (fewer than 10): the copy goes to the end, as step 7', () => {
    const store = new DraftStore();
    const id = store.create(tcWith(6));
    const out = order(store.applyOps(id, [{ op: 'duplicate_step', n: 4, at: 10 }]));
    expect(out).toHaveLength(7);
    expect(out[6]).toBe('7:s4');
  });
});
