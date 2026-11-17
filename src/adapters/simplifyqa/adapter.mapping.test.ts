import { SimplifyQaAdapter } from './adapter.js';

/** Row MAPPING — the raw SQA wire rows projected onto the neutral types the tools speak.
 *
 *  Each test drives a real adapter read method (the list and get calls), asserts the search payload it compiled
 *  AND the neutral value it produced. Shapes are the ones the backend really returns: business keys
 *  in `code`, dot-notation columns (`selectedTestCase.testcaseId`), arrays where the neutral model has
 *  a single string, snake_case image refs, and plenty of missing fields. */

type Reply = { status?: number; body: string };
type Handler = (url: string, init: RequestInit) => Reply | undefined;
type Call = { method: string; url: string; body: any; headers: Record<string, unknown> };

const ME = { userDetails: { id: 36, username: 'qa.user', email: 'qa.user@x.test', userType: 'user' } };
const ROLES = { data: [{ userId: 36, projectId: 7, roleId: 2, deleted: false }] };

function makeAdapter(handler: Handler = () => undefined) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    let body: any;
    if (typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ method, url, body, headers: (init.headers ?? {}) as Record<string, unknown> });

    const out = handler(url, init);
    if (out) return response(out);
    if (url.includes('/pm/auth/me')) return response({ body: JSON.stringify(ME) });
    if (url.includes('/pm/projectuserrole?userId=')) return response({ body: JSON.stringify(ROLES) });
    return response({ status: 404, body: JSON.stringify({ message: `unexpected ${method} ${url}` }) });
  }) as unknown as typeof fetch;

  const adapter = new SimplifyQaAdapter(
    { baseUrl: 'https://x.test', token: 't', projectId: '7' } as any,
    { fetchImpl, FormDataImpl: FormData },
  );
  return { adapter, calls };
}

function response({ status = 200, body }: Reply) {
  return { ok: status < 300, status, text: async () => body };
}

const post = (calls: Call[], path: string) => calls.filter((c) => c.method === 'POST' && c.url.endsWith(path));
const get = (calls: Call[], path: string) => calls.filter((c) => c.method === 'GET' && c.url.endsWith(path));
const col = (body: any, column: string) => (body.searchFields ?? []).find((f: any) => f.column === column);

// ---------------------------------------------------------------------------- test cases

test('listTestCases compiles filters and maps rows to neutral summaries', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.endsWith('/tm/testcase/search')) {
      return { body: JSON.stringify({ data: [
        { id: 41, code: 'TC_41', name: 'Checkout', tcType: 'WEB', executionType: 'AUTOMATION', obsolete: false },
        { id: 42, tcType: 'API' }, // no code, no name — must not invent either
      ], totalCount: 2 }) };
    }
    return undefined;
  });

  const rows = await adapter.listTestCases({
    search: 'checkout',
    createdBy: 'me',
    storyId: 'US_12',
    moduleId: 'MOD_3',
    obsolete: false,
    limit: 10,
    offset: 20,
  });

  expect(rows).toHaveLength(2);
  expect(rows.totalCount).toBe(2);
  expect(rows[0]).toEqual({
    id: '41', code: 'TC_41', title: 'Checkout', technologyType: 'WEB', executionType: 'AUTOMATION', obsolete: false,
  });
  expect(rows[1]).toEqual({ id: '42', title: '', technologyType: 'API' });

  const body = post(calls, '/tm/testcase/search')[0]!.body;
  expect(col(body, 'deleted')).toEqual({ column: 'deleted', value: false });
  expect(col(body, 'projectId')).toEqual({ column: 'projectId', value: 7 });
  expect(col(body, 'name')).toEqual({ column: 'name', value: 'checkout', regEx: true });
  // "me" is resolved to the caller's own id; business keys are reduced to their numeric id.
  expect(col(body, 'createdBy')).toEqual({ column: 'createdBy', value: 36 });
  expect(col(body, 'userstoryId')).toEqual({ column: 'userstoryId', value: 12 });
  expect(col(body, 'moduleId')).toEqual({ column: 'moduleId', value: 3 });
  expect(col(body, 'obsolete')).toEqual({ column: 'obsolete', value: false });
  expect(body.startIndex).toBe(20);
  expect(body.skipStartIndex).toBe(1);
  expect(body.limit).toBe(10);
  expect(body.selectFields).toEqual(['id', 'code', 'name', 'tcType', 'executionType', 'obsolete']);
});

