import { SimplifyQaAdapter } from './adapter.js';

/** execution_plan add_testcases: one test case can sit in a plan once per VERSION (PL-305 already has TC-12826 v1.0). */
const TC = {
  id: 12826, code: 'TC-12826', name: 'Login', moduleId: 3, executionType: 'AUTOMATION', tcType: 'WEB',
  versionId: 'v1-id', versionName: 'v1.0',
  versions: [{ id: 'v1-id', name: 'v1.0' }, { id: 'v2-id', name: 'v2.0' }],
};

function plan(entries: any[]) {
  const posts: any[][] = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.requireProjectId = () => 40;
  a.ensureUserId = async () => '5';
  a.readOwnPlan = async () => ({ id: 305, code: 'PL-305', executionId: 9 });
  a.readOwnTestcase = async () => TC;
  a.listPlanEntries = async () => entries;
  a.http = { postJson: async (_p: string, rows: any[]) => { posts.push(rows); return {}; } };
  return { a, posts };
}
const v1Entry = { testcaseId: 12826, tcVersionId: 'v1-id', expAssignedTo: null, seq: 1 };

describe('add_testcases with versions', () => {
  it('adds v2.0 although v1.0 is already in the plan', async () => {
    const { a, posts } = plan([v1Entry]);
    const r = await a.addPlanEntries('PL-305', { tcIds: ['TC-12826'], version: 'v2.0' });
    expect(r).toEqual({ added: ['TC-12826'], skipped: [] });
    expect(posts[0]).toHaveLength(1);
    expect(posts[0]![0]).toMatchObject({ testcaseId: 12826, tcVersionId: 'v2-id', versionName: 'v2.0', seq: 2 });
  });

  it('adds both versions in one call with testCases[]', async () => {
    const { a, posts } = plan([]);
    await a.addPlanEntries('PL-305', { testCases: [{ tcId: 'TC-12826', version: 'v1.0' }, { tcId: 'TC-12826', versionId: 'v2-id' }] });
    expect(posts[0]!.map((r: any) => r.tcVersionId)).toEqual(['v1-id', 'v2-id']);
  });

  it('skips the same test case AND version as a duplicate', async () => {
    const { a, posts } = plan([v1Entry]);
    const r = await a.addPlanEntries('PL-305', { testCases: [{ tcId: 'TC-12826', version: 'v1.0' }] });
    expect(r.added).toEqual([]);
    expect(r.skipped[0]).toMatchObject({ code: 'TC-12826' });
    expect(posts).toEqual([]);
  });

  it('refuses a version that does not exist, and posts nothing', async () => {
    const { a, posts } = plan([]);
    await expect(a.addPlanEntries('PL-305', { tcIds: ['TC-12826'], version: 'v9.0' })).rejects.toThrow();
    expect(posts).toEqual([]);
  });
});
