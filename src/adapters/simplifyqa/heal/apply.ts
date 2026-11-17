/**
 * Applies a validated `HealPlan` as ONE new test-case version:
 *
 *   objects (append locator / set default / properties)
 *     → step patches (action repoint, parameter token rebind)
 *     → PUT /tm/testcase  operation=SAVENEWVERSION, verData.tdCopy=true   ← the atomic point
 *     → test-data patch for the FAILING iterations only
 *     → optional verify run
 *
 * Nothing here mutates the shared action catalog, renames a shared parameter, or touches the
 * version an in-flight run is executing.
 */
import type { QaObject, SavedRef, Step, TestCase } from '../../../domain/types.js';
import type { HealChange, HealPlan, HealReport } from '../../../domain/heal.js';
import { HEAL_CONTRACT_VERSION, type HealApplyMode } from '../../../domain/heal.js';

export type HealTestDataPatch = {
  tcId: string;
  versionId: string;
  environmentType: string;
  updates: Array<{ paramName: string; iterations: number[]; value: string }>;
};

export type HealVerifyResult = { verified: boolean; runId?: string | undefined; reason?: string | undefined };

export type HealApplyDeps = {
  getTestCase(tcId: string): Promise<TestCase>;
  getObject(id: string): Promise<QaObject>;
  updateObject(
    id: string,
    changes: {
      name?: string;
      description?: string;
      locators?: Array<{ name: string; value: string; unique?: boolean | undefined }>;
      parameterNames?: string[];
      defaultLocator?: string;
    },
  ): Promise<unknown>;
  saveAsNewVersion(
    tcId: string,
    opts: { versionName: string; tdCopy?: boolean; tc?: TestCase },
  ): Promise<SavedRef>;
  patchTestDataCells(input: HealTestDataPatch): Promise<{ patched: number; skipped: string[] }>;
  verify?: ((tcId: string, plan: HealPlan) => Promise<HealVerifyResult>) | undefined;
};

function nowIso(): string {
  return new Date().toISOString();
}

function versionIdOf(saved: SavedRef): string | undefined {
  const hit = (saved.artifacts ?? []).find((a) => a.startsWith('versionId='));
  return hit ? hit.slice('versionId='.length) : undefined;
}

function groupObjectChanges(changes: HealChange[]): Map<string, HealChange[]> {
  const byObject = new Map<string, HealChange[]>();
  for (const c of changes) {
    if (c.domain !== 'object') continue;
    const id = String(c.detail['objectId']);
    const list = byObject.get(id) ?? [];
    list.push(c);
    byObject.set(id, list);
  }
  return byObject;
}

/** Apply every object change for one object with a SINGLE PUT (merged, append-only locators). */
async function applyObjectChanges(deps: HealApplyDeps, objectId: string, changes: HealChange[]): Promise<void> {
  const locators: Array<{ name: string; value: string; unique?: boolean | undefined }> = [];
  let defaultLocator: string | undefined;
  const property: { name?: string; description?: string; parameterNames?: string[] } = {};

  for (const c of changes) {
    if (c.op === 'append_locator') {
      const loc = c.detail['locator'] as { name: string; value: string; unique?: boolean | undefined };
      locators.push(loc);
      if (loc.unique === true) defaultLocator = loc.name;
    } else if (c.op === 'set_default') {
      defaultLocator = String(c.detail['locatorName']);
    } else if (c.op === 'update_property') {
      const prop = c.detail['property'] as { name?: string; description?: string; parameterNames?: string[] };
      if (prop.name !== undefined) property.name = prop.name;
      if (prop.description !== undefined) property.description = prop.description;
      if (prop.parameterNames !== undefined) property.parameterNames = prop.parameterNames;
    }
  }

  await deps.updateObject(objectId, {
    ...(locators.length ? { locators } : {}),
    ...(defaultLocator ? { defaultLocator } : {}),
    ...property,
  });
}

function patchSteps(tc: TestCase, changes: HealChange[]): Step[] {
  const steps: Step[] = (tc.steps ?? []).map((s) => ({ ...s }));

  for (const c of changes) {
    if (c.domain === 'action') {
      const n = Number(c.detail['step']);
      const step = steps.find((s) => s.n === n);
      if (!step) throw new Error(`plan references step ${n}, which no longer exists on ${tc.id ?? tc.title}`);
      step.actionType = String(c.detail['actionType']);
      const uniq = c.detail['actionUniqueId'];
      const tech = (step.technologyType ?? '').toUpperCase();
      if (typeof uniq === 'string' && uniq.trim()) {
        // DATABASE (and any plugin whose names collide) is addressed by its uniqueId — keep it.
        step.actionUniqueId = uniq.trim();
      } else if (tech === 'DATABASE') {
        throw new Error(
          `step ${n} is a DATABASE step — changing its action needs an actionUniqueId (e.g. "db-2"); ` +
            'the action name alone is ambiguous.',
        );
      } else {
        // A recorded step pins its action by plugin uniqueId; leaving it would silently keep the OLD
        // action on save (see adapter.editStepsDirect).
        delete step.actionUniqueId;
      }
    }
  }

  for (const c of changes) {
    if (c.domain === 'parameter' && c.op === 'rebind') {
      const from = `\${${String(c.detail['fromToken'])}}`;
      const to = `\${${String(c.detail['name'])}}`;
      for (const step of steps) {
        if (step.description.includes(from)) step.description = step.description.split(from).join(to);
        if (step.value?.includes(from)) step.value = step.value.split(from).join(to);
        if (step.expectedResult?.includes(from)) step.expectedResult = step.expectedResult.split(from).join(to);
      }
    }
  }

  return steps;
}

