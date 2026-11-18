import { SimplifyQaAdapter } from './adapter.js';

/** sqa_query — the SEARCH / CATALOG surface of the adapter.
 *
 *  Everything here goes through the REAL path: the adapter builds the client, the project-access
 *  guard runs (/pm/auth/me → /pm/projectuserrole), and the generic engine compiles the request into
 *  the backend's `searchFields` protocol. The assertions are on the wire payload (exact columns,
 *  operators, skipStartIndex/sort, project scope, soft-delete) and on the answers — not on internals.
 *
 *  `dryRun: true` is the engine's own "compile only, send nothing" mode, so operator/paging
 *  assertions cannot accidentally pass because of a response fixture. */

type Reply = { status?: number; body: string };
type Handler = (url: string, init: RequestInit) => Reply | undefined;

type Call = { method: string; url: string; body: any; headers: Record<string, unknown> };

const ME = { userDetails: { id: 36, username: 'qa.user', email: 'qa.user@x.test', userType: 'user' } };
const ROLES = { data: [{ userId: 36, projectId: 7, roleId: 2, deleted: false }] };

function makeAdapter(handler: Handler = () => undefined, overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    let body: any;
    if (typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ method, url, body, headers: (init.headers ?? {}) as Record<string, unknown> });

    // The test owns the endpoint; anything it does not answer falls back to the project-access gate,
    // which every project-scoped request is preceded by (/pm/auth/me → /pm/projectuserrole?userId=).
    const out = handler(url, init);
    if (out) return response(out);
    if (url.includes('/pm/auth/me')) return response({ body: JSON.stringify(ME) });
    if (url.includes('/pm/projectuserrole?userId=')) return response({ body: JSON.stringify(ROLES) });
    return response({ status: 404, body: JSON.stringify({ message: `unexpected ${method} ${url}` }) });
  }) as unknown as typeof fetch;

  const adapter = new SimplifyQaAdapter(
    { baseUrl: 'https://x.test', token: 't', projectId: '7', ...overrides } as any,
    { fetchImpl, FormDataImpl: FormData },
  );
  return { adapter, calls };
}

function response({ status = 200, body }: Reply) {
  return { ok: status < 300, status, text: async () => body };
}

const searchCalls = (calls: Call[], path: string) => calls.filter((c) => c.method === 'POST' && c.url.endsWith(path));
const columns = (body: any): string[] => (body?.searchFields ?? []).map((f: any) => f.column);

// ---------------------------------------------------------------------------- catalog

test('catalog is served from the registry with no HTTP, and an alias resolves to one collection', async () => {
  const { adapter, calls } = makeAdapter();

  const one = (await adapter.sqaQuery({ op: 'catalog', collection: 'tc' })) as any;
  expect(one.collections).toHaveLength(1);
  const tc = one.collections[0]!;
  expect(tc.name).toBe('testcases');
  expect(tc.searchPath).toBe('/tm/testcase/search');
  expect(tc.getPath).toBe('/tm/testcase/getById/{id}');
  expect(tc.parentId).toBe(5); // custom-field / lifecycle parent for testcases
  // Fields carry their type + the operators the engine will accept for them.
  const nameField = tc.fields.find((f: any) => f.key === 'name')!;
  expect(nameField).toMatchObject({ type: 'string' });
  expect(nameField.ops).toContain('contains');
  // Relations are discoverable, so a caller can find "steps" before asking for it.
  expect(tc.relations.map((r: any) => r.name)).toContain('steps');
  expect(tc.relations.find((r: any) => r.name === 'steps')).toMatchObject({ kind: 'subresource' });

  const all = (await adapter.sqaQuery({ op: 'catalog' })) as any;
  const names = all.collections.map((c: any) => c.name);
  expect(names).toEqual(expect.arrayContaining(['testcases', 'stories', 'epics', 'features', 'suites', 'modules', 'functions', 'users', 'objects', 'defects', 'tasks']));

  // A catalog read is static metadata — it must never touch the backend.
  expect(calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------- info

test('info() names the project and reads each entity count, degrading a failed count to 0', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.endsWith('/pm/project/search')) {
      return { body: JSON.stringify({ data: [{ id: 7, code: 'PR_7', name: 'Checkout' }, { id: 9, name: 'Other' }] }) };
    }
    if (url.endsWith('/tm/testcase/search')) return { body: JSON.stringify({ totalCount: 12, data: [] }) };
    // No totalCount → falls back to the rows returned.
    if (url.endsWith('/tm/suites/search')) return { body: JSON.stringify({ data: [{ id: 1 }, { id: 2 }] }) };
    if (url.endsWith('/pm/userstory/search')) return { status: 500, body: 'boom' };
    if (url.endsWith('/tm/object/search')) return { body: JSON.stringify({ totalCount: 40, data: [] }) };
    return undefined;
  });

  const info = await adapter.info();

  expect(info).toEqual({
    provider: 'simplifyqa',
    projectId: '7',
    projectName: 'Checkout',
    counts: { testCases: 12, suites: 2, stories: 0, objects: 40 },
  });

  // Each count is a project-scoped, limit-1 search (never a full page just to count).
  for (const path of ['/tm/testcase/search', '/tm/suites/search', '/pm/userstory/search', '/tm/object/search']) {
    const call = searchCalls(calls, path)[0]!;
    expect(call.body.limit).toBe(1);
    expect(columns(call.body)).toContain('projectId');
    expect(call.body.searchFields).toContainEqual({ column: 'projectId', value: 7 });
    expect(call.body.searchFields).toContainEqual({ column: 'deleted', value: false });
  }
  // The project row was resolved through the user's roles, not guessed from the config.
  expect(calls.some((c) => c.url.includes('/pm/projectuserrole?userId=36'))).toBe(true);
});

