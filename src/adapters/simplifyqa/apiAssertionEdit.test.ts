import { buildTestcasePayload, fromSqaStep } from './mapper.js';
import { mergeApiPatch } from '../../drafts/apiPatch.js';
import { DraftStore } from '../../drafts/store.js';
import { SimplifyQaAdapter } from './adapter.js';

/** An API step as the backend stores it (saved by the UI / recorder), with one assertion and a header assertion. */
const storedApiStep = () => ({
  id: 'st-77', seq: 1, description: 'GET /tasks', stepType: 'API', technologyType: 'API', actionId: null,
  parameterIds: [], objectParameterIds: [], recordedParam: {},
  apiData: {
    requestStyle: 'HTTP',
    requestData: { httpData: { url: 'https://api.example.com/tasks', method: 'GET', headers: [{ key: 'Accept', value: 'application/json' }], body: { type: 'NONE' } } },
    assertions: [
      { path: 'statusCode', key: 'statusCode', condition: 'EQUALS', expectedValue: '201', caseSensitive: false },
      { path: 'responseHeaders.Content-Type', key: 'Content-Type', condition: 'CONTAINS', expectedValue: 'json', caseSensitive: false },
    ],
  },
});

/** Edit the saved step the way editStepsDirect does (merge the patch), then build the payload the save sends. */
const saveAfter = (patch: any) => {
  const cur = fromSqaStep(storedApiStep(), 1);
  const step = { ...cur, ...patch, ...(patch.api ? { api: mergeApiPatch(cur, patch) } : {}) };
  const out = (buildTestcasePayload({
    projectId: 19, moduleId: 7, existingId: '42',
    tc: { id: 'TC_42', title: 't', priority: 'medium', category: 'automated', steps: [step] } as any,
    paramIdByName: new Map(), stepResolutions: [{ actionId: null }],
  } as any) as any).steps.automationSteps;
  return out;
};

describe('adding an assertion to a saved API step edits that step in place', () => {
  test('a saved API step exposes its request and assertions to the reader', () => {
    const cur: any = fromSqaStep(storedApiStep(), 1);
    expect(cur.api.requestData.httpData.url).toBe('https://api.example.com/tasks');
    expect(cur.api.assertions).toHaveLength(2);
  });

  test('addAssertions appends; same step id, request and existing assertions untouched; no new step', () => {
    const out = saveAfter({ api: { addAssertions: [{ path: '$.body.title', condition: 'EQUALS', expectedValue: 'x' }] } });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('st-77');                       // the SAME stored step, not a new one
    expect(out[0].stepType).toBe('API');
    expect(out[0].apiData.requestData.httpData.url).toBe('https://api.example.com/tasks');
    expect(out[0].apiData.assertions.map((a: any) => a.path))
      .toEqual(['statusCode', 'responseHeaders.Content-Type', 'response.title']);
    expect(out[0].apiData.assertions[0].expectedValue).toBe('201');
  });

  test('a partial api patch no longer replaces the request', () => {
    const out = saveAfter({ api: { assertions: [{ path: 'statusCode', condition: 'EQUALS', expectedValue: '200' }] } });
    expect(out[0].apiData.requestData.httpData.url).toBe('https://api.example.com/tasks');
    expect(out[0].apiData.assertions).toHaveLength(1);
  });

  test('nested request edit (URL only) keeps method, headers and assertions', () => {
    const out = saveAfter({ api: { requestData: { httpData: { url: 'https://api.example.com/v2/tasks' } } } });
    const http = out[0].apiData.requestData.httpData;
    expect(http.url).toBe('https://api.example.com/v2/tasks');
    expect(http.method).toBe('GET');
    expect(http.headers).toHaveLength(1);
    expect(out[0].apiData.assertions).toHaveLength(2);
  });

  test('re-saving does not corrupt a saved header assertion path', () => {
    const out = saveAfter({ description: 'GET /tasks (renamed)' });
    expect(out[0].apiData.assertions[1].path).toBe('responseHeaders.Content-Type');
    expect(out[0].apiData.assertions[1].key).toBe('Content-Type');
  });

  test('a new header assertion given as {path:"$.headers.X"} still normalizes', () => {
    const out = saveAfter({ api: { addAssertions: [{ path: '$.headers.X-Id', condition: 'EQUALS', expectedValue: '1' }] } });
    expect(out[0].apiData.assertions[2].path).toBe('responseHeaders.X-Id');
  });

  test('condition synonyms are folded onto the editor enum (LESS_THAN → LESSER_THAN)', () => {
    const out = saveAfter({ api: { addAssertions: [
      { path: 'responseTime', condition: 'LESS_THAN', expectedValue: '300' },
      { path: 'responseSize', condition: 'less-than-or-equals', expectedValue: '5000' },
    ] } });
    expect(out[0].apiData.assertions[2].condition).toBe('LESSER_THAN');
    expect(out[0].apiData.assertions[3].condition).toBe('LESSER_THAN_OR_EQUAL_TO');
  });

  test('draft update_step merges the same way', () => {
    const store = new DraftStore();
    const cur = fromSqaStep(storedApiStep(), 1);
    const id = store.create({ title: 't', priority: 'medium', category: 'automated', steps: [cur] } as any);
    store.applyOps(id, [{ op: 'update_step', n: 1, patch: { api: { addAssertions: [{ path: 'responseTime', condition: 'LESS_THAN', expectedValue: '500' }] } } }] as any);
    const d: any = store.get(id)!;
    expect(d.tc.steps[0].api.requestData.httpData.url).toBe('https://api.example.com/tasks');
    expect(d.tc.steps[0].api.assertions).toHaveLength(3);
  });
});

