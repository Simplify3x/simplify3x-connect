import { validateTestCase } from './validate.js';
import type { TestCase } from './types.js';

const tc = (actionType: string): TestCase => ({
  title: 't', category: 'automated', priority: 'medium',
  steps: [{ n: 1, description: 'wait', actionType, stepType: 'web' }],
} as unknown as TestCase);

const catalog = new Set<string>(['minimumwait', 'click']);

describe('action name matching in validateTestCase', () => {
  const unknownAction = (a: string) =>
    validateTestCase(tc(a), (() => catalog) as never).filter((i) => /not in catalog/i.test(i.msg));

  test('the display name matches a squashed catalog key; exact names still match', () => {
    expect(unknownAction('Minimum Wait')).toHaveLength(0);
    expect(unknownAction('minimumWait')).toHaveLength(0);
    expect(unknownAction('Click')).toHaveLength(0);
  });
  test('a genuinely unknown action is still rejected', () => {
    expect(unknownAction('Teleport Home')).not.toHaveLength(0);
  });
});
