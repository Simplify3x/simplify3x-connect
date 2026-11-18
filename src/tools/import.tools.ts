/**
 * `excel_import` — bulk import from a spreadsheet (.xlsx / .csv / .tsv) into SimplifyQA.
 *
 * Three kinds, each mirroring what the UI's Import does for that screen:
 *   • testcases    — one MANUAL test case per row: name, description, steps (one per line or `|`),
 *                    expected result, module, story, prerequisites. Reports created / rejected.
 *   • testdata     — one ITERATION per row for one test case + environment; every column is a
 *                    parameter name (columns are matched case-insensitively to the TC's parameters).
 *   • plan_entries — one test case code per row, added to an EXECUTION PLAN (`planId`).
 *
 * Read / parse happens here; every write goes through the SAME adapter calls the single-item tools
 * use (createTestCase / saveGeneratedIterations / addPlanEntries), so validation and read-back are
 * identical. `dryRun` parses and reports without writing.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { TestCase } from '../domain/types.js';
import { readSpreadsheet } from '../adapters/simplifyqa/spreadsheet.js';

export type ImportDeps = { getAdapter: () => ProviderAdapter | null };

type ImportWrites = {
  createTestCase: (tc: TestCase) => Promise<{ id: string }>;
  getTestCase: (id: string) => Promise<TestCase>;
  saveGeneratedIterations?: (payload: {
    tcId: string; versionId: string; environmentType?: string;
    rows: Array<Record<string, string>>;
  }) => Promise<{ iterations?: unknown[] } & Record<string, unknown>>;
  addPlanEntries?: (planId: string, input: { tcIds?: string[]; suiteIds?: string[] }) => Promise<{ added: string[]; skipped: Array<{ code: string; reason: string }> }>;
};

const NOT_CONNECTED = 'Not connected to a product. Use qa_connect({ url, token, projectId }) first.';

const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');

export function registerImportTools(server: McpServer, deps: ImportDeps): void {
  server.registerTool(
    'excel_import',
    {
      title: 'Import test cases / test data / plan entries from a spreadsheet (.xlsx, .csv, .tsv)',
      description:
        'Bulk-import a spreadsheet into SimplifyQA — the MCP equivalent of the UI\'s Import.\n' +
        '`kind:"testcases"` — one MANUAL test case per row. Recognised headers (case/spacing-insensitive): ' +
        '`name`/`title` (required), `description`, `steps` (one step per line, or `|` separated), ' +
        '`expected result`, `module`, `story`/`userstory`, `prerequisites`. A step column is prose, so the ' +
        'imported cases are MANUAL (automation needs real locators — record those).\n' +
        '`kind:"testdata"` — one ITERATION per row for ONE test case: needs `tcId` + `environmentType`; every ' +
        'column is a parameter name (matched case-insensitively).\n' +
        '`kind:"plan_entries"` — the first column is a test case code/id; needs `planId` (execution plan).\n' +
        'Reports what was created / added and every rejected row with its reason. `dryRun:true` parses + ' +
        'reports without writing. The first row is the header unless `headerRow:false`.',
      inputSchema: {
        filePath: z.string().min(1).describe('Absolute path to the .xlsx / .csv / .tsv file on this machine.'),
        kind: z.enum(['testcases', 'testdata', 'plan_entries']).describe('What to import.'),
        tcId: z.string().optional().describe('testdata: the target test case (id or code).'),
        environmentType: z.string().optional().describe('testdata: env key from tc_list_environments (required).'),
        planId: z.string().optional().describe('plan_entries: the execution plan id/code.'),
        module: z.string().optional().describe('testcases: default module/folder id or name for rows without a module column.'),
        storyRef: z.string().optional().describe('testcases: default user story id/code for rows without a story column.'),
        headerRow: z.boolean().optional().describe('Treat the first row as headers (default true).'),
        dryRun: z.boolean().optional().describe('Parse and report only — nothing is written.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ filePath, kind, tcId, environmentType, planId, module, storyRef, headerRow, dryRun }) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & Partial<ImportWrites>) | null;
      if (!adapter) return err(NOT_CONNECTED);
      let sheet;
      try {
        sheet = await readSpreadsheet(filePath);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
      const all = sheet.rows.filter((r) => r.some((c) => c.trim() !== ''));
      if (!all.length) return err('The spreadsheet is empty.');
      const hasHeader = headerRow !== false;
      const header = hasHeader ? all[0]!.map((h) => h.trim()) : [];
      const data = hasHeader ? all.slice(1) : all;
      if (!data.length) return err('The spreadsheet has no data rows below the header.');

      const colIndex = (...names: string[]): number => {
        if (!hasHeader) return -1;
        const wanted = names.map(norm);
        return header.findIndex((h) => wanted.includes(norm(h)));
      };
      const cell = (row: string[], at: number): string => (at >= 0 ? (row[at] ?? '').trim() : '');

      try {
        if (kind === 'testcases') {
          const iName = colIndex('name', 'title', 'testcase', 'testcasename');
          const iDesc = colIndex('description', 'desc');
          const iSteps = colIndex('steps', 'step', 'teststeps', 'procedure');
          const iExpected = colIndex('expected', 'expectedresult', 'expectedoutcome');
          const iModule = colIndex('module', 'moduleid', 'folder', 'folderid');
          const iStory = colIndex('story', 'userstory', 'us');
          const iPre = colIndex('prerequisites', 'precondition', 'preconditions');
          if (hasHeader && iName < 0) {
            return err(`No "name" (or "title") column found. Header was: ${header.join(', ')}`);
          }
          const created: Array<{ row: number; id: string; title: string }> = [];
          const rejected: Array<{ row: number; reason: string }> = [];
          for (let r = 0; r < data.length; r++) {
            const row = data[r]!;
            const title = cell(row, iName) || (hasHeader ? '' : (row[0] ?? '').trim());
            if (!title) { rejected.push({ row: r + (hasHeader ? 2 : 1), reason: 'missing name' }); continue; }
            const stepText = cell(row, iSteps) || (!hasHeader ? row.slice(1).join('\n') : '');
            const stepLines = stepText
              .split(/\r?\n/)
              .flatMap((line) => (line.includes('|') && !/\r?\n/.test(stepText) ? line.split('|') : [line]))
              .map((s) => s.trim())
              .filter(Boolean);
            const expected = cell(row, iExpected);
            const tc: TestCase = {
              title,
              category: 'manual',
              ...(cell(row, iDesc) ? { description: cell(row, iDesc) } : {}),
              ...(cell(row, iPre) ? { preconditions: cell(row, iPre) } : {}),
              ...(cell(row, iModule) || module ? { folderOrModule: cell(row, iModule) || module! } : {}),
              ...(cell(row, iStory) || storyRef ? { storyRef: cell(row, iStory) || storyRef! } : {}),
              steps: stepLines.map((description, i) => ({
                n: i + 1, description, expectedResult: expected, stepType: 'manual', actionType: 'manual',
              })),
            };
            if (dryRun) { created.push({ row: r + (hasHeader ? 2 : 1), id: '(dry run)', title }); continue; }
            try {
              const saved = await adapter.createTestCase(tc);
              created.push({ row: r + (hasHeader ? 2 : 1), id: saved.id, title });
            } catch (e) {
              rejected.push({ row: r + (hasHeader ? 2 : 1), reason: e instanceof Error ? e.message : String(e) });
            }
          }
          return ok(
            `${dryRun ? 'DRY RUN — nothing written. ' : ''}Imported ${created.length} of ${data.length} test case row(s).` +
              (rejected.length ? `\nRejected ${rejected.length}: ${rejected.map((x) => `row ${x.row} (${x.reason})`).join('; ')}` : '') +
              (created.length ? `\nCreated: ${created.map((c) => `${c.id} "${c.title}"`).join(', ')}` : ''),
            { created, rejected } as unknown as Record<string, unknown>,
          );
        }

        if (kind === 'testdata') {
          if (!tcId) return err('kind:"testdata" needs `tcId` (the test case to fill).');
          if (!environmentType) return err('kind:"testdata" needs `environmentType` (an env key from tc_list_environments).');
          if (!adapter.saveGeneratedIterations) return err('This product cannot append test-data iterations.');
          const tc = await adapter.getTestCase(tcId);
          const versionId = tc.currentVersionId ?? tc.versions?.[0]?.id;
          if (!versionId) return err(`Could not resolve a version for ${tcId}.`);
          const params = header.map((h) => h.trim()).filter(Boolean);
          if (!params.length) return err('The header must name the parameter columns.');
          const rows: Array<Record<string, string>> = [];
          const rejected: Array<{ row: number; reason: string }> = [];
          for (let r = 0; r < data.length; r++) {
            const row = data[r]!;
            const values: Record<string, string> = {};
            let any = false;
            params.forEach((p, i) => {
              const v = cell(row, i);
              if (v !== '') any = true;
              values[p] = v;
            });
            if (!any) { rejected.push({ row: r + 2, reason: 'empty row' }); continue; }
            rows.push(values);
          }
          if (!rows.length) return err('No non-empty test-data rows to import.');
          if (dryRun) {
            return ok(`DRY RUN — nothing written. ${rows.length} iteration row(s) for ${tcId} in ${environmentType}: ${rows.map((x) => JSON.stringify(x)).join('; ')}`, { rows } as unknown as Record<string, unknown>);
          }
          const res = await adapter.saveGeneratedIterations({ tcId, versionId, environmentType, rows });
          return ok(
            `Imported ${rows.length} test-data iteration row(s) for ${tcId} into environment ${environmentType}.` +
              (rejected.length ? `\nSkipped ${rejected.length}: ${rejected.map((x) => `row ${x.row} (${x.reason})`).join('; ')}` : ''),
            { rows: rows.length, result: res } as unknown as Record<string, unknown>,
          );
        }

        // plan_entries
        if (!planId) return err('kind:"plan_entries" needs `planId` (the execution plan to add the test cases to).');
        if (!adapter.addPlanEntries) return err('This product cannot add entries to an execution plan.');
        const codes = data.map((row) => (row[0] ?? '').trim()).filter(Boolean);
        if (!codes.length) return err('No test case codes/ids found in the first column.');
        if (dryRun) return ok(`DRY RUN — nothing written. Would add ${codes.length} test case(s) to plan ${planId}: ${codes.join(', ')}`, { codes } as unknown as Record<string, unknown>);
        const res = await adapter.addPlanEntries(planId, { tcIds: codes });
        return ok(
          `Added ${res.added.length} test case(s) to execution plan ${planId}.` +
            (res.skipped.length ? `\nSkipped: ${res.skipped.map((s) => `${s.code} (${s.reason})`).join(', ')}` : '') +
            (res.added.length ? `\nAdded: ${res.added.join(', ')}` : ''),
          res as unknown as Record<string, unknown>,
        );
      } catch (e) {
        return err(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
