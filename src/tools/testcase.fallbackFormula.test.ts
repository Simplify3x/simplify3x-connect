import { saveJournalFallback } from './testcase.tools.js';

/** The journal fallback (recorder Save unavailable) must carry a recording's formulas into the new
 *  test case's DEFAULT test-data iteration — otherwise the random value captured at record time is
 *  frozen as a literal. `read_journal` exposes `recordedParamFormula` name-keyed, alongside
 *  `recordedParam` (name → value). */
function fakeAdapter(seen: any[]) {
  return {
    readJournal: async () => ({
      tcId: 'mcp-test',
      source: 'journal' as const,
      steps: [
        {
          n: 1,
          description: 'Type Diana in Username field',
          actionType: 'Type Text',
          stepType: 'web' as const,
          recordedParam: { username: 'Diana' },
          recordedParamFormula: { username: '=FIRST_NAME()' },
        },
        {
          n: 2,
          description: 'Click Login',
          actionType: 'Click',
          stepType: 'web' as const,
        },
      ],
    }),
    listModules: async () => [],
    createTestCase: async () => ({ id: '999' }),
    patchTestdataCells: async (input: any) => {
      seen.push(input);
      return { patched: input.cells.length, skipped: [] };
    },
  } as any;
}

test('journal fallback applies recorded formulas to the default iteration', async () => {
  const seen: any[] = [];
  const res = await saveJournalFallback(fakeAdapter(seen), 'mcp-test');

  expect(res?.id).toBe('999');
  expect(res?.formulasApplied).toBe(1);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toEqual({
    tcId: '999',
    cells: [{ paramName: 'username', value: 'Diana', formulaValue: '=FIRST_NAME()' }],
  });
});

test('journal fallback does not touch testdata when no formula was recorded', async () => {
  const seen: any[] = [];
  const adapter = fakeAdapter(seen);
  adapter.readJournal = async () => ({
    tcId: 'mcp-test',
    source: 'journal',
    steps: [
      {
        n: 1,
        description: 'Type Diana in Username field',
        actionType: 'Type Text',
        stepType: 'web',
        recordedParam: { username: 'Diana' },
      },
    ],
  });
  const res = await saveJournalFallback(adapter, 'mcp-test');

  expect(res?.id).toBe('999');
  expect(res?.formulasApplied).toBeUndefined();
  expect(seen).toHaveLength(0);
});
