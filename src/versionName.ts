import type { TestCase } from './domain/types.js';

/**
 * The next version name for a test case / function, as a MAJOR increment: `v1.0 → v2.0 → v3.0 …`.
 *
 * Used when a story update is applied as a NEW VERSION instead of an in-place edit, and by
 * `tc_save_as_new_version` when the caller doesn't name the version. The backend rejects duplicate
 * version names per TC, so this always returns a name that isn't on the row yet (a stray
 * hand-named `v2.0` bumps to `v3.0`).
 *
 * Only plain `v<major>.<minor>` names participate in the max; anything else (e.g. `Baseline`,
 * `v1.1 - hotfix`) is ignored so a human-named version never derails the sequence.
 */
export function nextVersionName(tc: Pick<TestCase, 'versions'> | null | undefined): string {
  const names = Array.isArray(tc?.versions) ? tc!.versions : [];
  let maxMajor = 0;
  let found = false;
  for (const v of names) {
    const m = /^v(\d+)\.(\d+)$/i.exec(String(v?.name ?? '').trim());
    if (!m) continue;
    found = true;
    maxMajor = Math.max(maxMajor, Number.parseInt(m[1]!, 10));
  }
  // A TC that has only `v1.0` → v2.0. A TC with no parseable version at all → v2.0 (v1.0 is the
  // implicit first version a TC is created with).
  return `v${(found ? maxMajor : 1) + 1}.0`;
}

/**
 * The id of the TC's LATEST version (highest `v<major>.<minor>`), or undefined when it has no
 * parseable version. Story sync must analyse the newest content: after an update is saved as a new
 * version, the default read still returns `versions[0]` (v1.0), so comparing against that would keep
 * re-reporting drift that has already been fixed.
 */
export function latestVersionId(
  tc: Pick<TestCase, 'versions'> | null | undefined,
): string | undefined {
  const versions = Array.isArray(tc?.versions) ? tc!.versions : [];
  let best: { major: number; minor: number; id?: string | undefined } | null = null;
  for (const v of versions) {
    const m = /^v(\d+)\.(\d+)$/i.exec(String(v?.name ?? '').trim());
    if (!m) continue;
    const major = Number.parseInt(m[1]!, 10);
    const minor = Number.parseInt(m[2]!, 10);
    if (!best || major > best.major || (major === best.major && minor > best.minor)) {
      best = { major, minor, id: v?.id };
    }
  }
  return best?.id;
}
