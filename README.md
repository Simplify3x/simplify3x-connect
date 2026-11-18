# Simplify3x Connect

An MCP server that lets AI clients work with **SimplifyQA** in plain language: find projects and
test cases, author and edit them, record new ones, run them, and triage failures.

Works with any MCP client (Claude Code, Cursor, Windsurf, VS Code, Codex, Devin) over **stdio** or
**Streamable HTTP**.

- npm: [`simplify3x-connect`](https://www.npmjs.com/package/simplify3x-connect)
- MCP Registry: `com.simplifyqa/simplify3x-connect`
- [Privacy policy](https://simplifyqa.ai/privacy) · [Terms](https://docs.simplifyqa.ai/legal-documents/end-user-license-agreement) · [Support](https://docs.simplifyqa.ai/need-support-connect-with-us)

## Quick install

You need your **SimplifyQA URL** and an **API token** from your SimplifyQA profile.

**Claude Code** (plugin, prompts for URL and token):

```
/plugin install simplify3x-connect --marketplace Simplify3x/simplify3x-connect
```

**Claude Desktop:** download
[simplify3x-connect-0.31.1.mcpb](https://github.com/Simplify3x/simplify3x-connect/releases/download/v0.31.1/simplify3x-connect-0.31.1.mcpb)
and double-click it, or use **Settings → Extensions → Install extension**. Enter your URL and token
when asked. No Node.js or npm needed.

**Codex CLI:**

```bash
codex mcp add simplify3x-connect --env QA_MCP_PROVIDER=simplifyqa --env QA_BASE_URL=https://<your-simplifyqa> --env QA_MCP_TOKEN=<your-token> -- npx -y simplify3x-connect
```

**Cursor, VS Code, Windsurf, Devin and others:** add the JSON config in [Install](#install) below.

---

## Requirements

- **Node.js 20 or newer**
- A SimplifyQA account and an API token
- Optional: the SimplifyQA desktop agent, only if you want to **record** test cases

---

## Install

Nothing to clone or build. Clients launch the package over stdio with `npx`.

Add this to your client's MCP config (`.mcp.json` for Claude Code, Cursor or Windsurf):

```json
{
  "mcpServers": {
    "simplify3x-connect": {
      "command": "npx",
      "args": ["-y", "simplify3x-connect"],
      "env": {
        "QA_MCP_PROVIDER": "simplifyqa",
        "QA_BASE_URL": "https://<your-simplifyqa-url>",
        "QA_MCP_TOKEN": "<your-api-token>",
        "QA_MCP_PROJECT_ID": "<optional-project-id>"
      }
    }
  }
}
```

Reload the client and the QA tools appear.

---

## Configuration

Only three values are required. Everything else has a sensible default in `src/defaults.ts`.

| Variable | Required | Purpose |
|---|:---:|---|
| `QA_MCP_PROVIDER` | ✓ | Backend to use. Set `simplifyqa`. |
| `QA_BASE_URL` | ✓ | Your SimplifyQA URL. |
| `QA_MCP_TOKEN` | ✓ | API token, raw — no `Bearer` prefix. Keep it in Vault. |

Override these only when you need to:

| Variable | Default |
|---|---|
| `QA_MCP_PROJECT_ID` | none — the assistant asks which project to use |
| `QA_MCP_CAPS` | `tc,suites,runs,objects,alm` |
| `QA_HTTP_TIMEOUT_MS` | `30000` |
| `QA_MCP_SESSION_TTL_MS` · `QA_MCP_MAX_SESSIONS` · `QA_MCP_MAX_BODY_BYTES` | `30m` · `200` · `1 MB` |
| `QA_MCP_URL` | none — needed only on a desktop install, for recording |

The caller's identity is taken from the token (`userId` claim, else the backend's `/pm/auth/me`); there
is nothing to configure for it.

With no credentials at all the server starts **offline**: drafts and editing work, nothing is sent
anywhere, and you can connect later from chat.

---

## Recording (optional)

Recording drives a real browser, device or terminal, so it runs on the **SimplifyQA desktop agent**
on your machine, not inside the MCP server. Point `QA_MCP_URL` at that agent and the recording tools
appear automatically.

You describe the test, confirm the setup details the assistant asks for, and review the captured
steps in the recorder window. Nothing is saved until you click **Save Testcase** there.

---

## Run it as a server (HTTP)

Use this to serve several clients from one machine or a container.

```bash
npm ci
npm run build
HOST=0.0.0.0 PORT=4060 npm run start:http
# simplify3x-connect gateway ready on http://0.0.0.0:4060/mcp
# health: http://0.0.0.0:4060/health  ready: http://0.0.0.0:4060/ready
```

Point any Streamable-HTTP MCP client at `http://<host>:4060/mcp`.

### Authentication

Two separate controls, because they answer different questions:

| Variable | Question | Behaviour |
|---|---|---|
| `QA_MCP_GATEWAY_TOKEN` | may this caller reach the server at all? | shared secret; anything else gets `401` with `WWW-Authenticate` |
| `QA_MCP_REQUIRE_CLIENT_TOKEN=true` | who is this caller in SimplifyQA? | every request must carry its own token, and that session connects with it; `QA_MCP_TOKEN` and `QA_MCP_USER_ID` are ignored, and the backend is always `QA_BASE_URL` (a caller's `x-qa-base-url` is ignored) |

With per-user mode on, send the gateway secret in `x-gateway-token` so it does not collide with the
product token in `Authorization`.

**Each session gets its own connection.** One user's token, `qa_connect` or project switch never
affects another session.

### Shared deployment

Set `QA_MCP_HOSTED=true` on a server that several users share. It is off by default, so a local
setup behaves as before. When on:

- each session keeps its own drafts and chooses its own project; nothing is shared between users
- `attachment_add` accepts only `base64` content, never a path on the server
- `attachment_download` is refused; users download attachments in SimplifyQA
- `report_download` returns the SimplifyQA report page link instead of saving PDFs on the server

Nothing is written to disk except heal plans, so no persistent volume is needed.

### Restrict where the server may call

```bash
QA_MCP_ALLOWED_HOSTS=sqa.example.com,agent.example.com
```

Limits both the startup configuration and every runtime connect to those hosts (subdomains
included). Recommended on any shared deployment.

### Operations

- **One replica.** Sessions and drafts live in memory, so run a single replica or use sticky routing
  keyed on `mcp-session-id`.
- **Probes.** Use `/health` (liveness) and `/ready` (readiness), never `/mcp`; a session-less `GET`
  on `/mcp` answers `404` by design so clients re-initialize.
- **Idle sessions** are evicted after `QA_MCP_SESSION_TTL_MS` (default 30 minutes), capped at
  `QA_MCP_MAX_SESSIONS` (default 200), with request bodies limited by `QA_MCP_MAX_BODY_BYTES` (1 MB).
- **Proxy.** Disable response buffering for the SSE stream (`proxy_buffering off`,
  `X-Accel-Buffering: no`) and allow a read timeout of at least five minutes.

### Secrets are never logged

Every log line passes through redaction: credentials in `Bearer` form, JWTs, provider API keys and
`token=`/`password=` values are removed, and the configured token is registered so even a raw line
cannot contain it. `DEBUG` output goes through the same filter.

---

## Install the QA persona (optional)

Writes a QA persona and tool guidance into your project, so the assistant knows how to drive these
tools:

```bash
npx simplify3x-connect init-agents --loop=claude   # claude | cursor | windsurf | vscode | codex | devin | all
#   --server-name <name>   # must match your MCP server name (default: simplify3x-connect)
```

---

## Use it

Reload your client, then work in plain language:

- *"List my projects"* → *"switch to the Payments project"*
- *"Show the test cases in module 12"* → *"open TC-42"*
- *"Create a test case for checkout with a saved card"* → review the draft → *"save it"*
- *"Add a step at position 3 of TC-42 that waits five seconds"*
- *"Run TC-40 on QA"* · *"run suite SU-7"* · *"why did TC-42 fail?"*
- *"Record a login test on the web"* → answer the setup questions → review → *"save it"*

---

## Development

```bash
npm ci
npm run build          # tsc -> dist/
npm test               # jest, 66 suites / 514 tests
npm run test:coverage  # jest --coverage
npm run dev            # stdio from source (tsx)
npm run dev:http       # HTTP from source, watching
```

`npm run start` serves stdio from `dist/`; `npm run start:http` serves HTTP from `dist/`.

---

## Releasing

The version lives in exactly one place you edit: `package.json`. `scripts/sync-version.mjs` copies it
into `src/version.ts`, and a test fails if the two ever disagree.

```bash
npm version patch        # or minor / major / an explicit version
npm publish
git push --follow-tags
```

`npm version` updates both files, commits and tags. `prepublishOnly` builds, so the published
`dist/` always matches the manifest. Only `dist/` ships, plus this README and the license.

---

## License

MIT. See [LICENSE](LICENSE).
