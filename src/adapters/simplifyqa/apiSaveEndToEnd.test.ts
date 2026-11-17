import { SimplifyQaAdapter } from './adapter.js';

/** An API test case driven through the REAL createTestCase against a stateful fake backend, then its stored step
 *  documents (as the agent reports them) read back through run_status's fetchStepResults. */
function backend() {
  const params: any[] = [];
  let nextId = 950;
  let saved: any;
  const a: any = new SimplifyQaAdapter({
    mode: 'connected', provider: 'simplifyqa', token: 't', projectId: '19', baseUrl: 'http://backend', walnutAuth: 'key', caps: new Set(),
  } as any);
  a.http = {
    postJson: async (path: string, body: any) => {
      if (path === '/tm/action/search') return { data: [{ id: 1, name: 'executeRestApi', objectRequired: false }] };
      if (path === '/tm/parameter/search') {
        const name = body.searchFields.find((f: any) => f.column === 'name')?.value;
        return { data: params.filter((p) => p.name.toLowerCase() === String(name).toLowerCase()) };
      }
      if (path === '/tm/parameter') { const p = { ...body, id: nextId++ }; params.push(p); return { id: String(p.id) }; }
      throw new Error(`unexpected POST ${path}`);
    },
    postMultipart: async (_p: string, _f: string, payload: any) => { saved = payload; return { id: 2, code: 'TC-2' }; },
    getJson: async (path: string) => { throw new Error(`unexpected GET ${path}`); },
  };
  return { a, params, saved: () => saved };
}

const apiTc = () => ({
  title: 'GET user', priority: 'medium', category: 'automated', folderOrModule: '7',
  steps: [{
    n: 1, description: 'GET /users/{{user_id}}', stepType: 'api',
    api: {
      requestStyle: 'HTTP',
      requestData: { httpData: {
        url: 'https://api.example.com/users/{{user_id}}', method: 'GET',
        headers: [{ key: 'Authorization', value: 'Bearer {{api_token}}' }],
        body: { type: 'NONE' },
      } },
      assertions: [
        { path: 'statusCode', condition: 'EQUALS', expectedValue: '200' },
        { path: '$.body.id', condition: 'EQUALS', expectedValue: '7' },
      ],
    },
  }],
});

describe('API test case save, end to end inside MCP', () => {
  test('tokens are bound to parameter ids, assertions are normalised, the step is action-less API', async () => {
    const { a, params, saved } = backend();
    await a.createTestCase(apiTc());
    const step = saved().steps.automationSteps[0];
    const id = (n: string) => params.find((p) => p.name === n).id;

    expect(step.stepType).toBe('API');
    expect(step.actionId).toBeNull();
    const http = step.apiData.requestData.httpData;
    expect(http.url).toBe(`https://api.example.com/users/{{${id('user_id')}}}`);
    expect(http.headers[0].value).toBe(`Bearer {{${id('api_token')}}}`);
    expect(step.parameterIds).toEqual([id('user_id'), id('api_token')]);
    expect(step.apiData.inputParameters.map((p: any) => p.name)).toEqual(['user_id', 'api_token']);
    expect(params.find((p) => p.name === 'api_token').protected).toBe(true);   // secret-looking name is masked

    // assertions: bare names stay, $.body.* becomes response.*
    expect(step.apiData.assertions.map((x: any) => x.path)).toEqual(['statusCode', 'response.id']);
    // nothing DB-specific leaks into an API step
    expect(step.parameterizedParamIds).toBeUndefined();
  });
});

describe('API run results read back through run_status', () => {
  const stepsFrom = (docs: any[]) => {
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.http = { postJson: async () => ({ data: docs }) };
    return a.fetchStepResults(1, 'r', 0, 19);
  };
  const assertion = (status: string) => ({ path: 'statusCode', condition: 'EQUALS', expectedValue: '200', actualValue: '404', status });

  test('a failed assertion names what was expected and what came back', async () => {
    const [s] = await stepsFrom([{ seq: 1, description: 'GET', status: 'FAILED', apiData: {
      assertions: [assertion('FAILED')], responseData: { statusCode: 404, responseTime: 80, responseBody: '{"e":"nf"}', responseHeaders: { server: 'x' } } } }]);
    expect(s.error).toContain('assertion failed: statusCode equals expected "200", actual "404"');
    expect(s.warning).toBeUndefined();
  });

  test('a request that got no response: failed → reason; passed → warning, status untouched', async () => {
    const noResp = { responseData: { statusCode: 503, responseBody: 'Could not send request  Connection refused', responseHeaders: {} } };
    const [failed] = await stepsFrom([{ seq: 1, description: 'GET', status: 'FAILED', apiData: noResp }]);
    expect(failed.error).toContain('Could not send request: Connection refused');
    const [passed] = await stepsFrom([{ seq: 1, description: 'GET', status: 'PASSED', apiData: noResp }]);
    expect(passed.status).toBe('passed');
    expect(passed.warning).toMatch(/no response/i);
  });

  test('a normal passing call and a real 404 that nothing asserts on stay clean', async () => {
    const [ok, notFound] = await stepsFrom([
      { seq: 1, description: 'GET', status: 'PASSED', apiData: { assertions: [assertion('PASSED')], responseData: { statusCode: 200, responseHeaders: { server: 'x' } } } },
      { seq: 2, description: 'GET', status: 'PASSED', apiData: { responseData: { statusCode: 404, responseBody: 'nf', responseHeaders: { server: 'x' } } } },
    ]);
    expect(ok.warning).toBeUndefined();
    expect(notFound.warning).toBeUndefined();
    expect(notFound.status).toBe('passed');
  });
});
