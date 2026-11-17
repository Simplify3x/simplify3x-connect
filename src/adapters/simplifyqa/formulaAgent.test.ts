import { SimplifyQaAdapter } from './adapter.js';

type Sent = { url: string; body: any; headers: Record<string, string> };

/** An adapter with only what evaluateFormula touches, plus a fake agent behind global fetch. */
function setup(agent: (sent: Sent) => { status: number; body: unknown } | 'down') {
  const sent: Sent[] = [];
  const legacy: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  jest.spyOn(globalThis, 'fetch').mockImplementation((async (url: any, init: any) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 5));                       // give a concurrent call the chance to overlap
      const s: Sent = { url: String(url), body: JSON.parse(init.body), headers: init.headers };
      sent.push(s);
      const r = agent(s);
      if (r === 'down') {
        const e: any = new TypeError('fetch failed');
        e.cause = { message: 'connect ECONNREFUSED 127.0.0.1:4040' };
        throw e;
      }
      return new Response(JSON.stringify(r.body), { status: r.status });
    } finally { inFlight--; }
  }) as typeof fetch);

  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { url: 'http://127.0.0.1:4040/mcp', token: 'tok', projectId: '19' };
  a.formulaAgentQueue = Promise.resolve();
  a.requireProjectId = () => 19;
  a.lookupProjectName = async () => 'My Project';
  a.listFormulas = async () => [
    { name: 'FIRST_NAME()', parameters: [{ keyName: 'country name' }, { keyName: 'sex' }, { keyName: 'min' }, { keyName: 'max' }] },
    { name: 'NUMERIC()', parameters: [{ keyName: 'length' }] },
  ];
  a.http = { getJson: async (p: string) => { legacy.push(p); return { data: { value: 'Legacy' } }; } };
  return { a, sent, legacy, maxInFlight: () => maxInFlight };
}

afterEach(() => jest.restoreAllMocks());

describe('evaluateFormula goes through the agent engine', () => {
  test('sends the expression to <agent origin>/formula/convert with only the arguments given', async () => {
    const { a, sent, legacy } = setup(() => ({ status: 200, body: { value: 'John' } }));
    const out = await a.evaluateFormula({ name: 'FIRST_NAME()', args: { 'country name:': 'United States' } }, { technologyType: 'web' });
    expect(out).toEqual({ value: 'John', expression: '=FIRST_NAME("United States")' });   // trailing blanks dropped
    expect(sent[0]!.url).toBe('http://127.0.0.1:4040/formula/convert');
    expect(sent[0]!.body).toMatchObject({ formula: '=FIRST_NAME("United States")', projectId: 19, projectName: 'My Project', technologyType: 'WEB' });
    expect(legacy).toHaveLength(0);
  });

  test('a formula the old backend route does not know (NUMERIC) works, with no hardcoded list', async () => {
    const { a, legacy } = setup(() => ({ status: 200, body: { value: 12345 } }));
    const out = await a.evaluateFormula({ name: 'NUMERIC', args: { length: '5' } });
    expect(out).toEqual({ value: '12345', expression: '=NUMERIC("5")' });
    expect(legacy).toHaveLength(0);
  });

  test('a raw nested expression is sent as written (a missing = is added)', async () => {
    const { a, sent } = setup(() => ({ status: 200, body: { value: 'JOHN' } }));
    expect((await a.evaluateFormula({ expression: 'UPPER(FIRST_NAME())' })).expression).toBe('=UPPER(FIRST_NAME())');
    expect(sent[0]!.body.formula).toBe('=UPPER(FIRST_NAME())');
  });

  test('the agent rejecting a formula is reported with its reason, and the old route is not tried', async () => {
    const { a, legacy } = setup(() => ({ status: 400, body: { value: '=NUMERIC("x")', Exception: 'Illegal argument: x' } }));
    await expect(a.evaluateFormula({ name: 'NUMERIC', args: { length: 'x' } })).rejects.toThrow(/Illegal argument: x/);
    expect(legacy).toHaveLength(0);
  });

  test('agent down: a formula the old route knows still works; any other gets a clear error, not a hang', async () => {
    const down = setup(() => 'down');
    const ok = await down.a.evaluateFormula({ name: 'FIRST_NAME', args: { 'country name': 'US' } });
    expect(ok.value).toBe('Legacy');
    expect(down.legacy[0]).toContain('/tm/customFormula?formulaName=FIRST_NAME');

    const down2 = setup(() => 'down');
    await expect(down2.a.evaluateFormula({ name: 'NUMERIC', args: { length: '5' } })).rejects.toThrow(/agent .*could not be reached.*ECONNREFUSED/);
    expect(down2.legacy).toHaveLength(0);
  });

  test('calls are serialised: the agent never sees two requests at once', async () => {
    const { a, maxInFlight } = setup(() => ({ status: 200, body: { value: 'x' } }));
    await Promise.all([1, 2, 3, 4].map(() => a.evaluateFormula({ name: 'NUMERIC', args: { length: '3' } })));
    expect(maxInFlight()).toBe(1);
  });

  test('an unknown name and a missing name/expression fail before any request', async () => {
    const { a, sent } = setup(() => ({ status: 200, body: { value: 'x' } }));
    await expect(a.evaluateFormula({ name: 'NOPE' })).rejects.toThrow(/Unknown formula "NOPE"/);
    await expect(a.evaluateFormula({})).rejects.toThrow(/needs a `name`/);
    expect(sent).toHaveLength(0);
  });
});
