/**
 * WHILE / DO-WHILE (and IF / ELSE IF) written through the MCP.
 *
 * SimplifyQA's block markers, as the editor's block map and the agent's executor both read them:
 *   WHILE_START … WHILE_END        a WHILE — the condition is on WHILE_START
 *   DO … WHILE                     a DO-WHILE — the condition is on the CLOSING `WHILE`
 * A bare `WHILE` is therefore the CLOSER of a DO-WHILE. Saving "while" as `WHILE` (what an uppercased `kind` gave) made
 * an unmatched closer, and the editor hides every step after it. And a condition is not a text label: it is
 * `conditions.children` rows (an element check = action + object) plus the readable `ifstring`, which the backend
 * refuses to run without ("conditionString is not allowed to be empty").
 */
import type { Condition, Step } from '../../domain/types.js';

const norm = (kind: string): string => kind.trim().toLowerCase().replace(/[\s-]+/g, '_');

/** The kinds whose condition the editor and the agent read. */
export const CONDITION_KINDS = new Set(['IF', 'ELSE_IF', 'WHILE_START', 'WHILE']);

/** Marker kinds of the two loop forms (after normalizing). */
const OPEN_WHILE = new Set(['while', 'while_start', 'start_while']);
const CLOSE_WHILE = new Set(['end_while', 'while_end', 'endwhile']);
const OPEN_DO = new Set(['do', 'start_do_while', 'do_while_start']);
const CLOSE_DO = new Set(['end_do_while', 'do_while_end', 'do_while_condition']);

/**
 * Turn the loose kinds a caller writes ("while", "end_while", "do_while", "end_do_while") into the wire markers. The two
 * ambiguous words are settled by the block they sit in: `while` / `do_while` close a DO that is still open, and open a new
 * block otherwise. Steps read back from SimplifyQA (they carry their raw `stepType`) are left exactly as stored.
 * Mutates `controlFlow.kind`; returns what it changed, for the save to report.
 */
export function normalizeLoopKinds(steps: Step[]): string[] {
  const notes: string[] = [];
  const open: Array<'DO' | 'WHILE_START' | 'OTHER'> = [];
  steps.forEach((s, i) => {
    const cf = s.controlFlow;
    if (s.stepType !== 'control_flow' || !cf?.kind) return;
    const raw = cf.kind;
    const stored = typeof s.sourceRaw?.['stepType'] === 'string';
    const k = norm(raw);
    let kind = raw.toUpperCase();
    const top = open[open.length - 1];
    if (!stored) {
      if (k === 'while' || k === 'do_while') kind = top === 'DO' ? 'WHILE' : (k === 'while' ? 'WHILE_START' : 'DO');
      else if (OPEN_WHILE.has(k)) kind = 'WHILE_START';
      else if (CLOSE_WHILE.has(k)) kind = 'WHILE_END';
      else if (OPEN_DO.has(k)) kind = 'DO';
      else if (CLOSE_DO.has(k)) kind = 'WHILE';
      else kind = raw.toUpperCase();
    }
    if (kind !== raw) { notes.push(`step ${i + 1}: control flow "${raw}" saved as ${kind}`); cf.kind = kind; }
    const wire = (typeof s.sourceRaw?.['stepType'] === 'string' ? String(s.sourceRaw['stepType']) : kind).toUpperCase();
    if (wire === 'DO') open.push('DO');
    else if (wire === 'WHILE_START') open.push('WHILE_START');
    else if (wire === 'WHILE' && top === 'DO') open.pop();
    else if (wire === 'WHILE_END' && top === 'WHILE_START') open.pop();
  });
  return notes;
}

/** Block problems a save should warn about (a WHILE / DO that never closes, a stray closer). Never blocks a save. */
export function loopBlockProblems(steps: Step[]): string[] {
  const out: string[] = [];
  const stack: Array<{ kind: 'DO' | 'WHILE_START'; at: number }> = [];
  steps.forEach((s, i) => {
    if (s.stepType !== 'control_flow') return;
    const wire = String(s.sourceRaw?.['stepType'] ?? s.controlFlow?.kind ?? '').toUpperCase();
    const at = `step ${i + 1}`;
    if (wire === 'WHILE_START' || wire === 'DO') stack.push({ kind: wire as 'DO' | 'WHILE_START', at: i + 1 });
    else if (wire === 'WHILE_END') {
      if (stack[stack.length - 1]?.kind === 'WHILE_START') stack.pop();
      else out.push(`${at}: WHILE_END has no WHILE_START before it — the editor will hide the steps from here on.`);
    } else if (wire === 'WHILE') {
      if (stack[stack.length - 1]?.kind === 'DO') stack.pop();
      else out.push(`${at}: a bare WHILE closes a DO-WHILE, but no DO is open. A WHILE loop is "while" … "end_while".`);
    }
  });
  for (const o of stack) {
    out.push(`step ${o.at}: ${o.kind === 'DO' ? 'DO has no closing WHILE (end_do_while)' : 'WHILE has no WHILE_END (end_while)'} — the editor will hide the steps after it.`);
  }
  return out;
}

