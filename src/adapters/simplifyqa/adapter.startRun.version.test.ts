import { SimplifyQaAdapter } from './adapter.js';

/** startRun version-resolution regressions. The old block silently forwarded opts.versionId
 *  even when it matched no version on the TC, and its versionName fallback picked from the
 *  TC's default. Result: user says "v2" and the backend either 500s (no versions[]) or
 *  silently runs v1 (name-vs-id mismatch, {versionId:'v2', versionName:'v1.0'}). Pin the
 *  three shapes: name resolves to id, unknown override throws with a listing, and no-override
 *  still falls back to the TC's current version. */

type Handler = (url: string, init: RequestInit) => { status?: number; body: string };

function makeAdapter(handler: Handler) {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const { status = 200, body } = handler(url, init);
    return { ok: status < 300, status, text: async () => body };
  }) as unknown as typeof fetch;
  return new SimplifyQaAdapter(
    { baseUrl: 'https://x.test', token: 't', projectId: 7 } as any,
    { fetchImpl, FormDataImpl: FormData },
  );
}

const RAW_TC_MULTI = {
  id: 42,
  name: 'Checkout flow',
  code: 'TC_42',
  projectId: 7,
  moduleId: 0,
  tcType: 'WEB',
  executionType: 'AUTOMATION',
  versionId: 'ver-1',
  versionsDetails: { id: 'ver-1', name: 'v1.0' },
  versions: [
    { id: 'ver-1', name: 'v1.0' },
    { id: 'ver-2', name: 'v2.0' },
  ],
};

/** Full-pipeline handler: version-resolution success needs every downstream stub to succeed. */
function fullPipeline(rawTc: any, captureExec: (body: any) => void): Handler {
  return (url, init) => {
    // Project-access gate: GET /pm/auth/me → GET /pm/projectuserrole runs before any project-scoped call.
    if (url.includes('/pm/auth/me')) return { body: JSON.stringify({ userDetails: { id: 31, username: 'qa' } }) };
    if (url.includes('/pm/projectuserrole')) {
      return { body: JSON.stringify({ data: [{ projectId: 7, roleId: 2 }] }) };
    }
    if (url.includes('/tm/testcase/getById/42')) return { body: JSON.stringify({ data: rawTc }) };
    if (url.includes('/pm/project/search')) return { body: JSON.stringify({ data: [{ id: 7, name: 'Proj Seven' }] }) };
    if (url.includes('/pm/fields/8')) return { body: JSON.stringify([{ key: 'general' }]) };
    if (url.includes('/pm/module/search')) return { body: JSON.stringify({ data: [] }) };
    if (init.method === 'POST' && url.endsWith('/exec/execution')) {
      captureExec(JSON.parse(String(init.body)));
      return { body: JSON.stringify({ data: { id: 'run-99' } }) };
    }
    throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
  };
}

test('startRun resolves a version NAME to its id (kills the silent v1 fallback)', async () => {
  let capturedExec: any = null;
  const adapter = makeAdapter(fullPipeline(RAW_TC_MULTI, (b) => { capturedExec = b; }));

  const ref = await adapter.startRun(
    { tcId: 'TC_42' },
    { mode: 'cloud', environment: 'general', browser: 'chromium', versionId: 'v2.0' },
  );

  expect(ref.runId).toBe('run-99');
  expect(capturedExec.executionItems[0].versionId).toBe('ver-2');
  expect(capturedExec.executionItems[0].versionName).toBe('v2.0');
});

test('startRun accepts a version id directly (unchanged happy path)', async () => {
  let capturedExec: any = null;
  const adapter = makeAdapter(fullPipeline(RAW_TC_MULTI, (b) => { capturedExec = b; }));

  await adapter.startRun(
    { tcId: 'TC_42' },
    { mode: 'cloud', environment: 'general', browser: 'chromium', versionId: 'ver-2' },
  );

  expect(capturedExec.executionItems[0].versionId).toBe('ver-2');
  expect(capturedExec.executionItems[0].versionName).toBe('v2.0');
});

test('startRun throws with a listing when the override matches no version', async () => {
  const adapter = makeAdapter((url) => {
    // Project-access gate: GET /pm/auth/me → GET /pm/projectuserrole runs before any project-scoped call.
    if (url.includes('/pm/auth/me')) return { body: JSON.stringify({ userDetails: { id: 31, username: 'qa' } }) };
    if (url.includes('/pm/projectuserrole')) {
      return { body: JSON.stringify({ data: [{ projectId: 7, roleId: 2 }] }) };
    }
    if (url.includes('/tm/testcase/getById/42')) return { body: JSON.stringify({ data: RAW_TC_MULTI }) };
    throw new Error(`should not reach ${url}`);
  });

  await expect(
    adapter.startRun(
      { tcId: 'TC_42' },
      { mode: 'cloud', environment: 'general', browser: 'chromium', versionId: 'bogus' },
    ),
  ).rejects.toThrow(/version "bogus" not found on TC_42[\s\S]*ver-1[\s\S]*v1\.0[\s\S]*ver-2[\s\S]*v2\.0/);
});

test('startRun with an override on a TC that has no versions[] throws — no 500 downstream', async () => {
  const rawTcNoVersions = { ...RAW_TC_MULTI, versions: undefined, versionsDetails: undefined, versionId: undefined };
  const adapter = makeAdapter((url) => {
    // Project-access gate: GET /pm/auth/me → GET /pm/projectuserrole runs before any project-scoped call.
    if (url.includes('/pm/auth/me')) return { body: JSON.stringify({ userDetails: { id: 31, username: 'qa' } }) };
    if (url.includes('/pm/projectuserrole')) {
      return { body: JSON.stringify({ data: [{ projectId: 7, roleId: 2 }] }) };
    }
    if (url.includes('/tm/testcase/getById/42')) return { body: JSON.stringify({ data: rawTcNoVersions }) };
    throw new Error(`should not reach ${url}`);
  });

  await expect(
    adapter.startRun(
      { tcId: 'TC_42' },
      { mode: 'cloud', environment: 'general', browser: 'chromium', versionId: 'v2' },
    ),
  ).rejects.toThrow(/has no versions available/);
});

test('startRun without an override still uses the TC current version (regression guard)', async () => {
  let capturedExec: any = null;
  const adapter = makeAdapter(fullPipeline(RAW_TC_MULTI, (b) => { capturedExec = b; }));

  await adapter.startRun(
    { tcId: 'TC_42' },
    { mode: 'cloud', environment: 'general', browser: 'chromium' },
  );

  expect(capturedExec.executionItems[0].versionId).toBe('ver-1');
  expect(capturedExec.executionItems[0].versionName).toBe('v1.0');
});
