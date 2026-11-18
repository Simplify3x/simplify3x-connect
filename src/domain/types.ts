// NOTE ON `| undefined`: the agent's tsconfig.json enables `exactOptionalPropertyTypes`
// (upstream common-qa-mcp's does not). Every optional field below is written
// `field?: T | undefined` rather than plain `field?: T` specifically so the pervasive
// upstream idiom `field: value ?? undefined` (mapper.ts, adapter.ts, ...) -- meaning
// "omit if absent" -- keeps type-checking: under exactOptionalPropertyTypes, `field?: T`
// (no `| undefined`) forbids a literal `undefined` value even though the key is optional,
// so widening the union is the standard fix rather than rewriting every construction site
// with conditional spreads.
export type Locator = { name: string; value: string; unique?: boolean | undefined };
export type Condition = {
  type: string;
  selector?: string | undefined;
  objectId?: string | undefined;
  text?: string | undefined;
  variableName?: string | undefined;
  variableValue?: string | undefined;
  /** An element check by the object's name instead of its id. */
  objectName?: string | undefined;
  /** AND / OR — how this check joins the next one when a step carries several. */
  logical?: string | undefined;
};
export type Step = {
  n: number; description: string; actionType: string;
  /** Backend technology of THIS step (WEB / API / DATABASE / ANDROID / IOS / MAINFRAME / …).
   *  Raw value when the backend supplies it, derived from `stepType` otherwise. Action names are
   *  NOT unique across technologies, so every action lookup/validation is scoped by this. */
  technologyType?: string | undefined;
  /** Opaque provider step id (Walnut step `_id`), carried READ→WRITE so an edit's PUT matches kept
   *  steps by identity (update in place) and correctly deletes the ones dropped — not fragile
   *  slot-by-number matching. Absent on freshly-inserted steps (the backend then creates them). */
  sourceId?: string | undefined;
  stepType: 'manual' | 'web' | 'api' | 'control_flow' | 'function' | 'function_end' | 'database' | 'android' | 'ios' | 'mainframe' | 'desktop' | 'sap' | 'switch' | 'compare';
  /** `missing: true` means `id` was looked up and did NOT resolve to a real object (deleted, or
   *  never existed) — distinct from `name` merely being unset. Callers must render this as a broken
   *  reference, not silently fall back to showing the bare id as if nothing were wrong. */
  objectRef?: { id?: string | undefined; name?: string | undefined; locators?: Locator[] | undefined; missing?: boolean | undefined;
    /** Recorder-captured element / page screenshots (base64 PNG, optional `data:` prefix). Only used when a new object is created. */
    thumbnail_url?: string | undefined; pageScreenShot_url?: string | undefined;
    /** Read side: absolute loadable image URLs of the stored object (SimplifyQA). */
    thumbnailUrl?: string | undefined; pageScreenshotUrl?: string | undefined } | undefined;
  value?: string | undefined; expectedResult?: string | undefined;
  /** Control-flow marker. `kind` mirrors SQA's raw `stepType` for control rows (IF/ELSE/ELSE_IF/IF_END,
   *  WHILE_START/WHILE/WHILE_END, DO/DO_WHILE, FOR_START/FOR_END, LOOP, ITERATOR_START/END,
   *  LOOP_ITERATION_START/END, SWITCH_TO_*). Kept as a wide string so a future backend adds don't need
   *  a schema change here — the markdown renderer defaults unknown kinds to their raw uppercase name. */
  controlFlow?: {
    kind: string;
    condition?: Condition | undefined;
    /** Several checks (joined by each one's `logical`); `condition` is the one-check shorthand. */
    conditions?: Condition[] | undefined;
    /** Raw ifstring from SQA's `conditions.ifstring` — the human-readable expression as shown in the UI. */
    conditionText?: string | undefined;
    blockId?: string | undefined;
    maxIterations?: number | undefined;
  } | undefined;
  api?: Record<string, unknown> | undefined; db?: Record<string, unknown> | undefined;
  /** NESTED test-case call (stepType 'function'): the child TC this step executes. Carried through
   *  the mapper so a nested step ROUND-TRIPS (read→edit→save) without losing its child binding —
   *  without this, editing any TC containing a nested step silently drops the reference on save. */
  functionCall?: {
    testCaseId: string;
    testCaseName?: string | undefined;
    /** SQA function code (e.g. FN_12). Populated by the adapter's FN-name lookup so the
     *  markdown renderer can show a human ref instead of a bare numeric id. */
    testCaseCode?: string | undefined;
    /** SQA `fnVersionId` — the specific version of the referenced function pinned by this call. */
    versionId?: string | undefined;
    versionName?: string | undefined;
    /** SQA `sharedFnProjectId` — non-null when the FN lives in a different project (shared functions). */
    sharedProjectId?: string | undefined;
    inputParams?: Record<string, unknown> | undefined;
    continueOnFailure?: boolean | undefined;
  } | undefined;
  flags?: {
    skip?: boolean | undefined;
    screenshot?: boolean | undefined;
    continueOnFailure?: boolean | undefined;
    optional?: boolean | undefined;
  } | undefined;
  /** WEB automation: browser to target for this step. Defaults to CHROME when absent. */
  browserType?: string | undefined;
  /** SQA automation: recorded values for this step, keyed by ACTION PARAMETER NAME (not id).
   *  Example: for a launch action, `{ packageName: 'us.zoom.videomeetings', activity: '...' }`.
   *  The mapper resolves each name → paramId via get-or-create, then emits SQA's
   *  `parameterIds: [<id>...]` + `recordedParam: { <id>: value }` on the step. Populates the
   *  default iteration on save. Manual TCs ignore this field. */
  /** LLM-facing recordedParam patches. NAME-keyed (`{"url": "https://x"}`) — mapper resolves to
   *  numeric paramId at save time. An ALL-DIGIT key (`{"7001": "sub_ln"}`) is an already-bound
   *  parameter ID and is used as-is (this is what a step read from the backend and re-added carries).
   *  Overrides matching keys in `sourceRecordedParam`. */
  recordedParam?: Record<string, string> | undefined;
  /** Formula-driven parameters recorded alongside their concrete values: `{ "<paramName>": "=FIRST_NAME()" }`.
   *  A recording stores the entered value AND this expression so the test-data cell can be saved as
   *  `{ value, formulaValue }` — the exact shape the executor re-evaluates per run. Absent for ordinary
   *  (non-formula) parameters. Used by the journal-fallback save; the recorder-window save gets the same
   *  information from the live step payload. */
  recordedParamFormula?: Record<string, string> | undefined;
  /** Provider plugin id of the action (the SQA `@Sync` uniqueId, e.g. "db-2"). Action NAMES are not unique
   *  in the backend catalog (executeQuery = db-2 AND db-3), so the save resolver prefers this over
   *  `actionType` when the backend exposes it. Set by the recorder journal; absent on hydrated steps. */
  actionUniqueId?: string | undefined;
  /** Names (keys of `recordedParam`) whose access type is Runtime — the store target of an action's
   *  Runtime Parameter slot. The save path creates these as `Runtime` parameters, not `Local`. */
  runtimeParameters?: string[] | undefined;
  /** EDIT ONLY: replace a parameter this step uses with another, IN THE SAME SLOT (so the action's argument order is
   *  unchanged). `from` / `to` are parameter names (or ids); `value` is the new parameter's test-data value for this step.
   *  Applied at save; idempotent (a step that already uses `to` and no longer `from` is left alone). */
  swapParams?: Array<{ from: string; to: string; value?: string | undefined }> | undefined;
  /** Backend-side parameterIds preserved from a round-tripped step. Adapters that populate this
   *  (SQA's fromSqaStep) let the save mapper emit the same FK linkages the backend had — without
   *  this, every save wipes parameterIds to only what description ${tokens} produce, silently
   *  dropping params linked via non-token mechanisms. */
  sourceParameterIds?: number[] | undefined;
  sourceObjectParameterIds?: number[] | undefined;
  /** The object (id / display name) this step had when it was LOADED. Lets a save tell "the prompt changed the object"
   *  from "nothing changed", so an object swap re-derives the object's parameter ids and by-name swaps are honoured. */
  sourceObjectId?: string | undefined;
  sourceObjectName?: string | undefined;
  /** Backend-side recordedParam preserved as-is (ID-keyed: `{"841": "https://staging.acme.com"}`).
   *  Save mapper seeds recordedParamOut with this so a re-save that doesn't touch values keeps
   *  them intact. LLM patches via `recordedParam` (name-keyed) override matching entries. */
  sourceRecordedParam?: Record<string, string> | undefined;
  /** Backend-side raw step fields preserved for round-trip: `stepType`, `conditions`, `loop`,
   *  `isConditional`, `if`, `else`, `functionId`, `fnVersionId`, `apiData`, `switchToAndroidData`,
   *  etc. Save mapper spreads this as the base object so control-flow / function / switch / api
   *  step structure survives a save. Restricted to the backend's joi allow-list to avoid junk. */
  sourceRaw?: Record<string, unknown> | undefined;
  /** DESKTOP only (plan.md P9.4): an IF's or ELSE_IF's conditions as the Java recorder journaled them (its
   *  `ConditionSpec`s), from `read_journal`. The save turns them into `conditions.children` rows, as the recorder
   *  window's own Save writes them. No other technology sets it. */
  desktopConditions?: DesktopConditionSpec[] | undefined;
};
/** One journaled DESKTOP condition: an element check, or a comparison of two values (each a runtime value, named by
 *  `left` / `right` with its `*ParamUid`, or a literal without one). */
