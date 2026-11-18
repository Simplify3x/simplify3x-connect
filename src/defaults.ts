/**
 * Defaults for every setting that does NOT need to be in a deployment's environment.
 *
 * The rule: a value belongs in the environment only if it is secret or genuinely deployment
 * specific (backend URL, token, bind address, host allowlist). Everything that has a sane value for
 * every deployment lives here, so `.env.example` stays short and nothing is silently unset.
 *
 * Each setting is still overridable from the environment — these are defaults, not constants. The
 * resolvers below are also the unit under test in `defaults.test.ts`.
 */
export const DEFAULTS = {
  /** Loopback by default: a local gateway. Containers set HOST=0.0.0.0. */
  host: '127.0.0.1',
  port: 4060,
  /** Per-request timeout to the product backend. 30s is generous for slow proxies. */
  httpTimeoutMs: 30_000,
  /** Idle MCP session lifetime before it is evicted. */
  sessionTtlMs: 30 * 60 * 1000,
  /** Concurrent session cap; the least recently used is evicted beyond it. */
  maxSessions: 200,
  /** Largest accepted request body. */
  maxBodyBytes: 1_000_000,
  /** Tool families registered when QA_MCP_CAPS is not set. */
  caps: ['tc', 'suites', 'runs', 'objects', 'alm'],
} as const;

/** Positive finite number from the environment, else the default. */
function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const resolveHost = (env: NodeJS.ProcessEnv = process.env): string =>
  (env['HOST'] ?? '').trim() || DEFAULTS.host;

export const resolvePort = (env: NodeJS.ProcessEnv = process.env): number =>
  positive(env['PORT'], DEFAULTS.port);

export const resolveHttpTimeoutMs = (env: NodeJS.ProcessEnv = process.env): number =>
  positive(env['QA_HTTP_TIMEOUT_MS'], DEFAULTS.httpTimeoutMs);

export const resolveSessionTtlMs = (env: NodeJS.ProcessEnv = process.env): number =>
  positive(env['QA_MCP_SESSION_TTL_MS'], DEFAULTS.sessionTtlMs);

export const resolveMaxSessions = (env: NodeJS.ProcessEnv = process.env): number =>
  positive(env['QA_MCP_MAX_SESSIONS'], DEFAULTS.maxSessions);

export const resolveMaxBodyBytes = (env: NodeJS.ProcessEnv = process.env): number =>
  positive(env['QA_MCP_MAX_BODY_BYTES'], DEFAULTS.maxBodyBytes);

/**
 * Per-user mode (QA_MCP_REQUIRE_CLIENT_TOKEN=true): every caller brings their own product token, the
 * server's own token is ignored, and the backend URL comes only from the server's environment.
 */
export const resolveRequireClientToken = (env: NodeJS.ProcessEnv = process.env): boolean =>
  (env['QA_MCP_REQUIRE_CLIENT_TOKEN'] ?? '').trim().toLowerCase() === 'true';

/**
 * Shared hosted deployment (QA_MCP_HOSTED=true). Off by default, so every existing stdio and HTTP
 * setup behaves exactly as before. When on: each session keeps its own drafts and project, tools never
 * read or write files on the server (users cannot reach its disk), and reports come back as links.
 */
export const resolveHosted = (env: NodeJS.ProcessEnv = process.env): boolean =>
  (env['QA_MCP_HOSTED'] ?? '').trim().toLowerCase() === 'true';

/** Value resolution is ON unless explicitly disabled (`off` / `0` / `false` / `no`). */
export const resolveValuesEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  !/^(off|0|false|no)$/i.test((env['QA_MCP_SQA_RESOLVE'] ?? '').trim());