export async function applyHealPlan(
  deps: HealApplyDeps,
  plan: HealPlan,
  opts: { mode?: HealApplyMode | undefined } = {},
): Promise<HealReport> {
  const mode: HealApplyMode = opts.mode ?? 'apply';
  const report: HealReport = {
    contractVersion: HEAL_CONTRACT_VERSION,
    planId: plan.planId,
    tcId: plan.tcId,
    mode,
    applied: [],
    skipped: [...plan.skipped],
    createdAt: nowIso(),
  };

  if (!plan.changes.length) {
    report.skipped.push({
      reason: plan.diagnosis.healable ? 'plan has no applicable changes' : `not healable: ${plan.diagnosis.family}`,
    });
    return report;
  }

  const tc = await deps.getTestCase(plan.tcId);
  if (plan.baseVersionId && tc.currentVersionId && tc.currentVersionId !== plan.baseVersionId) {
    throw new Error(
      `heal plan is stale: it was built against version ${plan.baseVersionId}, but ${plan.tcId} is now on ${tc.currentVersionId}. ` +
        'Re-run heal_plan (the failure may already be fixed, or the test case changed).',
    );
  }

  // --- objects (shared library) -------------------------------------------------------------
  const objects = groupObjectChanges(plan.changes);
  const defaultBefore = new Map<string, string | undefined>();
  for (const [objectId, changes] of objects) {
    const before = await deps.getObject(objectId);
    defaultBefore.set(objectId, (before.locators ?? []).find((l) => l.unique === true)?.name);
    await applyObjectChanges(deps, objectId, changes);
    report.applied.push(...changes);
  }

  // --- one new version ----------------------------------------------------------------------
  let saved: SavedRef;
  try {
    saved = await deps.saveAsNewVersion(plan.tcId, {
      versionName: `healed-${plan.planId.slice(0, 8)}`,
      tdCopy: true,
      tc: { ...tc, steps: patchSteps(tc, plan.changes) },
    });
  } catch (e) {
    // The version never landed: put each object's default locator back so the shared library is
    // not left pointing at a fix that no test case uses.
    for (const [objectId, defaultLocator] of defaultBefore) {
      if (!defaultLocator) continue;
      try {
        await deps.updateObject(objectId, { defaultLocator });
      } catch {
        /* best effort */
      }
    }
    report.error = e instanceof Error ? e.message : String(e);
    report.partial = true;
    return report;
  }

  if (saved.productUrl) report.productUrl = saved.productUrl;
  const versionId = versionIdOf(saved);
  if (versionId) report.versionId = versionId;

  for (const c of plan.changes) {
    if (c.domain !== 'object') report.applied.push(c);
  }

  // --- test data: failing iterations only ---------------------------------------------------
  const dataUpdates = plan.changes
    .filter((c) => c.domain === 'testdata')
    .map((c) => ({
      paramName: String(c.detail['paramName']),
      iterations: (c.detail['iterations'] as number[]) ?? [],
      value: String(c.detail['value'] ?? ''),
    }));

  if (dataUpdates.length) {
    if (!versionId) {
      report.partial = true;
      report.skipped.push({ domain: 'testdata', reason: 'no versionId returned by the backend — test data was not patched' });
    } else {
      try {
        const res = await deps.patchTestDataCells({ tcId: plan.tcId, versionId, environmentType: 'general', updates: dataUpdates });
        if (res.skipped.length) {
          report.partial = true;
          for (const reason of res.skipped) report.skipped.push({ domain: 'testdata', reason });
        }
      } catch (e) {
        report.partial = true;
        report.error = `test data patch failed after the version was saved: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }

  // --- verify -------------------------------------------------------------------------------
  if (mode === 'apply_and_verify') {
    if (!deps.verify) {
      report.partial = true;
      report.skipped.push({ reason: 'verification is not available for this provider' });
    } else {
      try {
        const v = await deps.verify(plan.tcId, plan);
        report.verified = v.verified;
        if (v.runId) report.runId = v.runId;
        if (!v.verified) {
          report.partial = true;
          report.skipped.push({ reason: v.reason ?? 'verification run did not pass the healed step' });
        }
      } catch (e) {
        report.partial = true;
        report.error = `verification failed to run: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }

  return report;
}