// ---------------------------------------------------------------------------- search compile

test('search compiles operators, sort and paging into one searchFields payload', async () => {
  const { adapter } = makeAdapter();

  const out = (await adapter.sqaQuery({
    op: 'search',
    collection: 'testcases',
    where: [
      { field: 'tcType', op: 'eq', value: 'web' },
      { field: 'name', op: 'contains', value: 'checkout' },
      { field: 'id', op: 'gt', value: 100 },
      { field: 'executionType', op: 'in', value: ['MANUAL', 'AUTOMATION'] },
    ],
    sort: [{ field: 'name', dir: 'desc' }],
    limit: 2,
    offset: 5,
    dryRun: true,
  })) as any;

  const payload = out.payload!;
  expect(out.rows).toEqual([]);
  expect(out.offset).toBe(5);
  // Paging is a ROW offset (skipStartIndex), not a page number.
  expect(payload.startIndex).toBe(5);
  expect(payload.limit).toBe(2);
  expect(payload.skipStartIndex).toBe(1);
  expect(payload.selectFields).toEqual(['id', 'code', 'name', 'tcType', 'executionType', 'moduleId', 'userstoryId', 'obsolete', 'reviewApproveStatus']);

  const fields = payload.searchFields as any[];
  // Soft-delete is always forced on and the active project always scopes the search.
  expect(fields[0]).toEqual({ column: 'deleted', value: false });
  expect(fields).toContainEqual({ column: 'projectId', value: 7 });
  // The product hides obsolete test cases unless the caller asked about them.
  expect(fields).toContainEqual({ column: 'obsolete', value: true, operator: 'nor' });
  // eq on an enum field is translated to the stored spelling (and reported back).
  // Enum values are matched tolerantly: SQA rows store the enum in mixed case, so a lower-case
  // word becomes an `in` over every spelling — and the translation is reported back.
  expect(fields).toContainEqual({ column: 'tcType', value: ['WEB', 'web', 'Web'] });
  expect(out.resolved).toContainEqual({ field: 'tcType', from: ['web'], to: ['WEB', 'web', 'Web'] });
  // contains → regex; gt → operator; in → array value.
  expect(fields).toContainEqual({ column: 'name', value: 'checkout', regEx: true });
  expect(fields).toContainEqual({ column: 'id', value: 100, operator: 'gt' });
  expect(fields).toContainEqual({ column: 'executionType', value: ['MANUAL', 'AUTOMATION'] });
  // Sorting rides in the same array, after the filters.
  expect(fields.at(-1)).toEqual({ column: 'name', sort: 'dsc' });
});

test('a caller-supplied scope is dropped — only the adapter can widen a project scope', async () => {
  const { adapter } = makeAdapter();

  const out = (await adapter.sqaQuery({
    op: 'search',
    collection: 'testcases',
    scopeProjectIds: [99],
    scopeAll: true,
    dryRun: true,
  } as any)) as any;

  const fields = out.payload!.searchFields as any[];
  expect(fields).toContainEqual({ column: 'projectId', value: 7 });
  expect(fields).not.toContainEqual({ column: 'projectId', value: 99 });
});

