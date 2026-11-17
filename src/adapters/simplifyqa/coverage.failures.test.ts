/**
 * Wave-2 coverage: the failure-analysis stack — `executionFailures.ts` (the I/O around one
 * execution), `failureReport.ts` (the analysis card + evidence), `failureCategory.ts` (fixed
 * classification rules) and `stepRules.ts` (what an executed step / run means).
 *
 * Shapes come from the real endpoints (`/exec/report`, `/reports/execution/getstepResult`,
 * `/tm/testcase/search`); assertions are the exact text the tools return.
 */
import type { QaHttp } from '../http.js';
import {
  ExecutionFailureAnalysis, FAILURE_LOG_TAIL, fetchFailureImage, type ExecutionFailureDeps,
} from './executionFailures.js';
import {
  CARD_END, failureImages, MAX_INLINE_IMAGES, pickGroupScreenshots, readableTime, renderExecution,
} from './failureReport.js';
import {
  categoryOf, classify, cleanLogLines, extractCause, isNoiseLine, trimTrace,
} from './failureCategory.js';
import {
  causeSignature, currentRuns, EXECUTION_TYPE_BY_KIND, failureState, groupBy, INFO_STEP_TYPES,
  isInfoStep, iterationLabel, lastTouchedStep, normaliseCause, numberSteps, parseEntityCode,
  realFailures, reportStepLabel, runKey, runLabel, stepWhere, UNREACHED_STATUSES,
} from './stepRules.js';
import type {
  ExecutionFailureContext, FailureFlow, FailureIteration, FailureStep, FailureTestcaseEntry,
} from './failureTypes.js';

type Router = { get?: (url: string) => any; post?: (url: string, body: any) => any };

function analysisWith(opts: {
  execDoc?: any;
  execDocById?: (id: number) => any;
  latest?: string | null;
  router?: Router;
}) {
  const calls: Array<{ method: 'GET' | 'POST'; url: string; body?: any }> = [];
  const get = jest.fn(async (url: string) => {
    calls.push({ method: 'GET', url });
    return opts.router?.get ? opts.router.get(url) : {};
  });
  const post = jest.fn(async (url: string, body: any) => {
    calls.push({ method: 'POST', url, body });
    return opts.router?.post ? opts.router.post(url, body) : {};
  });
  const http = {
    getJson: get, postJson: post, putJson: jest.fn(), patchJson: jest.fn(), del: jest.fn(), postMultipart: jest.fn(),
  } as unknown as QaHttp;
  const fetchExecDoc = jest.fn(async (id: number) => (opts.execDocById ? opts.execDocById(id) : opts.execDoc));
  const latestExecutionOf = jest.fn(async (_kind: string, _id: string) => opts.latest ?? null);
  const deps: ExecutionFailureDeps = {
    http, projectId: 7, baseUrl: 'https://x.test', fetchExecDoc, latestExecutionOf,
  };
  return { analysis: new ExecutionFailureAnalysis(deps), calls, get, post, fetchExecDoc, latestExecutionOf };
}

const EXEC_TC = {
  id: 55, code: 'EX-55', type: 'TESTCASE', status: 'FAILED',
  executionTypeId: 42, executionTypeCode: 'TC-42', executionTypeName: 'Checkout flow',
  environmentType: 'QA', startTime: '2026-10-13T22:16:00.00+05:30', endTime: '2026-10-13T22:17:30.00+05:30',
  executionDuration: 31_000,
};

const FAILED_RUN = {
  id: 10, executionItemId: 42, code: 'TC-42', status: 'FAILED', itr: 2,
  platform: { name: 'CHROME' }, versionId: 'ver-1', endTime: '2026-10-13T22:17:00.000Z',
  startTime: '2026-10-13T22:16:10.000Z', executionDuration: 5000,
};
const PASSED_RUN = {
  id: 11, executionItemId: 42, code: 'TC-42', status: 'PASSED', itr: 1,
  platform: { name: 'CHROME' }, versionId: 'ver-1', endTime: '2026-10-13T21:00:00.000Z',
};

const WRITTEN_STEPS = [
  { id: 'w1', seq: 1, description: 'Launch the app' },
  { id: 'w2', seq: 2, description: 'Click Pay button' },
  { id: 'w3', seq: 3, description: 'Confirm order' },
  { id: 'w4', seq: 4, description: 'Sign out' },
];

const FAILED_ROWS = [
  {
    id: 'r1', seq: 1, stepId: 'w1', displaySeq: '1', status: 'PASSED', stepType: 'NORMAL_STATEMENT',
    description: 'Launch the app',
    executionLogData: { executionLogs: [
      '2026-10-13 10:00:00.000 - INFO  : browser started',
      '2026-10-13 10:00:01.500 - WARN  : slow start',
    ] },
  },
  {
    id: 'r2', seq: 2, stepId: 'w2', displaySeq: '2', status: 'FAILED', stepType: 'NORMAL_STATEMENT',
    description: 'Click Pay button',
    executionLogData: { executionLogs: [
      "2026-10-13 10:00:02.000 - ERROR : No such element found: //button[@id='pay']",
      '2026-10-13 10:00:02.100 - INFO  : Object Name: Pay button',
      '2026-10-13 10:00:02.200 - INFO  : Action Name : Click',
    ] },
    testdata: [{ paramName: 'amount', value: '100' }],
    screenShots: [{ name: 'failure.png', original_name: 'shot.png', url: '/files/a.png', size: 10, type: 'png' }],
    expectedResult: 'Payment page', actualResult: 'Error page',
    exception: 'org.openqa.selenium.NoSuchElementException: no such element\n\tat com.x.Y(Z.java:1)',
    objectName: 'Pay button', actionName: 'Click', recordedBaseLinePath: '/files/base.png',
  },
  { id: 'r3', seq: 3, stepId: 'w3', displaySeq: '3', status: 'NOTEXECUTED', stepType: 'NORMAL_STATEMENT', description: 'Confirm order' },
];

const PASSED_ROWS = [
  { id: 'p1', seq: 1, stepId: 'w1', displaySeq: '1', status: 'PASSED', description: 'Launch the app' },
  {
    id: 'p2', seq: 2, stepId: 'w2', displaySeq: '2', status: 'PASSED', description: 'Click Pay button',
    testdata: [{ paramName: 'amount', value: '250' }],
    apiData: { responseData: { statusCode: 200, responseBody: '{"ok":true}' } },
  },
];

