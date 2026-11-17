import type {
  ActionDef,
  BacklogDeleteResult,
  BacklogKind,
  ReportFile,
  ReportKind,
  CloudRunner,
  DatasetInfo,
  DefaultIteration,
  CopyTestdataResult,
  DefectQuery,
  DefectSummary,
  TaskQuery,
  TaskSummary,
  Formula,
  FormulaCall,
  FunctionQuery,
  FunctionSummary,
  QaFunction,
  SaveGeneratedIterations,
  SaveGeneratedIterationsResult,
  TestdataRows,
  EntityRef,
  EnvInfo,
  JournalOp,
  JournalView,
  LocalAgent,
  Locator,
  MobileDevice,
  MemberOp,
  ModuleCreateInput,
  ModuleDeleteResult,
  ModuleDetail,
  ModuleSaved,
  ModuleSummary,
  ModuleUpdateInput,
  ObjectQuery,
  ProjectSummary,
  QaObject,
  ReleaseQuery,
  ReleaseSummary,
  SprintQuery,
  SprintSummary,
  RunOptions,
  RunRef,
  RunStatus,
  RunSummary,
  RunTarget,
  ScheduleAction,
  ScheduleInfo,
  ScheduleOptions,
  ScheduleRef,
  ScheduleUpdate,
  SavedRef,
  Story,
  StoryInput,
  StoryQuery,
  StorySummary,
  StoryUpdate,
  Epic,
  EpicInput,
  EpicQuery,
  EpicSummary,
  EpicUpdate,
  Feature,
  FeatureInput,
  FeatureQuery,
  FeatureSummary,
  FeatureUpdate,
  Suite,
  SuiteSummary,
  TcQuery,
  TcSummary,
  TestCase,
  UserQuery,
  UserSummary,
  VersionDeleteInput,
  VersionDeleteResult,
} from '../domain/types.js';
import type { HealApplyMode, HealPlan, HealProposeInput, HealReport } from '../domain/heal.js';
import type { HealFacts } from './simplifyqa/heal/plan.js';

/** A function whose body already exists inside a test case — matched on the step identifiers
 *  (actionId/objectId/stepType/technologyType + parameter names), never on display names. */
export type FunctionReuseCandidate = {
  fnId: string;
  fnCode?: string;
  fnName: string;
  fnVersionId?: string;
  /** 0-based index in the test case's step array. */
  start: number;
  length: number;
  /** `seq` of each covered step — what the replace call is keyed by. */
  seqs: number[];
  confidence: 'exact' | 'strong';
};

export type ProjectInfo = {
  provider: 'walnut' | 'simplifyqa';
  projectId: string;
  projectName: string;
  // `| undefined`: see the NOTE ON `| undefined` in domain/types.ts -- WalnutAdapter.info()
  // assigns `stats ? {...} : undefined` under exactOptionalPropertyTypes.
  counts?: Record<string, number> | undefined;
};

// ponytail: T[] with an optional side-band totalCount. Plain arrays still satisfy this
// (totalCount is optional), so adapters without a total in their response return as-is.
export type ListResult<T> = T[] & { totalCount?: number };

/**
 * What the caller may DO in one project — the role they hold there plus that role's privilege
 * keys. Resolved exactly the way the backend enforces it (`checkPrivilegesForApi`):
 * `/pm/auth/me` → userId, `/pm/projectuserrole?userId=` → roleId for the project,
 * `/pm/roles/search` → that role's `privileges[]`.
 *
 * `tokenValid:false` means the token itself was rejected (nothing else could be read);
 * `hasRole:false` means the token is fine but the user has no role in that project.
 */
export type ProjectPrivileges = {
  projectId: string;
  userId?: string;
  roleId?: number;
  roleName?: string;
  /** The user holds a role in this project. */
  hasRole: boolean;
  /** The token was accepted by `/pm/auth/me` (never assume — an expired key fails here). */
  tokenValid: boolean;
  /** Every privilege key granted to the role in this project (e.g. `add_testcase`). */
  privileges: string[];
};