test('an unknown field and an unsupported operator are refused before any search request', async () => {
  const { adapter, calls } = makeAdapter();

  await expect(
    adapter.sqaQuery({ op: 'search', collection: 'testcases', where: [{ field: 'priority', op: 'eq', value: 'HIGH' }] }),
  ).rejects.toThrow(/Unknown field "priority" on testcases[\s\S]*custom: true/);

  await expect(
    adapter.sqaQuery({ op: 'search', collection: 'testcases', where: [{ field: 'moduleId', op: 'contains', value: '3' }] }),
  ).rejects.toThrow(/Operator "contains" is not supported for testcases.moduleId. Supported: eq, in/);

  await expect(
    adapter.sqaQuery({ op: 'search', collection: 'testcases', sort: [{ field: 'nope' }] }),
  ).rejects.toThrow(/Unknown sort field "nope" on testcases/);

  // Nothing was sent: a rejected query must not cost a round trip.
  expect(searchCalls(calls, '/tm/testcase/search')).toHaveLength(0);
});

// ---------------------------------------------------------------------------- custom fields

const FIELDS = [
  { fieldType: 'defaultFld', key: 'name', values: [] },
  {
    fieldType: 'customFld', key: 'cf_region', label: 'Region', controlType: 'TEXT',
    values: [{ key: 'EMEA', value: 'EMEA' }, { key: 'APAC', value: 'APAC' }],
  },
  { fieldType: 'customFld', key: 'cf_team_region', label: 'Team Region', controlType: 'TEXT' },
];

test('a custom-field label resolves to its customFields.<key> column and the field list is cached', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.includes('/pm/fields/5')) return { body: JSON.stringify(FIELDS) };
    return undefined;
  });

  const byLabel = (await adapter.sqaQuery({
    op: 'search', collection: 'testcases',
    where: [{ field: 'Region', custom: true, op: 'eq', value: 'EMEA' }],
    dryRun: true,
  })) as any;
  expect(byLabel.payload!.searchFields).toContainEqual({ column: 'customFields.cf_region', value: 'EMEA' });

  // A key / explicit column goes through untouched (no field-config lookup needed for it).
  const byKey = (await adapter.sqaQuery({
    op: 'search', collection: 'testcases',
    where: [{ field: 'cf_team_region', custom: true, op: 'contains', value: 'emea' }],
    dryRun: true,
  })) as any;
  expect(byKey.payload!.searchFields).toContainEqual({ column: 'customFields.cf_team_region', value: 'emea', regEx: true });

  const byColumn = (await adapter.sqaQuery({
    op: 'search', collection: 'testcases',
    where: [{ field: 'customFields.cf_region', op: 'in', value: ['EMEA', 'APAC'] }],
    dryRun: true,
  })) as any;
  expect(byColumn.payload!.searchFields).toContainEqual({ column: 'customFields.cf_region', value: ['EMEA', 'APAC'] });

  // The project's field config is read once and reused — three queries, one GET.
  expect(calls.filter((c) => c.url.includes('/pm/fields/5'))).toHaveLength(1);
  expect(calls.find((c) => c.url.includes('/pm/fields/5'))!.url)
    .toBe('https://x.test/pm/fields/5?fieldType=allFields&projectId=7');
});

test('op:"custom_fields" lists label → key → column and refuses an unknown custom label', async () => {
  const { adapter } = makeAdapter((url) => {
    if (url.includes('/pm/fields/5')) return { body: JSON.stringify(FIELDS) };
    return undefined;
  });

  const out = (await adapter.sqaQuery({ op: 'custom_fields', collection: 'testcases' })) as any;
  expect(out.op).toBe('custom_fields');
  const fields = out.fields!;
  // Default fields are not "custom" — only the two customFld rows are listed.
  expect(fields.map((f: any) => f.key)).toEqual(['cf_region', 'cf_team_region']);
  expect(fields[0]).toMatchObject({
    key: 'cf_region', label: 'Region', column: 'customFields.cf_region', controlType: 'TEXT',
  });
  expect(fields[0]!.values).toEqual([{ key: 'EMEA', value: 'EMEA' }, { key: 'APAC', value: 'APAC' }]);

  await expect(
    adapter.sqaQuery({ op: 'search', collection: 'testcases', where: [{ field: 'Nope', custom: true, value: 'x' }] }),
  ).rejects.toThrow(/Custom field "Nope" not found on testcases. Available: Region, Team Region/);

  // A collection with no custom fields at all says so instead of pretending the label is free text.
  await expect(
    adapter.sqaQuery({ op: 'search', collection: 'users', where: [{ field: 'anything', custom: true, value: 'x' }] }),
  ).rejects.toThrow(/Collection "users" has no custom fields configured in this project/);
});

