import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { DraftStore } from '../drafts/store.js';
import type { TestCase } from '../domain/types.js';
import { log } from '../log.js';
import { rememberRecordingName } from './recordingNames.js';

// One-shot confirm tokens for core_close_session. Minted on refusal, redeemed on the follow-up call,
// short TTL. Stops the LLM from self-authorising a discard: it must return the EXACT nonce the tool
// just handed it, which only happens if it goes back to the user, hears "close anyway", then calls
// again with the token. Process-scoped — matches DraftStore's lifetime.
const CLOSE_NONCE_TTL_MS = 5 * 60_000;
const closeNonces = new Map<string, number>();

function mintCloseNonce(): string {
  const nonce = randomBytes(12).toString('base64url');
  closeNonces.set(nonce, Date.now() + CLOSE_NONCE_TTL_MS);
  return nonce;
}

/** Single-use: if valid & unexpired, delete + return true. Also opportunistically prunes expired entries. */
function redeemCloseNonce(nonce: string): boolean {
  const now = Date.now();
  for (const [n, exp] of closeNonces) if (exp < now) closeNonces.delete(n);
  const exp = closeNonces.get(nonce);
  if (exp === undefined) return false;
  closeNonces.delete(nonce);
  return exp >= now;
}

/**
 * Bridges the product MCP's AGENT-BOUND recording surface (recording_start, browser_*, verify_*,
 * control_flow_marker, generate_test_steps, recording_steps/save/discard, ...) through the Common
 * MCP, so the client drives recording through the ONE door instead of connecting to the agent
 * directly. Common cannot implement these (they need the product's real browser); it FORWARDS each
 * call verbatim via `adapter.callRaw` and relays the result.
 *
 * The set is mirrored DYNAMICALLY from the product's own advertised tools (real names + descriptions,
 * so it never drifts), minus the provider-ops Common already wraps as its own client tools. It runs
 * async once the connection is live; registerTool emits tools/list_changed so the client picks the
 * proxies up (a /mcp reconnect also surfaces them).
 *
 * DELIBERATELY ROUGH (fix later, per plan): input schemas are permissive (the agent validates
 * strictly) rather than mirrored exactly; and recording_save creates a draft in the AGENT's store,
 * which Common's tc_save cannot see -- persisting a recorded test still needs a draft->tc_save bridge.
 */

/** Agent provider-ops Common already exposes as its own client tools -- NOT re-proxied. */
const PROVIDER_OPS = new Set([
  'info', 'list_projects', 'list_testcases', 'get_testcase', 'actions_catalog',
  'create_testcase', 'update_testcase', 'list_cloud_runners', 'start_run', 'get_run', 'stop_run',
]);

/**
 * The ONLY agent tools re-exposed to the client: the technology SUB-AGENT tools. Each is a DELEGATED
 * sub-agent (goal in; its own LLM loop over internal browser + recording tools; a saved draft out).
 * The granular tools (browser_*, recording_*, verify_*, store_run_variable, control_flow_marker,
 * generate_test_steps, qa_select_technology, qa_technology_status) stay INTERNAL to the sub-agents on
 * the product agent and are NOT proxied -- the client drives everything through web / android /
 * mainframe / db plus the lifecycle provider-ops. This is the "one door, smartness downstream" surface.
 */
const TECHNOLOGY_SUBAGENTS = new Set(['web', 'android', 'ios', 'mainframe', 'db']);

/**
 * The POLL half of a delegated recording. A delegated recorder is non-blocking — `web`/`mainframe`
 * return a sessionId and record in the background — so its `*_status` tool is as much part of the
 * client surface as the recorder itself, and each one needs the DRAFT BRIDGE (see
 * registerDelegatedStatus). Without its status tool a technology can START a recording that can never
 * be collected: the assembled draft stays in the AGENT's store, which Common's tc_save cannot see.
 *
 * Keep this in lockstep with the recorders in TECHNOLOGY_SUBAGENTS that are non-blocking. `db` is
 * absent because it is still a declared scaffold with no delegated loop to poll.
 */
const DELEGATED_STATUS_TOOLS = new Set([
  'web_status', 'mainframe_status', 'android_status', 'ios_status',
]);

/**
 * Read-only ENVIRONMENT-DISCOVERY tools a sub-agent exposes so the client can answer "what can I
 * record against?" before it records. Proxied verbatim (no draft bridge — they return no test case).
 *
 * `android_devices` is the first, and it is not optional convenience: `android({ packageName })`
 * requires an exact package id (`in.redbus.android`), which is derivable from nothing — not from the
 * app's display name, and not from the user, who does not know it either. Without this tool in the
 * filter the model has a required argument it cannot obtain, which is how the mainframe `appPath`
 * failure started. Web and mainframe need no equivalent: a browser takes a URL the user already has,
 * and an emulator session file is a path they can point at.
 *
 * `ios_devices` is the same argument twice over: `ios({ bundleId })` needs a bundle id, which is no
 * more derivable than a package name ("Settings" is com.apple.Preferences), and a udid is a 40-char
 * string nobody can type from memory. Note the name: the QA-surface tool is `ios_devices`, matching
 * `android_devices`. The agent's INTERNAL loop has a separate `ios_list_devices` among its 49 tools —
 * different namespace, not proxied, and not what belongs here.
 */
const DISCOVERY_TOOLS = new Set(['android_devices', 'ios_devices']);

/**
 * Control tools for an IN-FLIGHT delegated recording: pause it, carry on, or abandon it. Proxied
 * VERBATIM — no draft bridge, deliberately. A pause returns the steps so far for REVIEW, not a
 * saveable draft; re-homing a partial into Common's DraftStore would invite saving a half-finished
 * recording, which the "never auto-save" rule exists to prevent. The real draft still arrives the
 * usual way, at `*_status` "done".
 *
 * Without these on the client surface a recording can be STARTED but never stopped: the only escape
 * from one that has gone wrong is restarting the agent, which drops every other session with it.
 *
 * Additive, like every set above it — an agent that does not advertise these simply never matches.
 */
const RECORDING_CONTROL_TOOLS = new Set([
  'android_recording_stop', 'android_recording_resume', 'android_recording_discard',
  'web_recording_stop', 'web_recording_resume', 'web_recording_discard',
  'mainframe_recording_stop', 'mainframe_recording_resume', 'mainframe_recording_discard',
  'ios_recording_stop', 'ios_recording_resume', 'ios_recording_discard',
]);

/** Permissive input: accept any object; the product MCP is the strict validator. */
const PASSTHROUGH_INPUT = z.record(z.string(), z.unknown());

/**
 * Appended to core_activate_technology's description so the model ASKS the user which recording mode
 * they want before starting a WEB recording (the agent accepts `recordingMode` on that tool). Without
 * this the recording silently defaults to HYBRID and the user is never offered AI-only.
 */
const RECORDING_MODE_PROMPT =
  '\n\nWEB recordings run in one of two modes — make sure you know which the user wants:\n' +
  '  • "AI-only" (default) — record ONLY the AI-driven steps (clean; the browser recording extension is NOT loaded), or\n' +
  '  • "AI + Manual" — ALSO capture the user\'s OWN manual clicks in the browser alongside the AI steps.\n' +
  'If the user ALREADY named the mode in their request (e.g. "AI-only", "AI + Manual"), use it — do NOT re-ask. ' +
  'Otherwise ASK "AI-only or AI + Manual?"; if they have no preference, use AI-only.\n' +
  'Pass their choice as recordingMode: "AI" or "HYBRID" ("AI + Manual" maps to "HYBRID"), plus a matching recordingModeAskedUser.\n' +
  'NOTE: ANDROID / IOS recordings are ALWAYS AI-only — do NOT ask or offer AI + Manual for mobile (it is a browser-extension feature). ' +
  'Set recordingMode="AI" and recordingModeAskedUser="AI" automatically for mobile.';

/** Canonicalise a recording-mode string (the user/agent may phrase it many ways) to the backend
 *  enum sense. "AI"/"AI-only" -> 'ai'; "HYBRID"/"AI + Manual"/"manual" -> 'hybrid'; else -> ''. */
function canonRecordingMode(s: unknown): '' | 'ai' | 'hybrid' {
  if (typeof s !== 'string') return '';
  const v = s.toLowerCase().replace(/[\s_+&-]/g, '');
  if (v === 'ai' || v === 'aionly') return 'ai';
  if (v === 'hybrid' || v === 'manual' || v === 'aimanual' || v === 'aiplusmanual') return 'hybrid';
  return '';
}

/**
 * Per-technology wording + extra input fields for the two delegated recorders. Everything else about
 * them is identical (resolve nested refs up front, forward, poll, re-home the draft), which is why
 * they share registerDelegatedRecorder / registerDelegatedStatus rather than each carrying a copy.
 */
