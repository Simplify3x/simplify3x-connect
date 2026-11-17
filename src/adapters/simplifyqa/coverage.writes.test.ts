import { SimplifyQaAdapter } from './adapter.js';
/** WRITE paths: the test-case lifecycle (create/update/clone/delete payload building), the object
 *  repository (create/update/delete + dependency preview) and the backlog writes (story / epic /
 *  feature defaults, two-phase delete, watch list, linkages).
 *
 *  Everything runs through the REAL adapter: the project-access gate (/pm/auth/me →
 *  /pm/projectuserrole?userId=) answers first, then the endpoint router. Payload assertions are on
 *  the actual wire body — the multipart blob the backend receives (`testcaseObj`) or the JSON body —
 *  never on a fixture, so a payload regression fails here. */

type Reply = {
  status?: number;
  body: string;
};

type Handler = (url: string, init: RequestInit) => Reply | undefined;

type Call = {
  method: string;
  url: string;
  body: any;
  raw: any;
};

const ME = { userDetails: { id: 36, username: 'qa.user', email: 'qa.user@x.test', userType: 'user' } };

const ROLES = { data: [{ userId: 36, projectId: 7, roleId: 2, deleted: false }] };

function response({ status = 200, body }: Reply) {
  return { ok: status < 300, status, text: async () => body };
}

function makeAdapter(handler: Handler = () => undefined) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    let body: any = undefined;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url, body, raw: init.body });
    const out = handler(url, init);
    if (out)
      return response(out);
    if (url.includes('/pm/auth/me'))
      return response({ body: JSON.stringify(ME) });
    if (url.includes('/pm/projectuserrole?userId='))
      return response({ body: JSON.stringify(ROLES) });
    // Every save resolves the parameter catalog's access types before it writes.
    if (url.endsWith('/tm/parameter/search'))
      return response({ body: JSON.stringify({ data: [] }) });
    return response({ status: 404, body: JSON.stringify({ message: `unexpected ${method} ${url}` }) });
  }) as unknown as typeof fetch;
  const adapter = new SimplifyQaAdapter({ baseUrl: 'https://x.test', token: 't', projectId: 7 } as any, { fetchImpl, FormDataImpl: FormData });
  return { adapter, calls };
}
/** The multipart field the adapter posted under `partName`. */