// ---------------------------------------------------------------------------- get / related

test('op:"get" resolves a business key to the numeric row and reports a soft-deleted row as missing', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.endsWith('/pm/userstory/search')) {
      return { body: JSON.stringify({ data: [{ id: 12, code: 'US-12' }] }) };
    }
    if (url.endsWith('/pm/userstory/12')) {
      return { body: JSON.stringify({ data: { id: 12, code: 'US-12', name: 'Checkout' } }) };
    }
    if (url.endsWith('/tm/testcase/getById/9')) {
      return { body: JSON.stringify({ data: { id: 9, name: 'Gone', deleted: true } }) };
    }
    return undefined;
  });

  const got = (await adapter.sqaQuery({ op: 'get', collection: 'stories', id: 'US-12' })) as any;
  expect(got.op).toBe('get');
  expect(got.row).toMatchObject({ id: 12, code: 'US-12', name: 'Checkout' });

  // The key lookup ran first, on the collection's keyField, then the row was fetched by numeric id.
  const keyLookup = searchCalls(calls, '/pm/userstory/search')[0]!;
  expect(keyLookup.body.searchFields).toContainEqual({ column: 'code', value: 'US-12' });
  expect(keyLookup.body.limit).toBe(1);
  expect(calls.some((c) => c.url.endsWith('/pm/userstory/12'))).toBe(true);

  // A direct GET does not apply the soft-delete filter, so the adapter must.
  await expect(adapter.sqaQuery({ op: 'get', collection: 'testcases', id: '9' })).rejects.toThrow(/testcases 9 not found/);
});

test('op:"related" reads the parent row and filters the target by its value, never by the raw ref', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.endsWith('/pm/userstory/12')) {
      return { body: JSON.stringify({ data: { id: 12, code: 'US-12', name: 'Checkout' } }) };
    }
    return undefined;
  });

  const out = (await adapter.sqaQuery({ op: 'related', collection: 'stories', id: '12', relation: 'testcases', dryRun: true })) as any;

  expect(out.collection).toBe('testcases');
  expect(calls.some((c) => c.url.endsWith('/pm/userstory/12'))).toBe(true);
  // stories.testcases: localField id → remoteField userstoryId.
  expect(out.payload!.searchFields).toContainEqual({ column: 'userstoryId', value: 12 });
  expect(out.payload!.searchFields).toContainEqual({ column: 'projectId', value: 7 });
});

test('an unknown relation is refused with the available relations and no parent read', async () => {
  const { adapter, calls } = makeAdapter();

  await expect(
    adapter.sqaQuery({ op: 'related', collection: 'stories', id: '12', relation: 'nope' }),
  ).rejects.toThrow(/Unknown relation "nope" on stories. Available: linkedIssues, testcases, attachments/);

  expect(calls.filter((c) => c.url.endsWith('/pm/userstory/12'))).toHaveLength(0);
});

// ---------------------------------------------------------------------------- count

test('op:"count" asks the backend for the total (limit 1) and carries the auth + project headers', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.endsWith('/tm/testcase/search')) return { body: JSON.stringify({ totalCount: 42, data: [] }) };
    return undefined;
  });

  const out = (await adapter.sqaQuery({ op: 'count', collection: 'testcases' })) as any;

  expect(out).toMatchObject({ op: 'count', collection: 'testcases', total: 42 });
  const call = searchCalls(calls, '/tm/testcase/search')[0]!;
  expect(call.body.limit).toBe(1);
  expect(call.body.startIndex).toBe(0);
  expect(call.body.skipStartIndex).toBe(1);
  expect(call.body.selectFields).toEqual(['id']);
  expect(call.body.searchFields).toContainEqual({ column: 'obsolete', value: true, operator: 'nor' });
  expect(call.headers).toMatchObject({
    Authorization: 'Bearer t',
    'x-project-id': '7',
    'Content-Type': 'application/json',
  });
});

