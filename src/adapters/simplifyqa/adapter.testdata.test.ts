import { SimplifyQaAdapter } from './adapter.js';

/** TEST-DATA path. Three separate stores are involved and they must never be confused:
 *    - the TC's DEFAULT iteration (the row a run executes) — `getDefaultIteration`,
 *    - generated iterations (append-only) — `saveGeneratedIterations`,
 *    - the SUITE-level store (its own definition + iteration rows) — `getSuiteTestdata`,
 *      `copySuiteTestdataIteration`, `deleteTestdataIterations`.
 *  Values must reach the wire re-keyed by paramId, secrets must never leave the adapter unmasked,
 *  and the DEFAULT row must be impossible to delete. */

type Call = { method: string; url: string; body?: any };

const CALLER_ID = 36;
const PROJECT_ID = 7;

const RAW_TC = {
  id: 42, name: 'Checkout flow', code: 'TC_42', projectId: 7, moduleId: 0,
  tcType: 'WEB', executionType: 'AUTOMATION',
  versionId: 'ver-1', versions: [{ id: 'ver-1', name: 'v1.0' }],
};

const ENVS = [{ key: 'general', name: 'General' }, { key: 'uat', name: 'UAT Server' }];

const PARAM_META: Record<string, { name: string; protected?: boolean }> = {
  '501': { name: 'username' },
  '502': { name: 'apiToken', protected: true },
  '503': { name: 'password' },
};

type State = {
  tcIterations: any[];
  suiteIterations: any[];
  suiteTd: Record<string, any>;
};

function makeAdapter(overrides: { state?: Partial<State> } = {}) {
  const calls: Call[] = [];
  const state: State = {
    tcIterations: overrides.state?.tcIterations ?? [],
    suiteIterations: overrides.state?.suiteIterations ?? [],
    suiteTd: overrides.state?.suiteTd ?? {},
  };

  const handler = (url: string, init: RequestInit): { status?: number; body: string } => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, ...(body !== undefined ? { body } : {}) });

    if (url.includes('/pm/auth/me')) {
      return { body: JSON.stringify({
        userDetails: { id: CALLER_ID, username: 'qa.user', email: 'qa.user@x.test', userType: 'user' },
      }) };
    }
    if (url.includes('/pm/projectuserrole') && url.includes(`userId=${CALLER_ID}`)) {
      return { body: JSON.stringify({ data: [{ userId: CALLER_ID, projectId: PROJECT_ID, roleId: 2, deleted: false }] }) };
    }
    if (url.includes('/tm/testcase/getById/42')) return { body: JSON.stringify({ data: RAW_TC }) };
    if (url.includes('/pm/fields/8')) return { body: JSON.stringify(ENVS) };

    if (url.includes('/tm/testdata/getDefaultItr')) {
      return { body: JSON.stringify({ data: { parametersData: {
        '501': { value: 'qa@x.test' },
        '502': { value: 's3cret' },
        '503': { value: '' },
        '504': { value: 'gone' },
        'abc': { value: 'ignored' },
      } } }) };
    }
    if (url.includes('/tm/parameter/search')) {
      return { body: JSON.stringify({ data: Object.entries(PARAM_META).map(([id, m]) => ({ id: Number(id), ...m })) }) };
    }
    if (url.match(/\/tm\/parameter\/\d+$/)) {
      const id = url.slice(url.lastIndexOf('/') + 1);
      const meta = PARAM_META[id];
      if (!meta) return { status: 404, body: JSON.stringify({ message: 'no such parameter' }) };
      return { body: JSON.stringify({ data: { id: Number(id), ...meta } }) };
    }

    if (url.includes('/tm/testdata/searchTd')) {
      const byId = (body?.searchFields ?? []).some((f: any) => f.column === 'id');
      const row = state.suiteTd;
      if (byId) return { body: JSON.stringify({ data: Object.keys(row).length ? [row] : [] }) };
      return { body: JSON.stringify({ data: Object.keys(row).length ? [row] : [] }) };
    }
    if (url.includes('/tm/testdata/searchItr')) {
      const fields = body?.searchFields ?? [];
      const isSuite = fields.some((f: any) => f.column === 'suiteId');
      return { body: JSON.stringify({ data: isSuite ? state.suiteIterations : state.tcIterations }) };
    }
    if (url.includes('/tm/testdata/updateItr')) return { body: JSON.stringify({ data: { ok: true } }) };
    if (url.includes('/tm/testdata/saveItrForDataGen')) {
      return { body: JSON.stringify({ data: { inserted: (body?.data?.[0]?.iterations ?? []).length } }) };
    }
    if (method === 'PUT' && url.endsWith('/tm/testdata/update')) {
      // The suite-level save replaces/appends iterations for the definition row.
      state.suiteIterations = [...(body?.payload ?? [])];
      return { body: JSON.stringify({ data: { ok: true } }) };
    }
    if (method === 'PATCH' && url.endsWith('/tm/testdata')) {
      const ids = new Set((body?.id ?? []).map(String));
      state.suiteIterations = state.suiteIterations.filter((r) => !ids.has(String(r.id)));
      return { body: JSON.stringify({ data: { ok: true } }) };
    }
    return { status: 404, body: JSON.stringify({ message: `unexpected ${method} ${url}` }) };
  };

  const fetchImpl = (async (url: string, init: RequestInit) => {
    const { status = 200, body } = handler(url, init);
    return { ok: status < 300, status, text: async () => body };
  }) as unknown as typeof fetch;

  const adapter = new SimplifyQaAdapter(
    { baseUrl: 'https://x.test', token: 't', projectId: PROJECT_ID } as any,
    { fetchImpl, FormDataImpl: FormData },
  );
  return { adapter, calls, state };
}

