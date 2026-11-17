/**
 * Pure planner: validate the product's proposals against live facts, drop the ones that cannot be
 * resolved, and emit a deterministic, ordered change-set. No I/O — everything it needs is passed in
 * (`HealFacts`), which is what makes the plan testable and makes dry-run and apply identical.
 */
import {
  HEAL_APPLY_ORDER,
  HEAL_CONTRACT_VERSION,
  isHealable,
  planIdFor,
  type HealChange,
  type HealDiagnosis,
  type HealDomain,
  type HealPlan,
  type HealProposal,
  type HealSkip,
  type ObjectUsage,
} from '../../../domain/heal.js';

export type HealStepFact = {
  n: number;
  actionType: string;
  description: string;
  stepType?: string | undefined;
  /** Backend technology of this step (WEB / API / DATABASE / ANDROID / IOS / …). */
  technologyType?: string | undefined;
  /** Object template of the step's object — the precise scope actions are registered under. */
  objectTemplateId?: string | undefined;
  /** Object template the step's CURRENT action belongs to (mismatch ⇒ the editor shows no action). */
  actionObjectTemplateId?: string | undefined;
  /** True when the step's current action is a plugin `@Deprecated` row. */
  actionDeprecated?: boolean | undefined;
  /** Plugin uniqueId currently pinned on the step (DATABASE overloads), when known. */
  actionUniqueId?: string | undefined;
  objectId?: string | undefined;
  /** True only for a real API REQUEST step (has an api/apiData payload). An API-technology step with
   *  a generic action (e.g. "Store from JSON") is false: it DOES have an action to heal. */
  isApiRequest?: boolean | undefined;
};

export type HealObjectFact = {
  id: string;
  objectTemplateId?: string | undefined;
  locators: Array<{ name: string; value: string; unique?: boolean | undefined }>;
};

export type HealFacts = {
  tcId: string;
  currentVersionId?: string | undefined;
  steps: HealStepFact[];
  objects: Record<string, HealObjectFact | undefined>;
  /** Action names exactly as the catalog reports them (case-insensitive matching). */
  actionNames: string[];
  /** Per-technology action names, lowercased — action names are NOT unique across technologies. */
  actionNamesByTech?: Record<string, string[]> | undefined;
  /** Per-object-template action names, lowercased (template id → names). More precise than tech. */
  actionNamesByTemplate?: Record<string, string[]> | undefined;
  /** Plugin uniqueIds ("db-2", …) — the only collision-free way to pick a DATABASE action. */
  actionUniqueIds?: string[] | undefined;
  /** `itr` numbers of the run that failed — the ONLY iterations test data may be patched on. */
  failingIterations?: number[] | undefined;
  /** Best-effort "which other test cases use this object" (bounded scan). */
  usingTestcasesByObject?: Record<string, string[] | undefined> | undefined;
  usageScanned?: number | undefined;
  usageTruncated?: boolean | undefined;
};

export type BuildHealPlanInput = {
  tcId: string;
  runId?: string | undefined;
  diagnosis: HealDiagnosis;
  proposals: HealProposal[];
  facts: HealFacts;
  /** Restrict to these domains (default: all healable domains). */
  domains?: HealDomain[] | undefined;
  now?: Date | undefined;
};

const PARAM_NAME = /^[A-Za-z0-9 _.\-()]+$/;

function skip(skipped: HealSkip[], reason: string, p?: HealProposal): void {
  const entry: HealSkip = { reason };
  if (p) {
    entry.domain = p.domain;
    entry.op = p.op;
    if ('objectId' in p) entry.target = p.objectId;
    else if ('step' in p && typeof p.step === 'number') entry.target = `step ${p.step}`;
    else if ('name' in p) entry.target = p.name;
    else if ('paramName' in p) entry.target = p.paramName;
  }
  skipped.push(entry);
}

