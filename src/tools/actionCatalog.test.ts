import { resolveCatalogFor } from './actionCatalog.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { Step } from '../domain/types.js';

const apiStep: Step = { n: 1, description: 'POST /pm/task', actionType: 'executerestapi', stepType: 'api' };

describe('resolveCatalogFor — provider-aware draft validation', () => {
  it('SimplifyQA: validates against the LIVE backend catalog and accepts `executerestapi`', async () => {
    let calls = 0;
    const adapter = {
      actionsCatalog: async () => {
        calls++;
        return [{ actionType: 'executerestapi', platform: 'unknown', id: 66 }];
      },
    } as unknown as ProviderAdapter;

    const cat = await resolveCatalogFor(adapter, true);
    expect(cat(apiStep).has('executerestapi')).toBe(true);

    // Cached per adapter — a second call must not refetch.
    await resolveCatalogFor(adapter, true);
    expect(calls).toBe(1);
  });

  it('SimplifyQA: does NOT fall back to the Walnut table when the live catalog is unreachable', async () => {
    const adapter = {
      actionsCatalog: async () => { throw new Error('agent down'); },
    } as unknown as ProviderAdapter;

    const cat = await resolveCatalogFor(adapter, true);
    // Empty set == "nothing to check" — never the Walnut vocabulary, which would reject SQA names.
    expect(cat(apiStep).size).toBe(0);
    expect(cat(apiStep).has('api_call')).toBe(false);
  });

  it('SimplifyQA with no adapter / actionsCatalog: skips (empty), never Walnut', async () => {
    const cat = await resolveCatalogFor(null, true);
    expect(cat(apiStep).size).toBe(0);
  });

  it('Walnut: keeps the static offline catalog untouched', async () => {
    const cat = await resolveCatalogFor({} as ProviderAdapter, false);
    expect(cat({ ...apiStep, actionType: 'api_call' }).has('api_call')).toBe(true);
    expect(cat({ ...apiStep, actionType: 'executerestapi' }).has('executerestapi')).toBe(false);
  });
});
