import os from 'node:os';
import { SimplifyQaAdapter } from './adapter.js';

/** listLocalAgents must flip `online: true` for a row that matches THIS machine on ANY of:
 *  hostname (bare), MAC address, or IP — regardless of the DB `active` flag. The executions-service
 *  bug (7s stale cron that only writes `active=true` on FIRST registration) means a running agent
 *  frequently reports `active:false`; we cannot touch that service, so the adapter compensates. */

type Handler = (url: string, init: RequestInit) => { status?: number; body: string };

function makeAdapter(handler: Handler) {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    // Project-access gate: GET /pm/auth/me → GET /pm/projectuserrole runs before any project-scoped call.
    if (url.includes('/pm/auth/me')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ userDetails: { id: 51, username: 'qa' } }) };
    }
    if (url.includes('/pm/projectuserrole')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ projectId: 7, roleId: 2 }] }) };
    }
    const { status = 200, body } = handler(url, init);
    return { ok: status < 300, status, text: async () => body };
  }) as unknown as typeof fetch;
  return new SimplifyQaAdapter(
    { baseUrl: 'https://x.test', token: 't', projectId: 7 } as any,
    { fetchImpl, FormDataImpl: FormData },
  );
}

function pickLocalIds() {
  const hostFull = os.hostname().toLowerCase();
  const hostBare = hostFull.replace(/\.(local|lan|localdomain)$/, '').split('.')[0] ?? hostFull;
  let mac = '';
  let ip = '';
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.internal) continue;
      if (!mac && iface.mac && iface.mac !== '00:00:00:00:00:00') mac = iface.mac;
      if (!ip && iface.address) ip = iface.address;
    }
  }
  return { hostBare, mac, ip };
}

test('listLocalAgents overrides active:false when hostname matches this machine', async () => {
  const { hostBare } = pickLocalIds();
  const adapter = makeAdapter((url) => {
    if (url.includes('/tm/machineRegistration/search')) {
      // active:false but machineName includes this box's hostname — should still be online.
      return { body: JSON.stringify({ data: [
        { id: 'a1', machineName: `USER [ ${hostBare}.local ]`, active: false, macAddress: 'aa:bb:cc:dd:ee:00' },
      ] }) };
    }
    throw new Error(`unexpected ${url}`);
  });
  const agents = await adapter.listLocalAgents!();
  expect(agents[0]!.online).toBe(true);
  expect(agents[0]!.isThisMachine).toBe(true);
});

test('listLocalAgents overrides active:false when MAC matches this machine', async () => {
  const { mac } = pickLocalIds();
  if (!mac) return; // CI runners without a routable NIC — skip cleanly.
  const adapter = makeAdapter((url) => {
    if (url.includes('/tm/machineRegistration/search')) {
      // Hostname deliberately wrong so ONLY the MAC can match.
      return { body: JSON.stringify({ data: [
        { id: 'a2', machineName: 'some-other-laptop', active: false, macAddress: mac.toUpperCase() },
      ] }) };
    }
    throw new Error(`unexpected ${url}`);
  });
  const agents = await adapter.listLocalAgents!();
  expect(agents[0]!.online).toBe(true);
  expect(agents[0]!.isThisMachine).toBe(true);
});

test('listLocalAgents leaves offline agents from OTHER machines alone', async () => {
  const adapter = makeAdapter((url) => {
    if (url.includes('/tm/machineRegistration/search')) {
      return { body: JSON.stringify({ data: [
        { id: 'foreign', machineName: 'teammate-laptop-xyz', active: false, macAddress: '00:11:22:33:44:55', ipAddress: '10.99.99.99' },
      ] }) };
    }
    throw new Error(`unexpected ${url}`);
  });
  const agents = await adapter.listLocalAgents!();
  expect(agents[0]!.online).toBe(false);
  expect(agents[0]!.isThisMachine).toBeUndefined();
});

test('probeLocalAgent returns true on any HTTP response, false on network error', async () => {
  // Stub global fetch — SimplifyQaAdapter uses the runtime fetch here, not the injected QaHttp
  // transport (the probe hits the agent /mcp, not the backend REST base).
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response('', { status: 400 })) as unknown as typeof fetch;
    const upAdapter = new SimplifyQaAdapter(
      { baseUrl: 'https://x.test', token: 't', projectId: 7, url: 'http://127.0.0.1:4040/mcp' } as any,
      { fetchImpl: (async () => ({ ok: true, status: 200, text: async () => '{}' })) as unknown as typeof fetch, FormDataImpl: FormData },
    );
    expect(await upAdapter.probeLocalAgent()).toBe(true);

    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await upAdapter.probeLocalAgent()).toBe(false);

    // No agent URL configured → false without any network call.
    const noUrlAdapter = new SimplifyQaAdapter(
      { baseUrl: 'https://x.test', token: 't', projectId: 7 } as any,
      { fetchImpl: (async () => ({ ok: true, status: 200, text: async () => '{}' })) as unknown as typeof fetch, FormDataImpl: FormData },
    );
    expect(await noUrlAdapter.probeLocalAgent()).toBe(false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
