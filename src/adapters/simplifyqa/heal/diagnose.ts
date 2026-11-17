/**
 * Normalises what the product server sends over `heal_propose` into the strict contract. The server
 * is a separate process (and a separate release cadence), so nothing here trusts its payload: an
 * unknown family/domain/op is dropped with a reason instead of reaching the planner half-built.
 */
import {
  HEAL_CONTRACT_VERSION,
  type HealDiagnosis,
  type HealDomain,
  type HealFamily,
  type HealProposal,
} from '../../../domain/heal.js';

const FAMILIES: HealFamily[] = [
  'object_state', 'action_mismatch', 'param_binding', 'test_data',
  'locator', 'assertion', 'timeout', 'session', 'interaction',
  'authoring', 'config', 'manual', 'unrecognised', 'app_bug', 'env', 'flaky',
];

const ALIASES: Record<string, HealFamily> = {
  locator: 'locator',
  element_not_found: 'locator',
  not_found: 'locator',
  object: 'object_state',
  object_state: 'object_state',
  attributes: 'object_state',
  action: 'action_mismatch',
  action_mismatch: 'action_mismatch',
  wrong_action: 'action_mismatch',
  parameter: 'param_binding',
  param: 'param_binding',
  param_binding: 'param_binding',
  unresolved_parameter: 'param_binding',
  data: 'test_data',
  test_data: 'test_data',
  testdata: 'test_data',
  assertion: 'assertion',
  timeout: 'timeout',
  timing: 'timeout',
  session: 'session',
  interaction: 'interaction',
  authoring: 'authoring',
  config: 'config',
  manual: 'manual',
  app_bug: 'app_bug',
  product_bug: 'app_bug',
  environment: 'env',
  env: 'env',
  flaky: 'flaky',
};

export function normaliseFamily(raw: unknown): HealFamily {
  const key = String(raw ?? '').trim().toLowerCase();
  if (FAMILIES.includes(key as HealFamily)) return key as HealFamily;
  return ALIASES[key] ?? 'unrecognised';
}

export function normaliseDiagnosis(raw: unknown): HealDiagnosis {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const confidenceRaw = Number(d['confidence']);
  const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0;
  const evidence = Array.isArray(d['evidence'])
    ? d['evidence'].filter((e): e is Record<string, unknown> => !!e && typeof e === 'object').slice(0, 50)
    : undefined;
  return {
    family: normaliseFamily(d['family']),
    confidence,
    ...(typeof d['reason'] === 'string' && d['reason'].trim() ? { reason: d['reason'].trim() } : {}),
    ...(evidence?.length ? { evidence } : {}),
  };
}

const DOMAINS = new Set<HealDomain>(['object', 'action', 'parameter', 'testdata']);
const MAX_PROPOSALS = 100;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function confidence(v: unknown): { confidence?: number } {
  const n = Number(v);
  if (!Number.isFinite(n)) return {};
  return { confidence: Math.min(1, Math.max(0, n)) };
}
function reason(v: unknown): { reason?: string } {
  const s = str(v);
  return s ? { reason: s } : {};
}

