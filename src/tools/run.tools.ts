import { z } from 'zod';
import { log } from '../log.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import { SCHEDULE_TYPES, type CloudRunner, type LocalAgent, type MobileDevice, type RunOptions, type RunState, type RunStatus, type RunSummary, type ScheduleInfo, type ScheduleOptions, type ScheduleType, type ScheduleUpdate } from '../domain/types.js';

/**
 * The client-facing RUN surface: cloud_runners / tc_run / run_status / run_stop. Like the discovery
 * tools these need a LIVE backend, so they read the current provider adapter per call via
 * `deps.getAdapter()` and forward across the product hop. tc_run owns the local-vs-cloud DECISION
 * policy (ask when unstated; refuse cloud when no runner is online) so every client behaves the same.
 */
export type RunToolsDeps = {
  getAdapter: () => ProviderAdapter | null;
  /** Current project id, used to key the in-session "reuse last run config?" prompt. When absent
   *  or returning null, the reuse prompt is skipped entirely (tests that don't wire it get the raw
   *  cascade). */
  getProjectId?: () => string | null;
};

const NOT_CONNECTED =
  'Not connected to a product. Use qa_connect({ url, token, projectId }) first — running a test needs a live backend connection.';

/** In-process, per-project memory of the last successful run's environment-level config so the
 *  next `tc_run` / `suite_run` can offer "reuse last config?" instead of walking the full cascade
 *  again. TC-specific fields (versionId, mobile device, schedule cadence) are NOT remembered — they
 *  are inherently per-run. Cleared on process exit; not persisted. */
type LastRunConfig = {
  when?: 'immediate' | 'schedule' | undefined;
  mode?: 'local' | 'remote' | 'cloud' | undefined;
  releaseId?: string | undefined;
  sprintId?: string | undefined;
  environment?: string | undefined;
  browser?: string | undefined;
  agentId?: string | undefined;
  cloudRunnerId?: string | undefined;
};
const lastRun = new Map<string, LastRunConfig>();

function summarizeLastRun(c: LastRunConfig): string {
  const parts: string[] = [];
  if (c.when) parts.push(`when=${c.when}`);
  if (c.mode) parts.push(`mode=${c.mode}`);
  if (c.releaseId !== undefined) parts.push(`release=${c.releaseId || '(none)'}`);
  if (c.sprintId !== undefined) parts.push(`sprint=${c.sprintId || '(none)'}`);
  if (c.environment) parts.push(`env=${c.environment}`);
  if (c.browser) parts.push(`browser=${c.browser}`);
  if (c.agentId) parts.push(`agent=${c.agentId}`);
  if (c.cloudRunnerId) parts.push(`runner=${c.cloudRunnerId}`);
  return parts.join(', ');
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function runnerLine(r: CloudRunner): string {
  const host = r.os ? ` · ${r.os}` : '';
  return `- ${r.online ? '🟢' : '⚪'} ${r.name}${host} \`${r.id}\`${r.status ? ` (${r.status})` : ''}`;
}

function localAgentLine(a: LocalAgent): string {
  // Show the machine hostname next to the owner (like the product UI) so the user can tell apart
  // several agents owned by the same person; the credential_id in backticks is for the tool call.
  const host = a.host && a.host !== a.name ? ` · ${a.host}` : '';
  return `- ${a.online ? '🟢' : '⚪'} ${a.name ?? a.id}${host} \`${a.id}\`${a.status ? ` (${a.status})` : ''}`;
}

function mobileDeviceLine(d: MobileDevice): string {
  // `active` here is the last-known connection flag from the SQA DB (stale by design). Show it as
  // a hint, not a gate — a device the user just plugged in may still read `active:false` here.
  const dot = d.active ? '🟢' : '⚪';
  const label = d.displayName || d.name;
  const os = d.osVersion ? ` · ${d.platform.toLowerCase()} ${d.osVersion}` : ` · ${d.platform.toLowerCase()}`;
  const status = d.status ? ` (${d.status})` : '';
  return `- ${dot} ${label}${os} \`${d.id}\`${status}`;
}

/** One line per schedule for management listings — what it runs, cadence, where + pinned agent,
 *  browser, next run, status; the credential-free id in backticks is what the management tools take. */
function scheduleLine(s: ScheduleInfo): string {
  const where = s.executionTarget === 'cloud_runner' ? 'cloud' : 'local';
  const agent = s.agent ? ` → ${s.agent}` : '';
  const br = s.browser ? ` · ${s.browser}` : '';
  const next = s.nextRunAt ? ` · next ${s.nextRunAt}` : s.scheduledFor ? ` · at ${s.scheduledFor}` : '';
  const paused = s.active === false ? ' [paused]' : '';
  return `- ${s.target} — ${s.scheduleType}, ${where}${agent}${br}${next} · **${s.status}**${paused} \`${s.id}\``;
}

const SCHEDULE_TYPE_DESC =
  "SCHEDULE STEP — REQUIRED for when:'schedule'; ASK the user explicitly, never assume. The " +
  "UI's Recurrence choices: 'once', 'every_5_minutes', 'hourly', 'daily', 'weekly', 'monthly'. " +
  "Anything but 'once' also needs endDate. ('weekdays' = weekly Mon–Fri, MCP shortcut — don't offer it.) " +
  "REPEAT EVERY N: hourly / daily / weekly / monthly take `interval` N (hourly + interval 2 = every 2 hours; default 1); weekly takes `daysOfWeek`; " +
  "monthly takes `dayOfMonth` (1–30) OR `occurrence` (first/second/third/last) + one weekday in `daysOfWeek`. SimplifyQA has NO 'every N minutes' — " +
  "only every_5_minutes (fixed).";
/** "every 2 hours" / "weekly on MONDAY, FRIDAY" / "monthly on the first MONDAY" — what a schedule repeats as, in words. */
export function describeCadence(type: string | undefined, o: { interval?: number | undefined; daysOfWeek?: string[] | undefined; dayOfMonth?: number | undefined; occurrence?: string | undefined }): string {
  const t = type ?? 'once';
  const unit: Record<string, string> = { hourly: 'hour', daily: 'day', weekly: 'week', monthly: 'month' };
  const every = unit[t] ? (o.interval && o.interval > 1 ? `every ${o.interval} ${unit[t]}s` : `${t}`) : t;
  const days = o.daysOfWeek?.length ? ` on ${o.daysOfWeek.map((d) => d.toUpperCase()).join(', ')}` : '';
  if (t === 'monthly' && o.occurrence) return `${every} on the ${o.occurrence} ${(o.daysOfWeek?.[0] ?? '').toUpperCase()}`.trim();
  if (t === 'monthly' && o.dayOfMonth) return `${every} on day ${o.dayOfMonth}`;
  return `${every}${t === 'weekly' ? days : ''}`;
}
const END_DATE_DESC = "SCHEDULE STEP — ISO end date; REQUIRED when scheduleType is anything but 'once'. ASK the user.";

/** The scheduler form's Recurrence dropdown, in the UI's order — what the user is asked to pick from. */
const RECURRENCE_CHOICES =
  "Once (once) · Every 5 Minutes (every_5_minutes) · Hourly (hourly) · Daily (daily) · Weekly (weekly) · Monthly (monthly)";

/** The schedule questions the UI forces (start time, recurrence, then end date for a repeating one).
 *  Returns the refusal to send, or null when everything was given. Never defaults the recurrence to
 *  "once" — a silent default is how a schedule got created without the user ever being asked. */
export function missingScheduleFields(
  tool: 'tc_run' | 'suite_run',
  scheduledFor: string | undefined,
  scheduleType: ScheduleType | undefined,
  endDate: string | undefined,
): string | null {
  const missing: string[] = [];
  if (!scheduledFor) missing.push("`scheduledFor` — when the first (or only) run starts, as an ISO datetime (e.g. '2026-08-20T09:00:00Z'), plus the timezone");
  if (!scheduleType) missing.push(`\`scheduleType\` — how often it repeats. Offer EXACTLY the UI's choices, in this order: ${RECURRENCE_CHOICES}`);
  if (scheduleType && scheduleType !== 'once' && !endDate) missing.push("`endDate` — when the repetition stops (ISO date); required for every recurrence except Once");
  if (!missing.length) return null;
  return (
    `ASK the user explicitly before creating the schedule — do not assume or default any of these:\n` +
    missing.map((m, i) => `  ${i + 1}. ${m}`).join('\n') +
    `\nThen call ${tool} again with when:'schedule' and the answers.` +
    (!scheduleType ? ' If they choose anything but Once, also ask for the end date.' : '')
  );
}

/** A schedule fires detached from any live session, so a LOCAL schedule must target a specific
 *  agent — there is no "your online agent" at fire time. Build the "pick an agent" message, offering
 *  ALL agents (online AND offline): a scheduled run can target an agent that is offline right now,
 *  because it runs when it fires — this mirrors the product's scheduler picker. */
async function localScheduleNeedsAgent(adapter: ProviderAdapter): Promise<string> {
  let list = '';
  if (adapter.listLocalAgents) {
    try {
      const agents = await adapter.listLocalAgents();
      list = agents.length
        ? '\n\nAgents (a scheduled run can target an offline one — it runs when it fires):\n' +
          agents.map(localAgentLine).join('\n')
        : '\n\nNo local agents are registered to this project.';
    } catch { /* best-effort listing — the core message still stands */ }
  }
  return (
    'A LOCAL schedule runs detached from any live session, so it must target a specific agent. ' +
    'Call again with `agentId` set to a credential_id from local_agents.' + list
  );
}

/** A run-NOW to a specific LOCAL agent cannot target an offline one (mirrors the product UI, which
 *  offers only ONLINE agents for an immediate run). Returns an error message when the picked agent is
 *  known-offline, else null. Roster errors are swallowed — the backend still validates at reserve. */
async function localAgentOfflineForNow(adapter: ProviderAdapter, agentId: string): Promise<string | null> {
  if (!adapter.listLocalAgents) return null;
  try {
    const agents = await adapter.listLocalAgents();
    const picked = agents.find((a) => a.id === agentId);
    // If the picked agent physically belongs to this machine (hostname / MAC / IP matched), the
    // adapter's DB-flag override in listLocalAgents already set `online: true`. Never refuse a
    // run-now for our OWN machine — the DB flag is stale by design (7s cron in the executions
    // service that we cannot touch).
    if (picked?.isThisMachine) return null;
    if (picked && !picked.online) {
      const online = agents.filter((a) => a.online);
      return (
        `Agent \`${agentId}\`${picked.name ? ` (${picked.name})` : ''} is offline — a run-now needs an ONLINE agent. ` +
        (online.length
          ? 'Online now:\n' + online.map(localAgentLine).join('\n')
          : 'No local agents are online right now — schedule it instead, or bring an agent online.')
      );
    }
  } catch { /* roster unavailable — let the backend validate at reserve */ }
  return null;
}

/** Human summary of a run's status. For a SUITE run `children` carries the per-test-case rollup and
 *  `progress` counts TEST CASES; a single test-case run has neither (progress counts steps). */
export function statusText(s: RunStatus): string {
  const unit = s.children ? 'test cases' : 'steps';
  const prog = s.progress ? ` · ${s.progress.done}/${s.progress.total} ${unit}` : '';
  const when = s.startedAt ? ` · started ${s.startedAt}${s.endedAt ? ` · ended ${s.endedAt}` : ''}` : '';
  const link = s.reportUrl ? `\n${s.reportUrl}` : '';
  const icon = (state: string): string =>
    state === 'passed' ? '✅'
    : state === 'failed' ? '❌'
    : state === 'running' ? '⏳'
    : state === 'skipped' ? '⏭️'
    : state === 'notExecuted' ? '➖'
    : state === 'stopped' ? '⏹️'
    : state === 'error' ? '⚠️'
    : '•';
  // Per-state tally across children (suite runs only) — EVERY state SQA actually reports gets its
  // own bucket (skipped/notExecuted/error included, not folded into another), so the sum below is
  // guaranteed to equal `total` by construction (every child has exactly one state). Kept concise —
  // only non-zero buckets, in a stable order so the header reads the same every poll.
  const isProvisional = s.state === 'running' || s.state === 'queued';
  const tally = s.children?.length
    ? (() => {
        const order: RunState[] = ['passed', 'failed', 'skipped', 'notExecuted', 'running', 'queued', 'stopped', 'error'];
        const counts = new Map<string, number>();
        for (const c of s.children!) counts.set(c.state, (counts.get(c.state) ?? 0) + 1);
        const parts = order.filter((k) => counts.get(k)).map((k) => `${counts.get(k)} ${k}`);
        // One row per SUITE MEMBER (test case), never per iteration — counts below are per test
        // case, stated explicitly since a member with multiple testdata iterations still counts once.
        const label = isProvisional ? ' (provisional — run still in progress)' : '';
        return parts.length ? ` · ${parts.join(', ')} [per test case]${label}` : '';
      })()
    : '';
  const CHILD_CAP = 100;
  const total = s.children?.length ?? 0;
  const shown = s.children?.slice(0, CHILD_CAP) ?? [];
  const kids = shown.length
    ? '\n\n' + shown.map((c) => `- ${icon(c.state)} ${c.id}${c.title ? ` — ${c.title}` : ''} (${c.state})`).join('\n') +
      (total > CHILD_CAP ? `\n… and ${total - CHILD_CAP} more (${total} total)` : '') +
      (total > 0 ? '\n\nTo see WHY a specific one passed/failed, call run_status again with the same runId ' +
        'plus `tcId` set to one of the ids above.' : '')
    : '';
  // First 5 non-blank lines of the raw error string — the previous single-line slice usually
  // showed a "[ERROR] session …" log prefix instead of the actual exception. Enough context for
  // the LLM to name the failure ("NoSuchElement on #foo") without dumping a full stack.
  const errBlock = (raw: string | undefined): string => {
    if (!raw) return '';
    const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0).slice(0, 5);
    return lines.map((l) => `  ${l}`).join('\n');
  };
  const stepIcon = (st: string): string =>
    st === 'passed' ? '✅' : st === 'failed' ? '❌' : st === 'skipped' ? '⏭️' : '•';
  // A failed step the executor reported NO reason for (a plugin that returned false without logging) — say so,
  // instead of listing it bare, so the caller knows to look in the agent log rather than assume there is nothing.
  const NO_REASON = '  (no error text was reported for this step — check the agent log for this run)';
  const steps = s.stepResults?.length
    ? '\n\n' + s.stepResults.map((st) => {
        const desc = st.description?.trim() || '(no description)';
        const err = errBlock(st.error) || (st.status === 'failed' ? NO_REASON : '');
        const warn = st.warning ? `\n  ⚠️ ${st.warning}` : '';
        return `${stepIcon(st.status)} step ${st.n}: ${desc} (${st.status})${err ? '\n' + err : ''}${warn}`;
      }).join('\n')
    : '';
  // Failed-step summary: hoist FAILED rows to the top so the LLM sees "which step, why" without
  // scanning the full list. Only fires when the run itself is failed AND at least one step row is
  // failed (a run can be marked FAILED before any step logs, in which case the reportUrl is the
  // only lead). Multi-step failures are all listed — cascading failures often clarify the root.
  const failedSteps = (s.stepResults ?? []).filter((st) => st.status === 'failed');
  const failedSummary = s.state === 'failed' && failedSteps.length
    ? '\n\n**Failed at:**\n' + failedSteps.map((st) => {
        const desc = st.description?.trim() || '(no description)';
        const err = errBlock(st.error) || NO_REASON;
        return `- step ${st.n}: ${desc}${err ? '\n' + err : ''}`;
      }).join('\n')
    : '';
  // Steps that passed but carry a warning (no API response, empty read, unresolved ${param}) — hoisted so a green run
  // is not mistaken for a clean one.
  const warnedSteps = (s.stepResults ?? []).filter((st) => st.warning);
  const warnSummary = warnedSteps.length
    ? `\n\n**⚠️ ${warnedSteps.length} step(s) need attention:**\n` +
      warnedSteps.map((st) => `- step ${st.n}: ${st.warning}`).join('\n')
    : '';
  const stateLabel = s.state === 'passed' && warnedSteps.length ? `passed, but ${warnedSteps.length} step(s) need attention` : s.state;
  return `Run ${s.runId} · **${stateLabel}**${prog}${when}${tally}${link}${failedSummary}${warnSummary}${kids}${steps}`;
}