const DELEGATED_RECORDERS = {
  web: {
    statusTool: 'web_status',
    /** Extra fields beyond `task` + nestStart/nestEnd, forwarded verbatim to the agent. */
    extraInput: {
      url: z.string().optional().describe(
        'Starting URL for the recording browser. STRONGLY recommended — the recording opens on this ' +
          'page. If omitted, the agent uses the first URL found in the task.',
      ),
      profile: z.string().optional().describe(
        'Persistent browser profile (cookies/localStorage). Omit for a fresh isolated profile per ' +
          'recording (recommended — avoids browser-lock collisions); pass a name to REUSE a signed-in ' +
          'profile across recordings.',
      ),
    },
    taskDescribe:
      'The GOAL in natural language, e.g. "Sign in at <url> as Admin/admin123, then verify the ' +
      'Dashboard heading is visible." Include the app URL in the task.',
    startNote:
      'NON-BLOCKING: this STARTS the delegated web recording on the agent and returns a sessionId ' +
      'immediately — a browser opens and records in the background. Then poll web_status({ sessionId }) ' +
      'until status is "done"; web_status re-homes the draft HERE and returns a Common draftId that ' +
      'tc_save can persist. POLL EVERY ~15-20 SECONDS, never minutes: the recording takes MINUTES end to end, but that is its DURATION, not the poll interval, and waiting minutes between polls leaves a finished draft sitting uncollected. Call web ONCE — do not retry it.',
    doneLabel: 'Web recording complete.',
  },
  mainframe: {
    statusTool: 'mainframe_status',
    extraInput: {
      appPath: z.string().optional().describe(
        'Path to the TN3270 emulator SESSION FILE or its executable. The extension identifies the ' +
          'emulator: `.ecf` = Quick3270, `.ws` = IBM Personal Communications, `.rd3x`/`.rd5x` = Micro ' +
          'Focus Reflection. Launched before recording and becomes the "Launch ${app_path}" step 1, so ' +
          'the test case replays from cold. Omit ONLY when the emulator is already open and you are ' +
          'attaching to its live session. If you do not know the path, ASK THE USER for it — do not ' +
          'search the filesystem.',
      ),
      attachOnly: z.boolean().optional().describe(
        'Do not launch the emulator even though appPath was given — attach to the running one.',
      ),
      // THE DIRECT (TN3270) ROUTE. These MUST be declared here even though the agent already
      // accepts them: this file registers its own schema and forwards only the keys it names
      // (see the loop over Object.keys(cfg.extraInput) below). A field the agent documents but
      // this config omits is not "passed through" — it cannot be supplied by the caller at all,
      // and the route it selects is unreachable from any MCP client.
      host: z.string().optional().describe(
        'DIRECT ROUTE — the mainframe hostname or IP to dial over TN3270, with NO emulator at all, ' +
          'e.g. "zos.example.com". Giving this selects the direct route the way appPath selects the ' +
          'emulator route; pass one or the other, never both. ASK THE USER — never invent a hostname ' +
          'and never reuse one from an earlier conversation. Prefer this route when no emulator is ' +
          'installed, the machine is not Windows, or several mainframe recordings must run at once ' +
          '(it has no single-attachment limit). A test case is TIED to the route it was recorded on.',
      ),
      port: z.string().optional().describe(
        'DIRECT ROUTE — the TN3270 port as a string, e.g. "1023" (Marist) or "3270" (a local ' +
          'Hercules/TK4). ASK THE USER: there is no safe default and the common ports differ per ' +
          'host. Required whenever `host` is given.',
      ),
      marker: z.string().optional().describe(
        'DIRECT ROUTE — text that appears on the FIRST screen once the host is ready, e.g. "z/OS". ' +
          'The connect waits for it, which is how "connected" is told apart from "connected but the ' +
          'screen is not drawn yet". ASK THE USER and pass it EXACTLY: matching is CASE-SENSITIVE, ' +
          'so "z/Os" against a screen showing "z/OS" waits out the timeout and fails. No escaping or ' +
          'URL-encoding — the agent assembles the target itself.',
      ),
      ssl: z.boolean().optional().describe(
        'DIRECT ROUTE, ADVANCED — TLS to the host. Default false, correct for plain TN3270 (port 1023 ' +
          'and most test hosts). Ask only if the user raises it, or a plain connection is refused.',
      ),
      dialect: z.enum(['zos', 'tk4']).optional().describe(
        'DIRECT ROUTE, ADVANCED — which logon flow the host speaks. "zos" (default) is a normal z/OS ' +
          'VTAM banner; "tk4" is MVS 3.8j under Hercules, with a different logon panel and a terminal ' +
          'that needs waking. Ask only if the user mentions Hercules, TK4- or MVS 3.8j.',
      ),
      target: z.string().optional().describe(
        'DIRECT ROUTE — the ALREADY-ASSEMBLED destination a SAVED test case carries: either ' +
          '"host:port?marker=..." or a profile NAME from the agent config file ("marist"). Use it when ' +
          'replaying something stored; for a NEW recording prefer host/port/marker, which are ' +
          'assembled with correct encoding (hand-built strings corrupt a marker containing "+", "&" ' +
          'or "="). A profile name only works where that config file exists, and it is not deployed. ' +
          'Ignored when `host` is given.',
      ),
    },
    taskDescribe:
      'The GOAL in natural language, e.g. "Log on to TSO as ANISHA/pass123, then run LISTUSER." ' +
      'Include the real values the host needs — they are parameterized at assembly time.',
    startNote:
      'ASK THE USER WHICH ROUTE FIRST — before any other work, and never pick for them. Pass EITHER ' +
      '`host`+`port`+`marker` (DIRECT: dials the host over TN3270, no emulator, any OS, several ' +
      'recordings at once) OR `appPath` (EMULATOR: launches a TN3270 emulator, Windows only, one at a ' +
      'time). A test case is TIED to the route it was recorded on and cannot be switched later, which ' +
      'is why this is never guessed. Do NOT try to INFER it: a running emulator does not mean they want ' +
      'the emulator route, an absent one does not rule it out (the direct route needs none), and the ' +
      'routes used by existing test cases say nothing about the one they want now. Do NOT run tasklist, ' +
      'search the filesystem for .ecf files, or read other test cases to decide this — ask. Calling this ' +
      'tool with neither argument is REFUSED. ' +
      'NON-BLOCKING: this STARTS the delegated mainframe recording on the agent and returns a sessionId ' +
      'immediately — the session connects and records in the background. Then poll ' +
      'mainframe_status({ sessionId }) until status is "done"; mainframe_status re-homes the draft HERE ' +
      'and returns a Common draftId that tc_save can persist. POLL EVERY ~15-20 SECONDS, never minutes: the recording takes MINUTES end to end, but that is its DURATION, not the poll interval, and waiting minutes between polls leaves a finished draft sitting uncollected. Call mainframe ONCE — do not ' +
      'retry it. On the EMULATOR route the HLLAPI session admits one attachment, so those recordings ' +
      'cannot overlap; the DIRECT route has no such limit.',
    doneLabel: 'Mainframe recording complete.',
  },
  android: {
    statusTool: 'android_status',
    extraInput: {
      packageName: z.string().describe(
        'The app under test, e.g. "com.example.app". Launched before recording and becomes the ' +
          '"Launch App ${app_package}" step 1, so the test case replays from cold.',
      ),
      deviceId: z.string().optional().describe(
        'udid of the target device from `adb devices` (e.g. "emulator-5554", "R58M12ABCDE"). OMIT when ' +
          'exactly one device is connected — it is auto-selected and reported back. With SEVERAL ' +
          'connected the call is refused and the udids are listed: ASK THE USER which device to record ' +
          'on. Never pick one yourself — recording on the wrong device does not fail, it silently ' +
          'produces a test case against the wrong handset.',
      ),
      activityName: z.string().optional().describe(
        'Optional launch activity. OMIT IT — the agent reads the app\'s launcher activity off the device ' +
          'and records it, so the saved test case launches explicitly rather than relying on a default. ' +
          'Pass one only to launch a specific non-default entry point.',
      ),
      action: z.enum(['start', 'reset']).optional().describe(
        '"start" (default) launches the app as-is; "reset" clears its data first, for a clean-state flow.',
      ),
    },
    taskDescribe:
      'The GOAL in natural language, e.g. "Sign in as admin/admin123, search for \'Acme\' and open the ' +
      'first result." Include the real values the app needs — they are parameterized at assembly time.',
    startNote:
      'NON-BLOCKING: this STARTS the delegated android recording on the agent and returns a sessionId ' +
      'immediately — the device attaches over ADB and records in the background. Then poll ' +
      'android_status({ sessionId }) until status is "done"; android_status re-homes the draft HERE and ' +
      'returns a Common draftId that tc_save can persist. POLL EVERY ~15-20 SECONDS, never minutes: the recording takes MINUTES end to end, but that is its DURATION, not the poll interval, and waiting minutes between polls leaves a finished draft sitting uncollected. Call android ONCE — do not retry ' +
      'it: the ' +
      'device is claimed for the recording, so a second call on the same udid is refused. Recordings ' +
      'on DIFFERENT devices can run at the same time.',
    doneLabel: 'Android recording complete.',
  },
  ios: {
    statusTool: 'ios_status',
    extraInput: {
      bundleId: z.string().describe(
        'The app under test, as a BUNDLE ID (e.g. "com.apple.Preferences"). Launched when the WDA '
          + 'session opens, so the app is frontmost before recording starts. RESOLVE IT YOURSELF '
          + 'FROM `ios_devices`, which lists every installed app as "Display Name — bundleId" — the '
          + 'user names the app the way a human does ("record a Settings flow") and you look up the '
          + 'id. Do NOT ask the user for it (nobody knows one from memory) and do NOT guess it from '
          + 'the display name: the mapping is not derivable (Photos is com.apple.mobileslideshow, '
          + 'Messages is com.apple.MobileSMS). Match on the DISPLAY NAME — on iOS that column is the '
          + 'real home-screen string, unlike android_devices where it is a derived placeholder, and '
          + 'the list is user-installed apps only so the names do not collide. If nothing matches or '
          + 'several do, show the candidates and ask.',
      ),
      deviceId: z.string().optional().describe(
        'udid of the target device or simulator, from `ios_devices`. OMIT when exactly one is '
          + 'available — it is auto-selected and reported back. With SEVERAL available the call is '
          + 'REFUSED and they are listed: ASK THE USER which one. Never pick one yourself — recording '
          + 'on the wrong device does not fail, it silently produces a test case against the wrong '
          + 'handset.',
      ),
      projectId: z.string().optional().describe(
        'Enables the WebDriverAgent auto-install self-heal on a REAL device, using the Apple signing '
          + 'material stored for that project. Omit for a simulator, which needs no signing. Pass it '
          + 'only when the user has actually configured signing for that project.',
      ),
    },
    taskDescribe:
      'The GOAL in natural language, e.g. "Open General > About and verify the Name row is visible." '
      + 'Include the real values the app needs — they are parameterized at assembly time.',
    startNote:
      'CALL ios_devices FIRST if you do not already have an exact bundle id — it lists the installed '
      + 'apps as "Display Name — bundleId", so you resolve the id from the app name the user said '
      + 'rather than asking them for a string they do not have. '
      + 'NON-BLOCKING: this STARTS the delegated iOS recording on the agent and returns a sessionId '
      + 'immediately — WebDriverAgent comes up and records in the background. Then poll '
      + 'ios_status({ sessionId }) until status is "done"; ios_status re-homes the draft HERE and '
      + 'returns a Common draftId that tc_save can persist. POLL EVERY ~15-20 SECONDS, never minutes: '
      + 'the recording takes MINUTES end to end, but that is its DURATION, not the poll interval, and '
      + 'waiting minutes between polls leaves a finished draft sitting uncollected. Bring-up is '
      + 'SLOWER than android on a real device (signing, install and tunnel), so early polls saying '
      + '"recording" are normal. Call ios ONCE — do not retry it: the device is claimed for the '
      + 'recording, so a second call on the same udid is refused. Recordings on DIFFERENT devices can '
      + 'run at the same time. A REAL DEVICE does not need a macOS agent — go-ios drives pairing, '
      + 'the developer image and WebDriverAgent from Windows and Linux too. A SIMULATOR does need '
      + 'macOS (xcodebuild + simctl), so on any other host pass a real device udid.',
    doneLabel: 'iOS recording complete.',
  },
} as const;

