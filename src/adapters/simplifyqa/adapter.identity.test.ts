import { SimplifyQaAdapter } from './adapter.js';

/** Identity resolution. QA_MCP_USER_ID used to be mandatory for API keys because the client cannot
 *  decode an SQA API key (encrypted JWT). GET /pm/auth/me maps the token to its user, so the id can
 *  be derived. Precedence must stay: explicit config → JWT claim → /me; and a backend without /me
 *  must degrade to the old unscoped behaviour instead of failing. */

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

const ALL_PROJECTS = [
  { id: 1, code: 'P1', name: 'One' },
  { id: 2, code: 'P2', name: 'Two' },
  { id: 3, code: 'P3', name: 'Three' },
  { id: 4, code: 'P4', name: 'Four' },
  { id: 5, code: 'P5', name: 'Five' },
  { id: 6, code: 'P6', name: 'Six' },
];

function handler(opts: {
  me?: { status?: number; body: string } | null;
  userProjectIds?: number[];
  seen?: string[];
}): Handler {
  return (url, init) => {
    opts.seen?.push(url);
    if (url.includes('/pm/auth/me')) {
      if (opts.me === null) return { status: 404, body: JSON.stringify({ message: 'Not found' }) };
      if (opts.me) return opts.me;
      return { body: JSON.stringify({ userDetails: { id: 36, username: 'Vignesh.V' } }) };
    }
    if (url.includes('/pm/projectuserrole')) {
      const ids = opts.userProjectIds ?? [1, 2, 4, 5];
      return { body: JSON.stringify({ data: ids.map((projectId) => ({ projectId })) }) };
    }
    if (url.endsWith('/pm/project/search')) {
      // Mirror the backend: when the caller scopes by ids (the two-step user path), only those
      // projects come back; otherwise the unscoped search returns the tenant list.
      let ids: number[] | null = null;
      try {
        const body = JSON.parse(String((init as any).body ?? '{}'));
        const f = (body.searchFields ?? []).find((x: any) => x.column === 'id');
        if (Array.isArray(f?.value)) ids = f.value as number[];
      } catch { /* no body */ }
      const data = ids ? ALL_PROJECTS.filter((p) => ids.includes(p.id)) : ALL_PROJECTS;
      return { body: JSON.stringify({ data, totalCount: data.length }) };
    }
    if (url.endsWith('/tm/testcase/search')) {
      return { body: JSON.stringify({ data: [], totalCount: 0 }) };
    }
    return { status: 404, body: JSON.stringify({ message: `unexpected ${url}` }) };
  };
}

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.sig`;
}

test('no QA_MCP_USER_ID → identity comes from /pm/auth/me and scopes projects', async () => {
  const seen: string[] = [];
  const adapter = makeAdapter(handler({ seen }));

  const projects = await adapter.listProjects();

  expect(projects.map((p: any) => p.id)).toEqual(['1', '2', '4', '5']);
  expect(projects.totalCount).toBe(4);
  expect(seen.filter((u) => u.includes('/pm/auth/me'))).toHaveLength(1);
  expect(seen.some((u) => u.includes('/pm/projectuserrole?userId=36'))).toBe(true);
});

test('/me is cached: two list calls trigger one identity request', async () => {
  const seen: string[] = [];
  const adapter = makeAdapter(handler({ seen }));

  await adapter.listProjects();
  await adapter.listProjects();

  expect(seen.filter((u) => u.includes('/pm/auth/me'))).toHaveLength(1);
});

test('explicit QA_MCP_USER_ID wins and /me is never called', async () => {
  const seen: string[] = [];
  const adapter = makeAdapter(handler({ seen, userProjectIds: [1] }), { userId: '99' });

  const projects = await adapter.listProjects();

  expect(projects.map((p: any) => p.id)).toEqual(['1']);
  expect(seen.some((u) => u.includes('/pm/auth/me'))).toBe(false);
  expect(seen.some((u) => u.includes('/pm/projectuserrole?userId=99'))).toBe(true);
});

test('a session JWT userId claim is used without calling /me', async () => {
  const seen: string[] = [];
  const adapter = makeAdapter(handler({ seen, userProjectIds: [2] }), { token: jwt({ userId: 7, customerId: 113 }) });

  await adapter.listProjects();

  expect(seen.some((u) => u.includes('/pm/auth/me'))).toBe(false);
  expect(seen.some((u) => u.includes('/pm/projectuserrole?userId=7'))).toBe(true);
});

test('a backend without /pm/auth/me degrades to unscoped project search', async () => {
  const adapter = makeAdapter(handler({ me: null }));

  const projects = await adapter.listProjects();

  expect(projects.map((p: any) => p.id)).toEqual(['1', '2', '3', '4', '5', '6']);
});

test('"me" filters resolve to the id from /pm/auth/me', async () => {
  let searchBody: any = null;
  const h = handler({});
  const adapter = makeAdapter((url, init) => {
    if (url.endsWith('/tm/testcase/search')) {
      searchBody = JSON.parse(String(init.body));
      return { body: JSON.stringify({ data: [], totalCount: 0 }) };
    }
    return h(url, init);
  });

  await adapter.listTestCases({ createdBy: 'me' } as any);

  expect(searchBody.searchFields).toEqual(
    expect.arrayContaining([{ column: 'createdBy', value: 36 }]),
  );
});

test('getSessionContext resolves userId from the token for the recorder window', async () => {
  const adapter = makeAdapter(handler({}));

  const ctx = await adapter.getSessionContext();

  expect(ctx.userId).toBe('36');
  expect(ctx.baseUrl).toBe('https://x.test');
});
