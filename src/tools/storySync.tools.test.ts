// story_sync_testcases — computeDrift + registration tests.
// Covers: no-drift, new-AC → add_step, reworded AC → update_step, automation TC skipped.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { Story, TestCase, Step } from '../domain/types.js';
import { computeAutomationCoverage, computeDrift, registerStorySyncTools } from './storySync.tools.js';

const mkStep = (n: number, description: string, expectedResult?: string): Step => ({
  n,
  description,
  actionType: 'manualStep',
  stepType: 'web',
  ...(expectedResult ? { expectedResult } : {}),
});

const mkTC = (over: Partial<TestCase> = {}): TestCase => ({
  id: 'TC_1',
  title: 'Login flow',
  priority: 'medium',
  category: 'manual',
  storyRef: 'US_1',
  steps: [],
  ...over,
});

describe('computeDrift', () => {
  it('reports no drift when every AC has a strong step match', () => {
    const story: Story = {
      id: 'US_1',
      title: 'Login',
      acceptanceCriteria: [
        'User enters valid username and password',
        'User clicks submit and lands on dashboard',
      ],
    };
    const tc = mkTC({
      steps: [
        mkStep(1, 'User enters valid username password', 'credentials accepted'),
        mkStep(2, 'User clicks submit lands dashboard', 'dashboard visible'),
      ],
    });
    const drift = computeDrift(story, tc);
    expect(drift.driftScore).toBe('none');
    expect(drift.signals).toHaveLength(0);
    expect(drift.proposedOps).toHaveLength(0);
  });

  it('proposes add_step for a brand-new AC', () => {
    const story: Story = {
      id: 'US_1',
      title: 'Login',
      acceptanceCriteria: [
        'User enters valid username and password',
        'Failed login shows an error banner within three seconds',
      ],
    };
    const tc = mkTC({
      steps: [mkStep(1, 'User enters valid username password', 'credentials accepted')],
    });
    const drift = computeDrift(story, tc);
    expect(drift.driftScore).toBe('major');
    const added = drift.signals.filter((s) => s.kind === 'ac_added');
    expect(added).toHaveLength(1);
    const addOp = drift.proposedOps.find((o) => o.op === 'add_step');
    expect(addOp).toBeDefined();
    expect(addOp && 'at' in addOp && addOp.at).toBe(2);
  });

  it('explodes an HTML <ul><li> AC blob into per-bullet ACs (US-941 regression)', () => {
    // Story editor shipped the ACs as ONE html blob. Before Phase 0 this landed as a single
    // "AC" whose merged token bag scored below T_LOW against every step → false ac_added
    // (the entire HTML as one step) + false ac_removed on steps that DO cover an inner bullet.
    const story: Story = {
      id: 'US_941',
      title: 'Purchase Product Through Checkout',
      acceptanceCriteria: [
        '<ul>' +
          '<li><p>The user should be able to log in using valid credentials.</p></li>' +
          '<li><p>The user should be able to add <strong>Sauce Labs Backpack</strong> to the cart.</p></li>' +
          '<li><p>The user should be able to click <strong>Finish</strong> to place the order.</p></li>' +
          '<li><p>The system should display the order confirmation after successful checkout.</p></li>' +
        '</ul>',
      ],
    };
    const tc = mkTC({
      id: 'TC_589',
      steps: [
        mkStep(1, 'able log in using valid credentials', 'logged in'),
        mkStep(2, 'able add Sauce Labs Backpack cart', 'item in cart'),
        mkStep(3, 'able click Finish place order', 'order placed'),
        mkStep(4, 'display order confirmation successful checkout', 'confirmation shown'),
      ],
    });
    const drift = computeDrift(story, tc);
    // Core regression assertions: NO signal carries the raw HTML blob, and NO ac_added
    // proposes the whole blob as a single step (the two things that broke on US-941).
    for (const sig of drift.signals) {
      if ('text' in sig) expect(sig.text).not.toMatch(/<[^>]+>/);
      if ('to' in sig) expect(sig.to).not.toMatch(/<[^>]+>/);
      if ('from' in sig) expect(sig.from).not.toMatch(/<[^>]+>/);
    }
    for (const op of drift.proposedOps) {
      if (op.op === 'add_step') expect(op.step.description).not.toMatch(/<[^>]+>/);
      if (op.op === 'update_step') {
        expect(op.patch.description ?? '').not.toMatch(/<[^>]+>/);
        expect(op.patch.expectedResult ?? '').not.toMatch(/<[^>]+>/);
      }
    }
    // Steps that clearly cover an AC should not be flagged for removal.
    const removed = drift.proposedOps.filter((o) => o.op === 'remove_step' || o.op === 'remove_steps');
    expect(removed).toHaveLength(0);
  });

  it('never emits raw HTML in signals or ops', () => {
    // Even when an AC IS drift, the text handed back must be stripped so callers do not
    // paste "<ul><li><p>..." into a step description.
    const story: Story = {
      id: 'US_1',
      title: 'X',
      acceptanceCriteria: ['<p>Login using <strong>valid</strong> credentials</p>'],
    };
    const tc = mkTC({ steps: [] });
    const drift = computeDrift(story, tc);
    const added = drift.signals.find((s) => s.kind === 'ac_added');
    expect(added && 'text' in added && added.text).toBe('Login using valid credentials');
    const addOp = drift.proposedOps.find((o) => o.op === 'add_step');
    expect(addOp && 'step' in addOp && addOp.step.description).not.toMatch(/<[^>]+>/);
  });

  it('tags every op with confidence + rationale + bucket', () => {
    const story: Story = {
      id: 'US_1',
      title: 'Login',
      acceptanceCriteria: ['Failed login shows an error banner within three seconds'],
    };
    const tc = mkTC({ steps: [mkStep(1, 'submits credentials successfully', 'session started')] });
    const drift = computeDrift(story, tc);
    for (const op of drift.proposedOps) {
      expect(typeof op.confidence).toBe('number');
      expect(op.confidence).toBeGreaterThanOrEqual(0);
      expect(op.confidence).toBeLessThanOrEqual(1);
      expect(op.rationale.length).toBeGreaterThan(0);
      expect(['auto', 'review', 'manual']).toContain(op.bucket);
    }
  });

  it('trims a removed scenario into ONE bulk remove_steps, capped at bucket=review', () => {
    // Steps 2–3 are a scenario about "turbine" that the current AC never mentions; step 1 still
    // represents the AC → the TC is TRIMMED (never obsoleted) and ONE bulk op carries both numbers.
    const story: Story = { id: 'US_1', title: 'X', acceptanceCriteria: ['pay with saved card'] };
    const tc = mkTC({
      steps: [
        mkStep(1, 'pay with saved card', 'payment accepted'),
        mkStep(2, 'open the turbine telemetry panel', 'turbine panel shown'),
        mkStep(3, 'read the turbine vibration reading', 'turbine reading captured'),
      ],
    });
    const drift = computeDrift(story, tc);
    const rem = drift.proposedOps.find((o) => o.op === 'remove_steps') as
      | { op: 'remove_steps'; numbers: number[]; confidence: number; bucket: string }
      | undefined;
    expect(rem).toBeDefined();
    // One bulk op (several remove ops in one apply call would renumber and hit the wrong steps).
    expect(rem!.numbers).toEqual([2, 3]);
    expect(rem!.bucket).toBe('review');              // destructive → never 'auto'
    expect(drift.allOrphaned).toBe(false);
  });

  it('never proposes removing an ISOLATED unmatched step (navigation step)', () => {
    // A lone unmatched step between two matched ones is a mundane navigation step, not a removed
    // scenario: it must come back as a `step_stale` hint, never as a removal.
    const story: Story = { id: 'US_1', title: 'X', acceptanceCriteria: ['update the phone number and save'] };
    const tc = mkTC({
      steps: [
        mkStep(1, 'update the phone number', 'phone number entered'),
        mkStep(2, 'click Edit on the details section', 'form becomes editable'),
        mkStep(3, 'save the change', 'change saved'),
      ],
    });
    const drift = computeDrift(story, tc);
    expect(drift.proposedOps.some((o) => o.op === 'remove_step' || o.op === 'remove_steps')).toBe(false);
    expect(drift.signals.some((s) => s.kind === 'step_stale' && s.n === 2)).toBe(true);
  });

  it('obsoletes a TC whose steps belong ONLY to a removed scenario', () => {
    // No step represents any current AC → the whole scenario was removed: obsolete the TC, do NOT
    // propose stripping it to zero steps (that leaves an empty but ACTIVE test case).
    const story: Story = { id: 'US_1', title: 'X', acceptanceCriteria: ['Something entirely unrelated'] };
    const tc = mkTC({
      steps: [mkStep(1, 'quantum entanglement measurement pipeline', 'result recorded')],
    });
    const drift = computeDrift(story, tc);
    expect(drift.allOrphaned).toBe(true);
    expect(drift.proposedOps).toHaveLength(0);
    expect(drift.signals.some((s) => s.kind === 'orphaned')).toBe(true);
  });

  it('emits title_review hint on major drift, none on minor/none', () => {
    // Major: an AC got removed → title likely references stale scope.
    const majorStory: Story = {
      id: 'US_1',
      title: 'Purchase',
      acceptanceCriteria: ['Click Finish place order'],
    };
    const majorTc = mkTC({
      title: 'Require Cart Review Before Purchase',
      steps: [
        mkStep(1, 'able click Finish place order', 'placed'),
        mkStep(2, 'quantum entanglement measurement pipeline', 'unrelated'),
        mkStep(3, 'quantum entanglement calibration sweep', 'calibrated'),
      ],
    });
    const majorDrift = computeDrift(majorStory, majorTc);
    expect(majorDrift.driftScore).toBe('major');
    const titleSig = majorDrift.signals.find((s) => s.kind === 'title_review');
    expect(titleSig).toBeDefined();
    if (titleSig && titleSig.kind === 'title_review') {
      expect(titleSig.currentTitle).toBe('Require Cart Review Before Purchase');
      expect(titleSig.hint).toMatch(/review against current ACs/i);
    }
    // No auto-rename op emitted.
    expect(majorDrift.proposedOps.find((o) => o.op === 'update_step' && o.n === 0)).toBeUndefined();

    // None: perfect match → no title_review.
    const cleanStory: Story = { id: 'US_2', title: 'X', acceptanceCriteria: ['submits credentials successfully'] };
    const cleanTc = mkTC({
      title: 'Login flow',
      steps: [mkStep(1, 'submits credentials successfully', 'session started')],
    });
    const cleanDrift = computeDrift(cleanStory, cleanTc);
    expect(cleanDrift.signals.find((s) => s.kind === 'title_review')).toBeUndefined();
  });

  it('emits hint-only patch (no description overwrite) for ac_reworded', () => {
    const story: Story = {
      id: 'US_1',
      title: 'Login',
      acceptanceCriteria: ['Submit button becomes disabled while credentials validate'],
    };
    const tc = mkTC({
      steps: [mkStep(1, 'Submit button disabled during validation', 'button greyed out')],
    });
    const drift = computeDrift(story, tc, 'strict');
    const upd = drift.proposedOps.find((o) => o.op === 'update_step');
    expect(upd).toBeDefined();
    expect(upd!.op).toBe('update_step');
    if (upd!.op === 'update_step') {
      expect(upd!.patch).toEqual({});                     // no clobbering the step wording
      expect(upd!.hint).toMatch(/AC drift/);
    }
  });

  it('proposes update_step for a reworded AC', () => {
    const story: Story = {
      id: 'US_1',
      title: 'Login',
      acceptanceCriteria: ['Submit button becomes disabled while credentials validate'],
    };
    const tc = mkTC({
      steps: [mkStep(1, 'Submit button disabled during validation', 'button greyed out')],
    });
    const drift = computeDrift(story, tc, 'strict');
    const reworded = drift.signals.filter((s) => s.kind === 'ac_reworded');
    expect(reworded).toHaveLength(1);
    const upd = drift.proposedOps.find((o) => o.op === 'update_step');
    expect(upd).toBeDefined();
    expect(upd && 'n' in upd && upd.n).toBe(1);
  });
});

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