export type DesktopConditionSpec = {
  type?: string | undefined;                      // 'OBJECT' | 'VALUE'
  logical?: string | undefined;                   // 'AND' | 'OR', the connector to the next condition
  check?: string | undefined;
  conditionActionUniqueId?: string | undefined;   // OBJECT: the check's plugin id, e.g. dsk-24
  conditionObject?: { name?: string | null | undefined; attributes?: Array<{ name: string; value: string; unique?: boolean | undefined }> | undefined } | undefined;
  left?: string | undefined;
  leftParamUid?: string | undefined;
  operator?: string | undefined;                  // eq | ne | lt | gt | lte | gte
  right?: string | undefined;
  rightParamUid?: string | undefined;
};
export type TestCase = { id?: string | undefined; title: string; description?: string | undefined; objective?: string | undefined;
  /** Provider-specific. Walnut stores it; SimplifyQA testcase rows have no priority column, so it is absent there. */
  priority?: 'critical' | 'high' | 'medium' | 'low' | undefined; status?: string | undefined; category: 'automated' | 'manual' | 'playwright';
  /** SQA: kept for history but hidden from normal lists/execution. Set by a story sync when the
   *  scenario a TC tested was removed. Reversible (`obsolete:false`); distinct from `tc_delete`. */
  obsolete?: boolean | undefined;
  preconditions?: string | undefined; expectedOutcome?: string | undefined; folderOrModule?: string | undefined; storyRef?: string | undefined;
  tags?: string[] | undefined; steps: Step[]; version?: number | undefined;
  /** Optimistic-lock counter on the tcfn document itself (separate from the version row's).
   *  Round-tripped so save payloads pass the same value the UI does — backend's concurrency check
   *  compares to the DB value and rejects if stale. */
  updateVersion?: number | undefined;
  /** SQA `tcType` — the automation stack this TC targets: 'WEB' | 'ANDROID' | 'IOS' | 'API' | 'MAINFRAME'
   *  | 'SAP' | 'DESKTOP' | 'DATABASE'. Drives the platform-specific inputs `tc_run` collects
   *  (browser for WEB; deviceType + deviceId for ANDROID/IOS). Undefined on providers without a
   *  tcType concept. */
  technologyType?: string | undefined;
  /** EDIT ONLY: raw test-case-level fields the backend keeps that the neutral model has no field for (tags, custom fields,
   *  mailers, linked issues, defects, suites). Carried through a read→edit→save untouched so a re-save never resets them. */
  sourceTc?: Record<string, unknown> | undefined;
  /** All non-deleted versions of this TC — populated by adapters that support versioning (SQA).
   *  `id` is the version's opaque id (SQA `tcfn_version.id`, a uuid); `name` is the human label
   *  ("v1.0"). Walnut/manual-only adapters leave this undefined. */
  versions?: TcVersion[] | undefined;
  /** The version whose steps are surfaced on `steps[]`. Adapters resolve this: caller-provided
   *  `versionId` argument > TC's currently-selected version > first entry in `versions[]`. */
  currentVersionId?: string | undefined;
  /** Default-row test data: param name -> value. Forwarded to the product on save to populate the
   *  datarow of the dataset it auto-creates from the `${param}` tokens in step descriptions, so the
   *  saved test case is executable with data. Optional -- the product also derives it from each
   *  step's single `${param}` + its value. */
  data?: Record<string, string> | undefined;
  /** SQA automation: execution target (device / browser) for the test case.
   *  - WEB: OPTIONAL — omit to let the SQA backend default to Chrome.
   *  - ANDROID / IOS: REQUIRED — the mapper refuses the save without one.
   *  Wire shape mirrors the SQA `executionPlatform` field on the tcfnObj:
   *  `{ id: <deviceSerial|'CHROME'>, name, technologyType: 'ANDROID'|'IOS'|'WEB', type:
   *    'REAL_DEVICE'|'CLOUD_DEVICE'|'NONE', cloudDeviceType? }`. */
  executionPlatform?: {
    id: string; name: string; technologyType: string; type: string;
    cloudDeviceType?: string | undefined;
  } | undefined };
/** One entry in `TestCase.versions[]`. Fields mirror what SQA's `/tm/testcase/getById` projects onto
 *  `versions[]` (tcfn.service.js:1489). `updateVersion` is the optimistic-lock counter, useful when
 *  the caller wants to display which version is newest. */
export type TcVersion = {
  id: string;
  name: string;
  updateVersion?: number | undefined;
  reviewApproveStatus?: string | undefined;
  executionType?: string | undefined;
  /** True when this is the TC's currently-selected version (the one the UI opens by default). */
  isCurrent?: boolean | undefined;
};

export type TcSummary = { id: string; code?: string; title: string;
  /** Provider-specific. Absent on SimplifyQA (testcase rows have no priority/status columns). */
  priority?: string; status?: string; stepCount?: number; technologyType?: string; executionType?: string; obsolete?: boolean };
export type ProjectSummary = { id: string; code?: string; name: string; counts?: Record<string, number> | undefined };
/** One raw backend column filter (searchFields protocol) — see `zRawFilter` in tools/schemas.ts. */
export type RawSearchFilter = { column: string; value: string | number | boolean | string[] | number[]; regEx?: boolean | undefined };
export type TcQuery = { search?: string; status?: string; limit?: number; offset?: number;
  /** Filter by numeric userId of the creator. Pass "me" and the adapter substitutes cfg.userId. */
  createdBy?: string;
  /** Filter by numeric userId of the last updater. Pass "me" and the adapter substitutes cfg.userId. */
  updatedBy?: string;
  storyId?: string;
  /** Filter to test cases filed under this module (id or business key). SimplifyQA only; ignored on providers without a module tree. */
  moduleId?: string;
  /** True → only obsolete TCs; false → only non-obsolete. Omit to include both. SimplifyQA only. */
  obsolete?: boolean;
  filters?: RawSearchFilter[] };
