import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import { zRawFilter } from './schemas.js';
import type { TaskCreateInput, TaskCreateResult, TaskUpdateInput, TaskUpdateResult } from '../adapters/simplifyqa/adapter.js';

export type TaskToolsDeps = {
  getAdapter: () => ProviderAdapter | null;
};

const NOT_CONNECTED =
  'Not connected to a product. Use qa_connect({ url, token, projectId }) first — listing tasks ' +
  'needs a live backend connection.';

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function escCell(v: unknown): string {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** SQA adapter attaches `totalCount` as a side-band prop on the returned array (mapper.withTotal). */
function totalOf(rows: unknown[]): number | undefined {
  const t = (rows as { totalCount?: number }).totalCount;
  return typeof t === 'number' ? t : undefined;
}

function countHeader(rows: unknown[], singular: string, plural = singular + 's'): string {
  const shown = rows.length;
  const total = totalOf(rows) ?? shown;
  const word = total === 1 ? singular : plural;
  return total > shown ? `Showing ${shown} of ${total} ${word}` : `${total} ${word}`;
}

/** Best-effort userId → display name map, so "assigned to" shows a person's name instead of a raw
 *  id. Falls back to showing the raw id for anyone not resolved (deleted user, or a project with
 *  more members than the single page fetched here). */
async function resolveUserNames(adapter: ProviderAdapter, ids: Set<string>): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!ids.size || !adapter.listUsers) return map;
  try {
    const users = await adapter.listUsers({ limit: 200 });
    for (const u of users) if (u.name) map.set(u.id, u.name);
  } catch {
    // best-effort — callers fall back to the raw id
  }
  return map;
}