function captureHandler(name: string): { server: McpServer; get: () => Handler } {
  let handler: Handler | undefined;
  const server = {
    registerTool: (n: string, _meta: unknown, h: Handler) => {
      if (n === name) handler = h;
    },
  } as unknown as McpServer;
  return {
    server,
    get: () => {
      if (!handler) throw new Error(`${name} handler not registered`);
      return handler;
    },
  };
}

describe('story_sync_testcases handler', () => {
  it('errors when not connected', async () => {
    const cap = captureHandler('story_sync_testcases');
    registerStorySyncTools(cap.server, { getAdapter: () => null });
    const res = await cap.get()({ storyId: 'US_1' });
    expect(res.isError).toBe(true);
  });

  it('plans BOTH categories: manual drift + automation coverage (scope defaults to both)', async () => {
    const cap = captureHandler('story_sync_testcases');
    const story: Story = {
      id: 'US_1',
      title: 'Login',
      acceptanceCriteria: ['User submits credentials', 'A failed login shows an error banner'],
    };
    const manualTC = mkTC({
      id: 'TC_M',
      title: 'Manual login',
      category: 'manual',
      versions: [{ id: 'v-m1', name: 'v1.0', isCurrent: true }],
      steps: [mkStep(1, 'User submits credentials', 'session started')],
    });
    const autoTC = mkTC({
      id: 'TC_A',
      title: 'Automated login',
      category: 'automated',
      versions: [{ id: 'v-a1', name: 'v1.0', isCurrent: true }],
      steps: [mkStep(1, 'User submits credentials')],
    });
    const adapter = {
      getStory: async () => story,
      listTestCases: async () => [
        { id: 'TC_M', title: 'Manual login', priority: 'medium' },
        { id: 'TC_A', title: 'Automated login', priority: 'medium' },
      ],
      getTestCase: async (id: string) => (id === 'TC_M' ? manualTC : autoTC),
    } as unknown as ProviderAdapter;
    registerStorySyncTools(cap.server, { getAdapter: () => adapter });
    const res = await cap.get()({ storyId: 'US_1' });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(sc.plan).toHaveLength(2);
    const manual = sc.plan.find((p: any) => p.kind === 'manual');
    const automation = sc.plan.find((p: any) => p.kind === 'automation');
    expect(manual.testCaseId).toBe('TC_M');
    expect(manual.nextVersionName).toBe('v2.0');
    expect(manual.proposedOps.length).toBeGreaterThan(0);      // the new AC is missing
    expect(automation.testCaseId).toBe('TC_A');
    expect(automation.action).toBe('rerecord');                 // the new AC is not covered
    expect(automation.missingAcs).toHaveLength(1);
    expect(automation.brief.acceptanceCriteria).toHaveLength(2);
    expect(automation.nextVersionName).toBe('v2.0');
    expect(sc.next).toBeTruthy();
  });

  it('scope:"manual" skips automation TCs with automation_tc_out_of_scope', async () => {
    const cap = captureHandler('story_sync_testcases');
    const story: Story = { id: 'US_1', title: 'Login', acceptanceCriteria: ['User submits credentials'] };
    const manualTC = mkTC({ id: 'TC_M', title: 'Manual login', category: 'manual', steps: [mkStep(1, 'User submits credentials')] });
    const autoTC = mkTC({ id: 'TC_A', title: 'Automated login', category: 'automated', steps: [mkStep(1, 'User submits credentials')] });
    const adapter = {
      getStory: async () => story,
      listTestCases: async () => [
        { id: 'TC_M', title: 'Manual login', priority: 'medium' },
        { id: 'TC_A', title: 'Automated login', priority: 'medium' },
      ],
      getTestCase: async (id: string) => (id === 'TC_M' ? manualTC : autoTC),
    } as unknown as ProviderAdapter;
    registerStorySyncTools(cap.server, { getAdapter: () => adapter });
    const res = await cap.get()({ storyId: 'US_1', scope: 'manual' });
    const sc = res.structuredContent as any;
    expect(sc.plan).toHaveLength(1);
    expect(sc.skipped).toHaveLength(1);
    expect(sc.skipped[0].reason).toBe('automation_tc_out_of_scope');
  });

  it('computeAutomationCoverage: matched ACs are up-to-date', () => {
    const story: Story = { id: 'US_1', title: 's', acceptanceCriteria: ['User submits credentials'] };
    const tc = mkTC({ category: 'automated', steps: [mkStep(1, 'User submits credentials', 'session started')] });
    const cov = computeAutomationCoverage(story, tc);
    expect(cov.covered).toBe(true);
    expect(cov.coverage).toBe(1);
  });

});
