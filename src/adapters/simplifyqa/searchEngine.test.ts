import type { QaHttp } from '../http.js';
import { SqaSearchEngine } from './searchEngine.js';

function makeHttp(opts: { post?: jest.Mock; get?: jest.Mock } = {}): QaHttp {
  return {
    postJson: opts.post ?? jest.fn(),
    getJson: opts.get ?? jest.fn(),
    putJson: jest.fn(),
    patchJson: jest.fn(),
    del: jest.fn(),
    postMultipart: jest.fn(),
  } as unknown as QaHttp;
}

describe('SqaSearchEngine', () => {
  test('compiles filters, sort, project scope, deleted:false and row-offset paging', async () => {
    const post = jest.fn().mockResolvedValue({ totalCount: 100, data: [{ id: 1 }, { id: 2 }] });
    const engine = new SqaSearchEngine(makeHttp({ post }), 1);

    const out = await engine.search({
      op: 'search',
      collection: 'testcases',
      where: [
        { field: 'name', op: 'contains', value: 'login' },
        { field: 'tcType', op: 'eq', value: 'API' },
      ],
      sort: [{ field: 'id', dir: 'desc' }],
      offset: 20,
      limit: 10,
    });

    expect(post).toHaveBeenCalledWith(
      '/tm/testcase/search',
      expect.objectContaining({ startIndex: 20, limit: 10, skipStartIndex: 1 }),
    );
    const body = post.mock.calls[0]![1] as Record<string, any>;
    expect(body['searchFields']).toEqual([
      { column: 'deleted', value: false },
      { column: 'projectId', value: 1 },
      { column: 'name', value: 'login', regEx: true },
      { column: 'tcType', value: 'API' },
      { column: 'id', sort: 'dsc' },
    ]);
    expect(out.totalCount).toBe(100);
    expect(out.nextOffset).toBe(22);
  });

  test('resolves a custom-field label to customFields.<key>', async () => {
    const get = jest.fn().mockResolvedValue([
      { key: 'CUSTFIELD_113SEVERITY_8_9i4h7', label: 'SEVERITY', fieldType: 'customFld', controlType: 'TEXT' },
    ]);
    const post = jest.fn().mockResolvedValue({ totalCount: 0, data: [] });
    const engine = new SqaSearchEngine(makeHttp({ post, get }), 1);

    await engine.search({
      op: 'search',
      collection: 'testcases',
      where: [{ field: 'SEVERITY', custom: true, op: 'contains', value: 'High' }],
    });

    expect(get).toHaveBeenCalledWith('/pm/fields/5?fieldType=allFields&projectId=1');
    const body = post.mock.calls[0]![1] as Record<string, any>;
    expect(body['searchFields']).toContainEqual({
      column: 'customFields.CUSTFIELD_113SEVERITY_8_9i4h7',
      value: 'High',
      regEx: true,
    });
  });

  test('rejects fields that do not exist (status/priority on testcases)', async () => {
    const engine = new SqaSearchEngine(makeHttp(), 1);
    await expect(
      engine.search({
        op: 'search',
        collection: 'testcases',
        where: [{ field: 'status', op: 'eq', value: 'x' }],
      }),
    ).rejects.toThrow(/Unknown field "status"/);
    await expect(
      engine.search({
        op: 'search',
        collection: 'testcases',
        where: [{ field: 'priority', op: 'eq', value: 'high' }],
      }),
    ).rejects.toThrow(/Unknown field "priority"/);
  });

  test('never sends deleted:true (hard-coded deleted:false)', async () => {
    const post = jest.fn().mockResolvedValue({ totalCount: 0, data: [] });
    const engine = new SqaSearchEngine(makeHttp({ post }), 1);

    await engine.search({
      op: 'search',
      collection: 'testcases',
      where: [{ field: 'deleted', op: 'eq', value: true }],
    });

    const body = post.mock.calls[0]![1] as Record<string, any>;
    expect(body['searchFields']).toContainEqual({ column: 'deleted', value: false });
    expect(body['searchFields']).not.toContainEqual({ column: 'deleted', value: true });
  });

  test('coerces numeric relation ids and follows story -> testcases', async () => {
    const post = jest.fn().mockResolvedValue({ totalCount: 1, data: [{ id: 7 }] });
    const engine = new SqaSearchEngine(makeHttp({ post }), 1);

    const out = await engine.related({
      op: 'related',
      collection: 'stories',
      id: '42',
      relation: 'testcases',
    });

    expect(out.collection).toBe('testcases');
    const body = post.mock.calls[0]![1] as Record<string, any>;
    expect(body['searchFields']).toContainEqual({ column: 'userstoryId', value: 42 });
  });

  test('get resolves a business key before hitting getById', async () => {
    const post = jest.fn().mockResolvedValue({ totalCount: 1, data: [{ id: 240, code: 'TC-240' }] });
    const get = jest.fn().mockResolvedValue({ data: { id: 240, name: 'Test renamed' } });
    const engine = new SqaSearchEngine(makeHttp({ post, get }), 1);

    const row = await engine.get('testcases', 'TC-240');

    expect(row['id']).toBe(240);
    expect(post).toHaveBeenCalledWith(
      '/tm/testcase/search',
      expect.objectContaining({
        searchFields: expect.arrayContaining([{ column: 'code', value: 'TC-240' }]),
      }),
    );
    expect(get).toHaveBeenCalledWith('/tm/testcase/getById/240');
  });

  test('catalog exposes descriptions, fields and relations', () => {
    const engine = new SqaSearchEngine(makeHttp(), 1);
    const all = engine.catalog();
    const tc = engine.catalog('testcases')[0]!;

    expect(all.length).toBeGreaterThan(20);
    expect(tc.description).toMatch(/test cases/i);
    expect(tc.fields.map((f) => f.key)).toContain('tcType');
    expect(tc.fields.map((f) => f.key)).not.toContain('priority');
    expect(tc.fields.map((f) => f.key)).not.toContain('status');
    expect(tc.relations.map((r) => r.name)).toContain('defects');
  });

  test('numeric id supports range operators; executions type TC aliases to TESTCASE', async () => {
    const post = jest.fn().mockResolvedValue({ totalCount: 0, data: [] });
    const engine = new SqaSearchEngine(makeHttp({ post }), 1);

    await engine.search({
      op: 'search',
      collection: 'stories',
      where: [{ field: 'id', op: 'gt', value: 0 }],
      limit: 1,
    });
    let body = post.mock.calls[0]![1] as Record<string, any>;
    expect(body['searchFields']).toContainEqual({ column: 'id', value: 0, operator: 'gt' });

    await engine.search({
      op: 'search',
      collection: 'executions',
      where: [{ field: 'type', op: 'eq', value: 'TC' }],
      limit: 1,
    });
    body = post.mock.calls[1]![1] as Record<string, any>;
    expect(body['searchFields']).toContainEqual({ column: 'type', value: 'TESTCASE' });
  });

  test('execution steps relation uses the TESTCASE type', async () => {
    const post = jest.fn().mockResolvedValue({ totalCount: 0, data: [] });
    const engine = new SqaSearchEngine(makeHttp({ post }), 1);

    await engine.related({
      op: 'related',
      collection: 'testcases',
      id: '585',
      relation: 'executions',
      limit: 1,
    });

    const body = post.mock.calls[0]![1] as Record<string, any>;
    expect(body['searchFields']).toContainEqual({ column: 'executionTypeId', value: 585 });
    expect(body['searchFields']).toContainEqual({ column: 'type', value: 'TESTCASE' });
  });

  test('exists is rejected on SQA booleans (backend $nor bug)', async () => {
    const engine = new SqaSearchEngine(makeHttp(), 1);
    await expect(
      engine.search({
        op: 'search',
        collection: 'testcases',
        where: [{ field: 'obsolete', op: 'exists', value: true }],
      }),
    ).rejects.toThrow(/not supported/);
  });
});
