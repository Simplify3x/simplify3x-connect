import { SimplifyQaAdapter } from './adapter.js';

/** `runReportUrl` is what startRun returns, so the caller never has to compose a report link. */
const link = (base: string, type: 'TESTCASE' | 'SUITE', parentId: number, runId: string, projectId: number) => {
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: base };
  return a.runReportUrl(type, parentId, runId, projectId);
};

describe('report link returned when a run starts', () => {
  test('test case: parentId is the TEST CASE id, id is the execution id', () => {
    expect(link('https://uat.simplifyqa.com/', 'TESTCASE', 231338, '42447', 165))
      .toBe('https://uat.simplifyqa.com/user/reports/reports-page?type=TESTCASE&parentId=231338&id=42447&projectId=165');
  });
  test('suite run and a prefixed run id', () => {
    expect(link('https://uat.simplifyqa.com', 'SUITE', 9, 'EX-42448', 165))
      .toBe('https://uat.simplifyqa.com/user/reports/reports-page?type=SUITE&parentId=9&id=42448&projectId=165');
  });
});
