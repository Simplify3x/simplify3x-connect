/**
 * `execution_plan` — create / update / delete a SimplifyQA execution plan (Test Execution plan, Tasks 2–4).
 *
 * One tool, one `action`. Delete is TWO-STEP: without `confirm` it previews (entry count, the permanent
 * loss of test-data selections, any schedule that runs the plan) and writes nothing. A plan in review or
 * approval is read-only, as in the SimplifyQA UI. SimplifyQA's API checks the privileges itself.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import { autoDefectLogRefusal, autoDefectLogRunNote } from './autoDefectLog.js';
import { STACK_SETUP_DESC, stackConfigsSchema, stackSetupReply } from './stackSetupTool.js';
import type { ExecutionPlanInput, PlanEntryInput, PlanEntryRef, PlanRunRef, StackSetupInput, StackSetupResult, SuiteRef } from '../adapters/simplifyqa/adapter.js';

export type ExecutionPlanToolDeps = { getAdapter: () => ProviderAdapter | null };

type PlanWrites = {
  createExecutionPlan: (input: ExecutionPlanInput) => Promise<{ id: string; code?: string }>;
  updateExecutionPlan: (id: string, patch: Partial<ExecutionPlanInput>) => Promise<unknown>;
  executionPlanDeletePreview: (id: string) => Promise<{ plan: SuiteRef; entries: number; schedules: SuiteRef[] }>;
  deleteExecutionPlan: (id: string) => Promise<void>;
  addPlanEntries: (id: string, input: PlanEntryInput) => Promise<{ added: string[]; skipped: Array<{ code: string; reason: string }> }>;
  planEntriesRemovePreview: (id: string, tcIds: string[]) => Promise<{ plan: SuiteRef; entries: PlanEntryRef[] }>;
  removePlanEntries: (id: string, tcIds: string[]) => Promise<{ removed: number; notRemoved: string[] }>;
  startExecutionPlanRun: (id: string, opts: { agentId?: string; mode?: 'local' | 'remote' | 'cloud' | 'stack'; browser?: string }) => Promise<PlanRunRef>;
  configurePlanStacks: (id: string, opts: StackSetupInput) => Promise<StackSetupResult>;
};

const NOT_CONNECTED =
  'Not connected to a product. Use qa_connect({ url, token, projectId }) first — execution_plan needs a live SimplifyQA connection.';

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const label = (r: SuiteRef): string => [r.code ?? `#${r.id}`, r.name].filter(Boolean).join(' ');
const toNum = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(/\d+/.exec(v)?.[0]);
  return Number.isFinite(n) ? n : undefined;
};

/** Fields `update` may change, in the order they are named to the user. */
const CHANGEABLE = [
  'name', 'plannedStartDate', 'plannedEndDate', 'environment', 'releaseId', 'sprintId', 'teamIds', 'planners',
  'autoReExecCount', 'autoReExecTriggerOn', 'autoDefectLog', 'newBrowserSession', 'terminateOnFailure',
] as const;

