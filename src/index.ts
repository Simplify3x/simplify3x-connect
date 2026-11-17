#!/usr/bin/env node
/**
 * Standalone stdio entry point -- kept ONLY as a local dev harness for exercising
 * this tool surface with a real MCP stdio client (e.g. the MCP Inspector) without
 * going through the agent's HTTP mount. This is explicitly NOT part of the
 * product path:
 *   - not referenced by package.json's `bin` or `main`
 *   - not one of esbuild.config.js's entryPoints (only src/server.ts is bundled)
 *   - not imported from src/server.ts or src/routes/index.ts
 * The product path is src/mcp/qa/mount.ts, mounted at POST/GET/DELETE /mcp on the
 * agent's own Express app (see src/server.ts). Run this file directly only for
 * local debugging: `npx tsx src/mcp/qa/index.ts`.
 *
 * Simplified from the original common-qa-mcp CLI: drops the `commander`-based
 * --port/--connection/--caps flags (commander is not a declared dependency of
 * this repo, and adding one for a dev-only harness would violate the "costs
 * nothing" bar this file is held to). Configure via QA_MCP_* env vars instead
 * (see config.ts) -- functionally equivalent for local debugging.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';
import { resolveConfig, type QaConfig } from './config.js';
import { createAdapter } from './adapters/factory.js';
import { log, mask } from './log.js';

function loadConfig(): QaConfig {
  try {
    return resolveConfig(process.env);
  } catch (e) {
    log(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

const config = loadConfig();
if (config.mode === 'offline') {
  log('config resolved: mode=offline (no QA_MCP_URL/TOKEN/PROJECT_ID) -- draft authoring only, zero network');
} else {
  log(
    `config resolved: mode=connected provider=${config.provider ?? '(auto)'} url=${config.url} ` +
      `projectId=${config.projectId} token=${mask(config.token)}`,
  );
}

const adapter = createAdapter(config);
const server = buildServer({ adapter, mode: config.mode, walnutUiOrigin: config.walnutUiOrigin, agentUrl: config.agentUrl });
await server.connect(new StdioServerTransport());
log('stdio server ready');
