/**
 * Heal service: propose (product server, browser-bound) → plan (validated change-set) → apply
 * (REST, one new version) → status. The service owns the contract boundary; the adapter owns the
 * product calls.
 */
import {
  HEAL_CONTRACT_VERSION,
  assertContract,
  type HealApplyMode,
  type HealPlan,
  type HealProposeInput,
  type HealReport,
} from '../../../domain/heal.js';
import { buildHealPlan, type HealFacts } from './plan.js';
import { normaliseDiagnosis, normaliseProposals } from './diagnose.js';
import { loadPlan, loadStatus, savePlan, saveReport, type HealStored } from './store.js';

export type HealProvider = {
  /** Raw `heal_propose` response from the product server (validated here, never trusted). */
  proposeHeal(input: HealProposeInput): Promise<unknown>;
  getHealFacts(tcId: string, opts?: { runId?: string | undefined }): Promise<HealFacts>;
  applyHealPlan(plan: HealPlan, opts?: { mode?: HealApplyMode | undefined }): Promise<HealReport>;
};

export type PlanOptions = {
  tcId: string;
  runId?: string | undefined;
  domains?: HealProposeInput['domains'];
  url?: string | undefined;
  maxAttemptsPerStep?: number | undefined;
  /** TEST ONLY (QA_HEAL_TEST_HOOK=1): bypass `heal_propose` and plan these raw proposals.
   *  Lets the MCP-side pipeline be verified end-to-end before the product server ships propose. */
  testProposals?: unknown[] | undefined;
  testFamily?: string | undefined;
};

export class HealService {
  constructor(private readonly provider: HealProvider) {}

  async plan(opts: PlanOptions): Promise<HealPlan> {
    const input: HealProposeInput = {
      contractVersion: HEAL_CONTRACT_VERSION,
      tcId: opts.tcId,
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(opts.domains ? { domains: opts.domains } : {}),
      ...(opts.url ? { url: opts.url } : {}),
      ...(opts.maxAttemptsPerStep !== undefined ? { maxAttemptsPerStep: opts.maxAttemptsPerStep } : {}),
    };

    let diagnosis;
    let proposals;
    let dropped;
    if (opts.testProposals) {
      diagnosis = normaliseDiagnosis({
        family: opts.testFamily ?? 'object_state',
        confidence: 0.9,
        reason: 'test-hook (heal_propose bypassed)',
      });
      ({ proposals, dropped } = normaliseProposals(opts.testProposals));
    } else {
      const raw = (await this.provider.proposeHeal(input)) as Record<string, unknown> | null;
      if (!raw || typeof raw !== 'object') {
        throw new Error('heal_propose returned no payload — the product server may not implement it yet.');
      }
      assertContract(raw['contractVersion']);
      diagnosis = normaliseDiagnosis(raw['diagnosis']);
      ({ proposals, dropped } = normaliseProposals(raw['proposals']));
    }

    const facts: HealFacts = await this.provider.getHealFacts(
      opts.tcId,
      opts.runId ? { runId: opts.runId } : {},
    );

    const plan = buildHealPlan({
      tcId: opts.tcId,
      ...(opts.runId ? { runId: opts.runId } : {}),
      diagnosis,
      proposals,
      facts,
      ...(opts.domains ? { domains: opts.domains } : {}),
    });
    for (const d of dropped) plan.skipped.push(d);

    await savePlan(plan);
    return plan;
  }

  async apply(planId: string, mode: HealApplyMode = 'apply'): Promise<HealReport> {
    const plan = await loadPlan(planId);
    if (!plan.changes.length) {
      const report: HealReport = {
        contractVersion: HEAL_CONTRACT_VERSION,
        planId: plan.planId,
        tcId: plan.tcId,
        mode,
        applied: [],
        skipped: [
          ...plan.skipped,
          { reason: plan.diagnosis.healable ? 'nothing to apply' : `not healable: ${plan.diagnosis.family}` },
        ],
        createdAt: new Date().toISOString(),
      };
      await saveReport(report);
      return report;
    }
    const report = await this.provider.applyHealPlan(plan, { mode });
    await saveReport(report);
    return report;
  }

  async status(planId: string): Promise<HealStored> {
    return loadStatus(planId);
  }
}
