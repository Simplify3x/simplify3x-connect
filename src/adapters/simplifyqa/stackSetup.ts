/**
 * Stack Setup (the canvas behind Execution Type → Stack, for an execution plan or a suite) — the pure parts: what each
 * stack runs on, which browsers its picker offers, and how test cases are spread over the stacks. The wire shape is the
 * UI's (`ep-stack-execution.component.ts`): every stack carries `mode` (LOCAL / REMOTE / CLOUD), `agentId` (LOCAL: the
 * saving user's own agent, REMOTE: the chosen machine, CLOUD: null) and `executionPlatform: { LOCAL, REMOTE, CLOUD }`.
 */

export type StackMode = 'LOCAL' | 'REMOTE' | 'CLOUD';

/** What a caller says about ONE stack. Everything is optional; a missing mode / browser falls back to the setup-wide default. */
export type StackSpec = {
  mode?: 'local' | 'remote' | 'cloud' | StackMode | undefined;
  /** Browser for the WEB test cases on this stack — chrome, firefox, edge, safari, or a UI name such as "chrome headless". */
  browser?: string | undefined;
  /** REMOTE only: the machine to run on (its id or machine name — see remote_agents / local_agents). */
  agentId?: string | undefined;
  /** Test cases to put on THIS stack (codes like TC-39 or ids). When any stack lists some, every stack must. */
  testCases?: string[] | undefined;
};

export type UiBrowser = { key: string; name: string; technologyType: 'WEB'; type: 'NONE' };
const web = (key: string, name: string): UiBrowser => ({ key, name, technologyType: 'WEB', type: 'NONE' });

/** The browser picker of a LOCAL / REMOTE stack, as the UI lists it. */
const LOCAL_BROWSERS: UiBrowser[] = [
  web('CHROME', 'Chrome'), web('CHROME_HEADLESS', 'Chrome headless'), web('CHROME_INCOGNITO', 'Chrome incognito'),
  web('FIREFOX', 'Firefox'), web('FIREFOX_HEADLESS', 'Firefox headless'), web('FIREFOX_PRIVATE', 'Firefox private'),
  web('EDGE', 'Edge'), web('EDGE_HEADLESS', 'Edge headless'), web('EDGE_INCOGNITO', 'Edge incognito'),
  web('SAFARI', 'Safari'), web('SAFARI_INCOGNITO', 'Safari incognito'), web('INTERNET_EXPLORER', 'Internet Explorer'),
];
/** The browser picker of a CLOUD stack — headless only. */
const CLOUD_BROWSERS: UiBrowser[] = [
  web('CHROME_HEADLESS', 'Chrome Headless'), web('FIREFOX_HEADLESS', 'Firefox Headless'), web('EDGE_HEADLESS', 'Edge headless'),
];
const BROWSER_ALIASES: Record<string, string> = {
  chromium: 'CHROME', msedge: 'EDGE', webkit: 'SAFARI', ie: 'INTERNET_EXPLORER', headless_chrome: 'CHROME_HEADLESS',
  headless_firefox: 'FIREFOX_HEADLESS', headless_edge: 'EDGE_HEADLESS',
};

/** A browser name as a user says it → the UI's picker entry for this mode. A cloud stack is headless, so "chrome" there means
 *  Chrome Headless. Anything the picker does not offer is refused with what it does offer. */
export function pickBrowser(input: string | undefined, mode: StackMode): UiBrowser {
  const list = mode === 'CLOUD' ? CLOUD_BROWSERS : LOCAL_BROWSERS;
  const want = (input ?? 'chrome').trim().toLowerCase().replace(/[\s-]+/g, '_');
  let key = BROWSER_ALIASES[want] ?? want.toUpperCase();
  if (mode === 'CLOUD' && !key.endsWith('_HEADLESS')) key = `${key}_HEADLESS`;
  const hit = list.find((b) => b.key === key);
  if (!hit) {
    throw new Error(`"${input}" is not a browser a ${mode} stack offers. Choose from: ${list.map((b) => b.name).join(', ')}.`);
  }
  return hit;
}

export type ResolvedStack = { mode: StackMode; browser: UiBrowser; agentId: string | null; testCases?: string[] };

const asMode = (m: string | undefined, fallback: StackMode): StackMode => {
  if (m === undefined) return fallback;
  const up = m.toUpperCase();
  if (up === 'LOCAL' || up === 'REMOTE' || up === 'CLOUD') return up;
  throw new Error(`"${m}" is not a stack platform — use local, remote or cloud.`);
};