// ---------------------------------------------------------------------------- scoping

test('with no project selected a project-scoped search is refused, while the catalog still works', async () => {
  const { adapter, calls } = makeAdapter(_url => undefined, { projectId: undefined });

  await expect(adapter.sqaQuery({ op: 'search', collection: 'testcases' }))
    .rejects.toThrow(/No project selected[\s\S]*qa_switch_project/);

  const catalog = (await adapter.sqaQuery({ op: 'catalog', collection: 'suites' })) as any;
  expect(catalog.collections.map((c: any) => c.name)).toEqual(['suites']);
  expect(calls).toHaveLength(0);
});

test('allProjects is limited to release-like collections and never leaks past the caller\'s projects', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.includes('/pm/projectuserrole?userId=')) {
      return { body: JSON.stringify({ data: [{ projectId: 7, roleId: 2 }, { projectId: 9, roleId: 2 }] }) };
    }
    return undefined;
  });

  await expect(adapter.sqaQuery({ op: 'search', collection: 'testcases', allProjects: true }))
    .rejects.toThrow(/allProjects works on releases, sprints, epics, features only/);

  const out = (await adapter.sqaQuery({ op: 'search', collection: 'epics', allProjects: true, dryRun: true })) as any;
  expect(out.scopeNote).toBe('Across all 2 projects you have a role in, not just the active one.');
  // projectIds is widened to the caller's two projects — the active one is not preferred or special.
  expect(out.payload!.searchFields).toContainEqual({ column: 'projectIds', value: [7, 9] });

  // A caller asking for a project it has no role in cannot widen the scope through allProjects.
  const narrowed = (await adapter.sqaQuery({
    op: 'search', collection: 'epics', allProjects: true, where: [{ field: 'projectIds', value: 55 }], dryRun: true,
  })) as any;
  expect(narrowed.scopeNote).toMatch(/^Across 0 of the projects you have a role in/);
  expect(narrowed.payload!.searchFields).toContainEqual({ column: 'projectIds', value: [-1] });
  // Both dry runs compiled only — the epic search itself was never sent.
  expect(calls.filter((c) => c.url.endsWith('/pm/epic/search'))).toHaveLength(0);
});

test('users + projectIds lists the project\'s members with their role, from the role assignments', async () => {
  const { adapter, calls } = makeAdapter((url, init) => {
    if (url.includes('/pm/projectuserrole?projectId=7')) {
      return { body: JSON.stringify({ data: [
        { userId: 36, roleId: 2 },
        { userId: 37, roleId: 3 },
        { userId: 99, roleId: 3, deleted: true },
      ] }) };
    }
    if (url.endsWith('/pm/users/search')) {
      const body = JSON.parse(String(init.body));
      const probe = body.searchFields.some((f: any) => f.column === 'id' && typeof f.value === 'number');
      if (probe) return { body: JSON.stringify({ data: [{ id: 36, userType: 'user' }] }) }; // isCallerAdmin
      return { body: JSON.stringify({ data: [
        { id: 36, name: 'QA User', email: 'qa.user@x.test' },
        { id: 37, name: 'Dev User', status: 'active' },
      ], totalCount: 2 }) };
    }
    if (url.endsWith('/pm/roles/search')) {
      return { body: JSON.stringify({ data: [{ id: 2, name: 'QA' }, { id: 3, name: 'Developer' }] }) };
    }
    return undefined;
  });

  const out = (await adapter.sqaQuery({
    op: 'search', collection: 'users', where: [{ field: 'projectIds', value: 7 }],
  })) as any;

  expect(out.rows).toEqual([
    { id: 36, name: 'QA User', email: 'qa.user@x.test', roleId: 2, roleName: 'QA' },
    { id: 37, name: 'Dev User', status: 'active', roleId: 3, roleName: 'Developer' },
  ]);
  expect(out.scopeNote).toBe('Members of project 7 (from its user-role assignments).');
  // Membership came from project_user_role (the deleted row is skipped), not from a user field.
  const memberSearch = searchCalls(calls, '/pm/users/search').at(-1)!;
  expect(memberSearch.body.searchFields).toContainEqual({ column: 'id', value: [36, 37] });
  expect(columns(memberSearch.body)).not.toContain('projectIds');
});

