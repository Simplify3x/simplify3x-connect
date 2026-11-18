import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimplifyQaAdapter } from './adapter.js';
import { registerAttachmentTools } from '../../tools/attachment.tools.js';

/**
 * "Download the attachment for EP-69" — driven through the REAL downloadAttachments: the attachments are listed from /pm/attachment, each file is
 * fetched from its /download/… URL through the authenticated binary client, written to a real folder, and its size compared with the one SimplifyQA
 * reports. A fake server stands in for SimplifyQA; it serves bytes only for the paths it knows.
 */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);          // 18 bytes
const PDF = new Uint8Array(Buffer.from('%PDF-1.4 test document body'));                                                    // 27 bytes
const att = (id: string, original: string, url: string, size: number, over: Record<string, unknown> = {}) =>
  ({ id, name: original.toLowerCase(), original_name: original, url, size, fileSize: `${size}B`, deleted: false, ...over });

const A1 = att('a1', 'teams-user-management.png', '/download/ATTACHMENTS/113/EP/69/teams-user-management.png', PNG.byteLength);
const A2 = att('a2', 'spec.pdf', '/download/ATTACHMENTS/113/EP/69/spec.pdf', PDF.byteLength);

function backend(rows: any[], files: Record<string, { data: Uint8Array; contentType?: string }>, opts: { baseUrl?: string } = {}) {
  const fetched: string[] = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: opts.baseUrl ?? 'http://backend' };
  a.requireProjectId = () => 19;
  a.http = {
    getJson: async (path: string) => {
      if (/^\/pm\/attachment\/69\/EP\?projectId=19$/.test(path)) return rows;
      throw new Error(`unexpected GET ${path}`);
    },
    getBinary: async (path: string) => {
      fetched.push(path);
      const f = files[decodeURIComponent(path)];
      if (!f) throw new Error(`HTTP 404 ${path}`);
      return { data: f.data, contentType: f.contentType ?? 'application/octet-stream' };
    },
  };
  return { a, fetched };
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'qa-att-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const dl = (a: any, extra: Record<string, unknown> = {}) => a.downloadAttachments({ entityType: 'epic', itemId: 'EP-69', outDir: dir, ...extra });