function part(call: Call, partName: string): any {
  const fd = call.raw as FormData;
  const raw = fd.get(partName);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

const byPath = (calls: Call[], method: string, suffix: string) => calls.filter((c) => c.method === method && c.url.split('?')[0]!.endsWith(suffix));

// ---------------------------------------------------------------- test cases

test('createTestCase (manual) resolves ${tokens} to parameter ids and posts the UI-shaped testcaseObj', async () => {
  let created = false;
  const { adapter, calls } = makeAdapter((url, init) => {
    if (url.endsWith('/tm/parameter/search') && init.method === 'POST') {
      // First call is the get-or-create lookup (nothing exists yet); the second is the access-type catalog.
      const body = JSON.parse(String(init.body));
      if (body.selectFields?.includes('type'))
        return { body: JSON.stringify({ data: [{ id: 901, name: 'username', type: 'Local' }] }) };
      return { body: JSON.stringify({ data: [] }) };
    }
    if (url.endsWith('/tm/parameter') && init.method === 'POST') {
      created = true;
      return { body: JSON.stringify({ data: { id: 901 } }) };
    }
    if (url.endsWith('/tm/testcase') && init.method === 'POST') {
      return { body: JSON.stringify({ data: { id: 640, code: 'TC-640', name: 'Login (manual)' } }) };
    }
    return undefined;
  });
  const ref = await adapter.createTestCase({
    title: 'Login (manual)',
    category: 'manual',
    folderOrModule: '3',
    data: { username: 'admin' },
    steps: [
      { n: 1, stepType: 'manual', actionType: 'manual', description: 'Enter ${username}', expectedResult: 'Logged in' },
    ],
  });
  expect(ref).toEqual({ id: '640', created: true });
  expect(created).toBe(true);
  // Parameter get-or-create: exact lookup, then exact create body.
  const lookup = byPath(calls, 'POST', '/tm/parameter/search')[0]!;
  expect(lookup.body).toEqual({
    searchFields: [
      { column: 'deleted', value: false },
      { column: 'name', value: 'username', ignorecase: true },
      { column: 'projectId', value: 7 },
    ],
    startIndex: 0,
    limit: 10,
  });
  const create = byPath(calls, 'POST', '/tm/parameter')[0]!;
  expect(create.body).toEqual({
    name: 'username',
    projectId: 7,
    protected: false,
    moduleId: 3,
    defaultValue: 'admin',
    type: 'Local',
    parameterType: 'Alphanumeric',
    description: '',
    unique: false,
    concat: '',
    paramAttributes: { minLength: 0, maxLength: 0, prefix: '', suffix: '' },
  });
  const save = byPath(calls, 'POST', '/tm/testcase')[0]!;
  const payload = part(save, 'testcaseObj');
  expect(save.url).toBe('https://x.test/tm/testcase');
  expect(payload.tcfnObj).toEqual({
    name: 'Login (manual)',
    userstoryId: null,
    defectId: [],
    suiteId: [],
    description: '',
    projectId: 7,
    tcType: 'WEB',
    executionType: 'MANUAL',
    obsolete: false,
    linkedIssues: [],
    moduleId: 3,
    prerequisite: '',
    customFields: {},
    tags: [],
    mailersList: { users: [], nonUsers: [], groups: [] },
    updateVersion: 0,
  });
  expect(payload.versionsDetails).toEqual({
    name: 'v1.0',
    id: '',
    syncONOFF: '',
    manualStepsTopreview: false,
    updateVersion: 0,
    executionType: 'MANUAL',
    reviewApproveStatus: '',
    functionProjectIds: [7],
  });
  // The prose is human-readable (`${}` stripped) while the binding rides on parameterIds/recordedParam.
  expect(payload.steps.manualSteps).toEqual([
    {
      projectId: 7,
      moduleId: 3,
      type: 'TC',
      stepType: 'NORMAL_STATEMENT',
      seq: 1,
      description: 'Enter username',
      expectedResult: 'Logged in',
      executionType: 'MANUAL',
      stepLevelActions: { skip: false, captureScreenshot: false, continueOnFailure: false, skippedReport: false },
      parameterIds: [901],
      recordedParam: { '901': 'admin' },
    },
  ]);
  expect(payload.steps.automationSteps).toEqual([]);
  expect(payload.operation).toBe('TC');
});

test('createTestCase (automated) resolves the action catalog + creates the object, then posts actionId/objectId', async () => {
  let objectCreateBody: any;
  const { adapter, calls } = makeAdapter((url, init) => {
    if (url.endsWith('/tm/action/search')) {
      return { body: JSON.stringify({ data: [
            { id: 55, name: 'click', disname: 'Click', objectTemplate: 3, objectRequired: true, uniqueId: 'web-1' },
          ] }) };
    }
    if (url.endsWith('/tm/objectTemplate/search')) {
      return { body: JSON.stringify({ data: [{ id: 3, name: 'WEB' }] }) };
    }
    if (url.endsWith('/tm/object/search')) {
      // The name lookup for the step's object finds nothing, so the object is created.
      return { body: JSON.stringify({ data: [] }) };
    }
    if (url.endsWith('/tm/object/createObjectSeq')) {
      objectCreateBody = JSON.parse(String(init.body));
      return { body: JSON.stringify({ data: { id: 700, disname: 'Login button' } }) };
    }
    if (url.endsWith('/tm/testcase') && init.method === 'POST') {
      return { body: JSON.stringify({ data: { id: 641 } }) };
    }
    return undefined;
  });
  const ref = await adapter.createTestCase({
    title: 'Checkout',
    category: 'automated',
    folderOrModule: '3',
    steps: [
      {
        n: 1,
        stepType: 'web',
        actionType: 'Click',
        description: 'Click Login',
        objectRef: { name: 'Login button', locators: [{ name: 'xpath', value: '//button[@id="login"]' }] },
      },
    ],
  });
  expect(ref).toEqual({ id: '641', created: true });
  // Object get-or-create: template id came from the objectTemplate map, module from the TC.
  expect(objectCreateBody).toEqual({
    projectId: 7,
    moduleId: 3,
    objecttemplateId: 3,
    technology: 'WEB',
    disname: 'Login button',
    attributes: [{ name: 'xpath', value: '//button[@id="login"]' }],
    parameterId: [],
    description: '',
  });
  const payload = part(byPath(calls, 'POST', '/tm/testcase')[0]!, 'testcaseObj');
  expect(payload.tcfnObj).toEqual({
    name: 'Checkout',
    userstoryId: null,
    defectId: [],
    suiteId: [],
    description: '',
    projectId: 7,
    tcType: 'WEB',
    executionType: 'AUTOMATION',
    obsolete: false,
    linkedIssues: [],
    moduleId: 3,
    prerequisite: '',
    customFields: {},
    tags: [],
    mailersList: { users: [], nonUsers: [], groups: [] },
    originalExecutinType: 'AUTOMATION',
    updateVersion: 0,
  });
  expect(payload.steps.manualSteps).toEqual([]);
  const step = payload.steps.automationSteps[0];
  expect(step).toMatchObject({
    actionId: 55,
    objectId: 700,
    projectId: 7,
    moduleId: 3,
    type: 'TC',
    stepType: 'NORMAL_STATEMENT',
    seq: 1,
    description: 'Click Login',
    expectedResult: '',
    executionType: 'AUTOMATION',
    technologyType: 'WEB',
    parameterIds: [],
    recordedParam: {},
    objectParameterIds: [],
    conditions: { ifstring: '', children: [] },
    stepLevelActions: { skip: false, captureScreenshot: false, continueOnFailure: false, skippedReport: false },
  });
  expect(step.objectId).toBe(700);
  // The catalog is fetched once per adapter, filtered — exactly the UI's own filter.
  const catalogCall = byPath(calls, 'POST', '/tm/action/search')[0]!;
  expect(catalogCall.body.searchFields).toEqual([
    { column: 'deleted', value: false },
    { column: 'projectId', value: { $in: [0, 7] } },
  ]);
});

test('updateTestCase sends a step dropped from the draft back as deleted:true (deletion reconciliation)', async () => {
  const rawTc = {
    id: 42, name: 'Checkout', projectId: 7, moduleId: 3, executionType: 'MANUAL',
    versionId: 'v1', versions: [{ id: 'v1', name: 'v1.0' }], versionsDetails: { id: 'v1', name: 'v1.0' },
  };
  const stepRows = [
    { id: 's1', seq: 1, description: 'Open page', executionType: 'MANUAL', versionId: 'v1' },
    { id: 's2', seq: 2, description: 'Deprecated step', executionType: 'MANUAL', versionId: 'v1' },
  ];
  const { adapter, calls } = makeAdapter((url, init) => {
    if (url.includes('/tm/testcase/getById/42'))
      return { body: JSON.stringify({ data: rawTc }) };
    if (url.includes('/tm/testcase/steps'))
      return { body: JSON.stringify({ data: stepRows }) };
    if (url.endsWith('/tm/testcase') && init.method === 'PUT')
      return { body: JSON.stringify({ data: { id: 42 } }) };
    return undefined;
  });
  const tc = await adapter.getTestCase('TC_42');
  expect(tc.steps.map((s) => s.sourceId)).toEqual(['s1', 's2']);
  // The draft keeps step 1 only — step 2 was removed by the user.
  await adapter.updateTestCase('TC_42', { ...tc, steps: [tc.steps[0]!] });
  const payload = part(byPath(calls, 'PUT', '/tm/testcase')[0]!, 'testcaseObj');
  expect(payload.tcfnObj).toMatchObject({ id: 42, name: 'Checkout', deleted: false, executionType: 'MANUAL' });
  expect(payload.steps.automationSteps).toEqual([]);
  expect(payload.steps.manualSteps).toHaveLength(2);
  expect(payload.steps.manualSteps[0]).toMatchObject({ id: 's1', seq: 1, deleted: false, parentId: 42, versionId: 'v1' });
  // The dropped row is resent with its backend id + deleted:true — an absent step alone deletes nothing.
  expect(payload.steps.manualSteps[1]).toMatchObject({
    id: 's2', seq: 2, description: 'Deprecated step', executionType: 'MANUAL', deleted: true, parentId: 42, versionId: 'v1',
  });
  expect(payload.steps.manualSteps[1].parameterIds).toBeUndefined();
});

test('cloneTestCase posts SAVEASNEWTC with the source version pinned and an allow-listed tcfnObj', async () => {
  const rawTc = {
    id: 42, code: 'TC-42', name: 'Checkout', projectId: 7, moduleId: 3, tcType: 'WEB',
    executionType: 'AUTOMATION', versionId: 'v2', updateVersion: 5, createdBy: 36, stepCount: 2,
    versionsDetails: { id: 'v2', name: 'v2.0', syncONOFF: 'SYNCOFF' },
    versions: [{ id: 'v1', name: 'v1.0' }, { id: 'v2', name: 'v2.0' }],
  };
  // The source VERSION's steps — the clone never copies whichever version the TC has open.
  const stepRows = [
    { id: 'a', seq: 1, description: 'Launch', executionType: 'AUTOMATION', technologyType: 'WEB', actionId: 12, objectId: 4, versionId: 'v2', recordedParam: { '7': 'x' } },
    { id: 'b', seq: 2, description: 'Manual check', executionType: 'MANUAL', versionId: 'v2' },
  ];
  let stepsUrl = '';
  const { adapter, calls } = makeAdapter((url, init) => {
    if (url.includes('/tm/testcase/getById/42'))
      return { body: JSON.stringify({ data: rawTc }) };
    if (url.includes('/tm/testcase/steps')) {
      stepsUrl = url;
      return { body: JSON.stringify({ data: stepRows }) };
    }
    if (url.endsWith('/tm/testcase') && init.method === 'PUT')
      return { body: JSON.stringify({ data: { id: 43 } }) };
    return undefined;
  });
  const ref = await adapter.cloneTestCase('TC_42', 'Checkout copy', { tdCopy: true });
  expect(ref).toEqual({
    id: '43', created: true, productUrl: 'https://x.test/user/testcase/details/43',
  });
  const payload = part(byPath(calls, 'PUT', '/tm/testcase')[0]!, 'testcaseObj');
  expect(payload.operation).toBe('SAVEASNEWTC');
  expect(payload.type).toBe('TC');
  expect(payload.verData).toEqual({ tdCopy: true, selVersionId: 'v2' });
  expect(payload.versionsDetails).toEqual({
    name: 'v2.0',
    id: '',
    syncONOFF: '',
    deleted: false,
    executionType: 'AUTOMATION',
    functionProjectIds: [7],
    reviewApproveStatus: '',
  });
  // Strict allow-list: audit/derived fields (`code`, `createdBy`, `stepCount`, `versions`) are dropped.
  expect(Object.keys(payload.tcfnObj).sort()).toEqual(['copiedFromTcId', 'deleted', 'executionType', 'id', 'moduleId', 'name', 'obsolete', 'projectId', 'tcType', 'updateVersion']);
  expect(payload.tcfnObj).toMatchObject({
    id: 42, name: 'Checkout copy', copiedFromTcId: 42, deleted: false, projectId: 7, moduleId: 3, tcType: 'WEB', obsolete: false,
  });
  expect(payload.steps.automationSteps).toHaveLength(1);
  // Server-assigned ids / version ids are stripped so the backend creates fresh rows under the copy.
  expect(payload.steps.automationSteps[0]).toEqual({
    seq: 1, description: 'Launch', executionType: 'AUTOMATION', technologyType: 'WEB', actionId: 12, objectId: 4,
  });
  expect(payload.steps.manualSteps).toEqual([{ seq: 2, description: 'Manual check', executionType: 'MANUAL' }]);
  expect(stepsUrl).toContain('versionId=v2');
  // A function business key can never reach the TC-only clone endpoint.
  await expect(adapter.cloneTestCase('FN_42', 'nope', { tdCopy: false })).rejects.toThrow(/Refusing to run against FN_42: this is a function key/);
  await expect(adapter.cloneTestCase('TC_42', '   ', { tdCopy: false })).rejects.toThrow('newTitle is required');
});

test('deleteTestCase is a soft delete, and reports the blocking dependencies instead of a fake success', async () => {
  let blocked = true;
  const { adapter, calls } = makeAdapter((url, init) => {
    if (url.endsWith('/tm/testcase/delete') && init.method === 'POST') {
      return {
        body: JSON.stringify({
          data: blocked
            ? [{ id: 42, defectArr: { '7': [91] }, suiteArr: { '7': [12, 13] }, epArr: {} }]
            : true,
        }),
      };
    }
    return undefined;
  });
  await expect(adapter.deleteTestCase('TC_42')).rejects.toThrow('Not deleted — test case is still referenced by defects (91); suites (12, 13). Remove those references first.');
  expect(byPath(calls, 'POST', '/tm/testcase/delete')[0]!.body).toEqual({ ids: [42], projectId: 7, isDelete: true });
  blocked = false;
  await expect(adapter.deleteTestCase('42')).resolves.toBeUndefined();
  expect(byPath(calls, 'POST', '/tm/testcase/delete')).toHaveLength(2);
});

// ---------------------------------------------------------------- objects

test('createObject maps objectType → objecttemplateId and defaults the module to "Default Module"', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.endsWith('/tm/object/search'))
      return { body: JSON.stringify({ data: [] }) };
    if (url.endsWith('/tm/objectTemplate/search'))
      return { body: JSON.stringify({ data: [{ id: 3, name: 'WEB' }] }) };
    if (url.endsWith('/pm/module/search'))
      return { body: JSON.stringify({ data: [{ id: 9, name: 'Default Module', isRoot: true }] }) };
    if (url.endsWith('/tm/object') && url.match(/\/tm\/object$/)) {
      return { body: JSON.stringify({ data: {
            id: 501, disname: 'Login button', technology: 'WEB', objecttemplateId: 3, moduleId: 9,
            attributes: [{ name: 'xpath', value: '//button', unique: true }],
          } }) };
    }
    return undefined;
  });
  const obj = await adapter.createObject({
    name: 'Login button', objectType: 'WEB',
    locators: [{ name: 'xpath', value: '//button', unique: true }],
  } as any);
  expect(obj).toMatchObject({
    id: '501', name: 'Login button', objectType: 'WEB', objectTemplateId: '3', moduleId: '9',
    locators: [{ name: 'xpath', value: '//button', unique: true }],
  });
  expect(byPath(calls, 'POST', '/tm/object')[0]!.body).toEqual({
    disname: 'Login button',
    objecttemplateId: 3,
    parameterId: [],
    projectId: 7,
    technology: 'WEB',
    moduleId: 9,
    attributes: [{ name: 'xpath', value: '//button', unique: true }],
  });
});

