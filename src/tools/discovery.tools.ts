import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { nextVersionName } from '../versionName.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { TestCase } from '../domain/types.js';
import type { FnVersionDep, JournalOp, MemberOp, TcQuery, TcVersionDep } from '../domain/types.js';
import { zJournalOp, zRawFilter } from './schemas.js';
import { stepsMarkdown } from './markdown.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveOutDir } from './outDir.js';
import { buildXlsx } from '../export/xlsx.js';

/**
 * The read side of the shared, product-neutral lifecycle contract: `tc_list` and
 * `tc_get`. Unlike the offline draft surface (testcase.tools.ts), these need a
 * LIVE backend, so they read the current provider adapter per call via
 * `deps.getAdapter()` -- the same product-routing seam project_info uses: whichever
 * product the session is connected to (walnut today, sqa via its own MCP later)
 * answers, and the tool shape is identical either way.
 */
export type DiscoveryToolsDeps = {
  /** The live provider adapter for the current connection, or null when offline. */
  getAdapter: () => ProviderAdapter | null;
  /** Optional draft lookup — lets `tc_save_as_new_version` freeze an EDITED draft into a new version
   *  (`fromDraftId`) instead of cloning what is already stored. Absent when the draft store isn't
   *  available in this build; the snapshot path stays fully functional. */
  getDraft?: (draftId: string) => { tc: TestCase } | null;
  /** False on a server other machines can reach: a caller `outDir` is then ignored (tools/outDir.ts). Default true. */
  allowOutDir?: boolean;
};