test('getDefaultIteration resolves the env key, the version and masks protected seeds', async () => {
  const { adapter, calls } = makeAdapter();

  const tpl = await adapter.getDefaultIteration({ tcId: 'TC_42', environmentType: 'uat server' });

  expect(tpl).toEqual({
    tcId: 'TC_42',
    versionId: 'ver-1',
    environmentType: 'uat',
    parameters: [
      { paramId: 501, name: 'username', seed: 'qa@x.test' },
      { paramId: 502, name: 'apiToken', seed: '*****', protected: true },
      { paramId: 503, name: 'password', seed: '(empty)', protected: true },
      // 504 is a deleted/lookup-missing parameter and 'abc' is not a paramId — both dropped.
    ],
  });

  const fetchPath = calls.find((c) => c.url.includes('/tm/testdata/getDefaultItr'))!.url;
  expect(fetchPath).toBe(
    'https://x.test/tm/testdata/getDefaultItr?projectId=7&testcaseId=42&versionId=ver-1' +
    '&environmentType=uat&collection=TC&executionType=AUTOMATION',
  );
});

test('getDefaultIteration with includeProtected returns the real secret (internal copy path)', async () => {
  const { adapter } = makeAdapter();
  const tpl = await adapter.getDefaultIteration({ tcId: 'TC_42', includeProtected: true });
  expect(tpl.parameters).toEqual([
    { paramId: 501, name: 'username', seed: 'qa@x.test' },
    { paramId: 502, name: 'apiToken', seed: 's3cret', protected: true },
    { paramId: 503, name: 'password', seed: '', protected: true },
  ]);
  expect(tpl.environmentType).toBe('general'); // no caller env → the project's first key
});

test('getDefaultIteration refuses a test case with no resolvable version', async () => {
  const fetchImpl = (async (url: string) => {
    if (url.includes('/pm/auth/me')) return { ok: true, status: 200, text: async () => JSON.stringify({ userDetails: { id: CALLER_ID } }) };
    if (url.includes('/pm/projectuserrole')) return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ projectId: PROJECT_ID, roleId: 2 }] }) };
    if (url.includes('/tm/testcase/getById/42')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: 42, name: 'Bare', projectId: 7 } }) };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  }) as unknown as typeof fetch;
  const adapter = new SimplifyQaAdapter(
    { baseUrl: 'https://x.test', token: 't', projectId: PROJECT_ID } as any,
    { fetchImpl, FormDataImpl: FormData },
  );

  await expect(adapter.getDefaultIteration({ tcId: 'TC_42' }))
    .rejects.toThrow(/test case TC_42 has no versionId — pass one explicitly/);
});

