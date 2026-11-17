import { DraftStore } from '../../drafts/store.js';
import { matchStepNumbers } from '../../drafts/bulk.js';
import { SimplifyQaAdapter } from './adapter.js';

const steps = (): any[] => [
  { n: 1, description: 'Open ${url}', actionType: 'launch', stepType: 'web' },
  { n: 2, description: 'Click Login', actionType: 'click', stepType: 'web', objectRef: { id: '501', name: 'Login Button' } },
  { n: 3, description: 'Read documents', actionType: 'readDocuments', stepType: 'database', recordedParam: { filter: '{"n":"{{suffix}}"}' } },
  { n: 4, description: 'Click Logout', actionType: 'Click', stepType: 'web', objectRef: { id: '502', name: 'Logout Button' } },
  { n: 5, description: 'Type ${username}', actionType: 'typeText', stepType: 'web', recordedParam: { username: 'a' } },
];
const tc = () => ({ title: 't', priority: 'medium', category: 'automated', steps: steps() } as any);

describe('matchStepNumbers', () => {
  test('criteria are ANDed; each criterion works', () => {
    expect(matchStepNumbers(steps(), { stepType: 'database' })).toEqual([3]);
    expect(matchStepNumbers(steps(), { actionType: 'click' })).toEqual([2, 4]);          // case-insensitive
    expect(matchStepNumbers(steps(), { object: 'login button' })).toEqual([2]);
    expect(matchStepNumbers(steps(), { object: '502' })).toEqual([4]);
    expect(matchStepNumbers(steps(), { descriptionContains: 'click' })).toEqual([2, 4]);
    expect(matchStepNumbers(steps(), { parameter: 'username' })).toEqual([5]);
    expect(matchStepNumbers(steps(), { parameter: 'suffix' })).toEqual([3]);               // {{name}} inside a value
    expect(matchStepNumbers(steps(), { from: 2, to: 4, stepType: 'web' })).toEqual([2, 4]);
    expect(matchStepNumbers(steps(), { numbers: [1, 5] })).toEqual([1, 5]);
  });
  test('an empty where is refused unless all:true; no match is an error, never a silent no-op', () => {
    expect(() => matchStepNumbers(steps(), {})).toThrow(/"where" is empty/);
    expect(matchStepNumbers(steps(), { all: true })).toEqual([1, 2, 3, 4, 5]);
    expect(() => matchStepNumbers(steps(), { actionType: 'nothing' })).toThrow(/no step matches/);
  });
});

describe('update_steps — draft', () => {
  test('"skip every step that clicks" patches exactly those steps and nothing else', () => {
    const store = new DraftStore();
    const id = store.create(tc());
    const out = store.applyOps(id, [{ op: 'update_steps', where: { actionType: 'click' }, patch: { flags: { skip: true } } }]);
    expect(out.tc.steps.map((s) => !!s.flags?.skip)).toEqual([false, true, false, true, false]);
  });
  test('an empty where changes nothing and says so', () => {
    const store = new DraftStore();
    const id = store.create(tc());
    expect(() => store.applyOps(id, [{ op: 'update_steps', where: {}, patch: { flags: { skip: true } } }])).toThrow(/"where" is empty/);
  });
  test('a bulk action change also drops each step\'s stale uniqueId', () => {
    const store = new DraftStore();
    const d = tc(); d.steps[2].actionUniqueId = 'db-17';
    const id = store.create(d);
    const out = store.applyOps(id, [{ op: 'update_steps', where: { stepType: 'database' }, patch: { actionType: 'readData' } }]);
    expect(out.tc.steps[2]!.actionType).toBe('readData');
    expect(out.tc.steps[2]!.actionUniqueId).toBeUndefined();
  });
});

describe('update_steps — saved test case, without the agent', () => {
  test('the bulk patch is applied to every match (flags merged, not replaced) and saved once', async () => {
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    let saved: any; let saves = 0;
    const loaded = tc(); loaded.steps[1].flags = { screenshot: true }; loaded.steps[3].flags = { continueOnFailure: true };
    a.getTestCase = async () => loaded;
    a.updateTestCase = async (_i: string, t: any) => { saved = t; saves++; return {}; };
    a.hop = () => { throw new Error('the agent must not be involved'); };
    a.stepsView = async () => ({ steps: [] });
    await a.editJournal('TC_1', [{ op: 'update_steps', where: { object: 'Login Button' }, patch: { flags: { skip: true } } },
      { op: 'update_steps', where: { actionType: 'click' }, patch: { description: 'Click (updated)' } }]);
    expect(saves).toBe(1);
    expect(saved.steps[1].flags).toEqual({ screenshot: true, skip: true });
    expect(saved.steps.map((s: any) => s.description)).toEqual(['Open ${url}', 'Click (updated)', 'Read documents', 'Click (updated)', 'Type ${username}']);
    expect(saved.steps[3].flags).toEqual({ continueOnFailure: true });
  });
});
