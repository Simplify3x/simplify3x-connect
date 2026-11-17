import { SimplifyQaAdapter } from './adapter.js';
import { apiTransportFailure, dbFailureHint, emptyReadWarning, unresolvedPlaceholders } from './stepDiagnostics.js';

describe('apiTransportFailure', () => {
  test('recognises the made-up 503 for a request that got no response', () => {
    expect(apiTransportFailure({ responseData: { statusCode: 503, responseBody: 'Could not send request  Connect to x:1 failed: Connection refused', responseHeaders: {} } }))
      .toBe('Connect to x:1 failed: Connection refused');
  });
  test('recognises the made-up 500 for any other exception', () => {
    expect(apiTransportFailure({ responseData: { statusCode: 500, responseBody: 'Unexpected error occurred: bad url' } })).toBe('bad url');
  });
  test('a REAL server error is never flagged (it has response headers, or a different body)', () => {
    expect(apiTransportFailure({ responseData: { statusCode: 503, responseBody: 'Could not send request  x', responseHeaders: { server: 'nginx' } } })).toBeUndefined();
    expect(apiTransportFailure({ responseData: { statusCode: 500, responseBody: '{"error":"boom"}', responseHeaders: {} } })).toBeUndefined();
    expect(apiTransportFailure({ responseData: { statusCode: 404, responseBody: 'Could not send request', responseHeaders: {} } })).toBeUndefined();
    expect(apiTransportFailure(undefined)).toBeUndefined();
    expect(apiTransportFailure({})).toBeUndefined();
  });
});

describe('dbFailureHint', () => {
  test('a driver call on a missing connection (raw helpful-NPE text) is explained', () => {
    const npe = 'ERROR Fail to executeQuery : Cannot invoke "com.simplifyqa.db.execution.sql.ISQLDriver.executeQuery(String)" because "this.sqlDriver" is null';
    expect(dbFailureHint(npe)).toMatch(/no active database connection/i);
    expect(dbFailureHint('Cannot invoke "x.y.Z.m()" because "this.mongoDriver" is null')).toMatch(/connect/i);
  });
  test('"Fail to <action> : null" and invalid-JSON filters are explained', () => {
    expect(dbFailureHint('ERROR Fail to readData : null')).toMatch(/without an error message/i);
    expect(dbFailureHint('Invalid JSON input. Position: 12')).toMatch(/\{\{name\}\}/);
  });
  test('anything else is left alone', () => {
    expect(dbFailureHint('Access denied for user root')).toBeUndefined();
    expect(dbFailureHint('Fail to connectToDb : Communications link failure')).toBeUndefined();
    expect(dbFailureHint(undefined)).toBeUndefined();
  });
});

describe('unresolvedPlaceholders / emptyReadWarning', () => {
  test('finds ${name} left in a value, ignores {{name}} and protected values', () => {
    expect(unresolvedPlaceholders([{ paramName: 'filter', value: '{"n":"a-${task_suffix}-${x}"}' }])).toEqual(['task_suffix', 'x']);
    expect(unresolvedPlaceholders([{ paramName: 'filter', value: '{"n":"a-{{task_suffix}}"}' }])).toEqual([]);
    expect(unresolvedPlaceholders([{ paramName: 'pw', value: '${secret}', protected: true }])).toEqual([]);
    expect(unresolvedPlaceholders(undefined)).toEqual([]);
  });
  test('an empty list stored by a read step is flagged; other steps and non-empty results are not', () => {
    expect(emptyReadWarning('Read documents from Collection Name', [{ paramName: 'task_doc', value: '[]' }])).toMatch(/task_doc/);
    expect(emptyReadWarning('Read documents from Collection Name', [{ paramName: 'task_doc', value: '["{}"]' }])).toBeUndefined();
    expect(emptyReadWarning('Verify value in key', [{ paramName: 'task_doc', value: '[]' }])).toBeUndefined();
    expect(emptyReadWarning('Read documents', undefined)).toBeUndefined();
  });
});

describe('run_status step results carry the diagnostics', () => {
  const adapterWith = (docs: any[]) => {
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.http = { postJson: async () => ({ data: docs }) };
    return a;
  };
  const noResponse = { responseData: { statusCode: 503, responseBody: 'Could not send request  Connection refused', responseHeaders: {} } };

  test('a PASSED API step with no response gets a warning but stays passed', async () => {
    const steps = await adapterWith([{ seq: 1, description: 'GET /x', status: 'PASSED', apiData: noResponse }]).fetchStepResults(1, 'r', 0, 25);
    expect(steps[0].status).toBe('passed');
    expect(steps[0].warning).toMatch(/no response/i);
    expect(steps[0].error).toBeUndefined();
  });
  test('a FAILED API step with no response says why', async () => {
    const steps = await adapterWith([{ seq: 1, description: 'GET /x', status: 'FAILED', apiData: noResponse }]).fetchStepResults(1, 'r', 0, 25);
    expect(steps[0].error).toContain('Could not send request: Connection refused');
  });
  test('a PASSED API step with a REAL 404 is untouched', async () => {
    const steps = await adapterWith([{ seq: 1, description: 'GET /x', status: 'PASSED',
      apiData: { responseData: { statusCode: 404, responseBody: 'nf', responseHeaders: { server: 'x' } } } }]).fetchStepResults(1, 'r', 0, 25);
    expect(steps[0].warning).toBeUndefined();
  });
  test('a FAILED DB step with a raw NPE message gets the hint appended; the original text is kept', async () => {
    const npe = 'Cannot invoke "x.ISQLDriver.executeQuery(String)" because "this.sqlDriver" is null';
    const steps = await adapterWith([{ seq: 2, description: 'Run query', status: 'FAILED', exception: npe }]).fetchStepResults(1, 'r', 0, 25);
    expect(steps[0].error).toContain(npe);
    expect(steps[0].error).toMatch(/no active database connection/i);
  });
  test('a PASSED read that stored [] and an unresolved ${param} both warn', async () => {
    const steps = await adapterWith([{ seq: 3, description: 'Read documents from Collection Name', status: 'PASSED',
      testdata: [{ paramName: 'filter', value: '{"n":"x-${task_suffix}"}' }, { paramName: 'task_doc', value: '[]' }] }]).fetchStepResults(1, 'r', 0, 25);
    expect(steps[0].warning).toMatch(/empty result/);
    expect(steps[0].warning).toMatch(/task_suffix/);
    expect(steps[0].status).toBe('passed');
  });
  test('ordinary passed/failed steps are unchanged (no regression)', async () => {
    const steps = await adapterWith([
      { seq: 1, description: 'Click', status: 'PASSED' },
      { seq: 2, description: 'Type', status: 'FAILED', exception: 'NoSuchElementException' },
    ]).fetchStepResults(1, 'r', 0, 25);
    expect(steps[0]).toEqual({ n: 1, description: 'Click', status: 'passed' });
    expect(steps[1].error).toBe('NoSuchElementException');
    expect(steps[1].warning).toBeUndefined();
  });
});
