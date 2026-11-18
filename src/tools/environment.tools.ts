/**
 * `environment_manage` — SimplifyQA project environments (project configuration > Environments).
 *
 * They are not plain rows: they live in the project's field configuration and are saved by
 * `POST /pm/fields/savefields` with the WHOLE environment list, exactly what the UI's Environment
 * editor does. Once saved, the environment is available to executions, schedules, pipelines and
 * execution plans (all read the same `/pm/fields/8?fieldType=environment` list), and the backend
 * provisions its own test-data rows ("Test Data environment creation has been initiated").
 *
 * Read them with `sqa_query({ op:"search", collection:"environments" })`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';

export type EnvironmentDeps = { getAdapter: () => ProviderAdapter | null };

type EnvWrites = {
  createEnvironment: (input: { name: string; key?: string }) => Promise<{ id: string; key: string; name: string }>;
  updateEnvironment: (ref: string, patch: { name?: string; key?: string }) => Promise<{ id: string; key: string; name: string }>;
  deleteEnvironment: (ref: string) => Promise<{ id: string; name: string; key: string }>;
};

const NOT_CONNECTED = 'Not connected to a product. Use qa_connect({ url, token, projectId }) first.';

export function registerEnvironmentTools(server: McpServer, deps: EnvironmentDeps): void {
  server.registerTool(
    'environment_manage',
    {
      title: 'Create, update or delete a project environment (SimplifyQA)',
      description:
        'Manage the project\'s ENVIRONMENTS (project configuration > Environments, next to General).\n' +
        '- action:"create" — needs `name` (optional `key`, else generated exactly like the UI). Refused when that name already exists.\n' +
        '- action:"update" — needs `environment` (current name or key) and the new `name` and/or `key`.\n' +
        '- action:"delete" — needs `environment`. TWO-STEP: the first call only previews; call again with `confirm:true` ' +
        'ONLY after the user explicitly says to delete (the default General environment is refused).\n' +
        'Every write posts the WHOLE environment list to `/pm/fields/savefields`, exactly as the UI does, and is read ' +
        'back to confirm. A saved environment is selectable for executions, schedules, pipelines and execution plans, ' +
        'and the product provisions its own test data. List them with `sqa_query collection:"environments"`.',
      inputSchema: {
        action: z.enum(['create', 'update', 'delete']).describe('What to do.'),
        name: z.string().min(1).optional().describe('create: the environment name (required). update: the NEW name (optional if only the key changes).'),
        key: z.string().optional().describe('Optional environment key (used as `environmentType` in test data). Generated when omitted on create.'),
        environment: z.string().optional().describe('update / delete: the existing environment, by name or key.'),
        confirm: z.boolean().optional().describe('delete: true on the SECOND call, only after the user explicitly said to delete.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ action, name, key, environment, confirm }) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & Partial<EnvWrites>) | null;
      if (!adapter) return err(NOT_CONNECTED);
      if (action === 'create') {
        if (!name) return err('environment_manage action:"create" needs: name.');
        if (!adapter.createEnvironment) return err('Creating environments is available only on a SimplifyQA connection.');
        try {
          const saved = await adapter.createEnvironment({ name, ...(key ? { key } : {}) });
          return ok(
            `Created environment "${saved.name}" (key ${saved.key}, id ${saved.id}). It is now listed with the project's ` +
              'environments and selectable for executions, schedules, pipelines and execution plans. The product ' +
              'provisions the new environment\'s test data itself.',
            { environment: saved } as unknown as Record<string, unknown>,
          );
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      }
      if (action === 'delete') {
        if (!environment) return err('environment_manage action:"delete" needs: environment (the current name or key).');
        if (!adapter.deleteEnvironment) return err('Deleting environments is available only on a SimplifyQA connection.');
        if (confirm !== true) {
          return ok(
            `About to delete environment "${environment}". Its test-data iterations go with it — this cannot be undone. ` +
              '**Ask the user to confirm**, then call `environment_manage` again with `confirm:true`.',
            { preview: true, needs: 'confirm', environment } as unknown as Record<string, unknown>,
          );
        }
        try {
          const gone = await adapter.deleteEnvironment(environment);
          return ok(`Deleted environment "${gone.name}" (key ${gone.key}).`, { deleted: gone } as unknown as Record<string, unknown>);
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      }
      if (!adapter.updateEnvironment) return err('Updating environments is available only on a SimplifyQA connection.');
      if (!environment) return err('environment_manage action:"update" needs: environment (the current name or key).');
      try {
        const saved = await adapter.updateEnvironment(environment, {
          ...(name ? { name } : {}),
          ...(key ? { key } : {}),
        });
        return ok(
          `Updated environment "${environment}" → "${saved.name}" (key ${saved.key}, id ${saved.id}).`,
          { environment: saved } as unknown as Record<string, unknown>,
        );
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