/**
 * Convert a product tool's JSON-Schema (object schema) into a Zod raw shape, so the PROXIED tool
 * advertises the SAME named parameters (ref/expected/value/count/…) and required-ness to the client
 * instead of an opaque permissive blob. Without this the client's model can't tell that, say,
 * web_validate_text REQUIRES `expected`; it sends nothing, and the agent invokes a 1-arg method with
 * 0 args ("Arguments length does not match"). Types are approximated (the product agent is the strict
 * validator); the point is that the model knows WHICH args to send. Returns null when the schema is
 * absent or not an object schema, so the caller falls back to the permissive record.
 */
function jsonSchemaToShape(schema: unknown): z.ZodRawShape | null {
  if (!schema || typeof schema !== 'object') return null;
  const s = schema as { type?: unknown; properties?: unknown; required?: unknown };
  if (s.type !== 'object' || !s.properties || typeof s.properties !== 'object') return null;
  const required = new Set(Array.isArray(s.required) ? s.required.map(String) : []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, raw] of Object.entries(s.properties as Record<string, unknown>)) {
    const p = (raw && typeof raw === 'object' ? raw : {}) as { type?: unknown; description?: unknown };
    let field: z.ZodTypeAny;
    switch (p.type) {
      case 'string':  field = z.string(); break;
      case 'number':  field = z.number(); break;
      case 'integer': field = z.number().int(); break;
      case 'boolean': field = z.boolean(); break;
      case 'array':   field = z.array(z.unknown()); break;
      case 'object':  field = z.record(z.string(), z.unknown()); break;
      default:        field = z.unknown();
    }
    if (typeof p.description === 'string') field = field.describe(p.description);
    if (!required.has(key)) field = field.optional();
    shape[key] = field;
  }
  return Object.keys(shape).length ? shape : null;
}

export type RecordingToolsDeps = {
  getAdapter: () => ProviderAdapter | null;
  isConnected: () => boolean;
  /** True only when the live connection is SimplifyQA. The granular-verb proxying + real-schema
   *  preservation below are SimplifyQA-only; Walnut keeps its exact prior surface (its `web`/android/
   *  mainframe/db sub-agents + permissive schemas), so this change cannot affect Walnut. */
  isSimplifyqa: () => boolean;
  /** Common's DraftStore — the draft bridge re-registers the agent's assembled recording here so
   *  tc_save (which reads THIS store) can persist it. */
  drafts: DraftStore;
};

