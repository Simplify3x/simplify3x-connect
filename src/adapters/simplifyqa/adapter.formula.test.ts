import { SimplifyQaAdapter } from './adapter.js';

/** Backend stores DEFAULT formula names WITH parens ("FIRST_NAME()") and /tm/customFormula wants its
 *  own positional query keys — not the formula's declared keyNames. Both bit us; pin them. */
function makeAdapter(seen: string[]) {
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    seen.push(u);
    // The adapter proves project access (GET /pm/auth/me → GET /pm/projectuserrole) before every
    // project-scoped call, /tm/customFormula included. Answer it so the formula call is reached.
    if (u.includes('/pm/auth/me')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ userDetails: { id: 4, username: 'qa' } }) };
    }
    if (u.includes('/pm/projectuserrole')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ projectId: 1, roleId: 3 }] }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { value: 'Marcus' } }) };
  }) as unknown as typeof fetch;
  const a = new SimplifyQaAdapter({ baseUrl: 'https://x.test', token: 't', projectId: 1 } as any, { fetchImpl });
  (a as any).formulaCache = Promise.resolve([{
    name: 'FIRST_NAME()', uniqueId: 'FIRST_NAME()', type: 'DEFAULT', scope: 'default',
    signature: 'FIRST_NAME(country name,sex,min,max)',
    parameters: [{ keyName: 'country name:' }, { keyName: 'sex:' }, { keyName: 'min:' }, { keyName: 'max:' }],
  }]);
  return a;
}

test('resolves a parenthesised formula name and maps args to the API query keys', async () => {
  const seen: string[] = [];
  const out = await makeAdapter(seen).evaluateFormula({
    name: 'FIRST_NAME',
    args: { 'country name': 'United States', sex: 'Male', min: '3', max: '10' },
  });
  // The access check is what the backend sees first; the formula request follows it.
  expect(seen[0]).toContain('/pm/auth/me');
  expect(seen[1]).toContain('/pm/projectuserrole?userId=4');
  const formulaCall = seen.find((u) => u.includes('/tm/customFormula'));
  expect(formulaCall).toBeDefined();
  expect(formulaCall).toContain('formulaName=FIRST_NAME&');
  expect(formulaCall).toContain('country=United+States');
  expect(formulaCall).toContain('sex=Male');
  expect(formulaCall).toContain('min_len=3');
  expect(formulaCall).toContain('max_len=10');
  expect(out.value).toBe('Marcus');
  expect(out.expression).toBe('=FIRST_NAME("United States","Male","3","10")');
});

test('accepts the name copied straight from tc_list_formulas', async () => {
  const out = await makeAdapter([]).evaluateFormula({ name: 'FIRST_NAME()' });
  expect(out.value).toBe('Marcus');
});
