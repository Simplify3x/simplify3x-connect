import {
  DEFAULTS,
  resolveHost,
  resolveHttpTimeoutMs,
  resolveMaxBodyBytes,
  resolveMaxSessions,
  resolvePort,
  resolveSessionTtlMs,
  resolveValuesEnabled,
} from './defaults.js';

/**
 * These defaults are the reason `.env.example` only lists a handful of variables. If one of them
 * stops applying, every deployment that relied on the default changes behaviour silently.
 */
describe('code defaults', () => {
  const empty: NodeJS.ProcessEnv = {};

  it('applies when the environment is empty', () => {
    expect(resolveHost(empty)).toBe('127.0.0.1');
    expect(resolvePort(empty)).toBe(4060);
    expect(resolveHttpTimeoutMs(empty)).toBe(30_000);
    expect(resolveSessionTtlMs(empty)).toBe(1_800_000);
    expect(resolveMaxSessions(empty)).toBe(200);
    expect(resolveMaxBodyBytes(empty)).toBe(1_000_000);
    expect(resolveValuesEnabled(empty)).toBe(true);
  });

  it('still honours an explicit override', () => {
    expect(resolveHost({ HOST: '0.0.0.0' })).toBe('0.0.0.0');
    expect(resolvePort({ PORT: '5000' })).toBe(5000);
    expect(resolveHttpTimeoutMs({ QA_HTTP_TIMEOUT_MS: '60000' })).toBe(60_000);
    expect(resolveSessionTtlMs({ QA_MCP_SESSION_TTL_MS: '1000' })).toBe(1000);
    expect(resolveMaxSessions({ QA_MCP_MAX_SESSIONS: '5' })).toBe(5);
    expect(resolveMaxBodyBytes({ QA_MCP_MAX_BODY_BYTES: '2048' })).toBe(2048);
    expect(resolveValuesEnabled({ QA_MCP_SQA_RESOLVE: 'off' })).toBe(false);
    expect(resolveValuesEnabled({ QA_MCP_SQA_RESOLVE: '0' })).toBe(false);
  });

  it('ignores nonsense rather than booting with a broken number', () => {
    expect(resolvePort({ PORT: 'not-a-port' })).toBe(DEFAULTS.port);
    expect(resolvePort({ PORT: '-1' })).toBe(DEFAULTS.port);
    expect(resolveMaxSessions({ QA_MCP_MAX_SESSIONS: '0' })).toBe(DEFAULTS.maxSessions);
  });

  it('documents the default tool families', () => {
    expect([...DEFAULTS.caps]).toEqual(['tc', 'suites', 'runs', 'objects', 'alm']);
  });
});
