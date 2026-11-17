import { SimplifyQaAdapter } from './adapter.js';

/** db-17 "Read Documents": Database Name, Collection Name, Filter are inputs; the 4th slot stores the result. */
const READ_DOCS = {
  id: 117, name: 'readDocuments', uniqueId: 'db-17',
  parameters: [
    { name: 'Database Name', type: 'String', runtimeParameter: false },
    { name: 'Collection Name', type: 'String', runtimeParameter: false },
    { name: 'Filter', type: 'String', runtimeParameter: false },
    { name: 'Runtime Parameter', type: 'Runtime', runtimeParameter: true },
  ],
};

function harness(actionSearch: () => any) {
  const created: any[] = [];
  let next = 800;
  const calls: string[] = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.requireProjectId = () => 19;
  a.http = {
    postJson: async (path: string, body: any) => {
      calls.push(path);
      if (path === '/tm/action/search') return actionSearch();
      if (path === '/tm/parameter/search') return { data: [] };
      if (path === '/tm/parameter') { created.push(body); return { id: String(next++) }; }
      throw new Error(`unexpected ${path}`);
    },
  };
  return { a, created, calls };
}

const readStep = (recordedParam: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  n: 1, description: 'Read documents', actionType: 'readDocuments', actionUniqueId: 'db-17', stepType: 'database' as const,
  recordedParam, ...extra,
});
const tc = (steps: any[]) => ({ title: 't', priority: 'medium', category: 'automated', steps });
const typeOf = (created: any[], name: string) => created.find((c) => c.name === name)?.type;

describe('Runtime store slot is derived from the action when the step does not declare it', () => {
  test('the empty value in the action\'s Runtime slot becomes a Runtime parameter; inputs stay Local', async () => {
    const { a, created } = harness(() => ({ data: [READ_DOCS] }));
    await a.resolveParamIds(19, 1, tc([readStep({ db_name: 'QA_PM', coll: 'task', flt: '{}', task_doc: '' })]));
    expect(typeOf(created, 'task_doc')).toBe('Runtime');
    expect(typeOf(created, 'db_name')).toBe('Local');
    expect(typeOf(created, 'coll')).toBe('Local');
    expect(typeOf(created, 'flt')).toBe('Local');
  });

  test('a value in the Runtime slot position is never treated as a store target', async () => {
    const { a, created } = harness(() => ({ data: [READ_DOCS] }));
    await a.resolveParamIds(19, 1, tc([readStep({ db_name: 'QA_PM', coll: 'task', flt: '{}', odd: 'has a value' })]));
    expect(typeOf(created, 'odd')).toBe('Local');
  });

  test('an explicit runtimeParameters still wins and is merged', async () => {
    const { a, created } = harness(() => ({ data: [READ_DOCS] }));
    await a.resolveParamIds(19, 1, tc([readStep({ db_name: 'QA_PM', coll: 'task', flt: '{}', task_doc: '' }, { runtimeParameters: ['extra'] })]));
    expect(typeOf(created, 'task_doc')).toBe('Runtime');
  });

  test('also resolves by action name when no uniqueId is given', async () => {
    const { a, created } = harness(() => ({ data: [READ_DOCS] }));
    await a.resolveParamIds(19, 1, tc([readStep({ db_name: 'QA_PM', coll: 'task', flt: '{}', task_doc: '' }, { actionUniqueId: undefined })]));
    expect(typeOf(created, 'task_doc')).toBe('Runtime');
  });

  test('if the action lookup fails, behaviour is exactly as before (Local unless declared)', async () => {
    const { a, created } = harness(() => { throw new Error('column not allowed'); });
    await a.resolveParamIds(19, 1, tc([readStep({ db_name: 'QA_PM', coll: 'task', flt: '{}', task_doc: '' })]));
    expect(typeOf(created, 'task_doc')).toBe('Local');
    const h2 = harness(() => { throw new Error('x'); });
    await h2.a.resolveParamIds(19, 1, tc([readStep({ task_doc: '' }, { runtimeParameters: ['task_doc'] })]));
    expect(typeOf(h2.created, 'task_doc')).toBe('Runtime');
  });

  test('non-database steps never trigger the lookup', async () => {
    const { a, calls } = harness(() => ({ data: [READ_DOCS] }));
    await a.resolveParamIds(19, 1, tc([{ n: 1, description: 'x', actionType: 'Type Text', stepType: 'web', recordedParam: { value: 'hi' } }]));
    expect(calls).not.toContain('/tm/action/search');
  });
});
