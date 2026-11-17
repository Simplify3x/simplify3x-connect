import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import { zRawFilter } from './schemas.js';

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
}
