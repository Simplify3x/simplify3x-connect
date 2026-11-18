/**
 * SimplifyQA collection registry — the single source of truth for the generic `sqa_query` tool.
 *
 * Every SQA collection read is the same protocol:
 *   POST /<module>/<collection>/search
 *   { searchFields: [...], startIndex, limit, selectFields?, skipStartIndex? }
 *   -> { totalCount, data: [...] }
 *
 * What differs per collection: the path, the project-scope column, the field keys, and the
 * relations. All of that lives here so one tool can query every collection.
 *
 * Field provenance (checked against the backend repos on 2026-10-23):
 * - Default fields come from `project-management/src/fields/default_fields.json` + the runtime
 *   `fields` collection (`GET /pm/fields/{parentId}`).
 * - `priority` is a default field only on features/stories/tasks/defects. Test cases, functions,
 *   suites, epics, releases and sprints have no `priority`.
 * - `status` is not a default field on any PM/TM collection. Defects store the workflow value in
 *   `state` (Joi labels it "Status"); test cases/functions use `reviewApproveStatus`; executions
 *   have a real `status`.
 * - Custom fields live in `customFields.<key>`; the key is resolved through
 *   `GET /pm/fields/{parentId}?fieldType=allFields&projectId=...`.
 *
 * `deleted: false` is sent on EVERY collection, as the AI assistant's reads exclude deleted rows; a
 * caller cannot widen it. The backend does not add it (see `searchUtil.addTypesAndPrepareQuery`,
 * which only adds customerId).
 */

export type SqaOp =
  | 'eq' | 'ne' | 'in' | 'not_in' | 'contains'
  | 'gt' | 'gte' | 'lt' | 'lte' | 'exists';

export type SqaFieldType = 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object';

export type SqaField = {
  key: string;
  type: SqaFieldType;
  ops: SqaOp[];
  label?: string;
  /** Explicitly set false for fields the backend cannot sort on. Default: sortable for scalar types. */
  sort?: boolean;
  /**
   * How a filter word is translated to the stored value (only when value resolution is on):
   *  - 'lifecycle': a configured option of this default field (`/pm/fields` values) — "New" →
   *    `CUSTFIELD_1New_3_mdokm`, "open" → every new+pending state. Ported from the AI assistant.
   *  - 'enum': one of `enumValues`, any case; `enumGroups` words stand for several values.
   *  - 'ref': a record of `refTo` named by name / code / "me" → its id(s) (see REF_FIELDS).
   */
  resolve?: 'lifecycle' | 'enum' | 'ref';
  refTo?: string;
  enumValues?: string[];
  enumGroups?: Record<string, string[]>;
};

export type SqaRelation = {
  /** 'query' = search the target, 'through' = read this row then query the target, 'subresource' = GET a child path. */
  kind: 'query' | 'through' | 'subresource';
  /** Target collection for 'query' / 'through'. */
  to?: string;
  /** Field on THIS collection. Supports dotted paths and `array[].field` for arrays of objects. */
  localField: string;
  /** Field on the TARGET collection for 'query'. */
  remoteField?: string;
  /** Constant filters to add to the target query. */
  where?: Record<string, string | number | boolean>;
  /** True when remoteField is an array / dotted path (value becomes an IN filter). */
  arrayContains?: boolean;
  /** Folder trees (test plans), 'through' only: read `localField` from the folder's sub-folders
   *  ('children' — both edge directions) or from the folder plus every folder below it ('subtree'). */
  tree?: 'children' | 'subtree';
  /** For 'subresource': path + params. `{id}` is replaced with the parent id. */
  subresourcePath?: string;
  subresourceParams?: Record<string, string>;
  description: string;
};

export type SqaCollection = {
  name: string;
  aliases: string[];
  /** One-line "what it is". */
  description: string;
  /** "What it is used for" — surfaced by the catalog. */
  usedFor: string;
  /** Which rows the backend returns depends on who is asking (admin vs non-admin). Shown on every
   *  search/count result so a partial list is never read as "all of them". */
  visibility?: string;
  /** parentId for custom fields / the `fields` collection. Absent when the collection has none. */
  parentId?: number;
  /** Defaults to POST. `environments` is a GET. */
  method?: 'POST' | 'GET';
  searchPath: string;
  getPath?: string;
  /** 'release': the row carries no project, only a `releaseId` — scoped to the releases of the active
   *  project, the way the UI does it (sprints: releasesOfActiveProject → allSprints by releaseId). */
  scope: 'project' | 'projectIds' | 'release' | 'none';
  /** Column that carries the soft-delete flag; every collection sets it, so deleted rows are never
   *  returned. */
  softDelete?: string;
  idField: string;
  keyField?: string;
  labelField: string;
  defaultSelect: string[];
  maxLimit?: number;
  totalCountReliable?: boolean;
  /** Boolean fields whose `true` rows the product hides unless a filter names the field (the UI
   *  hides obsolete test cases: 532 shown of 535 stored). Applied with value resolution on.
   *  The object form also stops hiding when a filter names any of `askedBy` (e.g. naming
   *  `parentExecutionId` asks for child runs; naming `id`/`code` looks one row up, whatever it is). */
  hiddenUnlessAsked?: Array<string | { field: string; askedBy: string[] }>;
  /** Each version is its own document under the same `id` — one entity, several rows. Rows are
   *  collapsed to one per id with value resolution on (prefer `parent:true`, then newest). */
  versioned?: boolean;
  /** Filters applied unless a filter names one of `unless` (value resolution on; `includeHidden`
   *  turns them off). Test plans are top-level folders; naming a folder-level field asks about folders. */
  defaultFilter?: { where: Record<string, string | number | boolean>; unless: string[] };
  /** Rows are folders of a tree (test plans): each row gets `_folder` counts and its path. */
  folderTree?: boolean;
  fields: Record<string, SqaField>;
  relations?: Record<string, SqaRelation>;
};

// ---------------------------------------------------------------------------
// Spelling helpers (keeps the registry readable).
// ---------------------------------------------------------------------------

const EQ: SqaOp[] = ['eq', 'in'];
const STR: SqaOp[] = ['eq', 'contains', 'ne'];
const NUM: SqaOp[] = ['eq', 'in', 'ne', 'gt', 'gte', 'lt', 'lte'];
// `exists` is unusable on SQA booleans (the backend puts { $exists } inside $nor).
const BOOL: SqaOp[] = ['eq', 'ne'];
const DATE: SqaOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'];
const ARR: SqaOp[] = ['in', 'not_in'];
// Fields whose value a word is translated for: lists are allowed (several states / technologies).
const CHOICE: SqaOp[] = ['eq', 'in', 'ne', 'not_in', 'contains'];

/** A configured workflow/priority/severity option (see SqaField.resolve). */
const LIFECYCLE: FieldDef = ['string', CHOICE, { resolve: 'lifecycle' }];
/** The AI assistant's catalogue enums for test cases (semantic/data/fields_generated.json). */
const TC_TYPE: FieldDef = ['string', CHOICE, {
  resolve: 'enum',
  enumValues: ['WEB', 'ANDROID', 'IOS', 'API', 'DESKTOP', 'SAP', 'MAINFRAME', 'DATABASE', 'HYBRID'],
  enumGroups: { MOBILE: ['ANDROID', 'IOS'] },
}];
const EXECUTION_TYPE: FieldDef = ['string', CHOICE, { resolve: 'enum', enumValues: ['MANUAL', 'AUTOMATION', 'DUO'] }];

type FieldDef = [SqaFieldType, SqaOp[]] | [SqaFieldType, SqaOp[], Partial<Omit<SqaField, 'key' | 'type' | 'ops'>>];

