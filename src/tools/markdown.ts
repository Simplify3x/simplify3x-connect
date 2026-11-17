import type { Condition, Step, TestCase, ValidationIssue } from '../domain/types.js';

// Full SQA control-flow set. Labels mirror tcfn.service.js:2176 stepTypeMapping so `tc_get`
// output matches what the user sees in the SQA UI. Values keyed by the RAW SQA `stepType`
// (upper-case) — the mapper carries that verbatim onto `controlFlow.kind` for control rows.
const CF_LABEL: Record<string, string> = {
  IF: 'IF', ELSE_IF: 'ELSE IF', ELSE: 'ELSE', IF_END: 'END IF',
  WHILE_START: 'WHILE', WHILE: 'WHILE', WHILE_END: 'END WHILE',
  DO: 'DO', DO_WHILE: 'DO WHILE',
  FOR_START: 'FOR', FOR_END: 'END FOR',
  LOOP: 'LOOP',
  ITERATOR_START: 'START ITERATOR', ITERATOR_END: 'END ITERATOR',
  LOOP_ITERATION_START: 'START ITERATION', LOOP_ITERATION_END: 'END ITERATION',
  FUNCTION_END: 'END FUNCTION',
  BREAK: 'BREAK', CONTINUE: 'CONTINUE',
  // Legacy small-cased forms — used by the Walnut adapter today. Keep for compatibility.
  if: 'IF', else: 'ELSE', if_end: 'END IF', while: 'WHILE', while_end: 'END WHILE',
};
// Kinds that OPEN a new block (indent everything after them). FUNCTION isn't here — the
// function row itself gets no controlFlow.kind (its stepType is 'function'), and its body
// isn't inlined into the caller TC's steps[] anyway. Only FUNCTION_END dedents.
const CF_OPEN = new Set([
  'IF', 'ELSE_IF', 'ELSE',
  'WHILE_START', 'WHILE', 'DO',
  'FOR_START', 'LOOP',
  'ITERATOR_START', 'LOOP_ITERATION_START',
  // legacy
  'if', 'else', 'while',
]);
const CF_CLOSE = new Set([
  'IF_END', 'WHILE_END', 'FOR_END', 'DO_WHILE',
  'ITERATOR_END', 'LOOP_ITERATION_END',
  'FUNCTION_END',
  // legacy
  'if_end', 'while_end',
]);
// ELSE / ELSE_IF: dedent BEFORE render, indent AFTER — they live between the IF and IF_END and
// should visually line up with the IF, not stack under its body.
const CF_MIDDLE = new Set(['ELSE', 'ELSE_IF', 'else']);

// Markdown table cells collapse leading plain spaces, so a nested step's indent
// would otherwise be invisible in most renderers (and in a raw-text CLI, plain
// spaces at a cell boundary are easy to miss entirely). &nbsp; survives both.
const INDENT_UNIT = '&nbsp;&nbsp;';

function escCell(v: unknown): string {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function conditionText(c: Condition | undefined, conditionText: string | undefined, maxIterations: number | undefined): string {
  // Prefer the raw ifstring — that's the human-readable expression the SQA UI shows. Falls back
  // to the structured Condition shape (Walnut) when ifstring is absent.
  if (conditionText) return conditionText;
  if (!c) return maxIterations ? `max ${maxIterations} iterations` : '';
  const bits = [
    c.type,
    c.selector,
    c.text != null ? JSON.stringify(c.text) : undefined,
    c.variableName ? `${c.variableName}${c.variableValue != null ? ` = ${c.variableValue}` : ''}` : undefined,
  ].filter((b): b is string => !!b);
  return bits.join(' · ');
}

/** Row description for a FUNCTION-call step: prefer the resolved FN code/name, fall back to the
 *  bare id. Kept short so the description column stays readable in the markdown table. */
function functionCallDescription(s: Step): string {
  const fc = s.functionCall;
  if (!fc) return '';
  const ref = fc.testCaseCode
    ? `${fc.testCaseCode}${fc.testCaseName ? ` / ${fc.testCaseName}` : ''}`
    : fc.testCaseName ?? `fn:${fc.testCaseId}`;
  const shared = fc.sharedProjectId ? ` · shared PR-${fc.sharedProjectId}` : '';
  return `${ref}${shared}`;
}

/**
 * Readable markdown steps table shared by every draft-returning tool (spec:
 * "one shared helper, not duplicated per tool"). Depth tracking mirrors
 * src/ui/editor.ts's own JS renderer: CF_CLOSE rows dedent BEFORE rendering (so
 * `END IF` lines up with its `IF`), CF_MIDDLE (ELSE/ELSE_IF) dedents-before then
 * indents-after, and CF_OPEN rows indent everything AFTER.
 */
export function stepsMarkdown(tc: TestCase): string {
  if (!tc.steps.length) return '_(no steps yet)_';

  const rows: string[] = [
    '| # | action | object | description | value | expected |',
    '|---|---|---|---|---|---|',
  ];
  let depth = 0;

  for (const s of tc.steps) {
    const kind = s.controlFlow?.kind;
    if (kind && (CF_CLOSE.has(kind) || CF_MIDDLE.has(kind))) depth = Math.max(0, depth - 1);

    const indent = INDENT_UNIT.repeat(depth);

    let action: string;
    let object: string;
    let description: string;
    let value: string;

    if (s.stepType === 'function') {
      action = '**FUNCTION**';
      object = escCell(functionCallDescription(s));
      description = `${indent}${escCell(s.description)}`;
      value = escCell(
        s.functionCall?.versionName
          ? `fnVersion:${s.functionCall.versionName}`
          : s.functionCall?.versionId
            ? `fnVersion:${s.functionCall.versionId}`
            : '',
      );
    } else if (kind) {
      action = `**${CF_LABEL[kind] ?? kind}**`;
      object = '';
      description = `${indent}${escCell(s.description)}`;
      value = escCell(conditionText(s.controlFlow?.condition, s.controlFlow?.conditionText, s.controlFlow?.maxIterations));
    } else {
      action = `\`${s.actionType}\``;
      // Object name (from disname, hydrated by the adapter). `missing:true` means the id was
      // looked up and did NOT resolve — a genuinely broken reference (deleted object) — and must
      // render as a clear warning, never silently as if it were just an unnamed object. Empty for
      // action steps that don't target an object (Launch, Wait, …).
      object = s.objectRef?.name
        ? `**${escCell(s.objectRef.name)}**`
        : s.objectRef?.missing
          ? escCell(`⚠ MISSING OBJECT #${s.objectRef.id}`)
          : s.objectRef?.id
            ? escCell(`#${s.objectRef.id}`)
            : '';
      description = `${indent}${escCell(s.description)}`;
      value = escCell(s.value);
    }

    const expected = escCell(s.expectedResult);
    rows.push(`| ${s.n} | ${action} | ${object} | ${description} | ${value} | ${expected} |`);

    if (kind && (CF_OPEN.has(kind) || CF_MIDDLE.has(kind))) depth++;
  }

  return rows.join('\n');
}

/** The one-line validation summary every draft-returning tool includes
 * alongside its steps table and draftId, e.g. "10 steps · validation ✓". */
export function validationSummaryLine(tc: TestCase, issues: ValidationIssue[]): string {
  const n = tc.steps.length;
  const noun = `${n} step${n === 1 ? '' : 's'}`;
  if (!issues.length) return `${noun} · validation ✓`;
  const detail = issues.map((i) => `step ${i.step ?? '-'}${i.field ? ` (${i.field})` : ''}: ${i.msg}`).join('; ');
  return `${noun} · validation ✗ -- ${detail}`;
}