/**
 * Full adapter contract (design spec §5, ~20 methods). Tools and the UI see only this
 * neutral surface -- WalnutAdapter (Tasks 5-6) and SimplifyQaAdapter (Tasks 11-12) each
 * implement it against their own REST API via a QaHttp client (src/adapters/http.ts).
 * Optional methods (`?`) are genuinely optional per product (e.g. `cloneTestCase` is
 * native on Walnut but a get+create composite on SQA; `listDatasets`/`getObject` are
 * walnut-first / migration-only) -- callers must treat their absence as "not supported
 * by this provider", not as a bug.
 */
export interface ProviderAdapter {
  /** Validates url+token+project. */
  info(): Promise<ProjectInfo>;

  /** Projects visible to the connected token -- for name→id resolution and browsing. */
  listProjects(): Promise<ProjectSummary[]>;

  /** The caller's role + privilege keys in a project (defaults to the selected one). Optional per
   *  provider: the recording preflight (`qa_privileges`) skips it when absent. */
  getProjectPrivileges?(projectId?: string): Promise<ProjectPrivileges>;

  /** Functions whose body already appears in this test case, matched on step IDs. Optional per
   *  provider (Walnut has no function library). */
  functionCandidatesFor?(
    tcId: string,
    opts?: { versionId?: string; minConfidence?: 'exact' | 'strong' },
  ): Promise<FunctionReuseCandidate[]>;

  listTestCases(q: TcQuery): Promise<TcSummary[]>;
  /** Neutral, steps included. `versionId` overrides which version's steps to load — omit to accept
   *  the TC's currently-selected version. Providers without versioning ignore the arg. */
  getTestCase(id: string, versionId?: string): Promise<TestCase>;
  createTestCase(tc: TestCase): Promise<SavedRef>;
  /** Full-doc semantics. */
  updateTestCase(id: string, tc: TestCase): Promise<SavedRef>;
  deleteTestCase(id: string): Promise<void>;
  /** Save-as-new-testcase — creates a NEW TC id in the SAME project + module. Mirrors the FE
   *  in-editor "Save as new TC" dialog (operation: SAVEASNEWTC). `title` is REQUIRED (backend
   *  needs it). `tdCopy:true` clones the source version's testdata; `tdCopy:false` copies only
   *  the column structure. `sourceVersionId` picks the version to clone (default: current). */
  cloneTestCase?(
    id: string,
    title: string,
    opts: { tdCopy: boolean; sourceVersionId?: string },
  ): Promise<SavedRef>;

  /** Snapshot a testcase's CURRENT server state under a NEW version name — same TC id, new
   *  `tcfn_version` row with cloned steps. Optional per provider: SimplifyQA uses the
   *  SAVENEWVERSION operation on `PUT /tm/testcase`; providers without a per-TC version model
   *  omit this. `tdCopy:true` clones the source version's testdata iterations under the new
   *  version; `sourceVersionId` picks which version to snapshot (defaults to the TC's current). */
  saveAsNewVersion?(
    id: string,
    opts: {
      versionName: string;
      tdCopy?: boolean;
      sourceVersionId?: string;
      /** When present, freeze THIS (edited) test case into the new version instead of the stored
       *  state — the "update + save as new version" path used by `story_sync_testcases`. Without
       *  it the current server state is cloned (a pure snapshot). */
      tc?: TestCase;
    },
  ): Promise<SavedRef>;

