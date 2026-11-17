import { SimplifyQaAdapter } from './adapter.js';

/**
 * The DB scenario from the failing run, driven through the REAL createTestCase (parameter get-or-create →
 * action resolution → payload build → POST /tm/testcase) against a stateful fake backend:
 *   connect to Mongo → read documents with a `${task_suffix}` filter, store into task_doc → verify task_doc.
 * The prompt gives NO `runtimeParameters` — MCP must work that out itself.
 */
const ACTIONS = [
  { id: 119, name: 'connectToMongoDb', uniqueId: 'db-19', objectRequired: false, parameters: [
    { name: 'Connection String', runtimeParameter: false }, { name: 'Database Name', runtimeParameter: false } ] },
  { id: 117, name: 'readDocuments', uniqueId: 'db-17', objectRequired: false, parameters: [
    { name: 'Database Name', runtimeParameter: false }, { name: 'Collection Name', runtimeParameter: false },
    { name: 'Filter', runtimeParameter: false }, { name: 'Runtime Parameter', type: 'Runtime', runtimeParameter: true } ] },
  { id: 130, name: 'verifyJsonValue', uniqueId: 'db-9', objectRequired: false, parameters: [
    { name: 'JSON', runtimeParameter: false }, { name: 'Key', runtimeParameter: false }, { name: 'Expected Value', runtimeParameter: false } ] },
];

function backend() {
  const params: any[] = [];
  let nextId = 900;
  let saved: any;
  const http = {
    postJson: async (path: string, body: any) => {
      if (path === '/tm/action/search') return { data: ACTIONS };
      if (path === '/tm/parameter/search') {
        const name = body.searchFields.find((f: any) => f.column === 'name')?.value;
        return { data: params.filter((p) => p.name.toLowerCase() === String(name).toLowerCase()) };
      }
      if (path === '/tm/parameter') { const p = { ...body, id: nextId++ }; params.push(p); return { id: String(p.id) }; }
      throw new Error(`unexpected POST ${path}`);
    },
    postMultipart: async (path: string, _field: string, payload: any) => {
      if (path !== '/tm/testcase') throw new Error(`unexpected multipart ${path}`);
      saved = payload;
      return { id: 1, code: 'TC-1' };
    },
    getJson: async (path: string) => { throw new Error(`unexpected GET ${path}`); },
  };
  const a: any = new SimplifyQaAdapter({
    mode: 'connected', provider: 'simplifyqa', token: 't', projectId: '19', baseUrl: 'http://backend', walnutAuth: 'key', caps: new Set(),
  } as any);
  a.http = http;
  return { a, params, saved: () => saved };
}

const FILTER = '{"name":"Taks new fromAPI_2-${task_suffix}"}';
const dbTc = () => ({
  title: 'DB read', priority: 'medium', category: 'automated', folderOrModule: '7',
  steps: [
    { n: 1, description: 'Connect to MongoDB', actionType: 'connectToMongoDb', actionUniqueId: 'db-19', stepType: 'database',
      recordedParam: { connection_string_2: 'mongodb://host/QA_PM', database_name_2: 'QA_PM' } },
    { n: 2, description: 'Read documents and store them in task_doc', actionType: 'readDocuments', actionUniqueId: 'db-17', stepType: 'database',
      recordedParam: { database_name_3: 'QA_PM', collection_name: 'task', filter: FILTER, task_doc: '' } },
    { n: 3, description: 'Verify state in task_doc', actionType: 'verifyJsonValue', actionUniqueId: 'db-9', stepType: 'database',
      recordedParam: { task_doc: '', key_5: 'state', expected_value_5: 'NEW' } },
  ],
});

