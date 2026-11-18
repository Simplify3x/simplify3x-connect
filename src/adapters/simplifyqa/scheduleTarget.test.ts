import { SimplifyQaAdapter } from './adapter.js';

/**
 * SH-11 ("SU-4 schedule", Once, suite SU-4): "change the schedule type from Suite to Test Case and select TC-35" — and back — driven through
 * the REAL updateSchedule against a fake Scheduler: a PUT replaces the document (a key left out is gone) and has an updateVersion check.
 */
const START = '2026-11-17T13:55:00.000Z';
const REC = { startDate: START, endDate: START, interval: 1, daysOfWeek: [], dayOfMonth: null, occurencePosition: '' };

const suiteSchedule = (over: Record<string, unknown> = {}) => ({
  id: 11, code: 'SH-11', name: 'SU-4 schedule', projectId: 19, deleted: false, updateVersion: 0, status: 'NOT STARTED', cancelled: false,
  schedulerType: 'SU', parentId: 4, platForm: [{ id: 'FIREFOX', name: 'FIREFOX', type: 'NONE', technologyType: 'WEB' }], releaseId: 5, iterationId: null,
  recurrenceType: 'ONCE', reccurenceData: REC, scheduleStartDate: START, scheduleEndDate: START, executionMode: 'local', agentId: ['agent-1'], environment: 'general', ...over,
});
const tcSchedule = () => suiteSchedule({ id: 12, code: 'SH-12', name: 'TC-35 schedule', schedulerType: 'TC', parentId: 35, parentVersionId: '350', releaseId: null });

const TCS: Record<string, any> = {
  '35': { id: 35, code: 'TC-35', projectId: 19, deleted: false, tcType: 'WEB', versions: [{ id: '350', name: 'v1.0' }], versionId: '350' },
  '99': { id: 99, code: 'TC-99', projectId: 77, deleted: false, tcType: 'WEB', versions: [{ id: '990', name: 'v1.0' }], versionId: '990' },
  '40': { id: 40, code: 'TC-40', projectId: 19, deleted: false, tcType: 'ANDROID', versions: [{ id: '400', name: 'v1.0' }], versionId: '400' },
};
const SUITES: Record<string, any> = {
  '4': { id: 4, code: 'SU-4', projectId: 19, testCases: [{ tcType: 'WEB' }, { tcType: 'API' }] },
  '7': { id: 7, code: 'SU-7', projectId: 19, testCases: [] },
};
const RELEASES = [{ id: 5, code: 'RE-5', name: 'demo release', state: 'New', projectIds: [19] }];

function backend(opts: { schedules?: any[]; ignoreTarget?: boolean } = {}) {
  const schedules = opts.schedules ?? [suiteSchedule()];
  const puts: any[] = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: 'http://backend' };
  a.requireProjectId = () => 19;
  a.fetchRawTestcase = async (id: string) => TCS[String(id).replace(/\D/g, '')] ?? {};
  a.readOwnSuite = async (id: string) => { const s = SUITES[String(id).replace(/\D/g, '')]; if (!s) throw new Error(`Suite ${id} not found.`); return s; };
  a.http = {
    postJson: async (path: string) => {
      if (path === '/sh/scheduler/search') return { data: schedules };
      if (path === '/pm/release/search') return { data: RELEASES };
      if (path === '/pm/sprint/search') return { data: [] };
      throw new Error(`unexpected POST ${path}`);
    },
    getJson: async (path: string) => {
      const m = /^\/sh\/scheduler\/(\d+)$/.exec(path);
      if (m) return schedules.filter((s) => String(s.id) === m[1]);
      throw new Error(`unexpected GET ${path}`);
    },
    putJson: async (path: string, body: any) => {
      puts.push({ path, body });
      const i = schedules.findIndex((s) => `/sh/scheduler/${s.id}` === path);
      const row = schedules[i]!;
      if (body.updateVersion !== row.updateVersion) throw new Error('CONCURRENCY');
      // whole-document replace: keys not sent are gone; the target fields can be ignored to test the read-back
      const next: any = { ...body, id: row.id, code: row.code, deleted: false, updateVersion: row.updateVersion + 1 };
      if (opts.ignoreTarget) { next.schedulerType = row.schedulerType; next.parentId = row.parentId; }
      schedules[i] = next;
      return { data: next };
    },
  };
  return { a, puts, schedules };
}