test('createObject reuses an identical object, updates a differing one, and refuses a missing/unknown object type', async () => {
  {
    let locators = [{ name: 'xpath', value: '//button' }];
    const existing = () => ({ id: 501, disname: 'Login button', technology: 'WEB', objectType: 'WEB', locators, attributes: locators });
    const upserts: any[] = [];
    const { adapter, calls } = makeAdapter((url, init) => {
      if (url.endsWith('/tm/object/search'))
        return { body: JSON.stringify({ data: [existing()] }) };
      if (url.match(/\/tm\/object\/501$/) && init.method === 'GET')
        return { body: JSON.stringify({ data: { ...existing(), objecttemplateId: 3, updateVersion: 1 } }) };
      if (url.match(/\/tm\/object\/501$/) && init.method === 'PUT') {
        upserts.push(JSON.parse(String(init.body)));
        locators = JSON.parse(String(init.body)).attributes;
        return { body: JSON.stringify({ data: { ...existing(), attributes: locators } }) };
      }
      return undefined;
    });
    // Same locators → the stored object, no write.
    const same = await adapter.createObject({ name: 'Login button', objectType: 'WEB', locators: [{ name: 'xpath', value: '//button' }] } as any);
    expect(same.id).toBe('501');
    expect(upserts).toHaveLength(0);
    expect(byPath(calls, 'POST', '/tm/object')).toHaveLength(0);
    // Different locators → the object is UPDATED in place (no second object created).
    const changed = await adapter.createObject({ name: 'login BUTTON', objectType: 'WEB', locators: [{ name: 'xpath', value: '//a' }] } as any);
    expect(changed.id).toBe('501');
    expect(upserts).toHaveLength(1);
    expect(upserts[0].attributes).toEqual([{ name: 'xpath', value: '//a' }]);
    expect(byPath(calls, 'POST', '/tm/object')).toHaveLength(0);
  }
  {
    const { adapter, calls } = makeAdapter((url) => {
      if (url.endsWith('/tm/objectTemplate/search'))
        return { body: JSON.stringify({ data: [{ id: 3, name: 'WEB' }] }) };
      return undefined;
    });
    await expect(adapter.createObject({ name: 'X', locators: [] } as any)).rejects.toThrow('createObject: objectType is required (e.g. "WEB", "ANDROID")');
    await expect(adapter.createObject({ name: 'X', objectType: 'SAP', locators: [] } as any)).rejects.toThrow('Unknown object type/technology "SAP" — known: WEB.');
    // Neither refusal reached the object create endpoint.
    expect(byPath(calls, 'POST', '/tm/object')).toHaveLength(0);
  }
});

