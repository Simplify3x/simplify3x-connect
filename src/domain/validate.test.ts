import { validateTestCase } from './validate.js';
import type { Step, TestCase, ValidationIssue } from './types.js';

function tcWith(steps: Step[]): TestCase {
  return { title: 'T', priority: 'medium', category: 'automated', steps };
}
function step(over: Partial<Step>): Step {
  return { n: 1, description: 'd', actionType: 'x', stepType: 'web', ...over };
}
const hasCatalogIssue = (issues: ValidationIssue[]) =>
  issues.some((i) => i.msg.includes('not in catalog'));

describe('validateTestCase — action-type catalog matching', () => {
  it('matches a catalog name case-insensitively (SQA `executerestapi` vs `ExecuteRestApi`)', () => {
    const issues = validateTestCase(
      tcWith([step({ stepType: 'api', actionType: 'ExecuteRestApi' })]),
      () => new Set(['executerestapi']),
    );
    expect(hasCatalogIssue(issues)).toBe(false);
  });

  it('accepts an SQA API action name against an SQA catalog (regression: was falsely rejected)', () => {
    const issues = validateTestCase(
      tcWith([step({ stepType: 'api', actionType: 'executerestapi' })]),
      () => new Set(['executerestapi', 'click', 'typetext']),
    );
    expect(issues).toHaveLength(0);
  });

  it('skips the check entirely for an EMPTY catalog (unknown vocabulary is not a rejection)', () => {
    const issues = validateTestCase(
      tcWith([step({ stepType: 'api', actionType: 'executerestapi' })]),
      () => new Set(),
    );
    expect(issues).toHaveLength(0);
  });

  it('still rejects an unknown name when a non-empty catalog is supplied', () => {
    const issues = validateTestCase(
      tcWith([step({ stepType: 'web', actionType: 'definitely_not_real' })]),
      () => new Set(['click']),
    );
    expect(hasCatalogIssue(issues)).toBe(true);
  });

  it('never checks a manual test case against the catalog', () => {
    const tc: TestCase = { ...tcWith([step({ actionType: 'freeform prose' })]), category: 'manual' };
    const issues = validateTestCase(tc, () => new Set(['click']));
    expect(hasCatalogIssue(issues)).toBe(false);
  });

  it('skips a numeric actionType (SQA backend action id round-trip)', () => {
    const issues = validateTestCase(
      tcWith([step({ stepType: 'web', actionType: '66' })]),
      () => new Set(['click']),
    );
    expect(hasCatalogIssue(issues)).toBe(false);
  });
});

describe('validateTestCase — function calls (FUNCTION … FUNCTION_END)', () => {
  const fn = (n: number, id = 'FN-12'): Step => ({
    n, description: 'call the login function', actionType: 'function', stepType: 'function',
    functionCall: { testCaseId: id },
  });
  const fnEnd = (n: number): Step => ({ n, description: '', actionType: 'function_end', stepType: 'function_end' });

  it('does NOT check a function call against the action catalog — a call has no action', () => {
    // Regression: "use these functions and create a new tc" could never save, because
    // `actionType "Function"` was rejected by a catalog that has no function-call action.
    const issues = validateTestCase(tcWith([fn(1), fnEnd(2)]), () => new Set(['click', 'typetext']));
    expect(issues).toHaveLength(0);
  });

  it('accepts an FN-code or a numeric id as the reference', () => {
    for (const id of ['FN-12', '12']) {
      const issues = validateTestCase(tcWith([fn(1, id), fnEnd(2)]), () => new Set(['click']));
      expect(issues).toHaveLength(0);
    }
  });

  it('rejects a function step with no function reference', () => {
    const bare = { ...fn(1), functionCall: undefined } as Step;
    const issues = validateTestCase(tcWith([bare, fnEnd(2)]), () => new Set(['click']));
    expect(issues.some((i) => i.msg.includes('no function reference'))).toBe(true);
  });

  it('rejects an unclosed function call (the shape that runs as a silent no-op)', () => {
    const issues = validateTestCase(tcWith([fn(1)]), () => new Set(['click']));
    expect(issues.some((i) => i.msg.includes('never closed'))).toBe(true);
  });

  it('rejects a function_end with no open call', () => {
    const issues = validateTestCase(tcWith([fnEnd(1)]), () => new Set(['click']));
    expect(issues.some((i) => i.msg.includes('without an open function'))).toBe(true);
  });

  it('validates a sequence of several function calls', () => {
    const issues = validateTestCase(
      tcWith([fn(1, 'FN-1'), fnEnd(2), fn(3, 'FN-2'), fnEnd(4)]),
      () => new Set(['click']),
    );
    expect(issues).toHaveLength(0);
  });
});
