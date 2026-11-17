import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { err, ok } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import { HealService, type HealProvider } from '../adapters/simplifyqa/heal/index.js';
import type { HealApplyMode, HealPlan, HealReport } from '../domain/heal.js';

/**
 * HEAL surface — three steps so nothing is written by accident:
 *
 *   heal_plan   → propose (product server, read-only replay) + validate → a reviewable change-set
 *   heal_apply  → that exact plan → ONE new test-case version (+ failing-iteration test data)
 *   heal_status → the stored plan and, once applied, its report
 *
 * `tc_heal` is kept as a one-shot alias for older prompts: it plans, and only applies when the
 * caller asks for a write mode.
 *
 * The write path lives in this MCP (it already owns every REST verb). The product server only
 * *proposes* — it has the browser, it must not persist anything.
 */
export type HealToolsDeps = {
  getAdapter: () => ProviderAdapter | null;
};

const NOT_CONNECTED =
  'Not connected to a product. Use qa_connect({ url, token, projectId }) first — healing a test case needs a live backend connection.';

const NOT_SUPPORTED =
  'This product/agent does not implement healing yet: the product server must expose `heal_propose` (contract v1). ' +
  'Healing is available on SimplifyQA with the local agent (QA_MCP_URL) running.';

const DOMAIN = z.enum(['object', 'action', 'parameter', 'testdata']);

/** Local test seam: lets the MCP-side pipeline be exercised before the product server ships
 *  `heal_propose`. Off unless the operator opts in. */
const TEST_HOOK_ENABLED = (): boolean => process.env['QA_HEAL_TEST_HOOK'] === '1';
const TEST_HOOK_ERR =
  '`testProposals` is a local test seam: set QA_HEAL_TEST_HOOK=1 in the MCP server environment and restart it.';

