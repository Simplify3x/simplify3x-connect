import type { Step, TestCase, ValidationIssue } from './types.js';

export function validateTestCase(tc: TestCase, catalogFor: (s: Step) => Set<string>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!tc.title?.trim()) issues.push({ field: 'title', msg: 'title is required' });
  const stack: { kind: 'if' | 'while'; n: number }[] = [];
  /** Open function calls, for balance checking (FUNCTION … FUNCTION_END). */
  const fnStack: number[] = [];
  for (const s of tc.steps) {
    const catalog = catalogFor(s);
    if (s.stepType === 'function') {
      // A function call carries NO action (SQA stores actionId:null on FUNCTION rows) — its only
      // required binding is the function it points at. It is therefore exempt from the action
      // catalog below, exactly like control flow, and must be closed by a FUNCTION_END.
      if (!s.functionCall?.testCaseId) {
        issues.push({ step: s.n, msg: 'function step has no function reference (functionCall.testCaseId)' });
      }
      fnStack.push(s.n);
      continue;
    }
    if (s.stepType === 'function_end') {
      if (!fnStack.length) issues.push({ step: s.n, msg: 'function_end without an open function step' });
      else fnStack.pop();
      continue;
    }
    if (s.stepType === 'control_flow') {
      const k = s.controlFlow?.kind;
      if (k === 'if' || k === 'while') stack.push({ kind: k, n: s.n });
      else if (k === 'else' && stack.at(-1)?.kind !== 'if') issues.push({ step: s.n, msg: 'else without open if' });
      else if (k === 'if_end' && stack.pop()?.kind !== 'if') issues.push({ step: s.n, msg: 'if_end without open if' });
      else if (k === 'while_end' && stack.pop()?.kind !== 'while') issues.push({ step: s.n, msg: 'while_end without open while' });
    } else if (tc.category !== 'manual' && s.stepType !== 'api' && s.stepType !== 'switch' && catalog.size) {
      // Manual test cases are descriptive prose (no automation binding), and API steps carry their
      // request in `api`/`apiData` with no action binding (Postman import + the UI emit
      // actionId:null) — so neither is held to the action-type catalog. A TECHNOLOGY SWITCH is a
      // platform step too (SWITCH_TO_API / _DB / _WEB …); it has no action at all, so requiring an
      // actionType from the catalog rejected every hybrid save with
      // `step 6: actionType "Switch to API" not in catalog`.
      // Only automated web / mobile / mainframe steps must name a real action.
      // Matching is case-INSENSITIVE: SimplifyQA action names are lower-cased on the backend
      // (`executerestapi`) while a model may type any casing.
      const actionType = s.actionType ?? '';
      // Also accept the display name ("Minimum Wait") when the catalog holds it squashed ("minimumwait") —
      // an extra fallback only, so anything that matched before still does.
      const known = catalog.has(actionType) || catalog.has(actionType.toLowerCase())
        || catalog.has(actionType.toLowerCase().replace(/[\s_-]+/g, ''));
      // ponytail: numeric actionType is SQA's backend action id (round-tripped from a hydrated TC)
      // — the catalog is name-keyed, so skip the name check rather than reject.
      if (!known && !/^\d+$/.test(actionType)) {
        issues.push({ step: s.n, msg: `actionType "${s.actionType}" not in catalog` });
      }
    }
  }
  for (const open of stack) issues.push({ step: open.n, msg: `${open.kind} never closed` });
  for (const open of fnStack) {
    issues.push({ step: open, msg: 'function call is never closed (a FUNCTION needs its FUNCTION_END)' });
  }
  return issues;
}