test('users + a project the caller is not in is refused instead of silently returning nobody', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.endsWith('/pm/users/search')) return { body: JSON.stringify({ data: [{ id: 36, userType: 'user' }] }) };
    return undefined;
  });

  await expect(adapter.sqaQuery({ op: 'search', collection: 'users', where: [{ field: 'projectIds', value: 8 }] }))
    .rejects.toThrow(/You are not a member of project 8/);

  // Only the admin probe ran — the member search never happened.
  expect(searchCalls(calls, '/pm/users/search')).toHaveLength(1);
});

describe('executions list parent runs only (as Reports v2 does)', () => {
  const PARENT_ONLY = { column: 'childExecution', value: true, operator: 'nor' };
  const NO_COPIES = { column: 'parentExecutionCopy', value: true, operator: 'nor' };
  const fieldsOf = async (where: any[]) => {
    const { adapter } = makeAdapter();
    const out = (await adapter.sqaQuery({ op: 'search', collection: 'executions', where, dryRun: true })) as any;
    return out.payload.searchFields as any[];
  };

  test('a plain search hides child runs and parent copies', async () => {
    const fields = await fieldsOf([{ field: 'executionTypeId', op: 'eq', value: 100 }]);
    expect(fields).toContainEqual(PARENT_ONLY);
    expect(fields).toContainEqual(NO_COPIES);
  });

  test('count applies the same default', async () => {
    const { adapter, calls } = makeAdapter((url) =>
      url.endsWith('/exec/execution/search') ? { body: JSON.stringify({ totalCount: 2, data: [] }) } : undefined);
    await adapter.sqaQuery({ op: 'count', collection: 'executions', where: [{ field: 'executionTypeId', op: 'eq', value: 100 }] });
    const body = searchCalls(calls, '/exec/execution/search')[0]!.body;
    expect(body.searchFields).toContainEqual(PARENT_ONLY);
    expect(body.searchFields).toContainEqual(NO_COPIES);
  });

  test('naming childExecution or parentExecutionId asks for child runs', async () => {
    for (const where of [
      [{ field: 'childExecution', op: 'eq', value: true }],
      [{ field: 'parentExecutionId', op: 'eq', value: 53133 }],
    ]) {
      const fields = await fieldsOf(where);
      expect(fields).not.toContainEqual(PARENT_ONLY);
      expect(fields).toContainEqual(NO_COPIES);
    }
  });

  test('a lookup by id or code finds the row whatever it is', async () => {
    for (const where of [[{ field: 'id', op: 'eq', value: 53134 }], [{ field: 'code', op: 'eq', value: 'EX-53134' }]]) {
      const fields = await fieldsOf(where);
      expect(fields).not.toContainEqual(PARENT_ONLY);
      expect(fields).not.toContainEqual(NO_COPIES);
    }
  });

  test('naming parentExecutionCopy asks for the copies', async () => {
    const fields = await fieldsOf([{ field: 'parentExecutionCopy', op: 'eq', value: true }]);
    expect(fields).not.toContainEqual(NO_COPIES);
    expect(fields).toContainEqual({ column: 'parentExecutionCopy', value: true });
  });

  test('includeHidden returns every row', async () => {
    const { adapter } = makeAdapter();
    const out = (await adapter.sqaQuery({ op: 'search', collection: 'executions', includeHidden: true, dryRun: true })) as any;
    expect(out.payload.searchFields).not.toContainEqual(PARENT_ONLY);
    expect(out.payload.searchFields).not.toContainEqual(NO_COPIES);
  });

  test('relation "children" lists the child runs of a parent', async () => {
    const { adapter, calls } = makeAdapter((url) =>
      url.endsWith('/exec/execution/search')
        ? { body: JSON.stringify({ totalCount: 1, data: [{ id: 53133, code: 'EX-53133', childExecutions: [53134] }] }) }
        : undefined);
    await adapter.sqaQuery({ op: 'related', collection: 'executions', id: 'EX-53133', relation: 'children' });
    const bodies = searchCalls(calls, '/exec/execution/search').map((c) => c.body.searchFields as any[]);
    const childQuery = bodies[bodies.length - 1]!;
    expect(childQuery).toContainEqual({ column: 'parentExecutionId', value: 53133 });
    expect(childQuery).not.toContainEqual(PARENT_ONLY);
  });
});
