import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ConnectedQaConfig } from '../../config.js';
import { RemoteMcpAdapter } from './adapter.js';

type ToolImpl = (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;

/** Partial config that also accepts explicit `undefined` (exactOptionalPropertyTypes-friendly). */
type AdapterCfg = { [K in keyof ConnectedQaConfig]?: ConnectedQaConfig[K] | undefined };

/** A successful provider-op result: the neutral payload under `key` in structuredContent. */
function ok(key: string, value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: key }],
    structuredContent: { [key]: value },
  };
}

const TEXTLESS_OK: CallToolResult = { content: [{ type: 'text', text: 'done' }] };

/**
 * A real MCP server (not a stub) exposing the provider-op tools the adapter calls, wired to the
 * adapter through an in-memory transport pair. Every tool invocation is recorded so the tests can
 * assert what the adapter actually forwarded.
 */
class FakeProductMcp {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  private readonly servers: McpServer[] = [];

  constructor(private readonly tools: Record<string, ToolImpl>) {}

  /** A fresh transport for ONE adapter connection (a reconnect gets its own server instance). */
  transportFactory = (): Transport => {
    const server = new McpServer({ name: 'fake-product', version: '0.0.1' });
    for (const [name, impl] of Object.entries(this.tools)) {
      server.registerTool(
        name,
        { description: `${name} provider-op`, inputSchema: z.any() },
        async (args: unknown) => {
          const forwarded = (args ?? {}) as Record<string, unknown>;
          this.calls.push({ name, args: forwarded });
          return impl(forwarded);
        },
      );
    }
    // One tool deliberately advertised WITHOUT a description, to prove it is not invented.
    server.registerTool('undocumented_tool', { inputSchema: z.any() }, async () => TEXTLESS_OK);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    void server.connect(serverTransport);
    this.servers.push(server);
    return clientTransport as Transport;
  };

  async close(): Promise<void> {
    await Promise.all(this.servers.map((s) => s.close().catch(() => undefined)));
  }
}

function makeAdapter(mcp: FakeProductMcp, cfg: AdapterCfg = {}) {
  return new RemoteMcpAdapter(
    {
      mode: 'connected',
      url: 'https://product.test/mcp',
      token: 'tok-123',
      projectId: 'proj-9',
      baseUrl: 'https://product.test',
      walnutAuth: 'key',
      caps: new Set<string>(),
      ...cfg,
    } as ConnectedQaConfig,
    mcp.transportFactory,
  );
}

let mcp: FakeProductMcp | null = null;
afterEach(async () => {
  await mcp?.close();
  mcp = null;
});