/** A USER STORY (Walnut `user_stories` doc, type 'story'). `key` = the human business key (walnut_key
 *  like US_001, or an external Jira/ADO key). `id` = the Mongo _id (what test cases link to via story_id). */
export type StorySummary = { id: string; key?: string | undefined; title: string; status?: string | undefined; priority?: string | undefined };
export type Story = { id: string; key?: string | undefined; title: string; description?: string | undefined;
  acceptanceCriteria?: string[] | undefined; status?: string | undefined; priority?: string | undefined;
  /** Sprint FK — SimplifyQA server-side column is `iterationId`, exposed here under the neutral name.
   *  Populated by the SQA mapper when the story doc carries it; undefined on providers with no sprint model. */
  sprintId?: string | undefined;
  /** Release FK. Undefined on providers with no release model (Walnut). */
  releaseId?: string | undefined;
  /** Parent epic id (SQA `epicId`). Undefined when the story is orphan or the provider has no epics. */
  epicId?: string | undefined;
  /** Parent feature id (SQA `featureId`). Used by impact_analysis to guess sibling-story dependencies
   *  (stories sharing a feature are likely coupled). */
  featureId?: string | undefined };
export type StoryQuery = { search?: string; status?: string; limit?: number; offset?: number;
  /** Filter stories that belong to this sprint. Neutral name; SimplifyQA maps it to `userstory.iterationId` server-side. */
  sprintId?: string;
  /** Filter stories that belong to this release (SimplifyQA `userstory.releaseId`). */
  releaseId?: string;
  /** Filter by numeric userId of the creator. Pass "me" and the adapter substitutes cfg.userId. */
  createdBy?: string;
  /** Filter by numeric userId of the last updater. Pass "me" and the adapter substitutes cfg.userId. */
  updatedBy?: string;
  /** Filter by numeric userId of the story owner (`userstory.ownerId`). Pass "me" and the adapter
   *  substitutes cfg.userId. Testcases have no owner field — this is story-only. */
  ownerId?: string;
  filters?: RawSearchFilter[] };
export type DefectSummary = { id: string; code?: string | undefined; title: string;
  state?: string | undefined; severity?: string | undefined; priority?: string | undefined;
  assignedTo?: string[] | undefined; tcIds?: string[] | undefined };
export type DefectQuery = { search?: string; limit?: number; offset?: number;
  tcId?: string;
  storyId?: string;
  /** Exact workflow-state key (e.g. "new"), not the capitalized UI label. */
  state?: string;
  /** Numeric userId of the assignee (array field on the defect). Pass "me" for the caller. */
  assignedTo?: string;
  createdBy?: string;
  filters?: RawSearchFilter[] };

/** A TASK (SimplifyQA `pm.task`) — project-management work item, distinct from a test case or defect. */
export type TaskSummary = { id: string; code?: string | undefined; title: string;
  state?: string | undefined; priority?: string | undefined;
  assignedTo?: string[] | undefined;
  /** Linked defect id, when raised against one. */
  defectId?: string | undefined };
export type TaskQuery = { search?: string; limit?: number; offset?: number;
  /** Filter to tasks linked to this user story (`userstoryId`). */
  storyId?: string;
  state?: string;
  assignedTo?: string;
  createdBy?: string;
  filters?: RawSearchFilter[] };
/** Fields accepted when CREATING a user story (`POST /pm/userstory`). Neutral shape — the SQA adapter
 *  maps `moduleId`/`iterationId`/etc to the SQA payload as-is. `projectId` is filled from the connected
 *  project when omitted; `state` and `estimatedEffort` are backend-required. */
export type MailersList = {
  users?: number[] | undefined;
  nonUsers?: number[] | undefined;
  groups?: number[] | undefined;
};
export type StoryInput = {
  name: string;
  /** Watch List (the UI's email button): user ids that receive email notifications. */
  mailersList?: MailersList | undefined;
  state?: string | undefined;
  estimatedEffort: number;
  projectId?: number | undefined;
  epicId?: number | undefined;
  featureId?: number | undefined;
  moduleId?: number | undefined;
  releaseId?: number | undefined;
  /** SQA `iterationId` — the sprint. */
  iterationId?: number | undefined;
  acceptanceCriteria?: string | undefined;
  description?: string | undefined;
  priority?: string | undefined;
  /** SQA accepts an array of userIds. */
  ownerId?: number[] | undefined;
  tags?: number[] | undefined;
  teamId?: number[] | undefined;
  type?: string | undefined;
  plannedStartDate?: string | undefined;
  plannedEndDate?: string | undefined;
  customFields?: Record<string, unknown> | undefined;
};
/** Partial update body for `PUT /pm/userstory/:id`. `updateVersion` is optimistic-concurrency: the
 *  server bumps it on every write and rejects stale writes. Pass it back from the last `getStory`. */
export type StoryUpdate = {
  name?: string | undefined;
  mailersList?: MailersList | undefined;
  linkedIssues?: Array<Record<string, unknown>> | undefined;
  state?: string | undefined;
  estimatedEffort?: number | undefined;
  projectId?: number | undefined;
  epicId?: number | undefined;
  featureId?: number | undefined;
  moduleId?: number | undefined;
  releaseId?: number | undefined;
  iterationId?: number | undefined;
  acceptanceCriteria?: string | undefined;
  description?: string | undefined;
  priority?: string | undefined;
  ownerId?: number[] | undefined;
  tags?: number[] | undefined;
  teamId?: number[] | undefined;
  type?: string | undefined;
  plannedStartDate?: string | undefined;
  plannedEndDate?: string | undefined;
  customFields?: Record<string, unknown> | undefined;
  updateVersion?: number | undefined;
};

/** An EPIC (SimplifyQA `pm.epic`). Top of the backlog hierarchy: epic → feature → story. `key` is the
 *  human business key (EP_XXX); `id` is the numeric doc id. */
export type EpicSummary = { id: string; key?: string | undefined; name: string;
  state?: string | undefined };
export type Epic = EpicSummary & { description?: string | undefined;
  estimatedEffort?: number | undefined; ownerId?: number | undefined;
  plannedStartDate?: string | undefined; plannedEndDate?: string | undefined };
export type EpicQuery = { search?: string; state?: string; limit?: number; offset?: number;
  /** Numeric userId of the creator. Pass "me" and the adapter substitutes cfg.userId. */
  createdBy?: string;
  /** Numeric userId of the last updater. Pass "me" and the adapter substitutes cfg.userId. */
  updatedBy?: string;
  /** Numeric userId of the epic owner. Pass "me" and the adapter substitutes cfg.userId. */
  ownerId?: string };
/** Fields accepted when CREATING an epic (`POST /pm/epic`). `projectIds` is filled to `[currentProject]`
 *  when omitted; all six required fields (name/state/estimatedEffort/plannedStartDate/plannedEndDate/projectIds)
 *  must be present before hitting the backend. */
export type EpicInput = {
  mailersList?: MailersList | undefined;
  name: string;
  state?: string | undefined;
  estimatedEffort: number;
  plannedStartDate: string;
  plannedEndDate: string;
  projectIds?: number[] | undefined;
  ownerId?: number | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
  teamId?: number[] | undefined;
  actualStartDate?: string | undefined;
  actualEndDate?: string | undefined;
  actualEffort?: number | undefined;
  remainingEffort?: number | undefined;
  plannedBudget?: number | undefined;
  customFields?: Record<string, unknown> | undefined;
};
export type EpicUpdate = {
  mailersList?: MailersList | undefined;
  linkedIssues?: Array<Record<string, unknown>> | undefined;
  name?: string | undefined;
  state?: string | undefined;
  estimatedEffort?: number | undefined;
  plannedStartDate?: string | undefined;
  plannedEndDate?: string | undefined;
  projectIds?: number[] | undefined;
  ownerId?: number | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
  teamId?: number[] | undefined;
  actualStartDate?: string | undefined;
  actualEndDate?: string | undefined;
  actualEffort?: number | undefined;
  remainingEffort?: number | undefined;
  plannedBudget?: number | undefined;
  customFields?: Record<string, unknown> | undefined;
  updateVersion?: number | undefined;
};

