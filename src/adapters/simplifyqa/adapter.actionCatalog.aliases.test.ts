import { SimplifyQaAdapter } from './adapter.js';

/**
 * The PUBLIC action catalog must contain only real action names.
 *
 * The adapter keys its internal resolution map several ways (`id::1`, `uniq::web-1`,
 * `dis::click`, and — when the backend row carries an objectTemplate — `WEB::click` /
 * `WEB::dis::click`). Those aliases exist so a saved or recorded step resolves back to its action.
 * They must NEVER reach `actionsCatalog()`: a `WEB::click` string is not a valid step `actionType`,
 * and listing the same action three times pollutes the model's vocabulary.
 */

type Route = { method: string; path: string; body: unknown };

function ok(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function adapterFor(router: (url: string, init: { method?: string }) => unknown) {
  const fetchImpl = (async (url: string, init: { method?: string } = {}) => ok(router(String(url), init))) as never;
  return new SimplifyQaAdapter(
    { baseUrl: 'https://x.test', token: 't', projectId: 7 } as never,
    { fetchImpl } as never,
  );
}

/** Answers the project-access gate so the adapter behaves as it does for a member. */
function accessRoute(url: string): unknown | undefined {
  if (url.includes('/pm/auth/me')) return { userDetails: { id: 36, username: 'qa.user', email: 'qa.user@x.test', userType: 'user' } };
  if (url.includes('/pm/projectuserrole')) return { data: [{ userId: 36, projectId: 7, roleId: 2, deleted: false }] };
  return undefined;
}

describe('actionsCatalog public vocabulary', () => {
  it('lists each action once, under its real name only', async () => {
    const seen: Route[] = [];
    const adapter = adapterFor((url, init) => {
      const access = accessRoute(url);
      if (access) return access;
      if (url.includes('/tm/action/search')) {
        seen.push({ method: init.method ?? 'POST', path: url, body: null });
        return {
          data: [
            // objectTemplate present: this is the row shape that used to leak `WEB::click`
            { id: 1, name: 'click', disname: 'Click', objectRequired: true, objectTemplate: 3, uniqueId: 'web-1' },
            { id: 2, name: 'executequery', disname: 'Execute Query', objectRequired: false, uniqueId: 'db-1' },
          ],
        };
      }
      if (url.includes('/tm/objectTemplate/search')) return { data: [{ id: 3, name: 'web' }] };
      return {};
    });

    const defs = await adapter.actionsCatalog();

    // No internal alias may appear, in any form.
    expect(defs.map((d) => d.actionType)).toEqual(['click', 'executequery']);
    for (const d of defs) expect(d.actionType).not.toContain('::');

    // No action may be listed twice (the leak produced one entry per alias of the same id).
    const ids = defs.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);

    // The mapping itself is still right: numeric id + objectRequired survive for round-tripping.
    expect(defs.find((d) => d.actionType === 'click')).toMatchObject({ id: 1, objectRequired: true, description: 'Click' });
    expect(defs.find((d) => d.actionType === 'executequery')).toMatchObject({ id: 2, objectRequired: false });

    // The public catalog is built from the backend catalog, not from a fixture.
    expect(seen.length).toBe(1);
  });
});