test('listTestCases refuses the columns SQA test cases do not have, without a request', async () => {
  const { adapter, calls } = makeAdapter();

  await expect(adapter.listTestCases({ status: 'passed' })).rejects.toThrow(/no `status` field/);
  await expect(adapter.listTestCases({ filters: [{ column: 'priority', value: 'HIGH' }] as any }))
    .rejects.toThrow(/no `priority` field/);

  expect(post(calls, '/tm/testcase/search')).toHaveLength(0);
});

// ---------------------------------------------------------------------------- stories

test('listStories maps the sprint column (iterationId) and reads the neutral keys off the row', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.endsWith('/pm/userstory/search')) {
      return { body: JSON.stringify({ data: [
        { id: 5, code: 'US_5', name: 'Login', state: 'DEFINED', priority: 'HIGH', iterationId: 3 },
        { id: 6, state: 'ACCEPTED' },
      ], totalCount: 2 }) };
    }
    return undefined;
  });

  const rows = await adapter.listStories({
    search: 'login', sprintId: '3', releaseId: '9', createdBy: '36', ownerId: 'me',
  });

  expect(rows[0]).toEqual({ id: '5', key: 'US_5', title: 'Login', status: 'DEFINED', priority: 'HIGH' });
  expect(rows[1]).toEqual({ id: '6', title: '', status: 'ACCEPTED' });

  const body = post(calls, '/pm/userstory/search')[0]!.body;
  // Neutral `sprintId` is SQA's `iterationId`; nothing named sprintId may reach the wire.
  expect(col(body, 'iterationId')).toEqual({ column: 'iterationId', value: 3 });
  expect(col(body, 'sprintId')).toBeUndefined();
  expect(col(body, 'releaseId')).toEqual({ column: 'releaseId', value: 9 });
  expect(col(body, 'ownerId')).toEqual({ column: 'ownerId', value: 36 });
  expect(col(body, 'name')).toEqual({ column: 'name', value: 'login', regEx: true });
  expect(body.limit).toBe(50);
});

test('getStory splits acceptance criteria, surfaces parent links, and resolves a business key', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.endsWith('/pm/userstory/search')) {
      // Only the US_404 probe finds nothing; US_12 is fetched by the key in the URL below.
      return { body: JSON.stringify({ data: [] }) };
    }
    if (url.endsWith('/pm/userstory/12')) {
      return { body: JSON.stringify({ data: {
        id: 12, code: 'US-12', name: 'Checkout', description: 'As a buyer',
        acceptanceCriteria: '<p>AC one</p><p>AC two</p>',
        iterationId: 3, releaseId: 9, epicId: 1, featureId: 2,
      } }) };
    }
    return undefined;
  });

  const story = await adapter.getStory('12');

  expect(story).toMatchObject({
    id: '12', key: 'US-12', title: 'Checkout', description: 'As a buyer',
    sprintId: '3', releaseId: '9', epicId: '1', featureId: '2',
  });
  expect(story.acceptanceCriteria).toEqual(['AC one', 'AC two']);
  expect(get(calls, '/pm/userstory/12')).toHaveLength(1);

  await expect(adapter.getStory('US_404')).rejects.toThrow(/Story not found for business key: US_404/);
});

// ---------------------------------------------------------------------------- epics + features

