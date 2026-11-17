import type { Step } from '../../domain/types.js';
import {
  CF_TO_WALNUT,
  WALNUT_TO_CF,
  deriveTestData,
  fromWalnutObject,
  fromWalnutStep,
  fromWalnutStory,
  fromWalnutStorySummary,
  fromWalnutSuite,
  fromWalnutSuiteSummary,
  fromWalnutTc,
  fromWalnutTcSummary,
  toWalnutStep,
  toWalnutTc,
} from './mapper.js';

describe('fromWalnutStep', () => {
  it('maps an element step with its identity, target, value and step-level flags', () => {
    const step = fromWalnutStep({
      _id: 'step-a',
      step_number: 3,
      step_description: 'Click Login',
      step_type: 'web',
      action_type: 'click',
      expected_result: 'Dashboard shows',
      object_id: 'obj-9',
      input_value: 'alice',
      stepLevelActions: { skip: true, captureScreenshot: true, continueOnFailure: false },
      is_optional: 1,
    });

    expect(step).toEqual({
      n: 3,
      sourceId: 'step-a',
      description: 'Click Login',
      actionType: 'click',
      stepType: 'web',
      objectRef: { id: 'obj-9' },
      value: 'alice',
      expectedResult: 'Dashboard shows',
      flags: { skip: true, screenshot: true, continueOnFailure: false, optional: true },
    });
    // Absent wire payloads stay undefined on the neutral step.
    expect(step.api).toBeUndefined();
    expect(step.db).toBeUndefined();
    expect(step.functionCall).toBeUndefined();
  });

  it('maps control-flow rows to their kind, keeping condition and block metadata', () => {
    for (const [wire, kind] of Object.entries(WALNUT_TO_CF)) {
      const step = fromWalnutStep({
        step_number: 1,
        step_description: wire,
        action_type: wire,
        step_type: 'control_flow',
        condition: {
          type: 'element_visible',
          selector: '#login',
          object_id: 'obj-3',
          text: 'Welcome',
          variableName: 'count',
          variableValue: '3',
        },
        block_id: 'block-1',
        max_iterations: 7,
      });

      expect(step.stepType).toBe('control_flow');
      expect(step.controlFlow).toEqual({
        kind,
        condition: {
          type: 'element_visible',
          selector: '#login',
          objectId: 'obj-3',
          text: 'Welcome',
          variableName: 'count',
          variableValue: '3',
        },
        blockId: 'block-1',
        maxIterations: 7,
      });
    }
    // The forward table is derived from the same source, never hand-maintained.
    expect(Object.keys(CF_TO_WALNUT)).toHaveLength(Object.keys(WALNUT_TO_CF).length);
    expect(CF_TO_WALNUT[WALNUT_TO_CF['while_start']!]).toBe('while_start');
  });

  it('maps function / api / database steps and defaults unknown step types to web', () => {
    const fn = fromWalnutStep({
      step_number: 3,
      step_description: 'Call login',
      action_type: 'run_test_case',
      step_type: 'function',
      function_call_data: {
        test_case_id: 'TC_12',
        function_name: 'Login',
        input_params: { user: 'alice' },
        continue_on_failure: true,
      },
    });
    expect(fn.functionCall).toEqual({
      testCaseId: 'TC_12',
      testCaseName: 'Login',
      inputParams: { user: 'alice' },
      continueOnFailure: true,
    });

    const api = fromWalnutStep({
      step_number: 4,
      step_description: 'GET /health',
      action_type: 'api_call',
      step_type: 'API',
      api_request_data: { method: 'GET', url: '/health' },
    });
    expect(api.stepType).toBe('api');
    expect(api.api).toEqual({ method: 'GET', url: '/health' });

    const db = fromWalnutStep({
      step_number: 5,
      step_description: 'Select 1',
      action_type: 'database_query',
      step_type: 'database',
      db_request_data: { query: 'select 1' },
    });
    expect(db.stepType).toBe('database');
    expect(db.db).toEqual({ query: 'select 1' });

    // An unrecognized (or absent) step_type silently becomes 'web' — the backend's own default.
    expect(fromWalnutStep({ step_number: 6, action_type: 'click', step_type: 'quantum' }).stepType).toBe('web');
    expect(fromWalnutStep({ step_number: 7, action_type: 'click' }).stepType).toBe('web');
    // No description on the wire → empty string, never undefined.
    expect(fromWalnutStep({ step_number: 8, action_type: 'click' }).description).toBe('');
  });
});