  /** STEPSTOFN: extract a subset of a testcase's steps into a NEW reusable function.
   *  Mirrors the SQA "Save as function" modal. Steps are resequenced 1..N, retyped as FN
   *  and filed under `moduleId`. `stepSeqs` picks steps by their current `seq` on the TC;
   *  order is preserved, gaps collapse on the way to the new function. `versionId` picks
   *  WHICH of the TC's versions to read steps from — required by the caller to ASK when the TC
   *  has more than one (same rule as tc_get); omit only for a single-version TC.
   *  Absent on providers with no function library (Walnut). */
  saveStepsAsFunction?(
    tcId: string,
    opts: {
      stepSeqs: number[];
      name: string;
      moduleId: number;
      copyTestData?: boolean;
      executionType?: 'AUTOMATION' | 'MANUAL';
      versionId?: string | undefined;
    },
  ): Promise<SavedRef>;

  /** One-shot "Save as function AND replace in TC": runs STEPSTOFN, then PUTs the source TC with
   *  the extracted rows soft-deleted and a FUNCTION+FUNCTION_END pair spliced at the first
   *  extracted seq. Backend rewires testdata automatically — deleted steps' paramIds drop from the
   *  TC's iteration columns, and the FN's default iteration is stamped into each TC iteration row
   *  per environment. `versionId` — same as saveStepsAsFunction; extraction AND the in-place
   *  replace both target this same version. Absent on providers without a function library. */
  replaceStepsWithExistingFunction?(
    tcId: string,
    opts: { functionId: string; stepSeqs: number[]; versionId?: string | undefined },
  ): Promise<SavedRef>;

  extractStepsAsFunctionAndReplace?(
    tcId: string,
    opts: {
      stepSeqs: number[];
      name: string;
      moduleId: number;
      copyTestData?: boolean;
      executionType?: 'AUTOMATION' | 'MANUAL';
      versionId?: string | undefined;
    },
  ): Promise<SavedRef & { fnId: string; fnVersionId: string }>;

  searchObjects(q: ObjectQuery): Promise<QaObject[]>;
  createObject(o: QaObject): Promise<QaObject>;
  /** Delete an object from the shared Object Repository. Any test-case step still bound to it (via
   *  objectRef.id) loses its locator until re-linked or re-recorded — callers should warn accordingly. */
  deleteObject(id: string): Promise<void>;
  /** Read-only dependency probe for object_delete's confirmation preview — how many test cases /
   *  functions / workflows currently reference this object. deleteObject calls this internally too
   *  (and refuses when any count is non-zero); exposed separately so a caller can show it BEFORE
   *  asking the user to confirm, not only discover it as a thrown error after the fact. */
  checkObjectDependencies?(id: string): Promise<{ tcCount: number; fnCount: number; wfCount: number }>;
  /** Update an object directly — e.g. fix a stale locator value outside the tc_heal replay-driven
   *  flow. `changes.locators` UPSERTS by locator name: an existing entry with a matching name has its
   *  value/unique updated in place, others are left untouched, and a name with no existing match is
   *  appended. `changes.moduleName`/`changes.parameterNames` take NAMES, never ids — the adapter
   *  resolves them (and throws naming the invalid one + valid options, rather than silently no-op'ing,
   *  if a name doesn't match). Deliberately CANNOT change the object's technology/type or its template
   *  id — those are structural (they select which attribute set is even valid) and stay whatever they
   *  already are. Optional: not every provider exposes a direct object edit. */
  updateObject?(id: string, changes: {
    name?: string;
    locators?: Locator[];
    description?: string;
    parameterNames?: string[];
    moduleName?: string;
    /** NAME of the locator to make the object's default (one in `locators` or already on the object). */
    defaultLocator?: string;
  }, opts?: { enrichNames?: boolean }): Promise<QaObject>;
  /** Edit a project-level PARAMETER itself (not a step's use of it): its access type (Local <-> Runtime), default value and
   *  description. Re-reads the parameter and throws if the change did not take. Refuses Global parameters and anything that
   *  would change a parameter to or from Global (their value is encrypted/shared - a different operation). Optional. */
  updateParameter?(ref: string, changes: { type?: 'Local' | 'Runtime'; defaultValue?: string; description?: string }): Promise<{
    id: string; name: string; type: string; defaultValue: string; changed: string[];
  }>;
  /** Valid action vocabulary per technology (cached by the caller). */
  actionsCatalog(platform?: string): Promise<ActionDef[]>;