function fullRouter(over: Partial<Router> = {}): Router {
  return {
    get: (url) => {
      if (url === '/exec/report/55/7') return { data: [FAILED_RUN, PASSED_RUN] };
      if (url.startsWith('/tm/testcase/steps')) return { data: WRITTEN_STEPS };
      return {};
    },
    post: (url, body) => {
      if (url === '/reports/execution/getstepResult') {
        return { data: String(body.executionRunId) === '10' ? FAILED_ROWS : PASSED_ROWS };
      }
      if (url === '/tm/testcase/search') return { data: [{ id: 42, code: 'TC-42', name: 'Checkout flow' }] };
      if (url === '/tm/tcfnversion/search') return { data: [{ id: 'ver-1', name: 'v1.0' }] };
      return {};
    },
    ...over,
  };
}

describe('ExecutionFailureAnalysis — one failed iteration, end to end', () => {
  test('reads the run, focuses the failed step, groups it and builds the flow + comparison', async () => {
    const { analysis, get, latestExecutionOf } = analysisWith({
      execDoc: EXEC_TC, latest: '55', router: fullRouter(),
    });

    const ctx = await analysis.analyse({ code: 'TC-42' });
    expect(latestExecutionOf).toHaveBeenCalledWith('TC', '42');
    expect(get).toHaveBeenCalledWith('/exec/report/55/7');

    expect(ctx.input).toEqual({ code: 'TC-42', resolvedBy: 'latest' });
    expect(ctx.execution).toEqual({
      id: '55', code: 'EX-55', type: 'TESTCASE', status: 'FAILED',
      executionTypeCode: 'TC-42', executionTypeName: 'Checkout flow', environment: 'QA',
      startedAt: '2026-10-13T22:16:00.00+05:30', endedAt: '2026-10-13T22:17:30.00+05:30',
      durationMs: 31_000,
      reportUrl: 'https://x.test/user/reports/reports-page?type=TESTCASE&parentId=42&id=55&projectId=7',
    });
    expect(ctx.counts).toEqual({
      runs: 2, failedRuns: 1, analysedRuns: 1, testcases: 1, failedTestcases: 1, passedTestcases: 0,
    });
    expect(ctx.passed).toBeUndefined();

    // The entry: both iterations counted, the failed one carries its name and version.
    expect(ctx.testcases).toHaveLength(1);
    const entry = ctx.testcases[0]!;
    expect(entry.code).toBe('TC-42');
    expect(entry.name).toBe('Checkout flow');
    expect(entry.versionName).toBe('v1.0');
    expect(entry.iterations).toEqual({ total: 2, passed: 1, failed: 1, other: 0 });
    expect(entry.failedIterations).toHaveLength(1);

    const it = entry.failedIterations[0]!;
    expect(it).toMatchObject({
      runId: '10', label: 'TC-42 (ITR-2, CHROME)', testcaseCode: 'TC-42', iteration: 'ITR-2',
      platform: 'CHROME', versionId: 'ver-1', status: 'FAILED', source: 'step', group: 1,
      stepCounts: { total: 3, passed: 1, failed: 1, skipped: 0, notExecuted: 1 },
    });
    expect(it.focus).toMatchObject({
      rowId: 'r2', seq: 2, displaySeq: '2', reportStep: '2', testcaseStep: '2', trail: 'TC step 2',
      description: 'Click Pay button', status: 'FAILED', state: 'failed',
      expected: 'Payment page', actual: 'Error page',
      exception: 'org.openqa.selenium.NoSuchElementException: no such element',
      cause: "No such element found: //button[@id='pay']",
      category: 'Element not found',
      objectName: 'Pay button', actionName: 'Click',
      recordedBaseline: 'https://x.test/files/base.png',
      errorLines: ["10:00:02 ERROR No such element found: //button[@id='pay']"],
      testdata: [{ paramName: 'amount', value: '100' }],
    });
    expect(it.focus!.screenshots).toEqual([{
      name: 'failure.png', originalName: 'shot.png', url: '/files/a.png',
      absoluteUrl: 'https://x.test/files/a.png', size: 10, type: 'png',
    }]);
    // r3 never ran, so it is not a failure.
    expect(it.failedSteps.map((s) => s.rowId)).toEqual(['r2']);

    // The FLOW: what ran, the failure, what came next, and what the run never reached.
    expect(it.flow!.lines).toEqual([
      '1 [PASSED] Launch the app',
      '2 [FAILED · stopped the run] Click Pay button | amount=100',
      '3 [NOTEXECUTED] Confirm order',
    ]);
    expect(it.flow!.notRun).toEqual(['3 [not run] Confirm order', '4 [not run] Sign out']);
    expect(it.flow!.warnings).toEqual(['step 1: 10:00:01 WARN slow start']);
    expect(it.flow!.breakdown).toBeUndefined();
    expect(it.flow!.functionCalls).toBeUndefined();
    // The passing iteration was read and compared at the same written step.
    expect(it.flow!.otherIterations).toEqual(['ITR-1: passed at this step with amount=250 — API 200: {"ok":true}']);

    // One cause, named from the category + the step + its error.
    expect(ctx.groups).toEqual([{
      id: 1,
      cause: 'Step 2 "Click Pay button" — No such element found: //button[@id=\'pay\']',
      kind: 'step',
      category: 'Element not found',
      size: 1,
      testcases: ['TC-42'],
      iterations: ['TC-42 (ITR-2, CHROME)'],
      representative: 'TC-42 (ITR-2, CHROME)',
      representativeRunId: '10',
    }]);
    expect(ctx.notes).toEqual(['Screenshot URLs are SQA artifact paths; they need the SQA bearer token to download.']);
    expect(FAILURE_LOG_TAIL).toBe(30);
  });
});