test('updateObject upserts locators, applies the exclusive default, re-sends the whole document and refuses unknown names', async () => {
  {
    const doc = {
      id: 5, disname: 'Login', description: 'the button', objecttemplateId: 3, parameterId: [11], moduleId: 2,
      technology: 'WEB', updateVersion: 4, thumbnail_url: 'thumb.png', pageScreenShot_url: '',
      attributes: [{ name: 'xpath', value: '//old' }, { name: 'css', value: '.login' }],
    };
    const { adapter, calls } = makeAdapter((url, init) => {
      if (url.endsWith('/tm/object/5') && (init.method ?? 'GET') === 'GET')
        return { body: JSON.stringify({ data: doc }) };
      if (url.endsWith('/tm/parameter/search'))
        return { body: JSON.stringify({ data: [{ id: 77, name: 'user' }] }) };
      if (url.endsWith('/pm/module/search'))
        return { body: JSON.stringify({ data: [{ id: 8, name: 'Checkout' }] }) };
      if (url.endsWith('/tm/object/5') && init.method === 'PUT') {
        return { body: JSON.stringify({ data: { ...doc, disname: 'Renamed', attributes: JSON.parse(String(init.body)).attributes } }) };
      }
      return undefined;
    });
    const out = await adapter.updateObject('5', {
      name: 'Renamed',
      locators: [
        { name: 'xpath', value: '//new', unique: true },
        { name: 'id', value: 'login' },
      ],
      defaultLocator: 'id',
      parameterNames: ['user'],
      moduleName: 'Checkout',
    });
    expect(out).toMatchObject({ id: '5', name: 'Renamed' });
    expect(byPath(calls, 'PUT', '/tm/object/5')[0]!.body).toEqual({
      disname: 'Renamed',
      description: 'the button',
      objecttemplateId: 3,
      parameterId: [77],
      moduleId: 8,
      technology: 'WEB',
      attributes: [
        { name: 'xpath', value: '//new' },
        { name: 'css', value: '.login' },
        { name: 'id', value: 'login', unique: true },
      ],
      thumbnail_url: 'thumb.png',
      projectId: 7,
      updateVersion: 4,
    });
  }
  {
    const doc = { id: 5, disname: 'Login', objecttemplateId: 3, parameterId: [], moduleId: 2, technology: 'WEB', updateVersion: 1, attributes: [{ name: 'xpath', value: '//a' }] };
    const { adapter, calls } = makeAdapter((url) => {
      if (url.endsWith('/tm/object/5'))
        return { body: JSON.stringify({ data: doc }) };
      if (url.endsWith('/tm/parameter/search'))
        return { body: JSON.stringify({ data: [] }) };
      if (url.endsWith('/pm/module/search'))
        return { body: JSON.stringify({ data: [{ id: 8, name: 'Checkout' }] }) };
      return undefined;
    });
    await expect(adapter.updateObject('5', { defaultLocator: 'nope' })).rejects.toThrow('Cannot make "nope" the default of object 5: it has no locator with that name. Its locators: xpath');
    await expect(adapter.updateObject('5', { moduleName: 'Missing' })).rejects.toThrow('Module "Missing" not found on object 5. Valid modules: Checkout');
    await expect(adapter.updateObject('5', { parameterNames: ['ghost'] })).rejects.toThrow('Parameter(s) not found on object 5: ghost');
    expect(byPath(calls, 'PUT', '/tm/object/5')).toHaveLength(0);
  }
});

