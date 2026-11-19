import { z } from 'zod';
import { SimplifyQaAdapter } from './adapter.js';
import { registerRunTools } from '../../tools/run.tools.js';

/**
 * DE-2347: a schedule with Chrome, a name, and "repeat every N …" — through the REAL tool schemas and the REAL
 * createSchedule / updateSchedule against a fake Scheduler. `schedule_update` used to reject `chrome` outright
 * (its browser enum had no chrome), and the descriptions told the model schedules can't use Chrome.
 */
const START = '2026-11-17T09:00:00.000Z';
const END = '2026-12-31T09:00:00.000Z';
const REC = { startDate: START, endDate: END, interval: 1, daysOfWeek: [], dayOfMonth: null, occurencePosition: '' };
const TC = { id: 38, code: 'TC-38', projectId: 19, deleted: false, tcType: 'WEB', versions: [{ id: '380', name: 'v1.0' }], versionId: '380' };
const existing = () => ({
  id: 12, code: 'SH-12', name: 'TC-38 schedule', projectId: 19, deleted: false, updateVersion: 0, status: 'NOT STARTED', cancelled: false,
  schedulerType: 'TC', parentId: 38, parentVersionId: '380', platForm: [{ id: 'FIREFOX', name: 'FIREFOX', type: 'NONE', technologyType: 'WEB' }],
  releaseId: null, iterationId: null, recurrenceType: 'HOURLY', reccurenceData: { ...REC, interval: 2 }, scheduleStartDate: START, scheduleEndDate: END,
  executionMode: 'local', agentId: ['agent-1'], environment: 'general',
});

function backend() {
  const schedules: any[] = [existing()];
  const posts: any[] = [];
  const puts: any[] = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: 'http://backend' };
  a.requireProjectId = () => 19;
  a.fetchRawTestcase = async () => TC;
  a.http = {
    postJson: async (path: string, body: any) => {
      if (path === '/sh/scheduler/search') return { data: schedules };
      if (path === '/sh/scheduler') { posts.push(body); const row = { id: 13, code: 'SH-13', ...body }; schedules.push(row); return { data: row }; }
      throw new Error(`unexpected POST ${path}`);
    },
    getJson: async (path: string) => {
      const m = /^\/sh\/scheduler\/(\d+)$/.exec(path);
      if (m) return schedules.filter((s) => String(s.id) === m[1]);
      throw new Error(`unexpected GET ${path}`);
    },
    putJson: async (path: string, body: any) => {
      puts.push(body);
      const i = schedules.findIndex((s) => `/sh/scheduler/${s.id}` === path);
      schedules[i] = { ...body, id: schedules[i].id, code: schedules[i].code, updateVersion: (schedules[i].updateVersion ?? 0) + 1 };
      return { data: schedules[i] };
    },
  };
  return { a, posts, puts, schedules };
}

function tools(a: any) {
  const reg = new Map<string, { schema: Record<string, z.ZodTypeAny>; handler: (x: any) => Promise<any> }>();
  const server: any = { registerTool: (n: string, cfg: any, h: any) => { reg.set(n, { schema: cfg.inputSchema, handler: h }); } };
  registerRunTools(server, { getAdapter: () => a, getProjectId: () => '19' });
  return reg;
}

describe('schedule_update accepts chrome (and the other SimplifyQA browsers)', () => {
  test.each(['chrome', 'chromium', 'msedge', 'edge', 'firefox', 'webkit', 'safari'])('the tool schema accepts browser "%s"', (b) => {
    const t = tools(backend().a).get('schedule_update')!;
    expect(z.object(t.schema).safeParse({ scheduleId: '12', browser: b }).success).toBe(true);
  });

  test('schedule_update browser:"chrome" changes the schedule\'s platform to CHROME and nothing else', async () => {
    const be = backend();
    const t = tools(be.a).get('schedule_update')!;
    const res = await t.handler({ scheduleId: '12', browser: 'chrome' });
    expect(res.isError).toBeFalsy();
    expect(be.puts).toHaveLength(1);
    expect(be.puts[0].platForm).toEqual([{ id: 'CHROME', name: 'CHROME', type: 'NONE', technologyType: 'WEB' }]);
    expect(be.puts[0]).toMatchObject({ recurrenceType: 'HOURLY', name: 'TC-38 schedule', agentId: ['agent-1'] });
  });

  test('an unknown browser is refused with the valid ones, and nothing is written', async () => {
    const be = backend();
    const res = await tools(be.a).get('schedule_update')!.handler({ scheduleId: '12', browser: 'netscape' });
    expect(res.isError).toBe(true);
    expect(String(res.content[0].text)).toMatch(/Unknown browser "netscape".*chrome/);
    expect(be.puts).toEqual([]);
  });

  test('the descriptions no longer say a schedule cannot use chrome (SimplifyQA)', () => {
    const reg = tools(backend().a);
    const desc = (n: string): string => String((reg.get(n)!.schema['browser'] as any).description);
    for (const n of ['tc_run', 'suite_run', 'schedule_update']) expect(desc(n)).toMatch(/chrome is fine/);
  });
});

describe('a named schedule that repeats every N … on Chrome (create)', () => {
  test('hourly + interval 3, scheduleName, browser chrome → one POST with all three', async () => {
    const be = backend();
    const ref = await be.a.createSchedule({ tcId: 'TC-38' }, {
      mode: 'local', agentId: 'agent-1', scheduledFor: START, endDate: END, timezone: 'UTC',
      scheduleType: 'hourly', interval: 3, name: 'every 3h smoke', browser: 'chrome',
    });
    expect(be.posts).toHaveLength(1);
    expect(be.posts[0]).toMatchObject({ name: 'every 3h smoke', recurrenceType: 'HOURLY', platForm: [{ id: 'CHROME' }] });
    expect(be.posts[0].reccurenceData.interval).toBe(3);
    expect(ref.name).toBe('every 3h smoke');
  });

  test('"every N minutes" is stored as EVERY_5_MINUTES with interval N', async () => {
    const be = backend();
    const ref = await be.a.createSchedule({ tcId: 'TC-38' }, {
      mode: 'local', agentId: 'agent-1', scheduledFor: START, endDate: END, timezone: 'UTC', scheduleType: 'every_5_minutes', interval: 15,
    });
    expect(be.posts).toHaveLength(1);
    expect(be.posts[0]).toMatchObject({ recurrenceType: 'EVERY_5_MINUTES' });
    expect(be.posts[0].reccurenceData.interval).toBe(15);
    expect(ref.id).toBeDefined();
  });
});
