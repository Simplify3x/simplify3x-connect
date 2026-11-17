/**
 * DESKTOP only (plan.md P9.4): the condition rows of an IF / ELSE_IF saved from a recording journal. Before, a journal
 * save wrote the IF with no rows at all. They are built as the recorder window's own Save writes them (the agent's
 * `AgentStepBroadcaster.conditionChild`):
 *  - a value comparison is a `PARAMETER` row that compares two parameters: a stored value by its Runtime parameter, a
 *    literal by a Local parameter whose value the run reads from the test data;
 *  - an element check is a `NORMAL_STATEMENT` row with the check's action and the element's object.
 * Only steps that carry `desktopConditions` are touched, and only DESKTOP journal steps carry it.
 */
import type { DesktopConditionSpec, Step } from '../../domain/types.js';

/** The Local parameter that holds a literal operand. Named after its value, as the recorder window names it, but
 *  never all digits: the save reads an all-digit name as an existing parameter id. */
export function desktopLiteralParamName(value: string): string {
  return `Condition value ${value}`;
}

const isValue = (spec: DesktopConditionSpec): boolean => String(spec.type ?? '').toUpperCase() === 'VALUE';

/** A side of a value comparison is a literal unless the journal tied it to a stored runtime value. */
const isLiteral = (spec: DesktopConditionSpec, side: 'left' | 'right'): boolean =>
  !(side === 'left' ? spec.leftParamUid : spec.rightParamUid);

/** Put each literal operand in the IF step's recorded values, so the save creates its parameter and writes its value
 *  into the test data, where the run reads it. */
export function seedDesktopConditionOperands(step: Step): void {
  for (const spec of step.desktopConditions ?? []) {
    if (!isValue(spec)) continue;
    for (const side of ['left', 'right'] as const) {
      const value = spec[side];
      if (value == null || !isLiteral(spec, side)) continue;
      step.recordedParam = { ...(step.recordedParam ?? {}), [desktopLiteralParamName(value)]: value };
    }
  }
}

export type DesktopConditionDeps = {
  projectId: number;
  /** A parameter's id by name, created when it does not exist. */
  parameterId: (name: string, value: string, type: 'Local' | 'Runtime') => Promise<number>;
  /** The check action by its plugin id; undefined when the catalog has no such action. */
  action: (uniqueId: string) => { id: number; objectTemplate?: number | undefined; displayName?: string | undefined;
    name?: string | undefined } | undefined;
  /** The checked element's object, reused or created with the desktop locator rules: its id and stored name. */
  object: (
    ref: { name: string; locators: Array<{ name: string; value: string; unique?: boolean }> },
    objectTemplate: number,
  ) => Promise<{ id: number; name: string }>;
};

/** The editor's operator symbols (the recorder window's `operatorMap`). */
const OPERATOR_TEXT: Record<string, string> = { eq: '==', lte: '<=', gte: '>=', ne: '!=', gt: '>', lt: '<' };

/**
 * The step's `conditions`: one row per journaled condition, and the readable `ifstring` the editor writes before it
 * saves (the window's `createIfstring`): `IF ( (status == Condition value Deleted 2 )  )`. A run reports that text as
 * the condition, and the backend refuses an empty one ("conditionString is not allowed to be empty", run 70176).
 */
export async function buildDesktopConditionRows(
  step: Step,
  deps: DesktopConditionDeps,
): Promise<{ ifstring: string; children: Array<Record<string, unknown>> }> {
  const children: Array<Record<string, unknown>> = [];
  const stepType = typeof step.sourceRaw?.['stepType'] === 'string' ? (step.sourceRaw['stepType'] as string) : 'IF';
  let text = `${stepType} (`;
  let seq = 0;
  for (const spec of step.desktopConditions ?? []) {
    seq++;
    const base = {
      type: 'TC',
      condition: spec.logical || 'AND',
      executionType: 'AUTOMATION',
      technologyType: 'DESKTOP',
      projectId: deps.projectId,
      seq,
      deleted: false,
    };
    const joiner = base.condition === 'AND' ? ' &&' : ' ||';
    if (isValue(spec)) {
      const operandName = (side: 'left' | 'right'): string => {
        const value = String(spec[side] ?? '');
        return isLiteral(spec, side) ? desktopLiteralParamName(value) : value;
      };
      const operand = (side: 'left' | 'right'): Promise<number> => isLiteral(spec, side)
        ? deps.parameterId(operandName(side), String(spec[side] ?? ''), 'Local')
        : deps.parameterId(operandName(side), '', 'Runtime');
      const operator = spec.operator || 'eq';
      children.push({
        ...base,
        stepType: 'PARAMETER',
        operator,
        parameter1: [await operand('left')],
        parameter2: [await operand('right')],
        showInput: true,
      });
      text += ` (${operandName('left')} ${OPERATOR_TEXT[operator] ?? operator} ${operandName('right')} )${joiner}`;
      continue;
    }
    const uid = String(spec.conditionActionUniqueId ?? '');
    const action = deps.action(uid);
    if (!action) {
      throw new Error(`IF condition ${seq}: the catalog has no desktop action ${uid || '(none)'} for the check "${spec.check ?? ''}".`);
    }
    if (action.objectTemplate == null) throw new Error(`IF condition ${seq}: the action ${uid} has no object template.`);
    const element = spec.conditionObject ?? {};
    const locators = (element.attributes ?? []).map((a) => ({
      name: a.name, value: a.value, ...(a.unique != null ? { unique: a.unique } : {}),
    }));
    if (!locators.length) throw new Error(`IF condition ${seq}: the checked element has no locators.`);
    const object = await deps.object({ name: (element.name ?? '').trim() || 'Condition element', locators },
      action.objectTemplate);
    children.push({
      ...base,
      stepType: 'NORMAL_STATEMENT',
      actionId: action.id,
      objectId: object.id,
      selectedObject: [object.id],
      parameterIds: [] as number[],
      objectParameterIds: [] as number[],
    });
    text += ` (${action.displayName ?? action.name ?? uid} ( ${object.name} ))${joiner}`;
  }
  // As the editor does: drop the last connector's two signs, then close.
  return { ifstring: children.length ? `${text.slice(0, -2)} )` : '', children };
}
