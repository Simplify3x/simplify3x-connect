/**
 * Wave-2 coverage: the PURE query layer — `searchEngine.ts` (compile / resolve / count / get /
 * related / decorate) and the word-matching helpers in `searchResolve.ts`.
 *
 * Every expectation is derived from the registry (`searchRegistry.ts`) and the calling code: a
 * fake `QaHttp` records the exact wire payload, so a change in compilation shows up here.
 */
import type { QaHttp } from '../http.js';
import { resolveValuesFromEnv, SqaSearchEngine } from './searchEngine.js';
import {
  dateWindow, latestById, matchEnumWord, matchLifecycleWord, matchNamed, matchPeople, normal,
  normaliseCode, personQuery, similarity, spellings, toLifecycleOptions, type Person,
} from './searchResolve.js';

type Handler = (url: string, body: any) => unknown;

function fakeHttp(handlers: { get?: Handler; post?: Handler } = {}) {
  const calls: Array<{ method: 'GET' | 'POST'; url: string; body?: any }> = [];
  const get = jest.fn(async (url: string) => {
    calls.push({ method: 'GET', url });
    return handlers.get ? handlers.get(url, undefined) : {};
  });
  const post = jest.fn(async (url: string, body: any) => {
    calls.push({ method: 'POST', url, body });
    return handlers.post ? handlers.post(url, body) : {};
  });
  const http = {
    getJson: get,
    postJson: post,
    putJson: jest.fn(),
    patchJson: jest.fn(),
    del: jest.fn(),
    postMultipart: jest.fn(),
  } as unknown as QaHttp;
  return { http, calls, get, post };
}

const bodyOf = (post: jest.Mock, n = 0): any => post.mock.calls[n]![1];

const STATE_FIELDS = [
  { fieldType: 'defaultFld', key: 'state', values: [
    { key: 'CUST_1New', value: 'New', mappedTo: 'new' },
    { key: 'CUST_2Pending', value: ' Pending ', mappedTo: 'pending' },
    { key: 'CUST_3Done', value: 'Done', mappedTo: 'completed' },
  ] },
  { fieldType: 'defaultFld', key: 'severity', values: [
    { key: 'SEV_HIGH', value: 'Critical', mappedTo: '' },
  ] },
  { fieldType: 'customFld', key: 'CUST_9', label: 'Env', controlType: 'TEXT' },
];

describe('SqaSearchEngine — catalog and collection resolution', () => {
  test('catalog lists every collection, resolves aliases, and refuses an unknown name', async () => {
    const { http } = fakeHttp();
    const engine = new SqaSearchEngine(http, 7);

    const all = engine.catalog();
    expect(all.length).toBeGreaterThan(20);
    expect(all.map((c) => c.name)).toEqual(expect.arrayContaining(['testcases', 'stories', 'testPlans', 'environments']));

    const tc = engine.catalog('tc')[0]!;
    expect(tc.name).toBe('testcases');
    expect(tc.parentId).toBe(5);
    expect(tc.searchPath).toBe('/tm/testcase/search');
    expect(tc.getPath).toBe('/tm/testcase/getById/{id}');
    expect(tc.scope).toBe('project');
    expect(tc.relations.map((r) => r.name)).toEqual(expect.arrayContaining(['steps', 'defects', 'versions']));
    expect(tc.fields.find((f) => f.key === 'moduleId')).toEqual({
      key: 'moduleId', type: 'number', ops: ['eq', 'in'], label: 'Module',
    });
    // A GET collection carries no getPath; a keyless one no keyField.
    const env = engine.catalog('env')[0]!;
    expect(env.searchPath).toBe('/pm/fields/8?fieldType=environment&projectId={projectId}');
    expect(env.getPath).toBeUndefined();
    expect(env.keyField).toBe('key');

    expect(() => engine.catalog('nonsense')).toThrow(/Unknown collection "nonsense"/);
    await expect(engine.search({ op: 'search' })).rejects.toThrow(/`collection` is required/);
  });
});

