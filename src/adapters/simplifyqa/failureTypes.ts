/**
 * Failure-analysis types for SimplifyQA executions (executionFailures.ts).
 *
 * This is deliberately EVIDENCE, not a verdict: the harness/LLM reads the failed step(s), logs,
 * screenshots and FLOW and writes the root-cause summary. The tool must not invent a cause.
 */

export type FailureArtifact = {
  name?: string;
  originalName?: string;
  url: string;
  absoluteUrl: string;
  size?: number;
  fileSize?: string;
  type?: string;
};

/** `info` = not an outcome (see stepRules.INFO_STEP_TYPES); `not_executed` = created but never reached. */
export type FailureStepState = 'passed' | 'failed' | 'skipped' | 'info' | 'not_executed' | 'error' | 'unknown';

export type FailureStep = {
  /** The step-result row's own id. */
  rowId?: string;
  seq: number;
  reportSeq?: number | string;
  displaySeq?: string;
  /** The number the report/PDF prints (`19.19.8`): displaySeq (automated) or reportSeq (manual). */
  reportStep?: string;
  /** The test case's own step this one sits under (`19`). */
  testcaseStep?: string;
  /** "TC step 19 › Login step 3 › Enter credentials step 8". */
  trail?: string;
  /** For a FUNCTION row: the function's name. */
  functionName?: string;
  /** Why the step failed (first real ERROR line, failed API assertion, or exception). */
  cause?: string;
  /** Failure category from fixed rules ("Element not found", "Assertion failed", …). */
  category?: string;
  description: string;
  status: string;
  state: FailureStepState;
  stepType?: string;
  type?: string;
  parentId?: number;
  stepId?: string;
  expected?: string;
  actual?: string;
  exception?: string;
  /** Lines that look like the real failure (ERROR / exception / validation failed / timeout / …). */
  errorLines: string[];
  /** All execution logs, capped by maxLogLines. */
  logs: string[];
  logCount: number;
  screenshots: FailureArtifact[];
  recordedBaseline?: string;
  recordedThumbnail?: string;
  executedThumbnail?: string;
  testdata?: Array<Record<string, unknown>>;
  networkLogs?: unknown;
  apiData?: unknown;
  defectIds?: unknown;
  selfHealed?: boolean;
  objectName?: string;
  actionName?: string;
  locator?: string;
};

/**
 * Whole-execution analysis: `TC-123` / `SU-123` / `PL-123` → its latest (parent) execution, or one
 * named execution. Every failed iteration is analysed; iterations that broke the same way are grouped.
 */
export type ExecutionFailureInput = {
  /** TC-123 | SU-123 | PL-123. Without `executionId`, the latest execution of it is analysed. */
  code?: string;
  /** Numeric execution id or EX code. When set, ONLY this execution is analysed. */
  executionId?: string;
  includeLogs?: boolean;
  maxLogLines?: number;
  includeScreenshots?: boolean;
};

export type FailureIteration = {
  runId: string;
  /** `TC-12 (ITR-2, CHROME)` */
  label: string;
  testcaseCode?: string;
  testcaseName?: string;
  versionName?: string;
  /** This iteration's failure category (its focus step's, else the run exception's). */
  category?: string;
  status: string;
  iteration?: string;
  platform?: string;
  versionId?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  /** Run-level exception (the reason when no step failed, e.g. manual or environment stops). */
  exception?: string;
  /** `step` = a step reported FAILED; `run_level` = the run failed with no failed step. */
  source: 'step' | 'run_level' | 'none';
  /** The failure that explains this iteration (first real failure, or the last step that ran). */
  focus?: FailureStep;
  /** Every real failed step (INFO rows and FUNCTION headings excluded). */
  failedSteps: FailureStep[];
  stepCounts: { total: number; passed: number; failed: number; skipped: number; notExecuted: number };
  /** Cause group number (see ExecutionFailureContext.groups). */
  group?: number;
  /** The whole-test-case context, for a cause's representative only (see flow.ts). */
  flow?: FailureFlow;
  /** Set when this iteration's steps could not be read. */
  readError?: string;
};

/** What a tester reads before judging a failure: the run's flow, what it never reached, how this
 *  call / iteration compares with the others, and warnings from steps that passed. */
export type FailureFlow = {
  lines: string[];
  breakdown?: string;
  notRun?: string[];
  functionCalls?: string;
  /** The same test case's other iterations at this step: passed / failed, with their data. */
  otherIterations?: string[];
  warnings: string[];
};

export type FailureTestcaseEntry = {
  executionItemId: string;
  code?: string;
  name?: string;
  versionId?: string;
  versionName?: string;
  stepId?: string;
  /** Plans: where the test case came from (e.g. `SUITE 123`). */
  source?: string;
  iterations: { total: number; passed: number; failed: number; other: number };
  failedIterations: FailureIteration[];
};

export type FailureGroup = {
  id: number;
  /** Human-readable cause (step + error, or run-level exception). */
  cause: string;
  kind: 'step' | 'run_level';
  /** Failure category of the representative ("Element not found", …). */
  category?: string;
  size: number;
  testcases: string[];
  iterations: string[];
  /** The iteration that carries this group's full evidence (logs/screenshots). */
  representative: string;
  representativeRunId: string;
};

export type ExecutionFailureContext = {
  input: { code?: string; executionId?: string; resolvedBy: 'executionId' | 'latest' };
  execution: {
    id: string;
    code?: string;
    type: string;
    status: string;
    executionTypeCode?: string;
    executionTypeName?: string;
    /** The execution's environment (`environmentType`). */
    environment?: string;
    childExecution?: boolean;
    startedAt?: string;
    endedAt?: string;
    durationMs?: number;
    exception?: string;
    reportUrl?: string;
  };
  counts: {
    runs: number;
    failedRuns: number;
    analysedRuns: number;
    testcases: number;
    failedTestcases: number;
    passedTestcases: number;
  };
  /** Test case entries whose every iteration passed (codes). */
  passed?: string[];
  groups: FailureGroup[];
  testcases: FailureTestcaseEntry[];
  notes: string[];
};
