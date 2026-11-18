/**
 * `column_preference` — read / change the COLUMN preferences of SimplifyQA list views.
 *
 * The UI's column-preference tick saves the checked fields into the user's preference document
 * (`PUT /pm/preference/:userId`) under a per-list key — `epicFilter`, `featureFilter`,
 * `userstoryFilter`, … This tool does the same write, so the column appears on the list after a
 * refresh exactly as if the user had ticked it.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';

export type PreferenceDeps = { getAdapter: () => ProviderAdapter | null };

type PreferenceWrites = {
  getUserPreferences: () => Promise<Record<string, unknown>>;
  updateUserPreferences: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
  listViewFields: (entityId: number, fieldType?: string) => Promise<Array<Record<string, unknown>>>;
};

const LISTS = {
  epic: { entityId: 1, prefKey: 'epicFilter', label: 'Epics' },
  feature: { entityId: 2, prefKey: 'featureFilter', label: 'Features' },
  userstory: { entityId: 3, prefKey: 'userstoryFilter', label: 'User Stories' },
  testcase: { entityId: 5, prefKey: 'testcaseFilter', label: 'Test Cases' },
  suite: { entityId: 5, prefKey: 'suiteTCFilter', label: 'Suite test cases' },
  scenario: { entityId: 5, prefKey: 'scenarioTCFilter', label: 'Test plan test cases' },
  executionplan: { entityId: 5, prefKey: 'executionplanFilter', label: 'Execution plan test cases' },
} as const;
type ListKey = keyof typeof LISTS;

/** The execution-plan test-case table builds its columns in code (not from the field config), so its
 *  preference stores these keys. Mirrors `plan-testcases-table.component.ts`'s `allColumns`. */
const EXECUTION_PLAN_COLUMNS: Array<Record<string, unknown>> = [
  { key: 'tcName', label: 'Name', isChecked: true },
  { key: 'expAssignedTo', label: 'Assignee', isChecked: true },
  { key: 'expAssignedDate', label: 'Date', isChecked: true },
  { key: 'versionName', label: 'Version', isChecked: false },
  { key: 'sourceType', label: 'Source Type', isChecked: false },
  { key: 'executionType', label: 'Execution Type', isChecked: false },
  { key: 'tags', label: 'Label', isChecked: false },
];

const LIST_KEYS = Object.keys(LISTS) as ListKey[];
void LIST_KEYS;

const NOT_CONNECTED = 'Not connected to a product. Use qa_connect({ url, token, projectId }) first.';

const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase();

/** The shape the UI stores in a preference array: the field definition with the runtime bits removed
 *  and `isChecked: true` (the UI only lists checked entries in the column-preference dialog). */
function storedField(field: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...field, isChecked: true };
  for (const k of ['map', 'values', 'sortCount', 'searchData', 'show', 'isEdit', 'showEditMode']) delete out[k];
  out['searchRow'] = '';
  return out;
}