export function registerExecutionPlanTools(server: McpServer, deps: ExecutionPlanToolDeps): void {
  server.registerTool(
    'execution_plan',
    {
      title: 'Create, update or delete an execution plan (SimplifyQA)',
      description:
        'Manage SimplifyQA execution plans. Read plans with sqa_query (collection "executionPlans"). Pick ONE `action`:\n' +
        '- action:"create" — needs `name`, `plannedStartDate`, `plannedEndDate` (YYYY-MM-DD) and `environment` ' +
        '(name or key; see sqa_query collection "environments"). Optional: releaseId, sprintId, teamIds, planners, ' +
        'autoReExecCount, autoReExecTriggerOn, autoDefectLog, newBrowserSession, terminateOnFailure.\n' +
        '- action:"update" — needs `planId` and at least one field to change (same fields as create). AUTO DEFECT LOGGING for ' +
        'the plan = `autoDefectLog:true` (create or update): failed steps then log a defect automatically. It needs the project\'s ' +
        'admin "Auto Defect Logging" switch on; if it is off the call is refused with that instruction — tell the user to ask ' +
        'an admin to enable it, then retry.\n' +
        '- action:"delete" — needs `planId`. TWO-STEP: call without `confirm` to PREVIEW (nothing is deleted; it ' +
        'states what is permanently lost), show it to the user, and call again with `confirm:true` ONLY after the user ' +
        'explicitly says to delete.\n' +
        '- action:"add_testcases" - needs `planId` and `tcIds`, `testCases` and/or `suiteIds` (a suite adds its test cases). Optional ' +
        '`assignTo` (user id or "me") and `assignDate` (YYYY-MM-DD); only assigned test cases can run. To pin a VERSION pass ' +
        '`testCases:[{ tcId:"TC-12826", version:"v2.0" }]` (or `versionId`, or one `versionId`/`version` for every `tcIds` entry) — ' +
        'the same test case can sit in the plan once per version, so v1.0 and v2.0 are two entries. A version that does not exist ' +
        'is an ERROR; a duplicate (same test case AND version) is skipped.\n' +
        '- action:"remove_testcases" — needs `planId` and `tcIds`. TWO-STEP like delete: removing also DELETES those ' +
        'test cases\' run history in SimplifyQA, which cannot be undone.\n' +
        '- action:"stack_setup" — needs `planId` and `stacks` (how many, e.g. 2) or `stackConfigs`. ' + STACK_SETUP_DESC + ' Optional `stackMode` ("cloud" default | "local") and `browser` are the defaults for stacks that do not say. ' +
        'A planner of the plan can do this, not only an admin.\n' +
        '- action:"run" — needs `planId`; call ONLY when the user explicitly asked to run this plan. It runs NOW — SimplifyQA cannot schedule an ' +
        'execution plan (its Scheduler takes a test case or a suite). `mode`: "local" (default — this machine\'s agent, which must be running), ' +
        '"remote" (another machine\'s agent: pass `agentId`), "cloud" (the project\'s cloud machine) or "stack" (the saved Stack Setup, ' +
        'divided across its stacks; only the stacks holding test cases assigned to the person running it execute). Runs the assigned, ' +
        'non-blocked AUTOMATION test cases and says which were left out. Then track it with run_status({ runId }) — it lists each test case.\n' +
        'A plan in review or approval (REVIEW PENDING, APPROVE PENDING, REVIEWED, APPROVED) is read-only, as in SimplifyQA.',
      inputSchema: {
        action: z.enum(['create', 'update', 'delete', 'add_testcases', 'remove_testcases', 'run', 'stack_setup']).describe('What to do.'),
        mode: z.enum(['local', 'remote', 'cloud', 'stack']).optional().describe('run: "local" (this machine\'s agent), "cloud" (a configured cloud machine), or "stack" (the saved stack setup, divided across its stacks).'),
        stacks: z.number().int().min(1).optional().describe('stack_setup: how many stacks (e.g. 2) — with append:true, how many to ADD. Omit when stackConfigs lists them.'),
        stackConfigs: stackConfigsSchema,
        append: z.boolean().optional().describe('stack_setup: add the stack(s) to the saved setup instead of replacing it.'),
        stackMode: z.enum(['cloud', 'local']).optional().describe('stack_setup: what each stack runs on (default cloud).'),
        browser: z.string().optional().describe('stack_setup: browser for WEB test cases (default chrome). run, mode "cloud": the browser for the plan\'s web test cases — ONLY Chrome Headless, Firefox Headless or Edge Headless (pass chrome / firefox / edge). The run asks for it when a web test case has no saved cloud browser; never offer safari / webkit / chromium for the cloud.'),
        agentId: z.string().optional().describe('run: this machine\'s agent id (optional; auto-picked, see local_agents).'),
        when: z.enum(['immediate', 'schedule']).optional().describe('run: only "immediate" — execution plans cannot be scheduled in SimplifyQA.'),
        planId: z.string().optional().describe('Every action except create: plan id or code (PL-5).'),
        tcIds: z.array(z.string()).optional().describe('add_testcases / remove_testcases: test case ids or codes.'),
        testCases: z.array(z.object({
          tcId: z.string().describe('Test case id or business key.'),
          versionId: z.string().optional().describe('Pin this version id (from the TC versions[]).'),
          version: z.string().optional().describe('Pin this version NAME (e.g. "v2.0"); ignored when versionId is given.'),
        })).optional().describe('add_testcases: test cases with an explicit version — lets one TC be added once per version (v1.0 AND v2.0).'),
        versionId: z.string().optional().describe('add_testcases: pin ONE version for every tcIds entry (id or name `version`). Omit = current version.'),
        version: z.string().optional().describe('add_testcases: pin one version by NAME for every tcIds entry (e.g. v2.0).'),
        suiteIds: z.array(z.string()).optional().describe('add_testcases: suites whose test cases to add.'),
        assignTo: z.string().optional().describe('add_testcases: user id, or "me".'),
        assignDate: z.string().optional().describe('add_testcases: YYYY-MM-DD.'),
        name: z.string().optional().describe('create/update: plan name (unique in the project).'),
        plannedStartDate: z.string().optional().describe('create/update: YYYY-MM-DD.'),
        plannedEndDate: z.string().optional().describe('create/update: YYYY-MM-DD, on or after the start.'),
        environment: z.string().optional().describe('create/update: environment name or key.'),
        releaseId: z.string().optional().describe('create/update: release id.'),
        sprintId: z.string().optional().describe('create/update: sprint id (needs a release).'),
        teamIds: z.array(z.number()).optional().describe('create/update: team ids.'),
        planners: z.array(z.number()).optional().describe('create/update: planner user ids.'),
        autoReExecCount: z.number().int().min(0).optional().describe('create/update.'),
        autoReExecTriggerOn: z.string().optional().describe('create/update.'),
        autoDefectLog: z.boolean().optional().describe('create/update: log a defect automatically when a step fails (needs the project\'s admin Auto Defect Logging switch on).'),
        newBrowserSession: z.boolean().optional().describe('create/update.'),
        terminateOnFailure: z.boolean().optional().describe('create/update.'),
        confirm: z.boolean().optional().describe('delete: true on the SECOND call, only after the user explicitly said to delete.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & Partial<PlanWrites>) | null;
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.createExecutionPlan || !adapter.updateExecutionPlan || !adapter.executionPlanDeletePreview || !adapter.deleteExecutionPlan
        || !adapter.addPlanEntries || !adapter.planEntriesRemovePreview || !adapter.removePlanEntries || !adapter.startExecutionPlanRun) {
        return err('execution_plan is available only on a SimplifyQA connection.');
      }
      const { action, planId } = args;
      if (args.plannedStartDate && args.plannedEndDate && args.plannedEndDate < args.plannedStartDate) {
        return err('plannedEndDate must be on or after plannedStartDate.');
      }
      // Only the fields the caller actually gave, with ids as numbers and sprint → iterationId.
      const fields: Partial<ExecutionPlanInput> = {};
      for (const k of CHANGEABLE) {
        const v = args[k];
        if (v === undefined) continue;
        if (k === 'releaseId') fields.releaseId = toNum(v as string) ?? null;
        else if (k === 'sprintId') fields.iterationId = toNum(v as string) ?? null;
        else (fields as Record<string, unknown>)[k] = v;
      }
      try {
        if ((action === 'create' || action === 'update') && args.autoDefectLog === true) {
          const refusal = await autoDefectLogRefusal(adapter, 'execution plan');
          if (refusal) return err(refusal);
        }
        if (action === 'create') {
          const missing = (['name', 'plannedStartDate', 'plannedEndDate', 'environment'] as const).filter((k) => !args[k]);
          if (missing.length) return err(`execution_plan action:"create" needs: ${missing.join(', ')}.`);
          const ref = await adapter.createExecutionPlan(fields as ExecutionPlanInput);
          return ok(`Created execution plan ${ref.code ?? ref.id} "${args.name}". Add test cases with action:"add_testcases".`, { plan: ref });
        }
        if (action === 'update') {
          if (!planId || !Object.keys(fields).length) {
            return err(`execution_plan action:"update" needs: planId and at least one field to change (${CHANGEABLE.join(', ')}).`);
          }
          await adapter.updateExecutionPlan(planId, fields);
          return ok(`Updated execution plan ${planId}.`);
        }
        if (action === 'stack_setup') {
          if (!adapter.configurePlanStacks) return err('execution_plan stack_setup is not available on this connection.');
          if (!planId) return err('execution_plan action:"stack_setup" needs: planId and stacks (or stackConfigs).');
          if (!args.stackConfigs?.length && (!args.stacks || args.stacks < 1)) {
            return err('execution_plan action:"stack_setup" needs: stacks (how many, at least 1) or stackConfigs (one entry per stack).');
          }
          const res = await adapter.configurePlanStacks(planId, {
            ...(args.stacks ? { count: args.stacks } : {}),
            ...(args.stackConfigs?.length ? { stackConfigs: args.stackConfigs } : {}),
            ...(args.stackMode ? { mode: args.stackMode === 'cloud' ? 'CLOUD' as const : 'LOCAL' as const } : {}),
            ...(args.browser ? { browser: args.browser } : {}),
            ...(args.append ? { append: true } : {}),
          });
          return ok(
            stackSetupReply(planId, res, 'Run it with execution_plan { action:"run", planId, mode:"stack" }.'),
            res as unknown as Record<string, unknown>,
          );
        }
        if (action === 'run') {
          if (!planId) return err('execution_plan action:"run" needs: planId.');
          const mode = (args.mode ?? 'local') as 'local' | 'remote' | 'cloud' | 'stack';
          if (args.when === 'schedule') {
            return err('SimplifyQA\'s Scheduler only schedules a test case or a suite — run the plan now, or schedule its test cases / a suite instead.');
          }
          const run = await adapter.startExecutionPlanRun(planId, {
            mode,
            ...(args.agentId ? { agentId: args.agentId } : {}),
            ...(args.browser ? { browser: args.browser } : {}),
          });
          const where = mode === 'local' ? 'locally' : mode === 'remote' ? `on remote agent ${args.agentId}` : mode === 'cloud' ? 'on the cloud' : 'with its stack setup';
          const defectNote = await autoDefectLogRunNote(adapter, 'plan', planId);
          const lines = [
            `Started ${planId} ${where} — run ${run.runId} with ${run.started.length} test case${run.started.length === 1 ? '' : 's'}: ${run.started.join(', ')}.`,
            ...(run.skipped.length ? [`Not run: ${run.skipped.map((s) => `${s.code} (${s.reason})`).join(', ')}.`] : []),
            `Track it with run_status({ runId: "${run.runId}" }).`,
            ...(defectNote ? [defectNote] : []),
          ];
          return ok(lines.join('\n'), { runId: run.runId, started: run.started, skipped: run.skipped });
        }
        if (action === 'add_testcases') {
          if (!planId || (!args.tcIds?.length && !args.suiteIds?.length && !args.testCases?.length)) {
            return err('execution_plan action:"add_testcases" needs: planId and tcIds, testCases or suiteIds.');
          }
          const input: PlanEntryInput = {
            ...(args.tcIds?.length ? { tcIds: args.tcIds } : {}),
            ...(args.suiteIds?.length ? { suiteIds: args.suiteIds } : {}),
            ...(args.testCases?.length ? { testCases: args.testCases } : {}),
            ...(args.versionId ? { versionId: args.versionId } : {}),
            ...(args.version ? { version: args.version } : {}),
            ...(args.assignTo ? { assignTo: args.assignTo } : {}), ...(args.assignDate ? { assignDate: args.assignDate } : {}),
          };
          const { added, skipped } = await adapter.addPlanEntries(planId, input);
          const lines = [
            added.length ? `Added ${added.length} test case${added.length === 1 ? '' : 's'} to ${planId}: ${added.join(', ')}.` : `Nothing added to ${planId}.`,
            ...(skipped.length ? [`Skipped: ${skipped.map((s) => `${s.code} (${s.reason})`).join(', ')}.`] : []),
            ...(added.length && !input.assignTo
              ? ['Not assigned yet — only assigned test cases can run. Add them again with assignTo + assignDate, or assign them in SimplifyQA.']
              : []),
          ];
          return ok(lines.join('\n'), { added, skipped });
        }
        if (action === 'remove_testcases') {
          if (!planId || !args.tcIds?.length) return err('execution_plan action:"remove_testcases" needs: planId and tcIds.');
          if (!args.confirm) {
            const { plan, entries } = await adapter.planEntriesRemovePreview(planId, args.tcIds);
            return ok(
              `⚠️ About to remove ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} (${entries.map((e) => e.code).join(', ')}) ` +
                `from ${label(plan)} — this also DELETES their run history (results and reports). This cannot be undone. ` +
                'Nothing has been removed yet. Only if the user explicitly confirms, call again with ' +
                `{ action: "remove_testcases", planId: "${planId}", tcIds: ${JSON.stringify(args.tcIds)}, confirm: true }.`,
              { preview: true, plan, entries },
            );
          }
          const { removed, notRemoved } = await adapter.removePlanEntries(planId, args.tcIds);
          const total = removed + notRemoved.length;
          if (notRemoved.length) return err(`Removed ${removed} of ${total}. SimplifyQA did not remove: ${notRemoved.join(', ')}.`);
          return ok(`Removed ${removed} ${removed === 1 ? 'entry' : 'entries'} from ${planId}.`);
        }
        if (!planId) return err('execution_plan action:"delete" needs: planId.');
        const { plan, entries, schedules } = await adapter.executionPlanDeletePreview(planId);
        if (schedules.length) {
          return err(`${label(plan)} can't be deleted — schedules use it: ${schedules.map(label).join(', ')}. Delete or change those schedules first.`);
        }
        if (!args.confirm) {
          return ok(
            `⚠️ About to delete execution plan **${plan.name ?? plan.id}** (${plan.code ?? plan.id}) and its ${entries} test-case ` +
              `${entries === 1 ? 'entry' : 'entries'}. Their test-data selections are permanently removed. This cannot be undone. ` +
              'Past runs are kept. Nothing has been deleted yet. Only if the user explicitly confirms, call again with ' +
              `{ action: "delete", planId: "${planId}", confirm: true }.`,
            { preview: true, plan, entries },
          );
        }
        await adapter.deleteExecutionPlan(planId);
        return ok(`Deleted execution plan ${label(plan)}.`);
      } catch (e) {
        return err(describeError(e));
      }
    },
  );
}
