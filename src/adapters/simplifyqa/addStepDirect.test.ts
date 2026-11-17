import { SimplifyQaAdapter } from './adapter.js';
import type { Step } from '../../domain/types.js';

const s = (n: number, description: string, extra: Partial<Step> = {}): Step =>
  ({ n, description, actionType: 'Click', stepType: 'web', ...extra }) as Step;

/** An adapter with only the three collaborators editJournal/editStepsDirect use, so no backend is needed. */
function fake(steps: Step[], category = 'automated') {
  const saved: Step[][] = [];
  const hopCalls: unknown[] = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.getTestCase = async () => ({ id: '7', category, steps });
  a.updateTestCase = async (_id: string, tc: { steps: Step[] }) => { saved.push(tc.steps); return { id: '7' }; };
  a.stepsView = async () => ({ tcId: '7', source: 'steps', steps: saved[saved.length - 1] ?? steps });
  a.hop = () => ({ editJournal: async (...x: unknown[]) => { hopCalls.push(x); return { tcId: '7', source: 'journal', steps: [] }; } });
  return { a, saved, hopCalls };
}

const WAIT = { actionType: 'Minimum Wait', stepType: 'web', description: 'Wait 5 seconds', value: '5' };
const API_STEP = {
  actionType: '', stepType: 'api', description: 'GET user',
  api: { requestData: { httpData: { url: 'https://x/1', method: 'GET' } } },
};