/** Validate one raw proposal; returns null (with a reason) when it cannot be trusted. */
export function normaliseProposal(raw: unknown): { proposal?: HealProposal; problem?: string } {
  if (!raw || typeof raw !== 'object') return { problem: 'proposal is not an object' };
  const p = raw as Record<string, unknown>;
  const domain = str(p['domain'])?.toLowerCase() as HealDomain | undefined;
  const op = str(p['op'])?.toLowerCase();
  if (!domain || !DOMAINS.has(domain)) return { problem: `unknown domain "${String(p['domain'])}"` };
  if (!op) return { problem: 'missing op' };

  if (domain === 'object') {
    const objectId = str(p['objectId']);
    if (!objectId) return { problem: 'object proposal needs objectId' };
    const step = num(p['step']);
    if (op === 'append_locator') {
      const loc = (p['locator'] ?? {}) as Record<string, unknown>;
      const name = str(loc['name']);
      const value = str(loc['value']);
      if (!name || !value) return { problem: 'append_locator needs locator.name and locator.value' };
      return {
        proposal: {
          domain, op: 'append_locator', objectId,
          ...(step !== undefined ? { step } : {}),
          locator: { name, value, ...(loc['unique'] === true ? { unique: true } : {}) },
          ...reason(p['reason']), ...confidence(p['confidence']),
        },
      };
    }
    if (op === 'set_default') {
      const locatorName = str(p['locatorName']);
      if (!locatorName) return { problem: 'set_default needs locatorName' };
      return {
        proposal: {
          domain, op: 'set_default', objectId,
          ...(step !== undefined ? { step } : {}),
          locatorName, ...reason(p['reason']), ...confidence(p['confidence']),
        },
      };
    }
    if (op === 'update_property') {
      const raw2 = (p['property'] ?? {}) as Record<string, unknown>;
      const property = {
        ...(str(raw2['name']) ? { name: str(raw2['name']) } : {}),
        ...(str(raw2['description']) ? { description: str(raw2['description']) } : {}),
        ...(Array.isArray(raw2['parameterNames'])
          ? { parameterNames: raw2['parameterNames'].map((n) => String(n)).filter(Boolean) }
          : {}),
      };
      if (!Object.keys(property).length) return { problem: 'update_property has no fields' };
      return {
        proposal: { domain, op: 'update_property', objectId, ...(step !== undefined ? { step } : {}), property, ...reason(p['reason']), ...confidence(p['confidence']) },
      };
    }
    return { problem: `unknown object op "${op}"` };
  }

  if (domain === 'action') {
    const step = num(p['step']);
    const actionType = str(p['actionType']);
    if (step === undefined) return { problem: 'action proposal needs step' };
    if (!actionType) return { problem: 'action proposal needs actionType' };
    const actionUniqueId = str(p['actionUniqueId']);
    return {
      proposal: {
        domain, op: 'repoint_action', step, actionType,
        ...(actionUniqueId ? { actionUniqueId } : {}),
        ...reason(p['reason']), ...confidence(p['confidence']),
      },
    };
  }

  if (domain === 'parameter') {
    const name = str(p['name']);
    if (!name) return { problem: 'parameter proposal needs name' };
    if (op === 'create') {
      const defaultValue = str(p['defaultValue']);
      return { proposal: { domain, op: 'create', name, ...(defaultValue !== undefined ? { defaultValue } : {}), ...reason(p['reason']), ...confidence(p['confidence']) } };
    }
    if (op === 'rebind') {
      const fromToken = str(p['fromToken']);
      if (!fromToken) return { problem: 'rebind needs fromToken' };
      return { proposal: { domain, op: 'rebind', name, fromToken, ...reason(p['reason']), ...confidence(p['confidence']) } };
    }
    return { problem: `unknown parameter op "${op}"` };
  }

  // testdata
  const paramName = str(p['paramName']);
  if (!paramName) return { problem: 'testdata proposal needs paramName' };
  const iterations = Array.isArray(p['iterations']) ? p['iterations'].map((n) => Number(n)).filter((n) => Number.isFinite(n)) : [];
  if (!iterations.length) return { problem: 'testdata proposal needs iterations[]' };
  return {
    proposal: {
      domain, op: 'set_cell', paramName, iterations,
      value: typeof p['value'] === 'string' ? p['value'] : String(p['value'] ?? ''),
      ...reason(p['reason']), ...confidence(p['confidence']),
    },
  };
}

export type NormalisedProposals = {
  proposals: HealProposal[];
  dropped: Array<{ reason: string }>;
};

export function normaliseProposals(raw: unknown): NormalisedProposals {
  if (!Array.isArray(raw)) return { proposals: [], dropped: [{ reason: 'heal_propose returned no proposals[]' }] };
  const proposals: HealProposal[] = [];
  const dropped: Array<{ reason: string }> = [];
  for (const entry of raw.slice(0, MAX_PROPOSALS)) {
    const res = normaliseProposal(entry);
    if (res.proposal) proposals.push(res.proposal);
    else dropped.push({ reason: res.problem ?? 'invalid proposal' });
  }
  if (raw.length > MAX_PROPOSALS) dropped.push({ reason: `proposal cap reached (${MAX_PROPOSALS})` });
  return { proposals, dropped };
}

/** One-line summary used by the tools and the agent instructions. */
export function summarise(diagnosis: HealDiagnosis, domains: HealDomain[]): string {
  const what = domains.length ? domains.join(' + ') : 'no healable domain';
  return `${diagnosis.family} (${Math.round(diagnosis.confidence * 100)}% confidence) → ${what}`;
}

export const contractVersion = HEAL_CONTRACT_VERSION;
