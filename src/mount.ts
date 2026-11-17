import type { Express, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { buildServer, type ServerDeps } from './server.js';
import { QaConnection } from './connection.js';
import { DraftStore } from './drafts/store.js';
import { createAdapter } from './adapters/factory.js';
import { resolveConfig } from './config.js';
import { connectionFromRequest } from './requestConnection.js';
import { log } from './log.js';

export type MountedStatus = {
  mode: 'offline' | 'connected';
  /** Live MCP sessions. */
  sessions: () => number;
};

export type MountOptions = {
  /** Test seam: observe the state that was created for a session. */
  onSessionCreated?: (sessionId: string, deps: ServerDeps) => void;
  /** Idle timeout for a session, ms. Default 30 min. */
  sessionTtlMs?: number;
  /** Maximum concurrent sessions; the least recently used is evicted. Default 200. */
  maxSessions?: number;
  /** Maximum accepted request body, bytes. Default 1 MB. */
  maxBodyBytes?: number;
};

/**
 * Mounts the Common QA MCP at POST/GET/DELETE /mcp on an Express app.
 *
 * MUST be registered before any body parser: each handler reads the raw request body itself and
 * always terminates the request.
 *
 * ONE CONNECTION PER SESSION, not one per process. With a process-wide connection the first client to
 * connect sets the identity, every later client acts as them, and a runtime `qa_connect` by one user
 * rebinds everyone -- which makes per-user credentials meaningless on a shared server. Per-session
 * state is what lets each MCP session carry its own token, and what makes `qa_connect` affect only
 * the caller.
 *
 * The DraftStore stays shared on purpose: a draft must survive a client reconnect.
 */
export function mountQaMcp(app: Express, options: MountOptions = {}): MountedStatus {
  const bootConfig = resolveConfig(process.env);
  const drafts = new DraftStore();

  const SESSION_TTL_MS = options.sessionTtlMs ?? Number(process.env['QA_MCP_SESSION_TTL_MS'] ?? 30 * 60 * 1000);
  const MAX_SESSIONS = options.maxSessions ?? Number(process.env['QA_MCP_MAX_SESSIONS'] ?? 200);
  const MAX_BODY_BYTES = options.maxBodyBytes ?? Number(process.env['QA_MCP_MAX_BODY_BYTES'] ?? 1_000_000);

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const lastSeen = new Map<string, number>();

  const touch = (id: string | undefined): void => { if (id) lastSeen.set(id, Date.now()); };

  /** Fresh connection + adapter for one MCP session. resolveConfig/createAdapter are pure (no I/O). */
  function sessionDeps(): ServerDeps {
    const cfg = resolveConfig(process.env);
    return {
      adapter: createAdapter(cfg),
      connection: new QaConnection(cfg),
      mode: cfg.mode,
      drafts,
      walnutUiOrigin: cfg.walnutUiOrigin,
      agentUrl: cfg.agentUrl,
      // The standalone gateway has no Electron window -- tc_draft_open just returns the editor link.
      openEditorWindow: async () => false,
    };
  }

  // Evict idle sessions so a long-running pod does not accumulate transports (each owns an McpServer
  // and a full tool catalog). unref() so the timer never holds the process open.
  setInterval(() => {
    const now = Date.now();
    for (const [id, ts] of lastSeen) {
      if (now - ts <= SESSION_TTL_MS) continue;
      const t = transports.get(id);
      try { void t?.close(); } catch { /* already gone */ }
      transports.delete(id);
      lastSeen.delete(id);
      log(`session ${id.slice(0, 8)}... expired after ${Math.round(SESSION_TTL_MS / 60000)}m idle`);
    }
  }, 60_000).unref();

  function readJsonBody(req: Request): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let data = '';
      let bytes = 0;
      let tooLarge = false;
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_BODY_BYTES) {
          tooLarge = true;
          data = '';
          return;
        }
        data += chunk;
      });
      req.on('end', () => {
        if (tooLarge) return reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        if (!data) return resolve(undefined);
        try { resolve(JSON.parse(data)); } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
      });
      req.on('error', reject);
    });
  }

  function jsonRpcError(res: Response, status: number, code: number, message: string): void {
    res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
  }

  function evictLeastRecentlyUsed(): void {
    let oldestId: string | undefined;
    let oldest = Infinity;
    for (const [sid, ts] of lastSeen) if (ts < oldest) { oldest = ts; oldestId = sid; }
    if (!oldestId) return;
    const victim = transports.get(oldestId);
    try { void victim?.close(); } catch { /* already gone */ }
    transports.delete(oldestId);
    lastSeen.delete(oldestId);
  }

  const postHandler = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    try {
      const existing = sessionId ? transports.get(sessionId) : undefined;
      if (existing) {
        touch(sessionId);
        const parsedBody = await readJsonBody(req);
        await existing.handleRequest(req, res, parsedBody);
        return;
      }
      if (sessionId) {
        jsonRpcError(res, 404, -32001, 'Session not found');
        return;
      }
      const parsedBody = await readJsonBody(req);
      if (!isInitializeRequest(parsedBody)) {
        jsonRpcError(res, 400, -32000, 'Bad Request: No valid session ID provided');
        return;
      }

      if (transports.size >= MAX_SESSIONS) evictLeastRecentlyUsed();

      const session = sessionDeps();
      const newTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, newTransport);
          lastSeen.set(id, Date.now());
          options.onSessionCreated?.(id, session);
        },
      });
      newTransport.onclose = () => {
        const id = newTransport.sessionId;
        if (id) { transports.delete(id); lastSeen.delete(id); }
      };

      const server = buildServer(session);
      await server.connect(newTransport as unknown as Transport);

      // Config-based connection: when THIS session has no credentials of its own, prime it from the
      // request's Authorization / x-qa-* headers. Fire-and-forget so a slow backend never stalls the
      // handshake. Because the connection is per session, one client's headers never affect another.
      if (session.connection?.describe().mode === 'offline') {
        const primeReq = connectionFromRequest(req);
        if (primeReq) {
          void session.connection.connect(primeReq).then(
            (r) => log(r.ok
              ? `connection primed from request (product=${primeReq.product ?? 'walnut'})`
              : `header/query connect failed: ${r.error}`),
            (e) => log('header/query connect threw', e instanceof Error ? e.message : String(e)),
          );
        }
      }

      await newTransport.handleRequest(req, res, parsedBody);
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 413) {
        log('POST /mcp rejected: request body too large');
        if (!res.headersSent) res.status(413).json({ error: 'request body too large' });
        return;
      }
      log('POST /mcp error', e instanceof Error ? e.message : String(e));
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  };

  const streamHandler = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      // 404 tells the client "this session is gone, re-initialize". A 400 reads as a protocol fault
      // and makes clients give up instead of reconnecting.
      res.status(404).send('Session not found');
      return;
    }
    touch(sessionId);
    if (req.method === 'GET') {
      // Long-lived SSE stream: stop proxies buffering or caching it.
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Connection', 'keep-alive');
    }
    try {
      await transport.handleRequest(req, res);
    } catch (e) {
      log(`${req.method} /mcp error`, e instanceof Error ? e.message : String(e));
      if (!res.headersSent) res.status(500).send('Error processing request');
    }
  };

  app.post('/mcp', postHandler);
  app.get('/mcp', streamHandler);
  app.delete('/mcp', streamHandler);

  log(`mounted at /mcp (mode=${bootConfig.mode})`);
  return { mode: bootConfig.mode, sessions: () => transports.size };
}
