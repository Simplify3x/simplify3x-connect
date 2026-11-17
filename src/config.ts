import fs from 'node:fs';
import { addCredential } from './vendor/logger.js';
import os from 'node:os';
import path from 'node:path';

// Fields every QaConfig carries regardless of mode.
type ConfigCommon = {
  provider?: 'walnut' | 'simplifyqa';
  customerId?: string;
  moduleId?: string;
  walnutAuth: 'key' | 'jwt';
  caps: Set<string>;
  port?: number;
  connection?: string;
  /** Origin of a running walnut-frontend, used by tc_draft_open to build the
   * `/embed/test-case-draft` URL. Optional in both modes -- offline mode has no
   * backend to derive one from, so this is the only source; connected mode may
   * still want to point at a different UI host than the API origin.
   *
   * Also read by `recording_start` (mcp/qa/tools/recording.tools.ts) as an
   * OVERRIDE: when set (env `QA_MCP_WALNUT_UI`), the live recording editor URL
   * points at this deployed frontend's `/embed/test-case-draft` instead of the
   * agent's own self-hosted `/editor` (the default when this is absent). */
  walnutUiOrigin?: string;
  /** Loopback base for the local Walnut agent, which can host the editor window.
   * Only consulted by the standalone stdio dev harness (src/mcp/qa/index.ts) --
   * when this tool surface is mounted in-process inside the agent itself (the
   * product path, see src/mcp/qa/mount.ts), `tc_draft_open` calls the window
   * opener directly and never reads this field. */
  agentUrl?: string;
  /** Product base URL. Forwarded to the product MCP (Walnut or SimplifyQA) as the `x-qa-base-url`
   *  header so its backend REST calls have a base — for tokens without a JWT `url` claim. From
   *  env `QA_BASE_URL` or `qa_connect({baseUrl})`. */
  baseUrl?: string;
  /** SimplifyQA-only: the numeric userId of the caller — used by `list_projects` to scope results
   *  to the user's assigned projects via `/pm/projectuserrole?userId=…`, and by `"me"` filters.
   *  OPTIONAL since the adapter resolves the caller from the token itself (`GET /pm/auth/me`) or
   *  from a session-JWT `userId` claim. Set `QA_MCP_USER_ID` only to override that identity (or
   *  for a deployment whose backend predates /pm/auth/me). */
  userId?: string;
};

/**
 * "No credentials at all" -- the deliberate, error-free mode this server boots
 * into when QA_MCP_URL/TOKEN/PROJECT_ID are all absent (spec: author drafts and
 * hand off to walnut-frontend's editor, no backend, no network). `url`/`token`/
 * `projectId` may still be partially present here in principle, but resolveConfig
 * never returns this shape in that case -- partial credentials are a
 * misconfiguration and throw instead (see resolveConfig).
 */
export type OfflineQaConfig = ConfigCommon & {
  mode: 'offline';
  url?: string;
  token?: string;
  projectId?: string;
};

/** token + at least one of (baseUrl | url) present -- the shape a live ProviderAdapter is built from.
 *  `baseUrl` (QA_BASE_URL) is the Walnut BACKEND REST base (direct data ops); `url` (QA_MCP_URL) is the
 *  agent /mcp endpoint to hop to (recording + save-with-editor, and the SimplifyQA/legacy forwarder).
 *  Both are OPTIONAL at the type level — a cloud editor has only `baseUrl`, a legacy config has only
 *  `url` — but resolveConfig guarantees at least one is present at runtime. `projectId` is OPTIONAL: a
 *  session can be connected with NO project selected yet, and the user picks one at runtime
 *  (list_projects -> qa_switch_project). */
export type ConnectedQaConfig = ConfigCommon & {
  mode: 'connected';
  url?: string;
  token: string;
  projectId?: string;
};

export type QaConfig = OfflineQaConfig | ConnectedQaConfig;

const DEFAULT_CAPS = ['tc', 'suites', 'runs', 'objects', 'alm'];

// One resolution layer: only the keys a given source actually supplied.
type ConfigLayer = Partial<QaConfig>;

