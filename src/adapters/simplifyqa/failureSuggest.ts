/**
 * A SUGGESTED root category for one failed iteration, from its evidence type and history. Fixed
 * rules, first match wins; the client's AI makes the final call, so this only ever suggests.
 */
import type { FailureIteration } from './failureTypes.js';
import { editedText, type StepComparison, type TestcaseHistory } from './failureHistory.js';
import { classify, type FailureFamily } from './failureCategory.js';
import { emptyReadWarning, unresolvedPlaceholders } from './stepDiagnostics.js';
import { stepData } from './flow.js';

export type RootCategory = 'APP_DEFECT' | 'NEW_CHANGE' | 'AUTOMATION_DATA';
export type Suggestion = { category: RootCategory | null; because: string };

const SETUP_FAMILIES: FailureFamily[] = ['locator', 'timeout', 'interaction', 'session', 'authoring', 'config'];

const passedRef = (h: TestcaseHistory | undefined): string | undefined => {
  const p = h?.lastPassed;
  return p ? (p.executionCode ?? `EX-${p.executionId}`) : undefined;
};

function apiStatus(api: unknown): number | undefined {
  const code = (api as { responseData?: { statusCode?: unknown } } | null | undefined)?.responseData?.statusCode;
  return typeof code === 'number' ? code : undefined;
}

export function suggestCategory(it: FailureIteration, known?: TestcaseHistory, cmp?: StepComparison | null): Suggestion {
  // History that could not be read says nothing: treated exactly like no history.
  const history = known?.status === 'unknown' ? undefined : known;
  const focus = it.focus;
  const cause = it.source === 'step' || focus
    ? (focus?.cause ?? focus?.exception ?? focus?.errorLines[0])
    : it.exception;
  const family = classify(cause ?? it.exception);
  const ref = passedRef(history);

  // 1. The test case itself changed since it last passed: its evidence is no longer comparable.
  if (history?.editedSincePass) {
    return { category: null, because: `test case edited since last pass (${editedText(history.editedSincePass)})` };
  }
  // 2. Failures about locating / reaching / authoring the step.
  if (SETUP_FAMILIES.includes(family)) {
    const note = ref ? `; passed in ${ref} — if the screen changed it is NEW_CHANGE` : '';
    return { category: 'AUTOMATION_DATA', because: `${family} failure${note}` };
  }
  // 3. The step's own test data is broken.
  if (focus && (unresolvedPlaceholders(focus.testdata).length > 0 || emptyReadWarning(focus.description, focus.testdata))) {
    return { category: 'AUTOMATION_DATA', because: 'unresolved placeholder or empty read in the step\'s test data' };
  }
  // 4. The failing step does not exist in the version that passed.
  if (ref && cmp && cmp.found === false) {
    return { category: 'NEW_CHANGE', because: `step no longer in the passed version (${ref})` };
  }
  // 5. Same step, same data, now fails the check it used to pass.
  const status = apiStatus(focus?.apiData);
  if (ref && cmp?.found && (family === 'assertion' || (status !== undefined && status >= 400))) {
    const now = stepData({ testdata: focus?.testdata });
    if (cmp.data === undefined || focus?.testdata === undefined || cmp.data === now) {
      return { category: 'APP_DEFECT', because: `same step and data passed in ${ref}, now fails ${family === 'assertion' ? 'an assertion' : `with API status ${status}`}` };
    }
  }
  // 6. Someone stopped it.
  if (family === 'manual') return { category: null, because: 'stopped manually' };
  // 7. Nothing to go on.
  return { category: null, because: 'no history signal' };
}
