import type { ConnectedQaConfig } from '../../config.js';
import type { Step, TestCase } from '../../domain/types.js';
import { ApiError } from '../http.js';
import { WalnutAdapter } from './adapter.js';

type Captured = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
};

type Reply = { status?: number; body?: string };

/** Minimal fetch stand-in: records the request and replies from the test's router. */
function makeAdapter(router: (req: Captured) => Reply, cfg: Partial<ConnectedQaConfig> = {}) {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET');
    const url = String(input);
    const rawBody = init?.body;
    let body: unknown;
    if (typeof rawBody === 'string' && rawBody.length) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const req: Captured = { method, url, headers: (init?.headers ?? {}) as Record<string, string>, body };
    calls.push(req);
    const reply = router(req);
    const status = reply.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => reply.body ?? '',
      headers: { get: () => 'application/json' },
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const adapter = new WalnutAdapter(
    {
      mode: 'connected',
      baseUrl: 'https://api.walnut.test',
      token: 'plain-api-key',
      walnutAuth: 'key',
      caps: new Set<string>(),
      ...cfg,
    } as ConnectedQaConfig,
    { fetchImpl },
  );
  return { adapter, calls };
}

function json(value: unknown): Reply {
  return { body: JSON.stringify(value) };
}

/** A JWT whose payload carries an `id` claim (the x-user-id source). */
function jwtFor(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ id: userId })).toString('base64url');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
}

const MONGO_TC = 'bbbbbbbbbbbbbbbbbbbbbbbb';

describe('WalnutAdapter headers', () => {
  it('sends bearer + x-project-id + x-user-id in jwt mode and bearer only in key mode', async () => {
    const token = jwtFor('user-42');
    const jwt = makeAdapter(() => json({ project: { _id: 'p1', name: 'Proj' } }), {
      token,
      walnutAuth: 'jwt',
      projectId: 'proj-1',
    });
    await jwt.adapter.info();
    expect(jwt.calls[0]!.headers).toMatchObject({
      Authorization: `Bearer ${token}`,
      'x-project-id': 'proj-1',
      'x-user-id': 'user-42',
      'Content-Type': 'application/json',
    });

    // Key mode: the API key already carries project context server-side, so neither scoping
    // header is sent (and there is no user identity to derive).
    const key = makeAdapter(() => json({ project: { _id: 'p1', name: 'Proj' } }));
    await key.adapter.info();
    expect(key.calls[0]!.headers).toMatchObject({
      Authorization: 'Bearer plain-api-key',
      'Content-Type': 'application/json',
    });
    expect(key.calls[0]!.headers).not.toHaveProperty('x-project-id');
    expect(key.calls[0]!.headers).not.toHaveProperty('x-user-id');
  });
});

