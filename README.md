# simplify3x-connect

One **product-neutral MCP** that any AI client (Claude Code, Cursor, Windsurf, VS Code, Codex,
Devin) connects to with a **URL + token** to drive the whole test-case lifecycle —
**discover · author · record · run · triage** — against **Walnut** or **SimplifyQA**. The client
sees one tool vocabulary regardless of the product behind it.

- npm: [`simplify3x-connect`](https://www.npmjs.com/package/simplify3x-connect)
- MCP Registry: `com.simplifyqa/simplify3x-connect`
- [Privacy policy](https://simplifyqa.ai/privacy) · [Terms](https://docs.simplifyqa.ai/legal-documents/end-user-license-agreement) · [Support](https://docs.simplifyqa.ai/need-support-connect-with-us)

## Quick install

You need your **SimplifyQA URL** and an **API token** from your SimplifyQA profile.

**Claude Code** (plugin, prompts for URL and token):

```
/plugin install simplify3x-connect --marketplace Simplify3x/simplify3x-connect
```

Or from your shell:

```bash
claude plugin marketplace add Simplify3x/simplify3x-connect
claude plugin install simplify3x-connect@simplify3x
```

**Claude Desktop:** download
[simplify3x-connect-0.28.1.mcpb](https://github.com/Simplify3x/simplify3x-connect/releases/download/v0.28.1/simplify3x-connect-0.28.1.mcpb)
and double-click it, or use **Settings → Extensions → Install extension**. Enter your URL and token
when asked. No Node.js or npm needed.

**Codex CLI:**

```bash
codex mcp add simplify3x-connect --env QA_MCP_PROVIDER=simplifyqa --env QA_BASE_URL=https://<your-simplifyqa> --env QA_MCP_TOKEN=<your-token> -- npx -y simplify3x-connect
```

**Cursor, VS Code, Windsurf, Devin and others:** add the JSON config in [Install](#install) below to
the client's MCP settings, with `QA_MCP_PROVIDER` set to `simplifyqa`.

## Install

Nothing to clone or build — clients launch it over stdio with `npx`. Requires **Node ≥ 20**.

Add it to your client's MCP config (`.mcp.json` for Claude Code / Cursor / Windsurf):

```json
{
  "mcpServers": {
    "simplify3x-connect": {
      "command": "npx",
      "args": ["-y", "simplify3x-connect"],
      "env": {
        "QA_MCP_PROVIDER": "walnut",
        "QA_BASE_URL": "https://<your-backend>",
        "QA_MCP_URL": "http://127.0.0.1:4050/mcp",
        "QA_MCP_TOKEN": "<your-token>",
        "QA_MCP_PROJECT_ID": "<optional-project-id>"
      }
    }
  }
}
```

| Env var | Required | Purpose |
|---|:---:|---|
| `QA_MCP_PROVIDER` | — | `walnut` (default) or `simplifyqa`. |
| `QA_BASE_URL` | ✓\* | Product **backend REST** — drives discover / author / run / triage (no agent needed). |
| `QA_MCP_URL` | ✓\* | Your **local agent's `/mcp`** — adds **recording** + journal editing (browser / mainframe). |
| `QA_MCP_TOKEN` | ✓ | Raw auth token (JWT — **no** `Bearer` prefix). |
| `QA_MCP_PROJECT_ID` | — | Pin a default project; omit and you'll be asked (change anytime with `qa_switch_project`). |

\* Set **`QA_BASE_URL`** for the lifecycle over direct REST, and **`QA_MCP_URL`** to add recording.
Set **both** for the full experience, or only `QA_BASE_URL` for a zero-agent setup (no recording).
With **neither** set it starts **offline** — draft authoring only — and you connect later from chat
with `qa_connect`.

> **Recording** (`web` / `mainframe`/ `mobile`) runs on the local agent, so `QA_MCP_URL` must point at a
> **running** agent. 


## Run it as a server (HTTP)

The stdio entry is for a single developer's client. To serve several clients from one machine or a
container, run the gateway:

```bash
npm run build
HOST=0.0.0.0 PORT=4060 npm run start:http
# simplify3x-connect gateway ready on http://0.0.0.0:4060/mcp
# health: http://0.0.0.0:4060/health  ready: http://0.0.0.0:4060/ready
```

Point any Streamable-HTTP MCP client at `http://<host>:4060/mcp`.

### Authentication

Two independent controls, because they answer different questions:

| Variable | Answers | Effect |
|---|---|---|
| `QA_MCP_GATEWAY_TOKEN` | may this caller reach the MCP at all? | shared secret; `/mcp` rejects anything else with 401 + `WWW-Authenticate` |
| `QA_MCP_REQUIRE_CLIENT_TOKEN=true` | who is this caller in the product? | every request must carry its own product token (`Authorization` / `x-qa-token`), and the session connects with it |

With per-user mode on, put the gateway secret in `x-gateway-token` so it does not collide with the
product token in `Authorization`.

**Nothing secret is ever logged.** `mask()` reports only whether a token is set, every line written by
the shared `log()` sink is pattern-redacted (Bearer credentials, JWTs, provider API keys,
`token=`/`password=` forms), and the resolved token is registered with the file logger so even a raw
`WALNUT_LOG_FILE` line cannot contain it. `DEBUG=1` goes through the same redaction.

**Each MCP session gets its own connection and adapter.** One user's `qa_connect`, project switch or
token can never affect another session — the behaviour that made a shared gateway unsafe. The draft
store is still shared so a draft survives a reconnect.

### Restrict where the server may call

`QA_MCP_ALLOWED_HOSTS=sqa.corp.example,agent.corp.example` limits both the startup configuration and
every runtime `qa_connect` to those hosts (subdomains included). Without it, a client can point the
gateway at any address through `baseUrl` / `url`, which is a server-side request forgery risk on a
shared deployment.

### Running more than one replica

The HTTP transport is stateful: sessions and drafts live in memory, so run a single replica or use
sticky routing keyed on `mcp-session-id`. Idle sessions are evicted after
`QA_MCP_SESSION_TTL_MS` (default 30 minutes), and a hard cap of `QA_MCP_MAX_SESSIONS` (default 200)
drops the least recently used. Request bodies are capped by `QA_MCP_MAX_BODY_BYTES` (1 MB).

Behind a proxy, disable response buffering for the SSE stream (`proxy_buffering off`,
`X-Accel-Buffering: no`, a read timeout of at least five minutes). `GET /mcp` without a session
returns 404 by design so a client re-initializes; use `/health` and `/ready` for probes, never `/mcp`.

## Install the QA agent (optional)

Drops a QA persona + tool guidance into your project so the client knows how to drive these tools:

```bash
npx simplify3x-connect init-agents --loop=claude   # claude | cursor | windsurf | vscode | codex | devin | all
#   --server-name <name>   # must match your MCP server name (default: simplify3x-connect)
```

## Use it

Reload your client, then drive it in plain language:

- _"List my projects"_ → _"switch to project X"_
- _"Record a login test on web"_ → answer the setup questions → review the draft → _"save it"_
- _"Run TC_123 on cloud"_ · _"show me the login stories"_ · _"add a loop around steps 3–5 of TC_42"_