/** A FEATURE (SimplifyQA `pm.feature`). Middle of the backlog hierarchy: epic → feature → story.
 *  `key` = business key (FT_XXX). `epicId` links to the parent epic. */
export type FeatureSummary = { id: string; key?: string | undefined; name: string;
  state?: string | undefined; priority?: string | undefined; epicId?: string | undefined };
export type Feature = FeatureSummary & { description?: string | undefined;
  estimatedEffort?: number | undefined; ownerId?: number | undefined;
  plannedStartDate?: string | undefined; plannedEndDate?: string | undefined };
export type FeatureQuery = { search?: string; state?: string; limit?: number; offset?: number;
  /** Filter features under a specific parent epic id. */
  epicId?: string;
  /** Numeric userId of the creator. Pass "me" and the adapter substitutes cfg.userId. */
  createdBy?: string;
  /** Numeric userId of the last updater. Pass "me" and the adapter substitutes cfg.userId. */
  updatedBy?: string;
  /** Numeric userId of the feature owner. Pass "me" and the adapter substitutes cfg.userId. */
  ownerId?: string };
/** Fields accepted when CREATING a feature (`POST /pm/feature`). Same rules as EpicInput plus optional
 *  `epicId` (parent). `state` is optional on the backend for features (unlike epic/story). */
export type FeatureInput = {
  mailersList?: MailersList | undefined;
  name: string;
  estimatedEffort: number;
  plannedStartDate: string;
  plannedEndDate: string;
  projectIds?: number[] | undefined;
  epicId?: number | undefined;
  state?: string | undefined;
  priority?: string | undefined;
  ownerId?: number | undefined;
  description?: string | undefined;
  tags?: number[] | undefined;
  teamId?: number[] | undefined;
  actualStartDate?: string | undefined;
  actualEndDate?: string | undefined;
  actualEffort?: number | undefined;
  remainingEffort?: number | undefined;
  customFields?: Record<string, unknown> | undefined;
};
export type FeatureUpdate = {
  mailersList?: MailersList | undefined;
  linkedIssues?: Array<Record<string, unknown>> | undefined;
  name?: string | undefined;
  estimatedEffort?: number | undefined;
  plannedStartDate?: string | undefined;
  plannedEndDate?: string | undefined;
  projectIds?: number[] | undefined;
  epicId?: number | undefined;
  state?: string | undefined;
  priority?: string | undefined;
  ownerId?: number | undefined;
  description?: string | undefined;
  tags?: number[] | undefined;
  teamId?: number[] | undefined;
  actualStartDate?: string | undefined;
  actualEndDate?: string | undefined;
  actualEffort?: number | undefined;
  remainingEffort?: number | undefined;
  customFields?: Record<string, unknown> | undefined;
  updateVersion?: number | undefined;
};

/** A RELEASE (SimplifyQA `pm.release`). `state` is the release state ("planned", "in-progress", ...). */
export type ReleaseSummary = { id: string; name: string; state?: string | undefined;
  plannedStartDate?: string | undefined; plannedEndDate?: string | undefined };
export type ReleaseQuery = { scope: 'project' | 'all' };
/** A SPRINT (SimplifyQA `pm.sprint`). `releaseId` links to the parent Release. */
export type SprintSummary = { id: string; name: string; releaseId?: string | undefined;
  state?: string | undefined; plannedStartDate?: string | undefined; plannedEndDate?: string | undefined };
export type SprintQuery = { releaseId?: string };
/** A MODULE / folder in the SimplifyQA test-case tree. `parentId` is absent on root nodes.
 *  `isRoot`/`childIds` widen the row so tools can render the tree shape without a `get_module` per row —
 *  the UI's tree walker keys off `parent.childIds`, so surfacing it here lets callers verify hierarchy. */
export type ModuleSummary = {
  id: string;
  name: string;
  parentId?: string | undefined;
  isRoot?: boolean | undefined;
  childIds?: number[] | undefined;
};

/** Full MODULE detail — `list_modules` returns only summary rows; `get_module` returns everything the
 *  server persists (description, human-readable code, immediate children, project). */
export type ModuleDetail = ModuleSummary & {
  code?: string | undefined;
  description?: string | undefined;
  childIds?: number[] | undefined;
  projectId?: string | undefined;
  isRoot?: boolean | undefined;
};

/** Input to `createModule`. `isRoot:true` files under the project root (server strips `parentId`);
 *  otherwise `parentId` must resolve to an existing module in the same project. Optional `children`
 *  turns a single-node create into a subtree walk — the adapter POSTs the root, then depth-first
 *  posts each child with the freshly-returned parent id (no need for the caller to thread ids). */
export type ModuleCreateInput = {
  name: string;
  projectId: string;
  isRoot: boolean;
  parentId?: string | undefined;
  description?: string | undefined;
  children?: ModuleTreeInput[] | undefined;
};

/** A child node in a `createModule` subtree. `isRoot`/`parentId` are derived by position — never
 *  passed by the caller — so a whole hierarchy is described by name+description+children alone. */
export type ModuleTreeInput = {
  name: string;
  description?: string | undefined;
  children?: ModuleTreeInput[] | undefined;
};

/** Enriched result of `createModule`. Extends `SavedRef` with the fields the UI's tree walker relies
 *  on (`isRoot`, `parentId`, `childIds`, `code`) so callers can verify the module landed where
 *  intended, plus `children` when a subtree was created. On partial subtree failure `failedAt` names
 *  the first unfinished node — everything before it did land. */
export type ModuleSaved = SavedRef & {
  name: string;
  code?: string | undefined;
  isRoot: boolean;
  parentId?: string | undefined;
  childIds?: number[] | undefined;
  children?: ModuleSaved[] | undefined;
  failedAt?: { path: string; error: string } | undefined;
  linkWarning?: string | undefined;
};

/** Input to `updateModule` — partial edit of an existing module. `projectId` is required by the
 *  backend for the privilege check; adapter falls back to the connected project when omitted. */
export type ModuleUpdateInput = {
  name?: string | undefined;
  description?: string | undefined;
  projectId?: string | undefined;
  parentId?: string | undefined;
};

/** Report kinds `downloadReports` can produce. `detailed` / `summary` are per test case; `suite` is the
 *  suite-overall PDF (suite runs only). */
export type ReportKind = 'detailed' | 'summary' | 'suite';
export type ReportFile = { kind: ReportKind; label: string; path: string; bytes: number };

/** Backlog item kinds that can be deleted through `deleteBacklogItem`. */
export type BacklogKind = 'epic' | 'feature' | 'story' | 'defect' | 'task';
/** Result of a backlog delete. `dependencies[].counts` maps each blocking relation (e.g. `featureArr`,
 *  `usArr`, `tcArr`, `taskArr`) to the ids that still reference the item; any non-empty one blocks delete. */
export type BacklogDeleteResult = {
  dryRun: boolean;
  deleted: boolean;
  dependencies: Array<{ id: number; counts: Record<string, number[]> }>;
};

/** Per-id dependency footprint the PATCH /pm/module dry-run returns. Non-empty arrays block delete
 *  until the referring rows are moved or removed. */