export function registerRecordingPassthrough(server: McpServer, deps: RecordingToolsDeps): void {
  void (async () => {
    const adapter = await waitForConnectedAdapter(deps, 12000);
    if (!adapter?.listAgentTools || !adapter.callRaw) return; // offline, or a product without passthrough
    // Retry listAgentTools until the downstream product MCP is primed and advertising. At startup the
    // Common connection can report "connected" (config present) BEFORE the product MCP's OWN connection
    // is primed, so a single call races it, returns nothing, and the web/android/... tools never appear
    // for the whole session (observed after a client reload). The first attempt also nudges the prime.
    // Poll until the downstream advertises tools. This is NOT a one-shot 30s window: the agent
    // (Electron :4050) is frequently started AFTER this MCP server, and a one-shot discovery that
    // misses that window left web/mainframe/... unregistered for the WHOLE session until the user
    // restarted common-mcp (the classic startup race). Instead we retry with backoff (500ms → 10s cap)
    // for a generous window, so the recording surface SELF-HEALS whenever the agent primes. The
    // registration below emits `tools/list_changed`, so a late discovery still reaches the client with
    // no reconnect. Bounded (not eternal) so a truly-absent agent eventually stops polling.
    let tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> = [];
    const deadline = Date.now() + 10 * 60_000; // ~10 min — covers "agent started shortly after common-mcp"
    let delay = 500;
    let announcedWait = false;
    while (Date.now() < deadline) {
      try {
        const a = deps.getAdapter();
        if (a?.listAgentTools) {
          tools = await a.listAgentTools();
          if (tools.length) break;
        }
      } catch { /* downstream not primed yet — retry */ }
      await new Promise((r) => setTimeout(r, delay));
      // Surface the wait once, so a genuinely-down agent is diagnosable (not silently spinning).
      if (!announcedWait && delay >= 10_000) {
        announcedWait = true;
        log('recording passthrough: still waiting for the product agent to advertise its tools (will keep retrying)…');
      }
      delay = Math.min(Math.round(delay * 1.5), 10_000);
    }
    if (!tools.length) {
      log('recording passthrough: no agent tools discovered within ~10min — the product agent never advertised any this session. Start the agent, then reconnect the MCP.');
      return;
    }
    log(`recording passthrough: discovered ${tools.length} agent tool(s); registering the recording surface (emits tools/list_changed).`);
    // SimplifyQA-only behavior below (granular-verb proxying + real-schema preservation). Walnut keeps
    // its EXACT prior surface, so this cannot affect Walnut. Evaluated once the connection is live.
    const simplifyqa = deps.isSimplifyqa();
    let proxied = 0;
    for (const t of tools) {
      if (PROVIDER_OPS.has(t.name)) continue;
      // Two recording surfaces are proxied:
      //  (a) WALNUT — the technology SUB-AGENT tools (web/android/mainframe/db) + `qa_technology_status`
      //      (which LISTS the sub-agents + their availability, the way list_projects lists projects) +
      //      every non-blocking recorder's own *_status tool. One delegated sub-agent per tech; its
      //      granular browser_*/recording_*/verify_* tools stay INTERNAL to the agent's own loop.
      //      The status tools come from DELEGATED_STATUS_TOOLS, NOT a hardcoded 'web_status':
      //      `mainframe_status` is equally a client-surface tool, and it matches no core_*/web_* prefix,
      //      so naming only web_status here would leave a started mainframe recording uncollectable.
      //  (b) SIMPLIFYQA — the client's own LLM drives GRANULAR verbs, and the SimplifyQA agent exposes
      //      ONLY client-facing tools (core_*, web_*, generic_*, and any FUTURE technology family such as
      //      mobile_*/desktop_* — it has no internal-only tools to hide). So the agent's tools/list IS the
      //      source of truth: proxy EVERY non-provider-op tool it advertises (the generic forward branch
      //      below). A new tool family on the agent then needs ZERO change here. Prefixes don't collide:
      //      Walnut's single tool is exactly `web` (no underscore) and its internals use browser_/…
      const isSubAgent = TECHNOLOGY_SUBAGENTS.has(t.name)
        || t.name === 'qa_technology_status'
        || DELEGATED_STATUS_TOOLS.has(t.name)
        || DISCOVERY_TOOLS.has(t.name)
        || RECORDING_CONTROL_TOOLS.has(t.name);
      const isRecorderVerb = simplifyqa;   // SimplifyQA: every remaining (non-provider-op) tool — agent-driven
      if (!isSubAgent && !isRecorderVerb) continue;
      try {
        // A delegated recorder + its status tool get the DRAFT BRIDGE, not a dumb forward: the
        // recording assembles a test case into a draft in the AGENT's OWN store, which tc_save
        // (Common's store) can't see. So we forward, then re-register the returned TestCase in
        // Common's DraftStore and hand back a COMMON draftId — the only kind tc_save can persist.
        const recorderCfg = DELEGATED_RECORDERS[t.name as keyof typeof DELEGATED_RECORDERS];
        if (recorderCfg) {
          registerDelegatedRecorder(server, deps, t, recorderCfg);
          proxied++;
          continue;
        }
        const statusOwner = Object.values(DELEGATED_RECORDERS).find((c) => c.statusTool === t.name);
        if (statusOwner) {
          registerDelegatedStatus(server, deps, t, statusOwner);
          proxied++;
          continue;
        }
        if (t.name === 'core_close_session') {
          registerCloseSessionWithSaveGuard(server, deps, t);
          proxied++;
          continue;
        }
        // SimplifyQA-only: intercept `core_activate_technology` so mobile (ANDROID/IOS) recordings
        // can't be started without the LLM having explicitly asked the user which platform. The
        // Java-side tool takes `technology` as a required string; without wrapping, the LLM picks
        // ANDROID vs IOS silently and reuses the previous session's pick on the second recording
        // (the reported bug). Walnut mobile uses a different tool (`android`/`ios`) with its own
        // cascade in registerDelegatedRecorder — this wrapper does NOT apply there.
        if (simplifyqa && t.name === 'core_activate_technology') {
          registerActivateTechnologyWithMobileGuard(server, deps, t);
          proxied++;
          continue;
        }
        if (simplifyqa && FORMULA_INPUT_VERBS.has(t.name)) {
          registerFormulaAwareInput(server, deps, t);
          proxied++;
          continue;
        }

        // SimplifyQA: preserve the agent's REAL parameter schema (ref/expected/value/count/…) so the
        // client sends the right args (without it, web_validate_text's required `expected` is hidden →
        // "Arguments length does not match"). Walnut keeps the permissive record exactly as before.
        //
        // EXCEPT the recording-control tools, on BOTH products. The permissive record advertises no
        // properties at all, so a client reads `{stop,resume,discard}` as taking nothing and calls
        // them bare — but every one REQUIRES `sessionId` at the agent, and resume additionally takes
        // an optional `task` its own description offers. Args are forwarded verbatim either way, so
        // this changes only what the caller is TOLD it may send; hiding a required argument is not a
        // conservative default, it is a broken call the client cannot see coming. These tools are new,
        // so there is no prior Walnut behaviour to preserve here.
        const useRealShape = simplifyqa || RECORDING_CONTROL_TOOLS.has(t.name);
        const shape = useRealShape ? jsonSchemaToShape(t.inputSchema) : null;
        // core_activate_technology gains a prompt to ASK the user AI-only vs AI + Manual before recording.
        const modePrompt = t.name === 'core_activate_technology' ? RECORDING_MODE_PROMPT : '';
        server.registerTool(
          t.name,
          {
            description: `${t.description ?? t.name}${modePrompt}\n\n(Agent-bound tool — runs on the connected product agent, forwarded through the Common MCP.)`,
            inputSchema: shape ?? PASSTHROUGH_INPUT,
          },
          async (args: Record<string, unknown> = {}) => {
            const a = deps.getAdapter();
            if (!a?.callRaw) return err('Not connected to a product agent — recording runs on the agent (qa_connect first).');
            try {
              return (await a.callRaw(t.name, args)) as CallToolResult;
            } catch (e) {
              return err(e instanceof Error ? e.message : String(e));
            }
          },
        );
        proxied++;
      } catch {
        // Name already registered (a Common-native tool) -- skip rather than clobber.
      }
    }
    log(`recording passthrough: proxied ${proxied} agent tool(s)`);
  })();
}

/** What the dynamic mirror gives us about one downstream tool. */
type AgentTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
type RecorderCfg = (typeof DELEGATED_RECORDERS)[keyof typeof DELEGATED_RECORDERS];

/**
 * The set of agent text-entry verbs that may carry a `formula` argument. When the passthrough loop
 * encounters one of these tools (SimplifyQA-only), it registers the formula-aware wrapper instead of
 * a dumb forward so the recorder types a freshly-generated value and the saved step regenerates per run.
 * Note: `mainframe_enter_text` is included as the expected mainframe field-entry verb name; confirm
 * against the product's actual tool name if it differs in future.
 * DESKTOP: `desktop_enter_text` (types) and `desktop_set_text` (replaces); their formulas are evaluated as DESKTOP.
 */
export const FORMULA_INPUT_VERBS = new Set([
  'web_enter_text', 'web_keyboard_action', 'android_enter_text', 'ios_enter_text',
  'mainframe_enter_text',
  'desktop_enter_text', 'desktop_set_text',
]);

/**
 * The BUILT-IN formula catalog the agent's formula engine (`/formula/convert`) supports — mirrors the
 * engine's `FunctionType` enum. Exposed INLINE in the `formula` param description so the recording agent
 * (which often cannot reach the separate `tc_list_formulas` tool) can discover every formula and stops
 * inventing names (e.g. the bogus `RANDOM_ALPHANUMERIC` → the real name is `ALPHA_NUMERIC`). Names are
 * matched case-insensitively; arguments are POSITIONAL in the `expression` form. PROJECT/CUSTOM formulas
 * are NOT listed here (they are dynamic per project) — those still come from `tc_list_formulas`.
 */
export const FORMULA_CATALOG = [
  'Arithmetic: SUM(a,b,…), SUBTRACT(a,b), MULTIPLY(a,b,…), DIVISION(a,b), MODULUS(a,b), MAX(a,b,…), MIN(a,b,…)',
  'Text: CONCATENATE(a,b,…), LEFT(text,n), RIGHT(text,n), MID(text,start,len), UPPER(text), LOWER(text), PROPER(text), SPLIT(text,delim,index), REPLACE(text,old,new), REPEAT(text,n), LENGTH(text)',
  'Random/ID: ALPHABET(n)=n letters, NUMERIC(n)=n-digit number (1-9), ALPHA_NUMERIC(n)=n letters+digits — each also takes (min,max) for a random length/range. Also UUID(), PICK_RANDOM(a,b,…), FLIP(). For "3 letters then 3 digits" use =CONCATENATE(ALPHABET(3),NUMERIC(3)).',
  'Date/Time: NOW(), TODAY(), DAY(), MONTH(), YEAR(), TIME(), HOUR(), MINUTE(), SECOND(), FORMAT_DATE(pattern), FORMAT_TIME(pattern), DAY_OF_WEEK()',
  'Logic/Compare: IF_ELSE(cond,then,else), CONTAINS(text,sub), EQUALS(a,b), EQUALS_IGNORE_CASE(a,b), NOT_EQUALS(a,b), GREATER_THAN(a,b), GREATER_THAN_EQUALS(a,b), LESS_THAN(a,b), LESS_THAN_EQUALS(a,b), EMPTY(v), BLANK(v)',
  'Synthetic data: FIRST_NAME(country,sex,min_len,max_len), LAST_NAME(…), FULL_NAME(…), MIDDLE_NAME(…), PREFIX(sex), GENDER(), PHONE_NUMBER(), DATE_OF_BIRTH(pattern,min_age,max_age), EMAIL_ID(prefix,domain), COUNTRY_NAME(), COUNTRY_CODE(), STATE(), CITY(), STREET(), ADDRESS(), ZIPCODE(), TIMEZONE(), CURRENCY_CODE(), CURRENCY_NAME(), CURRENCY_SYMBOL(), CREDIT_CARD_NUMBER(), CREDIT_CARD_CVV(), CREDIT_CARD_EXPIRY()',
  'Name formulas (FIRST_NAME/LAST_NAME/FULL_NAME/MIDDLE_NAME): every arg is OPTIONAL — for a random name just use FIRST_NAME() with NO args. Only set min_len/max_len when the user asks for a specific length, and then pass ALL four args (country,sex,min_len,max_len) and keep min_len ≥ 5, max_len ≥ 6, and min_len < max_len (they must DIFFER — never the same value). Otherwise FIRST_NAME errors: "MIN > 4, MAX > 5 and MIN should be lesser than MAX".',
  'Excel: READ_FROM_EXCEL(…), READ_CELL(…), READ_COLUMN(…), READ_ROW(…)',
  'Misc: ONCE(v), USER_PREFERENCE(key)',
  'Aliases: NUMBER=NUMERIC, ALPHABETS=ALPHABET, MOD=MODULUS, DIV=DIVISION, CONCAT=CONCATENATE, GTE/GT/LTE/LT/EQ/NEQ/EQIGNC = the compare ops above',
].join('\n  ');

