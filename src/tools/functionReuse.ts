import type { ProviderAdapter } from '../adapters/types.js';
import type { Step } from '../domain/types.js';

/** A run of consecutive recorded steps that is identical (by action + object) to an existing function's body. */
export type FnMatch = {
  fnId: string;
  fnCode?: string | undefined;
  fnName: string;
  /** Index into the scanned step list where the run starts. */
  start: number;
  length: number;
  /** `n` (seq) of each matched step — what the backend replace call is keyed by. */
  stepNs: number[];
  /** How sure the matcher is: same params (`exact`) or same action/element with different params
   *  (`strong`). Absent on matches produced by the legacy name-based matcher. */
  confidence?: 'exact' | 'strong' | undefined;
};

/** ID-based matching for a SAVED test case: compares actionId / objectId / stepType / technologyType
 *  and the parameter NAMES of each step (never display names, never values). Falls back to the
 *  name-based matcher below when the provider cannot do it. */
export async function findFunctionCandidatesForTc(
  adapter: ProviderAdapter,
  tcId: string,
  opts: { versionId?: string | undefined; minConfidence?: 'exact' | 'strong' | undefined } = {},
): Promise<FnMatch[]> {
  if (!adapter.functionCandidatesFor) return [];
  let candidates;
  try {
    candidates = await adapter.functionCandidatesFor(tcId, {
      ...(opts.versionId !== undefined ? { versionId: opts.versionId } : {}),
      ...(opts.minConfidence !== undefined ? { minConfidence: opts.minConfidence } : {}),
    });
  } catch {
    return [];
  }
  return candidates.map((c) => ({
    fnId: c.fnId,
    ...(c.fnCode ? { fnCode: c.fnCode } : {}),
    fnName: c.fnName,
    start: c.start,
    length: c.length,
    stepNs: c.seqs,
    confidence: c.confidence,
  }));
}

/** A function with fewer steps than this is too generic to suggest (one "Click" matches everything). */
const MIN_FN_STEPS = 2;
/** Cap on candidate functions fetched per save — each costs one getFunction round trip. */
const MAX_CANDIDATES = 50;
const FETCH_CHUNK = 8;

/** SQA steps round-tripped from the backend carry `actionType = String(actionId)` ("106"), while a
 *  freshly RECORDED step carries the display name ("Type Text") — and a stored FUNCTION's steps can be
 *  either. Matching therefore has to speak ONE vocabulary: this resolves numeric action ids to the
 *  backend's display name (best-effort; an unavailable catalog leaves the id untouched). */
async function actionNameResolver(adapter: ProviderAdapter): Promise<(t: string) => string> {
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  try {
    for (const d of (await adapter.actionsCatalog?.()) ?? []) {
      // Canonical human label: the backend's display name, else its action name.
      const label = d.description ?? d.actionType;
      if (!label) continue;
      if (d.id != null) byId.set(String(d.id), label);
      // Both spellings the pipeline can emit ("launchApplication") resolve to the same label, so a
      // RECORDED step ("Go to URL") and a hydrated one ("launchApplication") compare equal.
      if (d.actionType) byName.set(d.actionType.trim().toLowerCase(), label);
    }
  } catch { /* no catalog — compare raw values */ }
  return (t: string) => {
    const raw = String(t ?? '').trim();
    if (/^\d+$/.test(raw)) return byId.get(raw) ?? raw;
    return byName.get(raw.toLowerCase()) ?? raw;
  };
}

const withResolvedActions = (steps: Step[], resolve: (t: string) => string): Step[] =>
  steps.map((s) => ({ ...s, actionType: resolve(s.actionType) }));

const isPlain = (s: Step): boolean =>
  !s.controlFlow && s.stepType !== 'control_flow' && s.stepType !== 'function' && s.stepType !== 'function_end';

/** Identity of a step for matching: the action plus the object it acts on. Values are deliberately
 *  excluded — a function's values are parameters, so a recording that typed different data is still a reuse.
 *  Names are NORMALISED because the two sides come from different sources: a RECORDED step carries the
 *  live element label ("Username field") while the saved object is stored with a dedupe suffix
 *  ("Username field_1"), and the same action may be cased/spaced differently ("Type Text" vs typeText). */
