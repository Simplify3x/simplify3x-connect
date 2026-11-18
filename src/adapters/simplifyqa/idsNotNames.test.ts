import { buildTestcasePayload, fromSqaStep } from './mapper.js';
import { SimplifyQaAdapter } from './adapter.js';

const fnStep = (over: Record<string, unknown> = {}) => fromSqaStep({
  id: 'f1', seq: 1, description: 'call', stepType: 'FUNCTION', actionId: null, functionId: 12, fnVersionId: 'v-old', sharedFnProjectId: 5, ...over,
}, 1);
const save = (steps: any[]) => (buildTestcasePayload({
  projectId: 19, moduleId: 7, existingId: '42',
  tc: { id: 'TC_42', title: 't', priority: 'medium', category: 'automated', technologyType: 'WEB', steps } as any,
  paramIdByName: new Map(), stepResolutions: steps.map(() => ({ actionId: null, objectId: null })),
} as any) as any).steps.automationSteps[0];

describe('a function call is saved as ids', () => {
  test('an unchanged call round-trips its ids', () => {
    const out = save([fnStep()]);
    expect(out).toMatchObject({ functionId: 12, fnVersionId: 'v-old', sharedFnProjectId: 5 });
  });
  test('"call a different function" writes the NEW id (the saved one no longer wins), with its version', () => {
    const s = fnStep();
    s.functionCall = { testCaseId: 'FN_20', versionId: 'v-new' };
    expect(save([s])).toMatchObject({ functionId: 20, fnVersionId: 'v-new' });
  });
  test('a business code is turned into its id, never dropped as NaN', () => {
    const s = fnStep({ sharedFnProjectId: undefined });
    s.functionCall = { testCaseId: 'FN-12', versionId: 'v-old' };
    expect(save([s]).functionId).toBe(12);
  });
  test('changing the function but leaving the OLD function\'s version is refused, not saved wrong', () => {
    const s = fnStep();
    s.functionCall = { testCaseId: '20' };
    expect(() => save([s])).toThrow(/changed from 12 to 20.*versionId/);
  });
  test('something that is neither an id nor a code is an error', () => {
    const s = fnStep();
    s.functionCall = { testCaseId: 'login helper', versionId: 'v' };
    expect(() => save([s])).toThrow(/not a function id or code/);
  });
});

describe('a run is linked to its release / sprint by id', () => {
  const idOrZero = (l: string, v?: string) => (Object.create(SimplifyQaAdapter.prototype) as any).idOrZero(l, v);
  test('empty → none; digits and a business code → the id', () => {
    expect(idOrZero('releaseId', undefined)).toBe(0);
    expect(idOrZero('releaseId', '')).toBe(0);
    expect(idOrZero('releaseId', '5')).toBe(5);
    expect(idOrZero('sprintId', 'SPR-12')).toBe(12);
  });
  test('a NAME is an error, not a silent 0', () => {
    expect(() => idOrZero('releaseId', 'Release 2')).toThrow(/not an id/);
    expect(() => idOrZero('sprintId', 'Sprint One')).toThrow(/Pass the numeric id/);
  });
});

describe('a run\'s environment is resolved to the stored key', () => {
  const run = (envs: any[] | Error, requested?: string) => {
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.requireProjectId = () => 19;
    a.http = { getJson: async () => { if (envs instanceof Error) throw envs; return envs; } };
    return a.resolveEnvironment(19, requested);
  };
  const envs = [{ key: 'general', name: 'General' }, { key: 'stg_01', name: 'Staging' }];
  test('a name or key (any case) resolves to the key', async () => {
    expect(await run(envs, 'Staging')).toBe('stg_01');
    expect(await run(envs, 'STG_01')).toBe('stg_01');
    expect(await run(envs, 'general')).toBe('general');
  });
  test('an unknown environment is refused with the valid ones', async () => {
    await expect(run(envs, 'prod')).rejects.toThrow(/does not exist.*General.*Staging \(key stg_01\)/);
  });
  test('if the list cannot be read, or is empty, the value is used as before', async () => {
    expect(await run(new Error('boom'), 'whatever')).toBe('whatever');
    expect(await run([], 'whatever')).toBe('whatever');
  });
  test('no environment requested → the first one, as before', async () => {
    expect(await run(envs, undefined)).toBe('general');
  });
});
