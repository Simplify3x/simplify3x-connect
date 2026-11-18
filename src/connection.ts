/**
 * The live backend connection: URL + token supplied AT RUNTIME by the user.
 *
 * WHY THIS EXISTS. `resolveConfig()` reads credentials once, from the environment or
 * `~/.common-qa-mcp/config.json`, and `createAdapter()` is called once at mount -- so connecting
 * meant restarting the agent with env vars set. That is the wrong shape for the product: an AI
 * client is supposed to connect by handing the MCP an app URL and a token, in conversation
 * ("connect to https://… with this token"), and switch project or org without a restart.
 *
 * So the resolved config becomes the STARTING point and this holder owns what is current. Tools
 * read `connection.adapter()` per call instead of closing over one built at mount; when there are
 * no credentials it is `null` and the offline authoring path (record -> preview -> draft, no
 * backend, no network) works exactly as before -- that mode is the whole verified surface and must
 * never require a token.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *  - No credential on disk. The TOKEN lives in memory for the life of the process. Persisting it
 *    would put a credential in a file this feature has no mandate to manage; `~/.common-qa-mcp/
 *    config.json` already exists for users who WANT that, and it is still read at boot. (The
 *    last-selected projectId — a NON-secret id — IS remembered across restarts via projectStore,
 *    so a client relaunch doesn't drop you back to project-less; the token is never written.)
 *  - No logging of the token, ever -- `describe()` reports its presence and length, nothing else.
 *  - No optimistic accept: `connect()` VALIDATES against the backend and keeps the previous
 *    connection when validation fails, so a typo cannot silently break a working session.
 *
 * SCOPE: process-wide, not per MCP client. The agent is a single-user local process (loopback-bound,
 * one desktop user), so one current connection is the honest model; two AI clients pointed at
 * different orgs through the same agent would share it. Documented rather than pretended away.
 */

import { createAdapter } from './adapters/factory.js';
import type { ProviderAdapter } from './adapters/types.js';
import type { ConnectedQaConfig, QaConfig } from './config.js';
import { jwtStringClaim, looksLikeJwt } from './config.js';
import { readLastProject, writeLastProject } from './projectStore.js';
import { addCredential, createLogger } from './vendor/logger.js';

const logger = createLogger('QaConnection');

export interface ConnectRequest {
  /** The MCP endpoint to hop to: the local agent `/mcp` (walnut recording) or the SimplifyQA `/mcp`.
   *  OPTIONAL for a walnut DIRECT connection — pass `baseUrl` (the backend) instead/as well. */
  url?: string;
  /** Bearer token: a Walnut session JWT, or an MCP API key. */
  token: string;
  /** Required for a JWT (the token alone carries no project context); optional for an API key,
   *  which is already project-scoped server-side. */
  projectId?: string;
  /** `jwt` (default) sends `Authorization` + `x-project-id`; `key` sends only `Authorization`.
   *  Mirrors WalnutAdapter.headers(). */
  auth?: 'jwt' | 'key';
  /** Which product to route to. `walnut` (default) uses the in-process Walnut adapter (REST);
   *  `simplifyqa` routes to the SQA agent MCP (a remote MCP) — `url` is then its /mcp endpoint. */
  product?: 'walnut' | 'simplifyqa';
  /** Product base URL. Forwarded as `x-qa-base-url` to the product MCP (Walnut or SimplifyQA) so
   *  its backend REST calls have a base — for tokens without a JWT `url` claim. */
  baseUrl?: string;
}

export interface ConnectionDescription {
  mode: 'offline' | 'connected';
  url?: string;
  projectId?: string;
  auth?: 'jwt' | 'key';
  /** Presence + length only. The value is never logged or returned. */
  token?: string;
  /** Where the current credentials came from, so a user can tell a stale env var from what they
   *  just typed. */
  source: 'none' | 'startup-config' | 'runtime-connect';
}

