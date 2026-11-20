import { SimplifyQaAdapter, assertPlannedDates } from './adapter.js';

describe('planned date ordering', () => {
  test('end before start is refused (the SQA web form blocks it, the backend does not)', () => {
    expect(() => assertPlannedDates('2026-12-10', '2026-12-01')).toThrow(/must be after/);
  });

  test('a later end date is allowed', () => {
    expect(() => assertPlannedDates('2026-12-01', '2026-12-10')).not.toThrow();
    expect(() => assertPlannedDates('2026-12-01T10:00:00Z', '2026-12-02T09:00:00Z')).not.toThrow();
  });

  test('the same day is refused (the end must be AFTER the start)', () => {
    expect(() => assertPlannedDates('2026-12-01', '2026-12-01')).toThrow(/must be after/);
  });

  test('one missing date is not an ordering error (partial updates)', () => {
    expect(() => assertPlannedDates('2026-12-01', undefined)).not.toThrow();
    expect(() => assertPlannedDates(undefined, '2026-12-01')).not.toThrow();
  });

  test('a malformed date is refused', () => {
    expect(() => assertPlannedDates('10-12-2026', '2026-12-11')).toThrow(/must look like 2026-12-10/);
  });

  test('createStory refuses the bad pair before any write', async () => {
    const posts: any[] = [];
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.getBacklogDefaults = async () => ({ state: 'New', priority: 'High' });
    a.requireProjectId = () => 1;
    a.http = { postJson: async (p: string, b: any) => { posts.push({ p, b }); return { id: 1 }; } };
    await expect(a.createStory({ name: 'Story', estimatedEffort: 1, plannedStartDate: '2026-12-10', plannedEndDate: '2026-12-01' }))
      .rejects.toThrow(/Planned end date \(2026-12-01\) must be after/);
    expect(posts).toHaveLength(0);
    await a.createStory({ name: 'Story', estimatedEffort: 1, plannedStartDate: '2026-12-01', plannedEndDate: '2026-12-10' });
    expect(posts).toHaveLength(1);
  });

  test('updateStory refuses the bad pair before any write', async () => {
    const puts: any[] = [];
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.requireProjectId = () => 1;
    a.resolveStoryNumericId = async (id: string) => id;
    a.http = { putJson: async (p: string, b: any) => { puts.push({ p, b }); return { id: 1 }; } };
    await expect(a.updateStory('77', { plannedStartDate: '2026-12-10', plannedEndDate: '2026-12-01' }))
      .rejects.toThrow(/must be after/);
    expect(puts).toHaveLength(0);
  });
});
