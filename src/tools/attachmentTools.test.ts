import { registerAttachmentTools } from './attachment.tools.js';

function setup() {
  const calls: any[] = [];
  const removed: any[] = [];
  const adapter: any = {
    addAttachment: async (input: any) => {
      calls.push(input);
      return { id: '1326', name: input.fileName, attachments: [{ id: 'a1', original_name: input.fileName }] };
    },
    removeAttachment: async (input: any) => {
      removed.push(input);
      return { removed: true, attachments: [] };
    },
    downloadAttachments: async (input: any) => {
      downloads.push(input);
      return { files: [{ path: `${input.outDir}/a.txt`, name: 'a.txt', bytes: 3, sizeMatches: true }], available: [], warnings: [] };
    },
  };
  const downloads: any[] = [];
  const handlers: Record<string, (a: any) => Promise<any>> = {};
  const server: any = { registerTool: (n: string, _c: unknown, fn: (a: any) => Promise<any>) => { handlers[n] = fn; } };
  registerAttachmentTools(server, { getAdapter: () => adapter });
  return {
    add: (a: any) => handlers['attachment_add']!(a), del: (a: any) => handlers['attachment_delete']!(a),
    download: (a: any) => handlers['attachment_download']!(a), calls, removed, downloads,
  };
}

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('attachment_add / attachment_delete', () => {
  test('base64 content is decoded and uploaded under the given name', async () => {
    const { add, calls } = setup();
    const res = await add({ entityType: 'userstory', itemId: 'US-1326', base64: PNG_B64, fileName: 'shot.png' });
    expect(res.isError).toBeFalsy();
    expect(calls[0].entityType).toBe('userstory');
    expect(calls[0].itemId).toBe('US-1326');
    expect(calls[0].fileName).toBe('shot.png');
    expect(calls[0].contentType).toBe('image/png');
    expect(calls[0].data.byteLength).toBeGreaterThan(0);
    expect(res.content[0].text).toMatch(/Attachments now: shot\.png/);
  });

  test('needs a file source, and base64 needs a file name', async () => {
    const { add, calls } = setup();
    expect((await add({ entityType: 'epic', itemId: 'EP-66' })).isError).toBe(true);
    const noName = await add({ entityType: 'epic', itemId: 'EP-66', base64: PNG_B64 });
    expect(noName.isError).toBe(true);
    expect(noName.content[0].text).toMatch(/fileName/);
    expect(calls).toHaveLength(0);
  });

  test('delete passes id/name through and confirms the read-back', async () => {
    const { del, removed } = setup();
    const res = await del({ entityType: 'feature', itemId: 'FT-266', attachment: 'shot.png' });
    expect(res.isError).toBeFalsy();
    expect(removed[0]).toMatchObject({ entityType: 'feature', itemId: 'FT-266', attachment: 'shot.png' });
    expect(res.content[0].text).toMatch(/Attachments now: \(none\)/);
  });

  describe('QA_MCP_HOSTED', () => {
    const saved = process.env['QA_MCP_HOSTED'];
    afterEach(() => {
      if (saved === undefined) delete process.env['QA_MCP_HOSTED'];
      else process.env['QA_MCP_HOSTED'] = saved;
    });

    test('a shared server refuses a server file path and uploads nothing', async () => {
      process.env['QA_MCP_HOSTED'] = 'true';
      const { add, calls } = setup();
      const res = await add({ entityType: 'userstory', itemId: 'US-1', filePath: '/etc/hosts' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/cannot read files by path/);
      expect(calls).toHaveLength(0);
    });

    test('a shared server still accepts base64 content', async () => {
      process.env['QA_MCP_HOSTED'] = 'true';
      const { add, calls } = setup();
      const res = await add({ entityType: 'userstory', itemId: 'US-1', base64: PNG_B64, fileName: 'shot.png' });
      expect(res.isError).toBeFalsy();
      expect(calls).toHaveLength(1);
    });

    test('a shared server refuses attachment_download and writes nothing', async () => {
      process.env['QA_MCP_HOSTED'] = 'true';
      const { download, downloads } = setup();
      const res = await download({ entityType: 'userstory', itemId: 'US-1', all: true, outDir: '/tmp/anywhere' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/cannot save files/);
      expect(downloads).toHaveLength(0);
    });

    test('without the switch, attachment_download saves as before', async () => {
      delete process.env['QA_MCP_HOSTED'];
      const { download, downloads } = setup();
      const res = await download({ entityType: 'userstory', itemId: 'US-1', all: true });
      expect(res.isError).toBeFalsy();
      expect(downloads[0].outDir).toBe('./exports');
    });

    test('without the switch, a local file path is read and uploaded as before', async () => {
      delete process.env['QA_MCP_HOSTED'];
      const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const dir = mkdtempSync(join(tmpdir(), 'att-'));
      const file = join(dir, 'shot.png');
      writeFileSync(file, Buffer.from(PNG_B64, 'base64'));
      try {
        const { add, calls } = setup();
        const res = await add({ entityType: 'userstory', itemId: 'US-1', filePath: file });
        expect(res.isError).toBeFalsy();
        expect(calls[0].fileName).toBe('shot.png');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
