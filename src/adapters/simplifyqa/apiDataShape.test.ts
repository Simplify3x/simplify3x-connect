import { buildTestcasePayload, fromSqaStep } from './mapper.js';

const save = (
  step: Record<string, unknown>,
  paramIdByName = new Map<string, number>(),
  resolutions: Array<{ actionId: number | null; objectId: number | null }> = [{ actionId: null, objectId: null }],
) => (buildTestcasePayload({
  projectId: 19, moduleId: 7, existingId: '42',
  tc: { id: 'TC_42', title: 't', priority: 'medium', category: 'automated', steps: [step] } as any,
  paramIdByName, stepResolutions: resolutions,
} as any) as any).steps.automationSteps[0];

describe('a saved API step always carries the full editor shape', () => {
  test('a minimal request is filled with requestStyle / arrays / authorization / body', () => {
    const out = save({
      n: 1, description: 'GET user', actionType: '', stepType: 'api',
      api: { requestData: { httpData: { url: 'https://x/1', method: 'GET' } } },
    });
    const a = out.apiData;
    expect(a.requestStyle).toBe('HTTP');
    expect(a.requestData.grpcData).toEqual({});
    expect(a.requestData.httpData.url).toBe('https://x/1');
    expect(a.requestData.httpData.method).toBe('GET');
    expect(a.requestData.httpData.query_params).toEqual([]);
    expect(a.requestData.httpData.headers).toEqual([]);
    expect(a.requestData.httpData.authorization.type).toBe('NO_AUTHORIZATION');
    expect(a.requestData.httpData.body.type).toBe('NONE');
    expect(a.inputParameters).toEqual([]);
    expect(a.responseParameters).toEqual([]);
    expect(a.assertions).toEqual([]);
  });

  test('a parameter bound only through recordedParam still shows in inputParameters', () => {
    const out = save({
      n: 1, description: 'GET user', actionType: '', stepType: 'api',
      api: { requestData: { httpData: { url: 'https://x/1', method: 'GET' } } },
      recordedParam: { api_key: 'k' },
    }, new Map([['api_key', 99]]));
    expect(out.parameterIds).toEqual([99]);
    expect(out.apiData.inputParameters).toEqual([
      { id: 99, name: 'api_key', parameterAccessType: 'LOCAL', parameterDataType: 'ALPHANUMERIC', runtimeParameterKey: 'NONE' },
    ]);
  });

  test('a round-tripped numeric parameter keeps its inputParameters entry', () => {    const apiData = {
      requestStyle: 'HTTP',
      requestData: { httpData: { url: 'https://x/users/{{2124}}', method: 'GET', query_params: [], headers: [], body: { type: 'NONE' } } },
      inputParameters: [{ id: 2124, name: 'products_heading', parameterAccessType: 'LOCAL', parameterDataType: 'ALPHANUMERIC', runtimeParameterKey: 'NONE' }],
      responseParameters: [],
      assertions: [],
    };
    const step = fromSqaStep({
      id: 's1', seq: 1, description: 'GET user', stepType: 'API', technologyType: 'API', actionId: null,
      parameterIds: [2124], recordedParam: { '2124': 'Products' }, apiData,
    }, 1);
    const out = save(step, new Map());
    expect(out.parameterIds).toContain(2124);
    expect(out.apiData.inputParameters.map((p: any) => p.id)).toContain(2124);
    expect(out.apiData.inputParameters.find((p: any) => p.id === 2124).name).toBe('products_heading');
  });
});

describe('a request parameter backed by a RUNTIME parameter is saved as RUNTIME', () => {
  const saveWith = (step: Record<string, unknown>, names: Map<string, number>, access: Map<number, string>) =>
    (buildTestcasePayload({
      projectId: 19, moduleId: 7, existingId: '42',
      tc: { id: 'TC_42', title: 't', priority: 'medium', category: 'automated', steps: [step] } as any,
      paramIdByName: names, paramAccessById: access, stepResolutions: [{ actionId: null, objectId: null }],
    } as any) as any).steps.automationSteps[0];

  test('the catalog type decides — execution substitutes the value stored by an earlier step', () => {
    const out = saveWith({
      n: 1, description: 'POST fallout', actionType: '', stepType: 'api',
      api: { requestData: { httpData: { url: 'https://x/publish/{{casegroupname}}', method: 'POST' } } },
    }, new Map([['casegroupname', 501]]), new Map([[501, 'RUNTIME']]));
    expect(out.parameterIds).toEqual([501]);
    expect(out.apiData.inputParameters[0]).toMatchObject({ id: 501, name: 'casegroupname', parameterAccessType: 'RUNTIME' });
  });

  test('an existing LOCAL entry is upgraded to RUNTIME when the catalog says Runtime', () => {
    const out = saveWith({
      n: 1, description: 'POST fallout', actionType: '', stepType: 'api',
      api: {
        requestData: { httpData: { url: 'https://x/publish/{{casegroupname}}', method: 'POST' } },
        inputParameters: [{ id: 501, name: 'casegroupname', parameterAccessType: 'LOCAL' }],
      },
    }, new Map([['casegroupname', 501]]), new Map([[501, 'RUNTIME']]));
    expect(out.apiData.inputParameters).toEqual([{ id: 501, name: 'casegroupname', parameterAccessType: 'RUNTIME' }]);
  });

  test('a LOCAL catalog parameter stays LOCAL', () => {
    const out = saveWith({
      n: 1, description: 'GET', actionType: '', stepType: 'api',
      api: { requestData: { httpData: { url: 'https://x/{{api_key}}', method: 'GET' } } },
    }, new Map([['api_key', 502]]), new Map([[502, 'LOCAL']]));
    expect(out.apiData.inputParameters[0].parameterAccessType).toBe('LOCAL');
  });
});