test('patchTestdataCells writes the DEFAULT row only, keeps an existing formula and skips unknown params', async () => {
  const { adapter, calls } = makeAdapter({
    state: {
      tcIterations: [
        { id: 'itr-2', parentId: 'td-1', sequenceNo: 2, customerId: 9, data: [{ paramId: 501, value: 'B' }] },
        {
          id: 'itr-1', parentId: 'td-1', sequenceNo: 1, customerId: 9,
          data: [
            { paramId: 501, value: 'A', formulaValue: '=FIRST_NAME()' },
            { paramId: 502, value: 'old' },
          ],
        },
      ],
    },
  });

  const res = await adapter.patchTestdataCells({
    tcId: 'TC_42',
    cells: [
      { paramName: 'username', value: 'Dana', formulaValue: '=RANDOM_EMAIL()' },
      { paramName: 'APITOKEN', value: 'Go' },
      { paramName: 'nope', value: 'x' },
    ],
  });

  expect(res).toEqual({
    patched: 2,
    skipped: ['parameter "nope" is not in this version\'s test-data template'],
  });

  const updates = calls.filter((c) => c.url.includes('/tm/testdata/updateItr'));
  expect(updates).toHaveLength(1); // ITR-2 (the non-default row) is never touched
  expect(updates[0]!.body).toEqual({
    parentId: 'td-1',
    id: 'itr-1',
    customerId: 9,
    projectId: PROJECT_ID,
    data: [
      // The user's formula wins over the incoming one unless overwriteFormula is set…
      { paramId: 501, value: 'Dana', formulaValue: '=FIRST_NAME()' },
      // …and a case-insensitive parameter name still lands on the same paramId.
      { paramId: 502, value: 'Go' },
    ],
  });
});

test('patchTestdataCells with overwriteFormula replaces an existing formula', async () => {
  const { adapter, calls } = makeAdapter({
    state: {
      tcIterations: [
        {
          id: 'itr-1', parentId: 'td-1', sequenceNo: 1, customerId: 4,
          data: [{ paramId: 501, value: 'A', formulaValue: '=FIRST_NAME()' }],
        },
      ],
    },
  });

  await adapter.patchTestdataCells({
    tcId: 'TC_42',
    cells: [{ paramName: 'username', value: 'Dana', formulaValue: '=LAST_NAME()' }],
    overwriteFormula: true,
  });

  const update = calls.find((c) => c.url.includes('/tm/testdata/updateItr'))!;
  expect(update.body.customerId).toBe(4);
  expect(update.body.data).toEqual([{ paramId: 501, value: 'Dana', formulaValue: '=LAST_NAME()' }]);
});

test('patchTestdataCells without cells or without iterations writes nothing', async () => {
  const empty = makeAdapter();
  await expect(
    empty.adapter.patchTestdataCells({ tcId: 'TC_42', cells: [] }),
  ).resolves.toEqual({ patched: 0, skipped: [] });
  expect(empty.calls).toEqual([]);

  const noRows = makeAdapter();
  await expect(
    noRows.adapter.patchTestdataCells({ tcId: 'TC_42', cells: [{ paramName: 'username', value: 'x' }] }),
  ).resolves.toEqual({ patched: 0, skipped: ['no test-data iteration for TC_42 @ ver-1 / general'] });
  expect(noRows.calls.some((c) => c.url.includes('/tm/testdata/updateItr'))).toBe(false);
});

test('saveGeneratedIterations re-keys every row by paramId and appends checked iterations', async () => {
  const { adapter, calls } = makeAdapter();

  const res = await adapter.saveGeneratedIterations({
    tcId: 'TC_42',
    versionId: 'ver-1',
    environmentType: 'general',
    rows: [
      { username: 'dana', BUTTON: 'Go', unrelated: 'dropped' },
      { username: 'sam' },
    ],
    parameters: [
      { paramId: 501, name: 'username', seed: '' },
      { paramId: 502, name: 'Button', seed: '' },
    ],
  });

  expect(res).toEqual({ tcId: 'TC_42', inserted: 2 });

  const save = calls.find((c) => c.url.includes('/tm/testdata/saveItrForDataGen'))!;
  expect(save.body).toEqual({
    projectId: PROJECT_ID,
    data: [{
      type: 'TC',
      id: 42,
      versionId: 'ver-1',
      environmentType: 'general',
      projectId: PROJECT_ID,
      iterations: [
        { isChecked: true, data: [{ paramId: 501, value: 'dana' }, { paramId: 502, value: 'Go' }] },
        { isChecked: true, data: [{ paramId: 501, value: 'sam' }] },
      ],
    }],
  });
  // The caller's template is reused — no second /getDefaultItr round trip.
  expect(calls.some((c) => c.url.includes('/tm/testdata/getDefaultItr'))).toBe(false);
});

