import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { BacklogKind } from '../domain/types.js';
import type { BacklogUnlinkResult } from '../adapters/simplifyqa/adapter.js';

/**
 * Backlog CRUD tools for the epic → feature → user-story hierarchy. Mirrors the shape of
 * discovery.tools.ts (list_ / *_get) plus adds create + update. `story_list` and `story_get`
 * live in discovery.tools.ts (older); `story_create` and `story_update` live here so all the
 * WRITE tools sit together.
 */
export type BacklogToolsDeps = {
  getAdapter: () => ProviderAdapter | null;
};

const NOT_CONNECTED =
  'Not connected to a product. Use qa_connect first — backlog CRUD needs a live backend.';

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function escCell(v: unknown): string {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function totalOf(rows: unknown[]): number | undefined {
  const t = (rows as { totalCount?: number }).totalCount;
  return typeof t === 'number' ? t : undefined;
}

function countHeader<T>(rows: T[], singular: string, plural = singular + 's'): string {
  const shown = rows.length;
  const total = totalOf(rows) ?? shown;
  const word = total === 1 ? singular : plural;
  return total > shown ? `Showing ${shown} of ${total} ${word}` : `${total} ${word}`;
}

// ---------------------------------------------------------------------------
// Shared user-filter fields (matches story_list) — passed to every list tool.
// ---------------------------------------------------------------------------

const userFilterShape = {
  createdBy: z.string().optional().describe(
    'Numeric userId of the creator. Pass "me" to filter by the current caller. Resolve names via list_users first.',
  ),
  updatedBy: z.string().optional().describe(
    'Numeric userId of the last updater. Pass "me" for the current caller. Resolve names via list_users first.',
  ),
  ownerId: z.string().optional().describe(
    'Numeric userId of the owner (assignee). Pass "me" for the current caller. Resolve names via list_users first.',
  ),
};

export function registerBacklogTools(server: McpServer, deps: BacklogToolsDeps): void {
  // ------------------------------------------------------------------------- Epics

  server.registerTool(
    'epic_list',
    {
      title: 'List / search epics',
      description:
        'Pull up EPICS in the connected project — id, key (EP_…), name, state. Top of the backlog ' +
        'hierarchy: epic → feature → story. Use `search` for keyword matches on name. Requires a live ' +
        'connection. Read-only.',
      inputSchema: {
        search: z.string().optional().describe('Keyword match on epic name.'),
        state: z.string().optional().describe('Filter by state (must match the project state config).'),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
        ...userFilterShape,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ search, state, limit, offset, createdBy, updatedBy, ownerId }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.listEpics) return err('This product does not expose epics.');
      try {
        const rows = await adapter.listEpics({
          ...(search ? { search } : {}),
          ...(state ? { state } : {}),
          ...(limit != null ? { limit } : {}),
          ...(offset != null ? { offset } : {}),
          ...(createdBy ? { createdBy } : {}),
          ...(updatedBy ? { updatedBy } : {}),
          ...(ownerId ? { ownerId } : {}),
        });
        if (!rows.length) return ok('No epics found.', { epics: [], totalCount: totalOf(rows) ?? 0 });
        const text =
          `${countHeader(rows, 'epic')}:\n\n` +
          '| key | name | state |\n|---|---|---|\n' +
          rows.map((e) => `| ${escCell(e.key ?? e.id)} | ${escCell(e.name)} | ${escCell(e.state ?? '-')} |`).join('\n');
        return ok(text, { epics: rows, totalCount: totalOf(rows) ?? rows.length });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'epic_get',
    {
      title: 'Read one epic',
      description:
        'Read a single EPIC — name, state, description, dates, effort — by id or business key (EP_123). ' +
        'Requires a live connection. Read-only.',
      inputSchema: { id: z.string().describe('Epic id or business key (EP_123).') },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.getEpic) return err('This product does not expose epics.');
      try {
        const epic = await adapter.getEpic(id);
        const header = `**${epic.name}**${epic.key ? ` · ${epic.key}` : ''}${epic.state ? ` · ${epic.state}` : ''}`;
        const desc = epic.description ? `\n\n${epic.description}` : '';
        const dates = (epic.plannedStartDate || epic.plannedEndDate)
          ? `\n\n_Planned:_ ${epic.plannedStartDate ?? '—'} → ${epic.plannedEndDate ?? '—'}`
          : '';
        return ok(`${header}${desc}${dates}`, { epic });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'epic_create',
    {
      title: 'Create an epic',
      description:
        'Create a new EPIC in the connected project. `projectIds` defaults to the current project when ' +
        'omitted. `state` defaults to the project-configured default state when omitted; pass it only ' +
        'when overriding (must match an existing state in the project config — see epic_list / epic_get). ' +
        'Backend requires `name`, `estimatedEffort`, `plannedStartDate`, `plannedEndDate`. ' +
        '**`description` must be a DETAILED epic write-up as HTML (NOT markdown) derived from the ' +
        'source document (BRD, spec, user request). SQA UI renders this via a Tiptap editor and stores ' +
        'raw HTML — see the description field docstring for the exact allowed tags and required ' +
        'section structure. One-line summaries are not acceptable.** `customFields` may be omitted — ' +
        'an empty object is sent automatically.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        name: z.string().min(3).max(500).describe('Epic name (3–500 chars).'),
        estimatedEffort: z.number().nonnegative().describe('Estimated effort (hours).'),
        plannedStartDate: z.string().describe('ISO date/datetime for planned start.'),
        plannedEndDate: z.string().describe('ISO date/datetime for planned end.'),
        state: z.string().optional().describe(
          'Optional. Defaults to the project-configured default epic state when omitted.',
        ),
        projectIds: z.array(z.number()).optional().describe(
          'Project ids the epic belongs to. Defaults to [currentProject].',
        ),
        ownerId: z.number().optional().describe('Numeric userId of the epic owner.'),
        description: z.string().optional().describe(
          [
            'REQUIRED-QUALITY: rich HTML write-up sourced from the BRD/spec. NOT markdown — the SQA UI ',
            'renders this through a Tiptap editor and stores the raw HTML string. Minimum 300 words when ',
            'a BRD is available; NEVER a one-line summary.',
            '',
            'ALLOWED tags ONLY (anything else is stripped by the editor sanitizer): <p>, <br>, <h1>–<h6>, ',
            '<strong>, <em>, <u>, <s>, <mark>, <code>, <pre>, <blockquote>, <hr>, <ul>, <ol>, <li>, <a>, ',
            '<img>, <table>, <thead>, <tbody>, <tr>, <th>, <td>, <span>. Do NOT emit markdown syntax ',
            '(`##`, `**`, `- `, backtick-code-fences) — the editor will not render it.',
            '',
            'Follow this structure — omit a section only if the BRD has nothing for it. Every heading is ',
            'an <h2>; every bulleted point is an <li> inside <ul>:',
            '',
            '<h2>Overview</h2><p>2–4 sentences framing the epic — the business capability it delivers.</p>',
            '<h2>Business Goals</h2><ul><li>One goal per bullet, quoting BRD numbers/targets verbatim.</li></ul>',
            '<h2>Scope</h2><ul><li>In-scope items. Preserve requirement IDs like <code>REQ-4.2</code>.</li></ul>',
            '<h2>Out of Scope</h2><ul><li>Explicit exclusions from the BRD.</li></ul>',
            '<h2>Stakeholders</h2><ul><li>Owner, sponsor, impacted teams.</li></ul>',
            '<h2>Success Metrics</h2><ul><li>KPIs, thresholds, deadlines copied verbatim.</li></ul>',
            '<h2>Dependencies</h2><ul><li>Upstream systems, other epics, external teams.</li></ul>',
            '<h2>Risks</h2><ul><li>Risk — mitigation.</li></ul>',
            '',
            'Emphasise with <strong>, quote APIs/config keys with <code>, escape a real requirement in ',
            '<blockquote> when it carries contractual weight.',
          ].join('\n'),
        ),
        tags: z.array(z.string()).optional(),
        teamId: z.array(z.number()).optional(),
        actualStartDate: z.string().optional(),
        actualEndDate: z.string().optional(),
        actualEffort: z.number().optional(),
        remainingEffort: z.number().optional(),
        plannedBudget: z.number().optional(),
        watchList: z.array(z.union([z.string(), z.number()])).optional().describe(
          'Watch List (the UI email button): emails, full names or numeric userIds to receive notifications. Applied after creation.',
        ),
        customFields: z.record(z.string(), z.unknown()).optional().describe(
          'Optional. Empty object `{}` sent automatically when omitted.',
        ),
      },
    },
    async (input) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.createEpic) return err('This product does not expose epic creation.');
      try {
        const { watchList, ...payload } = input;
        const ref = await adapter.createEpic(payload);
        if (watchList?.length && adapter.addWatchListUsers) {
          await adapter.addWatchListUsers({ entityType: 'epic', itemId: ref.id, users: watchList });
        }
        return ok(`Created epic \`${ref.id}\`${watchList?.length ? ' with the Watch List set' : ''}.`, { savedRef: ref });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'epic_update',
    {
      title: 'Update an epic (partial)',
      description:
        'PATCH an existing EPIC — pass only the fields to change plus `updateVersion` (optimistic ' +
        'concurrency, from the last epic_get). Accepts id or business key (EP_123). ' +
        'Cannot rename the epic to a duplicate of another epic in the same customer.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        id: z.string().describe('Epic id or business key (EP_123).'),
        name: z.string().min(3).max(500).optional(),
        state: z.string().optional(),
        estimatedEffort: z.number().optional(),
        plannedStartDate: z.string().optional(),
        plannedEndDate: z.string().optional(),
        projectIds: z.array(z.number()).optional(),
        ownerId: z.number().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        teamId: z.array(z.number()).optional(),
        actualStartDate: z.string().optional(),
        actualEndDate: z.string().optional(),
        actualEffort: z.number().optional(),
        remainingEffort: z.number().optional(),
        plannedBudget: z.number().optional(),
        customFields: z.record(z.string(), z.unknown()).optional(),
        updateVersion: z.number().optional().describe('Optimistic-concurrency version from the last read.'),
      },
    },
    async ({ id, ...patch }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.updateEpic) return err('This product does not expose epic updates.');
      try {
        const ref = await adapter.updateEpic(id, patch);
        return ok(`Updated epic \`${ref.id || id}\`.`, { savedRef: ref });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  // ------------------------------------------------------------------------- Features

  server.registerTool(
    'feature_list',
    {
      title: 'List / search features',
      description:
        'Pull up FEATURES in the connected project — id, key (FT_…), name, state, parent epic. Middle ' +
        'of the backlog hierarchy. Pass `epicId` to list features under a specific epic. Requires a ' +
        'live connection. Read-only.',
      inputSchema: {
        search: z.string().optional().describe('Keyword match on feature name.'),
        state: z.string().optional(),
        epicId: z.string().optional().describe('Only features under this parent epic id.'),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
        ...userFilterShape,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ search, state, epicId, limit, offset, createdBy, updatedBy, ownerId }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.listFeatures) return err('This product does not expose features.');
      try {
        const rows = await adapter.listFeatures({
          ...(search ? { search } : {}),
          ...(state ? { state } : {}),
          ...(epicId ? { epicId } : {}),
          ...(limit != null ? { limit } : {}),
          ...(offset != null ? { offset } : {}),
          ...(createdBy ? { createdBy } : {}),
          ...(updatedBy ? { updatedBy } : {}),
          ...(ownerId ? { ownerId } : {}),
        });
        if (!rows.length) return ok('No features found.', { features: [], totalCount: totalOf(rows) ?? 0 });
        const text =
          `${countHeader(rows, 'feature')}:\n\n` +
          '| key | name | state | epicId |\n|---|---|---|---|\n' +
          rows.map((f) =>
            `| ${escCell(f.key ?? f.id)} | ${escCell(f.name)} | ${escCell(f.state ?? '-')} | ${escCell(f.epicId ?? '-')} |`,
          ).join('\n');
        return ok(text, { features: rows, totalCount: totalOf(rows) ?? rows.length });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'feature_get',
    {
      title: 'Read one feature',
      description:
        'Read a single FEATURE by id or business key (FT_123). Requires a live connection. Read-only.',
      inputSchema: { id: z.string().describe('Feature id or business key (FT_123).') },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.getFeature) return err('This product does not expose features.');
      try {
        const feature = await adapter.getFeature(id);
        const header = `**${feature.name}**${feature.key ? ` · ${feature.key}` : ''}${feature.state ? ` · ${feature.state}` : ''}`;
        const desc = feature.description ? `\n\n${feature.description}` : '';
        const parent = feature.epicId ? `\n\n_Parent epic:_ ${feature.epicId}` : '';
        return ok(`${header}${desc}${parent}`, { feature });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'feature_create',
    {
      title: 'Create a feature',
      description:
        'Create a new FEATURE. `projectIds` defaults to the current project when omitted.\n\n' +
        '**HIERARCHY — ALWAYS RESOLVE BEFORE CALLING.** Features live under Epics. Before calling ' +
        'this tool, confirm with the user which `epicId` this feature belongs to. If the user has ' +
        'not told you: (1) ask them directly, or (2) if they name an epic, resolve the id via ' +
        '`epic_list`. When creating MULTIPLE features from a BRD, group them under the correct ' +
        'epic — do not scatter them. Skip epic linking only if the user explicitly says "no epic" or ' +
        '"standalone feature".\n\n' +
        '`state` and `priority` default to the project-configured defaults when omitted; pass them ' +
        'only when overriding. Backend requires `name`, `estimatedEffort`, `plannedStartDate`, ' +
        '`plannedEndDate`. **`description` must be a DETAILED feature write-up as HTML (NOT ' +
        'markdown) — SQA UI renders it via a Tiptap editor. See the description field docstring for ' +
        'the exact allowed tags and required section structure. One-line summaries are not ' +
        'acceptable.** `customFields` may be omitted — an empty object is sent automatically.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        name: z.string().min(3).max(500),
        estimatedEffort: z.number().nonnegative(),
        plannedStartDate: z.string(),
        plannedEndDate: z.string(),
        projectIds: z.array(z.number()).optional(),
        epicId: z.number().optional().describe(
          'Parent epic numeric id. RESOLVE VIA `epic_list` OR ASK THE USER before creating — do not ' +
          'leave a feature parent-less unless the user explicitly says "no epic".',
        ),
        orphan: z.boolean().optional().describe(
          'Set true ONLY if the user has explicitly said the feature has no parent epic ("standalone", ' +
          '"no epic"). Required when `epicId` is omitted — the tool refuses otherwise.',
        ),
        state: z.string().optional().describe(
          'Optional. Defaults to the project-configured default feature state when omitted.',
        ),
        priority: z.string().optional().describe(
          'Optional. Defaults to the project-configured default feature priority when omitted.',
        ),
        ownerId: z.number().optional(),
        description: z.string().optional().describe(
          [
            'REQUIRED-QUALITY: rich HTML write-up sourced from the BRD/spec. NOT markdown — the SQA UI ',
            'renders through a Tiptap editor and stores raw HTML. Minimum 250 words when the BRD covers ',
            'this feature; NEVER a one-line summary.',
            '',
            'ALLOWED tags ONLY: <p>, <br>, <h1>–<h6>, <strong>, <em>, <u>, <s>, <mark>, <code>, <pre>, ',
            '<blockquote>, <hr>, <ul>, <ol>, <li>, <a>, <img>, <table>, <thead>, <tbody>, <tr>, <th>, ',
            '<td>, <span>. Do NOT emit markdown syntax (`##`, `**`, `- `, code fences).',
            '',
            'Structure (each heading as <h2>, bullets as <ul><li>…):',
            '<h2>Overview</h2><p>2–3 sentences on what the feature is and who it is for.</p>',
            '<h2>User Value</h2><ul><li>Why users need this. Preserve BRD phrasing.</li></ul>',
            '<h2>Functional Requirements</h2><ul><li>Every requirement the BRD spells out — one per <li>. Do not ',
            'summarise multiple into one bullet.</li></ul>',
            '<h2>UI / UX Notes</h2><ul><li>Screens, fields, empty states, error surfaces from the BRD.</li></ul>',
            '<h2>Non-Functional Requirements</h2><ul><li>Performance, security, a11y, i18n — quote thresholds verbatim (e.g. <code>&lt; 200ms p95</code>).</li></ul>',
            '<h2>Acceptance Signals</h2><ul><li>High-level "done when …" — leave fine-grained Given/When/Then for story acceptanceCriteria.</li></ul>',
            '<h2>Dependencies</h2><ul><li>APIs, other features, third-party services.</li></ul>',
            '',
            '<code> for API paths / field names, <strong> for defined terms, <blockquote> for contractual quotes.',
          ].join('\n'),
        ),
        tags: z.array(z.number()).optional(),
        teamId: z.array(z.number()).optional(),
        actualStartDate: z.string().optional(),
        actualEndDate: z.string().optional(),
        actualEffort: z.number().optional(),
        remainingEffort: z.number().optional(),
        customFields: z.record(z.string(), z.unknown()).optional().describe(
          'Optional. Empty object `{}` sent automatically when omitted.',
        ),
        watchList: z.array(z.union([z.string(), z.number()])).optional().describe(
          'Watch List (the UI email button): emails, full names or numeric userIds to receive notifications. Applied after creation.',
        ),
      },
    },
    async (input) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.createFeature) return err('This product does not expose feature creation.');
      if (input.epicId == null && input.orphan !== true) {
        return err(
          'HIERARCHY REQUIRED: no `epicId` provided. Before creating, ASK the user which epic this ' +
          'feature belongs to — offer (a) create a new epic first via `epic_create`, or (b) pick an ' +
          'existing one (list by name via `epic_list`). Only re-call with `orphan: true` if the user ' +
          'explicitly says "no epic" / "standalone".',
        );
      }
      try {
        const { orphan: _orphan, watchList, ...payload } = input;
        const ref = await adapter.createFeature(payload);
        if (watchList?.length && adapter.addWatchListUsers) {
          await adapter.addWatchListUsers({ entityType: 'feature', itemId: ref.id, users: watchList });
        }
        return ok(`Created feature \`${ref.id}\`${watchList?.length ? ' with the Watch List set' : ''}.`, { savedRef: ref });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'feature_update',
    {
      title: 'Update a feature (partial)',
      description:
        'PATCH an existing FEATURE — pass only the fields to change plus `updateVersion` (optimistic ' +
        'concurrency, from the last feature_get). Accepts id or business key (FT_123).',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        id: z.string().describe('Feature id or business key (FT_123).'),
        name: z.string().min(3).max(500).optional(),
        estimatedEffort: z.number().optional(),
        plannedStartDate: z.string().optional(),
        plannedEndDate: z.string().optional(),
        projectIds: z.array(z.number()).optional(),
        epicId: z.number().optional(),
        state: z.string().optional(),
        priority: z.string().optional(),
        ownerId: z.number().optional(),
        description: z.string().optional(),
        tags: z.array(z.number()).optional(),
        teamId: z.array(z.number()).optional(),
        actualStartDate: z.string().optional(),
        actualEndDate: z.string().optional(),
        actualEffort: z.number().optional(),
        remainingEffort: z.number().optional(),
        customFields: z.record(z.string(), z.unknown()).optional(),
        updateVersion: z.number().optional(),
      },
    },
    async ({ id, ...patch }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.updateFeature) return err('This product does not expose feature updates.');
      try {
        const ref = await adapter.updateFeature(id, patch);
        return ok(`Updated feature \`${ref.id || id}\`.`, { savedRef: ref });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  // ------------------------------------------------------------------------- Stories (write)

  server.registerTool(
    'story_create',
    {
      title: 'Create a user story',
      description:
        'Create a new USER STORY under the connected project. `projectId` defaults to the current ' +
        'project.\n\n' +
        '**HIERARCHY — ALWAYS RESOLVE BEFORE CALLING.** A story lives under Epic → Feature → Story. ' +
        'Do NOT create orphan stories. Before calling this tool, confirm with the user which ' +
        '`epicId` and/or `featureId` the story belongs to. If the user has not told you: (1) ask ' +
        'them directly, or (2) if they name a parent, resolve the id via `epic_list` / `feature_list` ' +
        'first. When creating MULTIPLE stories from a BRD, group them under the same parent unless ' +
        'the BRD clearly splits them across features. Only skip parent linking if the user explicitly ' +
        'says "no parent" or "standalone".\n\n' +
        '`state` and `priority` default to the project-configured defaults when omitted; pass them ' +
        'only when overriding. Backend requires `name`, `estimatedEffort`. **`description` and ' +
        '`acceptanceCriteria` must BOTH be HTML (NOT markdown) — SQA UI renders them via a Tiptap ' +
        'editor and persists raw HTML. See each field docstring below for the exact allowed tags, ' +
        'required section structure, and Given/When/Then format for AC. One-line descriptions and ' +
        '3-line AC lists are not acceptable.** `customFields` may be omitted — an empty object is ' +
        'sent automatically.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        name: z.string().min(3).max(500),
        estimatedEffort: z.number().nonnegative(),
        state: z.string().optional().describe(
          'Optional. Defaults to the project-configured default story state when omitted.',
        ),
        projectId: z.number().optional().describe('Defaults to the connected project.'),
        epicId: z.number().optional().describe(
          'Parent epic numeric id. RESOLVE VIA `epic_list` OR ASK THE USER before creating — do not ' +
          'leave a story parent-less unless the user explicitly says "no parent".',
        ),
        featureId: z.number().optional().describe(
          'Parent feature numeric id. RESOLVE VIA `feature_list` OR ASK THE USER before creating — a ' +
          'story typically lives under a feature. Skip only if the user explicitly says "no feature".',
        ),
        orphan: z.boolean().optional().describe(
          'Set true ONLY if the user has explicitly said the story has no parent ("standalone", "no ' +
          'epic/feature"). Required when BOTH `epicId` and `featureId` are omitted — the tool refuses ' +
          'otherwise so orphan stories cannot be created silently from a BRD/BRS prompt.',
        ),
        moduleId: z.number().optional(),
        releaseId: z.number().optional(),
        iterationId: z.number().optional().describe('Sprint numeric id (SQA `iterationId`).'),
        acceptanceCriteria: z.string().optional().describe(
          [
            'REQUIRED-QUALITY: comprehensive Given/When/Then criteria as HTML (SQA UI renders through a ',
            'Tiptap editor). Use <ul><li>…</li></ul> — one AC per <li>. Aim for 5–15 criteria; a BRD ',
            'with 3 acceptance lines is a smell — expand implicit signals. Cover happy path, at least ',
            'one alternative flow, error/validation cases, permission/role edges, boundary values.',
            '',
            'Format per <li>: "<strong>Given</strong> &lt;precondition&gt; <strong>When</strong> ',
            '&lt;action&gt; <strong>Then</strong> &lt;observable outcome&gt;". Concrete example:',
            '',
            '<ul>',
            '  <li><strong>Given</strong> a user with an unverified email <strong>When</strong> they submit the login form <strong>Then</strong> the system displays <code>Verify your email</code> and does not create a session</li>',
            '  <li><strong>Given</strong> a user with 5 failed login attempts in the last 15 minutes <strong>When</strong> they submit valid credentials <strong>Then</strong> the system responds <code>429</code> and locks the account for 30 minutes</li>',
            '</ul>',
            '',
            'Do NOT emit markdown. Allowed tags: same allowlist as description. AVOID vague criteria ',
            '("Login works", "Errors are handled") — every <li> must be independently testable.',
          ].join('\n'),
        ),
        description: z.string().optional().describe(
          [
            'REQUIRED-QUALITY: rich HTML write-up sourced from the BRD/spec. NOT markdown — SQA UI ',
            'stores raw HTML from a Tiptap editor. Minimum 200 words when the BRD covers this story.',
            '',
            'ALLOWED tags ONLY: <p>, <br>, <h1>–<h6>, <strong>, <em>, <u>, <s>, <mark>, <code>, <pre>, ',
            '<blockquote>, <hr>, <ul>, <ol>, <li>, <a>, <img>, <table>, <thead>, <tbody>, <tr>, <th>, ',
            '<td>, <span>. No markdown syntax.',
            '',
            'Structure:',
            '<h2>Context</h2><p>2–3 sentences framing the story within its feature/epic.</p>',
            '<h2>User Story</h2><p>As a <strong>&lt;persona&gt;</strong> I want <strong>&lt;capability&gt;</strong> so that <strong>&lt;benefit&gt;</strong>.</p>',
            '<h2>Functional Details</h2><ul><li>Every requirement the BRD spells out — one per <li>. Include input formats, validation rules, downstream side effects.</li></ul>',
            '<h2>Edge Cases</h2><ul><li>Empty state, offline, permission denied, concurrent edits, boundary values.</li></ul>',
            '<h2>Non-Functional Requirements</h2><ul><li>Performance / security / a11y constraints, verbatim.</li></ul>',
            '',
            '<code> for field/API/config names, <strong> for defined terms. Preserve BRD numbers.',
          ].join('\n'),
        ),
        priority: z.string().optional().describe(
          'Optional. Defaults to the project-configured default story priority when omitted.',
        ),
        ownerId: z.array(z.number()).optional().describe('Numeric userIds of story owners.'),
        tags: z.array(z.number()).optional(),
        teamId: z.array(z.number()).optional(),
        type: z.string().optional(),
        plannedStartDate: z.string().optional(),
        plannedEndDate: z.string().optional(),
        watchList: z.array(z.union([z.string(), z.number()])).optional().describe(
          'Watch List (the UI email button): emails, full names or numeric userIds to receive notifications. Applied after creation.',
        ),
        customFields: z.record(z.string(), z.unknown()).optional().describe(
          'Optional. Empty object `{}` sent automatically when omitted.',
        ),
      },
    },
    async (input) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.createStory) return err('This product does not expose story creation.');
      if (input.epicId == null && input.featureId == null && input.orphan !== true) {
        return err(
          'HIERARCHY REQUIRED: no `epicId` or `featureId` provided. Before creating, ASK the user ' +
          'which parents this story belongs to — offer two paths: (a) generate the full Epic → ' +
          'Feature → Story hierarchy (call `epic_create` then `feature_create` then this tool), or ' +
          '(b) pick existing parents (list by NAME via `epic_list` / `feature_list`, then pass their ' +
          'ids). Only re-call with `orphan: true` if the user explicitly says "no parent" / ' +
          '"standalone". Apply the same ask to sibling stories in this batch — do not create some ' +
          'linked and some orphaned silently.',
        );
      }
      try {
        const { orphan: _orphan, watchList, ...payload } = input;
        const ref = await adapter.createStory(payload);
        if (watchList?.length && adapter.addWatchListUsers) {
          await adapter.addWatchListUsers({ entityType: 'userstory', itemId: ref.id, users: watchList });
        }
        return ok(`Created story \`${ref.id}\`${watchList?.length ? ' with the Watch List set' : ''}.`, { savedRef: ref });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'story_update',
    {
      title: 'Update a user story (partial)',
      description:
        'PATCH an existing USER STORY — pass only the fields to change plus `updateVersion` ' +
        '(optimistic concurrency, from the last story_get). Accepts id or business key (US_123). ' +
        'Pass `acceptanceCriteria` as a newline-separated string when replacing AC lines.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        id: z.string().describe('Story id or business key (US_123).'),
        name: z.string().min(3).max(500).optional(),
        state: z.string().optional(),
        estimatedEffort: z.number().optional(),
        projectId: z.number().optional(),
        epicId: z.number().optional(),
        featureId: z.number().optional(),
        moduleId: z.number().optional(),
        releaseId: z.number().optional(),
        iterationId: z.number().optional(),
        acceptanceCriteria: z.string().optional(),
        description: z.string().optional(),
        priority: z.string().optional(),
        ownerId: z.array(z.number()).optional(),
        tags: z.array(z.number()).optional(),
        teamId: z.array(z.number()).optional(),
        type: z.string().optional(),
        plannedStartDate: z.string().optional(),
        plannedEndDate: z.string().optional(),
        customFields: z.record(z.string(), z.unknown()).optional(),
        updateVersion: z.number().optional(),
      },
    },
    async ({ id, ...patch }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.updateStory) return err('This product does not expose story updates.');
      try {
        const ref = await adapter.updateStory(id, patch);
        return ok(`Updated story \`${ref.id || id}\`.`, { savedRef: ref });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  // ------------------------------------------------------------------------- Delete (all kinds)

  type Row = { id: string; label: string; keys: string[] };
  const norm = (v: string) => v.trim().toLowerCase().replace(/[-\s]+/g, '_');

  /** Resolve a name / id / business key to the rows that match EXACTLY, via the kind's list tool. */
  async function findRows(adapter: ProviderAdapter, kind: BacklogKind, ref: string): Promise<{ exact: Row[]; near: Row[] } | string> {
    let rows: Row[];
    const q = { search: ref, limit: 50 };
    if (kind === 'epic') {
      if (!adapter.listEpics) return 'This product does not expose epics.';
      rows = (await adapter.listEpics(q)).map((r) => ({ id: r.id, label: r.name, keys: [r.id, r.key ?? '', r.name] }));
    } else if (kind === 'feature') {
      if (!adapter.listFeatures) return 'This product does not expose features.';
      rows = (await adapter.listFeatures(q)).map((r) => ({ id: r.id, label: r.name, keys: [r.id, r.key ?? '', r.name] }));
    } else if (kind === 'story') {
      if (!adapter.listStories) return 'This product does not expose user stories.';
      rows = (await adapter.listStories(q)).map((r) => ({ id: r.id, label: r.title, keys: [r.id, r.key ?? '', r.title] }));
    } else if (kind === 'defect') {
      if (!adapter.listDefects) return 'This product does not expose defects.';
      rows = (await adapter.listDefects(q)).map((r) => ({ id: r.id, label: r.title, keys: [r.id, r.code ?? '', r.title] }));
    } else {
      if (!adapter.listTasks) return 'This product does not expose tasks.';
      rows = (await adapter.listTasks(q)).map((r) => ({ id: r.id, label: r.title, keys: [r.id, r.code ?? '', r.title] }));
    }
    const want = norm(ref);
    const exact = rows.filter((r) => r.keys.some((k) => k && norm(k) === want));
    return { exact, near: rows.filter((r) => !exact.includes(r)).slice(0, 10) };
  }

  server.registerTool(
    'backlog_delete',
    {
      title: 'Delete an epic / feature / user story / defect / task',
      description:
        'DESTRUCTIVE. Delete ONE epic, feature, user story, defect or task. `ref` is the item\'s NAME, ' +
        'business key (EP_12, FT_3, US_5, DF_7 …) or numeric id — resolved here, the user never supplies an ' +
        'internal id. TWO-STEP: call WITHOUT `confirm` to get a preview (what will be deleted + anything that ' +
        'depends on it); show it to the user and ASK; only then call again with `confirm:true`. An item that ' +
        'still has dependents (an epic with features/stories, a feature/story with children or test cases, ' +
        'a defect with test cases/tasks) is REFUSED with the blockers listed — nothing cascades. An ambiguous ' +
        'name lists the matches and deletes nothing. Needs the user\'s delete permission; no agent required. ' +
        'Requires a live connection.',
      inputSchema: {
        kind: z.enum(['epic', 'feature', 'story', 'defect', 'task']).describe('Which kind of item to delete.'),
        ref: z.string().min(1).describe('Name, business key (EP_/FT_/US_/DF_…) or numeric id of the item.'),
        confirm: z.boolean().optional().describe('Set true ONLY after the user has seen the preview and explicitly confirmed the delete.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ kind, ref, confirm }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.deleteBacklogItem) return err('This product does not support deleting backlog items.');
      try {
        const found = await findRows(adapter, kind, ref);
        if (typeof found === 'string') return err(found);
        if (found.exact.length === 0) {
          const hint = found.near.length
            ? `\n\nClosest matches:\n${found.near.map((r) => `- ${r.label} (id ${r.id})`).join('\n')}\n\nNothing was deleted.`
            : ' Nothing was deleted.';
          return err(`No ${kind} matching "${ref}" was found.${hint}`);
        }
        if (found.exact.length > 1) {
          return err(
            `"${ref}" matches ${found.exact.length} ${kind}s — ambiguous, nothing was deleted. Ask the user which one:\n` +
              found.exact.map((r) => `- ${r.label} (id ${r.id})`).join('\n'),
          );
        }
        const item = found.exact[0]!;
        const what = `${kind} **${item.label}** (id ${item.id})`;

        const probe = await adapter.deleteBacklogItem({ kind, id: item.id, confirm: false });
        const blockers = probe.dependencies.flatMap((d) => Object.entries(d.counts));
        if (blockers.length) {
          return err(
            `Cannot delete ${what} — other items still depend on it:\n` +
              blockers.map(([k, ids]) => `- ${k.replace(/Arr$/, '')}: ${ids.length} (ids ${ids.slice(0, 15).join(', ')}${ids.length > 15 ? ', …' : ''})`).join('\n') +
              '\n\nMove or delete those first. Nothing was deleted.',
          );
        }
        if (confirm !== true) {
          return ok(
            `About to delete ${what}. Nothing else depends on it.\n\n` +
              '**Ask the user to confirm**, then call `backlog_delete` again with `confirm:true`. This cannot be undone from here.',
            { preview: true, needs: 'confirm', item: { kind, id: item.id, name: item.label } },
          );
        }
        const res = await adapter.deleteBacklogItem({ kind, id: item.id, confirm: true });
        if (!res.deleted) {
          return err(`The product refused to delete ${what} (it reported dependents). Nothing was deleted.`);
        }
        return ok(`Deleted ${what}.`, { deleted: { kind, id: item.id, name: item.label } });
      } catch (e) {
        const msg = describeError(e);
        return err(/privilege|authori[sz]|forbidden|401|403/i.test(msg)
          ? `You don't have permission to delete this ${kind}. (${msg})`
          : msg);
      }
    },
  );

  server.registerTool(
    'watch_list_add',
    {
      title: 'Add members to the Watch List of an epic, feature or user story',
      description:
        'Add people to an item\'s WATCH LIST — the same list the UI\'s email button edits. `users` takes ' +
        'emails, full names or numeric userIds (e.g. ["rohini.k@simplify3x.com"]). Existing watchers are ' +
        'kept; the item is re-read to confirm. Use it after creating an item, or for an existing one.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        entityType: z.enum(['epic', 'feature', 'userstory']).describe('Which backlog item.'),
        itemId: z.string().describe('Item id or business key (EP-66, FT-266, US-1326).'),
        users: z.array(z.union([z.string(), z.number()])).min(1)
          .describe('Emails, full names or numeric userIds to add to the Watch List.'),
      },
    },
    async ({ entityType, itemId, users }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.addWatchListUsers) return err('Watch Lists are available only on a SimplifyQA connection.');
      try {
        const res = await adapter.addWatchListUsers({ entityType, itemId, users });
        return ok(
          `Watch List of ${entityType} ${itemId} now has user id(s): ${res.users.join(', ') || '(none)'}.`,
          { entityType, itemId, users: res.users, mailersList: res.mailersList } as unknown as Record<string, unknown>,
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'backlog_link',
    {
      title: 'Link an epic / feature / user story / defect to another item (Linkages)',
      description:
        'Create a LINK between an epic, feature, user story or DEFECT and another backlog item (defect, epic, ' +
        'feature, story, task) — the UI\'s Linkages section. `linkType` is a link type name/key such as ' +
        '"Clones" (case-insensitive; the available types are read from the project\'s link-type config ' +
        'and an unknown one is refused with the list). `destType` is the DESTINATION issue type ' +
        '(e.g. "defect"). The link is saved on the SOURCE item and read back from /pm/linkages to confirm.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        sourceType: z.enum(['epic', 'feature', 'userstory', 'defect']).describe('Item that owns the Linkages section (a defect too — its Linkages section).'),
        sourceId: z.string().describe('Source item id or business key (EP-64, FT-266, US-1326, DE-75).'),
        destType: z.enum(['epic', 'feature', 'userstory', 'defect', 'task']).describe('Destination issue type.'),
        destId: z.string().describe('Destination id or business key (DE-2293).'),
        linkType: z.string().min(1).describe('Link type name or key, e.g. "Clones".'),
      },
    },
    async ({ sourceType, sourceId, destType, destId, linkType }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.linkBacklogItem) return err('Linkages are available only on a SimplifyQA connection.');
      try {
        const res = await adapter.linkBacklogItem({ sourceType, sourceId, destType, destId, linkType });
        return ok(
          (res.alreadyLinked
            ? `${sourceType} ${sourceId} was already linked to ${destType} ${res.destinationCode ?? destId} (${linkType}) — nothing changed. `
            : `Linked ${sourceType} ${sourceId} → ${destType} ${res.destinationCode ?? destId} (${linkType}, key ${res.linkTypeKey}). `) +
          `Links now: ${res.linkedIssues.map((l) => `${l['destinationCode'] ?? l['destinationId']} (${l['linkTypeKey']})`).join(', ') || '(none)'}`,
          { sourceType, sourceId, destType, destId, linkTypeKey: res.linkTypeKey, links: res.linkedIssues } as unknown as Record<string, unknown>,
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'backlog_unlink',
    {
      title: 'Remove a link between two backlog items (Linkages)',
      description:
        'DELETE a LINK between two backlog items — the UI\'s Linkages delete (the opposite of backlog_link). Pass the item that owns the link ' +
        '(`sourceType` + `sourceId`, e.g. epic EP-71) and the item it points to (`destType` + `destId`, e.g. defect DE-2293). If the source has more than one ' +
        'link to that item, say which with `linkType` (e.g. "Clones"). The link disappears from BOTH items\' Linkages; the tool reads the source\'s ' +
        'Linkages back to confirm and checks the other side too. A link that is not there is reported with the links the source does have. ' +
        'Deleting is final — call it only when the user asked to remove the link.',
      inputSchema: {
        sourceType: z.enum(['epic', 'feature', 'userstory', 'defect', 'task']).describe('Item type that owns the Linkages row.'),
        sourceId: z.string().describe('Source item id or business key (EP-71, FT-266, US-1326, DE-2293, TA-3).'),
        destType: z.enum(['epic', 'feature', 'userstory', 'defect', 'task']).describe('The linked item\'s type.'),
        destId: z.string().describe('The linked item\'s id or business key (DE-2293).'),
        linkType: z.string().optional().describe('Link type name or key (e.g. "Clones") — needed only when the source has several links to that item.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ sourceType, sourceId, destType, destId, linkType }) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & {
        unlinkBacklogItem?: (input: { sourceType: string; sourceId: string; destType: string; destId: string; linkType?: string | undefined }) => Promise<BacklogUnlinkResult>;
      }) | null;
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.unlinkBacklogItem) return err('Linkages are available only on a SimplifyQA connection.');
      try {
        const res = await adapter.unlinkBacklogItem({ sourceType, sourceId, destType, destId, ...(linkType ? { linkType } : {}) });
        return ok(
          [
            `Removed the link ${res.sourceCode} → ${res.destinationCode} (${res.removed.join(', ')}) and read the Linkages back: it is gone.`,
            `${res.sourceCode}'s links now: ${res.remaining.join(', ') || '(none)'}.`,
            ...res.warnings.map((w) => `⚠️ ${w}`),
          ].join('\n'),
          { ...res } as unknown as Record<string, unknown>,
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );
}
