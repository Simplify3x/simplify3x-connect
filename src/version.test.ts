import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { VERSION } from './version.js';
import { buildServer } from './server.js';

/**
 * Guards the release-time drift we actually hit: `npm version` bumps package.json only, so the
 * version announced to clients stayed at the previous number while the package on npm moved on.
 */
// Jest runs from the repo root, so cwd is the package root (import.meta is not available under the
// test tsconfig's module setting).
const packageJson = (): { version: string } =>
  JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { version: string };

describe('reported version', () => {
  it('matches package.json', () => {
    expect(VERSION).toBe(packageJson().version);
  });

  it('is the version the MCP server actually announces', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const previous = process.env['QA_MCP_PROVIDER'];
    process.env['QA_MCP_PROVIDER'] = 'simplifyqa';
    const server = buildServer({ adapter: null, mode: 'offline', openEditorWindow: async () => false });
    await server.connect(st);

    const client = new Client({ name: 'version-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(ct);
    const info = client.getServerVersion();
    await client.close();

    if (previous === undefined) delete process.env['QA_MCP_PROVIDER'];
    else process.env['QA_MCP_PROVIDER'] = previous;

    expect(info?.name).toBe('simplify3x-connect');
    expect(info?.version).toBe(VERSION);
  });
});
