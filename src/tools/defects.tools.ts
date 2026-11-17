import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import { zRawFilter } from './schemas.js';

export type DefectToolsDeps = {
  getAdapter: () => ProviderAdapter | null;
};

const NOT_CONNECTED =
  'Not connected to a product. Use qa_connect({ url, token, projectId }) first — listing defects ' +
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

export function registerDefectTools(server: McpServer, deps: DefectToolsDeps): void {
  server.registerTool(
    'defect_list',
    {
      title: 'List / search defects (bugs)',
      description:
        'List defects (bugs) raised in the connected project — id/code, title, state, severity, ' +
        'priority, assignee(s), and which test case(s) each is linked to. Mirrors the filters on the ' +
        'product\'s Defect list page: `search` (title keyword), `tcId` (defects against one test case), ' +
        '`storyId` (defects on one user story), `state` (workflow state — use the exact `state` value ' +
        'from an existing defect_list row, e.g. "new"/"open"/"closed", not the capitalized UI label), ' +
        '`assignedTo` / `createdBy` (numeric userId, or "me" — resolve a name to an id via list_users ' +
        'first). The Defect list page also lets a user filter by MANY MORE project-configured columns ' +
        '(Module, Release, Feature, Team, Client, Labels, custom fields, ...) that vary per project — ' +
        'pass those via `filters: [{ column, value }]` (raw column filters, appended as-is; use the ' +
        'field\'s backend key, e.g. `moduleId`/`releaseId`/`featureId`/`teamId`/`clientId`/`tags`). ' +
        'Omit everything for the full project list. Requires a live connection (qa_connect). Read-only ' +
        'and product-neutral. When presenting this as a table, label the columns "ID" and "Name" — ' +
        'the underlying fields are literally named `code`/`title`, but that\'s internal wire ' +
        'terminology, not what to show the user.',
      inputSchema: {
        search: z.string().optional().describe('Keyword to find defects by title.'),
        tcId: z.string().optional().describe('Only defects raised against this test case (id or business key).'),
        storyId: z.string().optional().describe('Only defects linked to this user story (id or business key).'),
        state: z.string().optional().describe('Exact workflow state key (e.g. "new", "open", "closed") — from an existing row\'s `state` value, not the capitalized UI label.'),
        assignedTo: z.string().optional().describe('Numeric userId of the assignee. Pass "me" for the current caller. Resolve names via list_users first.'),
        createdBy: z.string().optional().describe('Numeric userId of the creator. Pass "me" for the current caller. Resolve names via list_users first.'),
        filters: z.array(zRawFilter).optional().describe('Extra raw column filters for project-configured columns with no dedicated parameter above (Module/Release/Feature/Team/Client/Labels/custom fields).'),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ search, tcId, storyId, state, assignedTo, createdBy, filters, limit, offset }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.listDefects) return err('This product does not expose a defect tracker.');
      try {
        const rows = await adapter.listDefects({
          ...(search ? { search } : {}),
          ...(tcId ? { tcId } : {}),
          ...(storyId ? { storyId } : {}),
          ...(state ? { state } : {}),
          ...(assignedTo ? { assignedTo } : {}),
          ...(createdBy ? { createdBy } : {}),
          ...(filters?.length ? { filters } : {}),
          ...(limit != null ? { limit } : {}),
          ...(offset != null ? { offset } : {}),
        });
        if (!rows.length) return ok('No defects found.', { defects: [], totalCount: totalOf(rows) ?? 0 });
        const assignedIds = new Set<string>();
        for (const d of rows) for (const id of d.assignedTo ?? []) assignedIds.add(id);
        const nameById = await resolveUserNames(adapter, assignedIds);
        const displayAssigned = (ids?: string[]) =>
          ids?.length ? ids.map((id) => nameById.get(id) ?? `user ${id}`).join(', ') : '-';
        const text =
          `${countHeader(rows, 'defect')}:\n\n` +
          '| ID | Name | state | severity | priority | assigned to |\n|---|---|---|---|---|---|\n' +
          rows
            .map((d) => `| ${escCell(d.code ?? d.id)} | ${escCell(d.title)} | ${escCell(d.state ?? '-')} | ${escCell(d.severity ?? '-')} | ${escCell(d.priority ?? '-')} | ${escCell(displayAssigned(d.assignedTo))} |`)
            .join('\n');
        return ok(text, { defects: rows, totalCount: totalOf(rows) ?? rows.length });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );
}