describe('DB test case save, end to end inside MCP', () => {
  test('filter is bound, the store slot is Runtime, steps are wired to the same parameters', async () => {
    const { a, params, saved } = backend();
    await a.createTestCase(dbTc());
    const steps = saved().steps.automationSteps;
    const id = (name: string) => params.find((p) => p.name === name).id;

    // 1. the store slot is a Runtime parameter although the prompt never said so; inputs are Local
    expect(params.find((p) => p.name === 'task_doc').type).toBe('Runtime');
    expect(params.find((p) => p.name === 'filter').type).toBe('Local');
    expect(params.find((p) => p.name === 'collection_name').type).toBe('Local');
    expect(params.filter((p) => p.name === 'task_doc')).toHaveLength(1);   // step 3 reuses it, never duplicates it

    // 2. the read step: filter written as {{task_suffix}} and the parameter is bound
    const read = steps[1];
    expect(read.recordedParam[String(id('filter'))]).toBe('{"name":"Taks new fromAPI_2-{{task_suffix}}"}');
    expect(read.parameterizedParamIds).toEqual([id('task_suffix')]);
    expect(read.actionId).toBe(117);
    // the step's own arguments keep their order: db, collection, filter, store slot
    expect(read.parameterIds).toEqual([id('database_name_3'), id('collection_name'), id('filter'), id('task_doc')]);

    // 3. the verify step points at the SAME task_doc parameter
    expect(steps[2].parameterIds[0]).toBe(id('task_doc'));
    expect(steps[2].recordedParam[String(id('key_5'))]).toBe('state');

    // 4. neighbours are untouched
    expect(steps[0].parameterizedParamIds).toBeUndefined();
    expect(steps[2].parameterizedParamIds).toBeUndefined();
    expect(steps.map((s: any) => s.stepType)).toEqual(['NORMAL_STATEMENT', 'NORMAL_STATEMENT', 'NORMAL_STATEMENT']);
  });

  test('a placeholder like [] given to a store slot must not become its storage key (keys would collide, data reads back [])', async () => {
    const { a, params, saved } = backend();
    const tc: any = dbTc();
    tc.steps[1].recordedParam.task_doc = '[]';           // the prompt "initialises" the store slot
    // a second store slot elsewhere that does the same thing
    tc.steps.push({ n: 4, description: 'Read documents and store them in user_doc', actionType: 'readDocuments', actionUniqueId: 'db-17',
      stepType: 'database', recordedParam: { database_name_3: 'QA_PM', collection_name: 'user', filter: '{}', user_doc: '[]' } });
    await a.createTestCase(tc);
    const steps = saved().steps.automationSteps;
    const id = (n: string) => params.find((p) => p.name === n).id;

    for (const name of ['task_doc', 'user_doc']) {
      const p = params.find((x) => x.name === name);
      expect(p.type).toBe('Runtime');
      expect(p.defaultValue).toBe('');                    // not "[]"
    }
    expect(steps[1].recordedParam[String(id('task_doc'))]).toBe('');   // key = the parameter's own name
    expect(steps[3].recordedParam[String(id('user_doc'))]).toBe('');
    // real inputs are untouched — a filter of {} is a legitimate value, not a placeholder
    expect(steps[3].recordedParam[String(id('filter'))]).toBe('{}');
  });

  test('a deliberate storage key on a store slot is kept', async () => {
    const { a, saved, params } = backend();
    const tc: any = dbTc();
    tc.steps[1].recordedParam.task_doc = 'task_docs_key';
    tc.steps[1].runtimeParameters = ['task_doc'];
    await a.createTestCase(tc);
    expect(saved().steps.automationSteps[1].recordedParam[String(params.find((p) => p.name === 'task_doc').id)]).toBe('task_docs_key');
  });

  test('a prompt that already declares runtimeParameters and uses {{task_suffix}} saves the same way', async () => {
    const { a, params, saved } = backend();
    const tc: any = dbTc();
    tc.steps[1].runtimeParameters = ['task_doc'];
    tc.steps[1].recordedParam.filter = '{"name":"Taks new fromAPI_2-{{task_suffix}}"}';
    await a.createTestCase(tc);
    expect(params.find((p) => p.name === 'task_doc').type).toBe('Runtime');
    expect(saved().steps.automationSteps[1].parameterizedParamIds).toEqual([params.find((p) => p.name === 'task_suffix').id]);
  });

  test('a mixed API → DB test case can carry a SWITCH_TO_DB step (control_flow kind) that saves with no action', async () => {
    const { a, saved } = backend();
    const tc: any = dbTc();
    tc.steps.unshift({ n: 0, description: 'API call', stepType: 'api', api: { requestData: { httpData: { url: 'https://x/create', method: 'GET' } }, assertions: [{ path: 'statusCode', condition: 'EQUALS', expectedValue: '200' }] } });
    tc.steps.splice(1, 0, { n: 0, description: 'Switch to: DATABASE', stepType: 'control_flow', controlFlow: { kind: 'SWITCH_TO_DB' } });
    await a.createTestCase(tc);
    const steps = saved().steps.automationSteps;
    expect(steps.map((s: any) => s.stepType)).toEqual(['API', 'SWITCH_TO_DB', 'NORMAL_STATEMENT', 'NORMAL_STATEMENT', 'NORMAL_STATEMENT']);
    expect(steps[1].actionId == null).toBe(true);
  });

  test('a DB step with no parameter references saves exactly as before (no parameterizedParamIds, no extra parameters)', async () => {
    const { a, params, saved } = backend();
    const tc: any = dbTc();
    tc.steps[1].recordedParam.filter = '{"name":"fixed"}';
    await a.createTestCase(tc);
    expect(saved().steps.automationSteps[1].parameterizedParamIds).toBeUndefined();
    expect(params.find((p) => p.name === 'task_suffix')).toBeUndefined();
  });
});

describe('the module is saved as its ID, never as a name or a silent 0', () => {
  const modules = [{ id: '7', name: 'Login' }, { id: '8', name: 'Payments' }, { id: '9', name: 'Payments' }];
  const withModules = () => { const b = backend(); (b.a as any).listModules = async () => modules; return b; };

  test('a module NAME is resolved to its id', async () => {
    const { a, saved } = withModules();
    const tc: any = dbTc(); tc.folderOrModule = 'login';
    await a.createTestCase(tc);
    expect(saved().tcfnObj.moduleId).toBe(7);
    expect(saved().steps.automationSteps[0].moduleId).toBe(7);
  });
  test('a numeric id passes straight through', async () => {
    const { a, saved } = withModules();
    const tc: any = dbTc(); tc.folderOrModule = '8';
    await a.createTestCase(tc);
    expect(saved().tcfnObj.moduleId).toBe(8);
  });
  test('an unknown name is an error (it used to become module 0 = root, silently)', async () => {
    const { a } = withModules();
    const tc: any = dbTc(); tc.folderOrModule = 'No Such Module';
    await expect(a.createTestCase(tc)).rejects.toThrow(/not found in this project/);
  });
  test('an ambiguous name is an error that lists the ids', async () => {
    const { a } = withModules();
    const tc: any = dbTc(); tc.folderOrModule = 'Payments';
    await expect(a.createTestCase(tc)).rejects.toThrow(/matches 2 modules.*id 8.*id 9/);
  });
});