describe('download the attachment of EP-69', () => {
  test('one attachment: fetched from SimplifyQA, saved, the bytes are identical and the size matches what SimplifyQA reports', async () => {
    const { a, fetched } = backend([A1], { [A1.url]: { data: PNG, contentType: 'image/png' } });
    const r = await dl(a);
    expect(fetched).toEqual(['/download/ATTACHMENTS/113/EP/69/teams-user-management.png']);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toMatchObject({ id: 'a1', name: 'teams-user-management.png', path: join(dir, 'teams-user-management.png'), bytes: 18, reportedBytes: 18, sizeMatches: true });
    expect(new Uint8Array(await readFile(r.files[0].path))).toEqual(PNG);
    expect(r.warnings).toEqual([]);
  });

  test('several attachments and no choice: they are LISTED, nothing is downloaded', async () => {
    const { a, fetched } = backend([A1, A2], { [A1.url]: { data: PNG }, [A2.url]: { data: PDF } });
    const r = await dl(a);
    expect(r.needsChoice).toBe(true);
    expect(r.available).toEqual([{ id: 'a1', name: 'teams-user-management.png', bytes: 18 }, { id: 'a2', name: 'spec.pdf', bytes: PDF.byteLength }]);
    expect(r.files).toEqual([]);
    expect(fetched).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  test('choose one (by name or by id), several, or all', async () => {
    const files = { [A1.url]: { data: PNG }, [A2.url]: { data: PDF } };
    const one = backend([A1, A2], files);
    expect((await dl(one.a, { attachments: ['SPEC.pdf'] })).files.map((f: any) => f.name)).toEqual(['spec.pdf']);
    const byId = backend([A1, A2], files);
    expect((await dl(byId.a, { attachments: ['a1'] })).files.map((f: any) => f.name)).toEqual(['teams-user-management.png']);
    const some = backend([A1, A2], files);
    expect((await dl(some.a, { attachments: ['a1', 'spec.pdf', 'a1'] })).files.map((f: any) => f.name)).toEqual(['teams-user-management.png', 'spec.pdf']);
    const every = backend([A1, A2], files);
    const r = await dl(every.a, { all: true });
    expect(r.files.map((f: any) => f.bytes)).toEqual([PNG.byteLength, PDF.byteLength]);
    expect((await readdir(dir)).sort()).toContain('spec.pdf');
  });

  test('never overwrites: a second download of the same file is saved as "name (1).ext"', async () => {
    const { a } = backend([A1], { [A1.url]: { data: PNG } });
    await dl(a);
    const again = await dl(a);
    expect(again.files[0].path).toBe(join(dir, 'teams-user-management (1).png'));
    expect((await readdir(dir)).sort()).toEqual(['teams-user-management (1).png', 'teams-user-management.png']);
  });

  test('a file name with path characters is saved INSIDE the folder; names with spaces are fetched encoded', async () => {
    const evil = att('e1', '../../evil.png', '/download/ATTACHMENTS/113/EP/69/some file.png', PNG.byteLength);
    const { a, fetched } = backend([evil], { '/download/ATTACHMENTS/113/EP/69/some file.png': { data: PNG } });
    const r = await dl(a);
    expect(r.files[0].path.startsWith(dir)).toBe(true);
    expect(await readdir(dir)).toHaveLength(1);
    expect(fetched[0]).toBe('/download/ATTACHMENTS/113/EP/69/some%20file.png');
  });
});

describe('what is reported instead of trusted', () => {
  test('a size that differs from what SimplifyQA reports is flagged; no reported size is said so', async () => {
    const wrong = att('w1', 'big.png', '/download/ATTACHMENTS/113/EP/69/big.png', 9999);
    const r = await dl(backend([wrong], { [wrong.url]: { data: PNG } }).a);
    expect(r.files[0]).toMatchObject({ bytes: 18, reportedBytes: 9999, sizeMatches: false });
    expect(r.warnings.join(' ')).toMatch(/downloaded 18 bytes, but SimplifyQA reports 9999/);
    const none = att('n1', 'n.png', '/download/ATTACHMENTS/113/EP/69/n.png', 0, { size: undefined, fileSize: '' });
    expect((await dl(backend([none], { [none.url]: { data: PNG } }).a)).files[0].sizeMatches).toBeNull();
  });

  test('a web page standing in for the file (an expired login) is refused and nothing is saved; an empty body too', async () => {
    const html = new Uint8Array(Buffer.from('<!DOCTYPE html><html><body>Please log in</body></html>'));
    await expect(dl(backend([A1], { [A1.url]: { data: html, contentType: 'text/html' } }).a)).rejects.toThrow(/returned a web page, not the file/);
    await expect(dl(backend([A1], { [A1.url]: { data: new Uint8Array(0) } }).a)).rejects.toThrow(/downloaded empty/);
    expect(await readdir(dir)).toEqual([]);
  });

  test('an unknown or ambiguous attachment, no attachments, a server error, and a URL on another host (the token is not sent there)', async () => {
    const files = { [A1.url]: { data: PNG }, [A2.url]: { data: PDF } };
    await expect(dl(backend([A1, A2], files).a, { attachments: ['nope.png'] })).rejects.toThrow(/has no attachment "nope\.png". It has: teams-user-management\.png, spec\.pdf/);
    const twin = [A1, att('a9', 'teams-user-management.png', '/download/x/dup.png', 18)];
    await expect(dl(backend(twin, files).a, { attachments: ['teams-user-management.png'] })).rejects.toThrow(/matches 2 attachments.*pass the id/);
    await expect(dl(backend([], files).a)).rejects.toThrow(/has no attachments/);
    await expect(dl(backend([A1], {}).a)).rejects.toThrow(/Could not download "teams-user-management\.png": HTTP 404/);
    const foreign = att('f1', 'x.png', 'https://evil.example.com/download/x.png', 18);
    await expect(dl(backend([foreign], {}).a)).rejects.toThrow(/outside the connected SimplifyQA host/);
    const absolute = att('f2', 'ok.png', 'http://backend/download/ATTACHMENTS/113/EP/69/ok.png', 18);
    expect((await dl(backend([absolute], { '/download/ATTACHMENTS/113/EP/69/ok.png': { data: PNG } }).a)).files).toHaveLength(1);
  });
});

describe('the attachment_download tool', () => {
  const tool = (adapter: any) => {
    const h: Record<string, (a: any) => Promise<any>> = {};
    registerAttachmentTools({ registerTool: (n: string, _d: unknown, fn: any) => { h[n] = fn; } } as any, { getAdapter: () => adapter });
    return h['attachment_download']!;
  };
  const text = (r: any): string => r.content.map((c: any) => c.text).join('\n');

  test('reports the saved path, file name and size, and that it matches SimplifyQA', async () => {
    const r = await tool(backend([A1], { [A1.url]: { data: PNG } }).a)({ entityType: 'epic', itemId: 'EP-69', outDir: dir });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain(`Downloaded 1 attachment of epic EP-69 from SimplifyQA`);
    expect(text(r)).toContain(`${join(dir, 'teams-user-management.png')} — teams-user-management.png, 18 bytes (matches the size SimplifyQA reports)`);
  });

  test('several and no choice: lists them and tells the model to ask', async () => {
    const r = await tool(backend([A1, A2], { [A1.url]: { data: PNG }, [A2.url]: { data: PDF } }).a)({ entityType: 'epic', itemId: 'EP-69', outDir: dir });
    expect(text(r)).toContain(`has 2 attachments:\n1. teams-user-management.png (18 bytes, id a1)\n2. spec.pdf (${PDF.byteLength} bytes, id a2)`);
    expect(text(r)).toMatch(/Nothing was downloaded\. ASK the user which to download/);
  });

  test('errors and not-connected come back as messages', async () => {
    expect(text(await tool(backend([], {}).a)({ entityType: 'epic', itemId: 'EP-69', outDir: dir }))).toMatch(/has no attachments/);
    expect(text(await tool(null)({ entityType: 'epic', itemId: 'EP-69' }))).toMatch(/Not connected/);
  });
});