test('epics and features map their scope column and business key, on list and full read', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.endsWith('/pm/epic/search')) {
      if (colIn(calls, url, 'code')) return { body: JSON.stringify({ data: [{ id: 9, code: 'EP_9' }] }) };
      return { body: JSON.stringify({ data: [
        { id: 9, code: 'EP_9', name: 'Auth', state: 'DEFINED' },
        { id: 10 },
      ], totalCount: 2 }) };
    }
    if (url.endsWith('/pm/epic/9')) {
      return { body: JSON.stringify({ data: {
        id: 9, code: 'EP_9', name: 'Auth', state: 'DEFINED', description: 'All auth work',
        estimatedEffort: 40, ownerId: 36, plannedStartDate: '2026-01-01', plannedEndDate: '2026-03-01',
      } }) };
    }
    if (url.endsWith('/pm/feature/search')) {
      return { body: JSON.stringify({ data: [
        { id: 21, code: 'FT_21', name: 'Login', state: 'DEFINED', priority: 'HIGH', epicId: 9 },
        { id: 22 },
      ] }) };
    }
    if (url.endsWith('/pm/feature/21')) {
      return { body: JSON.stringify({ data: {
        id: 21, code: 'FT_21', name: 'Login', state: 'DEFINED', priority: 'HIGH', epicId: 9,
        estimatedEffort: 8, ownerId: 36,
      } }) };
    }
    return undefined;
  });

  const epics = await adapter.listEpics({ search: 'auth', state: 'DEFINED', createdBy: '36' });
  expect(epics[0]).toEqual({ id: '9', key: 'EP_9', name: 'Auth', state: 'DEFINED' });
  expect(epics[1]).toEqual({ id: '10', name: '' });
  // Epics are multi-project: the scope column is projectIds, not projectId.
  const epicBody = post(calls, '/pm/epic/search')[0]!.body;
  expect(col(epicBody, 'projectIds')).toEqual({ column: 'projectIds', value: 7 });
  expect(col(epicBody, 'projectId')).toBeUndefined();
  expect(col(epicBody, 'state')).toEqual({ column: 'state', value: 'DEFINED' });

  const epic = await adapter.getEpic('EP_9');
  expect(epic).toMatchObject({
    id: '9', key: 'EP_9', name: 'Auth', state: 'DEFINED', description: 'All auth work',
    estimatedEffort: 40, ownerId: 36, plannedStartDate: '2026-01-01', plannedEndDate: '2026-03-01',
  });
  expect(get(calls, '/pm/epic/9')).toHaveLength(1);

  const features = await adapter.listFeatures({ epicId: '9', search: 'log' });
  expect(features[0]).toEqual({ id: '21', key: 'FT_21', name: 'Login', state: 'DEFINED', priority: 'HIGH', epicId: '9' });
  expect(features[1]).toEqual({ id: '22', name: '' });
  const featureBody = post(calls, '/pm/feature/search')[0]!.body;
  expect(col(featureBody, 'epicId')).toEqual({ column: 'epicId', value: 9 });

  const feature = await adapter.getFeature('21');
  expect(feature).toMatchObject({ id: '21', key: 'FT_21', name: 'Login', priority: 'HIGH', epicId: '9', estimatedEffort: 8 });
});

/** Did the request just made for this URL carry a `code` filter? (epic list vs epic key lookup) */
function colIn(calls: Call[], url: string, column: string): boolean {
  const last = calls.filter((c) => c.url.endsWith(url)).at(-1);
  return !!last?.body?.searchFields?.some((f: any) => f.column === column);
}

// ---------------------------------------------------------------------------- suites

test('suites expose member count and, on a full read, members in their numbered order', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.endsWith('/tm/suites/search')) {
      return { body: JSON.stringify({ data: [
        { id: 5, name: 'Smoke', suiteType: 'AUTOMATION', lastSelectedExecutionType: 'automation', testCases: [{}, {}, {}] },
        { id: 6, suiteName: 'Manual set', executionType: 'manual' },
      ] }) };
    }
    if (url.endsWith('/tm/suites/5')) {
      return { body: JSON.stringify({ data: {
        id: 5, name: 'Smoke', description: 'Fast checks', lastSelectedExecutionType: 'automation',
        testCases: [{ testcaseId: 41, seq: 2 }, { id: 42 }, { _id: 43 }],
      } }) };
    }
    return undefined;
  });

  const suites = await adapter.listSuites();
  expect(suites[0]).toEqual({ id: '5', name: 'Smoke', memberCount: 3, suiteType: 'AUTOMATION', executionType: 'AUTOMATION' });
  // No testCases array → no memberCount at all (not 0); executionType is normalised to upper case.
  expect(suites[1]).toEqual({ id: '6', name: 'Manual set', executionType: 'MANUAL' });
  expect(post(calls, '/tm/suites/search')[0]!.body.limit).toBe(100);

  const suite = await adapter.getSuite('SU_5');
  expect(suite).toEqual({
    id: '5',
    name: 'Smoke',
    description: 'Fast checks',
    executionType: 'AUTOMATION',
    // seq wins where the row has one; otherwise the position in the array is the order.
    members: [{ tcId: '41', order: 2 }, { tcId: '42', order: 2 }, { tcId: '43', order: 3 }],
  });
  // The business key was stripped to its numeric segment before the GET.
  expect(get(calls, '/tm/suites/5')).toHaveLength(1);
});

