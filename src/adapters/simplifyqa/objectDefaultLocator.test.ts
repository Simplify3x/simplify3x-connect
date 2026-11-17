import { SimplifyQaAdapter } from './adapter.js';

/** An adapter with a stubbed backend holding one object; captures the body PUT back. */
function setup(attributes: Array<{ name: string; value: string; unique?: boolean }>, extraDoc: Record<string, unknown> = {}) {
  const puts: any[] = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: 'https://uat.simplifyqa.com', token: 't', projectId: '25' };
  a.requireProjectId = () => 25;
  a.http = {
    getJson: async () => ({ id: 9, disname: 'Login', objecttemplateId: 3, technology: 'WEB', moduleId: 1, updateVersion: 4, attributes, ...extraDoc }),
    putJson: async (_p: string, body: any) => { puts.push(body); return { id: 9, disname: 'Login', attributes: body.attributes }; },
  };
  return { a, puts };
}

const XPATH = { name: 'xpath', value: "//input[@id='user']" };

describe('object update: add a locator and make it the default', () => {
  test('add an xpath AND defaultLocator "xpath": it is the ONLY default; the old default is cleared; nothing is lost', async () => {
    const { a, puts } = setup([{ name: 'id', value: 'user', unique: true }, { name: 'css', value: '#user' }]);
    await a.updateObject('9', { locators: [XPATH], defaultLocator: 'xpath' });
    expect(puts[0].attributes).toEqual([
      { name: 'id', value: 'user' },
      { name: 'css', value: '#user' },
      { ...XPATH, unique: true },
    ]);
  });

  test('defaultLocator can name a locator already on the object, without resending its value', async () => {
    const { a, puts } = setup([{ name: 'id', value: 'user', unique: true }, { name: 'css', value: '#user' }]);
    await a.updateObject('9', { defaultLocator: 'css' });
    expect(puts[0].attributes).toEqual([{ name: 'id', value: 'user' }, { name: 'css', value: '#user', unique: true }]);
  });

  test('the name match is case-insensitive', async () => {
    const { a, puts } = setup([{ name: 'XPath', value: '//a' }, { name: 'id', value: 'x', unique: true }]);
    await a.updateObject('9', { defaultLocator: 'xpath' });
    expect(puts[0].attributes).toEqual([{ name: 'XPath', value: '//a', unique: true }, { name: 'id', value: 'x' }]);
  });

  test('an unknown name is refused, lists the real locators and writes nothing', async () => {
    const { a, puts } = setup([{ name: 'id', value: 'user', unique: true }]);
    await expect(a.updateObject('9', { defaultLocator: 'xpath' })).rejects.toThrow(/no locator with that name.*Its locators: id/s);
    expect(puts).toHaveLength(0);
  });

  test('`unique: true` on a locator still works and an update without either leaves the default alone', async () => {
    const { a, puts } = setup([{ name: 'id', value: 'user', unique: true }]);
    await a.updateObject('9', { locators: [{ ...XPATH, unique: true }] });
    expect(puts[0].attributes.filter((l: any) => l.unique).map((l: any) => l.name)).toEqual(['xpath']);
    const b = setup([{ name: 'id', value: 'user', unique: true }]);
    await b.a.updateObject('9', { locators: [XPATH] });
    expect(b.puts[0].attributes).toEqual([{ name: 'id', value: 'user', unique: true }, XPATH]);
  });

  test('recorder screenshots survive a locator edit (PUT replaces the object document)', async () => {
    const thumb = { url: '/download/recording/thumb-1' };
    const page = { url: '/download/recording/page-1' };
    const { a, puts } = setup([{ name: 'id', value: 'user', unique: true }], { thumbnail_url: thumb, pageScreenShot_url: page });
    await a.updateObject('9', { locators: [XPATH] });
    expect(puts[0].thumbnail_url).toEqual(thumb);
    expect(puts[0].pageScreenShot_url).toEqual(page);
  });

  test('an object with no screenshots does not get empty image fields', async () => {
    const { a, puts } = setup([{ name: 'id', value: 'user', unique: true }], { thumbnail_url: {}, pageScreenShot_url: '' });
    await a.updateObject('9', { locators: [XPATH] });
    expect('thumbnail_url' in puts[0]).toBe(false);
    expect('pageScreenShot_url' in puts[0]).toBe(false);
  });
});