describe('journal_modify add_step (Minimum Wait)', () => {
  test('an API request step needs no actionType (it has no action at all)', async () => {
    const { a, saved } = fake([s(1, 'one')]);
    await a.editJournal('7', [{ op: 'add_step', step: API_STEP as any }]);
    expect(saved[0]!.map((x) => x.stepType)).toEqual(['web', 'api']);
    expect(saved[0]![1]!.actionType).toBe('');
  });
  test('inserts at the given position, shifts the rest down and never goes through the agent', async () => {
    const { a, saved, hopCalls } = fake([s(1, 'one'), s(2, 'two'), s(3, 'three')]);
    await a.editJournal('7', [{ op: 'add_step', at: 2, step: WAIT }]);
    expect(hopCalls).toHaveLength(0);                       // the recorder window must not be opened
    const out = saved[0]!;
    expect(out.map((x) => x.description)).toEqual(['one', 'Wait 5 seconds', 'two', 'three']);
    expect(out.map((x) => x.n)).toEqual([1, 2, 3, 4]);
    expect(out[1]!.actionType).toBe('Minimum Wait');
  });

  test('appends when no position is given and clamps an out-of-range one', async () => {
    const f1 = fake([s(1, 'one'), s(2, 'two')]);
    await f1.a.editJournal('7', [{ op: 'add_step', step: WAIT }]);
    expect(f1.saved[0]!.map((x) => x.description)).toEqual(['one', 'two', 'Wait 5 seconds']);
    const f2 = fake([s(1, 'one'), s(2, 'two')]);
    await f2.a.editJournal('7', [{ op: 'add_step', at: 99, step: WAIT }]);
    expect(f2.saved[0]!.map((x) => x.description)).toEqual(['one', 'two', 'Wait 5 seconds']);
  });

  test('inserting at 1 puts it first and leaves the other steps intact', async () => {
    const { a, saved } = fake([s(1, 'one'), s(2, 'two')]);
    await a.editJournal('7', [{ op: 'add_step', at: 1, step: WAIT }]);
    expect(saved[0]!.map((x) => x.description)).toEqual(['Wait 5 seconds', 'one', 'two']);
  });

  test('refuses a position inside a function call and a step with no actionType', async () => {
    const fn = [s(1, 'a'), s(2, 'fn', { stepType: 'function', actionType: 'function' }), s(3, 'end', { stepType: 'function_end', actionType: 'function_end' })];
    await expect(fake(fn).a.editJournal('7', [{ op: 'add_step', at: 3, step: WAIT }])).rejects.toThrow(/inside the function call/);
    await expect(fake([s(1, 'a')]).a.editJournal('7', [{ op: 'add_step', at: 1, step: { description: 'x', stepType: 'web' } }])).rejects.toThrow(/actionType is required/);
  });

  test('`seq` works as an alias of `at`, and `at` wins when both are given', async () => {
    const f1 = fake([s(1, 'one'), s(2, 'two'), s(3, 'three')]);
    await f1.a.editJournal('7', [{ op: 'add_step', seq: 3, step: WAIT }]);
    expect(f1.saved[0]!.map((x) => x.description)).toEqual(['one', 'two', 'Wait 5 seconds', 'three']);
    const f2 = fake([s(1, 'one'), s(2, 'two'), s(3, 'three')]);
    await f2.a.editJournal('7', [{ op: 'add_step', at: 1, seq: 3, step: WAIT }]);
    expect(f2.saved[0]!.map((x) => x.description)[0]).toBe('Wait 5 seconds');
  });

  test('an element step keeps its objectRef and the existing steps are not modified', async () => {
    const orig = [s(1, 'one', { objectRef: { id: '11', name: 'Login' } }), s(2, 'two')];
    const { a, saved } = fake(orig.map((x) => ({ ...x })));
    await a.editJournal('7', [{ op: 'add_step', at: 2, step: { description: 'click ok', actionType: 'Click', stepType: 'web', objectRef: { name: 'OK button' } } }]);
    const out = saved[0]!;
    expect(out[1]!.objectRef).toEqual({ name: 'OK button' });
    expect(out[0]).toEqual({ ...orig[0], n: 1 });
    expect(out[2]).toEqual({ ...orig[1], n: 3 });
  });

  test('remove_steps deletes a whole range in one op, in any order', async () => {
    const many = Array.from({ length: 10 }, (_, i) => s(i + 1, `s${i + 1}`));
    const { a, saved, hopCalls } = fake(many);
    await a.editJournal('7', [{ op: 'remove_steps', numbers: [7, 5, 10, 6, 9, 8] }]);
    expect(hopCalls).toHaveLength(0);
    expect(saved[0]!.map((x) => x.n)).toEqual([1, 2, 3, 4]);
    expect(saved[0]!.map((x) => x.description)).toEqual(['s1', 's2', 's3', 's4']);
  });

  test('remove_steps fails atomically when any requested step is missing', async () => {
    const { a, saved } = fake([s(1, 'one'), s(2, 'two')]);
    await expect(a.editJournal('7', [{ op: 'remove_steps', numbers: [1, 99] }])).rejects.toThrow(/no step 99/);
    expect(saved).toHaveLength(0);
  });

  test('set_meta edits the test case directly without the agent', async () => {
    const { a, saved, hopCalls } = fake([s(1, 'one')]);
    await a.editJournal('7', [{ op: 'set_meta', patch: { title: 'Renamed', description: 'edited' } }]);
    expect(hopCalls).toHaveLength(0);
    expect(saved).toHaveLength(1);            // persisted through updateTestCase
    expect(saved[0]).toHaveLength(1);         // steps untouched
  });

  test('supported edits go straight to the saved steps; unsupported ops still go through the agent', async () => {
    const direct = fake([s(1, 'one'), s(2, 'two')]);
    await direct.a.editJournal('7', [{ op: 'remove_step', n: 1 }]);
    expect(direct.hopCalls).toHaveLength(0);                 // no agent involvement for a supported op
    expect(direct.saved[0]!.map((x) => x.description)).toEqual(['two']);

    const hopped = fake([s(1, 'one'), s(2, 'two')]);
    await hopped.a.editJournal('7', [{ op: 'wrap_in_loop', from: 1, to: 1, maxIterations: 2 } as any]);
    expect(hopped.hopCalls).toHaveLength(1);                 // the agent is the only one that can wrap
    expect(hopped.saved).toHaveLength(0);
  });
});
