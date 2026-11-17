// tc_run — verifies the version-refusal path now lists versions inline (mirrors tc_get's
// refusal). Before this fix the message just said "look at tc_get's `versions[]`", which the
// model often ignored — asking the user for an ID they didn't know or guessing a name that
// the adapter would silently forward. See adapter.startRun.version.test.ts for the adapter
// half of the fix.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { TestCase } from '../domain/types.js';
import { registerRunTools } from './run.tools.js';

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
  currentVersionId: 'ver-1',
  versions: [
    { id: 'ver-1', name: 'v1.0', isCurrent: true },
    { id: 'ver-2', name: 'v2.0', isCurrent: false },
  ],
  steps: [],
};

const singleVersionTc: TestCase = {
  ...multiVersionTc,
  versions: [{ id: 'ver-1', name: 'v1.0', isCurrent: true }],
};

describe('tc_run version refusal', () => {
  it('refuses with an inline version listing when versionId is undefined on a multi-version TC', async () => {
    const cap = captureHandlers(['tc_run']);
    const adapter = { getTestCase: async () => multiVersionTc } as unknown as ProviderAdapter;
    registerRunTools(cap.server, { getAdapter: () => adapter });

    const res = await cap.get('tc_run')({
      tcId: '42', mode: 'cloud', when: 'immediate',
      releaseId: '', sprintId: '', environment: 'general', browser: 'chromium',
      // versionId deliberately omitted
    });

    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>).map((c) => c.text).join('');
    expect(text).toMatch(/2 versions/);
    expect(text).toMatch(/ver-1/);
    expect(text).toMatch(/v1\.0/);
    expect(text).toMatch(/ver-2/);
    expect(text).toMatch(/v2\.0/);
    expect(text).toMatch(/id OR its name/);
  });

  it('does NOT refuse when the TC has a single version (auto-accepts, matches UI default)', async () => {
    const cap = captureHandlers(['tc_run']);
    // The single-version TC path goes past the version guard and into startRun. Stub startRun
    // to return a runId — we only need to prove we got past the refusal.
    const adapter = {
      getTestCase: async () => singleVersionTc,
      startRun: async () => ({ runId: 'run-ok' }),
    } as unknown as ProviderAdapter;
    registerRunTools(cap.server, { getAdapter: () => adapter });

    const res = await cap.get('tc_run')({
      tcId: '42', mode: 'local', when: 'immediate',
      releaseId: '', sprintId: '', environment: 'general', browser: 'chromium',
      // No agentId → tool skips the online-check and calls startRun directly (auto-pick path).
    });

    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>).map((c) => c.text).join('');
    expect(text).toMatch(/run-ok/);
  });
});
