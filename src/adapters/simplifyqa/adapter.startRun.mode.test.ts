import os from 'node:os';
import { SimplifyQaAdapter } from './adapter.js';

/** startRun mode/agent fidelity. A REMOTE dispatch used to be refused when the picked machine was
 *  registered from this box, which made callers fall back to LOCAL and the report then read
 *  "LOCAL-SERIAL". REMOTE must dispatch to whatever machine the caller picked, and the created
 *  execution must actually carry that mode + agent. */

type Handler = (url: string, init: RequestInit) => { status?: number; body: string };

const HOSTNAME = os.hostname().toLowerCase();

function makeAdapter(handler: Handler) {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const { status = 200, body } = handler(url, init);
    return { ok: status < 300, status, text: async () => body };
  }) as unknown as typeof fetch;
  return new SimplifyQaAdapter(
    { baseUrl: 'https://x.test', token: 't', projectId: 7, url: 'data:text/plain,ok' } as any,
    { fetchImpl, FormDataImpl: FormData },
  );
}

const DB_TC = {
  id: 42,
  name: 'DB CRUD',
  code: 'TC_42',
  projectId: 7,
  moduleId: 0,
  tcType: 'DATABASE',
  executionType: 'AUTOMATION',
  versions: [{ id: 'ver-1', name: 'v1.0' }],
};

function pipeline(opts: {
  capturedExec?: (b: any) => void;
  execDoc?: { mode?: string; agentId?: string } | null;
  roster?: any[];
}): Handler {
  return (url, init) => {
    // Project-access gate: GET /pm/auth/me → GET /pm/projectuserrole runs before any project-scoped call.
    if (url.includes('/pm/auth/me')) return { body: JSON.stringify({ userDetails: { id: 11, username: 'qa' } }) };
    if (url.includes('/pm/projectuserrole')) {
      return { body: JSON.stringify({ data: [{ projectId: 7, roleId: 2 }] }) };
    }
    if (url.includes('/tm/testcase/getById/42')) return { body: JSON.stringify({ data: DB_TC }) };
    if (url.includes('/pm/project/search')) return { body: JSON.stringify({ data: [{ id: 7, name: 'Proj Seven' }] }) };
    if (url.includes('/pm/fields/8')) return { body: JSON.stringify([{ key: 'general' }]) };
    if (url.includes('/pm/module/search')) return { body: JSON.stringify({ data: [] }) };
    if (url.includes('/tm/machineRegistration/search')) {
      return { body: JSON.stringify({ data: opts.roster ?? [] }) };
    }
    if (url.includes('/exec/execution/search')) {
      const doc = opts.execDoc;
      if (doc === null) return { status: 500, body: JSON.stringify({ message: 'nope' }) };
      return { body: JSON.stringify({ data: [{ id: 'run-1', ...(doc ?? {}) }] }) };
    }
    if (init.method === 'POST' && url.endsWith('/exec/execution')) {
      opts.capturedExec?.(JSON.parse(String(init.body)));
      return { body: JSON.stringify({ data: { id: 'run-1' } }) };
    }
    return { status: 404, body: JSON.stringify({ message: `unexpected ${init.method} ${url}` }) };
  };
}

const SELF_AGENT = {
  id: 'agent-self',
  machineName: `VIGNESH [ ${HOSTNAME} ]`,
  macAddress: 'aa:bb:cc:dd:ee:ff',
  active: true,
};
const REMOTE_AGENT = {
  id: 'agent-remote',
  machineName: 'SOMEONEELSE [ Windows-PC ]',
  macAddress: '11:22:33:44:55:66',
  active: true,
};

test('REMOTE dispatches to the other machine the caller picked', async () => {
  let captured: any = null;
  const adapter = makeAdapter(pipeline({
    capturedExec: (b) => { captured = b; },
    execDoc: { mode: 'REMOTE', agentId: 'agent-remote' },
    roster: [SELF_AGENT, REMOTE_AGENT],
  }));

  const ref = await adapter.startRun(
    { tcId: 'TC_42' },
    { mode: 'remote', agentId: 'agent-remote', environment: 'general' },
  );

  expect(ref.runId).toBe('run-1');
  expect(captured.mode).toBe('REMOTE');
  expect(captured.agentId).toBe('agent-remote');
  expect(captured.cloudType).toBe('NONE');
});

test('REMOTE refuses this box\'s own agent — a remote run must not silently be a local one', async () => {
  let posted = false;
  const adapter = makeAdapter(pipeline({
    capturedExec: () => { posted = true; },
    execDoc: { mode: 'REMOTE', agentId: 'agent-self' },
    roster: [SELF_AGENT, REMOTE_AGENT],
  }));

  await expect(
    adapter.startRun({ tcId: 'TC_42' }, { mode: 'remote', agentId: 'agent-self', environment: 'general' }),
  ).rejects.toThrow(/THIS machine's own agent/);
  expect(posted).toBe(false);
});

test('LOCAL still resolves this machine\'s agent and posts LOCAL', async () => {
  let captured: any = null;
  const adapter = makeAdapter(pipeline({
    capturedExec: (b) => { captured = b; },
    execDoc: { mode: 'LOCAL', agentId: 'agent-self' },
    roster: [SELF_AGENT],
  }));

  await adapter.startRun({ tcId: 'TC_42' }, { mode: 'local', environment: 'general' });

  expect(captured.mode).toBe('LOCAL');
  expect(captured.agentId).toBe('agent-self');
});

test('a backend that stores a different mode is surfaced at dispatch, not in the report', async () => {
  const adapter = makeAdapter(pipeline({
    execDoc: { mode: 'LOCAL', agentId: 'agent-remote' },
    roster: [SELF_AGENT, REMOTE_AGENT],
  }));

  await expect(
    adapter.startRun({ tcId: 'TC_42' }, { mode: 'remote', agentId: 'agent-remote', environment: 'general' }),
  ).rejects.toThrow(/created with mode LOCAL instead of REMOTE/);
});

test('a read-back failure never blocks an accepted run', async () => {
  const adapter = makeAdapter(pipeline({
    execDoc: null, // /exec/execution/search 500s
    roster: [SELF_AGENT, REMOTE_AGENT],
  }));

  // startRun now always returns the run's report link alongside the id (RunRef { runId, reportUrl }).
  const ref = await adapter.startRun(
    { tcId: 'TC_42' },
    { mode: 'remote', agentId: 'agent-remote', environment: 'general' },
  );
  expect(ref.runId).toBe('run-1');
  expect(ref.reportUrl).toContain('type=TESTCASE');
  expect(ref.reportUrl).toContain('parentId=42');
});

test('CLOUD stamps the chosen runner\'s machine type as cloudType', async () => {
  let captured: any = null;
  const adapter = makeAdapter(pipeline({
    capturedExec: (b) => { captured = b; },
    execDoc: { mode: 'CLOUD', agentId: '' },
    roster: [SELF_AGENT],
  }));

  await adapter.startRun(
    { tcId: 'TC_42' },
    { mode: 'cloud', environment: 'general', cloudRunnerId: 'cm-1', cloudType: 'AZURE' },
  );

  expect(captured.mode).toBe('CLOUD');
  expect(captured.cloudType).toBe('AZURE');
  expect(captured.agentId).toBeNull();
});
