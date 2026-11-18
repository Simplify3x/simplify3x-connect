import { SimplifyQaAdapter } from './adapter.js';

const DELAY_MS = 40;

/** A recording-shaped automation TC: N API steps, each naming its own `${param}`. */
function apiTc(n: number): any {
  const steps = Array.from({ length: n }, (_, i) => {
    const name = `p${i + 1}`;
    return {
      n: i + 1,
      description: 'GET $' + `{${name}}`,
      stepType: 'api',
      api: {
        requestStyle: 'HTTP',
        requestData: { httpData: { url: 'https://example.com/{{' + name + '}}', method: 'GET', headers: [], body: { type: 'NONE' } } },
        assertions: [],
      },
    };
  });
  return { title: 'Perf TC', category: 'automated', folderOrModule: '1', steps };
}

function setup() {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls: string[] = [];
  let nextParamId = 5000;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const track = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    calls.push(label);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await sleep(DELAY_MS);
      return await fn();
    } finally {
      inFlight -= 1;
    }
  };
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: 'https://x', projectId: '1' };
  a.requireProjectId = () => 1;
  a.actionCatalogCache = Promise.resolve(new Map());
  a.http = {
    postJson: async (path: string, body: any) => track(path, async () => {
      if (path === '/tm/action/search') return { data: [] };
      if (path === '/tm/parameter/search') return { data: [] };
      if (path === '/tm/parameter') return { id: String(nextParamId++), ...body };
      throw new Error(`unexpected POST ${path}`);
    }),
    postMultipart: async () => ({ id: 1, code: 'TC-1' }),
    getJson: async (path: string) => { throw new Error(`unexpected GET ${path}`); },
  };
  return { a: a as SimplifyQaAdapter, calls, stats: () => ({ maxInFlight }) };
}

describe('save path performance', () => {
  test('a 10-step recording resolves its parameters concurrently, not one round-trip at a time', async () => {
    const { a, calls, stats } = setup();
    const t0 = Date.now();
    await a.createTestCase(apiTc(10));
    const elapsed = Date.now() - t0;

    // 10 unique params → 10 get-or-create (one search + one create each), not one per step.
    expect(calls.filter((c) => c === '/tm/parameter')).toHaveLength(10);
    expect(calls.filter((c) => c === '/tm/parameter/search').length).toBeLessThanOrEqual(11);
    expect(stats().maxInFlight).toBeGreaterThan(1);

    // Sequential would be ~20 × 40ms ≈ 800ms. Concurrency 6 → a few waves.
    expect(elapsed).toBeLessThan(600);
  });

  test('one lookup is made per parameter name, never per step', async () => {
    const tc = apiTc(10);
    // Same token repeated on every step must still resolve once (api urls carry no tokens here).
    for (const s of tc.steps) {
      s.description = 'GET ${shared}';
      s.api.requestData.httpData.url = 'https://example.com/shared';
    }
    const { a, calls } = setup();
    await a.createTestCase(tc);
    // 1 for the shared param + 1 for the access-type catalog read.
    expect(calls.filter((c) => c === '/tm/parameter/search')).toHaveLength(2);
  });
});