// ---------------------------------------------------------------------------- modules

test('listModules pages past 100 rows and normalises parent/child ids', async () => {
  const { adapter, calls } = makeAdapter((url, init) => {
    if (!url.endsWith('/pm/module/search')) return undefined;
    const body = JSON.parse(String(init.body));
    if (body.startIndex === 0) {
      return { body: JSON.stringify({ data: Array.from({ length: 100 }, (_, i) => ({
        id: i + 1, name: `M${i + 1}`, isRoot: i === 0, parentId: i === 0 ? 0 : 1,
      })), totalCount: 102 }) };
    }
    return { body: JSON.stringify({ data: [
      { id: 101, name: 'A', parentId: 1, childIds: [102, 'x', 103] },
      { id: 102, name: 'B', parentId: '0', childIds: null },
    ], totalCount: 102 }) };
  });

  const modules = await adapter.listModules();

  expect(modules).toHaveLength(102);
  expect(modules.totalCount).toBe(102);
  // Root: parentId 0 is "no parent" and is dropped; the flags that are present are carried.
  expect(modules[0]).toEqual({ id: '1', name: 'M1', isRoot: true });
  // Non-numeric child ids are discarded; a missing childIds array stays absent.
  expect(modules[100]).toEqual({ id: '101', name: 'A', parentId: '1', childIds: [102, 103] });
  expect(modules[101]).toEqual({ id: '102', name: 'B' });

  const searches = post(calls, '/pm/module/search');
  expect(searches).toHaveLength(2); // stopped at the short page — no third request
  expect(searches[1]!.body.startIndex).toBe(100);
  expect(searches[0]!.body.limit).toBe(100);
  expect(searches[0]!.body.selectFields).toEqual(['id', 'code', 'name', 'parentId', 'isRoot', 'childIds']);
});

test('getModule reads the array response and reports an empty one as not found', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.endsWith('/pm/module/9')) {
      return { body: JSON.stringify([{ id: 9, code: 'MOD_9', name: 'Child', description: 'Nested', parentId: 1, isRoot: false, childIds: [10, 'x'], projectId: 7 }]) };
    }
    if (url.endsWith('/pm/module/404')) return { body: JSON.stringify([]) };
    return undefined;
  });

  const module = await adapter.getModule('MOD_9');
  expect(module).toEqual({
    id: '9', name: 'Child', code: 'MOD_9', description: 'Nested', parentId: '1',
    childIds: [10], isRoot: false, projectId: '7',
  });
  expect(get(calls, '/pm/module/9')).toHaveLength(1);

  await expect(adapter.getModule('404')).rejects.toThrow(/Module 404 not found/);
});

// ---------------------------------------------------------------------------- functions

test('listFunctions maps fnType (with tcType fallback) and the review status', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.endsWith('/tm/function/search')) {
      return { body: JSON.stringify({ data: [
        { id: 9, code: 'FN_9', name: 'Login helper', description: 'Signs in', fnType: 'WEB', executionType: 'AUTOMATION', reviewApproveStatus: 'APPROVED', stepCount: 4 },
        { id: 10, tcType: 'API', status: 'DRAFT' },
      ], totalCount: 2 }) };
    }
    return undefined;
  });

  const rows = await adapter.listFunctions({ search: 'login', executionType: 'AUTOMATION', moduleId: 'MOD_3' });

  expect(rows[0]).toEqual({
    id: '9', code: 'FN_9', name: 'Login helper', description: 'Signs in',
    fnType: 'WEB', executionType: 'AUTOMATION', status: 'APPROVED', stepCount: 4,
  });
  expect(rows[1]).toEqual({ id: '10', name: '', fnType: 'API', status: 'DRAFT' });

  const body = post(calls, '/tm/function/search')[0]!.body;
  expect(col(body, 'moduleId')).toEqual({ column: 'moduleId', value: 3 });
  expect(col(body, 'executionType')).toEqual({ column: 'executionType', value: 'AUTOMATION' });
  expect(body.selectFields).toEqual(['id', 'code', 'name', 'description', 'fnType', 'executionType', 'reviewApproveStatus', 'stepCount']);
});

// ---------------------------------------------------------------------------- users

