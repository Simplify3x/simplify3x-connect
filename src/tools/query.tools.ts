/**
 * `sqa_query` — ONE read tool for every SimplifyQA collection.
 *
 * Operations:
 *   catalog       — collections, descriptions, fields, relations, custom-field parentId
 *   custom_fields — resolve a custom-field label to its key + `customFields.<key>` column
 *   search        — compile filters/sort/paging and return rows
 *   get           — one row by id/key, optionally expanding steps/versions/members
 *   related       — follow a relation (story → testcases, testcase → defects, suite → runs, ...)
 *
 * The engine always injects `deleted:false` and the active project. Unknown fields are rejected
 * locally because the backend silently ignores them (200 + 0 rows).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type {
  SqaCatalogEntry,
  SqaCustomField,
  SqaQueryRequest,
  SqaQueryResult,
  SqaRow,
  SqaSearchResult,
  SqaWhere,
} from '../adapters/simplifyqa/searchEngine.js';
import { resolveCollection } from '../adapters/simplifyqa/searchRegistry.js';

/** The collection's visibility note (users / projects): which rows the caller can see. */
export function visibilityOf(collection: string): string | undefined {
  return resolveCollection(collection)?.visibility;
}

/** Collections people ask for that this MCP does not expose. */
const UNAVAILABLE_LOGS = /^(activity|audit|access|login|user[\s_-]?activity|application)[\s_-]?(logs?|trail|history)$|^(activity|audit)$/i;
export const UNAVAILABLE_LOGS_MSG =
  'Activity / audit logs are NOT available through this MCP. Tell the user exactly that — "Activity logs ' +
  'are not available here; an admin can see them in SimplifyQA under Admin → Activity Log" — and STOP. ' +
  'Do NOT substitute another collection (scheduleHistory is scheduler runs only, executions are test runs).';

/** Prefixes a search/count result with the visibility note, so "341 users" is never read as everyone. */
function withVisibility(collection: string, text: string, scopeNote?: string): string {
  if (scopeNote) return `_**Scope:** ${scopeNote} Say so in the answer._\n\n${text}`;
  const v = visibilityOf(collection);
  if (!v) return text;
  return (
    `_**Visibility:** ${v} When you answer, say this — e.g. "N users in your projects", ` +
    `not "all users"._\n\n${text}`
  );
}

export type QueryToolsDeps = {
  getAdapter: () => ProviderAdapter | null;
};

const NOT_CONNECTED =
  'Not connected to a product. Use qa_connect({ url, token, projectId }) first — sqa_query needs a live SimplifyQA connection.';

const zWhere = z.object({
  field: z.string().describe(
    'Field key for the collection (e.g. moduleId, state, userstoryId). For a custom field, pass its label here and set custom:true.',
  ),
  op: z.enum(['eq', 'ne', 'in', 'not_in', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists']).optional().describe(
    'Filter operator. Default: "in" for array values, otherwise "eq". "contains" is a case-insensitive substring (the backend escapes regex specials).',
  ),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string()),
    z.array(z.number()),
  ]).optional().describe('Filter value. Use an array for in/not_in.'),
  custom: z.boolean().optional().describe(
    'Resolve `field` against the collection custom fields (match by label or key) and compile it to customFields.<key>.',
  ),
  condition: z.enum(['and', 'or']).optional().describe('Combine with the other filters using AND (default) or OR.'),
});

/** Models often send `where` as one filter object, a `{ field: value }` map, or a JSON string instead of the array
 *  the engine takes — and then burn several calls on "where needs an array". Normalise to the array form. */
function asWhereArray(v: unknown): unknown {
  let x = v;
  if (typeof x === 'string') {
    try { x = JSON.parse(x); } catch { return v; }
  }
  if (Array.isArray(x)) return x;
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    if (typeof o['field'] === 'string') return [o];
    return Object.entries(o).map(([field, value]) => ({ field, op: Array.isArray(value) ? 'in' : 'eq', value }));
  }
  return v;
}

/** `select` given as one string ("name") instead of ["name"]. */
function asStringArray(v: unknown): unknown {
  return typeof v === 'string' ? [v] : v;
}

const zSort = z.object({
  field: z.string(),
  dir: z.enum(['asc', 'desc']).optional(),
});

function cell(v: unknown): string {
  if (v === null || v === undefined) return '-';
  if (Array.isArray(v)) {
    const flat = v.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : String(x)));
    return flat.length <= 4 ? flat.join(', ') : `[${flat.length} items]`;
  }
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 100 ? `${s.slice(0, 97)}...` : s;
  }
  return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Extra columns for folder rows (test plans): header → key in the engine's `_folder` stats. */
