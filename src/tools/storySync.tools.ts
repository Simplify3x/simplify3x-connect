import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { Story, TestCase, Step } from '../domain/types.js';
import { latestVersionId, nextVersionName } from '../versionName.js';
import { splitAcceptanceCriteria } from '../acText.js';

/**
 * story_sync_testcases — detect drift between a user story and the test cases linked to it, and
 * return an ORDERED, resumable plan for updating them.
 *
 * Scope:
 *   - MANUAL test cases: the AC↔step lexical drift (unchanged) → add_step / update_step / remove_step.
 *   - AUTOMATION test cases: an automated TC can't be re-texted — it has to be RE-RECORDED. The tool
 *     reports `action: 'rerecord'` plus the recording brief (ACs, story/module ids, current steps,
 *     testdata seeds) when the story's ACs are no longer represented by its steps, and `up-to-date`
 *     otherwise.
 *
 * Every drifted item carries the next version name (v1.0 → v2.0 → …) because the update is applied as
 * a NEW VERSION of the same test case (TC id, story link, suite membership and history preserved):
 *   manual     : tc_draft_from_tc → tc_draft_update → tc_save_as_new_version({ fromDraftId })
 *   automation : core_activate_technology({ testcaseId, versionName }) → record → Save (the recorder
 *                window's own Save button, or tc_save({ sessionId }) which clicks that same button)
 *                writes a NEW VERSION of the SAME automation TC (one TC at a time)
 *
 * Report-only: this tool writes nothing itself.
 */
export type StorySyncToolsDeps = {
  getAdapter: () => ProviderAdapter | null;
};

const NOT_CONNECTED =
  'Not connected to a product. Use qa_connect first — story-sync needs a live backend to read ' +
  'the story and its linked test cases.';

type Sensitivity = 'strict' | 'normal' | 'loose';

// Jaccard thresholds by sensitivity. T_HIGH = "clearly the same AC as this step".
// T_LOW = "possible match, likely reworded". Below T_LOW = no match (AC is new / step is stale).
const THRESHOLDS: Record<Sensitivity, { high: number; low: number }> = {
  strict: { high: 0.5, low: 0.15 },
  normal: { high: 0.6, low: 0.25 },
  loose: { high: 0.7, low: 0.35 },
};

// Small stopword set — enough to stop "the/and/a" from dominating token overlap on short ACs.
// ponytail: hand-picked list, swap for a stemmer if false-positive rate warrants it.
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'onto', 'when', 'then',
  'should', 'shall', 'must', 'will', 'can', 'may', 'are', 'was', 'were', 'been', 'being',
  'has', 'have', 'had', 'not', 'but', 'user', 'system', 'given', 'verify', 'ensure',
]);

function tokenize(s: string | undefined | null): Set<string> {
  if (!s) return new Set();
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    // Crude plural folding ("accounts" → "account", "loads" → "load"): without it an AC that says
    // "account summary" never matches a step that says "Accounts page", which is most of the misses.
    out.add(raw.length > 3 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw);
  }
  return out;
}

/** Union of the tokens of many strings/steps — used to ask "is this concept ANYWHERE in the flow?" */
function unionTokens(sets: Array<Set<string>>): Set<string> {
  const out = new Set<string>();
  for (const s of sets) for (const t of s) out.add(t);
  return out;
}