function testProposalSchema() {
  return z
    .array(z.any())
    .optional()
    .describe(
      'TEST ONLY (needs QA_HEAL_TEST_HOOK=1): plan these raw proposals instead of calling heal_propose. ' +
        'The full validation/apply pipeline runs exactly as in production; only the browser-driven proposal step is skipped.',
    );
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function pct(n: number | undefined): string {
  return n === undefined ? '' : ` (${Math.round(n * 100)}%)`;
}

function renderPlan(plan: HealPlan): string {
  const lines: string[] = [];
  const d = plan.diagnosis;
  lines.push(`Heal plan \`${plan.planId}\` for ${plan.tcId}${plan.runId ? ` · run ${plan.runId}` : ''}`);
  lines.push(
    `Diagnosis: **${d.family}**${pct(d.confidence)} — ${d.healable ? 'healable' : 'not healable'}` +
      (d.reason ? ` · ${d.reason}` : ''),
  );

  if (!plan.changes.length) {
    lines.push('', 'No changes proposed — nothing would be written.');
  } else {
    lines.push('', `**${plan.changes.length} change(s)** (applied in this order):`);
    for (const c of plan.changes) {
      const why = c.reason ? ` — ${c.reason}` : '';
      const detail = JSON.stringify(c.detail);
      lines.push(`- ${c.domain}/${c.op} · ${c.target}${pct(c.confidence)}${why}\n  \`${detail}\``);
    }
  }

  if (plan.skipped.length) {
    lines.push('', `**Skipped (${plan.skipped.length}):**`);
    for (const s of plan.skipped.slice(0, 15)) {
      lines.push(`- ${[s.domain, s.op, s.target].filter(Boolean).join(' ')} — ${s.reason}`);
    }
    if (plan.skipped.length > 15) lines.push(`- … ${plan.skipped.length - 15} more`);
  }

  if (plan.blastRadius.objects.length) {
    lines.push('', '**Shared-object blast radius:**');
    for (const o of plan.blastRadius.objects) {
      const users = o.sharedWithTestcases.length
        ? `also used by ${o.sharedWithTestcases.slice(0, 10).join(', ')}${o.sharedWithTestcases.length > 10 ? ', …' : ''}`
        : `no other test case found (${o.scanned} scanned${o.truncated ? ', scan truncated' : ''})`;
      lines.push(`- object ${o.objectId}: ${users}`);
    }
  }

  lines.push(
    '',
    plan.changes.length
      ? `Review it, then call heal_apply({ planId: "${plan.planId}" }) — it creates a NEW version and never edits the current one.`
      : 'Nothing to apply.',
  );
  return lines.join('\n');
}

function renderReport(report: HealReport): string {
  const lines: string[] = [];
  lines.push(
    `Heal ${report.mode === 'apply_and_verify' ? 'applied + verified' : 'applied'} · plan \`${report.planId}\` · ${report.tcId}`,
  );
  if (report.versionId) lines.push(`New version: \`${report.versionId}\` (the TC's default version is unchanged — pass this versionId to run the healed flow)`);
  if (report.productUrl) lines.push(`Open: ${report.productUrl}`);
  if (report.verified !== undefined) lines.push(`Verified: ${report.verified ? 'yes' : 'no'}`);
  if (report.partial) lines.push('**Partial:** the version landed, but a later stage did not complete.');

  lines.push('', `Applied ${report.applied.length} change(s):`);
  for (const c of report.applied) lines.push(`- ${c.domain}/${c.op} · ${c.target}`);

  if (report.skipped.length) {
    lines.push('', `Skipped (${report.skipped.length}):`);
    for (const s of report.skipped.slice(0, 15)) lines.push(`- ${[s.domain, s.op, s.target].filter(Boolean).join(' ')} — ${s.reason}`);
    if (report.skipped.length > 15) lines.push(`- … ${report.skipped.length - 15} more`);
  }
  if (report.error) lines.push('', `Error: ${report.error}`);
  return lines.join('\n');
}

function healService(adapter: ProviderAdapter): HealService | string {
  if (!adapter.proposeHeal || !adapter.getHealFacts || !adapter.applyHealPlan) return NOT_SUPPORTED;
  return new HealService(adapter as unknown as HealProvider);
}

export function registerHealTools(server: McpServer, deps: HealToolsDeps): void {
  server.registerTool(
    'heal_plan',
    {
      title: 'Plan a heal for a failed test case (read-only)',
      description:
        'Replays a failed test case live, captures the DOM at the failing step, and returns a REVIEWABLE heal plan: ' +
        'objects (locators + properties), per-step actions, parameters, and the test data of the failing iteration only. ' +
        'This call never writes — apply it with `heal_apply({ planId })`.\n\n' +
        'Use it when a test failed for a reason the healer may fix (locator/object changed, wrong action, unresolved ' +
        '`${param}`, bad test-data value). It also reports a diagnosis when the failure is NOT healable (app bug, ' +
        'environment, bad business data), with the reason.\n\n' +
        'Rules baked in: the shared action catalog is never modified, shared parameters are never renamed ' +
        '(create + rebind instead), and only the iteration that failed may have test data patched.',
      inputSchema: {
        tcId: z.string().describe('The failing test case id (TC-123).'),
        runId: z.string().optional().describe('Specific failed run. Omit to use the latest failed run.'),
        domains: z
          .array(DOMAIN)
          .optional()
          .describe('Limit which domains may change (default: all). e.g. ["parameter","testdata"] to skip locator churn.'),
        url: z.string().url().optional().describe('Override start URL when the test case has no navigate step.'),
        maxAttemptsPerStep: z.number().int().min(1).max(5).optional().describe('Replay retries at the failing step. Default 3.'),
        testProposals: testProposalSchema(),
        testFamily: z.string().optional().describe('TEST ONLY: family to report alongside testProposals (default object_state).'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      const svc = healService(adapter);
      if (typeof svc === 'string') return err(svc);
      if (args.testProposals && !TEST_HOOK_ENABLED()) return err(TEST_HOOK_ERR);
      try {
        const plan = await svc.plan({
          tcId: args.tcId,
          ...(args.runId ? { runId: args.runId } : {}),
          ...(args.domains ? { domains: args.domains } : {}),
          ...(args.url ? { url: args.url } : {}),
          ...(args.maxAttemptsPerStep !== undefined ? { maxAttemptsPerStep: args.maxAttemptsPerStep } : {}),
          ...(args.testProposals ? { testProposals: args.testProposals } : {}),
          ...(args.testFamily ? { testFamily: args.testFamily } : {}),
        });
        return ok(renderPlan(plan), { plan });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'heal_apply',
    {
      title: 'Apply a heal plan (creates a NEW version)',
      description:
        'Applies a plan from `heal_plan` as ONE new test-case version: objects first, then step/action bindings, ' +
        'then the failing iteration\'s test data. The current version is never edited, so a running execution is ' +
        'not affected. `mode:"apply_and_verify"` also re-runs the test case and reports `verified` only when the ' +
        'healed step passes WITHOUT falling back to another locator.\n\n' +
        'Refuses a stale plan (the test case moved to a different version since planning) — re-run heal_plan then.',
      inputSchema: {
        planId: z.string().describe('planId returned by heal_plan.'),
        mode: z.enum(['apply', 'apply_and_verify']).optional().describe("Default 'apply'."),
        confirmSharedObject: z
          .boolean()
          .optional()
          .describe('Required when the plan changes an object also used by other test cases (blast radius non-empty).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      const svc = healService(adapter);
      if (typeof svc === 'string') return err(svc);
      try {
        const stored = await svc.status(args.planId);
        const shared = stored.plan.blastRadius.objects.filter((o) => o.sharedWithTestcases.length > 0);
        if (shared.length && args.confirmSharedObject !== true) {
          const list = shared
            .map((o) => `object ${o.objectId} is also used by: ${o.sharedWithTestcases.join(', ')}`)
            .join('; ');
          return err(
            `This plan changes a SHARED object — ${list}. Confirm with confirmSharedObject:true if that is intended.`,
          );
        }
        const mode: HealApplyMode = args.mode ?? 'apply';
        const report = await svc.apply(args.planId, mode);
        return ok(renderReport(report), { report });
      } catch (e) {
        const msg = describeError(e);
        if (/ENOENT/i.test(msg)) return err(`No heal plan \`${args.planId}\` on disk — run heal_plan first (plans expire with the machine's temp state).`);
        return err(msg);
      }
    },
  );

  server.registerTool(
    'heal_status',
    {
      title: 'Read a heal plan and its result',
      description: 'Returns the stored plan for a planId and, once applied, the apply report (version, verified, partial).',
      inputSchema: { planId: z.string().describe('planId returned by heal_plan.') },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        const adapter = deps.getAdapter();
        if (!adapter) return err(NOT_CONNECTED);
        const svc = healService(adapter);
        if (typeof svc === 'string') return err(svc);
        const stored = await svc.status(args.planId);
        const text = stored.report ? `${renderPlan(stored.plan)}\n\n${renderReport(stored.report)}` : renderPlan(stored.plan);
        return ok(text, stored);
      } catch (e) {
        return err(`No heal plan \`${args.planId}\`: ${describeError(e)}`);
      }
    },
  );

  // ---- one-shot alias (older prompts: "heal the testcase") ----------------------------------
  server.registerTool(
    'tc_heal',
    {
      title: 'Diagnose and heal a failed test-case run',
      description:
        'One-shot alias for heal_plan + heal_apply. Default `mode:"suggest"` only diagnoses and proposes — it writes ' +
        'NOTHING. Pass `mode:"apply"` (new version) or `mode:"apply_and_verify"` (new version + re-run) to write.\n\n' +
        'Covers objects (locators/properties), actions (per step only — the catalog is never modified), parameters, ' +
        'and the test data of the failing iteration. Every response carries a classification and rationale, even when ' +
        'the failure is not healable (app bug, bad business data, environment).',
      inputSchema: {
        tcId: z.string().describe('The failing test case id.'),
        runId: z.string().optional().describe('Specific failed run to heal against.'),
        mode: z
          .enum(['suggest', 'apply', 'apply_and_verify'])
          .optional()
          .describe("Default 'suggest' (no writes). 'apply' persists a NEW version; 'apply_and_verify' also re-runs."),
        domains: z.array(DOMAIN).optional().describe('Limit which domains may change (default: all).'),
        url: z.string().url().optional().describe('Override start URL for the replay.'),
        maxAttemptsPerStep: z.number().int().min(1).max(5).optional().describe('Replay retries at the failing step. Default 3.'),
        confirmSharedObject: z
          .boolean()
          .optional()
          .describe('Required when applying a plan that changes an object used by other test cases.'),
        testProposals: testProposalSchema(),
        testFamily: z.string().optional().describe('TEST ONLY: family to report alongside testProposals (default object_state).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args): Promise<CallToolResult> => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      const svc = healService(adapter);
      if (typeof svc === 'string') return err(svc);
      if (args.testProposals && !TEST_HOOK_ENABLED()) return err(TEST_HOOK_ERR);
      try {
        const plan = await svc.plan({
          tcId: args.tcId,
          ...(args.runId ? { runId: args.runId } : {}),
          ...(args.domains ? { domains: args.domains } : {}),
          ...(args.url ? { url: args.url } : {}),
          ...(args.maxAttemptsPerStep !== undefined ? { maxAttemptsPerStep: args.maxAttemptsPerStep } : {}),
          ...(args.testProposals ? { testProposals: args.testProposals } : {}),
          ...(args.testFamily ? { testFamily: args.testFamily } : {}),
        });
        const mode = args.mode ?? 'suggest';
        if (mode === 'suggest') return ok(renderPlan(plan), { plan });

        const shared = plan.blastRadius.objects.filter((o) => o.sharedWithTestcases.length > 0);
        if (shared.length && args.confirmSharedObject !== true) {
          const list = shared.map((o) => `object ${o.objectId} is also used by: ${o.sharedWithTestcases.join(', ')}`).join('; ');
          return err(`Plan \`${plan.planId}\` changes a SHARED object — ${list}. Re-run with confirmSharedObject:true to apply.`);
        }
        const report = await svc.apply(plan.planId, mode);
        return ok(`${renderPlan(plan)}\n\n${renderReport(report)}`, { plan, report });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );
}