const normToken = (v: string | undefined): string =>
  (v ?? '').trim().toLowerCase()
    .replace(/_\d+$/, '')            // "username field_1" → "username field"
    .replace(/\s+\d+$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The most identifying locator of a step's element: an XPath/id/css one when present, else the first.
 *  A function read from the backend has ids; a just-recorded step has no ids but DOES carry the
 *  captured locators, so this is what lets the two be compared exactly. */
function primaryLocator(s: Step): string {
  const locs = s.objectRef?.locators ?? [];
  const pick = locs.find((l) => /xpath|css|^id$|^name$/i.test(l.name) && l.value)
    ?? locs.find((l) => l.value);
  return normToken(pick?.value);
}

const signature = (s: Step): StepSig => ({
  action: normToken(s.actionType),
  object: normToken(s.objectRef?.name),
  locator: primaryLocator(s),
});

type StepSig = { action: string; object: string; locator?: string };

/** Two elements are the same when their normalised labels are equal, or when one label is a
 *  meaningful fragment of the other — a recorder may name the field "Username" while the saved object
 *  is "Username field_1", and "Login" vs "Login button". Short labels (<4 chars) must match exactly so
 *  a stray "OK" click cannot match anything. An empty object on both sides (launch / wait) is a match. */
const objectMatches = (a: string, b: string): boolean => {
  if (!a || !b) return a === b;
  if (a === b) return true;
  return a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a));
};

const stepsMatch = (a: StepSig, b: StepSig): boolean => {
  if (a.action !== b.action) return false;
  // Same element by LOCATOR when both sides have one (the reliable signal: labels drift, the XPath
  // does not). Otherwise fall back to the fuzzy label comparison.
  if (a.locator && b.locator) return a.locator === b.locator;
  return objectMatches(a.object, b.object);
};

/** Steps that carry no intent of their own — the recorder inserts "Wait until Element is Present"
 *  automatically. They are skipped when matching so a wait in the middle of a flow does not hide an
 *  otherwise exact function body; the matched RANGE still covers them, so a replacement stays contiguous. */
const TRANSPARENT_ACTION = /^(wait|pause|delay|minimum wait)\b/i;
const isTransparent = (s: Step): boolean => TRANSPARENT_ACTION.test((s.actionType ?? '').trim());

/** Every position where `fnSteps` appears as a contiguous run inside `steps`, ignoring transparent
 *  (wait/pause) steps. Control-flow / nested function steps break a run, so a match never spans a
 *  bracket. Returns the ORIGINAL index range covering the run, waits included. */
export function findRunsDetailed(steps: Step[], fnSteps: Step[]): Array<{ start: number; end: number }> {
  const hits: Array<{ start: number; end: number }> = [];
  // Transparent (wait/pause) steps are dropped from the RECORDING side below, so they must be dropped
  // from the function body too — otherwise the two sequences are offset by one and an exact match can
  // never be found (a function extracted from a recording always contains its recorder wait).
  const wantSteps = fnSteps.filter((s) => !isTransparent(s));
  const want = wantSteps.map(signature);
  // A run of only object-less steps (launch, wait, …) is not distinctive enough to suggest.
  if (!wantSteps.some((s) => s.objectRef?.name)) return hits;
  const usable = steps
    .map((s, i) => ({ s, i }))
    .filter((x) => isPlain(x.s) && !isTransparent(x.s));
  for (let a = 0; a + want.length <= usable.length; a++) {
    let all = true;
    for (let j = 0; j < want.length; j++) {
      if (!stepsMatch(signature(usable[a + j]!.s), want[j]!)) { all = false; break; }
    }
    if (all) hits.push({ start: usable[a]!.i, end: usable[a + want.length - 1]!.i });
  }
  return hits;
}

/** Start indices of the runs — convenience wrapper over {@link findRunsDetailed}. */
export function findRuns(steps: Step[], fnSteps: Step[]): number[] {
  return findRunsDetailed(steps, fnSteps).map((h) => h.start);
}

/** A contiguous block of recorded steps that is a good candidate for a NEW reusable function. */
export type FnGroup = {
  /** A short suggested name, taken from the block's first/last meaningful step. */
  suggestedName: string;
  stepSeqs: number[];
  fromSeq: number;
  toSeq: number;
  stepCount: number;
  /** One-line human summary ("steps 1–6: Go to URL → Verify Products page title"). */
  summary: string;
};