describe('RemoteMcpAdapter connection lifecycle', () => {
  it('connects lazily, reuses one client, and returns the structuredContent payload', async () => {
    const server = new FakeProductMcp({ info: () => ok('info', { provider: 'walnut', projectId: 'p1', projectName: 'Shop' }) });
    mcp = server;
    let spawns = 0;
    const adapter = makeAdapter(server);
    const counting = new RemoteMcpAdapter(
      {
        mode: 'connected',
        url: 'https://product.test/mcp',
        token: 'tok-123',
        projectId: 'proj-9',
        walnutAuth: 'key',
        caps: new Set<string>(),
      } as ConnectedQaConfig,
      () => {
        spawns += 1;
        return server.transportFactory();
      },
    );

    // Constructing is cheap: nothing is connected until the first call.
    expect(spawns).toBe(0);

    await expect(adapter.info()).resolves.toEqual({ provider: 'walnut', projectId: 'p1', projectName: 'Shop' });
    await expect(counting.info()).resolves.toEqual({ provider: 'walnut', projectId: 'p1', projectName: 'Shop' });
    await expect(adapter.info()).resolves.toMatchObject({ projectId: 'p1' });

    // One connection served every call on the counting adapter.
    expect(spawns).toBe(1);
    expect(server.calls.filter((c) => c.name === 'info')).toHaveLength(3);
  });

  it('reconnects once on a -32001 stale session and retries the same call', async () => {
    const server = new FakeProductMcp({ info: () => ok('info', { provider: 'walnut', projectId: 'p1', projectName: 'Shop' }) });
    mcp = server;
    let spawns = 0;
    let staleInjected = false;

    /** First connection answers its first tool call with a "Session not found" JSON-RPC error. */
    const staleThenReal = (): Transport => {
      const transport = server.transportFactory();
      spawns += 1;
      if (spawns > 1) return transport;
      let onmessage: Transport['onmessage'];
      const wrapper = {
        async start() { await transport.start(); },
        async close() { await transport.close(); },
        async send(message, options) {
          const request = message as { id?: unknown; method?: string };
          if (request.method === 'tools/call' && !staleInjected) {
            staleInjected = true;
            const error = { jsonrpc: '2.0' as const, id: request.id, error: { code: -32001, message: 'Session not found' } };
            queueMicrotask(() => onmessage?.(error as never));
            return;
          }
          await transport.send(message, options);
        },
      } as Transport;
      // The client installs its own handler here; it is re-pointed at the injection above.
      Object.defineProperty(wrapper, 'onmessage', {
        get: () => onmessage,
        set: (fn: Transport['onmessage']) => { onmessage = fn; },
        configurable: true,
      });
      transport.onmessage = (message, extra) => onmessage?.(message, extra);
      return wrapper;
    };

    const adapter = new RemoteMcpAdapter(
      {
        mode: 'connected',
        url: 'https://product.test/mcp',
        token: 'tok-123',
        projectId: 'proj-9',
        walnutAuth: 'key',
        caps: new Set<string>(),
      } as ConnectedQaConfig,
      staleThenReal,
    );

    await expect(adapter.info()).resolves.toMatchObject({ projectName: 'Shop' });
    expect(staleInjected).toBe(true);
    // Two connections: the dead one, then the fresh one that actually answered.
    expect(spawns).toBe(2);
    expect(server.calls.filter((c) => c.name === 'info')).toHaveLength(1);
  });

  it('propagates any other failure without reconnecting', async () => {
    const authFailure = Object.assign(new Error('Unauthorized: bad token'), { code: -32000 });
    const failing: ToolImpl = () => { throw authFailure; };
    const server = new FakeProductMcp({ info: failing });
    mcp = server;
    let spawns = 0;
    const adapter = new RemoteMcpAdapter(
      {
        mode: 'connected',
        url: 'https://product.test/mcp',
        token: 'tok-123',
        projectId: 'proj-9',
        walnutAuth: 'key',
        caps: new Set<string>(),
      } as ConnectedQaConfig,
      () => {
        spawns += 1;
        return server.transportFactory();
      },
    );

    await expect(adapter.info()).rejects.toThrow(/Unauthorized: bad token/);
    expect(spawns).toBe(1);
  });
});

describe('RemoteMcpAdapter project guard and headers', () => {
  it('refuses project-scoped ops without a project, but still lists projects', async () => {
    const server = new FakeProductMcp({
      list_projects: () => ok('projects', [{ id: 'p1', name: 'Shop' }]),
      list_testcases: () => ok('testCases', []),
    });
    mcp = server;
    const adapter = makeAdapter(server, { projectId: undefined });

    await expect(adapter.listTestCases({})).rejects.toThrow(
      /No project selected\. Call list_projects[\s\S]*qa_switch_project/,
    );
    await expect(adapter.searchObjects({})).rejects.toThrow(/No project selected/);
    // The one exemption: listing projects must work before a project exists.
    await expect(adapter.listProjects()).resolves.toEqual([{ id: 'p1', name: 'Shop' }]);
    expect(server.calls.map((c) => c.name)).toEqual(['list_projects']);
  });

  it('forwards the bearer token, project and product base URL as headers', () => {
    const adapter = makeAdapter(new FakeProductMcp({}));
    const headers = (adapter as unknown as { headers(): Record<string, string> }).headers();
    expect(headers).toEqual({
      Authorization: 'Bearer tok-123',
      'x-project-id': 'proj-9',
      'x-qa-base-url': 'https://product.test',
    });

    // Project / base URL are optional: a bare connection sends the bearer token alone.
    const bare = makeAdapter(new FakeProductMcp({}), { projectId: undefined, baseUrl: undefined });
    expect((bare as unknown as { headers(): Record<string, string> }).headers()).toEqual({
      Authorization: 'Bearer tok-123',
    });
  });
});

