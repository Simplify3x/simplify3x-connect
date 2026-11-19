/**
 * `release_update` / `sprint_update` — change or close a SimplifyQA release or sprint; `release_delete` / `sprint_delete` remove one.
 *
 * Releases and sprints could only be read (sqa_query "releases" / "sprints"). These read the record, change only what was
 * asked, save it the way the SimplifyQA editor does, and read it back — the answer says what the stored state now is.
 * SimplifyQA lets only an admin user edit a release / sprint; for anyone else the tool says so.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import { PmBlockedError } from '../adapters/simplifyqa/adapter.js';
import type { PmBlockers, PmCreateInput, PmCreateResult, PmDeletePreview, PmUpdateInput, PmUpdateResult, SuiteRef } from '../adapters/simplifyqa/adapter.js';

export type ReleaseSprintToolDeps = { getAdapter: () => ProviderAdapter | null };

type PmWrites = {
  updateReleaseOrSprint: (kind: 'release' | 'sprint', ref: string, patch: PmUpdateInput) => Promise<PmUpdateResult>;
  createReleaseOrSprint: (kind: 'release' | 'sprint', input: PmCreateInput) => Promise<PmCreateResult>;
};

type PmDeletes = {
  releaseOrSprintDeletePreview: (kind: 'release' | 'sprint', ref: string) => Promise<PmDeletePreview>;
  deleteReleaseOrSprint: (kind: 'release' | 'sprint', ref: string) => Promise<SuiteRef>;
};

const NOT_CONNECTED =
  'Not connected to a product. Use qa_connect({ url, token, projectId }) first — release_update / sprint_update need a live SimplifyQA connection.';

const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const FIELD_NAMES: Record<string, string> = {
  state: 'state', name: 'name', plannedStartDate: 'planned start', plannedEndDate: 'planned end', actualStartDate: 'actual start',
  actualEndDate: 'actual end', description: 'description', estimatedEffort: 'estimated effort', ownerIds: 'owners',
};

const changeFields = {
  state: z.string().optional().describe('The state to set, as the project names it (e.g. "In-progress", "Completed"). An unknown state is refused with the valid ones listed.'),
  close: z.boolean().optional().describe('true = close it: the project\'s completed-type state (Completed / Released / Closed) and the actual end date. Use this for "close release RE-44".'),
  name: z.string().optional().describe('New name (3–500 characters).'),
  description: z.string().optional(),
  plannedStartDate: z.string().optional().describe('YYYY-MM-DD.'),
  plannedEndDate: z.string().optional().describe('YYYY-MM-DD, on or after the start.'),
  actualStartDate: z.string().optional().describe('YYYY-MM-DD.'),
  actualEndDate: z.string().optional().describe('YYYY-MM-DD.'),
  estimatedEffort: z.number().min(0).optional(),
  ownerIds: z.array(z.number()).min(1).optional().describe('Owner user ids (replaces the current owners).'),
};

export function registerReleaseSprintTools(server: McpServer, deps: ReleaseSprintToolDeps): void {
  const handler = (kind: 'release' | 'sprint') => async (args: Record<string, unknown>) => {
    const adapter = deps.getAdapter() as (ProviderAdapter & Partial<PmWrites>) | null;
    if (!adapter) return err(NOT_CONNECTED);
    if (!adapter.updateReleaseOrSprint) return err(`${kind}_update is available only on a SimplifyQA connection.`);
    const ref = String(args[kind === 'release' ? 'releaseId' : 'sprintId'] ?? '').trim();
    if (!ref) return err(`${kind}_update needs ${kind === 'release' ? 'releaseId' : 'sprintId'} — the ${kind}'s id, code or exact name.`);
    const patch: PmUpdateInput = {};
    for (const k of ['state', 'close', 'name', 'description', 'plannedStartDate', 'plannedEndDate', 'actualStartDate', 'actualEndDate', 'estimatedEffort', 'ownerIds'] as const) {
      if (args[k] !== undefined) (patch as Record<string, unknown>)[k] = args[k];
    }
    if (patch.close && patch.state !== undefined) return err(`${kind}_update: give either close:true or a state, not both.`);
    if (!Object.keys(patch).length) {
      return err(`${kind}_update needs something to change: close:true, state, or one of ${Object.keys(FIELD_NAMES).filter((f) => f !== 'state').join(', ')}.`);
    }
    try {
      const r = await adapter.updateReleaseOrSprint(kind, ref, patch);
      const head = r.written
        ? `Updated ${kind} ${r.code} "${r.name}": state ${r.stateBefore || '(none)'} → ${r.stateAfter}` +
          `${r.changed.length ? ` (changed: ${r.changed.map((c) => FIELD_NAMES[c] ?? c).join(', ')})` : ''}. Read back from SimplifyQA: ${r.stateAfter}.`
        : `${kind} ${r.code} "${r.name}" already matches (state ${r.stateAfter}) — nothing was changed.`;
      return ok([head, ...r.warnings.map((w) => `⚠️ ${w}`)].join('\n'), { ...r } as unknown as Record<string, unknown>);
    } catch (e) {
      return err(describeError(e));
    }
  };

  server.registerTool(
    'release_update',
    {
      title: 'Update or close a release (SimplifyQA)',
      description:
        'Change or CLOSE a SimplifyQA release. Read releases with sqa_query (collection "releases"). Pass `releaseId` (id, code like RE-44, ' +
        'or exact name) and either `close:true` (sets the project\'s completed-type state and the actual end date) or `state`, and/or ' +
        'name, dates, description, estimatedEffort, ownerIds. It reads the release back and reports the stored state. Only an admin user ' +
        'can edit a release in SimplifyQA. Closing warns when the release still has sprints that are not completed.',
      inputSchema: { releaseId: z.string().describe('Release id, code (RE-44) or exact name.'), ...changeFields },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    handler('release'),
  );

  server.registerTool(
    'sprint_update',
    {
      title: 'Update or complete a sprint (SimplifyQA)',
      description:
        'Change or COMPLETE a SimplifyQA sprint. Read sprints with sqa_query (collection "sprints"). Pass `sprintId` (id, code, or exact name) ' +
        'and either `close:true` (sets the completed state and the actual end date) or `state`, and/or name, dates, description, ' +
        'estimatedEffort, ownerIds. It reads the sprint back and reports the stored state. Only an admin user can edit a sprint in ' +
        'SimplifyQA, and its editor refuses to complete a sprint that still has new / pending stories, tasks or defects (not checked here).',
      inputSchema: { sprintId: z.string().describe('Sprint id, code or exact name.'), ...changeFields },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    handler('sprint'),
  );

  const createFields = {
    name: z.string().describe('Name (3–500 characters).'),
    plannedStartDate: z.string().describe('YYYY-MM-DD.'),
    plannedEndDate: z.string().describe('YYYY-MM-DD, on or after the start.'),
    estimatedEffort: z.number().min(0).describe('Estimated effort in hours (e.g. 2).'),
    description: z.string().optional(),
    state: z.string().optional().describe('Defaults to the project\'s first state (New). An unknown state is refused with the valid ones listed.'),
    owners: z.array(z.string()).optional().describe('Owners: emails, names, user ids or "me". Default: the connected user (SimplifyQA requires at least one owner).'),
  };
  const createHandler = (kind: 'release' | 'sprint') => async (args: Record<string, unknown>) => {
    const adapter = deps.getAdapter() as (ProviderAdapter & Partial<PmWrites>) | null;
    if (!adapter) return err(NOT_CONNECTED);
    if (!adapter.createReleaseOrSprint) return err(`${kind}_create is available only on a SimplifyQA connection.`);
    try {
      const input: PmCreateInput = {
        name: String(args['name'] ?? ''), plannedStartDate: String(args['plannedStartDate'] ?? ''), plannedEndDate: String(args['plannedEndDate'] ?? ''),
        estimatedEffort: args['estimatedEffort'] as number,
        ...(args['description'] !== undefined ? { description: String(args['description']) } : {}),
        ...(args['state'] !== undefined ? { state: String(args['state']) } : {}),
        ...(args['owners'] !== undefined ? { owners: args['owners'] as string[] } : {}),
        ...(args['releaseId'] !== undefined ? { releaseId: String(args['releaseId']) } : {}),
      };
      const r = await adapter.createReleaseOrSprint(kind, input);
      const head = `Created ${kind} ${r.code} "${r.name}"${r.release ? ` in release ${r.release}` : ''}: state ${r.state}, ` +
        `${r.plannedStartDate} → ${r.plannedEndDate}, estimated effort ${r.estimatedEffort} h. Read back from SimplifyQA.`;
      return ok([head, ...r.warnings.map((w) => `⚠️ ${w}`)].join('\n'), { ...r } as unknown as Record<string, unknown>);
    } catch (e) {
      return err(describeError(e));
    }
  };

  server.registerTool(
    'release_create',
    {
      title: 'Create a release (SimplifyQA)',
      description:
        'Create a SimplifyQA release in the connected project — what Releases → Create Release does — and return its key (RE-xx). Needs ' +
        '`name`, `plannedStartDate`, `plannedEndDate` (YYYY-MM-DD) and `estimatedEffort` (hours). The state defaults to New and the owner to ' +
        'the connected user (SimplifyQA requires one). A release with the same name is refused. It reads the release back. Only an admin ' +
        'user can create releases. Use the returned RE-xx as `releaseId` for runs, schedules and pipelines, and create sprints with sprint_create.',
      inputSchema: createFields,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    createHandler('release'),
  );

  server.registerTool(
    'sprint_create',
    {
      title: 'Create a sprint under a release (SimplifyQA)',
      description:
        'Create a SimplifyQA sprint under an existing release and return its key (SP-xx). Needs `releaseId` (id, code like RE-44, or exact ' +
        'name — create the release first with release_create), `name`, `plannedStartDate`, `plannedEndDate` (YYYY-MM-DD) and ' +
        '`estimatedEffort` (hours). The state defaults to New and the owner to the connected user. A sprint with the same name in that ' +
        'release is refused; dates outside the release\'s are warned about. It reads the sprint back. Only an admin user can create sprints.',
      inputSchema: { releaseId: z.string().describe('The release this sprint belongs to: id, code (RE-44) or exact name.'), ...createFields },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    createHandler('sprint'),
  );

  // ---- delete: TWO-STEP, refused while anything still uses the record -----------------------------------------------
  const BLOCKER_NAMES: Record<keyof PmBlockers, string> = {
    sprints: 'sprints', stories: 'stories', defects: 'defects', tasks: 'tasks', executionPlans: 'execution plans',
    pipelines: 'pipelines', schedules: 'schedules', otherProjects: 'other projects that also use this release',
  };
  const refLabel = (r: SuiteRef): string => [r.code ?? `#${r.id}`, r.name].filter(Boolean).join(' ');
  const listBlockers = (b: PmBlockers): string[] =>
    (Object.keys(BLOCKER_NAMES) as Array<keyof PmBlockers>).filter((k) => b[k].length)
      .map((k) => `- ${BLOCKER_NAMES[k]} (${b[k].length}): ${b[k].slice(0, 8).map(refLabel).join(', ')}${b[k].length > 8 ? ', …' : ''}`);

  const deleteHandler = (kind: 'release' | 'sprint') => async (args: Record<string, unknown>) => {
    const adapter = deps.getAdapter() as (ProviderAdapter & Partial<PmDeletes>) | null;
    if (!adapter) return err(NOT_CONNECTED);
    if (!adapter.releaseOrSprintDeletePreview || !adapter.deleteReleaseOrSprint) return err(`${kind}_delete is available only on a SimplifyQA connection.`);
    const idArg = kind === 'release' ? 'releaseId' : 'sprintId';
    const ref = String(args[idArg] ?? '').trim();
    if (!ref) return err(`${kind}_delete needs ${idArg} — the ${kind}'s id, code or exact name.`);
    try {
      const { record, blockers, callerIsAdmin } = await adapter.releaseOrSprintDeletePreview(kind, ref);
      const used = listBlockers(blockers);
      if (used.length) {
        return err(`${refLabel(record)} can't be deleted — it is still used by:\n${used.join('\n')}\n` +
          `Move or remove those first${kind === 'release' ? ' (delete or move its sprints, re-point its items)' : ''}. Nothing was deleted.`);
      }
      if (args['confirm'] !== true) {
        return ok(
          `⚠️ About to delete ${kind} **${record.name ?? record.id}** (${record.code ?? record.id}${record.state ? `, ${record.state}` : ''}). ` +
            `Nothing links to it. Past runs keep their reference to it. This cannot be undone from here. ` +
            (callerIsAdmin ? '' : `⚠️ The connected user does not look like a SimplifyQA admin, and only an admin can delete a ${kind}. `) +
            `Nothing has been deleted yet. Only if the user explicitly confirms, call again with { ${idArg}: "${ref}", confirm: true }.`,
          { preview: true, kind, record, callerIsAdmin },
        );
      }
      const gone = await adapter.deleteReleaseOrSprint(kind, ref);
      return ok(`Deleted ${kind} ${refLabel(gone)}. Checked against SimplifyQA: it is no longer listed.`, { deleted: true, kind, record: gone });
    } catch (e) {
      if (e instanceof PmBlockedError) {
        return err(`${refLabel(e.record)} can't be deleted — it is still used by:\n${listBlockers(e.blockers).join('\n')}\nNothing was deleted.`);
      }
      return err(describeError(e));
    }
  };

  server.registerTool(
    'release_delete',
    {
      title: 'Delete a release (SimplifyQA)',
      description:
        'Delete a SimplifyQA release (Releases → Delete). TWO-STEP: call with `releaseId` (id, code like RE-45, or exact name) and no `confirm` ' +
        'to PREVIEW — it lists everything still linked (its sprints, stories, defects, tasks, execution plans, pipelines, schedules, other ' +
        'projects using it) and deletes nothing. Show that to the user, and call again with `confirm:true` ONLY after the user explicitly says ' +
        'to delete. A release that anything still uses is refused even with confirm. Only an admin user can delete a release.',
      inputSchema: {
        releaseId: z.string().describe('Release id, code (RE-45) or exact name.'),
        confirm: z.boolean().optional().describe('true on the SECOND call, only after the user explicitly said to delete.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    deleteHandler('release'),
  );

  server.registerTool(
    'sprint_delete',
    {
      title: 'Delete a sprint (SimplifyQA)',
      description:
        'Delete a SimplifyQA sprint (Sprints → Delete). TWO-STEP: call with `sprintId` (id, code like SP-64, or exact name) and no `confirm` to ' +
        'PREVIEW — it lists everything still linked (stories, defects, tasks, execution plans, pipelines, schedules) and deletes nothing. ' +
        'Show that to the user, and call again with `confirm:true` ONLY after the user explicitly says to delete. A sprint that anything ' +
        'still uses is refused even with confirm. Only an admin user can delete a sprint.',
      inputSchema: {
        sprintId: z.string().describe('Sprint id, code (SP-64) or exact name.'),
        confirm: z.boolean().optional().describe('true on the SECOND call, only after the user explicitly said to delete.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    deleteHandler('sprint'),
  );
}
