import { findRuns, findRunsDetailed, proposeFunctionGroups, reconcileMatches } from './functionReuse.js';
import type { Step } from '../domain/types.js';

function step(n: number, actionType: string, objectName?: string, over: Partial<Step> = {}): Step {
  return {
    n, description: `${actionType} ${objectName ?? ''}`.trim(), actionType, stepType: 'web',
    ...(objectName ? { objectRef: { name: objectName } } : {}),
    ...over,
  };
}

describe('function reuse matcher — vocabulary + name normalisation', () => {
  // A recorded step carries the live label and the display name; the saved function's steps carry
  // the dedupe-suffixed object name and (before hydration) a numeric action id. Regression: these
  // never matched, so the pre-save suggestion was always empty on SimplifyQA.
  it('matches despite the saved object dedupe suffix (_1) and case/spacing differences', () => {
    const recorded: Step[] = [
      step(1, 'Go to URL'),
      step(2, 'Type Text', 'Username field'),
      step(3, 'Type Text', 'Password field'),
      step(4, 'Click', 'Login button'),
    ];
    const fnBody: Step[] = [
      step(1, 'Go to URL'),
      step(2, 'Type Text', 'username  field_1'),
      step(3, 'Type Text', 'PASSWORD FIELD_1'),
      step(4, 'Click', 'Login button_1'),
    ];
    expect(findRuns(recorded, fnBody)).toEqual([0]);
  });

  it('matches when the recording names the element more loosely than the saved object', () => {
    // Recorder captured "Username" / "Login"; the repository object is "Username field_1" / "Login button_1".
    const recorded: Step[] = [
      step(1, 'Go to URL'),
      step(2, 'Type Text', 'Username'),
      step(3, 'Type Text', 'Password'),
      step(4, 'Click', 'Login'),
    ];
    const fnBody: Step[] = [
      step(1, 'Go to URL'),
      step(2, 'Type Text', 'Username field_1'),
      step(3, 'Type Text', 'Password field_1'),
      step(4, 'Click', 'Login button_1'),
    ];
    expect(findRuns(recorded, fnBody)).toEqual([0]);
  });

  it('does NOT match two different short labels', () => {    const recorded: Step[] = [step(1, 'Click', 'OK'), step(2, 'Click', 'Cancel')];
    const fnBody: Step[] = [step(1, 'Click', 'OK'), step(2, 'Click', 'Save')];
    expect(findRuns(recorded, fnBody)).toEqual([]);
  });

  it('does not match a run that is not contiguous', () => {    const recorded: Step[] = [
      step(1, 'Go to URL'),
      step(2, 'Click', 'Some banner'),
      step(3, 'Type Text', 'Username field'),
      step(4, 'Type Text', 'Password field'),
      step(5, 'Click', 'Login button'),
    ];
    const fnBody: Step[] = [
      step(1, 'Go to URL'),
      step(2, 'Type Text', 'Username field'),
      step(3, 'Type Text', 'Password field'),
      step(4, 'Click', 'Login button'),
    ];
    expect(findRuns(recorded, fnBody)).toEqual([]);
  });

  it('never matches a function made only of object-less steps', () => {
    const recorded = [step(1, 'Go to URL'), step(2, 'Minimum Wait')];
    expect(findRuns(recorded, [step(1, 'Go to URL'), step(2, 'Minimum Wait')])).toEqual([]);
  });

  it('sees through the recorder-inserted wait step and reports the FULL original range', () => {
    // The recorder inserts "Wait until Element is Present" between launch and typing.
    const recorded: Step[] = [
      step(1, 'Go to URL'),
      step(2, 'Wait until Element is Present', 'Username'),
      step(3, 'Type Text', 'Username'),
      step(4, 'Type Text', 'Password'),
      step(5, 'Click', 'Login'),
    ];
    const fnBody: Step[] = [
      step(1, 'Go to URL'),
      step(2, 'Type Text', 'Username field_1'),
      step(3, 'Type Text', 'Password field_1'),
      step(4, 'Click', 'Login button_1'),
    ];
    expect(findRuns(recorded, fnBody)).toEqual([0]);
    // …and the matched range covers the wait, so a replacement stays contiguous.
    expect(findRunsDetailed(recorded, fnBody)).toEqual([{ start: 0, end: 4 }]);
  });
});