describe('test case mapping', () => {
  it('maps the test-case document (story link, tags, version, steps) and its fallbacks', () => {
    const tc = fromWalnutTc({
      _id: 'mongo-1',
      test_case_id: 'TC_7',
      title: 'Checkout',
      test_category: 'manual',
      priority: 'high',
      status: 'draft',
      description: 'desc',
      objective: 'obj',
      preconditions: 'pre',
      expected_outcome: 'out',
      story_id: { _id: 'story-1' },
      tags: ['smoke', 'p1'],
      version: 4,
      test_steps: [
        { step_number: 1, step_description: 'Open', action_type: 'navigate', step_type: 'web' },
      ],
    });

    expect(tc).toMatchObject({
      id: 'TC_7',
      title: 'Checkout',
      description: 'desc',
      objective: 'obj',
      priority: 'high',
      status: 'draft',
      category: 'manual',
      preconditions: 'pre',
      expectedOutcome: 'out',
      storyRef: 'story-1',
      tags: ['smoke', 'p1'],
      version: 4,
    });
    expect(tc.steps).toHaveLength(1);
    expect(tc.steps[0]).toMatchObject({ n: 1, description: 'Open', stepType: 'web' });

    // Fallbacks: the Mongo id when there is no business key, a safe default category, empty
    // collections — and a bare ObjectId story link (not a populated doc).
    const playwright = fromWalnutTc({ _id: 'mongo-2', title: 't', test_category: 'playwright', story_id: 'story-9' });
    expect(playwright.id).toBe('mongo-2');
    expect(playwright.category).toBe('playwright');
    expect(playwright.storyRef).toBe('story-9');
    expect(playwright.tags).toEqual([]);
    expect(playwright.steps).toEqual([]);

    // An unknown / absent category is treated as automated (the default product category).
    const other = fromWalnutTc({ title: 't', test_category: 'something-else' });
    expect(other.category).toBe('automated');
    expect(other.id).toBeUndefined();
  });

  it('maps a list row to a TcSummary', () => {
    expect(
      fromWalnutTcSummary({
        _id: 'mongo-3',
        test_case_id: 'TC_3',
        title: 'Login',
        priority: 'medium',
        status: 'active',
        total_steps: 6,
      }),
    ).toEqual({ id: 'TC_3', title: 'Login', priority: 'medium', status: 'active', stepCount: 6 });

    // No business key → the Mongo _id, stringified; no total_steps → no stepCount.
    const bare = fromWalnutTcSummary({ _id: 'mongo-4', title: 'Bare' });
    expect(bare.id).toBe('mongo-4');
    expect(bare.stepCount).toBeUndefined();
    expect(bare.status).toBeUndefined();
  });
});