export type ModuleDependency = {
  id: number;
  tcArr: number[];
  fnArr: number[];
  parameterArr: number[];
  objArr: number[];
  defectArr: number[];
  usArr: number[];
};

/** Result of `deleteModule`. `dryRun:true` → nothing was deleted; `dependencies` names what still
 *  references each id. `dryRun:false` → server actually deleted the ids with empty dependencies and
 *  silently skipped the rest; `dependencies` still surfaces the skipped-with-refs list for the caller
 *  to act on. */
export type ModuleDeleteResult = {
  dryRun: boolean;
  dependencies: ModuleDependency[];
};

/** Input to `deleteVersion`. `kind` toggles the backend `parentType` ('TC'|'FN'); `versionId` is
 *  the tcfn_version uuid (from `TestCase.versions[]` / `QaFunction.versions[]`); `versionName` is
 *  required by the backend validator even though the delete match doesn't strictly need it. */
export type VersionDeleteInput = {
  kind: 'tc' | 'fn';
  parentId: string;
  versionId: string;
  versionName: string;
  confirm?: boolean;
};

/** TC-version dependency row — matches the payload SQA's dry-run returns for `parentType==='TC'`
 *  (tcfnversion.service.js:219). Each `*Arr` maps projectId (as a string key) → array of referring
 *  entity ids in that project. Empty maps mean "no refs of this kind". */
export type TcVersionDep = {
  id: number;
  versionName?: string | undefined;
  defectArr: Record<string, number[]>;
  suiteArr: Record<string, number[]>;
  epArr: Record<string, number[]>;
  scenarioArr: Record<string, number[]>;
  schedulerArr: Record<string, number[]>;
  pipelineArr: Record<string, number[]>;
  workflowArr: Record<string, number[]>;
};

/** FN-version dependency row — matches the payload SQA returns for `parentType==='FN'`
 *  (tcfnversion.service.js:267). Same {projectId → ids} shape, narrower key set. */
export type FnVersionDep = {
  id: number;
  tcArr: Record<string, number[]>;
  fnArr: Record<string, number[]>;
  wfArr: Record<string, number[]>;
};

/** Result of `deleteVersion`. Two-phase mirrors the backend contract (tcfnversion.service.js:30):
 *  - `confirm:false` → `dryRun:true`, `dependencies` non-empty either way (each ref-array in the
 *    dep row may be empty maps — a truly-safe delete is when EVERY *Arr is `{}`).
 *  - `confirm:true` with empty deps → `dryRun:false`, `deleted:true`, `dependencies` empty.
 *  - `confirm:true` with non-empty deps → SERVER REFUSED: `dryRun:false`, `deleted:false`,
 *    `dependencies` populated. Caller must inspect the shape, not assume success from confirm:true. */
export type VersionDeleteResult = {
  dryRun: boolean;
  deleted: boolean;
  dependencies: Array<TcVersionDep | FnVersionDep>;
  /** True when any dependency row still has a non-empty ref map. When `dryRun:true` this means
   *  "delete would be refused"; when `dryRun:false` this means "server refused the delete". */
  hasBlockers: boolean;
};

/** A reusable FUNCTION (SimplifyQA `tcfnObj` with type='FN'). Distinct from a TC: intended to be
 *  called as a nested step from many test cases. `fnType` is the technology (WEB/API/ANDROID/IOS);
 *  `executionType` is MANUAL/AUTOMATION; `status` is the review/approve status. */
export type FunctionSummary = { id: string; code?: string; name: string; description?: string | undefined;
  fnType?: string | undefined; executionType?: string | undefined; stepCount?: number | undefined;
  status?: string | undefined };
export type QaFunction = { id: string; code?: string | undefined; name: string;
  description?: string | undefined; fnType?: string | undefined; executionType?: string | undefined;
  status?: string | undefined; stepCount?: number | undefined; steps: Step[];
  /** Present when the FN has versions (SQA always does). Newest first — same shape as `TestCase.versions`. */
  versions?: TcVersion[] | undefined };
export type FunctionQuery = { search?: string; fnType?: string; executionType?: string;
  /** Filter to functions filed under this module (id or business key). */
  moduleId?: string;
  /** Numeric userId of the creator. Pass "me" and the adapter substitutes cfg.userId. */
  createdBy?: string;
  /** Numeric userId of the last updater. Pass "me" and the adapter substitutes cfg.userId. */
  updatedBy?: string;
  limit?: number; offset?: number };
/** A USER row from `/pm/user/search` — the identity behind `createdBy` / `updatedBy` on stories &
 *  testcases. Use `list_users` to resolve a name → id, then pass that id to `tc_list({createdBy})`. */
export type UserSummary = { id: string; name?: string; email?: string; username?: string; status?: string };
export type UserQuery = { search?: string; limit?: number; offset?: number;
  /** Restrict to users assigned to this project (via projectuserrole). Non-admin callers are
   *  already scoped server-side to their accessible projects. */
  projectId?: string };

export type QaObject = {
  id?: string; name: string; pageName?: string; objectType?: string; locators: Locator[];
  /** Object template (the backend's `objecttemplateId`) — actions are registered per template, so
   *  this is the precise scope for an action heal (more specific than the technology label). */
  objectTemplateId?: string | undefined;
  description?: string | undefined;
  moduleId?: string | undefined;
  parameterIds?: string[] | undefined;
  moduleName?: string | undefined;
  parameterNames?: string[] | undefined;
  /** Absolute, directly loadable image URLs (SimplifyQA only; present when the object has them). */
  thumbnailUrl?: string | undefined;
  pageScreenshotUrl?: string | undefined;
};
export type ObjectQuery = { query?: string; pageName?: string; limit?: number; offset?: number };
export type Suite = { id?: string; name: string; description?: string; members: { tcId: string; order: number }[];
  /** SimplifyQA Execution Type (LOCAL / REMOTE / CLOUD / STACK) — the suite's own menu value. */
  executionType?: string | undefined };
/** `suiteType` is SimplifyQA-only ("MANUAL" | "AUTOMATION"); absent on Walnut. */
export type SuiteSummary = { id: string; name: string; memberCount?: number; suiteType?: string | undefined;
  /** SimplifyQA Execution Type (LOCAL / REMOTE / CLOUD / STACK). */
  executionType?: string | undefined };
export type MemberOp = { op: 'add' | 'remove' | 'reorder'; tcId: string; order?: number };
export type RunTarget = { tcId?: string; suiteId?: string; planId?: string };
/** A single device entry for multi-device parallel execution. Each entry becomes one executionItem
 *  inside a SINGLE execution (one execution ID, multiple parallel runs). */
export type DeviceSpec = {
  deviceId: string;
  deviceName?: string;
  deviceType?: 'REAL_DEVICE' | 'EMULATOR' | 'SIMULATOR' | 'CLOUD_DEVICE' | 'CLOUD_EMULATOR' | 'CLOUD_SIMULATOR';
  cloudDeviceType?: 'LAMBDA_TEST' | 'BROWSER_STACK' | 'SAUCE_LABS' | 'SIMPLIFY_QA_DEVICE_FORM';
  osVersion?: string;
};