export function buildHealPlan(input: BuildHealPlanInput): HealPlan {
  const { diagnosis, facts } = input;
  const skipped: HealSkip[] = [];
  const stepsByN = new Map(facts.steps.map((s) => [s.n, s]));
  const actionNames = new Set(facts.actionNames.map((a) => a.trim().toLowerCase()));
  const allowedDomains = new Set<HealDomain>(input.domains ?? HEAL_APPLY_ORDER);
  const changes: HealChange[] = [];
  const seen = new Set<string>();

  const familyHealable = isHealable(diagnosis.family);

  // Names of locators per object AFTER earlier proposals in this same plan — lets `set_default`
  // refer to a locator that `append_locator` adds a few lines above.
  const locatorNames = new Map<string, Set<string>>();
  const namesFor = (objectId: string): Set<string> => {
    let set = locatorNames.get(objectId);
    if (!set) {
      set = new Set((facts.objects[objectId]?.locators ?? []).map((l) => l.name));
      locatorNames.set(objectId, set);
    }
    return set;
  };

  if (familyHealable) {
    for (const p of input.proposals) {
      if (!allowedDomains.has(p.domain)) {
        skip(skipped, `domain "${p.domain}" was not requested for this heal`, p);
        continue;
      }

      const key = `${p.domain}|${p.op}|${JSON.stringify(p)}`;
      if (seen.has(key)) {
        skip(skipped, 'duplicate proposal', p);
        continue;
      }
      seen.add(key);

      if (p.domain === 'object') {
        const object = facts.objects[p.objectId];
        if (!object) {
          skip(skipped, `object ${p.objectId} was not found in this project`, p);
          continue;
        }
        if (p.step !== undefined) {
          const step = stepsByN.get(p.step);
          if (!step) {
            skip(skipped, `step ${p.step} does not exist on ${facts.tcId}`, p);
            continue;
          }
          if (step.objectId !== p.objectId) {
            skip(skipped, `step ${p.step} uses object ${step.objectId ?? '(none)'}, not ${p.objectId}`, p);
            continue;
          }
        }
        if (p.op === 'append_locator') {
          const name = p.locator.name?.trim();
          const value = p.locator.value?.trim();
          if (!name || !value) {
            skip(skipped, 'locator needs a non-empty name and value', p);
            continue;
          }
          const existing = object.locators.find((l) => l.name === name);
          if (existing && existing.value === value) {
            skip(skipped, `object ${p.objectId} already has ${name}="${value}"`, p);
            continue;
          }
          namesFor(p.objectId).add(name);
          changes.push({
            domain: 'object',
            op: p.op,
            target: `object ${p.objectId}`,
            detail: { objectId: p.objectId, locator: { name, value, ...(p.locator.unique === true ? { unique: true } : {}) } },
            ...(existing ? { before: { name: existing.name, value: existing.value } } : {}),
            ...(p.reason ? { reason: p.reason } : {}),
            ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
          });
          continue;
        }
        if (p.op === 'set_default') {
          const wanted = p.locatorName?.trim();
          if (!wanted) {
            skip(skipped, 'set_default needs a locatorName', p);
            continue;
          }
          const has = [...namesFor(p.objectId)].some((n) => n.toLowerCase() === wanted.toLowerCase());
          if (!has) {
            skip(skipped, `object ${p.objectId} has no locator "${wanted}" (not even after this plan's additions)`, p);
            continue;
          }
          changes.push({
            domain: 'object',
            op: p.op,
            target: `object ${p.objectId}`,
            detail: { objectId: p.objectId, locatorName: wanted },
            ...(p.reason ? { reason: p.reason } : {}),
            ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
          });
          continue;
        }
        // update_property
        const prop = p.property ?? {};
        const fields = Object.entries(prop).filter(
          ([, v]) => v !== undefined && v !== null && (!Array.isArray(v) || v.length > 0),
        );
        if (!fields.length) {
          skip(skipped, 'update_property needs at least one of name / description / parameterNames', p);
          continue;
        }
        changes.push({
          domain: 'object',
          op: p.op,
          target: `object ${p.objectId}`,
          detail: { objectId: p.objectId, property: Object.fromEntries(fields) },
          ...(p.reason ? { reason: p.reason } : {}),
          ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
        });
        continue;
      }

      if (p.domain === 'action') {
        const step = stepsByN.get(p.step);
        if (!step) {
          skip(skipped, `step ${p.step} does not exist on ${facts.tcId}`, p);
          continue;
        }
        const wanted = p.actionType?.trim();
        if (!wanted) {
          skip(skipped, 'repoint_action needs an actionType', p);
          continue;
        }
        // API REQUEST / control-flow / function / switch / manual steps persist actionId:null — there is
        // no action to heal. API failures belong to the request/assertions, not to an action name.
        // An API-TECHNOLOGY step using a generic action ("Store from JSON", …) is NOT in that set: it
        // has a real action and must be healed like any other action step (never converted to API).
        const nonAction = new Set(['control_flow', 'function', 'function_end', 'switch', 'manual']);
        const kind = (step.stepType ?? '').toLowerCase();
        if (nonAction.has(kind) || step.isApiRequest === true) {
          skip(
            skipped,
            kind === 'api'
              ? `step ${p.step} is an API request step — it has no action; fix the request/assertions instead`
              : `step ${p.step} is a ${kind} step — it has no action to heal`,
            p,
          );
          continue;
        }

        const wantedLower = wanted.toLowerCase();
        const tech = (step.technologyType ?? '').toUpperCase();
        const techNames = tech ? facts.actionNamesByTech?.[tech] : undefined;
        const techSet = new Set((techNames ?? []).map((n) => n.toLowerCase()));
        const templateId = (step.objectTemplateId ?? '').trim();
        const templateNames = templateId ? facts.actionNamesByTemplate?.[templateId] : undefined;

        // Scope 1 — the step's OBJECT TEMPLATE. This is the most precise match: an action is
        // registered per template (the backend field `objectTemplate`), and the step's object
        // carries the same template id. It also fixes the "actions not showing in the step"
        // case, where a name exists but under a different template than the object's.
        if (templateId && templateNames) {
          const tplSet = new Set(templateNames.map((n) => n.toLowerCase()));
          if (!tplSet.has(wantedLower)) {
            const owner = Object.entries(facts.actionNamesByTemplate ?? {}).find(
              ([t, names]) => t !== templateId && names.some((n) => n.toLowerCase() === wantedLower),
            );
            if (owner) {
              skip(skipped, `action "${wanted}" belongs to object template ${owner[0]}, but step ${p.step} uses template ${templateId}`, p);
            } else if (actionNames.has(wantedLower)) {
              skip(skipped, `action "${wanted}" is not available for object template ${templateId} (step ${p.step})`, p);
            } else {
              skip(skipped, `action "${wanted}" is not in this project's catalog`, p);
            }
            continue;
          }
        } else if (tech && techNames) {
          // Scope 2 — technology (steps with no object: launch/waits, or a template lookup miss).
          if (!techSet.has(wantedLower)) {
            const otherTech = Object.entries(facts.actionNamesByTech ?? {}).find(
              ([t, names]) => t !== tech && names.some((n) => n.toLowerCase() === wantedLower),
            );
            if (otherTech) {
              skip(skipped, `action "${wanted}" belongs to ${otherTech[0]}, but step ${p.step} is ${tech}`, p);
            } else if (actionNames.has(wantedLower)) {
              skip(skipped, `action "${wanted}" is not registered for ${tech} (step ${p.step})`, p);
            } else {
              skip(skipped, `action "${wanted}" is not in this project's catalog`, p);
            }
            continue;
          }
        } else if (!actionNames.has(wantedLower)) {
          skip(skipped, `action "${wanted}" is not in this project's catalog`, p);
          continue;
        }

        // DATABASE action names genuinely collide ("executeQuery" = db-2 AND db-3), so a DB repoint
        // must name the plugin uniqueId — otherwise the save can quietly pick the wrong overload.
        let actionUniqueId: string | undefined;
        if (tech === 'DATABASE') {
          const uniq = p.actionUniqueId?.trim();
          if (!uniq) {
            skip(
              skipped,
              `database step ${p.step} needs actionUniqueId (e.g. "db-2") — "executeQuery" is registered more than once`,
              p,
            );
            continue;
          }
          if (facts.actionUniqueIds?.length && !facts.actionUniqueIds.includes(uniq)) {
            skip(skipped, `actionUniqueId "${uniq}" is not in this project's catalog`, p);
            continue;
          }
          actionUniqueId = uniq;
        }

        const currentUnique = (step.actionUniqueId ?? '').trim();
        const namesEqual = step.actionType.trim().toLowerCase() === wantedLower;
        // Same name + same plugin uniqueId (or no uniqueId involved) means nothing to do. For a
        // DATABASE repoint the uniqueId is what distinguishes overloads, so a matching NAME alone
        // must not block switching db-2 → db-3.
        const sameUnique = actionUniqueId !== undefined && currentUnique !== '' && currentUnique === actionUniqueId;
        // …but a step whose CURRENT action belongs to a different object template must be rewritten
        // even when the NAME matches: that mismatch is exactly why the editor shows an empty Action
        // field (the same name resolves to another technology's action row).
        const currentActionTemplate = (step.actionObjectTemplateId ?? '').trim();
        const templateMismatch = (!!templateId && !!currentActionTemplate && currentActionTemplate !== templateId)
          || step.actionDeprecated === true;
        if (!templateMismatch && ((actionUniqueId === undefined && namesEqual) || sameUnique)) {
          skip(skipped, `step ${p.step} already uses "${wanted}"${actionUniqueId ? ` (${actionUniqueId})` : ''}`, p);
          continue;
        }
        changes.push({
          domain: 'action',
          op: p.op,
          target: `step ${p.step}`,
          detail: { step: p.step, actionType: wanted, ...(actionUniqueId ? { actionUniqueId } : {}) },
          before: { actionType: step.actionType },
          ...(p.reason ? { reason: p.reason } : {}),
          ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
        });
        continue;
      }

      if (p.domain === 'parameter') {
        const name = p.name?.trim();
        if (!name || !PARAM_NAME.test(name)) {
          skip(skipped, `"${p.name}" is not a valid parameter name`, p);
          continue;
        }
        if (p.op === 'rebind') {
          const from = p.fromToken?.trim();
          if (!from) {
            skip(skipped, 'rebind needs the literal token it replaces (fromToken)', p);
            continue;
          }
          if (from === name) {
            skip(skipped, 'fromToken and name are identical — nothing to rebind', p);
            continue;
          }
          changes.push({
            domain: 'parameter',
            op: p.op,
            target: `parameter ${name}`,
            detail: { name, fromToken: from },
            ...(p.reason ? { reason: p.reason } : {}),
            ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
          });
          continue;
        }
        changes.push({
          domain: 'parameter',
          op: p.op,
          target: `parameter ${name}`,
          detail: { name, ...(p.defaultValue !== undefined ? { defaultValue: p.defaultValue } : {}) },
          ...(p.reason ? { reason: p.reason } : {}),
          ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
        });
        continue;
      }

      // testdata
      const paramName = p.paramName?.trim();
      if (!paramName) {
        skip(skipped, 'set_cell needs a paramName', p);
        continue;
      }
      const iterations = [...new Set(p.iterations ?? [])];
      if (!iterations.length) {
        skip(skipped, 'set_cell needs at least one failing iteration', p);
        continue;
      }
      if (facts.failingIterations?.length) {
        const allowed = new Set(facts.failingIterations);
        const outside = iterations.filter((i) => !allowed.has(i));
        if (outside.length) {
          skip(skipped, `iteration(s) ${outside.join(', ')} did not fail in this run — only failing iterations may be patched`, p);
          continue;
        }
      }
      changes.push({
        domain: 'testdata',
        op: p.op,
        target: `ITR ${iterations.join(',')}`,
        detail: { paramName, iterations, value: String(p.value ?? '') },
        ...(p.reason ? { reason: p.reason } : {}),
        ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
      });
    }
  } else {
    for (const p of input.proposals) skip(skipped, `family "${diagnosis.family}" is not healable — no change is proposed`, p);
  }

  const ordered = [...changes].sort((a, b) => HEAL_APPLY_ORDER.indexOf(a.domain) - HEAL_APPLY_ORDER.indexOf(b.domain));
  const objects: ObjectUsage[] = [];
  for (const objectId of new Set(ordered.filter((c) => c.domain === 'object').map((c) => String(c.detail['objectId'])))) {
    objects.push({
      objectId,
      sharedWithTestcases: facts.usingTestcasesByObject?.[objectId] ?? [],
      scanned: facts.usageScanned ?? 0,
      truncated: facts.usageTruncated === true,
    });
  }

  return {
    contractVersion: HEAL_CONTRACT_VERSION,
    planId: planIdFor(input.tcId, facts.currentVersionId, ordered),
    tcId: input.tcId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(facts.currentVersionId ? { baseVersionId: facts.currentVersionId } : {}),
    diagnosis: { ...diagnosis, healable: familyHealable && ordered.length > 0 },
    changes: ordered,
    skipped,
    blastRadius: { objects },
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}
