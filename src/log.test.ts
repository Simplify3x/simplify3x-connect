import { log, mask, redact } from './log.js';

/**
 * Tokens and headers must never reach a log line, with DEBUG on or a log file configured. These tests
 * pin the three guarantees: `mask()` reveals nothing, `redact()` strips credential-shaped text, and
 * the shared `log()` sink scrubs whatever it is given.
 */
describe('log redaction', () => {
  it('mask reports only presence, never any part of the value', () => {
    const token = 'super-secret-token-value';
    expect(mask(token)).toBe('(redacted)');
    expect(mask(token)).not.toContain('super');
    expect(mask(token)).not.toContain(token.slice(0, 6));
    expect(mask(undefined)).toBe('(unset)');
    expect(mask('')).toBe('(unset)');
  });

  it('strips a Bearer credential', () => {
    expect(redact('Authorization: Bearer abcdefghijklmnop1234')).not.toContain('abcdefghijklmnop1234');
    expect(redact('Authorization: Bearer abcdefghijklmnop1234')).toContain('Bearer ***');
  });

  it('strips a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = redact(`token payload ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain('***JWT***');
  });

  it('strips provider-style API keys', () => {
    const out = redact('using sk-proj-abcdefghijklmnop1234567890 now');
    expect(out).not.toContain('sk-proj-abcdefghijklmnop1234567890');
    expect(out).toContain('***KEY***');
  });

  it('strips key=value and key: value forms', () => {
    expect(redact('token=abc123secret')).not.toContain('abc123secret');
    expect(redact('password: hunter2')).not.toContain('hunter2');
    expect(redact('apiKey=xyz987')).not.toContain('xyz987');
    expect(redact('authorization: Bearer zzzzzzzzzzzz')).not.toContain('zzzzzzzzzzzz');
  });

  it('does not mangle ordinary text', () => {
    expect(redact('project 42 · 12 steps · status PASSED')).toBe('project 42 · 12 steps · status PASSED');
  });

  it('scrubs whatever log() is given, including objects and Errors', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let emitted = '';
    try {
      log('connecting with Bearer abcdefghijklmnop1234');
      log({ authorization: 'Bearer abcdefghijklmnop1234', project: 7 });
      log(new Error('failed with token=abc123secret'));
      // Read the calls BEFORE mockRestore(), which also clears them.
      emitted = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    } finally {
      spy.mockRestore();
    }
    expect(emitted).not.toContain('abcdefghijklmnop1234');
    expect(emitted).not.toContain('abc123secret');
    expect(emitted).toContain('project');
  });
});
