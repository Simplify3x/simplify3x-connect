import type { Step } from '../domain/types.js';

/** Which steps a bulk edit ("skip every step that uses X") applies to. Every given criterion must match. */
export type StepWhere = {
  /** Explicit step numbers. */
  numbers?: number[] | undefined;
  /** Inclusive step-number range. */
  from?: number | undefined;
  to?: number | undefined;
  stepType?: string | undefined;
  /** Action name or id as the step carries it (case-insensitive). */
  actionType?: string | undefined;
  /** Object display name (case-insensitive) or id. */
  object?: string | undefined;
  /** Text the step's description contains (case-insensitive). */
  descriptionContains?: string | undefined;
  /** A parameter the step uses, by name — matched on its `${name}` tokens, recorded value names and `{{name}}` references. */
  parameter?: string | undefined;
  /** Required to apply a patch to EVERY step; without it an empty `where` is refused. */
  all?: boolean | undefined;
};

const has = (hay: string | undefined, needle: string): boolean => (hay ?? '').toLowerCase().includes(needle.toLowerCase());

function usesParameter(s: Step, name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  const tokens = [`\${${n}}`, `{{${n}}}`];
  const texts = [s.description, ...Object.values(s.recordedParam ?? {})].filter((t): t is string => typeof t === 'string');
  return texts.some((t) => tokens.some((tok) => t.includes(tok))) || Object.keys(s.recordedParam ?? {}).some((k) => k.toLowerCase() === n.toLowerCase());
}

/** Step numbers matching `where`. Throws when `where` is empty without `all`, or nothing matches — a bulk edit that silently
 *  changes everything, or nothing, is worse than an error. */
export function matchStepNumbers(steps: Step[], where: StepWhere): number[] {
  const criteria = [where.numbers?.length, where.from, where.to, where.stepType, where.actionType, where.object, where.descriptionContains, where.parameter]
    .filter((c) => c !== undefined && c !== null && c !== '').length;
  if (criteria === 0 && !where.all) {
    throw new Error('update_steps: "where" is empty — give at least one criterion (numbers, from/to, stepType, actionType, object, descriptionContains, parameter) or set all:true to change every step.');
  }
  const hits = steps.filter((s) => {
    if (where.numbers?.length && !where.numbers.includes(s.n)) return false;
    if (where.from !== undefined && s.n < where.from) return false;
    if (where.to !== undefined && s.n > where.to) return false;
    if (where.stepType && s.stepType !== where.stepType) return false;
    if (where.actionType && String(s.actionType ?? '').toLowerCase() !== where.actionType.trim().toLowerCase()) return false;
    if (where.object) {
      const o = where.object.trim().toLowerCase();
      if (String(s.objectRef?.id ?? '').toLowerCase() !== o && String(s.objectRef?.name ?? '').trim().toLowerCase() !== o) return false;
    }
    if (where.descriptionContains && !has(s.description, where.descriptionContains)) return false;
    if (where.parameter && !usesParameter(s, where.parameter)) return false;
    return true;
  });
  if (!hits.length) throw new Error('update_steps: no step matches that "where" — nothing was changed.');
  return hits.map((s) => s.n);
}
