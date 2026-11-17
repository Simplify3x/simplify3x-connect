import { SimplifyQaAdapter } from './adapter.js';
/** `readJournal` / `editJournal` — the AGENT-FREE step editor.
 *
 *  When the desktop agent is unreachable (no `cfg.url`, as here) every step edit is applied straight
 *  to the saved test case and renumbered after EACH op, then saved through `updateTestCase`. The two
 *  full-REST tests below run the whole chain (getById → steps → PUT testcaseObj → re-read); the rest
 *  pin each op's exact effect on the neutral step list handed to the save.
 *
 *  The stub seam used by the focused op tests is `updateTestCase` — the list it receives IS the edit
 *  result (nothing is serialised in between), so the assertions are on the real product contract. */

type Reply = {
  status?: number;
  body: string;
};

type Handler = (url: string, init: RequestInit) => Reply | undefined;

const ME = { userDetails: { id: 36, username: 'qa.user', email: 'qa.user@x.test', userType: 'user' } };

const ROLES = { data: [{ userId: 36, projectId: 7, roleId: 2, deleted: false }] };

function response({ status = 200, body }: Reply) {
  return { ok: status < 300, status, text: async () => body };
}

function makeAdapter(handler: Handler = () => undefined) {
  const calls: Array<{
    method: string;
    url: string;
    body: any;
    raw: any;
  }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    let body: any;
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
    if (url.endsWith('/tm/parameter/search'))
      return response({ body: JSON.stringify({ data: [] }) });
    return response({ status: 404, body: JSON.stringify({ message: `unexpected ${method} ${url}` }) });
  }) as unknown as typeof fetch;
  const adapter = new SimplifyQaAdapter({ baseUrl: 'https://x.test', token: 't', projectId: 7 } as any, { fetchImpl, FormDataImpl: FormData });
  return { adapter, calls };
}