/** Catalog names an element-check type may stand for: `element_displayed` is the action `elementIsDisplayed`. */
export function elementCheckNames(type: string): string[] {
  const n = type.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const names = [n, n.replace(/^element(?!is)/, 'elementis'), n.replace(/^element(not)/, 'elementisnot'), n.replace(/^is/, 'elementis')];
  return [...new Set(names)];
}

/** A step's own condition(s), normalized: the single `condition` first, then `conditions`. */
export function stepConditions(step: Step): Condition[] {
  const cf = step.controlFlow;
  return [...(cf?.condition ? [cf.condition] : []), ...(cf?.conditions ?? [])];
}

export type LoopConditionDeps = {
  projectId: number;
  /** The TC's technology (WEB / ANDROID / …) — written on every condition row. */
  technology: string;
  /** The catalog action for one of the candidate names / a plugin uniqueId; undefined when none exists. */
  action: (names: string[], uniqueId?: string) => { id: number; displayName?: string | undefined; name?: string | undefined; objectRequired?: boolean } | undefined;
  /** The checked object: its numeric id and name (by id, or by name). Throws when it does not exist. */
  object: (ref: { objectId?: string | undefined; objectName?: string | undefined }) => Promise<{ id: number; name: string }>;
};

/**
 * The step's `conditions`, as the recorder writes an IF's (AgentStepBroadcaster.conditionChild): one `NORMAL_STATEMENT` row
 * per element check, joined AND / OR, and the readable `ifstring` the editor writes (`WHILE_START ( (Element is Displayed
 * ( Add Employee tab )) )`). An unsupported check is refused — a row with no real check would save fine and fail at run time.
 */
export async function buildConditionRows(
  stepType: string,
  specs: Condition[],
  deps: LoopConditionDeps,
): Promise<{ ifstring: string; children: Array<Record<string, unknown>> }> {
  const children: Array<Record<string, unknown>> = [];
  let text = `${stepType} (`;
  let seq = 0;
  for (const spec of specs) {
    seq++;
    const type = String(spec.type ?? '').trim();
    if (!type) throw new Error(`${stepType} condition ${seq}: "type" is required — the check to make, e.g. "element_displayed".`);
    if (/^(value|variable|compare)/i.test(type) || spec.variableName) {
      throw new Error(
        `${stepType} condition ${seq}: comparing a value (type "${type}") can't be saved from here yet — the run reads a compared literal from ` +
        'the test data, which this save does not write. Use an element check (element_displayed, element_enabled, …), or set that condition in the SimplifyQA editor.',
      );
    }
    const action = deps.action(elementCheckNames(type), type);
    if (!action) {
      throw new Error(
        `${stepType} condition ${seq}: no element-check action matches "${type}". Use one of: element_displayed, element_not_displayed, ` +
        'element_enabled, element_disabled, element_clickable, element_checked — or the action\'s exact name.',
      );
    }
    if (!spec.objectId && !spec.objectName) {
      throw new Error(`${stepType} condition ${seq}: "${type}" checks an element — give its objectId (or objectName).`);
    }
    const obj = await deps.object({ objectId: spec.objectId, objectName: spec.objectName });
    const logical = String(spec.logical ?? 'AND').toUpperCase() === 'OR' ? 'OR' : 'AND';
    children.push({
      type: 'TC',
      stepType: 'NORMAL_STATEMENT',
      condition: logical,
      actionId: action.id,
      objectId: obj.id,
      selectedObject: [obj.id],
      parameterIds: [] as number[],
      objectParameterIds: [] as number[],
      executionType: 'AUTOMATION',
      technologyType: deps.technology,
      projectId: deps.projectId,
      seq,
      deleted: false,
    });
    text += ` (${action.displayName ?? action.name ?? type} ( ${obj.name} ))${logical === 'AND' ? ' &&' : ' ||'}`;
  }
  // As the editor does: drop the last connector's two signs, then close.
  return { ifstring: children.length ? `${text.slice(0, -2)} )` : '', children };
}
