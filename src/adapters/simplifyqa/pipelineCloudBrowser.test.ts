import { SimplifyQaAdapter } from './adapter.js';

/** A CLOUD pipeline binds the cloud picker's headless platform, never a local browser. */
function setup() {
  const posts: any[] = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.requireProjectId = () => 7;
  a.fetchRawTestcase = async () => ({ id: 55, code: 'TC-55', projectId: 7, tcType: 'WEB', name: 'Case', versionId: 'v55', versionName: 'v1.0' });
  a.readOwnSuite = async () => ({ id: 300, code: 'SU-300', name: 'Smoke', testCases: [{ testcaseId: 55, tcType: 'WEB' }] });
  a.environmentKey = async () => 'general';
  a.http = { postJson: async (path: string, body: any) => { posts.push({ path, body }); return { data: { id: 9, code: 'PIP-9' } }; } };
  return { a: a as SimplifyQaAdapter, posts };
}

const base = { name: 'nightly', parentId: '55', releaseId: '3', sprintId: '4' };

describe('pipeline browser on the cloud', () => {
  test('TC pipeline, mode cloud uses CHROME_HEADLESS even when "chrome" is passed', async () => {
    const { a, posts } = setup();
    await a.createPipeline({ ...base, pipelineType: 'TC', mode: 'cloud', browser: 'chrome' } as any);
    expect(posts[0].body.platForm).toEqual([{ id: 'CHROME_HEADLESS', name: 'CHROME_HEADLESS', technologyType: 'WEB', type: 'NONE' }]);
    expect(posts[0].body.executionMode).toBe('cloud');
  });

  test('TC pipeline, mode local keeps the local CHROME entry', async () => {
    const { a, posts } = setup();
    await a.createPipeline({ ...base, pipelineType: 'TC', mode: 'local', browser: 'chrome' } as any);
    expect(posts[0].body.platForm).toEqual([{ id: 'CHROME', name: 'CHROME', type: 'NONE', technologyType: 'WEB' }]);
  });

  test('SU pipeline, mode cloud uses headless for the web test cases', async () => {
    const { a, posts } = setup();
    await a.createPipeline({ ...base, pipelineType: 'SU', mode: 'cloud', browser: 'edge' } as any);
    expect(posts[0].body.platForm).toEqual([{ id: 'EDGE_HEADLESS', name: 'EDGE_HEADLESS', technologyType: 'WEB', type: 'NONE' }]);
  });

  test('a browser the cloud picker does not offer is refused with the three that exist', async () => {
    const { a } = setup();
    await expect(a.createPipeline({ ...base, pipelineType: 'TC', mode: 'cloud', browser: 'safari' } as any))
      .rejects.toThrow(/Chrome Headless, Firefox Headless, Edge headless/);
  });
});