describe('suite mapping', () => {
  it('maps a suite list row and a suite document (ordering + business-key fallback)', () => {
    expect(fromWalnutSuiteSummary({ _id: 'su-1', name: 'Regression', totalTests: 12 })).toEqual({
      id: 'su-1',
      name: 'Regression',
      memberCount: 12,
    });
    // Non-numeric totalTests is dropped rather than emitted as NaN.
    const sparseSummary = fromWalnutSuiteSummary({ name: 'No id' });
    expect(sparseSummary.id).toBe('');
    expect(sparseSummary).not.toHaveProperty('memberCount');

    const suite = fromWalnutSuite({
      _id: 'su-9',
      name: 'Smoke',
      description: 'Runs nightly',
      testCases: [
        { testCaseId: { _id: 'm2', test_case_id: 'TC_2' }, order: 2 },
        { testCaseId: { _id: 'm1' }, order: 1 },
        // Null test case (deleted) and a member without any testCaseId are dropped.
        { testCaseId: null, order: 3 },
        { order: 4 },
      ],
    });

    expect(suite).toEqual({
      id: 'su-9',
      name: 'Smoke',
      description: 'Runs nightly',
      members: [
        { tcId: 'm1', order: 1 },
        { tcId: 'TC_2', order: 2 },
      ],
    });

    // Members without an explicit order take their index.
    const noOrders = fromWalnutSuite({ _id: 'su-10', name: 'X', testCases: [{ testCaseId: 'mongo-a' }, { testCaseId: 'mongo-b' }] });
    expect(noOrders.members).toEqual([
      { tcId: 'mongo-a', order: 0 },
      { tcId: 'mongo-b', order: 1 },
    ]);
    expect(noOrders).not.toHaveProperty('description');
  });
});

describe('story mapping', () => {
  it('maps a story summary (key fallback) and a full story with acceptance criteria', () => {
    expect(
      fromWalnutStorySummary({ _id: 'st-1', walnut_key: 'US_001', title: 'Login story', status: 'open', priority: 'high' }),
    ).toEqual({ id: 'st-1', key: 'US_001', title: 'Login story', status: 'open', priority: 'high' });

    const minimal = fromWalnutStorySummary({ id: 'st-2', title: 'No key' });
    expect(minimal.id).toBe('st-2');
    expect(minimal).not.toHaveProperty('key');
    expect(minimal).not.toHaveProperty('status');

    const story = fromWalnutStory({
      _id: 'st-3',
      key: 'US_003',
      title: 'Checkout',
      description: 'As a buyer…',
      acceptance_criteria: ['Card is charged', 42],
    });
    expect(story).toEqual({
      id: 'st-3',
      key: 'US_003',
      title: 'Checkout',
      description: 'As a buyer…',
      acceptanceCriteria: ['Card is charged', '42'],
    });

    // An empty AC list is omitted rather than exposed as [].
    const empty = fromWalnutStory({ _id: 'st-4', title: 'Bare', acceptance_criteria: [] });
    expect(empty).not.toHaveProperty('acceptanceCriteria');
    expect(empty).not.toHaveProperty('description');
  });
});

describe('fromWalnutObject', () => {
  it('maps repository attributes to locators, keeping only well-formed ones', () => {
    const obj = fromWalnutObject({
      _id: 'obj-1',
      description: 'Login button',
      object_type: 'WEB',
      attributes: [
        { name: 'css', value: '#login', unique: true },
        { name: 'xpath', value: '//button' },
        { name: 'broken' },
        { name: 'bad-value', value: 12 },
      ],
    });

    expect(obj).toEqual({
      id: 'obj-1',
      name: 'Login button',
      objectType: 'WEB',
      locators: [
        { name: 'css', value: '#login', unique: true },
        { name: 'xpath', value: '//button' },
      ],
    });

    // No _id / attributes → an id-less object with an empty locator bag.
    const bare = fromWalnutObject({ description: 'Nameless' });
    expect(bare).not.toHaveProperty('id');
    expect(bare.locators).toEqual([]);
    expect(bare).not.toHaveProperty('objectType');
  });
});