describe('SqaSearchEngine — compiling a search', () => {
  test('builds the whole wire payload: scope, soft delete, ops, coercion, sort, paging, select', async () => {
    const { http, post } = fakeHttp({ post: () => ({ totalCount: 0, data: [] }) });
    const engine = new SqaSearchEngine(http, 7, { resolveValues: true });

    const out = await engine.search({
      op: 'search',
      collection: 'testcases',
      where: [
        { field: 'projectId', value: 99 },                 // overridden, never sent
        { field: 'id', op: 'in', value: '7' },             // coerced to a number, then wrapped
        { field: 'tags', op: 'not_in', value: [3, '4'] },   // numbers coerced, $nor
        { field: 'code', op: 'ne', value: 'TC-1', condition: 'or' },
        { field: 'name', op: 'contains', value: 'login' },
        { field: 'obsolete', op: 'eq', value: 'false' },    // boolean coercion + hidden filter off
        { field: 'tcType', op: 'eq', value: 'WEB' },        // enum already stored: untouched
      ],
      sort: [{ field: 'id', dir: 'desc' }, { field: 'name' }],
      limit: 9000,
      offset: -5,
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/tm/testcase/search', expect.anything());
    expect(bodyOf(post)).toEqual({
      searchFields: [
        { column: 'deleted', value: false },
        { column: 'projectId', value: 7 },
        { column: 'id', value: [7] },
        { column: 'tags', value: [3, 4], operator: 'nor' },
        { column: 'code', value: 'TC-1', operator: 'nor', condition: 'or' },
        { column: 'name', value: 'login', regEx: true },
        { column: 'obsolete', value: false },
        { column: 'tcType', value: 'WEB' },
        { column: 'id', sort: 'dsc' },
        { column: 'name', sort: 'asc' },
      ],
      startIndex: 0,
      limit: 500,
      skipStartIndex: 1,
      selectFields: expect.arrayContaining(['id', 'code', 'name', 'obsolete']),
    });
    expect(out).toEqual({ collection: 'testcases', rows: [], totalCount: 0, returned: 0, offset: 0 });

    // dryRun returns the payload and never calls the backend; `select:['*']` sends no selectFields.
    const dry = await engine.search({
      op: 'search', collection: 'modules', select: ['*'], dryRun: true,
      where: [{ field: 'name', op: 'contains', value: 'web' }],
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(dry.rows).toEqual([]);
    expect(dry.returned).toBe(0);
    expect((dry.payload!['searchFields'] as any[])[2]).toEqual({ column: 'name', value: 'web', regEx: true });
    expect(dry.payload!['selectFields']).toBeUndefined();

    await engine.search({ op: 'search', collection: 'modules', select: ['id', 'code'] });
    expect(bodyOf(post, 1)['selectFields']).toEqual(['id', 'code']);
  });

  test('rejects unknown collections/fields/operators/sorts and weird filters', async () => {
    const { http, post } = fakeHttp({ post: () => ({ totalCount: 0, data: [] }) });
    const engine = new SqaSearchEngine(http, 7, { resolveValues: true });

    await expect(engine.search({ op: 'search', collection: 'nope' })).rejects.toThrow(/Unknown collection "nope"/);
    await expect(
      engine.search({ op: 'search', collection: 'testcases', where: [{ field: 'status', op: 'eq', value: 'x' }] }),
    ).rejects.toThrow(/Unknown field "status" on testcases[\s\S]*custom: true/);
    await expect(
      engine.search({ op: 'search', collection: 'testcases', where: [{ field: '   ', value: 'x' }] }),
    ).rejects.toThrow(/Each filter needs a non-empty `field`/);
    await expect(
      engine.search({ op: 'search', collection: 'stories', where: [{ field: 'tags', op: 'eq', value: ['a'] }] }),
    ).rejects.toThrow(/Operator "eq" is not supported for stories.tags. Supported: in, not_in/);
    await expect(
      engine.search({ op: 'search', collection: 'testcases', sort: [{ field: 'nope' }] }),
    ).rejects.toThrow(/Unknown sort field "nope" on testcases/);
    await expect(
      engine.search({ op: 'search', collection: 'testcases', sort: [{ field: 'tags' }] }),
    ).rejects.toThrow(/Field "tags" on testcases is not sortable \(array\)/);

    // customFields.* is sortable/pass-through and accepts `exists` (the backend's $exists).
    await engine.search({
      op: 'search',
      collection: 'testcases',
      where: [{ field: 'customFields.CUST_1SEV', op: 'exists', value: true }],
      sort: [{ field: 'customFields.CUST_1SEV' }],
    });
    expect(bodyOf(post)['searchFields']).toEqual(expect.arrayContaining([
      { column: 'customFields.CUST_1SEV', value: true, operator: 'exists' },
      { column: 'customFields.CUST_1SEV', sort: 'asc' },
    ]));
  });
});

describe('SqaSearchEngine — search results', () => {
  test('GET collections filter and page on the client, honouring the soft-delete rule', async () => {
    const rows = [
      { id: '1', key: 'general', name: 'General' },
      { id: '2', key: 'qa', name: 'QA', deleted: true },
      { id: '3', key: 'prod', name: 'Production' },
    ];
    const { http, get } = fakeHttp({ get: () => rows });
    const engine = new SqaSearchEngine(http, 7);

    const out = await engine.search({
      op: 'search', collection: 'environments',
      where: [{ field: 'key', op: 'contains', value: 'R' }],
      limit: 10,
    });
    expect(get).toHaveBeenCalledWith('/pm/fields/8?fieldType=environment&projectId=7');
    expect(out.rows.map((r) => r['key'])).toEqual(['general', 'prod']);
    expect(out.totalCount).toBe(2);
    expect(out.nextOffset).toBeUndefined();

    const first = await engine.search({ op: 'search', collection: 'environments', limit: 1 });
    expect(first.rows.map((r) => r['key'])).toEqual(['general']);
    expect(first.nextOffset).toBe(1);
    const second = await engine.search({ op: 'search', collection: 'environments', limit: 1, offset: 1 });
    expect(second.rows.map((r) => r['key'])).toEqual(['prod']);
    expect(second.nextOffset).toBeUndefined();

    const byIn = await engine.search({
      op: 'search', collection: 'environments', where: [{ field: 'key', op: 'in', value: ['general', 'prod'] }],
    });
    expect(byIn.rows).toHaveLength(2);
    const byNotIn = await engine.search({
      op: 'search', collection: 'environments', where: [{ field: 'key', op: 'not_in', value: ['general'] }],
    });
    expect(byNotIn.rows.map((r) => r['key'])).toEqual(['prod']);
    const byNe = await engine.search({
      op: 'search', collection: 'environments', where: [{ field: 'key', op: 'ne', value: 'general' }],
    });
    expect(byNe.rows.map((r) => r['key'])).toEqual(['prod']);

    await expect(
      engine.search({ op: 'search', collection: 'environments', where: [{ field: 'nope', value: 'x' }] }),
    ).rejects.toThrow(/Unknown field "nope" on environments/);
  });

  test('collapses version rows to one entity per id and reports what the total counts', async () => {
    const page = [
      { id: 1, name: 'old', parent: false, updateVersion: 1 },
      { id: 1, name: 'new', parent: true, updateVersion: 2 },
      { id: 2, name: 'b' },
    ];
    const { http, post } = fakeHttp({ post: () => ({ totalCount: 10, data: page }) });
    const engine = new SqaSearchEngine(http, 7, { resolveValues: true });

    const out = await engine.search({ op: 'search', collection: 'stories', where: [{ field: 'id', op: 'in', value: [1, 2] }] });
    expect(out.rows.map((r) => r['name'])).toEqual(['new', 'b']);
    expect(out.returned).toBe(2);
    expect(out.collapsedVersions).toBe(1);
    expect(out.totalCount).toBe(10);
    expect(out.totalCountIsRows).toBe(true);
    expect(out.nextOffset).toBe(3);
    expect(bodyOf(post)['selectFields']).toEqual(expect.arrayContaining(['id', 'parent', 'updateVersion', 'updatedAt']));

    // The whole set on one page: the total is the collapsed item count, not the row count.
    const whole = new SqaSearchEngine(
      fakeHttp({ post: () => ({ totalCount: 3, data: page }) }).http, 7, { resolveValues: true },
    );
    const wholeOut = await whole.search({ op: 'search', collection: 'stories' });
    expect(wholeOut.totalCount).toBe(2);
    expect(wholeOut.totalCountIsRows).toBeUndefined();
    expect(wholeOut.nextOffset).toBeUndefined();

    // allVersions keeps every row.
    const all = new SqaSearchEngine(
      fakeHttp({ post: () => ({ totalCount: 3, data: page }) }).http, 7, { resolveValues: true },
    );
    const allOut = await all.search({ op: 'search', collection: 'stories', allVersions: true });
    expect(allOut.rows).toHaveLength(3);
    expect(allOut.collapsedVersions).toBeUndefined();
  });
});

describe('SqaSearchEngine — custom fields', () => {
  test('maps field rows, resolves a name, and refuses missing/ambiguous fields', async () => {
    const rows = [
      { key: 'CUST_1SEV', label: 'SEVERITY', originalLabel: 'Severity', fieldType: 'customFld', controlType: 'TEXT', mandatory: true, values: [{ key: 'H', value: 'High' }] },
      { key: 'CUST_2COMP', label: 'Components', fieldType: 'customFld', controlType: 'LIST' },
      { key: 'DEFAULT_STATE', label: 'State', fieldType: 'defaultFld' },
      { key: '', label: 'nameless', fieldType: 'customFld' },
    ];
    const { http, get } = fakeHttp({ get: () => rows });
    const engine = new SqaSearchEngine(http, 7);

    const fields = await engine.customFields('testcases');
    expect(get).toHaveBeenCalledWith('/pm/fields/5?fieldType=allFields&projectId=7');
    expect(fields).toEqual([
      {
        key: 'CUST_1SEV', label: 'SEVERITY', originalLabel: 'Severity', column: 'customFields.CUST_1SEV',
        fieldType: 'customFld', controlType: 'TEXT', mandatory: true, values: [{ key: 'H', value: 'High' }],
      },
      { key: 'CUST_2COMP', label: 'Components', column: 'customFields.CUST_2COMP', fieldType: 'customFld', controlType: 'LIST' },
    ]);
    // Cached: a second read does not hit the backend again.
    await engine.customFields('testcases');
    expect(get).toHaveBeenCalledTimes(1);

    expect((await engine.resolveCustomField('testcases', ' severity ')).key).toBe('CUST_1SEV');
    expect((await engine.resolveCustomField('testcases', 'cust_2comp')).key).toBe('CUST_2COMP');
    expect((await engine.resolveCustomField('testcases', 'customFields.CUST_2COMP')).key).toBe('CUST_2COMP');
    await expect(engine.resolveCustomField('testcases', 'Nope')).rejects.toThrow(
      /Custom field "Nope" not found on testcases. Available: SEVERITY, Components/,
    );

    const ambiguous = new SqaSearchEngine(
      fakeHttp({ get: () => [
        { key: 'A', label: 'SEVERITY', fieldType: 'customFld' },
        { key: 'B', label: 'SEVERITY', fieldType: 'customFld' },
      ] }).http, 7,
    );
    await expect(ambiguous.resolveCustomField('testcases', 'severity')).rejects.toThrow(
      /is ambiguous on testcases: SEVERITY \(A\), SEVERITY \(B\)\. Use the exact key/,
    );

    // A collection without a parentId has no custom fields at all.
    const none = new SqaSearchEngine(fakeHttp().http, 7);
    expect(await none.customFields('linkages')).toEqual([]);
    await expect(none.resolveCustomField('linkages', 'X')).rejects.toThrow(
      /has no custom fields configured in this project/,
    );
  });

  test('a custom field filter uses its control type for allowed ops and coercion', async () => {
    const { http, post } = fakeHttp({
      get: () => [
        { key: 'CUST_1NUM', label: 'Story Points', fieldType: 'customFld', controlType: 'NUMBER' },
        { key: 'CUST_2LIST', label: 'Components', fieldType: 'customFld', controlType: 'LIST' },
      ],
      post: () => ({ totalCount: 0, data: [] }),
    });
    const engine = new SqaSearchEngine(http, 7, { resolveValues: true });

    await engine.search({
      op: 'search', collection: 'testcases',
      where: [{ field: 'Story Points', custom: true, op: 'gte', value: '8' }],
    });
    expect(bodyOf(post)['searchFields']).toContainEqual({ column: 'customFields.CUST_1NUM', value: 8, operator: 'gte' });

    await engine.search({
      op: 'search', collection: 'testcases', includeHidden: true,
      where: [{ field: 'Components', custom: true, op: 'in', value: ['web'] }],
    });
    expect(bodyOf(post, 1)['searchFields']).toContainEqual({ column: 'customFields.CUST_2LIST', value: ['web'] });

    await expect(engine.search({
      op: 'search', collection: 'testcases',
      where: [{ field: 'Components', custom: true, op: 'contains', value: 'web' }],
    })).rejects.toThrow(/Operator "contains" is not supported for testcases.Components. Supported: in, not_in/);
  });
});

describe('SqaSearchEngine — count', () => {
  test('plain count is one call; GET collections count in memory; grouping errors are explicit', async () => {
    const { http, post } = fakeHttp({
      post: () => ({ totalCount: 12, data: [{ id: 1 }] }),
      get: () => [{ id: '1', key: 'general' }, { id: '2', key: 'qa' }],
    });
    const engine = new SqaSearchEngine(http, 7);

    expect(await engine.count({ op: 'count', collection: 'testcases' })).toEqual({ collection: 'testcases', total: 12 });
    expect(bodyOf(post)['limit']).toBe(1);
    expect(bodyOf(post)['selectFields']).toEqual(['id']);

    expect(await engine.count({ op: 'count', collection: 'environments' })).toEqual({ collection: 'environments', total: 2 });
    await expect(engine.count({ op: 'count', collection: 'environments', groupBy: 'key' }))
      .rejects.toThrow(/Grouping is not supported on environments/);
    await expect(engine.count({ op: 'count', collection: 'testcases', groupBy: 'nope' }))
      .rejects.toThrow(/Cannot group testcases by "nope"\. Fields: id, code/);
    await expect(engine.count({ op: 'count', collection: 'linkTypes', groupBy: 'inwardType' }))
      .rejects.toThrow(/Cannot group by linkTypes.inwardType \(object\)/);
  });

  test('groupBy an enum counts one call per configured value plus (unset)', async () => {
    const { http, post } = fakeHttp({
      post: (_url, body) => {
        const filter = (body.searchFields as any[]).find((f) => f.column === 'tcType');
        if (!filter) return { totalCount: 10, data: [{ id: 1 }] };
        return { totalCount: Array.isArray(filter.value) && filter.value.includes('WEB') ? 4 : 0, data: [] };
      },
    });
    const engine = new SqaSearchEngine(http, 7, { resolveValues: true });

    const out = await engine.count({ op: 'count', collection: 'testcases', groupBy: 'tcType' });
    expect(out).toEqual({
      collection: 'testcases',
      total: 10,
      groupBy: 'tcType',
      groups: [{ value: 'WEB', label: 'WEB', count: 4 }, { value: '', label: '(unset)', count: 6 }],
    });
    // 1 total + 9 configured tcType values; the WEB call sends every spelling.
    expect(post).toHaveBeenCalledTimes(10);
    const webCall = post.mock.calls
      .map((c) => c[1] as any)
      .find((b) => (b.searchFields as any[]).some((f) => f.column === 'tcType' && Array.isArray(f.value) && f.value.includes('WEB')))!;
    expect((webCall.searchFields as any[]).find((f) => f.column === 'tcType')).toEqual({
      column: 'tcType', value: ['WEB', 'web', 'Web'],
    });
  });

  test('any other groupBy reads rows and labels them; ref ids fall back to #id', async () => {
    const defects = new SqaSearchEngine(fakeHttp({
      post: () => ({ totalCount: 3, data: [{ id: 1, type: 'Functional' }, { id: 2, type: 'Functional' }, { id: 3 }] }),
    }).http, 7, { resolveValues: true });
    expect(await defects.count({ op: 'count', collection: 'defects', groupBy: 'type' })).toEqual({
      collection: 'defects',
      total: 3,
      scanned: 3,
      groupBy: 'type',
      groups: [
        { value: 'Functional', label: 'Functional', count: 2 },
        { value: '', label: '(unset)', count: 1 },
      ],
    });

    const testcases = new SqaSearchEngine(fakeHttp({
      post: (url) => {
        if (url === '/pm/module/search') return { data: [{ id: 7, code: 'MOD-7', name: 'Web' }] };
        return { totalCount: 3, data: [{ id: 1, moduleId: 7 }, { id: 2, moduleId: 7 }, { id: 3, moduleId: 99 }] };
      },
    }).http, 7, { resolveValues: true });
    const byModule = await testcases.count({ op: 'count', collection: 'testcases', groupBy: 'moduleId' });
    expect(byModule.groups).toEqual([
      { value: '7', label: 'Web', count: 2 },
      { value: '99', label: '#99', count: 1 },
    ]);
  });

  test('a versioned count reads rows, folds versions, and flags an approximate total', async () => {
    const versioned = new SqaSearchEngine(fakeHttp({
      get: () => STATE_FIELDS,
      post: () => ({
        totalCount: 4,
        data: [
          { id: 1, state: 'CUST_1New', parent: true, updateVersion: 2 },
          { id: 1, state: 'CUST_3Done', parent: false, updateVersion: 1 },
          { id: 2, state: 'CUST_1New' },
          { id: 2, state: 'CUST_1New' },
        ],
      }),
    }).http, 7, { resolveValues: true });
    expect(await versioned.count({ op: 'count', collection: 'stories', groupBy: 'state' })).toEqual({
      collection: 'stories',
      total: 2,
      scanned: 4,
      groupBy: 'state',
      groups: [{ value: 'CUST_1New', label: 'New', count: 2 }],
    });

    // Past the scan cap the total can no longer be made exact.
    const big = Array.from({ length: 500 }, (_, i) => ({ id: i + 1 }));
    const capped = new SqaSearchEngine(fakeHttp({
      post: () => ({ totalCount: 99_999, data: big }),
    }).http, 7, { resolveValues: true });
    const approx = await capped.count({ op: 'count', collection: 'stories' });
    expect(approx).toEqual({ collection: 'stories', total: 99_999, scanned: 5000, approximate: true });
  });
});

describe('SqaSearchEngine — get / related / expand', () => {
  test('get takes a numeric id straight to getById, resolves a business key from the row, and refuses deleted rows', async () => {
    const { http, post, get } = fakeHttp({
      post: () => ({ totalCount: 1, data: [{ id: 240, code: 'TC-240' }] }),
      get: () => ({ data: { id: 240, name: 'Pay flow' } }),
    });
    const engine = new SqaSearchEngine(http, 7);

    expect(await engine.get('testcases', '240')).toEqual({ id: 240, name: 'Pay flow' });
    expect(get).toHaveBeenLastCalledWith('/tm/testcase/getById/240');
    expect(post).not.toHaveBeenCalled();

    expect(await engine.get('testcases', 'TC-240')).toEqual({ id: 240, name: 'Pay flow' });
    expect(bodyOf(post)['searchFields']).toContainEqual({ column: 'code', value: 'TC-240' });

    const deleted = new SqaSearchEngine(
      fakeHttp({ get: () => ({ data: { id: 240, deleted: true } }) }).http, 7,
    );
    await expect(deleted.get('testcases', '240')).rejects.toThrow(/testcases 240 not found/);

    // A collection with no getPath searches by id, then by key, then reports not found.
    const byCode = new SqaSearchEngine(fakeHttp({
      post: (_url, body) => (body.searchFields.some((f: any) => f.column === 'code' && f.value === 'SPR-3')
        ? { totalCount: 1, data: [{ id: 3, code: 'SPR-3', name: 'Sprint 3' }] }
        : { totalCount: 0, data: [] }),
    }).http, 7);
    expect(await byCode.get('sprints', 'SPR-3')).toEqual({ id: 3, code: 'SPR-3', name: 'Sprint 3' });

    const missing = new SqaSearchEngine(fakeHttp({ post: () => ({ totalCount: 0, data: [] }) }).http, 7);
    await expect(missing.get('attachments', 'gone')).rejects.toThrow(/attachments gone not found/);
  });

  test('related follows query, through and subresource relations, and names what is missing', async () => {
    const allFolders = [
      { id: 1, name: 'Plan', isRoot: true, childIds: [2], testcaseIds: [{ id: 100 }, { id: 101 }] },
      { id: 2, name: 'Child', parentId: 1, childIds: [3], testcaseIds: [{ id: 102 }] },
      { id: 3, name: 'Leaf', parentId: 2, testcaseIds: [{ id: 103 }] },
      { id: 4, name: 'Other', testcaseIds: [{ id: 200 }] },
    ];
    const { http, post } = fakeHttp({
      get: (url) => (url === '/tm/testcase/getById/42'
        ? { data: { id: 42, moduleId: 7, versionsDetails: { id: 'ver-9' } } }
        : url.startsWith('/tm/scenario/') ? { data: allFolders[0] } : {}),
      post: (url, body) => {
        const has = (column: string, value?: unknown) => (body.searchFields as any[])
          .some((f) => f.column === column && (value === undefined || JSON.stringify(f.value) === JSON.stringify(value)));
        if (url === '/exec/execution/search') return { data: [{ id: 55, executionRunId: 'run-uuid', executionItemId: 42 }] };
        if (url === '/reports/execution/getstepResult') {
          return { data: [{ id: 's1', status: 'PASSED' }, { id: 's2', deleted: true }] };
        }
        if (url === '/pm/defect/search') {
          return { data: [{ id: 5, code: 'DE-5', selectedTestCase: [{ testcaseId: 11 }, { testcaseId: 12 }] }] };
        }
        if (url === '/pm/module/search') return { data: [{ id: 7, code: 'MOD-7', name: 'Web' }] };
        if (url === '/tm/scenario/search') {
          return has('id', [2]) ? { data: [allFolders[1]] } : { data: allFolders };
        }
        if (url === '/tm/testcase/search') return { data: [{ id: 11 }, { id: 12 }] };
        if (url === '/pm/userstory/search') return { data: [{ id: 42, moduleId: 7 }] };
        return {};
      },
    });
    const engine = new SqaSearchEngine(http, 7, { resolveValues: true });
    const somePayload = (column: string, value: unknown) =>
      expect(post.mock.calls.map((c) => c[1] as any)).toEqual(expect.arrayContaining([
        expect.objectContaining({ searchFields: expect.arrayContaining([{ column, value }]) }),
      ]));

    // query (defects → testcases), through an array-of-objects local field.
    const linked = await engine.related({ op: 'related', collection: 'defects', id: '5', relation: 'testcases' });
    expect(linked.collection).toBe('testcases');
    somePayload('id', [11, 12]);

    // through a scalar local field (testcases → module).
    const module = await engine.related({ op: 'related', collection: 'testcases', id: '42', relation: 'module' });
    expect(module.rows).toEqual([{ id: 7, code: 'MOD-7', name: 'Web' }]);

    // subresource with getstepResult needs the run uuid, and drops deleted rows.
    const steps = await engine.related({ op: 'related', collection: 'executions', id: '55', relation: 'steps' });
    expect(steps.rows).toEqual([{ id: 's1', status: 'PASSED' }]);
    expect(steps.totalCount).toBe(1);

    // folder tree: direct children.
    const children = await engine.related({ op: 'related', collection: 'testPlans', id: '1', relation: 'children' });
    expect(children.rows.map((r) => r['id'])).toEqual([2]);
    somePayload('id', [2]);

    // folder tree: the whole subtree's test cases.
    const subtree = await engine.related({ op: 'related', collection: 'testPlans', id: '1', relation: 'allTestcases' });
    expect(subtree.collection).toBe('testcases');
    somePayload('id', [100, 101, 102, 103]);

    await expect(engine.related({ op: 'related', collection: 'stories', id: '1' }))
      .rejects.toThrow(/`relation` is required for op:"related"/);
    await expect(engine.related({ op: 'related', collection: 'stories', id: '1', relation: 'nope' }))
      .rejects.toThrow(/Unknown relation "nope" on stories. Available: /);
    await expect(engine.related({ op: 'related', collection: 'stories', relation: 'testcases' }))
      .rejects.toThrow(/`id` is required for op:"related"/);

    // A step-result subresource without the run uuid says what to use instead.
    const noUuid = new SqaSearchEngine(fakeHttp({
      post: (url) => (url === '/reports/execution/getstepResult'
        ? { data: [] }
        : { data: [{ id: 55, executionItemId: 42 }] }),
    }).http, 7);
    await expect(noUuid.related({ op: 'related', collection: 'executions', id: '55', relation: 'steps' }))
      .rejects.toThrow(/has no executionRunId/);
  });

  test('getWithExpand reads subresources and relations, and refuses an unknown expansion', async () => {
    const { http, get } = fakeHttp({
      get: (url) => {
        if (url === '/tm/testcase/getById/42') return { data: { id: 42, versionId: 'ver-1' } };
        if (url.startsWith('/tm/testcase/steps')) return { data: [{ id: 'st-1' }, { id: 'st-2', deleted: true }] };
        return {};
      },
      post: () => ({ totalCount: 1, data: [{ id: 'ver-1', name: 'v1' }] }),
    });
    const engine = new SqaSearchEngine(http, 7);

    const out = await engine.getWithExpand({ op: 'get', collection: 'testcases', id: '42', expand: ['steps', 'versions'] });
    expect(out.op).toBe('get');
    if (out.op !== 'get') throw new Error('expected a get result');
    expect(out.row).toEqual({ id: 42, versionId: 'ver-1' });
    expect(out.expanded!['steps']).toEqual([{ id: 'st-1' }]);
    expect(out.expanded!['versions']).toEqual([{ id: 'ver-1', name: 'v1' }]);
    expect(get).toHaveBeenCalledWith('/tm/testcase/steps?projectId=7&tcfnId=42&type=TC&versionId=ver-1');

    await expect(engine.getWithExpand({ op: 'get', collection: 'testcases', id: '42', expand: ['nope'] }))
      .rejects.toThrow(/Unknown expansion "nope" on testcases/);
  });
});

describe('SqaSearchEngine — value resolution', () => {
  test('enum groups and lifecycle words become stored values; stored values pass through', async () => {
    const { http, post } = fakeHttp({
      get: () => STATE_FIELDS,
      post: () => ({ totalCount: 0, data: [] }),
    });
    const engine = new SqaSearchEngine(http, 7, { resolveValues: true });

    // enum: a group word means several values, each in every spelling.
    const grouped = await engine.search({
      op: 'search', collection: 'testcases', where: [{ field: 'tcType', op: 'eq', value: 'MOBILE' }],
    });
    const tcType = (bodyOf(post)['searchFields'] as any[]).find((f) => f.column === 'tcType');
    expect(tcType.value).toEqual(['ANDROID', 'android', 'Android', 'IOS', 'ios', 'Ios']);
    expect(grouped.resolved).toEqual([{
      field: 'tcType', from: ['MOBILE'], to: ['ANDROID', 'android', 'Android', 'IOS', 'ios', 'Ios'],
    }]);
    await expect(engine.search({
      op: 'search', collection: 'testcases', where: [{ field: 'tcType', op: 'eq', value: 'PDA' }],
    })).rejects.toThrow(/testcases.tcType has no value "PDA"\. Valid: WEB, ANDROID, IOS, API, DESKTOP, SAP, MAINFRAME, DATABASE, HYBRID, MOBILE \(= ANDROID \+ IOS\)/);

    // already stored exactly → untouched, no resolution recorded.
    const stored = await engine.search({
      op: 'search', collection: 'testcases', where: [{ field: 'tcType', op: 'eq', value: 'WEB' }],
    });
    expect(stored.resolved).toBeUndefined();
    // contains is never translated.
    await engine.search({
      op: 'search', collection: 'testcases', where: [{ field: 'tcType', op: 'contains', value: 'WE' }],
    });
    expect(bodyOf(post, 2)['searchFields']).toContainEqual({ column: 'tcType', value: 'WE', regEx: true });

    // lifecycle: a category word selects every option mapped to it.
    const open = await engine.search({
      op: 'search', collection: 'stories', where: [{ field: 'state', op: 'eq', value: 'open' }],
    });
    expect(bodyOf(post, 3)['searchFields']).toContainEqual({
      column: 'state', value: ['CUST_1New', 'CUST_2Pending'],
    });
    expect(open.resolved).toEqual([{ field: 'state', from: ['open'], to: ['CUST_1New', 'CUST_2Pending'] }]);
    // an exact label stays one value; a stored key is untouched (labels are trimmed).
    await engine.search({ op: 'search', collection: 'stories', where: [{ field: 'state', op: 'eq', value: 'Done' }] });
    expect(bodyOf(post, 4)['searchFields']).toContainEqual({ column: 'state', value: 'CUST_3Done' });
    const kept = await engine.search({
      op: 'search', collection: 'stories', where: [{ field: 'state', op: 'in', value: ['CUST_2Pending'] }],
    });
    expect(kept.resolved).toBeUndefined();
    await expect(engine.search({
      op: 'search', collection: 'stories', where: [{ field: 'state', op: 'eq', value: 'nonsense' }],
    })).rejects.toThrow(/has no value "nonsense" in this project\. Valid: New \(CUST_1New\), Pending \(CUST_2Pending\), Done \(CUST_3Done\)/);

    // When the options cannot be read the filter is sent exactly as given (never dropped).
    const noOptions = new SqaSearchEngine(fakeHttp({
      get: () => { throw new Error('fields unavailable'); },
      post: () => ({ totalCount: 0, data: [] }),
    }).http, 7, { resolveValues: true });
    await noOptions.search({ op: 'search', collection: 'stories', where: [{ field: 'state', op: 'eq', value: 'Closed' }] });
  });

  test('ref words resolve to ids: me, people, labels, releases and modules', async () => {
    const meHttp = fakeHttp({ post: () => ({ totalCount: 0, data: [] }) });
    const me = new SqaSearchEngine(meHttp.http, 7, { resolveValues: true, currentUserId: 36 });
    const mine = await me.search({
      op: 'search', collection: 'stories', where: [{ field: 'ownerId', op: 'eq', value: 'me' }],
    });
    expect(bodyOf(meHttp.post)['searchFields']).toContainEqual({ column: 'ownerId', value: 36 });
    expect(mine.resolved).toEqual([{ field: 'ownerId', from: ['me'], to: ['36'] }]);

    const anon = new SqaSearchEngine(fakeHttp({ post: () => ({ data: [] }) }).http, 7, { resolveValues: true });
    await expect(anon.search({
      op: 'search', collection: 'stories', where: [{ field: 'ownerId', op: 'eq', value: 'me' }],
    })).rejects.toThrow(/Cannot tell who "me" is on this connection/);

    // A name → every matching user id.
    const peopleHttp = fakeHttp({
      post: (url) => (url === '/pm/users/search'
        ? { data: [{ id: 5, name: 'Priya Sharma' }, { id: 6, name: 'Sunil' }] }
        : { totalCount: 0, data: [] }),
    });
    const people = new SqaSearchEngine(peopleHttp.http, 7, { resolveValues: true });
    await people.search({ op: 'search', collection: 'stories', where: [{ field: 'ownerId', op: 'eq', value: 'priya' }] });
    expect(bodyOf(peopleHttp.post, 1)['searchFields']).toContainEqual({ column: 'ownerId', value: 5 });
    await expect(people.search({
      op: 'search', collection: 'stories', where: [{ field: 'ownerId', op: 'eq', value: 'zzz' }],
    })).rejects.toThrow(/stories.ownerId: No user matches "zzz" in this project\. Use their name, username or email\./);

    // labels: one name is many rows, all of their ids count.
    const tagsHttp = fakeHttp({
      post: (url) => (url === '/pm/tags/search'
        ? { data: [{ id: 9, name: 'smoke' }, { id: 9, name: 'smoke' }, { id: 10, name: 'Smoke Test' }] }
        : { data: [] }),
    });
    const tags = new SqaSearchEngine(tagsHttp.http, 7, { resolveValues: true });
    await tags.search({ op: 'search', collection: 'testcases', where: [{ field: 'tags', op: 'in', value: ['smoke'] }] });
    expect(bodyOf(tagsHttp.post, 1)['searchFields']).toContainEqual({ column: 'tags', value: [9] });

    // releases by code, modules by code.
    const releasesHttp = fakeHttp({
      post: (url) => (url === '/pm/release/search'
        ? { data: [{ id: 31, code: 'REL-31', name: 'Release 1.0' }] }
        : { totalCount: 0, data: [] }),
    });
    const releases = new SqaSearchEngine(releasesHttp.http, 7, { resolveValues: true });
    await releases.search({ op: 'search', collection: 'stories', where: [{ field: 'releaseId', op: 'eq', value: 'REL-31' }] });
    expect(bodyOf(releasesHttp.post, 1)['searchFields']).toContainEqual({ column: 'releaseId', value: 31 });

    const modulesHttp = fakeHttp({
      post: (url) => (url === '/pm/module/search'
        ? { data: [{ id: 7, code: 'WEB-2', name: 'Web 2' }] }
        : { totalCount: 0, data: [] }),
    });
    const modules = new SqaSearchEngine(modulesHttp.http, 7, { resolveValues: true });
    await modules.search({ op: 'search', collection: 'testcases', where: [{ field: 'moduleId', op: 'eq', value: 'Web 2' }] });
    expect(bodyOf(modulesHttp.post, 0)['searchFields']).toContainEqual({ column: 'code', value: 'WEB-2' });
    expect(bodyOf(modulesHttp.post, 1)['searchFields']).toContainEqual({ column: 'moduleId', value: 7 });
  });

  test('date filters become day boundaries with the IST offset and a range for a window', async () => {
    const { http, post } = fakeHttp({ post: () => ({ totalCount: 0, data: [] }) });
    const engine = new SqaSearchEngine(http, 7, { resolveValues: true });
    const fields = (n: number) => bodyOf(post, n)['searchFields'] as any[];

    const one = await engine.search({
      op: 'search', collection: 'testcases', where: [{ field: 'createdAt', op: 'eq', value: '2026-10-01' }],
    });
    expect(fields(0)).toContainEqual({ column: 'createdAt', offset: -330, value: '2026-10-01' });
    expect(one.resolved).toEqual([{ field: 'createdAt', from: ['2026-10-01'], to: ['2026-10-01'] }]);

    await engine.search({
      op: 'search', collection: 'testcases', where: [{ field: 'createdAt', op: 'eq', value: '2026-10' }],
    });
    expect(fields(1)).toContainEqual({
      column: 'createdAt', offset: -330, value: { fromDate: '2026-10-01', toDate: '2026-10-31' }, operator: 'range',
    });

    await engine.search({
      op: 'search', collection: 'testcases', where: [{ field: 'createdAt', op: 'ne', value: '2026-10-01' }],
    });
    expect(fields(2)).toContainEqual({ column: 'createdAt', offset: -330, value: '2026-10-01', operator: 'nor' });
    await expect(engine.search({
      op: 'search', collection: 'testcases', where: [{ field: 'createdAt', op: 'ne', value: '2026-10' }],
    })).rejects.toThrow(/"not on" works for one day only; use lt \/ gt for a window/);

    const cases: Array<[string, string]> = [['gt', '2026-10-31'], ['gte', '2026-10-01'], ['lt', '2026-10-01'], ['lte', '2026-10-31']];
    for (const [op, value] of cases) {
      await engine.search({
        op: 'search', collection: 'testcases',
        where: [{ field: 'createdAt', op: op as any, value: '2026-10', condition: 'or' }],
      });
      expect(fields(post.mock.calls.length - 1)).toContainEqual({
        column: 'createdAt', offset: -330, value, operator: op, condition: 'or',
      });
    }

    await expect(engine.search({
      op: 'search', collection: 'testcases', where: [{ field: 'createdAt', op: 'eq', value: 20261001 }],
    })).rejects.toThrow(/give one date or window as text/);
    await expect(engine.search({
      op: 'search', collection: 'testcases', where: [{ field: 'createdAt', op: 'eq', value: 'someday' }],
    })).rejects.toThrow(/Cannot read "someday" as a date for createdAt/);
  });

  test('decorates rows with readable labels and folder counts; a failed lookup only leaves the field raw', async () => {
    const { http } = fakeHttp({
      get: () => STATE_FIELDS,
      post: (url) => {
        if (url === '/pm/users/search') return { data: [{ id: 36, name: 'Rishi' }] };
        if (url === '/pm/defect/search') {
          return { totalCount: 1, data: [{ id: 1, state: 'CUST_1New', severity: 'SEV_HIGH', ownerId: [36, 99] }] };
        }
        return {};
      },
    });
    const engine = new SqaSearchEngine(http, 7, { resolveValues: true });
    const defects = await engine.search({ op: 'search', collection: 'defects' });
    expect(defects.rows[0]!['_display']).toEqual({
      state: 'New', severity: 'Critical', ownerId: 'Rishi, #99',
    });
    expect(defects.rows[0]!['state']).toBe('CUST_1New');

    const folders = [
      { id: 1, name: 'Plan', isRoot: true, childIds: [2], testcaseIds: [{ id: 100 }] },
      { id: 2, name: 'Child', parentId: 1, testcaseIds: [{ id: 101 }] },
    ];
    const plans = new SqaSearchEngine(fakeHttp({
      post: (_url, body) => ((body.searchFields as any[]).some((f) => f.column === 'isRoot')
        ? { totalCount: 2, data: [{ id: 1, name: 'Plan' }, { id: 2, name: 'Child' }] }
        : { totalCount: 2, data: folders }),
    }).http, 7, { resolveValues: true });
    const out = await plans.search({ op: 'search', collection: 'testPlans' });
    const byId = new Map(out.rows.map((r) => [r['id'], r]));
    expect(byId.get(1)!['_folder']).toEqual({
      suites: 0, testCases: 1, suitesWithSubFolders: 0, testCasesWithSubFolders: 2, subFolders: 1, path: 'Plan',
    });
    expect(byId.get(2)!['_folder']).toMatchObject({ testCases: 1, subFolders: 0, path: 'Plan / Child' });

    // A failed label lookup leaves _display off (best-effort), never fails the search.
    const broken = new SqaSearchEngine(fakeHttp({
      get: () => { throw new Error('no fields'); },
      post: (url) => (url === '/pm/users/search'
        ? { data: { data: [] } }
        : { totalCount: 1, data: [{ id: 2, state: 'CUST_1New' }] }),
    }).http, 7, { resolveValues: true });
    const raw = await broken.search({ op: 'search', collection: 'defects' });
    expect(raw.rows[0]!['_display']).toBeUndefined();
  });
});

describe('searchResolve — word matching', () => {
  test('lifecycle options, similarity and category matching', () => {
    expect(toLifecycleOptions([{ key: 'A', value: ' Released ', mappedTo: 'completed' }, { key: 'B' }, null, 'x', { key: '', value: 'no key' }]))
      .toEqual([{ key: 'A', label: 'Released', category: 'completed' }, { key: 'B', label: 'B', category: '' }]);
    expect(toLifecycleOptions({ nope: true })).toEqual([]);
    expect(toLifecycleOptions([{ key: 'C', value: 'Old', archive: true }])).toEqual([]);

    expect(normal('IN_PROGRESS')).toBe('in progress');
    expect(normal('  a--b__c  ')).toBe('a b c');
    expect(similarity('', '')).toBe(1);
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('abc', 'xyz')).toBe(0);
    expect(similarity('pendng', 'pending')).toBeCloseTo(0.923, 3);

    const opts = [
      { key: 'CUST_1New_1', label: 'New', category: 'new' },
      { key: 'CUST_2Pending_2', label: 'Pending', category: 'pending' },
      { key: 'CUST_3InProgress_3', label: 'QA In Progress', category: 'pending' },
      { key: 'CUST_4Done_4', label: 'Done', category: 'completed' },
    ];
    expect(matchLifecycleWord('New', opts, 'state')).toEqual(['CUST_1New_1']);
    expect(matchLifecycleWord('open', opts, 'state')).toEqual(['CUST_1New_1', 'CUST_2Pending_2', 'CUST_3InProgress_3']);
    expect(matchLifecycleWord('closed', opts, 'state')).toEqual(['CUST_4Done_4']);
    expect(matchLifecycleWord('qa_inprogress', opts, 'state')).toEqual(['CUST_3InProgress_3']);
    expect(matchLifecycleWord('pendng', opts, 'state')).toEqual(['CUST_2Pending_2']);
    expect(matchLifecycleWord('nonsense', opts, 'state')).toEqual([]);
    // A longer word built on an option is a different value, not a typo.
    expect(matchLifecycleWord('highness', [{ key: 'H', label: 'High', category: '' }], 'priority')).toEqual([]);
    // category words only apply to `state`.
    expect(matchLifecycleWord('open', opts, 'priority')).toEqual([]);
  });

  test('people, codes, named records, versions, dates and enums', () => {
    expect(personQuery(' @Sunil.G, ')).toBe('sunil.g');
    const people: Person[] = [
      { id: 1, name: 'Priya Sharma' },
      { id: 2, username: 'priya' },
      { id: 3, name: 'Praharsha Reddy', email: 'prahrsha@x.test' },
    ];
    expect(matchPeople('priya', people)).toEqual([2]);
    expect(matchPeople('sharma', people)).toEqual([1]);
    expect(matchPeople('prahrsha', people)).toEqual([3]);
    expect(matchPeople('xx', people)).toEqual([]);
    expect(matchPeople('nobodyhere', people)).toEqual([]);

    expect(normaliseCode('us 12')).toBe('US-12');
    expect(normaliseCode('US_12')).toBe('US-12');
    expect(normaliseCode('US12')).toBe('US-12');
    expect(normaliseCode('abcdef-12')).toBeUndefined();
    expect(normaliseCode('hello')).toBeUndefined();

    const records = [
      { id: 1, code: 'US-12', name: 'Login' },
      { id: 2, name: 'Sprint 1' },
      { id: 3, name: 'sprint 1 ' },
      { id: 4, name: 'Sprint 2' },
    ];
    expect(matchNamed('US-12', records)).toEqual([1]);
    expect(matchNamed('sprint 1', records)).toEqual([2, 3]);
    expect(matchNamed('nothing here', records)).toEqual([]);
    expect(matchNamed('sprnt 2', records, true)).toEqual([4]);
    expect(matchNamed('sprnt 2', records, false)).toEqual([]);

    const rows = [
      { id: 1, name: 'v1', updateVersion: 3 },
      { id: 1, name: 'canonical', parent: true, updateVersion: 1 },
      { id: 2, name: 'newest', updateVersion: 1, updatedAt: '2026-01-01' },
      { id: 2, name: 'older', updateVersion: 1, updatedAt: '2025-01-01' },
      { name: 'no id' },
      { id: 3, name: 'first' },
    ];
    const folded = latestById(rows);
    expect(folded.map((r) => r['name'])).toEqual(['canonical', 'newest', 'no id', 'first']);
    expect(latestById<Record<string, unknown>>([])).toEqual([]);

    // ---- dates, enum spellings and the resolution kill switch
    const now = new Date('2026-10-13T10:00:00Z');
    expect(dateWindow('2026-10-01', now)).toEqual({ from: '2026-10-01', to: '2026-10-01' });
    expect(dateWindow('2026-02-30', now)).toEqual({ from: '2026-02-28', to: '2026-02-28' });
    expect(dateWindow('2026-13', now)).toBeNull();
    expect(dateWindow('2026-10', now)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(dateWindow('2026-09..2026-10-05', now)).toEqual({ from: '2026-09-01', to: '2026-10-05' });
    expect(dateWindow('2026-09 to 2026-10-05', now)).toEqual({ from: '2026-09-01', to: '2026-10-05' });
    expect(dateWindow('2026-09..nope', now)).toBeNull();
    expect(dateWindow('today', now)).toEqual({ from: '2026-10-13', to: '2026-10-13' });
    expect(dateWindow('yesterday', now)).toEqual({ from: '2026-10-12', to: '2026-10-12' });
    expect(dateWindow('this week', now)).toEqual({ from: '2026-10-12', to: '2026-10-13' });
    expect(dateWindow('this month', now)).toEqual({ from: '2026-10-01', to: '2026-10-13' });
    expect(dateWindow('this year', now)).toEqual({ from: '2026-01-01', to: '2026-10-13' });
    expect(dateWindow('last 7 days', now)).toEqual({ from: '2026-10-06', to: '2026-10-13' });
    expect(dateWindow('past_2_weeks', now)).toEqual({ from: '2026-09-29', to: '2026-10-13' });
    expect(dateWindow('next 7 days', now)).toBeNull();
    expect(dateWindow('quarterly', now)).toBeNull();

    expect(spellings(['Defect'])).toEqual(['Defect', 'DEFECT', 'defect']);
    expect(spellings(['defect'])).toEqual(['defect', 'DEFECT', 'Defect']);
    expect(matchEnumWord('mobile', ['WEB', 'ANDROID', 'IOS'], { MOBILE: ['ANDROID', 'IOS'] })).toEqual(['ANDROID', 'IOS']);
    expect(matchEnumWord(' ios ', ['WEB', 'ANDROID', 'IOS'])).toEqual(['IOS']);
    expect(matchEnumWord('webos', ['WEB', 'ANDROID', 'IOS'])).toEqual([]);

    expect(resolveValuesFromEnv({})).toBe(true);
    expect(resolveValuesFromEnv({ QA_MCP_SQA_RESOLVE: ' off ' })).toBe(false);
    expect(resolveValuesFromEnv({ QA_MCP_SQA_RESOLVE: '0' })).toBe(false);
    expect(resolveValuesFromEnv({ QA_MCP_SQA_RESOLVE: 'yes' })).toBe(true);
  });
});