describe('WalnutAdapter discovery reads', () => {
  it('maps info() and tolerates a project without statistics', async () => {
    const { adapter, calls } = makeAdapter((req) => {
      if (req.url.endsWith('/api/projects/proj-1')) {
        return json({
          project: {
            _id: 'mongo-proj',
            name: 'Shop QA',
            statistics: { stories_count: 3, members_count: 4, test_cases_count: 12, defects_count: 1 },
          },
        });
      }
      // No project configured: the path still resolves, and the doc carries no _id/statistics.
      return json({ project: { name: 'Bare project' } });
    }, { projectId: 'proj-1' });

    await expect(adapter.info()).resolves.toEqual({
      provider: 'walnut',
      projectId: 'mongo-proj',
      projectName: 'Shop QA',
      counts: { stories: 3, members: 4, testCases: 12, defects: 1 },
    });

    const bare = makeAdapter(() => json({ project: { name: 'Bare project' } }));
    await expect(bare.adapter.info()).resolves.toEqual({
      provider: 'walnut',
      projectId: '',
      projectName: 'Bare project',
      counts: undefined,
    });
    expect(bare.calls[0]!.url).toBe('https://api.walnut.test/api/projects/');
    expect(calls).toHaveLength(1);
  });

  it('maps listProjects() from both an array body and a { projects } wrapper', async () => {
    const rows = [
      { _id: 'p-a', name: 'Alpha', statistics: { stories_count: 2, test_cases_count: 7 } },
      { id: 'p-b', name: 'Beta' },
    ];

    const arrayForm = makeAdapter(() => json(rows));
    await expect(arrayForm.adapter.listProjects()).resolves.toEqual([
      { id: 'p-a', name: 'Alpha', counts: { stories: 2, members: 0, testCases: 7, defects: 0 } },
      { id: 'p-b', name: 'Beta', counts: { stories: 0, members: 0, testCases: 0, defects: 0 } },
    ]);

    const wrapped = makeAdapter(() => json({ projects: rows }));
    expect(await wrapped.adapter.listProjects()).toHaveLength(2);
    // A body that is neither an array nor a { projects } list degrades to an empty list.
    const empty = makeAdapter(() => json({ nope: true }));
    await expect(empty.adapter.listProjects()).resolves.toEqual([]);
  });

  it('forwards the test-case query and maps list rows and one full document', async () => {
    const { adapter, calls } = makeAdapter((req) => {
      if (req.url.includes('/api/test-cases?')) {
        return json({
          testCases: [
            { _id: 'mongo-1', test_case_id: 'TC_1', title: 'Login', priority: 'high', status: 'active', total_steps: 4 },
          ],
        });
      }
      return json({
        _id: 'mongo-2',
        test_case_id: 'TC_2',
        title: 'Checkout',
        test_category: 'automated',
        priority: 'low',
        story_id: 'story-2',
        test_steps: [
          {
            step_number: 1,
            step_description: 'Click pay',
            step_type: 'web',
            action_type: 'click',
            object_id: 'obj-5',
            expected_result: 'Order placed',
            stepLevelActions: { continueOnFailure: true },
          },
        ],
      });
    });

    await expect(adapter.listTestCases({ search: 'login', limit: 10, offset: 5 })).resolves.toEqual([
      { id: 'TC_1', title: 'Login', priority: 'high', status: 'active', stepCount: 4 },
    ]);
    expect(calls[0]!.url).toBe('https://api.walnut.test/api/test-cases?search=login&limit=10&offset=5');

    await adapter.listTestCases({});
    expect(calls[1]!.url).toBe('https://api.walnut.test/api/test-cases');

    const tc = await adapter.getTestCase('TC_2');
    expect(calls[2]!.url).toBe('https://api.walnut.test/api/test-cases/TC_2');
    expect(tc).toMatchObject({ id: 'TC_2', title: 'Checkout', category: 'automated', storyRef: 'story-2' });
    expect(tc.steps[0]).toMatchObject({
      n: 1,
      description: 'Click pay',
      objectRef: { id: 'obj-5' },
      expectedResult: 'Order placed',
      flags: { continueOnFailure: true },
    });
  });
});

describe('WalnutAdapter actionsCatalog', () => {
  it('overrides the web catalog from the live endpoint, falls back on failure, and filters by platform', async () => {
    const live = makeAdapter(() => json({ actions: [{ action_type: 'navigate' }, { name: 'click' }, { action_type: '' }] }));
    const web = await live.adapter.actionsCatalog('web');
    expect(web.map((a) => a.actionType)).toEqual(['navigate', 'click']);
    expect(web.every((a) => a.platform === 'web')).toBe(true);

    // Every other technology keeps the static catalog.
    const android = await live.adapter.actionsCatalog('android');
    expect(android.map((a) => a.actionType)).toContain('android_click');
    const all = await live.adapter.actionsCatalog();
    expect(all.length).toBeGreaterThan(android.length + web.length);

    // Live catalog unavailable (500) → the static web list is used instead of throwing.
    const offline = makeAdapter(() => ({ status: 500, body: 'boom' }));
    const fallback = await offline.adapter.actionsCatalog('web');
    expect(fallback.map((a) => a.actionType)).toContain('navigate');
    expect(fallback.length).toBeGreaterThan(2);
  });
});

