import { randomUUID } from 'node:crypto';
import type { Step, TestCase } from '../domain/types.js';
import { normalizeParamTokens, normalizeStepProse } from '../paramTokens.js';
import { duplicateSteps } from './duplicate.js';
import { mergeApiPatch } from './apiPatch.js';
import { matchStepNumbers, type StepWhere } from './bulk.js';

export type Draft = { draftId: string; tc: TestCase; updatedAt: number;
  /** Recording session that produced this draft (set when a delegated recorder re-homes its result
   *  here). Lets tc_save close that session's live-recording editor window on the agent after saving. */
  sessionId?: string };

export type DraftOp =
  | { op: 'set_meta'; patch: Partial<TestCase> }
  | { op: 'add_step'; at?: number; step: Omit<Step, 'n'> }
  | { op: 'update_step'; n: number; patch: Partial<Step> }
  | { op: 'add_assertions'; n: number; assertions: import('../domain/types.js').ApiAssertionInput[] }
  | { op: 'remove_step'; n: number }
  | { op: 'remove_steps'; numbers: number[] }
  | { op: 'move_step'; n: number; to: number }
  | { op: 'duplicate_step'; n: number; through?: number; at?: number }
  | { op: 'update_steps'; where: StepWhere; patch: Partial<Step> };

/**
 * Thrown by `get`/`applyOps`/`delete` on an unknown draftId. A distinct class
 * (rather than a bare Error) so the tool layer can catch it specifically if it
 * ever needs to, though today every tool just funnels `e.message` into `err()`.
 */
export class DraftNotFoundError extends Error {
  constructor(draftId: string) {
    super(
      `No draft found for id "${draftId}". Drafts are in-memory only and never ` +
        `persisted -- this id may have been discarded, or the server process may ` +
        `have restarted since it was created.`,
    );
    this.name = 'DraftNotFoundError';
  }
}

/** Normalise `${{name}}` → `${name}` across the draft's prose so the editor preview matches what
 *  tc_save will persist (the payload builder normalises again as a safety net). */
function normalizeDraft(tc: TestCase): TestCase {
  // Only the API-style `${{name}}` is normalised here. The `${name}` wrapper is deliberately KEPT
  // in the draft: the save path extracts parameter names from it first (so the parameter/ITR row is
  // created and bound), and only then strips the braces from the manual step prose.
  const description = normalizeParamTokens(tc.description);
  const preconditions = normalizeParamTokens(tc.preconditions);
  return {
    ...tc,
    ...(description !== undefined ? { description } : {}),
    ...(preconditions !== undefined ? { preconditions } : {}),
    steps: renumber(normalizeFunctionBlocks(tc.steps.map(normalizeStepProse))),
  };
}

function renumber(steps: Step[]): Step[] {
  return steps.map((s, i) => ({ ...s, n: i + 1 }));
}

/** A function call is always a PAIR in SQA: the FUNCTION row carries the reference and the very next
 *  row is its FUNCTION_END (the executor OPENS on FUNCTION and actually RUNS the function on
 *  FUNCTION_END — a lone FUNCTION silently does nothing). The UI always inserts them together, so the
 *  draft enforces the same invariant: an authored `function` step gets its end generated, an explicit
 *  `function_end` is accepted only where it directly closes an opener, and an orphan end is dropped.
 *  Keeps a round-tripped end (sourceId intact) instead of deleting and re-creating it on save. */
function functionEndStep(): Step {
  return { n: 0, stepType: 'function_end', actionType: 'function_end', description: '' };
}

function normalizeFunctionBlocks(steps: Step[]): Step[] {
  const out: Step[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (s.stepType === 'function_end') {
      // Keep a closer only when it directly follows an opener that is still open.
      if (out.at(-1)?.stepType === 'function') out.push(s);
      continue;
    }
    out.push(s);
    if (s.stepType === 'function' && steps[i + 1]?.stepType !== 'function_end') {
      out.push(functionEndStep());
    }
  }
  return out;
}

/** Removing either half of a function call removes the WHOLE call — a half-deleted pair is exactly the
 *  shape that saves fine and then never executes. */