export type RunOptions = { environment?: string; browser?: string; headless?: boolean;
  /** Where to run: 'local' = THIS machine's desktop agent; 'remote' = ANOTHER registered agent
   *  machine (a teammate's box, from remote_agents); 'cloud' = a cloud runner VM. The client MUST
   *  decide this (asking the user when unstated) — there is no safe default. 'stack' (suites only) runs
   *  the suite's saved stack setup. */
  mode?: 'local' | 'remote' | 'cloud' | 'stack';
  /** For mode:'local' — a specific local agent credential_id (from local_agents; must be THIS
   *  machine's row). Omit to auto-pick this machine's agent. For mode:'remote' — REQUIRED, a
   *  credential_id from remote_agents (a teammate's row; auto-pick is not safe across boxes). */
  agentId?: string;

  /** For mode:'cloud' — the specific online cloud runner to dispatch to (resolved from listCloudRunners). */
  cloudRunnerId?: string;
  /** For mode:'cloud' — the runner's machine type (VM / AZURE / KUBERNETES), read off the chosen
   *  cloud runner. Stamped as the execution's `cloudType`; defaults to VM when unknown. */
  cloudType?: string;
  /** REQUIRED for ANDROID/IOS test cases — the target device id (adb serial / emulator name for
   *  LOCAL; cloud device name for CLOUD). Enumerate with `mobile_list_devices`. Ignored for
   *  non-mobile tcTypes (WEB / API / MAINFRAME / etc.). */
  deviceId?: string;
  /** REQUIRED for ANDROID/IOS test cases — the KIND of device the picked `deviceId` is.
   *  Drives the `type` field on the wire execution platform (REAL_DEVICE / EMULATOR / SIMULATOR
   *  for LOCAL; CLOUD_* for a farm). */
  deviceType?: 'REAL_DEVICE' | 'EMULATOR' | 'SIMULATOR' | 'CLOUD_DEVICE' | 'CLOUD_EMULATOR' | 'CLOUD_SIMULATOR';
  /** REQUIRED when `deviceType` is CLOUD_* — which cloud farm the device came from. Values mirror
   *  the SQA wire schema (note SIMPLIFY_QA_DEVICE_FORM's legacy "FORM" spelling). Read off the
   *  `cloudDeviceType` field on the matching row from `mobile_list_devices`. */
  cloudDeviceType?: 'LAMBDA_TEST' | 'BROWSER_STACK' | 'SAUCE_LABS' | 'SIMPLIFY_QA_DEVICE_FORM';
  /** Optional OS version to stamp on the wire platform object for ANDROID/IOS runs. Read off the
   *  matching row in `mobile_list_devices`; passed through untouched. */
  osVersion?: string;
  /** Human-readable device name for ANDROID/IOS runs (e.g. "OPPO CPH2375", "Pixel 7"). Read off
   *  the matching row's `name` field in `mobile_list_devices`. Used as the display name in
   *  execution reports. Falls back to `deviceId` when not provided. */
  deviceName?: string;
  /** For PARALLEL execution on multiple mobile devices — pass an array of device specs. Each entry
   *  creates one executionItem inside a SINGLE execution (one execution ID, multiple parallel runs).
   *  When provided, the single-device fields (deviceId, deviceName, deviceType, etc.) are ignored. */
  devices?: DeviceSpec[];
  /** Wire values on `/exec/execution` are SERIAL or PARALLEL — the joi validator
   *  at executions/src/validators/execution.validator.js:36 rejects anything else. Local is always
   *  serial. Default 'serial'. Applies to suite runs and multi-device TC runs. */
  strategy?: 'serial' | 'parallel';
  /** SUITE cloud only — max concurrent runners. Maps to `globalConfiguration.MAXIMUM_CONTAINER_COUNT`
   *  on the wire (suite doc's field with the same name is the fallback). */
  maxConcurrent?: number;
  /** SUITE runs only — stop dispatching remaining test cases after the first failure. */
  terminateOnFailure?: boolean;
  /** SimplifyQA project-management tag on the run. Optional — the UI's "Release" picker
   *  (from `list_releases`). Sent as numeric `releaseId` on the exec payload; default 0. */
  releaseId?: string;
  /** SimplifyQA project-management tag on the run. Optional — the UI's "Sprint" picker
   *  (from `list_sprints`). Sent as numeric `iterationId` on the exec payload; default 0. */
  sprintId?: string;
  /** Override the TC's currently-selected version for this run. Optional — the UI's
   *  "Version" chip defaults to the TC's current; pass an id from the TC's `versions[]` to run
   *  a different one. Omit to run the current version. */
  versionId?: string };
/** `reportUrl`: the product's report page for THIS run — hand it to the user as-is instead of composing a link. */
export type RunRef = { runId: string; reportUrl?: string };
/** A cloud runner VM registered to the project. `online` is the single flag the run flow gates on.
 *  `id` (compute_configs._id) drives an IMMEDIATE cloud reserve; `credentialId` (the linked
 *  test_runner_vm agent credential) is what a SCHEDULE pins as assigned_agent_credential_id —
 *  a different id-space from `id`. */
export type CloudRunner = { id: string; name: string; online: boolean; status?: string; os?: string; credentialId?: string; cloudType?: string };
/** A LOCAL Walnut agent registered to the project. `id` is the agent credential_id (what a LOCAL
 *  run/schedule dispatches to). `online` gates whether it can take a run now. `owner` is the person
 *  and `host` the machine hostname — shown together (like the product UI) so a user can tell apart
 *  several agents owned by the same person (the credential_id alone means nothing to them). */
export type LocalAgent = { id: string; name?: string; online: boolean; status?: string; owner?: string; host?: string; isThisMachine?: boolean };
/** A mobile device registered to the project OR available on a configured cloud provider. `id`
 *  is the wire deviceId the executor takes (adb serial / udid for LOCAL; cloud farm device name
 *  for CLOUD). `active` is the last-known connection flag from the backend — stale by design
 *  (updated only when the desktop agent or an execution touches it). `agentId` is which
 *  registered machine's desktop agent the device is paired with (used to filter for REMOTE
 *  runs). `cloudDeviceType` names the cloud farm the device came from — undefined for local
 *  devices, one of LAMBDA_TEST / BROWSER_STACK / SAUCE_LABS / SIMPLIFY_QA_DEVICE_FORM for cloud
 *  rows (note the FORM/FARM legacy typo — mirrors the SQA wire schema exactly). */
export type MobileDevice = {
  id: string;
  name: string;
  /** Human-readable display name for reports, e.g. "Oppo-Cph2375-Ab1fe936". Built from
   *  manufacturer + model + serial when available; falls back to `name` or `id`. */
  displayName?: string;
  platform: 'ANDROID' | 'IOS';
  deviceType: 'REAL_DEVICE' | 'EMULATOR' | 'SIMULATOR' | 'CLOUD_DEVICE' | 'CLOUD_EMULATOR' | 'CLOUD_SIMULATOR';
  osVersion?: string;
  active?: boolean;
  status?: string;
  agentId?: string;
  cloudDeviceType?: 'LAMBDA_TEST' | 'BROWSER_STACK' | 'SAUCE_LABS' | 'SIMPLIFY_QA_DEVICE_FORM';
};
/** Inputs to createSchedule (POST /api/schedules) — mirrors RunOptions' runner-pick fields plus the
 *  schedule cadence. `mode` and `scheduledFor` are required (the backend rejects a schedule with no
 *  start time). Manual test cases are not schedulable — the backend surfaces that error. */
/** Schedule recurrence. The first six mirror the SimplifyQA scheduler's Recurrence dropdown
 *  (Once, Every 5 Minutes, Hourly, Daily, Weekly, Monthly); `weekdays` is an MCP shortcut
 *  (weekly on Mon–Fri) kept for existing callers. */
export const SCHEDULE_TYPES = ['once', 'every_5_minutes', 'hourly', 'daily', 'weekly', 'monthly', 'weekdays'] as const;
export type ScheduleType = typeof SCHEDULE_TYPES[number];