  /** Walnut-only: the recording-JOURNAL view of a test case (steps derived from its journal seed,
   *  or the persisted steps when no seed exists) — the read side of journal-first editing. Absent on
   *  providers with no recording journal. */
  readJournal?(tcId: string): Promise<JournalView>;
  /** Walnut-only: apply granular modify ops (add/remove/update/move step, wrap in loop/if, insert
   *  nested) to a test case and persist — the write side of journal-first editing. */
  editJournal?(tcId: string, ops: JournalOp[]): Promise<JournalView>;

  listSuites(): Promise<SuiteSummary[]>;
  getSuite(id: string): Promise<Suite>;
  createSuite(s: Suite): Promise<SavedRef>;
  /** SimplifyQA-only: create a PROJECT (admin surface). */
  createProject?(input: { name: string; description?: string | undefined; users?: number[] | undefined }): Promise<SavedRef>;
  getProjectById?(id: string): Promise<Record<string, any>>;
  deleteProject?(id: string): Promise<{ deleted: boolean }>;
  updateSuiteMembers(id: string, ops: MemberOp[]): Promise<Suite>;
  deleteSuite(id: string): Promise<void>;

  /** USER STORIES — read side of story-driven authoring (list + read-with-AC). `getStory` accepts a
   *  Mongo _id or a US_/Jira business key. Optional: only products with a story backlog implement them. */
  listStories?(q: StoryQuery): Promise<StorySummary[]>;
  getStory?(id: string): Promise<Story>;
  /** Story WRITE side. `createStory` posts to `POST /pm/userstory` (or provider equivalent) and returns
   *  the saved ref. `updateStory` posts a partial `PUT /pm/userstory/:id`; `updateVersion` on the patch
   *  is optimistic-concurrency and should be the value the client last read. Optional. */
  createStory?(input: StoryInput): Promise<SavedRef>;
  updateStory?(id: string, patch: StoryUpdate): Promise<SavedRef>;

  /** EPICS — top of the backlog hierarchy (epic → feature → story). Only providers with a full
   *  project-management surface (SimplifyQA) implement these; absent on Walnut. */
  listEpics?(q: EpicQuery): Promise<EpicSummary[]>;
  getEpic?(id: string): Promise<Epic>;
  createEpic?(input: EpicInput): Promise<SavedRef>;
  updateEpic?(id: string, patch: EpicUpdate): Promise<SavedRef>;

  /** FEATURES — middle of the backlog hierarchy. `epicId` on FeatureInput/Update links to the parent. */
  listFeatures?(q: FeatureQuery): Promise<FeatureSummary[]>;
  getFeature?(id: string): Promise<Feature>;
  createFeature?(input: FeatureInput): Promise<SavedRef>;
  updateFeature?(id: string, patch: FeatureUpdate): Promise<SavedRef>;
  /** Add users to an epic/feature/story Watch List (`mailersList.users`) — the UI's email button. */
  addWatchListUsers?(input: {
    entityType: 'epic' | 'feature' | 'userstory';
    itemId: string;
    users: Array<string | number>;
  }): Promise<{ users: number[]; mailersList: Record<string, unknown> }>;
  /** Link a backlog item to another item with a link type (the UI's Linkages section). */
  linkBacklogItem?(input: {
    sourceType: 'epic' | 'feature' | 'userstory';
    sourceId: string;
    destType: 'epic' | 'feature' | 'userstory' | 'defect' | 'task';
    destId: string;
    linkType: string;
  }): Promise<{ linkTypeKey: string; destinationCode?: string; linkedIssues: Array<Record<string, unknown>> }>;

