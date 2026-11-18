import type { Request } from 'express';
import type { ConnectRequest } from './connection.js';
import { resolveRequireClientToken } from './defaults.js';

// Type-only imports above (erased at runtime), so this module has NO runtime dependency graph --
// it's a pure parser and can be unit-tested without pulling mount.ts's Electron/browser imports.

function firstHeader(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
function firstQuery(req: Request, name: string): string | undefined {
  const v = req.query[name];
  if (Array.isArray(v)) return v[0] != null ? String(v[0]) : undefined;
  return v != null ? String(v) : undefined;
}

/**
 * Config-based connection (the no-chat setup path): an AI client's mcp.json can carry the
 * connection in the transport itself instead of the user calling `qa_connect` in chat, e.g.
 *   { "url": "http://127.0.0.1:4050/mcp",
 *     "headers": { "Authorization": "Bearer <token>", "x-qa-product": "walnut",
 *                  "x-qa-url": "http://localhost:8080", "x-project-id": "<id>" } }
 *
 * - token   <- `Authorization: Bearer …` (scheme stripped; `x-qa-token` also accepted)
 * - url      <- `?url=` | `x-qa-url` | QA_MCP_URL   (the MCP endpoint to hop to: agent /mcp for
 *               walnut recording, or the SQA /mcp)
 * - baseUrl  <- `?baseUrl=` | `x-qa-base-url` | QA_BASE_URL   (the Walnut BACKEND REST base, for
 *               DIRECT data ops; a walnut session can connect with baseUrl alone)
 * - product  <- `?product=` | `x-qa-product` | QA_MCP_PROVIDER       (default 'walnut')
 * - projectId<- `?projectId=` | `x-project-id` | QA_MCP_PROJECT_ID
 * - auth     <- `?auth=` | `x-qa-auth`                               ('jwt' | 'key')
 *
 * Returns null when there is no usable token + (url|baseUrl), so the offline authoring path is untouched.
 */
export function connectionFromRequest(req: Request): ConnectRequest | null {
  const authz = firstHeader(req, 'authorization') ?? '';
  const token = ((authz.replace(/^Bearer\s+/i, '')) || firstHeader(req, 'x-qa-token') || '').trim();
  if (!token) return null;
  // Per-user mode: WHERE to connect is the server's decision, so the caller's url / baseUrl / product
  // are ignored and only the environment is used. The caller supplies only WHO (the token).
  const perUser = resolveRequireClientToken();
  const fromCaller = (query: string, header: string): string | undefined =>
    perUser ? undefined : (firstQuery(req, query) ?? firstHeader(req, header));
  // `url` = the MCP endpoint to hop to (agent /mcp for walnut recording, or the SQA /mcp).
  // `baseUrl` = the Walnut BACKEND REST base for DIRECT data ops (QA_BASE_URL). Either one (with a
  // token) is a usable connection; a walnut direct session needs only baseUrl.
  const url = (fromCaller('url', 'x-qa-url') ?? process.env['QA_MCP_URL'] ?? '').trim();
  const baseUrl = (fromCaller('baseUrl', 'x-qa-base-url') ?? process.env['QA_BASE_URL'] ?? '').trim();
  if (!url && !baseUrl) return null;
  const productRaw = fromCaller('product', 'x-qa-product') ?? process.env['QA_MCP_PROVIDER'] ?? '';
  const product: 'walnut' | 'simplifyqa' = productRaw === 'simplifyqa' ? 'simplifyqa' : 'walnut';
  const projectId = (firstQuery(req, 'projectId') ?? firstHeader(req, 'x-project-id') ?? process.env['QA_MCP_PROJECT_ID'] ?? '').trim();
  const authRaw = firstQuery(req, 'auth') ?? firstHeader(req, 'x-qa-auth') ?? '';
  const auth: 'jwt' | 'key' | undefined = authRaw === 'key' ? 'key' : authRaw === 'jwt' ? 'jwt' : undefined;
  return { token, product, ...(url ? { url } : {}), ...(baseUrl ? { baseUrl } : {}), ...(projectId ? { projectId } : {}), ...(auth ? { auth } : {}) };
}
