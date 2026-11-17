import { buildTestcasePayload, fromSqaStep } from './mapper.js';
import { SimplifyQaAdapter } from './adapter.js';
import { normalizeJournalStep } from '../../tools/testcase.tools.js';

const tc = (steps: any[]) => ({ id: 'TC_42', title: 't', priority: 'medium', category: 'automated', steps } as any);

const save = (steps: any[], resolutions: Array<{ actionId: number | null; objectId: number | null }>) =>
  (buildTestcasePayload({
    projectId: 19, moduleId: 7, existingId: '42',
    tc: tc(steps), paramIdByName: new Map(), stepResolutions: resolutions,
  } as any) as any).steps.automationSteps;

/** A step the backend stores as `stepType: "API"` + `technologyType: "API"` but which is a GENERIC
 *  action ("Store from JSON" = actionId 140) with no request payload — TC-794 step 2. */
const genericApiRaw = () => ({
  id: 'sid-2', seq: 2, description: 'Get value from JSON and store [param_name_3]',
  stepType: 'API', technologyType: 'API', actionId: 140,
  parameterIds: [], objectParameterIds: [], recordedParam: {}, attachments: [],
  conditions: { ifstring: '', children: [] },
  stepLevelActions: { skip: false, captureScreenshot: false, continueOnFailure: false, skippedReport: false },
  loop: { loopType: 'for', loopIteration: null },
});

/** A real API REQUEST step (TC-794 step 1): actionId null + apiData. */
const apiRequestRaw = () => ({
  id: 'sid-1', seq: 1, description: 'GET user 1',
  stepType: 'API', technologyType: 'API', actionId: null,
  apiData: {
    requestStyle: 'HTTP',
    requestData: { httpData: { url: 'https://jsonplaceholder.typicode.com/users/1', method: 'GET' } },
    assertions: [{ path: 'statusCode', condition: 'EQUALS', expectedValue: '200' }],
  },
  parameterIds: [], objectParameterIds: [], recordedParam: {}, attachments: [],
  conditions: { ifstring: '', children: [] },
  stepLevelActions: { skip: false, captureScreenshot: false, continueOnFailure: false, skippedReport: false },
  loop: { loopType: 'for', loopIteration: null },
});

describe('healing/saving must not convert a generic API action into an API request', () => {
  test('generic action under stepType API round-trips as a generic action step', () => {
    const step = fromSqaStep(genericApiRaw(), 1);
    expect(step.stepType).toBe('api');       // neutral bucket (technology is API)
    expect(step.api).toBeUndefined();        // …but there is no request payload

    const out = save([step], [{ actionId: 140, objectId: null }])[0];
    expect(out.stepType).toBe('API');
    expect(out.technologyType).toBe('API');
    expect(out.actionId).toBe(140);          // the action is preserved
    expect(out.apiData).toBeUndefined();     // and no empty API request is invented
  });

  test('a real API request step is still action-less and keeps its request', () => {
    const step = fromSqaStep(apiRequestRaw(), 1);
    const out = save([step], [{ actionId: null, objectId: null }])[0];
    expect(out.stepType).toBe('API');
    expect(out.actionId).toBeNull();
    expect(out.apiData.requestData.httpData.url).toBe('https://jsonplaceholder.typicode.com/users/1');
    expect(out.apiData.assertions).toHaveLength(1);
  });

  test('both kinds keep their own shape side by side', () => {
    const steps = [fromSqaStep(apiRequestRaw(), 1), fromSqaStep(genericApiRaw(), 2)];
    const out = save(steps, [{ actionId: null, objectId: null }, { actionId: 140, objectId: null }]);
    expect(out[0].actionId).toBeNull();
    expect(out[0].apiData.requestData.httpData.url).toBe('https://jsonplaceholder.typicode.com/users/1');
    expect(out[1].actionId).toBe(140);
    expect(out[1].apiData).toBeUndefined();
  });
});

describe('recording a generic action inside an API session', () => {
  test('the journal step stays an action step (not an API request)', () => {
    const s = normalizeJournalStep({
      n: 1, description: 'Get value from JSON and store [param_name_3]',
      actionType: 'Store from JSON', stepType: 'api',
    } as any);
    expect(s.stepType).toBe('api');
    expect(s.api).toBeUndefined();
  });

  test('action resolution finds the generic action by its display name (so the save keeps it)', async () => {
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.requireProjectId = () => 2;
    a.actionCatalog = async () => new Map([
      ['dis::store from json', { id: 140, objectRequired: false, name: 'storeFromJSON', displayName: 'Store from JSON' }],
    ]);
    const out = await a.resolveAutomationSteps(2, 1, {
      category: 'automated',
      steps: [{ n: 1, description: 'store', actionType: 'Store from JSON', stepType: 'api' }],
    } as any);
    expect(out).toEqual([{ actionId: 140, objectId: null }]);
  });

  test('a display name that differs only in spacing/punctuation still resolves', async () => {
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.requireProjectId = () => 2;
    // The backend spells it "StoreFromJSON"; the recorder emits "Store from JSON".
    a.actionCatalog = async () => new Map([
      ['dis::storefromjson', { id: 140, objectRequired: false, displayName: 'StoreFromJSON' }],
    ]);
    const out = await a.resolveAutomationSteps(2, 1, {
      category: 'automated',
      steps: [{ n: 1, description: 'store', actionType: 'Store from JSON', stepType: 'api' }],
    } as any);
    expect(out).toEqual([{ actionId: 140, objectId: null }]);
  });

  test('a real API request step still resolves action-less', async () => {
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.requireProjectId = () => 2;
    a.actionCatalog = async () => new Map();
    const out = await a.resolveAutomationSteps(2, 1, {
      category: 'automated',
      steps: [{ n: 1, description: 'GET', actionType: '', stepType: 'api', api: { requestStyle: 'HTTP', requestData: {} } }],
    } as any);
    expect(out).toEqual([{ actionId: null, objectId: null }]);
  });
});
