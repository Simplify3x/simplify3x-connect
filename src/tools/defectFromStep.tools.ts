/**
 * `defect_create_from_step` / `defect_link_step` — log a defect from a failed step of an execution report, or link a failed step to an
 * existing defect.
 *
 * The MCP could only read and delete defects, so a failure found through it had to be logged and linked by hand in the report. These do what
 * the report's "Log Defect" and "link defect" do: the defect is pre-filled with the test case + version, the steps to replicate, the execution,
 * environment, browser, expected / actual, the error and the step's screenshots; the defect id goes onto the step result; and the test case
 * lists the defect — so the link shows from the defect, the test case and the execution report.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { DefectFromStepInput, DefectFromStepResult, DefectLinkInput, DefectLinkResult } from '../adapters/simplifyqa/adapter.js';

export type DefectFromStepToolDeps = { getAdapter: () => ProviderAdapter | null };

type StepDefects = {
  logDefectFromStep: (input: DefectFromStepInput) => Promise<DefectFromStepResult>;
  linkDefectToStep: (input: DefectLinkInput) => Promise<DefectLinkResult>;
};

const NOT_CONNECTED = 'Not connected to a product. Use qa_connect({ url, token, projectId }) first — this needs a live SimplifyQA connection.';
const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function registerDefectFromStepTools(server: McpServer, deps: DefectFromStepToolDeps): void {
  server.registerTool(
    'defect_create_from_step',
    {
      title: 'Log a defect from a failed execution step',
      description:
        'Log a DEFECT from a FAILED step of an execution — what "Log Defect" in the execution report does — and link it to that step. Pass ' +
        '`executionId` (EX-170 or 170) and `step` (the step number in the report; it must have failed). If the execution ran several test cases, ' +
        'also pass `tc`. The defect is pre-filled from the report: test case + version, steps to replicate up to the failure, execution, environment, ' +
        'browser, expected vs actual and the error message, and the step\'s screenshots; its release / sprint / module come from the execution / ' +
        'test case. Optional: `name` (default "TC-41 step 7 failed: … (EX-170)"; a defect with that name already existing is refused — link it ' +
        'with defect_link_step instead), `description` (extra notes), `state` / `priority` / `severity` (the project\'s own values, default = ' +
        'the project\'s defaults), `assignee` (email, name, user id or "me"). Needs the add_defect privilege. Returns the defect key (DE-xx); the ' +
        'test case then lists it too. To attach a step to a defect that already exists, use defect_link_step.',
      inputSchema: {
        executionId: z.string().describe('Execution id or code: EX-170 or 170.'),
        step: z.number().int().min(1).describe('Step number as shown in the report; it must be a FAILED step.'),
        tc: z.string().optional().describe('Test case id or code (TC-41) — only when the execution ran several test cases.'),
        name: z.string().optional().describe('Defect name (3–500 characters).'),
        description: z.string().optional().describe('Extra notes added to the defect description.'),
        state: z.string().optional(),
        priority: z.string().optional(),
        severity: z.string().optional(),
        assignee: z.string().optional().describe('Email, name, numeric user id or "me".'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & Partial<StepDefects>) | null;
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.logDefectFromStep) return err('This product does not expose logging a defect from a step.');
      try {
        const input: DefectFromStepInput = { executionId: args.executionId, step: args.step };
        for (const [k, v] of Object.entries(args)) if (k !== 'executionId' && k !== 'step' && v !== undefined) (input as Record<string, unknown>)[k] = v;
        const r = await adapter.logDefectFromStep(input);
        const head = `Logged defect ${r.defectCode} "${r.name}" from step ${r.step} of ${r.execution} (${r.testCase}) — state ${r.state || '-'}, priority ${r.priority || '-'}, ` +
          `${r.attachments} attachment${r.attachments === 1 ? '' : 's'}; ${r.linkedToStep ? `linked to step ${r.step}` : `NOT linked to step ${r.step}`}.`;
        return ok([head, ...r.warnings.map((w) => `⚠️ ${w}`)].join('\n'), { ...r } as unknown as Record<string, unknown>);
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'defect_link_step',
    {
      title: 'Link a failed execution step to an existing defect',
      description:
        'Link a FAILED step of an execution to a defect that ALREADY EXISTS (e.g. DE-60) — what "link defect" on the report step does — and make ' +
        'sure the step\'s test case + version is on the defect\'s TEST CASE field, so the link shows from the defect, the test case and the execution ' +
        'report. Pass `executionId` (EX-170 or 170), `step` (must have failed) and `defectId` (id, code or exact name); `tc` only when the ' +
        'execution ran several test cases. Linking a step that is already linked changes nothing. To create a new defect from the step, use ' +
        'defect_create_from_step.',
      inputSchema: {
        executionId: z.string().describe('Execution id or code: EX-170 or 170.'),
        step: z.number().int().min(1).describe('Step number as shown in the report; it must be a FAILED step.'),
        defectId: z.string().describe('The existing defect: id, code (DE-60) or exact name.'),
        tc: z.string().optional().describe('Test case id or code (TC-41) — only when the execution ran several test cases.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & Partial<StepDefects>) | null;
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.linkDefectToStep) return err('This product does not expose linking a defect to a step.');
      try {
        const r = await adapter.linkDefectToStep({ executionId: args.executionId, step: args.step, defectId: args.defectId, ...(args.tc ? { tc: args.tc } : {}) });
        const parts = [
          r.stepLinked ? `step ${r.step} of ${r.execution} is now linked to ${r.defectCode}` : `step ${r.step} of ${r.execution} was already linked to ${r.defectCode}`,
          r.testCaseLinked ? `${r.testCase} was added to the defect's test cases` : `${r.testCase} was already on the defect`,
        ];
        return ok([`Defect ${r.defectCode} "${r.defectName}": ${parts.join('; ')}.`, ...r.warnings.map((w) => `⚠️ ${w}`)].join('\n'), { ...r } as unknown as Record<string, unknown>);
      } catch (e) {
        return err(describeError(e));
      }
    },
  );
}
