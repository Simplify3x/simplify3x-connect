import { SimplifyQaAdapter } from './adapter.js';

/** getProjectPrivileges — the recording preflight. It must mirror the backend's
 *  checkPrivilegesForApi resolution exactly: /pm/auth/me → userId, /pm/projectuserrole → roleId,
 *  /pm/roles/search → privileges[]. Answers, never crashes: a dead token and "no role in this
 *  project" are both RESULTS, because the caller reports them instead of failing mid-recording. */

type Handler = (url: string, init: RequestInit) => { status?: number; body: string };

function makeAdapter(handler: Handler, overrides: Record<string, unknown> = {}) {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const { status = 200, body } = handler(url, init);
    return { ok: status < 300, status, text: async () => body };
  }) as unknown as typeof fetch;
  return new SimplifyQaAdapter(
    { baseUrl: 'https://x.test', token: 't', projectId: 1, ...overrides } as any,
    { fetchImpl, FormDataImpl: FormData },
  );
}

const FULL = ['add_testcase', 'add_parameter', 'add_object', 'view_testcase'];

function handler(opts: {
  me?: { status?: number; body: string } | null;
  roles?: Array<{ projectId: number; roleId: number }>;
  privilegeRows?: Record<number, { id: number; name: string; privileges: string[] }>;
  seen?: string[];
}): Handler {
  return (url, init) => {
    opts.seen?.push(url);
    if (url.includes('/pm/auth/me')) {
      if (opts.me === null) return { status: 404, body: '{}' };
      if (opts.me) return opts.me;
      return { body: JSON.stringify({ userDetails: { id: 36, username: 'Vignesh.V' } }) };
    }
    if (url.includes('/pm/projectuserrole')) {
      return { body: JSON.stringify({ data: opts.roles ?? [{ projectId: 1, roleId: 1 }] }) };
    }
    if (url.endsWith('/pm/roles/search')) {
      let body: any = {};
      try { body = JSON.parse(String((init as any).body ?? '{}')); } catch { /* ignore */ }
      const id = (body.searchFields ?? []).find((f: any) => f.column === 'id')?.value?.[0];
      const row = (opts.privilegeRows ?? { 1: { id: 1, name: 'QA', privileges: FULL } })[id];
      return { body: JSON.stringify({ data: row ? [row] : [] }) };
    }
    return { status: 404, body: JSON.stringify({ message: `unexpected ${url}` }) };
  };
}

test('resolves role name + privileges for the selected project', async () => {
  const seen: string[] = [];
  const adapter = makeAdapter(handler({ seen }));

  const p = await adapter.getProjectPrivileges();

  expect(p).toMatchObject({ projectId: '1', userId: '36', roleId: 1, roleName: 'QA', hasRole: true, tokenValid: true });
  expect(p.privileges).toEqual(FULL);
  expect(seen.some((u) => u.includes('/pm/projectuserrole?userId=36'))).toBe(true);
  expect(seen.some((u) => u.endsWith('/pm/roles/search'))).toBe(true);
});

test('asks for the requested project, not the selected one', async () => {
  const adapter = makeAdapter(handler({
    roles: [{ projectId: 1, roleId: 1 }, { projectId: 2, roleId: 5 }],
    privilegeRows: {
      1: { id: 1, name: 'QA', privileges: FULL },
      5: { id: 5, name: 'Developer', privileges: ['view_testcase'] },
    },
  }));

  const p = await adapter.getProjectPrivileges('2');

  expect(p.projectId).toBe('2');
  expect(p.roleId).toBe(5);
  expect(p.roleName).toBe('Developer');
  expect(p.privileges).toEqual(['view_testcase']);
});

test('no role in the project → hasRole:false with a live token', async () => {
  const adapter = makeAdapter(handler({ roles: [{ projectId: 1, roleId: 1 }] }));

  const p = await adapter.getProjectPrivileges('3');

  expect(p).toMatchObject({ projectId: '3', hasRole: false, tokenValid: true, privileges: [] });
});

test('a 401 from /me is reported as an invalid token, not thrown', async () => {
  const adapter = makeAdapter(handler({
    me: { status: 401, body: JSON.stringify({ message: 'Invalid token' }) },
  }));

  const p = await adapter.getProjectPrivileges();

  expect(p).toMatchObject({ hasRole: false, tokenValid: false, privileges: [] });
});

test('caches per project+user so a repeated preflight is one round trip', async () => {
  const seen: string[] = [];
  const adapter = makeAdapter(handler({ seen }));

  await adapter.getProjectPrivileges();
  const afterFirst = seen.filter((u) => u.includes('/pm/projectuserrole')).length;
  await adapter.getProjectPrivileges();

  expect(seen.filter((u) => u.includes('/pm/projectuserrole')).length).toBe(afterFirst);
});
