import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGatewayApp } from './gateway.js';
import type { ServerDeps } from './server.js';

const JSON_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

const init = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const listTools = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

type Rpc = { status: number; json: Record<string, unknown> | null };

function client(base: string, extra: Record<string, string> = {}) {
  let session: string | undefined;
  const rpc = async (body: unknown): Promise<Rpc> => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...extra, ...(session ? { 'mcp-session-id': session } : {}) },
      body: JSON.stringify(body),
    });
    session ??= res.headers.get('mcp-session-id') ?? undefined;
    const text = await res.text();
    const payload = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5))
      .join('');
    return { status: res.status, json: (payload || text) ? JSON.parse(payload || text) : null };
  };
  const close = async (): Promise<void> => {
    if (!session) return;
    await fetch(`${base}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': session, ...extra } }).catch(() => undefined);
  };
  return { rpc, close, session: () => session };
}

async function start(
  env: NodeJS.ProcessEnv = {},
  mountOptions: Parameters<typeof createGatewayApp>[1] = {},
): Promise<{ base: string; stop: () => Promise<void> }> {
  const { app } = createGatewayApp(env, mountOptions);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const stop = async (): Promise<void> => {
    (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { base: `http://127.0.0.1:${port}`, stop };
}

describe('HTTP gateway: caller-chosen output folders', () => {
  const allowOf = async (env: NodeJS.ProcessEnv, opts: Parameters<typeof createGatewayApp>[1] = {}) => {
    const created: ServerDeps[] = [];
    const { base, stop } = await start(env, { ...opts, onSessionCreated: (_id, deps) => created.push(deps) });
    try {
      const c = client(base);
      await c.rpc(init);
      await c.close();
      return created[0]!.allowOutDir;
    } finally {
      await stop();
    }
  };

  it('allowed when bound to loopback (default), refused when bound to all interfaces', async () => {
    expect(await allowOf({})).toBe(true);
    expect(await allowOf({ HOST: '127.0.0.1' })).toBe(true);
    expect(await allowOf({ HOST: '0.0.0.0' })).toBe(false);
  });

  it('an explicit mount option wins', async () => {
    expect(await allowOf({ HOST: '0.0.0.0' }, { allowOutDir: true })).toBe(true);
    expect(await allowOf({}, { allowOutDir: false })).toBe(false);
  });
});

describe('HTTP gateway', () => {
  it('serves liveness and readiness without a session', async () => {
    const { base, stop } = await start();
    try {
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: 'ok' });

      const ready = await fetch(`${base}/ready`);
      expect(ready.status).toBe(200);
      const body = (await ready.json()) as { status: string; sessions: number };
      expect(body.status).toBe('ready');
      expect(typeof body.sessions).toBe('number');
    } finally {
      await stop();
    }
  });

  it('answers 404 for an unknown session, so a client re-initializes instead of giving up', async () => {
    const { base, stop } = await start();
    try {
      const res = await fetch(`${base}/mcp`, { method: 'GET', headers: { 'mcp-session-id': 'nope' } });
      expect(res.status).toBe(404);
    } finally {
      await stop();
    }
  });

  it('rejects a POST that is not an initialize request and carries no session', async () => {
    const { base, stop } = await start();
    try {
      const res = await fetch(`${base}/mcp`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(listTools) });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { message?: string } };
      expect(body.error?.message).toContain('No valid session ID');
    } finally {
      await stop();
    }
  });

  it('completes the handshake and serves a tool catalog', async () => {
    const { base, stop } = await start();
    try {
      const c = client(base);
      const inited = await c.rpc(init);
      expect(inited.status).toBe(200);
      const result = inited.json?.['result'] as { serverInfo?: { name?: string } };
      expect(result.serverInfo?.name).toBe('simplify3x-connect');

      await c.rpc(initialized);
      const listed = await c.rpc(listTools);
      const tools = (listed.json?.['result'] as { tools: Array<{ name: string }> }).tools;
      expect(tools.length).toBeGreaterThan(10);
      expect(tools.some((t) => t.name === 'qa_connection_status')).toBe(true);
      await c.close();
    } finally {
      await stop();
    }
  });

  it('gives every session its OWN connection and adapter', async () => {
    // The defect this guards: one process-wide QaConnection made the first caller's identity apply to
    // everyone, so user B acted as user A and a runtime qa_connect rebound all sessions.
    const created: Array<{ id: string; deps: ServerDeps }> = [];
    const { base, stop } = await start({}, { onSessionCreated: (id, deps) => created.push({ id, deps }) });
    try {
      const a = client(base);
      const b = client(base);
      await a.rpc(init);
      await b.rpc(init);
      expect(a.session()).toBeDefined();
      expect(b.session()).toBeDefined();
      expect(a.session()).not.toBe(b.session());

      expect(created).toHaveLength(2);
      expect(created[0]!.deps.connection).toBeDefined();
      expect(created[1]!.deps.connection).toBeDefined();
      expect(created[0]!.deps.connection).not.toBe(created[1]!.deps.connection);

      // A runtime connect on one session must not be visible from the other.
      const before = created[1]!.deps.connection!.describe();
      await created[0]!.deps.connection!.connect({ token: 'x', baseUrl: 'https://invalid.example.test', product: 'walnut' })
        .catch(() => undefined);
      expect(created[1]!.deps.connection!.describe()).toEqual(before);

      await a.close();
      await b.close();
    } finally {
      await stop();
    }
  });

  it('enforces a gateway token and returns WWW-Authenticate', async () => {
    const { base, stop } = await start({ QA_MCP_GATEWAY_TOKEN: 's3cret' });
    try {
      const unauth = await fetch(`${base}/mcp`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(init) });
      expect(unauth.status).toBe(401);
      expect(unauth.headers.get('www-authenticate')).toContain('Bearer');

      const viaHeader = client(base, { 'x-gateway-token': 's3cret' });
      expect((await viaHeader.rpc(init)).status).toBe(200);
      await viaHeader.close();

      const viaBearer = client(base, { authorization: 'Bearer s3cret' });
      expect((await viaBearer.rpc(init)).status).toBe(200);
      await viaBearer.close();
    } finally {
      await stop();
    }
  });

  it('requires each caller to present a product token in per-user mode', async () => {
    const created: string[] = [];
    const { base, stop } = await start(
      { QA_MCP_REQUIRE_CLIENT_TOKEN: 'true' },
      { onSessionCreated: (id) => created.push(id) },
    );
    try {
      const none = await fetch(`${base}/mcp`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(init) });
      expect(none.status).toBe(401);
      const body = (await none.json()) as { error?: string };
      expect(body.error).toBe('client token required');

      const withToken = client(base, { authorization: 'Bearer user-a-token' });
      expect((await withToken.rpc(init)).status).toBe(200);
      expect(created).toHaveLength(1);
      await withToken.close();
    } finally {
      await stop();
    }
  });

  it('rejects an oversized request body with 413', async () => {
    const { base, stop } = await start({}, { maxBodyBytes: 200 });
    try {
      const huge = JSON.stringify({ ...init, padding: 'x'.repeat(1000) });
      const res = await fetch(`${base}/mcp`, { method: 'POST', headers: JSON_HEADERS, body: huge });
      expect(res.status).toBe(413);
    } finally {
      await stop();
    }
  });
});