function expandFunctionPairRemoval(steps: Step[], wanted: Set<number>): Set<number> {
  const out = new Set(wanted);
  for (const n of wanted) {
    const idx = steps.findIndex((s) => s.n === n);
    if (idx === -1) continue;
    if (steps[idx]!.stepType === 'function') {
      const end = steps[idx + 1];
      if (end?.stepType === 'function_end') out.add(end.n);
    } else if (steps[idx]!.stepType === 'function_end') {
      const open = steps[idx - 1];
      if (open?.stepType === 'function') out.add(open.n);
    }
  }
  return out;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/**
 * In-memory draft store -- deliberately the ENTIRE persistence layer for this
 * server's authoring mode. The user explicitly does not want test-case drafts
 * written anywhere (no disk spill, no backend write) until a future "save"
 * feature exists; this Map is scoped to this process's lifetime and a restart
 * silently loses every open draft. That data loss is intentional, not a defect --
 * do not "fix" it by adding a spill file or any other persistence.
 */
export class DraftStore {
  private readonly drafts = new Map<string, Draft>();

  create(tc: TestCase, sessionId?: string): string {
    // Random, so a draft id cannot be guessed on a shared server.
    const draftId = `draft_${randomUUID()}`;
    this.drafts.set(draftId, {
      draftId,
      // `${{name}}` tokens are normalised to `${name}` so the editor preview matches what
      // tc_save will persist (and the token binds a real parameter).
      tc: normalizeDraft(tc),
      updatedAt: Date.now(),
      ...(sessionId ? { sessionId } : {}),
    });
    return draftId;
  }

  get(draftId: string): Draft {
    const d = this.drafts.get(draftId);
    if (!d) throw new DraftNotFoundError(draftId);
    return d;
  }

  /**
   * Bind a draft to the product id it was just saved as. After tc_save CREATES a test case, the draft
   * still has no `tc.id`; stamping it here means a later tc_draft_update + tc_save is an UPDATE of that
   * same test case (tc_save keys create-vs-update on `tc.id`) instead of minting a duplicate.
   */
  markSaved(draftId: string, id: string): void {
    const d = this.drafts.get(draftId);
    if (!d) throw new DraftNotFoundError(draftId);
    d.tc = { ...d.tc, id };
    d.updatedAt = Date.now();
  }

  delete(draftId: string): void {
    if (!this.drafts.delete(draftId)) throw new DraftNotFoundError(draftId);
  }

  /** Recording-produced drafts that haven't been persisted yet. `sessionId` is set only by the
   *  delegated-recorder bridge (recording.tools.ts:650); `!tc.id` is the same "was this saved?"
   *  probe tc_save uses at testcase.tools.ts:696. Powers the core_close_session save-guard so a
   *  tear-down can't silently drop a fresh recording (web, mobile, mainframe — any technology). */
  listUnsavedRecordings(): Array<{ draftId: string; sessionId: string; title: string }> {
    const out: Array<{ draftId: string; sessionId: string; title: string }> = [];
    for (const [draftId, d] of this.drafts) {
      if (d.sessionId && !d.tc.id) out.push({ draftId, sessionId: d.sessionId, title: d.tc.title });
    }
    return out;
  }

  /**
   * Applies ops in order, renumbering steps contiguously from 1 after EVERY op
   * (not just at the end) -- later ops in the same call address steps by the
   * number they'd have *after* the previous op, matching how a caller reasons
   * about the draft one op at a time.
   */
  applyOps(draftId: string, ops: DraftOp[]): Draft {
    const current = this.get(draftId);
    let tc = current.tc;

    for (const opItem of ops) {
      tc = applyOne(tc, opItem);
    }

    tc = normalizeDraft(tc);
    const updated: Draft = { draftId, tc, updatedAt: Date.now() };
    this.drafts.set(draftId, updated);
    return updated;
  }
}

function applyOne(tc: TestCase, opItem: DraftOp): TestCase {
  switch (opItem.op) {
    case 'set_meta': {
      // `steps` is deliberately never accepted through set_meta -- steps are
      // exclusively managed by add_step/update_step/remove_step/move_step so
      // renumbering invariants can never be bypassed.
      const { steps: _ignored, ...metaPatch } = opItem.patch;
      return { ...tc, ...metaPatch };
    }
    case 'add_step': {
      const idx = opItem.at != null ? clamp(opItem.at - 1, 0, tc.steps.length) : tc.steps.length;
      const newStep = { ...opItem.step, n: 0 } as Step; // n is overwritten by renumber() below
      const steps = [...tc.steps.slice(0, idx), newStep, ...tc.steps.slice(idx)];
      return { ...tc, steps: renumber(steps) };
    }
    case 'update_steps': {
      // one update_step per matching step, so every step is patched exactly as a single update_step would
      return matchStepNumbers(tc.steps, opItem.where).reduce(
        (acc, n) => applyOne(acc, { op: 'update_step', n, patch: opItem.patch }), tc);
    }
    case 'duplicate_step': {
      const copies = duplicateSteps(tc.steps, opItem.n, opItem.through);
      const idx = opItem.at != null ? clamp(opItem.at - 1, 0, tc.steps.length) : tc.steps.length;
      return { ...tc, steps: renumber([...tc.steps.slice(0, idx), ...copies, ...tc.steps.slice(idx)]) };
    }
    case 'update_step': {
      if (!tc.steps.some((s) => s.n === opItem.n)) {
        throw new Error(`update_step: no step numbered ${opItem.n} (draft has ${tc.steps.length} step(s))`);
      }
      const steps = tc.steps.map((s) => {
        if (s.n !== opItem.n) return s;
        const next: Step = {
          ...s, ...opItem.patch, n: s.n,
          ...(opItem.patch.api ? { api: mergeApiPatch(s, opItem.patch) } : {}),
          ...(opItem.patch.controlFlow ? { controlFlow: { ...s.controlFlow, ...opItem.patch.controlFlow } } : {}),
        } as Step;
        // A recorded step pins its action by plugin uniqueId, which the save prefers over the name — so a changed
        // action must drop the old pin, or the new action name is silently ignored.
        if (opItem.patch.actionType !== undefined && opItem.patch.actionUniqueId === undefined) delete next.actionUniqueId;
        return next;
      });
      return { ...tc, steps: renumber(steps) };
    }
    case 'add_assertions': {
      const target = tc.steps.find((s) => s.n === opItem.n);
      if (!target) {
        throw new Error(`add_assertions: no step numbered ${opItem.n} (draft has ${tc.steps.length} step(s))`);
      }
      if (target.stepType !== 'api' && !(target.api && typeof target.api === 'object')) {
        throw new Error(`add_assertions: step ${opItem.n} is a ${target.stepType} step, not an API step — assertions only exist on API steps.`);
      }
      const steps = tc.steps.map((s) =>
        s.n === opItem.n ? { ...s, api: mergeApiPatch(s, { api: { addAssertions: opItem.assertions } } as Partial<Step>) } : s);
      return { ...tc, steps };
    }
    case 'remove_step': {
      if (!tc.steps.some((s) => s.n === opItem.n)) {
        throw new Error(`remove_step: no step numbered ${opItem.n} (draft has ${tc.steps.length} step(s))`);
      }
      const drop = expandFunctionPairRemoval(tc.steps, new Set([opItem.n]));
      const steps = tc.steps.filter((s) => !drop.has(s.n));
      return { ...tc, steps: renumber(steps) };
    }
    case 'remove_steps': {
      const want = new Set(opItem.numbers);
      const missing = [...want].filter((n) => !tc.steps.some((s) => s.n === n));
      if (missing.length) {
        throw new Error(`remove_steps: no step numbered ${missing.join(', ')} (draft has ${tc.steps.length} step(s))`);
      }
      const drop = expandFunctionPairRemoval(tc.steps, want);
      return { ...tc, steps: renumber(tc.steps.filter((s) => !drop.has(s.n))) };
    }
    case 'move_step': {
      const fromIdx = tc.steps.findIndex((s) => s.n === opItem.n);
      if (fromIdx === -1) {
        throw new Error(`move_step: no step numbered ${opItem.n} (draft has ${tc.steps.length} step(s))`);
      }
      const moved = tc.steps[fromIdx]!;
      const without = [...tc.steps.slice(0, fromIdx), ...tc.steps.slice(fromIdx + 1)];
      const toIdx = clamp(opItem.to - 1, 0, without.length);
      const steps = [...without.slice(0, toIdx), moved, ...without.slice(toIdx)];
      return { ...tc, steps: renumber(steps) };
    }
  }
}
