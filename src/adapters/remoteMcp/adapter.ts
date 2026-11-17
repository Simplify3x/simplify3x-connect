import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ConnectedQaConfig } from '../../config.js';
import { VERSION } from '../../version.js';
import type { ProjectInfo, ProviderAdapter } from '../types.js';
import type {
  ActionDef, CloudRunner, DatasetInfo, DefaultIteration, EntityRef, EnvInfo, JournalOp, JournalView, Locator, MemberOp, ModuleSummary, ObjectQuery, ProjectSummary, QaObject,
  ReleaseQuery, ReleaseSummary, RunOptions, RunRef, RunStatus, RunTarget, SaveGeneratedIterations, SaveGeneratedIterationsResult, SavedRef, SprintQuery, SprintSummary, Story, StoryQuery, StorySummary,
  Suite, SuiteSummary, TcQuery, TcSummary, TestCase,
} from '../../domain/types.js';

/**
 * RemoteMcpAdapter -- the generic "forward to a product MCP" driver of the Common QA MCP.
 *
 * BOTH products are reached the same way: a thin MCP CLIENT holds a connection to the product's
 * agent MCP (`cfg.url` = that product's `/mcp` endpoint) and fulfils each neutral ProviderAdapter
 * method by calling the correspondingly-named PROVIDER-OP tool on it (info -> `info`, listTestCases
 * -> `list_testcases`, ...), reading the neutral payload out of `structuredContent[<key>]`. This is
 * the provider-op contract in docs/sqa-agent-mcp-integration-guide.md -- the SAME for the Walnut MCP
 * and the product MCP, so the Common MCP forwards to both identically.
 *
 * The bearer token (+ x-project-id) is forwarded to the product MCP on every request. The client
 * connects lazily on first use (and re-arms on failure), so constructing the adapter is cheap.
 */
export type RemoteTransportFactory = () => Transport;

function firstText(res: unknown): string {
  const content = (res as { content?: Array<{ type?: string; text?: string }> }).content;
  return content?.find((c) => c?.type === 'text')?.text ?? '';
}

/**
 * True when a call failed because the product MCP's SESSION is gone -- almost always because that
 * process was restarted (e.g. an agent rebuild), which invalidates the session id our cached client
 * holds. The Streamable-HTTP transport surfaces this as a -32001 "Session not found" while POSTing.
 * We treat it as "reconnect and retry once", NOT a real failure.
 */
function isStaleSession(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /session not found|-32001/i.test(msg);
}

export class RemoteMcpAdapter implements ProviderAdapter {
  private clientPromise: Promise<Client> | null = null;

  constructor(
    private readonly cfg: ConnectedQaConfig,
    /** Test seam: inject a pre-linked in-memory transport instead of a real HTTP one. */
    private readonly transportFactory?: RemoteTransportFactory,
  ) {}

