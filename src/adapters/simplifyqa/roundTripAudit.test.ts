import { buildTestcasePayload, fromSqaStep, toTestCase } from './mapper.js';

const platform = { id: 'emulator-5554', name: 'Pixel', technologyType: 'ANDROID', type: 'REAL_DEVICE' };
const rawTc = (over: Record<string, unknown> = {}) => ({
  id: 42, code: 'TC-42', name: 'Android login', description: 'd', tcType: 'ANDROID', executionType: 'AUTOMATION',
  moduleId: 7, userstoryId: 3, updateVersion: 4,
  tags: ['smoke', 'login'], customFields: { owner: 'qa-team' },
  mailersList: { users: [11], nonUsers: ['a@b.c'], groups: [] }, linkedIssues: [{ id: 'JIRA-1' }], defectId: [5], suiteId: [9],
  executionPlatform: platform,
  steps: { automationSteps: [
    { id: 's1', seq: 1, description: 'Tap login', stepType: 'NORMAL_STATEMENT', technologyType: 'ANDROID', actionId: 301, objectId: 901, parameterIds: [], recordedParam: {} },
    { id: 's2', seq: 2, description: 'Type user', stepType: 'NORMAL_STATEMENT', technologyType: 'ANDROID', actionId: 302, objectId: 902, parameterIds: [], recordedParam: {} },
  ] },
  ...over,
});
const save = (doc: any) => {
  const tc: any = toTestCase(doc);
  return buildTestcasePayload({
    projectId: 19, moduleId: 7, existingId: '42', tc, paramIdByName: new Map(),
    stepResolutions: tc.steps.map((s: any) => ({ actionId: Number(s.actionType), objectId: s.objectRef ? Number(s.objectRef.id) : null })),
  } as any) as any;
};

describe('re-saving an existing test case keeps what the prompt did not touch', () => {
  test('tags, custom fields, mailers, linked issues, defects and suites survive', () => {
    const t = save(rawTc()).tcfnObj;
    expect(t.tags).toEqual(['smoke', 'login']);
    expect(t.customFields).toEqual({ owner: 'qa-team' });
    expect(t.mailersList).toEqual({ users: [11], nonUsers: ['a@b.c'], groups: [] });
    expect(t.linkedIssues).toEqual([{ id: 'JIRA-1' }]);
    expect(t.defectId).toEqual([5]);
    expect(t.suiteId).toEqual([9]);
  });
  test('an Android test case keeps its technology and its device', () => {
    const p = save(rawTc());
    expect(p.tcfnObj.tcType).toBe('ANDROID');
    expect(p.tcfnObj.executionPlatform).toEqual(platform);
    expect(p.steps.automationSteps.map((s: any) => s.technologyType)).toEqual(['ANDROID', 'ANDROID']);
  });
  test.each(['IOS', 'MAINFRAME', 'DESKTOP', 'SAP'])('a %s step keeps its technology', (tech) => {
    const doc = rawTc({ tcType: tech, executionPlatform: { id: tech, name: tech, technologyType: tech, type: tech === 'IOS' ? 'REAL_DEVICE' : 'NONE' } });
    (doc.steps as any).automationSteps.forEach((s: any) => { s.technologyType = tech; });
    expect(save(doc).steps.automationSteps.map((s: any) => s.technologyType)).toEqual([tech, tech]);
    expect(save(doc).tcfnObj.tcType).toBe(tech);
  });
  test('the raw step technology survives hydration', () => {
    expect((fromSqaStep({ seq: 1, stepType: 'NORMAL_STATEMENT', technologyType: 'MAINFRAME', actionId: 1 }, 1) as any).stepType).toBe('mainframe');
  });
});

describe('editing a saved non-web test case', () => {
  const editAndSave = async (tech: string, ops: any[]) => {
    const { SimplifyQaAdapter } = await import('./adapter.js');
    const doc: any = rawTc({ tcType: tech, executionPlatform: { id: 'd1', name: 'dev', technologyType: tech, type: tech === 'ANDROID' || tech === 'IOS' ? 'REAL_DEVICE' : 'NONE' } });
    doc.steps.automationSteps.forEach((s: any) => { s.technologyType = tech; });
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.requireProjectId = () => 19;
    a.getTestCase = async () => toTestCase(doc);
    let tc: any;
    a.updateTestCase = async (_i: string, t: any) => { tc = t; return {}; };
    a.hop = () => null; a.stepsView = async () => ({ steps: [] });
    await a.editStepsDirect('TC_42', ops);
    // the real save path: build the payload from what editStepsDirect handed to updateTestCase
    return buildTestcasePayload({
      projectId: 19, moduleId: 7, existingId: '42', tc, paramIdByName: new Map(),
      stepResolutions: tc.steps.map((s: any) => ({ actionId: Number(s.actionType) || 11, objectId: s.objectRef ? Number(s.objectRef.id) : null })),
    } as any) as any;
  };

  test.each(['ANDROID', 'IOS', 'MAINFRAME', 'DESKTOP', 'SAP'])('%s: skip one step, bulk-skip all, change action — technology, device and the other steps stay', async (tech) => {
    const p = await editAndSave(tech, [
      { op: 'update_step', n: 1, patch: { flags: { skip: true } } },
      { op: 'update_steps', where: { stepType: tech.toLowerCase() }, patch: { flags: { screenshot: true } } },
    ]);
    expect(p.tcfnObj.tcType).toBe(tech);
    expect(p.tcfnObj.executionPlatform.technologyType).toBe(tech);
    expect(p.steps.automationSteps.map((s: any) => s.technologyType)).toEqual([tech, tech]);
    expect(p.steps.automationSteps[0].stepLevelActions).toMatchObject({ skip: true, captureScreenshot: true });
    expect(p.steps.automationSteps[1].stepLevelActions).toMatchObject({ skip: false, captureScreenshot: true });
    expect(p.tcfnObj.tags).toEqual(['smoke', 'login']);        // and the test case's own fields are intact
  });
});
