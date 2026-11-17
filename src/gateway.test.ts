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