test('deleteObject previews its dependencies and only deletes a dependency-free object', async () => {
  let dirty = true;
  const { adapter, calls } = makeAdapter((url, init) => {
    if (url.endsWith('/tm/object') && init.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      if (body.isDelete === false) {
        return dirty
          ? { body: JSON.stringify({ data: [{ id: 5, tcArr: { '7': [1, 2] }, fnArr: { '7': [3] }, wfArr: {} }] }) }
          : { body: JSON.stringify({ data: [{ id: 5, tcArr: {}, fnArr: {}, wfArr: {} }] }) };
      }
      return { body: JSON.stringify({ data: [{ id: 5 }] }) };
    }
    return undefined;
  });
  await expect(adapter.deleteObject('5')).rejects.toThrow('Cannot delete object 5 — still used by 2 test cases, 1 function.');
  expect(byPath(calls, 'PATCH', '/tm/object').map((c) => c.body)).toEqual([
    { ids: [5], projectId: 7, isDelete: false },
  ]);
  dirty = false;
  await expect(adapter.deleteObject('5')).resolves.toBeUndefined();
  expect(byPath(calls, 'PATCH', '/tm/object').map((c) => c.body)).toEqual([
    { ids: [5], projectId: 7, isDelete: false },
    { ids: [5], projectId: 7, isDelete: false },
    { ids: [5], projectId: 7, isDelete: true },
  ]);
  expect(dirty).toBe(false);
});

