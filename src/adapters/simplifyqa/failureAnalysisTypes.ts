/**
 * Failure Analysis v2 model: several executions' failure contexts combined into one analysis.
 * Counting unit = a failed test case within one execution (`AnalysisTestcase.key`); each counts once,
 * by its primary pattern group.
 */
import type { ExecutionFailureContext, FailureIteration } from './failureTypes.js';
import type { StepComparison, TestcaseHistory } from './failureHistory.js';
import type { RootCategory, Suggestion } from './failureSuggest.js';

export type Category = RootCategory | 'UNCLASSIFIED';

/** `{ name: '(no suite)' }` when the test case did not run from a suite. */
export type SuiteRef = { id?: string; code?: string; name?: string };


export type AnalysisTestcase = {
  /** `${executionId}:${entryKey}` — the counting unit. */
  key: string;
  executionId: string;
  /** Where it came from, as a code for display: SU-12, a plan code, TC-3, TYPE-id, or Standalone. */
  sourceCode?: string;
  suite: SuiteRef;
  code?: string;
  name?: string;
  description?: string;
  versionName?: string;
  /** key = `${executionId}:${runId}`. */
  failedIterations: Array<{ key: string; it: FailureIteration }>;
  history?: TestcaseHistory;
  /** Every pattern group one of its failed iterations fell into, ascending. */
  groups: number[];
  primaryGroup: number;
};

export type PatternGroup = {
  id: number;
  signature: string;
  cause: string;
  family: string;
  iterationKeys: string[];
  testcaseKeys: string[];
  suites: SuiteRef[];
  representativeKey: string;
  sampleKeys: string[];
  suggested: Suggestion;
  evidenceShown: boolean;
};

export type Verdict = {
  group: number;
  pattern: string;
  rootCause: string;
  category: RootCategory;
  confidence: 'high' | 'medium' | 'low';
};

export type FailureAnalysis = {
  id: string;
  owner: string;
  createdAt: number;
  executions: ExecutionFailureContext['execution'][];
  testcases: AnalysisTestcase[];
  groups: PatternGroup[];
  verdicts: Record<number, Verdict>;
  /** key = iteration key `${executionId}:${runId}`. */
  comparisons: Record<string, StepComparison | null>;
  passedTestcases: number;
  notes: string[];
  /** Test case keys whose review page (`failure_analysis({ analysisId, review: true })`) was shown. */
  reviewedKeys?: string[];
};

export type AnalysisFilter = {
  view?: 'consolidated' | 'suite';
  suiteId?: string;
  pattern?: number | number[];
  category?: Category;
  page?: number;
};

export type CategorySummary = Array<{ category: Category; testcases: number; percent: number }>;
