/**
 * Self-healing contract shared by the MCP tools, the planner and the product adapter.
 *
 * A heal is a CHANGE-SET, not a single locator patch: objects (locators + properties), actions
 * (per STEP only — the shared action catalog is never written), parameters, and the test data of
 * the iteration that actually failed. The planner validates every proposal against live data and
 * returns a reviewable plan; apply turns that plan into ONE new test-case version.
 *
 * `contractVersion` is carried over the wire to the product server (`heal_propose`); a mismatch
 * fails loudly instead of silently parsing an old shape.
 */
import { createHash } from 'node:crypto';

export const HEAL_CONTRACT_VERSION = 1 as const;

export type HealDomain = 'object' | 'action' | 'parameter' | 'testdata';

/** Families the healer can reason about. The first four are healable (each unlocks domains);
 *  the rest are diagnosed and reported but intentionally produce no changes. */
export type HealFamily =
  | 'object_state'
  | 'action_mismatch'
  | 'param_binding'
  | 'test_data'
  | 'locator'
  | 'assertion'
  | 'timeout'
  | 'session'
  | 'interaction'
  | 'authoring'
  | 'config'
  | 'manual'
  | 'unrecognised'
  | 'app_bug'
  | 'env'
  | 'flaky';

const DOMAINS_BY_FAMILY: Record<HealFamily, HealDomain[]> = {
  object_state: ['object'],
  locator: ['object'],
  action_mismatch: ['action'],
  param_binding: ['parameter', 'testdata'],
  test_data: ['testdata'],
  assertion: [],
  timeout: [],
  session: [],
  interaction: [],
  authoring: [],
  config: [],
  manual: [],
  unrecognised: [],
  app_bug: [],
  env: [],
  flaky: [],
};

export function domainsForFamily(family: HealFamily): HealDomain[] {
  return DOMAINS_BY_FAMILY[family] ?? [];
}

export function isHealable(family: HealFamily): boolean {
  return domainsForFamily(family).length > 0;
}

export type HealLocator = { name: string; value: string; unique?: boolean | undefined };

export type HealPropertyPatch = {
  name?: string | undefined;
  description?: string | undefined;
  parameterNames?: string[] | undefined;
};

/** What the product server proposes (read-only). `before` is deliberately absent: the planner
 *  reads live data so a stale proposal can never overwrite a value it did not see. */
export type HealProposal =
  | { domain: 'object'; op: 'append_locator'; objectId: string; step?: number | undefined; locator: HealLocator; reason?: string | undefined; confidence?: number | undefined }
  | { domain: 'object'; op: 'set_default'; objectId: string; step?: number | undefined; locatorName: string; reason?: string | undefined; confidence?: number | undefined }
  | { domain: 'object'; op: 'update_property'; objectId: string; step?: number | undefined; property: HealPropertyPatch; reason?: string | undefined; confidence?: number | undefined }
  | { domain: 'action'; op: 'repoint_action'; step: number; actionType: string; actionUniqueId?: string | undefined; reason?: string | undefined; confidence?: number | undefined }
  | { domain: 'parameter'; op: 'create'; name: string; defaultValue?: string | undefined; reason?: string | undefined; confidence?: number | undefined }
  | { domain: 'parameter'; op: 'rebind'; name: string; fromToken: string; reason?: string | undefined; confidence?: number | undefined }
  | { domain: 'testdata'; op: 'set_cell'; paramName: string; iterations: number[]; value: string; reason?: string | undefined; confidence?: number | undefined };

export type HealDiagnosis = {
  family: HealFamily;
  confidence: number;
  reason?: string | undefined;
  evidence?: Array<Record<string, unknown>> | undefined;
};

/** A validated, resolvable change. `detail` is the domain-specific payload apply consumes. */
export type HealChange = {
  domain: HealDomain;
  op: HealProposal['op'];
  /** Human anchor used in reports: `object 8812`, `step 6`, `parameter randomName`, `ITR-2`. */
  target: string;
  detail: Record<string, unknown>;
  /** Live values read at plan time. Apply restores these when a later stage fails. */
  before?: Record<string, unknown> | undefined;
  reason?: string | undefined;
  confidence?: number | undefined;
};

export type HealSkip = {
  domain?: string | undefined;
  op?: string | undefined;
  target?: string | undefined;
  reason: string;
};

export type ObjectUsage = {
  objectId: string;
  sharedWithTestcases: string[];
  scanned: number;
  truncated: boolean;
};

export type HealBlastRadius = {
  objects: ObjectUsage[];
};

export type HealPlan = {
  contractVersion: typeof HEAL_CONTRACT_VERSION;
  planId: string;
  tcId: string;
  runId?: string | undefined;
  baseVersionId?: string | undefined;
  diagnosis: HealDiagnosis & { healable: boolean };
  changes: HealChange[];
  skipped: HealSkip[];
  blastRadius: HealBlastRadius;
  createdAt: string;
};

export type HealApplyMode = 'apply' | 'apply_and_verify';

export type HealReport = {
  contractVersion: typeof HEAL_CONTRACT_VERSION;
  planId: string;
  tcId: string;
  mode: HealApplyMode;
  versionId?: string | undefined;
  productUrl?: string | undefined;
  runId?: string | undefined;
  verified?: boolean | undefined;
  /** True when the version landed but a later stage (test data patch / verify) did not. */
  partial?: boolean | undefined;
  applied: HealChange[];
  skipped: HealSkip[];
  error?: string | undefined;
  createdAt: string;
};

export type HealProposeInput = {
  contractVersion: typeof HEAL_CONTRACT_VERSION;
  tcId: string;
  runId?: string | undefined;
  domains?: HealDomain[] | undefined;
  url?: string | undefined;
  maxAttemptsPerStep?: number | undefined;
};

export type HealProposeResult = {
  contractVersion: typeof HEAL_CONTRACT_VERSION;
  diagnosis: HealDiagnosis;
  replay?: { itr?: number | undefined; iteration?: string | undefined; failedStep?: number | undefined; screenshot?: string | undefined } | undefined;
  proposals: HealProposal[];
};

/** Deterministic plan identity: re-applying the same plan cannot mint a second version. */
export function planIdFor(tcId: string, baseVersionId: string | undefined, changes: HealChange[]): string {
  const payload = JSON.stringify({
    tcId,
    baseVersionId: baseVersionId ?? null,
    changes: changes.map((c) => ({ domain: c.domain, op: c.op, target: c.target, detail: c.detail })),
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/** Order apply runs in. Dependencies point forward, so a change can rely on everything above it. */
export const HEAL_APPLY_ORDER: HealDomain[] = ['parameter', 'object', 'action', 'testdata'];

export function assertContract(version: unknown): void {
  if (version !== HEAL_CONTRACT_VERSION) {
    throw new Error(
      `heal contract mismatch: the product server speaks v${String(version)}, this MCP speaks v${HEAL_CONTRACT_VERSION}. ` +
        'Update simplifyqa-mcp-server (or common-mcp) so both sides agree — refusing to parse a mismatched proposal.',
    );
  }
}
