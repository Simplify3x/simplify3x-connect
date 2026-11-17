import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import { lintAutomatedTestCase, lintBlock } from './testCaseLint.js';
import type { Draft, DraftOp, DraftStore } from '../drafts/store.js';
import type { ProviderAdapter } from '../adapters/types.js';
import { validateTestCase } from '../domain/validate.js';
import type { ActionDef, JournalView, Step, TestCase } from '../domain/types.js';
import { WALNUT_ACTIONS, actionDefsFrom, offlineCatalogFor } from '../adapters/walnut/actionTypes.js';
import { resolveCatalogFor, type CatalogFor } from './actionCatalog.js';
import { toWalnutStep } from '../adapters/walnut/mapper.js';
import { stepsMarkdown, validationSummaryLine } from './markdown.js';
import { zCategory, zDraftOp, zNewStep, zPriority } from './schemas.js';
import { emitTcEdit, openTcViewerWindow, refreshRecorderWindow } from './tcEditPublisher.js';
import { nextVersionName, latestVersionId } from '../versionName.js';
import { recordingName } from './recordingNames.js';
import { askReplaceText, findFunctionCandidatesForTc, findFunctionMatches, proposeFunctionGroups, replaceMatchedRuns, selectMatches, suggestionText, type FnMatch } from './functionReuse.js';

// `| undefined` throughout: see the NOTE ON `| undefined` in domain/types.ts --
// these fields are always threaded through from another already-optional value.
export type TestcaseToolsDeps = {
  drafts: DraftStore;
  /** Default origin for tc_draft_open when the caller doesn't pass frontendOrigin. */
  walnutUiOrigin?: string | undefined;
  /** Loopback base for the local Walnut agent, used ONLY by the default
   * (network) openInAgentWindowViaHttp fallback below -- i.e. only when
   * `openEditorWindow` is absent. Irrelevant once this tool surface is mounted
   * in-process inside the agent itself (src/mcp/qa/mount.ts always supplies
   * `openEditorWindow`, so this field is never consulted there). */
  agentUrl?: string | undefined;
  /**
   * Direct in-process override for opening the editor window. Set by
   * src/mcp/qa/mount.ts to call routes/editorWindow.routes.ts's
   * `openEditorWindow()` directly -- no HTTP hop, because this tool module now
   * runs inside the same process as the Electron window it's asking to open.
   * Left undefined for the standalone stdio dev harness (src/mcp/qa/index.ts),
   * which is a genuinely separate process and falls back to the original
   * loopback-fetch behavior below.
   */
  openEditorWindow?: ((url: string, title: string) => Promise<boolean>) | undefined;
  /** The live provider adapter for the current connection, or null when offline. `tc_save` uses it to
   *  persist a draft to the product (create/update). Optional so offline-only callers still compile. */
  getAdapter?: (() => ProviderAdapter | null) | undefined;
  /**
   * True when the connected product is SimplifyQA. Draft validation must NEVER run against Walnut's
   * static action table for SimplifyQA — its action vocabulary is the backend's own (e.g. the API
   * action is `executerestapi`, not Walnut's `api_call`), so a Walnut check falsely rejects valid
   * SQA steps as `actionType "…" not in catalog`. When absent, validation keeps the Walnut behavior
   * (the Walnut agent's own mount does not pass this).
   */
  isSimplifyqa?: (() => boolean) | undefined;
};

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** First text block from an MCP tool result, for forwarding agent-side save errors. */
function firstText(res: unknown): string {
  const r = res as { content?: Array<{ text?: unknown }> } | undefined;
  if (Array.isArray(r?.content)) {
    const text = r.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
    if (text) return text;
  }
  return 'Recorder save failed.';
}

/** The agent's `read_journal` emits an API step's whole request as top-level `apiData` (the wire
 *  key), whereas the neutral Step holds it as `api`. Fold it across so the save mapper finds it and
 *  emits a real API step (with its request + assertions) instead of an empty NORMAL_STATEMENT. */
export function normalizeJournalStep(step: Step): Step {
  const raw = step as Step & { apiData?: Record<string, unknown>; technologyType?: string };
  // The agent's read_journal emits an API step's request as top-level `apiData` and often labels the
  // step "API Call" while leaving stepType as 'web'. Normalise it to a real API step, otherwise the
  // save builder tries to resolve an action named "API Call" and the whole save fails — taking the
  // parameters and test data with it.
  const looksApi = !!raw.apiData && (
    step.stepType === 'api' ||
    /^api\s*call$/i.test((step.actionType ?? '').trim()) ||
    (raw.technologyType ?? '').toUpperCase() === 'API'
  );
  if (looksApi && !step.api) {
    return { ...step, stepType: 'api', api: raw.apiData };
  }
  // A DESKTOP step is never a technology switch: its own window actions are named "Switch to Window by Name"
  // (dsk-13) and "Switch to Root" (dsk-23), and they must stay steps.
  if (step.stepType === 'desktop') return step;
  // "Switch to WEB/API/DB/…" journal rows arrive as a plain statement with that action name. Route
  // them to the control-flow shape the save builder understands, so a mixed recording saves.
  const sw = /^switch\s+to\s+(.+)$/i.exec((step.actionType ?? '').trim());
  if (sw && !step.controlFlow) {
    return { ...step, stepType: 'switch', controlFlow: { kind: `SWITCH_TO_${sw[1]!.trim().toUpperCase()}` } };
  }
  return step;
}

/**
 * Recorder Save unavailable (the agent's `core_save_session` answers `recorder save request failed:
 * null`, or reports an error): persist the journal STRAIGHT to the backend so the recording — its
 * steps, parameters and default test-data row — is never lost. The save builder turns each step's
 * `recordedParam` into real project parameters plus the ITR-1 row, which is exactly what the
 * recorder UI save was failing to write.
 *
 * Only used as a fallback: when the recorder save works, that path (exact window parity) wins.
 */
export async function saveJournalFallback(
  adapter: ProviderAdapter,
  sessionId: string,
  target?: {
    testcaseId?: string | undefined;
    versionId?: string | undefined;
    versionName?: string | undefined;
    saveMode?: string | undefined;
    copyTestdata?: boolean | undefined;
  },
  name?: string,
): Promise<{ id: string; productUrl?: string; versionName?: string; formulasApplied?: number; formulaSkipped?: string[] } | null> {
  if (!adapter.readJournal) return null;
  const view = await adapter.readJournal(sessionId);
  const steps = (view?.steps ?? []).map(normalizeJournalStep);
  if (!steps.length) return null;
  // The name the recording was started with. Without one, the session id plus the time: a recorder can keep one
  // session id for several recordings, and the backend refuses a second test case with the same name.
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const tc: TestCase = {
    title: name?.trim() || `Recording ${sessionId} ${stamp}`,
    category: 'automated',
    steps,
  };
  if (adapter.listModules) {
    try {
      const dflt = (await adapter.listModules()).find((m) => m.name?.trim().toLowerCase() === 'default module');
      if (dflt?.id) tc.folderOrModule = dflt.id;
    } catch { /* no module lookup — save without one */ }
  }

  // EXISTING-TC re-record (story sync): when the recording was opened against a test case, the
  // fallback must create a NEW VERSION of that TC — never a separate new test case.
  let ref: { id: string; productUrl?: string } | null = null;
  let versionName: string | undefined;
  const existingTcId = target?.testcaseId;
  const newVersion = (target?.saveMode ?? 'new-version') === 'new-version';
  if (existingTcId && newVersion && adapter.saveAsNewVersion) {
    let base: TestCase | null = null;
    try { base = await adapter.getTestCase(target!.testcaseId!); } catch { /* no name/version info */ }
    const vName = target?.versionName
      || nextVersionName(base)
      || 'v2.0';
    // Preserve the EXISTING test case's metadata (name, module, story, description, custom fields);
    // only its steps are replaced. Passing a journal-built TC here used to RENAME the TC and blank
    // its module, which also blocked the recorder window's Save (module is mandatory).
    const merged: TestCase = base
      ? { ...base, category: base.category ?? 'automated', steps }
      : tc;
    ref = await adapter.saveAsNewVersion(target!.testcaseId!, {
      versionName: vName,
      tc: merged,
      tdCopy: target?.copyTestdata !== false,
      ...(target?.versionId ? { sourceVersionId: target.versionId } : {}),
      ...(base?.currentVersionId ? {} : {}),
    });
    versionName = vName;
  } else {
    ref = await adapter.createTestCase(tc);
  }
  if (!ref?.id) return null;

  // Formula-driven values: the steps were created with their concrete recorded values, so apply the
  // recorded =NAME(...) expressions to the DEFAULT test-data row afterwards. Without this the fallback
  // save (window unavailable) would silently freeze the recording's random values as literals.
  let formulasApplied = 0;
  const formulaSkipped: string[] = [];
  // NEVER persist a recorded =NAME(...) as plain text. Written straight through, an unevaluated /
  // unknown / mis-cased formula (e.g. =First_Name("", "") or =concatenate(=first_name(),...)) landed in
  // the grid as text and showed #Error at execution. Evaluate it first; if the agent rejects it, keep
  // the recorded literal value and REPORT the skip.
  const cells: Array<{ paramName: string; value: string; formulaValue?: string }> = [];
  for (const s of steps) {
    for (const [paramName, rawFormula] of Object.entries(s.recordedParamFormula ?? {})) {
      const literal = String((s.recordedParam ?? {})[paramName] ?? '');
      if (!adapter.evaluateFormula) {
        cells.push({ paramName, value: literal, formulaValue: rawFormula });
        continue;
      }
      try {
        const { value, expression } = await adapter.evaluateFormula({ expression: rawFormula });
        cells.push({ paramName, value, formulaValue: expression });
      } catch (e) {
        cells.push({ paramName, value: literal });
        formulaSkipped.push(
          `${paramName}: "${rawFormula}" was NOT stored as a formula — ` +
            `${e instanceof Error ? e.message : String(e)} (kept the recorded value).`,
        );
      }
    }
  }
  if (cells.length > 0 && adapter.patchTestdataCells) {
    try {
      // Target the NEW version's iteration (a TC has one row per version; patching the first row
      // would stamp the formulas onto the OLD version).
      let targetVersionId: string | undefined = undefined;
      if (existingTcId && versionName && adapter.getTestCase) {
        try {
          const after = await adapter.getTestCase(existingTcId);
          targetVersionId = latestVersionId(after);
        } catch { /* fall back to the default row */ }
      }
      const r = await adapter.patchTestdataCells({ tcId: String(ref.id), cells, ...(targetVersionId ? { versionId: targetVersionId } : {}) });
      formulasApplied = r.patched;
      formulaSkipped.push(...r.skipped);
    } catch {
      formulaSkipped.push('could not patch the test-data cells');
    }
  }

  return {
    id: String(ref.id),
    ...(ref.productUrl ? { productUrl: ref.productUrl } : {}),
    ...(versionName ? { versionName } : {}),
    ...(cells.length ? { formulasApplied, formulaSkipped } : {}),
  };
}

/**
 * Asks a SEPARATELY-RUNNING local Walnut agent to draw the editor in its own
 * Electron window, over a loopback HTTP call to POST /editor/open.
 *
 * This is the ORIGINAL common-qa-mcp behavior, preserved verbatim as the
 * fallback for `TestcaseToolsDeps.openEditorWindow` being absent -- i.e. for
 * the standalone stdio dev harness (src/mcp/qa/index.ts), which really is a
 * different OS process from the agent and has no direct function to call.
 * When this tool surface is mounted IN-PROCESS inside the agent
 * (src/mcp/qa/mount.ts), that mount always supplies `deps.openEditorWindow`,
 * which calls routes/editorWindow.routes.ts's openEditorWindow() directly and
 * this HTTP path is never used.
 *
 * Returns false for every "not available" case -- agent not running, running as a
 * plain node dev server (it answers 501), or slow -- because this is an
 * optimisation over returning a link, never a failure the user should see. The
 * short timeout keeps a stale port from stalling the tool call.
 */
