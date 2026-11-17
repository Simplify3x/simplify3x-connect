import { apiFailureReason } from './apiFailureReason.js';
import { SimplifyQaAdapter } from './adapter.js';

describe('apiFailureReason', () => {
  test('a failed assertion names the field, the expectation and what came back, plus the HTTP status', () => {
    const why = apiFailureReason({
      assertions: [
        { path: 'statusCode', condition: 'EQUALS', expectedValue: '200', actualValue: '404', status: 'FAILED' },
        { path: 'body.id', condition: 'EQUALS', expectedValue: '7', actualValue: '7', status: 'PASSED' },
      ],
      responseData: { statusCode: 404, responseTime: 120, responseBody: '{"error":"not found"}' },
    });
    expect(why).toBe('assertion failed: statusCode equals expected "200", actual "404" · HTTP 404 in 120 ms — {"error":"not found"}');
  });

  test('uses key when there is no path, and spells the condition out', () => {
    expect(apiFailureReason({ assertions: [{ key: 'name', condition: 'NOT_EQUAL_TO_NULL', expectedValue: '', actualValue: 'null', status: 'FAILED' }] }))
      .toBe('assertion failed: name not equal to null expected "", actual "null"');
  });

  test('a long list is capped, and a long error body is shortened', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ path: `f${i}`, condition: 'EQUALS', expectedValue: 'a', actualValue: 'b', status: 'FAILED' }));
    const why = apiFailureReason({ assertions: many, responseData: { statusCode: 500, responseBody: 'x'.repeat(400) } })!;
    expect(why).toContain('… and 3 more failed assertion(s)');
    expect(why).toContain(`${'x'.repeat(160)}…`);
    expect(why).not.toContain('x'.repeat(161));
  });

  test('a 4xx/5xx with no assertions is still a reason; a 200 with nothing failed is not', () => {
    expect(apiFailureReason({ responseData: { statusCode: 500, responseBody: '' } })).toBe('HTTP 500');
    expect(apiFailureReason({ assertions: [{ path: 'a', status: 'PASSED' }], responseData: { statusCode: 200 } })).toBeUndefined();
    expect(apiFailureReason(undefined)).toBeUndefined();
    expect(apiFailureReason({})).toBeUndefined();
  });
});

describe('step results carry the API reason', () => {
  function adapterWith(stepDocs: any[]) {
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    a.http = { postJson: async () => ({ data: stepDocs }) };
    return a;
  }
  const failedApiStep = (extra: any) => ({
    seq: 2, description: 'GET /users', status: 'FAILED', stepType: 'API',
    apiData: { assertions: [{ path: 'statusCode', condition: 'EQUALS', expectedValue: '200', actualValue: '404', status: 'FAILED' }], responseData: { statusCode: 404 } },
    ...extra,
  });

  test('replaces the misleading last INFO log line with the real reason', async () => {
    const a = adapterWith([failedApiStep({ executionLogData: { executionLogs: ['INFO Executing HTTP Request: GET /users', 'INFO Received HTTP Response: Status=404, Time=90ms'] } })]);
    const steps = await a.fetchStepResults(1, 'r1', 0, 25);
    expect(steps[0].error).toContain('assertion failed: statusCode equals expected "200", actual "404"');
    expect(steps[0].error).not.toContain('Received HTTP Response');
  });

  test('an exception or an ERROR line still wins', async () => {
    const withExc = await adapterWith([failedApiStep({ exception: 'Connection refused' })]).fetchStepResults(1, 'r1', 0, 25);
    expect(withExc[0].error).toBe('Connection refused');
    const withErr = await adapterWith([failedApiStep({ executionLogData: { executionLogs: ['ERROR Error occurred for API step Message: timeout'] } })]).fetchStepResults(1, 'r1', 0, 25);
    expect(withErr[0].error).toContain('timeout');
  });

  test('passed steps and non-API steps are untouched', async () => {
    const steps = await adapterWith([
      { seq: 1, description: 'ok', status: 'PASSED', apiData: { assertions: [{ status: 'FAILED' }] } },
      { seq: 2, description: 'db', status: 'FAILED', executionLogData: { executionLogs: ['INFO connected'] } },
    ]).fetchStepResults(1, 'r1', 0, 25);
    expect(steps[0].error).toBeUndefined();
    expect(steps[1].error).toBe('INFO connected');   // unchanged behaviour when there is no apiData
  });
});
