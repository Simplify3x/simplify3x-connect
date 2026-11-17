import { QaConnection } from './connection.js';

/**
 * The host allowlist exists for shared deployments: without it a client can point the gateway at any
 * address through baseUrl / url or `qa_connect`, making the server call arbitrary internal endpoints
 * from inside the network (SSRF). With QA_MCP_ALLOWED_HOSTS set, only those hosts are accepted — from
 * the request headers and from a runtime connect alike, because both go through connect().
 */
describe('outbound host allowlist', () => {
  const saved = process.env['QA_MCP_ALLOWED_HOSTS'];
  afterEach(() => {
    if (saved === undefined) delete process.env['QA_MCP_ALLOWED_HOSTS'];
    else process.env['QA_MCP_ALLOWED_HOSTS'] = saved;
  });

  const offline = () => new QaConnection({ mode: 'offline', caps: new Set(['tc']) } as never);

  it('refuses a backend outside the allowlist', async () => {
    process.env['QA_MCP_ALLOWED_HOSTS'] = 'sqa.corp.example';
    const res = await offline().connect({ token: 'k', baseUrl: 'https://evil.example.test', product: 'simplifyqa' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('not allowed');
      expect(res.error).toContain('sqa.corp.example');
    }
  });

  it('refuses an agent URL outside the allowlist', async () => {
    process.env['QA_MCP_ALLOWED_HOSTS'] = 'sqa.corp.example';
    const res = await offline().connect({ token: 'k', url: 'http://169.254.169.254/mcp', product: 'walnut' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('not allowed');
  });

  it('accepts a subdomain of an allowed host', async () => {
    process.env['QA_MCP_ALLOWED_HOSTS'] = 'corp.example';
    // The allowlist passes; the failure that follows is the network/validation one, never the host gate.
    const res = await offline().connect({ token: 'k', baseUrl: 'https://sqa.corp.example', product: 'simplifyqa' });
    if (!res.ok) expect(res.error).not.toContain('not allowed');
  });

  it('is off when the variable is unset', async () => {
    delete process.env['QA_MCP_ALLOWED_HOSTS'];
    const res = await offline().connect({ token: 'k', baseUrl: 'https://anything.example.test', product: 'simplifyqa' });
    if (!res.ok) expect(res.error).not.toContain('not allowed');
  });
});