export type ScheduleOptions = {
  /** REPEAT EVERY N (hourly / daily / weekly / monthly): N hours / days / weeks / months, 1 or more. Not for once / every_5_minutes. */
  interval?: number;
  /** Weekly: the weekdays to run on (MONDAY … or MON …); default = the start's weekday. Monthly + occurrence: the ONE weekday. */
  daysOfWeek?: string[];
  /** Monthly "ON DAY": 1–30; default = the start's day. */
  dayOfMonth?: number;
  /** Monthly "ON THE": the first / second / third / last weekday (give the weekday in daysOfWeek). */
  occurrence?: 'first' | 'second' | 'third' | 'last';
  /** The schedule's name (3–501 characters, unique in the project). Omitted → "<TC-22> schedule", numbered when that is taken. */
  name?: string;
  /** Where the scheduled run executes: 'local' (THIS machine's agent), 'remote' (a teammate's
   *  registered agent) or 'cloud' (a cloud runner VM). */
  mode: 'local' | 'remote' | 'cloud';
  /** mode:'local' / 'remote' — REQUIRED: the specific agent credential_id the schedule fires on.
   *  A schedule runs detached from any live session (no "caller's own agent" at fire time), so a
   *  local/remote schedule must pin an agent — createSchedule sets execution_mode:'manual' so the
   *  backend honors it. LOCAL must be THIS machine's row (local_agents); REMOTE must be a
   *  teammate's row (remote_agents). */
  agentId?: string;
  /** mode:'cloud' — the specific cloud runner id (compute_configs._id, from listCloudRunners), used
   *  only to identify the runner. The actual SCHEDULE pin travels in cloudRunnerCredentialId. */
  cloudRunnerId?: string;
  /** mode:'cloud' — pin a SPECIFIC cloud runner by its agent CREDENTIAL id (CloudRunner.credentialId,
   *  NOT cloudRunnerId). The backend validates it as an active test_runner_vm credential and rejects a
   *  VM that is offline at create time; omit to let the backend auto-pick a live VM at fire time. */
  cloudRunnerCredentialId?: string;
  browser?: string;
  /** Environment id (Mongo id); only forwarded when it is a 24-hex id, mirroring startRun. */
  environmentId?: string;
  /** Tag the scheduled run with a RELEASE (from list_releases). REQUIRED for suite schedules on
   *  SimplifyQA — the UI marks Release with `*` when _parentComponent==='SU'. Sent as numeric
   *  releaseId on the schedule payload. */
  releaseId?: string;
  /** Tag the scheduled run with a SPRINT (from list_sprints). REQUIRED for suite schedules on
   *  SimplifyQA — mirrors the UI. SQA's underlying column is `iterationId`. */
  sprintId?: string;
  /** REQUIRED — ISO datetime of the first (or only) run. */
  scheduledFor: string;
  /** Recurrence cadence (the tools make the user pick it explicitly). */
  scheduleType?: ScheduleType;
  /** ISO end date for recurring schedules. */
  endDate?: string;
  /** IANA timezone, default 'UTC'. */
  timezone?: string;
};
/** Neutral reference to a created schedule (from POST /api/schedules `data`). */
export type ScheduleRef = { id: string; name?: string; status?: string; nextRunAt?: string; productUrl?: string; notes?: string[] };
/** A schedule as listed for management (GET /api/schedules). `target` names WHAT it runs (a test case
 *  or a suite), `agent` is the pinned agent/runner's human name, and `updateVersion` is the optimistic-
 *  concurrency token an edit must echo back. */
export type ScheduleInfo = {
  id: string;
  /** The schedule's own name (as the Scheduler shows it). */
  name?: string;
  target: string;               // e.g. "TC_2271 — Login" or "Suite: Smoke"
  scheduleType: string;         // once / hourly / daily / ...
  status: string;               // scheduled / running / paused / cancelled / ...
  active?: boolean;             // is_active — false = paused
  executionTarget?: 'local' | 'cloud_runner';
  agent?: string;               // pinned agent/runner owner/name (never the credential_id)
  browser?: string;
  nextRunAt?: string;
  scheduledFor?: string;
  timezone?: string;
  updateVersion?: number;
};
/** Fields an edit may change (schedule_update). Omitted = leave as-is. Mirrors updateScheduleSchema;
 *  `mode:'local'` re-pins via agentId, `mode:'cloud'` via cloudRunnerCredentialId. */
export type ScheduleUpdate = {
  /** REPEAT EVERY N (hourly / daily / weekly / monthly): N hours / days / weeks / months, 1 or more. Not for once / every_5_minutes. */
  interval?: number;
  /** Weekly: the weekdays to run on (MONDAY … or MON …); default = the start's weekday. Monthly + occurrence: the ONE weekday. */
  daysOfWeek?: string[];
  /** Monthly "ON DAY": 1–30; default = the start's day. */
  dayOfMonth?: number;
  /** Monthly "ON THE": the first / second / third / last weekday (give the weekday in daysOfWeek). */
  occurrence?: 'first' | 'second' | 'third' | 'last';
  /** Rename the schedule (3–501 characters, unique in the project). */
  name?: string;
  /** Change WHAT it runs: a test case (the schedule becomes a Test Case schedule) or a suite (a Suite schedule) — the same schedule id.
   *  Give one of them, not both. */
  tcId?: string;
  suiteId?: string;
  /** Release / sprint (id, code or exact name; "none" clears) — a suite schedule needs a release. */
  releaseId?: string;
  sprintId?: string;
  scheduledFor?: string;
  scheduleType?: ScheduleType;
  endDate?: string;
  timezone?: string;
  browser?: string;
  environmentId?: string;
  mode?: 'local' | 'cloud';
  agentId?: string;
  cloudRunnerCredentialId?: string;
};
/** State transitions for schedule_control. pause↔resume are reversible; cancel stops the pending/live
 *  run; delete (a separate tool) removes the row entirely. */
export type ScheduleAction = 'pause' | 'resume' | 'cancel';
export type RunState = 'queued' | 'running' | 'passed' | 'failed' | 'skipped' | 'notExecuted' | 'stopped' | 'error';
export type RunStatus = { runId: string; state: RunState;
  progress?: { done: number; total: number };
  /** `warning`: a step that PASSED but shows evidence of a problem (e.g. an API request that got no response, a read that
   *  matched nothing). Derived from stored data; it never changes `status`. */
  stepResults?: { n: number; description: string; status: string; error?: string; warning?: string; screenshotUrl?: string }[];
  /** SUITE runs only — per-test-case rollup (one row per member). `progress` then counts TEST CASES,
   *  not steps. Absent for a single test-case run. `testcaseId`/`versionId`/`stepId` (when present)
   *  are what a follow-up drill-down (adapter's `getSuiteChildRun`) needs to fetch THIS child's own
   *  step-level results — the rollup alone only carries pass/fail state, not why. */
  children?: {
    id: string; title?: string; state: RunState;
    testcaseId?: string; versionId?: string; stepId?: string;
  }[];
  startedAt?: string | undefined;
  endedAt?: string | undefined;
  reportUrl?: string };
/** One row in a run-history scoreboard — enough to render a "last N executions" list without
 *  pulling per-step detail. SUITE runs carry the per-test-case tally inline (from the exec doc's
 *  executionItems[]); TC runs omit those counters. */
export type RunSummary = {
  runId: string;
  state: RunState;
  startedAt?: string;
  endedAt?: string;
  reportUrl?: string;
  // SUITE only:
  totalTestCases?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  notExecuted?: number;
};
export type SavedRef = { id: string; productUrl?: string; created: boolean; artifacts?: string[] };
export type ActionDef = { actionType: string; platform: string; description?: string;
  /** Backend numeric id, when the provider has one (SimplifyQA). Undefined on offline / walnut. */
  id?: number | undefined;
  /** True when the action requires an objectRef on the step (SimplifyQA). Optional. */
  objectRequired?: boolean | undefined };