test('saveGeneratedIterations refuses an empty row list and a missing versionId', async () => {
  const { adapter, calls } = makeAdapter();
  await expect(adapter.saveGeneratedIterations({
    tcId: 'TC_42', versionId: 'ver-1', environmentType: 'general', rows: [],
  })).rejects.toThrow(/rows\[\] required and non-empty/);

  await expect(adapter.saveGeneratedIterations({
    tcId: 'TC_42', versionId: '', environmentType: 'general', rows: [{ username: 'x' }],
  })).rejects.toThrow(/versionId required/);

  expect(calls).toEqual([]);
});

test('deleteTestdataIterations patches the named rows only, against the suite definition row', async () => {
  const { adapter, calls, state } = makeAdapter({
    state: {
      suiteTd: {
        id: 'td-su-1', type: 'SU', projectId: PROJECT_ID, updateVersion: 3,
        defaultIteration: { general: 'itr-1' }, executionType: 'AUTOMATION',
      },
      suiteIterations: [
        { id: 'itr-1', name: 'ITR-1', sequenceNo: 1, data: [] },
        { id: 'itr-2', name: 'ITR-2', sequenceNo: 2, data: [] },
        { id: 'itr-3', name: 'ITR-3', sequenceNo: 3, data: [] },
      ],
    },
  });

  const res = await adapter.deleteTestdataIterations({
    entityType: 'SU', id: 'SU-17', environmentType: 'general', iterations: ['ITR-2'],
  });

  expect(res.deleted).toEqual(['itr-2']);
  expect(res.rows.iterations.map((r) => r.name)).toEqual(['ITR-1', 'ITR-3']);
  expect(state.suiteIterations.map((r) => r.id)).toEqual(['itr-1', 'itr-3']);

  const patch = calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/tm/testdata'))!;
  expect(patch.body).toEqual({
    id: ['itr-2'],
    testdata: { id: 'td-su-1', defaultIteration: { general: 'itr-1' }, updateVersion: 3, projectId: PROJECT_ID },
    payload: [],
  });
  // The definition lookup asks the SUITE column — never the test-case one.
  const lookup = calls.find((c) => c.url.includes('/tm/testdata/searchTd'))!;
  expect(lookup.body.searchFields).toEqual(expect.arrayContaining([
    { column: 'type', value: 'SU', regEx: false },
    { column: 'suiteId', value: 17, regEx: false },
    { column: 'projectId', value: PROJECT_ID },
  ]));
});

test('deleteTestdataIterations refuses the DEFAULT row and an unknown name', async () => {
  const { adapter, calls } = makeAdapter({
    state: {
      suiteTd: {
        id: 'td-su-1', type: 'SU', projectId: PROJECT_ID,
        defaultIteration: { general: 'itr-1' }, executionType: 'AUTOMATION',
      },
      suiteIterations: [
        { id: 'itr-1', name: 'ITR-1', sequenceNo: 1, data: [] },
        { id: 'itr-2', name: 'ITR-2', sequenceNo: 2, data: [] },
      ],
    },
  });

  await expect(adapter.deleteTestdataIterations({
    entityType: 'SU', id: 'SU-17', environmentType: 'general', iterations: ['ITR-1'],
  })).rejects.toThrow(/"ITR-1" is the DEFAULT iteration and cannot be deleted/);

  await expect(adapter.deleteTestdataIterations({
    entityType: 'SU', id: 'SU-17', environmentType: 'general', iterations: ['ITR-9'],
  })).rejects.toThrow(/No iteration "ITR-9" on SU SU-17[\s\S]*ITR-1, ITR-2/);

  expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
});

