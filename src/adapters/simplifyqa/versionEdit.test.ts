import { SimplifyQaAdapter } from './adapter.js';

/**
 * A test case with two versions: journal_grep / journal_modify must be able to read and edit v2.0 — not only
 * the current v1.0 — and the save must carry v2.0's version id (so the backend updates v2.0's row and steps).
 * Driven through the REAL editJournal → editStepsDirect → updateTestCase → buildTestcasePayload.
 */
const V1 = 'ver-1';
const V2 = 'ver-2';
const stepsOf = (v: string) => Array.from({ length: v === V2 ? 3 : 2 }, (_, i) => ({
  n: i + 1, stepType: 'normal', actionType: 'click', description: `${v} step ${i + 1}`, sourceId: `${v}-s${i + 1}`,
}));

function fake() {
  const puts: any[] = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.requireProjectId = () => 19;
  a.hop = () => undefined;
  a.fetchRawTestcase = async () => ({ id: 12826, versions: [{ id: V1, name: 'v1.0' }, { id: V2, name: 'v2.0' }] });
  a.getTestCase = async (_id: string, versionId?: string) => {
    const cur = versionId ?? V1;
    return {
      id: '12826', title: 'TC 12826', category: 'manual', steps: stepsOf(cur), currentVersionId: cur,
      versions: [{ id: V1, name: 'v1.0', isCurrent: cur === V1 }, { id: V2, name: 'v2.0', isCurrent: cur === V2 }],
    };
  };
  a.pinFunctionCalls = async () => undefined;
  a.resolveFunctionTechnologies = async () => undefined;
  a.resolveModuleId = async () => 3;
  a.resolveParamIds = async () => new Map();
  a.appendRemovedSteps = async () => undefined;
  a.http = { putMultipart: async (_p: string, _k: string, payload: any) => { puts.push(payload); return { data: { id: 12826 } }; } };
  return { a, puts };
}

describe('journal read/edit on a chosen version', () => {
  test('reads v2.0 by name, with its own steps and the version named', async () => {
    const { a } = fake();
    const view = await a.readJournal('TC-12826', 'v2.0');
    expect(view.steps.map((s: any) => s.description)).toEqual(['ver-2 step 1', 'ver-2 step 2', 'ver-2 step 3']);
    expect([view.version, view.versionCount]).toEqual([{ id: V2, name: 'v2.0' }, 2]);
  });

  test('an edit with versionId saves against v2.0 (versionsDetails.id, step versionId) with v2.0\'s steps', async () => {
    const { a, puts } = fake();
    const view = await a.editJournal('TC-12826', [{ op: 'update_step', n: 3, patch: { description: 'edited' } }], V2);
    expect(puts).toHaveLength(1);
    expect(puts[0].versionsDetails).toMatchObject({ id: V2, name: 'v2.0' });
    const sent = puts[0].steps.manualSteps;
    expect(sent.map((s: any) => [s.id, s.versionId, s.description])).toEqual([
      ['ver-2-s1', V2, 'ver-2 step 1'], ['ver-2-s2', V2, 'ver-2 step 2'], ['ver-2-s3', V2, 'edited'],
    ]);
    expect(view.version).toEqual({ id: V2, name: 'v2.0' });
  });

  test('without versionId the CURRENT version is edited exactly as before', async () => {
    const { a, puts } = fake();
    const view = await a.editJournal('TC-12826', [{ op: 'update_step', n: 1, patch: { description: 'edited' } }]);
    expect(puts[0].versionsDetails.id).toBe(V1);
    expect(puts[0].steps.manualSteps).toHaveLength(2);
    expect(view.version).toEqual({ id: V1, name: 'v1.0' });
  });

  test('an unknown version is refused with the list and nothing is written; agent-only ops are refused on a chosen version', async () => {
    const { a, puts } = fake();
    await expect(a.editJournal('TC-12826', [{ op: 'remove_step', n: 1 }], 'v9.9')).rejects.toThrow(/no version "v9.9".*v1\.0.*v2\.0/s);
    await expect(a.editJournal('TC-12826', [{ op: 'wrap_in_if', from: 1, to: 2 }], 'v2.0')).rejects.toThrow(/needs the agent/);
    expect(puts).toEqual([]);
  });
});
