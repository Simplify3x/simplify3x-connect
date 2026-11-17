/**
 * The test-plan folder tree (`scenarioFolder`, TP-N), ported from ai-assistant
 * `src/tools/_lib/plantree.py`. Pure functions over folder rows.
 *
 * - A TEST PLAN is a top-level folder (`isRoot`); folders inside it are sub-folders.
 * - The parent/child edge is stored twice — `childIds` on the parent, `parentId` on the child —
 *   and neither is complete across the data, so both are read. `leafNode` is unreliable: leaves
 *   are read from the structure.
 * - Nothing rolls up by itself: a plan that files everything in sub-folders holds 0 directly, so
 *   both the direct and the whole-subtree counts are carried.
 * - `suiteIds` holds plain ids; `testcaseIds` holds `{ id, version, versionId }` objects.
 */

export type Folder = Record<string, unknown>;

export type FolderStats = {
  suites: number;
  testCases: number;
  suitesWithSubFolders: number;
  testCasesWithSubFolders: number;
  subFolders: number;
  /** Folder names from the plan (root) down to this folder. */
  path: string;
};

const idOf = (f: Folder): number | undefined => (typeof f['id'] === 'number' ? (f['id'] as number) : undefined);

/** The ids in a membership array, whichever shape it has (ids or `{ id }` objects). */
export function memberIds(entries: unknown): number[] {
  if (!Array.isArray(entries)) return [];
  const out = new Set<number>();
  for (const e of entries) {
    const v = e && typeof e === 'object' ? (e as Folder)['id'] : e;
    const n = Number(v);
    if (v !== null && v !== '' && Number.isFinite(n)) out.add(n);
  }
  return [...out];
}

/** folder id → child ids, from BOTH directions of the edge (dangling ids and self-links dropped). */
export function childrenOf(rows: Folder[]): Map<number, number[]> {
  const known = new Set(rows.map(idOf).filter((x): x is number => x !== undefined));
  const out = new Map<number, number[]>();
  const seen = new Set<string>();
  const link = (parent: unknown, child: unknown) => {
    const [p, c] = [Number(parent), Number(child)];
    if (parent == null || child == null || !Number.isFinite(p) || !Number.isFinite(c) || p === c) return;
    if (!known.has(c) || seen.has(`${p}:${c}`)) return;
    seen.add(`${p}:${c}`);
    out.set(p, [...(out.get(p) ?? []), c]);
  };
  for (const r of rows) {
    for (const kid of Array.isArray(r['childIds']) ? r['childIds'] : []) link(r['id'], kid);
    link(r['parentId'], r['id']);
  }
  return out;
}

/** Every folder below `id` (not including it). Cycles cannot hang it. */
export function descendants(id: number, children: Map<number, number[]>): number[] {
  const out: number[] = [];
  const seen = new Set<number>([id]);
  const stack = [...(children.get(id) ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    stack.push(...(children.get(next) ?? []));
  }
  return out;
}

/** Direct and whole-subtree membership counts, sub-folder count and path, for every folder. */
export function folderStats(rows: Folder[]): Map<number, FolderStats> {
  const byId = new Map<number, Folder>();
  for (const r of rows) { const id = idOf(r); if (id !== undefined) byId.set(id, r); }
  const children = childrenOf(rows);
  const parent = new Map<number, number>();
  for (const [p, kids] of children) for (const k of kids) parent.set(k, p);

  const path = (id: number): string => {
    const names: string[] = [];
    const seen = new Set<number>();
    for (let cur: number | undefined = id; cur !== undefined && !seen.has(cur); cur = parent.get(cur)) {
      seen.add(cur);
      const f = byId.get(cur);
      names.push(String(f?.['name'] ?? f?.['code'] ?? `#${cur}`));
    }
    return names.reverse().join(' / ');
  };

  const out = new Map<number, FolderStats>();
  for (const [id, f] of byId) {
    const below = descendants(id, children);
    const suites = new Set(memberIds(f['suiteIds']));
    const tcs = new Set(memberIds(f['testcaseIds']));
    const allSuites = new Set(suites);
    const allTcs = new Set(tcs);
    for (const d of below) {
      for (const s of memberIds(byId.get(d)?.['suiteIds'])) allSuites.add(s);
      for (const t of memberIds(byId.get(d)?.['testcaseIds'])) allTcs.add(t);
    }
    out.set(id, {
      suites: suites.size,
      testCases: tcs.size,
      suitesWithSubFolders: allSuites.size,
      testCasesWithSubFolders: allTcs.size,
      subFolders: below.length,
      path: path(id),
    });
  }
  return out;
}
