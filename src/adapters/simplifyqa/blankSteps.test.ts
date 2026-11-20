import { SimplifyQaAdapter } from './adapter.js';
import { buildTestcasePayload, isBlankStep, withoutBlankSteps } from './mapper.js';

/**
 * DE-2320 — a 1-step recording saved through the MCP showed 2 steps in the UI.
 * The test-case editor seeds a NEW test case with one blank placeholder row; a save that carries
 * it stores a phantom step. These tests pin the guard: a blank row is never written, never
 * re-saved, and (for the recorder window's own Save) deleted afterwards.
 */
describe('blank placeholder steps', () => {
  // What the editor seeds: no text, no action, no object, no data.
  const editorPlaceholder = {
    seq: 1, description: '', expectedResult: '', actionId: null, objectId: null,
    stepType: 'NORMAL_STATEMENT', technologyType: 'WEB', parameterIds: [], objectParameterIds: [],
    conditions: { ifstring: '', children: [] }, loop: { loopType: 'for', loopIteration: null },
    recordedParam: {}, stepLevelActions: { skip: false },
  };

  test('the editor placeholder is recognised as blank', () => {
    expect(isBlankStep(editorPlaceholder)).toBe(true);
    expect(isBlankStep({ description: '   ', stepType: 'web' })).toBe(true);
    expect(isBlankStep({ n: 1 })).toBe(true);
  });

  test('real and structural steps are never blank', () => {
    // real action step
    expect(isBlankStep({ description: 'Click the logo', actionType: 'Click', stepType: 'web' })).toBe(false);
    expect(isBlankStep({ description: '', actionId: 184, stepType: 'NORMAL_STATEMENT' })).toBe(false);
    expect(isBlankStep({ description: 'Go to URL', actionType: 'Go to URL', objectRef: { id: '1' } })).toBe(false);
    // manual step with only an expected result
    expect(isBlankStep({ description: '', expectedResult: 'It opens', stepType: 'manual' })).toBe(false);
    // API / function / control-flow / switch rows legitimately have no description
    expect(isBlankStep({ stepType: 'API', description: '', api: { method: 'GET' } })).toBe(false);
    expect(isBlankStep({ stepType: 'API', description: '', apiData: { method: 'GET' } })).toBe(false);
    expect(isBlankStep({ stepType: 'FUNCTION', description: '', functionCall: { testCaseId: 'FN_1' } })).toBe(false);
    expect(isBlankStep({ stepType: 'IF_END', description: '' })).toBe(false);
    expect(isBlankStep({ stepType: 'SWITCH_TO_WEB', description: '' })).toBe(false);
    // a value without a description still carries work
    expect(isBlankStep({ description: '', stepType: 'web', value: '5' })).toBe(false);
    // an already-deleted row is not a candidate
    expect(isBlankStep({ ...editorPlaceholder, deleted: true })).toBe(false);
  });

  test('withoutBlankSteps drops placeholders and keeps a save with only real steps intact', () => {
    const kept = { n: 1, description: 'Click', actionType: 'Click', stepType: 'web' as const };
    const out = withoutBlankSteps({ title: 't', category: 'automated' as const, steps: [editorPlaceholder as never, kept] });
    expect(out.steps).toHaveLength(1);
    expect(out.steps?.[0]).toEqual(kept);
    // all blanks → untouched (the caller's validation / message must still fire)
    const allBlank = withoutBlankSteps({ title: 't', category: 'automated' as const, steps: [editorPlaceholder as never] });
    expect(allBlank.steps).toHaveLength(1);
  });

  test('a MANUAL save never writes the placeholder row', async () => {
    let payload: any;
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.requireProjectId = () => 1;
    a.pinFunctionCalls = async () => {};
    a.resolveFunctionTechnologies = async () => {};
    a.resolveModuleId = async () => 1;
    a.resolveStoryNumericIdOrNull = async () => undefined;
    a.resolveParamIds = async () => new Map();
    a.http = { postMultipart: async (_p: string, _f: string, body: any) => { payload = body; return { id: 7 }; } };
    await a.createTestCase({
      title: 'Manual with placeholder', category: 'manual',
      steps: [editorPlaceholder as never, { n: 2, description: 'Open the page', expectedResult: 'Page opens', actionType: 'manual', stepType: 'manual' }],
    });
    expect(payload.steps.manualSteps).toHaveLength(1);
    expect(payload.steps.manualSteps[0].description).toBe('Open the page');
  });

  test('dropEmptySteps deletes the stored placeholder and reports the real count', async () => {
    const update = jest.fn(async (id: string) => ({ id, created: false }));
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.fetchRawTestcase = async () => ({ id: 42 });
    a.fetchStepsCollection = jest.fn()
      .mockResolvedValueOnce([
        { id: 's1', seq: 1, description: 'Click the logo', actionId: 184, stepType: 'NORMAL_STATEMENT', deleted: false },
        { id: 's2', seq: 2, description: '', actionId: null, objectId: null, stepType: 'NORMAL_STATEMENT', deleted: false },
      ])
      .mockResolvedValueOnce([{ id: 's1', seq: 1, description: 'Click the logo', actionId: 184, deleted: false }]);
    a.getTestCase = async () => ({
      id: '42', title: 'Probe', category: 'automated',
      steps: [
        { n: 1, description: 'Click the logo', actionType: 'Click', stepType: 'web', sourceId: 's1' },
        { n: 2, description: '', actionType: '', stepType: 'web', sourceId: 's2' },
      ],
    });
    a.updateTestCase = update;
    const r = await a.dropEmptySteps('42');
    expect(r).toEqual({ removed: 1, removedSeqs: [2], stepCount: 1 });
    expect(update).toHaveBeenCalledTimes(1);
    expect((update.mock.calls[0] as any)[1].steps).toHaveLength(1);
  });

  test('dropEmptySteps does nothing when the test case has no blanks', async () => {
    const update = jest.fn();
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.fetchRawTestcase = async () => ({ id: 42 });
    a.fetchStepsCollection = jest.fn(async () => [
      { id: 's1', seq: 1, description: 'Click the logo', actionId: 184, stepType: 'NORMAL_STATEMENT', deleted: false },
    ]);
    a.updateTestCase = update;
    const r = await a.dropEmptySteps('42');
    expect(r).toEqual({ removed: 0, removedSeqs: [], stepCount: 1 });
    expect(update).not.toHaveBeenCalled();
  });

  test('the assembled automation payload numbers the steps 1..N after the placeholder is gone', () => {
    const payload = buildTestcasePayload({
      projectId: 1, moduleId: 1,
      tc: {
        title: 'Probe', category: 'automated',
        steps: [
          { n: 1, description: 'Go to URL', actionType: 'Go to URL', stepType: 'web' },
          { n: 2, description: 'Click', actionType: 'Click', stepType: 'web' },
        ],
      } as never,
      paramIdByName: new Map(),
      paramAccessById: new Map(),
      stepResolutions: [
        { actionId: 153, objectId: null },
        { actionId: 184, objectId: 198 },
      ],
    }) as any;
    expect(payload.steps.automationSteps.map((s: any) => s.seq)).toEqual([1, 2]);
  });
});
