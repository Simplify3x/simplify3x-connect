import type { Step } from '../domain/types.js';

/** Openers and their closers: a copied range must contain whole blocks, never half of one. */
const OPENS: Record<string, string> = {
  IF: 'IF_END', FOR_START: 'FOR_END', WHILE_START: 'WHILE_END', ITERATOR_START: 'ITERATOR_END',
};
const CLOSES = new Set(Object.values(OPENS));

const kindOf = (s: Step): string =>
  s.stepType === 'function' ? 'FUNCTION'
  : s.stepType === 'function_end' ? 'FUNCTION_END'
  : s.stepType === 'control_flow' ? String(s.controlFlow?.kind ?? '').toUpperCase()
  : '';

/**
 * Copies of steps `n..through` (inclusive, by step number) ready to be inserted anywhere — the whole step, nothing
 * rebuilt from a summary: parameter bindings, recorded values, object, flags, browser, API request, conditions and every
 * other saved field travel with the clone. The ONE thing a copy must not inherit is the original's identity
 * (`sourceId`): with it the save would treat the copy as the same row and overwrite the original.
 *
 * Refuses a range that would split a block (IF…IF_END, loops, a function call and its end) — a lone opener or closer
 * produces a test case the agent cannot run — and a block-opening step with no `through` to say where the block ends.
 */
export function duplicateSteps(steps: Step[], n: number, through?: number): Step[] {
  const from = steps.findIndex((s) => s.n === n);
  if (from < 0) throw new Error(`duplicate_step: no step numbered ${n} (the test case has ${steps.length} step(s)).`);
  const last = through ?? n;
  const to = steps.findIndex((s) => s.n === last);
  if (to < 0) throw new Error(`duplicate_step: no step numbered ${last} (the test case has ${steps.length} step(s)).`);
  if (to < from) throw new Error(`duplicate_step: "through" (${last}) comes before step ${n}.`);

  const range = steps.slice(from, to + 1);
  const first = kindOf(range[0]!);
  if (through == null && (first === 'FUNCTION' || OPENS[first])) {
    throw new Error(
      `duplicate_step: step ${n} opens a block (${first}). Give "through" = the number of the last step of that block ` +
      `(its ${first === 'FUNCTION' ? 'FUNCTION_END' : OPENS[first]}) so the whole block is copied.`,
    );
  }
  // Balance check — every opener in the range needs its closer in the range, and no closer may come first.
  const open: string[] = [];
  for (const s of range) {
    const k = kindOf(s);
    if (k === 'FUNCTION') open.push('FUNCTION_END');
    else if (OPENS[k]) open.push(OPENS[k]!);
    else if (k === 'FUNCTION_END' || CLOSES.has(k)) {
      if (open.pop() !== k) {
        throw new Error(`duplicate_step: steps ${n}-${last} contain a ${k} whose opening step is outside the range — copy the whole block.`);
      }
    }
  }
  if (open.length) {
    throw new Error(`duplicate_step: steps ${n}-${last} open a block that is not closed inside the range (missing ${open[open.length - 1]}) — extend "through".`);
  }

  return range.map((s) => {
    const copy = JSON.parse(JSON.stringify(s)) as Step;
    delete copy.sourceId;
    copy.n = 0;   // renumbered by the caller
    return copy;
  });
}