/** What each stack should be: one entry per stack, in order. `stackConfigs` wins; otherwise `count` copies of the default. */
export function resolveStacks(input: { count?: number | undefined; mode?: string | undefined; browser?: string | undefined; stackConfigs?: StackSpec[] | undefined }): ResolvedStack[] {
  const fallbackMode = asMode(input.mode, 'CLOUD');
  const specs = input.stackConfigs;
  if (specs?.length) {
    if (input.count !== undefined && Math.trunc(input.count) !== specs.length) {
      throw new Error(`stacks is ${input.count} but ${specs.length} stack configuration(s) were given — they must match (or leave stacks out).`);
    }
    return specs.map((s, i) => {
      const mode = asMode(s.mode, fallbackMode);
      if (mode === 'REMOTE' && !s.agentId?.trim()) {
        throw new Error(`Stack ${i + 1} is REMOTE, so it needs agentId — the machine it runs on (its id or machine name; see remote_agents).`);
      }
      if (mode !== 'REMOTE' && s.agentId) throw new Error(`Stack ${i + 1}: agentId is only for a REMOTE stack.`);
      return {
        mode, browser: pickBrowser(s.browser ?? input.browser, mode), agentId: s.agentId?.trim() ?? null,
        ...(s.testCases?.length ? { testCases: s.testCases } : {}),
      };
    });
  }
  const count = Math.trunc(input.count ?? NaN);
  if (!Number.isFinite(count) || count < 1) throw new Error('Say how many stacks (stacks: 2) or describe each one (stackConfigs).');
  if (fallbackMode === 'REMOTE') throw new Error('A REMOTE stack needs its machine — describe the stacks with stackConfigs ([{ mode:"remote", agentId }]).');
  return Array.from({ length: count }, () => ({ mode: fallbackMode, browser: pickBrowser(input.browser, fallbackMode), agentId: null }));
}

export type CaseRef = { code: string; id: string };

/** The cases a reference ("TC-39", "tc-39", "39") names — several entries when the same test case is in the setup more than once. */
function matchCases(cases: CaseRef[], ref: string): number[] {
  const r = String(ref).trim().toLowerCase();
  const digits = /^(?:tc[-_]?)?(\d+)$/.exec(r)?.[1];
  const hits: number[] = [];
  cases.forEach((c, i) => { if (c.code.toLowerCase() === r || (digits !== undefined && c.id === digits)) hits.push(i); });
  return hits;
}

/**
 * Spread `cases` (by index) over stacks.
 *  - no stack lists test cases → round-robin over all of them (AUTO);
 *  - some stack lists them → MANUAL: every NEW stack must list its own, unknown or doubly-placed ones are refused, and cases
 *    nobody listed stay where they are (`current`, when appending) or are left out (`unassigned`).
 * `current` = what the already-saved stacks hold (case indices), for appending: new stacks only TAKE the cases they name, or,
 * with nothing named, everything is re-dealt round-robin over old + new.
 */
export function distributeCases(
  cases: CaseRef[],
  newStacks: Array<{ testCases?: string[] | undefined }>,
  current: number[][] = [],
): { buckets: number[][]; unassigned: number[] } {
  const total = current.length + newStacks.length;
  const named = newStacks.map((s) => s.testCases);
  const anyNamed = named.some((n) => n?.length);
  if (!anyNamed) {
    const buckets: number[][] = Array.from({ length: total }, () => []);
    cases.forEach((_, i) => buckets[i % total]!.push(i));
    return { buckets, unassigned: [] };
  }
  const missing = named.map((n, i) => (n?.length ? -1 : current.length + i + 1)).filter((n) => n > 0);
  if (missing.length) {
    throw new Error(`Test cases were named for some stacks but not for stack ${missing.join(', ')} — name them for every new stack (an empty stack cannot be saved), or name none and they are spread automatically.`);
  }
  const buckets: number[][] = [...current.map((b) => [...b]), ...newStacks.map(() => [] as number[])];
  const placed = new Map<number, number>();
  named.forEach((refs, k) => {
    const stackNo = current.length + k;
    for (const ref of refs ?? []) {
      const hits = matchCases(cases, ref);
      if (!hits.length) {
        throw new Error(`${ref} is not a test case of this setup. Its test cases: ${cases.map((c) => c.code).join(', ')}.`);
      }
      for (const h of hits) {
        if (placed.has(h) && placed.get(h) !== stackNo) {
          throw new Error(`${cases[h]!.code} is named for stack ${placed.get(h)! + 1} and stack ${stackNo + 1} — a test case runs on one stack.`);
        }
        placed.set(h, stackNo);
      }
    }
  });
  // a case taken by a new stack leaves the old one it was on
  for (let s = 0; s < current.length; s++) buckets[s] = buckets[s]!.filter((i) => !placed.has(i));
  for (const [i, s] of placed) if (!buckets[s]!.includes(i)) buckets[s]!.push(i);
  const inBucket = new Set(buckets.flat());
  const unassigned = cases.map((_, i) => i).filter((i) => !inBucket.has(i));
  return { buckets, unassigned };
}

/** The UI refuses to save a stack with no test case (a run would skip or fail it): the first empty one, as "Stack N". */
export function firstEmptyStack(buckets: number[][]): number | undefined {
  const i = buckets.findIndex((b) => b.length === 0);
  return i < 0 ? undefined : i + 1;
}
