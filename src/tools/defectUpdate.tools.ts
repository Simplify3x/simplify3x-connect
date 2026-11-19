/**
 * `defect_update` / `defect_create` — change or log a SimplifyQA defect with the fields of the defect form.
 *
 * Defects could only be read (sqa_query "defects") and deleted (backlog_delete). backlog_link adds a Linkages row, which is a different
 * relationship from the form fields: USER STORY is the defect's `userstoryId`, and TEST CASE (a test case with its version) is what makes
 * the defect show in that test case's linked defects. This edits those fields the way the defect form does, reads the defect back, and
 * checks the test case really lists the defect. Environment, Type, Feature, the planned dates, Linkages (saved from the defect's side) and
 * Attachments complete the form; Environment / Type are checked against the project's own list (or the form's fixed one).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { AttachmentEntity, DefectCreateInput, DefectCreateResult, DefectUpdateInput, DefectUpdateResult } from '../adapters/simplifyqa/adapter.js';
import { readAttachmentSource } from './attachment.tools.js';

export type DefectUpdateToolDeps = { getAdapter: () => ProviderAdapter | null };

const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type AttachmentInput = { filePath?: string | undefined; base64?: string | undefined; fileName?: string | undefined; contentType?: string | undefined };
type AttachWriter = {
  addAttachment?: (input: { entityType: AttachmentEntity; itemId: string; fileName: string; contentType?: string | undefined; data: Uint8Array }) => Promise<{ attachments: Array<Record<string, unknown>> }>;
};

const linkagesSchema = z.array(z.object({
  destType: z.enum(['epic', 'feature', 'userstory', 'defect', 'task']).describe('What the defect is linked TO.'),
  destId: z.string().describe('Its id or business key (US-25, DE-9, FT-248, TA-4).'),
  linkType: z.string().describe('The link type as the Linkages dropdown shows it ("Clones", "Relates to", …). An unknown one is refused with the available ones.'),
})).optional().describe('LINKAGES, saved from the DEFECT\'s side (the form\'s Linkages section). A link that already exists is left as it is.');

const attachmentsSchema = z.array(z.object({
  filePath: z.string().optional().describe('Absolute path of the file (read on this machine).'),
  base64: z.string().optional().describe('File content as base64 when there is no local path. Requires fileName.'),
  fileName: z.string().optional().describe('Name to store it under (default: the file\'s own name).'),
  contentType: z.string().optional().describe('MIME type; inferred from the extension when omitted.'),
})).optional().describe('ATTACHMENTS: files to attach to the defect (max 20 MB each). To remove or download one later: attachment_delete / attachment_download with entityType "defect".');

const formFields = {
  environment: z.string().optional().describe('ENVIRONMENT: one of the project\'s own list, or the form\'s (Development, QA, UAT). An unknown value is refused with the valid ones.'),
  executionType: z.string().optional().describe('TYPE (the form\'s Execution Type): Manual or Automation (or the project\'s own list).'),
  type: z.string().optional().describe('Same as executionType — the form\'s TYPE field.'),
  featureId: z.string().optional().describe('FEATURE: a feature of this project — id, business key (FT-248) or exact name.'),
  plannedStartDate: z.string().optional().describe('PLANNED START DATE, YYYY-MM-DD.'),
  plannedEndDate: z.string().optional().describe('PLANNED END DATE, YYYY-MM-DD, on or after the start.'),
  linkages: linkagesSchema,
  attachments: attachmentsSchema,
};

/** Attach each file to the defect, one save per file; the first failure stops with what was done so far. */
async function attachAll(adapter: AttachWriter, defect: string, files: AttachmentInput[]): Promise<{ done: string[]; error?: string }> {
  const done: string[] = [];
  if (!adapter.addAttachment) return { done, error: 'Attaching files is available only on a SimplifyQA connection.' };
  for (const f of files) {
    const src = await readAttachmentSource(f).catch((e: unknown) => ({ error: describeError(e) }));
    if ('error' in src) return { done, error: src.error };
    try {
      await adapter.addAttachment({ entityType: 'defect', itemId: defect, fileName: src.name, contentType: src.mime, data: src.data });
      done.push(src.name);
    } catch (e) {
      return { done, error: `"${src.name}": ${describeError(e)}` };
    }
  }
  return { done };
}

