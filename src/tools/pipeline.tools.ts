/**
 * `pipeline` — SimplifyQA pipelines: create, update, two-step delete, run, run status and stop.
 * SimplifyQA's API checks the privileges itself (add_pipelines / delete_pipelines / view_pipelines).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { PipelineInput, PipelineUpdate, SuiteRef } from '../adapters/simplifyqa/adapter.js';

export type PipelineDeps = { getAdapter: () => ProviderAdapter | null };

type PipelineWrites = {
  createPipeline: (input: PipelineInput) => Promise<{ id: string; code?: string }>;
  updatePipeline: (id: string, patch: PipelineUpdate) => Promise<unknown>;
  pipelineDeletePreview: (id: string) => Promise<SuiteRef>;
  deletePipeline: (id: string) => Promise<void>;
  startPipeline: (id: string) => Promise<{ runId: string; code?: string }>;
  getPipelineRun: (execId: string) => Promise<Record<string, unknown>>;
  stopPipelineRun: (execId: string) => Promise<void>;
};

const NOT_CONNECTED =
  'Not connected to a product. Use qa_connect({ url, token, projectId }) first — pipeline needs a live SimplifyQA connection.';

export function registerPipelineTools(server: McpServer, deps: PipelineDeps): void {
  server.registerTool(
    'pipeline',
    {
      title: 'Create / change / delete / run a SimplifyQA pipeline',
      description:
        'Manage SimplifyQA PIPELINES. Read them with sqa_query collection "pipelines". Actions:\n' +
        '- action:"create" — needs `name`, `pipelineType` (TC or SU), `parentId` (the test case or suite), `mode` ' +
        '(local / remote / cloud), `releaseId` and `sprintId` (SimplifyQA requires both — ASK if unknown); optional ' +
        '`agentId`, `environment`, `browser` (TC), `description`.\n' +
        '- action:"update" — needs `pipelineId`; any of `name`, `description`, `releaseId`, `sprintId`, `environment`, `agentId`, `mode`.\n' +
        '- action:"delete" — needs `pipelineId`. TWO-STEP: the first call only previews; call again with `confirm:true` ' +
        'ONLY after the user explicitly says to delete.\n' +
        '- action:"run" — needs `pipelineId`; call ONLY when the user explicitly asked to run it.\n' +
        '- action:"run_status" / "stop" — need `executionId` (from run).',
      inputSchema: {
        action: z.enum(['create', 'update', 'delete', 'run', 'run_status', 'stop']).describe('What to do.'),
        pipelineId: z.string().optional().describe('update / delete / run: pipeline id or code.'),
        executionId: z.string().optional().describe('run_status / stop: the execution id from run.'),
        name: z.string().optional().describe('create / update: pipeline name.'),
        pipelineType: z.enum(['TC', 'SU']).optional().describe('create: TC (test case) or SU (suite).'),
        parentId: z.string().optional().describe('create: the test case or suite id / code.'),
        mode: z.enum(['local', 'remote', 'cloud']).optional().describe('create / update: where it runs.'),
        agentId: z.string().optional().describe('create / update: agent id (local_agents / remote_agents).'),
        releaseId: z.string().optional().describe('create / update: release id (required to create).'),
        sprintId: z.string().optional().describe('create / update: sprint id (required to create).'),
        environment: z.string().optional().describe('create / update: environment name or key (default general).'),
        browser: z.string().optional().describe('create: browser for the WEB test cases — the test case, or every WEB test case in the suite (default chrome). A CLOUD pipeline is headless: only Chrome Headless, Firefox Headless or Edge Headless exist there (pass chrome / firefox / edge).'),
        description: z.string().optional().describe('create / update.'),
        confirm: z.boolean().optional().describe('delete: true on the SECOND call, only after the user explicitly said to delete.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & Partial<PipelineWrites>) | null;
      if (!adapter) return err(NOT_CONNECTED);
      const a = adapter as ProviderAdapter & PipelineWrites;
      if (!a.createPipeline || !a.deletePipeline) return err('This product has no pipelines.');
      const { action, pipelineId, executionId } = args;
      try {
        if (action === 'create') {
          if (!args.name || !args.pipelineType || !args.parentId || !args.mode || !args.releaseId || !args.sprintId) {
            return err('pipeline action:"create" needs: name, pipelineType, parentId, mode, releaseId and sprintId.');
          }
          const r = await a.createPipeline({
            name: args.name, pipelineType: args.pipelineType, parentId: args.parentId, mode: args.mode,
            releaseId: args.releaseId, sprintId: args.sprintId,
            ...(args.agentId ? { agentId: args.agentId } : {}), ...(args.environment ? { environment: args.environment } : {}),
            ...(args.browser ? { browser: args.browser } : {}), ...(args.description ? { description: args.description } : {}),
          });
          return ok(`Created pipeline ${r.code ?? r.id} "${args.name}".`, r);
        }
        if (action === 'run_status' || action === 'stop') {
          if (!executionId) return err(`pipeline action:"${action}" needs: executionId.`);
          if (action === 'stop') {
            await a.stopPipelineRun(executionId);
            return ok(`Asked SimplifyQA to stop pipeline execution ${executionId}.`);
          }
          const s = await a.getPipelineRun(executionId);
          return ok(`Pipeline execution ${executionId}: ${String(s['status'] ?? 'unknown')}.`, s);
        }
        if (!pipelineId) return err(`pipeline action:"${action}" needs: pipelineId.`);
        if (action === 'update') {
          const patch: PipelineUpdate = {
            ...(args.name !== undefined ? { name: args.name } : {}), ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.releaseId ? { releaseId: args.releaseId } : {}), ...(args.sprintId ? { sprintId: args.sprintId } : {}),
            ...(args.environment ? { environment: args.environment } : {}), ...(args.agentId ? { agentId: args.agentId } : {}),
            ...(args.mode ? { mode: args.mode } : {}),
          };
          if (!Object.keys(patch).length) return err('pipeline action:"update" needs: pipelineId and at least one field to change.');
          await a.updatePipeline(pipelineId, patch);
          return ok(`Updated pipeline ${pipelineId}.`);
        }
        if (action === 'run') {
          const r = await a.startPipeline(pipelineId);
          return ok(`Started pipeline ${pipelineId} — execution ${r.code ?? r.runId} (id ${r.runId}). Check it with action:"run_status".`, r);
        }
        // delete
        if (args.confirm !== true) {
          const p = await a.pipelineDeletePreview(pipelineId);
          return ok(
            `About to delete pipeline ${[p.code ?? `#${p.id}`, p.name].filter(Boolean).join(' ')}. This cannot be undone. ` +
            'Show this to the user; call again with confirm:true only after they explicitly say to delete.',
            { preview: p },
          );
        }
        await a.deletePipeline(pipelineId);
        return ok(`Deleted pipeline ${pipelineId}.`);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