  /** SimplifyQA-only: modules / folders in the test-case tree, so a draft can be filed under a
   *  chosen module on save. Absent on providers with no module tree (Walnut). */
  listModules?(): Promise<ModuleSummary[]>;
  /** Full detail for one module — description, code, immediate childIds. `list_modules` returns only
   *  id/name/parent. */
  getModule?(id: string): Promise<ModuleDetail>;
  /** Create a new module. `isRoot:true` files under the project root (server ignores `parentId`);
   *  otherwise `parentId` must exist. When `input.children` is present, walks the subtree
   *  depth-first — the returned `ModuleSaved.children` mirrors the input shape with resolved ids.
   *  Backend has no tx endpoint: on mid-walk failure the result carries `failedAt`; everything up
   *  to that point did land. */
  createModule?(input: ModuleCreateInput): Promise<ModuleSaved>;
  /** Partial update of an existing module — currently just `name` / `description`. Backend requires
   *  `projectId` on the body for the privilege check; adapter defaults to the connected project. */
  updateModule?(id: string, patch: ModuleUpdateInput): Promise<SavedRef>;
  /** Delete modules by id. Two-phase per the SQA PATCH /pm/module contract: `confirm:false` (default)
   *  → dry-run returning the dependency footprint (test cases, functions, defects…) per id;
   *  `confirm:true` → server deletes only the ids with empty dependencies and silently skips the rest.
   *  ponytail: single tool, `confirm` flag, mirrors the backend's two-call flow. */
  /** Delete ONE epic / feature / user story / defect / task by numeric id. Two-phase for all but task:
   *  `confirm:false` (default) = dependency dry-run, nothing is deleted; `confirm:true` deletes only
   *  when nothing depends on the item (otherwise returns the blockers, `deleted:false`). */
  /** Generate PDF reports for ONE execution (`runId` = execution id) and save them under `outDir`.
   *  A TC execution takes `detailed` / `summary`; a SUITE execution also takes `suite` (overall) and
   *  `detailed` / `summary` produce one PDF per test case in the suite. Optional (SimplifyQA only). */
  downloadReports?(input: { runId: string; kinds: ReportKind[]; outDir: string }): Promise<{ scope: 'testcase' | 'suite'; runLabel: string; files: ReportFile[]; notes: string[] }>;
  deleteBacklogItem?(input: { kind: BacklogKind; id: string; confirm?: boolean }): Promise<BacklogDeleteResult>;
  deleteModule?(input: { ids: string[]; projectId: string; confirm?: boolean }): Promise<ModuleDeleteResult>;

  /** Soft-delete ONE version of a TC or a FN. Two-phase per the SQA PUT /tm/tcfnversion/delete
   *  contract: `confirm:false` (default) → dry-run returning the version's dependency footprint;
   *  `confirm:true` → server soft-deletes IF the dep footprint is empty, else silently refuses
   *  (returns the deps unchanged). Caller must NOT assume `confirm:true` = deleted — inspect
   *  `deleted` on the result. Optional per provider (SimplifyQA only). */
  deleteVersion?(input: VersionDeleteInput): Promise<VersionDeleteResult>;

  /** REUSABLE FUNCTIONS (SimplifyQA `tcfnObj` type='FN') — powers list/get/delete for the
   *  function library that test cases call as nested steps. Absent on providers without a
   *  function library. Delete is soft. */
  listFunctions?(q: FunctionQuery): Promise<FunctionSummary[]>;
  getFunction?(id: string): Promise<QaFunction>;
  deleteFunction?(id: string): Promise<void>;
  /** Save-as-new-function — creates a NEW FN id in the SAME project + module. Mirrors the FE
   *  in-editor "Save as new function" dialog (operation: SAVEASNEWFN). `title` is REQUIRED.
   *  `tdCopy:true` clones the source version's testdata; `tdCopy:false` copies only the column
   *  structure. `sourceVersionId` picks the version to clone (default: current). */
  cloneFunction?(
    id: string,
    title: string,
    opts: { tdCopy: boolean; sourceVersionId?: string },
  ): Promise<SavedRef>;
  /** Snapshot a function's CURRENT server state under a NEW version name — same FN id, new
   *  `tcfn_version` row with cloned steps. Mirrors `saveAsNewVersion` with `type:'FN'`. */
  saveAsNewFunctionVersion?(
    id: string,
    opts: { versionName: string; tdCopy?: boolean; sourceVersionId?: string },
  ): Promise<SavedRef>;