describe('ExecutionFailureAnalysis — run level, unreadable runs and notes', () => {
  test('a run with no FAILED step uses the last step that ran and inherits the execution exception', async () => {
    const execDoc = {
      ...EXEC_TC, id: 56, code: 'EX-56', type: 'SUITE', executionTypeId: 7,
      executionTypeName: 'Nightly', exception: 'Execution forcefully stopped by admin',
    };
    const runA = { id: 20, executionItemId: 42, code: 'TC-42', status: 'FAILED', itr: 1, endTime: '2026-10-13T22:10:00.000Z' };
    const runB = { id: 21, executionItemId: 43, code: 'TC-43', status: 'FAILED', itr: 1, endTime: '2026-10-13T22:11:00.000Z' };
    const { analysis } = analysisWith({
      execDoc, latest: '56',
      router: {
        get: (url) => (url === '/exec/report/56/7'
          ? { data: [runA, runB] }
          : url.startsWith('/tm/testcase/steps') ? { data: [] } : {}),
        post: (url, body) => {
          if (url === '/reports/execution/getstepResult') {
            if (String(body.executionRunId) === '21') throw new Error('steps unavailable');
            return { data: [
              { id: 'a1', seq: 1, stepId: 'w1', displaySeq: '1', status: 'PASSED', description: 'Launch' },
              {
                id: 'a2', seq: 2, stepId: 'w2', displaySeq: '2', status: 'PASSED', description: 'Click',
                executionLogData: { executionLogs: ['2026-10-13 10:00:01.000 - INFO  : clicked'] },
              },
            ] };
          }
          if (url === '/tm/testcase/search') return { data: [{ id: 42, name: 'Checkout flow' }, { id: 43, name: 'Search flow' }] };
          return {};
        },
      },
    });

    const ctx = await analysis.analyse({ code: 'SU-7' });
    expect(ctx.counts).toMatchObject({ runs: 2, failedRuns: 2, analysedRuns: 2, testcases: 2, failedTestcases: 2 });

    const allIterations = ctx.testcases.flatMap((t) => t.failedIterations);
    const first = allIterations.find((i) => i.runId === '20')!;
    const second = allIterations.find((i) => i.runId === '21')!;
    expect(first).toMatchObject({
      source: 'run_level', category: 'Stopped manually',
      exception: 'Execution forcefully stopped by admin',
      focus: { rowId: 'a2', description: 'Click' },
    });
    expect(first!.flow!.lines).toEqual(['1 [PASSED] Launch', '2 [PASSED] Click']);
    expect(second).toMatchObject({ readError: 'steps unavailable', source: 'run_level', category: 'Stopped manually' });
    expect(second!.flow).toBeUndefined();

    // Both run-level iterations group by the execution's exception; the readable one is the
    // representative (it has evidence) and carries the flow.
    expect(ctx.groups).toHaveLength(1);
    expect(ctx.groups[0]).toMatchObject({
      kind: 'run_level', category: 'Stopped manually', size: 2,
      representative: 'TC-42 (ITR-1)', representativeRunId: '20',
    });
    expect(ctx.groups[0]!.cause).toBe('Run-level: Execution forcefully stopped by admin (last step that ran: 2 "Click")');
    expect(ctx.notes).toEqual([
      '1 failed iteration(s) could not be read; they are grouped by their run-level exception.',
      'Some iterations failed with no failed step (manual verdict or a stop) — their focus is the last step that ran, and the cause is the run-level exception.',
    ]);
    expect(ctx.passed).toBeUndefined();
  });

  test('an execution with no runs says so; an all-passed execution lists what passed', async () => {
    const empty = analysisWith({
      execDoc: EXEC_TC, latest: '55',
      router: { get: (url) => (url === '/exec/report/55/7' ? { data: [] } : {}) },
    });
    const none = await empty.analysis.analyse({ code: 'TC-42' });
    expect(none.counts).toEqual({
      runs: 0, failedRuns: 0, analysedRuns: 0, testcases: 0, failedTestcases: 0, passedTestcases: 0,
    });
    expect(none.groups).toEqual([]);
    expect(none.testcases).toEqual([]);
    expect(none.notes).toEqual(['The execution has no runs yet.']);

    const allPass = analysisWith({
      execDoc: EXEC_TC, latest: '55',
      router: {
        get: (url) => (url === '/exec/report/55/7' ? { data: [PASSED_RUN] } : {}),
        post: (url) => {
          if (url === '/tm/testcase/search') return { data: [{ id: 42, code: 'TC-42', name: 'Checkout flow' }] };
          return {};
        },
      },
    });
    const passed = await allPass.analysis.analyse({ code: 'TC-42' });
    expect(passed.testcases).toEqual([]);
    expect(passed.passed).toEqual(['TC-42']);
    expect(passed.notes).toEqual(['No failed iterations — all 1 run(s) are PASSED.']);
    expect(passed.counts).toMatchObject({ runs: 1, failedRuns: 0, passedTestcases: 1 });
    expect(passed.groups).toEqual([]);
  });

  test('resolves an execution by id or EX code, and refuses a code/execution mismatch', async () => {
    const plain = (over: { doc?: any; latest?: string | null; execDocById?: (id: number) => any } = {}) =>
      analysisWith({
        execDoc: over.doc ?? EXEC_TC,
        latest: over.latest === undefined ? '55' : over.latest,
        ...(over.execDocById ? { execDocById: over.execDocById } : {}),
        router: {
          get: (url) => (url.startsWith('/exec/report/') ? { data: [] } : {}),
          post: (url) => {
            if (url === '/exec/execution/search') return { data: [EXEC_TC] };
            return { data: [] };
          },
        },
      });

    await expect(plain().analysis.analyse({})).rejects.toThrow(/Provide a code \(TC-123 \/ SU-123 \/ PL-123\) or an executionId/);
    await expect(plain().analysis.analyse({ code: 'XX-9' })).rejects.toThrow(/Unrecognised code "XX-9"/);
    await expect(plain({ latest: null }).analysis.analyse({ code: 'SU-7' })).rejects.toThrow(/SU-7 has no execution in project 7/);
    await expect(plain({ execDocById: () => null }).analysis.analyse({ executionId: '99' }))
      .rejects.toThrow(/Execution 99 not found in project 7/);

    const suiteDoc = { ...EXEC_TC, type: 'SUITE', executionTypeId: 8, executionTypeCode: undefined };
    await expect(plain({ doc: suiteDoc }).analysis.analyse({ code: 'SU-7', executionId: '55' }))
      .rejects.toThrow(/Execution 55 ran SUITE 8, not SU-7/);

    const noRuns = analysisWith({
      execDoc: EXEC_TC,
      router: {
        get: (url) => (url === '/exec/report/55/7' ? { data: [{ id: 1, executionItemId: 99, status: 'FAILED' }] } : {}),
      },
    });
    await expect(noRuns.analysis.analyse({ code: 'TC-42', executionId: '55' }))
      .rejects.toThrow(/TC-42 has no runs in execution 55/);

    // By EX code: the execution is looked up through the search endpoint.
    const byCode = plain();
    const ctx = await byCode.analysis.analyse({ executionId: 'ex-55' });
    expect(byCode.post.mock.calls[0]![0]).toBe('/exec/execution/search');
    expect((byCode.post.mock.calls[0]![1] as any).searchFields).toContainEqual({ column: 'code', value: 'EX-55', regEx: false });
    expect(ctx.input).toEqual({ executionId: 'ex-55', resolvedBy: 'executionId' });

    // A SU code whose execution matches is accepted.
    const matched = plain({ doc: { ...EXEC_TC, type: 'SUITE', executionTypeId: 7 } }).analysis;
    const ok = await matched.analyse({ code: 'SU-7', executionId: '55' });
    expect(ok.input).toEqual({ code: 'SU-7', executionId: '55', resolvedBy: 'executionId' });
  });
});