describe('reconcileMatches — "replace all" must never silently drop a chosen function', () => {
  const m = (fnId: string, start: number, stepNs: number[], length = stepNs.length) => ({
    fnId, fnCode: `FN-${fnId}`, fnName: `fn ${fnId}`, start, length, stepNs,
  });

  it('keeps every chosen match when the re-match only found some of them', () => {
    const expected = [m('64', 0, [1, 2, 3, 4, 5, 6]), m('59', 6, [7, 8, 9, 10, 11, 12]), m('62', 12, [13, 14, 15, 16, 17, 18])];
    const rematched = [m('64', 0, [1, 2, 3, 4, 5, 6])];           // partial second lookup
    const out = reconcileMatches(expected, rematched);
    expect(out.map((x) => x.fnId)).toEqual(['64', '59', '62']);
  });

  it('prefers the freshly re-matched range when it overlaps the chosen one', () => {
    const expected = [m('59', 6, [7, 8, 9, 10, 11, 12])];
    const rematched = [m('59', 6, [7, 8, 9, 10, 11, 12], 6)];
    expect(reconcileMatches(expected, rematched)[0]).toBe(rematched[0]);
  });

  it('never queues the same range twice', () => {
    const dup = m('64', 0, [1, 2, 3]);
    const out = reconcileMatches([dup, dup], [dup]);
    expect(out).toHaveLength(1);
  });
});

describe('proposeFunctionGroups — new-function candidates for a finished recording', () => {
  const flow = (count: number): Step[] =>
    Array.from({ length: count }, (_, i) => step(i + 1, 'Click', `Element ${i + 1}`));

  it('splits a 24-step flow into 4 balanced groups of 6', () => {
    const g = proposeFunctionGroups(flow(24));
    expect(g).toHaveLength(4);
    expect(g.map((x) => x.stepCount)).toEqual([6, 6, 6, 6]);
    expect(g[0]!.fromSeq).toBe(1);
    expect(g.at(-1)!.toSeq).toBe(24);
  });

  it('skips runs shorter than 3 steps', () => {
    expect(proposeFunctionGroups(flow(2))).toEqual([]);
  });

  it('does not re-propose steps already covered by an existing-function match', () => {
    // steps 1–6 already match a function → only 7–12 should be proposed
    const g = proposeFunctionGroups(flow(12), { exclude: new Set([1, 2, 3, 4, 5, 6]) });
    expect(g).toHaveLength(1);
    expect(g[0]!.stepSeqs).toEqual([7, 8, 9, 10, 11, 12]);
  });

  it('honours groupSize and maxGroups; never leaves a tiny tail block', () => {
    const g = proposeFunctionGroups(flow(14), { groupSize: 5, maxGroups: 3 });
    expect(g.length).toBeLessThanOrEqual(3);
    for (const block of g) expect(block.stepCount).toBeGreaterThanOrEqual(3);
  });

  it('breaks a run at control-flow / function steps', () => {
    const steps: Step[] = [
      ...flow(4),
      { n: 5, description: 'END FUNCTION', actionType: 'function_end', stepType: 'function_end' },
      ...flow(4).map((s, i) => ({ ...s, n: i + 6 })),
    ];
    const g = proposeFunctionGroups(steps, { groupSize: 4 });
    expect(g.map((x) => [x.fromSeq, x.toSeq])).toEqual([[1, 4], [6, 9]]);
  });

  it('builds a human summary + suggested name from the block', () => {
    const g = proposeFunctionGroups(flow(6));
    expect(g[0]!.summary).toContain('steps 1–6');
    expect(g[0]!.suggestedName).toContain('Element 1');
    expect(g[0]!.suggestedName).toContain('Element 6');
  });
});