/** Read QA_MCP_ALLOWED_HOSTS (comma-separated). Empty/absent means "no allowlist". */
function allowedHosts(): string[] {
  return String(process.env['QA_MCP_ALLOWED_HOSTS'] ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** Returns an error message when a target host is outside the allowlist, else null. */
function hostNotAllowed(...urls: Array<string | undefined>): string | null {
  const allow = allowedHosts();
  if (!allow.length) return null;
  for (const raw of urls) {
    if (!raw) continue;
    let host: string;
    try { host = new URL(raw).hostname.toLowerCase(); } catch { continue; }
    if (!allow.some((a) => host === a || host.endsWith(`.${a}`))) {
      return `Host "${host}" is not allowed. Allowed hosts: ${allow.join(', ')} (QA_MCP_ALLOWED_HOSTS).`;
    }
  }
  return null;
}

export class QaConnection {
  private current: QaConfig;
  private source: ConnectionDescription['source'];
  private cached: ProviderAdapter | null;
  /** The config the adapter in `cached` was built from -- rebuild only when it actually changes. */
  private cachedFor: QaConfig | null = null;

  /** `rememberProject: false` on a shared server: never restore or persist the last project, because
   *  that file is shared by every session on the pod. Each session then picks its project in chat. */
  constructor(private readonly startup: QaConfig, private readonly rememberProject = true) {
    this.current = startup;
    this.source = startup.mode === 'connected' ? 'startup-config' : 'none';
    this.cached = null;
    // Restore the last-selected project across restarts. The startup config carries url + token
    // but usually NO project, so a client relaunch otherwise drops the connection back to
    // project-less — which breaks downstream per-project model resolution for AI recording. If we
    // booted connected to a backend we have a remembered project for, adopt it. Optimistic (no
    // async validate here): the id was validated when it was saved via switchProject/connect; if it
    // is since stale, project-scoped calls fail cleanly and the user can switch — the connection
    // itself is fine.
    if (rememberProject && startup.mode === 'connected' && !startup.projectId) {
      // Key the remembered project by the effective backend base: `url` (agent /mcp) for the
      // legacy/SQA forwarder, else `baseUrl` (QA_BASE_URL) for the direct walnut path.
      const key = startup.url ?? startup.baseUrl ?? '';
      const remembered = readLastProject(key);
      if (remembered) {
        this.current = { ...startup, projectId: remembered };
        logger.info(`Restored last-selected project ${remembered} for ${key}`);
      }
    }
  }

  /** The adapter for the CURRENT credentials, or null when offline. Call per request. */
  adapter(): ProviderAdapter | null {
    if (this.cachedFor === this.current) return this.cached;
    this.cached = createAdapter(this.current);
    this.cachedFor = this.current;
    return this.cached;
  }

  config(): QaConfig {
    return this.current;
  }

  describe(): ConnectionDescription {
    const c = this.current;
    if (c.mode !== 'connected') return { mode: 'offline', source: this.source };
    // The effective backend base: `url` (agent /mcp) for the legacy/SQA forwarder, else `baseUrl`
    // (QA_BASE_URL) for the direct walnut path. Omitted entirely if somehow neither is set.
    const effectiveUrl = c.url ?? c.baseUrl;
    return {
      mode: 'connected',
      ...(effectiveUrl ? { url: effectiveUrl } : {}),
      projectId: c.projectId ?? '', // '' = connected but no project selected yet
      auth: c.walnutAuth === 'key' ? 'key' : 'jwt',
      token: `present (${c.token.length} chars)`,
      source: this.source,
    };
  }

  /**
   * Validate `req` against the backend and adopt it on success.
   *
   * Validation is `adapter.info()` -- `GET /api/projects/:id` -- which is the one call that proves
   * all three parts at once: the URL is reachable, the token is accepted, and the project exists
   * and is visible to that token. On failure NOTHING changes.
   */
  async connect(req: ConnectRequest): Promise<{ ok: true; info: unknown } | { ok: false; error: string }> {
    // Tolerate a pasted/`headers.Authorization`-style "Bearer <token>": the field is labelled
    // "Bearer token" and MCP-client header values carry the scheme, but we add `Bearer ` ourselves
    // downstream -- so keep only the raw credential and never send "Bearer Bearer ...".
    const token = (req.token ?? '').trim().replace(/^Bearer\s+/i, '').trim();
    const url = req.url?.trim();
    const baseUrl = req.baseUrl?.trim().replace(/\/+$/, '');
    const product: 'walnut' | 'simplifyqa' = req.product === 'simplifyqa' ? 'simplifyqa' : 'walnut';

    if (!token) return { ok: false, error: 'token is required.' };
    // A caller's token (header or qa_connect) is scrubbed from every log line by exact value, like the
    // startup token. ponytail: the redaction set only grows; fine for per-user keys at hosted scale.
    addCredential(token);
    // A connection needs an endpoint. `baseUrl` (QA_BASE_URL) is the product BACKEND REST base for
    // direct data ops; `url` (QA_MCP_URL) is an MCP endpoint to hop to — the local agent (recording,
    // not-yet-ported writes). SimplifyQA specifically must have baseUrl (or a JWT embedding `url`)
    // so common tools (list_projects, tc_list, …) speak SQA REST directly and don't require the
    // agent to be running.
    if (product === 'simplifyqa' && !baseUrl && !jwtStringClaim(token, 'url')) {
      return {
        ok: false,
        error:
          'SimplifyQA needs a base URL: pass baseUrl=<your SimplifyQA URL>, or use a JWT that ' +
          'embeds the "url" claim. The agent url alone is not enough — read-only tools ' +
          '(list_projects, tc_list, story_list, …) call the SimplifyQA backend directly and should ' +
          'keep working even when the local agent is off.',
      };
    }
    if (!url && !baseUrl) {
      return { ok: false, error: 'Provide baseUrl (the product backend) and/or url (the agent /mcp) — at least one is required.' };
    }
    if (url && !/^https?:\/\//i.test(url)) {
      return { ok: false, error: `url must be absolute and start with http:// or https:// — got "${url}".` };
    }
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
      return { ok: false, error: `baseUrl must be absolute and start with http:// or https:// — got "${baseUrl}".` };
    }

    // HOST ALLOWLIST. On a shared server a client can otherwise point the gateway at any address
    // through baseUrl / url (or qa_connect), making the pod call arbitrary internal endpoints. When
    // QA_MCP_ALLOWED_HOSTS is set, only those hosts are accepted — from the headers AND from qa_connect.
    const notAllowed = hostNotAllowed(url, baseUrl);
    if (notAllowed) return { ok: false, error: notAllowed };

    // Auth mode: explicit wins; else auto-detect from the token shape (JWT vs key) — same rule as the
    // startup config (config.ts looksLikeJwt). A JWT sends x-project-id; a key sends Authorization only.
    const auth: 'jwt' | 'key' = req.auth === 'key' ? 'key' : req.auth === 'jwt' ? 'jwt' : (looksLikeJwt(token) ? 'jwt' : 'key');
    const projectId = req.projectId?.trim() ?? '';
    // The JWT-needs-projectId rule is Walnut-specific (it sends x-project-id). SQA forwards the token
    // to its own MCP, which resolves tenant context however it likes, so we don't force it there.
    if (product === 'walnut' && auth === 'jwt' && !projectId) {
      return {
        ok: false,
        error: 'projectId is required with a JWT (the token alone carries no project context). '
          + 'Pass projectId, or auth:"key" if this is an MCP API key.',
      };
    }

    const candidate: ConnectedQaConfig = {
      ...(this.startup as ConnectedQaConfig),
      mode: 'connected',
      provider: product,
      token,
      // An API key is project-scoped server-side; keep whatever the startup config had so
      // project-scoped helpers still have something to name, but never require it.
      projectId: projectId || (this.startup.projectId ?? ''),
      walnutAuth: auth,
      ...(url ? { url: url.replace(/\/+$/, '') } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    };

    const probe = createAdapter(candidate);
    if (!probe) return { ok: false, error: `Could not build an adapter for product "${product}".` };
    try {
      const info = await probe.info();
      this.current = candidate;
      this.cached = probe;
      this.cachedFor = candidate;
      this.source = 'runtime-connect';
      // Remember the project so a later restart reboots into it (see projectStore). Only when one
      // was actually chosen — a key-scoped connect may carry none.
      if (this.rememberProject && candidate.projectId) writeLastProject(candidate.url ?? candidate.baseUrl ?? '', candidate.projectId);
      // URL and project only -- never the token, not even truncated.
      logger.info(`Connected to ${candidate.url ?? candidate.baseUrl} (project ${candidate.projectId || '(key-scoped)'}, auth ${auth})`);
      return { ok: true, info };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`connect rejected for ${url}: ${message}`);
      return { ok: false, error: message };
    }
  }

  /**
   * Switch to a different project on the CURRENT connection -- same url/token/product/auth, only the
   * projectId changes. Reuses connect()'s validate-before-adopt contract (probe.info()), so a bad id
   * leaves the working connection untouched. Requires a connected session; offline callers are told
   * to qa_connect first. Lets an AI client change project WITHOUT re-sending credentials.
   */
  async switchProject(projectId: string): Promise<{ ok: true; info: unknown } | { ok: false; error: string }> {
    const pid = projectId?.trim();
    if (!pid) return { ok: false, error: 'projectId is required.' };
    const c = this.current;
    if (c.mode !== 'connected') {
      return { ok: false, error: 'Not connected — use qa_connect first, then switch project.' };
    }
    const candidate: ConnectedQaConfig = { ...c, projectId: pid };
    const probe = createAdapter(candidate);
    if (!probe) return { ok: false, error: `Could not build an adapter for project "${pid}".` };
    try {
      const info = await probe.info();
      this.current = candidate;
      this.cached = probe;
      this.cachedFor = candidate;
      this.source = 'runtime-connect';
      // Remember it so a restart reboots into this project instead of project-less (projectStore).
      if (this.rememberProject) writeLastProject(candidate.url ?? candidate.baseUrl ?? '', pid);
      logger.info(`Switched to project ${pid}`);
      return { ok: true, info };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`switchProject rejected for ${pid}: ${message}`);
      return { ok: false, error: message };
    }
  }

  /** Back to the credentials the process started with (usually none). Offline authoring is
   *  unaffected either way -- it never used a connection. */
  disconnect(): void {
    this.current = this.startup;
    this.source = this.startup.mode === 'connected' ? 'startup-config' : 'none';
    this.cached = null;
    this.cachedFor = null;
    logger.info('Disconnected — back to the startup configuration');
  }
}
