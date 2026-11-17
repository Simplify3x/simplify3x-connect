import { applyHealPlan, type HealApplyDeps } from './apply.js';
import { buildHealPlan, type HealFacts } from './plan.js';
import type { HealProposal } from '../../../domain/heal.js';
import type { Step, TestCase } from '../../../domain/types.js';

const tc = (): TestCase => ({
  id: '123',
  title: 'login flow',
  category: 'automated',
  currentVersionId: 'v1',
  steps: [
    { n: 1, description: 'open the app', actionType: 'launchApplication', stepType: 'web' },
    {
      n: 2,
      description: 'sign in with ${oldName}',
      actionType: 'click',
      stepType: 'web',
      objectRef: { id: '8812' },
      actionUniqueId: 'web-1',
    },
  ],
});

const facts = (): HealFacts => ({
  tcId: 'TC-123',
  currentVersionId: 'v1',
  steps: [
    { n: 1, actionType: 'launchApplication', description: 'open the app' },
    { n: 2, actionType: 'click', description: 'sign in with ${oldName}', objectId: '8812' },
  ],
  objects: { '8812': { id: '8812', locators: [{ name: 'css', value: '#old', unique: true }] } },
  actionNames: ['click', 'enterText', 'selectItem', 'launchApplication'],
  failingIterations: [2],
});

const proposals: HealProposal[] = [
  { domain: 'object', op: 'append_locator', objectId: '8812', step: 2, locator: { name: 'css', value: '#new', unique: true } },
  { domain: 'action', op: 'repoint_action', step: 2, actionType: 'selectItem' },
  { domain: 'parameter', op: 'rebind', name: 'newName', fromToken: 'oldName' },
  { domain: 'testdata', op: 'set_cell', paramName: 'newName', iterations: [2], value: 'Taks_new' },
];

function makeDeps(over: Partial<HealApplyDeps> = {}): { deps: HealApplyDeps; calls: string[]; saved: { steps?: Step[] | undefined } } {
  const calls: string[] = [];
  const saved: { steps?: Step[] | undefined } = {};
  const deps: HealApplyDeps = {
    getTestCase: async () => tc(),
    getObject: async () => ({ id: '8812', name: 'login button', locators: [{ name: 'css', value: '#old', unique: true }] }),
    updateObject: async () => {
      calls.push('object');
      return {};
    },
    saveAsNewVersion: async (_id, opts) => {
      calls.push('version');
      saved.steps = opts.tc?.steps;
      return { id: '123', created: false, artifacts: ['versionId=v2'] };
    },
    patchTestDataCells: async (input) => {
      calls.push(`testdata:${input.updates.map((u) => u.iterations.join(',')).join('|')}`);
      return { patched: 1, skipped: [] };
    },
    ...over,
  };
  return { deps, calls, saved };
}

function plan(over: Partial<HealFacts> = {}) {
  return buildHealPlan({
    tcId: 'TC-123',
    runId: '42447',
    diagnosis: { family: 'param_binding', confidence: 0.8 },
    proposals,
    facts: { ...facts(), ...over },
  });
}

describe('heal apply', () => {
  test('writes objects, ONE new version, then the failing iteration only', async () => {
    const { deps, calls, saved } = makeDeps();
    const report = await applyHealPlan(deps, plan());

    expect(calls[0]).toBe('object');
    expect(calls[1]).toBe('version');
    expect(calls[2]).toBe('testdata:2');
    expect(report.versionId).toBe('v2');
    expect(report.partial).toBeUndefined();
    expect(report.applied.map((c) => c.domain).sort()).toEqual(['action', 'object', 'parameter', 'testdata']);

    const patched = saved.steps?.find((s) => s.n === 2);
    expect(patched?.actionType).toBe('selectItem');
    expect(patched?.actionUniqueId).toBeUndefined();
    expect(patched?.description).toBe('sign in with ${newName}');
  });

  test('refuses a stale plan (test case moved to another version)', async () => {
    const { deps } = makeDeps({ getTestCase: async () => ({ ...tc(), currentVersionId: 'v9' }) });
    await expect(applyHealPlan(deps, plan())).rejects.toThrow(/stale/);
  });

  test('a failed version save leaves no test-data write and reports partial', async () => {
    const { deps, calls } = makeDeps({
      saveAsNewVersion: async () => {
        calls.push('version');
        throw new Error('backend rejected SAVENEWVERSION');
      },
    });
    const report = await applyHealPlan(deps, plan());

    expect(calls).not.toContain('testdata:2');
    expect(report.partial).toBe(true);
    expect(report.versionId).toBeUndefined();
    expect(report.error).toMatch(/SAVENEWVERSION/);
  });

  test('a test-data failure after the version keeps the version and marks partial', async () => {
    const { deps } = makeDeps({
      patchTestDataCells: async () => {
        throw new Error('iteration locked');
      },
    });
    const report = await applyHealPlan(deps, plan());
    expect(report.versionId).toBe('v2');
    expect(report.partial).toBe(true);
    expect(report.error).toMatch(/test data patch failed/);
  });

  test('a DATABASE action repoint keeps its uniqueId (overload is not lost)', async () => {
    const dbTc: TestCase = {
      id: '321', title: 'db flow', category: 'automated', currentVersionId: 'v1',
      steps: [{ n: 1, description: 'read the db', actionType: 'executeQuery', stepType: 'database', technologyType: 'DATABASE' }],
    };
    const { deps, saved } = makeDeps({ getTestCase: async () => dbTc });
    const p = buildHealPlan({
      tcId: 'TC-321',
      diagnosis: { family: 'action_mismatch', confidence: 0.7 },
      proposals: [{ domain: 'action', op: 'repoint_action', step: 1, actionType: 'updateQuery', actionUniqueId: 'db-3' }],
      facts: {
        tcId: 'TC-321', currentVersionId: 'v1', objects: {},
        steps: [{ n: 1, actionType: 'executeQuery', description: 'read the db', stepType: 'database', technologyType: 'DATABASE' }],
        actionNames: ['executequery', 'updatequery'],
        actionNamesByTech: { DATABASE: ['executequery', 'updatequery'] },
        actionUniqueIds: ['db-2', 'db-3'],
      },
    });
    await applyHealPlan(deps, p);
    expect(saved.steps?.[0]?.actionUniqueId).toBe('db-3');
    expect(saved.steps?.[0]?.actionType).toBe('updateQuery');
  });

  test('nothing to apply when the plan has no changes', async () => {
    const { deps, calls } = makeDeps();
    const empty = buildHealPlan({
      tcId: 'TC-123',
      diagnosis: { family: 'app_bug', confidence: 0.9 },
      proposals,
      facts: facts(),
    });
    const report = await applyHealPlan(deps, empty);
    expect(calls).toHaveLength(0);
    expect(report.applied).toHaveLength(0);
    expect(report.skipped.some((s) => s.reason.includes('not healable'))).toBe(true);
  });
});