const FOLDER_COLUMNS: Record<string, string> = {
  suites: 'suites',
  'test cases': 'testCases',
  'suites (with sub-folders)': 'suitesWithSubFolders',
  'test cases (with sub-folders)': 'testCasesWithSubFolders',
  'sub-folders': 'subFolders',
  path: 'path',
};

/** The readable value when the engine added one: a label as is, an id as "Name (#id)". */
function getCell(row: SqaRow, column: string): unknown {
  const folder = row['_folder'] as Record<string, unknown> | undefined;
  if (folder && FOLDER_COLUMNS[column] !== undefined) return folder[FOLDER_COLUMNS[column]!];
  const display = (row['_display'] as Record<string, string> | undefined)?.[column];
  if (display !== undefined) {
    const raw = row[column];
    const isIds = typeof raw === 'number' || (Array.isArray(raw) && raw.every((v) => typeof v === 'number'));
    return isIds ? `${display} (#${Array.isArray(raw) ? raw.join(', #') : raw})` : display;
  }
  if (column.startsWith('customFields.')) {
    const cf = row['customFields'];
    return cf && typeof cf === 'object' ? (cf as SqaRow)[column.slice('customFields.'.length)] : undefined;
  }
  return row[column];
}

/** "Interpreted: state "open" → NEW, IN_PROGRESS" — so the reader sees what was actually filtered. */
function searchText(res: SqaSearchResult, select?: string[]): string {
  const body = searchBody(res, select);
  if (!res.resolved?.length) return body;
  const lines = res.resolved.map((r) => `${r.field} ${r.from.map((f) => `"${f}"`).join(', ')} → ${r.to.join(', ')}`);
  return `_Interpreted: ${lines.join('; ')}._\n\n${body}`;
}

function searchBody(res: SqaSearchResult, select?: string[]): string {
  if (res.payload) {
    return `**Dry run — no HTTP call made.**\n\n\`\`\`json\n${JSON.stringify(res.payload, null, 2)}\n\`\`\``;
  }
  if (!res.rows.length) {
    return `No rows in **${res.collection}** (offset ${res.offset}).`;
  }
  const first = res.rows[0]!;
  // Folder rows show counts instead of their raw membership arrays.
  const hidden = ['_id', 'deleted', 'customerId', 'projectId', '_display', '_folder',
    ...(first['_folder'] ? ['childIds', 'suiteIds', 'testcaseIds'] : [])];
  const columns = [
    ...(select?.length && !(select.length === 1 && select[0] === '*')
      ? select
      : Object.keys(first).filter((k) => !hidden.includes(k)).slice(0, 12)),
    ...(first['_folder'] ? Object.keys(FOLDER_COLUMNS) : []),
  ];
  const header = `| ${columns.join(' | ')} |`;
  const sep = `|${columns.map(() => '---').join('|')}|`;
  const body = res.rows
    .slice(0, 50)
    .map((r) => `| ${columns.map((c) => cell(getCell(r, c))).join(' | ')} |`)
    .join('\n');
  const total = res.totalCount ?? res.returned;
  const more = res.nextOffset !== undefined
    ? `\n\n_Showing ${res.returned} of ${total}; nextOffset=${res.nextOffset}._`
    : res.returned === 1 ? '' : `\n\n_${total} row${total === 1 ? '' : 's'}._`;
  const versions = res.totalCountIsRows
    ? '\n\n_The total counts stored version rows (each version of an item is its own row), not items — use `op:"count"` for the number of items._'
    : '';
  return `**${res.collection}** — ${total} row${total === 1 ? '' : 's'} (offset ${res.offset}):\n\n${header}\n${sep}\n${body}${more}${versions}`;
}

