import { SimplifyQaAdapter } from './adapter.js';
import { ApiError } from '../http.js';

/**
 * "Create a Once schedule for TC-22 at 1:55 PM named 'schduler name check'", rename it, and schedule the same target twice — driven through the
 * REAL createSchedule / updateSchedule against a fake Scheduler that behaves like the product: names are unique per project (a second one is
 * HTTP 409 DUPLICATENAME) and a PUT is a whole-document replace with an updateVersion check.
 */
const START = '2026-11-17T13:55:00.000Z';
const TC = (id: number, code: string) => ({ id, code, projectId: 19, deleted: false, tcType: 'WEB', versions: [{ id: '1', name: 'v1.0' }], versionId: '1' });

function backend(opts: { schedules?: any[]; ignoreRename?: boolean; duplicateOnlyServerSide?: boolean } = {}) {
  const schedules = opts.schedules ?? [];
  const posts: any[] = [];
  const puts: any[] = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: 'http://backend' };
  a.requireProjectId = () => 19;
  a.fetchRawTestcase = async (id: string) => (/22/.test(id) ? TC(22, 'TC-22') : /39/.test(id) ? TC(39, 'TC-39') : {});
  const clash = (name: string, self?: number) => schedules.find((s) => s.name.toLowerCase() === String(name).toLowerCase() && s.id !== self);
  a.http = {
    postJson: async (path: string, body: any) => {
      if (path === '/sh/scheduler/search') return { data: opts.duplicateOnlyServerSide ? [] : schedules };
      if (path === '/sh/scheduler') {
        posts.push(body);
        if (clash(body.name)) throw new ApiError(409, JSON.stringify({ errorCode: 'DUPLICATENAME', message: 'Duplicate Name Error' }), 'POST /sh/scheduler');
        const row = { id: 13 + schedules.length, code: `SH-${13 + schedules.length}`, deleted: false, updateVersion: 0, status: 'NOT STARTED', ...body };
        schedules.push(row);
        return { data: row };
      }
      throw new Error(`unexpected POST ${path}`);
    },
    getJson: async (path: string) => {
      const m = /^\/sh\/scheduler\/(\d+)$/.exec(path);
      if (m) return schedules.filter((s) => String(s.id) === m[1]);
      throw new Error(`unexpected GET ${path}`);
    },
    putJson: async (path: string, body: any) => {
      puts.push(body);
      const row = schedules.find((s) => `/sh/scheduler/${s.id}` === path)!;
      if (clash(body.name, row.id)) throw new ApiError(409, JSON.stringify({ errorCode: 'DUPLICATENAME' }), `PUT ${path}`);
      if (body.updateVersion !== row.updateVersion) throw new Error('CONCURRENCY');
      if (!opts.ignoreRename) Object.assign(row, body, { updateVersion: row.updateVersion + 1 });
      return { data: row };
    },
  };
  return { a, posts, puts, schedules };
}
const OPTS = { mode: 'local' as const, agentId: 'agent-1', scheduledFor: START, scheduleType: 'once' as const, timezone: 'Asia/Kolkata' };

describe('create a schedule with a name', () => {
  test('"schduler name check" is the schedule\'s name (not "TC-22 schedule")', async () => {
    const { a, posts, schedules } = backend();
    const ref = await a.createSchedule({ tcId: 'TC-22' }, { ...OPTS, name: 'schduler name check' });
    expect(posts[0].name).toBe('schduler name check');
    expect(schedules[0].name).toBe('schduler name check');
    expect(ref).toMatchObject({ id: '13', name: 'schduler name check' });
  });

  test('a given name is checked like the Scheduler form: 3–501 characters, unique in the project (any case)', async () => {
    const { a, posts } = backend({ schedules: [{ id: 5, code: 'SH-5', name: 'nightly smoke', deleted: false }] });
    await expect(a.createSchedule({ tcId: 'TC-22' }, { ...OPTS, name: 'ab' })).rejects.toThrow(/at least 3 characters/);
    await expect(a.createSchedule({ tcId: 'TC-22' }, { ...OPTS, name: 'x'.repeat(502) })).rejects.toThrow(/at most 501/);
    await expect(a.createSchedule({ tcId: 'TC-22' }, { ...OPTS, name: 'Nightly Smoke' })).rejects.toThrow(/already exists in this project \(SH-5\)/);
    expect(posts).toEqual([]);
    expect((await a.createSchedule({ tcId: 'TC-22' }, { ...OPTS, name: ' weekly regression ' })).name).toBe('weekly regression');
  });

  test('no name given: the automatic name is made UNIQUE, so the same test case can be scheduled twice (it used to be HTTP 409)', async () => {
    const { a, posts } = backend();
    const names: string[] = [];
    for (let i = 0; i < 3; i++) names.push((await a.createSchedule({ tcId: 'TC-39' }, { ...OPTS, scheduleType: 'weekly', endDate: '2026-12-31T00:00:00.000Z' })).name);
    expect(names).toEqual(['TC-39 schedule', 'TC-39 schedule 2', 'TC-39 schedule 3']);
    expect(posts.map((p) => p.name)).toEqual(names);
  });

  test('if the Scheduler still answers 409 DUPLICATENAME (a name we could not see), it is said in words', async () => {
    const { a } = backend({ schedules: [{ id: 5, code: 'SH-5', name: 'hidden', deleted: false }], duplicateOnlyServerSide: true });
    await expect(a.createSchedule({ tcId: 'TC-22' }, { ...OPTS, name: 'hidden' })).rejects.toThrow(/A schedule named "hidden" already exists.*unique/s);
  });
});

