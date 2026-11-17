import { DraftStore } from './store.js';
import type { Step, TestCase } from '../domain/types.js';

function fn(n: number, id = 'FN-12'): Step {
  return {
    n, description: `call ${id}`, actionType: 'function', stepType: 'function',
    functionCall: { testCaseId: id },
  };
}
function web(n: number): Step {
  return { n, description: 'Click Login', actionType: 'Click', stepType: 'web' };
}
function tc(steps: Step[]): TestCase {
  return { title: 'T', priority: 'medium', category: 'automated', steps };
}
const kinds = (steps: Step[]) => steps.map((s) => s.stepType);

describe('DraftStore — function calls are always a balanced FUNCTION/FUNCTION_END pair', () => {
  it('auto-adds the FUNCTION_END for a function step supplied to tc_draft_create', () => {
    const store = new DraftStore();
    const id = store.create(tc([fn(1, 'FN-64'), fn(1, 'FN-63')]));
    const steps = store.get(id).tc.steps;
    expect(kinds(steps)).toEqual(['function', 'function_end', 'function', 'function_end']);
    expect(steps[0]!.functionCall?.testCaseId).toBe('FN-64');
    expect(steps[2]!.functionCall?.testCaseId).toBe('FN-63');
  });

  it('auto-adds the end on add_step and keeps it adjacent', () => {
    const store = new DraftStore();
    const id = store.create(tc([web(1)]));
    store.applyOps(id, [{ op: 'add_step', step: { description: 'call FN-20', actionType: 'function', stepType: 'function', functionCall: { testCaseId: '20' } } }]);
    expect(kinds(store.get(id).tc.steps)).toEqual(['web', 'function', 'function_end']);
  });

  it('is idempotent — an explicit function_end is not duplicated', () => {
    const store = new DraftStore();
    const id = store.create(tc([web(1)]));
    store.applyOps(id, [
      { op: 'add_step', step: { description: 'call FN-20', actionType: 'function', stepType: 'function', functionCall: { testCaseId: '20' } } },
      { op: 'add_step', step: { description: '', actionType: 'function_end', stepType: 'function_end' } },
    ]);
    expect(kinds(store.get(id).tc.steps)).toEqual(['web', 'function', 'function_end']);
  });

  it('dropping the closer removes the whole call — never an orphan or a half pair', () => {
    const store = new DraftStore();
    const id = store.create(tc([fn(1, 'FN-1'), web(3)]));
    // step 2 is the generated FUNCTION_END -> removing it removes the call with it
    store.applyOps(id, [{ op: 'remove_step', n: 2 }]);
    expect(kinds(store.get(id).tc.steps)).toEqual(['web']);
  });

  it('removing the opener also removes its end (no orphan, no half pair)', () => {
    const store = new DraftStore();
    const id = store.create(tc([fn(1, 'FN-1'), web(3)]));
    expect(kinds(store.get(id).tc.steps)).toEqual(['function', 'function_end', 'web']);
    store.applyOps(id, [{ op: 'remove_step', n: 1 }]);
    expect(kinds(store.get(id).tc.steps)).toEqual(['web']);
  });

  it('converting a web step INTO a function call pairs it, and back again unpairs', () => {
    const store = new DraftStore();
    const id = store.create(tc([web(1)]));
    store.applyOps(id, [{ op: 'update_step', n: 1, patch: { stepType: 'function', actionType: 'function', functionCall: { testCaseId: 'FN-9' } } }]);
    expect(kinds(store.get(id).tc.steps)).toEqual(['function', 'function_end']);
    store.applyOps(id, [{ op: 'update_step', n: 1, patch: { stepType: 'web', actionType: 'Click', functionCall: undefined } }]);
    expect(kinds(store.get(id).tc.steps)).toEqual(['web']);
  });

  it('moving a function call keeps the call and its end together', () => {
    const store = new DraftStore();
    const id = store.create(tc([fn(1, 'FN-1'), web(3), web(4)]));
    store.applyOps(id, [{ op: 'move_step', n: 3, to: 1 }]);
    expect(kinds(store.get(id).tc.steps)).toEqual(['web', 'function', 'function_end', 'web']);
  });

  it('renumbers contiguously after every operation', () => {
    const store = new DraftStore();
    const id = store.create(tc([web(1), fn(2, 'FN-5')]));
    const steps = store.get(id).tc.steps;
    expect(steps.map((s) => s.n)).toEqual([1, 2, 3]);
  });
});