function asProvider(v: unknown): 'walnut' | 'simplifyqa' | undefined {
  return v === 'walnut' || v === 'simplifyqa' ? v : undefined;
}

function asWalnutAuth(v: unknown): 'key' | 'jwt' | undefined {
  return v === 'key' || v === 'jwt' ? v : undefined;
}

function asCaps(v: unknown): Set<string> | undefined {
  if (v == null) return undefined;
  const parts = Array.isArray(v) ? v.map(String) : String(v).split(',');
  const cleaned = parts.map((s) => s.trim()).filter(Boolean);
  return cleaned.length ? new Set(cleaned) : undefined;
}

function asPort(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// Shared normalizer for the two raw, loosely-typed sources (env vars and the
// JSON config file) that both describe a connection using the same field set.
function normalizeLayer(raw: Record<string, unknown>): ConfigLayer {
  const layer: ConfigLayer = {};
  const provider = asProvider(raw['provider']);
  if (provider) layer.provider = provider;
  const url = asString(raw['url']);
  if (url) layer.url = url;
  const token = asString(raw['token']);
  if (token) layer.token = token;
  const projectId = asString(raw['projectId']);
  if (projectId) layer.projectId = projectId;
  const customerId = asString(raw['customerId']);
  if (customerId) layer.customerId = customerId;
  const moduleId = asString(raw['moduleId']);
  if (moduleId) layer.moduleId = moduleId;
  const walnutAuth = asWalnutAuth(raw['walnutAuth']);
  if (walnutAuth) layer.walnutAuth = walnutAuth;
  const caps = asCaps(raw['caps']);
  if (caps) layer.caps = caps;
  const port = asPort(raw['port']);
  if (port !== undefined) layer.port = port;
  const walnutUiOrigin = asString(raw['walnutUiOrigin']);
  if (walnutUiOrigin) layer.walnutUiOrigin = walnutUiOrigin;
  const agentUrl = asString(raw['agentUrl']);
  if (agentUrl) layer.agentUrl = agentUrl;
  const baseUrl = asString(raw['baseUrl']);
  if (baseUrl) layer.baseUrl = baseUrl;
  const userId = asString(raw['userId']);
  if (userId) layer.userId = userId;
  return layer;
}

function parseEnvLayer(env: NodeJS.ProcessEnv): ConfigLayer {
  return normalizeLayer({
    provider: env['QA_MCP_PROVIDER'],
    url: env['QA_MCP_URL'],
    token: env['QA_MCP_TOKEN'],
    projectId: env['QA_MCP_PROJECT_ID'],
    customerId: env['QA_MCP_CUSTOMER_ID'],
    moduleId: env['QA_MCP_MODULE_ID'],
    walnutAuth: env['QA_MCP_WALNUT_AUTH'],
    caps: env['QA_MCP_CAPS'],
    port: env['QA_MCP_PORT'],
    walnutUiOrigin: env['QA_MCP_WALNUT_UI'],
    agentUrl: env['QA_MCP_AGENT_URL'],
    baseUrl: env['QA_BASE_URL'],
    userId: env['QA_MCP_USER_ID'],
  });
}

type RawConfigFile = { default?: string; connections?: Record<string, Record<string, unknown>> };

// Reads the named connection out of ~/.common-qa-mcp/config.json. An absent
// or malformed file (or a missing connection name) is just an empty layer —
// this must never throw, since it runs on every server boot.
function readConfigFileLayer(connectionName?: string): ConfigLayer {
  try {
    const filePath = path.join(os.homedir(), '.common-qa-mcp', 'config.json');
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as RawConfigFile;
    const name = connectionName ?? parsed.default ?? 'default';
    const entry = parsed.connections?.[name];
    return entry ? normalizeLayer(entry) : {};
  } catch {
    return {};
  }
}

// Copies only the keys `layer` actually defines onto `target`, so later,
// lower-priority-but-earlier-applied layers are never clobbered by absent keys.
function applyLayer<T extends object>(target: T, layer: Partial<T>): void {
  for (const key of Object.keys(layer) as Array<keyof T>) {
    const value = layer[key];
    if (value !== undefined) target[key] = value as T[keyof T];
  }
}

/**
 * A token "looks like a JWT" when it is exactly three non-empty base64url segments separated by dots
 * (header.payload.signature). Used to AUTO-DETECT the auth mode: a Walnut user JWT → 'jwt' (Bearer +
 * x-project-id + x-user-id), anything else (an MCP API key) → 'key' (Bearer only). No decode/verify —
 * shape alone is enough to pick the header set; the backend re-verifies the token itself.
 */
export function looksLikeJwt(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p));
}