/**
 * Register a formula-aware wrapper for a text-entry verb. When the caller passes a `formula` arg,
 * it is resolved via `adapter.evaluateFormula` and the resulting `value` + `formulaExpression` are
 * forwarded to the agent (the raw `formula` arg is stripped). When no `formula` is passed, all args
 * are forwarded byte-for-byte unchanged — exact backward compatibility.
 */
export function registerFormulaAwareInput(server: McpServer, deps: RecordingToolsDeps, t: AgentTool): void {
  const base = jsonSchemaToShape(t.inputSchema) ?? {};
  const shape: z.ZodRawShape = {
    ...base,
    formula: z.object({
      name: z.string().optional().describe('Built-in formula name from the catalog below, e.g. "FIRST_NAME", "ALPHA_NUMERIC". Case-insensitive. MUST be a real formula — do NOT invent names (there is no RANDOM_NAME; for a random person name use FIRST_NAME/FULL_NAME). For PROJECT/CUSTOM formulas use tc_list_formulas.'),
      args: z.record(z.string(), z.string()).optional().describe("Named args keyed by the formula's parameter keyNames (see the catalog signatures)."),
      expression: z.string().optional().describe('A full formula with POSITIONAL args, e.g. "=ALPHA_NUMERIC(6)" or "=CONCATENATE(UPPER(LEFT(FIRST_NAME(),3)),NUMERIC(4))". Use instead of name/args; supports any formula in the catalog.'),
    }).optional().describe(
      "OPTIONAL. Generate this field's value with a testdata formula instead of a literal. When set, the recorder types a freshly-generated value and the saved step regenerates per run. Omit for a normal literal (the default). If the user did NOT ask for a formula, do NOT set this.\n\nYou may ONLY use formulas from the catalog below (or a PROJECT/CUSTOM formula from tc_list_formulas). NEVER invent a formula name — if no single formula fits, COMPOSE existing ones, e.g. 3 letters + 3 digits = =CONCATENATE(ALPHABET(3),NUMERIC(3)); a random name = =FULL_NAME().\n\nAVAILABLE BUILT-IN FORMULAS (any work via `expression`; args are positional):\n  " + FORMULA_CATALOG),
  };
  server.registerTool(t.name, { description: `${t.description ?? t.name}`, inputSchema: shape },
    async (args: Record<string, unknown> = {}) => {
      const a = deps.getAdapter();
      if (!a?.callRaw) return err('Not connected to a product agent — recording runs on the agent (qa_connect first).');
      const formula = args['formula'] as { name?: string; args?: Record<string, string>; expression?: string } | undefined;
      const forwarded: Record<string, unknown> = {};
      for (const k of Object.keys(args)) if (k !== 'formula') forwarded[k] = args[k];
      if (formula && (formula.name || formula.expression) && a.evaluateFormula) {
        let resolved: { value: string; expression: string };
        // DESKTOP verbs are evaluated as DESKTOP; every other verb keeps the adapter's default (WEB).
        try { resolved = await a.evaluateFormula(formula, t.name.startsWith('desktop_') ? { technologyType: 'DESKTOP' } : undefined); }
        catch (e) { return err(e instanceof Error ? e.message : String(e)); }
        forwarded['value'] = resolved.value;
        forwarded['formulaExpression'] = resolved.expression;
      }
      try { return (await a.callRaw(t.name, forwarded)) as CallToolResult; }
      catch (e) { return err(e instanceof Error ? e.message : String(e)); }
    });
}

/**
 * Register a DELEGATED RECORDER (`web`, `mainframe`) with a REAL schema rather than the permissive
 * passthrough: `task` is required, and the technology's own extra fields are surfaced so the caller is
 * nudged to pass them (a web recording wants `url` so it starts on the real page instead of
 * about:blank; a mainframe recording wants `appPath` so the emulator gets launched and step 1 is
 * recorded).
 *
 * `nestStart`/`nestEnd` arrive here as test-case IDS but go DOWN as resolved `{ tcId, name }` refs —
 * resolved up front so a bad id fails BEFORE a recording is wasted, and so the agent can compose the
 * nesting INTO the session (making the live editor show, and its Save persist, the whole composition).
 */