/** A function needs enough steps to be worth extracting; below this it is noise. */
const MIN_GROUP_STEPS = 3;

const plainLabel = (s: Step): string => {
  const text = (s.description ?? '').replace(/\$\{[^}]+\}/g, '…').replace(/\s+/g, ' ').trim();
  if (text) return text;
  // A recorded launch / wait often has no description — fall back to its action name so a suggested
  // function name is never blank.
  return (s.actionType ?? '').trim() || `step ${s.n}`;
};

/**
 * Propose contiguous blocks of the recorded steps as NEW reusable functions.
 *
 * The product's own analyzer (the UI's "Analyze" button, `potential_functions` + `block_steps`) is the
 * ideal source when it is configured; this is the deterministic local fallback: walk the plain steps in
 * order, skip anything already covered by an existing-function match, and cut the remaining runs into
 * balanced blocks of ~`groupSize` steps. Pure — no I/O — so it is unit-testable and can never block a save.
 */
export function proposeFunctionGroups(
  steps: Step[],
  opts: { groupSize?: number; maxGroups?: number; exclude?: ReadonlySet<number> } = {},
): FnGroup[] {
  const size = Math.max(MIN_GROUP_STEPS, opts.groupSize ?? 6);
  const maxGroups = Math.max(1, opts.maxGroups ?? 4);
  const exclude = opts.exclude ?? new Set<number>();

  // Contiguous runs of plain, not-already-a-function steps (a control-flow / function row breaks a run).
  const runs: Step[][] = [];
  let run: Step[] = [];
  for (const s of steps) {
    if (!isPlain(s) || exclude.has(s.n)) {
      if (run.length) runs.push(run);
      run = [];
      continue;
    }
    run.push(s);
  }
  if (run.length) runs.push(run);

  const out: FnGroup[] = [];
  for (const r of runs) {
    if (out.length >= maxGroups) break;
    if (r.length < MIN_GROUP_STEPS) continue;
    // Balanced chunks: ceil(len/size) blocks, never leaving a tiny tail block behind.
    let chunks = Math.max(1, Math.ceil(r.length / size));
    let per = Math.ceil(r.length / chunks);
    if (r.length - per * (chunks - 1) < MIN_GROUP_STEPS) chunks = Math.max(1, chunks - 1);
    per = Math.ceil(r.length / chunks);
    for (let i = 0; i < r.length && out.length < maxGroups; i += per) {
      const block = r.slice(i, i + per);
      if (block.length < MIN_GROUP_STEPS) continue;
      const first = plainLabel(block[0]!);
      const last = plainLabel(block[block.length - 1]!);
      const fromSeq = block[0]!.n;
      const toSeq = block[block.length - 1]!.n;
      const suggestedName = [first, last]
        .filter(Boolean)
        .map((t) => t.replace(/[.;]+$/, ''))
        .join(' → ')
        .slice(0, 70) || `Steps ${fromSeq}–${toSeq}`;
      out.push({
        suggestedName,
        stepSeqs: block.map((s) => s.n),
        fromSeq,
        toSeq,
        stepCount: block.length,
        summary: `steps ${fromSeq}–${toSeq} (${block.length} steps): ${first} → ${last}`,
      });
    }
  }
  return out;
}