describe('WalnutAdapter writes', () => {
  it('creates a test case over REST: mints recorded objects, links the story, writes test data', async () => {
    const { adapter, calls } = makeAdapter((req) => {
      if (req.url.includes('/api/stories?')) return json({ stories: [{ _id: 'story-1', walnut_key: 'US_002' }] });
      if (req.method === 'POST' && req.url.endsWith('/api/objects')) return json({ _id: 'obj-77' });
      if (req.method === 'POST' && req.url.endsWith('/api/test-cases')) {
        return json({ testCase: { _id: 'mongo-77', test_case_id: 'TC_77' } });
      }
      if (req.url.endsWith('/api/test-cases/TC_77')) return json({ linked_datasets: [{ dataset_id: 'ds-1' }] });
      if (req.url.endsWith('/api/test-data/datasets/ds-1/rows')) {
        return json({
          rows: [
            { _id: 'row-1', values: [{ name: 'user', value: 'old' }] },
            { values: [{ name: 'ignored', value: 'x' }] }, // no _id → skipped
          ],
        });
      }
      if (req.url.endsWith('/api/test-data/rows/row-1')) return json({ ok: true });
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });

    const steps: Step[] = [
      {
        n: 1,
        description: 'Open ${url}',
        actionType: 'navigate',
        stepType: 'web',
        value: 'https://shop.test',
        objectRef: { name: 'URL field', locators: [{ name: 'css', value: '#url' }] },
      },
      { n: 2, description: 'Type ${user}', actionType: 'type', stepType: 'web', value: 'alice' },
    ];
    const tc: TestCase = {
      title: 'Checkout',
      category: 'automated',
      priority: 'high',
      description: 'Buy something',
      objective: 'Order placed',
      preconditions: 'Signed in',
      expectedOutcome: 'Order confirmation',
      tags: ['smoke'],
      storyRef: 'US_002',
      // Explicit data wins over the value derived from the step.
      data: { user: 'explicit' },
      steps,
    };

    const saved = await adapter.createTestCase(tc);
    expect(saved).toEqual({
      id: 'TC_77',
      created: true,
      productUrl: 'https://api.walnut.test/test-cases/TC_77',
    });

    // The recorded locator became a repository object, linked via object_id on the step.
    const objectPost = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/objects'))!;
    expect(objectPost.body).toEqual({
      description: 'URL field',
      object_type: 'WEB',
      attributes: [{ name: 'css', value: '#url' }],
    });

    const createPost = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/test-cases'))!;
    expect(createPost.body).toMatchObject({
      title: 'Checkout',
      test_category: 'automated',
      priority: 'high',
      story_id: 'story-1',
      description: 'Buy something',
      objective: 'Order placed',
      preconditions: 'Signed in',
      expected_outcome: 'Order confirmation',
      tags: ['smoke'],
    });
    expect(createPost.body.test_steps[0]).toMatchObject({ object_id: 'obj-77', step_description: 'Open ${url}' });
    expect(createPost.body.test_steps[1]).not.toHaveProperty('object_id');

    // The auto-created datarow is filled: existing values are kept, derived + explicit values merged.
    const rowPut = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/api/test-data/rows/row-1'))!;
    expect(rowPut.body).toEqual({ values: { user: 'explicit', url: 'https://shop.test' } });
  });

  it('updates a test case: resolves a business key to the Mongo id and sends the full document', async () => {
    const { adapter, calls } = makeAdapter((req) => {
      if (req.method === 'GET' && req.url.endsWith('/api/test-cases/TC_55')) return json({ _id: 'mongo-55' });
      if (req.method === 'PUT' && req.url.endsWith('/api/test-cases/mongo-55')) {
        return json({ data: { test_case_id: 'TC_55' } });
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });

    const saved = await adapter.updateTestCase('TC_55', {
      title: 'Renamed',
      category: 'manual',
      priority: 'medium',
      status: 'active',
      description: 'Updated',
      version: 7,
      storyRef: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      steps: [{ n: 1, description: 'Open ${url}', actionType: 'navigate', stepType: 'web', value: 'https://x' }],
    });

    expect(saved).toEqual({
      id: 'TC_55',
      created: false,
      productUrl: 'https://api.walnut.test/test-cases/TC_55',
    });

    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toMatchObject({
      title: 'Renamed',
      test_category: 'manual',
      priority: 'medium',
      status: 'active',
      description: 'Updated',
      version: 7,
      story_id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      // Full-document PUT: dropped steps must be deleted on the backend.
      reconcile_step_deletions: true,
    });
    expect(put.body.test_steps).toHaveLength(1);
  });
});

describe('WalnutAdapter runs', () => {
  it('startRun dispatches local to the caller’s own agent and cloud to the pinned runner', async () => {
    const token = jwtFor('user-1');
    const { adapter, calls } = makeAdapter((req) => {
      if (req.url.endsWith('/api/agent-credentials/project-agents')) {
        return json({
          agents: [
            { credential_id: 'teammate', is_online: true, owner_user_id: 'user-2' },
            { credential_id: 'mine-stale', is_online: true, owner_user_id: 'user-1', last_seen_at: '2024-01-01T00:00:00Z' },
            { credential_id: 'mine-fresh', is_online: true, owner_user_id: 'user-1', last_seen_at: '2024-05-01T00:00:00Z' },
            { credential_id: 'mine-offline', is_online: false, owner_user_id: 'user-1' },
          ],
        });
      }
      return json({ _id: 'exec-1' });
    }, { token, walnutAuth: 'jwt' });

    await expect(adapter.startRun({ tcId: MONGO_TC }, { mode: 'local' })).resolves.toEqual({ runId: 'exec-1' });

    const reserve = calls.find((c) => c.url.endsWith('/api/executions/reserve'))!;
    expect(reserve.body).toMatchObject({
      testcase_id: MONGO_TC,
      execution_type: 'automated',
      execution_target: 'local',
      browser: 'chromium',
      headless: false,
      agent_credential_id: 'mine-fresh',
    });

    // No online agent owned by the caller → a clear instruction, not an opaque reserve failure.
    const agentless = makeAdapter(() => json({ agents: [{ credential_id: 'teammate', is_online: true, owner_user_id: 'other' }] }), { token, walnutAuth: 'jwt' });
    await expect(agentless.adapter.startRun({ tcId: MONGO_TC }, { mode: 'local' })).rejects.toThrow(
      /No local agent registered to YOUR account is online/,
    );

    // --- cloud: a coded reserve rejection is unwrapped to its human message ---
    const cloud = makeAdapter(() => ({
      status: 409,
      body: JSON.stringify({ code: 'cloud_runner_offline', message: 'Runner is offline. Choose an online runner.' }),
    }));

    await expect(
      cloud.adapter.startRun({ tcId: MONGO_TC }, { mode: 'cloud', cloudRunnerId: 'cr-1', environment: 'cccccccccccccccccccccccc' }),
    ).rejects.toThrow('Runner is offline. Choose an online runner.');

    expect(cloud.calls[0]!.body).toMatchObject({
      execution_target: 'cloud_runner',
      cloud_runner_id: 'cr-1',
      headless: true,
      environment_id: 'cccccccccccccccccccccccc',
    });
    // A non-24-hex environment is not a Mongo id, so it is left to the backend default.
    const plainEnv = makeAdapter(() => json({ execution_id: 'exec-2' }));
    await expect(plainEnv.adapter.startRun({ tcId: MONGO_TC }, { mode: 'cloud', environment: 'staging' })).resolves.toEqual({
      runId: 'exec-2',
    });
    expect(plainEnv.calls[0]!.body).not.toHaveProperty('environment_id');
  });

  it('getRun maps single executions, suite summaries and the post-reserve 404', async () => {
    let suiteStatus = 200;
    const { adapter } = makeAdapter((req) => {
      if (req.url.includes('/api/executions/suite/SR_12/summary')) {
        if (suiteStatus === 404) return { status: 404, body: 'not found' };
        return json({
          suite: { status: 'in_progress' },
          totals: { total: 2, passed: 1 },
          testcases: [
            { testcase_identifier: 'TC_1', testcase_title: 'Login', status: 'passed' },
            { testcase_id: 'mongo-2', status: 'blocked' },
          ],
        });
      }
      return json({ status: 'failed', passed_steps: 1, failed_steps: 1, skipped_steps: 0, blocked_steps: 0, total_steps: 2 });
    });

    await expect(adapter.getRun('exec-1')).resolves.toEqual({
      runId: 'exec-1',
      state: 'failed',
      progress: { done: 2, total: 2 },
      reportUrl: 'https://api.walnut.test/reports/exec-1',
    });

    await expect(adapter.getRun('SR_12')).resolves.toEqual({
      runId: 'SR_12',
      state: 'running',
      progress: { done: 1, total: 2 },
      children: [
        { id: 'TC_1', title: 'Login', state: 'passed' },
        { id: 'mongo-2', state: 'error' },
      ],
    });

    // Right after reserve the child execution docs may not exist yet — that reads as queued.
    suiteStatus = 404;
    await expect(adapter.getRun('SR_12')).resolves.toEqual({ runId: 'SR_12', state: 'queued' });
  });
});

describe('WalnutAdapter error mapping', () => {
  it('turns a project-scope 404 into the actionable hint but leaves other 404s alone', async () => {
    const scoped = makeAdapter(() => ({ status: 404, body: '{"error":"Project not found"}' }));
    await expect(scoped.adapter.getTestCase('TC_1')).rejects.toThrow(
      /isn't accessible with this token.*list_projects.*qa_switch_project/s,
    );

    const missing = makeAdapter(() => ({ status: 404, body: '{"error":"Test case not found"}' }));
    await expect(missing.adapter.getTestCase('TC_9')).rejects.toThrow(/HTTP 404/);
  });

  it('preserves 401/403 statuses (as ApiError) and unwraps a coded JSON body on writes', async () => {
    const unauthorized = makeAdapter(() => ({ status: 401, body: 'unauthorized' }));
    const unauthorizedError = await unauthorized.adapter.getTestCase('TC_1').catch((e: unknown) => e);
    expect(unauthorizedError).toBeInstanceOf(ApiError);
    expect(unauthorizedError).toMatchObject({ status: 401 });

    const forbidden = makeAdapter(() => ({ status: 403, body: 'forbidden' }));
    const forbiddenError = await forbidden.adapter.listTestCases({}).catch((e: unknown) => e);
    expect(forbiddenError).toBeInstanceOf(ApiError);
    expect(forbiddenError).toMatchObject({ status: 403 });

    // A 5xx read keeps the upstream status + body for status-based handling downstream.
    const unavailable = makeAdapter(() => ({ status: 503, body: 'EXECUTIONS_RESERVE_FIRST' }));
    const unavailableError = await unavailable.adapter.getTestCase('TC_1').catch((e: unknown) => e);
    expect(unavailableError).toBeInstanceOf(ApiError);
    expect(unavailableError).toMatchObject({ status: 503, body: 'EXECUTIONS_RESERVE_FIRST' });

    // deleteTestCase collapses any failure to its human message.
    const failedDelete = makeAdapter(() => ({ status: 500, body: JSON.stringify({ message: 'ObjectId cast failed' }) }));
    await expect(failedDelete.adapter.deleteTestCase(MONGO_TC)).rejects.toThrow('ObjectId cast failed');
    // A non-JSON body falls back to the raw snippet, then to the bare status.
    const plainDelete = makeAdapter(() => ({ status: 500, body: 'gateway exploded' }));
    await expect(plainDelete.adapter.deleteTestCase(MONGO_TC)).rejects.toThrow('gateway exploded');
  });
});

describe('WalnutAdapter agent-bound surface', () => {
  it('reports no agent tools / a clear error with no agent, and delegates to the hop when configured', async () => {
    const { adapter, calls } = makeAdapter(() => json({}));

    await expect(adapter.listAgentTools()).resolves.toEqual([]);
    await expect(adapter.callRaw('web', { task: 'x' })).rejects.toThrow(/needs a local Walnut agent/);
    await expect(adapter.readJournal('TC_1')).rejects.toThrow(/journal needs a local product agent/);
    await expect(adapter.editJournal('TC_1', [])).rejects.toThrow(/journal_modify\) needs a local product agent/);
    // None of those touched the REST backend.
    expect(calls).toHaveLength(0);

    // With QA_MCP_URL configured, saving goes to the agent's /mcp instead of REST. Port 1 refuses
    // immediately, which proves the REST path below was never taken.
    const hopped = makeAdapter(() => {
      throw new Error('REST must not be used when an agent hop is configured');
    }, { url: 'http://127.0.0.1:1/mcp', projectId: 'proj-1' });

    const tc: TestCase = { title: 'Delegated', category: 'automated', steps: [] };
    // Either transport-level wording is fine; what matters is that the REST stub below was never hit.
    await expect(hopped.adapter.createTestCase(tc)).rejects.toThrow(/fetch failed|Could not reach the product MCP/);
    await expect(hopped.adapter.updateTestCase('TC_1', tc)).rejects.toThrow(/fetch failed|Could not reach the product MCP/);
    expect(hopped.calls).toHaveLength(0);
  });
});
