import { SimplifyQaAdapter, suiteRunGlobalConfig } from './adapter.js';
import { toSuite, toSuiteSummary } from './mapper.js';

describe('suite Execution Type (LOCAL / REMOTE / CLOUD / STACK)', () => {
  test('updateSuite writes the UI value to lastSelectedExecutionType', async () => {
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    let sent: any;
    a.readOwnSuite = async () => ({
      id: 28, name: 'mcp suit', suiteType: 'AUTOMATION', projectId: 1, updateVersion: 4,
      autoReExecCount: 0, autoReExecTriggerOn: 'AFTER_SUITE',
      lastSelectedExecutionType: 'REMOTE', testCases: [],
    });
    a.http = { putMultipart: async (_p: string, _f: string, body: any) => { sent = body; return { ok: true }; } };
    a.productUrlFor = () => 'https://x/user/suites/suite-details?id=28';

    await a.updateSuite('SU-28', { executionType: 'stack' });
    expect(sent.lastSelectedExecutionType).toBe('STACK');
    expect(sent.name).toBe('mcp suit');
  });

  test('reads expose the suite execution type', () => {
    const doc = { id: 28, code: 'SU-28', name: 'mcp suit', suiteType: 'AUTOMATION', lastSelectedExecutionType: 'STACK', testCases: [] };
    expect(toSuiteSummary(doc).executionType).toBe('STACK');
    expect(toSuite(doc).executionType).toBe('STACK');
  });

  test('an absent value is not fabricated', () => {
    const doc = { id: 29, name: 'plain', testCases: [] };
    expect(toSuiteSummary(doc).executionType).toBeUndefined();
    expect(toSuite(doc).executionType).toBeUndefined();
  });

  test('getSuiteSettings reads the Settings panel back (auto re-exec / auto defect / type)', async () => {
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.readOwnSuite = async () => ({
      id: 28, code: 'SU-28', name: 'mcp suit', suiteType: 'AUTOMATION',
      lastSelectedExecutionType: 'STACK', autoReExecCount: 2, autoDefectLog: true,
      autoReExecTriggerOn: 'AFTER_SUITE', newBrowserSession: true, terminateOnFailure: false,
      minimumContainerCount: 1, maximumContainerCount: 4, testCases: [],
    });
    const view = await a.getSuiteSettings('SU-28');
    expect(view).toMatchObject({
      id: '28', code: 'SU-28', executionType: 'STACK', autoReExecCount: 2,
      autoDefectLog: true, autoReExecTriggerOn: 'AFTER_SUITE', newBrowserSession: true,
      terminateOnFailure: false, minimumContainerCount: 1, maximumContainerCount: 4,
    });
  });

  test('a suite run carries the Settings auto re-execution count into globalConfiguration', () => {
    const gc = suiteRunGlobalConfig({
      autoReExecCount: 2, autoReExecTriggerOn: 'AFTER_SUITE', newBrowserSession: true,
      terminateOnFailure: false,
    });
    expect(gc['RE_EXECUTION_COUNT']).toBe(2);
    expect(gc['RE_EXECUTION_TYPE']).toBe('AFTER_SUITE');
    expect(gc['NEW_BROWSER_SESSION']).toBe(true);
    expect(gc['TERMINATE_ON_FAIL']).toBe(false);
  });

  test('explicit run options win over the suite fields; absent settings default to 0', () => {
    expect(suiteRunGlobalConfig({ autoReExecCount: 2, terminateOnFailure: false }, { terminateOnFailure: true })['TERMINATE_ON_FAIL']).toBe(true);
    expect(suiteRunGlobalConfig({})['RE_EXECUTION_COUNT']).toBe(0);
    expect(suiteRunGlobalConfig({})['RE_EXECUTION_TYPE']).toBe('AFTER_TESTCASE');
  });
});