test('updateParameter sends the whole definition back, proves the change landed and refuses a Global parameter', async () => {
  {
    const docs: Record<string, any> = {
      '900': {
        id: 900, name: 'host', type: 'Local', defaultValue: 'a', description: '', parameterType: 'Alphanumeric',
        paramAttributes: { minLength: 0, maxLength: 0, prefix: '', suffix: '' }, protected: false, unique: false,
        concat: '', updateVersion: 3, moduleId: 2,
      },
      '901': {
        id: 901, name: 'region', type: 'Local', defaultValue: 'eu', description: '', parameterType: 'Alphanumeric',
        paramAttributes: { minLength: 0, maxLength: 0, prefix: '', suffix: '' }, protected: false, unique: false,
        concat: '', updateVersion: 1,
      },
    };
    const { adapter, calls } = makeAdapter((url, init) => {
      const m = url.match(/\/tm\/parameter\/(\d+)$/);
      if (m && (init.method ?? 'GET') === 'GET')
        return { body: JSON.stringify({ data: docs[m[1]!] }) };
      if (m && init.method === 'PUT') {
        docs[m[1]!] = { ...docs[m[1]!], ...JSON.parse(String(init.body)) };
        return { body: JSON.stringify({ data: docs[m[1]!] }) };
      }
      if (url.endsWith('/tm/parameter/search'))
        return { body: JSON.stringify({ data: [{ id: 901, name: 'region' }] }) };
      return undefined;
    });
    const out = await adapter.updateParameter('900', { type: 'Runtime', defaultValue: 'b' });
    expect(out).toEqual({ id: '900', name: 'host', type: 'Runtime', defaultValue: 'b', changed: ['type Local -> Runtime', 'defaultValue'] });
    expect(byPath(calls, 'PUT', '/tm/parameter/900')[0]!.body).toEqual({
      name: 'host',
      projectId: 7,
      moduleId: 2,
      description: '',
      parameterType: 'Alphanumeric',
      defaultValue: 'b',
      paramAttributes: { minLength: 0, maxLength: 0, prefix: '', suffix: '' },
      protected: false,
      type: 'Runtime',
      unique: false,
      concat: '',
      updateVersion: 3,
    });
    // By NAME, an unknown parameter, and a no-op change each refuse before writing.
    const before = byPath(calls, 'PUT', '/tm/parameter/900').length + byPath(calls, 'PUT', '/tm/parameter/901').length;
    const named = await adapter.updateParameter('region', { description: 'x' });
    expect(named).toEqual({ id: '901', name: 'region', type: 'Local', defaultValue: 'eu', changed: ['description'] });
    expect(byPath(calls, 'PUT', '/tm/parameter/901')[0]!.body).toMatchObject({ name: 'region', projectId: 7, description: 'x', updateVersion: 1 });
    await expect(adapter.updateParameter('ghost', { description: 'x' })).rejects.toThrow('Parameter "ghost" was not found in this project');
    await expect(adapter.updateParameter('900', {})).rejects.toThrow('Nothing to change - pass type, defaultValue and/or description.');
    expect(byPath(calls, 'PUT', '/tm/parameter/900').length + byPath(calls, 'PUT', '/tm/parameter/901').length).toBe(before + 1);
  }
  {
    const { adapter, calls } = makeAdapter((url) => {
      if (url.endsWith('/tm/parameter/900'))
        return { body: JSON.stringify({ data: { id: 900, name: 'secret', type: 'Global', defaultValue: 'x' } }) };
      return undefined;
    });
    await expect(adapter.updateParameter('900', { defaultValue: 'y' })).rejects.toThrow('Parameter "secret" is Global - Global parameters hold an encrypted shared value');
    expect(byPath(calls, 'PUT', '/tm/parameter/900')).toHaveLength(0);
  }
});

