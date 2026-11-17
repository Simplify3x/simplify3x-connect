import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addCredential, createLogger } from './logger.js';

/**
 * The file log is the risky path: WALNUT_LOG_FILE keeps lines on disk indefinitely, and DEBUG writes
 * verbose ones. This proves a token cannot land there, whether it arrives bare (registered credential)
 * or credential-shaped (Bearer / JWT / token=...).
 */
describe('file logging never stores a token', () => {
  const file = path.join(os.tmpdir(), `qa-mcp-log-test-${process.pid}.log`);

  beforeAll(() => {
    process.env['WALNUT_LOG_FILE'] = file;
    process.env['DEBUG'] = '1';
  });

  afterAll(() => {
    delete process.env['WALNUT_LOG_FILE'];
    delete process.env['DEBUG'];
    try { fs.unlinkSync(file); } catch { /* not created */ }
  });

  it('redacts a registered secret, a Bearer header and a token= value', () => {
    const log = createLogger('redaction-test');
    addCredential('bare-secret-value-123');

    log.info('token=%s', 'bare-secret-value-123');
    log.debug('Authorization: Bearer abcdefghijklmnop1234');
    log.error('connect failed for token=abc123secret');

    const written = fs.readFileSync(file, 'utf8');
    expect(written).not.toContain('bare-secret-value-123');
    expect(written).not.toContain('abcdefghijklmnop1234');
    expect(written).not.toContain('abc123secret');
    expect(written).toContain('***');
    // The diagnostic value survives, so the log stays useful.
    expect(written).toContain('connect failed for');
  });
});
