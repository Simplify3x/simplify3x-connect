// coverage.suites — suite / execution-plan / test-plan / pipeline handlers.
// These modules had almost no coverage: the tests below drive the real in-process MCP server and
// assert both the user-facing text and the exact adapter call (including the two-step delete /
// remove preview→confirm contract, which must never write on the first call).

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { Suite } from '../domain/types.js';
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

const suite = (name: string, members: Array<{ tcId: string; order: number }>): Suite => ({ id: 'SU-5', name, members });

// The product gates each tool on the FULL write surface being present (it is all-or-nothing per
// provider), so every test supplies the whole set and overrides only what it asserts.
const suiteStubs = {
  suiteDeletePreview: async () => ({ suite: { id: '5' }, blockers: { schedules: [], pipelines: [], executionPlans: [], testPlans: [] } }),
  deleteSuite: async () => undefined,
  updateSuite: async () => ({}),
  updateSuiteSettings: async () => ({}),
  getSuiteSettings: async () => ({
    id: '5', autoReExecCount: 0, autoDefectLog: false, newBrowserSession: false, terminateOnFailure: false,
  }),
};
const planStubs = {
  createExecutionPlan: async () => ({ id: '1' }),
  updateExecutionPlan: async () => ({}),
  executionPlanDeletePreview: async () => ({ plan: { id: '1' }, entries: 0, schedules: [] }),
  deleteExecutionPlan: async () => undefined,
  addPlanEntries: async () => ({ added: [], skipped: [] }),
  planEntriesRemovePreview: async () => ({ plan: { id: '1' }, entries: [] }),
  removePlanEntries: async () => ({ removed: 0, notRemoved: [] }),
  startExecutionPlanRun: async () => ({ runId: '1', started: [], skipped: [] }),
};
const testPlanStubs = {
  createTestPlan: async () => ({ id: '1' }),
  renameTestPlan: async () => ({}),
  addToTestPlan: async () => ({ added: [], skipped: [] }),
  removeSuiteFromTestPlan: async () => undefined,
  removeTestcaseFromTestPlan: async () => ({ removed: '', remaining: [] }),
  testPlanDeletePreview: async () => ({ plan: { id: '1' }, subFolders: [] }),
  deleteTestPlan: async () => undefined,
};
const pipelineStubs = {
  createPipeline: async () => ({ id: '1' }),
  updatePipeline: async () => ({}),
  pipelineDeletePreview: async () => ({ id: '1' }),
  deletePipeline: async () => undefined,
  startPipeline: async () => ({ runId: '1' }),
  getPipelineRun: async () => ({}),
  stopPipelineRun: async () => undefined,
};

