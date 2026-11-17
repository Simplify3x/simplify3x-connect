import { registerTestcaseTools } from './testcase.tools.js';

/** Capture the handlers registerTestcaseTools wires up, so tc_automate can be called without an MCP transport. */
function handlers(adapter: unknown) {
  const map = new Map<string, (args: any) => Promise<any>>();
  const server: any = { registerTool: (name: string, _cfg: unknown, fn: (a: any) => Promise<any>) => { map.set(name, fn); } };
  registerTestcaseTools(server, { drafts: {} as any, getAdapter: () => adapter } as any);
  return map;
}

const manualTc = (storyRef?: string) => ({
  id: '55', title: 'Login works', category: 'manual', currentVersionId: 'v1',
  ...(storyRef ? { storyRef } : {}),
  steps: [{ n: 1, description: 'open https://app.example.com', expectedResult: 'page opens' }],
});

describe('tc_automate keeps the manual test case linked to its story', () => {
  test('the guide REQUIRES the source story id and returns it in structuredContent', async () => {
    const h = handlers({ getTestCase: async () => manualTc('4321') });
    const res = await h.get('tc_automate')!({ tcId: '55', url: 'https://app.example.com' });
    const text = res.content[0].text as string;
    expect(text).toContain('userstoryId: 4321 (REQUIRED');
    expect(text).toContain('sourceTcId: "55"');
    expect(res.structuredContent.userstoryId).toBe(4321);
  });

  test('a source with no story does not tell the AI to pass one', async () => {
    const h = handlers({ getTestCase: async () => manualTc() });
    const res = await h.get('tc_automate')!({ tcId: '55', url: 'https://app.example.com' });
    expect(res.content[0].text).not.toContain('userstoryId: ');
    expect(res.structuredContent.userstoryId).toBeUndefined();
  });
});
