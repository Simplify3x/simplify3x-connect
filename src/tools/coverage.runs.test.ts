// coverage.runs — the run surface: the tc_run / suite_run refusal cascade, cloud+agent eligibility,
// schedule creation payloads, run_status rollups and drill-down, run_history, run_stop, the schedule
// management tools and the agent/runner/device listings. Driven through a real in-process MCP client
// so the assertions cover what a caller actually sees plus the exact adapter arguments.
//
// Fake adapters carry `listAgentTools` (no `callRaw`) so the recording passthrough short-circuits.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { RunStatus } from '../domain/types.js';
import { DraftStore } from '../drafts/store.js';
import { buildServer } from '../server.js';

type Harness = { client: Client; server: McpServer };

async function connect(adapter: ProviderAdapter | null): Promise<Harness> {
  const server = buildServer({
    adapter,
    connection: undefined,
    mode: 'connected',
    drafts: new DraftStore(),
    openEditorWindow: async () => false,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new McpClient({ name: 'coverage-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

function textOf(res: unknown): string {
  const content = ((res as { content?: Array<{ type: string; text?: string }> }).content ?? []);
  return content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
}

function structured<T>(res: unknown): T {
  return (res as { structuredContent?: T }).structuredContent as T;
}

const NO_AGENT = { listAgentTools: async () => [{ name: 'info' }] };

/** A WEB test case with one version — the shortest thing that clears the cascade. */
const webTc = {
  id: '42', title: 'Checkout flow', category: 'automated', technologyType: 'WEB',
  currentVersionId: 'v-1', versions: [{ id: 'v-1', name: 'v1.0', isCurrent: true }], steps: [],
};

const runner = (over: Record<string, unknown> = {}) => ({
  id: 'cr-1', name: 'Cloud VM 1', online: true, os: 'linux', status: 'idle', credentialId: 'cred-x', cloudType: 'aws',
  ...over,
});

describe('tc_run refusal cascade', () => {
  it('walks when → mode → release → sprint → environment → browser, then starts the run', async () => {
    const getTestCase = jest.fn(async () => webTc);
    const startRun = jest.fn(async () => ({ runId: 'run-1', reportUrl: 'https://qa/runs/run-1' }));
    const { client, server } = await connect({ ...NO_AGENT, getTestCase, startRun } as unknown as ProviderAdapter);
    try {
      const steps: Array<[Record<string, unknown>, string]> = [
        [{ tcId: '42' }, 'Specify WHEN to run'],
        [{ tcId: '42', when: 'immediate' }, 'Specify where to run'],
        [{ tcId: '42', when: 'immediate', mode: 'local' }, 'ASK the user which RELEASE'],
        [{ tcId: '42', when: 'immediate', mode: 'local', releaseId: 'R_9' }, 'ASK the user which SPRINT'],
        [{ tcId: '42', when: 'immediate', mode: 'local', releaseId: 'R_9', sprintId: '' }, 'ASK the user which ENVIRONMENT'],
        [
          { tcId: '42', when: 'immediate', mode: 'local', releaseId: 'R_9', sprintId: '', environment: 'qa' },
          'ASK the user which BROWSER',
        ],
      ];
      for (const [args, expected] of steps) {
        const res = await client.callTool({ name: 'tc_run', arguments: args });
        expect(res.isError).toBe(true);
        expect(textOf(res)).toContain(expected);
      }
      expect(startRun).not.toHaveBeenCalled();

      const res = await client.callTool({
        name: 'tc_run',
        arguments: {
          tcId: '42', when: 'immediate', mode: 'local', releaseId: 'R_9',
          sprintId: '', environment: 'qa', browser: 'chromium',
        },
      });
      expect(res.isError).toBeFalsy();
      // Skipped release/sprint/version values are omitted, not sent as empty strings.
      expect(startRun).toHaveBeenCalledWith({ tcId: '42' }, {
        mode: 'local', environment: 'qa', browser: 'chromium', releaseId: 'R_9',
      });
      expect(textOf(res)).toContain('Started 42 locally on your online agent. Run id `run-1`');
      expect(textOf(res)).toContain('Report: https://qa/runs/run-1');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('refuses cloud runs with no online runner, rejects an offline pick, then pins the online one', async () => {
    const startRun = jest.fn(async () => ({ runId: 'run-cloud' }));
    const listCloudRunners = jest.fn(async () => [runner({ id: 'cr-1', name: 'Cloud VM 1' })]);
    const base = {
      tcId: '42', when: 'immediate', mode: 'cloud', releaseId: '', environment: 'qa', browser: 'chromium',
    };
    // Round 1: nothing online.
    const none = await connect({ ...NO_AGENT, getTestCase: async () => webTc, startRun, listCloudRunners: async () => [runner({ online: false })] } as unknown as ProviderAdapter);
    try {
      const res = await none.client.callTool({ name: 'tc_run', arguments: base });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('Currently there are no active cloud runners in your project.');
      expect(startRun).not.toHaveBeenCalled();
    } finally {
      await none.client.close();
      await none.server.close();
    }

    const { client, server } = await connect({ ...NO_AGENT, getTestCase: async () => webTc, startRun, listCloudRunners } as unknown as ProviderAdapter);
    try {
      const missing = await client.callTool({ name: 'tc_run', arguments: { ...base, cloudRunnerId: 'cr-9' } });
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toContain('Cloud runner "cr-9" is not online. Online now:');
      expect(textOf(missing)).toContain('- 🟢 Cloud VM 1 · linux `cr-1` (idle)');

      const res = await client.callTool({ name: 'tc_run', arguments: { ...base, cloudRunnerId: 'cr-1' } });
      expect(res.isError).toBeFalsy();
      expect(startRun).toHaveBeenCalledWith({ tcId: '42' }, {
        mode: 'cloud', environment: 'qa', browser: 'chromium', cloudRunnerId: 'cr-1', cloudType: 'aws',
      });
      expect(textOf(res)).toContain('Started 42 on cloud runner **Cloud VM 1**. Run id `run-cloud`');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('requires an explicit remote agent and refuses an offline one for a run-now', async () => {
    const startRun = jest.fn(async () => ({ runId: 'run-remote' }));
    const listLocalAgents = jest.fn(async () => [
      { id: 'cred-offline', name: 'rishi', host: 'SIMLAP24', online: false },
      { id: 'cred-on', name: 'rishi', host: 'SIMLAP24', online: true },
      { id: 'cred-mine', name: 'vignesh', online: false, isThisMachine: true },
    ]);
    const { client, server } = await connect({ ...NO_AGENT, getTestCase: async () => webTc, startRun, listLocalAgents } as unknown as ProviderAdapter);
    try {
      const base = {
        tcId: '42', when: 'immediate', mode: 'remote', releaseId: '', environment: 'qa', browser: 'chromium',
      };
      const noAgent = await client.callTool({ name: 'tc_run', arguments: base });
      expect(noAgent.isError).toBe(true);
      expect(textOf(noAgent)).toContain('REMOTE runs need an explicit agentId.');

      const offline = await client.callTool({ name: 'tc_run', arguments: { ...base, agentId: 'cred-offline' } });
      expect(offline.isError).toBe(true);
      expect(textOf(offline)).toContain('Agent `cred-offline` (rishi) is offline — a run-now needs an ONLINE agent.');
      expect(textOf(offline)).toContain('- 🟢 rishi · SIMLAP24 `cred-on`');
      expect(startRun).not.toHaveBeenCalled();

      // This machine's own row is never refused — its DB online flag is stale by design.
      const ownMachine = await client.callTool({ name: 'tc_run', arguments: { ...base, agentId: 'cred-mine' } });
      expect(ownMachine.isError).toBeFalsy();
      expect(startRun).toHaveBeenCalledWith({ tcId: '42' }, {
        mode: 'remote', agentId: 'cred-mine', environment: 'qa', browser: 'chromium',
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('schedules', () => {
  it('asks for the schedule fields and a local agent before creating anything', async () => {
    const createSchedule = jest.fn(async () => ({ id: 'S-1', nextRunAt: '2026-08-20T09:00:00Z' }));
    const listLocalAgents = jest.fn(async () => [{ id: 'cred-1', name: 'rishi', host: 'SIMLAP24', online: false }]);
    const { client, server } = await connect({ ...NO_AGENT, getTestCase: async () => webTc, createSchedule, listLocalAgents } as unknown as ProviderAdapter);
    try {
      const base = {
        tcId: '42', when: 'schedule', mode: 'local', releaseId: '', environment: 'qa', browser: 'chromium',
      };
      const noStart = await client.callTool({ name: 'tc_run', arguments: base });
      expect(noStart.isError).toBe(true);
      expect(textOf(noStart)).toContain('`scheduledFor` — when the first (or only) run starts');
      expect(textOf(noStart)).toContain('`scheduleType` — how often it repeats.');

      const noEnd = await client.callTool({
        name: 'tc_run', arguments: { ...base, scheduledFor: '2026-08-20T09:00:00Z', scheduleType: 'daily' },
      });
      expect(noEnd.isError).toBe(true);
      expect(textOf(noEnd)).toContain('`endDate` — when the repetition stops');

      const noAgent = await client.callTool({
        name: 'tc_run',
        arguments: { ...base, scheduledFor: '2026-08-20T09:00:00Z', scheduleType: 'daily', endDate: '2026-09-20' },
      });
      expect(noAgent.isError).toBe(true);
      expect(textOf(noAgent)).toContain('A LOCAL schedule runs detached from any live session, so it must target a specific agent.');
      expect(textOf(noAgent)).toContain('- ⚪ rishi · SIMLAP24 `cred-1`');
      expect(createSchedule).not.toHaveBeenCalled();

      const created = await client.callTool({
        name: 'tc_run',
        arguments: {
          ...base, agentId: 'cred-1', scheduledFor: '2026-08-20T09:00:00Z',
          scheduleType: 'daily', endDate: '2026-09-20', timezone: 'Asia/Kolkata',
        },
      });
      expect(created.isError).toBeFalsy();
      expect(createSchedule).toHaveBeenCalledWith({ tcId: '42' }, {
        mode: 'local', scheduledFor: '2026-08-20T09:00:00Z', agentId: 'cred-1', browser: 'chromium',
        environmentId: 'qa', scheduleType: 'daily', endDate: '2026-09-20', timezone: 'Asia/Kolkata',
      });
      expect(textOf(created)).toContain(
        'Scheduled 42 (daily, local) for 2026-08-20T09:00:00Z · first run 2026-08-20T09:00:00Z → agent `cred-1`. Schedule id `S-1`.',
      );
      expect(structured<{ when: string; schedule: { id: string } }>(created).when).toBe('schedule');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('pins a cloud runner credential only when the user picked one', async () => {
    const createSchedule = jest.fn(async (_target: unknown, _opts: unknown) => ({ id: 'S-9' }));
    const listCloudRunners = jest.fn(async () => [runner({ id: 'cr-1', name: 'Cloud VM 1', credentialId: 'cred-x' })]);
    const { client, server } = await connect({ ...NO_AGENT, getTestCase: async () => webTc, createSchedule, listCloudRunners } as unknown as ProviderAdapter);
    try {
      const args = {
        tcId: '42', when: 'schedule', mode: 'cloud', releaseId: '', environment: 'qa', browser: 'chromium',
        scheduledFor: '2026-08-20T09:00:00Z', scheduleType: 'once',
      };
      const pinned = await client.callTool({ name: 'tc_run', arguments: { ...args, cloudRunnerId: 'cr-1' } });
      expect(pinned.isError).toBeFalsy();
      expect(createSchedule).toHaveBeenLastCalledWith({ tcId: '42' }, {
        mode: 'cloud', scheduledFor: '2026-08-20T09:00:00Z', cloudRunnerCredentialId: 'cred-x',
        browser: 'chromium', environmentId: 'qa', scheduleType: 'once',
      });
      expect(textOf(pinned)).toContain('→ cloud runner **Cloud VM 1**.');

      const unpinned = await client.callTool({ name: 'tc_run', arguments: args });
      expect(unpinned.isError).toBeFalsy();
      const lastOpts = createSchedule.mock.calls.at(-1)![1] as Record<string, unknown>;
      expect(lastOpts['cloudRunnerCredentialId']).toBeUndefined();
      expect(textOf(unpinned)).toContain('→ cloud (auto-pick a live VM at run time).');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('manages schedules: list, edit, pause, and a two-step delete', async () => {
    const listSchedules = jest.fn(async () => [
      {
        id: 'S-1', target: 'TC_2271 — Login', scheduleType: 'daily', status: 'scheduled',
        executionTarget: 'cloud_runner', agent: 'rishi · SIMLAP24', browser: 'chromium',
        nextRunAt: '2026-08-21T09:00:00Z', active: false,
      },
      { id: 'S-2', target: 'Suite: Smoke', scheduleType: 'once', status: 'scheduled', executionTarget: 'local', scheduledFor: '2026-08-20T09:00:00Z' },
    ]);
    const updateSchedule = jest.fn(async () => ({ id: 'S-1', nextRunAt: '2026-08-22T09:00:00Z' }));
    const controlSchedule = jest.fn(async () => ({ id: 'S-1', status: 'paused' }));
    const scheduleDeletePreview = jest.fn(async () => ({ id: 'S-1', code: 'SCH-1', name: 'nightly login', target: 'TC_2271 — Login' }));
    const deleteSchedule = jest.fn(async () => undefined);
    const { client, server } = await connect({
      ...NO_AGENT, listSchedules, updateSchedule, controlSchedule, scheduleDeletePreview, deleteSchedule,
    } as unknown as ProviderAdapter);
    try {
      const list = await client.callTool({ name: 'schedule_list', arguments: {} });
      expect(list.isError).toBeFalsy();
      expect(textOf(list)).toContain('2 schedules:');
      expect(textOf(list)).toContain(
        '- TC_2271 — Login — daily, cloud → rishi · SIMLAP24 · chromium · next 2026-08-21T09:00:00Z · **scheduled** [paused] `S-1`',
      );
      expect(textOf(list)).toContain('- Suite: Smoke — once, local · at 2026-08-20T09:00:00Z · **scheduled** `S-2`');

      const empty = await client.callTool({ name: 'schedule_update', arguments: { scheduleId: 'S-1' } });
      expect(empty.isError).toBe(true);
      expect(textOf(empty)).toContain('Nothing to change');

      const edited = await client.callTool({
        name: 'schedule_update',
        arguments: {
          scheduleId: 'S-1', scheduledFor: '2026-08-22T09:00:00Z', browser: 'firefox',
          environment: 'env-7', mode: 'local', agentId: 'cred-1',
        },
      });
      expect(edited.isError).toBeFalsy();
      expect(updateSchedule).toHaveBeenCalledWith('S-1', {
        scheduledFor: '2026-08-22T09:00:00Z', browser: 'firefox', environmentId: 'env-7',
        mode: 'local', agentId: 'cred-1',
      });
      expect(textOf(edited)).toContain('Updated schedule `S-1` · next run 2026-08-22T09:00:00Z.');

      const paused = await client.callTool({ name: 'schedule_control', arguments: { scheduleId: 'S-1', action: 'pause' } });
      expect(paused.isError).toBeFalsy();
      expect(controlSchedule).toHaveBeenCalledWith('S-1', 'pause');
      expect(textOf(paused)).toContain('Paused schedule `S-1` · status paused.');

      const preview = await client.callTool({ name: 'schedule_delete', arguments: { scheduleId: 'S-1' } });
      expect(preview.isError).toBeFalsy();
      expect(textOf(preview)).toContain('About to delete schedule SCH-1 (nightly login), which runs TC_2271 — Login. This cannot be undone.');
      expect(deleteSchedule).not.toHaveBeenCalled();

      const deleted = await client.callTool({ name: 'schedule_delete', arguments: { scheduleId: 'S-1', confirm: true } });
      expect(deleted.isError).toBeFalsy();
      expect(textOf(deleted)).toContain('Deleted schedule `S-1`.');
      expect(deleteSchedule).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('suite_run', () => {
  it('asks for SERIAL/PARALLEL, then dispatches with the suite-only options', async () => {
    const startRun = jest.fn(async () => ({ runId: 'run-suite' }));
    const { client, server } = await connect({ ...NO_AGENT, startRun } as unknown as ProviderAdapter);
    try {
      const base = {
        suiteId: 'SU-5', when: 'immediate', mode: 'local', releaseId: 'R_9', sprintId: '',
        environment: 'qa',
      };
      const noStrategy = await client.callTool({ name: 'suite_run', arguments: base });
      expect(noStrategy.isError).toBe(true);
      expect(textOf(noStrategy)).toContain('ASK the user whether this suite should run SERIAL or PARALLEL');
      expect(startRun).not.toHaveBeenCalled();

      const res = await client.callTool({
        name: 'suite_run',
        arguments: {
          ...base, strategy: 'parallel', maxConcurrent: 4, terminateOnFailure: true,
          browser: 'firefox', headless: true,
        },
      });
      expect(res.isError).toBeFalsy();
      expect(startRun).toHaveBeenCalledWith({ suiteId: 'SU-5' }, {
        mode: 'local', environment: 'qa', browser: 'firefox', headless: true,
        releaseId: 'R_9', strategy: 'parallel', maxConcurrent: 4, terminateOnFailure: true,
      });
      expect(textOf(res)).toContain('Started suite SU-5 locally on your online agent. Run id `run-suite`');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('run_status / run_history / run_stop', () => {
  const suiteStatus: RunStatus = {
    runId: 'run-9', state: 'running', progress: { done: 2, total: 4 },
    startedAt: '2026-01-01T10:00:00Z',
    children: [
      { id: 'TC_1', title: 'Login', state: 'passed', testcaseId: '11' },
      { id: 'TC_2', title: 'Checkout', state: 'failed', testcaseId: '12', versionId: 'v-2' },
      { id: 'TC_3', state: 'skipped' },
      { id: 'TC_4', state: 'notExecuted' },
    ],
  };

  it('renders the per-test-case rollup and drills into one child', async () => {
    const getRun = jest.fn(async () => suiteStatus);
    const getLatestSuiteRun = jest.fn(async () => 'run-9');
    const getSuiteChildRun = jest.fn(async () => ({
      runId: 'TC_2-run', state: 'failed', startedAt: '2026-01-01T10:00:05Z', endedAt: '2026-01-01T10:00:15Z',
      stepResults: [{ n: 1, description: 'Click login', status: 'failed', error: 'NoSuchElement\n  at Page.click' }],
    }));
    const { client, server } = await connect({ ...NO_AGENT, getRun, getLatestSuiteRun, getSuiteChildRun } as unknown as ProviderAdapter);
    try {
      const both = await client.callTool({ name: 'run_status', arguments: { runId: 'run-9', suiteId: 'SU-5' } });
      expect(both.isError).toBe(true);
      expect(textOf(both)).toContain('Pass exactly one of `runId` or `suiteId`.');

      const res = await client.callTool({ name: 'run_status', arguments: { suiteId: 'SU-5' } });
      expect(res.isError).toBeFalsy();
      const text = textOf(res);
      expect(text).toContain('Run run-9 · **running** · 2/4 test cases · started 2026-01-01T10:00:00Z');
      expect(text).toContain('1 passed, 1 failed, 1 skipped, 1 notExecuted [per test case] (provisional — run still in progress)');
      expect(text).toContain('- ✅ TC_1 — Login (passed)');
      expect(text).toContain('- ❌ TC_2 — Checkout (failed)');
      expect(text).toContain('plus `tcId` set to one of the ids above.');
      expect(getRun).toHaveBeenCalledWith('run-9');

      const child = await client.callTool({ name: 'run_status', arguments: { runId: 'run-9', tcId: 'TC_2' } });
      expect(child.isError).toBeFalsy();
      expect(getSuiteChildRun).toHaveBeenCalledWith('run-9', { testcaseId: '12', versionId: 'v-2' });
      expect(textOf(child)).toContain('TC_2 — Checkout within suite run run-9:');
      expect(textOf(child)).toContain('**Failed at:**\n- step 1: Click login\n  NoSuchElement\n  at Page.click');
      expect(textOf(child)).toContain('❌ step 1: Click login (failed)');

      const unknown = await client.callTool({ name: 'run_status', arguments: { runId: 'run-9', tcId: 'TC_404' } });
      expect(unknown.isError).toBe(true);
      expect(textOf(unknown)).toContain('"TC_404" is not one of the test cases in this suite run. Available:');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('reports an empty suite history and refuses tcId on a single-TC run', async () => {
    const getRun = jest.fn(async () => ({ runId: 'run-1', state: 'passed', stepResults: [] } as RunStatus));
    const { client, server } = await connect({
      ...NO_AGENT, getRun, getLatestSuiteRun: async () => null,
    } as unknown as ProviderAdapter);
    try {
      const empty = await client.callTool({ name: 'run_status', arguments: { suiteId: 'SU-5' } });
      expect(empty.isError).toBeFalsy();
      expect(textOf(empty)).toContain('Suite SU-5 has no executions yet.');

      const single = await client.callTool({ name: 'run_status', arguments: { runId: 'run-1', tcId: 'TC_1' } });
      expect(single.isError).toBe(true);
      expect(textOf(single)).toContain('is not a suite run (or has no per-test-case rollup yet)');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('renders run history with durations, suite tallies and a clamped limit', async () => {
    const listRecentRuns = jest.fn(async (type: string) => type === 'SUITE'
      ? [{
          runId: 'run-s1', state: 'failed', startedAt: '2026-01-01T10:00:00Z', endedAt: '2026-01-01T10:02:05Z',
          totalTestCases: 3, passed: 2, failed: 1, skipped: 0,
        }]
      : [
          { runId: 'run-1', state: 'passed', startedAt: '2026-01-01T10:00:00Z', endedAt: '2026-01-01T10:00:53Z' },
          { runId: 'run-2', state: 'error', startedAt: '2026-01-01T11:00:00Z' },
        ]);
    const { client, server } = await connect({ ...NO_AGENT, listRecentRuns } as unknown as ProviderAdapter);
    try {
      const tcRes = await client.callTool({ name: 'run_history', arguments: { tcId: '42', limit: 20 } });
      expect(tcRes.isError).toBeFalsy();
      expect(textOf(tcRes)).toContain('Recent executions of test case 42 (2 shown):');
      expect(textOf(tcRes)).toContain('- ✅ run-1 · passed · 2026-01-01T10:00:00Z → 2026-01-01T10:00:53Z (53s)');
      expect(textOf(tcRes)).toContain('- ⚠️ run-2 · error · started 2026-01-01T11:00:00Z');
      expect(textOf(tcRes)).toContain('for step-level detail on any one.');
      expect(listRecentRuns).toHaveBeenCalledWith('TC', '42', 20);

      const suiteRes = await client.callTool({ name: 'run_history', arguments: { suiteId: 'SU-5' } });
      expect(suiteRes.isError).toBeFalsy();
      expect(textOf(suiteRes)).toContain('Recent executions of suite SU-5 (1 shown):');
      expect(textOf(suiteRes)).toContain('- ❌ run-s1 · failed · 2✅/1❌/0⏭ of 3 · 2026-01-01T10:00:00Z → 2026-01-01T10:02:05Z (2m 05s)');
      expect(listRecentRuns).toHaveBeenCalledWith('SUITE', 'SU-5', 5);

      const neither = await client.callTool({ name: 'run_history', arguments: {} });
      expect(neither.isError).toBe(true);
      expect(textOf(neither)).toContain('Pass exactly one of `suiteId` or `tcId`.');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('stops a run and reports the terminal state instead of fire-and-forget', async () => {
    const stopRun = jest.fn(async () => undefined);
    const getRun = jest.fn(async () => ({ runId: 'run-1', state: 'stopped' } as RunStatus));
    const { client, server } = await connect({ ...NO_AGENT, stopRun, getRun } as unknown as ProviderAdapter);
    try {
      const none = await client.callTool({ name: 'run_stop', arguments: {} });
      expect(none.isError).toBe(true);
      expect(textOf(none)).toContain('Pass exactly one of `runId`, `suiteId`, or `tcId`.');

      const noLookup = await client.callTool({ name: 'run_stop', arguments: { tcId: '42' } });
      expect(noLookup.isError).toBe(true);
      expect(textOf(noLookup)).toContain('does not support latest-testcase-run lookup');

      const res = await client.callTool({ name: 'run_stop', arguments: { runId: 'run-1' } });
      expect(res.isError).toBeFalsy();
      expect(stopRun).toHaveBeenCalledWith('run-1');
      expect(textOf(res)).toContain('Run run-1 is now **stopped**.');
    } finally {
      await client.close();
      await server.close();
    }
  }, 10_000);
});

describe('agent / runner / device listings', () => {
  it('lists cloud runners, this machine\'s agent, remote agents and mobile devices', async () => {
    const listCloudRunners = jest.fn(async () => [
      runner({ id: 'cr-1', name: 'Cloud VM 1', online: true }),
      runner({ id: 'cr-2', name: 'Cloud VM 2', online: false, os: undefined, status: undefined }),
    ]);
    const listLocalAgents = jest.fn(async () => [
      { id: 'cred-mine', name: 'vignesh', online: true, host: 'SIMLAP24', isThisMachine: true },
      { id: 'cred-other', name: 'rishi', online: false, host: 'SIMLAP24' },
    ]);
    const listMobileDevices = jest.fn(async () => [
      { id: 'emulator-5554', name: 'Pixel_7', platform: 'ANDROID', deviceType: 'EMULATOR', osVersion: '13', active: true },
      { id: 'R58M', name: 'Oppo', displayName: 'Oppo-Cph2375-Ab1fe936', platform: 'ANDROID', deviceType: 'REAL_DEVICE', active: false, status: 'busy' },
    ]);
    const { client, server } = await connect({
      ...NO_AGENT, listCloudRunners, listLocalAgents, listMobileDevices,
    } as unknown as ProviderAdapter);
    try {
      const runners = await client.callTool({ name: 'cloud_runners', arguments: {} });
      expect(runners.isError).toBeFalsy();
      expect(textOf(runners)).toContain('2 cloud runners · 1 online:');
      expect(textOf(runners)).toContain('- 🟢 Cloud VM 1 · linux `cr-1` (idle)');
      expect(textOf(runners)).toContain('- ⚪ Cloud VM 2 `cr-2`');
      expect(structured<{ online: number }>(runners).online).toBe(1);

      const local = await client.callTool({ name: 'local_agents', arguments: {} });
      expect(local.isError).toBeFalsy();
      expect(textOf(local)).toContain('1 local agent on this machine · 1 online:');
      expect(textOf(local)).toContain('- 🟢 vignesh · SIMLAP24 `cred-mine`');

      const remote = await client.callTool({ name: 'remote_agents', arguments: {} });
      expect(remote.isError).toBeFalsy();
      expect(textOf(remote)).toContain('1 remote agent · 0 online:');
      expect(textOf(remote)).toContain('- ⚪ rishi · SIMLAP24 `cred-other`');

      const devices = await client.callTool({ name: 'mobile_list_devices', arguments: { platform: 'android' } });
      expect(devices.isError).toBeFalsy();
      const text = textOf(devices);
      expect(text).toContain('2 ANDROID devices · 1 active:');
      expect(text).toContain('**EMULATOR** (1)');
      expect(text).toContain('- 🟢 Pixel_7 · android 13 `emulator-5554`');
      expect(text).toContain('**REAL_DEVICE** (1)');
      expect(text).toContain('- ⚪ Oppo-Cph2375-Ab1fe936 · android `R58M` (busy)');
      expect(listMobileDevices).toHaveBeenCalledWith('ANDROID');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('says so when no agent is registered on this machine', async () => {
    const listLocalAgents = jest.fn(async () => [{ id: 'cred-other', name: 'rishi', online: true }]);
    const { client, server } = await connect({ ...NO_AGENT, listLocalAgents } as unknown as ProviderAdapter);
    try {
      const local = await client.callTool({ name: 'local_agents', arguments: {} });
      expect(local.isError).toBeFalsy();
      expect(textOf(local)).toContain('No local agent is registered from this machine.');

      const remote = await client.callTool({ name: 'remote_agents', arguments: {} });
      expect(remote.isError).toBeFalsy();
      expect(textOf(remote)).toContain('1 remote agent · 1 online:');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