describe('the add_assertions op appends and touches nothing else', () => {
  const fake = (steps: any[]) => {
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    let saved: any;
    a.getTestCase = async () => ({ id: 'TC_42', title: 't', priority: 'medium', category: 'automated', steps });
    a.updateTestCase = async (_id: string, tc: any) => { saved = tc; return { id: 'TC_42' }; };
    a.hop = () => { throw new Error('the agent must not be involved'); };
    return { a, saved: () => saved };
  };

  test('saved API step: the assertion is appended, the request and existing assertions stay', async () => {
    const cur = fromSqaStep(storedApiStep(), 1);
    const { a, saved } = fake([{ ...cur }]);
    await a.editJournal('TC_42', [{ op: 'add_assertions', n: 1, assertions: [{ path: 'responseTime', condition: 'LESS_THAN', expectedValue: '3000' }] }]);
    const out = saved();
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0].api.requestData.httpData.url).toBe('https://api.example.com/tasks');
    expect(out.steps[0].api.requestData.httpData.method).toBe('GET');
    expect(out.steps[0].api.assertions).toHaveLength(3);
    expect(out.steps[0].api.assertions[2]).toMatchObject({ path: 'responseTime', condition: 'LESS_THAN', expectedValue: '3000' });
  });

  test('a non-API step is refused, naming it — nothing is saved', async () => {
    const web = { n: 1, description: 'click', actionType: '11', stepType: 'web' } as any;
    const { a, saved } = fake([web]);
    await expect(a.editJournal('TC_42', [{ op: 'add_assertions', n: 1, assertions: [{ path: 'statusCode', condition: 'EQUALS', expectedValue: '200' }] }]))
      .rejects.toThrow(/step 1 .*not an API step/);
    expect(saved()).toBeUndefined();
  });

  test('draft: add_assertions appends to the API step in place', () => {
    const store = new DraftStore();
    const id = store.create({ title: 't', priority: 'medium', category: 'automated', steps: [fromSqaStep(storedApiStep(), 1)] } as any);
    store.applyOps(id, [{ op: 'add_assertions', n: 1, assertions: [{ path: 'responseSize', condition: 'LESS_THAN', expectedValue: 5000 }] }] as any);
    const d: any = store.get(id)!;
    expect(d.tc.steps[0].api.requestData.httpData.url).toBe('https://api.example.com/tasks');
    expect(d.tc.steps[0].api.assertions).toHaveLength(3);
  });
});