const NOT_CONNECTED =
  'Not connected to a product. Use qa_connect({ url, token, projectId }) first — listing and ' +
  'reading existing test cases needs a live backend connection (the offline path only authors drafts).';

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Markdown table cells: escape pipes and flatten newlines (mirrors markdown.ts). */
function escCell(v: unknown): string {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** SQA adapter attaches `totalCount` as a side-band prop on the returned array (via
 *  mapper.withTotal). The provider interface declares plain `T[]`, so read it via a widening cast. */
function totalOf(rows: unknown[]): number | undefined {
  const t = (rows as { totalCount?: number }).totalCount;
  return typeof t === 'number' ? t : undefined;
}

/** Render a `ModuleSaved` (single node or subtree) as human-readable text so the model sees the
 *  full tree shape it just created — id, code, isRoot flag, parent, and nested children indented.
 *  `failedAt` (if set on root) is surfaced at the bottom so a partial-success is never hidden. */
function formatModuleSaved(saved: any, indent = 0): string {
  const pad = '  '.repeat(indent);
  const code = saved.code ? ` [${saved.code}]` : '';
  const parent = saved.parentId ? `, parent=${saved.parentId}` : '';
  const root = saved.isRoot ? ', isRoot=true' : '';
  const head = `${pad}- ${saved.name}${code} (id ${saved.id}${root}${parent})`;
  const linkWarningLine = saved.linkWarning ? `${pad}  ⚠ ${saved.linkWarning}` : undefined;
  const childLines = (saved.children ?? []).map((c: any) => formatModuleSaved(c, indent + 1));
  const parts = [head, ...(linkWarningLine ? [linkWarningLine] : []), ...childLines];
  if (indent === 0 && saved.failedAt) {
    parts.push(`\n⚠ Subtree create stopped at "${saved.failedAt.path}": ${saved.failedAt.error}`);
    parts.push('  Nodes listed above ARE persisted. Fix the error, then create the remaining nodes.');
  }
  if (indent === 0) {
    const created = countCreated(saved);
    parts.unshift(`Created ${created} module${created === 1 ? '' : 's'}:`);
  }
  return parts.join('\n');
}

function countCreated(saved: any): number {
  return 1 + (saved.children ?? []).reduce((n: number, c: any) => n + countCreated(c), 0);
}

/** Header line for a list tool: "Showing 100 of 350 test cases" when the backend returned a
 *  totalCount larger than the page, else "N test cases". Pluralises via `plural` (defaults to `s`
 *  suffix — pass explicit forms for "stor y/ies", etc). */
function countHeader<T>(rows: T[], singular: string, plural = singular + 's'): string {
  const shown = rows.length;
  const total = totalOf(rows) ?? shown;
  const word = total === 1 ? singular : plural;
  return total > shown ? `Showing ${shown} of ${total} ${word}` : `${total} ${word}`;
}

/** One-line human summary of a single version's dependency row from `delete_version`'s dry-run.
 *  Shape branches on `parentType`: TC has 7 ref maps (defects, suites, execplans, scenarios,
 *  schedulers, pipelines, workflows), FN has 3 (tcs, fns, workflows). Each map is {projectId → ids}. */
function renderVersionDepRow(dep: TcVersionDep | FnVersionDep): string {
  const totalIn = (m: Record<string, number[]>): number =>
    Object.values(m).reduce((n, arr) => n + arr.length, 0);
  const parts: string[] = [];
  if ('defectArr' in dep) {
    const d = dep as TcVersionDep;
    const bits: Array<[string, number]> = [
      ['defect', totalIn(d.defectArr)], ['suite', totalIn(d.suiteArr)],
      ['exec-plan', totalIn(d.epArr)], ['scenario', totalIn(d.scenarioArr)],
      ['schedule', totalIn(d.schedulerArr)], ['pipeline', totalIn(d.pipelineArr)],
      ['workflow', totalIn(d.workflowArr)],
    ];
    for (const [label, n] of bits) if (n) parts.push(`${n} ${label}${n === 1 ? '' : 's'}`);
  } else {
    const d = dep as FnVersionDep;
    const bits: Array<[string, number]> = [
      ['test case', totalIn(d.tcArr)], ['function', totalIn(d.fnArr)], ['workflow', totalIn(d.wfArr)],
    ];
    for (const [label, n] of bits) if (n) parts.push(`${n} ${label}${n === 1 ? '' : 's'}`);
  }
  return parts.length ? `- ${parts.join(', ')}` : '- (no references)';
}


type SourceVersion = { id: string; name: string };

/** Pick the source version for save-as-new-TC/FN and save-as-new-version. A multi-version source is
 *  NEVER silently defaulted: with no selection it lists the versions by name and asks; a name/number the
 *  user gave ("v2", "2", "v2.0", or an id) is resolved here, and an unresolvable one lists the options.
 *  Single-version sources proceed and the caller states which version was used. */
async function pickSourceVersion(
  adapter: ProviderAdapter,
  kind: 'TC' | 'FN',
  id: string,
  requested: string | undefined,
): Promise<{ version?: SourceVersion; message?: string }> {
  let versions: Array<{ id: string; name: string; isCurrent?: boolean | undefined }> = [];
  try {
    const src = kind === 'TC' ? await adapter.getTestCase(id) : await adapter.getFunction!(id);
    versions = (src.versions ?? []).map((v) => ({ id: v.id, name: v.name, isCurrent: v.isCurrent }));
  } catch {
    // Version list unavailable — fall back to the adapter's own default rather than block.
    return requested ? { version: { id: requested, name: requested } } : {};
  }
  const listing = versions.map((v) => `- **${v.name}**${v.isCurrent ? ' (currently open)' : ''}`).join('\n');
  if (requested) {
    const r = requested.trim().toLowerCase();
    const num = r.replace(/^v/, '').replace(/\.0+$/, '');
    const hit = versions.find((v) => v.id === requested)
      ?? versions.find((v) => v.name.trim().toLowerCase() === r)
      ?? versions.find((v) => v.name.trim().toLowerCase().replace(/^v/, '').replace(/\.0+$/, '') === num);
    if (hit) return { version: { id: hit.id, name: hit.name } };
    return { message: `Version "${requested}" of ${id} was not found. Available versions:
${listing}

**Ask the user** which one to use, then call again with \`sourceVersionName\`.` };
  }
  if (versions.length > 1) {
    return { message: `${id} has ${versions.length} versions:
${listing}

**Ask the user** which version to use (do NOT default to the latest or v1), then call again with \`sourceVersionName\`. Nothing was created.` };
  }
  return versions[0] ? { version: { id: versions[0].id, name: versions[0].name } } : {};
}

/** Inline-display ceiling for tc_list: above this many matches the tool asks how to proceed instead of
 *  rendering everything into the chat. */
const TC_INLINE_LIMIT = 100;
const TC_EXPORT_PAGE = 100;
/** Hard stop on an export so a runaway project can't turn one call into unbounded requests. */
const TC_EXPORT_CAP = 20000;

/** Human-readable list of the filters a tc_list call applied — echoed in every response. */
function describeTcFilters(a: Record<string, unknown>): string {
  const parts: string[] = [];
  const add = (label: string, v: unknown) => { if (v !== undefined && v !== '') parts.push(`${label}: ${String(v)}`); };
  add('search', a['search']); add('status', a['status']); add('createdBy', a['createdBy']);
  add('updatedBy', a['updatedBy']); add('story', a['storyId']); add('module', a['moduleId']);
  if (typeof a['obsolete'] === 'boolean') parts.push(`obsolete: ${a['obsolete']}`);
  const f = a['filters'];
  if (Array.isArray(f)) for (const x of f as Array<{ column: string; value: unknown }>) parts.push(`${x.column}: ${String(x.value)}`);
  return parts.length ? parts.join(' · ') : 'none (all test cases in the active project)';
}

export function registerDiscoveryTools(server: McpServer, deps: DiscoveryToolsDeps): void {
  server.registerTool(
    'list_projects',
    {
      title: 'List projects (resolve a project name to its id)',
      description:
        'List the projects visible to the current connection — id, name and counts. Use this to ' +
        'resolve a project NAME to its id (e.g. before qa_switch_project when the user names a ' +
        'project). Requires a live connection.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      try {
        const rows = await adapter.listProjects();
        if (!rows.length) return ok('No projects found.', { projects: [], totalCount: totalOf(rows) ?? 0 });
        const view = rows.map(({ id: _id, ...rest }) => rest);
        const text =
          `${countHeader(rows, 'project')}:\n\n` +
          '| key | name | test cases |\n|---|---|---|\n' +
          rows.map((p) => `| ${escCell(p.code)} | ${escCell(p.name)} | ${p.counts?.['testCases'] ?? '-'} |`).join('\n');
        return ok(text, { projects: view, totalCount: totalOf(rows) ?? rows.length });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'tc_list',
    {
      title: 'List / search existing test cases (NOT reusable functions)',
      description:
        'List or search EXISTING TEST CASES (TC_* ids) in the connected product. NOT for reusable ' +
        'functions: if the user asks for functions, FN_*, the function library, or reusable steps, ' +
        'use `list_functions` instead. Trigger words for THIS tool: "test case", "TC", "TC_", ' +
        '"scenario", "script". Requires a live connection (qa_connect). Returns a summary list — id, ' +
        'title, technology, execution type, step count. Use `tc_get` to read one in full. ' +
        'Read-only, product-neutral. When presenting this as a table, label the columns "ID" and ' +
        '"Name" — the underlying fields are literally named `code`/`title`, but that\'s internal ' +
        'wire terminology, not what to show the user.',
      inputSchema: {
        search: z.string().optional().describe('Free-text search over title / id.'),
        status: z.string().optional().describe('Filter by status. Walnut only — SimplifyQA test cases have no status field (use `reviewApproveStatus` or a custom field via sqa_query).'),
        limit: z.number().int().positive().optional().describe('Max results (paging).'),
        offset: z.number().int().nonnegative().optional().describe('Result offset (paging).'),
        createdBy: z.string().optional().describe('Numeric userId of the creator. Pass "me" to filter by the current caller (needs QA_MCP_USER_ID for API-key auth). Resolve names to ids via list_users first.'),
        updatedBy: z.string().optional().describe('Numeric userId of the last updater. Pass "me" for the current caller. Resolve names via list_users first.'),
        storyId: z.string().optional().describe('Only test cases tagged to this user story (id or business key, e.g. US_123).'),
        moduleId: z.string().optional().describe('Only test cases filed under this module (id or business key, e.g. MO_12). SimplifyQA only — ignored elsewhere.'),
        obsolete: z.boolean().optional().describe('True → only obsolete TCs; false → only non-obsolete. Omit to include both. The response summary always reports how many of the returned rows are obsolete.'),
        filters: z.array(zRawFilter).optional().describe('Extra raw column filters for project-configured columns with no dedicated parameter above (e.g. custom fields) — use the field\'s backend key as `column`. SimplifyQA test cases have no priority/status/stepCount columns.'),
        output: z.enum(['xlsx', 'first100']).optional().describe(
          "How to return a LARGE result. Omit it: when more than 100 test cases match, the tool returns ONLY the total count + the options and you must ASK the user. 'xlsx' = write ALL matches to an .xlsx file (use directly when the user asked for Excel / a download — no need to ask). 'first100' = show exactly the first 100 inline. At 100 or fewer matches results are shown inline either way. Ignored when `limit`/`offset` is passed (an explicit page).",
        ),
        outDir: z.string().optional().describe('Folder for the .xlsx export. Default: ./qa-reports'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ search, status, limit, offset, createdBy, updatedBy, storyId, moduleId, obsolete, filters, output, outDir }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      try {
        const q: TcQuery = {
          ...(search !== undefined ? { search } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(offset !== undefined ? { offset } : {}),
          ...(createdBy !== undefined ? { createdBy } : {}),
          ...(updatedBy !== undefined ? { updatedBy } : {}),
          ...(storyId !== undefined ? { storyId } : {}),
          ...(moduleId !== undefined ? { moduleId } : {}),
          ...(obsolete !== undefined ? { obsolete } : {}),
          ...(filters?.length ? { filters } : {}),
        };
        const appliedFilters = describeTcFilters({ search, status, createdBy, updatedBy, storyId, moduleId, obsolete, filters });
        const paged = limit !== undefined || offset !== undefined;

        // ---- Excel export: ALL matches, regardless of count, no questions asked.
        if (output === 'xlsx' && !paged) {
          const all: Awaited<ReturnType<typeof adapter.listTestCases>> = [];
          for (let off = 0; ; off += TC_EXPORT_PAGE) {
            const page = await adapter.listTestCases({ ...q, limit: TC_EXPORT_PAGE, offset: off });
            all.push(...page);
            const total = totalOf(page);
            if (page.length < TC_EXPORT_PAGE || (total !== undefined && all.length >= total)) break;
            if (all.length >= TC_EXPORT_CAP) {
              return err(`Export stopped: more than ${TC_EXPORT_CAP} test cases match. Nothing was written — narrow the query (module, status, story, search) and try again.`);
            }
          }
          if (!all.length) return ok(`No test cases match (filters: ${appliedFilters}) — no file was written.`, { testCases: [], totalCount: 0 });
          // Priority/status are absent on SimplifyQA test cases; only include the columns the
          // connected product actually returned.
          const hasStatus = all.some((r) => r.status !== undefined);
          const hasPriority = all.some((r) => r.priority !== undefined);
          const hasSteps = all.some((r) => r.stepCount !== undefined);
          const headers = [
            'ID', 'Name', 'Technology', 'Execution type',
            ...(hasStatus ? ['Status'] : []),
            ...(hasPriority ? ['Priority'] : []),
            ...(hasSteps ? ['Steps'] : []),
            'Obsolete',
          ];
          const data = all.map((r) => [
            r.code ?? r.id, r.title, r.technologyType ?? '', r.executionType ?? '',
            ...(hasStatus ? [r.status ?? ''] : []),
            ...(hasPriority ? [r.priority ?? ''] : []),
            ...(hasSteps ? [r.stepCount ?? ''] : []),
            r.obsolete === true ? 'yes' : '',
          ]);
          const { dir, note: outDirNote } = resolveOutDir(outDir, deps.allowOutDir !== false);
          await mkdir(dir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
          const file = join(dir, `test-cases_${stamp}.xlsx`);
          await writeFile(file, buildXlsx('Test cases', headers, data));
          return ok(
            `Exported **${all.length}** test case${all.length === 1 ? '' : 's'} to \`${file}\`.\n` +
              `Columns: ${headers.join(', ')}.\nFilters applied: ${appliedFilters}.\n` +
              'The list carries no parameter values, so nothing protected is included.' +
              (outDirNote ? `\n${outDirNote}` : ''),
            { file, count: all.length, filters: appliedFilters },
          );
        }

        let rows = await adapter.listTestCases(q);
        if (!rows.length) return ok(`No test cases found (filters: ${appliedFilters}).`, { testCases: [], totalCount: totalOf(rows) ?? 0 });

        // ---- Large result: state the count and ASK, instead of dumping everything inline.
        let shownNote = '';
        if (!paged) {
          let total = totalOf(rows);
          if (total === undefined && rows.length >= TC_INLINE_LIMIT) {
            // Backend gave no total: probe one row past the page to know whether more exist.
            const probe = await adapter.listTestCases({ ...q, limit: 1, offset: TC_INLINE_LIMIT });
            total = probe.length ? (totalOf(probe) ?? TC_INLINE_LIMIT + 1) : rows.length;
          }
          const count = total ?? rows.length;
          if (count > TC_INLINE_LIMIT) {
            if (output === 'first100') {
              rows = Object.assign(rows.slice(0, TC_INLINE_LIMIT), { totalCount: count });
              shownNote = `\n\nShowing the first ${TC_INLINE_LIMIT} of ${count} — ${count - TC_INLINE_LIMIT} not displayed.`;
            } else {
              return ok(
                `**${count} test cases** match (filters: ${appliedFilters}) — too many to show in the chat.\n\n` +
                  '**Ask the user how to proceed**, then call `tc_list` again:\n' +
                  "- Download all as Excel → `output: 'xlsx'`\n" +
                  "- Show the first 100 here → `output: 'first100'`\n" +
                  '- Refine the query (module, status, story, search text…) and list again',
                { needs: 'output', totalCount: count, options: ['xlsx', 'first100', 'refine'], filters: appliedFilters },
              );
            }
          }
        }
        const view = rows.map(({ id: _id, priority: _p, ...rest }) => rest);
        const obsoleteCount = rows.filter((r) => r.obsolete === true).length;
        const obsoleteNote = obsoleteCount ? ` · ${obsoleteCount} obsolete` : '';
        // Status and steps are provider-specific; do not print empty columns for SimplifyQA.
        const hasStatus = rows.some((r) => r.status !== undefined);
        const hasSteps = rows.some((r) => r.stepCount !== undefined);
        const header = `| ID | Name | technology | execution |${hasStatus ? ' status |' : ''}${hasSteps ? ' steps |' : ''} obsolete |`;
        const separator = `|---|---|---|---|${hasStatus ? '---|' : ''}${hasSteps ? '---|' : ''}---|`;
        const text =
          `${countHeader(rows, 'test case')}${obsoleteNote} (filters: ${appliedFilters}):\n\n` +
          `${header}\n${separator}\n` +
          rows
            .map((r) => `| ${escCell(r.code)} | ${escCell(r.title)} | ${r.technologyType ?? '-'} | ${r.executionType ?? '-'} |${hasStatus ? ` ${r.status ?? '-'} |` : ''}${hasSteps ? ` ${r.stepCount ?? '-'} |` : ''} ${r.obsolete === true ? 'yes' : ''} |`)
            .join('\n') + shownNote;
        return ok(text, { testCases: view, totalCount: totalOf(rows) ?? rows.length, obsoleteOnPage: obsoleteCount });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'tc_get',
    {
      title: 'Read one test case (with steps)',
      description:
        'Read a single EXISTING test case in full — metadata plus its steps as a readable table — ' +
        'from the connected product. Requires a live connection (qa_connect). `id` accepts the ' +
        "product's id or business key. Product-neutral: same shape on any connected product.\n\n" +
        'VERSIONS: SimplifyQA TCs can have multiple versions, each with its own steps. When the TC ' +
        "has more than one version and `versionId` is omitted, this tool REFUSES and lists the " +
        "available versions — ASK the user which one to read, then call again with `versionId`. " +
        "Pass `versionId: ''` (empty string) to accept the TC's currently-selected version. Single- " +
        'version TCs are read directly. Providers without versioning (Walnut) ignore `versionId`.',
      inputSchema: {
        id: z.string().describe('The test case id (or business key) to read.'),
        versionId: z.string().optional().describe(
          "Version to read (an id from the TC's `versions[]`). Omit to trigger the ASK-user " +
          "prompt when the TC has multiple versions. Pass '' (empty string) to accept the TC's " +
          'currently-selected version without prompting.',
        ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, versionId }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      try {
        // Cheap pre-flight: read the TC without steps so we can inspect versions before deciding
        // whether to prompt. Adapter's getTestCase(id) with no versionId is the natural way, and
        // for SQA the version list is on the TC doc itself so this is one HTTP round-trip that
        // we're going to do anyway.
        const preview = await adapter.getTestCase(id);
        const versions = preview.versions ?? [];
        if (versions.length > 1 && versionId === undefined) {
          const listing = versions
            .map((v) => `  • \`${v.id}\` — **${v.name}**${v.isCurrent ? ' (current)' : ''}${v.reviewApproveStatus ? ` · ${v.reviewApproveStatus}` : ''}`)
            .join('\n');
          return err(
            `Test case ${preview.id ?? id} has ${versions.length} versions — ASK the user which ` +
              `one to read, then call \`tc_get\` again with { id, versionId }. ` +
              `Pass \`versionId: ''\` to accept the current version.\n\n${listing}`,
          );
        }
        // versionId === '' means "explicit current" — pass undefined to the adapter (its default).
        // Otherwise pass through.
        const chosen = versionId === undefined || versionId === '' ? undefined : versionId;
        const tc = chosen ? await adapter.getTestCase(id, chosen) : preview;
        const stepCount = tc.steps.length;
        const versionLine =
          tc.versions?.length
            ? (() => {
                const current = tc.versions!.find((v) => v.isCurrent) ?? tc.versions![tc.versions!.length - 1]!;
                return ` · version: ${current.name}${tc.versions!.length > 1 ? ` (${tc.versions!.length} total)` : ''}`;
              })()
            : '';
        const meta = [
          tc.priority ? `priority: ${tc.priority}` : '',
          tc.status ? `status: ${tc.status}` : '',
          `category: ${tc.category}`,
          `${stepCount} step${stepCount === 1 ? '' : 's'}`,
        ].filter(Boolean).join(' · ');
        const header =
          `**${tc.title}**${tc.id ? ` · ${tc.id}` : ''}\n` +
          `${meta}${versionLine}`;
        return ok(`${header}\n\n${stepsMarkdown(tc)}`, { tc });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'tc_delete',
    {
      title: 'Delete a test case (two-step confirm)',
      description:
        'Soft-delete an existing test case in the connected product. TWO-STEP CONFIRM: call once ' +
        'with just `tcId` to preview the target (title + step count) and get a warning; then call ' +
        'again with `{ tcId, confirm: true }` to actually delete. Refuses to delete without ' +
        "`confirm:true`. `tcId` accepts the product's id or business key. Requires a live " +
        'connection (qa_connect). Product-neutral.',
      inputSchema: {
        tcId: z.string().describe('The test case id (or business key) to delete.'),
        confirm: z.boolean().optional().describe('Set to true on the SECOND call to actually delete.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ tcId, confirm }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!confirm) {
        try {
          // Delete preview: read the current version — no step-collapse hint anymore since
          // the adapter's getTestCase signature dropped that arg in favor of a versionId param.
          const tc = await adapter.getTestCase(tcId);
          const steps = tc.steps.length;
          return ok(
            `⚠️ About to delete test case **${tc.title}**` +
              `${tc.id ? ` (${tc.id})` : ''} — ${steps} step${steps === 1 ? '' : 's'}. ` +
              `To proceed, call again with { tcId: "${tcId}", confirm: true }.`,
            { preview: true, tc },
          );
        } catch (e) {
          return err(describeError(e));
        }
      }
      try {
        await adapter.deleteTestCase(tcId);
        return ok(`Deleted ${tcId}.`);
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'tc_clone',
    {
      title: 'Save a test case as a new test case (same project + module)',
      description:
        'FOR TEST CASES ONLY. NOT for reusable functions: if the user names an `FN_*` key or asks to ' +
        'clone a function, use `fn_clone` instead. Trigger words for THIS tool: "test case", "TC", ' +
        '"TC_", "scenario", "script".\n\n' +
        'Save an existing test case as a NEW test case (new TC id) in the SAME project + module. ' +
        'Mirrors the FE in-editor "Save as new TC" dialog (operation: SAVEASNEWTC). Clones ONE ' +
        'source version — pass `sourceVersionId` to pick which; defaults to the TC\'s currently ' +
        'selected version. `tcId` accepts the numeric id or business key (`TC_*`).\n\n' +
        '`newName` is REQUIRED — backend rejects an empty name on SAVEASNEWTC.\n\n' +
        'TESTDATA — TWO-STEP: call once WITHOUT `tdCopy` to get the "Copy Test Data" prompt and ' +
        'confirm with the user; then call again with `tdCopy` set. Mirrors the FE\'s "COPY TEST ' +
        'DATA" modal (Cancel = false, Confirm = true). The tool REFUSES to clone until `tdCopy` ' +
        'is passed — the prompt step is not skippable.\n\n' +
        '`tdCopy:true` clones the source version\'s testdata iterations across every environment. ' +
        '`tdCopy:false` copies only the column STRUCTURE — one empty iteration (`ITR-1`) per ' +
        'environment; cells fall back to each parameter\'s project-level `defaultValue` if any.\n\n' +
        'Requires a live connection.',
      inputSchema: {
        tcId: z.string().describe('The source test case id or business key (e.g. TC_123).'),
        newName: z.string().min(1).describe('Name for the new test case (required by backend).'),
        tdCopy: z.boolean().optional().describe('REQUIRED to actually clone. Whether to clone the source version\'s testdata iterations. Omit on the first call to get the confirmation prompt; ask the user, then call again with the chosen value.'),
        sourceVersionId: z.string().optional().describe('Which version of the source TC to clone; defaults to the TC\'s current version.'),
        sourceVersionName: z.string().optional().describe('Version to use, by NAME/number as the user says it (e.g. "v2", "2"). Preferred over sourceVersionId — the user should never need an id. If the source has several versions and this is omitted, the tool lists them and asks.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ tcId, newName, tdCopy, sourceVersionId , sourceVersionName}) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.cloneTestCase) return err('This product does not support save-as-new-testcase.');
      const picked = await pickSourceVersion(adapter, 'TC', tcId, sourceVersionName ?? sourceVersionId);
      if (picked.message) return ok(picked.message, { needs: 'sourceVersionName' });
      if (picked.version) sourceVersionId = picked.version.id;
      const srcNote = picked.version ? ` Source version: **${picked.version.name}**.` : '';
      // Prompt step: no `tdCopy` → hand back the "Copy Test Data" question.
      if (tdCopy === undefined) {
        return ok(
          `**COPY TEST DATA** — Do you want to copy test data to new test case **${newName}** (from ${tcId})?\n\n` +
            `If you do not want to copy the test data, only the column structure will be carried over (one empty ITR-1 per environment).\n\n` +
            `**Ask the user**, then call \`tc_clone\` again:\n` +
            `- \`tdCopy: true\` → copy iterations across all environments (Confirm)\n` +
            `- \`tdCopy: false\` → structure only, empty values (Cancel)`,
          { preview: true, needs: 'tdCopy' },
        );
      }
      try {
        const ref = await adapter.cloneTestCase(tcId, newName, {
          tdCopy,
          ...(sourceVersionId !== undefined ? { sourceVersionId } : {}),
        });
        const tdNote = tdCopy
          ? ' Testdata iterations were copied across environments.'
          : ' Testdata structure was carried over but values are empty (tdCopy:false).';
        return ok(
          `Cloned ${tcId} → **${newName}**. New id: **${ref.id}**` +
            srcNote +
            (ref.productUrl ? ` · ${ref.productUrl}` : '') +
            `.${tdNote}`,
          { savedRef: ref },
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'tc_save_as_new_version',
    {
      title: 'Snapshot a test case as a new version',
      description:
        'FOR TEST CASES ONLY. NOT for reusable functions: if the user names an `FN_*` key or asks to ' +
        'snapshot / create a new version of a function, use `fn_save_as_new_version` instead. ' +
        'Trigger words for THIS tool: "test case", "TC", "TC_", "scenario", "script".\n\n' +
        'Freeze the CURRENT server state of a test case under a NEW version name — same TC id, a ' +
        'new version row with cloned steps. Mirrors the SimplifyQA UI "Save as new version" dialog ' +
        '(operation: SAVENEWVERSION). `tcId` accepts the numeric id or business key (`TC_*`).\n\n' +
        '`versionName` must be unique for this TC — the backend rejects duplicates.\n\n' +
        'TESTDATA — TWO-STEP: call once WITHOUT `tdCopy` to get the "Copy Test Data" prompt and ' +
        'confirm with the user; then call again with `tdCopy` set. Mirrors the FE\'s "COPY TEST ' +
        'DATA" modal (Cancel = false, Confirm = true). The tool REFUSES to snapshot until `tdCopy` ' +
        'is passed — the prompt step is not skippable.\n\n' +
        '`tdCopy:true` clones the source version\'s testdata iterations across every environment. ' +
        '`tdCopy:false` copies only the column STRUCTURE — one empty iteration (`ITR-1`) per ' +
        'environment; cells fall back to each parameter\'s project-level `defaultValue` if any.\n\n' +
        '`sourceVersionId` picks which version to snapshot; omit to snapshot the TC\'s currently ' +
        'selected version. Requires a live connection.',
      inputSchema: {
        tcId: z.string().describe('The test case id or business key (e.g. TC_123).'),
        versionName: z.string().min(1).optional().describe(
          'Name for the new version. OMIT to auto-increment (v1.0 → v2.0 → v3.0 …) from the versions ' +
            'already on the TC — the normal path for an update. If given it must be unique for this TC.',
        ),
        tdCopy: z.boolean().optional().describe('REQUIRED to actually snapshot. Clone testdata iterations from the source version. Omit on the first call to get the confirmation prompt; ask the user, then call again with the chosen value.'),
        sourceVersionId: z.string().optional().describe('Version to snapshot; defaults to the TC\'s current version.'),
        fromDraftId: z.string().optional().describe(
          'Freeze THIS edited draft as the new version instead of the stored state — the "update + save ' +
            'as new version" path. Load it first with tc_draft_from_tc({tcId}) (+ tc_draft_update), then ' +
            'pass its draftId here. Without it the tool clones the CURRENT server state (pure snapshot).',
        ),
        sourceVersionName: z.string().optional().describe('Version to use, by NAME/number as the user says it (e.g. "v2", "2"). Preferred over sourceVersionId — the user should never need an id. If the source has several versions and this is omitted, the tool lists them and asks.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ tcId, versionName, tdCopy, sourceVersionId , sourceVersionName, fromDraftId}) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.saveAsNewVersion) return err('This product does not support save-as-new-version.');
      // Resolve the edited draft FIRST: the version name auto-increment and the "copy test data"
      // prompt are both phrased against the content that is about to be frozen.
      let draftTc: TestCase | undefined;
      if (fromDraftId) {
        const draft = deps.getDraft?.(fromDraftId);
        if (!draft) return err(`Draft "${fromDraftId}" not found — load it with tc_draft_from_tc({ tcId }) first.`);
        draftTc = draft.tc;
        // The draft must be THIS test case, else the "new version" would carry another TC's steps.
        if (draftTc.id && draftTc.id !== tcId) {
          return err(`Draft "${fromDraftId}" is for ${draftTc.id}, not ${tcId}. Re-open it with tc_draft_from_tc({ tcId: "${tcId}" }).`);
        }
      }
      // Auto-increment v1.0 → v2.0 → v3.0 unless the caller named the version.
      if (!versionName) {
        try {
          const tcForVersions = draftTc ?? (await adapter.getTestCase(tcId));
          versionName = nextVersionName(tcForVersions);
        } catch (e) {
          return err(`Could not read ${tcId} to choose the next version name: ${describeError(e)}. Pass versionName explicitly.`);
        }
      }
      const picked = await pickSourceVersion(adapter, 'TC', tcId, sourceVersionName ?? sourceVersionId);
      if (picked.message) return ok(picked.message, { needs: 'sourceVersionName' });
      if (picked.version) sourceVersionId = picked.version.id;
      const srcNote = picked.version ? ` Source version: **${picked.version.name}**.` : '';
      // Prompt step: no `tdCopy` → hand back the "Copy Test Data" question so the caller can
      // confirm with the user before writing. Mirrors the FE's COPY TEST DATA modal.
      if (tdCopy === undefined) {
        return ok(
          `**COPY TEST DATA** — Do you want to copy test data to new version **${versionName}** of ${tcId}?\n\n` +
            `If you do not want to copy the test data, only the column structure will be carried over (one empty ITR-1 per environment).\n\n` +
            `**Ask the user**, then call \`tc_save_as_new_version\` again:\n` +
            `- \`tdCopy: true\` → copy iterations across all environments (Confirm)\n` +
            `- \`tdCopy: false\` → structure only, empty values (Cancel)`,
          { preview: true, needs: 'tdCopy' },
        );
      }
      try {
        const ref = await adapter.saveAsNewVersion(tcId, {
          versionName: versionName!,
          tdCopy,
          // A draft loaded from the TC remembers which version it came from — pin it so tdCopy clones
          // THAT version's iterations instead of the adapter having to re-resolve (or finding none).
          ...(sourceVersionId !== undefined
            ? { sourceVersionId }
            : draftTc?.currentVersionId
              ? { sourceVersionId: draftTc.currentVersionId }
              : {}),
          ...(draftTc ? { tc: draftTc } : {}),
        });
        const tdNote = tdCopy
          ? ' Testdata iterations were copied across environments.'
          : ' Testdata structure was carried over but values are empty (tdCopy:false).';
        return ok(
          `Snapshotted ${tcId} as new version **${versionName}**` +
            srcNote +
            (ref.productUrl ? ` · ${ref.productUrl}` : '') +
            `.${tdNote}`,
          { savedRef: ref },
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'tc_steps_to_function',
    {
      title: 'Extract selected steps of a test case into a new reusable function',
      description:
        'Take a subset of the steps on an EXISTING test case and save them as a new reusable ' +
        'function (SimplifyQA STEPSTOFN operation). Mirrors the FE "Save as function" modal. ' +
        'Steps are picked by their current `seq`, resequenced 1..N in the new function, and filed ' +
        'under `moduleId`. `tcId` accepts the numeric id or business key (TC_123). Requires a live ' +
        'connection (qa_connect).\n\n' +
        'CALL THIS when the user says things like "save these steps as a function", "convert the ' +
        'first N steps to a function", "extract these steps into a function". Show the steps of the ' +
        'TC first (via tc_get) so the user can confirm which `seq`s to extract, and ASK the user ' +
        'which module to file the new function under — call `list_modules` if the module id is not ' +
        'known.\n\n' +
        'VERSIONS: SimplifyQA TCs can have multiple versions with DIFFERENT step counts/content. ' +
        "When the TC has more than one version and `versionId` is omitted, this tool REFUSES and " +
        "lists the available versions — ASK the user which version's steps to convert, read that " +
        "version's steps with tc_get({ id, versionId }) to confirm the `seq`s, then call this tool " +
        "again with the SAME `versionId`. Pass `versionId: ''` to accept the TC's currently-selected " +
        'version without prompting. Single-version TCs are used directly.\n\n' +
        '`executionType` forces every picked step into the AUTOMATION or MANUAL bucket; omit to ' +
        'split by each step\'s own executionType (function will be DUO if both are present).\n\n' +
        'TESTDATA: iterations from the source TC version are copied to the new function by default. ' +
        'The backend prunes them to only the parameters the extracted steps reference (via key-based ' +
        'matching in tcfn.service.js `compareDatas` `isStepsToFn` mode), across every environment ' +
        'the source version has. Pass `copyTestData: false` if you explicitly want a bare function.\n\n' +
        'REPLACE-IN-SOURCE: pass `replaceInSource: true` to also splice a FUNCTION + FUNCTION_END ' +
        'pair back into the source TC in place of the extracted steps (mirrors the FE "Save & Replace" ' +
        'button). The extracted rows are soft-deleted; the backend automatically drops any testdata ' +
        'columns those steps owned and injects an FN cell (with the FN\'s per-env default iteration) ' +
        'into every TC iteration row. Requires a contiguous `stepSeqs` range and refuses picks that ' +
        'cross control-flow (IF/WHILE/FOR/DO) or nested FUNCTION brackets, and DUO/SYNCON TCs — those ' +
        'are v2 cases.\n\n' +
        'FAILURE MODE with replaceInSource: if the FN is created but the follow-up PUT fails, the ' +
        'error surfaces the new fn id + version id so you can retry or delete the phantom function.',
      inputSchema: {
        tcId: z.string().describe('The source test case id or business key (e.g. TC_123).'),
        stepSeqs: z.array(z.number().int().positive()).min(1)
          .describe('Current `seq` numbers of the steps to extract (e.g. [1,2,3,4] for the first four). Must be contiguous when replaceInSource is true.'),
        name: z.string().min(1).describe('Name for the new function.'),
        moduleId: z.number().int().positive()
          .describe('Module id to file the new function under. Resolve via list_modules if unknown.'),
        executionType: z.enum(['AUTOMATION', 'MANUAL']).optional()
          .describe('Force all picked steps into this bucket; omit to split by each step\'s own executionType.'),
        copyTestData: z.boolean().optional()
          .describe('Copy the source version\'s testdata iterations to the new function (backend prunes to only the params the extracted steps use). Default: true.'),
        replaceInSource: z.boolean().optional()
          .describe('Replace the extracted steps on the source TC with a FUNCTION + FUNCTION_END call to the new function. Default: false (create-only). Requires contiguous stepSeqs and refuses DUO/SYNCON/control-flow spans.'),
        versionId: z.string().optional().describe(
          "Version to extract steps FROM — an id from the TC's `versions[]`, from a real tc_get " +
          'read the user directed. REQUIRED whenever the TC has more than one version (this tool ' +
          "refuses when it's omitted OR empty in that case) — there is no shortcut for \"current\" " +
          'on a multi-version TC; the user must name a version. Omit only for a genuinely single-' +
          'version TC.',
        ),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ tcId, stepSeqs, name, moduleId, executionType, copyTestData, replaceInSource, versionId }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.saveStepsAsFunction) {
        return err('This product does not support extracting steps to a function.');
      }

      // Same ASK-when-ambiguous rule as tc_get, but STRICTER: unlike tc_get's read-only ''-means-
      // "accept current" shortcut, this is a WRITE action, so an empty versionId is treated the
      // SAME as omitted — there is no silent "current version" default here. This closes a real
      // loophole where a model satisfied the "versionId required" check by passing '' instead of
      // actually asking the user, then fabricated a justification for skipping the question.
      if ((versionId === undefined || versionId === '') && adapter.getTestCase) {
        try {
          const preview = await adapter.getTestCase(tcId);
          const versions = preview.versions ?? [];
          if (versions.length > 1) {
            const listing = versions
              .map((v) => `  • \`${v.id}\` — **${v.name}**${v.isCurrent ? ' (current)' : ''}`)
              .join('\n');
            return err(
              `Test case ${preview.id ?? tcId} has ${versions.length} versions — STOP. Do NOT pick ` +
                `one yourself (not "current", not the one you last read with tc_get, not a "sensible ` +
                `default") — ASK the user which version's steps to convert and WAIT for their ` +
                `explicit reply, even if you already showed them this version list earlier in the ` +
                `conversation. There is no '' / "current" shortcut for this tool — a real version id ` +
                `named by the user is required. Once they answer, read that version's steps with ` +
                `tc_get({ id: "${tcId}", versionId }) to confirm the seqs, then call ` +
                `tc_steps_to_function again with that SAME versionId.\n\n${listing}`,
            );
          }
        } catch (e) {
          return err(describeError(e));
        }
      }
      const chosenVersionId = versionId === undefined || versionId === '' ? undefined : versionId;

      const tdCopy = copyTestData ?? true;
      const tdNote = tdCopy
        ? ' Testdata iterations were copied (pruned to the extracted steps\' parameters).'
        : ' No testdata was copied.';

      if (replaceInSource) {
        if (!adapter.extractStepsAsFunctionAndReplace) {
          return err('This product does not support replace-in-source for step-to-function extraction.');
        }
        try {
          const ref = await adapter.extractStepsAsFunctionAndReplace(tcId, {
            stepSeqs, name, moduleId, copyTestData: tdCopy,
            ...(executionType !== undefined ? { executionType } : {}),
            ...(chosenVersionId !== undefined ? { versionId: chosenVersionId } : {}),
          });
          return ok(
            `Created function **${name}** (id: ${ref.fnId}, version: ${ref.fnVersionId}) and replaced ` +
            `steps [${stepSeqs.join(', ')}] on ${tcId} with a FUNCTION call.${tdNote}`,
            { savedRef: ref },
          );
        } catch (e) {
          return err(describeError(e));
        }
      }

      try {
        const ref = await adapter.saveStepsAsFunction(tcId, {
          stepSeqs, name, moduleId, copyTestData: tdCopy,
          ...(executionType !== undefined ? { executionType } : {}),
          ...(chosenVersionId !== undefined ? { versionId: chosenVersionId } : {}),
        });
        return ok(
          `Created function **${name}** (id: ${ref.id}) from ${tcId} steps [${stepSeqs.join(', ')}].${tdNote}`,
          { savedRef: ref },
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'story_list',
    {
      title: 'List / search user stories',
      description:
        'Pull up USER STORIES in the connected project — id, key (US_…), title, status. Give `search` to ' +
        'find stories by keyword (matches key / title / description / acceptance criteria). Use story_get ' +
        'to read one with its acceptance criteria, then draft manual test cases for it. Requires a live ' +
        'connection (qa_connect). Read-only and product-neutral.',
      inputSchema: {
        search: z.string().optional().describe('Keyword to find stories (key / title / description / AC).'),
        status: z.string().optional(),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
        sprintId: z.string().optional().describe('Only stories that belong to this sprint (from list_sprints).'),
        releaseId: z.string().optional().describe('Only stories that belong to this release (from list_releases).'),
        createdBy: z.string().optional().describe('Numeric userId of the creator. Pass "me" to filter by the current caller (needs QA_MCP_USER_ID for API-key auth). Resolve names to ids via list_users first.'),
        updatedBy: z.string().optional().describe('Numeric userId of the last updater. Pass "me" for the current caller. Resolve names via list_users first.'),
        ownerId: z.string().optional().describe('Numeric userId of the story OWNER (assignee). Pass "me" for the current caller. Resolve names via list_users first.'),
        filters: z.array(zRawFilter).optional().describe('Extra raw column filters for project-configured columns with no dedicated parameter above (Feature/Epic/Priority/custom fields) — use the field\'s backend key as `column`.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ search, status, limit, offset, sprintId, releaseId, createdBy, updatedBy, ownerId, filters }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.listStories) return err('This product does not expose a user-story backlog.');
      try {
        const rows = await adapter.listStories({
          ...(search ? { search } : {}),
          ...(status ? { status } : {}),
          ...(limit != null ? { limit } : {}),
          ...(offset != null ? { offset } : {}),
          ...(sprintId ? { sprintId } : {}),
          ...(releaseId ? { releaseId } : {}),
          ...(createdBy ? { createdBy } : {}),
          ...(updatedBy ? { updatedBy } : {}),
          ...(ownerId ? { ownerId } : {}),
          ...(filters?.length ? { filters } : {}),
        });
        if (!rows.length) return ok('No user stories found.', { stories: [], totalCount: totalOf(rows) ?? 0 });
        const view = rows.map(({ id: _id, ...rest }) => rest);
        const text =
          `${countHeader(rows, 'story', 'stories')}:\n\n` +
          '| key | title | status |\n|---|---|---|\n' +
          rows.map((s) => `| ${escCell(s.key ?? s.id)} | ${escCell(s.title)} | ${escCell(s.status ?? '-')} |`).join('\n');
        return ok(text, { stories: view, totalCount: totalOf(rows) ?? rows.length });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'story_get',
    {
      title: 'Read one user story (with acceptance criteria)',
      description:
        'Read a single user story — title, description, and ACCEPTANCE CRITERIA — from the connected ' +
        'product. `id` accepts the story id or its business key (US_123). Read this before drafting manual ' +
        'test cases so they cover the acceptance criteria. Requires a live connection.',
      inputSchema: { id: z.string().describe('Story id or business key (US_123).') },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.getStory) return err('This product does not expose a user-story backlog.');
      try {
        const story = await adapter.getStory(id);
        const ac = story.acceptanceCriteria ?? [];
        const header = `**${story.title}**${story.key ? ` · ${story.key}` : ''}${story.status ? ` · ${story.status}` : ''}`;
        const desc = story.description ? `\n\n${story.description}` : '';
        const acBlock = ac.length
          ? `\n\n**Acceptance criteria (${ac.length}):**\n` + ac.map((c, i) => `${i + 1}. ${c}`).join('\n')
          : '\n\n_No acceptance criteria on this story._';
        return ok(`${header}${desc}${acBlock}`, { story });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'list_releases',
    {
      title: 'List releases (project-scoped or all)',
      description:
        'List RELEASES in SimplifyQA — id, name, state, planned dates. `scope` is required: ' +
        '"project" = releases attached to the currently connected project, "all" = every release the ' +
        'token can see. ASK the user which scope before calling — do not guess. Requires a live ' +
        'connection (qa_connect). Read-only.',
      inputSchema: {
        scope: z.enum(['project', 'all']).describe(
          'ASK the user first: "project" = current project only, "all" = every release visible to the token.',
        ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ scope }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.listReleases) return err('This product has no release/sprint model.');
      try {
        const rows = await adapter.listReleases({ scope });
        if (!rows.length) return ok(`No releases found (scope: ${scope}).`, { releases: [], totalCount: totalOf(rows) ?? 0 });
        const text =
          `${countHeader(rows, 'release')} (scope: ${scope}):\n\n` +
          '| id | name | state | planned start | planned end |\n|---|---|---|---|---|\n' +
          rows
            .map((r) => `| ${escCell(r.id)} | ${escCell(r.name)} | ${escCell(r.state ?? '-')} | ${escCell(r.plannedStartDate ?? '-')} | ${escCell(r.plannedEndDate ?? '-')} |`)
            .join('\n');
        return ok(text, { releases: rows, totalCount: totalOf(rows) ?? rows.length });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'list_sprints',
    {
      title: 'List sprints (optionally within a release)',
      description:
        'List SPRINTS in SimplifyQA — id, name, parent release, state, planned dates. Pass ' +
        '`releaseId` (from list_releases) to see sprints of one release; omit to see every sprint the ' +
        'token can see. To answer "how many stories in this sprint", follow up with ' +
        'story_list({ sprintId }). Requires a live connection. Read-only.',
      inputSchema: {
        releaseId: z.string().optional().describe('Only sprints belonging to this release (from list_releases).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ releaseId }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.listSprints) return err('This product has no release/sprint model.');
      try {
        const rows = await adapter.listSprints(releaseId !== undefined ? { releaseId } : {});
        if (!rows.length) return ok('No sprints found.', { sprints: [], totalCount: totalOf(rows) ?? 0 });
        const text =
          `${countHeader(rows, 'sprint')}${releaseId ? ` (release ${releaseId})` : ''}:\n\n` +
          '| id | name | release | state | planned start | planned end |\n|---|---|---|---|---|---|\n' +
          rows
            .map((s) => `| ${escCell(s.id)} | ${escCell(s.name)} | ${escCell(s.releaseId ?? '-')} | ${escCell(s.state ?? '-')} | ${escCell(s.plannedStartDate ?? '-')} | ${escCell(s.plannedEndDate ?? '-')} |`)
            .join('\n');
        return ok(text, { sprints: rows, totalCount: totalOf(rows) ?? rows.length });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'list_functions',
    {
      title: 'List / search reusable functions (NOT test cases)',
      description:
        'List reusable FUNCTIONS in the connected project — the FN_* library of building blocks that ' +
        'test cases call as nested steps. NOT test cases: if the user asks for test cases, TCs, ' +
        'scenarios, or scripts, use `tc_list` instead. Trigger words for THIS tool: "functions", ' +
        '"reusable functions", "function library", "FN_", "shared steps", "building blocks". Returns ' +
        'id, key (FN_*), name, description, technology (WEB/API/ANDROID/IOS), execution type ' +
        '(MANUAL/AUTOMATION), review status, step count. Use `get_function` to read one in full ' +
        '(with its steps) and `delete_function` to soft-delete. SimplifyQA-only. Requires a live ' +
        'connection (qa_connect). Read-only.',
      inputSchema: {
        search: z.string().optional().describe('Free-text search over the function name.'),
        fnType: z.string().optional().describe('Filter by technology (WEB / API / ANDROID / IOS).'),
        executionType: z.string().optional().describe('Filter by execution type (MANUAL / AUTOMATION).'),
        moduleId: z.string().optional().describe('Only functions filed under this module (id or business key, e.g. MO_12).'),
        createdBy: z.string().optional().describe('Numeric userId of the creator. Pass "me" to filter by the current caller (needs QA_MCP_USER_ID for API-key auth). Resolve names to ids via list_users first.'),
        updatedBy: z.string().optional().describe('Numeric userId of the last updater. Pass "me" for the current caller. Resolve names via list_users first.'),
        limit: z.number().int().positive().optional().describe('Max results (paging).'),
        offset: z.number().int().nonnegative().optional().describe('Result offset (paging).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ search, fnType, executionType, moduleId, createdBy, updatedBy, limit, offset }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.listFunctions) return err('This product has no reusable-function library.');
      try {
        const rows = await adapter.listFunctions({
          ...(search !== undefined ? { search } : {}),
          ...(fnType !== undefined ? { fnType } : {}),
          ...(executionType !== undefined ? { executionType } : {}),
          ...(moduleId !== undefined ? { moduleId } : {}),
          ...(createdBy !== undefined ? { createdBy } : {}),
          ...(updatedBy !== undefined ? { updatedBy } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(offset !== undefined ? { offset } : {}),
        });
        if (!rows.length) return ok('No functions found.', { functions: [], totalCount: totalOf(rows) ?? 0 });
        const view = rows.map(({ id: _id, ...rest }) => rest);
        const text =
          `${countHeader(rows, 'function')}:\n\n` +
          '| key | name | technology | execution | status | steps |\n|---|---|---|---|---|---|\n' +
          rows
            .map((f) => `| ${escCell(f.code)} | ${escCell(f.name)} | ${f.fnType ?? '-'} | ${f.executionType ?? '-'} | ${f.status ?? '-'} | ${f.stepCount ?? '-'} |`)
            .join('\n');
        return ok(text, { functions: view, totalCount: totalOf(rows) ?? rows.length });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'get_function',
    {
      title: 'Read / explain one reusable function (NOT a test case)',
      description:
        'Read a single reusable FUNCTION in full — metadata, description, and steps as a readable ' +
        "table — from the connected product. `id` accepts the function's numeric id or its business key " +
        '(e.g. FN_123). NOT for test cases: if the user asks to read / explain a TC or TC_* id, use ' +
        '`tc_get` instead. Trigger words for THIS tool: "function", "FN_", "reusable function", ' +
        '"explain this function". Use this to explain what a function does before calling it from a ' +
        'test case or before deleting it. Requires a live connection (qa_connect).',
      inputSchema: {
        id: z.string().describe('The function id (or business key like FN_123) to read.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.getFunction) return err('This product has no reusable-function library.');
      try {
        const fn = await adapter.getFunction(id);
        const steps = fn.steps.length;
        const versionCount = fn.versions?.length ?? 0;
        const header =
          `**${fn.name}**${fn.code ? ` · ${fn.code}` : fn.id ? ` · ${fn.id}` : ''}\n` +
          `technology: ${fn.fnType ?? '-'} · execution: ${fn.executionType ?? '-'}` +
          `${fn.status ? ` · status: ${fn.status}` : ''} · ${steps} step${steps === 1 ? '' : 's'}` +
          `${versionCount ? ` · ${versionCount} version${versionCount === 1 ? '' : 's'}: ${fn.versions!.map((v) => v.name).join(', ')}` : ''}` +
          `${fn.description ? `\n\n${fn.description}` : ''}`;
        const body = steps
          ? '\n\n| # | type | description |\n|---|---|---|\n' +
            fn.steps
              .map((s) => `| ${s.n} | ${escCell(s.stepType)}${s.controlFlow ? `/${s.controlFlow.kind}` : ''} | ${escCell(s.description)} |`)
              .join('\n')
          : '\n\n_(no steps)_';
        const versionsBlock = versionCount
          ? '\n\n**Versions** (newest first):\n\n| name | id | current | execution | review |\n|---|---|---|---|---|\n' +
            fn.versions!
              .map((v) => `| ${escCell(v.name)} | \`${v.id}\` | ${v.isCurrent ? '✓' : ''} | ${v.executionType ?? '-'} | ${v.reviewApproveStatus ?? '-'} |`)
              .join('\n')
          : '';
        return ok(`${header}${body}${versionsBlock}`, { function: fn });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'delete_function',
    {
      title: 'Delete a reusable function (NOT a test case; two-step confirm)',
      description:
        'Soft-delete a reusable FUNCTION in the connected product. NOT for test cases: if the user ' +
        'asks to delete a TC or TC_* id, use `tc_delete` instead. Trigger words for THIS tool: ' +
        '"function", "FN_", "reusable function". TWO-STEP CONFIRM: call once with just `id` to preview ' +
        'the target (name + step count) and get a warning; then call again with `{ id, confirm: true }` ' +
        "to actually delete. Refuses to delete without `confirm:true`. `id` accepts the function's " +
        'numeric id or business key. The backend refuses to delete a function that is still referenced ' +
        'by a test case, another function, or a workflow — this tool surfaces those references so the ' +
        'user can remove them first.',
      inputSchema: {
        id: z.string().describe('The function id (or business key like FN_123) to delete.'),
        confirm: z.boolean().optional().describe('Set to true on the SECOND call to actually delete.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ id, confirm }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.getFunction || !adapter.deleteFunction) {
        return err('This product has no reusable-function library.');
      }
      if (!confirm) {
        try {
          const fn = await adapter.getFunction(id);
          return ok(
            `⚠️ About to delete function **${fn.name}**` +
              `${fn.code ? ` (${fn.code})` : ''} — ${fn.steps.length} step${fn.steps.length === 1 ? '' : 's'}. ` +
              `To proceed, call again with { id: "${id}", confirm: true }. Deletion will be refused if ` +
              'the function is still referenced by a test case, another function, or a workflow.',
            { preview: true, function: fn },
          );
        } catch (e) {
          return err(describeError(e));
        }
      }
      try {
        await adapter.deleteFunction(id);
        return ok(`Deleted function ${id}.`);
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'fn_clone',
    {
      title: 'Save a reusable function as a new function (same project + module)',
      description:
        'FOR REUSABLE FUNCTIONS ONLY. NOT for test cases: if the user names a `TC_*` key or asks to ' +
        'clone a test case / scenario / script, use `tc_clone` instead. Trigger words for THIS tool: ' +
        '"function", "reusable function", "FN_", "FN-".\n\n' +
        'Save an existing reusable FUNCTION as a NEW function (new FN id) in the SAME project + ' +
        'module. Mirrors the FE in-editor "Save as new function" dialog (operation: SAVEASNEWFN). ' +
        'Clones ONE source version — pass `sourceVersionId` to pick which; defaults to the FN\'s ' +
        'newest version. `fnId` accepts the numeric id or business key (`FN_*`).\n\n' +
        '`newName` is REQUIRED — backend rejects an empty name on SAVEASNEWFN.\n\n' +
        'TESTDATA — TWO-STEP: call once WITHOUT `tdCopy` to get the "Copy Test Data" prompt and ' +
        'confirm with the user; then call again with `tdCopy` set. Mirrors the FE\'s "COPY TEST ' +
        'DATA" modal (Cancel = false, Confirm = true). The tool REFUSES to clone until `tdCopy` ' +
        'is passed — the prompt step is not skippable.\n\n' +
        '`tdCopy:true` clones the source version\'s testdata iterations across every environment. ' +
        '`tdCopy:false` copies only the column STRUCTURE — one empty iteration (`ITR-1`) per ' +
        'environment; cells fall back to each parameter\'s project-level `defaultValue` if any.\n\n' +
        'Requires a live connection.',
      inputSchema: {
        fnId: z.string().describe('The source function id or business key (e.g. FN_123).'),
        newName: z.string().min(1).describe('Name for the new function (required by backend).'),
        tdCopy: z.boolean().optional().describe('REQUIRED to actually clone. Whether to clone the source version\'s testdata iterations. Omit on the first call to get the confirmation prompt; ask the user, then call again with the chosen value.'),
        sourceVersionId: z.string().optional().describe('Which version of the source FN to clone; defaults to the FN\'s newest version.'),
        sourceVersionName: z.string().optional().describe('Version to use, by NAME/number as the user says it (e.g. "v2", "2"). Preferred over sourceVersionId — the user should never need an id. If the source has several versions and this is omitted, the tool lists them and asks.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ fnId, newName, tdCopy, sourceVersionId , sourceVersionName}) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.cloneFunction) return err('This product does not support save-as-new-function.');
      const picked = await pickSourceVersion(adapter, 'FN', fnId, sourceVersionName ?? sourceVersionId);
      if (picked.message) return ok(picked.message, { needs: 'sourceVersionName' });
      if (picked.version) sourceVersionId = picked.version.id;
      const srcNote = picked.version ? ` Source version: **${picked.version.name}**.` : '';
      // Prompt step: no `tdCopy` → hand back the "Copy Test Data" question.
      if (tdCopy === undefined) {
        return ok(
          `**COPY TEST DATA** — Do you want to copy test data to new function **${newName}** (from ${fnId})?\n\n` +
            `If you do not want to copy the test data, only the column structure will be carried over (one empty ITR-1 per environment).\n\n` +
            `**Ask the user**, then call \`fn_clone\` again:\n` +
            `- \`tdCopy: true\` → copy iterations across all environments (Confirm)\n` +
            `- \`tdCopy: false\` → structure only, empty values (Cancel)`,
          { preview: true, needs: 'tdCopy' },
        );
      }
      try {
        const ref = await adapter.cloneFunction(fnId, newName, {
          tdCopy,
          ...(sourceVersionId !== undefined ? { sourceVersionId } : {}),
        });
        const tdNote = tdCopy
          ? ' Testdata iterations were copied across environments.'
          : ' Testdata structure was carried over but values are empty (tdCopy:false).';
        return ok(
          `Cloned ${fnId} → **${newName}**. New id: **${ref.id}**` +
            srcNote +
            (ref.productUrl ? ` · ${ref.productUrl}` : '') +
            `.${tdNote}`,
          { savedRef: ref },
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'fn_save_as_new_version',
    {
      title: 'Snapshot a reusable function as a new version',
      description:
        'FOR REUSABLE FUNCTIONS ONLY. NOT for test cases: if the user names a `TC_*` key or asks to ' +
        'snapshot / create a new version of a test case, use `tc_save_as_new_version` instead. ' +
        'Trigger words for THIS tool: "function", "reusable function", "FN_", "FN-".\n\n' +
        'Freeze the CURRENT server state of a reusable FUNCTION under a NEW version name — same FN id, a ' +
        'new version row with cloned steps. Mirrors the SimplifyQA UI "Save as new version" dialog ' +
        '(operation: SAVENEWVERSION, type: FN). `fnId` accepts the numeric id or business key (`FN_*`).\n\n' +
        '`versionName` must be unique for this FN — the backend rejects duplicates.\n\n' +
        'TESTDATA — TWO-STEP: call once WITHOUT `tdCopy` to get the "Copy Test Data" prompt and ' +
        'confirm with the user; then call again with `tdCopy` set. Mirrors the FE\'s "COPY TEST ' +
        'DATA" modal (Cancel = false, Confirm = true). The tool REFUSES to snapshot until `tdCopy` ' +
        'is passed — the prompt step is not skippable.\n\n' +
        '`tdCopy:true` clones the source version\'s testdata iterations across every environment. ' +
        '`tdCopy:false` copies only the column STRUCTURE — one empty iteration (`ITR-1`) per ' +
        'environment; cells fall back to each parameter\'s project-level `defaultValue` if any.\n\n' +
        '`sourceVersionId` picks which version to snapshot; omit to snapshot the FN\'s newest ' +
        'version (the FN doc has no inline current-version marker). Requires a live connection.',
      inputSchema: {
        fnId: z.string().describe('The function id or business key (e.g. FN_123).'),
        versionName: z.string().min(1).describe('Name for the new version (must be unique for this FN).'),
        tdCopy: z.boolean().optional().describe('REQUIRED to actually snapshot. Clone testdata iterations from the source version. Omit on the first call to get the confirmation prompt; ask the user, then call again with the chosen value.'),
        sourceVersionId: z.string().optional().describe('Version to snapshot; defaults to the FN\'s newest version.'),
        sourceVersionName: z.string().optional().describe('Version to use, by NAME/number as the user says it (e.g. "v2", "2"). Preferred over sourceVersionId — the user should never need an id. If the source has several versions and this is omitted, the tool lists them and asks.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ fnId, versionName, tdCopy, sourceVersionId , sourceVersionName}) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.saveAsNewFunctionVersion) return err('This product does not support save-as-new-version for functions.');
      const picked = await pickSourceVersion(adapter, 'FN', fnId, sourceVersionName ?? sourceVersionId);
      if (picked.message) return ok(picked.message, { needs: 'sourceVersionName' });
      if (picked.version) sourceVersionId = picked.version.id;
      const srcNote = picked.version ? ` Source version: **${picked.version.name}**.` : '';
      // Prompt step: no `tdCopy` → hand back the "Copy Test Data" question so the caller can
      // confirm with the user before writing. Mirrors the FE's COPY TEST DATA modal.
      if (tdCopy === undefined) {
        return ok(
          `**COPY TEST DATA** — Do you want to copy test data to new version **${versionName}** of ${fnId}?\n\n` +
            `If you do not want to copy the test data, only the column structure will be carried over (one empty ITR-1 per environment).\n\n` +
            `**Ask the user**, then call \`fn_save_as_new_version\` again:\n` +
            `- \`tdCopy: true\` → copy iterations across all environments (Confirm)\n` +
            `- \`tdCopy: false\` → structure only, empty values (Cancel)`,
          { preview: true, needs: 'tdCopy' },
        );
      }
      try {
        const ref = await adapter.saveAsNewFunctionVersion(fnId, {
          versionName,
          tdCopy,
          ...(sourceVersionId !== undefined ? { sourceVersionId } : {}),
        });
        const tdNote = tdCopy
          ? ' Testdata iterations were copied across environments.'
          : ' Testdata structure was carried over but values are empty (tdCopy:false).';
        return ok(
          `Snapshotted ${fnId} as new version **${versionName}**` +
            srcNote +
            (ref.productUrl ? ` · ${ref.productUrl}` : '') +
            `.${tdNote}`,
          { savedRef: ref },
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'list_modules',
    {
      title: 'List modules / folders (SimplifyQA test-case tree)',
      description:
        'List the MODULES (folder tree) in the connected project — id, name, parent. Use for any ' +
        '"list / show / what modules" request. Also the source of the `folderOrModule` id passed to ' +
        'tc_draft_create (ask the user which one before drafting). SimplifyQA-only: Walnut has no ' +
        'module tree. Requires a live connection.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.listModules) return err('This product has no module tree.');
      try {
        const rows = await adapter.listModules();
        if (!rows.length) return ok('No modules found.', { modules: [], totalCount: totalOf(rows) ?? 0 });
        const text =
          `${countHeader(rows, 'module')}:\n\n` +
          '| id | name | type | parent | childIds |\n|---|---|---|---|---|\n' +
          rows.map((m) => {
            const type = m.isRoot ? 'root' : m.parentId ? 'sub' : '-';
            const children = m.childIds?.length ? m.childIds.join(', ') : '-';
            return `| ${escCell(m.id)} | ${escCell(m.name)} | ${type} | ${escCell(m.parentId ?? '-')} | ${escCell(children)} |`;
          }).join('\n');
        return ok(text, { modules: rows, totalCount: totalOf(rows) ?? rows.length });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'get_module',
    {
      title: 'View module details',
      description:
        'Fetch full detail for one MODULE — id, name, code, description, parentId, childIds. Use ' +
        'when list_modules\' summary row isn\'t enough (need description or child tree). SimplifyQA-only. ' +
        'Requires a live connection.',
      inputSchema: {
        id: z.string().describe('Module id (numeric or business key resolvable via list_modules).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.getModule) return err('This product has no module tree.');
      try {
        const m = await adapter.getModule(id);
        const lines = [
          `**Module ${m.id}** — ${m.name}`,
          m.code ? `Code: ${m.code}` : undefined,
          m.parentId ? `Parent: ${m.parentId}` : 'Parent: (root)',
          m.description ? `Description: ${m.description}` : undefined,
          m.childIds?.length ? `Child module ids: ${m.childIds.join(', ')}` : undefined,
        ].filter(Boolean);
        return ok(lines.join('\n'), { module: m });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  // Recursive `children` schema for a subtree create. Each child inherits parentId from position
  // in the tree — never pass isRoot/parentId on child nodes (backend derives them). z.lazy is the
  // idiomatic zod pattern for a self-referential schema.
  type ModuleChildSchema = { name: string; description?: string | undefined; children?: ModuleChildSchema[] | undefined };
  const zModuleChild: z.ZodType<ModuleChildSchema> = z.lazy(() =>
    z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      children: z.array(zModuleChild).optional(),
    }),
  );

  server.registerTool(
    'create_module',
    {
      title: 'Create a module (folder), optionally with a nested subtree, in the test-case tree',
      description:
        'Create a new MODULE under the connected project. Set `isRoot:true` for a top-level folder; ' +
        'otherwise pass `parentId` (resolve via list_modules). To create a WHOLE HIERARCHY in one call ' +
        '(root + submodules + nested submodules), pass a `children` array — each child gets ' +
        '`isRoot:false` and its parentId auto-wired from the tree position (do NOT set `isRoot`/`parentId` ' +
        'on child nodes). Duplicate name in the same project is rejected server-side. On mid-subtree ' +
        'failure the response carries `failedAt`; every node before it is already persisted (no ' +
        'transactional rollback upstream). SimplifyQA-only. Requires a live connection.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        name: z.string().min(1).describe('Module name. Must be unique within the project.'),
        projectId: z.string().describe('Target project id (see list_projects).'),
        isRoot: z.boolean().describe('True → top-level folder; false → child of `parentId`.'),
        parentId: z.string().optional().describe('Parent module id (required when isRoot is false; MUST be omitted when isRoot is true).'),
        description: z.string().optional().describe('Free-text description.'),
        children: z.array(zModuleChild).optional().describe(
          'Optional subtree under this module. Each child = { name, description?, children? } — no isRoot/parentId (derived).',
        ),
      },
    },
    async ({ name, projectId, isRoot, parentId, description, children }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.createModule) return err('This product has no module tree.');
      if (!isRoot && !parentId) {
        return err('parentId is required when isRoot is false.');
      }
      if (isRoot && parentId) {
        return err('parentId must be omitted when isRoot is true — backend silently drops it and the module would land at root, not under the intended parent.');
      }
      try {
        const saved = await adapter.createModule({
          name,
          projectId,
          isRoot,
          ...(parentId ? { parentId } : {}),
          ...(description ? { description } : {}),
          ...(children?.length ? { children } : {}),
        });
        return ok(formatModuleSaved(saved), { saved });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'update_module',
    {
      title: 'Update a module (rename / edit description / move parent)',
      description:
        'Edit an existing MODULE — pass `id` plus any of `name`, `description`, `parentId`. Name ' +
        'must remain unique within the project (duplicate rejected server-side). Works regardless of ' +
        'whether test cases/functions/etc. are tagged to the module — no need to delete and recreate ' +
        'it to rename or move it. `parentId` moves the module elsewhere in the tree (pass `""` to move ' +
        'it to project root); moving it under itself or under one of its own descendants is refused. ' +
        'SimplifyQA-only. Requires a live connection.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        id: z.string().describe('Module id (numeric or business key, e.g. MO_12).'),
        name: z.string().min(1).optional().describe('New module name.'),
        description: z.string().optional().describe('New description (pass "" to clear).'),
        parentId: z.string().optional().describe(
          'New parent module id (from list_modules). Moves this module in the hierarchy. Pass "" to ' +
          'move it to project root instead of under another module.',
        ),
        projectId: z.string().optional().describe('Project id; defaults to the connected project.'),
      },
    },
    async ({ id, name, description, parentId, projectId }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.updateModule) return err('This product has no module tree.');
      if (name === undefined && description === undefined && parentId === undefined) {
        return err('Nothing to update — pass at least `name`, `description` or `parentId`.');
      }
      if (adapter.getModule) {
        try {
          await adapter.getModule(id);
        } catch {
          let listing = '';
          try {
            const rows = await adapter.listModules?.();
            if (rows?.length) listing = `\n\nAvailable modules:\n${rows.map((m) => `  • \`${m.id}\` — ${m.name}`).join('\n')}`;
          } catch { /* best-effort listing only */ }
          return err(`Module "${id}" not found — nothing was updated.${listing}`);
        }
      }
      try {
        const saved = await adapter.updateModule(id, {
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(parentId !== undefined ? { parentId } : {}),
          ...(projectId ? { projectId } : {}),
        });
        const changed = [
          name !== undefined ? `name → "${name}"` : undefined,
          description !== undefined ? `description → "${description}"` : undefined,
          parentId !== undefined ? `parent → ${parentId === '' ? '(root)' : parentId}` : undefined,
        ].filter(Boolean).join(', ');
        return ok(`Updated module ${saved.id || id}: ${changed}.`, { saved });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'delete_module',
    {
      title: 'Delete modules (with dependency dry-run)',
      description:
        'Delete one or more MODULES by id. Two phases: call with `confirm:false` (default) for a ' +
        'DRY RUN that returns each id\'s dependency footprint (test cases, functions, parameters, ' +
        'objects, defects, user stories that still reference the module). Call again with ' +
        '`confirm:true` to actually delete; the server drops only ids with EMPTY dependencies and ' +
        'silently skips the rest — surface those to the caller so they can move/remove the refs first. ' +
        'SimplifyQA-only. Requires a live connection.',
      inputSchema: {
        ids: z.array(z.string()).min(1).describe('Module ids to delete.'),
        projectId: z.string().describe('Project id the modules belong to.'),
        confirm: z.boolean().optional().describe('False (default) → dry-run; true → apply delete.'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ ids, projectId, confirm }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.deleteModule) return err('This product has no module tree.');
      try {
        const result = await adapter.deleteModule({ ids, projectId, ...(confirm !== undefined ? { confirm } : {}) });
        const blockers = result.dependencies.filter((d) =>
          d.tcArr.length || d.fnArr.length || d.parameterArr.length || d.objArr.length || d.defectArr.length || d.usArr.length,
        );
        if (result.dryRun) {
          if (!blockers.length) {
            return ok(
              `Dry-run: ${ids.length} module(s) have NO dependencies — safe to delete. ` +
                'Call again with confirm:true to apply.',
              { result },
            );
          }
          const text =
            `Dry-run: ${blockers.length} of ${ids.length} module(s) still have references. ` +
            'Deleting with confirm:true will SKIP these ids:\n\n' +
            '| id | test cases | functions | params | objects | defects | user stories |\n' +
            '|---|---|---|---|---|---|---|\n' +
            blockers
              .map(
                (d) =>
                  `| ${d.id} | ${d.tcArr.length} | ${d.fnArr.length} | ${d.parameterArr.length} | ${d.objArr.length} | ${d.defectArr.length} | ${d.usArr.length} |`,
              )
              .join('\n');
          return ok(text, { result });
        }
        if (blockers.length) {
          return ok(
            `Deleted ${ids.length - blockers.length} module(s). ${blockers.length} SKIPPED (still referenced). ` +
              'Move or remove the referring rows, then retry those ids.',
            { result },
          );
        }
        return ok(`Deleted ${ids.length} module(s).`, { result });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'delete_version',
    {
      title: 'Delete a version of a test case or function (two-step confirm)',
      description:
        'Soft-delete ONE version of a test case (`kind:"tc"`) or a reusable function (`kind:"fn"`) ' +
        'in the connected product. `versionId` comes from the parent\'s `versions[]` (populated by ' +
        '`tc_get` for TCs and `get_function` for FNs); pass the version\'s `name` too (backend ' +
        'validator requires it). TWO-STEP CONFIRM: call once with `confirm:false` (default) to get ' +
        'a DRY RUN — the response lists every entity still referencing this version (defects, suites, ' +
        'exec plans, scenarios, schedulers, pipelines, workflows for a TC; TCs, other FNs, workflows ' +
        'for a FN). Only when EVERY dependency map is empty is the delete allowed; the server itself ' +
        "REFUSES a `confirm:true` call when refs still exist, so `confirm:true` doesn't guarantee " +
        'deletion — the tool inspects the response and reports honestly. Refuses to delete the LAST ' +
        'remaining version (the parent would be orphaned; use `tc_delete` / `delete_function` instead ' +
        'to remove the whole entity). SimplifyQA-only. Requires a live connection.',
      inputSchema: {
        kind: z.enum(['tc', 'fn']).describe("'tc' for a test-case version; 'fn' for a function version."),
        parentId: z.string().describe('Parent TC or FN id (numeric or business key like TC_123 / FN_45).'),
        versionId: z.string().describe("The version's uuid (from tc_get.versions[].id or get_function.versions[].id)."),
        versionName: z.string().describe("The version's human name (e.g. 'v1.0'). Required by the backend validator."),
        confirm: z.boolean().optional().describe('False (default) → dry-run; true → apply delete (server still refuses if any dependency exists).'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ kind, parentId, versionId, versionName, confirm }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.deleteVersion) return err('This product has no per-version delete support.');
      // Client-side "last version" guard — mirrors the SQA UI (testcase.component.ts:2126,
      // function.component.ts:1600). Backend cheerfully deletes the sole remaining version and
      // orphans the parent, so we block it here.
      try {
        const parent = kind === 'tc'
          ? await adapter.getTestCase(parentId)
          : adapter.getFunction ? await adapter.getFunction(parentId) : null;
        const versions = parent?.versions ?? [];
        if (versions.length === 0) {
          return err(
            `${kind === 'tc' ? 'Test case' : 'Function'} ${parentId} has no versions to delete.`,
          );
        }
        if (versions.length === 1) {
          return err(
            `${kind === 'tc' ? 'Test case' : 'Function'} ${parentId} has only one version — ` +
              'deleting it would orphan the parent (all steps and testdata go with it). ' +
              `Delete the whole ${kind === 'tc' ? 'test case (tc_delete)' : 'function (delete_function)'} ` +
              'instead, or add another version first.',
          );
        }
        if (!versions.some((v) => v.id === versionId)) {
          const listing = versions.map((v) => `  - ${v.name} \`${v.id}\``).join('\n');
          return err(
            `Version \`${versionId}\` not found on ${parentId}. Known versions:\n${listing}`,
          );
        }
      } catch (e) {
        return err(describeError(e));
      }
      try {
        const result = await adapter.deleteVersion({
          kind,
          parentId,
          versionId,
          versionName,
          ...(confirm !== undefined ? { confirm } : {}),
        });
        if (result.dryRun) {
          if (!result.hasBlockers) {
            return ok(
              `Dry-run: version \`${versionId}\` (${versionName}) has NO dependencies — safe to delete. ` +
                'Call again with confirm:true to apply.',
              { result },
            );
          }
          const rows = result.dependencies.map((d) => renderVersionDepRow(d));
          return ok(
            `Dry-run: version \`${versionId}\` (${versionName}) still has references. ` +
              'Deleting is blocked until the referring rows are moved or removed:\n\n' +
              rows.join('\n'),
            { result },
          );
        }
        if (result.deleted) {
          return ok(
            `Deleted version \`${versionId}\` (${versionName}). Cascade: steps, testdata and ` +
              'testdata iterations for this version were soft-deleted along with it.',
            { result },
          );
        }
        // confirm:true but server returned deps → refused.
        const rows = result.dependencies.map((d) => renderVersionDepRow(d));
        return err(
          `Server REFUSED to delete version \`${versionId}\` — it is still referenced. ` +
            'Remove or move the refs, then retry:\n\n' + rows.join('\n'),
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'suite_list',
    {
      title: 'List test suites',
      description:
        'List the test suites in the connected product — id, name, type (Manual/Automation, where the ' +
        'provider has a suite-level type — SimplifyQA does, Walnut doesn\'t), and number of test ' +
        'cases. Use suite_get to read one with its ordered test cases, or suite_run to execute one. ' +
        'Requires a live connection (qa_connect). Read-only and product-neutral. When presenting this ' +
        'as a table, label the count column "Number of testcases", not "Members".',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      try {
        const rows = await adapter.listSuites();
        if (!rows.length) return ok('No test suites found.', { suites: [], totalCount: totalOf(rows) ?? 0 });
        const text =
          `${countHeader(rows, 'suite')}:\n\n` +
          '| id | name | type | Number of testcases |\n|---|---|---|---|\n' +
          rows.map((s) => `| ${escCell(s.id)} | ${escCell(s.name)} | ${escCell(s.suiteType ?? '-')} | ${s.memberCount ?? '-'} |`).join('\n');
        return ok(text, { suites: rows, totalCount: totalOf(rows) ?? rows.length });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'list_users',
    {
      title: 'List users (resolve a name to a userId)',
      description:
        'List users the caller can see in the connected product — id, name, email, username, status. ' +
        'Use this to resolve a person\'s NAME to a userId before filtering tc_list / story_list by ' +
        '`createdBy` / `updatedBy`. Non-admin callers are auto-scoped server-side to users in their ' +
        'assigned projects. Optional `search` matches on name (case-insensitive substring). Optional ' +
        '`projectId` narrows further to that project\'s members. Requires a live connection. Read-only.',
      inputSchema: {
        search: z.string().optional().describe('Case-insensitive substring over user name.'),
        projectId: z.string().optional().describe('Only users assigned to this project (from list_projects).'),
        limit: z.number().int().positive().optional().describe('Max results (default 100).'),
        offset: z.number().int().nonnegative().optional().describe('Result offset (paging).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ search, projectId, limit, offset }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.listUsers) return err('This product does not expose a user directory.');
      try {
        const rows = await adapter.listUsers({
          ...(search ? { search } : {}),
          ...(projectId ? { projectId } : {}),
          ...(limit != null ? { limit } : {}),
          ...(offset != null ? { offset } : {}),
        });
        if (!rows.length) return ok('No users found.', { users: [], totalCount: totalOf(rows) ?? 0 });
        const text =
          `${countHeader(rows, 'user')}:\n\n` +
          '| id | name | email | username | status |\n|---|---|---|---|---|\n' +
          rows.map((u) => `| ${escCell(u.id)} | ${escCell(u.name ?? '-')} | ${escCell(u.email ?? '-')} | ${escCell(u.username ?? '-')} | ${escCell(u.status ?? '-')} |`).join('\n');
        return ok(text, { users: rows, totalCount: totalOf(rows) ?? rows.length });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'suite_get',
    {
      title: 'Read one test suite (with test cases)',
      description:
        'Read a single test suite — its name, description, and ORDERED test cases — from the ' +
        'connected product. Requires a live connection (qa_connect). `id` is the suite id. ' +
        'Product-neutral: same shape on any connected product.',
      inputSchema: {
        id: z.string().describe('The suite id to read.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      try {
        const suite = await adapter.getSuite(id);
        const n = suite.members.length;
        const header =
          `**${suite.name}**${suite.id ? ` · ${suite.id}` : ''}` +
          `${suite.description ? `\n${suite.description}` : ''}\n${n} test case${n === 1 ? '' : 's'}`;
        const body = n
          ? '\n\n| order | test case |\n|---|---|\n' +
            suite.members.map((m) => `| ${m.order} | ${escCell(m.tcId)} |`).join('\n')
          : '';
        return ok(`${header}${body}`, { suite });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'suite_create',
    {
      title: 'Create a new suite from a few test cases',
      description:
        'Create a NEW test suite in the connected project from a small set of existing test cases. ' +
        '`tcIds` accepts numeric ids, business keys (TC_123), OR plain test case NAMES — a name is ' +
        'resolved by searching the project (tc_list under the hood); an ambiguous name (multiple ' +
        'matches) or one with zero matches is reported back rather than guessed. NOTE: a suite can ' +
        'only hold test cases of ONE category (all manual OR all automated) — a mixed set is refused.\n\n' +
        'NAME: if `name` is omitted, this tool does NOT create anything yet — it resolves the test ' +
        'cases, SUGGESTS a suite name, and returns a preview. Show the user the suggested name and the ' +
        'resolved test cases, ask them to confirm it or give their own, then call suite_create again ' +
        'with `name` set (and the same `tcIds`) to actually create it. Requires a live connection.',
      inputSchema: {
        tcIds: z.array(z.string()).min(1).describe('Test case ids, business keys (TC_123), or plain names to include.'),
        name: z.string().optional().describe('Suite name. Omit to get a suggested name + preview first (does not create).'),
        description: z.string().optional().describe('Optional suite description.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ tcIds, name, description }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.createSuite) return err('This product does not support creating suites.');
      if (!adapter.getTestCase) return err('This product does not support test-case read.');

      // Resolve each ref: try it as an id/business key first, else search by name.
      const resolved: Array<{ tcId: string; title: string; category: 'manual' | 'automated' }> = [];
      const unresolved: string[] = [];
      for (const ref of tcIds) {
        try {
          const tc = await adapter.getTestCase(ref);
          resolved.push({ tcId: tc.id ?? ref, title: tc.title || ref, category: tc.category === 'manual' ? 'manual' : 'automated' });
          continue;
        } catch {
          // Not a direct id/key hit — fall through to a name search below.
        }
        if (adapter.listTestCases) {
          try {
            const matches = await adapter.listTestCases({ search: ref, limit: 5 });
            if (matches.length === 1) {
              const m = matches[0]!;
              const category: 'manual' | 'automated' = String(m.executionType ?? '').toUpperCase() === 'MANUAL' ? 'manual' : 'automated';
              resolved.push({ tcId: m.id, title: m.title, category });
              continue;
            }
            if (matches.length > 1) {
              return err(
                `"${ref}" matches ${matches.length} test cases — be more specific or pass the id: ` +
                  matches.map((m) => `${m.title} (${m.id})`).join(', '),
              );
            }
          } catch {
            // fall through to unresolved
          }
        }
        unresolved.push(ref);
      }
      if (unresolved.length) {
        return err(
          `Could not find a test case for: ${unresolved.join(', ')} — check the id/name, or use ` +
            'tc_list to search first.',
        );
      }

      // Same rule the backend enforces: a suite can only hold ONE category. Catch a mismatch here,
      // before suggesting a name / asking the user to confirm — no point previewing a suite that
      // createSuite would refuse anyway.
      const categories = new Set(resolved.map((r) => r.category));
      if (categories.size > 1) {
        const byCategory = (cat: 'manual' | 'automated') =>
          resolved.filter((r) => r.category === cat).map((r) => `${r.title} (${r.tcId})`).join(', ') || '(none)';
        return err(
          'Cannot create suite: the test cases are a mix of manual and automated — a suite can only ' +
            `hold ONE category. Manual: ${byCategory('manual')}. Automated: ${byCategory('automated')}. ` +
            'Split them into two suites, or pick only same-category test cases.',
        );
      }

      if (!name) {
        const suggested = resolved.length === 1
          ? `${resolved[0]!.title} Suite`
          : `${resolved[0]!.title} + ${resolved.length - 1} more Suite`;
        return ok(
          `Resolved ${resolved.length} test case${resolved.length === 1 ? '' : 's'}: ` +
            `${resolved.map((r) => `${r.title} (${r.tcId})`).join(', ')}.\n\n` +
            `Suggested suite name: "${suggested}" — ASK the user to confirm this or give their own ` +
            `name, then call suite_create again with { name, tcIds } (reuse the same tcIds, or the ` +
            `resolved ids: ${resolved.map((r) => r.tcId).join(', ')}).`,
          { preview: true, suggestedName: suggested, testCases: resolved },
        );
      }

      try {
        const ref = await adapter.createSuite({
          name,
          ...(description !== undefined ? { description } : {}),
          members: resolved.map((r, i) => ({ tcId: r.tcId, order: i + 1 })),
        });
        return ok(
          `Created suite **${name}**${ref.id ? ` · ${ref.id}` : ''} with ${resolved.length} test ` +
            `case${resolved.length === 1 ? '' : 's'}: ${resolved.map((r) => r.title).join(', ')}.` +
            (ref.productUrl ? ` ${ref.productUrl}` : ''),
          { savedRef: ref },
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  // --- Suite membership edits (writes) --------------------------------------
  // Kept beside suite_list/suite_get so all suite tools live together; they mutate
  // via the adapter's updateSuiteMembers (→ update_suite_members provider-op).

  const testCasesTable = (suite: { members: { tcId: string; order: number }[] }): string =>
    suite.members.length
      ? '\n\n| order | test case |\n|---|---|\n' +
        suite.members.map((m) => `| ${m.order} | ${escCell(m.tcId)} |`).join('\n')
      : '';

  server.registerTool(
    'suite_add_testcases',
    {
      title: 'Add test cases to a suite',
      description:
        'Add one or more EXISTING test cases to a suite (appended in order). `tcIds` accepts ids or ' +
        'business keys (e.g. TC_123) — use suite_list / tc_list to find them. NOTE: a suite can only ' +
        'hold test cases of ONE category (all manual OR all automated) — the product rejects a mix. ' +
        'Requires a live connection. Returns the updated suite with its test cases.',
      inputSchema: {
        suiteId: z.string().describe('The suite id to add to (from suite_list).'),
        tcIds: z.array(z.string()).min(1).describe('Test case ids / business keys to add.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ suiteId, tcIds }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      try {
        const ops: MemberOp[] = tcIds.map((tcId) => ({ op: 'add', tcId }));
        const suite = await adapter.updateSuiteMembers(suiteId, ops);
        const n = suite.members.length;
        // Resolve titles for the confirmation — membership rows only carry `tcId`.
        const added = await Promise.all(
          tcIds.map(async (tcId) => {
            try {
              const tc = await adapter.getTestCase(tcId);
              return tc.title ? `${tc.title} (${tcId})` : tcId;
            } catch {
              return tcId;
            }
          }),
        );
        return ok(
          `Added ${added.length} test case${added.length === 1 ? '' : 's'} to **${suite.name}**: ` +
            `${added.join(', ')} — now ${n} test case${n === 1 ? '' : 's'} total.` +
            testCasesTable(suite),
          { suite },
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'suite_remove_testcases',
    {
      title: 'Remove test cases from a suite',
      description:
        'Remove one or more test cases from a suite. `tcIds` accepts ids or business keys; every ' +
        'occurrence of each is removed and the remaining test cases are reordered. Requires a live ' +
        'connection. Returns the updated suite with its test cases.',
      inputSchema: {
        suiteId: z.string().describe('The suite id to remove from.'),
        tcIds: z.array(z.string()).min(1).describe('Test case ids / business keys to remove.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ suiteId, tcIds }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      try {
        const ops: MemberOp[] = tcIds.map((tcId) => ({ op: 'remove', tcId }));
        const suite = await adapter.updateSuiteMembers(suiteId, ops);
        const n = suite.members.length;
        return ok(
          `Removed ${tcIds.length} test case${tcIds.length === 1 ? '' : 's'} from **${suite.name}** — now ${n} test case${n === 1 ? '' : 's'} total.` +
            testCasesTable(suite),
          { suite },
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  // --- Journal-first editing: READ side (journal_grep) ----------------------
  // The write side (journal_modify) forwards to the agent's edit_journal op.
  server.registerTool(
    'journal_grep',
    {
      title: 'Read a test case for editing (journal view)',
      description:
        'Load a test case as NUMBERED steps to edit — from its recording JOURNAL when one exists (so a ' +
        'later journal_modify stays healer/re-record consistent), else from its persisted steps (the ' +
        '`source` is reported). Optional `pattern` filters shown rows (case-insensitive substring over ' +
        'the step description) to help locate a range for journal_modify. Requires a live connection.',
      inputSchema: {
        tcId: z.string().describe('Test case id or business key.'),
        pattern: z.string().optional().describe('Case-insensitive substring filter over step descriptions.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ tcId, pattern }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.readJournal) return err('This product has no recording journal.');
      try {
        const view = await adapter.readJournal(tcId);
        const p = pattern?.toLowerCase();
        const rows = view.steps
          .filter((s) => !p || (s.description ?? '').toLowerCase().includes(p))
          .map(
            (s) =>
              `| ${s.n} | ${escCell(s.stepType)}${s.controlFlow ? `/${s.controlFlow.kind}` : ''} | ${escCell(s.description)} |`,
          );
        const staleness =
          view.source === 'journal'
            ? ` · journal seed${view.ageDays != null ? ` (${view.ageDays}d old)` : ''}`
            : ' · NO journal seed — showing persisted steps (a new-interaction add would be steps-only)';
        const header =
          `**${tcId}** — ${view.steps.length} step${view.steps.length === 1 ? '' : 's'} · source: ${view.source}${staleness}`;
        const body = rows.length
          ? '\n\n| n | type | description |\n|---|---|---|\n' + rows.join('\n')
          : `\n\n(no steps${pattern ? ' match the filter' : ''})`;
        return ok(`${header}${body}`, { view });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'journal_modify',
    {
      title: 'Modify a test case (steps, loops, if-else, nested)',
      description:
        'Apply granular edits to an EXISTING test case and persist them, opening the result in the ' +
        'test-case editor. Use journal_grep first to see the numbered steps, then pass ops (numbers are ' +
        'from that view, 1-based):\n' +
        '  • add_step / update_step / remove_step / move_step — edit individual steps\n' +
        '  • duplicate_step { n, through?, at? } — copy the WHOLE step (parameters, values, object, flags, settings) to the end or to `at`; ' +
        'use this for "add the same step again", not add_step. `through` is required when n opens an IF / loop / function block.\n' +
        '  • update_steps { where, patch } — one patch for EVERY matching step ("skip every step that uses X"); where: numbers, from/to, stepType, actionType, object, descriptionContains, parameter, or all:true\n' +
        '  • a step patch may carry swapParams [{ from, to, value? }] to replace one parameter with another in the same slot (recordedParam only adds)\n' +
        '  • add_assertions { n, assertions:[{ path, condition, expectedValue }] } — APPEND response assertions to an ' +
        'EXISTING API step (path: statusCode | responseTime | responseSize | $.body.x | $.headers.Name). The request, object, ' +
        'action, parameters and existing assertions are untouched — use this for "add only the assertion to step N".\n' +
        '  • update_step patch.api is MERGED into the saved API request (add an assertion: api.addAssertions [{ path, condition, expectedValue }]; api.assertions replaces the list) — edit an API step with this, never remove_step + add_step\n' +
        '  • wrap_in_loop { from, to, condition?, maxIterations? } — wrap steps from..to in a while loop\n' +
        '  • wrap_in_if   { from, to, condition? } — wrap steps from..to in an if block\n' +
        '  • add_step with stepType "control_flow" and controlFlow { kind, condition } — kind "while" … "end_while" (WHILE), "do" … "end_do_while" (DO-WHILE; the condition goes on the closing step). Conditions: controlFlow.condition = { type: element_displayed | element_not_displayed | element_enabled | element_disabled | element_clickable | element_checked, objectId | objectName }, or controlFlow.conditions [...] joined by each one\'s logical AND|OR.\n' +
        '  • insert_nested { at?, tcId, name? } — insert an existing test case as a nested step (reuse)\n' +
        'For a test case backed by a recording journal the journal is kept in sync (so healer / ' +
        're-record stay consistent); others edit the persisted steps. NOTE: adding a brand-new ' +
        'INTERACTION step (click/type on a new element) via add_step has no captured locator, so it is ' +
        'a manual/non-executable step — unless you give it an object: pass objectRef { id } or { name } to reuse an ' +
        'existing object from the repository, or { name, locators:[{ name, value }] } to create one. A step that ' +
        'needs NO element — e.g. Minimum Wait — needs none. Use add_step { at?, step: { actionType:"Minimum Wait", ' +
        'stepType, description, value? } } — `at` (alias `seq`) is the 1-based position the new step takes; it is ' +
        'inserted there DIRECTLY (the recorder window does not open) and the other steps just shift down. ' +
        'Requires a live connection.',
      inputSchema: {
        tcId: z.string().describe('Test case id or business key.'),
        ops: z.array(zJournalOp).min(1).describe('Ops to apply, in order.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ tcId, ops }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.editJournal) return err('This product has no editable recording journal.');
      // A live recording's id is its SESSION id (mcp-xxxxxxxx), not a test case. Editing steps there
      // would not work anyway: Save persists the recorder WINDOW's step list, not the journal, so a
      // journal edit is invisible to the user and lost at save. Point at the tool that does work.
      if (/^mcp-[a-z0-9]+$/i.test(tcId.trim())) {
        return err(
          `"${tcId}" is a LIVE recording session, not a saved test case.\n` +
          'The recorder window owns the steps that Save persists, so a pre-save removal has to happen there:\n' +
          '  • core_remove_steps({ numbers: [3,5] })            → preview\n' +
          '  • core_remove_steps({ numbers: [3,5], confirm: true }) → deletes those rows in the recorder window\n' +
          'Once the recording is saved, edit the test case with journal_modify({ tcId: "TC-…" }).',
        );
      }
      try {
        const view = await adapter.editJournal(tcId, ops as JournalOp[]);
        const rows = view.steps.map(
          (s) => `| ${s.n} | ${escCell(s.stepType)}${s.controlFlow ? `/${s.controlFlow.kind}` : ''} | ${escCell(s.description)} |`,
        );
        return ok(
          `Updated **${tcId}** — ${view.steps.length} step${view.steps.length === 1 ? '' : 's'}${view.source === 'steps' ? '' : ' (opened in the editor)'}.` +
            '\n\n| n | type | description |\n|---|---|---|\n' +
            rows.join('\n'),
          { view },
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );
}
