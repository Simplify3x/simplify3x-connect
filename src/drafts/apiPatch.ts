import type { Step } from '../domain/types.js';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Merge `b` into `a` key by key (nested objects merged, arrays and scalars replaced). */
function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  return out;
}

/**
 * The `api` of a step after applying `patch.api` to it — so "add an assertion" / "change the URL" edits the SAVED request
 * in place instead of replacing it with whatever the patch happens to carry (which would drop the URL, headers, body and
 * the existing assertions, i.e. rebuild the step). `addAssertions` appends to the current list; `assertions` replaces it.
 * Returns undefined when the patch does not touch `api`.
 */
export function mergeApiPatch(cur: Step, patch: Partial<Step>): Record<string, unknown> | undefined {
  if (!patch.api) return undefined;
  const base = (cur.api ?? (cur.sourceRaw as Record<string, unknown> | undefined)?.['apiData'] ?? {}) as Record<string, unknown>;
  const { addAssertions, ...rest } = patch.api as Record<string, unknown>;
  const merged = deepMerge(base, rest);
  if (Array.isArray(addAssertions) && addAssertions.length) {
    const current = Array.isArray(merged['assertions']) ? (merged['assertions'] as unknown[]) : [];
    merged['assertions'] = [...current, ...addAssertions];
  }
  return merged;
}