function registerDelegatedRecorder(
  server: McpServer,
  deps: RecordingToolsDeps,
  t: AgentTool,
  cfg: RecorderCfg,
): void {
  server.registerTool(
    t.name,
    {
      description: `${t.description ?? t.name}\n\n(${cfg.startNote})`,
      inputSchema: {
        task: z.string().min(1).describe(cfg.taskDescribe),
        ...cfg.extraInput,
        nestStart: z.array(z.string()).optional().describe(
          'Existing test case ids to run BEFORE the recorded activity, as nested steps (e.g. a Login ' +
            'test case). They are prepended to the produced draft in order — so the draft becomes ' +
            '[nestStart…] → recorded activity → [nestEnd…]. Use this to reuse a login flow instead of ' +
            're-recording it.',
        ),
        nestEnd: z.array(z.string()).optional().describe(
          'Existing test case ids to run AFTER the recorded activity, as nested steps (e.g. a Logout ' +
            'test case). They are appended to the produced draft in order.',
        ),
      },
    },
    // `args` is annotated rather than inferred: the schema above SPREADS cfg.extraInput, whose type is
    // a union across the technologies, so the SDK cannot infer a single concrete arg shape (implicit
    // any). Reading fields off a Record keeps this honest — the agent is the strict validator anyway.
    async (args: Record<string, unknown>) => {
      const a = deps.getAdapter();
      if (!a?.callRaw) return err('Not connected to a product agent — recording runs on the agent (qa_connect first).');
      const rec = args ?? {};
      const idsOf = (key: string): string[] =>
        Array.isArray(rec[key]) ? (rec[key] as unknown[]).map(String) : [];
      let startRefs: Array<{ tcId: string; name: string }>;
      let endRefs: Array<{ tcId: string; name: string }>;
      try {
        startRefs = await resolveNestedRefs(a, idsOf('nestStart'));
        endRefs = await resolveNestedRefs(a, idsOf('nestEnd'));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
      // Forward `task` plus whichever of this technology's own fields the caller actually supplied.
      // Driven off cfg.extraInput's keys so adding a field to the config is the only edit needed.
      const agentArgs: Record<string, unknown> = { task: rec['task'] };
      for (const key of Object.keys(cfg.extraInput)) {
        if (rec[key] !== undefined) agentArgs[key] = rec[key];
      }
      if (startRefs.length) agentArgs['nestStart'] = startRefs;
      if (endRefs.length) agentArgs['nestEnd'] = endRefs;
      // NON-BLOCKING: the agent returns a sessionId immediately (recording runs in the background), so
      // this returns in ms — no long-blocking RPC, no client-timeout-driven retries, no duplicate
      // browser/emulator. The draft is re-homed later, on the status tool's "done".
      try {
        return (await a.callRaw(t.name, agentArgs)) as CallToolResult;
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

/**
 * Wrap `core_close_session` with a SAVE GUARD so a tear-down can't silently drop a recorded but
 * unsaved draft (web, mobile, mainframe — any technology). The agent's own close is coarse: it
 * closes every active session (WEB + ANDROID + IOS) at once, and only the browser/driver + device
 * mirror are torn down — the model may still have a `draft_...` in Common that never made it to
 * `tc_save`. This wrapper checks Common's DraftStore for recording-sourced drafts with no `tc.id`
 * and, unless `force:true`, refuses with a list of the offenders and the two ways out (`tc_save` to
 * persist, `tc_draft_discard` to throw away).
 */
export function registerCloseSessionWithSaveGuard(
  server: McpServer,
  deps: RecordingToolsDeps,
  t: AgentTool,
): void {
  server.registerTool(
    t.name,
    {
      description:
        `${t.description ?? t.name}\n\n` +
        `(Common wraps this with a SAVE GUARD covering BOTH recording paths: (a) delegated-recorder ` +
        `drafts in Common's DraftStore — save with tc_save({draftId}) or discard with ` +
        `tc_draft_discard({draftId}); (b) granular recordings on the Java agent (queried live via ` +
        `core_active_recordings) — save those with tc_save({ sessionId }) (it clicks the recorder ` +
        `window's own Save button, exact parity) or by clicking Save Testcase in the /mcp-recorder ` +
        `window. If either has unsaved work the close is REFUSED and the refusal ` +
        `hands back a ONE-SHOT confirm token. To close AND lose the unsaved steps, call again as ` +
        `core_close_session({ confirm: "<the-token-from-the-refusal>" }) — the browser, driver AND ` +
        `recorder window all tear down. Only redeem the token after the user explicitly says ` +
        `"discard" or "close anyway"; never invent one.)`,
      inputSchema: {
        confirm: z.string().optional().describe(
          'One-shot confirm token minted by this tool in a prior REFUSAL. Only pass it when the ' +
            'user has explicitly said "discard" or "close anyway" after seeing the refusal. Do NOT ' +
            'invent a value — if you don\'t have a token from a prior refusal, call without confirm ' +
            'and the refusal (if any) will give you a fresh one.',
        ),
        keepRecorderOpen: z.boolean().optional().describe(
          'Pass true when the user says "close the browser" / "keep the recorder open": closes the browser, ' +
            'driver and device but KEEPS the recorder window and its captured steps open so they can still be ' +
            'reviewed and saved. Never refused for unsaved steps — nothing is lost.',
        ),
        closeTestcaseWindow: z.boolean().optional().describe(
          'Pass true — ONLY after the user confirms in chat — to close the recorder (testcase) window that a ' +
            'previous keepRecorderOpen / mobile close left open.',
        ),
      },
    },
    async (args) => {
      const a = deps.getAdapter();
      if (!a?.callRaw) return err('Not connected to a product agent — recording runs on the agent (qa_connect first).');
      const confirmArg = (args as { confirm?: unknown } | undefined)?.confirm;
      const confirm = typeof confirmArg === 'string' ? confirmArg.trim() : '';
      const bypass = confirm.length > 0 && redeemCloseNonce(confirm);
      // Closing only the browser leaves the steps in the recorder window, so there is nothing to guard.
      const keepRecorderOpen = (args as { keepRecorderOpen?: unknown } | undefined)?.keepRecorderOpen === true;
      const closeTestcaseWindow = (args as { closeTestcaseWindow?: unknown } | undefined)?.closeTestcaseWindow === true;
      if (!bypass && !keepRecorderOpen) {
        // Two sources of "unsaved":
        //  (a) delegated-recorder drafts re-homed into Common's DraftStore (from web/mainframe
        //      background recordings polled via *_status).
        //  (b) granular recordings live in the JAVA journal (core_activate_technology + *_ verbs).
        // Both must be checked, both must be reported in ONE refusal so the LLM can act on the
        // whole picture. The Java probe is best-effort — if it fails (agent gone, tool not
        // advertised on an older jar), fall back to just (a) so we never widen a failure into
        // a refusal-to-close for the wrong reason.
        const delegatedUnsaved = deps.drafts.listUnsavedRecordings();
        let granularUnsaved: Array<{ sessionId: string; mcpSessionKey: string; stepCount: number }> = [];
        try {
          const probe = (await a.callRaw('core_active_recordings', {})) as CallToolResult;
          if (!probe.isError) {
            const sc = probe.structuredContent as { recordings?: unknown } | undefined;
            const rows = Array.isArray(sc?.recordings) ? sc!.recordings : [];
            for (const r of rows) {
              const row = r as { sessionId?: unknown; mcpSessionKey?: unknown; stepCount?: unknown };
              const count = typeof row.stepCount === 'number' ? row.stepCount : 0;
              if (count > 0 && typeof row.sessionId === 'string' && typeof row.mcpSessionKey === 'string') {
                granularUnsaved.push({ sessionId: row.sessionId, mcpSessionKey: row.mcpSessionKey, stepCount: count });
              }
            }
          }
        } catch { /* older jar / no probe — Java's own guard still catches this on forward */ }
        if (delegatedUnsaved.length || granularUnsaved.length) {
          const lines: string[] = [];
          if (delegatedUnsaved.length) {
            lines.push(`Unsaved DELEGATED-recorder draft(s) (save with tc_save or discard with tc_draft_discard):`);
            for (const u of delegatedUnsaved) {
              lines.push(`  • draftId: ${u.draftId} — "${u.title}" (recording session ${u.sessionId})`);
            }
          }
          if (granularUnsaved.length) {
            lines.push(`Unsaved GRANULAR recording(s) — save with tc_save({ sessionId }) (clicks the recorder's Save) or click Save Testcase in the /mcp-recorder window:`);
            for (const g of granularUnsaved) {
              lines.push(`  • session ${g.sessionId} (${g.mcpSessionKey}) — ${g.stepCount} step(s)`);
            }
          }
          const nonce = mintCloseNonce();
          return err(
            `Refusing to close: ${delegatedUnsaved.length + granularUnsaved.length} recording(s) are NOT saved yet.\n` +
              `${lines.join('\n')}\n\n` +
              `ASK the user what to do:\n` +
              `  • KEEP THE RECORDER — if they only want the BROWSER closed ("close the browser"), call ` +
              `core_close_session({ keepRecorderOpen: true }): the browser/driver close, the recorder window and its ` +
              `steps stay open to review and save. Nothing is lost.\n` +
              `  • SAVE — for a delegated draft, tc_save({ draftId: "<id>" }); for a granular ` +
              `recording, tc_save({ sessionId: "<session id>" }) (clicks the recorder's own Save, ` +
              `exact parity) or tell the user to click Save Testcase in the recorder window.\n` +
              `  • DISCARD — for a delegated draft, tc_draft_discard({ draftId: "<id>" }); then retry close.\n` +
              `  • CLOSE ANYWAY — call core_close_session({ confirm: "${nonce}" }) to tear down the ` +
              `browser, driver AND recorder window (all captured steps above are LOST). This token ` +
              `is one-shot, valid for 5 minutes, tied to THIS refusal. Only redeem it after the ` +
              `user literally says "discard" or "close anyway" — never invent a token.`,
          );
        }
      }
      // Forward to Java. `force:true` goes over the wire ONLY when Common has just redeemed a
      // valid confirm nonce it minted itself — never in response to a raw `force` argument from
      // the client. That means a caller who skips the two-call ceremony (e.g. an LLM that decides
      // on its own to bypass) still faces Java's own save-guard for GRANULAR recordings. Both
      // guards must clear.
      const forward: Record<string, unknown> = bypass ? { force: true } : {};
      if (keepRecorderOpen) forward['keepRecorderOpen'] = true;
      if (closeTestcaseWindow) forward['closeTestcaseWindow'] = true;
      try {
        return (await a.callRaw(t.name, forward)) as CallToolResult;
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

/**
 * SimplifyQA-only wrapper around `core_activate_technology`. Enforces the mobile question sequence
 * — "Android or iOS?" then "which device?" — AND the WEB AI-only-vs-AI+Manual question, on EVERY call, not
 * just the first of the session. The bugs this fixes: the underlying tool takes `technology` as a
 * bare required string, so an LLM that silently reuses the previous session's pick or infers a
 * platform from a vague prompt ("record an app") passes schema validation and starts recording on
 * the wrong device with no re-prompt; likewise `recordingMode` defaults to AI, so a WEB recording
 * started without asking silently drops the user's own manual clicks.
 *
 * Enforcement is per-rung:
 *   1. `technology` — schema-required (Java-side).
 *   2. Mobile (ANDROID/IOS) → `deviceId` MUST be present. Refusal names the fresh discovery call
 *      the LLM has to make (`android_list_devices` / `ios_list_devices`) so the user's picking off
 *      the CURRENT roster, not a stale memory of last session's udids.
 *   3. Mobile → `platformAskedUser` MUST match `technology`. This is a "did you ask?" checkbox the
 *      LLM has to fill AFTER asking the user "Android or iOS?". Same soft ceiling as every other
 *      cascade in this file — the LLM can fabricate — but it makes the choice explicit in the
 *      call, so the ceiling matches deviceType/cloudDeviceType across the file.
 *   4. WEB → `recordingModeAskedUser` MUST match `recordingMode` (AI|HYBRID; both canonicalised so
 *      "AI + Manual"/"manual" also map to HYBRID) and both MUST be present. Makes the AI-only vs
 *      AI + Manual choice explicit on every recording instead of letting the agent's AI default win
 *      — but if the user already named the mode in their request the agent sets it from that without
 *      re-asking. Only WEB is gated — AI + Manual (HYBRID) is a browser-extension feature.
 *
 * MAINFRAME (and every non-WEB/MOBILE technology) is forwarded verbatim — the extra rungs fire
 * only for the technologies they apply to.
 */
function registerActivateTechnologyWithMobileGuard(
  server: McpServer,
  deps: RecordingToolsDeps,
  t: AgentTool,
): void {
  // Merge the agent's schema with our added rungs. Fresh object so the JSON-schema→zod conversion
  // output (which may be typed as readonly) isn't mutated in place.
  const base = jsonSchemaToShape(t.inputSchema) ?? {};
  const shape: z.ZodRawShape = {
    ...base,
    platformAskedUser: z.enum(['android', 'ios']).optional().describe(
      'REQUIRED when technology is ANDROID or IOS. Set to the platform the USER explicitly named ' +
        'after you ASKED them "Android or iOS?". If the user\'s prompt already named the platform ' +
        '("record an iOS app…"), set it to that; otherwise ASK first, then set. Do NOT reuse a ' +
        'previous session\'s answer. Must match `technology` (case-insensitive). The tool refuses ' +
        'mobile recordings without this, so a silent tool-side pick can\'t sneak through.',
    ),
    deviceTypeAskedUser: z.enum(['real_device', 'cloud_device', 'virtual_device']).optional().describe(
      'REQUIRED when technology is ANDROID or IOS. The device category the USER chose after you ' +
        'ASKED them "Real Device, Cloud Device, or Virtual Device?". If the user\'s prompt already ' +
        'named it ("record on LambdaTest" → cloud_device, "record on my iPhone" → real_device, ' +
        '"record on simulator" → virtual_device), set it from that WITHOUT re-asking; otherwise ' +
        'ASK. This determines which listing tool to call and which `provider` to pass:\n' +
        '  • real_device → call `mobile_list_devices` / the platform list tool, pick a physical device, provider=local\n' +
        '  • cloud_device → call `cloud_list_devices` with the platform, pick a cloud device, ' +
        'provider from the row (lambdatest/browserstack/saucelabs/simplifyqa)\n' +
        '  • virtual_device → call `mobile_list_devices` / the platform list tool, pick an ' +
        'emulator (Android) or simulator (iOS), provider=emulator or provider=simulator\n' +
        'The tool refuses mobile recordings without this.',
    ),
    recordingModeAskedUser: z.string().optional().describe(
      'REQUIRED for WEB recordings. The recording mode the user chose: ' +
        '"ai" for AI-only, or "hybrid" (equivalently "ai+manual") for AI + Manual. This is the ' +
        'FIRST question asked — before platform, device type, or anything else. If the user ' +
        'ALREADY named the mode in THIS request ("AI-only", "AI + Manual"/"hybrid"), set it from ' +
        'that WITHOUT re-asking; otherwise ASK "AI-only or AI + Manual?" for THIS recording. ' +
        'Do NOT reuse a previous recording\'s choice unless the user explicitly says "same as ' +
        'last time". Must match `recordingMode` ("AI + Manual" = "HYBRID"). The tool refuses ' +
        'WEB recordings without this, so a silent default can\'t skip the question.\n' +
        'FOR ANDROID / IOS: always set recordingMode="AI" and recordingModeAskedUser="AI" — ' +
        'AI + Manual (HYBRID) is a browser-extension feature and is NOT supported on mobile. ' +
        'Do NOT ask the user; just default to AI.',
    ),
  };
  server.registerTool(
    t.name,
    {
      description:
        `${t.description ?? t.name}${RECORDING_MODE_PROMPT}\n\n` +
        `⚠️ ALL RECORDINGS — EVERY session, WITHOUT EXCEPTION, follow these steps in ORDER:\n` +
        `  0. RECORDING MODE:\n` +
        `     • WEB → ASK "AI-only or AI + Manual?" FIRST — before anything else. ` +
        `Set \`recordingMode\` ("AI" or "HYBRID") and \`recordingModeAskedUser\` to the same.\n` +
        `     • ANDROID / IOS → AI + Manual is NOT supported (browser-extension feature). ` +
        `Always set recordingMode="AI" and recordingModeAskedUser="AI" automatically — do NOT ask.\n` +
        `     • API / DATABASE → AI + Manual does NOT apply (there is no browser to capture). ` +
        `Always set recordingMode="AI" and recordingModeAskedUser="AI" automatically — do NOT ask.\n\n` +
        `⚠️ MOBILE (technology ANDROID/IOS) — after setting recordingMode="AI", continue:\n` +
        `  1. ASK the user "Android or iOS?" if their prompt did not explicitly name a platform ` +
        `("record an app" is NOT an answer). Never infer, never reuse a previous session's pick.\n` +
        `  2. Set BOTH \`technology\` and \`platformAskedUser\` to that answer.\n` +
        `  3. ASK the user "Real Device, Cloud Device, or Virtual Device?" if their prompt did ` +
        `not already indicate one (e.g. "LambdaTest" → cloud_device, "my iPhone" → real_device, ` +
        `"simulator" → virtual_device). Set \`deviceTypeAskedUser\` to their choice.\n` +
        `  4. Based on device type:\n` +
        `     • real_device → call \`mobile_list_devices\` / \`android_list_devices\` / ` +
        `\`ios_list_devices\`, pick a physical device, set provider=local\n` +
        `     • cloud_device → call \`cloud_list_devices\` with the platform, pick a cloud ` +
        `device, set provider from the row (lambdatest/browserstack/saucelabs)\n` +
        `     • virtual_device → call \`mobile_list_devices\` / the platform list tool, pick an ` +
        `emulator (Android) or simulator (iOS), set provider=emulator or provider=simulator\n` +
        `  5. Show the user the returned rows, let them pick, pass the row's udid as \`deviceId\`.\n` +
        `The tool refuses each rung it doesn't get, so skipping one just wastes a round-trip.\n\n` +
        `(Agent-bound tool — runs on the connected product agent, forwarded through the Common MCP.)`,
      inputSchema: shape,
    },
    async (args: Record<string, unknown> = {}) => {
      const a = deps.getAdapter();
      if (!a?.callRaw) return err('Not connected to a product agent — recording runs on the agent (qa_connect first).');

      const technologyRaw = typeof args['technology'] === 'string' ? (args['technology'] as string) : '';
      const technology = technologyRaw.toUpperCase();
      const mobile = technology === 'ANDROID' || technology === 'IOS';

      // Rung 0 — recording mode. ANDROID / IOS are always AI-only (HYBRID is a browser-extension
      // feature). API and DATABASE are non-browser too, so they are AI-only as well — asking
      // "AI-only or AI + Manual?" for them is meaningless and must not happen. For WEB, make the
      // AI-only vs AI + Manual choice EXPLICIT on EVERY recording.
      const modeForced = mobile || technology === 'API' || technology === 'DATABASE';
      if (modeForced) {
        // No browser extension for mobile / API / DATABASE — AI + Manual (HYBRID) does not apply.
        args['recordingMode'] = 'AI';
        args['recordingModeAskedUser'] = 'AI';
      } else {
        // WEB: the marker (recordingModeAskedUser) must match recordingMode; both are
        // canonicalised so "AI + Manual", "manual" and "hybrid" are all understood and map to the
        // backend enum HYBRID. If the user already named the mode in their request the agent sets
        // the marker from that (see the field description) — it does NOT have to re-ask. A
        // missing/mismatched marker is refused with the exact question. This is the FIRST question
        // asked — before platform, device type, or anything else.
        const canonMode = canonRecordingMode(args['recordingMode']);
        const canonAsked = canonRecordingMode(args['recordingModeAskedUser']);
        if (!canonMode || canonAsked !== canonMode) {
          return err(
            `Refusing to start a ${technology || '(unknown)'} recording: the AI-only vs AI + Manual ` +
              `choice for THIS recording isn't set. If the user ALREADY named it in their request ` +
              `("AI-only", "AI + Manual"/"hybrid"), use that; otherwise ASK FIRST: "AI-only (records ` +
              `only the steps I drive) or AI + Manual (also records your own clicks)?" — do NOT reuse ` +
              `an earlier recording's answer unless they say "same as last time". Then retry ` +
              `\`core_activate_technology\` with \`recordingMode\` set to "AI" or "HYBRID" ` +
              `(AI + Manual = HYBRID) AND \`recordingModeAskedUser\` set to the same choice. ` +
              (canonMode && canonAsked && canonAsked !== canonMode
                ? `(You passed recordingModeAskedUser='${String(args['recordingModeAskedUser'])}' but ` +
                  `recordingMode='${String(args['recordingMode'])}' — those contradict; the user's ` +
                  `answer must drive BOTH.)`
                : ''),
          );
        }
        // Normalise to the backend enum so "AI + Manual"/"manual" still enables HYBRID downstream.
        args['recordingMode'] = canonMode === 'hybrid' ? 'HYBRID' : 'AI';
      }

      if (mobile) {
        const platform = technology.toLowerCase() as 'android' | 'ios';
        const listTool = platform === 'android' ? 'android_list_devices' : 'ios_list_devices';
        const asked = typeof args['platformAskedUser'] === 'string'
          ? (args['platformAskedUser'] as string).toLowerCase()
          : undefined;

        // Rung 1 — force the platform question. Refuse when the LLM committed to technology
        // without an explicit "I asked" marker matching it.
        if (asked !== platform) {
          return err(
            `Refusing to start a ${technology} recording: no evidence the user was asked which ` +
              `mobile platform to use. ASK the user: "Android or iOS?" — do NOT infer from the ` +
              `prompt (e.g. "record an app" gives NO platform), and do NOT reuse a previous ` +
              `session's answer. After they answer, retry \`core_activate_technology\` with ` +
              `\`platformAskedUser\` set to their choice AND \`technology\` matching it. ` +
              (asked && asked !== platform
                ? `(You passed platformAskedUser='${asked}' but technology='${technology}' — those ` +
                  `contradict. The user's answer must drive BOTH.)`
                : ''),
          );
        }

        // Rung 2 — force the device TYPE question. The user must choose Real Device, Cloud Device,
        // or Virtual Device before listing devices — it determines which listing tool to call and
        // which `provider` to pass to the agent.
        const deviceType = typeof args['deviceTypeAskedUser'] === 'string'
          ? (args['deviceTypeAskedUser'] as string).toLowerCase()
          : undefined;
        const validDeviceTypes = ['real_device', 'cloud_device', 'virtual_device'];
        if (!deviceType || !validDeviceTypes.includes(deviceType)) {
          const virtualLabel = platform === 'android' ? 'Emulator' : 'Simulator';
          return err(
            `Refusing to start a ${technology} recording: no device type chosen. ASK the user: ` +
              `"Real Device, Cloud Device, or Virtual Device (${virtualLabel})?" — if their prompt ` +
              `already named one (e.g. "LambdaTest" → cloud_device, "my iPhone" → real_device, ` +
              `"simulator"/"emulator" → virtual_device), use it WITHOUT re-asking. Then retry ` +
              `\`core_activate_technology\` with \`deviceTypeAskedUser\` set to their choice.\n\n` +
              `Based on their choice:\n` +
              `  • real_device → call \`mobile_list_devices\` or \`${listTool}\`, pick a physical device, set provider="local"\n` +
              `  • cloud_device → call \`cloud_list_devices\` with platform="${platform}", pick a device, set provider from the row (lambdatest/browserstack/saucelabs)\n` +
              `  • virtual_device → call \`mobile_list_devices\` or \`${listTool}\`, pick a ${virtualLabel.toLowerCase()}, set provider="${platform === 'android' ? 'emulator' : 'simulator'}"`,
          );
        }

        // Rung 3 — force the device question. deviceId is per-session (devices plug/unplug) so
        // the LLM must call the listing tool fresh AND let the user pick.
        const deviceId = typeof args['deviceId'] === 'string' ? (args['deviceId'] as string).trim() : '';
        const listToolHint = deviceType === 'cloud_device'
          ? `\`cloud_list_devices\` with platform="${platform}"`
          : `\`${listTool}\` or \`mobile_list_devices\``;
        if (!deviceId) {
          return err(
            `${technology} recording needs \`deviceId\`. Call ${listToolHint} FRESH this session ` +
              `(the connected roster changes between sessions — do NOT reuse a udid from an ` +
              `earlier call), show the user the returned rows and ASK which device they want to ` +
              `record on, then retry with the picked row's udid as \`deviceId\`.`,
          );
        }
      }

      // Duplicate-name guard: the recorder's Save button persists a NEW test case under `testcaseName`,
      // so a clashing name has to be caught here, before the recording is started. Skipped for edit
      // sessions (mcpTcEditSessionId), for EXISTING-TC re-records (testcaseId — the name IS the target
      // TC's name) and when the user confirmed. Best-effort — lookup failure never blocks.
      const tcName = typeof args['testcaseName'] === 'string' ? (args['testcaseName'] as string).trim() : '';
      if (tcName && !args['mcpTcEditSessionId'] && !args['testcaseId'] && args['allowDuplicateName'] !== true) {
        try {
          const hits = await a.listTestCases({ search: tcName, limit: 50 });
          const dup = hits.find((x) => x.title.trim().toLowerCase() === tcName.toLowerCase());
          if (dup) {
            return err(
              `Refusing to start recording: a test case named "${tcName}" already exists (${dup.code ?? dup.id}). ` +
                'ASK the user: use a different `testcaseName`, or — if they really want a second test case with ' +
                'the same name — retry with `allowDuplicateName: true`.',
            );
          }
        } catch {
          // lookup failed — proceed
        }
      }

      // platformAskedUser / deviceTypeAskedUser / recordingModeAskedUser / allowDuplicateName are
      // intercept-only — the Java tool doesn't know about them, so don't leak them downstream.
      const forwarded: Record<string, unknown> = {};
      for (const k of Object.keys(args)) {
        if (k !== 'platformAskedUser' && k !== 'deviceTypeAskedUser'
          && k !== 'recordingModeAskedUser' && k !== 'allowDuplicateName') {
          forwarded[k] = args[k];
        }
      }
      try {
        const res = (await a.callRaw(t.name, forwarded)) as CallToolResult;
        // Remember the name for tc_save's journal fallback, which otherwise names the test case by session id.
        const sid = (res as { structuredContent?: { sessionId?: unknown } } | undefined)?.structuredContent?.sessionId;
        if (!res?.isError && tcName && typeof sid === 'string') rememberRecordingName(sid, tcName);
        return res;
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

/**
 * Register a delegated recorder's POLL tool (`web_status`, `mainframe_status`) — and with it THE DRAFT
 * BRIDGE. While the recording is running the downstream result is forwarded verbatim; on "done" the
 * agent's assembled TestCase is re-registered in COMMON's DraftStore, because that is the only store
 * `tc_save` can read. Without this hop a finished recording would be visible but unsaveable.
 */
function registerDelegatedStatus(
  server: McpServer,
  deps: RecordingToolsDeps,
  t: AgentTool,
  cfg: RecorderCfg,
): void {
  const starter = t.name.replace(/_status$/, '');
  server.registerTool(
    t.name,
    {
      description:
        `${t.description ?? t.name}\n\n(Poll a recording started by ${starter}(). While it reports ` +
        `"recording", call it again after ~15-20 SECONDS — never minutes, since the recording's MINUTES-long ` +
        `DURATION is not a poll interval. On "done" this re-homes the assembled draft into Common's store and ` +
        `returns a Common draftId — review the steps, then tc_save({ draftId }) to persist.)`,
      inputSchema: { sessionId: z.string().describe(`The sessionId returned by ${starter}().`) },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const a = deps.getAdapter();
      if (!a?.callRaw) return err('Not connected to a product agent — recording runs on the agent (qa_connect first).');
      let res: CallToolResult;
      try {
        res = (await a.callRaw(t.name, { sessionId: (args as { sessionId?: unknown }).sessionId })) as CallToolResult;
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
      if (res.isError) return res; // recording error — forward verbatim
      const sc = res.structuredContent as
        { status?: string; tc?: TestCase; summary?: string; stepCount?: number; sessionId?: string } | undefined;
      if (sc?.status !== 'done' || !sc.tc) return res; // still recording → forward as-is
      // Tag the draft with its recording sessionId (the one polled with, or echoed back) so tc_save can
      // close this recording's live-steps window on the agent once it's saved through the MCP path.
      const recSessionId =
        (typeof (args as { sessionId?: unknown }).sessionId === 'string' ? (args as { sessionId?: string }).sessionId : undefined)
        ?? sc.sessionId;
      const draftId = deps.drafts.create(sc.tc, recSessionId);
      const stored = deps.drafts.get(draftId).tc;
      const stepCount = Array.isArray(stored.steps) ? stored.steps.length : (sc.stepCount ?? 0);
      return ok(
        `${sc.summary ?? cfg.doneLabel}\n\nRegistered as draft ${draftId} ` +
          `(${stepCount} step${stepCount === 1 ? '' : 's'}). This is an UNSAVED draft — SHOW these steps ` +
          `to the user and ASK whether to save. Do NOT save automatically: finishing a recording is NOT a ` +
          `save instruction. Call tc_save({ draftId: "${draftId}" }) ONLY after the user EXPLICITLY says to ` +
          `save (e.g. "save it"). The user may also save it themselves in the product UI.`,
        { status: 'done', draftId, tc: stored, stepCount, ...(sc.summary ? { summary: sc.summary } : {}) },
      );
    },
  );
}

/**
 * Resolve existing test-case ids to { tcId, name } refs for a delegated recorder to compose as nested
 * steps DURING recording. Titles come from getTestCase, so a wrong id fails BEFORE a recording is
 * wasted; the id is passed through as-is (function_call_data.test_case_id is a String — a business key
 * TC_123 or a Mongo _id both persist). The agent builds the actual function steps in-session so the
 * live editor renders + saves them.
 */
async function resolveNestedRefs(adapter: ProviderAdapter, tcIds: string[]): Promise<Array<{ tcId: string; name: string }>> {
  const refs: Array<{ tcId: string; name: string }> = [];
  for (const id of tcIds) {
    let name = id;
    try {
      const child = await adapter.getTestCase(id);
      if (child?.title) name = child.title;
    } catch {
      throw new Error(`Cannot reuse test case "${id}" as a nested step — it was not found (check the id).`);
    }
    refs.push({ tcId: id, name });
  }
  return refs;
}

/** Poll until the shared connection is live and its adapter can enumerate the agent's tools. */
async function waitForConnectedAdapter(deps: RecordingToolsDeps, timeoutMs: number): Promise<ProviderAdapter | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (deps.isConnected()) {
      const a = deps.getAdapter();
      if (a?.listAgentTools) return a;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return deps.isConnected() ? deps.getAdapter() : null;
}