export function registerTaskTools(server: McpServer, deps: TaskToolsDeps): void {
  server.registerTool(
    'task_list',
    {
      title: 'List / search tasks',
      description:
        'List tasks (project-management work items, distinct from test cases and defects) in the ' +
        'connected project — id/code, title, state, priority, assignee(s), and a linked defect id ' +
        'when raised against one. Give `search` for a title keyword, `storyId` for tasks tagged to a ' +
        'user story, `state`/`assignedTo`/`createdBy` to narrow further, or `filters: [{ column, ' +
        'value }]` for any other project-configured column with no dedicated parameter. Omit ' +
        'everything for the full project list. Requires a live connection (qa_connect). Read-only and ' +
        'product-neutral. When presenting this as a table, label the columns "ID" and "Name" — the ' +
        'underlying fields are literally named `code`/`title`, but that\'s internal wire terminology, ' +
        'not what to show the user.',
      inputSchema: {
        search: z.string().optional().describe('Keyword to find tasks by title.'),
        storyId: z.string().optional().describe('Only tasks tagged to this user story (id or business key, e.g. US_123).'),
        state: z.string().optional().describe('Exact workflow state key — from an existing row\'s `state` value, not the capitalized UI label.'),
        assignedTo: z.string().optional().describe('Numeric userId of the assignee. Pass "me" for the current caller. Resolve names via list_users first.'),
        createdBy: z.string().optional().describe('Numeric userId of the creator. Pass "me" for the current caller. Resolve names via list_users first.'),
        filters: z.array(zRawFilter).optional().describe('Extra raw column filters for project-configured columns with no dedicated parameter above.'),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ search, storyId, state, assignedTo, createdBy, filters, limit, offset }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.listTasks) return err('This product does not expose a task tracker.');
      try {
        const rows = await adapter.listTasks({
          ...(search ? { search } : {}),
          ...(storyId ? { storyId } : {}),
          ...(state ? { state } : {}),
          ...(assignedTo ? { assignedTo } : {}),
          ...(createdBy ? { createdBy } : {}),
          ...(filters?.length ? { filters } : {}),
          ...(limit != null ? { limit } : {}),
          ...(offset != null ? { offset } : {}),
        });
        if (!rows.length) return ok('No tasks found.', { tasks: [], totalCount: totalOf(rows) ?? 0 });
        const assignedIds = new Set<string>();
        for (const t of rows) for (const id of t.assignedTo ?? []) assignedIds.add(id);
        const nameById = await resolveUserNames(adapter, assignedIds);
        const displayAssigned = (ids?: string[]) =>
          ids?.length ? ids.map((id) => nameById.get(id) ?? `user ${id}`).join(', ') : '-';
        const text =
          `${countHeader(rows, 'task')}:\n\n` +
          '| ID | Name | state | priority | assigned to |\n|---|---|---|---|---|\n' +
          rows
            .map((t) => `| ${escCell(t.code ?? t.id)} | ${escCell(t.title)} | ${escCell(t.state ?? '-')} | ${escCell(t.priority ?? '-')} | ${escCell(displayAssigned(t.assignedTo))} |`)
            .join('\n');
        return ok(text, { tasks: rows, totalCount: totalOf(rows) ?? rows.length });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'task_update',
    {
      title: 'Update a task (planned dates, assignee, state, …)',
      description:
        'Change an existing TASK — what the SimplifyQA editor does, then it READS THE TASK BACK and reports each change. Pass `taskId` ' +
        '(id, code like TA-3, or exact name) and only what to change: `plannedStartDate` / `plannedEndDate` (YYYY-MM-DD), `assignee` ' +
        '(email, name, user id or "me" — one that matches nobody is refused) or `unassign:true`, `state`, `priority` (the project\'s own ' +
        'values; an unknown one is refused with the valid ones listed), `releaseId` / `sprintId` (id, code or name; a sprint brings its release; "none" clears), ' +
        '`storyId` (the linked user story; "none" clears), `name`, `description`, `estimatedEffort`, `actualEffort`, `remainingEffort`. Needs the add_task ' +
        'privilege. A start date after the end date is refused — move the end date too.',
      inputSchema: {
        taskId: z.string().describe('Task id, code (TA-3) or exact name.'),
        plannedStartDate: z.string().optional().describe('YYYY-MM-DD.'),
        plannedEndDate: z.string().optional().describe('YYYY-MM-DD.'),
        assignee: z.string().optional().describe('Who to assign it to: email (rohini.k@simplify3x.com), name, numeric user id, or "me".'),
        unassign: z.boolean().optional().describe('true = clear the assignee.'),
        state: z.string().optional(),
        priority: z.string().optional(),
        name: z.string().optional().describe('New name (at least 3 characters).'),
        description: z.string().optional(),
        estimatedEffort: z.number().min(0).max(9999).optional(),
        actualEffort: z.number().min(0).max(9999).optional(),
        remainingEffort: z.number().min(0).max(9999).optional(),
        releaseId: z.string().optional().describe('Release: id, code (RE-44) or exact name; "none" clears it (and the sprint).'),
        sprintId: z.string().optional().describe('Sprint: id, code (SP-1) or exact name; it must belong to the task\'s release. "none" clears it.'),
        storyId: z.string().optional().describe('Linked user story: id or key (US_123); "none" unlinks it.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & { updateTask?: (ref: string, patch: TaskUpdateInput) => Promise<TaskUpdateResult> }) | null;
      if (!adapter) return err('Not connected to a product. Use qa_connect({ url, token, projectId }) first — task_update needs a live backend connection.');
      if (!adapter.updateTask) return err('This product does not expose task updates.');
      const { taskId, ...rest } = args;
      const patch: TaskUpdateInput = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
      if (patch.unassign && patch.assignee !== undefined) return err('task_update: give either assignee or unassign:true, not both.');
      if (!Object.keys(patch).length) {
        return err('task_update needs something to change: plannedStartDate, plannedEndDate, assignee (or unassign), state, priority, releaseId, sprintId, storyId, name, description, estimatedEffort, actualEffort or remainingEffort.');
      }
      try {
        const r = await adapter.updateTask(taskId, patch);
        if (!r.written) return ok(`Task ${r.code} "${r.name}" already matches — nothing was changed.`, { ...r } as unknown as Record<string, unknown>);
        return ok(
          `Updated task ${r.code} "${r.name}" and read it back from SimplifyQA:\n` + r.changes.map((c) => `- ${c.field}: ${c.from} → ${c.to}`).join('\n'),
          { ...r } as unknown as Record<string, unknown>,
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'task_create',
    {
      title: 'Create a task',
      description:
        'Create a TASK in the connected project — what Tasks → Create Task does — and return its key (TS-xx / TA-xx). Needs `name` and ' +
        '`estimatedEffort` (hours); everything else is optional and DEFAULTED, and the answer lists what was defaulted: type / state / priority = ' +
        'the project\'s own default values, planned dates = the sprint\'s (else the release\'s, else today). Optional: `description`, `assignee` ' +
        '(email, name, user id or "me" — one that matches nobody is refused), `releaseId` / `sprintId` (id, code or exact name; a sprint brings ' +
        'its release and must belong to the release named), `storyId` (the user story it belongs to: id or key), `type`, `state`, `priority`, ' +
        '`plannedStartDate` / `plannedEndDate` (YYYY-MM-DD). A task with the same name in the project is refused. Reads the task back. ' +
        'Needs the add_task privilege. Change it later with task_update.',
      inputSchema: {
        name: z.string().describe('Task name (2–500 characters).'),
        estimatedEffort: z.number().min(0).max(9999).describe('Estimate in hours.'),
        description: z.string().optional(),
        assignee: z.string().optional().describe('Email, name, numeric user id or "me". Default: unassigned.'),
        releaseId: z.string().optional().describe('Release: id, code (RE-44) or exact name.'),
        sprintId: z.string().optional().describe('Sprint: id, code (SP-1) or exact name; it must belong to the release.'),
        storyId: z.string().optional().describe('User story it belongs to: id or key (US_123).'),
        type: z.string().optional().describe('Task type — one of the project\'s own; default: the project\'s default type.'),
        state: z.string().optional(),
        priority: z.string().optional(),
        plannedStartDate: z.string().optional().describe('YYYY-MM-DD.'),
        plannedEndDate: z.string().optional().describe('YYYY-MM-DD.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & { createTask?: (input: TaskCreateInput) => Promise<TaskCreateResult> }) | null;
      if (!adapter) return err('Not connected to a product. Use qa_connect({ url, token, projectId }) first — task_create needs a live backend connection.');
      if (!adapter.createTask) return err('This product does not expose task creation.');
      try {
        const input: TaskCreateInput = { name: args.name, estimatedEffort: args.estimatedEffort };
        for (const [k, v] of Object.entries(args)) if (k !== 'name' && k !== 'estimatedEffort' && v !== undefined) (input as Record<string, unknown>)[k] = v;
        const r = await adapter.createTask(input);
        const where = [r.release ? `release ${r.release}` : '', r.sprint ? `sprint ${r.sprint}` : ''].filter(Boolean).join(', ');
        const text = [
          `Created task ${r.code} "${r.name}" — ${r.type || 'task'}, state ${r.state || '-'}, priority ${r.priority || '-'}, ${r.plannedStartDate} → ${r.plannedEndDate}, ` +
            `estimate ${r.estimatedEffort} h${where ? `, ${where}` : ''}${r.ownerIds.length ? `, assigned to ${args.assignee}` : ', unassigned'}. Read back from SimplifyQA.`,
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
