import { SimplifyQaAdapter } from './adapter.js';
import { describeCadence } from '../../tools/run.tools.js';

/**
 * "Create a schedule with a recurrence — Every 5 Minutes, every N hours / days / weeks / months" — driven through the REAL createSchedule /
 * updateSchedule against a fake Scheduler. The Scheduler form's recurrence fields: REPEAT EVERY N (hourly / daily / weekly / monthly), the
 * weekdays of a weekly schedule, and monthly "ON DAY d" (1–30) or "ON THE first / second / third / last <weekday>".
 */
const START = '2026-11-17T09:00:00.000Z';      // a Tuesday
const END = '2026-12-31T09:00:00.000Z';
const TC = { id: 22, code: 'TC-22', projectId: 19, deleted: false, tcType: 'WEB', versions: [{ id: '1', name: 'v1.0' }], versionId: '1' };
const BASE = { mode: 'local' as const, agentId: 'agent-1', scheduledFor: START, endDate: END, timezone: 'UTC' };

function backend(schedules: any[] = []) {
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
const create = (opts: Record<string, unknown>, sched = backend()) => sched.a.createSchedule({ tcId: 'TC-22' }, { ...BASE, ...opts }).then(() => sched.posts[0]);

describe('create a schedule with a recurrence', () => {
  test('Every 5 Minutes: the product\'s own EVERY_5_MINUTES, with its end date', async () => {
    const body = await create({ scheduleType: 'every_5_minutes' });
    expect(body).toMatchObject({ recurrenceType: 'EVERY_5_MINUTES', scheduleStartDate: START, scheduleEndDate: END });
    expect(body.reccurenceData).toEqual({ startDate: START, endDate: END, interval: 1, daysOfWeek: [], dayOfMonth: null, occurencePosition: '' });
    await expect(backend().a.createSchedule({ tcId: 'TC-22' }, { ...BASE, endDate: undefined, scheduleType: 'every_5_minutes' })).rejects.toThrow(/needs an end date/);
  });

  test('REPEAT EVERY N: every 2 hours, every 3 days, every 2 weeks', async () => {
    expect((await create({ scheduleType: 'hourly', interval: 2 })).reccurenceData).toMatchObject({ interval: 2, daysOfWeek: [], dayOfMonth: null });
    const daily = await create({ scheduleType: 'daily', interval: 3 });
    expect([daily.recurrenceType, daily.reccurenceData.interval]).toEqual(['DAILY', 3]);
    const weekly = await create({ scheduleType: 'weekly', interval: 2 });
    expect([weekly.recurrenceType, weekly.reccurenceData.interval, weekly.reccurenceData.daysOfWeek]).toEqual(['WEEKLY', 2, ['TUESDAY']]);   // the start's weekday
    expect((await create({ scheduleType: 'hourly' })).reccurenceData.interval).toBe(1);                                                        // default unchanged
  });

  test('weekly on chosen days (names or short names, any case); monthly on a day, or on the first / last weekday', async () => {
    expect((await create({ scheduleType: 'weekly', daysOfWeek: ['mon', 'FRIDAY', 'Mon'] })).reccurenceData.daysOfWeek).toEqual(['MONDAY', 'FRIDAY']);
    const onDay = await create({ scheduleType: 'monthly', dayOfMonth: 15, interval: 2 });
    expect(onDay.reccurenceData).toMatchObject({ interval: 2, dayOfMonth: 15, occurencePosition: '', daysOfWeek: [] });
    const onThe = await create({ scheduleType: 'monthly', occurrence: 'first', daysOfWeek: ['monday'] });
    expect(onThe.reccurenceData).toMatchObject({ occurencePosition: 'FIRST', daysOfWeek: ['MONDAY'], dayOfMonth: null });
    expect((await create({ scheduleType: 'monthly' })).reccurenceData.dayOfMonth).toBe(17);                                                     // default: the start's day
    expect((await create({ scheduleType: 'weekdays' })).reccurenceData.daysOfWeek).toHaveLength(5);
  });

  test('settings a cadence does not have are refused with the reason — never silently dropped', async () => {
    const refuse = (opts: Record<string, unknown>, re: RegExp) => expect(create(opts)).rejects.toThrow(re);
    await refuse({ scheduleType: 'once', interval: 2 }, /A Once schedule has no recurrence settings/);
    // "every N minutes" is supported: EVERY_5_MINUTES + interval N (checked in the cadence test below).
    await refuse({ scheduleType: 'hourly', interval: 0 }, /whole number, 1 or more/);
    await refuse({ scheduleType: 'hourly', interval: 1.5 }, /whole number, 1 or more/);
    await refuse({ scheduleType: 'daily', daysOfWeek: ['MONDAY'] }, /daysOfWeek applies to a weekly/);
    await refuse({ scheduleType: 'weekdays', daysOfWeek: ['MONDAY'] }, /weekdays already means Monday–Friday/);
    await refuse({ scheduleType: 'weekly', daysOfWeek: ['funday'] }, /"funday" is not a weekday/);
    await refuse({ scheduleType: 'weekly', daysOfWeek: [] }, /at least one weekday/);
    await refuse({ scheduleType: 'weekly', dayOfMonth: 5 }, /apply to a monthly schedule only/);
    await refuse({ scheduleType: 'monthly', dayOfMonth: 31 }, /1 to 30/);
    await refuse({ scheduleType: 'monthly', dayOfMonth: 5, occurrence: 'last', daysOfWeek: ['FRIDAY'] }, /not both/);
    await refuse({ scheduleType: 'monthly', occurrence: 'last' }, /exactly one weekday/);
    await refuse({ scheduleType: 'monthly', occurrence: 'last', daysOfWeek: ['MON', 'FRI'] }, /exactly one weekday/);
  });
});

describe('edit a schedule\'s recurrence', () => {
  const hourly = () => backend([{
    id: 5, code: 'SH-5', name: 'poll', projectId: 19, deleted: false, updateVersion: 0, schedulerType: 'TC', parentId: 22, recurrenceType: 'HOURLY',
    reccurenceData: { startDate: START, endDate: END, interval: 1, daysOfWeek: [], dayOfMonth: null, occurencePosition: '' }, scheduleStartDate: START, scheduleEndDate: END,
  }]);

  test('interval alone: the schedule keeps its cadence (HOURLY) and end, and now repeats every 3', async () => {
    const { a, puts } = hourly();
    await a.updateSchedule('5', { interval: 3 });
    expect(puts[0]).toMatchObject({ recurrenceType: 'HOURLY', scheduleEndDate: END });
    expect(puts[0].reccurenceData).toMatchObject({ interval: 3, startDate: START, endDate: END });
  });

  test('a new cadence with its settings: weekly every 2 weeks on Monday and Friday', async () => {
    const { a, puts } = hourly();
    await a.updateSchedule('5', { scheduleType: 'weekly', interval: 2, daysOfWeek: ['MON', 'FRI'] });
    expect(puts[0]).toMatchObject({ recurrenceType: 'WEEKLY' });
    expect(puts[0].reccurenceData).toMatchObject({ interval: 2, daysOfWeek: ['MONDAY', 'FRIDAY'] });
  });

  test('settings on a Once schedule, or for another cadence, are refused', async () => {
    const once = backend([{ id: 6, code: 'SH-6', name: 'single', projectId: 19, deleted: false, updateVersion: 0, schedulerType: 'TC', parentId: 22, recurrenceType: 'ONCE',
      reccurenceData: { startDate: START, endDate: null, interval: 1, daysOfWeek: [], dayOfMonth: null, occurencePosition: '' }, scheduleStartDate: START, scheduleEndDate: START }]);
    await expect(once.a.updateSchedule('6', { interval: 2 })).rejects.toThrow(/A Once schedule has no recurrence settings/);
    await expect(hourly().a.updateSchedule('5', { dayOfMonth: 3 })).rejects.toThrow(/apply to a monthly schedule only/);
    expect(once.puts).toEqual([]);
  });

  test('changing only the start time keeps the interval it already has', async () => {
    const h = backend([{ id: 5, code: 'SH-5', name: 'poll', projectId: 19, deleted: false, updateVersion: 0, schedulerType: 'TC', parentId: 22, recurrenceType: 'HOURLY',
      reccurenceData: { startDate: START, endDate: END, interval: 4, daysOfWeek: [], dayOfMonth: null, occurencePosition: '' }, scheduleStartDate: START, scheduleEndDate: END }]);
    await h.a.updateSchedule('5', { scheduledFor: '2026-11-18T09:00:00.000Z' });
    expect(h.puts[0].reccurenceData).toMatchObject({ interval: 4, startDate: '2026-11-18T09:00:00.000Z' });
  });
});

describe('describeCadence', () => {
  test('says what a schedule repeats as', () => {
    expect(describeCadence(undefined, {})).toBe('once');
    expect(describeCadence('hourly', {})).toBe('hourly');
    expect(describeCadence('hourly', { interval: 2 })).toBe('every 2 hours');
    expect(describeCadence('daily', { interval: 3 })).toBe('every 3 days');
    expect(describeCadence('weekly', { daysOfWeek: ['mon', 'fri'] })).toBe('weekly on MON, FRI');
    expect(describeCadence('monthly', { occurrence: 'first', daysOfWeek: ['monday'] })).toBe('monthly on the first MONDAY');
    expect(describeCadence('monthly', { interval: 2, dayOfMonth: 15 })).toBe('every 2 months on day 15');
    expect(describeCadence('every_5_minutes', {})).toBe('every_5_minutes');
  });
});
