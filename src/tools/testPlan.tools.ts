/**
 * `test_plan` — SimplifyQA test plans (scenario folders): create, rename, add suites / test cases,
 * remove a suite or a single test case, and a two-step delete (the folder and every folder below it).
 * SimplifyQA's API checks the privileges itself (add_Scenario_folder / delete_Scenario_folder).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { SuiteRef } from '../adapters/simplifyqa/adapter.js';

export type TestPlanDeps = { getAdapter: () => ProviderAdapter | null };

type TestPlanWrites = {
  createTestPlan: (input: { name: string; parentId?: string }) => Promise<{ id: string; code?: string }>;
  renameTestPlan: (id: string, name: string) => Promise<unknown>;
  addToTestPlan: (id: string, input: { suiteIds?: string[]; tcIds?: string[] }) => Promise<{ added: string[]; skipped: Array<{ code: string; reason: string }> }>;
  removeSuiteFromTestPlan: (id: string, suiteId: string) => Promise<void>;
  removeTestcaseFromTestPlan: (id: string, tcId: string, versionId?: string) => Promise<{ removed: string; remaining: number[] }>;
  testPlanDeletePreview: (id: string) => Promise<{ plan: SuiteRef; subFolders: SuiteRef[] }>;
  deleteTestPlan: (id: string) => Promise<void>;
};

const NOT_CONNECTED =
  'Not connected to a product. Use qa_connect({ url, token, projectId }) first — test_plan needs a live SimplifyQA connection.';

const label = (r: SuiteRef): string => [r.code ?? `#${r.id}`, r.name].filter(Boolean).join(' ');

export function registerTestPlanTools(server: McpServer, deps: TestPlanDeps): void {
  server.registerTool(
    'test_plan',
    {
      title: 'Create / change / delete a SimplifyQA test plan',
      description:
        'Manage SimplifyQA TEST PLANS (the Test Plan folders under Test Execution). Read them with sqa_query collection ' +
        '"testPlans". Actions:\n' +
        '- action:"create" — needs `name`; optional `parentId` (a test plan id) makes it a sub-folder.\n' +
        '- action:"rename" — needs `testPlanId` and `name`.\n' +
        '- action:"add" — needs `testPlanId` and `suiteIds` and/or `tcIds`; ones already in the test plan are skipped.\n' +
        '- action:"remove_suite" — needs `testPlanId` and `suiteId`.\n' +
        '- action:"remove_testcase" — needs `testPlanId` and `tcId` (optional `versionId` when the folder has ' +
        'several versions of it). Removes ONLY that test case; the plan is re-read to confirm. Suites, other test ' +
        'cases and sub-folders are untouched.\n' +
        '- action:"delete" — needs `testPlanId`. TWO-STEP: the first call only previews (it deletes every folder below ' +
        'it too); call again with `confirm:true` ONLY after the user explicitly says to delete.',
      inputSchema: {
        action: z.enum(['create', 'rename', 'add', 'remove_suite', 'remove_testcase', 'delete']).describe('What to do.'),
        testPlanId: z.string().optional().describe('Every action except create: test plan id or code.'),
        name: z.string().optional().describe('create / rename: the name.'),
        parentId: z.string().optional().describe('create: parent test plan id (omit for a top-level one).'),
        suiteIds: z.array(z.string()).optional().describe('add: suite ids or codes.'),
        tcIds: z.array(z.string()).optional().describe('add: test case ids or codes.'),
        suiteId: z.string().optional().describe('remove_suite: the suite to take out.'),
        tcId: z.string().optional().describe('remove_testcase: the test case to take out (id or code).'),
        versionId: z.string().optional().describe('remove_testcase: only when the folder holds several versions of that test case.'),
        confirm: z.boolean().optional().describe('delete: true on the SECOND call, only after the user explicitly said to delete.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & Partial<TestPlanWrites>) | null;
      if (!adapter) return err(NOT_CONNECTED);
      const a = adapter as ProviderAdapter & TestPlanWrites;
      if (!a.createTestPlan || !a.deleteTestPlan) return err('This product has no test plans.');
      const { action, testPlanId } = args;
      try {
        if (action === 'remove_testcase') {
          if (!testPlanId) return err('test_plan action:"remove_testcase" needs: testPlanId and tcId.');
          if (!args.tcId) return err('test_plan action:"remove_testcase" needs: testPlanId and tcId.');
          if (!a.removeTestcaseFromTestPlan) return err('This product cannot remove a test case from a test plan.');
          const r = await a.removeTestcaseFromTestPlan(testPlanId, args.tcId, args.versionId);
          return ok(
            `Removed ${r.removed} from test plan ${testPlanId}. ` +
              `The plan still has: ${r.remaining.length ? r.remaining.join(', ') : '(no direct test cases)'}.`,
            r,
          );
        }
        if (action === 'create') {
          if (!args.name) return err('test_plan action:"create" needs: name.');
          const r = await a.createTestPlan({ name: args.name, ...(args.parentId ? { parentId: args.parentId } : {}) });
          return ok(`Created test plan ${r.code ?? r.id} "${args.name}".`, { id: r.id, ...(r.code ? { code: r.code } : {}) });
        }
        if (!testPlanId) return err(`test_plan action:"${action}" needs: testPlanId.`);
        if (action === 'rename') {
          if (!args.name) return err('test_plan action:"rename" needs: testPlanId and name.');
          await a.renameTestPlan(testPlanId, args.name);
          return ok(`Renamed test plan ${testPlanId} to "${args.name}".`);
        }
        if (action === 'add') {
          if (!args.suiteIds?.length && !args.tcIds?.length) return err('test_plan action:"add" needs: testPlanId and suiteIds or tcIds.');
          const r = await a.addToTestPlan(testPlanId, {
            ...(args.suiteIds?.length ? { suiteIds: args.suiteIds } : {}), ...(args.tcIds?.length ? { tcIds: args.tcIds } : {}),
          });
          const lines = [
            r.added.length ? `Added ${r.added.join(', ')} to test plan ${testPlanId}.` : `Nothing new to add to test plan ${testPlanId}.`,
            ...(r.skipped.length ? [`Skipped: ${r.skipped.map((s) => `${s.code} (${s.reason})`).join(', ')}.`] : []),
          ];
          return ok(lines.join('\n'), r);
        }
        if (action === 'remove_suite') {
          if (!args.suiteId) return err('test_plan action:"remove_suite" needs: testPlanId and suiteId.');
          await a.removeSuiteFromTestPlan(testPlanId, args.suiteId);
          return ok(`Removed suite ${args.suiteId} from test plan ${testPlanId}.`);
        }
        // delete
        if (args.confirm !== true) {
          const p = await a.testPlanDeletePreview(testPlanId);
          const subs = p.subFolders.length ? ` and the ${p.subFolders.length} folder(s) below it: ${p.subFolders.map(label).join(', ')}` : '';
          return ok(
            `About to delete test plan ${label(p.plan)}${subs}. This cannot be undone. Show this to the user; call again ` +
            'with confirm:true only after they explicitly say to delete.',
            { preview: p },
          );
        }
        await a.deleteTestPlan(testPlanId);
        return ok(`Deleted test plan ${testPlanId}.`);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