describe('RemoteMcpAdapter result handling', () => {
  it('surfaces isError results and missing structuredContent as clear errors', async () => {
    const server = new FakeProductMcp({
      info: () => ({ content: [{ type: 'text', text: 'backend exploded' }], isError: true }),
      list_projects: () => ({ content: [], isError: true }),
      list_testcases: () => TEXTLESS_OK,
      get_testcase: () => ({ content: [{ type: 'text', text: 'wrong key' }], structuredContent: { other: 1 } }),
      delete_testcase: () => ({ content: [{ type: 'text', text: 'cannot delete a referenced test case' }], isError: true }),
    });
    mcp = server;
    const adapter = makeAdapter(server);

    await expect(adapter.info()).rejects.toThrow(/backend exploded/);
    await expect(adapter.listProjects()).rejects.toThrow(/product MCP tool "list_projects" returned an error\./);
    // Void ops surface an error too, they just have no payload to unwrap.
    await expect(adapter.deleteTestCase('TC_1')).rejects.toThrow(/cannot delete a referenced test case/);
    await expect(adapter.listTestCases({})).rejects.toThrow(
      /product MCP tool "list_testcases" did not return structuredContent\.testCases\./,
    );
    await expect(adapter.getTestCase('TC_1')).rejects.toThrow(
      /product MCP tool "get_testcase" did not return structuredContent\.tc\./,
    );
  });

  it('passes callRaw through verbatim and mirrors the agent tool catalog', async () => {
    const raw: CallToolResult = { content: [{ type: 'text', text: 'Recorded step 1' }] };
    const server = new FakeProductMcp({ web: () => raw, web_status: () => ok('status', 'done') });
    mcp = server;
    const adapter = makeAdapter(server);

    const result = await adapter.callRaw('web', { task: 'Sign in', url: 'https://app.test' });
    // Relayed verbatim: same content, no structuredContent re-shaping.
    expect(result).toEqual(raw);
    expect(server.calls[0]).toEqual({ name: 'web', args: { task: 'Sign in', url: 'https://app.test' } });

    const tools = await adapter.listAgentTools();
    const web = tools.find((t) => t.name === 'web')!;
    expect(web.description).toBe('web provider-op');
    expect(web.inputSchema).toBeDefined();
    expect(tools.map((t) => t.name).sort()).toEqual(['undocumented_tool', 'web', 'web_status']);
    // A tool advertised without a description does not get an invented one.
    expect(tools.find((t) => t.name === 'undocumented_tool')).toEqual({ name: 'undocumented_tool', inputSchema: expect.anything() });
  });
});

