import type { ConnectedQaConfig } from '../../config.js';
import type { MakeClientOptions, QaHttp } from '../http.js';
import { ApiError, makeClient } from '../http.js';
import type { ProjectInfo } from '../types.js';
import type {
  ActionDef, CloudRunner, EntityRef, JournalOp, JournalView, LocalAgent, MemberOp, ObjectQuery, ProjectSummary, QaObject, RunOptions, RunRef, RunStatus,
  RunTarget, ScheduleAction, ScheduleInfo, ScheduleOptions, ScheduleRef, ScheduleUpdate, SavedRef, Step, Story, StoryQuery, StorySummary, Suite, SuiteSummary, TcQuery, TcSummary, TestCase,
} from '../../domain/types.js';
import type { WalnutPlatform } from './actionTypes.js';
import { WALNUT_ACTIONS, actionDefsFrom } from './actionTypes.js';
import {
  deriveTestData, fromWalnutObject, fromWalnutStory, fromWalnutStorySummary, fromWalnutSuite, fromWalnutSuiteSummary,
  fromWalnutTc, fromWalnutTcSummary, toWalnutStep,
} from './mapper.js';
import { RemoteMcpAdapter } from '../remoteMcp/adapter.js';

/**
 * Transport-only injection seam for tests: swap the underlying fetch implementation
 * instead of mutating `globalThis`. The adapter still builds its own `QaHttp` via
 * `makeClient` (so its real `headers()` logic always runs, jwt vs key mode included)
 * -- only the network transport is replaceable.
 */
export type WalnutTransport = Pick<MakeClientOptions, 'fetchImpl' | 'FormDataImpl' | 'BlobImpl'>;

type WalnutProjectResponse = {
  project: {
    _id?: string;
    name: string;
    statistics?: {
      stories_count?: number;
      members_count?: number;
      test_cases_count?: number;
      defects_count?: number;
    };
  };
};

type WalnutListResponse = {
  testCases?: unknown[];
  total?: number;
  limit?: number;
  offset?: number;
};

type WalnutActionsResponse = {
  actions?: Array<{ action_type?: string; name?: string }>;
};

/** GET /api/test-cases/:id — only the linked-dataset pointer matters for test-data population. */
type WalnutTcDoc = { linked_datasets?: Array<{ dataset_id?: string }> };

/** GET /api/test-data/datasets/:datasetId/rows — the datarows the create route seeded (one per env). */
type WalnutRowsResponse = {
  rows?: Array<{ _id?: string; values?: Array<{ name?: string; value?: string }> | Record<string, unknown> }>;
};

/** Datarow `values` come back as a `[{name,value}]` array (prepareRowValuesForDb) or, for legacy
 *  rows, a flat object. Flatten either to `{ paramName: value }` so new values can be merged in. */
function flattenRowValues(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const name = (item as { name?: unknown })?.name;
      if (typeof name === 'string' && name) out[name] = String((item as { value?: unknown }).value ?? '');
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = v == null ? '' : String(v);
  }
  return out;
}

/** Neutral step technology -> Object Repository `object_type` (schemas.ts enum, UPPERCASE). Only
 *  element-bearing technologies get an object; api/database/control_flow/function never do. */
const OBJECT_TYPE_FOR_STEP: Partial<Record<Step['stepType'], 'WEB' | 'ANDROID' | 'MAINFRAME'>> = {
  web: 'WEB',
  android: 'ANDROID',
  mainframe: 'MAINFRAME',
};

/** The user id (`id` claim) from a Walnut JWT's payload, for the `x-user-id` header the execution
 *  routes demand. Pure base64url decode — no signature check (the backend re-verifies the token). */
function userIdFromJwt(token: string): string | undefined {
  const seg = token.split('.')[1];
  if (!seg) return undefined;
  try {
    let b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as { id?: unknown };
    return typeof claims.id === 'string' ? claims.id : undefined;
  } catch {
    return undefined;
  }
}

/** Walnut execution `status` (schemas.ts:3315) → neutral RunStatus.state. `blocked` = couldn't run
 *  (setup/dependency) → surfaced as 'error'; `terminated`/`cancelled` = user/system stop → 'stopped'. */
function mapRunState(status: unknown): RunStatus['state'] {
  switch (status) {
    case 'not_started': return 'queued';
    case 'in_progress': return 'running';
    case 'passed': return 'passed';
    case 'failed': return 'failed';
    case 'terminated':
    case 'cancelled': return 'stopped';
    case 'blocked': return 'error';
    case 'skipped': return 'stopped';
    default: return 'queued';
  }
}

/** Reserve/trigger errors come back as coded JSON (no_cloud_runner_available, cloud_runner_offline,
 *  cloud_runner_not_eligible, enqueue_failed, …). Unwrap ApiError.body to the human message so the
 *  client sees "…is offline. Choose an online runner" instead of "HTTP 409". */