export type EnvInfo = { id: string; name: string; key?: string; isDefault?: boolean };
export type DatasetInfo = { id: string; name: string; rowCount?: number };

/** Template row for testdata generation. `parameters[i].paramId` is the backend id used when
 *  posting new rows; `name` is the human-facing token (e.g. `${username}`); `seed` is the current
 *  default value (empty string if unset) — used for regex-based type inference when no override is
 *  supplied. `versionId`/`environmentType` are echoed back from the product so a follow-up
 *  saveGeneratedIterations call targets the same TC context without a second lookup. */
export type DefaultIteration = {
  tcId: string;
  versionId: string;
  environmentType: string;
  /** `seed` is already masked for a protected parameter ("*****" / "(empty)") — the real value
   *  never leaves the adapter. */
  parameters: Array<{ paramId: number; name: string; seed: string; protected?: boolean | undefined }>;
};

/** One stored testdata iteration row (TC, FUNCTION or SUITE scope). `data` cells keep the backend
 *  shape; `paramId` (+ optional `name`) identifies the parameter. `isChecked` is the iteration-
 *  selection flag (a SUITE's suite-level testdata keeps exactly one active row per environment). */
export type TestdataIterationRow = {
  id: string;
  name: string;
  sequenceNo?: number | undefined;
  isChecked?: boolean | undefined;
  type?: string | undefined;
  environmentType?: string | undefined;
  data: Array<{
    paramId: number;
    name?: string | undefined;
    value?: string | undefined;
    formulaValue?: string | undefined;
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
};

/** Testdata iterations for a TC / FUNCTION / SUITE, with the parameter-id → name map for display. */
export type TestdataRows = {
  entityType: 'TC' | 'FN' | 'SU';
  id: string;
  /** The backend `testdata` definition row (NOT the suite/test-case id). */
  testdataId: string;
  environmentType: string;
  defaultIterationId?: string | undefined;
  iterations: TestdataIterationRow[];
  parameterNames: Record<string, string>;
};

/** Request body for `saveGeneratedIterations`. `rows[i]` is a flat `{paramName: value}` map; the
 *  adapter re-keys it to `{paramId: value}` server-side using the template.
 *  `formulas` — optional per-column formula assignments applied to EVERY row: the adapter evaluates
 *  the formula fresh per row via the product's compute endpoint and stamps both `value` (evaluated)
 *  and `formulaValue` (source `=NAME(...)` expression) on the payload cell. A formula wins over an
 *  explicit `rows[i]` value for the same param name. */
export type SaveGeneratedIterations = {
  tcId: string;
  /** 'FN' saves into a reusable FUNCTION's testdata (`tcId` then carries the function id). Default 'TC'. */
  entityType?: 'TC' | 'FN' | undefined;
  versionId: string;
  environmentType: string;
  rows: Array<Record<string, string>>;
  formulas?: Record<string, FormulaCall> | undefined;
  /** Optional pre-fetched template parameters (from a getDefaultIteration the caller already made).
   *  When present the adapter skips its own re-fetch — avoids paying the template + N parameter-name
   *  lookups twice per save. Safe to omit; adapter falls back to fetching. */
  parameters?: Array<{ paramId: number; name: string; seed: string }> | undefined;
};

/** A formula available in the project for testdata generation. `scope` is derived from the formula
 *  document: 'default' = customer-wide prefab (FIRST_NAME, RANDOM_EMAIL, …); 'customer' = user-defined
 *  formula visible across every project in the customer; 'project' = only in the current project.
 *  `signature`/`example` come straight from the formula's stored description. `parameters` names the
 *  argument keys (order matters: the adapter serialises calls positionally as `=NAME("a","b")`). */
export type Formula = {
  name: string;
  uniqueId: string;
  type: 'DEFAULT' | 'CUSTOM';
  scope: 'default' | 'customer' | 'project';
  signature: string;
  details?: string | undefined;
  example?: string | undefined;
  parameters: Array<{ keyName: string; description?: string | undefined; dataType?: string | undefined }>;
};

/** A model-supplied call to a formula for one testdata column. `args` is name→value keyed by
 *  `Formula.parameters[].keyName`; the adapter orders them positionally when building the stored
 *  `formulaValue` expression, and passes them as query params to the compute endpoint. */
export type FormulaCall = {
  /** Formula name from tc_list_formulas. Optional when a full `expression` is given. */
  name?: string | undefined;
  args?: Record<string, string> | undefined;
  /** A complete formula expression, used verbatim — nested formulas, custom formulas, `{{param}}` references:
   *  `=UPPER(FIRST_NAME("United States"))`. A leading `=` is added when missing. Wins over name/args. */
  expression?: string | undefined;
};

export type SaveGeneratedIterationsResult = {
  tcId: string;
  inserted: number;
  iterationIds?: string[];
  datasetUrl?: string;
};
/** Result of copying one TC's default-iteration values onto another TC (tc_automate). */
export type CopyTestdataResult = {
  fromTcId: string;
  toTcId: string;
  environmentType: string;
  /** Number of parameter values written onto the target's default iteration. */
  copied: number;
  /** Source parameter names that had no matching target parameter (nothing written for them). */
  skipped: string[];
};
export type EntityRef = { kind: 'testcase' | 'suite' | 'run' | 'function'; id: string };
/** The recording-JOURNAL view of a test case, for journal-first editing. `source:'journal'` = steps
 *  derived from the stored journal seed (edits stay healer/re-record consistent); `source:'steps'` =
 *  fell back to the persisted test_steps because the TC has no journal seed. */
export type JournalView = {
  tcId: string;
  source: 'journal' | 'steps';
  steps: Step[];
  savedAt?: string | undefined;
  ageDays?: number | undefined;
  entryCount?: number | undefined;
};
/** One API response assertion, as an LLM writes it. `path` is the live-request form
 *  (`statusCode`, `responseTime`, `responseSize`, `$.body.x`, `$.headers.Name`); the mapper
 *  normalizes it to the editor's `response.x` / `responseHeaders.Name` shape on save. */
export type ApiAssertionInput = {
  path: string;
  condition: string;
  expectedValue?: string | number | boolean | undefined;
  key?: string | undefined;
  [k: string]: unknown;
};

/** A granular edit op for journal_modify / edit_journal. `n` / `from` / `to` are the CLIENT-VISIBLE
 *  step numbers from journal_grep (1-based). Range ops wrap the inclusive [from,to] span. */
export type JournalOp =
  | { op: 'set_meta'; patch: Partial<TestCase> }
  | { op: 'add_step'; at?: number | undefined; seq?: number | undefined; step: Omit<Step, 'n'> }
  | { op: 'update_step'; n: number; patch: Partial<Step> }
  | { op: 'add_assertions'; n: number; assertions: ApiAssertionInput[] }
  | { op: 'remove_step'; n: number }
  | { op: 'remove_steps'; numbers: number[] }
  | { op: 'move_step'; n: number; to: number }
  | { op: 'duplicate_step'; n: number; through?: number | undefined; at?: number | undefined; seq?: number | undefined }
  | { op: 'update_steps'; where: import('../drafts/bulk.js').StepWhere; patch: Partial<Step> }
  | { op: 'wrap_in_loop'; from: number; to: number; condition?: Condition | undefined; maxIterations?: number | undefined }
  | { op: 'wrap_in_if'; from: number; to: number; condition?: Condition | undefined }
  | { op: 'insert_nested'; at?: number | undefined; tcId: string; name?: string | undefined };
export type ValidationIssue = { step?: number; field?: string; msg: string };