  /** RELEASES & SPRINTS — SimplifyQA project-management surface. `listReleases({scope})` returns
   *  releases for the current project (`scope:'project'`) or every release the token can see
   *  (`scope:'all'`); the tool ASKS the user which. `listSprints({releaseId?})` optionally filters
   *  by release. Absent on providers with no release/sprint model (Walnut). */
  listReleases?(q: ReleaseQuery): Promise<ReleaseSummary[]>;
  listSprints?(q: SprintQuery): Promise<SprintSummary[]>;

  /** The connected project's bug tracker rows. Absent on providers with no defect tracker. */
  listDefects?(q: DefectQuery): Promise<DefectSummary[]>;

  /** The connected project's task-management work items. Absent on providers with no task tracker. */
  listTasks?(q: TaskQuery): Promise<TaskSummary[]>;

  /** USERS visible to the caller — for name → userId resolution before filtering `tc_list` /
   *  `story_list` by `createdBy` / `updatedBy`. Absent on providers with no user directory. */
  listUsers?(q: UserQuery): Promise<UserSummary[]>;

  startRun(target: RunTarget, opts: RunOptions): Promise<RunRef>;
  /** Create a SCHEDULE (deferred / recurring run) instead of dispatching now. Optional: only products
   *  with a scheduler implement it; absence = "this provider cannot schedule runs". */
  createSchedule?(target: RunTarget, opts: ScheduleOptions): Promise<ScheduleRef>;
  /** List the project's schedules for management (find one to edit / cancel / delete). Optional. */
  listSchedules?(): Promise<ScheduleInfo[]>;
  /** Edit a schedule's cadence / time / browser / pinned agent. Optional. Reads the current
   *  update_version itself (optimistic concurrency), so the caller passes only what changes. */
  updateSchedule?(scheduleId: string, changes: ScheduleUpdate): Promise<ScheduleRef>;
  /** Pause / resume / cancel a schedule (reversible pause↔resume; cancel stops the pending/live run). */
  controlSchedule?(scheduleId: string, action: ScheduleAction): Promise<ScheduleRef>;
  /** Delete a schedule permanently (also tears down any live run it owns). Optional. */
  deleteSchedule?(scheduleId: string): Promise<void>;
  /** What deleting a schedule would remove, without deleting. When present, schedule_delete is two-step. */
  scheduleDeletePreview?(scheduleId: string): Promise<{ id: string; code?: string; name?: string; target: string }>;
  /** Per-step results when terminal. */
  getRun(runId: string): Promise<RunStatus>;
  stopRun(runId: string): Promise<void>;
  /** Resolve the most recent execution run for a given suite. Returns `null` when the suite has never
   *  been executed. Optional — providers that don't have a suite-run history endpoint omit it. */
  getLatestSuiteRun?(suiteId: string): Promise<string | null>;
  /** Resolve the most recent STANDALONE execution run for a given test case (excludes suite-child
   *  rows). Returns `null` when the TC has never been executed on its own. Optional. */
  getLatestTestcaseRun?(tcId: string): Promise<string | null>;
  /** Top-N recent standalone executions for a SUITE or TC, newest first. Same standalone-only scope
   *  as `getLatestSuiteRun` / `getLatestTestcaseRun` (suite-child TC rows are excluded when
   *  `type='TC'`). For SUITE rows the returned summary includes a per-test-case tally derived from
   *  the exec doc's executionItems[], so no follow-up call is needed to render a suite scoreboard.
   *  Optional. */
  listRecentRuns?(type: 'SUITE' | 'TC', id: string, limit: number): Promise<RunSummary[]>;