/** Decode a string claim from a JWT payload WITHOUT verifying the signature. Verification is the
 *  backend's job; this only extracts embedded metadata (e.g. SQA tokens carry a `url` claim naming
 *  the SimplifyQA backend). Returns undefined on any parse failure — never throws. */
export function jwtStringClaim(token: string | undefined, name: string): string | undefined {
  if (!token) return undefined;
  try {
    const t = token.startsWith('Bearer ') ? token.slice(7).trim() : token.trim();
    const seg = t.split('.')[1];
    if (!seg) return undefined;
    let b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>;
    const v = claims[name];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolution order (spec §12): defaults -> ~/.common-qa-mcp/config.json
 * (named connections; cliFlags.connection selects) -> QA_MCP_* env -> CLI flags.
 * Each layer only overrides keys it actually sets.
 *
 * Credentials are optional overall (design note §3):
 *  - token AND baseUrl AND url ALL ABSENT -> OfflineQaConfig, no throw. The normal, supported way to
 *    run with no backend at all (author drafts, hand off to the editor).
 *  - a PARTIAL set (a baseUrl/url but no token, or a token but neither baseUrl nor url) ->
 *    misconfiguration, throws naming what is missing.
 *  - token + at least one of (baseUrl | url) -> ConnectedQaConfig. `baseUrl` (QA_BASE_URL) is the
 *    Walnut backend for direct data ops; `url` (QA_MCP_URL) is the agent /mcp endpoint (recording +
 *    the legacy/SimplifyQA forwarder). projectId is OPTIONAL: absent means "connected, no project
 *    selected yet" and the user chooses one at runtime.
 *
 * Auth mode is AUTO-DETECTED from the token shape (jwt vs key) unless QA_MCP_WALNUT_AUTH is set
 * explicitly (env/config-file/CLI), which always wins. Never logs `token` -- callers must go through
 * `mask()` from log.ts if they log config at all.
 */
export function resolveConfig(env: NodeJS.ProcessEnv, cliFlags: Partial<QaConfig> = {}): QaConfig {
  const merged: Partial<QaConfig> & { caps: Set<string> } = {
    caps: new Set(DEFAULT_CAPS),
  };

  applyLayer(merged, readConfigFileLayer(cliFlags.connection));
  applyLayer(merged, parseEnvLayer(env));
  applyLayer(merged, cliFlags);

  // Auth mode: an explicit QA_MCP_WALNUT_AUTH (env/config-file/CLI) always wins; otherwise auto-detect
  // from the token — a JWT-shaped token → 'jwt', anything else → 'key'. Offline (no token) keeps the
  // harmless 'key' default. Computed AFTER the token is known (below the layer merge).
  merged.walnutAuth = merged.walnutAuth ?? (merged.token && looksLikeJwt(merged.token) ? 'jwt' : 'key');

  // Register the resolved token with the log redactor: even a caller that logs it raw is scrubbed.
  addCredential(merged.token);

  const hasToken = !!merged.token;
  const hasUrl = !!merged.url;
  const hasBaseUrl = !!merged.baseUrl;

  if (!hasToken && !hasUrl && !hasBaseUrl) {
    // No credentials supplied at all -- offline is the intended, error-free outcome.
    return { ...merged, mode: 'offline' } as OfflineQaConfig;
  }

  // A partial set is a misconfiguration -- name exactly what is missing.
  const missing: string[] = [];
  if (!hasToken) missing.push('QA_MCP_TOKEN');
  if (!hasUrl && !hasBaseUrl) missing.push('QA_BASE_URL or QA_MCP_URL');
  if (missing.length) {
    throw new Error(
      `Missing required configuration: set ${missing.join(', ')} (via environment variables, ` +
        `~/.common-qa-mcp/config.json, or CLI flags).`,
    );
  }

  // SimplifyQA specifically needs a resolvable base URL — either QA_BASE_URL, or a JWT whose
  // payload carries the `url` claim. Without one, the factory would silently fall back to the
  // agent-forwarder (RemoteMcpAdapter), and every common tool (list_projects, tc_list, …) would
  // require the local agent to be running just to make what are really direct REST calls. Fail loud
  // at boot instead so the user fixes the config.
  if (merged.provider === 'simplifyqa' && !hasBaseUrl && !jwtStringClaim(merged.token, 'url')) {
    throw new Error(
      'SimplifyQA needs a base URL for direct REST calls. Set QA_BASE_URL in mcp.json (or ' +
        '~/.common-qa-mcp/config.json), or use a token JWT that embeds the "url" claim. ' +
        'QA_MCP_URL (the local agent) alone is not enough — read-only tools (list_projects, ' +
        'tc_list, story_list, …) call the SimplifyQA backend directly and do not need the agent.',
    );
  }

  return { ...merged, mode: 'connected' } as ConnectedQaConfig;
}

// A probe that throws (DNS failure, TLS failure, timeout, connection refused) is not a
// signal either way -- it collapses to "no response", same as never matching.
async function safeFetch(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetchImpl(url, init);
  } catch {
    return null;
  }
}

// A 200 only counts as a match -- for EITHER probe -- when it's actually JSON: a SPA
// catch-all (or any host that 200s everything, GET or POST) must not be mistaken for a
// product match just because it answered with 200. The content-type must say JSON AND the
// body must actually parse. Shared by both probes so neither gets a weaker bar than the other.
async function isJson200(res: Response | null): Promise<boolean> {
  if (!res || res.status !== 200) return false;
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return false;
  try {
    await res.json();
    return true;
  } catch {
    return false; // content-type lied -- body didn't actually parse as JSON
  }
}

/**
 * Best-effort provider auto-detect (spec §3: explicit config always wins over this).
 * Runs both probes concurrently (never short-circuits) and only returns a provider when
 * exactly one of them gives a confident match. Returns null on any ambiguity -- including
 * ties -- so the caller surfaces `describeAmbiguousProvider` instead of guessing.
 */
export async function detectProvider(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<'walnut' | 'simplifyqa' | null> {
  const [health, search] = await Promise.all([
    safeFetch(fetchImpl, `${url}/api/health`),
    safeFetch(fetchImpl, `${url}/pm/project/search`, { method: 'POST' }),
  ]);

  // Symmetric rule for both probes: a 200 only counts when it's confirmed JSON (isJson200);
  // a bare 401 only counts with corroboration; anything else (404, other statuses, a throw
  // already collapsed to null by safeFetch) is no-match.
  const isWalnut = await isJson200(health);
  // A bare 401 on the search probe is only trusted as an SQA-specific signal when the
  // health probe didn't hit the identical status -- if BOTH the walnut-only health route
  // and the SQA search route 401 identically, that's a blanket auth gate on this host, not
  // evidence of SQA (a genuine SQA host has no reason to 401 a route it doesn't implement).
  // Walnut has no equivalent 401 path: its match is JSON-only, so it needs no such rule.
  const isSimplifyQa = (await isJson200(search)) || (search?.status === 401 && health?.status !== 401);

  if (isWalnut && !isSimplifyQa) return 'walnut';
  if (isSimplifyQa && !isWalnut) return 'simplifyqa';
  return null;
}

/**
 * The exact message a caller (the adapter factory, Task 5/6/11/12) should surface when
 * `detectProvider` returns null -- spec §3: "on ambiguity, error asking for QA_MCP_PROVIDER".
 * `detectProvider` itself never throws; this is a pure formatter for whoever does.
 */
export function describeAmbiguousProvider(url: string): string {
  return (
    `Could not auto-detect the QA provider at ${url}. ` +
    `Set QA_MCP_PROVIDER to "walnut" or "simplifyqa" explicitly.`
  );
}