/** Restore process.env IN PLACE. Reassigning `process.env` swaps in a plain object that Node's own
 *  readers (os.homedir() reads HOME) no longer see, so later env changes would silently not apply. */
function restoreEnv(saved: NodeJS.ProcessEnv): void {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
}

describe('per-user mode (QA_MCP_REQUIRE_CLIENT_TOKEN=true)', () => {
  const saved = { ...process.env };
  afterEach(() => restoreEnv(saved));

  /** A stand-in SimplifyQA backend that records the Authorization header of every call it gets. */
  async function fakeBackend(): Promise<{ url: string; seen: string[]; stop: () => Promise<void> }> {
    const { createServer } = await import('node:http');
    const seen: string[] = [];
    const srv = createServer((req, res) => {
      seen.push(String(req.headers.authorization ?? ''));
      res.writeHead(401, { 'content-type': 'application/json' }).end('{}');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const { port } = srv.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, seen, stop: () => new Promise((r) => srv.close(() => r())) };
  }

  const until = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 40));
  };

  it('calls the backend with the caller\'s token, never the server token, and ignores a caller-supplied URL', async () => {
    const backend = await fakeBackend();
    Object.assign(process.env, {
      QA_MCP_PROVIDER: 'simplifyqa',
      QA_BASE_URL: backend.url,
      QA_MCP_TOKEN: 'service-token-xyz',
      QA_MCP_REQUIRE_CLIENT_TOKEN: 'true',
    });
    delete process.env['QA_MCP_URL'];
    const sessions: ServerDeps[] = [];
    const { base, stop } = await start(process.env, { onSessionCreated: (_id, deps) => sessions.push(deps) });
    try {
      // The caller also tries to redirect the server elsewhere; that header must be ignored.
      const userB = client(base, { authorization: 'Bearer user-b-token', 'x-qa-base-url': 'http://127.0.0.1:9' });
      expect((await userB.rpc(init)).status).toBe(200);
      await until(() => backend.seen.length > 0);

      expect(sessions[0]?.connection?.describe().mode).toBe('offline'); // never connected as the server
      expect(backend.seen.length).toBeGreaterThan(0); // reached OUR backend, not the caller's URL
      expect(backend.seen.every((h) => h === 'Bearer user-b-token')).toBe(true);
      await userB.close();
    } finally {
      await stop();
      await backend.stop();
    }
  });

  it('boots with a base URL and no server token, and refuses to boot without a base URL', async () => {
    const { resolveConfig } = await import('./config.js');
    const env = { QA_MCP_PROVIDER: 'simplifyqa', QA_MCP_REQUIRE_CLIENT_TOKEN: 'true' };
    const cfg = resolveConfig({ ...env, QA_BASE_URL: 'https://sqa.example.com', QA_MCP_USER_ID: '7' });
    expect(cfg.mode).toBe('offline');
    expect(cfg.baseUrl).toBe('https://sqa.example.com');
    expect(cfg.token).toBeUndefined();
    // Every session copies this config, so a server userId would make every caller user 7.
    expect(cfg.userId).toBeUndefined();
    expect(() => resolveConfig(env)).toThrow(/needs QA_BASE_URL/);
  });
});