function part(call: {
  raw: any;
}, partName: string): any {
  const raw = (call.raw as FormData).get(partName);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
/** Steps the caller would have read from the backend (`getTestCase` output). */

const STEP_FIXTURES = (): any[] => [
  { n: 1, description: 'Go to URL', actionType: 'Go to URL', stepType: 'web', sourceId: 's1' },
  { n: 2, description: 'Type user', actionType: 'Type Text', stepType: 'web', sourceId: 's2', flags: { screenshot: true } },
  { n: 3, description: 'Type pass', actionType: 'Type Text', stepType: 'web', sourceId: 's3' },
  { n: 4, description: 'Click login', actionType: 'Click', stepType: 'web', sourceId: 's4' },
];
/** Focused-op harness: the real adapter, with the two IO boundaries (read TC, write TC) replaced by
 *  in-memory state so a test can assert the exact step list a save receives and the view it returns. */

function stubAdapter(steps: any[], tc: Record<string, unknown> = {}) {
  const fetchImpl = (async () => ({ ok: true, status: 200, text: async () => '{}' })) as unknown as typeof fetch;
  const adapter: any = new SimplifyQaAdapter({ baseUrl: 'https://x.test', token: 't', projectId: 7 } as any, { fetchImpl, FormDataImpl: FormData } as any);
  let saved = steps.map((s) => ({ ...s }));
  let base = { id: '42', title: 'Journal TC', category: 'automated', folderOrModule: '3', ...tc };
  let lastTc: any = null;
  adapter.getTestCase = async () => ({ ...base, steps: saved.map((s) => ({ ...s })) });
  adapter.updateTestCase = async (_id: string, next: any) => {
    lastTc = next;
    saved = next.steps.map((s: any) => ({ ...s }));
    return { id: '42' };
  };
  adapter.stepsView = async () => ({ tcId: '42', source: 'steps', steps: saved.map((s) => ({ ...s })) });
  adapter.getFunction = async (id: string) => ({
    id: String(id), code: 'FN-12', name: 'Login fn', versions: [{ id: 'fnv-1', name: 'v1.0' }],
  });
  return { adapter, saved: () => saved, lastTc: () => lastTc, setBase: (b: any) => { base = { ...base, ...b }; } };
}

const numbered = (rows: any[]) => rows.map((s) => `${s.n}:${s.description}`);

// ---------------------------------------------------------------- read

test('readJournal with no agent configured reads the saved steps (source:"steps")', async () => {
  const { adapter, calls } = makeAdapter((url) => {
    if (url.includes('/tm/testcase/getById/42')) {
      return { body: JSON.stringify({ data: { id: 42, name: 'Checkout', projectId: 7, moduleId: 3, executionType: 'MANUAL', versionId: 'v1' } }) };
    }
    if (url.includes('/tm/testcase/steps')) {
      return { body: JSON.stringify({ data: [
            { id: 's1', seq: 1, description: 'Open page', executionType: 'MANUAL' },
            { id: 's2', seq: 2, description: 'Click pay', executionType: 'MANUAL' },
          ] }) };
    }
    return undefined;
  });
  const view = await adapter.readJournal('TC_42');
  expect(view).toEqual({
    tcId: 'TC_42',
    source: 'steps',
    steps: [
      expect.objectContaining({ n: 1, description: 'Open page', stepType: 'manual', sourceId: 's1' }),
      expect.objectContaining({ n: 2, description: 'Click pay', stepType: 'manual', sourceId: 's2' }),
    ],
  });
  // No agent hop: the read went straight to the backend, in the documented order.
  const paths = calls.map((c) => `${c.method} ${c.url.replace('https://x.test', '').split('?')[0]}`);
  expect(paths.slice(0, 2)).toEqual(['GET /pm/auth/me', 'GET /pm/projectuserrole']);
  expect(paths.slice(2)).toEqual(['GET /tm/testcase/getById/42', 'GET /tm/testcase/steps']);
});

// ---------------------------------------------------------------- full REST edit

test('editJournal applies update/add/remove on a saved MANUAL test case and PUTs the renumbered steps', async () => {
  const rawTc = {
    id: 42, name: 'Checkout', projectId: 7, moduleId: 3, executionType: 'MANUAL',
    versionId: 'v1', versions: [{ id: 'v1', name: 'v1.0' }], versionsDetails: { id: 'v1', name: 'v1.0' },
  };
  let rows: any[] = [
    { id: 's1', seq: 1, description: 'Open page', executionType: 'MANUAL', versionId: 'v1' },
    { id: 's2', seq: 2, description: 'Enter user', executionType: 'MANUAL', versionId: 'v1' },
    { id: 's3', seq: 3, description: 'Close modal', executionType: 'MANUAL', versionId: 'v1' },
  ];
  let newId = 0;
  const { adapter, calls } = makeAdapter((url, init) => {
    if (url.includes('/tm/testcase/getById/42'))
      return { body: JSON.stringify({ data: rawTc }) };
    if (url.includes('/tm/testcase/steps'))
      return { body: JSON.stringify({ data: rows }) };
    if (url.endsWith('/tm/testcase') && init.method === 'PUT') {
      const payload = part({ raw: init.body }, 'testcaseObj');
      rows = payload.steps.manualSteps
        .filter((s: any) => s.deleted !== true)
        .map((s: any, i: number) => ({
        id: s.id ?? `new${++newId}`, seq: i + 1, description: s.description, executionType: 'MANUAL', versionId: 'v1',
      }));
      return { body: JSON.stringify({ data: { id: 42 } }) };
    }
    return undefined;
  });
  const view = await adapter.editJournal('TC_42', [
    { op: 'update_step', n: 1, patch: { description: 'Open home' } },
    { op: 'add_step', at: 2, step: { stepType: 'manual', actionType: 'manual', description: 'Wait 5 seconds' } },
    { op: 'remove_step', n: 4 },
  ]);
  const save = calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/tm/testcase'))[0]!;
  const payload = part(save, 'testcaseObj');
  // The edited draft, renumbered 1..N, each kept row still carrying its backend id.
  expect(payload.steps.manualSteps.map((s: any) => [s.seq, s.description, s.id, s.deleted])).toEqual([
    [1, 'Open home', 's1', false],
    [2, 'Wait 5 seconds', undefined, false],
    [3, 'Enter user', 's2', false],
    [3, 'Close modal', 's3', true],
  ]);
  expect(payload.steps.manualSteps[0]).toMatchObject({ deleted: false, parentId: 42, versionId: 'v1' });
  // The dropped row is resent explicitly as deleted:true (with the seq it still has in the backend).
  expect(payload.steps.manualSteps[3]).toMatchObject({
    id: 's3', seq: 3, description: 'Close modal', executionType: 'MANUAL', deleted: true, parentId: 42,
  });
  expect(payload.steps.automationSteps).toEqual([]);
  expect(payload.tcfnObj).toMatchObject({ id: 42, name: 'Checkout', deleted: false, moduleId: 3 });
  // The returned view is the re-read test case, so the caller sees exactly what was saved.
  expect(numbered(view.steps)).toEqual(['1:Open home', '2:Wait 5 seconds', '3:Enter user']);
  expect(view.steps.map((s) => s.sourceId)).toEqual(['s1', `new${newId}`, 's2']);
});

test('editJournal set_meta updates metadata only and never sends `steps` from the patch', async () => {
  const { adapter, calls } = makeAdapter((url, init) => {
    if (url.includes('/tm/testcase/getById/42')) {
      return { body: JSON.stringify({ data: { id: 42, name: 'Checkout', projectId: 7, moduleId: 3, executionType: 'MANUAL', versionId: 'v1' } }) };
    }
    if (url.includes('/tm/testcase/steps')) {
      return { body: JSON.stringify({ data: [{ id: 's1', seq: 1, description: 'Open page', executionType: 'MANUAL' }] }) };
    }
    if (url.endsWith('/tm/testcase') && init.method === 'PUT') {
      return { body: JSON.stringify({ data: { id: 42 } }) };
    }
    return undefined;
  });
  const view = await adapter.editJournal('42', [{
      op: 'set_meta',
      patch: { title: 'Renamed', description: 'new summary', steps: [{ n: 1, description: 'hijack' }] } as any,
    }]);
  const payload = part(calls.filter((c) => c.method === 'PUT')[0]!, 'testcaseObj');
  expect(payload.tcfnObj).toMatchObject({ id: 42, name: 'Renamed' });
  // The step list came from the test case, not from the patch.
  expect(payload.steps.manualSteps).toHaveLength(1);
  expect(payload.steps.manualSteps[0]).toMatchObject({ id: 's1', description: 'Open page', seq: 1 });
  expect(numbered(view.steps)).toEqual(['1:Open page']);
});

// ---------------------------------------------------------------- op semantics

test('move_step and duplicate_step renumber the whole list', async () => {
  const { adapter, saved } = stubAdapter(STEP_FIXTURES());
  const view = await adapter.editJournal('42', [
    { op: 'move_step', n: 1, to: 4 },
    { op: 'duplicate_step', n: 2 },
  ]);
  expect(numbered(saved())).toEqual([
    '1:Type user', '2:Type pass', '3:Click login', '4:Go to URL', '5:Type pass',
  ]);
  expect(numbered(view.steps)).toEqual(numbered(saved()));
});

test('update_steps patches every match, merges flags, and drops a stale action pin on an action change', async () => {
  const steps = STEP_FIXTURES();
  steps[1] = { ...steps[1]!, actionUniqueId: 'web-7', objectRef: { id: '500', name: 'User field' } };
  steps[2] = { ...steps[2]!, objectRef: { id: '501', name: 'Pass field' } };
  const { adapter, saved, lastTc } = stubAdapter(steps);
  await adapter.editJournal('42', [
    { op: 'update_steps', where: { actionType: 'Type Text' }, patch: { flags: { skip: true }, description: 'Retry' } },
    { op: 'update_step', n: 1, patch: { actionType: 'Launch Application' } },
    { op: 'update_step', n: 3, patch: { objectRef: { name: 'Password' } } },
  ]);
  const rows = saved();
  // Both Type Text steps: description replaced, flags MERGED (step 2 had screenshot on).
  expect(rows[1]).toMatchObject({ description: 'Retry', flags: { screenshot: true, skip: true } });
  expect(rows[2]).toMatchObject({ description: 'Retry', flags: { skip: true } });
  // A changed action drops the recorded plugin uniqueId pin, or the new action would be ignored.
  expect(rows[0]!.actionUniqueId).toBeUndefined();
  expect(rows[0]!.actionType).toBe('Launch Application');
  // "Use object X" by NAME with no id replaces the binding instead of merging the old id back in.
  expect(rows[2]!.objectRef).toEqual({ name: 'Password' });
  expect(rows[1]!.objectRef).toEqual({ id: '500', name: 'User field' });
  expect(lastTc().steps).toHaveLength(4);
  // The bulk matcher refuses an empty where and a where that matches nothing.
  await expect(adapter.editJournal('42', [{ op: 'update_steps', where: {}, patch: { description: 'x' } }]))
    .rejects.toThrow('update_steps: "where" is empty');
  await expect(adapter.editJournal('42', [{ op: 'update_steps', where: { stepType: 'api' }, patch: { description: 'x' } }]))
    .rejects.toThrow('update_steps: no step matches that "where"');
});

test('add_assertions appends to an API step and refuses any other step type', async () => {
  const steps = STEP_FIXTURES();
  steps[1] = { ...steps[1]!, stepType: 'api', actionType: 'executeRestAPI', api: { requestStyle: 'REST', assertions: [{ path: 'statusCode', condition: 'EQUALS', expectedValue: '200' }] } };
  const { adapter, saved } = stubAdapter(steps);
  await adapter.editJournal('42', [{
      op: 'add_assertions', n: 2,
      assertions: [{ path: 'responseTime', condition: 'LESSER_THAN', expectedValue: '3000' }],
    }]);
  expect(saved()[1]!.api).toEqual({
    requestStyle: 'REST',
    assertions: [
      { path: 'statusCode', condition: 'EQUALS', expectedValue: '200' },
      { path: 'responseTime', condition: 'LESSER_THAN', expectedValue: '3000' },
    ],
  });
  // Everything else on the step is untouched.
  expect(saved()[1]).toMatchObject({ n: 2, stepType: 'api', actionType: 'executeRestAPI', sourceId: 's2' });
  await expect(adapter.editJournal('42', [{ op: 'add_assertions', n: 1, assertions: [] }])).rejects.toThrow('add_assertions: step 1 on 42 is a web step, not an API step');
});

test('insert_nested appends a pinned FUNCTION + FUNCTION_END pair and refuses a manual TC or an unversioned function', async () => {
  {
    const { adapter, saved } = stubAdapter(STEP_FIXTURES());
    await adapter.editJournal('42', [{ op: 'insert_nested', at: 3, tcId: 'FN-12', name: 'Login helper' }]);
    expect(saved().map((s) => s.stepType)).toEqual(['web', 'web', 'function', 'function_end', 'web', 'web']);
    expect(saved()[2]).toEqual({
      n: 3,
      stepType: 'function',
      actionType: 'function',
      description: 'Login helper',
      functionCall: { testCaseId: '12', versionId: 'fnv-1' },
    });
    expect(saved()[3]).toEqual({ n: 4, stepType: 'function_end', actionType: 'function_end', description: '' });
    expect(numbered(saved())).toEqual(['1:Go to URL', '2:Type user', '3:Login helper', '4:', '5:Type pass', '6:Click login']);
  }
  {
    const manual = stubAdapter(STEP_FIXTURES(), { category: 'manual' });
    await expect(manual.adapter.editJournal('42', [{ op: 'insert_nested', tcId: 'FN-12' }])).rejects.toThrow('insert_nested: 42 is a manual test case — nested function calls can only be added to automated test cases.');
    expect(manual.lastTc()).toBeNull();
    const noVersion = stubAdapter(STEP_FIXTURES());
    noVersion.adapter.getFunction = async (id: string) => ({ id: String(id), name: 'x', versions: [] });
    await expect(noVersion.adapter.editJournal('42', [{ op: 'insert_nested', tcId: 'FN-12' }])).rejects.toThrow('insert_nested: function FN-12 has no version to pin.');
  }
});

test('add_step / duplicate_step refuse to insert inside a function-call block', async () => {
  const steps = [
    { n: 1, description: 'Open', actionType: 'Go to URL', stepType: 'web' },
    { n: 2, description: 'Call login', actionType: 'function', stepType: 'function', functionCall: { testCaseId: '12' } },
    { n: 3, description: '', actionType: 'function_end', stepType: 'function_end' },
    { n: 4, description: 'Close', actionType: 'Close Browser', stepType: 'web' },
  ];
  const { adapter, lastTc } = stubAdapter(steps);
  await expect(adapter.editJournal('42', [{ op: 'add_step', at: 3, step: { stepType: 'web', actionType: 'Wait', description: 'w' } }]))
    .rejects.toThrow('add_step: position 3 is inside the function call at step 2.');
  await expect(adapter.editJournal('42', [{ op: 'duplicate_step', n: 4, at: 3 }]))
    .rejects.toThrow('duplicate_step: position 3 is inside the function call at step 2.');
  await expect(adapter.editJournal('42', [{ op: 'add_step', at: 1, step: { stepType: 'web', description: 'no action' } } as any]))
    .rejects.toThrow('add_step: step.actionType is required (e.g. "Minimum Wait").');
  expect(lastTc()).toBeNull();
});

test('step ops refuse an unknown step number, and an agent-only op says which ops work without it', async () => {
  {
    const { adapter } = stubAdapter(STEP_FIXTURES());
    await expect(adapter.editJournal('42', [{ op: 'remove_step', n: 9 }])).rejects.toThrow('remove_step: no step 9 on 42 (it has 4).');
    await expect(adapter.editJournal('42', [{ op: 'remove_steps', numbers: [1, 9] }])).rejects.toThrow('remove_steps: no step 9 on 42 (it has 4).');
    await expect(adapter.editJournal('42', [{ op: 'move_step', n: 9, to: 1 }])).rejects.toThrow('move_step: no step 9 on 42 (it has 4).');
    await expect(adapter.editJournal('42', [{ op: 'update_step', n: 9, patch: { description: 'x' } }])).rejects.toThrow('update_step: no step 9 on 42 (it has 4).');
    await expect(adapter.editJournal('42', [{ op: 'duplicate_step', n: 9 }])).rejects.toThrow('duplicate_step: no step numbered 9 (the test case has 4 step(s)).');
  }
  {
    const { adapter, lastTc } = stubAdapter(STEP_FIXTURES());
    await expect(adapter.editJournal('42', [{ op: 'wrap_in_if', from: 1, to: 2 }])).rejects.toThrow(/The SimplifyQA desktop agent is not reachable, and 'wrap_in_if' needs it\./);
    expect(lastTc()).toBeNull();
  }
});
