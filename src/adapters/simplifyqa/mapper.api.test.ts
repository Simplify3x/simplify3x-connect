import { buildTestcasePayload, extractApiParamNames } from './mapper.js';
import type { Step, TestCase } from '../../domain/types.js';

const apiStep: Step = {
  n: 1,
  description: 'POST Request',
  expectedResult: 'Status code is 200',
  actionType: '',
  stepType: 'api',
  api: {
    requestStyle: 'HTTP',
    requestData: {
      httpData: {
        url: 'https://qa.simplifyqa.com/pm/task',
        method: 'POST',
        headers: [{ key: 'Content-Type', value: 'application/json', active: true }],
        authorization: { type: 'BEARER_TOKEN', bearerToken: { value: '{{token}}' } },
        body: { type: 'JSON', data: { payload: '{"name":"Task-{{suffix}}"}' } },
      },
    },
    assertions: [{ path: 'status', condition: 'EQUALS', expectedValue: 200, caseSensitive: false }],
  },
};

function tc(steps: Step[]): TestCase {
  return { title: 'API - Create Task', priority: 'medium', category: 'automated', steps };
}

describe('buildTestcasePayload — API steps', () => {
  it('emits wire stepType "API" with actionId:null and the request payload', () => {
    const payload = buildTestcasePayload({
      projectId: 1, moduleId: 2, tc: tc([apiStep]),
      paramIdByName: new Map([['token', 11], ['suffix', 22]]),
      stepResolutions: [{ actionId: null, objectId: null }],
    });
    const step = (payload['steps'] as { automationSteps: Array<Record<string, unknown>> }).automationSteps[0]!;

    expect(step['stepType']).toBe('API');
    expect(step['technologyType']).toBe('API');
    expect(step['actionId']).toBeNull();
    expect(step['objectId']).toBeNull();
    expect((payload['tcfnObj'] as Record<string, unknown>)['tcType']).toBe('API');

    const api = step['apiData'] as Record<string, any>;
    expect(api['requestData']['httpData']['authorization']['bearerToken']['value']).toBe('{{11}}');
    expect(api['requestData']['httpData']['body']['data']['payload']).toContain('{{22}}');
    expect(api['assertions']).toHaveLength(1);
    expect(step['lastActiveTab']).toEqual({ mainTab: 'body', subTab: 'JSON' });
  });

  it('registers parameterIds, recordedParam and inputParameters from the request tokens', () => {
    const payload = buildTestcasePayload({
      projectId: 1, moduleId: 2,
      tc: { ...tc([apiStep]), data: { token: 'tkn-123', suffix: 'abc' } },
      paramIdByName: new Map([['token', 11], ['suffix', 22]]),
      stepResolutions: [{ actionId: null, objectId: null }],
    });
    const step = (payload['steps'] as { automationSteps: Array<Record<string, unknown>> }).automationSteps[0]!;

    expect(step['parameterIds']).toEqual(expect.arrayContaining([11, 22]));
    expect(step['recordedParam']).toEqual({ '11': 'tkn-123', '22': 'abc' });
    const inputIds = (step['apiData'] as Record<string, any>)['inputParameters'].map((p: any) => p.id).sort();
    expect(inputIds).toEqual([11, 22]);
  });


  it('resolves parameter names containing spaces (prefix value_4)', () => {
    const spaced: Step = JSON.parse(JSON.stringify(apiStep));
    (spaced.api as any).requestData.httpData.body.data.payload = '{"name":"{{prefix value_4}}"}';

    const payload = buildTestcasePayload({
      projectId: 1, moduleId: 2, tc: tc([spaced]),
      paramIdByName: new Map([['prefix value_4', 1274]]),
      stepResolutions: [{ actionId: null, objectId: null }],
    });
    const step = (payload['steps'] as { automationSteps: Array<Record<string, unknown>> }).automationSteps[0]!;
    const api = step['apiData'] as Record<string, any>;

    expect(api['requestData']['httpData']['body']['data']['payload']).toContain('{{1274}}');
    expect(step['parameterIds']).toContain(1274);
    const inputNames = (api['inputParameters'] as any[]).map((p) => p.name);
    expect(inputNames).toContain('prefix value_4');
  });


  it('translates live assertion paths to the API editor assertion shape', () => {
    const s: Step = JSON.parse(JSON.stringify(apiStep));
    (s.api as any).assertions = [
      { path: 'statusCode', condition: 'EQUALS', expectedValue: '200' },
      { path: '$.body.id', condition: 'GREATER_THAN', expectedValue: '0' },
      { path: '$.headers.Content-Type', condition: 'CONTAINS', expectedValue: 'application/json' },
    ];
    const payload = buildTestcasePayload({
      projectId: 1, moduleId: 2, tc: tc([s]),
      paramIdByName: new Map(), stepResolutions: [{ actionId: null, objectId: null }],
    });
    const step = (payload['steps'] as { automationSteps: Array<Record<string, unknown>> }).automationSteps[0]!;
    const assertions = (step['apiData'] as Record<string, any>)['assertions'] as any[];
    expect(assertions[0]).toEqual(expect.objectContaining({ path: 'statusCode', key: 'statusCode', caseSensitive: false }));
    expect(assertions[1]).toEqual(expect.objectContaining({ path: 'response.id', key: 'id', caseSensitive: false }));
    expect(assertions[2]).toEqual(expect.objectContaining({ path: 'responseHeaders.Content-Type', key: 'Content-Type', caseSensitive: false }));
  });

  it('leaves an unresolvable token untouched rather than dropping it', () => {
    const payload = buildTestcasePayload({
      projectId: 1, moduleId: 2, tc: tc([apiStep]),
      paramIdByName: new Map([['token', 11]]), // 'suffix' NOT resolved
      stepResolutions: [{ actionId: null, objectId: null }],
    });
    const step = (payload['steps'] as { automationSteps: Array<Record<string, unknown>> }).automationSteps[0]!;
    const api = step['apiData'] as Record<string, any>;
    expect(api['requestData']['httpData']['body']['data']['payload']).toContain('{{suffix}}');
  });
});

describe('extractApiParamNames', () => {
  it('collects nested {{name}} tokens', () => {
    expect(extractApiParamNames({ a: '{{x}}', b: { c: ['{{y}}', 'z'] } }).sort()).toEqual(['x', 'y']);
    expect(extractApiParamNames({ a: '{{prefix value_4}}' })).toEqual(['prefix value_4']);
  });
  it('ignores non-string values', () => {
    expect(extractApiParamNames({ n: 1, b: true, s: '{{p}}' })).toEqual(['p']);
  });
});
