/**
 * `action_template_backup` — protect the Action catalogue (Object Templates) against a bad
 * "sync actions" run.
 *
 * SimplifyQA applies an AI/agent action sync SERVER-SIDE (`POST /tm/action/accept-reject/:id`): the
 * template's actions are replaced by the synced lists. That code is not in the MCP, so it cannot be
 * intercepted from here. What the MCP CAN do is take a snapshot before the sync and put back any
 * action a later sync dropped:
 *
 *   action "save"    — write every action of the project (full docs) to a JSON snapshot.
 *   action "verify"  — compare a snapshot with the live catalogue: which actions are missing per
 *                      template (read-only — no writes).
 *   action "restore" — re-CREATE the missing actions from the snapshot (dry-run by default; needs
 *                      `confirm:true`). It never deletes or edits anything.
 *
 * Matching is by (objectTemplate, uniqueId) and falls back to (objectTemplate, name), so a re-created
 * action is not duplicated.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';

export type ActionBackupDeps = { getAdapter: () => ProviderAdapter | null; getProjectId?: () => number | undefined };

type ActionBackupWrites = {
  listAllActionsFull: () => Promise<Array<Record<string, any>>>;
  createActionFromBackup: (row: Record<string, any>) => Promise<{ id: string }>;
};

const NOT_CONNECTED = 'Not connected to a product. Use qa_connect({ url, token, projectId }) first.';

type Snapshot = {
  savedAt: string;
  projectId?: number | string | undefined;
  actions: Array<Record<string, any>>;
};

const keyOf = (r: Record<string, any>): string => {
  const tpl = r['objectTemplate'] ?? '';
  const uniq = String(r['uniqueId'] ?? '').trim();
  if (uniq) return `${tpl}|u|${uniq.toLowerCase()}`;
  return `${tpl}|n|${String(r['name'] ?? '').trim().toLowerCase()}`;
};

const defaultPath = (projectId: string | number | undefined): string =>
  join(homedir(), '.simplify3x-connect', 'action-backups', `actions-${projectId ?? 'project'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

export function registerActionBackupTools(server: McpServer, deps: ActionBackupDeps): void {
  server.registerTool(
    'action_template_backup',
    {
      title: 'Back up / verify / restore the Action catalogue (Object Templates)',
      description:
        'Protects the project\'s ACTIONS (the Object Template lists: WEB Click / Enter Text / … plus custom methods) ' +
        'against a bad "Sync Actions" run, which SimplifyQA applies server-side and can replace a template\'s list.\n' +
        '- action:"save" — writes a JSON snapshot of every action (name, display name, uniqueId, template, parameters) ' +
        'and reports the count per template. Do this BEFORE an AI/agent sync.\n' +
        '- action:"verify" — compares a snapshot with the live catalogue and lists the actions missing per template. ' +
        'Read-only.\n' +
        '- action:"restore" — re-CREATES the missing actions from the snapshot (never deletes or edits). Dry-run by ' +
        'default; pass `confirm:true` to write.\n' +
        '`snapshotPath` is returned by save and accepted by verify/restore (default: the newest snapshot of this project).',
      inputSchema: {
        action: z.enum(['save', 'verify', 'restore']).describe('What to do.'),
        snapshotPath: z.string().optional().describe('verify / restore: the JSON file written by save. Default: newest for this project.'),
        dryRun: z.boolean().optional().describe('restore: report only (default true).'),
        confirm: z.boolean().optional().describe('restore: true to actually re-create the missing actions.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ action, snapshotPath, dryRun, confirm }) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & Partial<ActionBackupWrites>) | null;
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.listAllActionsFull || !adapter.createActionFromBackup) {
        return err('action_template_backup is available only on a SimplifyQA connection.');
      }
      try {
        if (action === 'save') {
          const rows = await adapter.listAllActionsFull();
          const path = snapshotPath ?? defaultPath(deps.getProjectId?.());
          await mkdir(join(path, '..'), { recursive: true });
          const snap: Snapshot = { savedAt: new Date().toISOString(), projectId: deps.getProjectId?.(), actions: rows };
          await writeFile(path, JSON.stringify(snap, null, 2), 'utf8');
          const byTpl = new Map<string, number>();
          for (const r of rows) {
            const k = String(r['objectTemplate'] ?? '(none)');
            byTpl.set(k, (byTpl.get(k) ?? 0) + 1);
          }
          return ok(
            `Saved ${rows.length} action(s) to ${path}.\n` +
              [...byTpl.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([t, n]) => `  • template ${t}: ${n}`).join('\n') +
              '\nRun action:"verify" after the sync to see whether anything was dropped.',
            { snapshotPath: path, actions: rows.length, perTemplate: Object.fromEntries(byTpl) } as unknown as Record<string, unknown>,
          );
        }

        const path = snapshotPath ?? (await newestSnapshot(deps.getProjectId?.()));
        let snap: Snapshot;
        try {
          snap = JSON.parse(await readFile(path, 'utf8')) as Snapshot;
        } catch (e) {
          return err(`Could not read the snapshot at ${path}: ${e instanceof Error ? e.message : String(e)}. Run action:"save" first.`);
        }
        const live = await adapter.listAllActionsFull();
        const liveKeys = new Set(live.map(keyOf));
        const missing = (snap.actions ?? []).filter((r) => !liveKeys.has(keyOf(r)));

        if (action === 'verify') {
          if (!missing.length) {
            return ok(`No action is missing: all ${live.length} live action(s) covered by ${path}.`, { missing: [], live: live.length } as unknown as Record<string, unknown>);
          }
          const byTpl = groupByTemplate(missing);
          return ok(
            `${missing.length} action(s) from ${path} are NOT in the live catalogue:\n` +
              [...byTpl.entries()].map(([t, rows]) => `  • template ${t}: ${rows.map((r) => r['name'] ?? r['uniqueId'] ?? r['id']).join(', ')}`).join('\n') +
              '\nRun action:"restore" (dryRun first) to re-create them.',
            { missing: missing.map((r) => ({ template: r['objectTemplate'], name: r['name'], uniqueId: r['uniqueId'], id: r['id'] })) } as unknown as Record<string, unknown>,
          );
        }

        if (!missing.length) return ok(`Nothing to restore — every action in ${path} already exists.`);
        if (dryRun !== false && confirm !== true) {
          const byTpl = groupByTemplate(missing);
          return ok(
            `DRY RUN — nothing written. Would re-create ${missing.length} action(s):\n` +
              [...byTpl.entries()].map(([t, rows]) => `  • template ${t}: ${rows.map((r) => r['name'] ?? r['uniqueId']).join(', ')}`).join('\n') +
              '\nCall again with confirm:true to write them.',
            { dryRun: true, missing: missing.length } as unknown as Record<string, unknown>,
          );
        }
        if (confirm !== true) return err('restore needs `confirm:true` (or dryRun:true) — nothing was written.');

        const created: Array<{ name: string; template: unknown; id: string }> = [];
        const failed: Array<{ name: string; error: string }> = [];
        for (const row of missing) {
          try {
            const r = await adapter.createActionFromBackup(row);
            created.push({ name: String(row['name'] ?? row['uniqueId'] ?? ''), template: row['objectTemplate'], id: r.id });
          } catch (e) {
            failed.push({ name: String(row['name'] ?? row['uniqueId'] ?? ''), error: e instanceof Error ? e.message : String(e) });
          }
        }
        const after = await adapter.listAllActionsFull();
        return ok(
          `Restored ${created.length} of ${missing.length} action(s)${failed.length ? `; ${failed.length} failed` : ''}. Live catalogue: ${after.length} action(s).\n` +
            (created.length ? `Re-created: ${created.map((c) => `${c.name} (template ${c.template})`).join(', ')}` : '') +
            (failed.length ? `\nFailed: ${failed.map((f) => `${f.name} — ${f.error}`).join('; ')}` : ''),
          { created, failed, live: after.length } as unknown as Record<string, unknown>,
        );
      } catch (e) {
        return err(`action_template_backup failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

function groupByTemplate(rows: Array<Record<string, any>>): Map<string, Array<Record<string, any>>> {
  const m = new Map<string, Array<Record<string, any>>>();
  for (const r of rows) {
    const k = String(r['objectTemplate'] ?? '(none)');
    const list = m.get(k) ?? [];
    list.push(r);
    m.set(k, list);
  }
  return m;
}

async function newestSnapshot(projectId: string | number | undefined): Promise<string> {
  const dir = join(homedir(), '.simplify3x-connect', 'action-backups');
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(dir)).filter((f) => f.startsWith(`actions-${projectId ?? 'project'}-`) && f.endsWith('.json')).sort();
  if (!files.length) throw new Error(`No snapshot for project ${projectId ?? '?'} in ${dir} — run action:"save" first.`);
  return join(dir, files[files.length - 1]!);
}
