/**
 * `defect_update` — change a SimplifyQA defect, including the form's USER STORY and TEST CASE fields.
 *
 * Defects could only be read (sqa_query "defects") and deleted (backlog_delete). backlog_link adds a Linkages row, which is a different
 * relationship from the form fields: USER STORY is the defect's `userstoryId`, and TEST CASE (a test case with its version) is what makes
 * the defect show in that test case's linked defects. This edits those fields the way the defect form does, reads the defect back, and
 * checks the test case really lists the defect.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { DefectCreateInput, DefectCreateResult, DefectUpdateInput, DefectUpdateResult } from '../adapters/simplifyqa/adapter.js';

export type DefectUpdateToolDeps = { getAdapter: () => ProviderAdapter | null };

const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function registerDefectUpdateTool(server: McpServer, deps: DefectUpdateToolDeps): void {
  server.registerTool(
    'defect_update',
    {
      title: 'Update a defect (user story, test case, state, assignee, …)',
      description:
        'Change an existing DEFECT the way the SimplifyQA defect form does, then READ IT BACK and report each change. Pass `defectId` (id, code like ' +
        'DE-61, or exact name) and only what to change:\n' +
        '- `storyId` — the form\'s USER STORY field (story id or key, e.g. US-25; "none" clears it). This is NOT a Linkages row (backlog_link).\n' +
        '- `testCases` — the form\'s TEST CASE field: test cases to ADD, each "TC-41" or with its version "TC-41:v1.0" (no version = the test case\'s ' +
        'current one, and the answer says which). The defect then shows in each test case\'s linked defects — checked after saving. `removeTestCases` ' +
        'takes some out; `clearTestCases:true` empties the field.\n' +
        '- `state`, `priority`, `severity` (the project\'s own values; an unknown one is refused with the valid ones listed), `assignee` (email, name, ' +
        'user id or "me") or `unassign:true`, `releaseId` / `sprintId` (id, code or name; "none" clears), `name`, `description`.\n' +
        'Needs the add_defect privilege.',
      inputSchema: {
        defectId: z.string().describe('Defect id, code (DE-61) or exact name.'),
        storyId: z.string().optional().describe('USER STORY field: story id or key (US-25); "none" clears it.'),
        testCases: z.array(z.string()).optional().describe('TEST CASE field — test cases to add: "TC-41" or "TC-41:v1.0".'),
        removeTestCases: z.array(z.string()).optional().describe('Test cases to take out of the TEST CASE field.'),
        clearTestCases: z.boolean().optional().describe('true = empty the TEST CASE field.'),
        state: z.string().optional(),
        priority: z.string().optional(),
        severity: z.string().optional(),
        assignee: z.string().optional().describe('Email, name, numeric user id or "me".'),
        unassign: z.boolean().optional().describe('true = clear the assignee.'),
        releaseId: z.string().optional().describe('Release: id, code (RE-44) or exact name; "none" clears it (and the sprint).'),
        sprintId: z.string().optional().describe('Sprint: id, code (SP-1) or exact name; it must belong to the defect\'s release. "none" clears it.'),
        name: z.string().optional().describe('New name (at least 3 characters).'),
        description: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & { updateDefect?: (ref: string, patch: DefectUpdateInput) => Promise<DefectUpdateResult> }) | null;
      if (!adapter) return err('Not connected to a product. Use qa_connect({ url, token, projectId }) first — defect_update needs a live backend connection.');
      if (!adapter.updateDefect) return err('This product does not expose defect updates.');
      const { defectId, ...rest } = args;
      const patch: DefectUpdateInput = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
      if (patch.unassign && patch.assignee !== undefined) return err('defect_update: give either assignee or unassign:true, not both.');
      if (!Object.keys(patch).length) {
        return err('defect_update needs something to change: storyId, testCases (or removeTestCases / clearTestCases), state, priority, severity, assignee (or unassign), releaseId, sprintId, name or description.');
      }
      try {
        const r = await adapter.updateDefect(defectId, patch);
        const head = r.written
          ? `Updated defect ${r.code} "${r.name}" and read it back from SimplifyQA:\n` + r.changes.map((c) => `- ${c.field}: ${c.from} → ${c.to}`).join('\n')
          : `Defect ${r.code} "${r.name}" already matches — nothing was changed.`;
        return ok([head, ...r.warnings.map((w) => `⚠️ ${w}`)].join('\n'), { ...r } as unknown as Record<string, unknown>);
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'defect_create',
    {
      title: 'Log a defect (create)',
      description:
        'Log a new DEFECT in the connected project — what Defect Management → Create Defect does — and return its key (DE-xx). Only `name` is required; ' +
        'state and priority default to the project\'s own default values, and the answer lists what was defaulted. Optional: `description`, `severity`, ' +
        '`category` (the project\'s own values; an unknown one is refused with the valid ones listed), `assignee` (email, name, user id or "me"), ' +
        '`releaseId` / `sprintId` (id, code or name), `storyId` (the USER STORY field: id or key, e.g. US-25), `testCases` (the TEST CASE field: "TC-41" ' +
        'or "TC-41:v1.0" — the test case then lists the defect, checked after saving), `module` (default: the project\'s Default module), ' +
        '`estimatedEffort`, `customFields` ({ key: value } — needed when the project marks custom fields mandatory). A defect with the same name is ' +
        'refused. Reads the defect back. Needs the add_defect privilege. To log a defect FROM a failed execution step (evidence pre-filled), use ' +
        'defect_create_from_step instead; to change one later, defect_update.',
      inputSchema: {
        name: z.string().describe('Defect name (3–500 characters).'),
        description: z.string().optional(),
        state: z.string().optional(),
        priority: z.string().optional(),
        severity: z.string().optional(),
        category: z.string().optional(),
        assignee: z.string().optional().describe('Email, name, numeric user id or "me". Default: unassigned.'),
        releaseId: z.string().optional().describe('Release: id, code (RE-44) or exact name.'),
        sprintId: z.string().optional().describe('Sprint: id, code (SP-1) or exact name; it must belong to the release.'),
        storyId: z.string().optional().describe('USER STORY field: story id or key (US-25).'),
        testCases: z.array(z.string()).optional().describe('TEST CASE field: "TC-41" or "TC-41:v1.0".'),
        module: z.string().optional().describe('Module name, code or id. Default: the project\'s Default module.'),
        estimatedEffort: z.number().min(0).max(9999).optional(),
        customFields: z.record(z.string(), z.unknown()).optional().describe('Custom field values { "<field key>": value }.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & { createDefect?: (input: DefectCreateInput) => Promise<DefectCreateResult> }) | null;
      if (!adapter) return err('Not connected to a product. Use qa_connect({ url, token, projectId }) first — defect_create needs a live backend connection.');
      if (!adapter.createDefect) return err('This product does not expose defect creation.');
      try {
        const input: DefectCreateInput = { name: args.name };
        for (const [k, v] of Object.entries(args)) if (k !== 'name' && v !== undefined) (input as Record<string, unknown>)[k] = v;
        const r = await adapter.createDefect(input);
        const text = [
          `Logged defect ${r.defectCode} "${r.name}" — state ${r.state || '-'}, priority ${r.priority || '-'}${r.severity ? `, severity ${r.severity}` : ''}` +
            `${r.testCases.length ? `, test case ${r.testCases.join(', ')}` : ''}${r.storyId !== undefined ? `, user story #${r.storyId}` : ''}. Read back from SimplifyQA.`,
          ...(r.defaults.length ? [`Defaulted (not given): ${r.defaults.join('; ')}.`] : []),
          ...r.warnings.map((w) => `⚠️ ${w}`),
        ].join('\n');
        return ok(text, { ...r } as unknown as Record<string, unknown>);
      } catch (e) {
        return err(describeError(e));
      }
    },
  );
}