// ---------------------------------------------------------------- backlog writes

test('backlog creates: story defaults + business-key update, epic/feature default field sets and project scope', async () => {
  {
    const { adapter, calls } = makeAdapter((url, init) => {
      if (url.includes('/pm/fields/3')) {
        return { body: JSON.stringify([
            { key: 'state', values: [{ key: 'PROPOSED', value: 'Proposed', isDefault: true, archive: false }] },
            { key: 'priority', values: [{ key: 'MEDIUM', value: 'Medium', isDefault: true, archive: false }] },
          ]) };
      }
      if (url.endsWith('/pm/userstory/search'))
        return { body: JSON.stringify({ data: [{ id: 12, code: 'US-12', name: 'Login' }] }) };
      if (url.endsWith('/pm/userstory') && init.method === 'POST')
        return { body: JSON.stringify({ data: { id: 12, code: 'US-12' } }) };
      if (url.endsWith('/pm/userstory/12') && init.method === 'PUT')
        return { body: JSON.stringify({ data: { id: 12, code: 'US-12' } }) };
      return undefined;
    });
    const created = await adapter.createStory({ name: 'Login story', description: 'As a user' } as any);
    expect(created).toEqual({ id: '12', created: true });
    expect(byPath(calls, 'POST', '/pm/userstory')[0]!.body).toEqual({
      name: 'Login story',
      description: 'As a user',
      projectId: 7,
      state: 'PROPOSED',
      priority: 'MEDIUM',
      customFields: {},
    });
    const updated = await adapter.updateStory('US_12', { name: 'Renamed' } as any);
    expect(updated).toEqual({ id: '12', created: false });
    // The business key was resolved to the numeric id through the search endpoint.
    expect(byPath(calls, 'POST', '/pm/userstory/search')[0]!.body).toEqual({
      searchFields: [
        { column: 'deleted', value: false },
        { column: 'code', value: 'US_12' },
      ],
      startIndex: 0,
      limit: 1,
    });
    expect(byPath(calls, 'PUT', '/pm/userstory/12')[0]!.body).toEqual({ projectId: 7, name: 'Renamed' });
  }
  {
    const { adapter, calls } = makeAdapter((url) => {
      if (url.includes('/pm/fields/1')) {
        return { body: JSON.stringify([{ key: 'state', values: [{ key: 'PROPOSED', value: 'Proposed', isDefault: true }] }]) };
      }
      if (url.includes('/pm/fields/2')) {
        return { body: JSON.stringify([
            { key: 'state', values: [{ key: 'PLANNED', value: 'Planned', isDefault: true }] },
            { key: 'priority', values: [{ key: 'HIGH', value: 'High', isDefault: true }] },
          ]) };
      }
      if (url.endsWith('/pm/epic') && url.match(/\/pm\/epic$/))
        return { body: JSON.stringify({ data: { id: 4, code: 'EP-4' } }) };
      if (url.endsWith('/pm/feature') && url.match(/\/pm\/feature$/))
        return { body: JSON.stringify({ data: { id: 8, code: 'FT-8' } }) };
      return undefined;
    });
    expect(await adapter.createEpic({ name: 'Checkout epic' } as any)).toEqual({ id: '4', created: true });
    expect(byPath(calls, 'POST', '/pm/epic')[0]!.body).toEqual({
      name: 'Checkout epic', projectIds: [7], state: 'PROPOSED', customFields: {},
    });
    expect(await adapter.createFeature({ name: 'Payments', epicId: 4 } as any)).toEqual({ id: '8', created: true });
    expect(byPath(calls, 'POST', '/pm/feature')[0]!.body).toEqual({
      name: 'Payments', epicId: 4, projectIds: [7], state: 'PLANNED', priority: 'HIGH', customFields: {},
    });
  }
});

test('deleteBacklogItem is two-phase: a dry run lists dependencies, confirm deletes; task skips the dry run', async () => {
  let phase: 'deps' | 'clean' = 'deps';
  const { adapter, calls } = makeAdapter((url, init) => {
    if (url.endsWith('/pm/epic') && init.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      // The dep row's `*Arr` values are arrays of referencing ids (the shape the adapter reads).
      if (phase === 'deps')
        return { body: JSON.stringify({ data: [{ id: 5, suiteArr: [12], defectArr: [] }] }) };
      expect(body.isDelete).toBe(true);
      return { body: JSON.stringify({ data: { ok: true } }) };
    }
    if (url.endsWith('/pm/task') && init.method === 'PATCH')
      return { body: JSON.stringify({ data: { ok: true } }) };
    return undefined;
  });
  const preview = await adapter.deleteBacklogItem({ kind: 'epic', id: 'EP_5' });
  expect(preview).toEqual({ dryRun: true, deleted: false, dependencies: [{ id: 5, counts: { suiteArr: [12] } }] });
  expect(byPath(calls, 'PATCH', '/pm/epic')[0]!.body).toEqual({ ids: [5], projectId: 7, isDelete: false });
  phase = 'clean';
  expect(await adapter.deleteBacklogItem({ kind: 'epic', id: '5', confirm: true })).toEqual({
    dryRun: false, deleted: true, dependencies: [],
  });
  expect(byPath(calls, 'PATCH', '/pm/epic')[1]!.body).toEqual({ ids: [5], projectId: 7, isDelete: true });
  // A task has no dry-run endpoint at all — the preview is answered locally, without a write.
  expect(await adapter.deleteBacklogItem({ kind: 'task', id: 'TA_9' })).toEqual({ dryRun: true, deleted: false, dependencies: [] });
  expect(byPath(calls, 'PATCH', '/pm/task')).toHaveLength(0);
  expect(await adapter.deleteBacklogItem({ kind: 'task', id: 'TA_9', confirm: true })).toEqual({ dryRun: false, deleted: true, dependencies: [] });
  expect(byPath(calls, 'PATCH', '/pm/task')[0]!.body).toEqual({ ids: [9], projectId: 7 });
});

