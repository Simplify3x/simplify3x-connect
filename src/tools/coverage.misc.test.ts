// coverage.misc — Object Repository, column preferences, attachments, projects and
// function clone. These modules were the least-covered in src/tools; each test drives the real
// in-process MCP server and pins the adapter request (including two-step previews that must not write).

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ProviderAdapter } from '../adapters/types.js';
import { DraftStore } from '../drafts/store.js';
import { buildServer } from '../server.js';

type Harness = { client: Client; server: McpServer };

async function connect(adapter: ProviderAdapter | null): Promise<Harness> {
  const server = buildServer({
    adapter,
    connection: undefined,
    mode: 'connected',
    drafts: new DraftStore(),
    openEditorWindow: async () => false,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new McpClient({ name: 'coverage-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

function textOf(res: unknown): string {
  const content = ((res as { content?: Array<{ type: string; text?: string }> }).content ?? []);
  return content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
}

function structured<T>(res: unknown): T {
  return (res as { structuredContent?: T }).structuredContent as T;
}

describe('objects / column_preference / attachments', () => {
  it('creates an object and reports its locator count', async () => {
    const createObject = jest.fn(async (input: unknown) => ({
      id: 'o-1',
      name: (input as { name: string }).name,
      objectType: 'WEB',
      locators: [
        { name: 'css', value: '#login' },
        { name: 'xpath', value: '//button[@id="login"]' },
      ],
    }));
    const adapter = { createObject } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({
        name: 'object_create',
        arguments: {
          name: 'Login button',
          objectType: 'WEB',
          locators: [
            { name: 'css', value: '#login' },
            { name: 'xpath', value: '//button[@id="login"]' },
          ],
        },
      });

      expect(res.isError).toBeFalsy();
      expect(createObject).toHaveBeenCalledWith({
        name: 'Login button',
        objectType: 'WEB',
        locators: [
          { name: 'css', value: '#login' },
          { name: 'xpath', value: '//button[@id="login"]' },
        ],
      });
      expect(textOf(res)).toContain('Saved object `o-1` — "Login button" (WEB, 2 locators).');
      expect(structured<{ object?: { id: string } }>(res).object?.id).toBe('o-1');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('previews an object delete with its usage, then deletes only on confirm', async () => {
    const getObject = jest.fn(async () => ({
      id: 'o-1', name: 'Login button', objectType: 'WEB', locators: [],
    }));
    const checkObjectDependencies = jest.fn(async () => ({ tcCount: 2, fnCount: 1, wfCount: 0 }));
    const deleteObject = jest.fn(async () => undefined);
    const adapter = { getObject, checkObjectDependencies, deleteObject } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const preview = await client.callTool({ name: 'object_delete', arguments: { id: 'o-1' } });
      expect(preview.isError).toBeFalsy();
      expect(textOf(preview)).toContain('About to delete **Login button** · WEB (o-1).');
      expect(textOf(preview)).toContain('Still referenced by 2 test cases, 1 function');
      expect(textOf(preview)).toContain('the delete WILL BE REFUSED');
      expect(deleteObject).not.toHaveBeenCalled();

      const confirmed = await client.callTool({ name: 'object_delete', arguments: { id: 'o-1', confirm: true } });
      expect(confirmed.isError).toBeFalsy();
      expect(textOf(confirmed)).toContain('Deleted object o-1.');
      expect(deleteObject).toHaveBeenCalledWith('o-1');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('enables a column on the epic list, seeding the defaults and saving the stored field shape', async () => {
    const getUserPreferences = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ epicFilter: [{ key: 'name' }, { key: 'createdAt' }] });
    const updateUserPreferences = jest.fn(async (_patch: Record<string, unknown>): Promise<Record<string, unknown>> => ({}));
    const listViewFields = jest.fn(async () => [
      { label: 'Name', key: 'name', isDefault: true, map: 'x', values: [] },
      { label: 'Created On', key: 'createdAt', isDefault: false },
    ]);
    const adapter = { getUserPreferences, updateUserPreferences, listViewFields } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({
        name: 'column_preference',
        arguments: { action: 'set', lists: ['epic'], column: 'Created On' },
      });

      expect(res.isError).toBeFalsy();
      expect(listViewFields).toHaveBeenCalledWith(1);
      const patch = updateUserPreferences.mock.calls[0]![0] as unknown as { epicFilter: Array<Record<string, unknown>> };
      expect(patch.epicFilter.map((f) => f['key'])).toStrictEqual(['name', 'createdAt']);
      expect(patch.epicFilter[1]).toMatchObject({ key: 'createdAt', label: 'Created On', isChecked: true, searchRow: '' });
      expect(patch.epicFilter[1]).not.toHaveProperty('map');
      expect(textOf(res)).toContain('Column preference saved.');
      expect(textOf(res)).toContain('Epics: Created On → shown ✓');
      expect(structured<{ lists?: Array<{ ok: boolean }> }>(res).lists?.[0]?.ok).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('attaches base64 content with an inferred MIME type, then removes it', async () => {
    const addAttachment = jest.fn(async (_input: {
      entityType: string; itemId: string; fileName: string; contentType?: string; data: Uint8Array;
    }) => ({
      id: 'att-1', name: 'shot.png', attachments: [{ original_name: 'shot.png' }],
    }));
    const removeAttachment = jest.fn(async () => ({ removed: true, attachments: [] }));
    const adapter = { addAttachment, removeAttachment } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const added = await client.callTool({
        name: 'attachment_add',
        arguments: { entityType: 'epic', itemId: 'EP_1', base64: 'aGVsbG8=', fileName: 'shot.png' },
      });

      expect(added.isError).toBeFalsy();
      expect(addAttachment).toHaveBeenCalledTimes(1);
      const call = addAttachment.mock.calls[0]![0] as {
        entityType: string; itemId: string; fileName: string; contentType: string; data: Uint8Array;
      };
      expect(call.entityType).toBe('epic');
      expect(call.itemId).toBe('EP_1');
      expect(call.fileName).toBe('shot.png');
      expect(call.contentType).toBe('image/png');
      expect(Array.from(call.data)).toStrictEqual([104, 101, 108, 108, 111]); // "hello"
      expect(textOf(added)).toContain('Attached "shot.png" to epic EP_1');
      expect(textOf(added)).toContain('Attachments now: shot.png');

      const removed = await client.callTool({
        name: 'attachment_delete',
        arguments: { entityType: 'epic', itemId: 'EP_1', attachment: 'shot.png' },
      });
      expect(removed.isError).toBeFalsy();
      expect(removeAttachment).toHaveBeenCalledWith({ entityType: 'epic', itemId: 'EP_1', attachment: 'shot.png' });
      expect(textOf(removed)).toContain('Removed "shot.png" from epic EP_1. Attachments now: (none)');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('project_create / project_delete', () => {
  it('creates a project with its members and reads it back for the code', async () => {
    const createProject = jest.fn(async () => ({ id: '55', created: true, code: 'PR-55' }));
    const getProjectById = jest.fn(async () => ({ id: '55', code: 'PR-55', name: 'Payments' }));
    const adapter = { createProject, getProjectById } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({
        name: 'project_create',
        arguments: { name: 'Payments', description: 'checkout project', users: [7] },
      });

      expect(res.isError).toBeFalsy();
      expect(createProject).toHaveBeenCalledWith({ name: 'Payments', description: 'checkout project', users: [7] });
      expect(getProjectById).toHaveBeenCalledWith('55');
      expect(textOf(res)).toContain('Created project PR-55 "Payments" (id 55).');
      expect(structured<{ project?: { code?: string } }>(res).project?.code).toBe('PR-55');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('previews a project delete, then deletes the numeric id on confirm', async () => {
    const getProjectById = jest.fn(async () => ({ id: '55', code: 'PR-55', name: 'Payments' }));
    const deleteProject = jest.fn(async () => ({ deleted: true }));
    const adapter = { getProjectById, deleteProject } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const preview = await client.callTool({ name: 'project_delete', arguments: { projectId: 'PR-55' } });
      expect(preview.isError).toBeFalsy();
      expect(textOf(preview)).toContain('About to delete project PR-55 "Payments". Everything inside it goes too');
      expect(structured<{ preview?: boolean; needs?: string }>(preview).needs).toBe('confirm');
      expect(deleteProject).not.toHaveBeenCalled();

      const confirmed = await client.callTool({ name: 'project_delete', arguments: { projectId: 'PR-55', confirm: true } });
      expect(confirmed.isError).toBeFalsy();
      expect(deleteProject).toHaveBeenCalledWith('55');
      expect(textOf(confirmed)).toContain('Deleted project PR-55 "Payments".');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('fn_clone', () => {
  it('asks about test data first, then clones the chosen source version', async () => {
    const getFunction = jest.fn(async () => ({
      id: '12',
      title: 'Utility login',
      versions: [{ id: 'v2', name: 'v2', isCurrent: true }],
    }));
    const cloneFunction = jest.fn(async () => ({
      id: 'FN-20', created: true, productUrl: 'https://qa/functions/FN-20',
    }));
    const adapter = { getFunction, cloneFunction } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const prompt = await client.callTool({
        name: 'fn_clone',
        arguments: { fnId: 'FN_12', newName: 'Utility login' },
      });
      expect(prompt.isError).toBeFalsy();
      expect(textOf(prompt)).toContain('**COPY TEST DATA** — Do you want to copy test data to new function **Utility login** (from FN_12)?');
      expect(textOf(prompt)).toContain('`tdCopy: true` → copy iterations across all environments (Confirm)');
      expect(structured<{ preview?: boolean; needs?: string }>(prompt).needs).toBe('tdCopy');
      expect(cloneFunction).not.toHaveBeenCalled();

      const cloned = await client.callTool({
        name: 'fn_clone',
        arguments: { fnId: 'FN_12', newName: 'Utility login', tdCopy: true },
      });
      expect(cloned.isError).toBeFalsy();
      expect(getFunction).toHaveBeenCalledWith('FN_12');
      expect(cloneFunction).toHaveBeenCalledWith('FN_12', 'Utility login', { tdCopy: true, sourceVersionId: 'v2' });
      expect(textOf(cloned)).toContain('Cloned FN_12 → **Utility login**. New id: **FN-20**');
      expect(textOf(cloned)).toContain('Source version: **v2**.');
      expect(textOf(cloned)).toContain('Testdata iterations were copied across environments.');
      expect(structured<{ savedRef?: { id: string } }>(cloned).savedRef?.id).toBe('FN-20');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
