/**
 * Function reuse matching by IDENTITY, not by display name.
 *
 * The old matcher compared the neutral step model (`actionType` + object NAME), so a renamed object,
 * a renamed action, or a different locale broke the match, and it never looked at parameters at all.
 * A recorded/edited test case's steps carry the real identifiers the product uses to decide what a
 * step DOES:
 *
 *   actionId | objectId | stepType | technologyType | parameter names
 *
 * This module fingerprints raw step rows on exactly that tuple and looks for a function's whole body
 * inside a test case. VALUES are deliberately excluded — a function's data is parameterised, so a
 * login recorded with demo/demo must still match a function written with admin/admin.
 *
 * Pure functions only (no I/O): the adapter feeds them the raw rows and resolves parameter ids to
 * names, which keeps the matching unit-testable.
 */

/** Raw step row as the backend returns it (test-management `steps` collection). */
export type RawStep = Record<string, unknown>;

export type MatchConfidence = 'exact' | 'strong';
export type MinConfidence = MatchConfidence;

import type { FunctionReuseCandidate } from '../types.js';

/** A function body found inside a test case (same shape as the provider-neutral type). */
export type FnCandidate = FunctionReuseCandidate;

/** A step that participates in matching. Control flow and nested function brackets never do. */
const BRACKET_TYPES = new Set([
  'FUNCTION', 'FUNCTION_END',
  'IF', 'ELSE_IF', 'ELSE', 'IF_END',
  'FOR_START', 'FOR_END', 'WHILE_START', 'WHILE_END', 'DO', 'DO_WHILE_END',
  'ITERATOR_START', 'ITERATOR_END', 'LOOP_ITERATION_START', 'LOOP_ITERATION_END',
]);

export function isPlainStep(s: RawStep | undefined | null): boolean {
  if (!s || typeof s !== 'object') return false;
  if (s['deleted'] === true) return false;
  const stepType = String(s['stepType'] ?? '').toUpperCase();
  if (BRACKET_TYPES.has(stepType)) return false;
  // Neutral-model rows (journal/draft) use lower-case step types.
  if (stepType === 'CONTROL_FLOW' || stepType === 'FUNCTION') return false;
  return true;
}

export type Fingerprint = {
  /** What the step DOES: step kind + action + element + technology. */
  base: string;
  /** Parameter names the step consumes, sorted + lower-cased (values are never compared). */
  names: string;
};

/** Build the identity tuple for one step. `nameOf` resolves a parameter id to its project-wide name
 *  (ids differ between a function and a recording of the same flow; the names do not). */
export function fingerprint(s: RawStep, nameOf: (id: number) => string | undefined): Fingerprint {
  const action = String(s['actionId'] ?? '');
  const object = s['objectId'] == null ? '' : String(s['objectId']);
  const tech = String(s['technologyType'] ?? '').toUpperCase();
  const kind = String(s['stepType'] ?? '').toUpperCase();
  const ids = [
    ...(Array.isArray(s['parameterIds']) ? s['parameterIds'] : []),
    ...(Array.isArray(s['objectParameterIds']) ? s['objectParameterIds'] : []),
    ...(Array.isArray(s['parameterizedParamIds']) ? s['parameterizedParamIds'] : []),
  ].map((v) => Number(v)).filter((n) => Number.isFinite(n));
  const names = [...new Set(ids)]
    .map((id) => (nameOf(id) ?? `#${id}`).trim().toLowerCase())
    .sort();
  return { base: `${kind}|${action}|${object}|${tech}`, names: names.join(',') };
}

export type Run = { index: number; confidence: MatchConfidence };

/**
 * Every position where `fnSteps` appears as a contiguous run inside `tcSteps`.
 *
 * `exact`  — same action/object/tech AND the same parameter names.
 * `strong` — same action/object/tech, parameters differ (a re-parameterised copy of the same flow).
 *
 * A run never spans a control-flow / nested-function bracket (those steps are not "plain"), and a
 * body of fewer than 2 steps is not distinctive enough to suggest.
 */
export function findRuns(tcSteps: RawStep[], fnSteps: RawStep[], nameOf: (id: number) => string | undefined): Run[] {
  const body = fnSteps.filter(isPlainStep);
  if (body.length < 2) return [];
  const want = body.map((s) => fingerprint(s, nameOf));
  const have = tcSteps.map((s) => fingerprint(s, nameOf));
  const out: Run[] = [];
  for (let i = 0; i + want.length <= tcSteps.length; i++) {
    let confidence: MatchConfidence | null = 'exact';
    for (let j = 0; j < want.length; j++) {
      const a = have[i + j]!;
      const b = want[j]!;
      if (!isPlainStep(tcSteps[i + j])) { confidence = null; break; }
      if (a.base !== b.base) { confidence = null; break; }
      if (a.names !== b.names) confidence = 'strong';
    }
    if (confidence) out.push({ index: i, confidence });
  }
  return out;
}

/** Longest-first, non-overlapping selection so one step is never offered for two functions. */
export function pickNonOverlapping(candidates: FnCandidate[]): FnCandidate[] {
  const sorted = [...candidates].sort((a, b) => b.length - a.length || a.start - b.start);
  const taken = new Set<number>();
  const out: FnCandidate[] = [];
  for (const c of sorted) {
    const idx = Array.from({ length: c.length }, (_, k) => c.start + k);
    if (idx.some((i) => taken.has(i))) continue;
    idx.forEach((i) => taken.add(i));
    out.push(c);
  }
  return out.sort((a, b) => a.start - b.start);
}

export const CONFIDENCE_RANK: Record<MatchConfidence, number> = { exact: 2, strong: 1 };

export function atLeast(actual: MatchConfidence, floor: MinConfidence): boolean {
  return CONFIDENCE_RANK[actual] >= CONFIDENCE_RANK[floor];
}
