import { SimplifyQaAdapter } from './adapter.js';

/** Backend where the project's newer CUSTOM actions are NOT in the bulk catalog (as in TC-12816), are found by a
 *  targeted search on id / name / disname, and GET /tm/action/:id reads the id as a project id (404). */
const CUSTOM = [
  { id: 994, name: 'uploadExcelFileToImport', disname: 'Upload excel file to import', objectRequired: false, objectTemplate: 3, projectId: 40, uniqueId: '40_upload-excel-file-to-import-v5' },
  { id: 996, name: 'makeExcelTestcaseNamesUnique', disname: 'Make excel testcase names unique', objectRequired: false, objectTemplate: 3, projectId: 40, uniqueId: '40_make-excel-v1' },
];

function adapter() {
  const gets: string[] = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.requireProjectId = () => 40;
  a.http = {
    postJson: async (path: string, body: any) => {
      if (path !== '/tm/action/search') throw new Error(`unexpected ${path}`);
      const extra = body.searchFields.find((f: any) => !['deleted', 'projectId'].includes(f.column));
      if (!extra) return { data: [{ id: 11, name: 'click', objectRequired: true, objectTemplate: 3 }] };
      return { data: CUSTOM.filter(r => (r as any)[extra.column] === extra.value) };
    },
    getJson: async (path: string) => { gets.push(path); throw new Error('HTTP 404 — "Project not found with the id 994"'); },
  };
  return { a, gets };
}
const tcOf = (steps: any[]) => ({ title: 't', priority: 'medium', category: 'automated', steps } as any);
const step = (actionType: string, over: Record<string, unknown> = {}) =>
  ({ n: 1, description: 'custom', stepType: 'web', actionType, ...over });

describe('custom-method actions missing from the bulk catalog', () => {
  test('an existing step carrying the numeric action id resolves (edit of the test case is not refused)', async () => {
    const { a, gets } = adapter();
    const [r] = await a.resolveAutomationSteps(40, 7, tcOf([step('994', { sourceId: 's38' })]));
    expect(r.actionId).toBe(994);
    expect(gets).toEqual([]); // never GET /tm/action/:id
  });

  test('a new step by action id, method name or display name resolves', async () => {
    for (const [key, id] of [['996', 996], ['makeExcelTestcaseNamesUnique', 996], ['Make excel testcase names unique', 996]] as const) {
      const { a } = adapter();
      const [r] = await a.resolveAutomationSteps(40, 7, tcOf([step(key)]));
      expect(r.actionId).toBe(id);
    }
  });

  test('an unknown action says it was not found in the action list, not "Project not found"', async () => {
    const { a } = adapter();
    const err = await a.resolveAutomationSteps(40, 7, tcOf([step('99999')])).catch((e: Error) => e);
    expect(err.message).toMatch(/not found in the action list/);
    expect(err.message).not.toMatch(/Project not found/);
  });
});
