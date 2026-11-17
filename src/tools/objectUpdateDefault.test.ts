import { registerObjectTools } from './objects.tools.js';

function objectUpdate(updated: { name: string; unique?: boolean }[]) {
  const calls: any[] = [];
  const adapter: any = {
    updateObject: async (_id: string, changes: any) => {
      calls.push(changes);
      return { id: '9', name: 'Login', locators: updated.map((l) => ({ name: l.name, value: 'v', ...(l.unique ? { unique: true } : {}) })) };
    },
  };
  let handler: ((a: any) => Promise<any>) | undefined;
  const server: any = { registerTool: (n: string, _c: unknown, fn: (a: any) => Promise<any>) => { if (n === 'object_update') handler = fn; } };
  registerObjectTools(server, { getAdapter: () => adapter });
  return { call: (a: any) => handler!(a), calls };
}

describe('object_update defaultLocator', () => {
  test('is passed to the adapter and the result confirms which locator is the default', async () => {
    const { call, calls } = objectUpdate([{ name: 'id' }, { name: 'xpath', unique: true }]);
    const res = await call({ id: '9', locators: [{ name: 'xpath', value: '//a' }], defaultLocator: 'xpath' });
    expect(res.isError).toBeFalsy();
    expect(calls[0].defaultLocator).toBe('xpath');
    expect(res.content[0].text).toContain('default locator → "xpath"');
  });

  test('defaultLocator alone is a valid update', async () => {
    const { call } = objectUpdate([{ name: 'css', unique: true }]);
    expect((await call({ id: '9', defaultLocator: 'css' })).isError).toBeFalsy();
  });

  test('REFUSES when the backend answer shows the default did not take (none, or the wrong one)', async () => {
    const none = await objectUpdate([{ name: 'id' }, { name: 'xpath' }]).call({ id: '9', defaultLocator: 'xpath' });
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toMatch(/default locator is \(none\), not "xpath"/);
    const wrong = await objectUpdate([{ name: 'id', unique: true }, { name: 'xpath' }]).call({ id: '9', defaultLocator: 'xpath' });
    expect(wrong.isError).toBe(true);
    expect(wrong.content[0].text).toMatch(/default locator is "id", not "xpath"/);
  });

  test('a locator flagged unique is checked the same way', async () => {
    const bad = await objectUpdate([{ name: 'id' }, { name: 'xpath' }])
      .call({ id: '9', locators: [{ name: 'xpath', value: '//a', unique: true }] });
    expect(bad.isError).toBe(true);
  });

  test('an update that does not ask for a default is not second-guessed', async () => {
    const res = await objectUpdate([{ name: 'id' }]).call({ id: '9', name: 'Login' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Updated object');
  });
});