/** Longest-first, non-overlapping selection so one step is never offered for two functions. */
function pickNonOverlapping(all: FnMatch[]): FnMatch[] {
  const sorted = [...all].sort((a, b) => b.length - a.length || a.start - b.start);
  const taken = new Set<number>();
  const out: FnMatch[] = [];
  for (const m of sorted) {
    const idx = Array.from({ length: m.length }, (_, k) => m.start + k);
    if (idx.some((i) => taken.has(i))) continue;
    idx.forEach((i) => taken.add(i));
    out.push(m);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Finds existing project functions whose whole body appears, in order, in `steps`.
 *  Best-effort: any lookup failure yields no matches so it can never block a save. */
export async function findFunctionMatches(
  adapter: ProviderAdapter,
  steps: Step[],
  onlyFnIds?: ReadonlySet<string>,
): Promise<FnMatch[]> {
  if (!adapter.listFunctions || !adapter.getFunction) return [];
  const plainCount = steps.filter(isPlain).length;
  if (plainCount < MIN_FN_STEPS) return [];
  try {
    const resolve = await actionNameResolver(adapter);
    const probe = withResolvedActions(steps, resolve);
    const listed = await adapter.listFunctions({ executionType: 'AUTOMATION', limit: 200 });
    const rows = Array.isArray(listed) ? listed : ((listed as { items?: unknown }).items as typeof listed) ?? [];
    const candidates = rows
      .filter((f) => (f.stepCount === undefined || (f.stepCount >= MIN_FN_STEPS && f.stepCount <= steps.length)))
      .filter((f) => !onlyFnIds || onlyFnIds.has(String(f.id)))
      .slice(0, MAX_CANDIDATES);
    const found: FnMatch[] = [];
    for (let i = 0; i < candidates.length; i += FETCH_CHUNK) {
      const chunk = candidates.slice(i, i + FETCH_CHUNK);
      const fns = await Promise.all(chunk.map((c) => adapter.getFunction!(String(c.id)).catch(() => undefined)));
      for (const fn of fns) {
        if (!fn) continue;
        const body = withResolvedActions((fn.steps ?? []).filter((s) => s.stepType !== 'function_end'), resolve);
        // A function containing control flow / nested calls can't be matched step-for-step.
        if (body.length < MIN_FN_STEPS || !body.every(isPlain)) continue;
        for (const hit of findRunsDetailed(probe, body)) {
          // The range covers any transparent waits inside the run, so a replace stays contiguous.
          const stepNs = steps.slice(hit.start, hit.end + 1).map((s) => s.n);
          found.push({
            fnId: String(fn.id), fnCode: fn.code, fnName: fn.name,
            start: hit.start, length: stepNs.length,
            stepNs,
          });
        }
      }
    }
    return pickNonOverlapping(found);
  } catch {
    return [];
  }
}

/** The question the model must put to the user before saving. */
export function askReplaceText(matches: FnMatch[], retryHint: string): string {
  const lines = matches.map((m) => {
    const label = [m.fnCode, m.fnName].filter(Boolean).join(' - ') || m.fnId;
    const conf = m.confidence ? ` [${m.confidence}]` : '';
    return `  • steps ${m.stepNs[0]}–${m.stepNs[m.stepNs.length - 1]} (${m.length} steps) already exist as function **${label}**${conf}`;
  });
  return (
    `NOT SAVED YET — ${matches.length} group(s) of the recorded steps already exist as reusable function(s):\n` +
    `${lines.join('\n')}\n\n` +
    'ASK the user: "Replace these steps with the existing function(s)? (yes / no)" and WAIT for the reply. ' +
    'Do NOT answer for them. Yes → save with replaceWithFunctions: true (the matched steps become a function ' +
    'call; their testdata is replaced by the function\'s own iterations). No → save with replaceWithFunctions: ' +
    `false (saved exactly as recorded).\n${retryHint}`
  );
}

/** Picks, for every chosen (expected) match, the re-matched counterpart that overlaps it — and falls
 *  back to the expected match itself when the re-match missed it. The expected seqs came from THIS test
 *  case (the suggestion), so they are valid; dropping a chosen function because a second lookup was
 *  partial is what made "replace all" silently swap only some of them. */
export function reconcileMatches(expected: FnMatch[], rematched: FnMatch[]): FnMatch[] {
  const byFn = new Map<string, FnMatch[]>();
  for (const m of rematched) {
    const list = byFn.get(m.fnId);
    if (list) list.push(m); else byFn.set(m.fnId, [m]);
  }
  const chosen: FnMatch[] = [];
  const used = new Set<string>();
  const key = (m: FnMatch) => `${m.fnId}:${m.start}:${m.length}`;
  for (const exp of expected) {
    const cands = (byFn.get(exp.fnId) ?? []).filter((c) => !used.has(key(c)));
    const overlap = (a: number[], b: number[]) => a.some((n) => b.includes(n));
    const hit = cands.find((c) => overlap(c.stepNs, exp.stepNs)) ?? cands[0] ?? exp;
    if (used.has(key(hit))) continue;   // the same range already queued by an earlier pick
    used.add(key(hit));
    chosen.push(hit);
  }
  return chosen;
}

/** After the TC is saved, swaps each matched run for a call to its function. Re-matches against the
 *  SAVED steps (their seqs are the real ones) and works last-to-first so earlier seqs stay valid. */
export async function replaceMatchedRuns(
  adapter: ProviderAdapter,
  tcId: string,
  expected: FnMatch[],
  opts: { trustSeqs?: boolean; versionId?: string } = {},
): Promise<string> {
  if (!adapter.replaceStepsWithExistingFunction || !adapter.getTestCase) {
    return '\n⚠️ Steps were NOT replaced: this provider cannot swap steps for a function call.';
  }
  let saved;
  try {
    saved = await adapter.getTestCase(tcId);
  } catch (e) {
    return `\n⚠️ Saved, but could not re-read the test case to replace steps: ${e instanceof Error ? e.message : String(e)}`;
  }
  const wanted = new Set(expected.map((m) => m.fnId));
  // Prefer the identity-based re-match (actionId/objectId/parameter names). It is what produced the
  // suggestion in the first place; the old name-based matcher below often could not re-find the same
  // run in the saved TC and reported "nothing was replaced".
  let rematched: FnMatch[] = adapter.functionCandidatesFor
    ? (await findFunctionCandidatesForTc(adapter, tcId, {
        ...(opts.versionId !== undefined ? { versionId: opts.versionId } : {}),
        minConfidence: 'strong',
      })).filter((m) => wanted.has(m.fnId))
    : [];
  if (!rematched.length) {
    rematched = await findFunctionMatches(adapter, saved.steps ?? [], wanted);
  }
  // Reconcile per chosen match so a PARTIAL re-match can never drop the rest.
  const matches = expected.length ? reconcileMatches(expected, rematched) : rematched;
  if (!matches.length) return '\n⚠️ Saved, but the matching function steps could not be located in the saved test case — nothing was replaced.';
  const notes: string[] = [];
  for (const m of [...matches].sort((a, b) => b.start - a.start)) {
    const label = [m.fnCode, m.fnName].filter(Boolean).join(' - ') || m.fnId;
    try {
      await adapter.replaceStepsWithExistingFunction(tcId, { functionId: m.fnId, stepSeqs: m.stepNs });
      notes.push(`replaced steps ${m.stepNs[0]}–${m.stepNs[m.stepNs.length - 1]} with function ${label}`);
    } catch (e) {
      notes.push(`⚠️ could not replace steps ${m.stepNs[0]}–${m.stepNs[m.stepNs.length - 1]} with ${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return `\nFunction reuse: ${notes.join('; ')}.`;
}

/** Applies the user's answer: true = every match, false/undefined = none, string[] = only those function ids. */
export function selectMatches(matches: FnMatch[], choice: boolean | string[] | undefined): FnMatch[] {
  if (choice === true) return matches;
  if (Array.isArray(choice)) {
    const ids = new Set(choice.map(String));
    return matches.filter((m) => ids.has(m.fnId));
  }
  return [];
}

/** The post-recording suggestion: which recorded steps already exist as functions, and the question to ask. */
export function suggestionText(matches: FnMatch[], where: string, applyHint: string): string {
  const lines = matches.map((m, i) => {
    const label = [m.fnCode, m.fnName].filter(Boolean).join(' - ') || m.fnId;
    const conf = m.confidence ? ` [${m.confidence}]` : '';
    return `  ${i + 1}. steps ${m.stepNs[0]}–${m.stepNs[m.stepNs.length - 1]} (${m.length} steps) → function **${label}** (id ${m.fnId})${conf}`;
  });
  return (
    `Found ${matches.length} group(s) of steps in ${where} that already exist as reusable function(s):\n` +
    `${lines.join('\n')}\n\n` +
    'Show this list to the user and ASK, per function: "Replace these steps with the existing function, or keep them as recorded?" ' +
    'Accept: all / only some (by number) / none. WAIT for the answer — never decide for them. ' +
    'None → leave everything as is (normal flow). ' + applyHint
  );
}
