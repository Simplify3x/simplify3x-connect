import { normalizeJournalStep, saveJournalFallback } from './testcase.tools.js';
import type { Step, TestCase } from '../domain/types.js';

const step = (n: number, extra: Partial<Step> = {}): Step =>
  ({ n, description: `step ${n}`, actionType: 'enterText', stepType: 'web', ...extra }) as Step;

describe('journal save fallback (recorder Save unavailable)', () => {
  test('builds the test case from journal steps and keeps recordedParam (parameters + test data)', async () => {
    let captured: TestCase | null = null;
    const adapter: any = {
      readJournal: async () => ({
        tcId: 'sess', source: 'journal', steps: [
          { ...step(1), recordedParam: { username: 'standard_user' } },
          { ...step(2), recordedParam: { password: 'secret_sauce' } },
        ],
      }),
      listModules: async () => [{ id: '2', name: 'Default Module' }],
      createTestCase: async (tc: TestCase) => { captured = tc; return { id: '999', created: true, productUrl: 'https://x/999' }; },
    };

    const res = await saveJournalFallback(adapter, 'sess');

    expect(res).toEqual({ id: '999', productUrl: 'https://x/999' });
    expect(captured).not.toBeNull();
    expect(captured!.category).toBe('automated');
    expect(captured!.folderOrModule).toBe('2');
    expect(captured!.steps[0]!.recordedParam).toEqual({ username: 'standard_user' });
    expect(captured!.steps[1]!.recordedParam).toEqual({ password: 'secret_sauce' });
  });

  test('returns null when the journal is empty', async () => {
    const adapter: any = { readJournal: async () => ({ tcId: 'x', source: 'journal', steps: [] }) };
    expect(await saveJournalFallback(adapter, 'x')).toBeNull();
  });

  test('returns null when there is no journal capability', async () => {
    expect(await saveJournalFallback({} as any, 'x')).toBeNull();
  });

  test('normalises an "API Call" journal step into a real API step', () => {
    const s = normalizeJournalStep({ n: 1, description: 'POST /x', actionType: 'API Call', stepType: 'web', apiData: { a: 1 } } as any);
    expect(s.stepType).toBe('api');
    expect(s.api).toEqual({ a: 1 });
  });
});