  getSuiteChildRun?(suiteRunId: string, child: { testcaseId: string; versionId?: string; stepId?: string }): Promise<RunStatus>;
  /** Cloud runner VMs registered to the project, with online status. Optional: only products with a
   *  cloud-execution fabric implement it; absence = "this provider has no cloud runners". */
  listCloudRunners?(): Promise<CloudRunner[]>;
  /** LOCAL agents registered to the project, with online status. Optional: only products with a local
   *  agent fabric implement it; absence = "this provider has no local agents to pick". */
  listLocalAgents?(): Promise<LocalAgent[]>;
  /** Mobile devices registered to the project (adb-visible reals, emulators, simulators). Backed by
   *  the SQA `/tm/mobileDevices/search` roster; `active` on each row is the last-known connection
   *  flag (stale by design). Optional — providers without a mobile fabric omit it. */
  listMobileDevices?(platform: 'ANDROID' | 'IOS'): Promise<MobileDevice[]>;
  /** True when THIS machine's LOCAL desktop agent /mcp is reachable (short timeout). Any HTTP
   *  response proves the process is up; connect/timeout errors mean it is down. There is exactly one
   *  desktop agent per machine (listening on the agent /mcp port, default 4040), so this replaces
   *  a customer-roster round trip for LOCAL-execution feasibility checks. Optional — providers with
   *  no desktop agent (walnut direct-REST) omit it. */
  probeLocalAgent?(): Promise<boolean>;