describe('suite_create / suite_add_testcases / suite_remove_testcases', () => {
  it('previews a suggested name and creates nothing when `name` is omitted', async () => {
    const getTestCase = jest.fn(async (id: string) => ({
      id,
      title: id === 'TC_1' ? 'Login' : 'Checkout',
      category: 'automated',
    }));
    const createSuite = jest.fn();
    const adapter = { getTestCase, createSuite } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({ name: 'suite_create', arguments: { tcIds: ['TC_1', 'TC_2'] } });

      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toContain('Resolved 2 test cases: Login (TC_1), Checkout (TC_2).');
      expect(textOf(res)).toContain('Suggested suite name: "Login + 1 more Suite"');
      const sc = structured<{ preview?: boolean; suggestedName?: string; testCases?: unknown[] }>(res);
      expect(sc.preview).toBe(true);
      expect(sc.suggestedName).toBe('Login + 1 more Suite');
      expect(sc.testCases).toHaveLength(2);
      expect(createSuite).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('creates the suite with ordered members and forwards the description', async () => {
    const getTestCase = jest.fn(async (id: string) => ({
      id,
      title: id === 'TC_1' ? 'Login' : 'Checkout',
      category: 'automated',
    }));
    const createSuite = jest.fn(async () => ({ id: 'SU-9', created: true, productUrl: 'https://qa/suites/SU-9' }));
    const adapter = { getTestCase, createSuite } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({
        name: 'suite_create',
        arguments: { tcIds: ['TC_1', 'TC_2'], name: 'Smoke suite', description: 'runs daily' },
      });

      expect(res.isError).toBeFalsy();
      expect(createSuite).toHaveBeenCalledWith({
        name: 'Smoke suite',
        description: 'runs daily',
        members: [
          { tcId: 'TC_1', order: 1 },
          { tcId: 'TC_2', order: 2 },
        ],
      });
      expect(textOf(res)).toContain('Created suite **Smoke suite** · SU-9 with 2 test cases: Login, Checkout.');
      expect(textOf(res)).toContain('https://qa/suites/SU-9');
      expect(structured<{ savedRef?: { id: string } }>(res).savedRef?.id).toBe('SU-9');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('refuses a mixed manual + automated suite before creating anything', async () => {
    const getTestCase = jest.fn(async (id: string) => ({
      id,
      title: id === 'TC_1' ? 'Manual check' : 'Recorded flow',
      category: id === 'TC_1' ? 'manual' : 'automated',
    }));
    const createSuite = jest.fn();
    const adapter = { getTestCase, createSuite } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({ name: 'suite_create', arguments: { tcIds: ['TC_1', 'TC_2'], name: 'Mixed' } });

      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('a suite can only hold ONE category');
      expect(textOf(res)).toContain('Manual: Manual check (TC_1)');
      expect(textOf(res)).toContain('Automated: Recorded flow (TC_2)');
      expect(createSuite).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('adds test cases with add ops and reports the resolved titles', async () => {
    const updateSuiteMembers = jest.fn(async () => suite('Smoke', [
      { tcId: 'TC_1', order: 1 },
      { tcId: 'TC_2', order: 2 },
    ]));
    const getTestCase = jest.fn(async (id: string) => ({ id, title: id === 'TC_2' ? 'Checkout' : 'Login' }));
    const adapter = { updateSuiteMembers, getTestCase } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({ name: 'suite_add_testcases', arguments: { suiteId: 'SU-5', tcIds: ['TC_2'] } });

      expect(res.isError).toBeFalsy();
      expect(updateSuiteMembers).toHaveBeenCalledWith('SU-5', [{ op: 'add', tcId: 'TC_2' }]);
      expect(textOf(res)).toContain('Added 1 test case to **Smoke**: Checkout (TC_2) — now 2 test cases total.');
      expect(textOf(res)).toContain('| 2 | TC_2 |');
      expect(structured<{ suite?: { members?: unknown[] } }>(res).suite?.members).toHaveLength(2);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('removes test cases with remove ops', async () => {
    const updateSuiteMembers = jest.fn(async () => suite('Smoke', [{ tcId: 'TC_1', order: 1 }]));
    const adapter = { updateSuiteMembers } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({ name: 'suite_remove_testcases', arguments: { suiteId: 'SU-5', tcIds: ['TC_2', 'TC_3'] } });

      expect(res.isError).toBeFalsy();
      expect(updateSuiteMembers).toHaveBeenCalledWith('SU-5', [
        { op: 'remove', tcId: 'TC_2' },
        { op: 'remove', tcId: 'TC_3' },
      ]);
      expect(textOf(res)).toContain('Removed 2 test cases from **Smoke** — now 1 test case total.');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('suite_manage', () => {
  it('sends suite fields and settings in one update', async () => {
    const updateSuite = jest.fn(async () => ({}));
    const updateSuiteSettings = jest.fn(async () => ({}));
    const adapter = { ...suiteStubs, updateSuite, updateSuiteSettings } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({
        name: 'suite_manage',
        arguments: {
          action: 'update', suiteId: 'SU-5', name: 'Smoke v2', executionType: 'stack',
          settings: { autoReExecCount: 2, terminateOnFailure: false },
        },
      });

      expect(res.isError).toBeFalsy();
      expect(updateSuite).toHaveBeenCalledWith('SU-5', { name: 'Smoke v2', executionType: 'stack' });
      expect(updateSuiteSettings).toHaveBeenCalledWith('SU-5', { autoReExecCount: 2, terminateOnFailure: false });
      expect(textOf(res)).toContain('Updated suite SU-5 — execution type STACK.');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('previews a delete without writing, then deletes only on confirm', async () => {
    const suiteRef = { id: '5', code: 'SU-5', name: 'Smoke' };
    const suiteDeletePreview = jest.fn(async () => ({
      suite: suiteRef,
      blockers: { schedules: [], pipelines: [], executionPlans: [], testPlans: [] },
    }));
    const deleteSuite = jest.fn(async () => undefined);
    const adapter = { ...suiteStubs, suiteDeletePreview, deleteSuite } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const preview = await client.callTool({ name: 'suite_manage', arguments: { action: 'delete', suiteId: 'SU-5' } });
      expect(preview.isError).toBeFalsy();
      expect(textOf(preview)).toContain('About to delete suite **Smoke** (SU-5).');
      expect(textOf(preview)).toContain('Nothing has been deleted yet.');
      expect(structured<{ preview?: boolean }>(preview).preview).toBe(true);
      expect(deleteSuite).not.toHaveBeenCalled();

      const confirmed = await client.callTool({
        name: 'suite_manage',
        arguments: { action: 'delete', suiteId: 'SU-5', confirm: true },
      });
      expect(confirmed.isError).toBeFalsy();
      expect(textOf(confirmed)).toContain('Deleted suite SU-5 Smoke.');
      expect(deleteSuite).toHaveBeenCalledTimes(1);
      expect(deleteSuite).toHaveBeenCalledWith('SU-5');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('refuses to delete a suite still used by an execution plan', async () => {
    const suiteDeletePreview = jest.fn(async () => ({
      suite: { id: '5', code: 'SU-5', name: 'Smoke' },
      blockers: {
        schedules: [], pipelines: [], testPlans: [],
        executionPlans: [{ id: '8', code: 'PL-8', name: 'Nightly' }],
      },
    }));
    const deleteSuite = jest.fn();
    const adapter = { ...suiteStubs, suiteDeletePreview, deleteSuite } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({ name: 'suite_manage', arguments: { action: 'delete', suiteId: 'SU-5', confirm: true } });

      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("SU-5 Smoke can't be deleted — it is still used by:");
      expect(textOf(res)).toContain('- execution plans: PL-8 Nightly');
      expect(deleteSuite).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('execution_plan', () => {
  it('rejects an inverted date range and a create missing required fields, writing nothing', async () => {
    const createExecutionPlan = jest.fn();
    const adapter = { ...planStubs, createExecutionPlan } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const inverted = await client.callTool({
        name: 'execution_plan',
        arguments: {
          action: 'create', name: 'Sprint 4', plannedStartDate: '2026-02-10',
          plannedEndDate: '2026-02-01', environment: 'general',
        },
      });
      expect(inverted.isError).toBe(true);
      expect(textOf(inverted)).toContain('plannedEndDate must be on or after plannedStartDate.');

      const missing = await client.callTool({
        name: 'execution_plan',
        arguments: { action: 'create', name: 'Sprint 4', plannedStartDate: '2026-02-01', plannedEndDate: '2026-02-28' },
      });
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toContain('execution_plan action:"create" needs: environment.');
      expect(createExecutionPlan).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('creates a plan, converting release/sprint ids to numbers', async () => {
    const createExecutionPlan = jest.fn(async () => ({ id: '77', code: 'PL-77' }));
    const adapter = { ...planStubs, createExecutionPlan } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({
        name: 'execution_plan',
        arguments: {
          action: 'create', name: 'Sprint 4', plannedStartDate: '2026-02-01', plannedEndDate: '2026-02-28',
          environment: 'general', releaseId: 'R-7', sprintId: 'SP-9', teamIds: [1, 2], autoDefectLog: false,
        },
      });

      expect(res.isError).toBeFalsy();
      expect(createExecutionPlan).toHaveBeenCalledWith({
        name: 'Sprint 4', plannedStartDate: '2026-02-01', plannedEndDate: '2026-02-28',
        environment: 'general', releaseId: 7, iterationId: 9, teamIds: [1, 2], autoDefectLog: false,
      });
      expect(textOf(res)).toContain('Created execution plan PL-77 "Sprint 4".');
      expect(structured<{ plan?: { id: string } }>(res).plan?.id).toBe('77');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('previews remove_testcases (with the run-history warning) then removes on confirm', async () => {
    const planEntriesRemovePreview = jest.fn(async () => ({
      plan: { id: '77', code: 'PL-77', name: 'Sprint 4' },
      entries: [
        { id: '1', code: 'TC-1', tcName: 'Login' },
        { id: '2', code: 'TC-2', tcName: 'Checkout' },
      ],
    }));
    const removePlanEntries = jest.fn(async () => ({ removed: 2, notRemoved: [] }));
    const adapter = { ...planStubs, planEntriesRemovePreview, removePlanEntries } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const preview = await client.callTool({
        name: 'execution_plan',
        arguments: { action: 'remove_testcases', planId: 'PL-77', tcIds: ['TC-1', 'TC-2'] },
      });
      expect(preview.isError).toBeFalsy();
      expect(planEntriesRemovePreview).toHaveBeenCalledWith('PL-77', ['TC-1', 'TC-2']);
      expect(textOf(preview)).toContain('About to remove 2 entries (TC-1, TC-2)');
      expect(textOf(preview)).toContain('this also DELETES their run history');
      expect(removePlanEntries).not.toHaveBeenCalled();

      const confirmed = await client.callTool({
        name: 'execution_plan',
        arguments: { action: 'remove_testcases', planId: 'PL-77', tcIds: ['TC-1', 'TC-2'], confirm: true },
      });
      expect(confirmed.isError).toBeFalsy();
      expect(removePlanEntries).toHaveBeenCalledWith('PL-77', ['TC-1', 'TC-2']);
      expect(textOf(confirmed)).toContain('Removed 2 entries from PL-77.');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('test_plan / pipeline', () => {
  it('removes ONE test case from a test plan with the chosen version', async () => {
    const removeTestcaseFromTestPlan = jest.fn(async () => ({ removed: 'TC-9', remaining: [3, 5] }));
    const adapter = { ...testPlanStubs, removeTestcaseFromTestPlan } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({
        name: 'test_plan',
        arguments: { action: 'remove_testcase', testPlanId: 'TP-4', tcId: 'TC-9', versionId: 'v-2' },
      });

      expect(res.isError).toBeFalsy();
      expect(removeTestcaseFromTestPlan).toHaveBeenCalledWith('TP-4', 'TC-9', 'v-2');
      expect(textOf(res)).toContain('Removed TC-9 from test plan TP-4. The plan still has: 3, 5.');
      expect(structured<{ remaining?: number[] }>(res).remaining).toStrictEqual([3, 5]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('creates a pipeline with exactly the supplied optional fields', async () => {
    const createPipeline = jest.fn(async () => ({ id: '9', code: 'PIPE-9' }));
    const adapter = { ...pipelineStubs, createPipeline } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({
        name: 'pipeline',
        arguments: {
          action: 'create', name: 'Nightly', pipelineType: 'TC', parentId: 'TC-9', mode: 'cloud',
          releaseId: 'R-1', sprintId: 'SP-2', browser: 'chrome', description: 'nightly run',
        },
      });

      expect(res.isError).toBeFalsy();
      expect(createPipeline).toHaveBeenCalledWith({
        name: 'Nightly', pipelineType: 'TC', parentId: 'TC-9', mode: 'cloud',
        releaseId: 'R-1', sprintId: 'SP-2', browser: 'chrome', description: 'nightly run',
      });
      expect(textOf(res)).toContain('Created pipeline PIPE-9 "Nightly".');
      expect(structured<{ code?: string }>(res).code).toBe('PIPE-9');
    } finally {
      await client.close();
      await server.close();
    }
  });

});
