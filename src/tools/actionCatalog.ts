import type { ProviderAdapter } from '../adapters/types.js';
import type { Step } from '../domain/types.js';
import { offlineCatalogFor } from '../adapters/walnut/actionTypes.js';

/** Maps a neutral Step to the set of action-type names valid for it. An EMPTY set means
 *  "no vocabulary available — nothing to check" (validate.ts honours that; it never invents a
 *  rejection from an empty catalog). */
export type CatalogFor = (s: Step) => Set<string>;

/** Shared "nothing to check" catalog. */
const EMPTY_CATALOG: CatalogFor = () => new Set<string>();

/**
 * Successful per-connection SimplifyQA catalogs, keyed by adapter IDENTITY. A reconnect /
 * project switch mints a new adapter instance, so a stale catalog is never reused; only NON-EMPTY
 * results are cached, so a transient fetch failure retries on the next call instead of disabling
 * the check for the rest of the session.
 */
const catalogCache = new WeakMap<ProviderAdapter, CatalogFor>();

/**
 * Provider-aware action-type catalog for draft validation.
 *
 * WHY THIS EXISTS: draft validation used to run EVERY step through Walnut's static action table
 * (`offlineCatalogFor`). SimplifyQA's action vocabulary is the BACKEND's own — e.g. its API action
 * is `executerestapi`, not Walnut's `api_call` — so any SQA step whose name isn't also a Walnut
 * name was falsely rejected with `actionType "…" not in catalog`, blocking `tc_save`.
 *
 * - Walnut (or unknown provider): the static `offlineCatalogFor`, unchanged.
 * - SimplifyQA with a live adapter: validate against the real backend catalog
 *   (`adapter.actionsCatalog()`) — exactly the set `resolveAutomationSteps` resolves names against
 *   at save time, so the pre-check and the save agree.
 * - SimplifyQA with no live catalog (agent down / offline): return an EMPTY catalog
 *   ("nothing to check") rather than the wrong Walnut vocabulary. The SQA adapter's own
 *   `resolveAutomationSteps` remains the authoritative action check at save time.
 */
export async function resolveCatalogFor(
  adapter: ProviderAdapter | null,
  isSimplifyqa: boolean,
): Promise<CatalogFor> {
  if (!isSimplifyqa) return offlineCatalogFor;
  if (!adapter || typeof adapter.actionsCatalog !== 'function') return EMPTY_CATALOG;

  const cached = catalogCache.get(adapter);
  if (cached) return cached;

  try {
    const defs = await adapter.actionsCatalog();
    // Accept BOTH the canonical action name ("launchApplication") and its display name ("Go to URL"):
    // a recorded step (journal → draft) carries the display name, and the save path resolves it the
    // same way, so the pre-check and the save agree.
    const names = new Set(
      defs
        .flatMap((d) => [d.actionType, d.description])
        .map((n) => (n ?? '').trim().toLowerCase())
        .filter((n) => n.length > 0),
    );
    if (!names.size) return EMPTY_CATALOG;
    const fn: CatalogFor = () => names;
    catalogCache.set(adapter, fn);
    return fn;
  } catch {
    // Could not fetch the live catalog — do NOT fall back to the Walnut table (it would falsely
    // reject valid SQA actions). Skip the name check; the save path validates for real.
    return EMPTY_CATALOG;
  }
}