describe('fetchFailureImage', () => {
  const httpWith = (getBinary?: jest.Mock): QaHttp => ({
    getJson: jest.fn(), postJson: jest.fn(), putJson: jest.fn(), patchJson: jest.fn(), del: jest.fn(),
    postMultipart: jest.fn(), ...(getBinary ? { getBinary } : {}),
  } as unknown as QaHttp);

  test('inlines a PNG/JPEG/GIF/WEBP on the SQA host, and refuses everything else', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38]);
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    const getBinary = jest.fn(async (path: string) => {
      if (path.endsWith('big.png')) return { data: new Uint8Array(20), contentType: 'application/octet-stream' };
      if (path.endsWith('empty.png')) return { data: new Uint8Array(0), contentType: 'image/png' };
      if (path.endsWith('text.png')) return { data: new Uint8Array([1, 2, 3]), contentType: 'image/png' };
      if (path.endsWith('boom.png')) throw new Error('gone');
      if (path.endsWith('j.jpeg')) return { data: jpeg, contentType: 'image/jpeg' };
      if (path.endsWith('g.gif')) return { data: gif, contentType: 'image/gif' };
      if (path.endsWith('w.webp')) return { data: webp, contentType: 'image/webp' };
      return { data: png, contentType: 'image/png' };
    });
    const http = httpWith(getBinary);
    const base = 'https://x.test';

    expect(await fetchFailureImage(http, base, `${base}/files/a.png`, 1000)).toEqual({
      data: Buffer.from(png).toString('base64'), mimeType: 'image/png',
    });
    expect(await fetchFailureImage(http, base, `${base}/files/j.jpeg`, 1000)).toMatchObject({ mimeType: 'image/jpeg' });
    expect(await fetchFailureImage(http, base, `${base}/files/g.gif`, 1000)).toMatchObject({ mimeType: 'image/gif' });
    expect(await fetchFailureImage(http, base, `${base}/files/w.webp`, 1000)).toMatchObject({ mimeType: 'image/webp' });

    expect(await fetchFailureImage(http, base, `${base}/files/big.png`, 5)).toBeNull();
    expect(await fetchFailureImage(http, base, `${base}/files/empty.png`, 1000)).toBeNull();
    expect(await fetchFailureImage(http, base, `${base}/files/text.png`, 1000)).toBeNull();
    expect(await fetchFailureImage(http, base, `${base}/files/boom.png`, 1000)).toBeNull();
    // Another host (or no base URL / no binary reader) is never fetched.
    expect(await fetchFailureImage(http, base, 'https://evil.test/a.png', 1000)).toBeNull();
    expect(await fetchFailureImage(http, '', `${base}/files/a.png`, 1000)).toBeNull();
    expect(await fetchFailureImage(httpWith(), base, `${base}/files/a.png`, 1000)).toBeNull();
  });
});

// --------------------------------------------------------------------------- failureCategory