export function registerPreferenceTools(server: McpServer, deps: PreferenceDeps): void {
  server.registerTool(
    'column_preference',
    {
      title: 'Read or change list-view COLUMN preferences (SimplifyQA)',
      description:
        'Read or change which columns a LIST VIEW shows for THIS user — the same write as ticking a ' +
        'column in the UI\'s Column Preference menu. Supported lists: epic, feature, userstory, testcase ' +
        '(Test Case list), suite (Suite test-case list), scenario (Test plan test-case list) and executionplan ' +
        '(Execution Plan test-case list, including "Execution Type"). ' +
        'action "get" returns the visible column keys of each list; action "set" enables or disables ' +
        '`column` (a label like "Execution Type", or its key like "executionType") on every list in `lists`, ' +
        'then reads the preferences back to confirm. The change applies to the UI after a refresh.',
      inputSchema: {
        action: z.enum(['get', 'set']).describe('get = read visible columns; set = enable/disable a column.'),
        lists: z.array(z.enum(['epic', 'feature', 'userstory', 'testcase', 'suite', 'scenario', 'executionplan'])).min(1)
          .describe('Which list views to touch. testcase = Test Cases; suite = Suite test cases; scenario = Test plan test cases; executionplan = Execution Plan test cases.'),
        column: z.string().optional().describe('action "set": column LABEL ("Created On") or key ("createdAt").'),
        enabled: z.boolean().optional().describe('action "set": true to show the column (default), false to hide it.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ action, lists, column, enabled }) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & Partial<PreferenceWrites>) | null;
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.getUserPreferences || !adapter.updateUserPreferences || !adapter.listViewFields) {
        return err('column_preference is available only on a SimplifyQA connection.');
      }
      try {
        if (action === 'get') {
          const prefs = await adapter.getUserPreferences();
          const visible = lists.map((l) => {
            const spec = LISTS[l as ListKey];
            const rows = Array.isArray(prefs[spec.prefKey]) ? (prefs[spec.prefKey] as Array<Record<string, unknown>>) : [];
            return { list: l, preferenceKey: spec.prefKey, columns: rows.map((r) => ({ key: r?.['key'], label: r?.['label'] })) };
          });
          return ok(
            visible.map((v) => `${LISTS[v.list as ListKey].label}: ${v.columns.length ? v.columns.map((c) => c.label ?? c.key).join(', ') : '(no saved preference — defaults)'}`).join('\n'),
            { lists: visible } as unknown as Record<string, unknown>,
          );
        }

        const wanted = (column ?? '').trim();
        if (!wanted) return err('action "set" needs `column` (a label like "Created On", or its key).');
        const wantEnabled = enabled !== false;

        // Resolve the column + current visible set per list BEFORE writing, so a bad label fails
        // without touching anything.
        const prefs = await adapter.getUserPreferences();
        const patch: Record<string, unknown> = {};
        const plan: Array<{ list: ListKey; key: string; label: string; next: Array<Record<string, unknown>> }> = [];
        for (const l of lists) {
          const spec = LISTS[l as ListKey];
          const fields = l === 'executionplan' ? EXECUTION_PLAN_COLUMNS : await adapter.listViewFields(spec.entityId);
          const match = fields.find((f) =>
            norm(f['label']) === norm(wanted) || norm(f['key']) === norm(wanted) || norm(f['originalLabel']) === norm(wanted));
          if (!match) {
            const options = fields.map((f) => String(f['label'] ?? f['key'] ?? '')).filter(Boolean);
            return err(`No column "${wanted}" on the ${spec.label} list. Available columns: ${options.join(', ')}`);
          }
          const key = String(match['key']);
          const saved = Array.isArray(prefs[spec.prefKey]) ? (prefs[spec.prefKey] as Array<Record<string, unknown>>) : [];
          // No saved preference yet → the UI shows its DEFAULT columns. Seed from those, not [].
          const current = saved.length
            ? saved
            : l === 'executionplan'
              ? EXECUTION_PLAN_COLUMNS.filter((c) => c['isChecked'] === true)
              : fields.filter((f) => f['isDefault'] === true);
          const without = current.filter((c) => c?.['key'] !== key);
          const next = wantEnabled ? [...without, storedField(match)] : without;
          patch[spec.prefKey] = next;
          plan.push({ list: l as ListKey, key, label: String(match['label'] ?? key), next });
        }

        await adapter.updateUserPreferences(patch);
        // Read back and confirm.
        const after = await adapter.getUserPreferences();
        const report = plan.map((p) => {
          const spec = LISTS[p.list];
          const rows = Array.isArray(after[spec.prefKey]) ? (after[spec.prefKey] as Array<Record<string, unknown>>) : [];
          const has = rows.some((r) => r?.['key'] === p.key);
          return {
            list: p.list,
            column: p.label,
            visible: has,
            ok: has === wantEnabled,
            columns: rows.map((r) => r?.['key']),
          };
        });
        const allOk = report.every((r) => r.ok);
        const summary = report
          .map((r) => `${LISTS[r.list as ListKey].label}: ${r.column} → ${r.visible ? 'shown' : 'hidden'} ${r.ok ? '✓' : '✗'}`)
          .join('\n');
        return allOk
          ? ok(`Column preference saved. Refresh the list view to see it.\n${summary}`, { lists: report } as unknown as Record<string, unknown>)
          : err(`Wrote the preference but the read-back did not match:\n${summary}`);
      } catch (e) {
        return err(`Could not update column preferences: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