function fields(defs: Record<string, FieldDef>): Record<string, SqaField> {
  const out: Record<string, SqaField> = {};
  for (const [key, def] of Object.entries(defs)) {
    const [type, ops, extra] = def;
    out[key] = { key, type, ops, ...(extra ?? {}) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Collections.
// ---------------------------------------------------------------------------

export const SQA_COLLECTIONS: Record<string, SqaCollection> = {
  projects: {
    name: 'projects',
    aliases: ['project'],
    description: 'Tenant projects — the root scope for test cases, backlog, runs and settings. Readable with no ' +
      'project selected. An admin sees every project in the tenant; `member:true` keeps only the ones you have a role in, ' +
      'and each row then carries your `roleId` + `roleName` in that project.',
    usedFor: 'How many / which projects; resolve a project name/id before qa_switch_project (use member:true for the user\'s own).',
    visibility: 'Only the projects you have access to. An admin sees every project in the account.',
    method: 'POST',
    searchPath: '/pm/project/search',
    scope: 'none',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'name',
    defaultSelect: ['id', 'code', 'name'],
    totalCountReliable: false,
    fields: fields({
      id: ['number', NUM],
      code: ['string', STR],
      name: ['string', STR],
      // Not stored: the adapter turns it into `id in <your role projects>` (/pm/projectuserrole).
      member: ['boolean', BOOL, { label: 'You have a role in it' }],
      businessUnitId: ['number', EQ, { label: 'Business unit' }],
      createdBy: ['number', EQ],
      updatedBy: ['number', EQ],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
    }),
  },

  testcases: {
    name: 'testcases',
    aliases: ['testcase', 'tc', 'test', 'tests'],
    description: 'Saved test cases (manual or automated; WEB/API/ANDROID/DATABASE/MAINFRAME/...).',
    usedFor: 'List/read test cases, find by module/story/type, and drive executions or defects.',
    parentId: 5,
    searchPath: '/tm/testcase/search',
    getPath: '/tm/testcase/getById/{id}',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'name',
    defaultSelect: ['id', 'code', 'name', 'tcType', 'executionType', 'moduleId', 'userstoryId', 'obsolete', 'reviewApproveStatus'],
    hiddenUnlessAsked: ['obsolete'],
    fields: fields({
      id: ['number', NUM],
      code: ['string', STR],
      name: ['string', STR],
      tcType: TC_TYPE,
      executionType: EXECUTION_TYPE,
      moduleId: ['number', EQ, { label: 'Module' }],
      userstoryId: ['number', EQ, { label: 'User Story' }],
      createdBy: ['number', EQ],
      updatedBy: ['number', EQ],
      obsolete: ['boolean', BOOL],
      reviewApproveStatus: ['string', STR],
      // NOTE: there is NO hybrid column. The backend rejects `isHybrid` on both the test case and its
      // version ("tcfnObj.isHybrid is not allowed", HTTP 400), and searching it returns 0 rows either
      // way. A hybrid test case is only detectable from its steps (SWITCH_TO_* + each step's
      // technologyType); do NOT advertise it as a filterable field.
      updateVersion: ['number', NUM],
      tags: ['array', ARR],
      suiteId: ['array', ARR],
      defectId: ['array', ARR],
      description: ['string', STR],
      prerequisite: ['string', STR],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
      projectId: ['number', EQ],
      // NOTE: priority/status/stepCount are NOT stored on SQA testcase rows. Do not add them.
    }),
    relations: {
      linkedIssues: {
        kind: 'query', to: 'tcLinkages', localField: 'id', remoteField: 'parentId',
        where: { parentType: 'TC' },
        description: 'Linked issues of this test case (the Linkages panel): each row names the linked item by destinationCode + parentName and the link by linkTypeKey.',
      },
      steps: {
        kind: 'subresource', localField: 'id',
        subresourcePath: '/tm/testcase/steps',
        subresourceParams: { tcfnId: 'id', type: 'TC' },
        description: 'Step rows for the test case (optionally a specific version).',
      },
      versions: {
        kind: 'query', to: 'versions', localField: 'id', remoteField: 'parentId',
        where: { parentType: 'TC' },
        description: 'All versions (tcfn_version rows) of this test case.',
      },
      attachments: {
        kind: 'query', to: 'attachments', localField: 'id', remoteField: 'parentId',
        where: { parentType: 'TC' },
        description: 'Files attached to this test case. `url` is a direct download path (prefix QA_BASE_URL).',
      },
      executions: {
        kind: 'query', to: 'executions', localField: 'id', remoteField: 'executionTypeId',
        // The executions collection stores `type: "TESTCASE"` (not "TC") — verified live.
        where: { type: 'TESTCASE' },
        description: 'Runs of this test case (newest first if you sort id desc). `type` is TESTCASE on the wire.',
      },
      defects: {
        kind: 'query', to: 'defects', localField: 'id', remoteField: 'selectedTestCase.testcaseId',
        arrayContains: true,
        description: 'Defects raised against / linked to this test case.',
      },
      suites: {
        kind: 'query', to: 'suites', localField: 'id', remoteField: 'testCases.testcaseId',
        arrayContains: true,
        description: 'Suites that contain this test case.',
      },
      testdata: {
        kind: 'query', to: 'testdata', localField: 'id', remoteField: 'testcaseId',
        description: 'Test-data iterations for this test case.',
      },
      module: {
        kind: 'through', to: 'modules', localField: 'moduleId', remoteField: 'id',
        description: 'The module/folder this test case lives in.',
      },
      story: {
        kind: 'through', to: 'stories', localField: 'userstoryId', remoteField: 'id',
        description: 'The user story this test case is linked to (if any).',
      },
    },
  },

  functions: {
    name: 'functions',
    aliases: ['function', 'fn', 'reusable'],
    description: 'Reusable step groups stored in the same tcfn collection as test cases (type=FN).',
    usedFor: 'List/read reusable functions, their versions and steps.',
    parentId: 6,
    searchPath: '/tm/function/search',
    getPath: '/tm/function/{id}/{projectId}',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'name',
    defaultSelect: ['id', 'code', 'name', 'fnType', 'executionType', 'moduleId', 'reviewApproveStatus'],
    fields: fields({
      id: ['number', NUM],
      code: ['string', STR],
      name: ['string', STR],
      fnType: ['string', STR],
      executionType: ['string', STR],
      moduleId: ['number', EQ, { label: 'Module' }],
      reviewApproveStatus: ['string', STR],
      createdBy: ['number', EQ],
      updatedBy: ['number', EQ],
      tags: ['array', ARR],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
      projectId: ['number', EQ],
    }),
    relations: {
      linkedIssues: {
        kind: 'query', to: 'tcLinkages', localField: 'id', remoteField: 'parentId',
        where: { parentType: 'FN' },
        description: 'Linked issues of this function (the Linkages panel): each row names the linked item by destinationCode + parentName and the link by linkTypeKey.',
      },
      steps: {
        kind: 'subresource', localField: 'id',
        subresourcePath: '/tm/function/steps',
        subresourceParams: { tcfnId: 'id', type: 'FN' },
        description: 'Step rows for the function (the newest version when versionId is omitted).',
      },
      versions: {
        kind: 'query', to: 'versions', localField: 'id', remoteField: 'parentId',
        where: { parentType: 'FN' },
        description: 'All versions of this function.',
      },
      attachments: {
        kind: 'query', to: 'attachments', localField: 'id', remoteField: 'parentId',
        where: { parentType: 'FN' },
        description: 'Files attached to this function. `url` is a direct download path (prefix QA_BASE_URL).',
      },
      module: {
        kind: 'through', to: 'modules', localField: 'moduleId', remoteField: 'id',
        description: 'The module/folder this function lives in.',
      },
    },
  },

  suites: {
    name: 'suites',
    aliases: ['suite', 'test suite'],
    description: 'Ordered collections of test cases used for batch execution.',
    usedFor: 'List/read suites, their member test cases, and their runs.',
    parentId: 7,
    searchPath: '/tm/suites/search',
    getPath: '/tm/suites/{id}',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'name',
    defaultSelect: ['id', 'code', 'name', 'suiteType', 'state'],
    fields: fields({
      id: ['number', NUM],
      code: ['string', STR],
      name: ['string', STR],
      suiteType: ['string', STR],
      state: ['string', STR],
      'testCases.testcaseId': ['array', ARR, { label: 'Test Case' }],
      createdBy: ['number', EQ],
      updatedBy: ['number', EQ],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
      projectId: ['number', EQ],
    }),
    relations: {
      testcases: {
        kind: 'through', to: 'testcases', localField: 'testCases[].testcaseId', remoteField: 'id',
        description: 'Member test cases, in suite order.',
      },
      executions: {
        kind: 'query', to: 'executions', localField: 'id', remoteField: 'executionTypeId',
        where: { type: 'SUITE' },
        description: 'Runs of this suite (newest first if you sort id desc).',
      },
    },
  },

  stories: {
    name: 'stories',
    aliases: ['story', 'userstory', 'user story', 'us'],
    description: 'User stories with acceptance criteria — the backlog/PM unit that test cases, defects and tasks link to.',
    usedFor: 'List/read stories, filter by epic/feature/release/sprint/module/owner, and follow their test cases/defects/tasks.',
    parentId: 3,
    searchPath: '/pm/userstory/search',
    getPath: '/pm/userstory/{id}',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'name',
    defaultSelect: ['id', 'code', 'name', 'state', 'priority', 'moduleId', 'epicId', 'featureId', 'releaseId', 'iterationId', 'ownerId'],
    versioned: true,
    fields: fields({
      id: ['number', NUM],
      code: ['string', STR],
      name: ['string', STR],
      state: LIFECYCLE,
      priority: LIFECYCLE,
      type: ['string', STR],
      moduleId: ['number', EQ, { label: 'Module' }],
      epicId: ['number', EQ, { label: 'Epic' }],
      featureId: ['number', EQ, { label: 'Feature' }],
      releaseId: ['number', EQ, { label: 'Release' }],
      iterationId: ['number', EQ, { label: 'Sprint' }],
      ownerId: ['number', EQ],
      createdBy: ['number', EQ],
      updatedBy: ['number', EQ],
      deploymentStatus: ['string', STR],
      tags: ['array', ARR],
      teamId: ['array', ARR],
      plannedStartDate: ['date', DATE],
      plannedEndDate: ['date', DATE],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
      projectId: ['number', EQ],
    }),
    relations: {
      linkedIssues: {
        kind: 'query', to: 'linkages', localField: 'id', remoteField: 'parentId',
        where: { parentType: 'US' },
        description: 'Linked issues of this user story (the Linkages panel): each row names the linked item by destinationCode + parentName and the link by linkTypeKey.',
      },
      testcases: {
        kind: 'query', to: 'testcases', localField: 'id', remoteField: 'userstoryId',
        description: 'Test cases linked to this story.',
      },
      attachments: {
        kind: 'query', to: 'attachments', localField: 'id', remoteField: 'parentId',
        where: { parentType: 'US' },
        description: 'Files attached to this story. `url` is a direct download path (prefix QA_BASE_URL).',
      },
      defects: {
        kind: 'query', to: 'defects', localField: 'id', remoteField: 'userstoryId',
        description: 'Defects linked to this story.',
      },
      tasks: {
        kind: 'query', to: 'tasks', localField: 'id', remoteField: 'userstoryId',
        description: 'Tasks linked to this story.',
      },
      epic: {
        kind: 'through', to: 'epics', localField: 'epicId', remoteField: 'id',
        description: 'The parent epic.',
      },
      feature: {
        kind: 'through', to: 'features', localField: 'featureId', remoteField: 'id',
        description: 'The parent feature.',
      },
      release: {
        kind: 'through', to: 'releases', localField: 'releaseId', remoteField: 'id',
        description: 'The release this story belongs to.',
      },
      sprint: {
        kind: 'through', to: 'sprints', localField: 'iterationId', remoteField: 'id',
        description: 'The sprint (iterationId) this story belongs to.',
      },
      module: {
        kind: 'through', to: 'modules', localField: 'moduleId', remoteField: 'id',
        description: 'The module/folder this story belongs to.',
      },
    },
  },

  epics: {
    name: 'epics',
    aliases: ['epic', 'ep'],
    description: 'Top-level backlog themes that group features and stories.',
    usedFor: 'List/read epics and follow their features/stories.',
    parentId: 1,
    searchPath: '/pm/epic/search',
    getPath: '/pm/epic/{id}',
    scope: 'projectIds',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'name',
    defaultSelect: ['id', 'code', 'name', 'state', 'ownerId', 'projectIds'],
    versioned: true,
    fields: fields({
      id: ['number', NUM],
      code: ['string', STR],
      name: ['string', STR],
      state: LIFECYCLE,
      ownerId: ['number', EQ],
      createdBy: ['number', EQ],
      updatedBy: ['number', EQ],
      projectIds: ['array', ARR],
      tags: ['array', ARR],
      teamId: ['array', ARR],
      plannedStartDate: ['date', DATE],
      plannedEndDate: ['date', DATE],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
    }),
    relations: {
      linkedIssues: {
        kind: 'query', to: 'linkages', localField: 'id', remoteField: 'parentId',
        where: { parentType: 'EP' },
        description: 'Linked issues of this epic (the Linkages panel): each row names the linked item by destinationCode + parentName and the link by linkTypeKey.',
      },
      features: {
        kind: 'query', to: 'features', localField: 'id', remoteField: 'epicId',
        description: 'Features under this epic.',
      },
      stories: {
        kind: 'query', to: 'stories', localField: 'id', remoteField: 'epicId',
        description: 'Stories under this epic.',
      },
    },
  },

  features: {
    name: 'features',
    aliases: ['feature', 'ft'],
    description: 'Features — children of epics that group user stories.',
    usedFor: 'List/read features and follow their stories.',
    parentId: 2,
    searchPath: '/pm/feature/search',
    getPath: '/pm/feature/{id}',
    scope: 'projectIds',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'name',
    defaultSelect: ['id', 'code', 'name', 'state', 'priority', 'epicId', 'ownerId', 'projectIds'],
    fields: fields({
      id: ['number', NUM],
      code: ['string', STR],
      name: ['string', STR],
      state: LIFECYCLE,
      priority: LIFECYCLE,
      epicId: ['number', EQ, { label: 'Epic' }],
      ownerId: ['number', EQ],
      createdBy: ['number', EQ],
      updatedBy: ['number', EQ],
      projectIds: ['array', ARR],
      tags: ['array', ARR],
      teamId: ['array', ARR],
      plannedStartDate: ['date', DATE],
      plannedEndDate: ['date', DATE],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
    }),
    relations: {
      linkedIssues: {
        kind: 'query', to: 'linkages', localField: 'id', remoteField: 'parentId',
        where: { parentType: 'FT' },
        description: 'Linked issues of this feature (the Linkages panel): each row names the linked item by destinationCode + parentName and the link by linkTypeKey.',
      },
      stories: {
        kind: 'query', to: 'stories', localField: 'id', remoteField: 'featureId',
        description: 'Stories under this feature.',
      },
      epic: {
        kind: 'through', to: 'epics', localField: 'epicId', remoteField: 'id',
        description: 'The parent epic.',
      },
    },
  },

  modules: {
    name: 'modules',
    aliases: ['module', 'folder', 'tree'],
    description: 'Folder tree used to organise test cases, functions and objects.',
    usedFor: 'List/read the module tree and find test cases/functions/objects by module.',
    searchPath: '/pm/module/search',
    getPath: '/pm/module/{id}',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'name',
    defaultSelect: ['id', 'code', 'name', 'parentId', 'isRoot', 'childIds'],
    maxLimit: 1000,
    fields: fields({
      id: ['number', NUM],
      code: ['string', STR],
      name: ['string', STR],
      parentId: ['number', EQ],
      isRoot: ['boolean', BOOL],
      createdBy: ['number', EQ],
      updatedBy: ['number', EQ],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
      projectId: ['number', EQ],
    }),
    relations: {
      children: {
        kind: 'query', to: 'modules', localField: 'id', remoteField: 'parentId',
        description: 'Direct child modules.',
      },
      testcases: {
        kind: 'query', to: 'testcases', localField: 'id', remoteField: 'moduleId',
        description: 'Test cases filed under this module.',
      },
      functions: {
        kind: 'query', to: 'functions', localField: 'id', remoteField: 'moduleId',
        description: 'Functions filed under this module.',
      },
      objects: {
        kind: 'query', to: 'objects', localField: 'id', remoteField: 'moduleId',
        description: 'Objects filed under this module.',
      },
    },
  },

  releases: {
    name: 'releases',
    aliases: ['release', 'rel'],
    description: 'Release containers that group sprints and stories.',
    usedFor: 'List/read releases and follow their sprints/stories.',
    parentId: 11,
    searchPath: '/pm/release/search',
    scope: 'projectIds',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'name',
    defaultSelect: ['id', 'code', 'name', 'state', 'projectIds', 'ownerIds'],
    fields: fields({
      id: ['number', NUM],
      code: ['string', STR],
      name: ['string', STR],
      state: ['string', STR],
      ownerIds: ['array', ARR],
      projectIds: ['array', ARR],
      plannedStartDate: ['date', DATE],
      plannedEndDate: ['date', DATE],
      actualStartDate: ['date', DATE],
      actualEndDate: ['date', DATE],
      createdBy: ['number', EQ],
      updatedBy: ['number', EQ],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
    }),
    relations: {
      sprints: {
        kind: 'query', to: 'sprints', localField: 'id', remoteField: 'releaseId',
        description: 'Sprints in this release.',
      },
      stories: {
        kind: 'query', to: 'stories', localField: 'id', remoteField: 'releaseId',
        description: 'Stories in this release.',
      },
    },
  },

  sprints: {
    name: 'sprints',
    aliases: ['sprint', 'iteration'],
    description: 'Iterations inside a release — only sprints whose release belongs to the active project ' +
      '(a sprint has no project of its own); `allProjects:true` reads the sprints of all your projects. ' +
      'On the wire, stories link to a sprint via `iterationId`.',
    usedFor: 'List/read sprints and follow their stories.',
    parentId: 12,
    searchPath: '/pm/sprint/search',
    // The backend's /pm/sprint/search filters by customer only, so without this a non-admin got every
    // sprint in the customer.
    scope: 'release',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'name',
    defaultSelect: ['id', 'code', 'name', 'releaseId', 'state', 'ownerIds'],
    fields: fields({
      id: ['number', NUM],
      code: ['string', STR],
      name: ['string', STR],
      releaseId: ['number', EQ, { label: 'Release' }],
      state: ['string', STR],
      ownerIds: ['array', ARR],
      plannedStartDate: ['date', DATE],
      plannedEndDate: ['date', DATE],
      actualStartDate: ['date', DATE],
      actualEndDate: ['date', DATE],
      createdBy: ['number', EQ],
      updatedBy: ['number', EQ],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
    }),
    relations: {
      stories: {
        kind: 'query', to: 'stories', localField: 'id', remoteField: 'iterationId',
        description: 'Stories in this sprint (stories call the sprint `iterationId`).',
      },
      release: {
        kind: 'through', to: 'releases', localField: 'releaseId', remoteField: 'id',
        description: 'The parent release.',
      },
    },
  },

  defects: {
    name: 'defects',
    aliases: ['defect', 'bug', 'bugs'],
    description: 'Bugs/defects, raised manually or from an execution, and linked to test cases and stories.',
    usedFor: 'List/read defects, filter by state/severity/priority/assignee, and follow their test cases/tasks.',
    parentId: 9,
    searchPath: '/pm/defect/search',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'name',
    defaultSelect: ['id', 'code', 'name', 'state', 'severity', 'priority', 'ownerId', 'userstoryId', 'selectedTestCase'],
    fields: fields({
      id: ['number', NUM],
      code: ['string', STR],
      name: ['string', STR],
      state: ['string', CHOICE, { resolve: 'lifecycle', label: 'Status' }],
      severity: LIFECYCLE,
      priority: LIFECYCLE,
      ownerId: ['array', ARR],
      userstoryId: ['number', EQ, { label: 'User Story' }],
      'selectedTestCase.testcaseId': ['array', ARR, { label: 'Test Case' }],
      moduleId: ['number', EQ, { label: 'Module' }],
      featureId: ['number', EQ, { label: 'Feature' }],
      releaseId: ['number', EQ, { label: 'Release' }],
      iterationId: ['number', EQ, { label: 'Sprint' }],
      type: ['string', STR],
      category: ['string', STR],
      environment: ['string', STR],
      createdBy: ['number', EQ],
      updatedBy: ['number', EQ],
      plannedStartDate: ['date', DATE],
      plannedEndDate: ['date', DATE],
      closedDate: ['date', DATE],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
      projectId: ['number', EQ],
    }),
    relations: {
      linkedIssues: {
        kind: 'query', to: 'linkages', localField: 'id', remoteField: 'parentId',
        where: { parentType: 'DE' },
        description: 'Linked issues of this defect (the Linkages panel): each row names the linked item by destinationCode + parentName and the link by linkTypeKey.',
      },
      testcases: {
        kind: 'through', to: 'testcases', localField: 'selectedTestCase[].testcaseId', remoteField: 'id',
        description: 'Test cases this defect is linked to.',
      },
      tasks: {
        kind: 'query', to: 'tasks', localField: 'id', remoteField: 'defectId',
        description: 'Tasks raised for this defect.',
      },
      story: {
        kind: 'through', to: 'stories', localField: 'userstoryId', remoteField: 'id',
        description: 'The user story this defect belongs to.',
      },
    },
  },

  tasks: {
    name: 'tasks',
    aliases: ['task'],
    description: 'Project-management work items that can hang off a user story or a defect.',
    usedFor: 'List/read tasks, filter by state/priority/assignee/story/defect.',
    parentId: 4,
    searchPath: '/pm/task/search',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'name',
    defaultSelect: ['id', 'code', 'name', 'state', 'priority', 'ownerId', 'userstoryId', 'defectId'],
    fields: fields({
      id: ['number', NUM],
      code: ['string', STR],
      name: ['string', STR],
      state: LIFECYCLE,
      priority: LIFECYCLE,
      ownerId: ['array', ARR],
      userstoryId: ['number', EQ, { label: 'User Story' }],
      defectId: ['number', EQ, { label: 'Defect' }],
      releaseId: ['number', EQ, { label: 'Release' }],
      iterationId: ['number', EQ, { label: 'Sprint' }],
      type: ['string', STR],
      createdBy: ['number', EQ],
      updatedBy: ['number', EQ],
      plannedStartDate: ['date', DATE],
      plannedEndDate: ['date', DATE],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
      projectId: ['number', EQ],
    }),
    relations: {
      linkedIssues: {
        kind: 'query', to: 'linkages', localField: 'id', remoteField: 'parentId',
        where: { parentType: 'TA' },
        description: 'Linked issues of this task (the Linkages panel): each row names the linked item by destinationCode + parentName and the link by linkTypeKey.',
      },
      defect: {
        kind: 'through', to: 'defects', localField: 'defectId', remoteField: 'id',
        description: 'The defect this task belongs to.',
      },
      story: {
        kind: 'through', to: 'stories', localField: 'userstoryId', remoteField: 'id',
        description: 'The user story this task belongs to.',
      },
    },
  },

  attachments: {
    name: 'attachments',
    aliases: ['attachment', 'file', 'files', 'upload', 'uploaded file'],
    description:
      'Files uploaded against an artifact (user story / test case / function) — screenshots, PDFs, ' +
      'spreadsheets. Every row carries a direct download `url`.',
    usedFor:
      'Find the file attached to a story (typically a testdata or test-scenario sheet) and hand its ' +
      '`url` to whoever needs it. Filter by parentId + parentType, or follow stories → attachments.',
    // Customer-wide on purpose: the backend scopes by customerId, but attachments do NOT always
    // carry a projectId (files saved by the TM service omit it), so a project-scoped read would
    // silently hide them. Filter by projectId when it matters.
    searchPath: '/pm/attachment/search',
    scope: 'none',
    softDelete: 'deleted',
    idField: 'id',
    labelField: 'original_name',
    defaultSelect: ['id', 'parentId', 'parentType', 'original_name', 'type', 'size', 'fileSize', 'projectId', 'url', 'createdAt'],
    fields: fields({
      id: ['string', STR],
      parentId: ['number', NUM, { label: 'Artifact id' }],
      parentType: ['string', CHOICE, { label: 'Artifact type (US / TC / FN)' }],
      original_name: ['string', STR, { label: 'File name' }],
      name: ['string', STR, { label: 'Stored file name' }],
      type: ['string', STR, { label: 'Extension' }],
      size: ['number', NUM, { label: 'Bytes' }],
      fileSize: ['string', STR, { label: 'Human-readable size' }],
      projectId: ['number', EQ],
      createdBy: ['number', EQ],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
      // Selectable, never filterable: this is returned so the caller can fetch the file.
      url: ['string', [], { label: 'Download path — prefix with QA_BASE_URL' }],
    }),
  },

  // Linked issues ("Linkages" panel on epic / feature / story / task / defect / test case / function).
  // A link is stored twice, once per side (PM linkages.service saveLinkIssues writes the mirror row):
  // rows whose parent is an epic/feature/story/task/defect live in PM, rows whose parent is a test case
  // or function live in TM (/tm/linkages). `parentName` is the LINKED item's name (UI linkages.component).
  linkages: {
    name: 'linkages',
    aliases: ['linkage', 'link', 'links', 'linked issue', 'linked issues', 'issue links', 'related items'],
    description:
      'Linked issues of epics (EP), features (FT), user stories (US), tasks (TA) and defects (DE): one row ' +
      'per link, from the item `parentType`+`parentId` to the linked item `destinationCode` ' +
      '(EP/FT/US/TA/DE/TC/FN-<n>), named by `parentName`. `linkTypeKey` is the link type (see linkTypes). ' +
      'Links whose parent is a TEST CASE or FUNCTION are in tcLinkages.',
    usedFor:
      'What is linked to an item: where parentType + parentId (or follow epics/features/stories/tasks/defects -> ' +
      'linkedIssues). Which items link TO something: where destinationCode (e.g. "TC-7577"); every link is ' +
      'stored on both sides, so this finds all epics/features/stories/tasks/defects linked to it.',
    searchPath: '/pm/linkages/search',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    labelField: 'destinationCode',
    defaultSelect: ['id', 'parentType', 'parentId', 'linkTypeKey', 'destinationCode', 'parentName', 'destinationType', 'destinationId', 'projectId'],
    fields: fields({
      id: ['string', STR],
      parentId: ['number', NUM, { label: 'Item id' }],
      parentType: ['string', CHOICE, { label: 'Item type (EP / FT / US / TA / DE)' }],
      destinationId: ['number', NUM, { label: 'Linked item id' }],
      destinationCode: ['string', CHOICE, { label: 'Linked item code' }],
      destinationType: ['string', CHOICE, { label: 'Linked item type (EP / FT / US / TA / DE / TC / FN)' }],
      parentName: ['string', STR, { label: 'Linked item name' }],
      linkId: ['string', STR, { label: 'Link type id (linkTypes, a uuid)' }],
      linkTypeKey: ['string', CHOICE, { label: 'Link type' }],
      linkType: ['string', CHOICE, { label: 'Direction (inwardType / outwardType)' }],
      jiraIssueKey: ['string', STR],
      projectId: ['number', EQ],
      createdBy: ['number', EQ],
      updatedBy: ['number', EQ],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
    }),
  },

  tcLinkages: {
    name: 'tcLinkages',
    aliases: ['testcase linkages', 'test case links', 'function linkages', 'function links', 'tc linkages'],
    description:
      'Linked issues of TEST CASES (TC) and FUNCTIONS (FN): same row shape as linkages, stored by the test ' +
      'management service. `parentType` TC/FN + `parentId` is the test case / function; `destinationCode` the ' +
      'linked item (any type, including other test cases and functions).',
    usedFor:
      'What a test case or function is linked to (or follow testcases/functions -> linkedIssues); which test ' +
      'cases / functions link TO an item: where destinationCode.',
    searchPath: '/tm/linkages/search',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    labelField: 'destinationCode',
    defaultSelect: ['id', 'parentType', 'parentId', 'linkTypeKey', 'destinationCode', 'parentName', 'destinationType', 'destinationId', 'projectId'],
    fields: fields({
      id: ['string', STR],
      parentId: ['number', NUM, { label: 'Test case / function id' }],
      parentType: ['string', CHOICE, { label: 'TC / FN' }],
      destinationId: ['number', NUM, { label: 'Linked item id' }],
      destinationCode: ['string', CHOICE, { label: 'Linked item code' }],
      destinationType: ['string', CHOICE, { label: 'Linked item type' }],
      parentName: ['string', STR, { label: 'Linked item name' }],
      linkId: ['string', STR, { label: 'Link type id (linkTypes, a uuid)' }],
      linkTypeKey: ['string', CHOICE, { label: 'Link type' }],
      linkType: ['string', CHOICE, { label: 'Direction (inwardType / outwardType)' }],
      projectId: ['number', EQ],
      createdBy: ['number', EQ],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
    }),
  },

  // The configured link types: `/pm/fields/10?fieldType=linkages` (UI linkages.component getDefaultFields).
  linkTypes: {
    name: 'linkTypes',
    aliases: ['link type', 'link types', 'linkage type', 'linkage types', 'relationship types'],
    description:
      'Link types configured for the project (admin -> Fields layout -> Linkages). Each row has an ' +
      '`inwardType` and an `outwardType` ({key, value}, e.g. "is blocked by" / "blocks"); a link row stores ' +
      'the key of one side as `linkTypeKey` and this row id as `linkId`.',
    usedFor: 'Turn a linkTypeKey into its label, or list the link types an item can use.',
    method: 'GET',
    searchPath: '/pm/fields/10?fieldType=linkages&projectId={projectId}',
    scope: 'none',
    softDelete: 'deleted',
    idField: 'id',
    labelField: 'name',
    defaultSelect: ['id', 'name', 'inwardType', 'outwardType'],
    fields: fields({
      id: ['string', STR],
      name: ['string', STR],
      key: ['string', STR],
      inwardType: ['object', [], { label: 'Inward {key, value}' }],
      outwardType: ['object', [], { label: 'Outward {key, value}' }],
      deleted: ['boolean', BOOL],
    }),
  },

  users: {
    name: 'users',
    aliases: ['user', 'people'],
    description: 'Users visible to you (see visibility) — resolve names/emails to numeric ids for owner/createdBy filters.',
    usedFor: 'Look up a person before filtering by ownerId/createdBy/updatedBy; list the members of a project with where:[{field:"projectIds",value:<projectId>}].',
    visibility: 'Only the users who share at least one project with you. An admin sees every user in the account.',
    searchPath: '/pm/users/search',
    scope: 'none',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'username',
    labelField: 'name',
    defaultSelect: ['id', 'name', 'username', 'email', 'active', 'status'],
    fields: fields({
      id: ['number', NUM],
      name: ['string', STR],
      username: ['string', STR],
      email: ['string', STR],
      active: ['boolean', BOOL],
      status: ['string', STR],
      userType: ['string', STR],
      // Members of a project: { field:"projectIds", value:<projectId> }. Not a stored user field — the
      // adapter resolves it from project_user_role (admin, or a member of that project, only).
      projectIds: ['number', NUM, { label: 'Member of project' }],
      createdAt: ['date', DATE],
      deleted: ['boolean', BOOL],
    }),
  },

  objects: {
    name: 'objects',
    aliases: ['object', 'locator', 'object repository'],
    description: 'Object repository — named locators used by test steps.',
    usedFor: 'List/read objects, find by module/technology/template, and resolve parameter references.',
    searchPath: '/tm/object/search',
    getPath: '/tm/object/{id}',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'disname',
    defaultSelect: ['id', 'code', 'disname', 'description', 'moduleId', 'objecttemplateId', 'technology', 'parameterId'],
    fields: fields({
      id: ['number', NUM],
      code: ['string', STR],
      disname: ['string', STR, { label: 'Name' }],
      description: ['string', STR],
      moduleId: ['number', EQ, { label: 'Module' }],
      objecttemplateId: ['number', EQ],
      technology: ['string', STR],
      parameterId: ['number', EQ],
      createdBy: ['number', EQ],
      updatedBy: ['number', EQ],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
      projectId: ['number', EQ],
    }),
    relations: {
      module: {
        kind: 'through', to: 'modules', localField: 'moduleId', remoteField: 'id',
        description: 'The module this object lives in.',
      },
      template: {
        kind: 'through', to: 'objectTemplates', localField: 'objecttemplateId', remoteField: 'id',
        description: 'The technology template for this object.',
      },
      parameter: {
        kind: 'through', to: 'parameters', localField: 'parameterId', remoteField: 'id',
        description: 'The parameter bound to this object (if any).',
      },
    },
  },

  objectTemplates: {
    name: 'objectTemplates',
    aliases: ['objecttemplate', 'templates'],
    description: 'Technology templates (WEB/ANDROID/IOS/...) that define object shape.',
    usedFor: 'Resolve an object technology/template before creating or filtering objects.',
    searchPath: '/tm/objectTemplate/search',
    scope: 'none',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'name',
    defaultSelect: ['id', 'code', 'name', 'disname'],
    fields: fields({
      id: ['number', NUM],
      code: ['string', STR],
      name: ['string', STR],
      disname: ['string', STR],
      createdAt: ['date', DATE],
      deleted: ['boolean', BOOL],
    }),
    relations: {
      objects: {
        kind: 'query', to: 'objects', localField: 'id', remoteField: 'objecttemplateId',
        description: 'Objects using this template.',
      },
    },
  },

  parameters: {
    name: 'parameters',
    aliases: ['parameter', 'param', 'params'],
    description: 'Test-data parameters. Values are bound per iteration in `testdata`.',
    usedFor: 'List/read parameters, filter by module/type, and resolve parameter references.',
    searchPath: '/tm/parameter/search',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'name',
    defaultSelect: ['id', 'code', 'name', 'type', 'parameterType', 'moduleId', 'defaultValue'],
    maxLimit: 1000,
    fields: fields({
      id: ['number', NUM],
      code: ['string', STR],
      name: ['string', STR],
      type: ['string', STR],
      parameterType: ['string', STR],
      moduleId: ['number', EQ, { label: 'Module' }],
      isEncrypted: ['boolean', BOOL],
      protected: ['boolean', BOOL],
      unique: ['boolean', BOOL],
      createdBy: ['number', EQ],
      createdAt: ['date', DATE],
      deleted: ['boolean', BOOL],
      projectId: ['number', EQ],
    }),
    relations: {
      objects: {
        kind: 'query', to: 'objects', localField: 'id', remoteField: 'parameterId',
        description: 'Objects bound to this parameter.',
      },
    },
  },

  actions: {
    name: 'actions',
    aliases: ['action', 'catalog'],
    description: 'Action catalog (click/type/API/...) referenced by test steps via id/uniqueId.',
    usedFor: 'Resolve action ids/uniqueIds when inspecting steps.',
    searchPath: '/tm/action/search',
    scope: 'none',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'uniqueId',
    labelField: 'name',
    defaultSelect: ['id', 'code', 'name', 'disname', 'uniqueId', 'type', 'groupName', 'objectRequired'],
    maxLimit: 1000,
    fields: fields({
      id: ['number', NUM],
      code: ['string', STR],
      name: ['string', STR],
      disname: ['string', STR],
      uniqueId: ['string', STR],
      type: ['string', STR],
      groupName: ['string', STR],
      objectRequired: ['boolean', BOOL],
      deprecated: ['boolean', BOOL],
      projectId: ['number', EQ],
      deleted: ['boolean', BOOL],
    }),
  },

  versions: {
    name: 'versions',
    aliases: ['version', 'tcfnversion'],
    description: 'Version rows for test cases/functions (`parentType` TC/FN).',
    usedFor: 'List/read versions of a test case or function.',
    searchPath: '/tm/tcfnversion/search',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'name',
    labelField: 'name',
    defaultSelect: ['id', 'name', 'parentType', 'parentId', 'executionType', 'reviewApproveStatus'],
    fields: fields({
      id: ['string', STR],
      name: ['string', STR],
      parentType: ['string', STR],
      parentId: ['number', EQ],
      executionType: ['string', STR],
      reviewApproveStatus: ['string', STR],
      createdBy: ['number', EQ],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
      projectId: ['number', EQ],
    }),
  },

  testdata: {
    name: 'testdata',
    aliases: ['test data', 'iteration', 'iterations'],
    description: 'Test-data iteration rows for a test case version + environment; `data[]` maps paramId to value.',
    usedFor: 'Find the actual parameter values used by a run/version/iteration.',
    searchPath: '/tm/testdata/searchItr',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'name',
    labelField: 'name',
    defaultSelect: ['id', 'name', 'testcaseId', 'versionId', 'type', 'environmentType', 'executionType', 'sequenceNo'],
    maxLimit: 1000,
    fields: fields({
      id: ['string', STR],
      name: ['string', STR],
      testcaseId: ['number', EQ, { label: 'Test Case' }],
      versionId: ['string', STR],
      type: ['string', STR],
      environmentType: ['string', STR],
      executionType: ['string', STR],
      sequenceNo: ['number', NUM],
      parentId: ['string', STR],
      createdBy: ['number', EQ],
      createdAt: ['date', DATE],
      deleted: ['boolean', BOOL],
      projectId: ['number', EQ],
    }),
    relations: {
      testcase: {
        kind: 'through', to: 'testcases', localField: 'testcaseId', remoteField: 'id',
        description: 'The test case this iteration belongs to.',
      },
      version: {
        kind: 'through', to: 'versions', localField: 'versionId', remoteField: 'id',
        description: 'The TC version this iteration belongs to.',
      },
    },
  },

  // Fields from test-management `validators/execution-plan.validation.js` (create/update schema);
  // codes are PL-<n> (`utils/sequenceUtil.js`). Not "ep" — that alias is epics.
  executionPlans: {
    name: 'executionPlans',
    aliases: ['executionplan', 'executionplans', 'execution plan', 'execution plans', 'plan', 'plans', 'pl'],
    description: 'Execution plans (PL-…): a planned set of test cases to run, tied to a release/sprint and an environment.',
    usedFor: 'List/count plans by release, sprint, environment or planner, and follow a plan to its runs.',
    searchPath: '/tm/executionplan/search',
    getPath: '/tm/executionplan/{id}',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'name',
    defaultSelect: ['id', 'code', 'name', 'releaseId', 'iterationId', 'environmentType', 'plannedStartDate', 'plannedEndDate'],
    fields: fields({
      id: ['number', NUM],
      code: ['string', STR],
      name: ['string', STR],
      releaseId: ['number', EQ, { label: 'Release' }],
      iterationId: ['number', EQ, { label: 'Sprint' }],
      environmentType: ['string', STR, { label: 'Environment' }],
      teamIds: ['array', ARR, { label: 'Teams' }],
      planners: ['array', ARR, { label: 'Planners' }],
      reviewApproveStatus: ['string', STR],
      autoReExecCount: ['number', NUM],
      autoDefectLog: ['boolean', BOOL],
      terminateOnFailure: ['boolean', BOOL],
      newBrowserSession: ['boolean', BOOL],
      plannedStartDate: ['date', DATE],
      plannedEndDate: ['date', DATE],
      createdBy: ['number', EQ],
      updatedBy: ['number', EQ],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
      projectId: ['number', EQ],
    }),
    relations: {
      executions: {
        kind: 'query', to: 'executions', localField: 'id', remoteField: 'executionTypeId',
        where: { type: 'EXECUTIONPLAN' },
        description: 'Runs of this plan (sort id desc for the latest). `type` is EXECUTIONPLAN on the wire.',
      },
      release: {
        kind: 'through', to: 'releases', localField: 'releaseId', remoteField: 'id',
        description: 'The release this plan belongs to (if any).',
      },
      sprint: {
        kind: 'through', to: 'sprints', localField: 'iterationId', remoteField: 'id',
        description: 'The sprint this plan belongs to (if any).',
      },
      entries: {
        kind: 'query', to: 'planEntries', localField: 'id', remoteField: 'execPlanId',
        description: 'The test cases planned in this plan (one row per test case entry).',
      },
    },
  },

  // The rows inside an execution plan — test-management `execplantestcases`
  // (fields: validators/exec-plan-testcases.validator.js). `code`/`tcName` are the test case's.
  planEntries: {
    name: 'planEntries',
    aliases: ['planentry', 'planentries', 'plan entry', 'plan entries', 'execplantestcases', 'execution plan entry', 'execution plan entries'],
    description: 'Test cases planned inside an execution plan, with the assignee, technology, source and latest result.',
    usedFor: 'Which test cases are in a plan, who they are assigned to, and how each is set to run.',
    searchPath: '/tm/execplantestcases/search',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'tcName',
    defaultSelect: ['id', 'code', 'tcName', 'execPlanId', 'testcaseId', 'tcType', 'executionType', 'expAssignedTo', 'status', 'result'],
    fields: fields({
      id: ['string', EQ],
      code: ['string', STR, { label: 'Test case code' }],
      tcName: ['string', STR, { label: 'Test case name' }],
      tcDesc: ['string', STR],
      execPlanId: ['number', EQ, { label: 'Execution plan' }],
      testcaseId: ['number', EQ, { label: 'Test case' }],
      tcVersionId: ['string', EQ],
      stepId: ['string', EQ],
      tcType: TC_TYPE,
      executionType: EXECUTION_TYPE,
      expAssignedTo: ['number', EQ, { label: 'Assigned to' }],
      expAssignedDate: ['date', DATE],
      sourceType: ['string', CHOICE, { resolve: 'enum', enumValues: ['scenario', 'suite', 'testcase', 'module', 'userstory'] }],
      sourceId: ['number', EQ],
      moduleId: ['number', EQ, { label: 'Module' }],
      status: ['string', STR],
      result: ['string', STR],
      seq: ['number', NUM],
      executionId: ['number', EQ],
      createdBy: ['number', EQ],
      updatedBy: ['number', EQ],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
      projectId: ['number', EQ],
    }),
    relations: {
      plan: { kind: 'through', to: 'executionPlans', localField: 'execPlanId', remoteField: 'id', description: 'The plan this entry belongs to.' },
      testcase: { kind: 'through', to: 'testcases', localField: 'testcaseId', remoteField: 'id', description: 'The planned test case.' },
    },
  },

  // pipelines service `pipelines` collection; codes from its sequence util.
  pipelines: {
    name: 'pipelines',
    aliases: ['pipeline', 'pipelines', 'pipline', 'piplines'],
    description: 'CI/CD pipelines that run a test case, suite or execution plan (pipelineType TC / SU / EP).',
    usedFor: 'List pipelines by type, mode, environment, release or sprint.',
    searchPath: '/pl/pipelines/search',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'name',
    defaultSelect: ['id', 'code', 'name', 'pipelineType', 'executionMode', 'executionStyle', 'environment', 'status'],
    fields: fields({
      id: ['number', NUM],
      code: ['string', STR],
      name: ['string', STR],
      pipelineType: ['string', CHOICE, { resolve: 'enum', enumValues: ['TC', 'SU', 'EP'] }],
      executionMode: ['string', CHOICE, { resolve: 'enum', enumValues: ['cloud', 'local'] }],
      executionStyle: ['string', CHOICE, { resolve: 'enum', enumValues: ['serial', 'parallel'] }],
      mode: ['string', CHOICE, { resolve: 'enum', enumValues: ['VM', 'AZURE'] }],
      status: ['string', STR],
      'platForm.name': ['string', STR, { label: 'Platform' }],
      environment: ['string', STR],
      releaseId: ['number', EQ, { label: 'Release' }],
      iterationId: ['number', EQ, { label: 'Sprint' }],
      createdBy: ['number', EQ],
      updatedBy: ['number', EQ],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
      projectId: ['number', EQ],
    }),
  },

  // test-management `runtime_parameters`: one row per key (validators: key, value, projectId).
  runtimeParameters: {
    name: 'runtimeParameters',
    aliases: ['runtimeparameter', 'runtimeparameters', 'runtime parameter', 'runtime parameters', 'runtime param', 'runtime params'],
    description: 'Project runtime parameters — key/value pairs available to every run.',
    usedFor: 'Look up a runtime parameter by key, or list them.',
    searchPath: '/tm/runtime_parameters/search',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'key',
    labelField: 'key',
    defaultSelect: ['id', 'key', 'value'],
    fields: fields({
      id: ['string', EQ],
      key: ['string', STR],
      value: ['string', STR],
      createdBy: ['number', EQ],
      updatedBy: ['number', EQ],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
      projectId: ['number', EQ],
    }),
  },

  // scheduler service `scheduler` (validators/schedulerValidation.js).
  schedules: {
    name: 'schedules',
    aliases: ['schedule', 'schedules', 'scheduler', 'schedulers'],
    description: 'Scheduled runs of a test case, suite or plan (schedulerType TC / SU / EP) with recurrence and last result.',
    usedFor: 'Which schedules exist, when they run next, and how their last run went.',
    searchPath: '/sh/scheduler/search',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'name',
    defaultSelect: ['id', 'code', 'name', 'schedulerType', 'recurrenceType', 'status', 'nextRecurrenceTime', 'lastExecutionTime', 'lastExecutionStatus', 'createdBy'],
    fields: fields({
      id: ['number', NUM],
      code: ['string', STR],
      name: ['string', STR],
      schedulerType: ['string', CHOICE, { resolve: 'enum', enumValues: ['TC', 'SU', 'EP'] }],
      recurrenceType: ['string', CHOICE, { resolve: 'enum', enumValues: ['ONCE', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'EVERY_5_MINUTES'] }],
      status: ['string', CHOICE, { resolve: 'enum', enumValues: ['NOT STARTED', 'AWAITING NEXT RUN', 'QUEUED', 'COMPLETED', 'CANCELLED'] }],
      lastExecutionStatus: ['string', CHOICE, { resolve: 'enum', enumValues: ['PASSED', 'FAILED'] }],
      lastExecutionId: ['number', EQ],
      lastFailureReason: ['string', STR],
      executionMode: ['string', CHOICE, { resolve: 'enum', enumValues: ['local', 'cloud'] }],
      executionStyle: ['string', CHOICE, { resolve: 'enum', enumValues: ['serial', 'parallel'] }],
      mode: ['string', CHOICE, { resolve: 'enum', enumValues: ['VM', 'AZURE'] }],
      'platForm.technologyType': ['string', STR, { label: 'Technology' }],
      'platForm.name': ['string', STR, { label: 'Platform' }],
      environment: ['string', STR],
      releaseId: ['number', EQ, { label: 'Release' }],
      iterationId: ['number', EQ, { label: 'Sprint' }],
      parentCode: ['string', STR, { label: 'Scheduled item code' }],
      parentName: ['string', STR, { label: 'Scheduled item name' }],
      cancelled: ['boolean', BOOL],
      'retryConfig.retryEnabled': ['boolean', BOOL],
      nextRecurrenceTime: ['date', DATE],
      lastExecutionTime: ['date', DATE],
      scheduleStartDate: ['date', DATE],
      scheduleEndDate: ['date', DATE],
      createdBy: ['number', EQ],
      updatedBy: ['number', EQ],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
      projectId: ['number', EQ],
    }),
    relations: {
      history: {
        kind: 'query', to: 'scheduleHistory', localField: 'id', remoteField: 'id',
        description: 'Audit history of this schedule (created, triggered, completed, failed …).',
      },
    },
  },

  // scheduler `scheduler_history`: each row is a SNAPSHOT of the schedule (same `id`) plus the event
  // in `_audit` (queue/schedulerQueue.js createAuditEntry).
  scheduleHistory: {
    name: 'scheduleHistory',
    aliases: ['schedulehistory', 'schedule history', 'scheduler history', 'schedule runs'],
    description: 'History of SCHEDULER runs only: one row per schedule event (a snapshot of the schedule + `_audit`). ' +
      'NOT the application activity / audit log (who did what, logins, user changes) — that is not available here; ' +
      'never use this collection to answer an activity-log question.',
    usedFor: 'When a schedule last triggered, failed or completed, and why.',
    searchPath: '/sh/scheduler_history/search',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'name',
    defaultSelect: ['id', 'code', 'name', 'status', 'lastFailureReason', '_audit'],
    fields: fields({
      id: ['number', EQ, { label: 'Schedule id' }],
      code: ['string', STR],
      name: ['string', STR],
      status: ['string', STR],
      lastFailureReason: ['string', STR],
      '_audit.event': ['string', STR, { label: 'Event' }],
      '_audit.source': ['string', STR],
      '_audit.reason': ['string', STR],
      '_audit.timestamp': ['date', DATE, { label: 'When' }],
      '_audit.recurrenceTime': ['date', DATE],
      projectId: ['number', EQ],
    }),
  },

  // test-management `scenarioFolder` (validators/scenario*.js); codes TP-<n>.
  testPlans: {
    name: 'testPlans',
    aliases: ['testplan', 'testplans', 'test plan', 'test plans', 'scenario', 'scenarios', 'scenario folder'],
    description: 'Test plans (TP-…): a folder tree of suites and test cases.',
    usedFor: 'List test plans, walk the folder tree, and see which suites / test cases a plan holds.',
    searchPath: '/tm/scenario/search',
    getPath: '/tm/scenario/{id}',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'name',
    defaultSelect: ['id', 'code', 'name', 'isRoot', 'parentId', 'childIds', 'suiteIds', 'createdBy', 'updatedAt'],
    // A test plan is a TOP-LEVEL folder: counting every folder said 26 plans where the project has
    // 16 (ai-assistant list_test_plans). Asking about specific folders, sub-folders or membership
    // ("which test plan holds TC-X") sees every folder.
    defaultFilter: {
      where: { isRoot: true },
      unless: ['isRoot', 'id', 'code', 'parentId', 'parentIds', 'childIds', 'leafNode', 'suiteIds', 'testcaseIds.id'],
    },
    folderTree: true,
    fields: fields({
      id: ['number', NUM],
      code: ['string', STR],
      name: ['string', STR],
      isRoot: ['boolean', BOOL],
      leafNode: ['boolean', BOOL],
      parentId: ['number', EQ, { label: 'Parent folder' }],
      parentIds: ['array', ARR],
      childIds: ['array', ARR],
      suiteIds: ['array', ARR, { label: 'Suites' }],
      'testcaseIds.id': ['array', ARR, { label: 'Test cases' }],
      createdBy: ['number', EQ],
      updatedBy: ['number', EQ],
      createdAt: ['date', DATE],
      updatedAt: ['date', DATE],
      deleted: ['boolean', BOOL],
      projectId: ['number', EQ],
    }),
    relations: {
      children: {
        kind: 'through', to: 'testPlans', localField: 'id', remoteField: 'id', tree: 'children',
        description: 'Direct sub-folders (read from both childIds and parentId).',
      },
      suites: { kind: 'through', to: 'suites', localField: 'suiteIds', remoteField: 'id', description: 'Suites filed directly in this folder.' },
      testcases: { kind: 'through', to: 'testcases', localField: 'testcaseIds[].id', remoteField: 'id', description: 'Test cases filed directly in this folder.' },
      allSuites: {
        kind: 'through', to: 'suites', localField: 'suiteIds', remoteField: 'id', tree: 'subtree',
        description: 'Suites in this folder AND every sub-folder below it (what the plan holds).',
      },
      allTestcases: {
        kind: 'through', to: 'testcases', localField: 'testcaseIds[].id', remoteField: 'id', tree: 'subtree',
        description: 'Test cases in this folder AND every sub-folder below it (what the plan holds).',
      },
    },
  },

  // project-management `tags`: one row PER TAGGING — one label name is many rows (ids), so a
  // label is matched by name, never by a single id. Fields: validators/label*.js.
  tags: {
    name: 'tags',
    aliases: ['tag', 'label', 'labels'],
    description: 'Labels (tags). One label is stored as many rows — one per tagging — sharing its name.',
    usedFor: 'List the labels in use; work items reference them by id in `tags`.',
    searchPath: '/pm/tags/search',
    getPath: '/pm/tags/{id}',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    labelField: 'name',
    defaultSelect: ['id', 'name', 'color'],
    fields: fields({
      id: ['number', NUM],
      name: ['string', STR],
      color: ['string', STR],
      createdBy: ['number', EQ],
      createdAt: ['date', DATE],
      deleted: ['boolean', BOOL],
      projectId: ['number', EQ],
    }),
  },

  // project-management `team`: customer-wide (no project field); codes TM-<n>. Fields: validators/team*.js.
  teams: {
    name: 'teams',
    aliases: ['team'],
    description: 'Teams (TM-…): named groups of users, customer-wide. Work items and plans reference them in `teamIds`.',
    usedFor: 'Who is in a team, and resolving a team name for a `teamIds` filter.',
    searchPath: '/pm/team/search',
    scope: 'none',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'name',
    defaultSelect: ['id', 'code', 'name', 'users', 'description'],
    fields: fields({
      id: ['number', NUM],
      code: ['string', STR],
      name: ['string', STR],
      users: ['array', ARR, { label: 'Members' }],
      description: ['string', STR],
      jiraTeamId: ['string', STR],
      createdBy: ['number', EQ],
      createdAt: ['date', DATE],
      deleted: ['boolean', BOOL],
    }),
  },

  groups: {
    name: 'groups',
    aliases: ['group', 'email group', 'email groups'],
    description: 'Email recipient groups, per project: SimplifyQA users plus outside contacts (non-users).',
    usedFor: 'Who is in an email group used by the share / email dialog on work items and test assets.',
    searchPath: '/pm/group/search',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    labelField: 'name',
    defaultSelect: ['id', 'name', 'users', 'nonUsers'],
    fields: fields({
      id: ['number', NUM],
      name: ['string', STR],
      users: ['array', ARR, { label: 'Members' }],
      nonUsers: ['array', ARR, { label: 'Outside contacts' }],
      createdBy: ['number', EQ],
      createdAt: ['date', DATE],
      deleted: ['boolean', BOOL],
    }),
    relations: {
      members: {
        kind: 'through', to: 'users', localField: 'users',
        description: 'The SimplifyQA users in this group.',
      },
    },
  },

  businessUnits: {
    name: 'businessUnits',
    aliases: ['businessUnit', 'business unit', 'business units', 'bu'],
    description: 'Business units of the tenant (customer-wide). Projects belong to one via `businessUnitId`. ' +
      'A plain list also shows "Default Business Unit" (id null) when some of YOUR projects have none, as the ' +
      'header does; its projects: op:"related", id:"default", relation:"projects".',
    usedFor: 'List business units and the projects in each.',
    searchPath: '/pm/business_unit/search',
    scope: 'none',
    softDelete: 'deleted',
    idField: 'id',
    labelField: 'name',
    defaultSelect: ['id', 'name', 'description'],
    fields: fields({
      id: ['number', NUM],
      name: ['string', STR],
      description: ['string', STR],
      createdBy: ['number', EQ],
      createdAt: ['date', DATE],
      deleted: ['boolean', BOOL],
    }),
    relations: {
      projects: {
        kind: 'query', to: 'projects', localField: 'id', remoteField: 'businessUnitId',
        description: 'Projects in this business unit.',
      },
    },
  },

  executions: {
    name: 'executions',
    aliases: ['execution', 'run', 'runs'],
    description: 'Run headers for suites/test cases/execution plans, with status/result and embedded execution items. '
      + 'Lists PARENT runs only, as Reports v2 does: an EP\'s suite runs and cloud stack chunks (childExecution:true) and '
      + 're-execution snapshots (parentExecutionCopy:true) are hidden unless a filter names childExecution / '
      + 'parentExecutionId / parentExecutionCopy, the lookup is by id/code, or includeHidden is set. '
      + 'Use relation "children" for a parent\'s child runs.',
    usedFor: 'Find the latest run, inspect status/results, and follow a run to its step results.',
    searchPath: '/exec/execution/search',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'code',
    labelField: 'code',
    defaultSelect: ['id', 'code', 'type', 'executionTypeId', 'status', 'result', 'executionCategory', 'mode', 'environmentType', 'iterationId', 'releaseId', 'childExecution', 'parentExecutionId', 'startTime', 'endTime'],
    // Same rows as the Reports v2 list (reports.controller getReports, current-executions-v2):
    // `$nor {childExecution:true}` and `$nor {parentExecutionCopy:true}` keep false AND missing.
    hiddenUnlessAsked: [
      { field: 'childExecution', askedBy: ['parentExecutionId', 'id', 'code'] },
      { field: 'parentExecutionCopy', askedBy: ['oldId', 'id', 'code'] },
    ],
    fields: fields({
      id: ['number', NUM],
      code: ['string', STR],
      // Live values: TESTCASE | SUITE | EXECUTIONPLAN | WORKFLOWBUILDER (not "TC").
      type: ['string', STR, { label: 'Type (TESTCASE | SUITE | EXECUTIONPLAN | WORKFLOWBUILDER)' }],
      executionTypeId: ['number', EQ],
      status: ['string', STR],
      result: ['string', STR],
      executionCategory: ['string', STR],
      mode: ['string', STR],
      environmentType: ['string', STR],
      iterationId: ['number', EQ],
      releaseId: ['number', EQ],
      agentId: ['number', EQ],
      childExecution: ['boolean', BOOL],
      parentExecutionId: ['number', EQ],
      parentExecutionCopy: ['boolean', BOOL, { label: 'Re-execution snapshot of a parent run' }],
      oldId: ['number', EQ, { label: 'Original run id (on a parentExecutionCopy row)' }],
      executionType: ['string', STR],
      startTime: ['date', DATE],
      endTime: ['date', DATE],
      createdBy: ['number', EQ],
      createdAt: ['date', DATE],
      deleted: ['boolean', BOOL],
      projectId: ['number', EQ],
    }),
    relations: {
      steps: {
        kind: 'subresource', localField: 'id',
        subresourcePath: '/reports/execution/getstepResult',
        description: 'Per-step results for this run (executionId/executionRunId/parentId).',
      },
      children: {
        kind: 'query', to: 'executions', localField: 'id', remoteField: 'parentExecutionId',
        description: 'Child runs of a parent run: an execution plan\'s suite runs, cloud stack chunks.',
      },
    },
  },

  machineResources: {
    name: 'machineResources',
    aliases: ['cloud runners', 'runners', 'cloud'],
    description: 'Cloud runner machines available for execution.',
    usedFor: 'Pick a cloud runner for a run.',
    searchPath: '/pm/machineResources/search',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'id',
    labelField: 'displayName',
    defaultSelect: ['id', 'displayName', 'name', 'status', 'type', 'parentId'],
    fields: fields({
      id: ['number', NUM],
      displayName: ['string', STR],
      name: ['string', STR],
      status: ['string', STR],
      type: ['string', STR],
      parentId: ['number', EQ],
      projectId: ['number', EQ],
    }),
  },

  machineRegistration: {
    name: 'machineRegistration',
    aliases: ['local agents', 'agents', 'machines'],
    description: 'Registered local agents (machines) that can execute runs.',
    usedFor: 'Pick a local/remote agent for a run.',
    searchPath: '/tm/machineRegistration/search',
    scope: 'none',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'machineName',
    labelField: 'machineName',
    defaultSelect: ['id', 'machineName', 'systemName', 'platform', 'ipAddress', 'macAddress', 'active'],
    fields: fields({
      // Live ids are 32-char hex strings, not numbers.
      id: ['string', STR],
      machineName: ['string', STR],
      systemName: ['string', STR],
      platform: ['string', STR],
      ipAddress: ['string', STR],
      macAddress: ['string', STR],
      active: ['boolean', BOOL],
      deleted: ['boolean', BOOL],
    }),
  },

  mobileDevices: {
    name: 'mobileDevices',
    aliases: ['devices', 'mobile', 'emulators'],
    description: 'Real devices, emulators and simulators registered for mobile execution.',
    usedFor: 'Pick a device for an ANDROID/IOS run.',
    searchPath: '/tm/mobileDevices/search',
    scope: 'project',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'deviceId',
    labelField: 'deviceName',
    defaultSelect: ['id', 'deviceId', 'deviceName', 'deviceType', 'osVersion', 'technologyType', 'agentId', 'active'],
    fields: fields({
      // Live ids are UUIDs, not numbers.
      id: ['string', STR],
      deviceId: ['string', STR],
      deviceName: ['string', STR],
      deviceType: ['string', STR],
      osVersion: ['string', STR],
      technologyType: ['string', STR],
      agentId: ['number', EQ],
      active: ['boolean', BOOL],
      createdAt: ['date', DATE],
      deleted: ['boolean', BOOL],
      projectId: ['number', EQ],
    }),
  },

  environments: {
    name: 'environments',
    aliases: ['environment', 'env', 'envs'],
    description: 'Environment keys used by test data (`general` is the default).',
    usedFor: 'Pick an environment when reading/writing test data.',
    method: 'GET',
    searchPath: '/pm/fields/8?fieldType=environment&projectId={projectId}',
    scope: 'none',
    softDelete: 'deleted',
    idField: 'id',
    keyField: 'key',
    labelField: 'name',
    defaultSelect: ['id', 'key', 'name'],
    fields: fields({
      id: ['string', STR],
      key: ['string', STR],
      name: ['string', STR],
      deleted: ['boolean', BOOL],
    }),
  },
};

// ---------------------------------------------------------------------------
// Reference fields — which stored ids can be named by name, code or "me" (resolve:'ref').
// Same field name means the same target on every collection listed, so it is declared once.
// ---------------------------------------------------------------------------

const REF_FIELDS: Record<string, string> = {
  createdBy: 'users',
  updatedBy: 'users',
  ownerId: 'users',
  moduleId: 'modules',
  releaseId: 'releases',
  iterationId: 'sprints',
  tags: 'tags',
  userstoryId: 'stories',
  epicId: 'epics',
  featureId: 'features',
  defectId: 'defects',
  'selectedTestCase.testcaseId': 'testcases',
  'testCases.testcaseId': 'testcases',
  planners: 'users',
  expAssignedTo: 'users',
  users: 'users',
  teamIds: 'teams', // execution plans
  teamId: 'teams', // stories / epics / features (an array, despite the name)
  execPlanId: 'executionPlans',
  testcaseId: 'testcases',
  suiteIds: 'suites',
  'testcaseIds.id': 'testcases',
};
const REF_COLLECTIONS = [
  'testcases', 'functions', 'suites', 'stories', 'epics', 'features', 'defects', 'tasks', 'executionPlans',
  'planEntries', 'pipelines', 'schedules', 'testPlans', 'teams',
];

for (const name of REF_COLLECTIONS) {
  for (const f of Object.values(SQA_COLLECTIONS[name]!.fields)) {
    const refTo = REF_FIELDS[f.key];
    if (refTo) Object.assign(f, { resolve: 'ref', refTo });
  }
}

// ---------------------------------------------------------------------------
// Lookup helpers.
// ---------------------------------------------------------------------------

const ALIAS_INDEX: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const c of Object.values(SQA_COLLECTIONS)) {
    out[c.name.toLowerCase()] = c.name;
    for (const a of c.aliases) out[a.toLowerCase()] = c.name;
  }
  return out;
})();

export function resolveCollection(name: string): SqaCollection | undefined {
  const canonical = ALIAS_INDEX[name.trim().toLowerCase()];
  return canonical ? SQA_COLLECTIONS[canonical] : undefined;
}

export function collectionNames(): string[] {
  return Object.keys(SQA_COLLECTIONS);
}