describe('session isolation on a shared server (QA_MCP_HOSTED=true)', () => {
  const saved = { ...process.env };
  afterEach(() => restoreEnv(saved));

  it('gives each session its own drafts, with ids that cannot be guessed', async () => {
    process.env['QA_MCP_HOSTED'] = 'true';
    const sessions: ServerDeps[] = [];
    const { base, stop } = await start({}, { onSessionCreated: (_id, deps) => sessions.push(deps) });
    try {
      const a = client(base);
      const b = client(base);
      await a.rpc(init);
      await b.rpc(init);
      const id = sessions[0]!.drafts!.create({ title: 'A only', category: 'automated', steps: [] } as never);
      expect(id).toMatch(/^draft_[0-9a-f-]{36}$/);
      expect(sessions[0]!.drafts!.get(id).tc.title).toBe('A only');
      expect(() => sessions[1]!.drafts!.get(id)).toThrow();
      await a.close();
      await b.close();
    } finally {
      await stop();
    }
  });

  it('without QA_MCP_HOSTED, sessions share one draft store as before', async () => {
    delete process.env['QA_MCP_HOSTED'];
    const sessions: ServerDeps[] = [];
    const { base, stop } = await start({}, { onSessionCreated: (_id, deps) => sessions.push(deps) });
    try {
      const a = client(base);
      const b = client(base);
      await a.rpc(init);
      await b.rpc(init);
      const id = sessions[0]!.drafts!.create({ title: 'shared', category: 'automated', steps: [] } as never);
      expect(sessions[1]!.drafts!.get(id).tc.title).toBe('shared');
      await a.close();
      await b.close();
    } finally {
      await stop();
    }
  });

  it.each([
    ['does not restore a project another session chose', 'true', ''],
    ['without QA_MCP_HOSTED, still restores the last project as before', '', '42'],
  ])('%s', async (_name, hostedFlag, expectedProject) => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-home-'));
    fs.mkdirSync(path.join(home, '.common-qa-mcp'));
    fs.writeFileSync(path.join(home, '.common-qa-mcp', 'last-project.json'), JSON.stringify({ 'https://sqa.example.com': '42' }));
    // Jest hands tests a COPY of process.env, so HOME would not reach os.homedir(); stub it instead.
    const homedir = jest.spyOn(os.default, 'homedir').mockReturnValue(home);
    Object.assign(process.env, {
      QA_MCP_PROVIDER: 'simplifyqa',
      QA_BASE_URL: 'https://sqa.example.com',
      QA_MCP_TOKEN: 'service-token-xyz',
      QA_MCP_HOSTED: hostedFlag,
    });
    delete process.env['QA_MCP_URL'];
    delete process.env['QA_MCP_PROJECT_ID'];
    delete process.env['QA_MCP_REQUIRE_CLIENT_TOKEN'];
    const sessions: ServerDeps[] = [];
    const { base, stop } = await start({}, { onSessionCreated: (_id, deps) => sessions.push(deps) });
    try {
      const a = client(base);
      await a.rpc(init);
      expect(sessions[0]!.connection!.describe().mode).toBe('connected');
      expect(sessions[0]!.connection!.describe().projectId ?? '').toBe(expectedProject);
      await a.close();
    } finally {
      await stop();
      homedir.mockRestore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
