import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProviderAdapter } from './adapters/types.js';
import type { QaConnection } from './connection.js';
import { DraftStore } from './drafts/store.js';
import { registerTestcaseTools } from './tools/testcase.tools.js';
import { registerConnectionTools } from './tools/connection.tools.js';
import { registerDiscoveryTools } from './tools/discovery.tools.js';
import { registerQueryTools } from './tools/query.tools.js';
import { registerPrivilegeTools, buildPrivilegeReport } from './tools/privileges.tools.js';
import { registerObjectTools } from './tools/objects.tools.js';
import { registerStorySyncTools } from './tools/storySync.tools.js';
import { registerBacklogTools } from './tools/backlog.tools.js';
import { registerRunTools } from './tools/run.tools.js';
import { registerSuiteManageTools } from './tools/suiteManage.tools.js';
import { registerExecutionPlanTools } from './tools/executionPlan.tools.js';
import { registerReleaseSprintTools } from './tools/releaseSprint.tools.js';
import { registerObjectParameterizeTool } from './tools/objectParameterize.tools.js';
import { registerDefectUpdateTool } from './tools/defectUpdate.tools.js';
import { registerDefectFromStepTools } from './tools/defectFromStep.tools.js';
import { registerTestPlanTools } from './tools/testPlan.tools.js';
import { registerPipelineTools } from './tools/pipeline.tools.js';
import { registerFailureTools } from './tools/failure.tools.js';
import { registerFailureExportTools } from './tools/failureExport.tools.js';
import { FailureAnalysisStore, ownerKey } from './tools/failureAnalysisStore.js';
import type { FailureAnalysis } from './adapters/simplifyqa/failureAnalysisTypes.js';
import { registerTestdataTools } from './tools/testdata.tools.js';
import { registerPreferenceTools } from './tools/preference.tools.js';
import { registerAttachmentTools } from './tools/attachment.tools.js';
import { registerProjectTools } from './tools/project.tools.js';
import { registerEnvironmentTools } from './tools/environment.tools.js';
import { registerImportTools } from './tools/import.tools.js';
import { registerActionBackupTools } from './tools/actionBackup.tools.js';
import { registerFormulaTools } from './tools/formulas.tools.js';
import { registerDefectTools } from './tools/defects.tools.js';
import { registerTaskTools } from './tools/tasks.tools.js';
import { registerRecordingPassthrough } from './tools/recording.tools.js';
import { registerHealTools } from './tools/heal.tools.js';
import { registerReportTools } from './tools/report.tools.js';
import { registerGapAnalysisTools } from './tools/gapAnalysis.tools.js';
import { registerImpactAnalysisTools } from './tools/impactAnalysis.tools.js';
import { ok, err } from './mcpResult.js';
import { VERSION } from './version.js';

export { ok, err };

/**
 * Collection READ tools superseded by `sqa_query` on SimplifyQA. They are not registered at all for
 * SQA connections (the write/authoring/analysis tools with the same prefixes stay). `list_projects`
 * is here too: `sqa_query` reads `projects` with no project selected (`member:true` = your own).
 */
const SQA_GENERIC_READ_TOOLS = new Set([
  'list_projects',
  'tc_list', 'tc_get', 'journal_grep',
  'story_list', 'story_get',
  'epic_list', 'epic_get', 'feature_list', 'feature_get',
  'list_releases', 'list_sprints',
  'list_modules', 'get_module',
  'list_functions', 'get_function',
  'suite_list', 'suite_get',
  'list_users',
  'object_list', 'object_get', 'tc_list_objects',
  'defect_list', 'task_list',
  // NOTE: tc_list_environments / tc_get_testdata / tc_list_formulas are deliberately NOT listed
  // here. They are not generic collection reads — they are the testdata surface (env keys,
  // parameter names + seeds with protected values masked, formula names), they are implemented in
  // the SimplifyQA adapter, and tc_generate_testdata's own instructions tell the caller to use two
  // of them. Skipping them left those instructions pointing at tools that did not exist.
]);