function unwrapApiError(e: unknown): Error {
  if (e instanceof ApiError) {
    try {
      const j = JSON.parse(e.body) as { message?: string; error?: string; code?: string };
      const msg = j.message || j.error || j.code;
      if (msg) return new Error(msg);
    } catch {
      // body wasn't JSON — fall through to the snippet
    }
    return new Error(e.body || `HTTP ${e.status}`);
  }
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * The backend's requireProjectAccess org-scopes the project lookup: if the CONNECTED project isn't in
 * the TOKEN's organization, EVERY org-scoped call (tc_list / tc_get / local_agents / runs / …) fails
 * with a bare `404 {"error":"Project not found"}` — which reads like a missing route, not a wrong
 * project. (Hit live: a persisted last-project from org A while the token is org B.) Translate ONLY
 * that case into an actionable hint; every other error (a genuine 404, 409, 503, …) is rethrown
 * UNCHANGED, so status-based handling and real "not found" messages are untouched.
 */
const PROJECT_SCOPE_HINT =
  "The connected project isn't accessible with this token — it's almost certainly not in your token's " +
  'organization (the project may be pinned from a different org). Run list_projects to see the projects ' +
  'this token can access, then qa_switch_project to switch to one.';

function isProjectNotFound(e: unknown): boolean {
  return e instanceof ApiError && e.status === 404 && /project not found/i.test(e.body || '');
}

/** Wrap a QaHttp so a project-scope 404 surfaces PROJECT_SCOPE_HINT instead of a bare "HTTP 404 …".
 *  Applied once to WalnutAdapter.http, so it covers every direct org-scoped call in one place. */
function withProjectScopeHint(http: QaHttp): QaHttp {
  const hint = (e: unknown): never => {
    if (isProjectNotFound(e)) throw new Error(PROJECT_SCOPE_HINT);
    throw e;
  };
  return {
    async getJson<T>(path: string): Promise<T> { try { return await http.getJson<T>(path); } catch (e) { return hint(e); } },
    async postJson<T>(path: string, body: unknown): Promise<T> { try { return await http.postJson<T>(path, body); } catch (e) { return hint(e); } },
    async putJson<T>(path: string, body: unknown): Promise<T> { try { return await http.putJson<T>(path, body); } catch (e) { return hint(e); } },
    async patchJson<T>(path: string, body: unknown): Promise<T> { try { return await http.patchJson<T>(path, body); } catch (e) { return hint(e); } },
    async del(path: string): Promise<void> { try { await http.del(path); } catch (e) { hint(e); } },
    async postMultipart<T>(path: string, partName: string, json: unknown): Promise<T> { try { return await http.postMultipart<T>(path, partName, json); } catch (e) { return hint(e); } },
    async putMultipart<T>(path: string, partName: string, json: unknown): Promise<T> { try { return await http.putMultipart!<T>(path, partName, json); } catch (e) { return hint(e); } },
  };
}

/** Suite-run header status ('passed'|'failed'|'in_progress'|'cancelled') → neutral RunState. */
function mapSuiteRunState(status: unknown): RunStatus['state'] {
  switch (String(status ?? '').toLowerCase()) {
    case 'passed': return 'passed';
    case 'failed': return 'failed';
    case 'in_progress': return 'running';
    case 'cancelled':
    case 'canceled': return 'stopped';
    default: return 'queued';
  }
}

const PRODUCT_URL_SEGMENT: Record<EntityRef['kind'], string> = {
  testcase: 'test-cases',
  suite: 'test-suites',
  // The execution REPORT page in walnut-frontend is `/reports/:id` (App.tsx) — NOT `/executions/:id`
  // (that route 404s). `:id` is the execution Mongo _id, which is what getRun uses as runId.
  run: 'reports',
  // ponytail: walnut has no reusable-function library — segment unused. Kept to satisfy the union.
  function: 'functions',
};

/**
 * WalnutAdapter — DIRECT-to-backend REST driver for Walnut (design note §3/§4). Every data op
 * (discover / author / save / run-dispatch / triage) hits the Walnut backend REST directly via a
 * `QaHttp` bound to `cfg.baseUrl` (the BACKEND base, `QA_BASE_URL`) — so a cloud editor with no local
 * agent can drive the whole lifecycle. The ONLY agent-bound surface is recording + save-with-editor,
 * which hops to the LOCAL AGENT's `/mcp` (`cfg.url`, `QA_MCP_URL`) via a lazily-built RemoteMcpAdapter
 * (see `callRaw`/`listAgentTools`); when `cfg.url` is unset, recording is gracefully unavailable.
 *
 * This class deliberately does not `implements ProviderAdapter` — it ports only the direct-REST subset
 * (journal, objects, environments, suite create/delete are out of scope here); the factory casts it,
 * and no registered tool calls the unported methods.
 */
export class WalnutAdapter {
  private readonly http: QaHttp;
  /** Lazily-built hop to the LOCAL AGENT's /mcp (cfg.url) for the agent-bound recording surface. Only
   *  ever built when cfg.url is set; direct REST never uses it. */
  private agentHop: RemoteMcpAdapter | null = null;

  constructor(
    private readonly cfg: ConnectedQaConfig,
    transport?: WalnutTransport,
  ) {
    // REST base is the BACKEND (cfg.baseUrl / QA_BASE_URL), NOT cfg.url (the agent /mcp endpoint). The
    // factory only builds this adapter when baseUrl is set, so it is present at runtime.
    this.http = withProjectScopeHint(makeClient({ baseUrl: cfg.baseUrl ?? '', headers: () => this.headers(), ...transport }));
  }

  // Auth headers: jwt mode sends the bearer token PLUS x-project-id (the token alone carries no
  // project context) and x-user-id (the execution routes read the acting user from THIS header — see
  // below); key mode sends only the bearer token, because an MCP API key already carries project
  // context server-side. Sending x-project-id in key mode, or omitting it in jwt mode, breaks real
  // requests against walnut-backend.
  //
  // x-user-id (jwt mode): the execution routes (POST /executions/reserve, /:id/stop, …) read the
  // acting user from THIS header, not just from the token — omitting it 400s with "Project ID and
  // User ID are required". It is derived from the token's own `id` claim, so it always matches the
  // authenticated user; harmless on the routes that ignore it.
  //
  // NOTE (common-mcp adaptation): projectId is OPTIONAL here (a session can be connected before a
  // project is chosen), so x-project-id is spread in only when present — mirroring RemoteMcpAdapter.
  private headers(): Record<string, string> {
    if (this.cfg.walnutAuth !== 'jwt') {
      return { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json' };
    }
    const uid = userIdFromJwt(this.cfg.token);
    return {
      Authorization: `Bearer ${this.cfg.token}`,
      ...(this.cfg.projectId ? { 'x-project-id': this.cfg.projectId } : {}),
      ...(uid ? { 'x-user-id': uid } : {}),
      'Content-Type': 'application/json',
    };
  }

  /** Validates baseUrl+token+project (`GET /api/projects/:id`). */
  async info(): Promise<ProjectInfo> {
    const res = await this.http.getJson<WalnutProjectResponse>(`/api/projects/${this.cfg.projectId ?? ''}`);
    const { project } = res;
    const stats = project.statistics;
    return {
      provider: 'walnut',
      projectId: project._id != null ? String(project._id) : (this.cfg.projectId ?? ''),
      projectName: project.name,
      counts: stats
        ? {
            stories: stats.stories_count ?? 0,
            members: stats.members_count ?? 0,
            testCases: stats.test_cases_count ?? 0,
            defects: stats.defects_count ?? 0,
          }
        : undefined,
    };
  }

  /** Projects visible to the token (`GET /api/projects`). Tolerant of both an array body and a
   *  `{ projects: [...] }` wrapper. */
  async listProjects(): Promise<ProjectSummary[]> {
    const res = await this.http.getJson<unknown>('/api/projects');
    const rows: unknown[] = Array.isArray(res) ? res : ((res as { projects?: unknown[] } | null)?.projects ?? []);
    return rows.map((row) => {
      const p = row as Record<string, unknown>;
      const stats = (p['statistics'] ?? {}) as Record<string, unknown>;
      const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
      return {
        id: String(p['id'] ?? p['_id'] ?? ''),
        name: String(p['name'] ?? ''),
        counts: {
          stories: num(stats['stories_count']),
          members: num(stats['members_count']),
          testCases: num(stats['test_cases_count']),
          defects: num(stats['defects_count']),
        },
      };
    });
  }

  async listTestCases(q: TcQuery): Promise<TcSummary[]> {
    const params = new URLSearchParams();
    if (q.search) params.set('search', q.search);
    if (q.limit != null) params.set('limit', String(q.limit));
    if (q.offset != null) params.set('offset', String(q.offset));
    const qs = params.toString();
    const res = await this.http.getJson<WalnutListResponse>(`/api/test-cases${qs ? `?${qs}` : ''}`);
    return (res.testCases ?? []).map((row) => fromWalnutTcSummary(row as Record<string, unknown>));
  }

  /** Neutral, steps included. `id` accepts either a Mongo ObjectId or a `TC_xxx` business key. */
  // ponytail: Walnut has no version model — versionId is accepted for interface parity and ignored.
  async getTestCase(id: string, _versionId?: string): Promise<TestCase> {
    // Passed through untouched -- never validated/transformed. The backend itself
    // resolves by shape (walnut-backend test-cases.ts:5156: 24-hex-char -> _id,
    // else -> test_case_id).
    const doc = await this.http.getJson<Record<string, unknown>>(`/api/test-cases/${id}`);
    return fromWalnutTc(doc);
  }

  /** List the project's test suites (`GET /api/test-suites`). `skip_filters=true` skips the faceted
   *  filter-metadata queries we don't need. Excludes ad-hoc suites server-side. `id` is the Mongo
   *  `_id` (what getSuite resolves by). */
  async listSuites(): Promise<SuiteSummary[]> {
    const res = await this.http.getJson<{ suites?: unknown[] }>('/api/test-suites?skip_filters=true');
    return (res.suites ?? []).map((row) => fromWalnutSuiteSummary(row as Record<string, unknown>));
  }

  /** Read one suite with its ordered members (`GET /api/test-suites/:id`). `id` is the Mongo `_id`
   *  (the route does NOT accept the `SU_` business key). */
  async getSuite(id: string): Promise<Suite> {
    const doc = await this.http.getJson<Record<string, unknown>>(`/api/test-suites/${id}`);
    return fromWalnutSuite(doc);
  }

  /** List the project's USER STORIES (`GET /api/stories?type=story`), for the story-driven authoring
   *  flow. `search` is a case-insensitive regex over key/title/description/AC (backend SEC-07 escaped).
   *  `id` on each row is the Mongo `_id` (what a test case links to via story_id). */
  async listStories(q: StoryQuery): Promise<StorySummary[]> {
    const params = new URLSearchParams({ type: 'story' });
    if (q.search) params.set('search', q.search);
    if (q.status) params.set('status', q.status);
    if (q.limit != null) params.set('limit', String(q.limit));
    if (q.offset != null) params.set('offset', String(q.offset));
    const res = await this.http.getJson<{ stories?: unknown[] }>(`/api/stories?${params.toString()}`);
    return (res.stories ?? []).map((row) => fromWalnutStorySummary(row as Record<string, unknown>));
  }

  /** Read one user story with its acceptance criteria. `GET /api/stories/:id` resolves by Mongo `_id`
   *  ONLY (no business-key route), so a `US_123`/Jira key is resolved first via the list `search`
   *  endpoint, matching key/walnut_key. */
  async getStory(id: string): Promise<Story> {
    const mongoId = await this.resolveStoryMongoId(id);
    const doc = await this.http.getJson<{ story?: Record<string, unknown> }>(`/api/stories/${mongoId}`);
    return fromWalnutStory((doc.story ?? doc) as Record<string, unknown>);
  }

  /** Resolve a story reference to its Mongo `_id`. A 24-hex id passes straight through; a business key
   *  (US_123 / an external Jira key) is looked up via `GET /api/stories?search=` and matched on
   *  key/walnut_key (there is no GET-by-key route). Throws a clear error when nothing matches. */
  private async resolveStoryMongoId(ref: string): Promise<string> {
    if (/^[0-9a-f]{24}$/i.test(ref)) return ref;
    // No GET-by-key route; and the list `search` regex covers key/title/description/AC but NOT the minted
    // walnut_key (US_001). Native stories have an EMPTY `key` (only walnut_key), so a keyword search on
    // "US_002" returns nothing. Scan the story list and match the business key (key / walnut_key /
    // raw_key) client-side instead.
    const params = new URLSearchParams({ type: 'story', limit: '200' });
    const res = await this.http.getJson<{ stories?: Array<Record<string, unknown>> }>(`/api/stories?${params.toString()}`);
    const rows = res.stories ?? [];
    const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
    const target = norm(ref);
    const hit = rows.find((r) => norm(r['key']) === target || norm(r['walnut_key']) === target || norm(r['raw_key']) === target);
    const id = hit?.['_id'] ?? hit?.['id'];
    if (!id) throw new Error(`No user story found for "${ref}" — check the story key (e.g. US_001) or pass its id.`);
    return String(id);
  }

  async searchObjects(q: ObjectQuery): Promise<QaObject[]> {
    const params = new URLSearchParams();
    if (q.query) params.set('search', q.query);
    if (q.pageName) params.set('pageName', q.pageName);
    if (q.limit != null) params.set('limit', String(q.limit));
    if (q.offset != null) params.set('offset', String(q.offset));
    const qs = params.toString();
    const res = await this.http.getJson<{ objects?: unknown[] }>(`/api/objects${qs ? `?${qs}` : ''}`);
    return (res.objects ?? []).map((row) => fromWalnutObject(row as Record<string, unknown>));
  }

  /** Read one object with its full locator bag (`GET /api/objects/:id`). */
  async getObject(id: string): Promise<QaObject> {
    const doc = await this.http.getJson<Record<string, unknown>>(`/api/objects/${id}`);
    return fromWalnutObject(doc);
  }

  async deleteObject(id: string): Promise<void> {
    await this.http.del(`/api/objects/${id}`);
  }

  /** Delete a test case (`DELETE /api/test-cases/:id`; recoverable via the product recycle bin). Like
   *  the update PUT, the route resolves ONLY by Mongo _id, so a business key is resolved first. */
  async deleteTestCase(id: string): Promise<void> {
    const mongoId = await this.resolveTestcaseMongoId(id);
    try {
      await this.http.del(`/api/test-cases/${mongoId}`);
    } catch (e) {
      throw unwrapApiError(e);
    }
  }

  /**
   * Add / remove suite members (`PATCH /api/test-suites/:id/test-cases`, one action per call). The
   * neutral op names a `tcId`, but the two backend actions speak different keys:
   *   • add    → `testCaseIds[]` of MONGO _ids (the route casts them to ObjectId), so each tcId is
   *              resolved from a business key when needed. The backend appends with fresh instanceIds
   *              and rejects mixing test-case categories (manual vs automated) in one suite (409).
   *   • remove → a single `instanceId`. The suite stores instanceIds, not tcIds, so we map each
   *              requested tcId (business key OR Mongo _id) to the instanceId(s) it occupies in the
   *              CURRENT membership and remove each. Removing a tcId drops every instance of it.
   * Returns the resulting neutral Suite. (reorder ops aren't surfaced as a tool; ignored here.)
   */
  async updateSuiteMembers(id: string, ops: MemberOp[]): Promise<Suite> {
    const removes = ops.filter((o) => o.op === 'remove');
    const adds = ops.filter((o) => o.op === 'add');

    if (removes.length) {
      const doc = await this.http.getJson<{ testCases?: Array<Record<string, unknown>> }>(
        `/api/test-suites/${id}`,
      );
      const wanted = new Set(removes.map((o) => String(o.tcId)));
      const instanceIds: string[] = [];
      for (const m of doc.testCases ?? []) {
        const tc = (m as { testCaseId?: { _id?: unknown; test_case_id?: unknown } | string }).testCaseId;
        const businessKey = typeof tc === 'object' && tc ? String(tc.test_case_id ?? '') : '';
        const mongoId = typeof tc === 'object' && tc ? String(tc._id ?? '') : String(tc ?? '');
        const inst = String((m as { instanceId?: unknown }).instanceId ?? '');
        if (inst && (wanted.has(businessKey) || wanted.has(mongoId))) instanceIds.push(inst);
      }
      if (!instanceIds.length) {
        throw new Error(`None of the requested test cases are members of suite ${id}.`);
      }
      for (const instanceId of instanceIds) {
        try {
          await this.http.patchJson(`/api/test-suites/${id}/test-cases`, { action: 'remove', instanceId });
        } catch (e) {
          throw unwrapApiError(e);
        }
      }
    }

    if (adds.length) {
      const testCaseIds = await Promise.all(adds.map((o) => this.resolveTestcaseMongoId(String(o.tcId))));
      try {
        await this.http.patchJson(`/api/test-suites/${id}/test-cases`, { action: 'add', testCaseIds });
      } catch (e) {
        throw unwrapApiError(e);
      }
    }

    return this.getSuite(id);
  }

  /**
   * Persist a NEW test case (`POST /api/test-cases`). The body mirrors the product's create schema:
   * the category field is `test_category` (NOT `category`); `status` defaults to 'draft' server-side
   * so we omit it; steps go through `toWalnutStep`. project comes from the x-project-id header and
   * the creator from the JWT, so neither is in the body.
   *
   * Two-step, exactly like the UI: create the test case (the backend auto-creates a dataset with a
   * column per `${param}` token and an EMPTY datarow), then fill that datarow via the SAME
   * /api/test-data endpoint the Test Data tab uses. This keeps web value-handling in the MCP (no
   * backend change) — walnut stores web values as `${param}` + datarow, never inline on the step.
   */
  async createTestCase(tc: TestCase): Promise<SavedRef> {
    // Prefer the agent hop when a QA_MCP_URL is configured (priority 1). The agent's save is the FULL
    // flow — it opens the live editor on the saved TC and (with the journal work) re-keys the recording
    // seed onto the new TC — neither of which the direct-REST path below does. Recording is always
    // agent-hosted, so a recorded draft's seed lives on the agent; saving through the SAME agent keeps
    // it journaled and shows the user the saved TC in the editor. Fall back to direct REST only when
    // there is NO agent hop (a cloud editor with QA_BASE_URL only).
    const saveHop = this.hop();
    if (saveHop) return saveHop.createTestCase(tc);
    await this.ensureRecordedObjects(tc.steps); // mint + link objects so recorded steps are executable
    // Link to a user story when supplied (manual-for-story authoring). The create route auto-derives
    // feature_id/epic_id from the story; story_id must be the Mongo _id, so resolve a US_/Jira key first.
    const storyId = tc.storyRef ? await this.resolveStoryMongoId(tc.storyRef) : undefined;
    const body: Record<string, unknown> = {
      title: tc.title,
      test_category: tc.category,
      priority: tc.priority,
      test_steps: tc.steps.map(toWalnutStep),
      ...(storyId ? { story_id: storyId } : {}),
      ...(tc.description ? { description: tc.description } : {}),
      ...(tc.objective ? { objective: tc.objective } : {}),
      ...(tc.preconditions ? { preconditions: tc.preconditions } : {}),
      ...(tc.expectedOutcome ? { expected_outcome: tc.expectedOutcome } : {}),
      ...(tc.tags && tc.tags.length ? { tags: tc.tags } : {}),
    };
    const res = await this.http.postJson<Record<string, unknown>>('/api/test-cases', body);
    const saved = this.savedRefFrom(res, true);

    // Fill the auto-created datarow with the ${param} values (derived per step, explicit tc.data
    // winning). A failure here is surfaced, not swallowed — the whole point is to stop values from
    // silently vanishing; the test case itself already exists, so the message says so.
    const testData = { ...deriveTestData(tc.steps), ...(tc.data ?? {}) };
    if (saved.id && Object.keys(testData).length) {
      try {
        await this.writeDefaultTestData(saved.id, testData);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `Test case ${saved.id} was created, but writing its default test data failed: ${msg}. ` +
            'Open it and fill the Test Data tab manually.',
        );
      }
    }
    return saved;
  }

  /**
   * Populate the datarow(s) of the dataset Walnut auto-creates from a test case's `${param}` tokens
   * — the same second step the UI's Test Data tab performs (create leaves the columns empty). Values
   * are keyed by PARAM NAME (the `${...}` token), which is how walnut stores them
   * (prepareRowValuesForDb). No dataset linked (the test case had no `${param}` tokens) → no-op.
   * Writes every seeded row (the create route makes one per project environment), merging over
   * whatever the row already holds so nothing existing is clobbered.
   */
  private async writeDefaultTestData(tcId: string, values: Record<string, string>): Promise<void> {
    const doc = await this.http.getJson<WalnutTcDoc>(`/api/test-cases/${tcId}`);
    const datasetId = doc.linked_datasets?.[0]?.dataset_id;
    if (!datasetId) return; // no ${param} tokens → nothing was auto-created to fill
    const rowsRes = await this.http.getJson<WalnutRowsResponse>(`/api/test-data/datasets/${datasetId}/rows`);
    for (const row of rowsRes.rows ?? []) {
      if (!row._id) continue;
      const merged = { ...flattenRowValues(row.values), ...values };
      await this.http.putJson(`/api/test-data/rows/${row._id}`, { values: merged });
    }
  }

  /** Update an EXISTING test case, full-document (`PUT /api/test-cases/:id`). Sends the neutral
   *  `version` for optimistic concurrency when present. */
  async updateTestCase(id: string, tc: TestCase): Promise<SavedRef> {
    // Prefer the agent hop when configured (priority 1) — same rationale as createTestCase: the agent
    // save opens the editor and (with the journal work) keeps the seed in sync. Direct REST only when
    // there is no agent hop.
    const saveHop = this.hop();
    if (saveHop) return saveHop.updateTestCase(id, tc);
    await this.ensureRecordedObjects(tc.steps); // same object-minting as create, for edited/recorded steps
    // Preserve/attach the story link on update too (the manual→automated promote keeps it).
    const storyId = tc.storyRef ? await this.resolveStoryMongoId(tc.storyRef) : undefined;
    const body: Record<string, unknown> = {
      title: tc.title,
      test_category: tc.category,
      priority: tc.priority,
      test_steps: tc.steps.map(toWalnutStep),
      ...(storyId ? { story_id: storyId } : {}),
      // Full-document semantics: this PUT carries the COMPLETE step list, so removed steps must be
      // deleted, not left lingering. The backend only reconciles deletions behind this opt-in flag
      // (test-cases.ts PUT :6132) — without it, a step dropped from the payload survives (each kept
      // step is matched by its _id, emitted below via toWalnutStep). Together = a clean replace.
      reconcile_step_deletions: true,
      ...(tc.status ? { status: tc.status } : {}),
      ...(tc.description ? { description: tc.description } : {}),
      ...(tc.version != null ? { version: tc.version } : {}),
    };
    // PUT /api/test-cases/:id resolves ONLY by Mongo _id (findOne({_id:id})) — a business key like
    // TC_123 makes Mongo throw a CastError → generic 500. GET tolerates both; PUT does not. Resolve
    // to the _id first (24-hex passes straight through).
    const mongoId = await this.resolveTestcaseMongoId(id);
    const res = await this.http.putJson<Record<string, unknown>>(`/api/test-cases/${mongoId}`, body);
    return this.savedRefFrom(res, false);
  }

  /** Neutral SavedRef from a create/update response, tolerant of the doc being bare or wrapped
   *  (`{ testCase }` / `{ data }`). Prefers the business id (`test_case_id`) for the deep link. */
  private savedRefFrom(res: unknown, created: boolean): SavedRef {
    const r = (res ?? {}) as Record<string, unknown>;
    const doc = ((r['testCase'] ?? r['data'] ?? r) ?? {}) as Record<string, unknown>;
    const businessId = doc['test_case_id'] != null ? String(doc['test_case_id']) : '';
    const mongoId = doc['_id'] != null ? String(doc['_id']) : '';
    const id = businessId || mongoId;
    return {
      id,
      created,
      ...(id ? { productUrl: this.productUrlFor({ kind: 'testcase', id }) } : {}),
    };
  }

  /**
   * The credential of the ONLINE local agent for this project — the SAME one the UI's Run modal
   * dispatches to. Sourced from the live roster (`GET /api/agent-credentials/project-agents`). The
   * roster reflects real Redis/heartbeat presence, so `is_online` always targets a live poller.
   * Returns null when the acting user has no online agent, OR when the roster endpoint is unreachable
   * (e.g. the `ai-agents` feature flag is off) — the caller then surfaces a clear "no local agent"
   * error. (The agent's cached-credential fallback is agent-only and intentionally not ported here.)
   */
  private async resolveLocalAgentCredential(): Promise<string | null> {
    try {
      const res = await this.http.getJson<{
        agents?: Array<{ credential_id?: string; is_online?: boolean; owner_user_id?: string;
                         agent_user_id?: string; last_seen_at?: string }>;
      }>('/api/agent-credentials/project-agents');
      const agents = res.agents ?? [];
      // A SHARED project lists EVERY member's agent. A local run must go to THE ACTING USER'S OWN
      // agent — NOT the first online one in the roster, which is very likely a teammate's machine.
      // Dispatching there sends the run to someone else's box (where it "passes in the UI but crashes
      // via MCP", because the UI runs on the user's own agent) and is an isolation problem besides.
      // Match the user from the JWT `id` claim, preferring their most-recently-seen online agent.
      const uid = userIdFromJwt(this.cfg.token);
      if (uid) {
        const mine = agents
          .filter((a) => a.is_online && a.credential_id
            && (a.owner_user_id === uid || a.agent_user_id === uid))
          .sort((a, b) => (b.last_seen_at ?? '').localeCompare(a.last_seen_at ?? ''));
        return mine[0]?.credential_id ?? null; // null = the acting user has no online agent
      }
      // Raw API key (no user identity in the token): can't match an owner — fall back to first online.
      return agents.find((a) => a.is_online && a.credential_id)?.credential_id ?? null;
    } catch {
      return null; // roster unreachable → caller surfaces a clear "no local agent" error
    }
  }

  /**
   * Persist recorded elements into the Object Repository so a saved test case is EXECUTABLE.
   *
   * A recorded step carries `objectRef.locators` (real captured selectors) but no `objectRef.id` —
   * it's a NEW object not yet in the repository. Walnut binds a step to its element via `object_id`
   * (a repository row); it does NOT store locators inline on the step. So without this, the save
   * drops every locator (object_id stays null) and the test case can't find its elements at run time.
   *
   * For each such step we POST /api/objects (description = the element name, attributes = the recorded
   * locators verbatim — the executor reads them by name: `playwright` primary, `xpath_*` fallbacks)
   * and stamp the returned `_id` onto `objectRef.id` so `toWalnutStep` then emits `object_id`. Runs
   * BEFORE the test-case create, so a failure aborts cleanly with nothing half-saved (any objects
   * already minted are just unlinked repository rows).
   */
  private async ensureRecordedObjects(steps: Step[]): Promise<void> {
    for (const s of steps) {
      const ref = s.objectRef;
      if (!ref || ref.id || !ref.locators?.length) continue; // already linked, or nothing captured
      const objectType = OBJECT_TYPE_FOR_STEP[s.stepType];
      if (!objectType) continue; // api/db/control-flow/function steps have no UI object
      const body = {
        description: ref.name ?? s.description ?? 'Recorded element',
        object_type: objectType,
        attributes: ref.locators.map((l) => ({ name: l.name, value: l.value })),
      };
      let res: { _id?: string };
      try {
        res = await this.http.postJson<{ _id?: string }>('/api/objects', body);
      } catch (e) {
        throw new Error(
          `Failed to create the Object Repository entry for step ${s.n} ("${body.description}"): ` +
            `${e instanceof Error ? e.message : String(e)}. The test case was not saved.`,
        );
      }
      if (!res?._id) throw new Error(`Object create for step ${s.n} returned no id; the test case was not saved.`);
      ref.id = String(res._id); // link → toWalnutStep now emits object_id → executable
    }
  }

  /** A neutral tcId may be a business key (`TC_123`) or a Mongo `_id`; the executions API wants the
   *  `_id`. 24-hex → pass through; otherwise resolve via the test-case read. */
  private async resolveTestcaseMongoId(tcId: string): Promise<string> {
    if (/^[0-9a-f]{24}$/i.test(tcId)) return tcId;
    const doc = await this.http.getJson<{ _id?: string }>(`/api/test-cases/${tcId}`);
    if (!doc?._id) throw new Error(`Could not resolve test case "${tcId}" to an id.`);
    return String(doc._id);
  }

  /**
   * Start a run of ONE test case (`POST /api/executions/reserve`; reserve-first is the only path for
   * cloud, and the modern path for local). mode:'local' dispatches to THIS agent's own queue (its
   * cached agent credential); mode:'cloud' dispatches to the chosen online cloud runner. The backend
   * mints the execution + enqueues; per-step driving happens on the agent/runner. `environment` is
   * used only when it is already a Mongo id — otherwise the backend applies the project default env.
   */
  async startRun(target: RunTarget, opts: RunOptions): Promise<RunRef> {
    if (target.suiteId) return this.startSuiteRun(target.suiteId, opts);
    if (!target.tcId) throw new Error('startRun: a test case id (tcId) or a suite id (suiteId) is required.');
    const isCloud = opts.mode === 'cloud';
    const body: Record<string, unknown> = {
      testcase_id: await this.resolveTestcaseMongoId(target.tcId),
      execution_type: 'automated',
      execution_target: isCloud ? 'cloud_runner' : 'local',
      // Default to bundled 'chromium', NOT 'chrome': the 'chrome' channel launches the user's real
      // installed Google Chrome, which exits within ~2s ("Browser disconnected UNEXPECTEDLY / external
      // close") when Chrome is already open (profile/singleton conflict) or version-mismatched with the
      // agent's Playwright. 'chromium' ships with the agent and runs an isolated profile — the same
      // stable browser a UI run uses. Callers can still pass browser:'chrome'/'msedge'/'firefox'/'webkit'.
      browser: opts.browser ?? 'chromium',
      headless: opts.headless ?? isCloud, // cloud VMs run headless; local shows the browser by default
      ...(opts.environment && /^[0-9a-f]{24}$/i.test(opts.environment) ? { environment_id: opts.environment } : {}),
    };
    if (isCloud) {
      if (opts.cloudRunnerId) body['cloud_runner_id'] = opts.cloudRunnerId; // else backend auto-picks
    } else {
      // A caller-picked agent (opts.agentId, from listLocalAgents) dispatches to THAT agent; otherwise
      // auto-pick the acting user's own online agent (the roster-backed resolveLocalAgentCredential).
      const cred = opts.agentId || (await this.resolveLocalAgentCredential());
      if (!cred) {
        throw new Error(
          'No local agent registered to YOUR account is online for this project. Open YOUR Walnut ' +
            'agent and make sure it shows connected/verified (its task poller must be running), or run ' +
            'on cloud. (A local run only ever dispatches to your own agent, never a teammate\'s.)',
        );
      }
      body['agent_credential_id'] = cred;
    }
    let res: { _id?: string; execution_mongo_id?: string; execution_id?: string };
    try {
      res = await this.http.postJson('/api/executions/reserve', body);
    } catch (e) {
      throw unwrapApiError(e);
    }
    const runId = res.execution_mongo_id ?? res._id ?? res.execution_id;
    if (!runId) throw new Error('Run was triggered but the backend returned no execution id.');
    return { runId: String(runId) };
  }

  /**
   * Start a SUITE run (`POST /api/executions/reserve` in suite mode — `testcase_ids[]` present).
   * Fetches the suite's ordered members to build the parallel `testcase_ids`/`instance_ids` the
   * reserve expects, then dispatches: mode:'local' → THIS agent's own queue (its online credential,
   * which the backend requires for a local suite); mode:'cloud' → the chosen/auto-picked online
   * runner. Returns the suite-run id (`SR_xxx`) as runId — getRun/stopRun route it back to the suite
   * endpoints by that prefix.
   */
  private async startSuiteRun(suiteId: string, opts: RunOptions): Promise<RunRef> {
    const doc = await this.http.getJson<{ testCases?: Array<Record<string, unknown>> }>(
      `/api/test-suites/${suiteId}`,
    );
    const members = (doc.testCases ?? [])
      .filter((m) => m && (m as { testCaseId?: unknown }).testCaseId)
      .slice()
      .sort((a, b) => Number((a as { order?: number }).order ?? 0) - Number((b as { order?: number }).order ?? 0));
    if (!members.length) throw new Error(`Suite ${suiteId} has no runnable test cases.`);
    const testcaseIds = members.map((m) => {
      const tc = (m as { testCaseId?: { _id?: unknown } | string }).testCaseId;
      return String(typeof tc === 'object' && tc ? (tc._id ?? '') : (tc ?? ''));
    });
    const instanceIds = members.map((m) => String((m as { instanceId?: unknown }).instanceId ?? ''));

    const isCloud = opts.mode === 'cloud';
    const body: Record<string, unknown> = {
      testcase_ids: testcaseIds,
      instance_ids: instanceIds,
      // Local is always serial (the backend forces it); cloud honours the requested strategy.
      strategy: isCloud ? (opts.strategy ?? 'serial') : 'serial',
      execution_type: 'automated',
      execution_target: isCloud ? 'cloud_runner' : 'local',
      suite_id: suiteId,
      browser: opts.browser ?? 'chromium',
      headless: opts.headless ?? isCloud,
      ...(opts.environment && /^[0-9a-f]{24}$/i.test(opts.environment) ? { environment_id: opts.environment } : {}),
      ...(opts.terminateOnFailure !== undefined ? { terminate_on_failure: opts.terminateOnFailure } : {}),
      ...(isCloud && opts.maxConcurrent ? { max_concurrent: opts.maxConcurrent } : {}),
    };
    if (isCloud) {
      if (opts.cloudRunnerId) body['cloud_runner_id'] = opts.cloudRunnerId; // else backend auto-picks
    } else {
      // A caller-picked agent (opts.agentId, from listLocalAgents) dispatches to THAT agent; otherwise
      // auto-pick the acting user's own online agent.
      const cred = opts.agentId || (await this.resolveLocalAgentCredential());
      if (!cred) {
        throw new Error(
          'No local agent registered to YOUR account is online for this project. Open YOUR Walnut ' +
            'agent and make sure it shows connected/verified, or run the suite on cloud.',
        );
      }
      body['agent_credential_id'] = cred;
    }
    let res: { suite_execution_id?: string };
    try {
      res = await this.http.postJson('/api/executions/reserve', body);
    } catch (e) {
      throw unwrapApiError(e);
    }
    if (!res.suite_execution_id) {
      throw new Error('Suite run was triggered but the backend returned no suite execution id.');
    }
    return { runId: String(res.suite_execution_id) };
  }

  /**
   * Create a SCHEDULE — a deferred / recurring run — instead of dispatching now (`POST /api/schedules`,
   * the same route the Scheduler UI uses). Maps the neutral target + ScheduleOptions to the backend's
   * createScheduleSchema: schedule_target ('test_case' when a tcId is given, else 'suite'); tc_id /
   * suite_id (the backend resolves a tc_id business key OR _id, but a suite_id must be a Mongo _id);
   * execution_target ('local' | 'cloud_runner' from opts.mode); assigned_agent_credential_id (the
   * picked local agent for local, or the picked cloud runner for cloud — omit to let the backend
   * auto-pick a VM); scheduled_for (REQUIRED ISO); schedule_type (default 'once'); end_date; timezone
   * (default 'UTC'); environment_id (only when a 24-hex id, mirroring startRun). MANUAL test cases are
   * rejected server-side (MANUAL_NOT_SCHEDULABLE_CODE); unwrapApiError surfaces that message verbatim.
   */
  async createSchedule(target: RunTarget, opts: ScheduleOptions): Promise<ScheduleRef> {
    if (opts.scheduleType === 'every_5_minutes') {
      throw new Error('Walnut schedules do not support "Every 5 Minutes" — pick once, hourly, daily, weekdays, weekly or monthly.');
    }
    if (!target.tcId && !target.suiteId) {
      throw new Error('createSchedule: a test case id (tcId) or a suite id (suiteId) is required.');
    }
    if (!opts.scheduledFor) {
      throw new Error('createSchedule: scheduledFor (an ISO datetime) is required for a schedule.');
    }
    const isCloud = opts.mode === 'cloud';
    // A schedule fires detached from any live session, so a LOCAL schedule MUST target a specific
    // agent — there is no "caller's own agent" at fire time. The backend only requires+honors the
    // pin in execution_mode:'manual' (needsAssignedAgent), so we must send both.
    if (!isCloud && !opts.agentId) {
      throw new Error(
        'createSchedule: a LOCAL schedule must target a specific agent (agentId — a credential_id ' +
          'from listLocalAgents). It runs detached from any live session, so there is no default agent.',
      );
    }
    const body: Record<string, unknown> = {
      schedule_target: target.tcId ? 'test_case' : 'suite',
      ...(target.tcId ? { tc_id: target.tcId } : {}),
      ...(target.suiteId ? { suite_id: target.suiteId } : {}),
      schedule_type: opts.scheduleType ?? 'once',
      execution_target: isCloud ? 'cloud_runner' : 'local',
      // LOCAL: pin the picked agent. execution_mode:'manual' is what makes the backend REQUIRE and
      //   honor assigned_agent_credential_id (needsAssignedAgent); without it the pin is ignored and a
      //   detached schedule has no agent to run on. (A local agent credential that is actually a
      //   test_runner_vm cred is auto-promoted to cloud_runner by the backend — see schedules.ts.)
      // CLOUD: the backend forces execution_mode='manual' itself and takes assigned_agent_credential_id
      //   as an OPTIONAL pin — the runner's test_runner_vm CREDENTIAL id (CloudRunner.credentialId, a
      //   DIFFERENT id-space from cloudRunnerId/compute_configs._id). Omit it to auto-pick a live VM at
      //   fire time. A pinned VM that is offline at create time is rejected by the backend.
      ...(isCloud
        ? (opts.cloudRunnerCredentialId ? { assigned_agent_credential_id: opts.cloudRunnerCredentialId } : {})
        : { execution_mode: 'manual', assigned_agent_credential_id: opts.agentId }),
      // Absent browser is intentional: the backend then falls back to each test case's own saved
      // browser instead of forcing one (createScheduleSchema.browser has no default).
      ...(opts.browser ? { browser: opts.browser } : {}),
      scheduled_for: opts.scheduledFor,
      ...(opts.endDate ? { end_date: opts.endDate } : {}),
      timezone: opts.timezone ?? 'UTC',
      ...(opts.environmentId && /^[0-9a-f]{24}$/i.test(opts.environmentId) ? { environment_id: opts.environmentId } : {}),
    };
    let res: { data?: Record<string, unknown> } & Record<string, unknown>;
    try {
      res = await this.http.postJson('/api/schedules', body);
    } catch (e) {
      throw unwrapApiError(e); // surfaces MANUAL_NOT_SCHEDULABLE + coded schedule errors as the human message
    }
    const doc = ((res?.data ?? res) ?? {}) as Record<string, unknown>;
    const id = doc['_id'] != null ? String(doc['_id']) : '';
    if (!id) throw new Error('Schedule was created but the backend returned no schedule id.');
    return {
      id,
      ...(typeof doc['status'] === 'string' ? { status: doc['status'] } : {}),
      ...(doc['next_run_at'] != null ? { nextRunAt: String(doc['next_run_at']) } : {}),
    };
  }

  /** Map one raw schedule row (`GET /api/schedules`) to a neutral ScheduleInfo — human target + cadence
   *  + status + pinned agent NAME (never the credential_id) + the update_version an edit must echo. */
  private toScheduleInfo(r: Record<string, unknown>): ScheduleInfo {
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
    const suiteId = str(r['suite_id']);
    const suiteName = str(r['suite_name']);
    const tcKey = str(r['tc_identifier']) ?? str(r['tc_id']);
    const tcName = str(r['tc_name']);
    const target = suiteId
      ? `Suite${suiteName ? `: ${suiteName}` : ` ${suiteId}`}`
      : `${tcKey ?? '(test case)'}${tcName ? ` — ${tcName}` : ''}`;
    const et = str(r['execution_target']);
    const agent = str(r['assigned_agent_owner_name']);
    const browser = str(r['browser']);
    const tz = str(r['timezone']);
    return {
      id: String(r['_id'] ?? ''),
      target,
      scheduleType: str(r['schedule_type']) ?? 'once',
      status: str(r['status']) ?? 'scheduled',
      ...(typeof r['is_active'] === 'boolean' ? { active: r['is_active'] as boolean } : {}),
      ...(et === 'local' || et === 'cloud_runner' ? { executionTarget: et } : {}),
      ...(agent ? { agent } : {}),
      ...(browser ? { browser } : {}),
      ...(r['next_run_at'] != null ? { nextRunAt: String(r['next_run_at']) } : {}),
      ...(r['scheduled_for'] != null ? { scheduledFor: String(r['scheduled_for']) } : {}),
      ...(tz ? { timezone: tz } : {}),
      ...(typeof r['update_version'] === 'number' ? { updateVersion: r['update_version'] as number } : {}),
    };
  }

  /** List the project's schedules for management (`GET /api/schedules`). */
  async listSchedules(): Promise<ScheduleInfo[]> {
    let res: { schedules?: Array<Record<string, unknown>>; data?: unknown };
    try {
      res = await this.http.getJson('/api/schedules');
    } catch (e) {
      throw unwrapApiError(e);
    }
    const rows = (res.schedules ?? (Array.isArray(res.data) ? res.data : [])) as Array<Record<string, unknown>>;
    return rows.map((r) => this.toScheduleInfo(r));
  }

  /** Fetch one raw schedule row (via the list) — needed for its update_version before an edit. */
  private async fetchScheduleRaw(scheduleId: string): Promise<Record<string, unknown>> {
    let res: { schedules?: Array<Record<string, unknown>> };
    try {
      res = await this.http.getJson('/api/schedules');
    } catch (e) {
      throw unwrapApiError(e);
    }
    const found = (res.schedules ?? []).find((r) => String(r['_id']) === scheduleId);
    if (!found) throw new Error(`Schedule ${scheduleId} was not found in this project.`);
    return found;
  }

  /** Edit a schedule (`PUT /api/schedules/:id`). Reads the current update_version itself (optimistic
   *  concurrency) so the caller passes only what changes. Re-pins via mode+agentId (local → also sets
   *  execution_mode:'manual') or mode+cloudRunnerCredentialId (cloud), mirroring createSchedule. */
  async updateSchedule(scheduleId: string, changes: ScheduleUpdate): Promise<ScheduleRef> {
    if (changes.scheduleType === 'every_5_minutes') {
      throw new Error('Walnut schedules do not support "Every 5 Minutes" — pick once, hourly, daily, weekdays, weekly or monthly.');
    }
    const current = await this.fetchScheduleRaw(scheduleId);
    const uv = current['update_version'];
    const body: Record<string, unknown> = {
      update_version: typeof uv === 'number' ? uv : 0,
      ...(changes.scheduledFor ? { scheduled_for: changes.scheduledFor } : {}),
      ...(changes.scheduleType ? { schedule_type: changes.scheduleType } : {}),
      ...(changes.endDate ? { end_date: changes.endDate } : {}),
      ...(changes.timezone ? { timezone: changes.timezone } : {}),
      ...(changes.browser ? { browser: changes.browser } : {}),
      ...(changes.environmentId && /^[0-9a-f]{24}$/i.test(changes.environmentId) ? { environment_id: changes.environmentId } : {}),
    };
    if (changes.mode === 'local' && changes.agentId) {
      body['execution_target'] = 'local';
      body['execution_mode'] = 'manual';
      body['assigned_agent_credential_id'] = changes.agentId;
    } else if (changes.mode === 'cloud' && changes.cloudRunnerCredentialId) {
      body['execution_target'] = 'cloud_runner';
      body['assigned_agent_credential_id'] = changes.cloudRunnerCredentialId;
    }
    let res: { data?: Record<string, unknown> } & Record<string, unknown>;
    try {
      res = await this.http.putJson(`/api/schedules/${scheduleId}`, body);
    } catch (e) {
      throw unwrapApiError(e);
    }
    const doc = ((res?.data ?? res) ?? {}) as Record<string, unknown>;
    return {
      id: doc['_id'] != null ? String(doc['_id']) : scheduleId,
      ...(typeof doc['status'] === 'string' ? { status: doc['status'] } : {}),
      ...(doc['next_run_at'] != null ? { nextRunAt: String(doc['next_run_at']) } : {}),
    };
  }

  /** Pause / resume / cancel a schedule. pause→`POST /:id/pause`, resume→`POST /:id/resume`,
   *  cancel→`PATCH /:id/cancel` (all bodyless). */
  async controlSchedule(scheduleId: string, action: ScheduleAction): Promise<ScheduleRef> {
    try {
      const res: { data?: Record<string, unknown> } & Record<string, unknown> =
        action === 'cancel'
          ? await this.http.patchJson(`/api/schedules/${scheduleId}/cancel`, {})
          : await this.http.postJson(`/api/schedules/${scheduleId}/${action}`, {});
      const doc = ((res?.data ?? res) ?? {}) as Record<string, unknown>;
      return {
        id: doc['_id'] != null ? String(doc['_id']) : scheduleId,
        ...(typeof doc['status'] === 'string' ? { status: doc['status'] } : {}),
        ...(doc['next_run_at'] != null ? { nextRunAt: String(doc['next_run_at']) } : {}),
      };
    } catch (e) {
      throw unwrapApiError(e);
    }
  }

  /** Delete a schedule permanently (`DELETE /api/schedules/:id`; the backend also tears down any live run). */
  async deleteSchedule(scheduleId: string): Promise<void> {
    try {
      await this.http.del(`/api/schedules/${scheduleId}`);
    } catch (e) {
      throw unwrapApiError(e);
    }
  }

  /** Neutral status of a run (`GET /api/executions/:id`, id = Mongo `_id`). Progress is derived from
   *  the per-status step counters; a UI deep link stands in for a report URL. */
  async getRun(runId: string): Promise<RunStatus> {
    if (/^SR_/i.test(runId)) return this.getSuiteRun(runId);
    const doc = await this.http.getJson<Record<string, unknown>>(`/api/executions/${runId}`);
    const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
    const done = num(doc['passed_steps']) + num(doc['failed_steps']) + num(doc['skipped_steps']) + num(doc['blocked_steps']);
    const total = num(doc['total_steps']);
    return {
      runId,
      state: mapRunState(doc['status']),
      ...(total > 0 ? { progress: { done, total } } : {}),
      reportUrl: this.productUrlFor({ kind: 'run', id: runId }),
    };
  }

  /** Neutral status of a SUITE run (`GET /api/executions/suite/:suiteRunId/summary`). `progress`
   *  counts TEST CASES (not steps); `children` is the per-testcase rollup. A 404 right after reserve
   *  (child execution docs not materialized yet) reads as 'queued', not an error. No reportUrl: the
   *  `/reports/:id` deep link is keyed by a single execution's Mongo id, not a suite-run `SR_` id. */
  private async getSuiteRun(suiteRunId: string): Promise<RunStatus> {
    let doc: {
      suite?: { status?: unknown };
      totals?: Record<string, unknown>;
      testcases?: Array<Record<string, unknown>>;
    };
    try {
      doc = await this.http.getJson(`/api/executions/suite/${suiteRunId}/summary`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return { runId: suiteRunId, state: 'queued' };
      throw unwrapApiError(e);
    }
    const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
    const t = doc.totals ?? {};
    const total = num(t['total']);
    const done = num(t['passed']) + num(t['failed']) + num(t['skipped']) + num(t['blocked']) + num(t['terminated']);
    const children = (doc.testcases ?? []).map((row) => ({
      id: String(row['testcase_identifier'] ?? row['testcase_id'] ?? ''),
      ...(typeof row['testcase_title'] === 'string' ? { title: row['testcase_title'] } : {}),
      state: mapRunState(row['status']),
    }));
    return {
      runId: suiteRunId,
      state: mapSuiteRunState(doc.suite?.status),
      ...(total > 0 ? { progress: { done, total } } : {}),
      ...(children.length ? { children } : {}),
    };
  }

  /** Signal a running execution to stop. Suite runs (`SR_...`) stop via the suite endpoint
   *  (`POST /api/executions/suite/:id/stop`); single executions via `POST /api/executions/:id/stop`.
   *  No body either way. */
  async stopRun(runId: string): Promise<void> {
    const path = /^SR_/i.test(runId)
      ? `/api/executions/suite/${runId}/stop`
      : `/api/executions/${runId}/stop`;
    try {
      await this.http.postJson(path, {});
    } catch (e) {
      throw unwrapApiError(e);
    }
  }

  /** Cloud runner VMs registered to the project + live online status
   *  (`GET /api/compute-configs/runners?live=1`). `online` already folds status online|busy. */
  async listCloudRunners(): Promise<CloudRunner[]> {
    const res = await this.http.getJson<{ runners?: Array<Record<string, unknown>> }>(
      '/api/compute-configs/runners?live=1',
    );
    return (res.runners ?? []).map((r) => ({
      id: String(r['id'] ?? ''),
      name: String(r['name'] ?? ''),
      online: r['online'] === true,
      ...(typeof r['status'] === 'string' ? { status: r['status'] } : {}),
      ...(typeof r['host'] === 'string' ? { os: r['host'] } : {}),
      // The linked test_runner_vm agent credential — what a SCHEDULE pins as
      // assigned_agent_credential_id (a different id-space from `id` = compute_configs._id).
      ...(typeof r['credential_id'] === 'string' && r['credential_id'] ? { credentialId: r['credential_id'] } : {}),
    }));
  }

  /**
   * LOCAL agents registered to the project + live online status
   * (`GET /api/agent-credentials/project-agents`) — the same live roster resolveLocalAgentCredential
   * reads, exposed so a client can list + pick an agent (`id` = credential_id) before a LOCAL run.
   * A shared project lists EVERY member's agent; `owner`/`online` let the user pick the right one.
   */
  async listLocalAgents(): Promise<LocalAgent[]> {
    const res = await this.http.getJson<{
      agents?: Array<{ credential_id?: string; is_online?: boolean; agent_status?: string;
                       owner_name?: string; host_name?: string }>;
    }>('/api/agent-credentials/project-agents');
    return (res.agents ?? [])
      .filter((a) => a.credential_id)
      .map((a) => {
        const name = a.owner_name || a.host_name;
        return {
          id: String(a.credential_id),
          online: a.is_online === true,
          ...(name ? { name } : {}),
          // Machine hostname — kept ALONGSIDE the owner so the UI/list can disambiguate several
          // agents owned by the same person (e.g. two "rishi" agents on different machines).
          ...(a.host_name ? { host: a.host_name } : {}),
          ...(typeof a.agent_status === 'string' ? { status: a.agent_status } : {}),
          ...(a.owner_name ? { owner: a.owner_name } : {}),
        };
      });
  }

  /**
   * Valid action vocabulary per technology. android/api/database/mainframe always
   * come from the static `WALNUT_ACTIONS` (there is no live/per-org source for
   * them); `web` is replaced by the live per-org `GET /api/actions` catalog when
   * that call succeeds and returns at least one action, else falls back to the
   * static list. No retry, no caching.
   */
  async actionsCatalog(platform?: string): Promise<ActionDef[]> {
    const catalog: Record<WalnutPlatform, string[]> = { ...WALNUT_ACTIONS };
    try {
      const res = await this.http.getJson<WalnutActionsResponse>('/api/actions');
      const live = (res.actions ?? [])
        .map((a) => a.action_type ?? a.name)
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
      if (live.length) catalog.web = live;
    } catch {
      // GET /api/actions unavailable (network error, 404, 500, ...) -- keep the
      // static WALNUT_ACTIONS.web fallback.
    }
    const all = actionDefsFrom(catalog);
    return platform ? all.filter((a) => a.platform === platform) : all;
  }

  // --- Agent-bound recording surface (composite delegation) -----------------
  // Recording (+ save-with-editor) is the ONLY surface that needs a local runtime, so it is NOT done
  // over direct REST: it hops to the LOCAL AGENT's /mcp (cfg.url) via an internal RemoteMcpAdapter.
  // The recording passthrough (tools/recording.tools.ts) drives it through `listAgentTools`/`callRaw`,
  // and tc_automate (tools/testcase.tools.ts) calls `callRaw('web'/'web_status')`. When no agent /mcp
  // is configured (a cloud editor), recording is gracefully unavailable.

  /** The internal hop to the local agent's /mcp, built lazily and ONLY when cfg.url is set. */
  private hop(): RemoteMcpAdapter | null {
    if (!this.cfg.url) return null;
    if (!this.agentHop) this.agentHop = new RemoteMcpAdapter(this.cfg);
    return this.agentHop;
  }

  /** The local agent's advertised tools (web/mainframe/…), mirrored so the recording passthrough can
   *  register them. No agent configured (cloud editor) → `[]`, so no recording tools get registered
   *  and recording is gracefully unavailable. */
  async listAgentTools(): Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>> {
    const hop = this.hop();
    return hop ? hop.listAgentTools() : [];
  }

  /** Forward an agent-bound tool call (recording) to the local agent's /mcp. Without a configured
   *  agent /mcp (cloud editor) there is nothing to forward to, so this fails with a clear instruction. */
  async callRaw(name: string, args: Record<string, unknown>): Promise<unknown> {
    const hop = this.hop();
    if (!hop) {
      throw new Error(
        "Recording needs a local Walnut agent — set QA_MCP_URL to the agent's /mcp endpoint.",
      );
    }
    return hop.callRaw(name, args);
  }

  // Recording JOURNAL (read/edit) is agent-bound too — it derives from a local recording seed the
  // agent owns (backend journal persistence is the deferred Item 3b). So journal_grep/journal_modify
  // DELEGATE to the local agent's /mcp, exactly like recording. No agent (a cloud editor) → a clear
  // "needs a local agent" error. The methods are always PRESENT so discovery.tools' `!adapter.readJournal`
  // guard doesn't short-circuit to "no journal" on the direct path — the requirement is the hop, not absence.
  async readJournal(tcId: string): Promise<JournalView> {
    const hop = this.hop();
    if (!hop) throw new Error("Reading a test case's recording journal needs a local product agent — set QA_MCP_URL to the agent's /mcp endpoint.");
    return hop.readJournal(tcId);
  }

  async editJournal(tcId: string, ops: JournalOp[]): Promise<JournalView> {
    const hop = this.hop();
    if (!hop) throw new Error("Editing a test case's recording journal (journal_modify) needs a local product agent — set QA_MCP_URL to the agent's /mcp endpoint.");
    return hop.editJournal(tcId, ops);
  }

  /** Deep link into the product UI (e.g. `/test-cases/:id`, `/reports/:id`). These routes are served
   *  by walnut-frontend, NOT the API host, so this must use the FRONTEND origin. */
  productUrlFor(entity: EntityRef): string {
    return `${this.resolveUiOrigin()}/${PRODUCT_URL_SEGMENT[entity.kind]}/${entity.id}`;
  }

  /** Frontend origin for deep links, resolved (and trailing-slash-trimmed) as:
   *   1. `walnutUiOrigin` (env `QA_MCP_WALNUT_UI`) -- the explicit override; point it at the local
   *      frontend dev server now, and the deployed frontend once shipped.
   *   2. else the BACKEND base (`cfg.baseUrl` / `QA_BASE_URL`) with a trailing `/api` stripped --
   *      correct for a single-host deploy (https://app.walnutai.ai/api -> https://app.walnutai.ai), so
   *      production Just Works with no override. A split local dev host (backend :8080, Vite :5173)
   *      can't be derived, so it needs (1). NOTE: derived from `baseUrl`, NOT `cfg.url` — `cfg.url` is
   *      now the agent /mcp endpoint, not a web origin. */
  private resolveUiOrigin(): string {
    const strip = (s: string): string => s.replace(/\/+$/, '');
    const override = this.cfg.walnutUiOrigin?.trim();
    if (override) return strip(override);
    return strip(this.cfg.baseUrl ?? '').replace(/\/api$/, '');
  }
}
