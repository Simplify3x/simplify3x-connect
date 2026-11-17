// tc_heal proxy tests. Covers the client-facing contract of common-mcp's heal proxy:
//   • not-connected → NOT_CONNECTED err (no product call invoked)
//   • connected but adapter has no heal provider → NOT_SUPPORTED err
//   • connected + heal provider present → the proxy drives HealService: it validates the product's
//     `heal_propose` payload, builds + stores the plan, and returns it (the product agent still owns
//     the diagnosis/proposals shape)
//   • mode:'suggest' writes NOTHING; mode:'apply' applies the planned change-set
//   • a provider error → err with the message
// The heal LOOP itself is product-agent code; those tests live in simplifyqa-mcp-server.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { HealApplyMode, HealPlan, HealReport } from '../domain/heal.js';
import type { HealFacts } from '../adapters/simplifyqa/heal/plan.js';
import { registerHealTools } from './heal.tools.js';

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

function captureHandler(name: string): { server: McpServer; get: () => Handler } {
  let handler: Handler | undefined;
  const server = {
    registerTool: (n: string, _meta: unknown, h: Handler) => { if (n === name) handler = h; },
  } as unknown as McpServer;
  return { server, get: () => { if (!handler) throw new Error(`${name} handler not registered`); return handler; } };
}

function textOf(res: CallToolResult): string {
  const t = res.content?.find((c: { type: string }) => c.type === 'text') as { text?: string } | undefined;
  return t?.text ?? '';
}

const emptyFacts = (tcId: string): HealFacts => ({ tcId, steps: [], objects: {}, actionNames: [] });

describe('tc_heal — common-mcp proxy', () => {
  it('errors when no adapter is connected', async () => {
    const cap = captureHandler('tc_heal');
    registerHealTools(cap.server, { getAdapter: () => null });
    const res = await cap.get()({ tcId: 'TC_1' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Not connected');
  });

  it('errors when the adapter has no heal provider (product does not implement heal)', async () => {
    const cap = captureHandler('tc_heal');
    const adapter = {} as unknown as ProviderAdapter; // no proposeHeal / getHealFacts / applyHealPlan
    registerHealTools(cap.server, { getAdapter: () => adapter });
    const res = await cap.get()({ tcId: 'TC_1' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('does not implement healing yet');
    expect(textOf(res)).toContain('heal_propose');
  });

  it('builds and returns the plan in suggest mode; strips undefined fields and writes nothing', async () => {
    const cap = captureHandler('tc_heal');
    const proposedInputs: unknown[] = [];
    const factsCalls: Array<{ tcId: string; opts: unknown }> = [];
    let applied = 0;

    const adapter = {
      proposeHeal: async (input: unknown) => {
        proposedInputs.push(input);
        return {
          contractVersion: 1,
          diagnosis: { family: 'locator', confidence: 0.8, reason: 'Element id changed from #login to #login-btn' },
          proposals: [],
        };
      },
      getHealFacts: async (tcId: string, opts?: unknown) => {
        factsCalls.push({ tcId, opts });
        return emptyFacts(tcId);
      },
      applyHealPlan: async () => { applied += 1; throw new Error('suggest must not apply'); },
    } as unknown as ProviderAdapter;

    registerHealTools(cap.server, { getAdapter: () => adapter });
    const res = await cap.get()({
      tcId: 'TC_1',
      runId: 'run-42',
      mode: 'suggest',
      // These undefineds must be stripped, not forwarded:
      domains: undefined,
      url: undefined,
      maxAttemptsPerStep: undefined,
      testProposals: undefined,
      testFamily: undefined,
    });

    expect(res.isError).toBeFalsy();
    // The product is asked for a proposal on exactly the given target — no undefined keys, and
    // `mode` is proxy-side policy (suggest = no apply), so it is not part of the propose contract.
    expect(proposedInputs).toHaveLength(1);
    expect(proposedInputs[0]).toStrictEqual({ contractVersion: 1, tcId: 'TC_1', runId: 'run-42' });
    expect(factsCalls).toHaveLength(1);
    expect(factsCalls[0]!.tcId).toBe('TC_1');
    expect(factsCalls[0]!.opts).toStrictEqual({ runId: 'run-42' });

    const sc = res.structuredContent as { plan?: HealPlan };
    expect(sc.plan).toBeDefined();
    expect(sc.plan!.tcId).toBe('TC_1');
    expect(sc.plan!.runId).toBe('run-42');
    expect(sc.plan!.diagnosis.family).toBe('locator');
    // No validated change survived, so the plan reports nothing to apply (healable is only true
    // when the family is healable AND at least one change landed).
    expect(sc.plan!.diagnosis.healable).toBe(false);
    expect(sc.plan!.changes).toHaveLength(0);
    expect(textOf(res)).toContain(`Heal plan \`${sc.plan!.planId}\` for TC_1 · run run-42`);
    // Suggest is read-only.
    expect(applied).toBe(0);
  });

  it('applies the planned change-set through applyHealPlan when mode is apply', async () => {
    const cap = captureHandler('tc_heal');
    const appliedPlans: HealPlan[] = [];
    const appliedModes: Array<HealApplyMode | undefined> = [];

    const adapter = {
      proposeHeal: async () => ({
        contractVersion: 1,
        diagnosis: { family: 'action_mismatch', confidence: 0.9, reason: 'the step lost its action' },
        proposals: [{ domain: 'action', op: 'repoint_action', step: 2, actionType: 'Click' }],
      }),
      getHealFacts: async (tcId: string): Promise<HealFacts> => ({
        tcId,
        steps: [{ n: 2, actionType: 'ClickOld', description: 'click login' }],
        objects: {},
        actionNames: ['Click', 'ClickOld'],
      }),
      applyHealPlan: async (plan: HealPlan, opts?: { mode?: HealApplyMode }) => {
        appliedPlans.push(plan);
        appliedModes.push(opts?.mode);
        const report: HealReport = {
          contractVersion: 1,
          planId: plan.planId,
          tcId: plan.tcId,
          mode: opts?.mode ?? 'apply',
          versionId: 'ver-2',
          applied: plan.changes,
          skipped: [],
          createdAt: new Date().toISOString(),
        };
        return report;
      },
    } as unknown as ProviderAdapter;

    registerHealTools(cap.server, { getAdapter: () => adapter });
    const res = await cap.get()({ tcId: 'TC_1', mode: 'apply' });

    expect(res.isError).toBeFalsy();
    expect(appliedPlans).toHaveLength(1);
    expect(appliedModes[0]).toBe('apply');
    expect(appliedPlans[0]!.changes).toHaveLength(1);
    expect(appliedPlans[0]!.changes[0]!.domain).toBe('action');
    expect(appliedPlans[0]!.changes[0]!.op).toBe('repoint_action');
    expect(appliedPlans[0]!.changes[0]!.target).toBe('step 2');
    const sc = res.structuredContent as { plan?: HealPlan; report?: HealReport };
    expect(sc.report?.versionId).toBe('ver-2');
    expect(textOf(res)).toContain('New version: `ver-2`');
  });

  it('surfaces adapter errors as err(message)', async () => {
    const cap = captureHandler('tc_heal');
    const adapter = {
      proposeHeal: async () => { throw new Error('agent unreachable'); },
      getHealFacts: async (tcId: string) => emptyFacts(tcId),
      applyHealPlan: async () => { throw new Error('must not apply'); },
    } as unknown as ProviderAdapter;
    registerHealTools(cap.server, { getAdapter: () => adapter });
    const res = await cap.get()({ tcId: 'TC_1' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('agent unreachable');
  });
});