test('listUsers maps the person fields and only keeps the ones the row actually has', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.endsWith('/pm/users/search')) {
      return { body: JSON.stringify({ data: [
        { id: 36, name: 'QA User', email: 'qa.user@x.test', username: 'qa.user', status: 'active' },
        { _id: 37 },
      ], totalCount: 2 }) };
    }
    return undefined;
  });

  const rows = await adapter.listUsers({ search: 'qa', projectId: '7', limit: 20, offset: 5 });

  expect(rows[0]).toEqual({ id: '36', name: 'QA User', email: 'qa.user@x.test', username: 'qa.user', status: 'active' });
  expect(rows[1]).toEqual({ id: '37' });

  const body = post(calls, '/pm/users/search')[0]!.body;
  expect(body.searchFields).toEqual([
    { column: 'deleted', value: false },
    { column: 'name', value: 'qa', regEx: true },
    { column: 'projectIds', value: 7 },
  ]);
  expect(body.startIndex).toBe(5);
  expect(body.limit).toBe(20);
  expect(body.selectFields).toEqual(['id', 'name', 'email', 'username', 'status']);
});

// ---------------------------------------------------------------------------- objects

test('objects expose attributes as locators and turn stored image refs into absolute URLs', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.endsWith('/tm/object/search')) {
      return { body: JSON.stringify({ data: [{
        id: 7, disname: 'Login button', technology: 'WEB', moduleId: 3, objecttemplateId: 11,
        parameterId: [841, 'null', 842],
        attributes: [
          { name: 'xpath', value: '//button', unique: true },
          { name: 'css' }, // no value → not a locator
          { name: 'id', value: 'btn' },
        ],
        // Stored refs are extension-less, host-relative paths; the UI appends .png.
        thumbnail_url: { url: '/download/recording/abc/thumb' },
        pageScreenShot_url: '/download/recording/abc/page.png',
      }] }) };
    }
    if (url.endsWith('/tm/object/8')) {
      return { body: JSON.stringify({ data: { id: 8, description: 'No locators yet', attributes: [] } }) };
    }
    return undefined;
  });

  const objects = await adapter.searchObjects({ query: 'Login', limit: 5 });

  expect(objects).toEqual([{
    id: '7',
    name: 'Login button',
    objectType: 'WEB',
    locators: [{ name: 'xpath', value: '//button', unique: true }, { name: 'id', value: 'btn' }],
    objectTemplateId: '11',
    thumbnailUrl: 'https://x.test/download/recording/abc/thumb.png',
    pageScreenshotUrl: 'https://x.test/download/recording/abc/page.png',
    moduleId: '3',
    parameterIds: ['841', '842'],
  }]);

  const body = post(calls, '/tm/object/search')[0]!.body;
  // The free-text query is the object's NAME column (`disname`), as the UI grid shows it.
  expect(col(body, 'disname')).toEqual({ column: 'disname', value: 'Login', regEx: true });

  // Full read: the name falls back to `description` when `disname` is unset.
  const object = await adapter.getObject('OBJ_8');
  expect(object).toEqual({ id: '8', name: 'No locators yet', locators: [], description: 'No locators yet' });
  expect(get(calls, '/tm/object/8')).toHaveLength(1);
});

// ---------------------------------------------------------------------------- defects + tasks

