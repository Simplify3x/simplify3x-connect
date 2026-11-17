/**
 * `failure_analysis` — the failure analysis of a SimplifyQA test case, suite or execution-plan run.
 *
 * This file only reads the arguments and hands back what the adapter builds: the ANALYSIS CARD +
 * evidence text and the top causes' screenshots (adapters/simplifyqa/failureReport.ts). The tool
 * itself does not assert a root cause.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, okWithImages, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { ExecutionFailureInput } from '../adapters/simplifyqa/failureTypes.js';
import type { FailureReport } from '../adapters/simplifyqa/failureReport.js';

export type FailureToolsDeps = {
  getAdapter: () => ProviderAdapter | null;
};

const NOT_CONNECTED =
  'Not connected to a product. Use qa_connect({ url, token, projectId }) first — failure_analysis needs a live SimplifyQA connection.';

/** The number in an id / business key ("TC-12" → "12"); anything without one is kept as given. */
const idNumber = (id: string): string => /\d+/.exec(id)?.[0] ?? id;

export function registerFailureTools(server: McpServer, deps: FailureToolsDeps): void {
  server.registerTool(
    'failure_analysis',
    {
      title: 'Analyse a failed SimplifyQA test case, suite or execution plan',
      description:
        'Analyse FAILED executions on SimplifyQA — test case, suite or execution plan. Pass `code` = TC-123 / SU-123 / PL-123 (PL = execution plan) for its LATEST execution (standalone test case run; parent execution for a suite or plan), or `executionId` (number or EX code) for ONLY that execution; both together analyse that code inside that execution. ' +
        'A test case gets every iteration; a suite or plan gets every failed test case with all of its failed iterations, grouped by cause.\n\n' +
        'The result starts with an ANALYSIS CARD (tables: "Why … failed", "Failed test cases" with Report Step No. and Test case step, each failed iteration). ' +
        'YOUR REPLY MUST START WITH THAT CARD EXACTLY AS RETURNED — same tables and rows, not reworded or summarised — and then add Why / Fix per cause from the evidence that follows it.',
      inputSchema: {
        code: z.string().optional().describe('TC-123, SU-123 or PL-123 (execution plan). Without executionId, its latest execution is analysed.'),
        executionId: z.string().optional().describe('Execution id or EX code. When set, only this execution is analysed.'),
        runId: z.string().optional().describe('Same as executionId (kept for older calls).'),
        tcId: z.string().optional().describe('Test case id — same as code TC-<id>.'),
        suiteId: z.string().optional().describe('Suite id — same as code SU-<id>.'),
        includeLogs: z.boolean().optional().describe('Include execution logs (default true).'),
        maxLogLines: z.number().int().positive().max(2000).optional().describe('Cap logs per step — the lines nearest the failure are kept (default 30).'),
        includeScreenshots: z.boolean().optional().describe('Include screenshot artifact URLs (default true).'),
        includeImages: z.boolean().optional().describe('Return the failure screenshot of each top cause group as an inline image (default true, max 5). Set false for text and links only.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const adapter = deps.getAdapter() as
        | (ProviderAdapter & {
            getFailureReport?: (input: ExecutionFailureInput & { includeImages?: boolean }) => Promise<FailureReport>;
          })
        | null;
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.getFailureReport) {
        return err('failure_analysis is available only on a SimplifyQA connection.');
      }
      const code = args.code
        ?? (args.tcId !== undefined ? `TC-${idNumber(args.tcId)}` : undefined)
        ?? (args.suiteId !== undefined ? `SU-${idNumber(args.suiteId)}` : undefined);
      // `runId` is an execution id: one analysis, one layout (the old single-run view had no tables).
      const executionId = args.executionId ?? args.runId;
      if (code === undefined && executionId === undefined) {
        return err('Provide `code` (TC-123 / SU-123 / PL-123) or `executionId` (an execution id or EX code).');
      }
      try {
        const report = await adapter.getFailureReport({
          ...(code !== undefined ? { code } : {}),
          ...(executionId !== undefined ? { executionId } : {}),
          ...(args.includeLogs !== undefined ? { includeLogs: args.includeLogs } : {}),
          ...(args.maxLogLines !== undefined ? { maxLogLines: args.maxLogLines } : {}),
          ...(args.includeScreenshots !== undefined ? { includeScreenshots: args.includeScreenshots } : {}),
          ...(args.includeImages !== undefined ? { includeImages: args.includeImages } : {}),
        });
        // Text only, no structuredContent: clients that find a structured result hand THAT to the
        // model instead of the text, and the card, FLOW and evidence are in the text.
        return report.images.length ? okWithImages(report.text, report.images) : ok(report.text);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
