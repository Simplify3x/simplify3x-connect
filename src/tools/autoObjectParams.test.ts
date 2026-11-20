import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ProviderAdapter } from '../adapters/types.js';
import { DraftStore } from '../drafts/store.js';
import { buildServer } from '../server.js';
import { applyObjectParameters, literalOfLocators } from './autoObjectParams.js';

const LOC = [
  { name: 'Xpath by Role and Name', value: "//a[normalize-space()='PIM']" },
  { name: 'class', value: 'oxd-main-menu-item' },
];

function fake(o: { description?: string; actionType?: string; seed?: string; locators?: Array<{ name: string; value: string }>; objectId?: string | undefined; unnamed?: boolean } = {}) {
  const calls: any[] = [];
  const adapter: any = {
    getTestCase: async () => ({
      id: 999,
      steps: [
        { n: 6, description: 'Wait until Side Menu Item is present', actionType: 'Wait until Element is Present', sourceObjectId: '1434' },
        // a SAVED step carries the action ID, as the real backend does ("184" = Click on project 1) — the name comes from the catalog
        { n: 7, description: o.description ?? 'Click side menu item ${menu_name}', actionType: '184', sourceObjectId: 'objectId' in o ? o.objectId : '1434' },
      ],
    }),
    actionNamesById: async () => (o.unnamed ? {} : { '184': o.actionType ?? 'Click' }),
    getDefaultIteration: async () => ({ tcId: '999', versionId: 'v1', environmentType: 'general', parameters: [{ paramId: 1, name: 'menu_name', seed: o.seed ?? '' }] }),
    getObject: async () => ({ id: '1434', name: 'Side Menu Item', locators: o.locators ?? LOC }),
    objectParameterize: async (input: any) => { calls.push(input); return { steps: [6, 7], objectName: 'Side Menu Item', testdata: 'seeded' }; },
  };
  return { adapter, calls };
}

describe('literalOfLocators', () => {
  it.each([
    ["//a[normalize-space()='PIM']", 'PIM'],
    ["//span[text()='Leave']", 'Leave'],
    ["//button[contains(., 'Save')]", 'Save'],
    ["//img[@alt='Logo']", 'Logo'],
  ])('%s → %s', (xpath, want) => {
    expect(literalOfLocators([{ name: 'x', value: xpath }])).toBe(want);
  });
  it('ignores a locator that is already a parameter and finds nothing in a plain one', () => {
    expect(literalOfLocators([{ name: 'x', value: "//a[normalize-space()='{{3134}}']" }])).toBeUndefined();
    expect(literalOfLocators([{ name: 'class', value: 'oxd-main-menu-item' }])).toBeUndefined();
  });
});

describe('applyObjectParameters (what tc_save runs)', () => {
  it('turns a ${name} click step into an object parameter, value = the locator text', async () => {
    const { adapter, calls } = fake();
    const note = await applyObjectParameters(adapter as ProviderAdapter, '999');
    expect(calls).toEqual([{ tcId: '999', step: 7, parameterName: 'menu_name', value: 'PIM', replace: 'PIM', confirm: true }]);
    expect(note).toContain('Object parameter menu_name = PIM set on steps 6, 7');
  });

  it('leaves a step alone when there is no ${token}', async () => {
    const { adapter, calls } = fake({ description: 'Click the PIM menu item' });
    expect(await applyObjectParameters(adapter, '999')).toBe('');
    expect(calls).toEqual([]);
  });

  it('leaves a value-taking step alone (Type Text with ${username} is a real plain parameter)', async () => {
    const { adapter, calls } = fake({ actionType: 'Type Text', description: 'Enter ${menu_name}' });
    expect(await applyObjectParameters(adapter, '999')).toBe('');
    expect(calls).toEqual([]);
  });

  it('a step whose action cannot be named is left alone, with a warning (never guessed)', async () => {
    const { adapter, calls } = fake({ unnamed: true });
    const note = await applyObjectParameters(adapter, '999');
    expect(calls).toEqual([]);
    expect(note).toContain('its action (184) could not be named');
  });

  it('leaves it alone when the parameter already has a value, and when the step has no object', async () => {
    const a = fake({ seed: 'PIM' });
    expect(await applyObjectParameters(a.adapter, '999')).toBe('');
    const b = fake({ objectId: undefined });
    expect(await applyObjectParameters(b.adapter, '999')).toBe('');
    expect([...a.calls, ...b.calls]).toEqual([]);
  });

  it('says so, and changes nothing, when no locator has text to parameterize', async () => {
    const { adapter, calls } = fake({ locators: [{ name: 'class', value: 'oxd-main-menu-item' }] });
    const note = await applyObjectParameters(adapter, '999');
    expect(calls).toEqual([]);
    expect(note).toContain('no locator of "Side Menu Item" has quoted text');
  });

  it('never throws: a failure becomes a warning line', async () => {
    const { adapter } = fake();
    adapter.objectParameterize = async () => { throw new Error('backend 500'); };
    expect(await applyObjectParameters(adapter, '999')).toContain('Could not apply the object parameters: backend 500');
  });

  it('is a no-op on a provider without object_parameterize', async () => {
    expect(await applyObjectParameters({} as ProviderAdapter, '999')).toBe('');
  });
});

describe('tc_save applies it by itself (no second tool call)', () => {
  it('the save reply reports the object parameter that was set', async () => {
    const { adapter, calls } = fake();
    adapter.callRaw = async (name: string) => (name === 'core_active_recordings'
      ? { structuredContent: { recordings: [] } }
      : { structuredContent: { saved: { tcId: '999', code: 'TC-999', productUrl: 'https://qa/tc/999' } } });
    const server = buildServer({ adapter, connection: undefined, mode: 'connected', drafts: new DraftStore(), openEditorWindow: async () => false });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(ct);
    try {
      const res: any = await client.callTool({ name: 'tc_save', arguments: { sessionId: 's-1', replaceWithFunctions: false } });
      const text = (res.content ?? []).map((c: any) => c.text ?? '').join('\n');
      expect(res.isError).toBeFalsy();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ tcId: '999', step: 7, parameterName: 'menu_name', value: 'PIM', confirm: true });
      expect(text).toContain('Created test case TC-999');
      expect(text).toContain('Object parameter menu_name = PIM');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