test('defects and tasks read dot-notation columns and normalise their array owners', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.endsWith('/pm/defect/search')) {
      return { body: JSON.stringify({ data: [{
        id: 1, code: 'DF_1', name: 'Crash on pay', state: 'NEW', severity: 'HIGH', priority: 'MEDIUM',
        ownerId: [36, '37', null],
        selectedTestCase: [{ testcaseId: 41 }, 42, { nope: true }],
      }], totalCount: 1 }) };
    }
    if (url.endsWith('/pm/task/search')) {
      return { body: JSON.stringify({ data: [
        { id: 2, code: 'TK_2', name: 'Fix it', priority: 'HIGH', ownerId: [37], defectId: 12 },
        { id: 3, defectId: 0 },
      ] }) };
    }
    return undefined;
  });

  const defects = await adapter.listDefects({
    search: 'crash', tcId: 'TC_41', storyId: 'US_5', state: 'NEW', assignedTo: '36',
  });
  expect(defects[0]).toEqual({
    id: '1', code: 'DF_1', title: 'Crash on pay', state: 'NEW', severity: 'HIGH', priority: 'MEDIUM',
    assignedTo: ['36', '37'], tcIds: ['41', '42'],
  });
  const defectBody = post(calls, '/pm/defect/search')[0]!.body;
  // The linked-test-case column is a dotted array column and must stay an array value.
  expect(col(defectBody, 'selectedTestCase.testcaseId')).toEqual({ column: 'selectedTestCase.testcaseId', value: [41] });
  expect(col(defectBody, 'userstoryId')).toEqual({ column: 'userstoryId', value: 5 });
  expect(col(defectBody, 'state')).toEqual({ column: 'state', value: 'NEW' });
  // ownerId is an array on the row → an $in, never a bare equality.
  expect(col(defectBody, 'ownerId')).toEqual({ column: 'ownerId', value: { $in: [36] } });

  const tasks = await adapter.listTasks({ storyId: 'US_5', state: 'OPEN', assignedTo: '37' });
  expect(tasks[0]).toEqual({
    id: '2', code: 'TK_2', title: 'Fix it', priority: 'HIGH', assignedTo: ['37'], defectId: '12',
  });
  // defectId 0 means "no defect" and is dropped rather than rendered as "0".
  expect(tasks[1]).toEqual({ id: '3', title: '' });
  const taskBody = post(calls, '/pm/task/search')[0]!.body;
  expect(col(taskBody, 'userstoryId')).toEqual({ column: 'userstoryId', value: 5 });
  expect(col(taskBody, 'ownerId')).toEqual({ column: 'ownerId', value: { $in: [37] } });
});

// ---------------------------------------------------------------------------- actions catalog

test('actionsCatalog exposes named actions only — synthetic lookup keys and deprecated rows stay out', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.endsWith('/tm/action/search')) {
      return { body: JSON.stringify({ data: [
        { id: 1, name: 'click', objectRequired: true, disname: 'Click' },
        { id: 2, name: 'executeQuery', objectRequired: false, uniqueId: 'db-2', disname: 'Execute Query' },
        { id: 3, name: 'oldThing', objectRequired: false, uniqueId: 'deprecated-old', disname: 'Old Thing' },
      ] }) };
    }
    if (url.endsWith('/tm/objectTemplate/search')) return { body: JSON.stringify({ data: [] }) };
    return undefined;
  });

  const defs = await adapter.actionsCatalog('web');

  expect(defs).toEqual([
    { actionType: 'click', platform: 'unknown', id: 1, objectRequired: true, description: 'Click' },
    { actionType: 'executequery', platform: 'unknown', id: 2, objectRequired: false, description: 'Execute Query' },
  ]);
  // The id/uniqueId/display-name aliases and the @Deprecated row are resolution keys, not actions.
  expect(defs.map((d) => d.actionType)).not.toContain('id::1');
  expect(defs.map((d) => d.actionType)).not.toContain('dis::click');
  expect(defs.map((d) => d.actionType)).not.toContain('oldthing');

  const search = post(calls, '/tm/action/search')[0]!.body;
  // The UI's own filter: shared actions (projectId 0) plus this project's.
  expect(search.searchFields).toContainEqual({ column: 'projectId', value: { $in: [0, 7] } });
  expect(search.limit).toBe(100000);

  // Cached per adapter: a second catalog read is free.
  await adapter.actionsCatalog();
  expect(post(calls, '/tm/action/search')).toHaveLength(1);
});

// ---------------------------------------------------------------------------- environments

test('listEnvironments reads the environment field config and marks the general one default', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.includes('/pm/fields/8')) {
      return { body: JSON.stringify([
        { id: 'uuid-1', key: 'general', name: 'General' },
        { key: 'staging' }, // no name, no id → both fall back to the key
        { id: 'uuid-3', key: 'gone', name: 'Gone', deleted: true },
        { id: 4, value: 'prod', label: 'Production' },
        'junk',
      ]) };
    }
    return undefined;
  });

  const envs = await adapter.listEnvironments();

  expect(envs).toEqual([
    { id: 'uuid-1', name: 'General', key: 'general', isDefault: true },
    { id: 'staging', name: 'staging', key: 'staging' },
    { id: '4', name: 'Production', key: 'prod' },
  ]);
  expect(get(calls, '/pm/fields/8?projectId=7&fieldType=environment')).toHaveLength(1);
});

// ---------------------------------------------------------------------------- formulas

