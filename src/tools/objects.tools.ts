import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import { zLocator } from './schemas.js';


export type ObjectToolsDeps = {
  getAdapter: () => ProviderAdapter | null;
};

const NOT_CONNECTED =
  'Not connected to a product. Use qa_connect({ url, token, projectId }) first — listing, reading and ' +
  'deleting objects needs a live backend connection.';

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Page size used both for a caller's default single page and for each internal-pagination round trip. */
const OBJECT_LIST_PAGE_SIZE = 100;
/** Hard stop on internal pagination (object_list with no limit/offset) so a runaway project can never
 *  turn one tool call into an unbounded number of requests or an unbounded response. */
const OBJECT_LIST_SAFETY_CAP = 2000;

/** Markdown table cells: escape pipes and flatten newlines (mirrors discovery.tools.ts / markdown.ts). */
function escCell(v: unknown): string {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function registerObjectTools(server: McpServer, deps: ObjectToolsDeps): void {
  server.registerTool(
    'object_create',
    {
      title: 'Create a new object in the Object Repository',
      description:
        'Create a new object (a locator-bound UI element) in the shared Object Repository. `objectType` ' +
        '(e.g. "WEB", "ANDROID") is REQUIRED and STRUCTURAL — it selects the object template and cannot ' +
        'be changed after creation (see object_update). `locators` is the set of captured selector ' +
        'strategies for this element. GET-OR-CREATE by NAME (case-insensitive): if an object with the ' +
        'same name already exists, this reuses it — updating its locators in place if they differ — ' +
        'instead of creating a duplicate. Requires a live connection (qa_connect).',
      inputSchema: {
        name: z.string().min(1).describe('Display name for the object (the UI\'s "Name" column).'),
        objectType: z.string().describe('Object type / technology, e.g. "WEB", "ANDROID", "IOS", "DESKTOP". Required, and fixed once created.'),
        locators: z.array(zLocator).optional().describe('Captured locator strategies for this element.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ name, objectType, locators }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      try {
        const obj = await adapter.createObject({ name, objectType, locators: locators ?? [] });
        const link = obj.id ? ` \`${obj.id}\`` : '';
        const reused = obj.name.trim().toLowerCase() === name.trim().toLowerCase() && obj.name !== name;
        return ok(
          `${reused ? 'Reused existing' : 'Saved'} object${link} — "${obj.name}" (${obj.objectType ?? objectType}, ${obj.locators.length} locator${obj.locators.length === 1 ? '' : 's'}).`,
          { object: obj },
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'object_list',
    {
      title: 'List / search objects in the shared Object Repository',
      description:
        'List or search objects (recorded, locator-bound UI elements) in the connected product\'s ' +
        'shared Object Repository. Requires a live connection (qa_connect). Returns a summary — id, ' +
        'name, object type and locator count — never full locator bags (use object_get for one in ' +
        'full). Omit `limit`/`offset` to fetch the ENTIRE project object list (paged internally, up to ' +
        `${OBJECT_LIST_SAFETY_CAP}); pass either one to control a single page yourself instead.`,
      inputSchema: {
        query: z.string().optional().describe('Free-text search over the object name / description.'),
        pageName: z.string().optional().describe('Filter by captured page / screen name.'),
        limit: z.number().int().positive().optional().describe('Return exactly one page of this size, starting at `offset`, instead of fetching everything.'),
        offset: z.number().int().nonnegative().optional().describe('Result offset for a single manual page (implies a one-page fetch; default page size 100 if `limit` is omitted).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, pageName, limit, offset }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      try {
        const manualPaging = limit !== undefined || offset !== undefined;
        let rows;
        let truncated = false;
        if (manualPaging) {
          // Caller wants exactly one page — respect it as-is.
          rows = await adapter.searchObjects({
            ...(query !== undefined ? { query } : {}),
            ...(pageName !== undefined ? { pageName } : {}),
            limit: limit ?? OBJECT_LIST_PAGE_SIZE,
            ...(offset !== undefined ? { offset } : {}),
          });
        } else {
          // No paging args — fetch the WHOLE project list by paging internally until a short page
          // comes back (end of results) or the safety cap is hit.
          rows = [];
          let off = 0;
          for (;;) {
            const page = await adapter.searchObjects({
              ...(query !== undefined ? { query } : {}),
              ...(pageName !== undefined ? { pageName } : {}),
              limit: OBJECT_LIST_PAGE_SIZE,
              offset: off,
            });
            rows.push(...page);
            if (page.length < OBJECT_LIST_PAGE_SIZE) break;
            if (rows.length >= OBJECT_LIST_SAFETY_CAP) { truncated = true; break; }
            off += OBJECT_LIST_PAGE_SIZE;
          }
        }
        if (!rows.length) return ok('No objects found.', { objects: [] });
        // Summary only — full locator bags (structuredContent's biggest cost) blow past the MCP result
        // size cap on any real-sized repository. object_get reads one object in full.
        const summaries = rows.map((o) => ({ id: o.id, name: o.name, objectType: o.objectType, locatorCount: o.locators.length }));
        const moreHint = manualPaging
          ? (rows.length === (limit ?? OBJECT_LIST_PAGE_SIZE) ? ' (more may exist — pass offset to page)' : '')
          : (truncated ? ` (stopped at the ${OBJECT_LIST_SAFETY_CAP}-object safety cap — refine with \`query\`)` : '');
        const text =
          `${rows.length} object${rows.length === 1 ? '' : 's'}${moreHint}:\n\n` +
          '| id | name | type | locators |\n|---|---|---|---|\n' +
          summaries
            .map((o) => `| ${escCell(o.id)} | ${escCell(o.name)} | ${escCell(o.objectType ?? '-')} | ${o.locatorCount} |`)
            .join('\n');
        return ok(text, { objects: summaries });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'object_get',
    {
      title: 'Read one object (with all its locators)',
      description:
        'Read a single object from the shared Object Repository — its name, type, FULL locator bag ' +
        '(every captured strategy, e.g. playwright primary + xpath fallbacks), and how many test ' +
        'cases/functions/workflows currently reference it (so usage is visible BEFORE editing or ' +
        'deleting, not just discovered as a delete refusal after the fact). Requires a live ' +
        'connection (qa_connect).',
      inputSchema: {
        id: z.string().describe('The object id to read.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.getObject) return err('This product does not expose object read-by-id.');
      try {
        const obj = await adapter.getObject(id, { enrichNames: true });
        const header = `**${obj.name}**${obj.id ? ` · ${obj.id}` : ''}${obj.objectType ? ` · ${obj.objectType}` : ''}`;
        const metaLine = [
          obj.moduleName ? `Module: ${obj.moduleName}` : undefined,
          obj.parameterNames?.length ? `Parameters: ${obj.parameterNames.join(', ')}` : undefined,
          obj.description ? `Description: ${obj.description}` : undefined,
        ].filter(Boolean).join(' · ');
        let usageNote = '';
        if (adapter.checkObjectDependencies) {
          try {
            const { tcCount, fnCount, wfCount } = await adapter.checkObjectDependencies(id);
            const parts: string[] = [];
            if (tcCount) parts.push(`${tcCount} test case${tcCount === 1 ? '' : 's'}`);
            if (fnCount) parts.push(`${fnCount} function${fnCount === 1 ? '' : 's'}`);
            if (wfCount) parts.push(`${wfCount} workflow${wfCount === 1 ? '' : 's'}`);
            usageNote = `\n\nUsage: ${parts.length ? `referenced by ${parts.join(', ')}` : 'not referenced by any test case, function, or workflow'}.`;
          } catch {
            // best-effort — omit the usage line rather than fail the whole read over it
          }
        }
        const body = obj.locators.length
          ? '\n\n| strategy | value |\n|---|---|\n' +
            obj.locators.map((l) => `| ${escCell(l.name)}${l.unique ? ' (unique)' : ''} | ${escCell(l.value)} |`).join('\n')
          : '\n\n_No locators captured._';
        return ok(`${header}${metaLine ? `\n${metaLine}` : ''}${body}${usageNote}`, { object: obj });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'tc_list_objects',
    {
      title: 'List the objects bound to a test case\'s steps',
      description:
        'READ-ONLY. Show every object (locator-bound UI element) referenced by an EXISTING test ' +
        'case\'s steps — id, name, and which step(s) use it. This tool NEVER deletes, updates, or ' +
        'creates anything, no matter what; it only reads. A referenced object id that no longer ' +
        'resolves (deleted, or never existed) is reported CLEARLY as "MISSING" — never silently ' +
        'dropped from the list or shown as if nothing were wrong.\n\n' +
        'VERSIONS: SimplifyQA TCs can have multiple versions with different step/object bindings — ' +
        "when the TC has more than one version and `versionId` is omitted, this tool REFUSES and " +
        "lists the available versions (same rule as tc_get) — ASK the user which one, then call " +
        "again with `versionId`. Pass versionId: '' to accept the current version. Requires a live " +
        'connection (qa_connect).',
      inputSchema: {
        tcId: z.string().describe('The test case id (or business key) to list objects for.'),
        versionId: z.string().optional().describe(
          "Version to read (an id from the TC's `versions[]`). Omit to trigger the ASK-user prompt " +
          "when the TC has multiple versions. Pass '' to accept the TC's currently-selected version.",
        ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ tcId, versionId }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      try {
        const preview = await adapter.getTestCase(tcId);
        const versions = preview.versions ?? [];
        if (versions.length > 1 && versionId === undefined) {
          const listing = versions
            .map((v) => `  • \`${v.id}\` — **${v.name}**${v.isCurrent ? ' (current)' : ''}`)
            .join('\n');
          return err(
            `Test case ${preview.id ?? tcId} has ${versions.length} versions — ASK the user which ` +
              `one to read, then call tc_list_objects again with { tcId, versionId }. Pass ` +
              `versionId: '' to accept the current version.\n\n${listing}`,
          );
        }
        const chosen = versionId === undefined || versionId === '' ? undefined : versionId;
        const tc = chosen ? await adapter.getTestCase(tcId, chosen) : preview;

        // Group by object id, in first-seen (step order) order, remembering which step(s) use it.
        const byId = new Map<string, { name?: string | undefined; missing?: boolean | undefined; steps: number[] }>();
        for (const s of tc.steps) {
          const ref = s.objectRef;
          if (!ref?.id) continue;
          const entry = byId.get(ref.id);
          if (entry) entry.steps.push(s.n);
          else byId.set(ref.id, { name: ref.name, missing: ref.missing, steps: [s.n] });
        }
        if (!byId.size) {
          return ok(`Test case ${tc.id ?? tcId} has no steps bound to any object.`, { objects: [] });
        }
        const entries = [...byId.entries()];
        const missingCount = entries.filter(([, v]) => v.missing).length;
        const missingNote = missingCount
          ? ` — ⚠️ ${missingCount} of them ${missingCount === 1 ? 'is' : 'are'} MISSING (referenced by a ` +
            'step but no longer exist in the Object Repository)'
          : '';
        const text =
          `${entries.length} object${entries.length === 1 ? '' : 's'} bound to ${tc.title || tcId}` +
            `${missingNote}:\n\n` +
          '| id | name | steps |\n|---|---|---|\n' +
          entries
            .map(([id, v]) => `| ${escCell(id)} | ${v.missing ? '⚠ MISSING' : escCell(v.name ?? '-')} | ${v.steps.join(', ')} |`)
            .join('\n');
        return ok(text, {
          objects: entries.map(([id, v]) => ({ id, name: v.name, missing: !!v.missing, steps: v.steps })),
        });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'parameter_update',
    {
      title: 'Edit a project parameter (Local / Runtime, default value, description)',
      description:
        "Edit a PARAMETER itself in the project - not a step's use of it. Typical: \"make task_doc a Runtime parameter\" " +
        '(a store slot written by a Read action must be Runtime), or change its default value / description. ' +
        'Local <-> Runtime only: Global parameters are encrypted and shared and are not edited here.\n\n' +
        'IMPACT: the change applies to EVERY test case that uses this parameter. So the call is a preview until you pass ' +
        '`confirm: true` - show the user what will change and that it affects every use, then call again with confirm. ' +
        'The parameter is re-read after the update and the call REFUSES if the change did not take. Requires a live connection.',
      inputSchema: {
        parameter: z.string().describe("The parameter's exact name (case-insensitive) or numeric id."),
        type: z.enum(['Local', 'Runtime']).optional().describe('New access type.'),
        defaultValue: z.string().optional(),
        description: z.string().optional(),
        confirm: z.boolean().optional().describe('Must be true to apply. Without it the call only describes what would change.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ parameter, type, defaultValue, description, confirm }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.updateParameter) return err('This product does not support editing parameters directly.');
      if (type === undefined && defaultValue === undefined && description === undefined) {
        return err('Nothing to change - pass type, defaultValue and/or description.');
      }
      if (confirm !== true) {
        const what = [type ? `type -> ${type}` : '', defaultValue !== undefined ? 'default value' : '', description !== undefined ? 'description' : '']
          .filter(Boolean).join(', ');
        return ok(
          `Preview only - nothing changed. This would update parameter "${parameter}": ${what}. It applies to EVERY test case that uses it. ` +
          'Call again with confirm: true to apply.',
          { applied: false },
        );
      }
      try {
        const r = await adapter.updateParameter(parameter, {
          ...(type ? { type } : {}),
          ...(defaultValue !== undefined ? { defaultValue } : {}),
          ...(description !== undefined ? { description } : {}),
        });
        return ok(`Updated parameter "${r.name}" (id ${r.id}): ${r.changed.join(', ') || 'no change needed'}. Now ${r.type}.`, { applied: true, parameter: r });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'object_update',
    {
      title: 'Update an object (name, description, parameter, module, or locators)',
      description:
        'Update an object in the shared Object Repository — rename it, change its description, set ' +
        'which parameter(s) it is bound to, move it to a different module, and/or fix locator values ' +
        'directly (e.g. a stale `data-test` attribute). Any combination of these can be set in ONE ' +
        'call when the user states them together. `locators` UPSERTS by strategy name: an entry ' +
        'matching an EXISTING locator name updates its value/unique in place, everything else on the ' +
        'object is untouched, and a name with no existing match is added as a NEW locator — you do not ' +
        'need to resupply the full locator set.\n\n' +
        'DEFAULT LOCATOR: to make a locator the object\'s DEFAULT (the one the UI marks as default and the ' +
        'executor uses first — "make it default"), pass `defaultLocator: "<locator name>"`, e.g. add an xpath ' +
        'with `locators: [{ name: "xpath", value: "//input[@id=\'u\']" }]` AND `defaultLocator: "xpath"` in one ' +
        'call. It can also name a locator already on the object (no need to resend its value). Only one ' +
        'default exists — it is cleared on the others. The result is re-read and the call REFUSES if the ' +
        'default did not take.\n\n' +
        '`parameterNames` REPLACES the object\'s full parameter binding with these (resolved by exact ' +
        'name, case-insensitive) — pass the CURRENT set plus the new one if the user means "also bind" ' +
        'rather than "replace"; read the object first (object_get) if you need to know the current ' +
        'bindings. `moduleName` takes the module\'s NAME, never an id — it is resolved automatically. ' +
        'Both REFUSE clearly (naming the bad value and the valid options) if the name doesn\'t match ' +
        'anything, rather than silently saving nothing.\n\n' +
        "The object's TYPE (technology) and TEMPLATE ID are NOT editable here — they are structural " +
        '(they determine which attribute set is even valid) and stay whatever they already are; ' +
        'changing either means creating a new object, not updating this one. Requires a live ' +
        'connection (qa_connect).',
      inputSchema: {
        id: z.string().describe('The object id to update.'),
        name: z.string().optional().describe('New display name for the object.'),
        description: z.string().optional().describe('New description for the object.'),
        parameterNames: z.array(z.string()).optional().describe(
          'REPLACES the object\'s bound parameters with these, resolved by exact name (case-' +
            'insensitive). Pass the full desired set, not just the one being added.',
        ),
        moduleName: z.string().optional().describe('Move the object to this module, by NAME (resolved automatically — never pass an id).'),
        locators: z.array(zLocator).optional().describe(
          'Locators to upsert by name, e.g. [{ name: "data-test", value: "123456" }] to fix one ' +
            'attribute — every other locator on the object is left as-is.',
        ),
        defaultLocator: z.string().optional().describe(
          'NAME of the locator to make the object\'s DEFAULT, e.g. "xpath" — one you add in `locators` in this ' +
            'same call, or one already on the object. Use this whenever the user says "make it default".',
        ),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ id, name, description, parameterNames, moduleName, locators, defaultLocator }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.updateObject) return err('This product does not support updating objects directly.');
      if (name === undefined && description === undefined && parameterNames === undefined
          && moduleName === undefined && locators === undefined && defaultLocator === undefined) {
        return err('Nothing to update — pass at least one of name, description, parameterNames, moduleName, locators, or defaultLocator.');
      }
      try {
        const obj = await adapter.updateObject(id, {
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(parameterNames !== undefined ? { parameterNames } : {}),
          ...(moduleName !== undefined ? { moduleName } : {}),
          ...(locators !== undefined ? { locators } : {}),
          ...(defaultLocator !== undefined ? { defaultLocator } : {}),
        }, { enrichNames: true });
        const mismatches: string[] = [];
        const changed: string[] = [];
        if (name !== undefined) {
          changed.push(`name → "${name}"`);
          if (obj.name !== name) mismatches.push(`name is "${obj.name}", not "${name}"`);
        }
        if (description !== undefined) {
          changed.push(`description → "${description}"`);
          if (description !== '' && obj.description !== description) {
            mismatches.push(`description is "${obj.description ?? '(empty)'}", not "${description}"`);
          }
        }
        if (parameterNames !== undefined) {
          changed.push(`parameters → [${parameterNames.join(', ')}]`);
          const wanted = new Set(parameterNames.map((n) => n.toLowerCase()));
          const got = new Set((obj.parameterNames ?? []).map((n) => n.toLowerCase()));
          if (wanted.size !== got.size || [...wanted].some((n) => !got.has(n))) {
            mismatches.push(`parameters are [${(obj.parameterNames ?? []).join(', ') || '(none)'}], not [${parameterNames.join(', ')}]`);
          }
        }
        if (moduleName !== undefined) {
          changed.push(`module → "${moduleName}"`);
          if ((obj.moduleName ?? '').toLowerCase() !== moduleName.toLowerCase()) {
            mismatches.push(`module is "${obj.moduleName ?? '(none)'}", not "${moduleName}"`);
          }
        }
        if (locators !== undefined) changed.push(`${locators.length} locator${locators.length === 1 ? '' : 's'} upserted`);
        // The default is the locator flagged `unique` — the one named by defaultLocator, else the last one flagged
        // in `locators`. Re-check what the backend answered: a default that silently did not take is the defect.
        const wantedDefault = defaultLocator?.trim()
          || [...(locators ?? [])].reverse().find((l) => l.unique === true)?.name;
        if (wantedDefault) {
          const defaults = obj.locators.filter((l) => l.unique);
          changed.push(`default locator → "${wantedDefault}"`);
          // The backend renames a few well-known attribute names on save, so only require the NAME to match when the
          // locator still carries it; otherwise require just that exactly one default is set.
          const stillNamed = obj.locators.some((l) => l.name.toLowerCase() === wantedDefault.toLowerCase());
          if (defaults.length !== 1 || (stillNamed && defaults[0]!.name.toLowerCase() !== wantedDefault.toLowerCase())) {
            mismatches.push(
              `the default locator is ${defaults.length ? `"${defaults.map((l) => l.name).join('", "')}"` : '(none)'}, not "${wantedDefault}"`,
            );
          }
        }
        const detail = [
          obj.description ? `description: "${obj.description}"` : undefined,
          obj.moduleName ? `module: "${obj.moduleName}"` : undefined,
          obj.parameterNames?.length ? `parameters: [${obj.parameterNames.join(', ')}]` : undefined,
        ].filter(Boolean).join(' · ');
        if (mismatches.length) {
          return err(
            `Update call succeeded but a fresh read of object ${obj.id ?? id} shows it did NOT take: ${mismatches.join('; ')}. ` +
              'Nothing else was rolled back — the fields that DID match are saved; re-check the mismatched one(s).',
          );
        }
        return ok(
          `Updated object ${obj.id ?? id} — "${obj.name}" (${obj.locators.length} locator${obj.locators.length === 1 ? '' : 's'} total)` +
            `${detail ? ` · ${detail}` : ''}. Changed: ${changed.join('; ')}.`,
          { object: obj },
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'object_delete',
    {
      title: 'Delete an object from the Object Repository (two-step confirm)',
      description:
        'Delete an object from the shared Object Repository. TWO-STEP CONFIRM, REQUIRED even for a ' +
        'single object: call once with just `id` to preview it (name/type + how many test cases, ' +
        'functions, or workflows still reference it); then call again with `{ id, confirm: true }` to ' +
        'actually delete. NEVER call this with confirm:true on the first call, and NEVER call it at ' +
        'all unless the user\'s own words asked to DELETE — a request to list, show, or read objects ' +
        '(object_list / object_get / "show me the objects in this test case") is NEVER a reason to ' +
        'call this tool. DEPENDENCY-CHECKED: if the object is still referenced by any test case, ' +
        'function, or workflow, the delete is REFUSED at confirm time too — it reports what still ' +
        'uses it instead of silently breaking those. Requires a live connection (qa_connect).',
      inputSchema: {
        id: z.string().describe('The object id to delete.'),
        confirm: z.boolean().optional().describe('Set to true on the SECOND call to actually delete. Omit (or false) to preview first.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ id, confirm }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!confirm) {
        try {
          const obj = adapter.getObject ? await adapter.getObject(id) : undefined;
          const label = obj ? `**${obj.name}**${obj.objectType ? ` · ${obj.objectType}` : ''} (${id})` : `object ${id}`;
          let depNote = '';
          if (adapter.checkObjectDependencies) {
            try {
              const { tcCount, fnCount, wfCount } = await adapter.checkObjectDependencies(id);
              const parts: string[] = [];
              if (tcCount) parts.push(`${tcCount} test case${tcCount === 1 ? '' : 's'}`);
              if (fnCount) parts.push(`${fnCount} function${fnCount === 1 ? '' : 's'}`);
              if (wfCount) parts.push(`${wfCount} workflow${wfCount === 1 ? '' : 's'}`);
              depNote = parts.length
                ? ` ⚠️ Still referenced by ${parts.join(', ')} — the delete WILL BE REFUSED unless those references are removed first.`
                : ' No test case, function, or workflow currently references it.';
            } catch {
              // best-effort — the actual delete call re-checks and refuses if this silently failed
            }
          }
          return ok(
            `⚠️ About to delete ${label}.${depNote} To proceed, call again with { id: "${id}", confirm: true }.`,
            { preview: true, object: obj },
          );
        } catch (e) {
          return err(describeError(e));
        }
      }
      try {
        await adapter.deleteObject(id);
        return ok(`Deleted object ${id}.`);
      } catch (e) {
        return err(describeError(e));
      }
    },
  );
}
