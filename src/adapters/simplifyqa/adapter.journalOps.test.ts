import { SimplifyQaAdapter } from './adapter.js';

/**
 * Step-op numbering in `editStepsDirect` (journal_modify when the desktop agent is unreachable /
 * the TC has no agent journal).
 *
 * The contract the product implements: `editStepsDirect` applies ops in order and RENUMBERS the
 * list after every op (`steps.map((x, k) => ({ ...x, n: k + 1 }))`), so each op addresses the
 * numbering as it stands at that point. A BULK delete over the numbers the caller saw is one
 * `remove_steps` op (`{ op:'remove_steps', numbers:[…] }`) — it is resolved against the current
 * steps in one pass, "so the caller can pass a range in any order without renumbering surprises"
 * (see the remove_steps branch in adapter.ts). Pin both shapes here.
 */
function makeAdapter(steps: any[]) {
  const fetchImpl = (async () => ({ ok: true, status: 200, text: async () => '{}' })) as unknown as typeof fetch;
  const adapter: any = new SimplifyQaAdapter(
    { baseUrl: 'https://x.test', token: 't', projectId: 1 } as any,
    { fetchImpl, FormDataImpl: FormData } as any,
  );
  let saved: any[] = steps.map((s) => ({ ...s }));
  const tc = {
    id: '803', title: 'numbering test', category: 'automated', folderOrModule: '1', steps: saved,
  };
  adapter.getTestCase = async () => ({ ...tc, steps: saved.map((s) => ({ ...s })) });
  adapter.updateTestCase = async (_id: string, next: any) => { saved = next.steps.map((s: any) => ({ ...s })); return { id: '803' }; };
  adapter.stepsView = async () => ({ tcId: '803', source: 'steps', steps: saved.map((s: any) => ({ ...s })) });
  return { adapter, saved: () => saved };
}

const base = [
  { n: 1, description: 'Go to URL', actionType: 'Go to URL', stepType: 'web' },
  { n: 2, description: 'Type user', actionType: 'Type Text', stepType: 'web' },
  { n: 3, description: 'Type pass', actionType: 'Type Text', stepType: 'web' },
  { n: 4, description: 'Click login', actionType: 'Click', stepType: 'web' },
];
const descs = (rows: any[]) => rows.map((r) => r.description);
const numbered = (rows: any[]) => rows.map((r) => `${r.n}:${r.description}`);

describe('editStepsDirect — op numbering is stable for the whole batch', () => {
  it('single remove_step still works', async () => {
    const { adapter, saved } = makeAdapter(base);
    await adapter.editStepsDirect('803', [{ op: 'remove_step', n: 2 }]);
    expect(descs(saved())).toEqual(['Go to URL', 'Type pass', 'Click login']);
    expect(numbered(saved())).toEqual(['1:Go to URL', '2:Type pass', '3:Click login']);
  });

  it('bulk removal addresses the numbers the caller saw (2 and 4)', async () => {
    const { adapter, saved } = makeAdapter(base);
    await adapter.editStepsDirect('803', [{ op: 'remove_steps', numbers: [2, 4] }]);
    expect(descs(saved())).toEqual(['Go to URL', 'Type pass']);
  });

  it('adjacent bulk removal (2 and 3) removes exactly those two, not a shifted one', async () => {
    const { adapter, saved } = makeAdapter(base);
    await adapter.editStepsDirect('803', [{ op: 'remove_steps', numbers: [2, 3] }]);
    expect(descs(saved())).toEqual(['Go to URL', 'Click login']);
  });

  it('repeated remove_step addresses the RENUMBERED list (each op renumbers)', async () => {
    const { adapter, saved } = makeAdapter(base);
    await adapter.editStepsDirect('803', [
      { op: 'remove_step', n: 2 },
      { op: 'remove_step', n: 2 }, // after the first removal this is 'Type pass'
    ]);
    expect(descs(saved())).toEqual(['Go to URL', 'Click login']);
  });

  it('update_step after a removal patches the step at its renumbered position', async () => {
    const { adapter, saved } = makeAdapter(base);
    await adapter.editStepsDirect('803', [
      { op: 'remove_step', n: 2 },
      // 'Click login' was step 4; the removal renumbered it to 3.
      { op: 'update_step', n: 3, patch: { description: 'Sign in' } },
    ]);
    expect(descs(saved())).toEqual(['Go to URL', 'Type pass', 'Sign in']);
  });
});