describe('SH-11: Suite → Test Case (the reported case)', () => {
  test('the same schedule id now runs TC-35: type, target, version and browser platform are set; the rest of the schedule is kept', async () => {
    const { a, puts, schedules } = backend();
    const ref = await a.updateSchedule('11', { tcId: 'TC-35' });
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toBe('/sh/scheduler/11');
    expect(puts[0].body).toMatchObject({
      id: 11, schedulerType: 'TC', parentId: 35, parentVersionId: '350', platForm: [{ id: 'FIREFOX', name: 'FIREFOX', type: 'NONE', technologyType: 'WEB' }],
      recurrenceType: 'ONCE', scheduleStartDate: START, executionMode: 'local', agentId: ['agent-1'], environment: 'general', releaseId: 5, updateVersion: 0,
    });
    expect([schedules[0]!.id, schedules[0]!.schedulerType, schedules[0]!.parentId]).toEqual([11, 'TC', 35]);
    expect(ref.id).toBe('11');
    expect(ref.notes?.join(' ')).toMatch(/was a Suite schedule; it is now a Test Case schedule \(same id\)/);
    expect(ref.notes?.join(' ')).toMatch(/name is still "SU-4 schedule".*pass `name`.*TC-35/s);
  });

  test('together with a rename, the name note disappears and the new name is read back', async () => {
    const { a, schedules } = backend();
    const ref = await a.updateSchedule('11', { tcId: '35', name: 'TC-35 once' });
    expect(schedules[0]!.name).toBe('TC-35 once');
    expect(ref.name).toBe('TC-35 once');
    expect(ref.notes?.join(' ')).not.toMatch(/name is still/);
  });
});

describe('Test Case → Suite, and the checks', () => {
  test('TC → SU: the suite\'s platforms replace the browser, and the test case\'s version is dropped from the document', async () => {
    const { a, puts, schedules } = backend({ schedules: [suiteSchedule({ schedulerType: 'TC', parentId: 35, parentVersionId: '350', releaseId: 5, name: 'nightly' })] });
    const ref = await a.updateSchedule('11', { suiteId: 'SU-4' });
    expect(puts[0].body).toMatchObject({ schedulerType: 'SU', parentId: 4 });
    expect(puts[0].body.platForm.map((p: any) => p.technologyType).sort()).toEqual(['API', 'WEB']);
    expect(puts[0].body).not.toHaveProperty('parentVersionId');
    expect(schedules[0]).not.toHaveProperty('parentVersionId');
    expect(ref.notes?.join(' ')).toMatch(/was a Test Case schedule; it is now a Suite schedule/);
    expect(ref.notes?.join(' ')).not.toMatch(/name is still/);      // "nightly" is the user's own name
  });

  test('a suite schedule needs a release: refused without one, accepted with one (id, code or name)', async () => {
    const noRelease = () => backend({ schedules: [tcSchedule().id === 12 ? { ...tcSchedule(), id: 11, code: 'SH-11' } : tcSchedule()] });
    const { a, puts } = noRelease();
    await expect(a.updateSchedule('11', { suiteId: 'SU-4' })).rejects.toThrow(/needs a release/);
    expect(puts).toEqual([]);
    const ok = noRelease();
    await ok.a.updateSchedule('11', { suiteId: 'SU-4', releaseId: 'demo release' });
    expect(ok.puts[0].body).toMatchObject({ schedulerType: 'SU', parentId: 4, releaseId: 5 });
  });

  test('refused with a message: both targets, an unknown / other-project / mobile test case, an empty suite', async () => {
    await expect(backend().a.updateSchedule('11', { tcId: 'TC-35', suiteId: 'SU-4' })).rejects.toThrow(/either a test case.*or a suite/s);
    await expect(backend().a.updateSchedule('11', { tcId: 'TC-1234' })).rejects.toThrow(/Test case TC-1234 not found/);
    await expect(backend().a.updateSchedule('11', { tcId: 'TC-99' })).rejects.toThrow(/TC-99 is not in project 19/);
    await expect(backend().a.updateSchedule('11', { tcId: 'TC-40' })).rejects.toThrow(/ANDROID test case.*schedule it from SimplifyQA/);
    await expect(backend().a.updateSchedule('11', { suiteId: 'SU-7' })).rejects.toThrow(/SU-7 has no test cases/);
  });

  test('pointing it at what it already runs changes nothing and says nothing', async () => {
    const { a } = backend({ schedules: [{ ...tcSchedule(), id: 11, code: 'SH-11' }] });
    const ref = await a.updateSchedule('11', { tcId: 'TC-35' });
    expect(ref.notes).toBeUndefined();
  });

  test('a switch the backend did not apply is reported, not claimed', async () => {
    const { a } = backend({ ignoreTarget: true });
    await expect(a.updateSchedule('11', { tcId: 'TC-35' })).rejects.toThrow(/pointed at TC 35 \(TC-35\) but reads back as SU 4/);
  });
});
