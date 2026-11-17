// coverage.recording — the recording passthrough (recording.tools.ts). The passthrough mirrors the
// connected agent's own tool list onto THIS server, so the tests drive a real in-process MCP client
// against a fake adapter that advertises agent tools, and assert:
//   • Walnut: only the sub-agent / status / discovery / control tools are proxied (granular verbs stay
//     internal), delegation resolves nestStart refs, and a finished recording is bridged into the
//     DraftStore as an UNSAVED draft that tc_save can persist.
//   • SimplifyQA: EVERY non-provider-op agent tool is proxied with its real parameter schema, the
//     formula-aware text verbs resolve `formula` before forwarding, and the activation / close guards
//     refuse instead of silently picking a platform or discarding unsaved steps.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { QaConnection } from '../connection.js';
import { DraftStore } from '../drafts/store.js';
import { buildServer, type ServerDeps } from '../server.js';

// The passthrough reports its discovery/proxied counts through `log` → console.error; keep the test
// report readable. Nothing under test depends on that output.
beforeAll(() => { jest.spyOn(console, 'error').mockImplementation(() => undefined); });
afterAll(() => { jest.restoreAllMocks(); });

type AgentTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };

type Harness = { client: Client; server: McpServer; setAdapter: (a: ProviderAdapter | null) => void };