function catalogText(entries: SqaCatalogEntry[], detailed: boolean): string {
  if (detailed && entries.length === 1) {
    const c = entries[0]!;
    const fieldLines = c.fields
      .map((f) => `- \`${f.key}\` (${f.type})${f.label ? ` — ${f.label}` : ''} · ops: ${f.ops.join(', ')}`)
      .join('\n');
    const relLines = c.relations.length
      ? c.relations.map((r) => `- **${r.name}** → ${r.to ?? r.kind} (${r.kind}) — ${r.description}`).join('\n')
      : '- none';
    return [
      `## ${c.name}`,
      c.description,
      '',
      `**Used for:** ${c.usedFor}`,
      `**Search:** \`POST ${c.searchPath}\`` + (c.getPath ? ` · **Get:** \`GET ${c.getPath}\`` : ''),
      `**Scope:** ${c.scope}` + (c.parentId !== undefined ? ` · **Custom-field parentId:** ${c.parentId}` : ''),
      ...(visibilityOf(c.name) ? [`**Visibility:** ${visibilityOf(c.name)}`] : []),
      `**Default fields:** ${c.defaultSelect.join(', ')}`,
      '',
      '**Fields (filter/sort):**',
      fieldLines,
      '',
      '**Relations (use op:"related"):**',
      relLines,
    ].join('\n');
  }
  const rows = entries
    .map((c) => `| ${c.name} | ${c.description} | ${c.defaultSelect.slice(0, 5).join(', ')} | ${c.relations.map((r) => r.name).join(', ') || '-'} |`)
    .join('\n');
  return (
    '**SimplifyQA collections** — use `op:"search"` with a `collection`, or `op:"catalog"` with a ' +
    'collection for full fields/relations. Custom fields: `op:"custom_fields"`.\n\n' +
    '| collection | what | key fields | relations |\n|---|---|---|---|\n' + rows
  );
}

function customFieldsText(collection: string, fields: SqaCustomField[]): string {
  if (!fields.length) return `No custom fields configured on **${collection}** in this project.`;
  const rows = fields
    .map((f) => `| ${f.label} | \`${f.key}\` | \`${f.column}\` | ${f.controlType ?? '-'} | ${f.mandatory ? 'yes' : 'no'} |`)
    .join('\n');
  return (
    `**Custom fields on ${collection}** — pass the label with \`custom: true\` in a filter.\n\n` +
    `| label | key | column | control | mandatory |\n|---|---|---|---|---|\n${rows}`
  );
}

function countText(res: Extract<SqaQueryResult, { op: 'count' }>): string {
  const lines: string[] = [];
  if (res.resolved?.length) {
    lines.push(`_Interpreted: ${res.resolved.map((r) => `${r.field} ${r.from.map((f) => `"${f}"`).join(', ')} → ${r.to.join(', ')}`).join('; ')}._`, '');
  }
  lines.push(`**${res.collection}** — ${res.approximate ? 'about ' : ''}${res.total} match.`);
  if (res.groups) {
    lines.push('', `| ${res.groupBy} | count |`, '|---|---|');
    for (const g of res.groups) lines.push(`| ${cell(g.label)}${g.label !== g.value && g.value ? ` (${cell(g.value)})` : ''} | ${g.count} |`);
  }
  if (res.approximate) {
    lines.push('', `_Built from the first ${res.scanned} rows; the full set is larger, so these numbers are a lower bound._`);
  }
  return lines.join('\n');
}

function resultText(res: SqaQueryResult, select?: string[]): string {
  switch (res.op) {
    case 'count':
      return withVisibility(res.collection, countText(res), res.scopeNote);
    case 'catalog':
      return catalogText(res.collections, true);
    case 'custom_fields':
      return customFieldsText(res.collection, res.fields);
    case 'search':
    case 'related':
      return res.payload ? searchText(res, select) : withVisibility(res.collection, searchText(res, select), res.scopeNote);
    case 'get':
      return (
        `**${res.collection}** — row \`${String(res.row['id'] ?? res.row['code'] ?? '?')}\`\n\n` +
        `\`\`\`json\n${JSON.stringify(res.expanded ? { ...res.row, expanded: res.expanded } : res.row, null, 2)}\n\`\`\``
      );
  }
}

