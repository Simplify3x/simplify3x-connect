/**
 * `qa_connect` / `qa_disconnect` / `qa_connection_status` -- the URL + token entry point.
 *
 * The product shape is: an AI client connects to this MCP and the USER hands it an app URL and a
 * token, in conversation. Before this, credentials came only from `QA_MCP_URL`/`QA_MCP_TOKEN`/
 * `QA_MCP_PROJECT_ID` read once at boot, so connecting -- or switching project or org -- meant
 * restarting the agent. See recording/../connection.ts for what the holder does and does not do
 * (memory only, never logged, validated before it is adopted).
 *
 * Offline authoring never needs any of this: recording, the live editor and drafts work with no
 * connection at all, and that is the mode this server boots into.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { QaConnection } from '../connection.js';
import { ok, err } from '../mcpResult.js';

export function registerConnectionTools(server: McpServer, connection: QaConnection): void {
  server.registerTool(
    'qa_connect',
    {
      title: 'Connect to a QA product',
      description:
        'Point this MCP at your QA product so it can work with EXISTING test cases -- list them, read ' +
        'their steps, modify them, and run them. Ask the user for their app URL and a token; do not ' +
        'guess either. The token is a product session JWT (then `projectId` is required, because the ' +
        'token alone carries no project context) or an MCP API key (then pass auth:"key" and ' +
        'projectId is optional -- a key is already project-scoped).\n\n' +
        'The connection is VALIDATED before it is accepted (it fetches the project), so a wrong URL, ' +
        'token or project fails here with the reason rather than surfacing later as a confusing ' +
        'error, and a failed attempt leaves any working connection untouched. It is kept in memory ' +
        'for as long as the agent runs and is never written to disk or logged.\n\n' +
        'NOT needed to record a new test case: recording, the live editor and drafts work offline ' +
        'with nothing configured.',
      inputSchema: {
        url: z.string().optional().describe('MCP endpoint to hop to — the product agent /mcp, used for recording and save-with-editor. OPTIONAL for a DIRECT (backend-REST) connection: pass `baseUrl` instead. Required when connecting through a remote product MCP. Must start with http:// or https://.'),
        token: z.string().min(1).describe('Bearer token: a product session JWT, or an MCP API key.'),
        projectId: z.string().optional().describe('Project id. REQUIRED with a JWT; optional with an API key.'),
        auth: z.enum(['jwt', 'key']).optional().describe('Token kind. Omit to AUTO-DETECT from the token (JWT-shaped → "jwt"). "jwt" sends Authorization + x-project-id; "key" sends Authorization only.'),
        product: z.enum(['walnut', 'simplifyqa']).optional().describe('Which product to route this connection to (the product selector; defaults to the primary product). For a remote product, also pass its agent MCP `/mcp` endpoint as `url`.'),
        baseUrl: z.string().optional().describe('The product BACKEND REST base (QA_BASE_URL) for DIRECT data ops (list/read/save/run). Provide this for a direct connection; `url` is only needed for recording / save-with-editor.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ url, token, projectId, auth, product, baseUrl }) => {
      const result = await connection.connect({
        token,
        ...(url !== undefined ? { url } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
        ...(auth !== undefined ? { auth } : {}),
        ...(product !== undefined ? { product } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
      });
      if (!result.ok) {
        return err(
          `Could not connect: ${result.error}\n\n` +
          'Nothing changed — any previous connection is still in place. Check the URL is the APP ' +
          'origin (not the API path), that the token is current, and that the project id belongs to ' +
          'the same org as the token.',
        );
      }
      const info = result.info as { provider?: string; projectName?: string; projectId?: string };
      return ok(
        `Connected to ${connection.describe().url} — project ${info?.projectName ?? '(unnamed)'} ` +
        `(${info?.projectId ?? projectId ?? 'key-scoped'}).\n` +
        'You can now list, read, modify and run existing test cases. Recording still works as before.',
        { connection: connection.describe(), info: result.info },
      );
    },
  );

  server.registerTool(
    'qa_switch_project',
    {
      title: 'Switch the connected project',
      description:
        'Switch to a different project on the SAME connection — reuses the current URL + token, so ' +
        'you do NOT re-enter them. Pass the project id; if the user names a project, resolve the name ' +
        'to an id first (SimplifyQA: sqa_query collection "projects" with member:true; Walnut: ' +
        'list_projects). Validated before it is adopted, so a bad id leaves the current project in place.',
      inputSchema: {
        projectId: z.string().min(1).describe('The project id to switch to. Find it by name with sqa_query collection "projects" (SimplifyQA) or list_projects (Walnut).'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ projectId }) => {
      const result = await connection.switchProject(projectId);
      if (!result.ok) {
        return err(`Could not switch project: ${result.error}\n\nThe current project is unchanged.`);
      }
      const info = result.info as { projectName?: string; projectId?: string };
      return ok(
        `Switched to project ${info?.projectName ?? '(unnamed)'} (${info?.projectId ?? projectId}). ` +
        'tc_list / tc_get now operate on this project.',
        { connection: connection.describe(), info: result.info },
      );
    },
  );

  server.registerTool(
    'qa_connection_status',
    {
      title: 'Show the current connection',
      description:
        'Report whether this MCP is connected to a QA product, which URL and project, how the ' +
        'credentials arrived (startup config vs qa_connect), and whether a token is present. Also ' +
        "reports whether the LOCAL desktop agent (/mcp, default :4040) is reachable — the process " +
        "that actually runs LOCAL executions on this machine. The token value itself is never returned.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const d = connection.describe();
      if (d.mode === 'offline') {
        return ok(
          'Offline — no backend connection. Recording, the live editor and drafts all work; ' +
          'listing, reading, modifying and running EXISTING test cases need qa_connect.',
          { connection: d },
        );
      }
      // Probe the desktop agent's /mcp so the model knows if LOCAL execution is possible without
      // having to attempt tc_run and read the failure. Providers with no local agent (walnut direct)
      // omit probeLocalAgent — leave the field undefined in that case.
      const adapter = connection.adapter();
      const localAgent: 'up' | 'down' | undefined = adapter?.probeLocalAgent
        ? (await adapter.probeLocalAgent()) ? 'up' : 'down'
        : undefined;
      const agentLine = localAgent === undefined
        ? ''
        : ` · local agent ${localAgent === 'up' ? 'UP' : 'DOWN — LOCAL runs will fail until you start the SimplifyQA desktop agent'}`;
      return ok(
        `Connected to ${d.url} · project ${d.projectId || '(key-scoped)'} · auth ${d.auth} · ` +
        `credentials from ${d.source === 'runtime-connect' ? 'qa_connect' : 'startup config'}` +
        agentLine,
        { connection: d, ...(localAgent !== undefined ? { localAgent } : {}) },
      );
    },
  );

  server.registerTool(
    'qa_disconnect',
    {
      title: 'Drop the connection',
      description:
        'Forget the runtime URL and token and fall back to whatever the agent started with (usually ' +
        'nothing). Use it before connecting to a different app or project, or to stop this MCP ' +
        'reaching a backend at all. Offline authoring is unaffected.',
      inputSchema: {},
      annotations: { readOnlyHint: false },
    },
    async () => {
      connection.disconnect();
      const d = connection.describe();
      return ok(
        d.mode === 'offline'
          ? 'Disconnected. No backend connection now — recording and drafts still work.'
          : `Disconnected the runtime credentials; back to the startup connection (${d.url}).`,
        { connection: d },
      );
    },
  );
}