async function connect(
  adapter: ProviderAdapter | null,
  opts: { connection?: QaConnection; tools?: AgentTool[]; drafts?: DraftStore } = {},
): Promise<Harness> {
  const deps: ServerDeps = {
    adapter,
    connection: opts.connection,
    mode: 'connected',
    drafts: opts.drafts ?? new DraftStore(),
    openEditorWindow: async () => false,
  };
  const server = buildServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new McpClient({ name: 'coverage-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server, setAdapter: (a) => { deps.adapter = a; } };
}

/** The passthrough registers from a fire-and-forget async loop; poll tools/list until it lands. */
async function toolNames(client: Client, expectAtLeastOne: string): Promise<string[]> {
  for (let i = 0; i < 50; i++) {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    if (names.includes(expectAtLeastOne)) return names;
    await Promise.resolve();
  }
  throw new Error(`the passthrough never registered ${expectAtLeastOne}`);
}

async function toolSchema(client: Client, name: string): Promise<Record<string, unknown>> {
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} is not registered`);
  return tool.inputSchema as Record<string, unknown>;
}

function textOf(res: unknown): string {
  const content = ((res as { content?: Array<{ type: string; text?: string }> }).content ?? []);
  return content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
}

function structured<T>(res: unknown): T {
  return (res as { structuredContent?: T }).structuredContent as T;
}

/** A minimal live-connection double: buildServer derives the provider from config().provider. */function sqaConnection(adapter: ProviderAdapter): QaConnection {
  return {
    config: () => ({ provider: 'simplifyqa', mode: 'connected', projectId: 'P1' }),
    describe: () => ({ mode: 'connected', projectId: 'P1', source: 'startup-config' }),
    adapter: () => adapter,
  } as unknown as QaConnection;
}

const WALNUT_TOOLS: AgentTool[] = [
  { name: 'info' },
  { name: 'web', description: 'Record a web flow', inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } },
  { name: 'web_status', description: 'Poll a web recording' },
  { name: 'qa_technology_status', description: 'Which sub-agents are available' },
  { name: 'android_devices', description: 'Installed apps per device' },
  { name: 'web_recording_stop', description: 'Pause', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] } },
  { name: 'browser_click', description: 'internal granular verb' },
  { name: 'core_save_session', description: 'internal recorder verb' },
];

const SQA_TOOLS: AgentTool[] = [
  { name: 'info' },
  { name: 'core_activate_technology', description: 'Start a recording', inputSchema: { type: 'object', properties: { technology: { type: 'string' }, testcaseName: { type: 'string' }, recordingMode: { type: 'string' }, recordingModeAskedUser: { type: 'string' }, deviceId: { type: 'string' } }, required: ['technology'] } },
  { name: 'web_click', description: 'Click an element', inputSchema: { type: 'object', properties: { ref: { type: 'string' }, expected: { type: 'string' } }, required: ['ref', 'expected'] } },
  { name: 'web_enter_text', description: 'Type into a field', inputSchema: { type: 'object', properties: { ref: { type: 'string' }, value: { type: 'string' } }, required: ['ref'] } },
  { name: 'desktop_set_text', description: 'Replace a field', inputSchema: { type: 'object', properties: { ref: { type: 'string' }, value: { type: 'string' } }, required: ['ref'] } },
  { name: 'api_send_request', description: 'Send a request', inputSchema: { type: 'object', properties: { method: { type: 'string' }, url: { type: 'string' } }, required: ['method', 'url'] } },
  { name: 'core_close_session', description: 'Tear down' },
];

describe('recorded-recording passthrough — Walnut surface', () => {
  it('proxies only the sub-agent surface, resolves nested refs and forwards calls verbatim', async () => {
    const callRaw = jest.fn(async (_name: string, args: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: `forwarded ${JSON.stringify(args)}` }],
    }));
    const getTestCase = jest.fn(async (id: string) => ({ id, title: 'Login helper' }));
    const adapter = { listAgentTools: async () => WALNUT_TOOLS, callRaw, getTestCase } as unknown as ProviderAdapter;
    const { client, server, setAdapter } = await connect(adapter);
    try {
      const names = await toolNames(client, 'web');
      expect(names).toEqual(expect.arrayContaining(['web', 'web_status', 'qa_technology_status', 'android_devices', 'web_recording_stop']));
      // Granular / internal verbs and the provider ops Common already wraps stay hidden.
      expect(names).not.toContain('browser_click');
      expect(names).not.toContain('core_save_session');
      expect(names).not.toContain('info');
      // The close SAVE GUARD is SimplifyQA-only (Walnut keeps its exact prior surface).
      expect(names).not.toContain('core_close_session');

      const res = await client.callTool({
        name: 'web',
        arguments: { task: 'Sign in as admin', url: 'https://app.test', profile: 'signed-in', nestStart: ['TC_1'] },
      });
      expect(res.isError).toBeFalsy();
      expect(getTestCase).toHaveBeenCalledWith('TC_1');
      expect(callRaw).toHaveBeenCalledWith('web', {
        task: 'Sign in as admin',
        url: 'https://app.test',
        profile: 'signed-in',
        nestStart: [{ tcId: 'TC_1', name: 'Login helper' }],
      });
      expect(textOf(res)).toContain('forwarded {"task":"Sign in as admin"');

      const stop = await client.callTool({ name: 'web_recording_stop', arguments: { sessionId: 'sess-7' } });
      expect(stop.isError).toBeFalsy();
      expect(callRaw).toHaveBeenCalledWith('web_recording_stop', { sessionId: 'sess-7' });

      // A bad nested id fails BEFORE a recording is started.
      getTestCase.mockRejectedValueOnce(new Error('404'));
      const badNest = await client.callTool({ name: 'web', arguments: { task: 'go', nestEnd: ['TC_9'] } });
      expect(badNest.isError).toBe(true);
      expect(textOf(badNest)).toContain('Cannot reuse test case "TC_9" as a nested step — it was not found (check the id).');

      // Downstream failures surface as tool errors, not crashes.
      callRaw.mockRejectedValueOnce(new Error('agent exploded'));
      const boom = await client.callTool({ name: 'web', arguments: { task: 'go' } });
      expect(boom.isError).toBe(true);
      expect(textOf(boom)).toContain('agent exploded');

      // The connection can drop after registration — the proxy says so instead of forwarding.
      setAdapter(null);
      const offline = await client.callTool({ name: 'web', arguments: { task: 'go' } });
      expect(offline.isError).toBe(true);
      expect(textOf(offline)).toContain('Not connected to a product agent — recording runs on the agent (qa_connect first).');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('re-homes a finished recording into the DraftStore as an unsaved draft tc_save can persist', async () => {
    let polls = 0;
    const callRaw = jest.fn(async (name: string) => {
      if (name === 'web_status') {
        polls += 1;
        if (polls === 1) {
          return {
            content: [{ type: 'text' as const, text: 'still recording' }],
            structuredContent: { status: 'recording', sessionId: 'sess-1' },
          };
        }
        return {
          structuredContent: {
            status: 'done',
            summary: 'Web recording complete.',
            tc: {
              title: 'Recorded login',
              category: 'automated',
              steps: [{ n: 1, description: 'Click login', stepType: 'web', actionType: 'Click' }],
            },
          },
        };
      }
      return { content: [{ type: 'text' as const, text: 'unexpected' }] };
    });
    const createTestCase = jest.fn(async () => ({ id: '77' }));
    const listModules = jest.fn(async () => [{ id: '3', name: 'Default Module' }]);
    const listTestCases = jest.fn(async () => []);
    const adapter = {
      listAgentTools: async () => WALNUT_TOOLS, callRaw, createTestCase, listModules, listTestCases,
    } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      await toolNames(client, 'web_status');

      const polling = await client.callTool({ name: 'web_status', arguments: { sessionId: 'sess-1' } });
      expect(callRaw).toHaveBeenCalledWith('web_status', { sessionId: 'sess-1' });
      // Still recording → forwarded verbatim, no draft minted.
      expect(textOf(polling)).toContain('still recording');
      expect(structured<{ draftId?: string }>(polling).draftId).toBeUndefined();

      callRaw.mockClear();
      const done = await client.callTool({ name: 'web_status', arguments: { sessionId: 'sess-1' } });
      expect(done.isError).toBeFalsy();
      const sc = structured<{ status: string; draftId: string; stepCount: number; tc: { title: string } }>(done);
      expect(sc.status).toBe('done');
      expect(sc.draftId).toMatch(/^draft_/);
      expect(sc.stepCount).toBe(1);
      expect(sc.tc.title).toBe('Recorded login');
      const text = textOf(done);
      expect(text).toContain('Web recording complete.');
      expect(text).toContain(`Registered as draft ${sc.draftId} (1 step). This is an UNSAVED draft`);
      expect(text).toContain(`tc_save({ draftId: "${sc.draftId}" }) ONLY after the user EXPLICITLY says to save`);

      // tc_save reads THAT store — the bridged draft is genuinely savable.
      const saved = await client.callTool({ name: 'tc_save', arguments: { draftId: sc.draftId } });
      expect(saved.isError).toBeFalsy();
      expect(textOf(saved)).toContain('Created test case 77.');
      expect(structured<{ saved: { id: string } }>(saved).saved.id).toBe('77');
    } finally {
      await client.close();
      await server.close();
    }
  });

});

describe('recording passthrough — SimplifyQA surface', () => {
  it('guards core_close_session: refuses a bridged unsaved draft, honours a one-shot token and keepRecorderOpen', async () => {
    const callRaw = jest.fn(async (name: string) => {
      if (name === 'core_active_recordings') return { structuredContent: { recordings: [] } };
      if (name === 'web_status') {
        return {
          structuredContent: {
            status: 'done',
            summary: 'Web recording complete.',
            tc: { title: 'Unsaved flow', category: 'manual', steps: [{ n: 1, description: 'Step', stepType: 'manual', actionType: 'manual' }] },
          },
        };
      }
      return { content: [{ type: 'text' as const, text: 'Closed.' }] };
    });
    const tools = [...SQA_TOOLS, { name: 'web_status', description: 'Poll a web recording' }];
    const adapter = { listAgentTools: async () => tools, callRaw } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter, { connection: sqaConnection(adapter) });
    try {
      await toolNames(client, 'web_status');

      // Nothing unsaved → the close is forwarded (with Common's own `force` NOT set).
      const clean = await client.callTool({ name: 'core_close_session', arguments: {} });
      expect(clean.isError).toBeFalsy();
      expect(callRaw).toHaveBeenCalledWith('core_close_session', {});
      expect(textOf(clean)).toContain('Closed.');

      // Finish a recording → an unsaved delegated draft now exists in Common's store.
      const done = await client.callTool({ name: 'web_status', arguments: { sessionId: 'sess-1' } });
      const draftId = structured<{ draftId: string }>(done).draftId;

      callRaw.mockClear();
      const refused = await client.callTool({ name: 'core_close_session', arguments: {} });
      expect(refused.isError).toBe(true);
      const refusedText = textOf(refused);
      expect(refusedText).toContain('Refusing to close: 1 recording(s) are NOT saved yet.');
      expect(refusedText).toContain('Unsaved DELEGATED-recorder draft(s)');
      expect(refusedText).toContain(`• draftId: ${draftId} — "Unsaved flow" (recording session sess-1)`);
      expect(callRaw.mock.calls.some((c) => c[0] === 'core_close_session')).toBe(false);

      const nonce = /core_close_session\(\{ confirm: "([^"]+)" \}\)/.exec(refusedText)?.[1];
      expect(nonce).toBeTruthy();

      // Redeeming the token forwards force:true — the ONLY way Common sets it.
      const forced = await client.callTool({ name: 'core_close_session', arguments: { confirm: nonce } });
      expect(forced.isError).toBeFalsy();
      expect(callRaw).toHaveBeenCalledWith('core_close_session', { force: true });

      // The token is one-shot: replaying it is ignored and the guard fires again.
      const replayed = await client.callTool({ name: 'core_close_session', arguments: { confirm: nonce } });
      expect(replayed.isError).toBe(true);
      expect(textOf(replayed)).toContain('Refusing to close: 1 recording(s) are NOT saved yet.');

      // "close the browser" keeps the recorder window — never refused, forwarded as asked.
      const kept = await client.callTool({ name: 'core_close_session', arguments: { keepRecorderOpen: true } });
      expect(kept.isError).toBeFalsy();
      expect(callRaw).toHaveBeenLastCalledWith('core_close_session', { keepRecorderOpen: true });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('proxies every agent tool with its real schema and resolves formulas before forwarding', async () => {
    const callRaw = jest.fn(async (name: string, args: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: `${name}:${JSON.stringify(args)}` }],
    }));
    const evaluateFormula = jest.fn(async () => ({ value: 'AB1234', expression: '=ALPHA_NUMERIC(6)' }));
    const adapter = { listAgentTools: async () => SQA_TOOLS, callRaw, evaluateFormula } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter, { connection: sqaConnection(adapter) });
    try {
      const names = await toolNames(client, 'web_click');
      expect(names).toEqual(expect.arrayContaining([
        'core_activate_technology', 'web_click', 'web_enter_text', 'desktop_set_text',
        'api_send_request', 'core_close_session',
      ]));
      expect(names).not.toContain('info');

      // The agent's real parameters are preserved (a required `expected` must be visible).
      const clickSchema = await toolSchema(client, 'web_click');
      expect(clickSchema['required']).toEqual(['ref', 'expected']);
      const enterSchema = await toolSchema(client, 'web_enter_text');
      expect(Object.keys(enterSchema['properties'] as Record<string, unknown>)).toEqual(
        expect.arrayContaining(['ref', 'value', 'formula']),
      );

      // A literal type-forward sends exactly what the caller passed.
      const literal = await client.callTool({ name: 'web_enter_text', arguments: { ref: 'e1', value: 'admin' } });
      expect(literal.isError).toBeFalsy();
      expect(evaluateFormula).not.toHaveBeenCalled();
      expect(callRaw).toHaveBeenCalledWith('web_enter_text', { ref: 'e1', value: 'admin' });

      // A formula is EVALUATED and the resolved value + expression are forwarded (no raw formula key).
      const typed = await client.callTool({
        name: 'web_enter_text',
        arguments: { ref: 'e2', formula: { expression: '=ALPHA_NUMERIC(6)' } },
      });
      expect(typed.isError).toBeFalsy();
      expect(evaluateFormula).toHaveBeenCalledWith({ expression: '=ALPHA_NUMERIC(6)' }, undefined);
      expect(callRaw).toHaveBeenLastCalledWith('web_enter_text', {
        ref: 'e2', value: 'AB1234', formulaExpression: '=ALPHA_NUMERIC(6)',
      });

      // DESKTOP verbs are evaluated as DESKTOP.
      const desktop = await client.callTool({
        name: 'desktop_set_text',
        arguments: { ref: 'e9', formula: { name: 'ALPHA_NUMERIC', args: { count: '6' } } },
      });
      expect(desktop.isError).toBeFalsy();
      expect(evaluateFormula).toHaveBeenLastCalledWith(
        { name: 'ALPHA_NUMERIC', args: { count: '6' } },
        { technologyType: 'DESKTOP' },
      );

      // A rejected formula fails the call and forwards nothing.
      evaluateFormula.mockRejectedValueOnce(new Error('not a formula'));
      const rejected = await client.callTool({
        name: 'web_enter_text', arguments: { ref: 'e3', formula: { name: 'NOPE' } },
      });
      expect(rejected.isError).toBe(true);
      expect(textOf(rejected)).toContain('not a formula');

      // Any other agent tool is a plain passthrough.
      const api = await client.callTool({
        name: 'api_send_request',
        arguments: { method: 'GET', url: 'https://api.test/health' },
      });
      expect(api.isError).toBeFalsy();
      expect(callRaw).toHaveBeenCalledWith('api_send_request', { method: 'GET', url: 'https://api.test/health' });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('refuses a WEB activation with no recording mode and an unasked/unlisted platform, then forwards', async () => {
    const callRaw = jest.fn(async (name: string) => ({
      content: [{ type: 'text' as const, text: `${name} ok` }],
      structuredContent: { sessionId: 'sess-1' },
    }));
    const listTestCases = jest.fn(async () => []);
    const adapter = { listAgentTools: async () => SQA_TOOLS, callRaw, listTestCases } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter, { connection: sqaConnection(adapter) });
    try {
      await toolNames(client, 'core_activate_technology');

      const noMode = await client.callTool({
        name: 'core_activate_technology', arguments: { technology: 'WEB', testcaseName: 'Login' },
      });
      expect(noMode.isError).toBe(true);
      expect(textOf(noMode)).toContain("the AI-only vs AI + Manual choice for THIS recording isn't set");

      const contradiction = await client.callTool({
        name: 'core_activate_technology',
        arguments: { technology: 'WEB', testcaseName: 'Login', recordingMode: 'HYBRID', recordingModeAskedUser: 'ai' },
      });
      expect(contradiction.isError).toBe(true);
      expect(textOf(contradiction)).toContain('those contradict; the user\'s answer must drive BOTH');

      await client.callTool({
        name: 'core_activate_technology',
        arguments: { technology: 'WEB', testcaseName: 'Login', recordingMode: 'AI + Manual', recordingModeAskedUser: 'hybrid' },
      });
      // "AI + Manual" is canonicalised to the backend enum and the intercept-only markers are stripped.
      expect(callRaw).toHaveBeenLastCalledWith('core_activate_technology', {
        technology: 'WEB', testcaseName: 'Login', recordingMode: 'HYBRID',
      });

      // Duplicate-name guard: a saved TC with this title is refused before a recorder opens.
      listTestCases.mockResolvedValueOnce([{ id: '1', code: 'TC-1', title: 'Login' }] as never);
      const dup = await client.callTool({
        name: 'core_activate_technology',
        arguments: {
          technology: 'WEB', testcaseName: 'Login', recordingMode: 'AI', recordingModeAskedUser: 'ai',
        },
      });
      expect(dup.isError).toBe(true);
      expect(textOf(dup)).toContain('a test case named "Login" already exists (TC-1).');
      expect(listTestCases).toHaveBeenCalledWith({ search: 'Login', limit: 50 });

      // Mobile ladder: platform asked → device TYPE asked → device asked.
      const base = { technology: 'ANDROID', testcaseName: 'Mob' };
      const noPlatform = await client.callTool({ name: 'core_activate_technology', arguments: base });
      expect(noPlatform.isError).toBe(true);
      expect(textOf(noPlatform)).toContain('no evidence the user was asked which mobile platform to use');
      expect(textOf(noPlatform)).toContain('ASK the user: "Android or iOS?"');

      const wrongPlatform = await client.callTool({
        name: 'core_activate_technology', arguments: { ...base, platformAskedUser: 'ios' },
      });
      expect(wrongPlatform.isError).toBe(true);
      expect(textOf(wrongPlatform)).toContain("(You passed platformAskedUser='ios' but technology='ANDROID' — those contradict.");

      const noDeviceType = await client.callTool({
        name: 'core_activate_technology', arguments: { ...base, platformAskedUser: 'android' },
      });
      expect(noDeviceType.isError).toBe(true);
      expect(textOf(noDeviceType)).toContain('no device type chosen. ASK the user: "Real Device, Cloud Device, or Virtual Device (Emulator)?"');

      const noDevice = await client.callTool({
        name: 'core_activate_technology',
        arguments: { ...base, platformAskedUser: 'android', deviceTypeAskedUser: 'real_device' },
      });
      expect(noDevice.isError).toBe(true);
      expect(textOf(noDevice)).toContain('ANDROID recording needs `deviceId`');
      expect(textOf(noDevice)).toContain('`android_list_devices` or `mobile_list_devices`');

      const mobile = await client.callTool({
        name: 'core_activate_technology',
        arguments: {
          ...base, platformAskedUser: 'android', deviceTypeAskedUser: 'real_device', deviceId: 'R58M',
          recordingMode: 'HYBRID', recordingModeAskedUser: 'hybrid', allowDuplicateName: true,
        },
      });
      expect(mobile.isError).toBeFalsy();
      // Mobile is ALWAYS AI-only whatever was asked, and every intercept-only marker is dropped.
      expect(callRaw).toHaveBeenLastCalledWith('core_activate_technology', {
        technology: 'ANDROID', testcaseName: 'Mob', deviceId: 'R58M', recordingMode: 'AI',
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('refuses to close a session holding unsaved granular recordings unless the token is redeemed', async () => {
    const callRaw = jest.fn(async (name: string) => {
      if (name === 'core_active_recordings') {
        return { structuredContent: { recordings: [{ sessionId: 'sess-9', mcpSessionKey: 'key-9', stepCount: 3 }] } };
      }
      return { content: [{ type: 'text' as const, text: 'Closed.' }] };
    });
    const adapter = { listAgentTools: async () => SQA_TOOLS, callRaw } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter, { connection: sqaConnection(adapter) });
    try {
      await toolNames(client, 'core_close_session');

      const refused = await client.callTool({ name: 'core_close_session', arguments: {} });
      expect(refused.isError).toBe(true);
      const text = textOf(refused);
      expect(text).toContain('Refusing to close: 1 recording(s) are NOT saved yet.');
      expect(text).toContain('Unsaved GRANULAR recording(s) — save with tc_save({ sessionId })');
      expect(text).toContain('• session sess-9 (key-9) — 3 step(s)');
      expect(callRaw.mock.calls.some((c) => c[0] === 'core_close_session')).toBe(false);

      const nonce = /core_close_session\(\{ confirm: "([^"]+)" \}\)/.exec(text)?.[1];
      expect(nonce).toBeTruthy();
      const forced = await client.callTool({ name: 'core_close_session', arguments: { confirm: nonce } });
      expect(forced.isError).toBeFalsy();
      expect(callRaw).toHaveBeenCalledWith('core_close_session', { force: true });
      expect(textOf(forced)).toContain('Closed.');

      // closeTestcaseWindow is forwarded as the caller asked (it never resolves the guard on its own).
      const kept = await client.callTool({ name: 'core_close_session', arguments: { closeTestcaseWindow: true } });
      expect(kept.isError).toBeTruthy(); // still unsaved → refused again
      const second = /core_close_session\(\{ confirm: "([^"]+)" \}\)/.exec(textOf(kept))?.[1];
      const window = await client.callTool({
        name: 'core_close_session', arguments: { confirm: second, closeTestcaseWindow: true },
      });
      expect(window.isError).toBeFalsy();
      expect(callRaw).toHaveBeenLastCalledWith('core_close_session', { force: true, closeTestcaseWindow: true });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
