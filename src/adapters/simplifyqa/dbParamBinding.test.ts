import { SimplifyQaAdapter } from './adapter.js';
import { bindValueParams, buildTestcasePayload, extractValueParamNames } from './mapper.js';

const FILTER = '{"name":"Taks new fromAPI_2-${task_suffix}"}';

describe('bindValueParams', () => {
  const ids = new Map([['task_suffix', 12], ['other', 13], ['filter', 10]]);

  test('rewrites ${name} to {{name}} and returns the id', () => {
    expect(bindValueParams(FILTER, ids, 'filter')).toEqual({ value: '{"name":"Taks new fromAPI_2-{{task_suffix}}"}', ids: [12] });
  });
  test('keeps an existing {{name}}, handles several, dedupes', () => {
    expect(bindValueParams('{{task_suffix}} ${other} ${task_suffix}', ids)).toEqual({ value: '{{task_suffix}} {{other}} {{task_suffix}}', ids: [12, 13] });
  });
  test('leaves unknown names, bound numeric ids, the argument\'s own name and plain JSON alone', () => {
    expect(bindValueParams('${nope} {{77}} ${filter}', ids, 'filter')).toEqual({ value: '${nope} {{77}} ${filter}', ids: [] });
    expect(bindValueParams('{"a":{"b":{"$in":[1]}}}', ids)).toEqual({ value: '{"a":{"b":{"$in":[1]}}}', ids: [] });
  });
  test('extractValueParamNames finds both forms, skips numeric ids and non-strings', () => {
    expect(extractValueParamNames('${a} {{b}} {{12}} ${a}')).toEqual(['a', 'b']);
    expect(extractValueParamNames(undefined)).toEqual([]);
  });
});

describe('DATABASE step save payload', () => {
  const build = (stepType: 'database' | 'web', extra: Record<string, unknown> = {}) => buildTestcasePayload({
    projectId: 19, moduleId: 1, userstoryId: undefined, existingId: undefined,
    tc: {
      title: 't', priority: 'medium', category: 'automated',
      steps: [{ n: 1, description: 'Read documents', actionType: 'readDocuments', stepType, recordedParam: { filter: FILTER, task_doc: '' }, runtimeParameters: ['task_doc'], ...extra }],
    } as any,
    paramIdByName: new Map([['filter', 10], ['task_doc', 11], ['task_suffix', 12]]),
    stepResolutions: [{ actionId: 1, objectId: null }],
  } as any) as any;

  test('the filter is bound: {{task_suffix}} in the value, its id in parameterizedParamIds', () => {
    const step = build('database').steps.automationSteps[0];
    expect(step.recordedParam['10']).toBe('{"name":"Taks new fromAPI_2-{{task_suffix}}"}');
    expect(step.parameterizedParamIds).toEqual([12]);
    // the step's own arguments are untouched and in the same order — the referenced param is not one of them
    expect(step.parameterIds).toEqual([10, 11]);
  });

  test('round-tripped parameterizedParamIds are kept and merged', () => {
    const step = build('database', { sourceRaw: { parameterizedParamIds: [99] } }).steps.automationSteps[0];
    expect(step.parameterizedParamIds).toEqual([99, 12]);
  });

  test('non-database steps are unchanged (no regression)', () => {
    const step = build('web').steps.automationSteps[0];
    expect(step.recordedParam['10']).toBe(FILTER);
    expect(step.parameterizedParamIds).toBeUndefined();
  });
});

describe('DATABASE save: referenced parameters are created', () => {
  test('${task_suffix} inside a filter creates the parameter (Runtime when a step stores into it)', async () => {
    const created: any[] = [];
    let next = 700;
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.http = {
      postJson: async (path: string, body: any) => {
        if (path === '/tm/parameter/search') return { data: [] };
        if (path === '/tm/parameter') { created.push(body); return { id: String(next++) }; }
        throw new Error(`unexpected ${path}`);
      },
    };
    const ids = await a.resolveParamIds(19, 1, {
      title: 't', priority: 'medium', category: 'automated',
      steps: [
        { n: 1, description: 'store', actionType: 'storeValue', stepType: 'database', recordedParam: { out: '' }, runtimeParameters: ['task_suffix'] },
        { n: 2, description: 'read', actionType: 'readDocuments', stepType: 'database', recordedParam: { filter: FILTER } },
      ],
    });
    expect(ids.has('task_suffix')).toBe(true);
    expect(created.filter((c) => c.name === 'task_suffix')).toHaveLength(1);
    expect(created.find((c) => c.name === 'task_suffix').type).toBe('Runtime');
  });

  test('non-database steps do not create parameters from value text', async () => {
    const created: any[] = [];
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.http = {
      postJson: async (path: string, body: any) => {
        if (path === '/tm/parameter/search') return { data: [] };
        created.push(body); return { id: '1' };
      },
    };
    await a.resolveParamIds(19, 1, {
      title: 't', priority: 'medium', category: 'automated',
      steps: [{ n: 1, description: 'x', actionType: 'Type Text', stepType: 'web', recordedParam: { value: '${nope}' } }],
    });
    expect(created.map((c) => c.name)).toEqual(['value']);
  });
});
