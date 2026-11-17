import { SimplifyQaAdapter } from './adapter.js';

/** A test-case run as the backend returns it for a DATABASE / API test case: no executionItemId on the run row. */
function adapterFor(execDoc: any, runRows: any[]) {
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: 'https://app.simplifyqa.ai/' };
  a.requireProjectId = () => 25;
  a.fetchExecDoc = async () => execDoc;
  a.http = {
    getJson: async () => runRows,
    postJson: async () => ({ data: [] }),   // /reports/execution/getstepResult
  };
  return a;
}
const tcRun = (over: any = {}) => ({ type: 'TC', executionTypeId: 617, status: 'FAILED', ...over });

describe('report URL of a single test-case run', () => {
  test('DATABASE run (empty executionItemId): parentId is the TEST CASE id, id is the execution id', async () => {
    const run = await adapterFor(tcRun(), [{ id: 'row1', status: 'FAILED', executionItemId: '' }]).getRun('424812');
    expect(run.reportUrl).toBe('https://app.simplifyqa.ai/user/reports/reports-page?type=TESTCASE&parentId=617&id=424812&projectId=25');
  });
  test('API run with no executionItemId at all', async () => {
    const run = await adapterFor(tcRun({ executionTypeId: 88 }), [{ id: 'r', status: 'PASSED' }]).getRun('EX-424813');
    expect(run.reportUrl).toContain('type=TESTCASE&parentId=88&id=424813&projectId=25');
  });
  test('falls back to the run row\'s testcaseId, then to executionItemId', async () => {
    expect((await adapterFor({ type: 'TC' }, [{ id: 'r', status: 'PASSED', testcaseId: 55 }]).getRun('9')).reportUrl).toContain('parentId=55&');
    expect((await adapterFor({ type: 'TC' }, [{ id: 'r', status: 'PASSED', executionItemId: 7 }]).getRun('9')).reportUrl).toContain('parentId=7&');
  });
  test('a web run is unchanged (same link shape)', async () => {
    const run = await adapterFor(tcRun({ executionTypeId: 12 }), [{ id: 'r', status: 'PASSED', executionItemId: 3001 }]).getRun('5');
    expect(run.reportUrl).toContain('type=TESTCASE&parentId=12&id=5&projectId=25');
  });
  test('no double slash from a trailing slash in the base URL', async () => {
    const run = await adapterFor(tcRun(), [{ id: 'r', status: 'FAILED' }]).getRun('1');
    expect(run.reportUrl).not.toMatch(/\.ai\/\/user/);
  });
});
