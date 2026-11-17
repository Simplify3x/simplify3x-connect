// tc_get — verifies the version-prompt refusal path + the header/rendering when a version resolves.
// Complements adapter.getTestCase.test.ts (which pins the wire→neutral mapping); this test lives at
// the tool layer to confirm the MCP contract the caller sees.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { TestCase } from '../domain/types.js';
import { registerDiscoveryTools } from './discovery.tools.js';

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

const multiVersionTc: TestCase = {
  id: '42',
  title: 'Checkout flow',
  priority: 'high',
  category: 'automated',
  currentVersionId: 'ver-current',
  versions: [
    { id: 'ver-current', name: 'v1.0', isCurrent: true, reviewApproveStatus: 'APPROVED' },
    { id: 'ver-2', name: 'v2.0', isCurrent: false },
  ],
  steps: [
    { n: 1, description: 'Login', stepType: 'web', actionType: 'Click' },
    { n: 2, description: '', stepType: 'control_flow', actionType: '', controlFlow: { kind: 'IF', conditionText: 'title == "Products"' } },
    { n: 3, description: '', stepType: 'function', actionType: '', functionCall: { testCaseId: '99', testCaseCode: 'FN_99', testCaseName: 'Login helper' } },
    { n: 4, description: '', stepType: 'function_end', actionType: '', controlFlow: { kind: 'FUNCTION_END' } },
    { n: 5, description: '', stepType: 'control_flow', actionType: '', controlFlow: { kind: 'IF_END' } },
  ],
};

describe('tc_get', () => {
  it('refuses when TC has multiple versions and no versionId is passed', async () => {
    const cap = captureHandlers(['tc_get']);
    const adapter = { getTestCase: async () => multiVersionTc } as unknown as ProviderAdapter;
    registerDiscoveryTools(cap.server, { getAdapter: () => adapter });

    const res = await cap.get('tc_get')({ id: '42' });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>).map((c) => c.text).join('');
    expect(text).toMatch(/2 versions/);
    expect(text).toMatch(/ver-current/);
    expect(text).toMatch(/ver-2/);
    expect(text).toMatch(/ASK the user/i);
  });

  it("versionId: '' accepts the current version without prompting", async () => {
    const cap = captureHandlers(['tc_get']);
    const calls: Array<{ id: string; versionId?: string }> = [];
    const adapter = {
      getTestCase: async (id: string, versionId?: string) => {
        calls.push({ id, ...(versionId !== undefined ? { versionId } : {}) });
        return multiVersionTc;
      },
    } as unknown as ProviderAdapter;
    registerDiscoveryTools(cap.server, { getAdapter: () => adapter });

    const res = await cap.get('tc_get')({ id: '42', versionId: '' });
    expect(res.isError).toBeFalsy();
    // Pre-flight read (no versionId) is the only call — '' means "accept current, no override".
    expect(calls).toEqual([{ id: '42' }]);
  });

  it('with explicit versionId, fetches that version and renders FUNCTION + IF rows properly', async () => {
    const cap = captureHandlers(['tc_get']);
    const calls: Array<{ id: string; versionId?: string }> = [];
    const adapter = {
      getTestCase: async (id: string, versionId?: string) => {
        calls.push({ id, ...(versionId !== undefined ? { versionId } : {}) });
        return multiVersionTc;
      },
    } as unknown as ProviderAdapter;
    registerDiscoveryTools(cap.server, { getAdapter: () => adapter });

    const res = await cap.get('tc_get')({ id: '42', versionId: 'ver-2' });
    expect(res.isError).toBeFalsy();
    // Two calls: pre-flight (no versionId) + version-pinned fetch.
    expect(calls).toEqual([{ id: '42' }, { id: '42', versionId: 'ver-2' }]);
    const text = (res.content as Array<{ text: string }>).map((c) => c.text).join('');
    expect(text).toMatch(/version: v1\.0/);
    expect(text).toMatch(/2 total/);
    expect(text).toMatch(/\*\*FUNCTION\*\*/);
    expect(text).toMatch(/FN_99 \/ Login helper/);
    expect(text).toMatch(/\*\*IF\*\*/);
    expect(text).toMatch(/title == "Products"/);
    expect(text).toMatch(/\*\*END FUNCTION\*\*/);
    expect(text).toMatch(/\*\*END IF\*\*/);
  });

  it('single-version TC renders without prompting', async () => {
    const cap = captureHandlers(['tc_get']);
    const singleVer: TestCase = {
      ...multiVersionTc,
      versions: [{ id: 'ver-only', name: 'v1.0', isCurrent: true }],
      currentVersionId: 'ver-only',
    };
    const adapter = { getTestCase: async () => singleVer } as unknown as ProviderAdapter;
    registerDiscoveryTools(cap.server, { getAdapter: () => adapter });

    const res = await cap.get('tc_get')({ id: '42' });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>).map((c) => c.text).join('');
    expect(text).toMatch(/version: v1\.0/);
    expect(text).not.toMatch(/ total/); // No "N total" suffix for single-version TCs
  });
});
