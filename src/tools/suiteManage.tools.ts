/**
 * `suite_manage` — update or delete a SimplifyQA suite (Test Execution plan, Task 1).
 *
 * One tool, one `action`. Delete is TWO-STEP: without `confirm` it only previews (SimplifyQA's own dry
 * run plus the MCP's checks for execution plans and test plans) and writes nothing; a suite that is
 * still used is refused even with `confirm:true`. SimplifyQA's API checks the privileges itself.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import { autoDefectLogNote, autoDefectLogRefusal } from './autoDefectLog.js';
import type { SuiteBlockers, SuiteRef, SuiteSettings, SuiteSettingsView } from '../adapters/simplifyqa/adapter.js';

export type SuiteManageDeps = { getAdapter: () => ProviderAdapter | null };

type SuiteWrites = {
  suiteDeletePreview: (id: string) => Promise<{ suite: SuiteRef; blockers: SuiteBlockers }>;
  deleteSuite: (id: string) => Promise<void>;
  updateSuite: (id: string, patch: { name?: string; description?: string; executionType?: string }) => Promise<unknown>;
  updateSuiteSettings: (id: string, settings: SuiteSettings) => Promise<unknown>;
  getSuiteSettings: (id: string) => Promise<SuiteSettingsView>;
  configureSuiteStacks: (id: string, opts: { count: number; mode?: 'CLOUD' | 'LOCAL'; browser?: string }) => Promise<{
    created: boolean; cloudAvailable?: boolean; stacks: Array<{ id: string; name: string; mode: string; codes: string[] }>;
  }>;
};

const NOT_CONNECTED =
  'Not connected to a product. Use qa_connect({ url, token, projectId }) first — suite_manage needs a live SimplifyQA connection.';

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const label = (r: SuiteRef): string => [r.code ?? `#${r.id}`, r.name].filter(Boolean).join(' ');

const BLOCKER_NAMES: Record<keyof SuiteBlockers, string> = {
  schedules: 'schedules', pipelines: 'pipelines', executionPlans: 'execution plans', testPlans: 'test plans',
};

export function registerSuiteManageTools(server: McpServer, deps: SuiteManageDeps): void {
  server.registerTool(
    'suite_manage',
    {
      title: 'Update or delete a suite (SimplifyQA)',
      description:
        'Change, read or remove an existing SimplifyQA suite. Pick ONE `action`:\n' +
        '- action:"get" — needs `suiteId`. READS the suite\'s Settings panel: execution type and ' +
        'autoReExecCount / autoDefectLog / autoReExecTriggerOn / newBrowserSession / terminateOnFailure / ' +
        'container limits. Use it to CONFIRM a setting after saving (also after a client restart — the ' +
        'settings live in the backend).\n' +
        '- action:"update" — needs `suiteId` and at least one of `name`, `description`, `executionType` ' +
        '(the suite\'s Execution Type menu: "local", "remote", "cloud" or "stack"), `settings` ' +
        '(autoDefectLog, autoReExecCount, autoReExecTriggerOn, newBrowserSession, terminateOnFailure, ' +
        'minimumContainerCount, maximumContainerCount).\n' +
        '- action:"delete" — needs `suiteId`. TWO-STEP: call without `confirm` to PREVIEW (nothing is ' +
        'deleted), show it to the user, and call again with `confirm:true` ONLY after the user explicitly ' +
        'says to delete. A suite still used by a schedule, pipeline, execution plan or test plan is refused.\n' +
        '- action:"stack_setup" — needs `suiteId` and `stacks` (how many). Saves the suite\'s STACK setup (the ' +
        'Stack canvas behind Execution Type → Stack): N stacks with the suite\'s test cases spread across ' +
        'them round-robin (every stack needs at least one). `stackMode` "cloud" (default) or "local"; ' +
        '`browser` for WEB cases. Then run it with suite_run mode:"stack".\n' +
        'AUTO DEFECT LOGGING for the suite = action:"update" with settings:{ autoDefectLog:true } (failed steps then log ' +
        'a defect automatically). It needs the project\'s admin "Auto Defect Logging" switch on; if it is off the call is ' +
        'refused with that instruction — tell the user to ask an admin to enable it, then retry.\n' +
        'Add/remove member test cases with suite_add_testcases / suite_remove_testcases; create with suite_create.',
      inputSchema: {
        action: z.enum(['get', 'update', 'delete', 'stack_setup']).describe('What to do with the suite.'),
        stacks: z.number().int().min(1).optional().describe('action "stack_setup": number of stacks.'),
        stackMode: z.enum(['cloud', 'local']).optional().describe('action "stack_setup": where the stacks run (default cloud).'),
        browser: z.string().optional().describe('action "stack_setup": browser for WEB test cases (default chrome).'),
        suiteId: z.string().optional().describe('Suite id or code (SU-12). Needed by every action.'),
        name: z.string().optional().describe('action "update": the new name.'),
        description: z.string().optional().describe('action "update": the new description.'),
        executionType: z.enum(['local', 'remote', 'cloud', 'stack']).optional()
          .describe('action "update": the suite\'s Execution Type (the UI menu) — "stack" selects Stack execution. Sent as lastSelectedExecutionType.'),
        settings: z.object({
          autoDefectLog: z.boolean().optional(),
          autoReExecCount: z.number().int().min(0).optional(),
          autoReExecTriggerOn: z.string().optional(),
          newBrowserSession: z.boolean().optional(),
          terminateOnFailure: z.boolean().optional(),
          minimumContainerCount: z.number().int().min(0).optional(),
          maximumContainerCount: z.number().int().min(0).optional(),
        }).optional().describe('action "update": execution settings to change.'),
        confirm: z.boolean().optional().describe('action "delete": true on the SECOND call, only after the user explicitly said to delete.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ action, suiteId, name, description, executionType, settings, confirm, stacks, stackMode, browser }) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & Partial<SuiteWrites>) | null;
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.suiteDeletePreview || !adapter.deleteSuite || !adapter.updateSuite || !adapter.updateSuiteSettings || !adapter.getSuiteSettings) {
        return err('suite_manage is available only on a SimplifyQA connection.');
      }
      try {
        if (action === 'stack_setup') {
          if (!suiteId || !stacks) return err('suite_manage action:"stack_setup" needs: suiteId and stacks (how many).');
          if (!adapter.configureSuiteStacks) return err('Stack setup is not available on this connection.');
          const res = await adapter.configureSuiteStacks(suiteId, {
            count: stacks,
            mode: stackMode === 'local' ? 'LOCAL' : 'CLOUD',
            ...(browser ? { browser } : {}),
          });
          return ok(
            `${res.created ? 'Created' : 'Updated'} the Stack setup of ${suiteId}: ${res.stacks.length} stack(s).\n` +
              res.stacks.map((s) => `- ${s.name} (${s.mode}): ${s.codes.join(', ')}`).join('\n') +
              (res.cloudAvailable === false ? '\n⚠️ This project has no cloud machine configured, so CLOUD stacks cannot run yet.' : '') +
              `\nRun it with suite_run({ suiteId: "${suiteId}", mode: "stack" }).`,
            res as unknown as Record<string, unknown>,
          );
        }
        if (action === 'get') {
          if (!suiteId) return err('suite_manage action:"get" needs suiteId.');
          const view = await adapter.getSuiteSettings(suiteId);
          const adminNote = await autoDefectLogNote(adapter, view.autoDefectLog);
          return ok(
            `Suite ${view.code ?? view.name ?? view.id} settings:\n` +
              `- execution type: ${view.executionType ?? '(unset)'}\n` +
              `- auto re-execution count: ${view.autoReExecCount}\n` +
              `- trigger auto re-execution: ${view.autoReExecTriggerOn ?? '(unset)'}\n` +
              `- auto defect log: ${view.autoDefectLog ? 'on' : 'off'}\n` +
              `- new browser session: ${view.newBrowserSession ? 'on' : 'off'}\n` +
              `- terminate on failure: ${view.terminateOnFailure ? 'on' : 'off'}\n` +
              `- container limits: min ${view.minimumContainerCount ?? '-'} / max ${view.maximumContainerCount ?? '-'}` +
              (adminNote ? `\n${adminNote}` : ''),
            view as unknown as Record<string, unknown>,
          );
        }
        if (action === 'update') {
          const fields = {
            ...(name !== undefined ? { name } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(executionType !== undefined ? { executionType } : {}),
          };
          const hasSettings = !!settings && Object.values(settings).some((v) => v !== undefined);
          if (!suiteId || (!Object.keys(fields).length && !hasSettings)) {
            return err('suite_manage action:"update" needs: suiteId and at least one of name, description, executionType, settings.');
          }
          if (settings?.autoDefectLog === true) {
            const refusal = await autoDefectLogRefusal(adapter, 'suite');
            if (refusal) return err(refusal);
          }
          if (Object.keys(fields).length) await adapter.updateSuite(suiteId, fields);
          if (hasSettings) await adapter.updateSuiteSettings(suiteId, settings as SuiteSettings);
          return ok(`Updated suite ${suiteId}${executionType ? ` — execution type ${executionType.toUpperCase()}` : ''}.`);
        }

        if (!suiteId) return err('suite_manage action:"delete" needs: suiteId.');
        const { suite, blockers } = await adapter.suiteDeletePreview(suiteId);
        const used = (Object.keys(blockers) as Array<keyof SuiteBlockers>).filter((k) => blockers[k].length);
        if (used.length) {
          return err(
            `${label(suite)} can't be deleted — it is still used by:\n` +
              used.map((k) => `- ${BLOCKER_NAMES[k]}: ${blockers[k].map(label).join(', ')}`).join('\n') +
              '\nRemove it from those first.',
          );
        }
        if (!confirm) {
          return ok(
            `⚠️ About to delete suite **${suite.name ?? suite.id}** (${suite.code ?? suite.id}). Its test data is deleted with it. ` +
              `Nothing has been deleted yet. Only if the user explicitly confirms, call again with ` +
              `{ action: "delete", suiteId: "${suiteId}", confirm: true }.`,
            { preview: true, suite },
          );
        }
        await adapter.deleteSuite(suiteId);
        return ok(`Deleted suite ${label(suite)}.`);
      } catch (e) {
        return err(describeError(e));
      }
    },
  );
}