/** Fraction of `part` that appears in `whole` (containment, not Jaccard). */
function containment(part: Set<string>, whole: Set<string>): number {
  if (part.size === 0) return 0;
  let hit = 0;
  for (const t of part) if (whole.has(t)) hit++;
  return hit / part.size;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** A token set plus the common inflections of each token ("update" → "updated", "display" →
 *  "displayed"). Used to recognise a step word as a FORM of an AC word: without it, "the updated
 *  picture" in a removed-scenario step looked distinctive just because the remaining AC says
 *  "update", and two unrelated steps could be chained into one scenario. */
function withInflections(tokens: Set<string>): Set<string> {
  const out = new Set(tokens);
  for (const t of tokens) {
    out.add(`${t}s`);
    out.add(`${t}es`);
    out.add(`${t}d`);
    out.add(`${t}ed`);
    out.add(`${t}ing`);
  }
  return out;
}

function stepTokens(step: Step): Set<string> {
  const a = tokenize(step.description);
  const b = tokenize(step.expectedResult);
  for (const t of b) a.add(t);
  return a;
}

// A step "looks AC-derived" if it has an expectedResult or a non-trivial description —
// used to decide whether an unmatched step is genuinely stale (worth proposing remove_step)
// vs. a mundane setup step we should leave alone.
function round2(n: number): number {
  return Math.round(Math.max(0, Math.min(1, n)) * 100) / 100;
}

function looksAcDerived(step: Step): boolean {
  return !!step.expectedResult && step.expectedResult.trim().length > 0;
}

type DriftSignal =
  | { kind: 'story_title_changed'; to: string }
  | { kind: 'ac_added'; text: string; likelyInsertAt?: number }
  | { kind: 'ac_removed'; text: string; matchingSteps: number[] }
  | { kind: 'ac_reworded'; from: string; to: string; matchingSteps: number[] }
  | { kind: 'step_stale'; n: number; reason: string }
  /** The story's scope changed enough (an AC added/removed) that the TC TITLE is probably stale.
   *  Hint only — never an auto-rename: the title is a human decision. */
  | { kind: 'title_review'; currentTitle: string; hint: string }
  /** NONE of this TC's steps represent any CURRENT acceptance criterion — the scenario it tested was
   *  removed from the story. The TC should be marked obsolete (not stripped to zero steps). */
  | { kind: 'orphaned'; reason: string };

/** How safe an op is to apply without a human look. `add_step` is additive → auto; anything that
 *  REWRITES or DELETES existing content is capped at 'review' no matter how confident the match is. */
export type OpBucket = 'auto' | 'review' | 'manual';

type OpMeta = { confidence: number; rationale: string; bucket: OpBucket };

type ProposedOp =
  | ({ op: 'add_step'; at?: number; step: { description: string; actionType: string; stepType: 'web'; expectedResult?: string } } & OpMeta)
  | ({ op: 'update_step'; n: number; patch: { description?: string; expectedResult?: string }; hint?: string } & OpMeta)
  | ({ op: 'remove_step'; n: number } & OpMeta)
  /** Bulk removal of a CONSECUTIVE run of orphaned steps (the removed scenario) in ONE op/save. */
  | ({ op: 'remove_steps'; numbers: number[] } & OpMeta);

type TCDrift = {
  testCaseId: string;
  title: string;
  driftScore: 'none' | 'minor' | 'major';
  signals: DriftSignal[];
  proposedOps: ProposedOp[];
  unresolved: string[];
  /** True when NO step matches any current AC (the whole TC belonged to a removed scenario). */
  allOrphaned?: boolean;
};

/** One executable item of the sync plan. Manual items are edited textually; automation items are
 *  RE-RECORDED with the agent's granular recording tools. */
export type SyncPlanItem =
  | {
      kind: 'manual';
      testCaseId: string;
      title: string;
      driftScore: 'none' | 'minor' | 'major';
      signals: DriftSignal[];
      proposedOps: ProposedOp[];
      unresolved: string[];
      /** 'obsolete' when every step belonged to a removed scenario (nothing left to keep). */
      action?: 'obsolete' | undefined;
      /** Only present when this item will actually WRITE something (drift or obsolete). A clean item
       *  carries no version name — printing one made a converged test case look like it needed v3.0. */
      nextVersionName?: string | undefined;
      versionStrategy: 'new' | 'in-place';
    }
  | {
      kind: 'automation';
      testCaseId: string;
      title: string;
      action: 'rerecord' | 'up-to-date' | 'obsolete';
      coverage: number;
      missingAcs: string[];
      /** Only present for action='rerecord' (the only case that writes a version). */
      nextVersionName?: string | undefined;
      brief: {
        storyId: string;
        storyKey?: string;
        userstoryId?: number;
        moduleId?: number;
        testcaseName: string;
        technology?: string;
        currentStepCount: number;
        acceptanceCriteria: string[];
        currentSteps: string[];
        testData?: Array<{ name: string; seed: string; protected?: boolean }>;
      };
    };

type SkippedTC = {
  testCaseId: string;
  title: string;
  reason: 'automation_tc_out_of_scope' | 'manual_tc_out_of_scope' | 'no_id' | 'already_obsolete';
};

export function computeDrift(story: Story, tc: TestCase, sensitivity: Sensitivity = 'normal'): TCDrift {
  const { high, low } = THRESHOLDS[sensitivity];
  const signals: DriftSignal[] = [];
  // Ops are collected per KIND and concatenated in an APPLY-SAFE order at the end (see below):
  // updates (indices stable) → removes DESC (no shift can invalidate a later index) → adds (append).
  const updates: ProposedOp[] = [];
  const removes: ProposedOp[] = [];
  const adds: ProposedOp[] = [];
  const unresolved: string[] = [];

  // Split HTML/newline blobs HERE too: the story may arrive from a provider that stores the ACs as one
  // blob, and comparing that blob would flag the whole story as new on every TC (US-897 / US-941).
  const acList = splitAcceptanceCriteria(story.acceptanceCriteria);
  // A story with NO criteria cannot be "out of date": never propose removing/obsoleting against an
  // empty AC list.
  if (acList.length === 0) {
    return { testCaseId: tc.id ?? '', title: tc.title, driftScore: 'none', signals: [], proposedOps: [], unresolved: [] };
  }
  const acTokens = acList.map(tokenize);
  const stepTok = tc.steps.map((s) => ({ n: s.n, tokens: stepTokens(s), step: s }));
  // ACs are long Given/When/Then prose and steps are short action lines, so a per-step Jaccard is
  // almost always low even when the flow DOES cover the AC. Ask two different questions instead:
  //   • acCovered: do the AC's concepts appear ANYWHERE in the flow? (containment vs the step union)
  //   • bestStep : which single step is the closest match? (drives "reworded" vs "new")
  const stepUnion = unionTokens(stepTok.map((s) => s.tokens));
  const acUnion = unionTokens(acTokens);

  // Track which steps got matched by any AC (to detect stale steps).
  const stepMatched = new Set<number>();
  // How many CURRENT ACs this TC still represents. Zero → the whole TC is orphaned (obsolete it).
  let matchedAcCount = 0;

  let appendAt = tc.steps.length + 1;   // next free slot for an added AC step (append order)
  acList.forEach((acText, i) => {
    const acTok = acTokens[i]!;
    let best = { score: 0, n: -1, stepDesc: '' };
    for (const st of stepTok) {
      const score = jaccard(acTok, st.tokens);
      if (score > best.score) best = { score, n: st.n, stepDesc: st.step.description };
    }

    // "Represented" needs EITHER a single step matching at >= low, OR the AC's vocabulary being almost
    // entirely present across the whole flow (a long criterion split over several steps). A merely
    // half-overlapping flow is NOT representation — that is how a genuinely new AC used to be swallowed
    // by the union check (its words like "enter/password/click/sign" exist in any login flow).
    const covered = containment(acTok, stepUnion) >= 0.75;
    if (best.score >= high) {
      stepMatched.add(best.n);
      matchedAcCount++;
      return;
    }
    if (covered && best.score < low) {
      stepMatched.add(best.n);
      matchedAcCount++;
      return;
    }
    if (best.score >= low && best.n > 0) {
      stepMatched.add(best.n);
      matchedAcCount++;
      signals.push({ kind: 'ac_reworded', from: best.stepDesc, to: acText, matchingSteps: [best.n] });
      // HINT ONLY — never overwrite the step's wording with the AC prose. A reworded AC usually means
      // "the step is still right, the AC text moved"; auto-replacing the description (and especially
      // the expectedResult) destroys a real, verified expectation.
      updates.push({
        op: 'update_step',
        n: best.n,
        patch: {},
        hint: `AC drift: this step matches the reworded criterion at ${Math.round(best.score * 100)}% — review its wording/expectation against the current AC if needed.`,
        confidence: round2(best.score),
        rationale: `step ${best.n} overlaps the AC at ${Math.round(best.score * 100)}% (reworded)`,
        bucket: 'review',
      });
      return;
    }
    // No match: AC is new to this TC. Insert in AC order — a constant index would reverse them.
    const insertAt = appendAt++;
    signals.push({ kind: 'ac_added', text: acText, likelyInsertAt: insertAt });
    adds.push({
      op: 'add_step',
      at: insertAt,
      step: {
        description: acText,
        actionType: 'manualStep',
        stepType: 'web',
        expectedResult: acText,
      },
      confidence: round2(1 - best.score),
      rationale: `no step matches this criterion (best overlap ${Math.round(best.score * 100)}%)`,
      bucket: 'auto',
    });
  });

  // Stale-step detection -------------------------------------------------
  // A REMOVED SCENARIO shows up as a CONSECUTIVE group of unmatched steps that share a distinctive
  // topic no current AC mentions (e.g. steps 11–15 all talk about the profile PICTURE while the
  // remaining criteria only cover login and the phone number). Only such a group is proposed for
  // removal. An isolated unmatched step ("Click Edit on the details section") is ambiguous — a
  // navigation step, not a deleted scenario — and is reported as a `step_stale` hint instead:
  // deleting a real step is far worse than leaving a review note.
  const unmatched = stepTok
    .filter((st) => !stepMatched.has(st.n) && looksAcDerived(st.step))
    .sort((a, b) => a.n - b.n);

  // Consecutive runs over the unmatched set (a gap means the step in between IS represented).
  const orphanRuns: Array<typeof unmatched> = [];
  for (const st of unmatched) {
    const last = orphanRuns[orphanRuns.length - 1];
    if (last && st.n === last[last.length - 1]!.n + 1) last.push(st);
    else orphanRuns.push([st]);
  }

  // Generic UI verbs/nouns — shared by almost every flow, so they must never make two steps look
  // like one scenario. Without this, "Click Save" + "Click Back" would read as a removed scenario.
  const UI_GENERIC = new Set([
    'click', 'open', 'enter', 'select', 'press', 'navigate', 'browse', 'type', 'choose', 'fill',
    'field', 'button', 'form', 'page', 'section', 'screen', 'menu', 'option', 'value', 'input',
    'display', 'displayed', 'shown', 'show', 'new', 'save', 'saved', 'submit', 'close', 'return',
    'wait', 'finish', 'complete', 'edit', 'editable', 'see', 'check', 'confirm', 'success',
  ]);

  /** Steps that belong to a removed scenario, inside one consecutive run of unmatched steps.
   *
   *  A topic is any token that (a) appears in no current AC and (b) is not a generic UI word. Two
   *  steps are linked when they share such a token, so a scenario written with synonyms still sticks
   *  together ("picture" / "image" / "avatar" chained through the 5 upload steps). A linked group of
   *  TWO OR MORE steps is a removed scenario; a group is also extended over its immediate neighbours
   *  that mention NOTHING from a current AC (a "choose the file from disk" step inside the picture
   *  scenario). Steps that still talk about a current criterion (a success-toast step) are never
   *  swallowed, and a lone step is never deleted. */
  const removedBlock = (run: typeof unmatched): Set<number> => {
    const out = new Set<number>();
    if (run.length < 2) return out;

    // Distinctive tokens per step: not a form of any AC word, not a generic UI word.
    const acForms = withInflections(acUnion);
    const distinct = run.map((st) => {
      const set = new Set<string>();
      for (const t of st.tokens) if (t && !acForms.has(t) && !UI_GENERIC.has(t)) set.add(t);
      return set;
    });

    // A topic must RECUR through the scenario, not just appear twice. Without a minimum support,
    // one shared incidental word ("details" in "Click Edit on the details section" + "Click Save on
    // the details form", or "reload" in two unrelated steps) turned ordinary steps into a "removed
    // scenario" and deleted them. A 2–3 step run is held to a lower bar so tiny scenarios are still
    // detectable.
    const minSupport = run.length >= 4 ? 3 : 2;
    const support = new Map<string, number>();
    for (const set of distinct) for (const t of set) support.set(t, (support.get(t) ?? 0) + 1);
    const eligible = new Set([...support].filter(([, c]) => c >= minSupport).map(([t]) => t));

    // Union-find over "shares at least one distinctive token".
    const parent = run.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    const union = (a: number, b: number): void => {
      const ra = find(a); const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };
    for (let i = 0; i < run.length; i++) {
      for (let j = i + 1; j < run.length; j++) {
        for (const t of distinct[i]!) {
          if (eligible.has(t) && distinct[j]!.has(t)) { union(i, j); break; }
        }
      }
    }
    const groups = new Map<number, number[]>();
    run.forEach((_, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push(i);
    });

    const touchesAc = run.map((st) => containment(st.tokens, acUnion) > 0);
    for (const idxs of groups.values()) {
      if (idxs.length < 2) continue;              // one step is never evidence of a scenario
      for (const i of idxs) {
        out.add(run[i]!.n);
        for (let lo = i - 1; lo >= 0 && !touchesAc[lo]; lo--) out.add(run[lo]!.n);
        for (let hi = i + 1; hi < run.length && !touchesAc[hi]; hi++) out.add(run[hi]!.n);
      }
    }
    return out.size >= 2 ? out : new Set<number>();
  };

  for (const run of orphanRuns) {
    const block = removedBlock(run);
    for (const st of run) {
      if (!block.has(st.n)) {
        signals.push({ kind: 'step_stale', n: st.n, reason: 'no strong AC match' });
        unresolved.push(`step ${st.n} has weak overlap with all ACs — review whether it's still needed`);
        continue;
      }
      signals.push({ kind: 'ac_removed', text: st.step.description, matchingSteps: [st.n] });
      removes.push({
        op: 'remove_step',
        n: st.n,
        confidence: 1,
        rationale: `step ${st.n} is part of a scenario removed from the story (${block.size} consecutive steps about a topic no current criterion mentions)`,
        bucket: 'review',   // destructive → always needs a human look
      });
    }
  }

  // A TC where NO current AC is represented has nothing left to keep: the scenario it tested was
  // removed from the story. Obsolete it instead of proposing to strip every step (which would leave
  // an empty — but still active — test case).
  const allOrphaned = tc.steps.length > 0 && matchedAcCount === 0;
  if (allOrphaned) {
    signals.push({ kind: 'orphaned', reason: 'no step represents any current acceptance criterion' });
    removes.length = 0;               // never propose emptying the TC
    updates.length = 0;
    adds.length = 0;
  }

  // Executable order: updates first (numbering still intact) → ONE remove_steps carrying EVERY
  // orphan → adds last (appended in AC order).
  // Several remove ops in one call would NOT be equivalent: the draft renumbers after each op, so a
  // later `remove_steps [12,13,14]` resolves against the already-shortened list and deletes the
  // wrong steps (seen in the first end-to-end run: 5 + 13,14,15 were removed instead of 5 + 12..14,
  // and the test case kept drifting on the next sync).
  const orphanNumbers = [...new Set(removes.map((r) => (r as { n: number }).n))].sort((a, b) => a - b);
  const groupedRemoves: ProposedOp[] = orphanNumbers.length === 0
    ? []
    : [{
        op: 'remove_steps',
        numbers: orphanNumbers,
        confidence: Math.min(...removes.map((r) => r.confidence)),
        rationale: `step${orphanNumbers.length > 1 ? 's' : ''} ${orphanNumbers.join(', ')} belong to a scenario removed from the story`,
        bucket: 'review',
      } as ProposedOp];

  const proposedOps: ProposedOp[] = allOrphaned
    ? []
    : [...updates, ...groupedRemoves, ...adds];

  const hasStructural = signals.some((s) => s.kind === 'ac_added' || s.kind === 'ac_removed');
  // "Drifted" means something would actually CHANGE. A hint-only update_step (empty patch, kept as a
  // review note) or a mere step_stale note is NOT drift: counting it made every sync propose another
  // version forever, so a test case that had just been trimmed still came back as "needs v3.0".
  const actionable = proposedOps.some(
    (o) => o.op !== 'update_step' || Object.keys((o as { patch?: Record<string, unknown> }).patch ?? {}).length > 0,
  );
  const driftScore: TCDrift['driftScore'] =
    allOrphaned ? 'major'
      : !actionable ? 'none'
        : hasStructural ? 'major' : 'minor';

  // Structural drift usually means the story's SCOPE moved, which makes the TC title stale. Hint
  // only (no auto-rename op): the title is the human's call.
  if (driftScore === 'major') {
    signals.push({
      kind: 'title_review',
      currentTitle: tc.title,
      hint: 'The story\'s criteria changed — review against current ACs; rename the title only if its scope moved.',
    });
  }


  return {
    testCaseId: tc.id ?? '',
    title: tc.title,
    driftScore,
    signals,
    proposedOps: allOrphaned ? [] : proposedOps,
    unresolved,
    allOrphaned,
  };
}

/**
 * How well an AUTOMATED test case's steps represent the story's acceptance criteria.
 *
 * An automation step is a recorded ACTION ("Click on From field"), so it will never read like an AC
 * ("Given the customer has products in the cart…"). Matching is therefore deliberately loose: an AC
 * counts as covered when ANY step reaches the `low` threshold on token overlap (validations usually
 * carry the AC's text in their expectedResult, which is what makes this usable at all).
 *
 * The purpose is not to prove equivalence — it is to decide whether the story edit is already
 * reflected in the recorded flow (skip, no needless re-record) or not (flag `rerecord`).
 */
export function computeAutomationCoverage(
  story: Story,
  tc: TestCase,
  sensitivity: Sensitivity = 'normal',
): { coverage: number; covered: boolean; missingAcs: string[] } {
  const acList = splitAcceptanceCriteria(story.acceptanceCriteria);
  if (acList.length === 0) return { coverage: 1, covered: true, missingAcs: [] };
  // A recorded action ("Click on Sign In") never reads like an AC ("Given the Bank-Admin…"). Measure
  // how much of each AC's vocabulary the WHOLE flow contains; a flow that validates the dashboard and
  // the balance genuinely covers those criteria even though no single step matches textually.
  const threshold = sensitivity === 'strict' ? 0.6 : sensitivity === 'loose' ? 0.4 : 0.5;
  const flowTokens = unionTokens(tc.steps.map((s) => stepTokens(s)));
  const missing: string[] = [];
  for (const ac of acList) {
    if (containment(tokenize(ac), flowTokens) < threshold) missing.push(ac);
  }
  const coverage = (acList.length - missing.length) / acList.length;
  return { coverage, covered: missing.length === 0, missingAcs: missing };
}

/** Numeric suffix of a business key / story ref ("US_897" → 897). */
function numericSuffix(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.match(/(\d+)\s*$/);
  return m ? Number.parseInt(m[1]!, 10) : undefined;
}

function moduleOf(tc: TestCase): number | undefined {
  const direct = numericSuffix(tc.folderOrModule);
  if (direct !== undefined) return direct;
  return undefined;
}

/** The technology an automated TC was recorded in — drives which recording tool the agent uses. */
function technologyOf(tc: TestCase): string | undefined {
  const t = (tc as unknown as { technologyType?: string }).technologyType;
  return typeof t === 'string' && t.trim() ? t.trim().toUpperCase() : undefined;
}

export function registerStorySyncTools(server: McpServer, deps: StorySyncToolsDeps): void {
  server.registerTool(
    'story_sync_testcases',
    {
      title: 'Sync a user story with its manual AND automation test cases (drift + recording plan)',
      description:
        'Compare a user STORY against every test case linked to it (via storyRef) and return a ' +
        'structured, ORDERED plan for bringing them up to date.\n\n' +
        'MANUAL test cases → textual drift (ac_added / ac_reworded / ac_removed / step_stale) and the ' +
        'exact draft ops (add_step / update_step / remove_step).\n' +
        'AUTOMATION test cases → `action: "rerecord"` (or `"up-to-date"`) plus the recording brief: the ' +
        'acceptance criteria to cover, story/module ids, current steps and testdata seeds. An automated ' +
        'TC cannot be re-texted — it must be re-recorded.\n\n' +
        'HOW TO APPLY (one item at a time, in plan order — never in parallel):\n' +
        '  MANUAL item:\n' +
        '    1. tc_draft_from_tc({ tcId })\n' +
        '    2. tc_draft_update({ draftId, ops: item.proposedOps })\n' +
        '    3. tc_save_as_new_version({ tcId, fromDraftId: draftId })   ← new version (v1.0 → v2.0)\n' +
        '  OBSOLETE item (action === "obsolete") — the scenario this TC tested was REMOVED from the story\n' +
        '    and NO step matches any current AC:\n' +
        '    ASK the user, then journal_modify({ tcId, ops: [{ op: "set_meta", patch: { obsolete: true } }] }).\n' +
        '    Do NOT strip its steps (that leaves an empty, still-active TC) and do NOT delete it.\n' +
        '  PARTIAL removal — only SOME steps belonged to the removed scenario:\n' +
        '    item.proposedOps carries ONE bulk remove_steps { numbers:[11,12,13,14,15] }; apply the MANUAL\n' +
        '    item steps 1-3 above. The result is a NEW VERSION without those steps (v1.0 keeps them).\n' +
        '    NEVER obsolete a partially-affected TC.\n' +
        '  AUTOMATION item (action === "rerecord"):\n' +
        '    1. ASK the user AI-only or Hybrid, then\n' +
        '       core_activate_technology({ technology, testcaseId: item.testCaseId, ' +
        'versionName: item.nextVersionName, testcaseName: item.title, userstoryId: item.brief.userstoryId, ' +
        'moduleId: item.brief.moduleId, recordingMode, recordingModeAskedUser })\n' +
        '       The recorder window opens on THAT test case (details + versions, steps cleared) and\n' +
        '       shows the pending version in the version dropdown (v1.0 → v2.0, v2.0 → v3.0).\n' +
        '    2. Record the brief.acceptanceCriteria end-to-end (web: web_launch_application → web_snapshot → ' +
        'web_click / web_enter_text / web_validate_text …).\n' +
        '       (desktop: desktop_launch_application → desktop_snapshot → desktop_click / desktop_enter_text / ' +
        'desktop_validate_text …; the launch is still the first step.)\n' +
        '    3. SAVE — click Save in the recorder window, OR tc_save({ sessionId }) (it clicks that same\n' +
        '       button). Either one writes the re-recorded flow as a NEW VERSION of the SAME TC (story,\n' +
        '       module, suite and history preserved) with the recorded test-data formulas.\n' +
        '       Do NOT use tc_draft_from_journal / tc_save_as_new_version on this flow — that would save twice.\n' +
        '  In-place editing is available with `versionStrategy: "in-place"` (same ops, tc_save instead of a ' +
        'new version) — use it only when the user explicitly does not want a new version.\n\n' +
        'Report-only: this tool writes nothing itself. Pass `testCaseIds` to limit the scan; otherwise the ' +
        'tool walks listTestCases and filters by storyRef (bounded by `scanLimit`, default 200). ' +
        'Test cases that are ALREADY obsolete are skipped (reason "already_obsolete"), so a second run ' +
        'after applying the plan only shows what is still left to do. ' +
        'Requires a live connection.',
      inputSchema: {
        storyId: z.string().describe('Story id or business key (US_123).'),
        testCaseIds: z.array(z.string()).optional().describe(
          'Restrict comparison to these TC ids/keys. Recommended for large projects; otherwise the ' +
          'tool walks up to `scanLimit` TCs.',
        ),
        scope: z.enum(['manual', 'automation', 'both']).optional().describe(
          'Which linked test cases to plan for. Default "both" (manual drift + automation re-record plan).',
        ),
        versionStrategy: z.enum(['new', 'in-place']).optional().describe(
          'How a MANUAL update is written: "new" (default) = new version (v1.0 → v2.0) preserving history; ' +
          '"in-place" = overwrite the current version.',
        ),
        sensitivity: z.enum(['strict', 'normal', 'loose']).optional().describe(
          'Match-strictness for AC↔step overlap. strict=more drift flagged, loose=less. Default normal.',
        ),
        scanLimit: z.number().int().positive().optional().describe(
          'Cap on how many TCs to fetch when `testCaseIds` is omitted. Default 200.',
        ),
        includeTestData: z.boolean().optional().describe(
          'Include the automation brief\'s testdata seeds (default true; costs one extra read per ' +
          'automation TC). Set false for a fast check.',
        ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ storyId, testCaseIds, scope, versionStrategy, sensitivity, scanLimit, includeTestData }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.getStory) return err('This product does not expose a user-story backlog.');

      try {
        const story = await adapter.getStory(storyId);

        // Resolve candidate TCs.
        let candidates: TestCase[] = [];
        if (testCaseIds && testCaseIds.length > 0) {
          candidates = await Promise.all(testCaseIds.map((id) => adapter.getTestCase(id)));
        } else {
          const cap = scanLimit ?? 200;
          const summaries = await adapter.listTestCases({ limit: cap });
          const fetched = await Promise.all(summaries.map((s) => adapter.getTestCase(s.id)));
          candidates = fetched.filter((tc) => tc.storyRef === story.id || tc.storyRef === story.key);
        }

        const sens: Sensitivity = sensitivity ?? 'normal';
        const wantManual = (scope ?? 'both') !== 'automation';
        const wantAutomation = (scope ?? 'both') !== 'manual';
        const strategy = versionStrategy ?? 'new';
        const acs = splitAcceptanceCriteria(story.acceptanceCriteria);

        const plan: SyncPlanItem[] = [];
        const skipped: SkippedTC[] = [];
        let manualConsidered = 0;
        let automationConsidered = 0;

        for (const raw of candidates) {
          if (!raw.id) {
            skipped.push({ testCaseId: '', title: raw.title, reason: 'no_id' });
            continue;
          }
          // Compare the NEWEST version, not the default read (versions[0] = v1.0). After an update
          // was saved as v2.0 the default read is stale, and analysing it would re-report drift that
          // is already fixed and hand back the wrong `nextVersionName`.
          const tcId = raw.id;
          let tc: TestCase & { id: string } = { ...raw, id: tcId };
          const latest = latestVersionId(raw);
          if (latest && latest !== raw.currentVersionId) {
            // Merge over `raw` (not replace): the version read must win for `steps`, but TC-level
            // flags it does not return (e.g. `obsolete`) must not be lost.
            try { tc = { ...raw, ...(await adapter.getTestCase(tcId, latest)), id: tcId }; }
            catch { /* keep the default-version read */ }
          }
          // Already retired by a previous sync: nothing left to plan. Without this the same
          // obsolete item came back on EVERY run and the plan never converged.
          if (tc.obsolete === true) {
            skipped.push({ testCaseId: tc.id, title: tc.title, reason: 'already_obsolete' });
            continue;
          }
          const isManual = tc.category === 'manual';

          if (isManual) {
            if (!wantManual) {
              skipped.push({ testCaseId: tc.id, title: tc.title, reason: 'manual_tc_out_of_scope' });
              continue;
            }
            manualConsidered++;
            const drift = computeDrift(story, tc, sens);
            plan.push({
              kind: 'manual',
              testCaseId: tc.id,
              title: tc.title,
              driftScore: drift.allOrphaned ? 'major' : drift.driftScore,
              signals: drift.signals,
              proposedOps: drift.proposedOps,
              unresolved: drift.unresolved,
              ...(drift.allOrphaned ? { action: 'obsolete' as const } : {}),
              // A clean item writes nothing, so it must not name a next version either.
              ...(drift.allOrphaned || drift.driftScore !== 'none'
                ? { nextVersionName: nextVersionName(tc) }
                : {}),
              versionStrategy: strategy,
            });
            continue;
          }

          // AUTOMATION
          if (!wantAutomation) {
            skipped.push({ testCaseId: tc.id, title: tc.title, reason: 'automation_tc_out_of_scope' });
            continue;
          }
          automationConsidered++;
          const cov = computeAutomationCoverage(story, tc, sens);
          const userstoryId = numericSuffix(tc.storyRef) ?? numericSuffix(story.id);
          const moduleId = moduleOf(tc);
          const technology = technologyOf(tc);
          let testData: Array<{ name: string; seed: string; protected?: boolean }> | undefined;
          if (includeTestData !== false && adapter.getDefaultIteration) {
            try {
              const it = await adapter.getDefaultIteration({
                tcId: tc.id,
                ...(tc.currentVersionId ? { versionId: tc.currentVersionId } : {}),
              });
              if (it.parameters.length) {
                testData = it.parameters.map((p) => ({
                  name: p.name,
                  seed: p.seed ?? '',
                  ...(p.protected ? { protected: true } : {}),
                }));
              }
            } catch {
              // testdata is best-effort — a broken store must not block the plan
            }
          }
          // Nothing recorded represents any current AC → the recorded scenario was removed; obsolete
          // the TC instead of asking for a re-record with zero criteria.
          const autoOrphaned = tc.steps.length > 0 && cov.coverage === 0;
          plan.push({
            kind: 'automation',
            testCaseId: tc.id,
            title: tc.title,
            action: autoOrphaned ? 'obsolete' : (cov.covered ? 'up-to-date' : 'rerecord'),
            coverage: Math.round(cov.coverage * 100) / 100,
            missingAcs: cov.missingAcs,
            ...(autoOrphaned || cov.covered ? {} : { nextVersionName: nextVersionName(tc) }),
            brief: {
              storyId: story.id ?? '',
              ...(story.key ? { storyKey: story.key } : {}),
              ...(userstoryId !== undefined ? { userstoryId } : {}),
              ...(moduleId !== undefined ? { moduleId } : {}),
              testcaseName: tc.title,
              ...(technology ? { technology } : {}),
              currentStepCount: tc.steps.length,
              acceptanceCriteria: acs,
              currentSteps: tc.steps.map((s) => s.description),
              ...(testData ? { testData } : {}),
            },
          });
        }

        const manualDrifted = plan.filter(
          (p): p is Extract<SyncPlanItem, { kind: 'manual' }> => p.kind === 'manual' && p.driftScore !== 'none',
        );
        const manualClean = plan.filter((p) => p.kind === 'manual' && p.driftScore === 'none');
        const autoRerecord = plan.filter(
          (p): p is Extract<SyncPlanItem, { kind: 'automation' }> => p.kind === 'automation' && p.action === 'rerecord',
        );
        const autoClean = plan.filter((p) => p.kind === 'automation' && p.action === 'up-to-date');

        const lines: string[] = [];
        lines.push(`Story **${story.title}**${story.key ? ` · ${story.key}` : ''}`);
        lines.push('');
        lines.push(
          `${acs.length} acceptance criteri${acs.length === 1 ? 'on' : 'a'} · ` +
            `${manualConsidered} manual TC${manualConsidered === 1 ? '' : 's'} (${manualDrifted.length} drifted, ` +
            `${manualClean.length} clean) · ${automationConsidered} automation TC${automationConsidered === 1 ? '' : 's'} ` +
            `(${autoRerecord.length} to re-record, ${autoClean.length} up-to-date) · ${skipped.length} skipped.`,
        );

        if (acs.length) {
          lines.push('', '**Acceptance criteria**');
          lines.push(acs.map((a, i) => `${i + 1}. ${a}`).join('\n'));
        }

        if (manualDrifted.length) {
          lines.push('', '**Manual — update as a new version**');
          for (const p of manualDrifted) {
            lines.push(
              `- **${p.title}** (${p.testCaseId}) — ${p.driftScore} · ${p.signals.length} signal(s) · ` +
                `${p.proposedOps.length} op(s) · next version **${p.nextVersionName}**`,
            );
            for (const s of p.signals) {
              if (s.kind === 'ac_added') lines.push(`    + added AC: ${s.text}`);
              else if (s.kind === 'ac_removed') lines.push(`    – removed AC: ${s.text}`);
              else if (s.kind === 'ac_reworded') lines.push(`    ~ reworded: ${s.from} → ${s.to}`);
              else if (s.kind === 'step_stale') lines.push(`    ? step ${s.n}: ${s.reason}`);
              else if (s.kind === 'title_review') lines.push(`    ! title review: "${s.currentTitle}" — ${s.hint}`);
            }
          }
          lines.push(
            '',
            strategy === 'new'
              ? 'Apply each: `tc_draft_from_tc({ tcId })` → `tc_draft_update({ draftId, ops })` → ' +
                  '`tc_save_as_new_version({ tcId, fromDraftId: draftId })`.'
              : 'Apply each in place: `tc_draft_from_tc({ tcId })` → `tc_draft_update({ draftId, ops })` → `tc_save({ draftId })`.',
          );
        } else if (manualConsidered) {
          lines.push('', '_No manual drift._');
        }

        if (autoRerecord.length) {
          lines.push(
            '',
            '**Automation — re-record ONE AT A TIME (each item is a separate recording session)**',
          );
          autoRerecord.forEach((p, i) => {
            lines.push(
              `${i + 1}. **${p.title}** (${p.testCaseId}) — ${p.missingAcs.length}/${acs.length} AC(s) not ` +
                `represented (coverage ${Math.round(p.coverage * 100)}%) · next version **${p.nextVersionName}**`,
            );
            lines.push(
              `    activate: technology=${p.brief.technology ?? 'WEB'}, testcaseName="${p.brief.testcaseName}", ` +
                `userstoryId=${p.brief.userstoryId ?? '?'}, moduleId=${p.brief.moduleId ?? '?'}`,
            );
            lines.push(`    current steps: ${p.brief.currentStepCount}`);
            if (p.missingAcs.length) {
              lines.push(`    cover: ${p.missingAcs.map((a) => `"${a}"`).join(' · ')}`);
            }
          });
          lines.push(
            '',
            'After each recording: `core_close_session()` → ask the user to review → ' +
              '`tc_draft_from_journal({ sessionId })` → `tc_save_as_new_version({ tcId, fromDraftId, tdCopy })`. ' +
              'Do NOT click Save in the recorder window for this flow (it creates a separate new TC).',
          );
        } else if (automationConsidered) {
          lines.push('', '_All linked automation TCs already cover the acceptance criteria._');
        }

        if (skipped.length) {
          lines.push('', '_Skipped:_');
          for (const s of skipped) lines.push(`- ${s.title} (${s.testCaseId || '—'}): ${s.reason}`);
        }

        return ok(lines.join('\n'), {
          story,
          acceptanceCriteria: acs,
          plan,
          next: plan.find((p) => (p.kind === 'manual'
            ? (p.action === 'obsolete' || p.driftScore !== 'none')
            : p.action !== 'up-to-date')) ?? null,
          skipped,
          counts: {
            manual: manualConsidered,
            manualDrifted: manualDrifted.length,
            automation: automationConsidered,
            automationRerecord: autoRerecord.length,
            obsolete: plan.filter((p) => (p as { action?: string }).action === 'obsolete').length,
          },
        });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