describe('failureCategory — fixed rules, never a guess', () => {
  test('classifies causes into their families, trims traces and log lines, and extracts the cause', () => {
    expect(categoryOf('No such element found: //button')).toBe('Element not found');
    expect(categoryOf('Assertion failed: expected "A" actual "B"')).toBe('Assertion failed');
    expect(categoryOf('click intercepted by a modal')).toBe('Element found but not usable');
    expect(categoryOf('Wait timed out after 30s')).toBe('Timed out waiting');
    expect(categoryOf('feature is disabled in this project')).toBe('Disabled by configuration');
    expect(categoryOf('invalid session id')).toBe('Browser session died');
    expect(categoryOf('invalid selector: bad xpath')).toBe('Test definition is invalid');
    expect(categoryOf('manually terminated by rishi')).toBe('Stopped manually');
    expect(categoryOf('something nobody has seen')).toBe('Unrecognised failure');
    expect(categoryOf(undefined)).toBe('Unrecognised failure');
    expect(categoryOf('anything', 'api_assertion')).toBe('Assertion failed');
    // The longest matching needle wins.
    expect(classify('element is not displayed; feature is disabled')).toBe('locator');
    expect(categoryOf('forcefully stopped')).toBe('Stopped manually');

    expect(trimTrace('org.x.NoSuchElement: no such element\n\tat com.x.Y(Z.java:1)\nCaused by: java.lang.X: boom'))
      .toBe('org.x.NoSuchElement: no such element | Caused by: java.lang.X: boom');
    expect(trimTrace('message (Session info: chrome=120)')).toBe('message');
    expect(trimTrace('a'.repeat(500))).toHaveLength(400);
    expect(trimTrace('')).toBe('');
    expect(trimTrace(undefined)).toBeUndefined();

    expect(cleanLogLines("2026-10-13 10:00:02.000 - ERROR : No such element found: //button[@id='pay']"))
      .toEqual(["10:00:02 ERROR No such element found: //button[@id='pay']"]);
    expect(cleanLogLines('line one\n\tat com.x.Y(Z.java:1)\nCaused by: boom\nline two')).toEqual(['line one | Caused by: boom', 'line two']);
    expect(cleanLogLines('')).toEqual([]);
    expect(cleanLogLines('x'.repeat(300))[0]!.endsWith('…')).toBe(true);
    expect(cleanLogLines('x'.repeat(300))[0]).toHaveLength(240);

    expect(isNoiseLine('Failed to take screenshot of the page')).toBe(true);
    expect(isNoiseLine('Executor is null')).toBe(true);
    expect(isNoiseLine('No such element found')).toBe(false);

    // extractCause prefers a failed API assertion, then the first real ERROR line, then the exception.
    expect(extractCause({
      apiData: { assertions: [
        { status: 'PASSED', key: 'a' },
        { status: false, key: 'statusCode', condition: 'EQUALS', expectedValue: 200, actualValue: 500 },
      ] },
    })).toEqual({ text: 'statusCode: expected 200 EQUALS actual 500', source: 'api_assertion' });

    expect(extractCause({
      executionLogData: { executionLogs: [
        '2026-10-13 10:00:00.000 - INFO  : starting',
        '2026-10-13 10:00:02.000 - ERROR : No such element found: //a',
        '2026-10-13 10:00:03.000 - ERROR : another error',
      ] },
    })).toEqual({ text: 'No such element found: //a', source: 'execution_log' });

    // Every error line is noise: the exception says more than the screenshot side failure.
    expect(extractCause({
      exception: 'java.lang.IllegalStateException: real',
      executionLogData: { executionLogs: ['2026-10-13 10:00:00.000 - ERROR : failed to take screenshot'] },
    })).toEqual({ text: 'java.lang.IllegalStateException: real', source: 'exception' });

    expect(extractCause({ actualResult: 'Error page' })).toEqual({ text: 'Error page', source: 'actualResult' });
    expect(extractCause({})).toBeUndefined();
    expect(extractCause({ executionLogData: { executionLogs: [] } })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------- stepRules

describe('stepRules — what an executed step and run mean', () => {
  test('step states, failures, report numbers and where a step sits', () => {
    expect(INFO_STEP_TYPES.has('SWITCH_TO_ANDROID')).toBe(true);
    expect(UNREACHED_STATUSES.has('')).toBe(true);
    expect(isInfoStep('INFO', 'NORMAL_STATEMENT')).toBe(true);
    expect(isInfoStep('FAILED', 'IF')).toBe(true);
    expect(isInfoStep('FAILED', 'NORMAL_STATEMENT')).toBe(false);
    expect(failureState('INFO', 'NORMAL_STATEMENT')).toBe('info');
    expect(failureState('FAILED', 'SWITCH_TO_API')).toBe('info');
    expect(failureState('')).toBe('not_executed');
    expect(failureState('NOT_EXECUTED')).toBe('not_executed');
    expect(failureState('PASSED')).toBe('passed');
    expect(failureState('FAILED')).toBe('failed');
    expect(failureState('SKIPPED')).toBe('skipped');
    expect(failureState('ERROR')).toBe('error');
    expect(failureState('WHATEVER')).toBe('unknown');

    const fnFail = { rowId: 'f', seq: 1, description: 'Login', status: 'FAILED', state: 'failed' as const, stepType: 'FUNCTION', errorLines: [], logs: [], logCount: 0, screenshots: [] };
    const inner = { rowId: 'i', seq: 2, description: 'Click', status: 'FAILED', state: 'failed' as const, stepType: 'NORMAL_STATEMENT', errorLines: [], logs: [], logCount: 0, screenshots: [] };
    expect(realFailures([fnFail, inner]).map((s) => s.rowId)).toEqual(['i']);
    expect(realFailures([fnFail]).map((s) => s.rowId)).toEqual(['f']);
    expect(realFailures([inner, { ...inner, rowId: 'p', state: 'passed', status: 'PASSED' }]).map((s) => s.rowId)).toEqual(['i']);

    const last = (over: Partial<FailureStep>) => ({ seq: 1, description: 'x', status: 'PASSED', state: 'passed' as const, errorLines: [], logs: [], logCount: 0, screenshots: [], ...over });
    expect(lastTouchedStep([
      last({ rowId: 'a', state: 'info' }),
      last({ rowId: 'b', state: 'not_executed' }),
      last({ rowId: 'c', state: 'passed' }),
      last({ rowId: 'd', state: 'skipped' }),
    ])!.rowId).toBe('d');
    expect(lastTouchedStep([last({ rowId: 'only', state: 'info' })])!.rowId).toBe('only');

    expect(reportStepLabel({ displaySeq: '19.19.8' }, true)).toBe('19.19.8');
    expect(reportStepLabel({ displaySeq: '2.0' }, true)).toBeUndefined();
    expect(reportStepLabel({ displaySeq: '0' }, true)).toBeUndefined();
    expect(reportStepLabel({ displaySeq: '  ' }, true)).toBeUndefined();
    expect(reportStepLabel({ reportSeq: 3 }, false)).toBe('3');
    expect(reportStepLabel({ reportSeq: 0 }, false)).toBeUndefined();
    expect(reportStepLabel({ displaySeq: 'abc' }, true)).toBe('abc');
    expect(reportStepLabel({}, true)).toBeUndefined();

    const steps: FailureStep[] = [
      last({ rowId: 'fn', reportStep: '19', stepType: 'FUNCTION', functionName: 'Login', displaySeq: '19' }),
      last({ rowId: 'b', displaySeq: '19.1' }),
      last({ rowId: 'c', displaySeq: '19.1.3' }),
    ];
    numberSteps(steps, true);
    expect(steps.map((s) => s.reportStep)).toEqual(['19', '19.1', '19.1.3']);
    expect(stepWhere(steps, 2)).toEqual({ testcaseStep: '19', trail: 'TC step 19 › Login step 3' });
    expect(stepWhere(steps, 1)).toEqual({ testcaseStep: '19', trail: 'TC step 19 › Login step 1' });
    expect(stepWhere([last({})], 0)).toEqual({});
  });

  test('run identity, current results, labels, causes and grouping', () => {
    expect(EXECUTION_TYPE_BY_KIND).toEqual({ TC: 'TESTCASE', SU: 'SUITE', PL: 'EXECUTIONPLAN' });
    expect(parseEntityCode(' tc 12 ')).toEqual({ kind: 'TC', num: 12, code: 'TC-12' });
    expect(parseEntityCode('PL_7')).toEqual({ kind: 'PL', num: 7, code: 'PL-7' });
    expect(parseEntityCode('X-1')).toBeNull();

    expect(iterationLabel({ itr: 2, code: 'TC-42' })).toBe('ITR-2');
    expect(iterationLabel({ itr: 2, itrName: 'Smoke run', code: 'TC-42' })).toBe('Smoke run');
    expect(iterationLabel({ itr: 2, itrName: 'TC-42', code: 'TC-42' })).toBe('ITR-2');
    expect(iterationLabel({ code: 'TC-42' })).toBeUndefined();
    expect(runLabel({ code: 'TC-12', itr: 2, platform: { name: 'CHROME' } })).toBe('TC-12 (ITR-2, CHROME)');
    expect(runLabel({ code: 'TC-12' })).toBe('TC-12');
    expect(runLabel({ itr: 2 })).toBe('ITR-2');

    const key = runKey({ executionItemId: 42, versionId: 'v', stepId: 's', itr: 2, platform: { name: 'CHROME' } });
    expect(key).toBe(JSON.stringify([42, 'v', 's', 2, 'CHROME']));
    expect(runKey({})).toBe(JSON.stringify([null, null, null, null, null]));

    const runs = [
      { id: 1, executionItemId: 42, itr: 1, endTime: '2026-01-01' },
      { id: 2, executionItemId: 42, itr: 1, endTime: '2026-02-01' },
      { id: 3, executionItemId: 43, itr: 1, endTime: '2026-01-15' },
      { executionItemId: 44 },
    ];
    expect(currentRuns(runs).map((r) => r.id)).toEqual([2, 3]);

    expect(normaliseCause("No such element 'Pay' at 42")).toBe('no such element … at #');
    expect(causeSignature(undefined, 'run_level', 'Stopped manually')).toBe(JSON.stringify(['run-level', 'stopped manually']));
    expect(causeSignature({ ...stepOf(), description: 'Click Pay button', cause: 'No such element found' }, 'step'))
      .toBe(JSON.stringify(['step', 'click', 'no such element found']));
    expect(causeSignature({ ...stepOf(), description: 'Click Pay', errorLines: ['ERROR: boom'] }, 'step'))
      .toBe(JSON.stringify(['step', 'click', 'error: boom']));

    const grouped = groupBy(['a', 'b', 'c', 'd'], (x) => (x === 'a' || x === 'b' ? 'one' : x === 'c' ? 'two' : 'three'));
    expect(grouped.map((g) => [g.key, g.items.length])).toEqual([['one', 2], ['two', 1], ['three', 1]]);
  });
});

// --------------------------------------------------------------------------- failureReport

function stepOf(over: Partial<FailureStep> = {}): FailureStep {
  return {
    seq: 2, description: 'Click Pay', status: 'FAILED', state: 'failed',
    errorLines: ['10:00:02 ERROR No such element found'],
    logs: ['10:00:02 ERROR No such element found'], logCount: 1, screenshots: [],
    ...over,
  };
}

function iterationOf(over: Partial<FailureIteration> = {}): FailureIteration {
  const focus = stepOf({ rowId: 'r2', reportStep: '2', testcaseStep: '2', trail: 'TC step 2', cause: 'No such element found' });
  return {
    runId: '10', label: 'TC-42 (ITR-1)', testcaseCode: 'TC-42', testcaseName: 'Checkout flow',
    status: 'FAILED', iteration: 'ITR-1', category: 'Element not found', versionName: 'v1.0',
    source: 'step', group: 1, focus, failedSteps: [focus],
    stepCounts: { total: 3, passed: 1, failed: 1, skipped: 0, notExecuted: 1 },
    ...over,
  };
}

function entryOf(iterations: FailureIteration[]): FailureTestcaseEntry {
  return {
    executionItemId: '42', code: 'TC-42', name: 'Checkout flow', versionId: 'ver-1', versionName: 'v1.0',
    iterations: { total: iterations.length, passed: 0, failed: iterations.length, other: 0 },
    failedIterations: iterations,
  };
}

const TESTCASE_CTX: ExecutionFailureContext = {
  input: { code: 'TC-42', resolvedBy: 'latest' },
  execution: {
    id: '55', code: 'EX-55', type: 'TESTCASE', status: 'FAILED',
    executionTypeCode: 'TC-42', executionTypeName: 'Checkout flow', environment: 'QA',
    endedAt: '2026-10-13T22:16:59.43+05:30', reportUrl: 'https://x.test/report',
  },
  counts: { runs: 3, failedRuns: 1, analysedRuns: 1, testcases: 1, failedTestcases: 1, passedTestcases: 0 },
  groups: [{
    id: 1, cause: 'Step 2 "Click Pay" — No such element found', kind: 'step', category: 'Element not found',
    size: 1, testcases: ['TC-42'], iterations: ['TC-42 (ITR-1)'],
    representative: 'TC-42 (ITR-1)', representativeRunId: '10',
  }],
  testcases: [entryOf([iterationOf()])],
  notes: [],
};

describe('failureReport — the analysis card', () => {
  test('renders a test-case card exactly, then the answer slots, evidence and the tester guide', () => {
    const text = renderExecution(TESTCASE_CTX);
    const lines = text.split('\n');
    const end = lines.indexOf(CARD_END);
    expect(end).toBeGreaterThan(0);
    expect(lines.slice(0, end)).toEqual([
      '**Test case failure analysis: TC-42 — Checkout flow**',
      'EX-55 · QA · 13 Oct 2026, 10:16 PM',
      '3 iterations · 2 passed · 1 failed, for 1 reason.',
      '',
      '**Why it failed**',
      '',
      '| # | Root cause | Iterations failed |',
      '|---|---|---|',
      '| 1 | Element not found — Step 2 "Click Pay" — No such element found | TC-42 (ITR-1) |',
      '',
      '**Failed iterations**',
      '',
      '| Iteration | Report Step No. | Test case step | Failure category |',
      '|---|---|---|---|',
      '| ITR-1 | 2 | TC step 2 | Element not found |',
      '',
      '**Each failed iteration**',
      '',
      '**TC-42 — Checkout flow** (v1.0 · ITR-1 · cause #1)',
      '**Failed at:** TC step 2  ',
      '**What failed:** Click Pay  ',
      '**Error:** `No such element found`  ',
      '',
    ]);

    expect(text).toContain('ANSWER — fill in every "…" below and keep this structure exactly');
    expect(text).toContain('**Cause #1 — Element not found** (TC-42)');
    expect(text).toContain('- **Where it broke:** TC step 2');
    expect(text).toContain('- **What went wrong:** `No such element found`');
    expect(text).toContain('- **Whose problem:** … (test script / test data / application / environment / manual stop) — how sure');
    expect(text).toContain('Report: https://x.test/report');
    expect(text).toContain('## Evidence — one representative per cause (for writing Why / Fix; do not paste)');
    expect(text).toContain('### TC-42 · ITR-1 · cause #1');
    expect(text).toContain('#### 1. TC step 2 (report step 2) — Click Pay  `FAILED`');
    expect(text).toContain('- **Failure evidence:**\n  - 10:00:02 ERROR No such element found');
    expect(text).toContain('- **Logs (last 1 of 1):**\n```text\n10:00:02 ERROR No such element found\n```');
    expect(text.trimEnd().endsWith('say what to check instead.')).toBe(true);
  });

  test('escapes table cells, uses the suite/plan columns, and reports an empty execution', () => {
    const suite: ExecutionFailureContext = {
      ...TESTCASE_CTX,
      input: { code: 'SU-7', resolvedBy: 'latest' },
      execution: {
        id: '56', code: 'EX-56', type: 'SUITE', status: 'FAILED', executionTypeName: 'Nightly',
        environment: 'QA', endedAt: '2026-10-13T22:16:59.43Z', exception: 'Stopped `by` admin',
      },
      counts: { runs: 4, failedRuns: 2, analysedRuns: 2, testcases: 2, failedTestcases: 1, passedTestcases: 1 },
      groups: [{
        id: 1, cause: 'pipe | and\nnewline', kind: 'step',
        size: 1, testcases: ['TC-42', 'TC-43'], iterations: ['TC-42 (ITR-1)'],
        representative: 'TC-42 (ITR-1)', representativeRunId: '10',
      }],
      passed: ['TC-43'],
      notes: ['One note.'],
    };
    const text = renderExecution(suite);
    expect(text).toContain('**Suite failure analysis: Nightly**');
    expect(text).toContain('EX-56 · QA · 14 Oct 2026, 3:46 AM');
    expect(text).toContain('Execution exception: `Stopped \'by\' admin`');
    expect(text).toContain('2 test cases · 1 passed · 1 failed, for 1 reason.');
    expect(text).toContain('| # | Root cause | Test cases |');
    expect(text).toContain('| 1 | pipe \\| and newline | 2 |');
    expect(text).toContain('| TC ID | Version | Test case name | Iteration | Report Step No. | Test case step | Failure category |');
    expect(text).toContain('| TC-42 | v1.0 | Checkout flow | ITR-1 | 2 | TC step 2 | Element not found |');
    expect(text).toContain('**TC-42 — Checkout flow** (v1.0 · ITR-1 · cause #1)');
    expect(text).toContain('Passed: TC-43.');
    expect(text).toContain('One note.');

    const plan: ExecutionFailureContext = {
      input: { code: 'PL-9', resolvedBy: 'latest' },
      execution: { id: '57', type: 'EXECUTIONPLAN', status: 'PASSED' },
      counts: { runs: 2, failedRuns: 0, analysedRuns: 0, testcases: 2, failedTestcases: 0, passedTestcases: 2 },
      groups: [],
      testcases: [],
      notes: [],
    };
    const planText = renderExecution(plan);
    expect(planText).toContain('**Execution plan failure analysis: execution 57**');
    expect(planText).toContain('2 test cases · 2 passed · 0 failed.');
    expect(planText).toContain('No test case failed.');
    expect(planText).toContain('No test case passed.');
    expect(planText).not.toContain('ANSWER — fill in every');
    expect(planText).not.toContain('Report:');
  });

  test('reads times, picks one screenshot per cause group, and fetches them', async () => {
    expect(readableTime('2026-10-13T22:16:59.43+05:30')).toBe('13 Oct 2026, 10:16 PM');
    expect(readableTime('2026-10-13T16:46:59.000Z')).toBe('13 Oct 2026, 10:16 PM');
    expect(readableTime('2026-01-01T00:05:00.000Z')).toBe('1 Jan 2026, 5:35 AM');
    expect(readableTime('not a date')).toBe('not a date');
    expect(readableTime(undefined)).toBeUndefined();

    const withShot = iterationOf({
      focus: stepOf({
        rowId: 'r2', reportStep: '2', trail: 'TC step 2',
        screenshots: [
          { url: '', absoluteUrl: '' },
          { name: 'failure.png', url: '/files/a.png', absoluteUrl: 'https://x.test/files/a.png' },
        ],
      }),
    });
    const blind = iterationOf({ runId: '12', label: 'TC-42 (ITR-2)', iteration: 'ITR-2', screenshots: [] } as any);
    blind.failedSteps = [stepOf({ rowId: 'x', screenshots: [] })];
    blind.focus = blind.failedSteps[0]!;

    const ctx: ExecutionFailureContext = {
      ...TESTCASE_CTX,
      counts: { runs: 4, failedRuns: 2, analysedRuns: 2, testcases: 1, failedTestcases: 1, passedTestcases: 0 },
      groups: [
        { ...TESTCASE_CTX.groups[0]!, id: 2, representativeRunId: '12' },
        { ...TESTCASE_CTX.groups[0]!, id: 1, representativeRunId: '10' },
      ],
      testcases: [entryOf([withShot, blind])],
    };
    const picked = pickGroupScreenshots(ctx);
    expect(picked).toHaveLength(1);
    expect(picked[0]).toEqual({
      caption: '**Screenshot — cause group 1:** TC-42 (ITR-1) · step 2 "Click Pay"',
      url: 'https://x.test/files/a.png',
    });
    expect(pickGroupScreenshots(ctx, 0)).toEqual([]);
    expect(MAX_INLINE_IMAGES).toBe(5);

    const images = await failureImages(ctx, async (url) => (url.endsWith('a.png')
      ? { data: 'AAA', mimeType: 'image/png' }
      : null));
    expect(images).toEqual([{ caption: picked[0]!.caption, data: 'AAA', mimeType: 'image/png' }]);
    expect(await failureImages(ctx, async () => null)).toEqual([]);
  });

  test('shows run-level wording, tightens a long flow, and renders a step\'s full evidence', () => {
    const filler = (i: number) => `${i} [PASSED] ${'long line '.repeat(45)}`;
    const flow: FailureFlow = {
      lines: [...Array.from({ length: 10 }, (_, i) => filler(i + 1)), ...Array.from({ length: 55 }, (_, i) => filler(i + 11))],
      breakdown: 'from step 20 on, 8 of 10 steps failed',
      notRun: ['31 [not run] Sign out'],
      functionCalls: 'function "Login": this is call 2 of 3; earlier calls: 1 passed',
      otherIterations: ['ITR-1: passed at this step with amount=250'],
      warnings: ['step 3: 10:00 WARN slow'],
    };
    flow.lines[9] = '10 [FAILED · stopped the run] Click Pay | amount=100';
    const it = iterationOf({
      source: 'run_level',
      focus: stepOf({ rowId: 'r2', reportStep: '10', trail: 'TC step 10', description: 'Click Pay', screenshots: [] }),
      failedSteps: [],
      flow,
      exception: 'Execution stopped',
    });
    it.failedSteps = [it.focus!];

    // A second cause: its evidence is the first one that gets a tight FLOW (the budget is spent).
    const rich = stepOf({
      rowId: 'r9', seq: 4, reportStep: '4', testcaseStep: '4', trail: 'TC step 4', description: 'Click Pay',
      objectName: 'Pay button', actionName: 'Click', locator: '//button[@id="pay"]',
      expected: 'Payment page', actual: 'Error page',
      exception: 'org.x.NoSuchElement: no such element',
      apiData: {
        responseData: { statusCode: 500, responseBody: '{"error":"boom"}' },
        assertions: [{ key: 'statusCode', condition: 'EQUALS', expectedValue: 200, actualValue: 500, status: 'FAILED' }],
      },
      testdata: [{ paramName: 'a', value: '1' }, { paramName: 'p', value: 'secret', protected: true }],
      screenshots: [{ name: 'failure.png', url: '/files/a.png', absoluteUrl: 'https://x.test/files/a.png' }],
    });
    const second = iterationOf({
      runId: '12', label: 'TC-42 (ITR-3)', iteration: 'ITR-3', group: 2,
      focus: stepOf({ rowId: 'r7', reportStep: '3', trail: 'TC step 3', screenshots: [] }),
      failedSteps: [
        stepOf({ rowId: 'r7', reportStep: '3', trail: 'TC step 3', screenshots: [], description: 'First failure' }),
        rich,
        stepOf({ rowId: 'r8', reportStep: '5', trail: 'TC step 5', screenshots: [], description: 'Next' }),
        stepOf({ rowId: 'r10', reportStep: '6', trail: 'TC step 6', screenshots: [], description: 'Click again' }),
      ],
      flow: { lines: ['1 [PASSED] a', '2 [PASSED] b', '3 [FAILED · continued] c', '4 [PASSED] d'], warnings: [] },
    });
    const ctx: ExecutionFailureContext = {
      ...TESTCASE_CTX,
      groups: [
        { ...TESTCASE_CTX.groups[0]!, representativeRunId: '10', iterations: ['TC-42 (ITR-1)', 'TC-42 (ITR-2)'] },
        { ...TESTCASE_CTX.groups[0]!, id: 2, representativeRunId: '12', representative: 'TC-42 (ITR-3)' },
      ],
      testcases: [entryOf([it, second])],
    };
    const text = renderExecution(ctx);
    expect(text).toContain('No step reported FAILED — the run was marked failed at run level (manual verdict or a stop).');
    expect(text).toContain('**Broke down:** from step 20 on, 8 of 10 steps failed');
    expect(text).toContain('- **Written steps not run** (what the test was going to do next):\n  - 31 [not run] Sign out');
    expect(text).toContain('- **Function calls:** function "Login": this is call 2 of 3; earlier calls: 1 passed');
    expect(text).toContain('- **Other iterations of this test case:**\n  - ITR-1: passed at this step with amount=250');
    expect(text).toContain('- **Warnings from steps that PASSED** (clues, not proof):\n  - step 3: 10:00 WARN slow');
    expect(text).toContain('- _Same cause, not repeated: TC-42 (ITR-2)_');
    // step 10 is the failure; evidence also shows the flow lines around it.
    expect(text).toContain('10 [FAILED · stopped the run] Click Pay | amount=100');

    // The second cause's FLOW is cut to the failure, and its rich step renders every evidence block.
    expect(text).toContain('_(FLOW cut to the failure to keep the result small.)_');
    expect(text).toContain('- **Object:** Pay button · **Action:** Click');
    expect(text).toContain('- **Locator:** `//button[@id="pay"]`');
    expect(text).toContain('- **Expected:** Payment page');
    expect(text).toContain('- **Actual:** Error page');
    expect(text).toContain('- **Exception:** org.x.NoSuchElement: no such element');
    expect(text).toContain('- **API response:** status 500 · body `{"error":"boom"}`');
    expect(text).toContain('- **Assertions:**\n  - statusCode EQUALS · expected "200" · actual "500" · FAILED');
    expect(text).toContain('- **Test data:** a=1, p=***');
    expect(text).toContain('- **Screenshots:**\n  - [failure.png](https://x.test/files/a.png)');
    expect(text).toContain('- _1 more failed step(s): 6 Click again_');
  });
});
