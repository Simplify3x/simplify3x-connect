import type { ProviderAdapter } from './types.js';
import type { ConnectedQaConfig, QaConfig } from '../config.js';
import { jwtStringClaim } from '../config.js';
import { RemoteMcpAdapter } from './remoteMcp/adapter.js';
import { WalnutAdapter } from './walnut/adapter.js';
import { SimplifyQaAdapter } from './simplifyqa/adapter.js';

/**
 * Builds the adapter for the current connection (design note §3).
 *
 * Routing (non-breaking, purely additive):
 *  - offline → null (draft authoring needs no backend).
 *  - simplifyqa WITH a resolvable REST base (explicit `baseUrl` OR a JWT `url` claim on the token)
 *    → SimplifyQaAdapter: DIRECT to the SimplifyQA backend REST, plus an OPTIONAL agent hop
 *    (`config.url` = the local agent /mcp) for the recording surface + writes not yet ported.
 *  - simplifyqa WITHOUT any REST base → RemoteMcpAdapter (LEGACY pure-forwarder; existing configs
 *    that use only QA_MCP_URL keep working exactly as before).
 *  - walnut WITH `baseUrl` (QA_BASE_URL) → WalnutAdapter: DIRECT to the Walnut backend REST, plus an
 *    OPTIONAL agent hop (`config.url` = the local agent /mcp) for recording + save-with-editor. This
 *    lets a cloud editor with no local agent drive the whole lifecycle except recording.
 *  - walnut WITHOUT `baseUrl` (only `config.url` set) → RemoteMcpAdapter: the LEGACY pure-forwarder,
 *    so existing configs (QA_MCP_URL = agent, no QA_BASE_URL) keep working exactly as before.
 *
 * `WalnutAdapter` and `SimplifyQaAdapter` implement only their direct-REST subsets of
 * `ProviderAdapter` (writes / testdata / run dispatch / … are ported incrementally), so the cast
 * bridges the gap — unported ops on those adapters delegate to their agent hop when configured, or
 * throw a clear "not yet ported / configure the hop" error otherwise.
 */
export function createAdapter(config: QaConfig): ProviderAdapter | null {
  if (config.mode !== 'connected') return null;

  if (config.provider === 'simplifyqa') {
    // resolveConfig / QaConnection.connect() guarantee a REST base is resolvable for SQA — either
    // explicit `baseUrl` or a JWT `url` claim. No RemoteMcpAdapter fallback here: read-only common
    // tools (list_projects, tc_list, …) must always speak SQA REST directly so the local agent can
    // be off; only recording + not-yet-ported writes hop, and they fail cleanly per-tool.
    const restBase = resolveSqaBaseUrl(config);
    if (!restBase) {
      throw new Error(
        'SimplifyQA adapter needs a base URL (baseUrl or JWT `url` claim). This should have been ' +
          'caught by resolveConfig / connect — please re-check the connection.',
      );
    }
    const cfgWithBase: ConnectedQaConfig = restBase === config.baseUrl ? config : { ...config, baseUrl: restBase };
    return new SimplifyQaAdapter(cfgWithBase) as unknown as ProviderAdapter;
  }

  // walnut (the default): direct REST when a backend base is set, else the legacy forwarder.
  if (config.baseUrl) return new WalnutAdapter(config) as unknown as ProviderAdapter;
  return new RemoteMcpAdapter(config);
}

/** Resolve the REST base URL for SQA: explicit `cfg.baseUrl` wins; else the JWT's `url` claim
 *  (SQA tokens embed the base URL). Returns undefined if neither is available. */
function resolveSqaBaseUrl(cfg: ConnectedQaConfig): string | undefined {
  const explicit = cfg.baseUrl?.trim();
  if (explicit) return explicit;
  return jwtStringClaim(cfg.token, 'url');
}