/** Compact per-run bullet list for `run_history`. Matches the icon vocabulary `statusText` uses so
 *  the two outputs feel like one surface. Duration only shows when both timestamps are present
 *  (running/queued rows will read as `-> (running)` without a `(53s)` suffix). */
function renderRunHistory(type: 'SUITE' | 'TC', entityId: string, runs: RunSummary[]): string {
  const stateIcon = (st: string): string =>
    st === 'passed' ? '✅'
    : st === 'failed' ? '❌'
    : st === 'running' ? '⏳'
    : st === 'skipped' ? '⏭️'
    : st === 'notExecuted' ? '➖'
    : st === 'stopped' ? '⏹️'
    : st === 'error' ? '⚠️'
    : '•';
  const durationOf = (r: RunSummary): string => {
    if (!r.startedAt || !r.endedAt) return '';
    const start = Date.parse(r.startedAt);
    const end = Date.parse(r.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
    const secs = Math.round((end - start) / 1000);
    if (secs < 60) return ` (${secs}s)`;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return ` (${m}m ${s.toString().padStart(2, '0')}s)`;
  };
  const when = (r: RunSummary): string => {
    if (r.startedAt && r.endedAt) return ` · ${r.startedAt} → ${r.endedAt}${durationOf(r)}`;
    if (r.startedAt) return ` · started ${r.startedAt}`;
    return '';
  };
  const tally = (r: RunSummary): string => {
    if (type !== 'SUITE' || r.totalTestCases === undefined) return '';
    const parts: string[] = [`${r.passed ?? 0}✅`];
    parts.push(`${r.failed ?? 0}❌`);
    parts.push(`${r.skipped ?? 0}⏭`);
    if ((r.notExecuted ?? 0) > 0) parts.push(`${r.notExecuted}➖`);
    return ` · ${parts.join('/')} of ${r.totalTestCases}`;
  };
  const label = type === 'SUITE' ? 'suite' : 'test case';
  const header = `Recent executions of ${label} ${entityId} (${runs.length} shown):\n`;
  const lines = runs.map((r) => `- ${stateIcon(r.state)} ${r.runId} · ${r.state}${tally(r)}${when(r)}`);
  const hint = type === 'SUITE'
    ? '\n\nCall run_status({ runId: "<id>" }) for the per-test-case rollup, then again with tcId for a child\'s steps.'
    : '\n\nCall run_status({ runId: "<id>" }) for step-level detail on any one.';
  return header + '\n' + lines.join('\n') + hint;
}

export function registerRunTools(server: McpServer, deps: RunToolsDeps): void {
  server.registerTool(
    'cloud_runners',
    {
      title: 'List cloud runners (and which are online)',
      description:
        'List the cloud runner VMs registered to the connected project and which are online. Use this ' +
        'to show the user the cloud options, or to pick a specific runner id for tc_run. Requires a live connection.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.listCloudRunners) return err('This product has no cloud runners.');
      try {
        const runners = await adapter.listCloudRunners();
        const online = runners.filter((r) => r.online);
        if (!runners.length) return ok('No cloud runners are registered to this project.', { runners: [] });
        const text =
          `${runners.length} cloud runner${runners.length === 1 ? '' : 's'} · ${online.length} online:\n\n` +
          runners.map(runnerLine).join('\n');
        return ok(text, { runners, online: online.length });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'local_agents',
    {
      title: "List THIS machine's local agent(s)",
      description:
        "List the LOCAL agent(s) registered from THIS machine — the desktop agent running on the box " +
        "this MCP is on. Use for a LOCAL tc_run / suite_run. There is exactly one desktop agent per " +
        "machine, so this is 0 or 1 row: empty means no agent is registered from this box (start the " +
        "SimplifyQA desktop agent, or use mode:'remote' to dispatch to a teammate's). Use `remote_agents` " +
        "for the other registered machines. Requires a live connection.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.listLocalAgents) return err('This product has no local agents to list.');
      try {
        const all = await adapter.listLocalAgents();
        const agents = all.filter((a) => a.isThisMachine);
        if (!agents.length) {
          return ok(
            "No local agent is registered from this machine. Start the SimplifyQA desktop agent on " +
            "this box, or use remote_agents + mode:'remote' to run on a teammate's machine.",
            { agents: [] },
          );
        }
        const online = agents.filter((a) => a.online);
        const text =
          `${agents.length} local agent${agents.length === 1 ? '' : 's'} on this machine · ${online.length} online:\n\n` +
          agents.map(localAgentLine).join('\n');
        return ok(text, { agents, online: online.length });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'remote_agents',
    {
      title: 'List REMOTE agents (other registered machines)',
      description:
        "List the LOCAL agents registered on OTHER machines (teammates' boxes) — the pool a REMOTE " +
        "run dispatches to. Use to pick an `agentId` for a REMOTE tc_run / suite_run. Excludes this " +
        "machine's own agent (that's `local_agents`). REMOTE dispatches to a specific teammate's " +
        "registered desktop agent through the SimplifyQA queue; the picked agent's browsers / adb " +
        "devices are what actually execute. Requires a live connection.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.listLocalAgents) return err('This product has no local agents to list.');
      try {
        const all = await adapter.listLocalAgents();
        const agents = all.filter((a) => !a.isThisMachine);
        if (!agents.length) return ok('No other machines are registered as agents for this customer.', { agents: [] });
        const online = agents.filter((a) => a.online);
        const text =
          `${agents.length} remote agent${agents.length === 1 ? '' : 's'} · ${online.length} online:\n\n` +
          agents.map(localAgentLine).join('\n');
        return ok(text, { agents, online: online.length });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'mobile_list_devices',
    {
      title: 'List mobile devices (Android or iOS)',
      description:
        "List MOBILE devices available to the project — union of the LOCAL roster (real devices + " +
        "emulators/simulators registered via the desktop agent, from `/tm/mobileDevices/search`) " +
        "and the CLOUD roster (whichever farm the project has integrated: LambdaTest / " +
        "BrowserStack / SauceLabs / SimplifyQA Device Farm — the first non-empty one wins, " +
        "matching the UI's single-provider-per-project model). Use before `tc_run` for an ANDROID " +
        "or IOS test case to pick a `deviceId` (and read `deviceType` + `cloudDeviceType` off the " +
        "same row). The `active` flag on local rows is last-known: stale by design (the SQA " +
        "backend writes it when the desktop agent connects/disconnects, and a 7s-stale cron flips " +
        "it back); a device the user just plugged in may still read `active:false` here. Cloud " +
        "rows don't carry `active` — cloud farms are always assumed reachable. Requires a live " +
        "connection.",
      inputSchema: {
        platform: z.enum(['android', 'ios']).describe("Which mobile platform to list devices for."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ platform }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.listMobileDevices) return err('This product has no mobile device roster to list.');
      try {
        const devices = await adapter.listMobileDevices(platform.toUpperCase() as 'ANDROID' | 'IOS');
        if (!devices.length) {
          return ok(
            `No ${platform.toUpperCase()} devices are registered to this project. Connect a device ` +
              `via the SimplifyQA desktop agent, then try again.`,
            { devices: [] },
          );
        }
        // Group by deviceType so the client can present the same tabs the UI does (Real / Emulator
        // / Simulator / Cloud Device). Cloud rows come from the configured farm (LT / BS / SL / SQA
        // Device Farm); the row's `cloudDeviceType` names which one — pass it back on `tc_run`.
        const groups: Record<string, MobileDevice[]> = {};
        for (const d of devices) {
          if (!groups[d.deviceType]) groups[d.deviceType] = [];
          groups[d.deviceType]!.push(d);
        }
        const active = devices.filter((d) => d.active).length;
        const sections = Object.entries(groups)
          .map(([type, rows]) => `**${type}** (${rows.length})\n${rows.map(mobileDeviceLine).join('\n')}`)
          .join('\n\n');
        const text =
          `${devices.length} ${platform.toUpperCase()} device${devices.length === 1 ? '' : 's'} · ${active} active:\n\n` +
          sections;
        return ok(text, { devices, active });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'tc_run',
    {
      title: 'Run a test case (local / remote / cloud; now or scheduled)',
      description:
        "★ ORDER OF QUESTIONS (STRICT — applies whether you ask one at a time OR bundle several into a " +
        "single message): when → mode → release → sprint → version → environment → browser/device → " +
        "schedule fields → agent. Ask in THIS order, always — never schema-declaration order, never " +
        "refusal-arrival order, never a 'natural UI' order (release first is WRONG). Skip a step only " +
        "when the flag below says it's skippable (sprint when release='', version when TC has one " +
        "version, browser vs. device by TC type). ★\n\n" +
        "Execute ONE existing test case in the connected product. ASK the user for EVERY field the " +
        "Execute dialog asks — never assume — in this DEPENDENCY ORDER: (0) if a previous run in this " +
        "session left a config for the project, the tool refuses first asking `reuseConfig` (true=merge " +
        "remembered mode/release/sprint/env/browser/agent, false=start fresh); (1) `when` " +
        "immediate/schedule, (2) `mode` local/remote/cloud, (3) `releaseId` (from list_releases; pass " +
        "'' to skip — no release), (4) `sprintId` (from list_sprints; skipped entirely when " +
        "releaseId=''), (5) `versionId` (from tc_get's `versions[]`; pass '' for current), (6) " +
        "`environment` (from tc_list_environments), (7) FOR WEB TCs: `browser`; FOR ANDROID/IOS TCs: " +
        "`deviceType` + `deviceId` (via `mobile_list_devices`), (8) for a schedule the start time + " +
        "recurrence (ASK — Once / Every 5 Minutes / Hourly / Daily / Weekly / Monthly, never default) + end date + timezone, (9) THEN offer the eligible agent/runner and pass the pick. IF YOU " +
        "BATCH SEVERAL REFUSED FIELDS INTO ONE AskUserQuestion, ORDER the questions EXACTLY as above " +
        "(when → mode → release → sprint → version → environment → browser/device → schedule fields " +
        "→ agent) — never in schema order or refusal order. `mode` decides WHERE it runs:\n" +
        "  • 'local' — THIS machine's desktop agent (its own browser). Call `local_agents` (0 or 1 row per box). " +
        "For when:'immediate' the tool first probes the desktop agent (:4040) and refuses cleanly if it's not up. " +
        "Omit `agentId` to auto-pick this machine's agent (or pass it explicitly — must be this machine's row). " +
        "For when:'schedule' `agentId` is REQUIRED.\n" +
        "  • 'remote' — ANOTHER registered machine's desktop agent (a teammate's box). Call `remote_agents` and " +
        "OFFER the list; `agentId` is REQUIRED (no auto-pick across boxes). For when:'immediate' only ONLINE " +
        "remote agents are eligible; for when:'schedule' ANY remote agent works (it runs when it fires).\n" +
        "  • 'cloud' — an online cloud runner VM (ONLINE-only whether now or scheduled). Pass `cloudRunnerId` " +
        'from cloud_runners; for a schedule omit it to let the backend auto-pick a live VM at fire time.\n' +
        'For cloud, if no runner is online it reports that there are no active cloud runners (nothing is run).\n' +
        'NOTE: MANUAL test cases cannot be run or scheduled by an agent — the backend rejects them.',
      inputSchema: {
        tcId: z.string().describe('The test case id (or business key) to run.'),
        reuseConfig: z.boolean().optional().describe("Set only when the tool refused asking about REUSE. true = merge the previous run's mode/release/sprint/browser/agent/runner into any unset field; the ENVIRONMENT is never merged — it is asked on every run; false = ignore prior config and walk the full cascade. Omit on a first run."),
        when: z.enum(['immediate', 'schedule']).optional().describe("STEP 1 — when to run. REQUIRED, ASK the user if unstated (the tool refuses when omitted). 'immediate' dispatches now; 'schedule' creates a schedule (needs scheduledFor)."),
        mode: z.enum(['local', 'remote', 'cloud']).optional().describe("STEP 2 — where to run. REQUIRED, ASK the user if unstated."),
        releaseId: z.string().optional().describe("STEP 3 — tag the run with a RELEASE (from list_releases). Optional in the UI; pass '' after asking to skip. The tool refuses when undefined so the user is asked."),
        sprintId: z.string().optional().describe("STEP 4 — tag the run with a SPRINT (from list_sprints, scoped to release). Only asked when releaseId is non-empty; skipped entirely when releaseId=''. Pass '' after asking to skip."),
        versionId: z.string().optional().describe("STEP 5 — override the TC's currently-selected VERSION for this run (an id or name from the TC's `versions[]`). Pass '' to accept the TC's current version."),
        environment: z.string().optional().describe('STEP 6 — environment key (from tc_list_environments). ASK the user on EVERY run; the UI marks this required. Never inherited from a previous run — reuseConfig does not fill it.'),
        browser: z.string().optional().describe("STEP 7 (WEB TCs) — browser, default 'chromium' (bundled + isolated). Others: 'chrome'/'msedge' (installed channel), 'firefox', 'webkit'. NOTE: a schedule accepts only chromium/msedge/firefox/webkit."),
        deviceId: z.string().optional().describe("STEP 7 (ANDROID/IOS TCs) — the target device id. LOCAL: adb serial or emulator name. CLOUD: the marketplace device name. Enumerate with `mobile_list_devices`."),
        deviceName: z.string().optional().describe("STEP 7 (ANDROID/IOS TCs) — the human-readable device name (e.g. 'Oppo-Cph2375-Ab1fe936', 'Pixel 7'). Read off the matching row's `displayName` (preferred) or `name` field from `mobile_list_devices`. Shown in the execution report. Auto-resolved from the device roster if omitted."),
        deviceType: z.enum(['real_device', 'emulator', 'simulator', 'cloud_device', 'cloud_emulator', 'cloud_simulator']).optional().describe("STEP 7 (ANDROID/IOS TCs) — the KIND of device the picked `deviceId` is (read off the matching row from `mobile_list_devices`)."),
        cloudDeviceType: z.enum(['lambda_test', 'browser_stack', 'sauce_labs', 'simplify_qa_device_form']).optional().describe("REQUIRED when `deviceType` is cloud_* — which cloud farm the device came from (read off the matching row's `cloudDeviceType`)."),
        osVersion: z.string().optional().describe("Optional OS version to stamp on the wire platform object for ANDROID/IOS — read off the matching row from `mobile_list_devices`."),
        devices: z.array(z.object({
          deviceId: z.string().describe("Device id (adb serial / emulator name for LOCAL; marketplace device name for CLOUD)."),
          deviceName: z.string().optional().describe("Human-readable device name from mobile_list_devices."),
          deviceType: z.enum(['real_device', 'emulator', 'simulator', 'cloud_device', 'cloud_emulator', 'cloud_simulator']).optional().describe("Kind of device (read off the matching row from mobile_list_devices)."),
          cloudDeviceType: z.enum(['lambda_test', 'browser_stack', 'sauce_labs', 'simplify_qa_device_form']).optional().describe("Cloud farm (required when deviceType is cloud_*)."),
          osVersion: z.string().optional().describe("OS version from mobile_list_devices."),
        })).optional().describe("STEP 7 (ANDROID/IOS TCs) — for PARALLEL execution on MULTIPLE devices. Pass an array of device specs to create ONE execution with one run per device (parallel). When provided, the single-device fields (deviceId, deviceName, deviceType, cloudDeviceType, osVersion) are ignored."),
        agentId: z.string().optional().describe("STEP 9 — for local: a credential_id from `local_agents` (must be THIS machine's row; omit to auto-pick). For remote: REQUIRED — a credential_id from `remote_agents`. when:'immediate' → the picked agent must be ONLINE; when:'schedule' → offline OK and `agentId` is REQUIRED for both local and remote."),
        cloudRunnerId: z.string().optional().describe("STEP 9 (cloud) — a specific ONLINE runner id (from cloud_runners). For when:'schedule' omit to auto-pick a live VM at fire time."),
        headless: z.boolean().optional().describe('Headless. Defaults: cloud=true, local=false. (Immediate runs only.)'),
        scheduledFor: z.string().optional().describe("STEP 8 — REQUIRED for when:'schedule'; ISO datetime of the first/only run (e.g. '2026-08-20T09:00:00Z')."),
        scheduleType: z.enum(SCHEDULE_TYPES).optional().describe(SCHEDULE_TYPE_DESC),
        endDate: z.string().optional().describe(END_DATE_DESC),
        timezone: z.string().optional().describe("IANA timezone for a schedule (e.g. 'Asia/Kolkata'). Default 'UTC'."),
        scheduleName: z.string().min(3).max(501).optional().describe("when:'schedule' — the schedule's NAME as the Scheduler shows it (3–501 characters, unique in the project), e.g. 'nightly smoke'. Omit it and the schedule is named '<TC-22> schedule' (numbered when taken)."),
        interval: z.number().int().min(1).optional().describe("REPEAT EVERY N for hourly / daily / weekly / monthly — N hours / days / weeks / months (e.g. hourly + 2 = every 2 hours). Default 1. Not for 'once' / 'every_5_minutes' (fixed at 5 minutes — SimplifyQA has no other minute interval)."),
        daysOfWeek: z.array(z.string()).optional().describe("Weekly: the weekdays to run on (MONDAY … SUNDAY or MON … SUN); default = the start's weekday. Monthly with `occurrence`: the one weekday."),
        dayOfMonth: z.number().int().min(1).max(30).optional().describe("Monthly 'ON DAY': 1–30; default = the start's day."),
        occurrence: z.enum(['first', 'second', 'third', 'last']).optional().describe("Monthly 'ON THE': the first / second / third / last weekday of the month — give the weekday in daysOfWeek."),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ tcId, reuseConfig, when, mode, agentId, environment, browser, headless, cloudRunnerId, deviceId, deviceName: deviceNameArg, deviceType, cloudDeviceType, osVersion, devices, scheduledFor, scheduleType, endDate, timezone, scheduleName, interval, daysOfWeek, dayOfMonth, occurrence, releaseId, sprintId, versionId }) => {
      let deviceName = deviceNameArg;
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);

      // STEP 0 — reuse-last-config prompt. Fires only when the caller wired getProjectId AND there
      // is a remembered config for that project AND the caller has not answered yet (undefined).
      // Merging when `reuseConfig: true` fills only fields left unset by this call — the user can
      // still override any single field explicitly. TC-specific fields (versionId, deviceId,
      // schedule cadence) are never remembered — they belong to the run, not the environment.
      const projectId = deps.getProjectId?.() ?? null;
      const remembered = projectId ? lastRun.get(projectId) : undefined;
      if (remembered && reuseConfig === undefined) {
        return err(
          `Previous run in this project used: ${summarizeLastRun(remembered)}. ` +
            'ASK the user whether to reuse it — call tc_run again with `reuseConfig: true` to merge ' +
            'those defaults, or `reuseConfig: false` to start fresh and be asked each field.',
        );
      }
      if (reuseConfig === true && remembered) {
        if (when === undefined) when = remembered.when;
        if (mode === undefined) mode = remembered.mode;
        if (releaseId === undefined) releaseId = remembered.releaseId;
        if (sprintId === undefined) sprintId = remembered.sprintId;
        // `environment` is deliberately NOT merged: it selects which test-data set the run uses
        // (general / UAT / …) and must be asked on EVERY run, even when the rest is reused.
        if (browser === undefined) browser = remembered.browser;
        if (agentId === undefined) agentId = remembered.agentId;
        if (cloudRunnerId === undefined) cloudRunnerId = remembered.cloudRunnerId;
      }

      // STEP 1 — when. Decides schedule vs immediate; gates the schedule fields and the agent
      // online-check downstream, so ask before anything else.
      if (!when) {
        return err(
          "Specify WHEN to run: call tc_run again with when: 'immediate' (run now) or when: 'schedule' " +
            '(create a schedule). If the user has not said, ask them first — never assume.',
        );
      }
      // STEP 2 — mode. Decides the agent/runner pool and constrains the browser set for a schedule.
      if (!mode) {
        return err(
          "Specify where to run: call tc_run again with mode: 'local', 'remote', or 'cloud'. " +
            "If the user has not said which, ASK them first — local runs on THIS machine's agent, " +
            "remote runs on a teammate's registered agent, cloud runs on an online cloud runner VM.",
        );
      }
      // STEP 3 — release. Optional in the UI; the tool asks anyway (pass '' to skip).
      if (releaseId === undefined) {
        return err(
          "ASK the user which RELEASE this run belongs to (from list_releases), then call tc_run " +
            "again with releaseId. If the user wants no release, pass releaseId: '' (empty string).",
        );
      }
      // STEP 4 — sprint. Only asked when a release was picked; when release is skipped, sprint is
      // skipped entirely (sprints scope to a release in the UI).
      if (releaseId !== '' && sprintId === undefined) {
        return err(
          "ASK the user which SPRINT this run belongs to (from list_sprints, filtered by releaseId), " +
            "then call tc_run again with sprintId. If the user wants no sprint, pass sprintId: '' (empty string).",
        );
      }
      if (releaseId === '') sprintId = '';

      // STEP 5 — version. Needs the TC's tcType and version list, so pre-fetch once here.
      let preview;
      try {
        preview = await adapter.getTestCase(tcId);
      } catch (e) {
        return err(describeError(e));
      }
      const tcType = (preview.technologyType ?? 'WEB').toUpperCase();
      const isMobile = tcType === 'ANDROID' || tcType === 'IOS';
      if (versionId === undefined) {
        const vs = preview.versions ?? [];
        if (vs.length > 1) {
          const listing = vs
            .map((v) => `  • \`${v.id}\` — **${v.name}**${v.isCurrent ? ' (current)' : ''}`)
            .join('\n');
          return err(
            `Test case ${preview.id ?? tcId} has ${vs.length} versions — ASK the user which ` +
              `one to run, then call tc_run again with versionId (pass the version id OR its ` +
              `name — either resolves). Pass versionId: '' to accept the TC's current ` +
              `version.\n\n${listing}`,
          );
        }
        versionId = '';
      }
      // STEP 6 — environment.
      if (!environment) {
        return err(
          'ASK the user which ENVIRONMENT to run against (from tc_list_environments), then call ' +
            'tc_run again with environment set to the chosen env key. Required — the UI marks this ' +
            'field with a red asterisk.',
        );
      }
      // STEP 7 (web only) — browser. Mobile branch handled after mode-dependent cloud/agent
      // resolution, since the device roster is filtered by where it will run. API / DB /
      // MAINFRAME / SAP / DESKTOP test cases have no browser/platform pick — asking for one blocks
      // those runs (and pushes callers into a local fallback), so gate strictly on WEB.
      if ((tcType === 'WEB' || tcType === 'WEB_DEPRECATED') && !browser) {
        return err(
          "ASK the user which BROWSER to run in (chromium / chrome / msedge / firefox / webkit), " +
            'then call tc_run again with browser set. Required — the UI marks this field with a ' +
            'red asterisk.',
        );
      }

      let resolvedRunner: CloudRunner | undefined;
      if (mode === 'cloud') {
        if (!adapter.listCloudRunners) return err('This product has no cloud runners; run with mode: "local".');
        let runners: CloudRunner[];
        try {
          runners = await adapter.listCloudRunners();
        } catch (e) {
          return err(describeError(e));
        }
        // Cloud is ONLINE-only whether now or scheduled (a schedule pin to an offline VM is rejected).
        const online = runners.filter((r) => r.online);
        if (!online.length) {
          return err('Currently there are no active cloud runners in your project.');
        }
        if (cloudRunnerId) {
          resolvedRunner = online.find((r) => r.id === cloudRunnerId);
          if (!resolvedRunner) {
            return err(
              `Cloud runner "${cloudRunnerId}" is not online. Online now:\n` + online.map(runnerLine).join('\n'),
            );
          }
        } else if (when === 'immediate') {
          resolvedRunner = online[0]; // run-now with no pick → auto-pick the first online runner
        }
        // when:'schedule' with no cloudRunnerId → leave unpinned; the backend auto-picks a live VM at fire time.
      }

      // LOCAL/REMOTE run-NOW to a specific agent must be online (can't dispatch to an offline agent).
      // The SCHEDULE branch below allows an offline agent since it runs when it fires. REMOTE also
      // REQUIRES an explicit agentId at all times — auto-pick across teammate boxes is unsafe.
      if (mode === 'remote' && !agentId) {
        return err(
          "REMOTE runs need an explicit agentId. Call remote_agents to see the teammate machines, " +
          "then pass one as agentId (must be an ONLINE row for when:'immediate').",
        );
      }
      if ((mode === 'local' || mode === 'remote') && when === 'immediate' && agentId) {
        const offlineMsg = await localAgentOfflineForNow(adapter, agentId);
        if (offlineMsg) return err(offlineMsg);
      }

      // Mobile refuse cascade — asked AFTER mode/when so the client can filter the device list by
      // where it's going to run. Order mirrors the UI: pick the KIND of device (Real / Emulator /
      // Cloud …), then the specific device off the matching tab. Cloud tabs show even in LOCAL
      // mode (see device-dropdown.component.html:104-111) — LOCAL orchestrator can drive a cloud
      // device via Appium.
      const isMultiDevice = isMobile && devices && devices.length > 1;
      if (isMobile && !isMultiDevice) {
        if (!deviceType) {
          const platform = tcType.toLowerCase() as 'android' | 'ios';
          const localKinds = platform === 'ios' ? "'real_device', 'simulator'" : "'real_device', 'emulator'";
          return err(
            `ASK the user which DEVICE TYPE this ${tcType} run should use: ${localKinds}, or ` +
              `'cloud_device' / 'cloud_emulator' / 'cloud_simulator' for a farm device. Then call ` +
              `tc_run again with deviceType set. (Also call mobile_list_devices({ platform: '${platform}' }) ` +
              `to show the available devices grouped by kind — the user picks a device and passes ` +
              `\`id\` as deviceId, its \`deviceType\`, and — for cloud rows — its \`cloudDeviceType\`.)`,
          );
        }
        const isCloudPick = deviceType.startsWith('cloud_');
        if (isCloudPick && !cloudDeviceType) {
          const platform = tcType.toLowerCase() as 'android' | 'ios';
          return err(
            `Cloud device picks need \`cloudDeviceType\` — which farm the device came from. Call ` +
              `mobile_list_devices({ platform: '${platform}' }); the matching row's \`cloudDeviceType\` ` +
              `is one of 'lambda_test' / 'browser_stack' / 'sauce_labs' / 'simplify_qa_device_form'. ` +
              `Pass it alongside deviceType and deviceId.`,
          );
        }
        if (!deviceId) {
          const platform = tcType.toLowerCase() as 'android' | 'ios';
          return err(
            `ASK the user which DEVICE to run on. Call mobile_list_devices({ platform: '${platform}' }) ` +
              `and offer the rows whose deviceType matches '${deviceType}' — the user picks one; pass its ` +
              `\`id\` as deviceId (and optionally its \`osVersion\`) to tc_run.`,
          );
        }
        // Always resolve the best device display name for the execution report. Even when the
        // model already provided deviceName (from the `name` field), the `displayName` from the
        // device roster is richer (Manufacturer-Model-Serial, e.g. "Oppo-Cph2375-Ab1fe936").
        // Best-effort — a failed lookup keeps whatever the model provided (or falls back to deviceId).
        if (deviceId && adapter.listMobileDevices) {
          try {
            const deviceRoster = await adapter.listMobileDevices(tcType.toUpperCase() as 'ANDROID' | 'IOS');
            const match = deviceRoster.find((d) => d.id === deviceId);
            log(`[mcp][tc_run] device resolve: deviceId=${deviceId} match=${match ? `id=${match.id} name=${match.name} displayName=${match.displayName ?? '(none)'}` : '(no match)'} provided=${deviceName ?? '(none)'}`);
            if (match) {
              const resolved = match.displayName || (match.name !== match.id ? match.name : undefined);
              if (resolved) deviceName = resolved;
              log(`[mcp][tc_run] device resolve: resolved=${resolved ?? '(none)'} final deviceName=${deviceName ?? '(none)'}`);
            }
          } catch (e) {
            log(`[mcp][tc_run] device resolve failed: ${e}`);
          }
        }
      } else if (isMultiDevice) {
        // Multi-device parallel: validate each device entry has at least a deviceId
        for (const dev of devices!) {
          if (!dev.deviceId) {
            return err('Each entry in `devices` must have a `deviceId`.');
          }
        }
        // Best-effort resolve display names for each device from the roster
        if (adapter.listMobileDevices) {
          try {
            const deviceRoster = await adapter.listMobileDevices(tcType.toUpperCase() as 'ANDROID' | 'IOS');
            for (const dev of devices!) {
              const match = deviceRoster.find((d) => d.id === dev.deviceId);
              if (match && !dev.deviceName) {
                dev.deviceName = match.displayName || (match.name !== match.id ? match.name : undefined);
              }
            }
          } catch (e) {
            log(`[mcp][tc_run] multi-device roster resolve failed: ${e}`);
          }
        }
      }

      if (when === 'schedule') {
        if (!adapter.createSchedule) return err('This product does not support scheduling runs.');
        const askSchedule = missingScheduleFields('tc_run', scheduledFor, scheduleType, endDate);
        if (askSchedule || !scheduledFor) return err(askSchedule ?? 'scheduledFor is required.');
        // A schedule fires detached from any live session — a LOCAL or REMOTE schedule must pin a
        // specific agent (mode:'remote' already fenced above, so this catches LOCAL).
        if (mode === 'local' && !agentId) return err(await localScheduleNeedsAgent(adapter));
        // Cloud: pin the runner's CREDENTIAL only when the user explicitly picked one; otherwise leave
        // it unpinned so the backend auto-picks a live VM at fire time (don't freeze today's online[0]).
        const pinnedRunner = mode === 'cloud' && cloudRunnerId ? resolvedRunner : undefined;
        const schedOpts: ScheduleOptions = {
          mode,
          scheduledFor,
          ...((mode === 'local' || mode === 'remote') && agentId ? { agentId } : {}),
          ...(pinnedRunner?.credentialId ? { cloudRunnerCredentialId: pinnedRunner.credentialId } : {}),
          ...(browser !== undefined ? { browser } : {}),
          ...(environment !== undefined ? { environmentId: environment } : {}),
          ...(releaseId ? { releaseId } : {}),
          ...(sprintId ? { sprintId } : {}),
          ...(scheduleType !== undefined ? { scheduleType } : {}),
          ...(endDate !== undefined ? { endDate } : {}),
          ...(timezone !== undefined ? { timezone } : {}),
          ...(scheduleName !== undefined ? { name: scheduleName } : {}),
          ...(interval !== undefined ? { interval } : {}),
          ...(daysOfWeek !== undefined ? { daysOfWeek } : {}),
          ...(dayOfMonth !== undefined ? { dayOfMonth } : {}),
          ...(occurrence !== undefined ? { occurrence } : {}),
        };
        try {
          const sched = await adapter.createSchedule({ tcId }, schedOpts);
          const next = sched.nextRunAt ? ` · first run ${sched.nextRunAt}` : '';
          const where = mode === 'cloud'
            ? (pinnedRunner ? `cloud runner **${pinnedRunner.name}**` : 'cloud (auto-pick a live VM at run time)')
            : `agent \`${agentId}\``;
          if (projectId) lastRun.set(projectId, { when, mode, releaseId, sprintId, browser, agentId, cloudRunnerId });
          return ok(
            `Scheduled ${tcId} (${describeCadence(scheduleType, { interval, daysOfWeek, dayOfMonth, occurrence })}, ${mode}) for ${scheduledFor}${next} → ${where}. Schedule id \`${sched.id}\`${sched.name ? ` named "${sched.name}"` : ''}.`,
            { schedule: sched, mode, when: 'schedule', ...(pinnedRunner ? { runner: pinnedRunner } : {}) },
          );
        } catch (e) {
          return err(describeError(e));
        }
      }

      const opts: RunOptions = {
        mode,
        ...((mode === 'local' || mode === 'remote') && agentId ? { agentId } : {}),
        ...(environment !== undefined ? { environment } : {}),
        ...(browser !== undefined ? { browser } : {}),
        ...(headless !== undefined ? { headless } : {}),
        ...(resolvedRunner ? { cloudRunnerId: resolvedRunner.id } : {}),
        ...(mode === 'cloud' && resolvedRunner?.cloudType ? { cloudType: resolvedRunner.cloudType } : {}),
        // Multi-device parallel: pass devices array and force parallel strategy
        ...(isMultiDevice ? {
          devices: devices!.map((d) => ({
            deviceId: d.deviceId,
            ...(d.deviceName ? { deviceName: d.deviceName } : {}),
            ...(d.deviceType ? { deviceType: d.deviceType.toUpperCase() as NonNullable<import('../domain/types.js').DeviceSpec['deviceType']> } : {}),
            ...(d.cloudDeviceType ? { cloudDeviceType: d.cloudDeviceType.toUpperCase() as NonNullable<import('../domain/types.js').DeviceSpec['cloudDeviceType']> } : {}),
            ...(d.osVersion ? { osVersion: d.osVersion } : {}),
          })),
          strategy: 'parallel' as const,
        } : {
          ...(deviceId !== undefined ? { deviceId } : {}),
          ...(deviceName !== undefined ? { deviceName } : {}),
          ...(deviceType !== undefined ? { deviceType: deviceType.toUpperCase() as NonNullable<RunOptions['deviceType']> } : {}),
          ...(cloudDeviceType !== undefined ? { cloudDeviceType: cloudDeviceType.toUpperCase() as NonNullable<RunOptions['cloudDeviceType']> } : {}),
          ...(osVersion !== undefined ? { osVersion } : {}),
        }),
        ...(releaseId ? { releaseId } : {}),
        ...(sprintId ? { sprintId } : {}),
        ...(versionId ? { versionId } : {}),
      };
      try {
        const run = await adapter.startRun({ tcId }, opts);
        const where =
          mode === 'cloud'
            ? `on cloud runner ${resolvedRunner ? `**${resolvedRunner.name}**` : ''}`
            : mode === 'remote'
              ? `on remote agent \`${agentId}\``
              : `locally${agentId ? ` on agent \`${agentId}\`` : ' on your online agent'}`;
        if (projectId) lastRun.set(projectId, { when, mode, releaseId, sprintId, browser, agentId, cloudRunnerId: resolvedRunner?.id ?? cloudRunnerId });
        const deviceCount = isMultiDevice ? ` across ${devices!.length} devices (parallel)` : '';
        return ok(
          `Started ${tcId} ${where}${deviceCount}. Run id \`${run.runId}\` — poll run_status({ runId: "${run.runId}" }) for progress.` +
            (run.reportUrl ? `
Report: ${run.reportUrl} (use this link as-is; do not build a report URL yourself)` : ''),
          { run, mode, ...(resolvedRunner ? { runner: resolvedRunner } : {}) },
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'suite_run',
    {
      title: 'Run a test suite (local / remote / cloud; now or scheduled)',
      description:
        "★ ORDER OF QUESTIONS (STRICT — applies whether you ask one at a time OR bundle several into a " +
        "single message): when → mode → strategy (serial/parallel, IMMEDIATE runs) → release → sprint " +
        "→ environment → schedule fields → agent. Ask " +
        "in THIS order, always — never schema-declaration order, never refusal-arrival order, never " +
        "a 'natural UI' order (release first is WRONG). Skip sprint when release=''. Suites do NOT " +
        "ask version / browser / device — each TC in the suite carries its own. ★\n\n" +
        'Execute an existing test SUITE — all its member test cases, in order — in the connected product. ' +
        "ASK the user for EVERY field the UI's Execute-suite dialog asks — never assume — in this " +
        "DEPENDENCY ORDER: (0) if a previous run in this session left a config for the project, the tool " +
        "refuses first asking `reuseConfig` (true=merge remembered mode/release/sprint/agent (the ENVIRONMENT is always asked), " +
        "false=start fresh); (1) `when` immediate/schedule, (2) `mode` local/remote/cloud, (3) " +
        "`strategy` SERIAL/PARALLEL — the UI's PARALLEL/SERIAL radio, shown for LOCAL, REMOTE and CLOUD " +
        "alike (ask it for an immediate run), (4) `releaseId` (from list_releases; pass '' to skip), " +
        "(5) `sprintId` (from list_sprints; skipped " +
        "entirely when releaseId=''), (6) `environment` (from tc_list_environments), (7) for a schedule " +
        "the start time + recurrence (ASK — Once / Every 5 Minutes / Hourly / Daily / Weekly / Monthly, never default) + end date + timezone, (8) THEN offer the eligible agent/runner. IF YOU " +
        "BATCH SEVERAL REFUSED FIELDS INTO ONE AskUserQuestion, ORDER the questions EXACTLY as above " +
        "(when → mode → strategy → release → sprint → environment → schedule fields → agent) — never in schema " +
        "order or refusal order. UNLIKE " +
        "`tc_run`, a suite does NOT ask for `versionId` or `browser` — each TC in the suite carries its " +
        "own pinned version + execution platform (that's what the suite editor picks per row). " +
        '★ RECOMMEND PARALLEL when the suite has more than one test case that can run independently ' +
        '(they dispatch concurrently — much faster); recommend SERIAL when the cases must run in order or ' +
        'share state (create → verify → delete, one shared login, a single local browser profile). The UI ' +
        'preselects SERIAL — say WHY you suggest parallel.\n' +
        '`mode` decides WHERE it runs:\n' +
        "  • 'local' — THIS machine's desktop agent. Runs SERIAL or PARALLEL exactly as asked (parallel " +
        "dispatches each TC as its own child execution). Call `local_agents` (0 or 1 row). For " +
        "when:'immediate' the tool probes :4040 and refuses if the desktop agent is down. Omit `agentId` to " +
        "auto-pick this machine's agent; for when:'schedule' `agentId` is REQUIRED.\n" +
        "  • 'remote' — ANOTHER registered machine's desktop agent, SERIAL or PARALLEL as asked. " +
        "Call `remote_agents`; " +
        "`agentId` is REQUIRED (no auto-pick). when:'immediate' → ONLINE only; when:'schedule' → offline OK.\n" +
        "  • 'cloud' — online cloud runner VM(s) (ONLINE-only whether now or scheduled). Pass `cloudRunnerId` " +
        'from cloud_runners; for a schedule omit it to auto-pick a live VM at fire time.\n' +
        'For cloud, if no runner is online it reports that there are no active cloud runners (nothing is run).\n' +
        'NOTE: manual suites go through the same dispatch — the backend stores them as an execution (no agent picks them up until steps are marked from the UI).',
      inputSchema: {
        suiteId: z.string().describe('The suite id to run (from suite_list / suite_get).'),
        reuseConfig: z.boolean().optional().describe("Set only when the tool refused asking about REUSE. true = merge the previous run's mode/release/sprint/browser/agent/runner into any unset field; the ENVIRONMENT is never merged — it is asked on every run; false = ignore prior config. Omit on a first run."),
        when: z.enum(['immediate', 'schedule']).optional().describe("STEP 1 — when to run. REQUIRED, ASK the user if unstated."),
        mode: z.enum(['local', 'remote', 'cloud']).optional().describe('STEP 2 — where to run. REQUIRED, ASK the user if unstated.'),
        releaseId: z.string().optional().describe("STEP 4 — release from list_releases. ASK the user; pass '' to skip (no release / no sprint asked)."),
        sprintId: z.string().optional().describe("STEP 5 — sprint from list_sprints (scoped to release). Only asked when releaseId is non-empty; skipped when releaseId=''. Pass '' to skip."),
        environment: z.string().optional().describe('STEP 6 — environment key (from tc_list_environments). ASK the user on EVERY suite run; the UI marks this required for a suite. Never inherited from a previous run — reuseConfig does not fill it.'),
        browser: z.string().optional().describe("Optional at the SUITE level — each TC in the suite has its own execution platform (that's the suite-editor pick per row). Provide only to OVERRIDE for every WEB TC. Values: 'chromium' (default), 'chrome'/'msedge', 'firefox', 'webkit'. NOTE: a schedule accepts only chromium/msedge/firefox/webkit."),
        headless: z.boolean().optional().describe('Headless. Defaults: cloud=true, local=false. (Immediate runs only.)'),
        agentId: z.string().optional().describe("STEP 8 — for local: a credential_id from `local_agents` (this machine only; omit to auto-pick). For remote: REQUIRED — a credential_id from `remote_agents`. when:'immediate' → picked agent must be ONLINE; when:'schedule' → offline OK, agentId REQUIRED for both local and remote."),
        cloudRunnerId: z.string().optional().describe("STEP 8 (cloud) — a specific ONLINE runner id (from cloud_runners). For when:'schedule' omit to auto-pick a live VM at fire time."),
        strategy: z.enum(['serial', 'parallel']).optional().describe(
          "STEP 3 (immediate runs) — SERIAL or PARALLEL across the suite's test cases: the same choice the " +
          "UI's Execute-suite dialog shows as a PARALLEL/SERIAL radio, and it applies to LOCAL, REMOTE and " +
          "CLOUD alike. ASK the user. RECOMMEND 'parallel' when the suite has several independent test cases " +
          "(they run concurrently — much faster); recommend 'serial' when order or shared state matters. The " +
          "wire defaults to SERIAL, which is why it must be asked rather than assumed."),
        maxConcurrent: z.number().int().positive().optional().describe('Cloud parallel only — maps to globalConfiguration.MAXIMUM_CONTAINER_COUNT on the wire.'),
        terminateOnFailure: z.boolean().optional().describe('Stop dispatching remaining test cases after the first failure. Maps to globalConfiguration.TERMINATE_ON_FAIL on the wire.'),
        scheduledFor: z.string().optional().describe("STEP 6 — REQUIRED for when:'schedule'; ISO datetime of the first/only run (e.g. '2026-08-20T09:00:00Z')."),
        scheduleType: z.enum(SCHEDULE_TYPES).optional().describe(SCHEDULE_TYPE_DESC),
        endDate: z.string().optional().describe(END_DATE_DESC),
        timezone: z.string().optional().describe("IANA timezone for a schedule (e.g. 'Asia/Kolkata'). Default 'UTC'."),
        scheduleName: z.string().min(3).max(501).optional().describe("when:'schedule' — the schedule's NAME as the Scheduler shows it (3–501 characters, unique in the project), e.g. 'nightly smoke'. Omit it and the schedule is named '<TC-22> schedule' (numbered when taken)."),
        interval: z.number().int().min(1).optional().describe("REPEAT EVERY N for hourly / daily / weekly / monthly — N hours / days / weeks / months (e.g. hourly + 2 = every 2 hours). Default 1. Not for 'once' / 'every_5_minutes' (fixed at 5 minutes — SimplifyQA has no other minute interval)."),
        daysOfWeek: z.array(z.string()).optional().describe("Weekly: the weekdays to run on (MONDAY … SUNDAY or MON … SUN); default = the start's weekday. Monthly with `occurrence`: the one weekday."),
        dayOfMonth: z.number().int().min(1).max(30).optional().describe("Monthly 'ON DAY': 1–30; default = the start's day."),
        occurrence: z.enum(['first', 'second', 'third', 'last']).optional().describe("Monthly 'ON THE': the first / second / third / last weekday of the month — give the weekday in daysOfWeek."),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ suiteId, reuseConfig, releaseId, sprintId, mode, agentId, environment, browser, headless, cloudRunnerId, strategy, maxConcurrent, terminateOnFailure, when, scheduledFor, scheduleType, endDate, timezone, scheduleName, interval, daysOfWeek, dayOfMonth, occurrence }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);

      // STEP 0 — reuse-last-config prompt. Same shape as tc_run: fires only when the caller wired
      // getProjectId AND there is a remembered config AND the user hasn't answered yet. Merges the
      // environment-level fields (mode/release/sprint/env/browser/agent/runner) into any left unset.
      const projectId = deps.getProjectId?.() ?? null;
      const remembered = projectId ? lastRun.get(projectId) : undefined;
      if (remembered && reuseConfig === undefined) {
        return err(
          `Previous run in this project used: ${summarizeLastRun(remembered)}. ` +
            'ASK the user whether to reuse it — call suite_run again with `reuseConfig: true` to merge ' +
            'those defaults, or `reuseConfig: false` to start fresh.',
        );
      }
      if (reuseConfig === true && remembered) {
        if (when === undefined) when = remembered.when;
        if (mode === undefined) mode = remembered.mode;
        if (releaseId === undefined) releaseId = remembered.releaseId;
        if (sprintId === undefined) sprintId = remembered.sprintId;
        // `environment` is deliberately NOT merged: it selects which test-data set the run uses
        // (general / UAT / …) and must be asked on EVERY run, even when the rest is reused.
        if (browser === undefined) browser = remembered.browser;
        if (agentId === undefined) agentId = remembered.agentId;
        if (cloudRunnerId === undefined) cloudRunnerId = remembered.cloudRunnerId;
      }

      // STEP 1 — when.
      if (!when) {
        return err(
          "Specify WHEN to run: call suite_run again with when: 'immediate' (run now) or when: 'schedule' " +
            '(create a schedule). If the user has not said, ask them first — never assume.',
        );
      }
      // STEP 2 — mode.
      if (!mode) {
        return err(
          "Specify where to run: call suite_run again with mode: 'local', 'remote', or 'cloud'. " +
            "If the user has not said which, ASK them first — local runs on THIS machine's agent, " +
            "remote runs on a teammate's registered agent, cloud runs on online cloud runner VM(s).",
        );
      }
      // STEP 3 — serial vs parallel (the UI's PARALLEL/SERIAL radio). The wire defaults to SERIAL, so an
      // unasked strategy silently hides the faster option on every suite run.
      if (when === 'immediate' && !strategy) {
        return err(
          'ASK the user whether this suite should run SERIAL or PARALLEL — the PARALLEL/SERIAL radio the ' +
            "UI's Execute-suite dialog shows above Release (it applies to local, remote and cloud). RECOMMEND " +
            'PARALLEL when the suite has more than one independent test case (they dispatch concurrently and ' +
            'finish much sooner); recommend SERIAL when the cases must run in order or share state. Then call ' +
            "suite_run again with strategy: 'serial' or 'parallel'.",
        );
      }
      // STEP 4 — release. Unified with tc_run: pass '' to skip (matches the UI's optional field).
      if (releaseId === undefined) {
        return err(
          "ASK the user which RELEASE this suite run belongs to (from list_releases), then call " +
            "suite_run again with releaseId. If the user wants no release, pass releaseId: '' (empty string).",
        );
      }
      // STEP 4 — sprint. Only asked when release is non-empty.
      if (releaseId !== '' && sprintId === undefined) {
        return err(
          "ASK the user which SPRINT this suite run belongs to (from list_sprints, filtered by " +
            "releaseId), then call suite_run again with sprintId. If the user wants no sprint, pass " +
            "sprintId: '' (empty string).",
        );
      }
      if (releaseId === '') sprintId = '';
      // STEP 5 — environment.
      if (!environment) {
        return err(
          'ASK the user which ENVIRONMENT to run against (from tc_list_environments), then call ' +
            'suite_run again with environment set to the chosen env key. Required — the UI marks this ' +
            'field with a red asterisk for a suite.',
        );
      }

      let resolvedRunner: CloudRunner | undefined;
      if (mode === 'cloud') {
        if (!adapter.listCloudRunners) return err('This product has no cloud runners; run with mode: "local".');
        let runners: CloudRunner[];
        try {
          runners = await adapter.listCloudRunners();
        } catch (e) {
          return err(describeError(e));
        }
        // Cloud is ONLINE-only whether now or scheduled (a schedule pin to an offline VM is rejected).
        const online = runners.filter((r) => r.online);
        if (!online.length) {
          return err('Currently there are no active cloud runners in your project.');
        }
        if (cloudRunnerId) {
          resolvedRunner = online.find((r) => r.id === cloudRunnerId);
          if (!resolvedRunner) {
            return err(`Cloud runner "${cloudRunnerId}" is not online. Online now:\n` + online.map(runnerLine).join('\n'));
          }
        } else if (when === 'immediate') {
          resolvedRunner = online[0]; // run-now with no pick → auto-pick the first online runner
        }
        // when:'schedule' with no cloudRunnerId → leave unpinned; the backend auto-picks a live VM at fire time.
      }

      // LOCAL/REMOTE run-NOW to a specific agent must be online. SCHEDULE branch below allows offline.
      // REMOTE always requires an explicit agentId (auto-pick across teammate boxes is unsafe).
      if (mode === 'remote' && !agentId) {
        return err(
          "REMOTE runs need an explicit agentId. Call remote_agents to see the teammate machines, " +
          "then pass one as agentId (must be an ONLINE row for when:'immediate').",
        );
      }
      if ((mode === 'local' || mode === 'remote') && when === 'immediate' && agentId) {
        const offlineMsg = await localAgentOfflineForNow(adapter, agentId);
        if (offlineMsg) return err(offlineMsg);
      }

      if (when === 'schedule') {
        if (!adapter.createSchedule) return err('This product does not support scheduling runs.');
        const askSchedule = missingScheduleFields('suite_run', scheduledFor, scheduleType, endDate);
        if (askSchedule || !scheduledFor) {
          return err(
            (askSchedule ?? 'scheduledFor is required.') +
              " NOTE: strategy/maxConcurrent/terminateOnFailure are immediate-run only — a schedule uses the suite's own settings.",
          );
        }
        // A schedule fires detached from any live session — LOCAL and REMOTE schedules must pin a
        // specific agent. REMOTE was already fenced above; this catches LOCAL.
        if (mode === 'local' && !agentId) return err(await localScheduleNeedsAgent(adapter));
        // Cloud: pin the runner's CREDENTIAL only when the user explicitly picked one; otherwise leave
        // it unpinned so the backend auto-picks a live VM at fire time (don't freeze today's online[0]).
        const pinnedRunner = mode === 'cloud' && cloudRunnerId ? resolvedRunner : undefined;
        const schedOpts: ScheduleOptions = {
          mode,
          scheduledFor,
          ...((mode === 'local' || mode === 'remote') && agentId ? { agentId } : {}),
          ...(pinnedRunner?.credentialId ? { cloudRunnerCredentialId: pinnedRunner.credentialId } : {}),
          ...(browser !== undefined ? { browser } : {}),
          ...(environment !== undefined ? { environmentId: environment } : {}),
          ...(releaseId ? { releaseId } : {}),
          ...(sprintId ? { sprintId } : {}),
          ...(scheduleType !== undefined ? { scheduleType } : {}),
          ...(endDate !== undefined ? { endDate } : {}),
          ...(timezone !== undefined ? { timezone } : {}),
          ...(scheduleName !== undefined ? { name: scheduleName } : {}),
          ...(interval !== undefined ? { interval } : {}),
          ...(daysOfWeek !== undefined ? { daysOfWeek } : {}),
          ...(dayOfMonth !== undefined ? { dayOfMonth } : {}),
          ...(occurrence !== undefined ? { occurrence } : {}),
        };
        try {
          const sched = await adapter.createSchedule({ suiteId }, schedOpts);
          const next = sched.nextRunAt ? ` · first run ${sched.nextRunAt}` : '';
          const where = mode === 'cloud'
            ? (pinnedRunner ? `cloud runner **${pinnedRunner.name}**` : 'cloud (auto-pick a live VM at run time)')
            : `agent \`${agentId}\``;
          if (projectId) lastRun.set(projectId, { when, mode, releaseId, sprintId, browser, agentId, cloudRunnerId });
          return ok(
            `Scheduled suite ${suiteId} (${describeCadence(scheduleType, { interval, daysOfWeek, dayOfMonth, occurrence })}, ${mode}) for ${scheduledFor}${next} → ${where}. Schedule id \`${sched.id}\`${sched.name ? ` named "${sched.name}"` : ''}.`,
            { schedule: sched, mode, when: 'schedule', ...(pinnedRunner ? { runner: pinnedRunner } : {}) },
          );
        } catch (e) {
          return err(describeError(e));
        }
      }

      const opts: RunOptions = {
        mode,
        ...((mode === 'local' || mode === 'remote') && agentId ? { agentId } : {}),
        ...(environment !== undefined ? { environment } : {}),
        ...(browser !== undefined ? { browser } : {}),
        ...(headless !== undefined ? { headless } : {}),
        ...(resolvedRunner ? { cloudRunnerId: resolvedRunner.id } : {}),
        ...(mode === 'cloud' && resolvedRunner?.cloudType ? { cloudType: resolvedRunner.cloudType } : {}),
        ...(releaseId ? { releaseId } : {}),
        ...(sprintId ? { sprintId } : {}),
        ...(strategy !== undefined ? { strategy } : {}),
        ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
        ...(terminateOnFailure !== undefined ? { terminateOnFailure } : {}),
      };
      try {
        const run = await adapter.startRun({ suiteId }, opts);
        const where =
          mode === 'cloud'
            ? `on cloud runner ${resolvedRunner ? `**${resolvedRunner.name}**` : ''}`
            : mode === 'remote'
              ? `on remote agent \`${agentId}\``
              : `locally${agentId ? ` on agent \`${agentId}\`` : ' on your online agent'}`;
        if (projectId) lastRun.set(projectId, { when, mode, releaseId, sprintId, browser, agentId, cloudRunnerId: resolvedRunner?.id ?? cloudRunnerId });
        return ok(
          `Started suite ${suiteId} ${where}. Run id \`${run.runId}\` — poll run_status({ runId: "${run.runId}" }) for progress.` +
            (run.reportUrl ? `
Report: ${run.reportUrl} (use this link as-is; do not build a report URL yourself)` : ''),
          { run, mode, ...(resolvedRunner ? { runner: resolvedRunner } : {}) },
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'run_status',
    {
      title: 'Get a run status',
      description:
        'Read the status of a run — state (queued/running/passed/failed/skipped/notExecuted/stopped/' +
        'error), progress, per-test-case rollup for a SUITE run (capped at 100 shown, ONE ROW PER ' +
        'TEST CASE — not per iteration), and a link. Every state SQA reports is its own bucket in the ' +
        'per-state tally (skipped and notExecuted are real, distinct outcomes — never counted as ' +
        'passed or folded into queued). While the run is still queued/running, the tally is labelled ' +
        'provisional. Pass EITHER `runId` (from tc_run / suite_run) or `suiteId` (from suite_list) to ' +
        'read that suite\'s LATEST execution.\n\n' +
        'The suite rollup only says pass/fail/etc per test case, never WHY — to get one child\'s own ' +
        'step-level detail (which step failed, the error), call again with the SAME `runId`/`suiteId` ' +
        'plus `tcId` set to one of the ids shown in the rollup. Requires a live connection.',
      inputSchema: {
        runId: z.string().optional().describe('The run id returned by tc_run or suite_run.'),
        suiteId: z.string().optional().describe('A suite id (from suite_list) — resolves to the suite\'s latest execution.'),
        tcId: z.string().optional().describe(
          'Drill into ONE child test case\'s step-level results within a SUITE run — its id from the ' +
          'rollup shown by a prior run_status call (without `tcId`). Ignored / refused for a single-TC run.',
        ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ runId, suiteId, tcId }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if ((runId && suiteId) || (!runId && !suiteId)) {
        return err('Pass exactly one of `runId` or `suiteId`.');
      }
      try {
        let effectiveRunId = runId;
        if (suiteId) {
          if (!adapter.getLatestSuiteRun) return err('This product does not support latest-suite-run lookup — pass `runId` instead.');
          const latest = await adapter.getLatestSuiteRun(suiteId);
          if (!latest) return ok(`Suite ${suiteId} has no executions yet.`);
          effectiveRunId = latest;
        }
        const status = await adapter.getRun(effectiveRunId!);
        if (tcId === undefined) {
          return ok(statusText(status), { run: status });
        }
        if (!status.children) {
          return err(`Run ${effectiveRunId} is not a suite run (or has no per-test-case rollup yet) — \`tcId\` doesn't apply here.`);
        }
        if (!adapter.getSuiteChildRun) {
          return err('This product does not support drilling into one test case\'s result within a suite run.');
        }
        const child = status.children.find((c) => c.id === tcId || c.testcaseId === tcId);
        if (!child) {
          const options = status.children.map((c) => `\`${c.id}\`${c.title ? ` — ${c.title}` : ''} (${c.state})`).join('\n');
          return err(`"${tcId}" is not one of the test cases in this suite run. Available:\n${options}`);
        }
        if (!child.testcaseId) {
          return err(`Test case ${child.id} in this suite run has no resolvable testcaseId — cannot fetch its step-level detail.`);
        }
        const childStatus = await adapter.getSuiteChildRun(effectiveRunId!, {
          testcaseId: child.testcaseId,
          ...(child.versionId ? { versionId: child.versionId } : {}),
          ...(child.stepId ? { stepId: child.stepId } : {}),
        });
        return ok(
          `${child.id}${child.title ? ` — ${child.title}` : ''} within suite run ${effectiveRunId}:\n\n${statusText(childStatus)}`,
          { run: childStatus },
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'run_history',
    {
      title: 'Recent execution history for a suite or test case',
      description:
        'Return the top-N most recent STANDALONE executions of a suite or test case (newest first), ' +
        'as a scoreboard — runId, state, timing, reportUrl, plus a per-test-case tally for SUITE ' +
        'runs (passed/failed/skipped of total). No step-level detail; use `run_status({ runId })` ' +
        'on any row to drill in. Pass EXACTLY one of `suiteId` or `tcId`. `limit` defaults to 5, ' +
        'capped at 20. Suite-child TC rows are excluded from a `tcId` query, so a test case that ' +
        'only runs inside suites returns empty. Requires a live connection.',
      inputSchema: {
        suiteId: z.string().optional().describe('A suite id (from suite_list) — returns the suite\'s recent executions.'),
        tcId: z.string().optional().describe('A test case id — returns the TC\'s recent STANDALONE executions.'),
        limit: z.number().int().min(1).max(20).optional().describe('How many recent runs to return (default 5, max 20).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ suiteId, tcId, limit }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if ((suiteId && tcId) || (!suiteId && !tcId)) {
        return err('Pass exactly one of `suiteId` or `tcId`.');
      }
      if (!adapter.listRecentRuns) {
        return err('This product does not support run-history lookup.');
      }
      const type: 'SUITE' | 'TC' = suiteId ? 'SUITE' : 'TC';
      const entityId = (suiteId ?? tcId)!;
      const n = Math.min(Math.max(limit ?? 5, 1), 20);
      try {
        const runs = await adapter.listRecentRuns(type, entityId, n);
        if (!runs.length) {
          const label = type === 'SUITE' ? 'suite' : 'test case';
          return ok(`No executions found for ${label} ${entityId}.`, { runs: [] });
        }
        const text = renderRunHistory(type, entityId, runs);
        return ok(text, { runs });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'run_stop',
    {
      title: 'Stop a run',
      description:
        'Signal a running execution to stop, and poll briefly for the terminal state so the reply ' +
        "reflects reality (not a fire-and-forget). Pass EXACTLY one of: `runId` (from tc_run / " +
        "suite_run), `suiteId` (stops the suite's LATEST execution), or `tcId` (stops the TC's " +
        'LATEST standalone execution — suite-child rows are excluded). Requires a live connection.',
      inputSchema: {
        runId: z.string().optional().describe('The run id (from tc_run / suite_run).'),
        suiteId: z.string().optional().describe("A suite id (from suite_list) — stops the suite's latest execution."),
        tcId: z.string().optional().describe("A test case id — stops the TC's latest STANDALONE execution."),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ runId, suiteId, tcId }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if ([runId, suiteId, tcId].filter((v) => v !== undefined && v !== '').length !== 1) {
        return err('Pass exactly one of `runId`, `suiteId`, or `tcId`.');
      }
      try {
        let effectiveRunId = runId;
        if (suiteId) {
          if (!adapter.getLatestSuiteRun) return err('This product does not support latest-suite-run lookup — pass `runId` instead.');
          const latest = await adapter.getLatestSuiteRun(suiteId);
          if (!latest) return err(`Suite ${suiteId} has no executions to stop.`);
          effectiveRunId = latest;
        } else if (tcId) {
          if (!adapter.getLatestTestcaseRun) return err('This product does not support latest-testcase-run lookup — pass `runId` instead.');
          const latest = await adapter.getLatestTestcaseRun(tcId);
          if (!latest) return err(`Test case ${tcId} has no executions to stop.`);
          effectiveRunId = latest;
        }
        await adapter.stopRun(effectiveRunId!);
        // Confirm — the backend accepts the stop async, so getRun is the source of truth. Poll a few
        // times so the reply reports the actual state instead of lying "requested" and moving on.
        // ponytail: fixed 3×1.5s poll, upgrade to configurable/backoff if teams hit slow stop paths.
        const TERMINAL = new Set(['stopped', 'passed', 'failed', 'error', 'skipped', 'notExecuted']);
        for (let i = 0; i < 3; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          const s = await adapter.getRun(effectiveRunId!);
          if (TERMINAL.has(s.state)) return ok(`Run ${effectiveRunId} is now **${s.state}**.`, { run: s });
        }
        return ok(
          `Stop request sent for run ${effectiveRunId}. State is still queued/running — poll ` +
            `run_status({ runId: "${effectiveRunId}" }) to confirm.`,
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'schedule_list',
    {
      title: 'List schedules',
      description:
        'List the scheduled runs in the connected project — each with WHAT it runs (test case / suite), ' +
        'its cadence, next run time, status (scheduled / running / paused / cancelled), where it runs + the ' +
        'pinned agent, and its browser. Use this to find a schedule to edit, pause/resume, cancel, or delete. ' +
        'Requires a live connection.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.listSchedules) return err('This product does not support listing schedules.');
      try {
        const schedules = await adapter.listSchedules();
        if (!schedules.length) return ok('No schedules in this project.', { schedules: [] });
        const text =
          `${schedules.length} schedule${schedules.length === 1 ? '' : 's'}:\n\n` +
          schedules.map(scheduleLine).join('\n');
        return ok(text, { schedules });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'schedule_update',
    {
      title: 'Edit a schedule',
      description:
        "Change a schedule's NAME / WHAT IT RUNS (a test case or a suite — `testCaseId` or `suiteId`; the schedule switches between Test Case and Suite as the Scheduler form does, keeping the same id) / " +
        "time / recurrence / end date / timezone / browser / environment / release / sprint, or RE-PIN its " +
        'agent. Pass `scheduleId` (from schedule_list) and ONLY the fields to change. To re-pin: ' +
        "mode:'local' + `agentId` (from local_agents), or mode:'cloud' + a runner's `cloudRunnerCredentialId` " +
        '(the `credentialId` from cloud_runners). Requires a live connection.',
      inputSchema: {
        scheduleId: z.string().describe('The schedule id (from schedule_list).'),
        name: z.string().min(3).max(501).optional().describe('Rename the schedule (3–501 characters, unique in the project) — the name the Scheduler shows.'),
        testCaseId: z.string().optional().describe('Make it run THIS test case (id or code, e.g. TC-35) — a suite schedule becomes a Test Case schedule. Not together with suiteId.'),
        suiteId: z.string().optional().describe('Make it run THIS suite (id or code, e.g. SU-4) — a test-case schedule becomes a Suite schedule (which needs a release). Not together with testCaseId.'),
        releaseId: z.string().optional().describe('Release: id, code (RE-44) or exact name; "none" clears it. A suite schedule needs one.'),
        sprintId: z.string().optional().describe('Sprint: id, code (SP-1) or exact name; it must belong to the release. "none" clears it.'),
        scheduledFor: z.string().optional().describe('New start / next-run ISO datetime.'),
        scheduleType: z.enum(SCHEDULE_TYPES).optional().describe('New recurrence (same choices as the UI: once, every_5_minutes, hourly, daily, weekly, monthly). Anything but once needs an endDate.'),
        interval: z.number().int().min(1).optional().describe("REPEAT EVERY N for hourly / daily / weekly / monthly — N hours / days / weeks / months (e.g. hourly + 2 = every 2 hours). Default 1; giving it alone changes the schedule's current cadence. Not for 'once' / 'every_5_minutes' (fixed at 5 minutes — SimplifyQA has no other minute interval)."),
        daysOfWeek: z.array(z.string()).optional().describe("Weekly: the weekdays to run on (MONDAY … SUNDAY or MON … SUN); default = the start's weekday. Monthly with `occurrence`: the one weekday."),
        dayOfMonth: z.number().int().min(1).max(30).optional().describe("Monthly 'ON DAY': 1–30; default = the start's day."),
        occurrence: z.enum(['first', 'second', 'third', 'last']).optional().describe("Monthly 'ON THE': the first / second / third / last weekday of the month — give the weekday in daysOfWeek."),
        endDate: z.string().optional().describe('New ISO end date (for recurring schedules).'),
        timezone: z.string().optional().describe("New IANA timezone (e.g. 'Asia/Kolkata')."),
        browser: z.enum(['chromium', 'msedge', 'firefox', 'webkit']).optional().describe('New browser (schedules accept chromium/msedge/firefox/webkit, not chrome).'),
        environment: z.string().optional().describe('New environment id (Mongo id).'),
        mode: z.enum(['local', 'cloud']).optional().describe('Re-pin target: pair with agentId (local) or cloudRunnerCredentialId (cloud).'),
        agentId: z.string().optional().describe('Local re-pin: an agent credential_id from local_agents.'),
        cloudRunnerCredentialId: z.string().optional().describe("Cloud re-pin: a runner's credentialId from cloud_runners."),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ scheduleId, name, testCaseId, suiteId, releaseId, sprintId, scheduledFor, scheduleType, interval, daysOfWeek, dayOfMonth, occurrence, endDate, timezone, browser, environment, mode, agentId, cloudRunnerCredentialId }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.updateSchedule) return err('This product does not support editing schedules.');
      const changes: ScheduleUpdate = {
        ...(name !== undefined ? { name } : {}),
        ...(testCaseId !== undefined ? { tcId: testCaseId } : {}),
        ...(suiteId !== undefined ? { suiteId } : {}),
        ...(releaseId !== undefined ? { releaseId } : {}),
        ...(sprintId !== undefined ? { sprintId } : {}),
        ...(scheduledFor !== undefined ? { scheduledFor } : {}),
        ...(scheduleType !== undefined ? { scheduleType } : {}),
        ...(interval !== undefined ? { interval } : {}),
        ...(daysOfWeek !== undefined ? { daysOfWeek } : {}),
        ...(dayOfMonth !== undefined ? { dayOfMonth } : {}),
        ...(occurrence !== undefined ? { occurrence } : {}),
        ...(endDate !== undefined ? { endDate } : {}),
        ...(timezone !== undefined ? { timezone } : {}),
        ...(browser !== undefined ? { browser } : {}),
        ...(environment !== undefined ? { environmentId: environment } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(agentId !== undefined ? { agentId } : {}),
        ...(cloudRunnerCredentialId !== undefined ? { cloudRunnerCredentialId } : {}),
      };
      if (Object.keys(changes).length === 0) {
        return err('Nothing to change — pass at least one field to edit (e.g. name, testCaseId / suiteId, scheduledFor, interval / daysOfWeek, scheduleType, browser, or a re-pin via mode + agentId/cloudRunnerCredentialId).');
      }
      try {
        const ref = await adapter.updateSchedule(scheduleId, changes);
        return ok(
          `Updated schedule \`${ref.id}\`${ref.name ? ` — name now "${ref.name}" (read back)` : ''}${testCaseId || suiteId ? ` — now runs ${testCaseId ?? suiteId} (read back)` : ''}${ref.nextRunAt ? ` · next run ${ref.nextRunAt}` : ''}.` +
            (ref.notes?.length ? '\n' + ref.notes.map((n) => `ℹ️ ${n}`).join('\n') : ''),
          { schedule: ref },
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'schedule_control',
    {
      title: 'Pause / resume / cancel a schedule',
      description:
        "Change a schedule's state: `pause` (stop it firing but keep it — reversible with `resume`), " +
        '`resume` (re-enable a paused schedule), or `cancel` (stop its pending / live run). To remove a ' +
        'schedule entirely, use schedule_delete instead. Requires a live connection.',
      inputSchema: {
        scheduleId: z.string().describe('The schedule id (from schedule_list).'),
        action: z.enum(['pause', 'resume', 'cancel']).describe('pause / resume / cancel.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ scheduleId, action }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.controlSchedule) return err('This product does not support pausing / resuming / cancelling schedules.');
      try {
        const ref = await adapter.controlSchedule(scheduleId, action);
        const verb = action === 'pause' ? 'Paused' : action === 'resume' ? 'Resumed' : 'Cancelled';
        return ok(`${verb} schedule \`${ref.id}\`${ref.status ? ` · status ${ref.status}` : ''}.`, { schedule: ref });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'schedule_delete',
    {
      title: 'Delete a schedule',
      description:
        'Permanently DELETE a schedule (and tear down any run it currently owns). This cannot be undone — ' +
        'to only stop it temporarily use schedule_control (pause / cancel). CONFIRM with the user before ' +
        'deleting. Requires a live connection.',
      inputSchema: {
        scheduleId: z.string().describe('The schedule id (from schedule_list).'),
        confirm: z.boolean().optional().describe('SimplifyQA: the first call only previews; pass true on the SECOND call, after the user explicitly said to delete.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ scheduleId, confirm }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.deleteSchedule) return err('This product does not support deleting schedules.');
      try {
        if (adapter.scheduleDeletePreview && confirm !== true) {
          const p = await adapter.scheduleDeletePreview(scheduleId);
          return ok(`About to delete schedule ${p.code ?? p.id}${p.name ? ` (${p.name})` : ''}, which runs ${p.target}. This cannot be undone. ` +
            'Show this to the user; call again with confirm:true only after they explicitly say to delete.', { preview: p });
        }
        await adapter.deleteSchedule(scheduleId);
        return ok(`Deleted schedule \`${scheduleId}\`.`);
      } catch (e) {
        return err(describeError(e));
      }
    },
  );
}