describe('RemoteMcpAdapter provider-op argument mapping', () => {
  it('forwards each neutral call to the matching provider-op tool with its arguments', async () => {
    const server = new FakeProductMcp({
      get_testcase: () => ok('tc', { id: 'TC_1', title: 'Login', category: 'manual', steps: [] }),
      create_testcase: () => ok('saved', { id: 'TC_2', created: true }),
      update_testcase: () => ok('saved', { id: 'TC_1', created: false }),
      delete_testcase: () => TEXTLESS_OK,
      actions_catalog: () => ok('actions', []),
      read_journal: () => ok('view', { tcId: 'TC_1', source: 'journal', steps: [] }),
      edit_journal: () => ok('view', { tcId: 'TC_1', source: 'journal', steps: [] }),
      start_run: () => ok('run', { runId: 'exec-1' }),
      get_run: () => ok('run', { runId: 'exec-1', state: 'passed' }),
      stop_run: () => TEXTLESS_OK,
      list_environments: () => ok('environments', [{ id: 'env-1', name: 'QA' }]),
      get_default_iteration: () => ok('iteration', { tcId: 'TC_1' }),
      update_object: () => ok('object', { id: 'obj-1', name: 'Button', locators: [] }),
      list_projects: () => ok('projects', []),
      list_suites: () => ok('suites', []),
      get_suite: () => ok('suite', { id: 'su-1', name: 'Smoke', members: [] }),
      list_stories: () => ok('stories', []),
      get_story: () => ok('story', { id: 'st-1', title: 'Story' }),
      list_modules: () => ok('modules', []),
      list_releases: () => ok('releases', []),
      list_sprints: () => ok('sprints', []),
      create_suite: () => ok('saved', { id: 'su-2', created: true }),
      update_suite_members: () => ok('suite', { id: 'su-1', name: 'Smoke', members: [] }),
      delete_suite: () => TEXTLESS_OK,
      list_cloud_runners: () => ok('runners', []),
      clone_testcase: () => ok('saved', { id: 'TC_3', created: true }),
      search_objects: () => ok('objects', []),
      create_object: () => ok('object', { id: 'obj-9', name: 'Btn', locators: [] }),
      get_object: () => ok('object', { id: 'obj-1', name: 'Button', locators: [] }),
      delete_object: () => TEXTLESS_OK,
      list_datasets: () => ok('datasets', []),
      save_generated_iterations: () => ok('result', { saved: 1 }),
    });
    mcp = server;
    const adapter = makeAdapter(server);

    const tc = { title: 'Login', category: 'manual' as const, steps: [] };
    await expect(adapter.getTestCase('TC_1', 'v2')).resolves.toMatchObject({ id: 'TC_1' });
    await expect(adapter.createTestCase(tc)).resolves.toEqual({ id: 'TC_2', created: true });
    await expect(adapter.updateTestCase('TC_1', tc)).resolves.toEqual({ id: 'TC_1', created: false });
    await expect(adapter.deleteTestCase('TC_1')).resolves.toBeUndefined();
    await expect(adapter.actionsCatalog()).resolves.toEqual([]);
    await adapter.actionsCatalog('web');
    await expect(adapter.readJournal('TC_1')).resolves.toMatchObject({ source: 'journal' });
    const ops = [{ op: 'remove_step' as const, n: 2 }];
    await adapter.editJournal('TC_1', ops);
    await expect(adapter.startRun({ tcId: 'TC_1' }, { mode: 'cloud' })).resolves.toEqual({ runId: 'exec-1' });
    await expect(adapter.getRun('exec-1')).resolves.toMatchObject({ state: 'passed' });
    await expect(adapter.stopRun('exec-1')).resolves.toBeUndefined();
    await expect(adapter.listEnvironments()).resolves.toEqual([{ id: 'env-1', name: 'QA' }]);
    await expect(adapter.getDefaultIteration({ tcId: 'TC_1' })).resolves.toEqual({ tcId: 'TC_1' });
    await expect(adapter.updateObject('obj-1', { name: 'Button' })).resolves.toMatchObject({ id: 'obj-1' });

    expect(server.calls).toEqual([
      { name: 'get_testcase', args: { id: 'TC_1', versionId: 'v2' } },
      { name: 'create_testcase', args: { tc } },
      { name: 'update_testcase', args: { id: 'TC_1', tc } },
      { name: 'delete_testcase', args: { id: 'TC_1' } },
      // No platform → no platform argument at all; a platform is forwarded when given.
      { name: 'actions_catalog', args: {} },
      { name: 'actions_catalog', args: { platform: 'web' } },
      { name: 'read_journal', args: { id: 'TC_1' } },
      { name: 'edit_journal', args: { id: 'TC_1', ops } },
      { name: 'start_run', args: { target: { tcId: 'TC_1' }, options: { mode: 'cloud' } } },
      { name: 'get_run', args: { runId: 'exec-1' } },
      { name: 'stop_run', args: { runId: 'exec-1' } },
      { name: 'list_environments', args: {} },
      { name: 'get_default_iteration', args: { tcId: 'TC_1' } },
      { name: 'update_object', args: { id: 'obj-1', name: 'Button' } },
    ]);

    // Every remaining forward: a table of (provider-op, neutral call, expected arguments).
    const remaining: Array<{ name: string; args: Record<string, unknown>; run: () => Promise<unknown> }> = [
      { name: 'list_projects', args: {}, run: () => adapter.listProjects() },
      { name: 'list_suites', args: {}, run: () => adapter.listSuites() },
      { name: 'get_suite', args: { id: 'su-1' }, run: () => adapter.getSuite('su-1') },
      { name: 'list_stories', args: { search: 'login' }, run: () => adapter.listStories({ search: 'login' }) },
      { name: 'get_story', args: { id: 'st-1' }, run: () => adapter.getStory('st-1') },
      { name: 'list_modules', args: {}, run: () => adapter.listModules() },
      { name: 'list_releases', args: { scope: 'project' }, run: () => adapter.listReleases({ scope: 'project' }) },
      { name: 'list_sprints', args: { releaseId: 'rel-1' }, run: () => adapter.listSprints({ releaseId: 'rel-1' }) },
      { name: 'create_suite', args: { suite: { name: 'Smoke', members: [] } }, run: () => adapter.createSuite({ name: 'Smoke', members: [] }) },
      {
        name: 'update_suite_members',
        args: { id: 'su-1', ops: [{ op: 'add', tcId: 'TC_1' }] },
        run: () => adapter.updateSuiteMembers('su-1', [{ op: 'add', tcId: 'TC_1' }]),
      },
      { name: 'delete_suite', args: { id: 'su-1' }, run: () => adapter.deleteSuite('su-1') },
      { name: 'list_cloud_runners', args: {}, run: () => adapter.listCloudRunners() },
      {
        name: 'clone_testcase',
        args: { id: 'TC_1', title: 'Copy', tdCopy: true },
        run: () => adapter.cloneTestCase('TC_1', 'Copy', { tdCopy: true }),
      },
      { name: 'search_objects', args: { query: 'btn' }, run: () => adapter.searchObjects({ query: 'btn' }) },
      {
        name: 'create_object',
        args: { object: { name: 'Btn', locators: [] } },
        run: () => adapter.createObject({ name: 'Btn', locators: [] }),
      },
      { name: 'get_object', args: { id: 'obj-1' }, run: () => adapter.getObject('obj-1') },
      { name: 'delete_object', args: { id: 'obj-1' }, run: () => adapter.deleteObject('obj-1') },
      { name: 'list_datasets', args: {}, run: () => adapter.listDatasets() },
      {
        name: 'save_generated_iterations',
        args: { tcId: 'TC_1', versionId: 'v1', environmentType: 'QA', rows: [{ user: 'a' }] },
        run: () => adapter.saveGeneratedIterations({ tcId: 'TC_1', versionId: 'v1', environmentType: 'QA', rows: [{ user: 'a' }] }),
      },
    ];
    const before = server.calls.length;
    for (const step of remaining) await step.run();
    expect(server.calls.slice(before)).toEqual(remaining.map(({ name, args }) => ({ name, args })));

    // Deep links are best-effort off the configured MCP origin (the /mcp suffix is stripped).
    expect(adapter.productUrlFor({ kind: 'testcase', id: 'TC_1' })).toBe('https://product.test/testcase/TC_1');
  });
});