test('addWatchListUsers resolves emails/names/ids and preserves the existing watchers', async () => {
  let mailers = { users: [36, 99], nonUsers: [] as number[], groups: [] as number[] };
  const { adapter, calls } = makeAdapter((url, init) => {
    if (url.endsWith('/pm/epic/search'))
      return { body: JSON.stringify({ data: [{ id: 5, code: 'EP-5' }] }) };
    if (url.endsWith('/pm/users/search')) {
      const body = JSON.parse(String(init.body));
      const column = body.searchFields.find((f: any) => f.column === 'email' || f.column === 'name')?.column;
      if (column === 'email')
        return { body: JSON.stringify({ data: [{ id: 36, email: 'qa.user@x.test' }] }) };
      return { body: JSON.stringify({ data: [{ id: 41, name: 'QA User' }] }) };
    }
    if (url.endsWith('/pm/epic/5') && (init.method ?? 'GET') === 'GET') {
      return { body: JSON.stringify({ data: { id: 5, code: 'EP-5', updateVersion: 2, mailersList: mailers } }) };
    }
    if (url.endsWith('/pm/epic/5') && init.method === 'PUT') {
      mailers = JSON.parse(String(init.body)).mailersList;
      return { body: JSON.stringify({ data: { id: 5 } }) };
    }
    return undefined;
  });
  const out = await adapter.addWatchListUsers({
    entityType: 'epic', itemId: 'EP_5', users: ['qa.user@x.test', 36, 'QA User'],
  });
  expect(out.users).toEqual([36, 99, 41]);
  expect(byPath(calls, 'PUT', '/pm/epic/5')[0]!.body).toEqual({
    mailersList: { users: [36, 99, 41], nonUsers: [], groups: [] },
    updateVersion: 2,
  });
});

test('linkBacklogItem resolves both sides, validates the link type and merges into linkedIssues', async () => {
  const { adapter, calls } = makeAdapter((url, init) => {
    if (url.endsWith('/pm/userstory/7') && (init.method ?? 'GET') === 'GET') {
      return { body: JSON.stringify({ data: {
            id: 7, code: 'US-7', name: 'Login', updateVersion: 4,
            linkedIssues: [{ destinationId: 99, linkTypeKey: 'blocks' }],
          } }) };
    }
    if (url.endsWith('/pm/defect/9'))
      return { body: JSON.stringify({ data: { id: 9, code: 'DE-9', name: 'Broken login' } }) };
    if (url.includes('/pm/fields/10')) {
      return { body: JSON.stringify([{ id: 70, inwardType: { key: 'clones', value: 'Clones' }, outwardType: { key: 'is cloned by', value: 'Is Cloned By' } }]) };
    }
    if (url.endsWith('/pm/userstory/7') && init.method === 'PUT')
      return { body: JSON.stringify({ data: { id: 7 } }) };
    if (url.includes('/pm/linkages/7/US')) {
      return { body: JSON.stringify([{ destinationId: 9, destinationCode: 'DE-9', linkTypeKey: 'clones' }]) };
    }
    return undefined;
  });
  const out = await adapter.linkBacklogItem({
    sourceType: 'userstory', sourceId: 'US_7', destType: 'defect', destId: 'DE_9', linkType: 'Clones',
  });
  expect(out).toEqual({
    linkTypeKey: 'clones',
    destinationCode: 'DE-9',
    linkedIssues: [{ destinationId: 9, destinationCode: 'DE-9', linkTypeKey: 'clones' }],
  });
  expect(byPath(calls, 'PUT', '/pm/userstory/7')[0]!.body).toEqual({
    projectId: 7,
    linkedIssues: [
      { destinationId: 99, linkTypeKey: 'blocks' },
      {
        projectId: 7, deleted: false, parentName: 'Broken login', destinationId: 9, destinationCode: 'DE-9',
        destinationType: 'DE', linkId: 70, linkTypeKey: 'clones', linkType: 'inwardType',
        jiraIssueId: '', jiraIssueKey: '', jiraLinkId: '',
      },
    ],
  });
});