  // Bearer token forwarded unchanged to the product MCP; x-project-id only when we have one (a key is
  // project-scoped server-side, so it may be absent). Mirrors the guide's auth section.
  private headers(): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.cfg.token}` };
    if (this.cfg.projectId) h['x-project-id'] = this.cfg.projectId;
    // Explicit product base URL (from `qa_connect({baseUrl})` or `QA_BASE_URL` env). Forwarded to
    // the product MCP (Walnut or SimplifyQA) so its backend REST calls have a base — lets tokens
    // without a JWT `url` claim still work. The product MCP prefers this header over the claim.
    if (this.cfg.baseUrl) h['x-qa-base-url'] = this.cfg.baseUrl;
    return h;
  }

  private async client(): Promise<Client> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const client = new Client({ name: 'simplify3x-connect', version: VERSION });
        // The `as Transport` cast bridges exactOptionalPropertyTypes: StreamableHTTPClientTransport
        // implements Transport, but the SDK's own .d.ts (built without EOPT) leaves its optional
        // callbacks (onclose?/onerror?/onmessage?) without `| undefined`, which this project's EOPT
        // rejects on assignment. The class genuinely satisfies the interface at runtime.
        // `cfg.url` (the product /mcp endpoint) is optional on the shared config type now, but the
        // factory only ever builds a RemoteMcpAdapter with it present (SimplifyQA, the legacy walnut
        // forwarder, or WalnutAdapter's recording hop) -- so `?? ''` only satisfies the type.
        const transport = this.transportFactory
          ? this.transportFactory()
          : (new StreamableHTTPClientTransport(new URL(this.cfg.url ?? ''), { requestInit: { headers: this.headers() } }) as Transport);
        await client.connect(transport);
        return client;
      })().catch((e) => {
        // Re-arm so the next call retries instead of reusing a rejected promise forever.
        this.clientPromise = null;
        throw e instanceof Error
          ? new Error(`Could not reach the product MCP at ${this.cfg.url}: ${e.message}`)
          : e;
      });
    }
    return this.clientPromise;
  }

  /**
   * callTool with transparent ONE-shot reconnect on a stale session. If the product MCP was
   * restarted, our cached client holds a dead session id and the first call throws "Session not
   * found"; we drop the client so `client()` re-connects fresh, then retry exactly once. Any other
   * error (or a second failure) propagates. Without this, every call after a product restart failed
   * until THIS process was restarted too.
   */
  private async callTool(name: string, args: Record<string, unknown>) {
    try {
      return await (await this.client()).callTool({ name, arguments: args });
    } catch (e) {
      if (!isStaleSession(e)) throw e;
      this.clientPromise = null; // discard the dead session; client() mints a new one
      return await (await this.client()).callTool({ name, arguments: args });
    }
  }

  /** Project-scoped provider-ops need a selected project. `list_projects` is the ONE exception (it
   *  lists ACROSS projects, so it must work with none selected). Guarding here turns an opaque backend
   *  400 ("Project ID and User ID are required") into a clear instruction so the AI client asks the
   *  user to pick a project first. */
  private assertProject(op: string): void {
    if (!this.cfg.projectId && op !== 'list_projects') {
      throw new Error(
        'No project selected. Call list_projects to see the available projects, then ' +
          'qa_switch_project({ projectId }) to choose one — test cases, runs and objects are all ' +
          'scoped to a project.',
      );
    }
  }

  /** Call a remote provider-op tool and pull the neutral payload from structuredContent[key]. */
  private async call<T>(name: string, args: Record<string, unknown>, key: string): Promise<T> {
    this.assertProject(name);
    const res = await this.callTool(name, args);
    if ((res as { isError?: boolean }).isError) {
      throw new Error(firstText(res) || `product MCP tool "${name}" returned an error.`);
    }
    const sc = (res as { structuredContent?: Record<string, unknown> }).structuredContent;
    if (!sc || !(key in sc)) {
      throw new Error(`product MCP tool "${name}" did not return structuredContent.${key}.`);
    }
    return sc[key] as T;
  }

  /** For void ops (delete/stop): only surface an error, ignore any payload. */
  private async callVoid(name: string, args: Record<string, unknown>): Promise<void> {
    this.assertProject(name);
    const res = await this.callTool(name, args);
    if ((res as { isError?: boolean }).isError) {
      throw new Error(firstText(res) || `product MCP tool "${name}" returned an error.`);
    }
  }

  async info(): Promise<ProjectInfo> {
    return this.call<ProjectInfo>('info', {}, 'info');
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return this.call<ProjectSummary[]>('list_projects', {}, 'projects');
  }

  async listTestCases(q: TcQuery): Promise<TcSummary[]> {
    return this.call<TcSummary[]>('list_testcases', q as unknown as Record<string, unknown>, 'testCases');
  }

  async getTestCase(id: string, versionId?: string): Promise<TestCase> {
    return this.call<TestCase>('get_testcase', { id, ...(versionId !== undefined ? { versionId } : {}) }, 'tc');
  }

  async createTestCase(tc: TestCase): Promise<SavedRef> {
    return this.call<SavedRef>('create_testcase', { tc }, 'saved');
  }

  async updateTestCase(id: string, tc: TestCase): Promise<SavedRef> {
    return this.call<SavedRef>('update_testcase', { id, tc }, 'saved');
  }

  async deleteTestCase(id: string): Promise<void> {
    await this.callVoid('delete_testcase', { id });
  }

  async cloneTestCase(
    id: string,
    title: string,
    opts: { tdCopy: boolean; sourceVersionId?: string },
  ): Promise<SavedRef> {
    return this.call<SavedRef>('clone_testcase', {
      id,
      title,
      tdCopy: opts.tdCopy,
      ...(opts.sourceVersionId !== undefined ? { sourceVersionId: opts.sourceVersionId } : {}),
    }, 'saved');
  }

  async searchObjects(q: ObjectQuery): Promise<QaObject[]> {
    return this.call<QaObject[]>('search_objects', q as unknown as Record<string, unknown>, 'objects');
  }

  async createObject(o: QaObject): Promise<QaObject> {
    return this.call<QaObject>('create_object', { object: o }, 'object');
  }

  async actionsCatalog(platform?: string): Promise<ActionDef[]> {
    return this.call<ActionDef[]>('actions_catalog', platform !== undefined ? { platform } : {}, 'actions');
  }

  async listSuites(): Promise<SuiteSummary[]> {
    return this.call<SuiteSummary[]>('list_suites', {}, 'suites');
  }

  async getSuite(id: string): Promise<Suite> {
    return this.call<Suite>('get_suite', { id }, 'suite');
  }

  async listStories(q: StoryQuery): Promise<StorySummary[]> {
    return this.call<StorySummary[]>('list_stories', q as unknown as Record<string, unknown>, 'stories');
  }

  async getStory(id: string): Promise<Story> {
    return this.call<Story>('get_story', { id }, 'story');
  }

  async listModules(): Promise<ModuleSummary[]> {
    return this.call<ModuleSummary[]>('list_modules', {}, 'modules');
  }

  async listReleases(q: ReleaseQuery): Promise<ReleaseSummary[]> {
    return this.call<ReleaseSummary[]>('list_releases', { scope: q.scope }, 'releases');
  }

  async listSprints(q: SprintQuery): Promise<SprintSummary[]> {
    return this.call<SprintSummary[]>('list_sprints', q.releaseId !== undefined ? { releaseId: q.releaseId } : {}, 'sprints');
  }

  async readJournal(tcId: string): Promise<JournalView> {
    return this.call<JournalView>('read_journal', { id: tcId }, 'view');
  }

  async editJournal(tcId: string, ops: JournalOp[]): Promise<JournalView> {
    return this.call<JournalView>('edit_journal', { id: tcId, ops }, 'view');
  }

  async createSuite(s: Suite): Promise<SavedRef> {
    return this.call<SavedRef>('create_suite', { suite: s }, 'saved');
  }

  async updateSuiteMembers(id: string, ops: MemberOp[]): Promise<Suite> {
    return this.call<Suite>('update_suite_members', { id, ops }, 'suite');
  }

  async deleteSuite(id: string): Promise<void> {
    await this.callVoid('delete_suite', { id });
  }

  // Execution forwards to the product MCP's own run ops (start_run / get_run / stop_run). For
  // SimplifyQA those are agent MCP tools; the gateway stays product-neutral and just relays.
  async startRun(target: RunTarget, opts: RunOptions): Promise<RunRef> {
    return this.call<RunRef>('start_run', { target, options: opts }, 'run');
  }

  async getRun(runId: string): Promise<RunStatus> {
    return this.call<RunStatus>('get_run', { runId }, 'run');
  }

  async stopRun(runId: string): Promise<void> {
    await this.callVoid('stop_run', { runId });
  }

  async listCloudRunners(): Promise<CloudRunner[]> {
    return this.call<CloudRunner[]>('list_cloud_runners', {}, 'runners');
  }

  /**
   * Raw passthrough: forward a tool call to the product MCP verbatim and return its CallToolResult.
   * For AGENT-BOUND tools (recording/browser) the Common MCP proxies rather than wraps -- it cannot
   * implement them (they need the product's real browser), so it relays the call and the result.
   * Stale-session resilient via `callTool`.
   */
  async callRaw(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return (await this.callTool(name, args)) as CallToolResult;
  }

  /** The product MCP's advertised tools (name + description + inputSchema), for building passthrough
   *  proxies of its agent-bound surface. The inputSchema is mirrored so the client's model knows each
   *  tool's real parameters (ref/object_name/expected/value/…) instead of guessing against a
   *  permissive schema. */
  async listAgentTools(): Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>> {
    const client = await this.client();
    const res = await client.listTools();
    return res.tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      ...(t.inputSchema ? { inputSchema: t.inputSchema as Record<string, unknown> } : {}),
    }));
  }

  async listEnvironments(): Promise<EnvInfo[]> {
    return this.call<EnvInfo[]>('list_environments', {}, 'environments');
  }

  async listDatasets(tcId?: string): Promise<DatasetInfo[]> {
    return this.call<DatasetInfo[]>('list_datasets', tcId !== undefined ? { tcId } : {}, 'datasets');
  }

  async getDefaultIteration(q: { tcId: string; versionId?: string; environmentType?: string }): Promise<DefaultIteration> {
    const args: Record<string, unknown> = { tcId: q.tcId };
    if (q.versionId !== undefined) args['versionId'] = q.versionId;
    if (q.environmentType !== undefined) args['environmentType'] = q.environmentType;
    return this.call<DefaultIteration>('get_default_iteration', args, 'iteration');
  }

  async saveGeneratedIterations(payload: SaveGeneratedIterations): Promise<SaveGeneratedIterationsResult> {
    return this.call<SaveGeneratedIterationsResult>('save_generated_iterations', payload as unknown as Record<string, unknown>, 'result');
  }

  async getObject(id: string): Promise<QaObject> {
    return this.call<QaObject>('get_object', { id }, 'object');
  }

  async deleteObject(id: string): Promise<void> {
    await this.callVoid('delete_object', { id });
  }

  async updateObject(id: string, changes: {
    name?: string;
    locators?: Locator[];
    description?: string;
    parameterNames?: string[];
    moduleName?: string;
  }): Promise<QaObject> {
    return this.call<QaObject>('update_object', { id, ...changes }, 'object');
  }

  // Deep link into the SimplifyQA UI. The AUTHORITATIVE link comes from SavedRef.productUrl (returned
  // by create/update); this synchronous fallback is best-effort off the MCP endpoint origin -- it
  // cannot round-trip to the remote, so callers should prefer SavedRef.productUrl when they have it.
  productUrlFor(entity: EntityRef): string {
    const base = (this.cfg.url ?? '').replace(/\/+$/, '').replace(/\/mcp$/i, '');
    return `${base}/${entity.kind}/${entity.id}`;
  }
}
