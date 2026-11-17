// tc_draft_from_tc — verifies the load-existing-TC-as-draft path so `tc_save` UPDATEs the
// original TC (preserving id/history/testdata/suites) instead of creating a sibling.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { TestCase } from '../domain/types.js';
import { registerTestcaseTools } from './testcase.tools.js';
import { DraftStore } from '../drafts/store.js';

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

function captureHandlers(names: string[]): { server: McpServer; get: (n: string) => Handler } {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (n: string, _meta: unknown, h: Handler) => {
      if (names.includes(n)) handlers.set(n, h);
    },
  } as unknown as McpServer;
  return {
    server,
    get: (n: string) => {
      const h = handlers.get(n);
      if (!h) throw new Error(`${n} handler not registered`);
      return h;
    },
  };
}

const existingTc: TestCase = {
  id: '589',
  title: 'Require Cart Review Before Purchase - Happy Path',
  priority: 'medium',
  category: 'manual',
  storyRef: '941',
  steps: [
    { n: 1, description: 'Login', stepType: 'web', actionType: 'manualStep' },
    { n: 2, description: 'Add to cart', stepType: 'web', actionType: 'manualStep' },
  ],
};

describe('tc_draft_from_tc', () => {
  it('errors when not connected', async () => {
    const cap = captureHandlers(['tc_draft_from_tc']);
    registerTestcaseTools(cap.server, { drafts: new DraftStore(), getAdapter: () => null });
    const res = await cap.get('tc_draft_from_tc')({ tcId: '589' });
    expect(res.isError).toBe(true);
  });

  it('hydrates a draft carrying the original tcId so tc_save UPDATEs in place', async () => {
    const cap = captureHandlers(['tc_draft_from_tc', 'tc_save']);
    const updateCalls: Array<{ id: string; tc: TestCase }> = [];
    const createCalls: TestCase[] = [];
    const adapter = {
      getTestCase: async (id: string) => ({ ...existingTc, id }),
      updateTestCase: async (id: string, tc: TestCase) => {
        updateCalls.push({ id, tc });
        return { id, productUrl: `http://x/tc/${id}` };
      },
      createTestCase: async (tc: TestCase) => {
        createCalls.push(tc);
        return { id: 'NEW_ID', productUrl: 'http://x/tc/NEW_ID' };
      },
    } as unknown as ProviderAdapter;

    registerTestcaseTools(cap.server, { drafts: new DraftStore(), getAdapter: () => adapter });

    const loaded = await cap.get('tc_draft_from_tc')({ tcId: '589' });
    expect(loaded.isError).toBeFalsy();
    const draftId = (loaded.structuredContent as { draftId: string }).draftId;
    expect(draftId).toMatch(/^draft_/);
    // Draft must carry the original tc.id — this is what tc_save keys create-vs-update on.
    expect((loaded.structuredContent as { tc: TestCase }).tc.id).toBe('589');

    const saved = await cap.get('tc_save')({ draftId });
    expect(saved.isError).toBeFalsy();
    // The whole point: UPDATE the same id, do NOT createTestCase.
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.id).toBe('589');
    expect(createCalls).toHaveLength(0);
  });
});
