import { SimplifyQaAdapter } from './adapter.js';

/** createEpic/createFeature/createStory must (a) fill state/priority from the project fields config
 *  when the caller omits them, and (b) always send `customFields: {}` when the caller omits customFields.
 *  Only the FIRST successful call is asserted; the second call in each test verifies that the fields
 *  fetch is cached per parentId (no repeat GET on /pm/fields). */

type Handler = (url: string, init: RequestInit) => { status?: number; body: string };

const ACCESS = {
  me: { ok: true, status: 200, text: async () => JSON.stringify({ userDetails: { id: 41, username: 'qa' } }) },
  roles: { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ projectId: 7, roleId: 2 }] }) },
};

function makeAdapter(handler: Handler) {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    // Project-access gate: GET /pm/auth/me → GET /pm/projectuserrole runs before any project-scoped call.
    // These two are NOT recorded into the test's `calls` list — the tests assert on create/fields calls only.
    if (url.includes('/pm/auth/me')) return ACCESS.me;
    if (url.includes('/pm/projectuserrole')) return ACCESS.roles;
    const { status = 200, body } = handler(url, init);
    return { ok: status < 300, status, text: async () => body };
  }) as unknown as typeof fetch;
  return new SimplifyQaAdapter(
    { baseUrl: 'https://x.test', token: 't', projectId: 7 } as any,
    { fetchImpl, FormDataImpl: FormData },
  );
}

// Simulated fields payload from /pm/fields/:parentId — matches the seed shape in project-management/src/fields/*.json.
const FIELDS = [
  { key: 'name', values: [] },
  {
    key: 'state',
    values: [
      { key: 'NEEDS_DEFINITION', value: 'Needs Definition', isDefault: false, archive: false },
      { key: 'DEFINED', value: 'Defined', isDefault: true, archive: false },
      { key: 'ACCEPTED', value: 'Accepted', isDefault: false, archive: false },
    ],
  },
  {
    key: 'priority',
    values: [
      { key: 'HIGH', value: 'High', isDefault: false, archive: false },
      { key: 'MEDIUM', value: 'Medium', isDefault: true, archive: false },
    ],
  },
];

test('createStory injects default state, priority, and customFields:{}', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const adapter = makeAdapter((url, init) => {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });
    if (url.includes('/pm/fields/3')) return { body: JSON.stringify(FIELDS) };
    if (url.includes('/pm/userstory')) return { body: JSON.stringify({ id: 100 }) };
    throw new Error(`unexpected ${url}`);
  });
  await adapter.createStory({ name: 'Login flow', estimatedEffort: 4 } as any);
  const createCall = calls.find((c) => c.url.includes('/pm/userstory'))!;
  // Backend stores the value's `.key` (uppercase enum), not the display `.value`. UI form binds
  // state with `keyname="key" type="KEY"` — see epic-form.component.html.
  expect(createCall.body.state).toBe('DEFINED');
  expect(createCall.body.priority).toBe('MEDIUM');
  expect(createCall.body.customFields).toEqual({});
  expect(createCall.body.projectId).toBe(7);
});

test('createEpic injects default state and customFields:{}, caller override wins', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const adapter = makeAdapter((url, init) => {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });
    if (url.includes('/pm/fields/1')) return { body: JSON.stringify(FIELDS) };
    if (url.includes('/pm/epic')) return { body: JSON.stringify({ id: 200 }) };
    throw new Error(`unexpected ${url}`);
  });
  // No state → fills from fields config.
  await adapter.createEpic({
    name: 'Auth epic', estimatedEffort: 40, plannedStartDate: '2026-01-01', plannedEndDate: '2026-03-01',
  } as any);
  // Explicit state → passes through untouched.
  await adapter.createEpic({
    name: 'Second epic', state: 'Accepted', estimatedEffort: 40,
    plannedStartDate: '2026-01-01', plannedEndDate: '2026-03-01',
    customFields: { region: 'EMEA' },
  } as any);
  const epicCreates = calls.filter((c) => c.url.endsWith('/pm/epic'));
  expect(epicCreates[0]!.body.state).toBe('DEFINED');
  expect(epicCreates[0]!.body.customFields).toEqual({});
  expect(epicCreates[1]!.body.state).toBe('Accepted'); // caller override passes through as-is
  expect(epicCreates[1]!.body.customFields).toEqual({ region: 'EMEA' });
  // fields fetch cached — only one GET /pm/fields/1 despite two creates.
  const fieldFetches = calls.filter((c) => c.url.includes('/pm/fields/1'));
  expect(fieldFetches.length).toBe(1);
});

test('createFeature falls back to an existing entity when fields-fetch fails', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const adapter = makeAdapter((url, init) => {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });
    if (url.includes('/pm/fields/2')) return { status: 500, body: 'boom' };
    if (url.includes('/pm/feature/search')) {
      // The fallback should read state/priority off an existing feature row in the project.
      return { body: JSON.stringify({ data: [{ id: 1, state: 'In Progress', priority: 'High' }] }) };
    }
    if (url.endsWith('/pm/feature')) return { body: JSON.stringify({ id: 300 }) };
    throw new Error(`unexpected ${url}`);
  });
  await adapter.createFeature({
    name: 'Payment', estimatedEffort: 8, plannedStartDate: '2026-01-01', plannedEndDate: '2026-02-01',
  } as any);
  const createCall = calls.find((c) => c.url.endsWith('/pm/feature'))!;
  expect(createCall.body.state).toBe('In Progress');
  expect(createCall.body.priority).toBe('High');
  expect(createCall.body.customFields).toEqual({});
});

test('createEpic falls back to an existing entity when fields config is empty', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const adapter = makeAdapter((url, init) => {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });
    if (url.includes('/pm/fields/1')) return { body: JSON.stringify([]) };
    if (url.includes('/pm/epic/search')) {
      return { body: JSON.stringify({ data: [{ id: 5, state: 'In Progress' }] }) };
    }
    if (url.endsWith('/pm/epic')) return { body: JSON.stringify({ id: 400 }) };
    throw new Error(`unexpected ${url}`);
  });
  await adapter.createEpic({
    name: 'New epic', estimatedEffort: 40, plannedStartDate: '2026-01-01', plannedEndDate: '2026-03-01',
  } as any);
  const createCall = calls.find((c) => c.url.endsWith('/pm/epic'))!;
  expect(createCall.body.state).toBe('In Progress');
  expect(createCall.body.customFields).toEqual({});
});