/** Proxy that silently drops registrations for `skip` — lets us keep the existing modules untouched. */
function skipTools(server: McpServer, skip: Set<string>): McpServer {
  const register = server.registerTool.bind(server) as unknown as (name: string, ...rest: unknown[]) => unknown;
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'registerTool') {
        return (name: string, ...rest: unknown[]) => {
          if (skip.has(name)) return undefined;
          return register(name, ...rest);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as McpServer;
}

/**
 * Common QA MCP -- the product-neutral core. This is the STANDALONE build: it carries the API
 * lifecycle surface (connection, projects, discovery, drafts, save-orchestration) that routes to a
 * product adapter -- Walnut over REST, SimplifyQA over its own MCP. The browser-recording + live
 * editor tools are agent-bound (they need a real browser/Electron window) and live in the Walnut
 * agent, which mounts this same core with those extra deps injected.
 *
 * `| undefined` on the optional fields is deliberate (exactOptionalPropertyTypes): callers thread
 * them through from other optional values, e.g. `walnutUiOrigin: config.walnutUiOrigin`.
 */
export type ServerDeps = {
  adapter: ProviderAdapter | null;
  /** The LIVE connection (mount.ts supplies one); tools read it per call so runtime qa_connect /
   *  header-primed connections win over the startup adapter. */
  connection?: QaConnection | undefined;
  mode?: 'connected' | 'offline' | undefined;
  /** Startup project id — scopes stored failure analyses when there is no live connection. */
  projectId?: string | undefined;
  /** Failure-analysis store; defaults to the process-wide one (tests pass their own). */
  failureStore?: FailureAnalysisStore<FailureAnalysis> | undefined;
  drafts?: DraftStore | undefined;
  walnutUiOrigin?: string | undefined;
  agentUrl?: string | undefined;
  openEditorWindow?: ((url: string, title: string) => Promise<boolean>) | undefined;
  /** False when the server is reachable from other machines: then a caller-supplied `outDir` is ignored
   *  and files go under `<cwd>/qa-reports` (tools/outDir.ts). Default true (stdio / loopback). */
  allowOutDir?: boolean | undefined;
};

/**
 * ONE failure-analysis store per process. mount.ts builds a server per HTTP session, so a per-build
 * store would lose every analysis on a client reconnect. Isolation is by owner (token hash + project),
 * not by server instance.
 */
const sharedFailureStore = new FailureAnalysisStore<FailureAnalysis>();

const OFFLINE_TOOLS = ['actions_catalog', 'tc_draft_create', 'tc_draft_update', 'tc_draft_get', 'tc_draft_discard', 'tc_draft_open'];

/**
 * MCP `initialize.instructions` — surfaced by every compliant client (Claude, VS Code, Cursor,
 * Windsurf, Devin) into its LLM system prompt. Load-bearing for weaker orchestrators (Devin) that
 * would otherwise freelance with shell/curl when a tool errors. Stays short — it complements, not
 * replaces, per-tool descriptions (which the LLM also reads).
 *
 * Provider-aware: SimplifyQA record-from-scratch uses granular verbs orchestrated on the client
 * (core_activate_technology → web_launch_application → web_snapshot + verbs → core_close_session),
 * driven from `tc_record_append` which itself returns the numbered guide at call time. Walnut uses
 * the bundled `web` sub-agent (single call, poll status). Unknown/offline gets a discovery hint.
 */
export function recordingInstructionsFor(provider: 'walnut' | 'simplifyqa' | 'unknown'): string {
  const common = [
    'You are driving Simplify3x Connect (simplify3x-connect), which fronts a QA product (Walnut or SimplifyQA).',
    '',
    'GROUND RULES (all providers, always):',
    '- FIRST turn: call `qa_connection_status` to see what is connected and which project is active.',
    '  If not connected, call `qa_connect({ url, token, projectId })`.',
    '- Project is NEVER assumed. If none is active, list the user\'s projects (SimplifyQA: `sqa_query({ op:"search", collection:"projects", where:[{ field:"member", value:true }] })`; Walnut: `list_projects`) and ASK the user which one, then `qa_switch_project`.',
    '- NEVER save without an EXPLICIT user instruction ("save it" / "persist it"). A finished recording is a DRAFT - stop and show it. "Looks good" is approval of content, NOT permission to save. ONE EXCEPTION: an API recording auto-saves ONCE after its LAST api_send_request (see API below), so the recorded test case is searchable without clicking Send and Save.',
    '- NEVER call an MCP endpoint directly with curl / Invoke-RestMethod / raw JSON-RPC. NEVER shell out to work around a failing tool. If a tool errors or is missing, REPORT the error and STOP — do not synthesize a workaround.',
    '- Follow each tool\'s own description — many tools RETURN a numbered guide in their response (notably `tc_record_append`). Do exactly what the returned guide says.',
    '- If the user asks for something this MCP does not expose (e.g. activity / audit / login logs), say plainly that it is not available here and stop. NEVER answer with a look-alike collection (scheduleHistory is scheduler runs, not an activity log).',
    '- When a result carries a `visibility` note (SimplifyQA users / projects), the list is only what THIS user can see. Say so in the answer ("341 users who share a project with you"), never "all users" / "every project".',
    '',
  ].join('\n');

  if (provider === 'simplifyqa') {
    return common + [
      'RECORDING ON SIMPLIFYQA — THE DIRECT FLOW (all technologies: WEB / MAINFRAME / ANDROID / IOS / API / DATABASE / DESKTOP):',
      'The SimplifyQA local agent does NOT expose bundled `web` / `mainframe` / `android` / `ios` / `db` sub-agent tools — calling them errors with "unknown tool". Recording is orchestrated by YOU (the LLM) through granular verbs.',
      '',
      'NO PRE-FLIGHT. Do NOT create a draft. Do NOT open anything. Do NOT call any `tc_*` tool before `core_activate_technology`. The recording session IS the entry point — `core_activate_technology` launches the recorder and creates the test-case shell itself. Save happens when the user clicks Save Testcase in the SimplifyQA recorder UI, or when they explicitly ask you to save from chat and you call `tc_save({ sessionId })` (that clicks the recorder window\'s own Save button).',
      '',
      'Common shape for every technology:',
      '  1. `qa_connection_status` — verify connected + note the projectId.',
      '  2. Ask the tech-specific setup questions BEFORE activation (WEB needs the AI-only vs AI + Manual recording mode AND `recordingModeAskedUser`, asked on EVERY recording — never reused; mainframe needs route + `app_path`; android/ios need the platform (`Android or iOS?` → `platformAskedUser`) plus `deviceId` when >1 device; desktop needs the application\'s full `.exe` path, with the application closed first).',
      '  3. `core_activate_technology({ technology: "<WEB|MAINFRAME|ANDROID|IOS|API|DATABASE|DESKTOP>", testcaseName, ...tech args })` — ONCE, at start. response.structuredContent.sessionId is the recording id. A clashing `testcaseName` is REFUSED — ASK for another name, or pass `allowDuplicateName: true` only when the user explicitly wants a duplicate.',
      '  4. `<tech>_launch_application({ ... })` — ALWAYS the FIRST action call. No snapshot / verify / save before it.',
      '  5. `<tech>_snapshot()` to get element refs (web/android/ios/desktop only; mainframe has no snapshot). Reuse refs while the page/screen is unchanged. Pass a ref to the action verb — NEVER a raw locator.',
      '  6. Per user intent: one snapshot ref + exactly ONE action verb + one narration line.',
      '  7. On error inside recording: ONE fresh `<tech>_snapshot` + retry once (skip on mainframe), then STOP and report.',
      '  8. `core_close_session()` when the flow is done. Unsaved steps make it REFUSE and return a one-shot `confirm: "<token>"` — ASK the user (SAVE / DISCARD / CLOSE ANYWAY) and only retry with the token when they explicitly choose to discard.',
      '  9. STOP. Report the recording session id. Tell the user to review captured steps in the SimplifyQA recorder UI and click Save Testcase — the recorder UI persists it. If the user EXPLICITLY says save from chat, call `tc_save({ sessionId })` instead — it clicks the recorder window\'s own Save, so the saved TC is exactly what the window shows. Do NOT call `tc_save({ draftId })` / `tc_draft_from_journal` / `update_testcase` / `journal_modify` for a live recording, and never do BOTH (duplicate TC).',
      '',
      'WEB: `core_activate_technology({ technology: "WEB", testcaseName, recordingMode: "AI"|"HYBRID", recordingModeAskedUser: "ai"|"hybrid" })` → `web_launch_application({ url })` → `web_snapshot` + `web_click` / `web_enter_text` / `web_select_item_from_dropdown` / `web_validate_text` / `web_keyboard_action`. ASK "AI-only or AI + Manual?" on EVERY WEB recording (AI + Manual = HYBRID; if the user already named it, use that) and pass BOTH fields (they must match) — never reuse an earlier answer; the tool refuses without them. Tabs: `web_switch_to_tab` / `web_switch_to_parent_tab` / `web_close_tab`. Iframes: `web_switch_to_iframe({ ref })` / `web_switch_to_parent_iframe` / `web_switch_to_default_content`. Formulas: pass `formula: { name, args? }` (from `tc_list_formulas`) or `formula: { expression }` to `web_enter_text` / `web_keyboard_action` to generate a field\'s value instead of typing a literal — the recorder types a fresh value and the saved step regenerates per run; only when the user asks for a formula value.',
      '',
      'MAINFRAME: ASK the ROUTE first (never pick / never infer). Emulator route: `app_path` (Windows-only, one recording at a time). Direct route: `host` + `port` + `marker` (any OS, several in parallel). `core_activate_technology({ technology: "MAINFRAME", testcaseName, app_path? OR host? + port? + marker? })` → `mainframe_launch_application` is FIRST. NO snapshot — target fields by `{ by: "label" | "position", target }`. AID keys: `mainframe_keyboard_action({ keys: "ENTER" | "PF3" })`. A failed step ends the session. Formulas: pass `formula: { name, args? }` or `formula: { expression }` to `mainframe_enter_text` to generate a field\'s value instead of a literal — only when the user asks for a formula value.',
      '',
      'ANDROID: `android_list_devices` FIRST (never guess a device or a package id). Resolve the app the user names to its exact `package` from that list. ASK "Android or iOS?" on EVERY mobile recording and pass `platformAskedUser: "android"` (must match `technology`; the tool refuses without it). `deviceId`: omit only with exactly one device; ASK with several. `core_activate_technology({ technology: "ANDROID", testcaseName, platformAskedUser: "android", deviceId })` → `android_launch_app({ package, activity? })` is FIRST → `android_snapshot` returns refs (`e1`, `e2`, … tagged `id|desc|text|bounds|xpath`) → `android_click` / `android_enter_text` / `android_validate_text`. Do NOT add generic_wait pauses on android — the verbs already wait. Formulas: pass `formula: { name, args? }` or `formula: { expression }` to `android_enter_text` to generate a field\'s value instead of a literal — only when the user asks for a formula value.',
      '',
      'IOS: `ios_list_devices` FIRST — match user\'s app word against the DISPLAY NAME (bundleId is opaque). ASK "Android or iOS?" on EVERY mobile recording and pass `platformAskedUser: "ios"` (must match `technology`; the tool refuses without it). `deviceId` rules match android. `core_activate_technology({ technology: "IOS", testcaseName, platformAskedUser: "ios", bundleId, deviceId })` → `ios_launch_app` is FIRST → `ios_snapshot` + `ios_click` / `ios_enter_text` / `ios_validate_text`. Real device does NOT need macOS (go-ios drives it); simulator does. `projectId` is for WDA signing on real devices only. Formulas: pass `formula: { name, args? }` or `formula: { expression }` to `ios_enter_text` to generate a field\'s value instead of a literal — only when the user asks for a formula value.',
      '',
      'API: no device, no app_path, no snapshot. `core_activate_technology({ technology: "API", testcaseName })` returns `structuredContent.sessionId` — KEEP it (it is the journal id for the save step; `core_active_recordings({})` is the fallback). Then `api_send_request({ method, url, headers?, query?, body?: {type,data:{payload}}, auth?: {type,token|username+password|key+value}, assertions?: [{path,condition,expectedValue}], extract?: [{path,store_as}] })` one call per request. Bodies are JSON/XML/TEXT/NONE — FORM_DATA and X_WWW_FORM_URLENCODED are not wired to the plugin yet (rejected). Supports `{{var}}` interpolation across chained calls (extract $.token in call 1, use `{{token}}` in call 2\'s auth.token). API steps STREAM into the `/mcp-recorder` window (RECORDED_API_STEP). **AUTO-SAVE: after the LAST `api_send_request` of the recording, call `tc_save({ sessionId })` ONCE, without asking** — this is the one exception to the explicit-save rule, and only for API recordings. It persists the test case and its steps so they are searchable/viewable/executable immediately, without the user having to click Send and Save in the API popup. Save ONCE at the end; never save after each request (that creates duplicate test cases). If it fails with `recorder save request failed`, persist from the journal instead: `tc_draft_from_journal({ sessionId })` → optional `tc_draft_update` → `tc_save({ draftId })` (no `core_close_session` needed). Never do both — that creates a duplicate test case. Report the created TC id and tell the user it is already saved. To add assertions to a SAVED API step later, use `journal_modify({ tcId, ops:[{ op:"add_assertions", n, assertions:[{ path:"responseTime", condition:"LESSER_THAN", expectedValue:"3000" }] }] })` — it APPENDS to that step and leaves the request, object, action, parameters and existing assertions untouched. Never re-record a test case just to add an assertion.',
      '',
      'DATABASE: no device, no app_path, no snapshot; the recorder window opens on activation and streams each step. `core_activate_technology({ technology: "DATABASE", testcaseName })` → `db_connect({ dbType, host, port, user, password, database })` (or `connectionString`) is FIRST — ASK the user for the connection details, never invent them → `db_execute_query` / `db_update` / `db_read_data` / `db_insert_data` → `db_close` (MongoDB: `db_connect_mongo` + `db_insert_document` / `db_update_documents` / `db_read_documents`). Every call executes LIVE and is recorded only if it succeeds; a failure returns the plugin error and records nothing. `store_as` captures a result (required by `db_read_data` / `db_read_documents`), `from_runtime` reuses it. SAVE: the user clicks Save Testcase in the recorder window; if the user explicitly asks you to save from chat, call `tc_save({ sessionId })` — it clicks the window\'s own Save, so the recorded DB steps are saved exactly. Headless fallback only when the user does not want the UI or it is unavailable — `core_close_session()` → `tc_draft_from_journal({ sessionId })` → `tc_save({ draftId })` (explicit user save instruction only; never both).',
      '',
      'DESKTOP (Windows desktop applications): no device, no browser. ASK for the application\'s full `.exe` path unless the user gave it (never search the filesystem), and ASK the user to CLOSE the application if it is already open — a second launch is refused and there is no attach. `core_activate_technology({ technology: "DESKTOP", testcaseName })` → `desktop_launch_application({ app_path })` is FIRST → tell the user NOT to touch the mouse or keyboard until you finish (steps use the real mouse and keyboard) → `desktop_snapshot()` returns refs (`e1`, `e2`, …) → `desktop_click` / `desktop_enter_text` / `desktop_select_item_from_dropdown` / `desktop_set_checkbox` / `desktop_invoke_menu_item` / `desktop_validate_text` with `{ ref }`. Take a new `desktop_snapshot` after a step that changes the window. If the user names an element the outline does not show, call `desktop_snapshot({ all: true })`: every element gets a ref; on a ref marked `(hidden from the control view)`, prefer `desktop_click` and `desktop_enter_text`. Windows switch by themselves: every ref knows its window, and a step on a ref in another window (a dialog, a pop-up) records `desktop_switch_window` / `desktop_switch_to_root` first. Each step result names window changes in a `Windows:` line (a dialog opened, a window closed or was renamed); when it includes an outline, its refs replace the earlier ones — act on them without a new snapshot. A step on a window that a dialog blocks is refused, with the dialog\'s outline. Menu bar: `desktop_click` the menu ("File") to open it, then `desktop_invoke_menu_item` on its item (the outline marks such items `(open "File" first)`). A right-click menu or an open drop-down list is OUTSIDE the window: after opening it, call `desktop_snapshot({ scope: "popups" })` and act on those refs. A dialog that is not in the snapshot: `desktop_list_windows` → `desktop_switch_window({ window_name })` → `desktop_snapshot()`. Pass `xpath` instead of `ref` only when the user gives an exact XPath. Formulas: pass `formula: { name, args? }` or `formula: { expression }` to `desktop_enter_text` / `desktop_set_text` to generate a value instead of a literal — only when the user asks for a formula value. Reuse a saved desktop function with `core_reuse_function({ function, params })`: it runs live and records one function step. A function that starts with Launch Application launches the application itself — reuse it right after `core_activate_technology`, INSTEAD of `desktop_launch_application` (after a launch it is refused). SAVE: the user clicks Save Testcase in the recorder window; if the user explicitly asks you to save from chat, call `tc_save({ sessionId })` — it clicks the window\'s own Save.',
      '',
      'Automate an EXISTING manual test case (any tech): `tc_automate({ tcId, url, extra? })` first — returns a guide built from the manual steps (with testcaseName + userstoryId/moduleId already derived). Then run the same common-shape steps. Save is via the recorder UI\'s Save Testcase button, or `tc_save({ sessionId })` when the user explicitly asks you to save from chat. Do NOT call `tc_save({ draftId })`.',
      'After that automated test case is SAVED, LINK it to the source manual TC: `tc_list_link_types` → SHOW the options → ASK the user which one → `tc_link({ fromTcId: <manual>, toTcId: <automation>, linkType: <chosen> })` (both directions by default). Never choose a link type yourself.',
      '',
      'READS / QUERIES: `sqa_query` is the ONLY read tool on SimplifyQA. Use it for EVERY fetch, query, list, search, get, read or count — the old per-collection reads (tc_list, tc_get, story_list, story_get, epic_list, feature_list, list_modules, list_functions, suite_list, list_users, object_list, defect_list, task_list, list_releases, list_sprints, journal_grep, …) are NOT registered. Do not look for them and do not invent one. This includes projects (works with no project selected): "how many projects" → `{ op:"count", collection:"projects" }` (an admin sees every project in the tenant); "my projects" → add `where:[{ field:"member", value:true }]`.',
      '  Flow: `sqa_query({ op:"catalog" })` (or `catalog` with a collection) → `{ op:"search", collection, where, sort, limit }` or `{ op:"get", collection, id }` → `{ op:"related", collection, id, relation }`. Any "show / list / find / get / fetch / count ..." request goes here.',
      '  It always filters `deleted:false`, scopes to the active project, rejects unknown fields locally, and resolves custom fields: `op:"custom_fields"` returns label → key → `customFields.<key>`; then pass the label with `custom:true` in `where`. Test cases have NO priority/status columns — use `reviewApproveStatus` or a custom field. The one exception is a FAILED run: analyse it with `failure_analysis` (below), not by reading its steps with `sqa_query`.',
      'COLUMN PREFERENCES (user-level, per list view): `column_preference({ action:"set", lists:["epic","feature","userstory"], column:"Created On" })` shows that column in the SimplifyQA UI list view (the same write as ticking it in Column Preference); `enabled:false` hides it; `action:"get"` reports the current columns. Lists: epic, feature, userstory, testcase (Test Case list), suite (Suite test cases), scenario (Test plan test cases), executionplan (Execution Plan test cases — e.g. column:"Execution Type"). It takes effect on the UI after a refresh.',
      'SPREADSHEET IMPORT: `excel_import({ filePath:"<absolute path>", kind:"testcases"|"testdata"|"plan_entries" })` reads .xlsx/.csv/.tsv the way the UI Import does. testcases: one MANUAL TC per row (name/title required; description, steps (newline or | separated), expected result, module, story headers). testdata: needs tcId + environmentType, one iteration per row, columns = parameter names. plan_entries: needs planId, first column = test case codes. It reports created/added and every rejected row; `dryRun:true` writes nothing. Never say the MCP cannot import a spreadsheet.',
      'ACTION CATALOGUE (Object Templates): a "sync actions" run is applied SERVER-SIDE by SimplifyQA and can replace an Object Template\'s action list. Before such a sync call `action_template_backup({ action:"save" })` (snapshot of every action + count per template); after it `action:"verify"` lists the actions a template lost and `action:"restore"` (dry-run first, then `confirm:true`) re-creates exactly those — it never deletes or edits an action.',
      'ATTACHMENTS (epic / feature / user story / defect): `attachment_add({ entityType:"epic"|"feature"|"userstory"|"defect", itemId, filePath:"<absolute path>" })` uploads one file and reads the item\'s attachments back to confirm; the file appears in the UI\'s Attachments section. A screenshot pasted in chat has no local path — ASK for its absolute path (or accept base64 + fileName). `attachment_delete({ entityType, itemId, attachment })` removes a wrong upload.',
      'WATCH LIST (the UI email button): `epic_create` / `feature_create` / `story_create` accept `watchList:["email-or-name-or-id", …]`; for an existing item use `watch_list_add({ entityType, itemId, users:[…] })`. Emails/names/ids resolve to user ids and the item is re-read to confirm. Never say you cannot set the Watch List.',
      'LINKAGES (the UI Linkages section): `backlog_link({ sourceType:"epic"|"feature"|"userstory"|"defect", sourceId, destType:"defect"|"epic"|"feature"|"userstory"|"task", destId, linkType:"Clones" })`. linkType is the displayed link-type name; it is matched to the project link-type config (unknown → refused with the list) and the link is read back from /pm/linkages.',
      'PROJECTS: `project_create({ name, description?, users? })` creates a project (the admin Project screen form), reads it back and returns its id + PR code — then `qa_switch_project` to work in it. `project_delete` is TWO-STEP (preview, then confirm:true). Never say you cannot create a project.',
      'ENVIRONMENTS: `environment_manage({ action:"create", name:"Mcp env" })` creates a project environment (project configuration > Environments, next to General) with the UI\'s exact key format; `action:"update", environment:"<current name or key>", name?/key?` renames or re-keys one; `action:"delete", environment:"…"` is TWO-STEP (preview, then confirm:true, General refused). Every write posts the whole environment list to /pm/fields/savefields exactly as the UI does and is read back to confirm. The saved environment is selectable for executions, schedules, pipelines and execution plans (read them with `sqa_query` collection "environments"). Never say the MCP cannot create an environment.',
      '',
      'TEST EXECUTION (SimplifyQA): suites `suite_manage`, execution plans `execution_plan`, test plans `test_plan`, pipelines `pipeline`, schedules via `schedule_*` (and `tc_run` / `suite_run` with when:"schedule"; execution plans cannot be scheduled - the SimplifyQA Scheduler takes a test case or a suite). Every DELETE (a test case, a suite, a plan/folder, an execution plan) is TWO-STEP: the first call only previews - show it, and call again with confirm:true ONLY after the user explicitly says so. Start a run or create a schedule ONLY on an explicit instruction. SimplifyQA execution plans run LOCALLY only. SimplifyQA has no pause for a schedule (cancel it, or give it a new start time). Removing ONE test case from a test plan is a plain edit, not a delete: `test_plan({ action:"remove_testcase", testPlanId, tcId })` removes only that case, is re-read to confirm, and leaves the suites, other test cases and sub-folders alone (re-add it with action:"add").',
      '',
      'FAILED RUNS: call `failure_analysis({ code })` with TC-123 / SU-123 / PL-123 (PL = execution plan) for its latest execution; add `executionId` to analyse that code inside only that execution (or pass `executionId` alone for the whole execution). Pass `codes:[…]` / `executionIds:[…]` to analyse several together. It returns an `analysisId` and a card (failures by category, patterns, failed test cases) followed by evidence; page unseen patterns with `failure_analysis({ analysisId, pattern:[…] })` as its "Next:" line says, then review every failed test case with `failure_analysis({ analysisId, review: true })` page by page (failed vs baseline vs last-passed screenshots and the data of both steps). Then call `failure_analysis_classify` ONCE with a verdict for every pattern, and START YOUR REPLY WITH THE CLASSIFIED CARD IT RETURNS EXACTLY AS RETURNED — same tables, rows and columns, never summarised or reworded — then add Why and Fix per pattern from the evidence; `failure_analysis_export` writes the Excel / PDF report. Do not assert a cause the evidence does not support.',
      '',
      'Rules while recording (all technologies):',
      '- Record ONLY what the user asked for. Do NOT add extra verify/validate steps unless the user says "verify" / "assert" / "check".',
      '- For a randomized value (e.g. random Indian name), use `generic_generate_random_alphanumeric({ count, store_as: "<name>" })` and reference later via `from_runtime: "<name>"` in the enter/select verb — NEVER pass `${name}` as a literal.',
      '- Control flow: `core_if` / `core_else_if` / `core_else` / `core_end_if`; `core_loop({ count })` / `core_end_loop`; `core_reuse_function({ function, params })` to reuse a saved function. Balance every open with its close.',
      '- Building a test case OUT OF saved functions ("use these functions and create a new tc"): draft ONE step per function, in run order, with `tc_draft_create({ title, steps: [{ description: "<narrative>", actionType: "function", stepType: "function", functionCall: { testCaseId: "FN-12" } }, …] })`, then `tc_save({ draftId })`. The matching FUNCTION_END is generated automatically and the function\'s newest version is pinned at save. Resolve the functions first with `sqa_query({ op: "search", collection: "functions" })`; pass the id or the FN-code (both work). NEVER author a `function_end` step yourself, and never fake a function call with ordinary click/type steps.',
      '- **A test case made of EXISTING functions is NOT a recording — do NOT call `core_activate_technology` for it.** ("create a test case with all the MongoDB functions", "use these functions to make a tc" → list the functions, then `tc_draft_create` + `tc_save` as above.) Recording is only for capturing NEW steps. In particular `core_reuse_function` DRIVES the function live, which DATABASE/API sessions cannot do (it fails with "executeResolved is not supported by this technology") — for a functions-only test case that live drive is never needed.',
      '- **Updating an EXISTING test case\'s test data / adding a formula there: `tc_update_testdata({ tcId, environmentType, cells: [{ param, value } | { param, formula: { expression } }] })`.** It writes the DEFAULT iteration (ITR-1) - the row a run actually uses - and leaves every other column alone. `tc_generate_testdata` APPENDS iterations and never becomes the default, so a formula saved there does NOT affect the next run. Formulas must come from `tc_list_formulas` (never invent names); TODAY takes a QUOTED offset like `=TODAY("d+365")`, not `ddmmyyyy`.',
      '- **Suite-level test data is a SEPARATE store from the member test cases.** When the user says "SU-24 test data" / "suite level only", use `suite_get_testdata({ suiteId, environmentType })` to read it and `suite_copy_testdata({ suiteId, environmentType, from?, name? })` to copy a row (e.g. ITR-1 → ITR-2) — the copy is saved on the SUITE and NEVER touches the member test cases\' own test data; both tools read the rows back to confirm. Do NOT use tc_generate_testdata / tc_update_testdata on the member TCs for a suite-level request. To remove an iteration row created by mistake: `testdata_delete_iterations({ entityType:"TC"|"SU", tcId?|suiteId?, environmentType, iterations:["ITR-2"] })` — the DEFAULT row cannot be deleted.',
      '- Never record a rejected step (intent count == recorded-step count). Always supply object_name / parameter_name / step_description.',
      '- **OBJECT PARAMETERIZATION ("use object parameterization", "make the menu item a parameter of the object"):** the recorder has no tool for it. Record the click normally on the REAL element (e.g. PIM) and write the parameter in the step_description as `${name}` — "Click side menu item ${menu_name}". Do NOT invent `object parameter menu_name = PIM` in your reply. tc_save then turns that click into a real "Parameter of object": the locator text (PIM) becomes `{{id}}` and the test data holds PIM. Check the save reply for the "Object parameter … set on step(s) …" line; if it says it could not, run `object_parameterize({ tcId, step, parameterName, value })`. If the save reply warns that an object parameter has an EMPTY test-data value, fix it yourself right away — `tc_update_testdata({ tcId, cells: [{ param: "menu_name", value: "PIM" }] })` with the value the user gave — and read the test data back; never leave it empty or tell the user it is set when it is not.',
      '- **THE MOMENT A RECORDING FINISHES, BEFORE ASKING TO SAVE: call `tc_suggest_function_groups({ sessionId })`.** It answers with two lists: `replace` — blocks of the recorded steps that ALREADY exist as a reusable function, and `create` — contiguous blocks worth extracting into a NEW function. Show BOTH and ASK the user per block: "create a new function (name?)", "replace with FN-x", or "keep as is" — never decide for them. APPLY AFTER the test case is saved (both need a saved tcId): `tc_steps_to_function({ tcId, stepSeqs, name, moduleId, replaceInSource: true })` for a create, `tc_replace_with_functions({ tcId, replace: [{ fnId, stepSeqs }] })` for a replace. If the lists are empty, say nothing and continue. This is a suggestion — it is NOT a save instruction.',
    ].join('\n');
  }

  if (provider === 'walnut') {
    return common + [
      'RECORDING A WEB TEST CASE (Walnut):',
      'Walnut exposes bundled technology SUB-AGENT tools — one call starts a real browser recording driven by the agent\'s own LLM loop.',
      '  1. `qa_technology_status` — confirm `web` is available.',
      '  2. ASK the user about REUSE first: an existing Login as `nestStart`, Logout as `nestEnd`? Find ids via `tc_list`.',
      '  3. `web({ task, url, nestStart?, nestEnd? })` — `task` is the complete goal ("Sign in at <url> as X/Y, then verify Z"). Returns immediately with `{ sessionId, status: "recording" }`. Call ONCE — do NOT retry it.',
      '  4. POLL `web_status({ sessionId })` every ~15-20 seconds until `status: "done"`. It returns `{ draftId, tc, stepCount }`.',
      '  5. Show the draft in plain language. Wait for an EXPLICIT save instruction, then `tc_save({ draftId })`.',
      '',
      'Mainframe / Android / iOS follow the same START → POLL `<tech>_status` → save shape; each has route/device questions to ask the user FIRST (see per-tool descriptions).',
    ].join('\n');
  }

  return common + [
    'RECORDING: provider is not yet resolved. Call `qa_connection_status` first — the response names the product, and the per-tool descriptions from `tools/list` will guide the flow (SimplifyQA uses granular verbs orchestrated via `tc_record_append`; Walnut uses the bundled `web` sub-agent).',
  ].join('\n');
}

export function buildServer(deps: ServerDeps): McpServer {
  // Provider known at boot from the live connection, or env when standalone (no mount.ts wrap).
  // Unknown = offline / no config yet — the instructions still steer the LLM to discover via
  // `qa_connection_status` before recording.
  const envProvider = (process.env['QA_MCP_PROVIDER'] ?? '').toLowerCase();
  const provider: 'walnut' | 'simplifyqa' | 'unknown' =
    deps.connection?.config().provider
    ?? (envProvider === 'simplifyqa' || envProvider === 'walnut' ? envProvider : 'unknown');
  const server = new McpServer(
    { name: 'simplify3x-connect', version: VERSION },
    { instructions: recordingInstructionsFor(provider) },
  );
  const drafts = deps.drafts ?? new DraftStore();

  // On SimplifyQA the collection reads are gone: ONE `sqa_query` tool replaces them. The write,
  // authoring, analysis and run tools stay registered. Walnut keeps its existing read surface.
  const toolServer = provider === 'simplifyqa' ? skipTools(server, SQA_GENERIC_READ_TOOLS) : server;

  server.registerTool('project_info', {
    title: 'Check the connection and project',
    description: 'Validate the configured connection and return provider, org/project and entity counts.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, async () => {
    // The live connection wins over startup state: the user may have connected/disconnected since
    // boot (qa_connect or config headers), so reporting the boot-time mode would be wrong.
    const live = deps.connection?.describe();
    const adapter = deps.connection ? deps.connection.adapter() : deps.adapter;
    const mode = live ? live.mode : deps.mode;

    if (mode === 'offline') {
      return ok(
        'Offline: no backend connection, so nothing is persisted anywhere.\n\n' +
          `Available offline: ${OFFLINE_TOOLS.join(', ')}.\n` +
          'Author a draft with tc_draft_create / tc_draft_update and open it with tc_draft_open.\n\n' +
          'To work with EXISTING test cases (list, read, modify, run), connect first:\n' +
          '  qa_connect({ url: "https://<your-product>", token: "<token>", projectId: "<id>" })',
        { mode: 'offline', availableTools: OFFLINE_TOOLS, ...(live ? { connection: live } : {}) },
      );
    }
    if (!adapter) return err('No provider configured. Use qa_connect, or set QA_MCP_URL/TOKEN/PROJECT_ID.');
    try {
      const info = await adapter.info();
      // Best-effort: say up front whether this user can record here (the same gate
      // core_activate_technology enforces). A provider without a role model, or a lookup hiccup,
      // must never break project_info — it is a diagnostic, not the source of truth.
      const privileges = adapter.getProjectPrivileges
        ? await adapter
            .getProjectPrivileges()
            .then((p) => buildPrivilegeReport(p))
            .catch(() => null)
        : null;
      return ok(
        `Connected: ${info.provider} · project ${info.projectName} (${info.projectId})`
          + (live?.source === 'runtime-connect' ? ' · via qa_connect' : ' · from startup config')
          + (privileges ? `\nRecording: ${privileges.verdict === 'ok' ? 'allowed' : 'NOT allowed'} — role ${privileges.role?.name ?? 'none'}${privileges.missing.length ? ` (missing ${privileges.missing.join(', ')})` : ''}` : ''),
        { info, ...(live ? { connection: live } : {}), ...(privileges ? { privileges } : {}) },
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  });

  // Runtime connect/disconnect/switch -- only when the host wired a live connection (mount.ts does).
  if (deps.connection) registerConnectionTools(toolServer, deps.connection);

  registerTestcaseTools(toolServer, {
    drafts,
    walnutUiOrigin: deps.walnutUiOrigin,
    agentUrl: deps.agentUrl,
    openEditorWindow: deps.openEditorWindow,
    // tc_save persists a draft to the product via the current provider adapter (create/update),
    // forwarded across the hop — same live-connection-wins rule as discovery.
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
    // Draft validation must use the RIGHT action vocabulary. SimplifyQA's is the backend's own
    // (e.g. `executerestapi`), so it must NEVER be checked against Walnut's static table — that is
    // what falsely rejected valid SQA API/other steps as "not in catalog". Live connection wins;
    // else the boot-time/env provider.
    isSimplifyqa: () =>
      (deps.connection?.config().provider
        ?? (envProvider === 'simplifyqa' ? 'simplifyqa' : undefined)) === 'simplifyqa',
  });

  // Read side of the shared lifecycle contract (list_projects / tc_list / tc_get). Reads the current
  // provider adapter per call -- the live connection wins over the startup adapter, like project_info.
  registerDiscoveryTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
    allowOutDir: deps.allowOutDir !== false,
    // tc_save_as_new_version({ fromDraftId }) freezes an EDITED draft — read it from the same store
    // the testcase tools write to. A missing/expired draft returns null (the tool reports it).
    getDraft: (draftId: string) => {
      try { return { tc: drafts.get(draftId).tc }; } catch { return null; }
    },
  });

  // Generic SimplifyQA query surface: one tool (sqa_query) over every collection. It replaces the
  // list/get reads above; those stay registered for compatibility while the migration lands.
  registerQueryTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });

  // Recording preflight (qa_privileges): what this user may create in the selected project. The
  // product agent enforces the same set in core_activate_technology; this is the readable surface.
  registerPrivilegeTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });

  // Object Repository surface (object_list / object_get / object_delete) — same live-connection-wins
  // rule as discovery/run tools.
  registerObjectTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });

  // Story ↔ manual-testcase drift detection (report-only; agent applies via tc_draft_*).
  registerStorySyncTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });

  // Backlog CRUD — epic / feature / story create+update plus epic/feature list+get.
  // story_list / story_get stay in discovery.tools.ts (older).
  registerBacklogTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });

  // Run surface (cloud_runners / tc_run / run_status / run_stop) -- same live-connection-wins rule;
  // the run is forwarded to the product MCP (local dispatches to the agent, cloud to a runner VM).
  // `getProjectId` keys the in-session "reuse last run config?" prompt to the connected project.
  // Failure Analysis v2: the process-wide store (survives per-session rebuilds), shared by
  // analyse/view/classify and export; entries are scoped to the owner (token hash + project).
  const failureStore = deps.failureStore ?? sharedFailureStore;
  const failureDeps = {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
    allowOutDir: deps.allowOutDir !== false,
    getOwnerKey: (): string | null => {
      if (deps.connection) {
        const c = deps.connection.config();
        return c.mode === 'connected' ? ownerKey(c.token, c.projectId) : null;
      }
      return deps.adapter ? `local:${deps.projectId ?? ''}` : null;
    },
    store: failureStore,
  };
  registerFailureTools(toolServer, failureDeps);
  registerFailureExportTools(toolServer, failureDeps);

  registerRunTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
    getProjectId: () => {
      const d = deps.connection?.describe();
      return d && d.mode === 'connected' ? d.projectId || null : null;
    },
  });

  // Suites: update / two-step delete; execution plans: create / update / delete / entries / run
  // (SimplifyQA). The API checks the privileges; the adapter checks project ownership.
  registerSuiteManageTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });
  registerExecutionPlanTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });
  registerReleaseSprintTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });
  registerObjectParameterizeTool(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });
  registerDefectUpdateTool(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });
  registerDefectFromStepTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });

  registerTestPlanTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });

  registerPipelineTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });

  // Testdata generation (tc_generate_testdata) -- fetches the default iteration template from the
  // product MCP, generates N rows client-side, and posts them back via save_generated_iterations.
  registerTestdataTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });

  // Column preferences of the list views (epic/feature/userstory) — the UI's column-preference tick.
  registerPreferenceTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });

  // File attachments on epics / features / user stories — uploads the same way the UI's save does.
  registerAttachmentTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });

  // Project creation (project_create) — the admin Project screen's New Project form.
  registerProjectTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });

  // Project environments (create / rename) — the project configuration's Environment editor.
  registerEnvironmentTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });

  // Spreadsheet import (.xlsx / .csv / .tsv) — test cases, test data, execution-plan entries.
  registerImportTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });

  // Action catalogue backup/verify/restore — protects Object Templates from a bad sync-actions run.
  registerActionBackupTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
    getProjectId: () => {
      const d = deps.connection?.describe();
      const id = d?.projectId;
      return id ? Number(id) : undefined;
    },
  });

  // Formula discovery (tc_list_formulas) — companion to tc_generate_testdata's `formulas` option, so
  // the model can enumerate DEFAULT prefabs + CUSTOM formulas before picking one.
  registerFormulaTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });

  // Defect tracker read surface (defect_list) — same live-connection-wins rule as discovery/run tools.
  registerDefectTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });

  // Task tracker read surface (task_list) — same live-connection-wins rule as discovery/run tools.
  registerTaskTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });

  // Heal surface (tc_heal) — product-neutral proxy. The real loop (replay + snapshot + propose +
  // verify) lives in the product agent and is invoked via adapter.callRaw. Same live-connection-
  // wins rule as run/discovery tools.
  registerHealTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });

  registerReportTools(server, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
    allowOutDir: deps.allowOutDir !== false,
  });

  // Coverage / gap aggregator across a scope (sprint / release / epic / feature / stories / project).
  // Read-only; reuses computeDrift from storySync + the existing listStories/getStory/listTestCases reads.
  registerGapAnalysisTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });

  // Blast-radius report from one anchor (defect / testcase / story / sprint / release). Read-only;
  // walks the graph via existing adapter reads and reuses gap_analysis's per-story analyser.
  registerImpactAnalysisTools(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
  });

  // Recording passthrough: mirror the product agent's browser-recording tools onto this server so
  // the client records through the one door. Agent-bound + forwarded (see recording.tools.ts).
  // Async + fire-and-forget: it waits for the connection, then registerTool emits list_changed.
  registerRecordingPassthrough(toolServer, {
    getAdapter: () => (deps.connection ? deps.connection.adapter() : deps.adapter),
    isConnected: () =>
      deps.connection ? deps.connection.describe().mode === 'connected' : deps.mode === 'connected',
    // SimplifyQA-only: gates the granular-verb proxying + real-schema preservation. Walnut unaffected.
    isSimplifyqa: () => deps.connection?.config().provider === 'simplifyqa',
    // Shared with the draft/save tools so a recorded draft bridged here is the SAME store tc_save reads.
    drafts,
  });

  return server;
}