export function registerQueryTools(server: McpServer, deps: QueryToolsDeps): void {
  server.registerTool(
    'sqa_query',
    {
      title: 'Query any SimplifyQA collection (catalog / search / get / related / custom_fields)',
      description:
        'THE ONLY READ TOOL ON SIMPLIFYQA. Use it for EVERY fetch / query / list / search / get / ' +
        'read / count request. The old per-collection read tools (tc_list, tc_get, story_list, ' +
        'story_get, epic_list, feature_list, list_modules, list_functions, suite_list, list_users, ' +
        'object_list, defect_list, task_list, list_releases, list_sprints, journal_grep, ...) are ' +
        'NOT registered on a SimplifyQA connection — do not look for them and do not invent one.\n\n' +
        'FLOW: (1) `op:"catalog"` (optionally with a collection) to see descriptions/fields/relations, ' +
        '(2) `op:"search"` for a list or `op:"get"` for one row, (3) `op:"related"` to follow a FK ' +
        '(story → testcases, testcase → defects, suite → runs, module → testcases, ...). For "how many" ' +
        'use `op:"count"` (same `where`), and add `groupBy` for a breakdown ("defects by severity").\n\n' +
        'RULES: every search injects `deleted:false` and the active project; deleted rows are never ' +
        'returned. Unknown fields/operators are rejected locally (the backend silently returns 0 rows ' +
        'for unknown columns). `priority`/`status` do NOT exist on SimplifyQA test cases — use ' +
        '`reviewApproveStatus` or a custom field.\n\n' +
        'CUSTOM FIELDS: `op:"custom_fields"` returns label → key → `customFields.<key>`; then pass the ' +
        'label as `field` with `custom:true` in `where` (or resolve one with `name`).\n\n' +
        'EXAMPLES:\n' +
        '- "list API test cases in module 46" → `{ op:"search", collection:"testcases", where:[{field:"tcType",op:"eq",value:"API"},{field:"moduleId",op:"eq",value:46}] }`\n' +
        '- "defects for TC 684" → `{ op:"related", collection:"testcases", id:"684", relation:"defects" }`\n' +
        '- "latest run of suite 120 + steps" → `{ op:"search", collection:"executions", where:[{field:"executionTypeId",op:"eq",value:120},{field:"type",op:"eq",value:"SUITE"}], sort:[{field:"id",dir:"desc"}], limit:1 }` then `{ op:"get", collection:"executions", id:"<runId>" }`\n' +
        '- "testcases where SEVERITY is High" → `{ op:"search", collection:"testcases", where:[{field:"SEVERITY",custom:true,op:"contains",value:"High"}] }`\n' +
        '- "releases / sprints in ALL my projects" → `{ op:"search", collection:"releases", allProjects:true }` and `{ op:"search", collection:"sprints", allProjects:true }` — do NOT qa_switch_project through each project. Release rows carry `projectIds`; sprint rows carry `releaseId`.\n\n' +
        'TIP: `dryRun:true` returns the compiled `searchFields` payload without making the HTTP call.',
      inputSchema: {
        op: z.enum(['catalog', 'search', 'get', 'related', 'custom_fields', 'count']).describe('Operation to run. "count" returns how many rows match (with `groupBy`, per value).'),
        groupBy: z.string().optional().describe('For op:"count": the field to break the count down by (e.g. "state", "severity", "ownerId", "tcType").'),
        includeHidden: z.boolean().optional().describe('Include rows hidden by default (obsolete test cases; child runs and re-execution copies of executions). Naming the field in `where` does the same.'),
        allVersions: z.boolean().optional().describe('Stories/epics: return every version row instead of one row per item.'),
        collection: z.string().optional().describe('Collection name or alias (testcases, tc, stories, defects, executions, ...). Required except for catalog.'),
        where: z.preprocess(asWhereArray, z.array(zWhere)).optional().describe('Filters, an ARRAY of { field, op?, value }. Combined with AND unless a filter sets condition:"or". Example: [{ field:"name", op:"contains", value:"login" }].'),
        select: z.preprocess(asStringArray, z.array(z.string())).optional().describe('Fields to return. Use ["*"] for the full row. Defaults to the collection summary projection.'),
        sort: z.array(zSort).optional().describe('Sort fields. Example: [{ field:"id", dir:"desc" }].'),
        limit: z.number().int().positive().max(500).optional().describe('Page size (default 50, max 500).'),
        offset: z.number().int().nonnegative().optional().describe('Row offset (not a page number — the engine sets skipStartIndex).'),
        id: z.string().optional().describe('Row id/business key — required for op:"get" and op:"related".'),
        relation: z.string().optional().describe('Relation name from the catalog — required for op:"related".'),
        expand: z.array(z.string()).optional().describe('For op:"get": relation names to expand (e.g. ["steps","versions"]).'),
        name: z.string().optional().describe('For op:"custom_fields": optional label/key to resolve (omit to list all).'),
        versionId: z.string().optional().describe('For op:"get"/"related" on testcases/functions: the version whose steps to read.'),
        dryRun: z.boolean().optional().describe('Return the compiled searchFields payload without calling the backend.'),
        allProjects: z.boolean().optional().describe('releases / sprints / epics / features, op:"search" or "count": read across EVERY project you have a role in instead of only the active one (no qa_switch_project needed). A projectId/projectIds filter narrows to some of your projects.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const adapter = deps.getAdapter() as
        | (ProviderAdapter & { sqaQuery?: (req: SqaQueryRequest) => Promise<SqaQueryResult> })
        | null;
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.sqaQuery) {
        return err('sqa_query is available only on a SimplifyQA connection (the current provider is Walnut).');
      }
      // Asked for something the MCP does not expose (activity / audit / login logs): say so plainly,
      // so the model answers "not available" instead of substituting a look-alike (scheduleHistory).
      if (args.collection && UNAVAILABLE_LOGS.test(args.collection)) return err(UNAVAILABLE_LOGS_MSG);
      if (args.op !== 'catalog' && !args.collection) {
        return err('`collection` is required for this op. Call sqa_query({ op:"catalog" }) to list collections.');
      }
      if ((args.op === 'get' || args.op === 'related') && !args.id) {
        return err('`id` is required for op:"get"/"related".');
      }
      if (args.op === 'related' && !args.relation) {
        return err('`relation` is required for op:"related". Call op:"catalog" with the collection to see relation names.');
      }

      const req: SqaQueryRequest = {
        op: args.op,
        ...(args.collection !== undefined ? { collection: args.collection } : {}),
        ...(args.where !== undefined ? { where: args.where as SqaWhere[] } : {}),
        ...(args.select !== undefined ? { select: args.select } : {}),
        ...(args.sort !== undefined ? { sort: args.sort } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.offset !== undefined ? { offset: args.offset } : {}),
        ...(args.id !== undefined ? { id: args.id } : {}),
        ...(args.relation !== undefined ? { relation: args.relation } : {}),
        ...(args.expand !== undefined ? { expand: args.expand } : {}),
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.versionId !== undefined ? { versionId: args.versionId } : {}),
        ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {}),
        ...(args.groupBy !== undefined ? { groupBy: args.groupBy } : {}),
        ...(args.includeHidden !== undefined ? { includeHidden: args.includeHidden } : {}),
        ...(args.allVersions !== undefined ? { allVersions: args.allVersions } : {}),
        ...(args.allProjects !== undefined ? { allProjects: args.allProjects } : {}),
      };

      try {
        const res = await adapter.sqaQuery(req);

        // custom_fields with a name → resolve one field (returns the same shape).
        if (res.op === 'custom_fields' && args.name) {
          const needle = args.name.trim().toLowerCase();
          const matches = res.fields.filter((f) =>
            f.label.trim().toLowerCase() === needle || f.key.trim().toLowerCase() === needle,
          );
          if (!matches.length) {
            return err(
              `Custom field "${args.name}" not found on ${res.collection}. Available: ` +
                res.fields.map((f) => f.label).join(', '),
            );
          }
          if (matches.length > 1) {
            return err(
              `Custom field "${args.name}" is ambiguous: ` +
                matches.map((f) => `${f.label} (${f.key})`).join(', ') +
                '. Pass the exact key as `name`.',
            );
          }
          return ok(
            `Resolved **${args.name}** on ${res.collection}:\n\n` +
              `- key: \`${matches[0]!.key}\`\n- column: \`${matches[0]!.column}\`\n` +
              `- control: ${matches[0]!.controlType ?? '-'}\n\n` +
              `Use it in a search: \`{ field:"${matches[0]!.label}", custom:true, op:"eq", value:"..." }\``,
            { ...res, matched: matches[0] },
          );
        }

        const visibility =
          (res.op === 'count' || res.op === 'search' || res.op === 'related')
            ? (res.scopeNote ?? visibilityOf(res.collection))
            : undefined;
        const extra: Record<string, unknown> =
          res.op === 'count'
            ? { ...res, ...(visibility ? { visibility } : {}) }
            : res.op === 'catalog'
            ? { op: res.op, collections: res.collections.length === 1 ? res.collections[0] : res.collections }
            : res.op === 'custom_fields'
              ? { op: res.op, collection: res.collection, fields: res.fields }
              : res.op === 'get'
                ? { op: res.op, collection: res.collection, row: res.row, ...(res.expanded ? { expanded: res.expanded } : {}) }
                : {
                    op: res.op,
                    collection: res.collection,
                    rows: res.rows,
                    totalCount: res.totalCount,
                    returned: res.returned,
                    offset: res.offset,
                    ...(res.nextOffset !== undefined ? { nextOffset: res.nextOffset } : {}),
                    ...(res.payload ? { payload: res.payload } : {}),
                    ...(res.resolved ? { resolved: res.resolved } : {}),
                    ...(res.totalCountIsRows ? { totalCountIsRows: true } : {}),
                    ...(visibility ? { visibility } : {}),
                  };
        return ok(resultText(res, args.select), extra);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
