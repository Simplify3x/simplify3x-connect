import { fingerprint, findRuns, isPlainStep, pickNonOverlapping, type RawStep } from './functionMatch.js';

/** Identity-based function matching. The matcher must compare what a step DOES
 *  (actionId / objectId / stepType / technologyType / parameter names) and never the VALUES typed
 *  into it, so a function written with admin/admin still matches a recording of demo/demo. */

const names = new Map<number, string>([
  [1, 'username'], [2, 'password'], [3, 'url'], [4, 'Username'],
]);
const nameOf = (id: number) => names.get(id);

const step = (over: Partial<Record<string, unknown>> = {}): RawStep => ({
  stepType: 'NORMAL_STATEMENT', type: 'TC', actionId: 106, objectId: 351,
  parameterIds: [1], objectParameterIds: [], technologyType: 'WEB', seq: 1, ...over,
});

test('fingerprint ignores values, descriptions and seq', () => {
  const a = step({ seq: 1, description: 'Type admin in Username', recordedParam: { username: 'admin' } });
  const b = step({ seq: 9, description: 'Type demo here', recordedParam: { username: 'demo' } });
  expect(fingerprint(a, nameOf)).toEqual(fingerprint(b, nameOf));
});

test('parameter names are order- and case-insensitive', () => {
  const a = step({ parameterIds: [1, 2] });
  const b = step({ parameterIds: [2, 1] });
  expect(fingerprint(a, nameOf).names).toBe(fingerprint(b, nameOf).names);
  expect(fingerprint(step({ parameterIds: [4] }), nameOf).names).toBe('username');
});

test('a different element or action is a different fingerprint', () => {
  expect(fingerprint(step({ objectId: 351 }), nameOf).base)
    .not.toBe(fingerprint(step({ objectId: 352 }), nameOf).base);
  expect(fingerprint(step({ actionId: 106 }), nameOf).base)
    .not.toBe(fingerprint(step({ actionId: 184 }), nameOf).base);
});

describe('findRuns', () => {
  const body = [step({ seq: 1, objectId: 351 }), step({ seq: 2, objectId: 352 })];

  test('finds an exact contiguous run and reports it', () => {
    const tc = [step({ seq: 1, objectId: 999 }), step({ seq: 2, objectId: 351 }), step({ seq: 3, objectId: 352 }), step({ seq: 4, objectId: 998 })];
    const runs = findRuns(tc, body, nameOf);
    expect(runs).toEqual([{ index: 1, confidence: 'exact' }]);
  });

  test('same action+element with different parameters is a STRONG match, not exact', () => {
    const tc = [step({ seq: 1, objectId: 351, parameterIds: [2] }), step({ seq: 2, objectId: 352, parameterIds: [1] })];
    expect(findRuns(tc, body, nameOf)).toEqual([{ index: 0, confidence: 'strong' }]);
  });

  test('a gap in the middle is not a match', () => {
    const tc = [step({ seq: 1, objectId: 351 }), step({ seq: 2, objectId: 777 }), step({ seq: 3, objectId: 352 })];
    expect(findRuns(tc, body, nameOf)).toEqual([]);
  });

  test('control-flow / function brackets break the run', () => {
    const tc = [step({ seq: 1, objectId: 351 }),
                step({ seq: 2, objectId: 352, stepType: 'FUNCTION' })];
    expect(findRuns(tc, body, nameOf)).toEqual([]);
  });

  test('a one-step function is too generic to suggest', () => {
    expect(findRuns([step({ objectId: 351 })], [step({ objectId: 351 })], nameOf)).toEqual([]);
  });

  test('deleted steps never match', () => {
    const tc = [step({ seq: 1, objectId: 351, deleted: true }), step({ seq: 2, objectId: 352 })];
    expect(findRuns(tc, body, nameOf)).toEqual([]);
  });
});

test('isPlainStep rejects brackets and deleted rows', () => {
  expect(isPlainStep(step())).toBe(true);
  expect(isPlainStep(step({ stepType: 'FUNCTION' }))).toBe(false);
  expect(isPlainStep(step({ stepType: 'IF' }))).toBe(false);
  expect(isPlainStep(step({ deleted: true }))).toBe(false);
});

test('pickNonOverlapping keeps the longest run and drops the overlap', () => {
  const picked = pickNonOverlapping([
    { fnId: '1', fnName: 'short', start: 0, length: 2, seqs: [1, 2], confidence: 'exact' },
    { fnId: '2', fnName: 'long', start: 0, length: 4, seqs: [1, 2, 3, 4], confidence: 'exact' },
    { fnId: '3', fnName: 'later', start: 5, length: 2, seqs: [6, 7], confidence: 'strong' },
  ]);
  expect(picked.map((p) => p.fnId)).toEqual(['2', '3']);
});