export function registerDefectUpdateTool(server: McpServer, deps: DefectUpdateToolDeps): void {
  server.registerTool(
    'defect_update',
    {
      title: 'Update a defect (state, assignee, environment, type, feature, dates, linkages, attachments, …)',
      description:
        'Change an existing DEFECT the way the SimplifyQA defect form does, then READ IT BACK and report each change. Pass `defectId` (id, code like ' +
        'DE-61, or exact name) and only what to change:\n' +
        '- `storyId` — the form\'s USER STORY field (story id or key, e.g. US-25; "none" clears it). This is NOT a Linkages row.\n' +
        '- `testCases` — the form\'s TEST CASE field: test cases to ADD, each "TC-41" or with its version "TC-41:v1.0" (no version = the test case\'s ' +
        'current one, and the answer says which). The defect then shows in each test case\'s linked defects — checked after saving. `removeTestCases` ' +
        'takes some out; `clearTestCases:true` empties the field.\n' +
        '- `state`, `priority`, `severity` (the project\'s own values; an unknown one is refused with the valid ones listed), `assignee` (email, name, ' +
        'user id or "me") or `unassign:true`, `releaseId` / `sprintId` (id, code or name; "none" clears), `name`, `description`.\n' +
        '- `environment`, `executionType` (alias `type`), `featureId`, `plannedStartDate`, `plannedEndDate` — the rest of the form ("none" clears one). ' +
        'Environment / Type are checked against the project\'s own list (or the form\'s: Development / QA / UAT, Manual / Automation).\n' +
        '- `linkages` — LINKAGES saved from the defect\'s side: [{ destType, destId, linkType }].\n' +
        '- `attachments` — files to attach to the defect ([{ filePath }]).\n' +
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
        ...formFields,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & AttachWriter & { updateDefect?: (ref: string, patch: DefectUpdateInput) => Promise<DefectUpdateResult> }) | null;
      if (!adapter) return err('Not connected to a product. Use qa_connect({ url, token, projectId }) first — defect_update needs a live backend connection.');
      if (!adapter.updateDefect) return err('This product does not expose defect updates.');
      const { defectId, attachments, type, ...rest } = args;
      const patch: DefectUpdateInput = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
      if (type !== undefined) {
        if (patch.executionType !== undefined && patch.executionType !== type) return err('defect_update: `type` and `executionType` are the same field — give one.');
        patch.executionType = type;
      }
      if (patch.unassign && patch.assignee !== undefined) return err('defect_update: give either assignee or unassign:true, not both.');
      if (!Object.keys(patch).length && !attachments?.length) {
        return err('defect_update needs something to change: storyId, testCases (or removeTestCases / clearTestCases), state, priority, severity, assignee (or unassign), releaseId, sprintId, name, description, environment, executionType (type), featureId, plannedStartDate, plannedEndDate, linkages or attachments.');
      }
      try {
        const lines: string[] = [];
        let data: Record<string, unknown> = {};
        let shown = defectId;
        if (Object.keys(patch).length) {
          const r = await adapter.updateDefect(defectId, patch);
          shown = r.code;
          lines.push(r.written
            ? `Updated defect ${r.code} "${r.name}" and read it back from SimplifyQA:\n` + r.changes.map((c) => `- ${c.field}: ${c.from} → ${c.to}`).join('\n')
            : `Defect ${r.code} "${r.name}" already matches — nothing was changed.`, ...r.warnings.map((w) => `⚠️ ${w}`));
          data = { ...r } as unknown as Record<string, unknown>;
        }
        if (attachments?.length) {
          const a = await attachAll(adapter, shown, attachments);
          if (a.done.length) lines.push(`Attached to ${shown}: ${a.done.join(', ')}.`);
          if (a.error) return err([...lines, `Could not attach ${a.error}`].join('\n'));
          data = { ...data, attached: a.done };
        }
        return ok(lines.join('\n'), data);
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
        '`estimatedEffort`, `customFields` ({ key: value } — needed when the project marks custom fields mandatory), and the rest of the form: ' +
        '`environment`, `executionType` (alias `type`: Manual / Automation), `featureId`, `plannedStartDate` / `plannedEndDate` (YYYY-MM-DD), ' +
        '`linkages` ([{ destType, destId, linkType }], saved from the defect\'s side) and `attachments` ([{ filePath }]). Environment / Type are ' +
        'checked against the project\'s own list (or the form\'s: Development / QA / UAT, Manual / Automation); a bad value refuses the call before ' +
        'anything is created. A defect with the same name is refused. Reads the defect back. Needs the add_defect privilege. To log a defect FROM a ' +
        'failed execution step (evidence pre-filled), use defect_create_from_step instead; to change one later, defect_update.',
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
        ...formFields,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & AttachWriter & { createDefect?: (input: DefectCreateInput) => Promise<DefectCreateResult> }) | null;
      if (!adapter) return err('Not connected to a product. Use qa_connect({ url, token, projectId }) first — defect_create needs a live backend connection.');
      if (!adapter.createDefect) return err('This product does not expose defect creation.');
      try {
        const { attachments, type, ...rest } = args;
        const input: DefectCreateInput = { name: rest.name };
        for (const [k, v] of Object.entries(rest)) if (k !== 'name' && v !== undefined) (input as Record<string, unknown>)[k] = v;
        if (type !== undefined) {
          if (input.executionType !== undefined && input.executionType !== type) return err('defect_create: `type` and `executionType` are the same field — give one.');
          input.executionType = type;
        }
        const r = await adapter.createDefect(input);
        const lines = [
          `Logged defect ${r.defectCode} "${r.name}" — state ${r.state || '-'}, priority ${r.priority || '-'}${r.severity ? `, severity ${r.severity}` : ''}` +
            `${r.testCases.length ? `, test case ${r.testCases.join(', ')}` : ''}${r.storyId !== undefined ? `, user story #${r.storyId}` : ''}. Read back from SimplifyQA.`,
          ...(r.fields?.length ? [`Form fields saved: ${r.fields.join('; ')}.`] : []),
          ...(r.linked?.length ? [`Linked from the defect to: ${r.linked.join(', ')}.`] : []),
          ...(r.defaults.length ? [`Defaulted (not given): ${r.defaults.join('; ')}.`] : []),
          ...r.warnings.map((w) => `⚠️ ${w}`),
        ];
        if (attachments?.length) {
          const a = await attachAll(adapter, r.defectCode, attachments);
          if (a.done.length) lines.push(`Attached to ${r.defectCode}: ${a.done.join(', ')}.`);
          if (a.error) return err([...lines, `The defect was logged, but attaching failed — ${a.error}`].join('\n'));
        }
        return ok(lines.join('\n'), { ...r } as unknown as Record<string, unknown>);
      } catch (e) {
        return err(describeError(e));
      }
    },
  );
}
