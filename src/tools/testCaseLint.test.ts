import { lintAutomatedTestCase, lintBlock } from './testCaseLint.js';

const tc = (steps: any[], data: Record<string, string> = {}): any => ({ title: 't', priority: 'medium', category: 'automated', steps, data });
const db = (n: number, actionType: string, recordedParam: Record<string, string> = {}, extra: any = {}) =>
  ({ n, description: actionType, actionType, stepType: 'database', recordedParam, ...extra });
const api = (n: number, url: string, assertions: any[] = [{ path: 'statusCode', condition: 'EQUALS', expectedValue: '200' }], extra: any = {}) =>
  ({ n, description: 'call', stepType: 'api', api: { requestData: { httpData: { url, method: 'GET' } }, assertions, ...extra } });

describe('DB checks', () => {
  test('a DB action before any connect step is flagged once', () => {
    const w = lintAutomatedTestCase(tc([db(1, 'executeQuery', { q: 'select 1' }), db(2, 'readData', { t: 'x' })]));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/step 1.*no "Connect" step before it/);
  });
  test('connect first → no warning; a function call may hide the connect → no warning', () => {
    expect(lintAutomatedTestCase(tc([db(1, 'connectToMongoDb'), db(2, 'readDocuments', { c: 'task' })]))).toEqual([]);
    expect(lintAutomatedTestCase(tc([{ n: 1, description: 'f', stepType: 'function', actionType: 'x' }, db(2, 'readDocuments', { c: 'task' })]))).toEqual([]);
  });
  test('a parameter used in a value but never set or stored is flagged; set in data, or stored earlier, is not', () => {
    const read = db(2, 'readDocuments', { filter: '{"n":"a-${task_suffix}"}' });
    expect(lintAutomatedTestCase(tc([db(1, 'connectToDb'), read]))[0]).toMatch(/task_suffix is not set/);
    expect(lintAutomatedTestCase(tc([db(1, 'connectToDb'), read], { task_suffix: 'x' }))).toEqual([]);
    const store = db(0, 'readDocuments', { out: '' }, { runtimeParameters: ['task_suffix'] });
    expect(lintAutomatedTestCase(tc([db(1, 'connectToDb'), store, read]))).toEqual([]);
  });
  test('a parameter an earlier step of another kind may have set (API response, web store) is not flagged', () => {
    const read = db(3, 'readDocuments', { filter: '{"n":"a-${task_suffix}"}' });
    const toDb = { n: 0, description: 'Switch', stepType: 'control_flow', controlFlow: { kind: 'SWITCH_TO_DB' } };
    expect(lintAutomatedTestCase(tc([api(1, 'https://x/create'), toDb, db(2, 'connectToDb'), read]))).toEqual([]);
  });
  test('a value that refers to its own argument name is not flagged', () => {
    expect(lintAutomatedTestCase(tc([db(1, 'connectToDb'), db(2, 'readDocuments', { filter: '{{filter}}' })]))).toEqual([]);
  });
});

describe('API checks', () => {
  test('a URL without a scheme, and a step with no assertions, are flagged', () => {
    const w = lintAutomatedTestCase(tc([api(1, 'api.example.com/users', [])]));
    expect(w.some((x) => /no http:\/\/ or https:\/\//.test(x))).toBe(true);
    expect(w.some((x) => /no assertions/.test(x))).toBe(true);
  });
  test('a good API step is clean; a {{token}} URL prefix is allowed', () => {
    expect(lintAutomatedTestCase(tc([api(1, 'https://api.example.com/users')]))).toEqual([]);
    expect(lintAutomatedTestCase(tc([api(1, '{{base_url}}/users')], { base_url: 'https://x' }))).toEqual([]);
  });
  test('an unset {{token}} in the request is flagged', () => {
    expect(lintAutomatedTestCase(tc([api(1, 'https://x/users/{{user_id}}')]))[0]).toMatch(/user_id is not set/);
  });
});

describe('technology switch', () => {
  const sw = (kind: string) => ({ n: 0, description: 'Switch', stepType: 'control_flow', controlFlow: { kind } });
  test('API step followed by DB steps with no switch is flagged once, naming the step kind to add', () => {
    const w = lintAutomatedTestCase(tc([api(1, 'https://x/a'), db(2, 'connectToDb'), db(3, 'readData', { t: 'x' })]));
    const sws = w.filter((x) => /SWITCH_TO_DB/.test(x));
    expect(sws).toHaveLength(1);
    expect(sws[0]).toMatch(/step 2.*active technology at this point is API/);
  });
  test('with a SWITCH_TO_DB step in between there is no switch warning (and no connect warning either)', () => {
    expect(lintAutomatedTestCase(tc([api(1, 'https://x/a'), sw('SWITCH_TO_DB'), db(2, 'connectToDb'), db(3, 'readData', { t: 'x' })])).filter((x) => /SWITCH_TO/.test(x))).toEqual([]);
  });
  test('switching back to API after DB needs SWITCH_TO_API', () => {
    const w = lintAutomatedTestCase(tc([db(1, 'connectToDb'), api(2, 'https://x/a'), db(3, 'readData', { t: 'x' })]));
    expect(w.some((x) => /step 2.*SWITCH_TO_API/.test(x))).toBe(true);
    expect(w.some((x) => /step 3.*SWITCH_TO_DB/.test(x))).toBe(true);
  });
  test('a single-technology test case, or one with a function call, is never flagged for switching', () => {
    expect(lintAutomatedTestCase(tc([db(1, 'connectToDb'), db(2, 'readData', { t: 'x' })])).filter((x) => /SWITCH_TO/.test(x))).toEqual([]);
    const fn = { n: 1, description: 'f', stepType: 'function', actionType: 'x' };
    expect(lintAutomatedTestCase(tc([api(0, 'https://x/a'), fn, db(2, 'connectToDb')])).filter((x) => /SWITCH_TO/.test(x))).toEqual([]);
  });
});

describe('everything else is left alone', () => {
  test('web / manual steps and empty test cases produce nothing', () => {
    expect(lintAutomatedTestCase(tc([{ n: 1, description: 'c', stepType: 'web', actionType: 'Click', recordedParam: { v: '${x}' } }]))).toEqual([]);
    expect(lintAutomatedTestCase(tc([]))).toEqual([]);
  });
  test('lintBlock is empty without warnings and lists them otherwise', () => {
    expect(lintBlock([])).toBe('');
    expect(lintBlock(['a', 'b'])).toContain('2 thing(s)');
  });
});