test('getSuiteTestdata reads the SUITE store (definition row, rows, parameter names)', async () => {
  const { adapter, calls } = makeAdapter({
    state: {
      suiteTd: {
        id: 'td-su-1', type: 'SU', projectId: PROJECT_ID, versionId: 'v9',
        executionType: 'AUTOMATION', updateVersion: 4,
        defaultIteration: { general: 'itr-s1' },
      },
      suiteIterations: [
        { id: 'itr-s1', name: 'ITR-1', sequenceNo: 1, isChecked: true, environmentType: 'general',
          data: [{ paramId: 501, value: 'qa@x.test' }] },
      ],
    },
  });

  const rows = await adapter.getSuiteTestdata({ suiteId: 'SU-17' });

  expect(rows).toMatchObject({
    entityType: 'SU',
    id: '17',
    testdataId: 'td-su-1',
    environmentType: 'general',
    defaultIterationId: 'itr-s1',
    parameterNames: { '501': 'username' },
  });
  expect(rows.iterations).toHaveLength(1);
  expect(rows.iterations[0]).toMatchObject({
    id: 'itr-s1', name: 'ITR-1', isChecked: true,
    data: [{ paramId: 501, name: 'username', value: 'qa@x.test' }],
  });
  expect((rows as any).definition).toMatchObject({ id: 'td-su-1', updateVersion: 4 });

  // The iteration scan is scoped to the suite + its version, never to a test case.
  const itrSearch = calls.find((c) => c.url.includes('/tm/testdata/searchItr'))!;
  expect(itrSearch.body.searchFields).toEqual(expect.arrayContaining([
    { column: 'suiteId', value: 17, regEx: false },
    { column: 'environmentType', value: 'general', regEx: false },
    { column: 'versionId', value: 'v9', regEx: false },
  ]));
});

test('copySuiteTestdataIteration saves a NEW suite-level row and never touches a member test case', async () => {
  const { adapter, calls, state } = makeAdapter({
    state: {
      suiteTd: {
        id: 'td-su-1', type: 'SU', projectId: PROJECT_ID, executionType: 'AUTOMATION',
        updateVersion: 4, defaultIteration: { general: 'itr-s1' },
      },
      suiteIterations: [
        { id: 'itr-s1', name: 'ITR-1', sequenceNo: 1, isChecked: true, environmentType: 'general',
          data: [{ paramId: 501, value: 'qa@x.test' }] },
      ],
    },
  });

  const res = await adapter.copySuiteTestdataIteration({ suiteId: 'SU-17', environmentType: 'general' });

  expect(res.name).toBe('ITR-2');
  expect(res.iterationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(res.rows.iterations.map((r) => r.name)).toEqual(['ITR-2']);

  const put = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/tm/testdata/update'))!;
  expect(put.body.testdata).toEqual({
    id: 'td-su-1',
    defaultIteration: { general: 'itr-s1' },
    updateVersion: 4,
  });
  const saved = put.body.payload[0];
  expect(saved).toMatchObject({
    // The copy keeps the source VALUES but is a brand-new, non-active iteration.
    name: 'ITR-2',
    environmentType: 'general',
    sequenceNo: 2,
    isChecked: false,
    newIteration: true,
    data: [{ paramId: 501, value: 'qa@x.test' }],
  });
  expect(saved.id).toBe(res.iterationId);
  expect(state.suiteIterations).toHaveLength(1); // the mock's list now holds the saved payload
  expect(calls.some((c) => c.url.includes('/tm/testcase/'))).toBe(false);
});

test('copySuiteTestdataIteration refuses a name the suite already uses', async () => {
  const { adapter, calls } = makeAdapter({
    state: {
      suiteTd: {
        id: 'td-su-1', type: 'SU', projectId: PROJECT_ID, executionType: 'AUTOMATION',
        defaultIteration: { general: 'itr-s1' },
      },
      suiteIterations: [
        { id: 'itr-s1', name: 'ITR-1', sequenceNo: 1, data: [] },
        { id: 'itr-s2', name: 'ITR-2', sequenceNo: 2, data: [] },
      ],
    },
  });

  await expect(adapter.copySuiteTestdataIteration({
    suiteId: 'SU-17', environmentType: 'general', name: 'ITR-2',
  })).rejects.toThrow(/already has a suite-level iteration named "ITR-2"/);
  expect(calls.some((c) => c.method === 'PUT')).toBe(false);
});