test('listFormulas normalises scope, parameters and the engine hint, and is cached', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.includes('/tm/syncFormulas/fetch')) {
      return { body: JSON.stringify({ data: [
        { name: 'TODAY', type: 'DEFAULT', description: { name: 'TODAY()', details: 'Today', parameters: [] } },
        { name: 'CUSTOM_REGION', type: 'CUSTOM', projectId: 7, uniqueId: 'u-1', description: { parameters: [{ keyName: 'region', value: 'the region' }] } },
        { name: 'CUSTOM_GLOBAL', type: 'CUSTOM', projectId: 55 },
        { name: '', type: 'DEFAULT' },
        null,
      ] }) };
    }
    return undefined;
  });

  const formulas = await adapter.listFormulas();

  expect(formulas.map((f) => [f.name, f.type, f.scope])).toEqual([
    ['TODAY', 'DEFAULT', 'default'],
    ['CUSTOM_REGION', 'CUSTOM', 'project'],
    ['CUSTOM_GLOBAL', 'CUSTOM', 'customer'],
  ]);
  // TODAY ships with no declared parameters, so the engine's real signature is filled in
  // (a model writing =TODAY(ddmmyyyy) is the classic failure this prevents).
  const today = formulas[0]!;
  expect(today.signature).toBe('TODAY("d+365")');
  expect(today.parameters).toEqual([{ keyName: 'offset', description: 'Quoted offset string, e.g. "d+365" / "m-1" / "y+2". Omit for today.' }]);
  // A declared parameter is preserved, with its description lifted from `value`.
  expect(formulas[1]!.parameters).toEqual([{ keyName: 'region', description: 'the region', dataType: undefined }]);
  // A formula without a name cannot be called, so it is dropped rather than listed blank.
  expect(formulas).toHaveLength(3);
  expect(get(calls, '/tm/syncFormulas/fetch?projectId=7')).toHaveLength(1);

  await adapter.listFormulas();
  expect(get(calls, '/tm/syncFormulas/fetch?projectId=7')).toHaveLength(1);
});

// ---------------------------------------------------------------------------- test case projection

test('getTestCase projects the raw doc onto the neutral test case, preserving what a save must keep', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.endsWith('/tm/testcase/getById/77')) {
      return { body: JSON.stringify({ data: {
        id: 77, name: 'Manual checkout', tcType: 'WEB', executionType: 'MANUAL',
        userstoryId: 12, moduleId: 3, obsolete: true, updateVersion: 4,
        customFields: { cf_region: 'EMEA' }, tags: ['smoke'], suiteId: [5],
        versionId: 'v1',
        versions: [{ id: 'v1', name: 'v1.0', updateVersion: 4, reviewApproveStatus: 'APPROVED' }, { id: 'v2', name: 'v2.0' }],
        steps: { manualSteps: [{ id: 's1', seq: 1, description: 'Open the cart', expectedResult: 'Cart opens', executionType: 'MANUAL' }] },
      } }) };
    }
    if (url.includes('/tm/testcase/steps')) return { body: JSON.stringify({ data: [] }) };
    return undefined;
  });

  const tc = await adapter.getTestCase('TC_77');

  expect(tc).toMatchObject({
    id: '77', title: 'Manual checkout', category: 'manual', technologyType: 'WEB',
    storyRef: '12', folderOrModule: '3', obsolete: true, updateVersion: 4,
    currentVersionId: 'v1',
  });
  // Fields the neutral model has no slot for ride on sourceTc so a re-save never loses them.
  expect(tc.sourceTc).toEqual({ customFields: { cf_region: 'EMEA' }, tags: ['smoke'], suiteId: [5] });
  // Versions are projected, with the doc's selected version flagged.
  expect(tc.versions).toEqual([
    { id: 'v1', name: 'v1.0', updateVersion: 4, reviewApproveStatus: 'APPROVED', isCurrent: true },
    { id: 'v2', name: 'v2.0', isCurrent: false },
  ]);
  // The empty steps collection falls back to the doc's inline manual steps.
  expect(tc.steps).toHaveLength(1);
  expect(tc.steps[0]).toMatchObject({ n: 1, description: 'Open the cart', expectedResult: 'Cart opens', stepType: 'manual' });
  // The collection was asked for the doc's selected version.
  expect(calls.find((c) => c.url.includes('/tm/testcase/steps'))!.url).toContain('versionId=v1');
});