describe('rename a schedule', () => {
  const seeded = () => backend({ schedules: [
    { id: 13, code: 'SH-13', name: 'TC-22 schedule', projectId: 19, deleted: false, updateVersion: 0, status: 'NOT STARTED', schedulerType: 'TC', parentId: 22, recurrenceType: 'ONCE',
      reccurenceData: { startDate: START, endDate: START, interval: 1, daysOfWeek: [], dayOfMonth: null, occurencePosition: '' }, scheduleStartDate: START, scheduleEndDate: START },
    { id: 14, code: 'SH-14', name: 'nightly smoke', projectId: 19, deleted: false, updateVersion: 0, schedulerType: 'TC', parentId: 39 },
  ] });

  test('schedule_update with a name renames it, sends the whole document, and reads the name back', async () => {
    const { a, puts, schedules } = seeded();
    const ref = await a.updateSchedule('13', { name: 'schduler name check' });
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ id: 13, name: 'schduler name check', schedulerType: 'TC', parentId: 22, updateVersion: 0 });
    expect(schedules[0]!.name).toBe('schduler name check');
    expect(ref).toMatchObject({ id: '13', name: 'schduler name check' });
  });

  test('a name another schedule has is refused; the schedule\'s own name is allowed (nothing to change); too short is refused', async () => {
    const { a, puts } = seeded();
    await expect(a.updateSchedule('13', { name: 'nightly smoke' })).rejects.toThrow(/already exists in this project \(SH-14\)/);
    await expect(a.updateSchedule('13', { name: 'no' })).rejects.toThrow(/at least 3 characters/);
    expect(puts).toEqual([]);
    const same = await a.updateSchedule('13', { name: 'TC-22 schedule' });
    expect(same.name).toBeUndefined();   // nothing was renamed
  });

  test('a rename the backend did not apply is reported, not claimed', async () => {
    const { a } = backend({ ignoreRename: true, schedules: [{ id: 13, code: 'SH-13', name: 'TC-22 schedule', projectId: 19, deleted: false, updateVersion: 0, schedulerType: 'TC', parentId: 22, recurrenceType: 'ONCE' }] });
    await expect(a.updateSchedule('13', { name: 'brand new name' })).rejects.toThrow(/sent the name "brand new name" but reads back as "TC-22 schedule"/);
  });

  test('a rename can go together with other changes in one edit', async () => {
    const { a, puts } = seeded();
    await a.updateSchedule('13', { name: 'renamed and moved', scheduledFor: '2026-11-18T13:55:00.000Z' });
    expect(puts[0]).toMatchObject({ name: 'renamed and moved', scheduleStartDate: '2026-11-18T13:55:00.000Z' });
  });
});

describe('the listing shows each schedule\'s name', () => {
  test('listSchedules carries the name', async () => {
    const { a } = backend({ schedules: [{ id: 13, code: 'SH-13', name: 'schduler name check', schedulerType: 'TC', parentId: 22, recurrenceType: 'ONCE', status: 'NOT STARTED' }] });
    const rows = await a.listSchedules();
    expect(rows[0]).toMatchObject({ id: '13', name: 'schduler name check' });
  });
});
