// tc_run / suite_run — in-session reuse-last-config prompt. The prompt fires only when a prior
// successful run in the SAME project left a config behind AND the caller has not answered yet
// (reuseConfig undefined). `reuseConfig: true` merges the remembered environment-level fields
// (when / mode / release / sprint / browser / agent / runner) — the ENVIRONMENT is deliberately
// NOT inherited and is asked on every run. `false` starts fresh. Tests that don't wire getProjectId
// skip the prompt entirely (see the version-refusal suite) — that keeps the raw cascade covered
// without shared-state coupling.

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

const singleVersionTc: TestCase = {
  id: '42', title: 'Checkout flow', priority: 'high', category: 'automated',
  currentVersionId: 'ver-1', versions: [{ id: 'ver-1', name: 'v1.0', isCurrent: true }], steps: [],
};

function textOf(res: CallToolResult): string {
  return (res.content as Array<{ text: string }>).map((c) => c.text).join('');
}

describe('tc_run reuse-config prompt', () => {
  it('first call in a fresh project skips the reuse prompt', async () => {
    const cap = captureHandlers(['tc_run']);
    const adapter = {
      getTestCase: async () => singleVersionTc,
      startRun: async () => ({ runId: 'run-1' }),
    } as unknown as ProviderAdapter;
    registerRunTools(cap.server, { getAdapter: () => adapter, getProjectId: () => 'proj-alpha-1' });

    const res = await cap.get('tc_run')({
      tcId: '42', when: 'immediate', mode: 'local',
      releaseId: '', sprintId: '', environment: 'qa', browser: 'chromium',
    });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/run-1/);
  });

  it('second call in the same project refuses asking to reuse or start fresh', async () => {
    const cap = captureHandlers(['tc_run']);
    const adapter = {
      getTestCase: async () => singleVersionTc,
      startRun: async () => ({ runId: 'run-a' }),
    } as unknown as ProviderAdapter;
    registerRunTools(cap.server, { getAdapter: () => adapter, getProjectId: () => 'proj-alpha-2' });

    await cap.get('tc_run')({
      tcId: '42', when: 'immediate', mode: 'local',
      releaseId: 'R_9', sprintId: 'SP_1', environment: 'staging', browser: 'firefox',
    });
    // Second call: only tcId — should refuse and quote the remembered summary.
    const res2 = await cap.get('tc_run')({ tcId: '42' });
    expect(res2.isError).toBe(true);
    const t = textOf(res2);
    expect(t).toMatch(/Previous run in this project used/);
    expect(t).toMatch(/mode=local/);
    expect(t).toMatch(/release=R_9/);
    expect(t).toMatch(/sprint=SP_1/);
    expect(t).toMatch(/browser=firefox/);
    expect(t).toMatch(/reuseConfig/);
    // The ENVIRONMENT is never inherited, so it is not part of the remembered summary.
    expect(t).not.toMatch(/env=staging/);
  });

  it('reuseConfig: true merges remembered fields but still asks for the environment', async () => {
    const cap = captureHandlers(['tc_run']);
    const startRunCalls: Array<{ target: unknown; opts: unknown }> = [];
    const adapter = {
      getTestCase: async () => singleVersionTc,
      startRun: async (target: unknown, opts: unknown) => { startRunCalls.push({ target, opts }); return { runId: 'run-b' }; },
    } as unknown as ProviderAdapter;
    registerRunTools(cap.server, { getAdapter: () => adapter, getProjectId: () => 'proj-alpha-3' });

    await cap.get('tc_run')({
      tcId: '42', when: 'immediate', mode: 'local',
      releaseId: 'R_9', sprintId: 'SP_1', environment: 'staging', browser: 'firefox',
    });

    // Reuse merges the environment-level fields, but NOT the environment: the run must not
    // silently use the previous run's test-data set. With nothing supplied it refuses and asks.
    const resRefused = await cap.get('tc_run')({ tcId: '42', reuseConfig: true });
    expect(resRefused.isError).toBe(true);
    expect(textOf(resRefused)).toMatch(/ENVIRONMENT/);
    expect(startRunCalls).toHaveLength(1); // the refusal did not start a run

    // Supplying the freshly-asked environment lets the reused config run.
    const res = await cap.get('tc_run')({ tcId: '42', reuseConfig: true, environment: 'qa' });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/run-b/);
    // Verify the merge landed on startRun's opts (remembered fields + the newly asked environment).
    expect(startRunCalls).toHaveLength(2);
    const last = startRunCalls[1]!.opts as Record<string, unknown>;
    expect(last['mode']).toBe('local');
    expect(last['environment']).toBe('qa');
    expect(last['browser']).toBe('firefox');
    expect(last['releaseId']).toBe('R_9');
    expect(last['sprintId']).toBe('SP_1');
  });

  it('reuseConfig: false starts fresh and re-triggers the cascade', async () => {
    const cap = captureHandlers(['tc_run']);
    const adapter = {
      getTestCase: async () => singleVersionTc,
      startRun: async () => ({ runId: 'run-c' }),
    } as unknown as ProviderAdapter;
    registerRunTools(cap.server, { getAdapter: () => adapter, getProjectId: () => 'proj-alpha-4' });

    await cap.get('tc_run')({
      tcId: '42', when: 'immediate', mode: 'local',
      releaseId: 'R_9', sprintId: 'SP_1', environment: 'staging', browser: 'firefox',
    });
    // reuseConfig: false + nothing else → should fall through to the `when` refusal (cascade start).
    const res = await cap.get('tc_run')({ tcId: '42', reuseConfig: false });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Specify WHEN to run/);
  });

  it('sprint question is skipped entirely when release is skipped', async () => {
    const cap = captureHandlers(['tc_run']);
    const adapter = {
      getTestCase: async () => singleVersionTc,
      startRun: async () => ({ runId: 'run-d' }),
    } as unknown as ProviderAdapter;
    // No getProjectId → no reuse prompt; keeps this test isolated from the shared Map.
    registerRunTools(cap.server, { getAdapter: () => adapter });

    // Pass release='', omit sprintId — should not refuse on sprint.
    const res = await cap.get('tc_run')({
      tcId: '42', when: 'immediate', mode: 'local',
      releaseId: '', environment: 'qa', browser: 'chromium',
    });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/run-d/);
  });
});