  /** Passthrough for AGENT-BOUND tools (recording/browser) the Common MCP proxies rather than wraps.
   *  Only the remote-MCP forwarder implements these; `unknown` is a CallToolResult (kept SDK-free
   *  here). */
  callRaw?(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** The product MCP's advertised tools (name + description + inputSchema), for building those proxies
   *  with the real per-tool parameter schema mirrored to the client. */
  listAgentTools?(): Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>>;

  // ---- self-healing -----------------------------------------------------------------------
  /** Read-only propose: replay the failed run, capture DOM evidence, return `heal_propose` (v1). */
  proposeHeal?(input: HealProposeInput): Promise<unknown>;
  /** Live facts the pure planner validates against (steps, objects, action catalog, failing itr). */
  getHealFacts?(tcId: string, opts?: { runId?: string | undefined }): Promise<HealFacts>;
  /** Apply a validated plan as ONE new test-case version (+ failing-iteration test data). */
  applyHealPlan?(plan: HealPlan, opts?: { mode?: HealApplyMode | undefined }): Promise<HealReport>;

  listEnvironments(): Promise<EnvInfo[]>;
  /** Walnut-first. */
  listDatasets?(tcId?: string): Promise<DatasetInfo[]>;

  /** Fetch the default (template) iteration row for a testcase — the seed used by
   *  `tc_generate_testdata` to learn the paramId map and infer types. Forwards to the product MCP's
   *  `get_default_iteration` provider-op. Absent on providers without a testdata store. */
  getDefaultIteration?(q: {
    tcId: string;
    versionId?: string;
    environmentType?: string;
    /** 'FN' reads a reusable FUNCTION's testdata (`tcId` then carries the function id). Default 'TC'. */
    entityType?: 'TC' | 'FN' | undefined;
    /** Internal (server-side) use only: return PROTECTED parameter values unmasked so a caller can
     *  COPY them to another test case. Never exposed to the model — `tc_get_testdata` leaves it off. */
    includeProtected?: boolean;
  }): Promise<DefaultIteration>;
  /** Persist N generated iteration rows for a testcase in one call. Forwards to the product MCP's
   *  `save_generated_iterations` provider-op (backed by `/tm/testdata/saveItrForDataGen`). */
  saveGeneratedIterations?(payload: SaveGeneratedIterations): Promise<SaveGeneratedIterationsResult>;
  /** Copy a test case's default-iteration seed values into ANOTHER test case, matching parameters
   *  BY NAME (the two TCs have different param ids). Used by tc_automate: a manual TC converted to
   *  automated must keep the manual testdata, not whatever values the recording happened to type.
   *  Protected values are read unmasked internally so they can be copied; they are never returned
   *  to the model. */
  copyTestdata?(q: { fromTcId: string; toTcId: string; environmentType?: string }): Promise<CopyTestdataResult>;

  /** Patch individual cells of a test case's DEFAULT testdata iteration by PARAMETER NAME — value
   *  and/or formula expression. Used after a journal-fallback save so a recording's formulas end up on
   *  the test-data cells as `{ value, formulaValue }` (the shape the executor re-evaluates per run).
   *  Patches the default row only (never appends iterations). Absent on providers without a testdata
   *  store. */
  patchTestdataCells?(input: {
    tcId: string;
    cells: Array<{ paramName: string; value: string; formulaValue?: string | undefined }>;
    versionId?: string | undefined;
    environmentType?: string | undefined;
    /** Replace an existing formula (tc_update_testdata). Default false preserves it. */
    overwriteFormula?: boolean | undefined;
  }): Promise<{ patched: number; skipped: string[] }>;

  /** Read a SUITE's suite-level testdata iterations (a separate store from its member test cases).
   *  `suiteId` is the suite id; `environmentType` is the env key/name. Absent on providers without
   *  suite-level test data (Walnut). */
  getSuiteTestdata?(q: { suiteId: string; environmentType?: string }): Promise<TestdataRows>;

  /** Copy one row of a SUITE's suite-level testdata into a NEW iteration row (for example ITR-1 →
   *  ITR-2) and save it at the SUITE level only. Member test cases' own testdata is never touched.
   *  `from` is an iteration name (`ITR-1`) or id; default = the suite's default/first row. Returns
   *  the row written plus the suite's rows read back after the save. */
  copySuiteTestdataIteration?(q: {
    suiteId: string;
    environmentType: string;
    from?: string | undefined;
    name?: string | undefined;
  }): Promise<{ iterationId: string; name: string; rows: TestdataRows }>;

  /** Delete testdata iteration rows at TC / FUNCTION / SUITE level (by name or id). Refuses the
   *  default row. Returns the ids deleted plus the rows read back after the delete. */
  deleteTestdataIterations?(q: {
    entityType: 'TC' | 'FN' | 'SU';
    id: string;
    environmentType: string;
    iterations: string[];
  }): Promise<{ deleted: string[]; rows: TestdataRows }>;

  /** List formulas the current project can use for testdata generation — DEFAULT prefabs (customer-
   *  wide) plus CUSTOM formulas (customer- or project-scoped). Powers `tc_list_formulas` and the
   *  per-column formula options that `tc_generate_testdata` accepts. Absent on providers with no
   *  formulas store. */
  listFormulas?(): Promise<Formula[]>;

  /** Evaluate one formula call (SimplifyQA: through the agent's formula engine, like the UI). Returns the
   *  generated `value` string plus a canonical `expression` (`=NAME("a","b")`) suitable for stamping onto a
   *  testdata row cell's `formulaValue` — matching the format the UI persists. `ctx.technologyType` is the
   *  technology of the test case / function the data is for (custom formulas need it). */
  evaluateFormula?(call: FormulaCall, ctx?: { technologyType?: string }): Promise<{ value: string; expression: string }>;
  getObject?(id: string, opts?: { enrichNames?: boolean }): Promise<QaObject>;

  /** Deep link into product UI. */
  productUrlFor(entity: EntityRef): string;
}