describe('forward mapping (neutral -> walnut)', () => {
  it('emits the persistence wire shape for web, control-flow and nested-call steps', () => {
    const web: Step = {
      n: 1,
      description: 'Open ${url}',
      actionType: 'navigate',
      stepType: 'web',
      value: 'https://shop.test',
      expectedResult: '  ',
      objectRef: {
        id: 'obj-1',
        locators: [
          { name: 'css', value: '#url' },
          { name: 'xpath', value: '//input', unique: true },
        ],
      },
      flags: { skip: true, screenshot: true },
    };
    expect(toWalnutStep(web)).toEqual({
      step_number: 1,
      step_type: 'web',
      action_type: 'navigate',
      step_description: 'Open ${url}',
      // Blank expected results are replaced with a non-empty phrase (the backend requires one).
      expected_result: 'Verified: Open ${url}',
      inputValue: 'https://shop.test',
      parameterName: 'url',
      detected_parameters: ['url'],
      object_id: 'obj-1',
      // The `unique` locator wins over the first one.
      element: { locator_type: 'xpath', locator_value: '//input' },
      stepLevelActions: { skip: true, captureScreenshot: true, continueOnFailure: false },
    });

    const loop: Step = {
      n: 2,
      description: 'While items remain',
      actionType: 'while_start',
      stepType: 'control_flow',
      expectedResult: 'All items processed',
      sourceId: 'step-b',
      controlFlow: {
        kind: 'while',
        condition: { type: 'element_visible', objectId: 'obj-2', selector: '#row' },
        blockId: 'block-2',
        maxIterations: 5,
      },
    };
    expect(toWalnutStep(loop)).toEqual({
      step_number: 2,
      step_type: 'control_flow',
      action_type: 'while_start',
      step_description: 'While items remain',
      expected_result: 'All items processed',
      _id: 'step-b',
      condition: { type: 'element_visible', object_id: 'obj-2', selector: '#row' },
      block_id: 'block-2',
      max_iterations: 5,
    });

    const nested: Step = {
      n: 3,
      description: 'Call login',
      actionType: 'run_test_case',
      stepType: 'function',
      expectedResult: 'Logged in',
      functionCall: {
        testCaseId: 'TC_9',
        testCaseName: 'Login',
        inputParams: { user: 'alice' },
        continueOnFailure: true,
      },
    };
    expect(toWalnutStep(nested)).toMatchObject({
      step_type: 'function',
      function_call_data: {
        test_case_id: 'TC_9',
        function_name: 'Login',
        input_params: { user: 'alice' },
        continue_on_failure: true,
      },
    });

    // A multi-token description still names the FIRST token on the wire (deriveTestData, which
    // needs exactly one token to bind a value, skips these).
    const multi = toWalnutStep({ n: 4, description: 'Type ${user} / ${pass}', actionType: 'type', stepType: 'web' });
    expect(multi).toMatchObject({ parameterName: 'user', detected_parameters: ['user', 'pass'] });
    expect(multi).not.toHaveProperty('inputValue');
    expect(multi).not.toHaveProperty('element');
  });

  it('derives default test data and builds the editor draft payload (round-trip safe)', () => {
    const steps: Step[] = [
      { n: 1, description: 'Open ${url}', actionType: 'navigate', stepType: 'web', value: 'https://one' },
      { n: 2, description: 'Open again ${url}', actionType: 'navigate', stepType: 'web', value: 'https://two' },
      // Multiple tokens → ambiguous, skipped.
      { n: 3, description: 'Type ${user} as ${role}', actionType: 'type', stepType: 'web', value: 'alice' },
      // No value → nothing to bind.
      { n: 4, description: 'Type ${blank}', actionType: 'type', stepType: 'web', value: '' },
    ];
    // First seen wins; only exactly-one-token steps bind.
    expect(deriveTestData(steps)).toEqual({ url: 'https://one' });

    const draft = toWalnutTc({
      id: 'TC_1',
      title: 'Login',
      priority: 'high',
      category: 'automated',
      steps,
    });
    expect(draft).toEqual({
      title: 'Login',
      priority: 'high',
      category: 'automated',
      test_steps: steps.map(toWalnutStep),
    });

    const back = fromWalnutStep(toWalnutStep(steps[0]!));
    expect(back).toMatchObject({ n: 1, description: 'Open ${url}', actionType: 'navigate', stepType: 'web' });
    const flowBack = fromWalnutStep(
      toWalnutStep({
        n: 5,
        description: 'If visible',
        actionType: 'if_start',
        stepType: 'control_flow',
        controlFlow: { kind: 'if', condition: { type: 'element_visible', objectId: 'obj-7' } },
      }),
    );
    expect(flowBack.controlFlow).toMatchObject({ kind: 'if', condition: { objectId: 'obj-7' } });
  });
});