async function openInAgentWindowViaHttp(
  agentUrl: string | undefined,
  url: string,
  title: string,
): Promise<boolean> {
  const base = agentUrl ?? 'http://127.0.0.1:4050';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/editor/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, title }),
      signal: ctl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Every draft-returning tool shares this shape: markdown steps table +
 * validation summary line in `content`, the neutral TestCase in
 * `structuredContent` (spec: "one shared helper, not duplicated per tool").
 * Exported so mcp/qa/tools/recording.tools.ts's `recording_save` (a
 * draft-returning tool too -- it hands live-recorded steps into the SAME
 * DraftStore) reuses this instead of a second hand-written literal. */
export function draftResult(draft: Draft, catalogFor: CatalogFor = offlineCatalogFor) {
  const issues = validateTestCase(draft.tc, catalogFor);
  const summary = validationSummaryLine(draft.tc, issues);
  const text = `Draft ${draft.draftId} · ${summary}\n\n${stepsMarkdown(draft.tc)}`;
  return ok(text, { draftId: draft.draftId, tc: draft.tc, issues });
}

function toBase64Url(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Builds the exact `/embed/test-case-draft#d=<payload>` URL walnut-frontend's
 * real TestStepsEditor reads, per scripts/open-in-walnut-editor.ts. `mode` is
 * hardcoded to 'view' -- there is no save path in this server yet, so offering
 * an editable Save affordance the backend can't fulfil would be misleading.
 */
function buildEditorUrl(origin: string, draft: Draft): string {
  const trimmed = origin.endsWith('/') ? origin.slice(0, -1) : origin;
  const payload = {
    title: draft.tc.title,
    priority: draft.tc.priority,
    category: draft.tc.category,
    draftId: draft.draftId,
    mode: 'view' as const,
    test_steps: draft.tc.steps.map(toWalnutStep),
  };
  return `${trimmed}/embed/test-case-draft#d=${toBase64Url(payload)}`;
}

/**
 * Registers the offline draft-authoring tool surface: actions_catalog plus the
 * 5 tc_draft_* tools. Every handler here works with `adapter === null` and
 * touches no network -- draft state lives entirely in `deps.drafts`
 * (in-memory, per DraftStore's own contract) and validation runs against the
 * static WALNUT_ACTIONS catalog via offlineCatalogFor. There is deliberately
 * no save/persist tool: nothing this module does writes to any backend.
 */
export function registerTestcaseTools(server: McpServer, deps: TestcaseToolsDeps): void {
  // Provider-aware action-type catalog for draft validation. SimplifyQA NEVER uses Walnut's static
  // table — it validates against the live SQA backend catalog (or skips when unreachable). Walnut
  // (and unknown/offline) keeps the static table, unchanged.
  const catalogFor = (): Promise<CatalogFor> =>
    resolveCatalogFor(deps.getAdapter?.() ?? null, deps.isSimplifyqa?.() ?? false);

  server.registerTool(
    'actions_catalog',
    {
      title: 'List the offline action-type catalog',
      description:
        'Static per-platform action-type vocabulary (web/android/ios/api/database/mainframe), used for '
        + 'offline draft validation. No network call. NOTE mainframe is deliberately EMPTY (no source '
        + 'list exists), and validate.ts skips validation entirely for an empty catalog — so a clean '
        + 'mainframe draft means "not checked", not "checked and fine".',
      inputSchema: { platform: z.enum(['web', 'android', 'ios', 'api', 'database', 'mainframe', 'desktop']).optional().describe('desktop: there is no offline list; on SimplifyQA the live catalog includes the DESKTOP actions (dsk-*: Launch Application, Click, Type Text, Switch to Window by Name, …).') },
      annotations: { readOnlyHint: true },
    },
    async ({ platform }) => {
      try {
        // Prefer the LIVE backend catalog when connected — SQA rows carry numeric `id` that the
        // model needs to round-trip existing steps (an SQA-hydrated step's actionType is the id
        // string, not the name). Falls back to the offline walnut list when no adapter or when
        // the adapter call fails, so the tool always returns something usable.
        // On SimplifyQA there is NO walnut fallback: its action vocabulary is the backend's own,
        // and showing Walnut's list would be actively misleading (the model would author steps
        // against names the SQA backend does not have).
        const adapter = deps.getAdapter?.();
        let defs: ActionDef[] | null = null;
        if (adapter?.actionsCatalog) {
          try { defs = await adapter.actionsCatalog(platform); } catch { defs = null; }
        }
        if (!defs) {
          defs = deps.isSimplifyqa?.()
            ? []
            : (() => {
                const all = actionDefsFrom(WALNUT_ACTIONS);
                return platform ? all.filter((a) => a.platform === platform) : all;
              })();
        }
        const text =
          `${defs.length} action type${defs.length === 1 ? '' : 's'}${platform ? ` for ${platform}` : ''}.\n\n` +
          defs.map((a) => `- \`${a.actionType}\` (${a.platform})${a.id != null ? ` — id ${a.id}` : ''}`).join('\n');
        return ok(text, { actions: defs });
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'tc_draft_from_tc',
    {
      title: 'Load an existing test case as a draft for in-place editing',
      description:
        'Fetch a REAL test case from the connected product and hydrate it into a draft, carrying the ' +
        "original tcId. Because the draft carries the id, a later `tc_save({ draftId })` UPDATES that " +
        'SAME test case (preserving id, run history, parameters, testdata bindings, and suite ' +
        'membership) instead of creating a sibling.\n\n' +
        'THIS is the tool for "tag/retag this EXISTING test case with a user story or module" — ' +
        '`journal_modify`\'s `set_meta` does NOT support that on SimplifyQA (journal-only ops there), ' +
        'so this draft round-trip is the only path:\n' +
        '  1. tc_draft_from_tc({ tcId })\n' +
        '  2. tc_draft_update({ draftId, ops: [{ op: "set_meta", patch: { storyRef?, folderOrModule?, ' +
        'title?, priority?, ... } }] }) — resolve a story/module NAME to an id via story_list / ' +
        'list_modules FIRST; never guess one.\n' +
        '  3. tc_save({ draftId })\n' +
        'Same three steps also apply to applying a `story_sync_testcases` drift report (pass the ' +
        'filtered `proposedOps` at step 2 instead of a set_meta patch). Requires a live connection ' +
        '(qa_connect).',
      inputSchema: {
        tcId: z.string().describe('The existing test-case id to load as a draft.'),
      },
    },
    async ({ tcId }) => {
      const adapter = deps.getAdapter?.();
      if (!adapter) {
        return err('Not connected to a product. Use qa_connect first — loading a real TC needs a live backend.');
      }
      try {
        const tc = await adapter.getTestCase(tcId);
        if (!tc.id) tc.id = tcId;   // adapter contract guarantees id, but belt-and-braces for the update path
        const draftId = deps.drafts.create(tc);
        return draftResult(deps.drafts.get(draftId), await catalogFor());
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'tc_draft_from_journal',
    {
      title: 'Load a recording journal as an automation draft',
      description:
        'Load the steps from a recording session (the journal on the connected agent) into a new ' +
        'AUTOMATION draft. Use this to save a recording that finished — including one from an ' +
        "earlier session. Then review with tc_draft_get and persist with tc_save. If the recording " +
        'targeted an existing TC, pass its id via `tcId` so the draft inherits title/module/project ' +
        'and tc_save UPDATES that TC instead of creating a new one. Requires a live connection ' +
        '(qa_connect) with an agent that owns the recording journal.',
      inputSchema: {
        sessionId: z.string().describe('The recording session id — the same id used when the recording started.'),
        tcId: z.string().optional().describe('Optional: an existing TC id to inherit title/module/project from (and to UPDATE on save).'),
        title: z.string().optional().describe('Optional draft title (overrides tcId meta). Defaults to "Recording <sessionId>" when no tcId is passed.'),
      },
    },
    async ({ sessionId, tcId, title }) => {
      const adapter = deps.getAdapter?.();
      if (!adapter) {
        return err('Not connected to a product. Use qa_connect first — reading a journal needs a live agent.');
      }
      if (!adapter.readJournal) {
        return err('This product has no recording journal.');
      }
      let view: JournalView;
      try {
        view = await adapter.readJournal(sessionId);
      } catch (e) {
        return err(`Could not read journal for session "${sessionId}": ${describeError(e)}`);
      }
      if (!view.steps || view.steps.length === 0) {
        return err(`Journal for session "${sessionId}" is empty — nothing to save. Record steps first.`);
      }
      let meta: Partial<TestCase> = {};
      if (tcId) {
        try {
          const existing = await adapter.getTestCase(tcId);
          meta = existing;
        } catch (e) {
          return err(`Could not fetch meta from tcId "${tcId}": ${describeError(e)}`);
        }
      }
      const tc: TestCase = {
        ...(meta as TestCase),
        title: title ?? meta.title ?? `Recording ${sessionId}`,
        category: 'automated',
        steps: view.steps.map(normalizeJournalStep),
        // When no tcId: this is a NEW TC, so drop any id that leaked in from meta.
        // When tcId: keep meta.id so tc_save UPDATES it in place.
        ...(tcId ? {} : { id: undefined as unknown as string | undefined }),
      };
      const draftId = deps.drafts.create(tc, sessionId);
      return draftResult(deps.drafts.get(draftId), await catalogFor());
    },
  );

  server.registerTool(
    'tc_draft_create',
    {
      title: 'Create a test-case draft',
      description:
        'MANUAL-ONLY authoring. Call this when the user asked for a MANUAL test case: they said "manual", ' +
        '"draft only", "plain prose", "no automation", or asked to cover a user story\'s acceptance criteria ' +
        'as manual cases. For those, this IS the right tool — call it.\n\n' +
        'Do NOT use for automated tests. "create a test case", "record this flow", "add a test for X" (with no ' +
        '"manual" qualifier) mean AUTOMATED — route to the `web` / `mainframe` sub-agent to RECORD with real ' +
        'locators instead.\n\n' +
        'Create a new in-memory test-case draft from steps you author yourself. Nothing is persisted -- no disk, ' +
        'no backend, no network. Use tc_draft_open to hand it to the test-case editor for viewing.\n\n' +
        'DO NOT USE THIS FOR A REAL WEB APPLICATION. Steps written here have no locators, so the test case cannot ' +
        'execute -- it only reads plausibly. Whenever there is an app you can reach (the user gives a URL, names an ' +
        'environment, or asks for a test of a real flow), call the `web` sub-agent instead: that captures real ' +
        'locators, real element names and real parameters, and is the DEFAULT way to create a web test case. You ' +
        'do not need the user to say "record" -- if a test case for a real app is wanted, recording is how it is made.\n\n' +
        'Legitimate uses: a MANUAL test case the user explicitly asked for (no automation), API/database steps that ' +
        'need no element binding, restructuring or drafting steps the user supplied verbatim, or sketching a plan ' +
        'when no app is reachable -- and say plainly that the result is not executable until recorded.\n\n' +
        'PARAMETERISE EVERY DYNAMIC VALUE — this is mandatory for manual test cases whenever the step ' +
        'names a URL, credential, product name, form value, expected string, or anything the tester will ' +
        'type / compare. Instead of hard-coding "Enter admin in the Username field", write "Enter ${username} ' +
        'in the Username field" and pass `data: { username: "admin" }` at the TC level. Every `${name}` token ' +
        'becomes a Local parameter in the product and the value from `data` populates the test case\'s ' +
        'default test-data row (ITR-1) automatically. Steps with no `${...}` tokens create no parameters — ' +
        'that is only correct for pure checklist verifications ("verify heading is visible"). If a step ' +
        'references a real value, tokenise it.',
      inputSchema: {
        title: z.string().min(1),
        priority: zPriority.optional(),
        category: zCategory.optional(),
        description: z.string().optional().describe('Optional test-case description / summary.'),
        storyRef: z.string().optional().describe(
          'Link this test case to a USER STORY — its id or business key (US_123, from story_list / ' +
            'story_get). Used when drafting MANUAL test cases for a story so they save linked to it.',
        ),
        folderOrModule: z.string().optional().describe(
          'SimplifyQA-only: id of the MODULE / folder to file this test case under on save (from ' +
            'list_modules). ASK the user which module before drafting; SimplifyQA files test cases in ' +
            'a module tree. Walnut ignores this.',
        ),
        steps: z.array(zNewStep).optional(),
        technologyType: z.string().optional().describe(
          'SimplifyQA-only: the automation stack this test case targets — WEB | API | ANDROID | IOS | ' +
            'DATABASE | MAINFRAME | DESKTOP | SAP. REQUIRED when the draft is built only from FUNCTION ' +
            'calls (a function call carries no technology of its own); otherwise it is derived from the ' +
            'steps, or from the called functions\' fnType at save time.',
        ),
        executionPlatform: z.object({
          id: z.string(), name: z.string(), technologyType: z.string(), type: z.string(),
          cloudDeviceType: z.string().optional(),
        }).optional().describe(
          'SimplifyQA-only, ANDROID/IOS only: the device the test case targets — ' +
            '{ id: <device serial>, name, technologyType: "ANDROID"|"IOS", type: "REAL_DEVICE"|"CLOUD_DEVICE" }. ' +
            'The backend rejects a mobile test case without it.',
        ),
        data: z.record(z.string(), z.string()).optional().describe(
          'Default values for the `${name}` tokens in step descriptions — one entry per token. ' +
            'Populates the auto-created default test-data row (ITR-1) on save. Example: ' +
            '`{ username: "admin", password: "admin123", url: "https://saucedemo.com" }`.',
        ),
      },
    },
    async ({ title, priority, category, description, storyRef, folderOrModule, steps, data, technologyType, executionPlatform }) => {
      try {
        const tc: TestCase = {
          title,
          ...(priority ? { priority } : {}),
          category: category ?? 'automated',
          ...(description ? { description } : {}),
          ...(storyRef ? { storyRef } : {}),
          ...(folderOrModule ? { folderOrModule } : {}),
          ...(technologyType ? { technologyType: technologyType.toUpperCase() } : {}),
          ...(executionPlatform ? { executionPlatform } : {}),
          ...(data ? { data } : {}),
          // zod (zNewStep) is the runtime gate on shape; DraftStore.create
          // assigns real step numbers regardless of what's passed here.
          steps: (steps ?? []) as Step[],
        };
        const draftId = deps.drafts.create(tc);
        return draftResult(deps.drafts.get(draftId), await catalogFor());
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'tc_draft_update',
    {
      title: 'Update a test-case draft',
      description:
        'Apply one or more ops (set_meta | add_step | update_step | remove_step | move_step | duplicate_step) to a draft. Steps renumber contiguously from 1 after every op.\n\n' +
        'To COPY a step ("add the same step 2 at the end") use duplicate_step { n, at? } — never rebuild it with add_step: duplicate_step clones the WHOLE step ' +
        '(parameters and their values, object, flags, browser, API request, settings) so nothing is lost. For an IF / loop / function block pass `through` too (the last step of the block).\n\n' +
        'update_steps { where, patch } applies ONE patch to EVERY step matching `where` (numbers, from/to, stepType, actionType, object, descriptionContains, parameter) — use it for "skip every step that uses X"; an empty `where` is refused unless all:true. ' +
        'To change WHICH parameter a step uses, put `swapParams: [{ from, to, value? }]` in the step patch (it replaces the parameter in the SAME slot; `recordedParam` only adds). ' +
        'To edit a project parameter itself (Local <-> Runtime, default value) use parameter_update.\n' +
        'To change an API step IN PLACE (add an assertion, change the URL / a header / the body) use update_step with `patch.api`: it is MERGED into the saved request, ' +
        'so only what you pass changes. `api.addAssertions: [{ path, condition, expectedValue }]` appends assertions (e.g. path "statusCode", "$.body.id", "$.headers.X"); `api.assertions` replaces the whole list. ' +
        'NEVER remove_step + add_step to edit a step — that deletes it and creates a different one.\n\n' +
        'STEP TYPE — for add_step / update_step on a MANUAL test case (tc.category === "manual", or every existing step arrived with stepType "manual"), pass `stepType: "manual"`. ' +
        'For an AUTOMATED test case pick the execution technology ("web", "api", "android", …). ' +
        'Getting this wrong routes the row to the wrong UI card and it renders blank in the desktop viewer.\n\n' +
        'CALLING A SAVED FUNCTION — a function step is `{ stepType: "function", actionType: "function", description, functionCall: { testCaseId: "FN-12" } }` ' +
        '(the numeric id also works). Its matching `function_end` row is generated automatically and the function\'s NEWEST version is pinned at save, so ' +
        '"use these functions and create a new tc" is just one add_step per function in run order, then tc_save. Do NOT pass a real action name ' +
        '(a function call has no action) and do NOT add `function_end` yourself.',
      inputSchema: { draftId: z.string(), ops: z.array(zDraftOp).min(1) },
    },
    async ({ draftId, ops }) => {
      try {
        const draft = deps.drafts.applyOps(draftId, ops as DraftOp[]);
        // Live-view fanout: emit one wire event per op so the Angular listener
        // can apply position-only ops (DELETE/MOVE) surgically without a full
        // reload. Shape-heavy ops (INSERT/UPDATE) currently log on the UI side
        // pending Phase 1.5's step-shape mapper — see plan/tc-edit-live-protocol.md.
        // set_meta has no wire event (§3 of the spec covers step-level only).
        if (draft.sessionId) {
          for (const op of ops as DraftOp[]) {
            switch (op.op) {
              case 'add_step':
                void emitTcEdit(draft.sessionId, 'TC_EDIT_INSERT', { at: op.at, step: op.step });
                break;
              case 'update_step':
                void emitTcEdit(draft.sessionId, 'TC_EDIT_UPDATE', { n: op.n, step: op.patch });
                break;
              case 'remove_step':
                void emitTcEdit(draft.sessionId, 'TC_EDIT_DELETE', { n: op.n });
                break;
              case 'move_step':
                void emitTcEdit(draft.sessionId, 'TC_EDIT_MOVE', { from: op.n, to: op.to });
                break;
              // set_meta, duplicate_step → no wire event; changes surface on next tc_save + reload
            }
          }
        }
        return draftResult(draft, await catalogFor());
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'tc_draft_get',
    {
      title: 'Get a test-case draft',
      description: 'Fetch a draft by id: readable steps table, validation summary, and the neutral TestCase.',
      inputSchema: { draftId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ draftId }) => {
      try {
        return draftResult(deps.drafts.get(draftId), await catalogFor());
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'tc_draft_discard',
    {
      title: 'Discard a test-case draft',
      description: 'Delete an in-memory draft. Nothing was ever persisted, so there is nothing else to undo.',
      inputSchema: { draftId: z.string() },
    },
    async ({ draftId }) => {
      try {
        deps.drafts.delete(draftId);
        return ok(`Discarded draft ${draftId}. Nothing was ever persisted.`);
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'tc_draft_open',
    {
      title: 'Open a draft in the test-case editor',
      description:
        "Show this draft in the product's real editor. Prefers the local agent's own native window when the agent is running; otherwise returns a link to open. The draft rides in the URL fragment -- nothing is uploaded, no backend call is made.",
      inputSchema: {
        draftId: z.string(),
        frontendOrigin: z.string().optional(),
        /** Set false to always return a link instead of using the agent window. */
        useAgentWindow: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ draftId, frontendOrigin, useAgentWindow }) => {
      try {
        const draft = deps.drafts.get(draftId);
        const origin = frontendOrigin ?? deps.walnutUiOrigin ?? 'http://localhost:8080';
        const url = buildEditorUrl(origin, draft);
        const issues = validateTestCase(draft.tc, await catalogFor());
        const summary = `Draft ${draft.draftId} · ${validationSummaryLine(draft.tc, issues)}`;

        // Preferred path: the agent is Electron, so it can draw the editor in its
        // own window -- no browser tab, and no need for the AI client to render UI.
        // Any failure here is not an error for this tool: fall through to the link.
        const openWindow =
          deps.openEditorWindow ?? ((u: string, t: string) => openInAgentWindowViaHttp(deps.agentUrl, u, t));
        const openedInAgent = useAgentWindow === false ? false : await openWindow(url, draft.tc.title);

        if (openedInAgent) {
          return ok(
            `Opened "${draft.tc.title}" in the agent's editor window.\n\n${summary}\n\n` +
              `If you would rather use a browser: ${url}`,
            { url, draftId: draft.draftId, openedIn: 'agent-window', tc: draft.tc },
          );
        }

        return ok(
          `${url}\n\n` +
            `Open this link to view "${draft.tc.title}" in the test-case editor -- nothing is uploaded, the draft rides in the URL fragment.\n\n` +
            `${summary}`,
          { url, draftId: draft.draftId, openedIn: 'link', tc: draft.tc },
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'tc_edit_open',
    {
      title: 'Open an existing test case for live prompt-driven step editing',
      description:
        'One-shot: hydrate an EXISTING test case as a draft, open it in the desktop TC-viewer window, ' +
        'and bind a live-edit session so subsequent tc_draft_update calls stream the changes into the ' +
        'window in real time (TC_EDIT_RESYNC on each op batch, per plan/tc-edit-live-protocol.md). ' +
        '⚠️ THIS OPENS THE DESKTOP RECORDER/VIEWER WINDOW (scrcpy / SCRPY). Use it ONLY when the user ' +
        'explicitly wants to WATCH the edits live or asks to open the test case in the viewer. For a plain ' +
        'prompt like "add a step to TC N at step 3", "remove step 2", "change step 3" do NOT use it — call ' +
        'journal_modify({ tcId, ops:[{ op:"add_step", at, step }] }), which edits the saved test case directly ' +
        'with no window.\n\n' +
        'Returns { draftId, sessionId, tcId }. Follow up with tc_draft_update({ draftId, ops }) for edits ' +
        'and tc_save({ draftId }) to persist. Requires a live connection (qa_connect); the desktop app ' +
        'must be running on the same machine or the window-open call silently no-ops (the draft still ' +
        'mutates correctly — only the live view is lost).',
      inputSchema: {
        tcId: z.string().describe('The existing test-case id to open for editing.'),
        hashRoute: z.string().optional().describe(
          'Optional Angular hash route override, e.g. "#/user/testcase/details/593". Defaults to ' +
            '"#/user/testcase/details/<numericTcId>" (matches the browser UI route). Pass this only if ' +
            'the product\'s testcase-details route differs from the default.',
        ),
        baseUrl: z.string().optional().describe('sqa-ui origin (defaults to whatever the desktop app is configured with).'),
        accessToken: z.string().optional().describe('Bearer token forwarded to the desktop window for API calls.'),
        userId: z.union([z.string(), z.number()]).optional(),
        projectId: z.union([z.string(), z.number()]).optional(),
      },
    },
    async ({ tcId, hashRoute, baseUrl, accessToken, userId, projectId }) => {
      const adapter = deps.getAdapter?.();
      if (!adapter) {
        return err('Not connected to a product. Use qa_connect first — opening a real TC needs a live backend.');
      }
      let tc: TestCase;
      try {
        tc = await adapter.getTestCase(tcId);
        if (!tc.id) tc.id = tcId;
      } catch (e) {
        return err(`Could not fetch test case "${tcId}": ${describeError(e)}`);
      }
      // sessionId is our correlation key: (a) stamped on the draft so tc_draft_update knows where to
      // fan out edits, (b) sent to Electron as the windowList key, (c) put in the URL query so the
      // Angular renderer knows MCP owns edits (§6 of the wire spec). One id, three places.
      const sessionId = `tc-edit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const draftId = deps.drafts.create(tc, sessionId);
      const draft = deps.drafts.get(draftId);

      // ponytail: fall back to the adapter's session context — the LLM has no way to know the
      // bearer token, and without it the desktop app loads sqa-ui unauthenticated → skeleton
      // loaders forever because API fetches 401. Caller args still win when explicitly provided.
      const sess = (await (adapter as {
        getSessionContext?: () => Promise<{ token?: string; baseUrl?: string; projectId?: string; userId?: string }>;
      }).getSessionContext?.()) ?? {};
      const _baseUrl = baseUrl ?? sess.baseUrl;
      const _accessToken = accessToken ?? sess.token;
      const _userId = userId ?? sess.userId;
      const _projectId = projectId ?? sess.projectId;
      const opened = await openTcViewerWindow({
        sessionId, tcId,
        ...(hashRoute ? { hashRoute } : {}),
        ...(_baseUrl ? { baseUrl: _baseUrl } : {}),
        ...(_accessToken ? { accessToken: _accessToken } : {}),
        ...(_userId !== undefined && _userId !== '' ? { userId: _userId } : {}),
        ...(_projectId !== undefined && _projectId !== '' ? { projectId: _projectId } : {}),
      });

      // TC_EDIT_HELLO gives the UI its baseline. Skipped if the window didn't open — no consumer.
      if (opened) {
        void emitTcEdit(sessionId, 'TC_EDIT_HELLO', {
          tcId, draftId, steps: draft.tc.steps,
        });
      }

      const issues = validateTestCase(draft.tc, await catalogFor());
      const summary = validationSummaryLine(draft.tc, issues);
      const openedLine = opened
        ? `Opened "${draft.tc.title}" in the desktop TC editor. Session ${sessionId}.`
        : `Draft ${draftId} ready. Desktop app not reachable on this machine — edits will apply to the draft, but nothing will render live.`;
      return ok(
        `${openedLine}\n\nDraft ${draft.draftId} · ${summary}\n\n${stepsMarkdown(draft.tc)}`,
        { draftId, sessionId, tcId, opened, tc: draft.tc, issues },
      );
    },
  );

  server.registerTool(
    'tc_record_append',
    {
      title: 'Record additional steps into a TC that is already open in the editor',
      description:
        'Start a live-browser recording session whose captured steps stream into the tc-viewer window ' +
        'bound by an earlier `tc_edit_open`. Each user interaction becomes a TC_EDIT_INSERT event in the ' +
        'editor. Returns instructions the model must follow (this tool itself does not touch the driver):\n' +
        '  1. `core_activate_technology({ technology:"WEB", mcpTcEditSessionId, testcaseName })` — starts ' +
        '     the browser and binds captures to this window. The response `structuredContent.sessionId` is ' +
        '     the RECORDING session id — remember it for step 3.\n' +
        '  2. Use `web_*` tools to drive the browser. Every captured step shows up live in the editor.\n' +
        '  3. When done, `tc_record_stop({ draftId, recordingSessionId })` reads the recording journal ' +
        '     and appends the captured steps to the draft. Then `tc_save({ draftId })` to persist.\n\n' +
        'A DESKTOP test case gets a desktop guide instead: technology "DESKTOP", ' +
        '`desktop_launch_application({ app_path })` first, then `desktop_snapshot` + `desktop_*` verbs.\n\n' +
        'The draft must have been opened via `tc_edit_open` first — its stored sessionId is what binds ' +
        'the recorder to the correct window.',
      inputSchema: {
        draftId: z.string().describe('The draft id from tc_edit_open.'),
      },
    },
    async ({ draftId }) => {
      let draft: Draft;
      try {
        draft = deps.drafts.get(draftId);
      } catch (e) {
        return err(describeError(e));
      }
      if (!draft.sessionId) {
        return err(
          `Draft "${draftId}" was not opened via tc_edit_open — no tc-viewer window is bound. ` +
            'Open it with tc_edit_open first, then call tc_record_append.',
        );
      }
      // A DESKTOP test case records a Windows application, not a browser.
      if ((draft.tc.technologyType ?? '').toUpperCase() === 'DESKTOP') {
        const desktopGuide =
          `Recording will stream into the TC editor bound to session ${draft.sessionId}.\n\n` +
          `1. core_activate_technology({ technology: "DESKTOP", mcpTcEditSessionId: "${draft.sessionId}", ` +
          `testcaseName: "${draft.tc.title}" }) — response.structuredContent.sessionId is the RECORDING id.\n` +
          `2. desktop_launch_application({ app_path: "<the application's full .exe path — ASK the user>" }) — must be ` +
          `the first call. Ask the user to close the application first if it is open, and not to touch the mouse or ` +
          `keyboard while you record.\n` +
          `3. desktop_snapshot() for refs; desktop_click / desktop_enter_text / desktop_validate_text / etc. with { ref }. ` +
          `After opening a right-click menu or a drop-down list: desktop_snapshot({ scope: "popups" }).\n` +
          `4. core_close_session() when done recording.\n` +
          `5. tc_record_stop({ draftId: "${draftId}", recordingSessionId: "<from step 1>" }) — append to draft.\n` +
          `6. tc_save({ draftId: "${draftId}" }) — persist to the SAME test case, same version.`;
        return ok(desktopGuide, { draftId, tcViewerSessionId: draft.sessionId, tcId: draft.tc.id });
      }
      const guide =
        `Recording will stream into the TC editor bound to session ${draft.sessionId}.\n\n` +
        `1. core_activate_technology({ technology: "WEB", mcpTcEditSessionId: "${draft.sessionId}", ` +
        `testcaseName: "${draft.tc.title}" }) — response.structuredContent.sessionId is the RECORDING id.\n` +
        `2. web_launch_application({ url: "..." }) — must be the first browser call.\n` +
        `3. web_snapshot() before each action; web_click / web_enter_text / web_validate_text / etc. to drive.\n` +
        `4. core_close_session() when done recording.\n` +
        `5. tc_record_stop({ draftId: "${draftId}", recordingSessionId: "<from step 1>" }) — append to draft.\n` +
        `6. tc_save({ draftId: "${draftId}" }) — persist to the SAME test case, same version.`;
      return ok(guide, { draftId, tcViewerSessionId: draft.sessionId, tcId: draft.tc.id });
    },
  );

  server.registerTool(
    'tc_record_stop',
    {
      title: 'Append recorded steps to the draft after tc_record_append',
      description:
        'Read the recording journal for a session and add each captured step to the draft as an ' +
        '`add_step` op. Pairs with `tc_record_append`. Follow with `tc_save({ draftId })` to persist.\n\n' +
        'CAVEAT: The recording journal is process-scoped and may contain steps from earlier recordings ' +
        'in the same Java-server process. Pass `fromIndex` to skip the first N steps if the journal ' +
        'accumulated prior state — usually the count of steps recorded before `tc_record_append` was called.',
      inputSchema: {
        draftId: z.string(),
        recordingSessionId: z.string().describe(
          'The session id from `core_activate_technology`\'s response.structuredContent.sessionId.',
        ),
        fromIndex: z.number().int().nonnegative().optional().describe(
          'Optional: skip the first N steps in the journal (defaults to 0 = take all).',
        ),
      },
    },
    async ({ draftId, recordingSessionId, fromIndex }) => {
      const adapter = deps.getAdapter?.();
      if (!adapter) {
        return err('Not connected to a product. Use qa_connect first — reading a journal needs a live agent.');
      }
      if (!adapter.readJournal) {
        return err('This product has no recording journal.');
      }
      let draft: Draft;
      try {
        draft = deps.drafts.get(draftId);
      } catch (e) {
        return err(describeError(e));
      }
      let view: JournalView;
      try {
        view = await adapter.readJournal(recordingSessionId);
      } catch (e) {
        return err(`Could not read journal for session "${recordingSessionId}": ${describeError(e)}`);
      }
      const skip = fromIndex ?? 0;
      const toAppend = (view.steps ?? []).slice(skip);
      if (toAppend.length === 0) {
        return ok(
          `No new steps to append (journal had ${view.steps?.length ?? 0} steps, skipped ${skip}).`,
          { draftId, appended: 0, tc: draft.tc },
        );
      }
      const ops: DraftOp[] = toAppend.map((step) => ({
        op: 'add_step' as const,
        step: { ...step, n: undefined as unknown as number },
      }));
      try {
        const updated = deps.drafts.applyOps(draftId, ops);
        // The per-op TC_EDIT_INSERT events already streamed to the editor DURING recording;
        // no re-emit here or the UI would double-render.
        return ok(
          `Appended ${toAppend.length} recorded step(s) to draft ${draftId}. Call tc_save to persist.`,
          { draftId, appended: toAppend.length, tc: updated.tc },
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'tc_suggest_functions',
    {
      title: 'Suggest existing functions for the recorded steps',
      description:
        'Call this RIGHT AFTER a recording finishes (before asking the user to save). It compares the ' +
        "recorded steps with the project's existing reusable functions and returns the groups of steps " +
        'that already exist as a function. If it returns matches, show them to the user and ASK which ' +
        'function(s) to replace (all / some / none) — do not decide for them. Read-only: nothing changes. ' +
        'Pass EXACTLY ONE of `sessionId` (live/finished recording), `draftId`, or `tcId` (already saved).',
      inputSchema: {
        sessionId: z.string().optional().describe('Recording session id (core_activate_technology / core_active_recordings).'),
        draftId: z.string().optional().describe('A draft id.'),
        tcId: z.string().optional().describe('A saved test case id or business key. Matched on step IDs (actionId/objectId/stepType/technologyType + parameter names), not on display names.'),
        versionId: z.string().optional().describe(
          "For tcId only: which version's steps to match (an id from the TC's versions[]). Omit for the TC's currently-selected version; on a multi-version TC ASK the user first.",
        ),
        minConfidence: z.enum(['exact', 'strong']).optional().describe(
          "For tcId only. 'exact' (default) = same action/element AND the same parameter names; " +
          "'strong' also accepts the same action/element with a different parameter set (a " +
          're-parameterised copy of the flow).',
        ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, draftId, tcId, versionId, minConfidence }) => {
      const adapter = deps.getAdapter?.();
      if (!adapter) return err('Not connected to a product. Use qa_connect first.');
      if ([sessionId, draftId, tcId].filter(Boolean).length !== 1) {
        return err('Pass exactly one of sessionId, draftId or tcId.');
      }
      let steps: Step[] = [];
      let where: string;
      let applyHint: string;
      let matches: FnMatch[] = [];
      try {
        if (sessionId) {
          if (!adapter.readJournal) return err('This product has no recording journal.');
          steps = ((await adapter.readJournal(sessionId)).steps ?? []).map(normalizeJournalStep);
          where = 'the recording';
          applyHint = `Replace/some → save with tc_save({ sessionId: "${sessionId}", replaceWithFunctions: true | ["<function id>", …] }) ` +
            'once the user asks to save; if they already saved from the recorder window, use tc_replace_with_functions on the saved TC instead.';
        } else if (draftId) {
          steps = deps.drafts.get(draftId).tc.steps ?? [];
          where = 'the draft';
          applyHint = `Replace/some → tc_save({ draftId: "${draftId}", replaceWithFunctions: true | ["<function id>", …] }) once the user asks to save.`;
        } else {
          where = `test case ${tcId}`;
          applyHint = `Replace/some → tc_replace_with_functions({ tcId: "${tcId}", functionIds: ["<function id>", …] }) (omit functionIds for all), ` +
            'or name the exact range with replace: [{ fnId: "<id>", stepSeqs: [<seq>, …] }].';
        }
        if (sessionId || draftId) {
          matches = await findFunctionMatches(adapter, steps);
        } else {
          // Identity-based: actionId/objectId/stepType/technologyType + parameter names.
          matches = await findFunctionCandidatesForTc(adapter, tcId!, {
            ...(versionId !== undefined ? { versionId } : {}),
            ...(minConfidence !== undefined ? { minConfidence } : {}),
          });
          // Provider without raw-step access → fall back to the name-based matcher.
          if (!matches.length) {
            steps = (await adapter.getTestCase(tcId!)).steps ?? [];
            matches = await findFunctionMatches(adapter, steps);
          }
        }
      } catch (e) {
        return err(describeError(e));
      }
      if (!matches.length) {
        return ok('No recorded steps match an existing function — nothing to replace; continue the normal flow.', { matches: [] });
      }
      return ok(suggestionText(matches, where, applyHint), { matches });
    },
  );

  server.registerTool(
    'tc_suggest_function_groups',
    {
      title: 'Suggest functions for the steps just recorded (create + replace)',
      description:
        'THE post-recording step: call this as soon as a recording finishes and BEFORE asking the user to save. ' +
        'It returns BOTH kinds of suggestion in one answer: ' +
        '`replace` — blocks of recorded steps that already exist as a reusable function (offer to swap them for ' +
        'a call to that function), and `create` — contiguous blocks that are good candidates for a NEW reusable ' +
        'function (offer to extract them). Read-only: nothing is created, replaced or saved. ' +
        'Show both lists and ASK the user per block: create as a new function (ask for the name) / replace with ' +
        'the existing FN-x / keep as recorded. Apply AFTER the test case is saved (tc_steps_to_function with ' +
        'replaceInSource:true, or tc_replace_with_functions). ' +
        'Pass EXACTLY ONE of `sessionId` (a finished recording), `draftId`, or `tcId` (already saved).',
      inputSchema: {
        sessionId: z.string().optional().describe('Recording session id (core_activate_technology / core_active_recordings).'),
        draftId: z.string().optional().describe('A draft id (tc_draft_from_journal / tc_draft_from_tc / tc_draft_create).'),
        tcId: z.string().optional().describe('A saved test case id or business key.'),
        versionId: z.string().optional().describe('For tcId only: which version to analyse (an id from the TC versions[]).'),
        groupSize: z.number().int().min(3).max(20).optional().describe('Target steps per proposed new function. Default 6, minimum 3.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, draftId, tcId, versionId, groupSize }) => {
      const adapter = deps.getAdapter?.();
      if (!adapter) return err('Not connected to a product. Use qa_connect first.');
      if ([sessionId, draftId, tcId].filter(Boolean).length !== 1) {
        return err('Pass exactly one of sessionId, draftId or tcId.');
      }
      let steps: Step[] = [];
      let matches: FnMatch[] = [];
      let where: string;
      try {
        if (sessionId) {
          if (!adapter.readJournal) return err('This product has no recording journal.');
          steps = ((await adapter.readJournal(sessionId)).steps ?? []).map(normalizeJournalStep);
          where = 'the recording';
        } else if (draftId) {
          steps = deps.drafts.get(draftId).tc.steps ?? [];
          where = 'the draft';
        } else {
          where = `test case ${tcId}`;
          matches = await findFunctionCandidatesForTc(adapter, tcId!, {
            ...(versionId !== undefined ? { versionId } : {}),
          });
          steps = (await adapter.getTestCase(tcId!)).steps ?? [];
        }
        if (sessionId || draftId) matches = await findFunctionMatches(adapter, steps);
      } catch (e) {
        return err(describeError(e));
      }

      // Steps already covered by an existing-function match are not proposed again as new groups.
      const covered = new Set<number>();
      for (const m of matches) for (const n of m.stepNs) covered.add(n);
      const groups = proposeFunctionGroups(steps, { ...(groupSize !== undefined ? { groupSize } : {}), exclude: covered });

      if (!matches.length && !groups.length) {
        return ok(
          `Nothing to suggest for ${where}: no recorded block matches an existing function and there is no run of ` +
            `${'3+'} consecutive steps worth extracting. Continue the normal flow (review + save).`,
          { replace: [], create: [] },
        );
      }

      const lines: string[] = [`NOTHING HAS CHANGED — suggestions only for ${where}. Ask the user, then apply.`];
      if (matches.length) {
        lines.push('', 'ALREADY EXIST AS A FUNCTION — offer to replace:');
        for (const m of matches) {
          const label = [m.fnCode, m.fnName].filter(Boolean).join(' — ') || m.fnId;
          lines.push(`  • steps ${m.stepNs[0]}–${m.stepNs[m.stepNs.length - 1]} (${m.length} steps) → ${label} (id ${m.fnId})`);
        }
      }
      if (groups.length) {
        lines.push('', 'COULD BECOME A NEW FUNCTION — offer to extract:');
        for (const g of groups) {
          lines.push(`  • steps ${g.fromSeq}–${g.toSeq} (${g.stepCount} steps) — suggested name "${g.suggestedName}"`);
        }
      }
      lines.push(
        '',
        'ASK the user, per block: "create a new function (name?)", "replace with FN-x", or "keep as is". Do NOT decide for them.',
        'APPLY AFTER THE TEST CASE IS SAVED (both need a saved tcId):',
        '  • create → tc_steps_to_function({ tcId, stepSeqs, name, moduleId, replaceInSource: true }) — saves the function AND leaves a function call in its place.',
        '  • replace → tc_replace_with_functions({ tcId, replace: [{ fnId, stepSeqs }] }).',
      );
      return ok(lines.join('\n'), { replace: matches, create: groups });
    },
  );

  server.registerTool(
    'tc_replace_with_functions',
    {
      title: 'Replace steps of a SAVED test case with existing functions',
      description:
        'After the user has chosen (from tc_suggest_functions) which functions to use, swap the matching ' +
        'steps of an already-saved test case for a call to each chosen function. Use this when the user ' +
        'saved from the recorder window; if the recording is not saved yet, pass the choice to tc_save ' +
        "instead. `functionIds` = the user's picks; omit for all matches. The replaced steps' own testdata " +
        "is dropped and the function's default iterations are used. ONLY call after the user said yes.",
      inputSchema: {
        tcId: z.string().describe('Saved test case id or business key.'),
        functionIds: z.array(z.string()).optional().describe('Function ids to apply (from tc_suggest_functions). Omit = all matches.'),
        replace: z.array(z.object({
          fnId: z.string().describe('Function id (FN_12 / numeric).'),
          stepSeqs: z.array(z.number().int().positive()).min(1).describe(
            'The `seq`s of the test case steps to swap for this function — use this when the user names the ' +
            'function AND the range. Must be contiguous.',
          ),
        })).optional().describe(
          'Explicit picks: replace exactly these seqs with these functions, skipping the matcher. Takes ' +
          'precedence over functionIds. This is the "use FN-12 for steps 3-6" path.',
        ),
        versionId: z.string().optional().describe('Version to edit (an id from the TC versions[]). Omit for the current version.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ tcId, functionIds, replace, versionId }) => {
      const adapter = deps.getAdapter?.();
      if (!adapter) return err('Not connected to a product. Use qa_connect first.');
      // Explicit "use THIS function for THESE steps" — no matching needed.
      if (replace && replace.length) {
        if (!adapter.replaceStepsWithExistingFunction) {
          return err('This provider cannot swap steps for a function call.');
        }
        const notes: string[] = [];
        for (const pick of replace) {
          const lo = Math.min(...pick.stepSeqs);
          const hi = Math.max(...pick.stepSeqs);
          try {
            await adapter.replaceStepsWithExistingFunction(tcId, {
              functionId: pick.fnId,
              stepSeqs: [...pick.stepSeqs].sort((a, b) => a - b),
              ...(versionId !== undefined ? { versionId } : {}),
            });
            notes.push(`replaced steps ${lo}–${hi} with function ${pick.fnId}`);
          } catch (e) {
            notes.push(`⚠️ could not replace steps ${lo}–${hi} with ${pick.fnId}: ${describeError(e)}`);
          }
        }
        return ok(`Test case ${tcId}. Function reuse: ${notes.join('; ')}.`, { tcId });
      }

      let steps: Step[];
      try {
        steps = (await adapter.getTestCase(tcId)).steps ?? [];
      } catch (e) {
        return err(`Could not read test case "${tcId}": ${describeError(e)}`);
      }
      // Prefer the ID-based matcher; fall back to the name-based one for providers without it.
      let matches: FnMatch[] = await findFunctionCandidatesForTc(adapter, tcId, {
        ...(versionId !== undefined ? { versionId } : {}),
        minConfidence: 'strong',
      });
      if (!matches.length) {
        matches = await findFunctionMatches(adapter, steps, functionIds ? new Set(functionIds.map(String)) : undefined);
      }
      const wantedIds = functionIds ? functionIds.map(String) : undefined;
      matches = selectMatches(matches, functionIds ?? true);
      const missing = wantedIds ? wantedIds.filter((id) => !matches.some((m) => String(m.fnId) === id)) : [];
      if (!matches.length) {
        return err(
          `No steps in ${tcId} match the chosen function(s) — nothing replaced.` +
            (missing.length ? ` Could not locate: ${missing.join(', ')}.` : ''),
        );
      }
      const note = await replaceMatchedRuns(adapter, tcId, matches, {
        trustSeqs: true,
        ...(versionId !== undefined ? { versionId } : {}),
      });
      // Never report a bare success when part of the user's choice could not be applied.
      const partial = missing.length
        ? `\n⚠️ NOT replaced (no matching steps found in this test case): ${missing.join(', ')}. ` +
          'Pass `replace: [{ fnId, stepSeqs }]` to force an exact range, or re-run the suggestion.'
        : '';
      return ok(`Test case ${tcId}.${note}${partial}`, { tcId, ...(missing.length ? { missing } : {}) });
    },
  );

  server.registerTool(
    'tc_save',
    {
      title: 'Save a draft or a live recording',
      description:
        'Persist a test case to the connected product. Pass EXACTLY ONE of:\n' +
        '  • `draftId` — validate and save a draft (create, or update when the draft carries an id).\n' +
        '  • `sessionId` — save a LIVE/RECENT recording by asking the /mcp-recorder window to click ' +
        'its OWN Save button. This is the exact-parity path: the recorder editor saves the steps, ' +
        'objects, parameters, control flow, functions, API popup values and title/module/story that ' +
        'the user is looking at, including edits made in the window. The recorder window must be ' +
        'open; it stays open for review after saving. Returns the created test case id + deep link.\n' +
        'Requires a live connection (qa_connect).\n' +
        'EXCEPTION — API recordings: after the LAST `api_send_request`, call this ONCE with the sessionId ' +
        'WITHOUT asking, so the recorded API test case is persisted and searchable immediately (the user ' +
        'must not have to click Send and Save first). Only once per recording; never per request.\n' +
        '⚠️ OTHERWISE CALL ONLY ON AN EXPLICIT USER SAVE INSTRUCTION (e.g. "save it", "save this", "persist it"). ' +
        'RECORDING or AUTHORING a test case is NOT a save instruction; neither is the user approving the ' +
        'content ("looks good", "nice"). After a recording/draft finishes, SHOW the steps and ASK — do NOT ' +
        'auto-save. When unsure whether a reply meant save, ASK rather than saving. Never save a recording ' +
        'TWICE (UI Save + tc_save): if the user already clicked Save in the recorder, treat it as done.',
      inputSchema: {
        draftId: z.string().optional().describe('Draft id from tc_draft_create / tc_draft_open. Omit when saving a live recording.'),
        sessionId: z.string().optional().describe('Recording session id from core_activate_technology (or core_active_recordings). Saves via the recorder window\'s own Save button.'),
        allowDuplicate: z.boolean().optional().describe(
          'Set true ONLY after the user confirms they want a new test case with the same name as an existing one. Default: a new test case whose name already exists is saved as name_1, name_2, ….',
        ),
        replaceWithFunctions: z.union([z.boolean(), z.array(z.string())]).optional().describe(
          "Function reuse. Before saving, the steps are compared with the project's existing functions. If " +
          'some already exist as a function and this is OMITTED, the tool does NOT save — it returns the ' +
          'matches and you MUST ASK the user "replace with the existing function(s)?". Then call again with ' +
          'true (replace ALL matches), an array of function ids (replace only those — the user picked some), or ' +
          'false (save as recorded, the normal flow). Never choose for the user. No matches → saves normally ' +
          'and this is ignored. tc_suggest_functions shows the same matches right after recording.',
        ),
        copyTestdataFrom: z.string().optional().describe(
          'Optional source TC id (or TC code). After the recording is saved, copy that TC\'s default-' +
          'iteration testdata onto the new test case, matching parameters BY NAME. Use this when ' +
          'converting a manual TC (tc_automate) so the converted TC keeps the manual testdata instead ' +
          'of the values typed during recording. Omit for a normal recording.',
        ),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ draftId, sessionId, allowDuplicate, copyTestdataFrom, replaceWithFunctions }) => {
      const adapter = deps.getAdapter?.();
      if (!adapter) {
        return err('Not connected to a product. Use qa_connect first — saving persists to the backend.');
      }
      if (!!draftId === !!sessionId) {
        return err('Pass exactly one of draftId (save a draft) or sessionId (save a live recording via the recorder window).');
      }
      if (sessionId) {
        if (!adapter.callRaw) {
          return err('Saving a live recording needs a local recorder agent. Use qa_connect with an agent, or save a draft with draftId.');
        }
        // Function reuse: offer to swap already-existing functions in for the recorded steps. Skipped
        // when the user already said no; a failed lookup never blocks the save.
        let fnMatches: FnMatch[] = [];
        if (replaceWithFunctions !== false && adapter.readJournal) {
          try {
            const view = await adapter.readJournal(sessionId);
            fnMatches = await findFunctionMatches(adapter, (view.steps ?? []).map(normalizeJournalStep));
          } catch { /* no journal / lookup failed — save normally */ }
          if (fnMatches.length && replaceWithFunctions === undefined) {
            return err(askReplaceText(fnMatches, `Then call tc_save again with sessionId: "${sessionId}".`));
          }
        }
        let res: unknown;
        let recorderError: string | null = null;
        // Existing-TC target (story sync): if the recording was opened against a declared test case,
        // a journal fallback must create a NEW VERSION of it rather than a separate test case.
        let recordingTarget: {
          testcaseId?: string; versionId?: string; versionName?: string; saveMode?: string; copyTestdata?: boolean;
          append?: boolean;
        } | undefined;
        try {
          const ctxRes = (await adapter.callRaw('core_active_recordings', {})) as {
            structuredContent?: { recordings?: Array<Record<string, unknown>> };
          } | undefined;
          const rec = ctxRes?.structuredContent?.recordings?.[0];
          if (rec && typeof rec['testcaseId'] === 'string' && rec['testcaseId']) {
            recordingTarget = {
              testcaseId: String(rec['testcaseId']),
              ...(rec['versionId'] ? { versionId: String(rec['versionId']) } : {}),
              ...(rec['versionName'] ? { versionName: String(rec['versionName']) } : {}),
              ...(rec['saveMode'] ? { saveMode: String(rec['saveMode']) } : {}),
              copyTestdata: rec['copyTestdata'] !== false,
              ...(rec['append'] === true || rec['append'] === 'true' ? { append: true } : {}),
            };
          }
        } catch { /* no context — normal create */ }
        // APPEND MODE — the recording was opened against an existing test case with append=true
        // (core_activate_technology({ testcaseId, append:true })). The recorded steps must be ADDED to
        // that test case: not a new TC, not a new version, and the existing steps must survive.
        // The session/window stay open, so further steps can be appended by another tc_save.
        if (recordingTarget?.testcaseId && recordingTarget.append
            && adapter.readJournal && adapter.getTestCase && adapter.updateTestCase) {
          try {
            const view = await adapter.readJournal(sessionId);
            const steps = (view?.steps ?? []).map(normalizeJournalStep);
            if (!steps.length) {
              return ok(`Nothing to append yet — recording ${sessionId} has no captured steps.`, {
                saved: { id: recordingTarget.testcaseId, via: 'append', appended: 0 },
              });
            }
            const targetTc = await adapter.getTestCase(recordingTarget.testcaseId);
            const before = targetTc.steps?.length ?? 0;
            targetTc.steps = [...(targetTc.steps ?? []), ...steps];
            const ref = await adapter.updateTestCase(String(targetTc.id ?? recordingTarget.testcaseId), targetTc);
            // The window is still open and wrote nothing — it still shows the pre-append step list.
            // Ask it to re-read the test case so the user sees the steps the save just stored.
            await refreshRecorderWindow(sessionId);
            // Clear the LIVE steps (recorder window + journal) so the next Save appends only new ones.
            // The tool's argument is `numbers` (1-based step numbers), and it needs confirm:true.
            let cleared = false;
            try {
              await adapter.callRaw('core_remove_steps', {
                sessionId,
                numbers: steps.map((_, i) => i + 1),
                confirm: true,
              });
              const after = (await adapter.callRaw('core_active_recordings', {})) as {
                structuredContent?: { recordings?: Array<Record<string, unknown>> };
              } | undefined;
              cleared = Number(after?.structuredContent?.recordings?.[0]?.['stepCount'] ?? 0) === 0;
            } catch { /* fall through to the warning below */ }
            return ok(
              `Appended ${steps.length} step(s) to ${recordingTarget.testcaseId} ` +
                `(now ${before + steps.length} steps). The recording stays open for more steps.` +
                (cleared ? '' :
                  '\n⚠️ The live steps could not be cleared from the recorder window — close/dispose that ' +
                  'window before adding more, otherwise the next save re-appends them.'),
              {
                saved: {
                  id: ref.id ?? recordingTarget.testcaseId,
                  via: 'append',
                  appended: steps.length,
                  stepCount: before + steps.length,
                },
              },
            );
          } catch (e) {
            return err(`Could not append the recorded steps to ${recordingTarget.testcaseId}: ${describeError(e)}`);
          }
        }
        try {
          res = await adapter.callRaw('core_save_session', { sessionId, timeoutMs: 60000 });
        } catch (e) {
          recorderError = describeError(e);
        }
        const r = res as {
          isError?: boolean;
          content?: Array<{ text?: unknown }>;
          structuredContent?: { saved?: { status?: string; tcId?: unknown; id?: unknown; code?: unknown; productUrl?: unknown; created?: unknown; message?: unknown; formulasApplied?: unknown; versionName?: unknown } };
        } | undefined;
        const saved = r?.structuredContent?.saved;
        const id = saved?.tcId ?? saved?.id;
        if (id == null) {
          const why = recorderError
            ?? (r?.isError ? firstText(res) : firstText(res) || 'recorder returned no test case id');
          // Fallback: the recorder's own Save is unavailable in this build (it answers
          // "recorder save request failed: null"). Persist the journal straight to the backend so
          // the steps AND their parameters / default test-data row are written instead of lost.
          let fallbackError: string | undefined;
          try {
            const fb = await saveJournalFallback(adapter, sessionId, recordingTarget, recordingName(sessionId));
            if (fb) {
              const fbLink = fb.productUrl ? `\n${fb.productUrl}` : '';
              let fbCopy = '';
              if (copyTestdataFrom && adapter.copyTestdata) {
                try {
                  const c = await adapter.copyTestdata({ fromTcId: copyTestdataFrom, toTcId: fb.id });
                  fbCopy = `\nTestdata copied from ${copyTestdataFrom}: ${c.copied} value(s)` +
                    (c.skipped.length ? `; skipped (no matching parameter): ${c.skipped.join(', ')}` : '') + '.';
                } catch (e) {
                  fbCopy = `\n⚠️ Testdata copy from ${copyTestdataFrom} failed: ${describeError(e)}.`;
                }
              }
              const fbFormula = fb.formulasApplied
                ? `\n${fb.formulasApplied} formula(s) were applied to the default test-data row.` +
                  (fb.formulaSkipped?.length ? ` Skipped: ${fb.formulaSkipped.join('; ')}.` : '')
                : '';
              return ok(
                (fb.versionName
                  ? `Created ${fb.versionName} of ${recordingTarget?.testcaseId ?? 'the test case'} from the recording journal — the recorder's own Save was unavailable (${why}). `
                  : `Created test case ${fb.id} from the recording journal — the recorder's own Save was unavailable (${why}). `) +
                `Parameters and test data were rebuilt from the journal's recorded values.${fbLink}${fbCopy}${fbFormula}`,
                {
                  saved: {
                    id: fb.id,
                    ...(fb.productUrl ? { productUrl: fb.productUrl } : {}),
                    ...(fb.versionName ? { versionName: fb.versionName } : {}),
                    via: 'journal',
                    ...(fb.formulasApplied !== undefined ? { formulasApplied: fb.formulasApplied } : {}),
                  },
                },
              );
            }
          } catch (e) {
            fallbackError = describeError(e);   // reported with the recorder's error, not swallowed
          }
          return err(`Recorder save failed: ${why}` +
            (fallbackError ? `\nSaving from the recording journal failed too: ${fallbackError}` : ''));
        }
        const code = saved?.code != null ? String(saved.code) : String(id);
        const verb = saved?.created === false ? 'Updated' : 'Created';
        const savedVersion = typeof saved?.versionName === 'string' ? saved.versionName : undefined;
        const versionNote = savedVersion ? ` as ${savedVersion}` : '';
        const productUrl = typeof saved?.productUrl === 'string' ? saved.productUrl : undefined;
        const link = productUrl ? `\n${productUrl}` : '';
        // tc_automate: make the converted TC's testdata come strictly from the SOURCE manual TC,
        // overwriting whatever values the recording typed. Best-effort — the save already succeeded.
        let copyNote = '';
        if (copyTestdataFrom) {
          if (!adapter.copyTestdata) {
            copyNote = `\n⚠️ Testdata was NOT copied from ${copyTestdataFrom}: this provider has no testdata store.`;
          } else {
            try {
              const c = await adapter.copyTestdata({ fromTcId: copyTestdataFrom, toTcId: String(id) });
              copyNote = `\nTestdata copied from ${copyTestdataFrom}: ${c.copied} value(s)` +
                (c.skipped.length ? `; skipped (no matching parameter): ${c.skipped.join(', ')}` : '') + '.';
            } catch (e) {
              copyNote = `\n⚠️ Testdata copy from ${copyTestdataFrom} failed: ${describeError(e)}. ` +
                'The test case was saved; copy the testdata manually.';
            }
          }
        }
        const chosenMatches = selectMatches(fnMatches, replaceWithFunctions);
        const fnNote = chosenMatches.length ? await replaceMatchedRuns(adapter, String(id), chosenMatches) : '';
        // The recorder window stamps the recorded formulas onto the default testdata iteration before
        // answering; report how many landed so a save that silently skipped them is visible.
        const formulasApplied = Number(saved?.formulasApplied ?? 0);
        const formulaNote = formulasApplied > 0
          ? `\n${formulasApplied} recorded formula(s) applied to the default test-data iteration.`
          : '';
        return ok(`${verb} test case ${code}${versionNote}.${link}${copyNote}${fnNote}${formulaNote}`, {
          saved: {
            id: String(id),
            ...(productUrl ? { productUrl } : {}),
            ...(copyTestdataFrom ? { copyTestdataFrom } : {}),
            ...(formulasApplied > 0 ? { formulasApplied } : {}),
            ...(savedVersion ? { versionName: savedVersion } : {}),
          },
        });
      }
      if (!draftId) {
        return err('Pass exactly one of draftId or sessionId.');
      }
      let draft: Draft;
      try {
        draft = deps.drafts.get(draftId);
      } catch {
        return err(`No draft "${draftId}". Author one with tc_draft_create, or open an existing test case with tc_draft_open.`);
      }
      const issues = validateTestCase(draft.tc, await catalogFor());
      if (issues.length) {
        const detail = issues.map((i) => `- step ${i.step ?? '-'}${i.field ? ` (${i.field})` : ''}: ${i.msg}`).join('\n');
        return err(`Cannot save "${draft.tc.title}" — ${issues.length} validation issue(s):\n${detail}`);
      }
      const isCreate = !draft.tc.id;
      if (isCreate && !(draft.tc.steps ?? []).length) {
        // An empty draft posts nothing and the backend answers without an id — the call used to
        // report "created" while persisting nothing. Say so instead.
        return err(
          `Cannot save "${draft.tc.title}" — the draft has no steps, so there is nothing to persist. ` +
            `Add steps with tc_draft_update ({ op: "add_step" }) first, then save. ` +
            `(To build a test case out of saved functions, add one step per function: ` +
            `{ op: "add_step", step: { description, actionType: "function", stepType: "function", ` +
            `functionCall: { testCaseId: "FN-12" } } } — its FUNCTION_END is added automatically.)`,
        );
      }
      let draftFnMatches: FnMatch[] = [];
      if (replaceWithFunctions !== false && draft.tc.category === 'automated') {
        draftFnMatches = await findFunctionMatches(adapter, draft.tc.steps ?? []);
        if (draftFnMatches.length && replaceWithFunctions === undefined) {
          return err(askReplaceText(draftFnMatches, `Then call tc_save again with draftId: "${draftId}".`));
        }
      }
      if (isCreate && adapter.listModules && !draft.tc.folderOrModule) {
        // No module chosen: file it under the project's "Default Module" (what the UI's form pre-selects)
        // when there is one. Only if there is none do we fall back to asking the user.
        try {
          const dflt = (await adapter.listModules()).find((m) => m.name?.trim().toLowerCase() === 'default module');
          // Mutate the stored draft directly: applyOps would drop its recorder sessionId.
          if (dflt?.id) draft.tc = { ...draft.tc, folderOrModule: dflt.id };
        } catch { /* lookup failed — fall through to asking */ }
      }
      if (isCreate && adapter.listModules && !draft.tc.folderOrModule) {
        return err(
          `Cannot save "${draft.tc.title}" — SimplifyQA files every test case under a module. ` +
            'Call list_modules, ASK the user which module to file this test case under, then ' +
            `tc_draft_update({ draftId: "${draftId}", ops: [{ op: "set_meta", patch: { folderOrModule: "<module id>" } }] }) ` +
            'before retrying tc_save.',
        );
      }
      let renamedFrom: string | undefined;
      if (isCreate && !allowDuplicate) {
        // A name that already exists is auto-suffixed (name_1, name_2, …) rather than saved as a
        // duplicate. Best-effort: a failed lookup must not block the save.
        try {
          const base = draft.tc.title.trim();
          const hits = await adapter.listTestCases({ search: base, limit: 200 });
          const taken = new Set(hits.map((t) => t.title.trim().toLowerCase()));
          if (taken.has(base.toLowerCase())) {
            let n = 1;
            while (taken.has(`${base}_${n}`.toLowerCase())) n++;
            // Mutate the stored draft directly: applyOps would drop its recorder sessionId.
            draft.tc = { ...draft.tc, title: `${base}_${n}` };
            renamedFrom = base;
          }
        } catch {
          // lookup failed — fall through to save
        }
      }
      {
        const missing: Array<{ n: number; name: string }> = [];
        const data = draft.tc.data ?? {};
        for (const s of draft.tc.steps ?? []) {
          for (const m of (s.description ?? '').matchAll(/\$\{([A-Za-z0-9_]+)\}/g)) {
            const name = m[1]!;
            const hasData = Object.prototype.hasOwnProperty.call(data, name) && data[name] !== '';
            const hasStepValue = draft.tc.category !== 'manual' && s.value !== undefined && s.value !== '';
            if (!hasData && !hasStepValue) missing.push({ n: s.n, name });
          }
        }
        if (missing.length) {
          const uniqueNames = [...new Set(missing.map((m) => m.name))];
          const perStep = missing.map((m) => `step ${m.n}: \${${m.name}}`).join(', ');
          return err(
            `Cannot save "${draft.tc.title}" — these step tokens have no resolvable value: ${perStep}. ` +
              'Every `${name}` token needs either a default in the TC\'s `data` map, or (for automated/' +
              'playwright steps) a `value` set on that step — otherwise the parameter gets bound with ' +
              'nothing to resolve at execution. Update the draft: ' +
              `tc_draft_update({ draftId: "${draftId}", ops: [{ op: "set_meta", patch: { data: { ${uniqueNames.map((n) => `${n}: "<value>"`).join(', ')} } } }] }) ` +
              'then retry tc_save.',
          );
        }
      }
      if (draft.tc.category === 'automated') {
        // Every automation step needs a canonical actionType name + a stepType (technology). Without
        // these the adapter's resolveAutomationSteps throws deep inside the multipart POST — cryptic
        // for the caller. objectRef presence is action-dependent (launch has none, click needs one),
        // so we leave that check to the resolver which has the catalog and knows objectRequired.
        const stepIssues: string[] = [];
        (draft.tc.steps ?? []).forEach((s, i) => {
          if (!s.actionType) stepIssues.push(`step ${i + 1}: missing actionType (e.g. "Click", "Type Text")`);
          if (!s.stepType) stepIssues.push(`step ${i + 1}: missing stepType (e.g. "web", "android", "mainframe")`);
        });
        if (stepIssues.length) {
          return err(
            `Cannot save "${draft.tc.title}" — ${stepIssues.length} automation step issue(s):\n- ${stepIssues.join('\n- ')}\n` +
              'Automation steps must carry a canonical actionType + stepType. Recorded drafts get these ' +
              'from the recorder; hand-built drafts must set them via tc_draft_update. For a past recording, ' +
              'use tc_draft_from_journal({ sessionId }) to load its journal into a save-ready draft.',
          );
        }
      }
      // Optimistic-concurrency guard: refuse an UPDATE that would silently
      // overwrite someone else's changes. `draft.tc.version` snapshotted at
      // hydrate time (via tc_draft_from_tc / tc_edit_open) is compared against
      // the CURRENT backend version; a mismatch means the TC moved between
      // hydrate and save. Best-effort — the re-fetch failing is not a save
      // blocker (backend transient issue vs. genuine drift are indistinguishable
      // here, and the PUT itself will surface real errors).
      if (draft.tc.id && draft.tc.version != null) {
        try {
          const current = await adapter.getTestCase(draft.tc.id);
          if (current.version != null && current.version !== draft.tc.version) {
            return err(
              `Cannot save "${draft.tc.title}" — TC ${draft.tc.id} was modified externally ` +
                `since this draft was opened (version ${draft.tc.version} → ${current.version}). ` +
                `Discard this draft with tc_draft_discard, then re-open with tc_edit_open / ` +
                `tc_draft_from_tc to pick up the latest state, then re-apply your edits.`,
            );
          }
        } catch {
          // Best-effort — proceed to the actual save if the version pre-check fails
        }
      }
      try {
        const isUpdate = !!draft.tc.id;
        const saved = isUpdate
          ? await adapter.updateTestCase(draft.tc.id as string, draft.tc)
          : await adapter.createTestCase(draft.tc);
        // Bind the draft to the id it was just created as, so a subsequent tc_draft_update + tc_save
        // UPDATES this same test case in place instead of creating a duplicate (the anisha TC_627→TC_628
        // trap). No-op on an update (already bound).
        if (!isUpdate && saved.id) {
          try { deps.drafts.markSaved(draft.draftId, saved.id); } catch { /* draft already gone — nothing to bind */ }
        }
        // The /mcp-recorder window is torn down by core_close_session (RecordingSubAgent.close →
        // ui.close), which is the ONE place windows close. tc_save no longer tries to close it
        // per-save — the previous callRaw('recording_window_close', ...) had no handler anywhere and
        // was a silently-swallowed no-op.
        const link = saved.productUrl ? `\n${saved.productUrl}` : '';
        const chosenDraft = selectMatches(draftFnMatches, replaceWithFunctions);
        const fnNote = chosenDraft.length ? await replaceMatchedRuns(adapter, String(saved.id), chosenDraft) : '';
        // Pre-run checks for DB / API test cases: warn about what will make the run fail or pass for the wrong
        // reason. Never blocks the save, and never throws into it.
        let lint: string[] = [];
        try { if (draft.tc.category === 'automated') lint = lintAutomatedTestCase(draft.tc); } catch { /* advisory only */ }
        return ok(
          `${isUpdate ? 'Updated' : 'Created'} test case ${saved.id}.` +
            (renamedFrom ? ` "${renamedFrom}" already existed, so it was saved as "${draft.tc.title}".` : '') +
            link + fnNote + lintBlock(lint),
          { saved, draftId: draft.draftId, ...(lint.length ? { warnings: lint } : {}) },
        );
      } catch (e) {
        return err(describeError(e));
      }
    },
  );

  server.registerTool(
    'tc_automate',
    {
      title: 'Turn a manual test case into a recording guide (creates a NEW automated TC)',
      description:
        'Read an EXISTING MANUAL test case and return a recording guide the model uses to drive a live ' +
        "recording via the connected agent's granular tools (web_launch_application, web_snapshot, " +
        'web_click, web_enter_text, …, core_close_session). The Electron recorder window opens ' +
        'automatically on web_launch_application; each captured step streams into it. The user reviews ' +
        'and clicks Save in the recorder — that CREATES A NEW automated test case (via POST /tm/testcase); ' +
        'the source manual TC is left untouched. Pass `url` unless the manual steps already contain one, ' +
        'and `extra` for credentials / data / what to assert. Read-only from MCP: this tool composes text, ' +
        'it never writes. Requires a live connection.',
      inputSchema: {
        tcId: z.string().describe('The manual test case id (or business key TC_123) to automate.'),
        url: z.string().optional().describe('Starting URL for the recording (the app under test).'),
        extra: z.string().optional().describe('Extra guidance for the recording: credentials, data, assertions.'),
        app_path: z.string().optional().describe('DESKTOP test cases only (tcType DESKTOP): the full path of the ' +
          'application\'s .exe. A DESKTOP test case needs no `url`; its guide uses the desktop_* tools.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ tcId, url, extra, app_path }) => {
      const adapter = deps.getAdapter?.();
      if (!adapter) return err('Not connected to a product. Use qa_connect first.');
      let source: TestCase;
      try {
        source = await adapter.getTestCase(tcId);
      } catch (e) {
        return err(`Could not read test case "${tcId}": ${describeError(e)}`);
      }
      if (source.category !== 'manual') {
        return err(
          `"${source.title}" (${tcId}) is not manual (category: ${source.category}). ` +
            'tc_automate promotes MANUAL → automated. To re-record an automated TC, record + tc_save with a fresh title.',
        );
      }
      // "US_7" → 7, "7" → 7, "MOD_12" → 12. Absent → undefined (don't invent).
      const numericSuffix = (s: string | undefined): number | undefined => {
        if (!s) return undefined;
        const m = s.match(/(\d+)$/);
        return m ? parseInt(m[1]!, 10) : undefined;
      };
      const userstoryId = numericSuffix(source.storyRef);
      const moduleId = numericSuffix(source.folderOrModule);
      const stepLines = source.steps
        .map((s, i) => `${i + 1}. ${s.description}${s.expectedResult ? ` (expect: ${s.expectedResult})` : ''}`)
        .join('\n');
      // A DESKTOP test case records a Windows application: it needs an .exe path, not a URL.
      const isDesktopSource = (source.technologyType ?? '').toUpperCase() === 'DESKTOP';
      if (!isDesktopSource && !url && !/https?:\/\//.test(`${extra ?? ''}\n${stepLines}`)) {
        return err(
          `To automate "${source.title}" I need the app URL — the manual steps don't contain one. ` +
            'Call again with `url` (and any credentials/data via `extra`).',
        );
      }
      const storyLine = userstoryId !== undefined
        ? `userstoryId:${userstoryId} — is already selected in the recorder's story picker.`
        : 'no story on source — will need to be picked at Save in the recorder if the user wants a link.';
      const moduleLine = moduleId !== undefined
        ? `moduleId:${moduleId} — is already selected in the recorder's module bar.`
        : 'no module on source — the user picks one in the recorder before Save.';
      // The converted TC must take its testdata STRICTLY from the manual TC — not from whatever the
      // recording happens to type (previously the recording context's values became the new TC's
      // testdata). Read the source default iteration and put the exact values in the guide; the
      // post-save copy (tc_save copyTestdataFrom / recorder sourceTcId) then enforces them.
      let testData: { environmentType: string; parameters: Array<{ name: string; seed: string; protected?: boolean | undefined }> } | null = null;
      try {
        if (adapter.getDefaultIteration) {
          const tpl = await adapter.getDefaultIteration({
            tcId,
            ...(source.currentVersionId ? { versionId: source.currentVersionId } : {}),
          });
          if (tpl.parameters.length) testData = tpl;
        }
      } catch {
        // testdata is best-effort — a broken store must not block the guide
      }
      const testDataBlock = testData
        ? `\n── Testdata from the source manual TC (env ${testData.environmentType}) — use EXACTLY these values ──\n` +
          testData.parameters
            .map((p) => p.protected
              ? `- ${p.name} = [PROTECTED on the source TC — ASK the user for the value; do not invent]`
              : `- ${p.name} = "${p.seed}"`)
            .join('\n') +
          `\nWhen a manual step fills one of these fields, pass the parameter NAME as \`parameter_name\` ` +
          `and type the value above. Do NOT invent values and do NOT reuse values from an earlier ` +
          `recording or the chat context. A parameter whose value is blank has no seed — generate a ` +
          `fresh random value (or reuse the previous session's ONLY if the user explicitly says so).\n`
        : `\n── Testdata ──\nThe source manual TC has no testdata. Generate fresh random values for the fields ` +
          `you type (or reuse the previous session's values ONLY if the user explicitly says so).\n`;
      const structuredTestData = testData
        ? {
            testData: {
              environmentType: testData.environmentType,
              parameters: testData.parameters.map((p) => ({
                name: p.name,
                seed: p.protected ? '*****' : p.seed,
                ...(p.protected ? { protected: true } : {}),
              })),
            },
          }
        : {};
      if (isDesktopSource) {
        const appPath = app_path?.trim();
        const desktopGuide =
          'Automate this manual test case by recording it end-to-end.\n\n' +
          `testcaseName:"${source.title}"\n` +
          `Story: ${storyLine}\n` +
          `Module: ${moduleLine}\n` +
          (source.preconditions ? `Preconditions: ${source.preconditions}\n` : '') +
          (appPath ? `Application: ${appPath}\n` : '') +
          (extra ? `${extra}\n` : '') +
          testDataBlock +
          `\nManual steps (guide only — do not paste verbatim; each granular action captures a real step):\n${stepLines}\n\n` +
          '── Recording tools (call on the connected agent) ──\n' +
          `1. core_activate_technology({ technology: "DESKTOP", testcaseName, ` +
          (userstoryId !== undefined ? `userstoryId: ${userstoryId} (REQUIRED — links the new TC to the source's story), ` : '') +
          `moduleId?: ${moduleId ?? '<from source>'}, sourceTcId: "${tcId}" }) — session context. ` +
          'sourceTcId lets the recorder copy the manual TC testdata at Save.\n' +
          `2. desktop_launch_application({ app_path: ${appPath ? JSON.stringify(appPath) : '"<the application\'s full .exe path — ASK the user>"'} }) ` +
          '— must be the FIRST call. If the application is already open, ask the user to close it first (a second ' +
          'launch is refused), and ask them not to touch the mouse or keyboard while you record.\n' +
          '3. desktop_snapshot() — refs for the current window; take a new one after a step that changes the window.\n' +
          '4. desktop_click({ ref }) / desktop_enter_text({ ref, value }) / desktop_set_text({ ref, value })\n' +
          '   desktop_select_item_from_dropdown({ ref, item }) / desktop_set_checkbox({ ref, checked })\n' +
          '   desktop_invoke_menu_item({ ref }) — open the menu-bar menu with desktop_click first\n' +
          '   desktop_validate_text({ ref, expected }) / desktop_keyboard_action({ keys })\n' +
          '   Right-click menus and open drop-down lists: desktop_snapshot({ scope: "popups" }) after opening them.\n' +
          '   Windows switch by themselves; for a dialog that is not in the snapshot use desktop_list_windows + ' +
          'desktop_switch_window.\n' +
          '5. core_close_session() — when the flow is done.\n\n' +
          '── Save ──\n' +
          'The recorder window streams each step as it is captured. When done, STOP and ask the user to ' +
          'review the step cards and click Save Testcase in the recorder — sourceTcId was passed at ' +
          'activation, so the recorder copies the source manual TC\'s testdata onto the new TC. If the ' +
          `user explicitly asks you to save from chat, call tc_save({ sessionId, copyTestdataFrom: "${tcId}" }). ` +
          `Either way that CREATES A NEW automated test case; the source manual TC ${tcId} stays as-is.`;
        return ok(desktopGuide, {
          sourceTcId: tcId,
          sourceTitle: source.title,
          technology: 'DESKTOP',
          ...(userstoryId !== undefined ? { userstoryId } : {}),
          ...(moduleId !== undefined ? { moduleId } : {}),
          ...structuredTestData,
        });
      }
      const guide =
        'Automate this manual test case by recording it end-to-end.\n\n' +
        `testcaseName:"${source.title}"\n` +
        `Story: ${storyLine}\n` +
        `Module: ${moduleLine}\n` +
        (source.preconditions ? `Preconditions: ${source.preconditions}\n` : '') +
        (url ? `Start URL: ${url}\n` : '') +
        (extra ? `${extra}\n` : '') +
        testDataBlock +
        `\nManual steps (guide only — do not paste verbatim; each granular action captures a real step):\n${stepLines}\n\n` +
        '── Recording tools (call on the connected agent) ──\n' +
        `1. core_activate_technology({ technology: "WEB", testcaseName, ` +
        // The source's story MUST be passed so the converted test case stays linked to it.
        (userstoryId !== undefined ? `userstoryId: ${userstoryId} (REQUIRED — links the new TC to the source's story), ` : '') +
        `moduleId?: ${moduleId ?? '<from source>'}, ` +
        `recordingMode, recordingModeAskedUser, sourceTcId: "${tcId}" }) — session context. ` +
        `ASK the user AI-only vs AI + Manual FIRST (AI + Manual = HYBRID; if they already named it, use that) and pass recordingMode + recordingModeAskedUser ` +
        `(they must match). sourceTcId lets the recorder copy the manual TC testdata at Save.\n` +
        `2. web_launch_application(${url ? `"${url}"` : '{ url }'}) — must be FIRST browser call; opens the Electron recorder window.\n` +
        '3. web_snapshot() — call BEFORE every action to get fresh element refs.\n' +
        '4. web_click({ ref }) / web_enter_text({ ref, value }) / web_select_item_from_dropdown({ ref, item })\n' +
        '   web_check_if_not_checked({ ref }) / web_un_check_if_checked({ ref })\n' +
        '   web_validate_text({ ref, expected }) / web_validate_partial_text({ ref, expected })\n' +
        '   web_keyboard_action({ keys, ref? }) / web_wait_until_element_present({ ref, timeout? })\n' +
        '   Tab / iframe: web_switch_to_tab, web_switch_to_parent_tab, web_close_tab,\n' +
        '   web_switch_to_iframe, web_switch_to_parent_iframe, web_switch_to_default_content.\n' +
        '5. core_close_session() — when the flow is done.\n\n' +
        '── Save ──\n' +
        'The recorder window streams each step as it is captured. When done, STOP and ask the user to ' +
        'review the step cards and click Save Testcase in the recorder — sourceTcId was passed at ' +
        'activation, so the recorder copies the source manual TC\'s testdata onto the new TC. If the ' +
        `user explicitly asks you to save from chat, call tc_save({ sessionId, copyTestdataFrom: "${tcId}" }) ` +
        '— it clicks the recorder window\'s own Save button and then copies the manual testdata. ' +
        'Either way that CREATES A NEW automated test case; the ' +
        `source manual TC ${tcId} stays as-is.\n\n` +
        'Do NOT rely on values typed during the recording for the converted TC\'s testdata — they are ' +
        'replaced by the source TC\'s values. Do NOT call tc_save({ draftId }) / ' +
        'tc_draft_from_journal / update_testcase / journal_modify from MCP in this flow — the recorder UI is the persist step.';
      return ok(guide, {
        sourceTcId: tcId,
        sourceTitle: source.title,
        ...(userstoryId !== undefined ? { userstoryId } : {}),
        ...(moduleId !== undefined ? { moduleId } : {}),
        ...(testData
          ? {
              testData: {
                environmentType: testData.environmentType,
                parameters: testData.parameters.map((p) => ({
                  name: p.name,
                  seed: p.protected ? '*****' : p.seed,
                  ...(p.protected ? { protected: true } : {}),
                })),
              },
            }
          : {}),
      });
    },
  );
}
