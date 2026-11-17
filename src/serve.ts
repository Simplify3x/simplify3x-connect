import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';
import { QaConnection } from './connection.js';
import { DraftStore } from './drafts/store.js';
import { createAdapter } from './adapters/factory.js';
import { resolveConfig } from './config.js';
import { log, mask } from './log.js';

/**
 * The PRODUCT stdio entry — what `simplify3x-connect` (or `simplify3x-connect serve`) runs when an AI client
 * launches it over stdio (the npx path). Mirrors mount.ts's HTTP wiring (a live QaConnection so
 * qa_connect works + a shared DraftStore so drafts survive across a session) but the transport is
 * stdio and the connection is primed from the `QA_MCP_*` env the client passes in its mcp config —
 * there are no HTTP headers over stdio. All logging goes to STDERR (log.ts); stdout is the MCP
 * transport itself and must stay clean.
 */
export async function startStdioServer(): Promise<void> {
  const config = resolveConfig(process.env);
  const connection = new QaConnection(config);
  const server = buildServer({
    adapter: createAdapter(config),
    connection,
    mode: config.mode,
    drafts: new DraftStore(),
    walnutUiOrigin: config.walnutUiOrigin,
    agentUrl: config.agentUrl,
    // No Electron window in the standalone CLI — tc_draft_open just returns the editor link.
    openEditorWindow: async () => false,
  });
  await server.connect(new StdioServerTransport());
  if (config.mode === 'offline') {
    log('stdio server ready — offline (draft authoring only; set QA_MCP_URL / QA_MCP_TOKEN / QA_MCP_PROJECT_ID to connect)');
  } else {
    log(`stdio server ready — product=${config.provider ?? 'walnut'} url=${config.url} project=${config.projectId} token=${mask(config.token)}`);
  }
}
