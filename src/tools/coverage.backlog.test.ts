// coverage.backlog — the backlog WRITE surface that backlog.tools.test.ts does not reach:
// backlog_delete's two-step preview/confirm contract (and its blocker/ambiguity/not-found guards),
// watch_list_add and backlog_link. Every test drives the real in-process MCP server (buildServer +
// InMemoryTransport) so the registered tool, its zod schema and the adapter call are all exercised.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { EpicSummary } from '../domain/types.js';
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

const epicRow = (id: string, key: string, name: string): EpicSummary => ({ id, key, name, state: 'open' });

describe('backlog_delete — two-step delete through the MCP client', () => {
  it('previews without deleting when confirm is absent, and forwards the dry-run call', async () => {
    const listEpics = jest.fn(async () => [epicRow('12', 'EP_12', 'Checkout')]);
    const deleteBacklogItem = jest.fn(async () => ({ dryRun: true, deleted: false, dependencies: [] }));
    const adapter = { listEpics, deleteBacklogItem } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({ name: 'backlog_delete', arguments: { kind: 'epic', ref: 'EP_12' } });

      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toContain('About to delete epic **Checkout** (id 12)');
      expect(textOf(res)).toContain('confirm:true');
      const preview = structured<{ preview?: boolean; needs?: string; item?: { kind: string; id: string } }>(res);
      expect(preview.preview).toBe(true);
      expect(preview.needs).toBe('confirm');
      expect(preview.item).toStrictEqual({ kind: 'epic', id: '12', name: 'Checkout' });

      expect(listEpics).toHaveBeenCalledWith({ search: 'EP_12', limit: 50 });
      // Only the dependency probe ran — the preview must never delete.
      expect(deleteBacklogItem).toHaveBeenCalledTimes(1);
      expect(deleteBacklogItem).toHaveBeenCalledWith({ kind: 'epic', id: '12', confirm: false });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('deletes with confirm:true after a clean probe', async () => {
    const listFeatures = jest.fn(async () => [
      { id: '4', key: 'FT_4', name: 'Payments', state: 'open', epicId: '12' },
    ]);
    const deleteBacklogItem = jest
      .fn()
      .mockResolvedValueOnce({ dryRun: true, deleted: false, dependencies: [] })
      .mockResolvedValueOnce({ dryRun: false, deleted: true, dependencies: [] });
    const adapter = { listFeatures, deleteBacklogItem } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({ name: 'backlog_delete', arguments: { kind: 'feature', ref: 'Payments', confirm: true } });

      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toContain('Deleted feature **Payments** (id 4).');
      expect(deleteBacklogItem).toHaveBeenNthCalledWith(1, { kind: 'feature', id: '4', confirm: false });
      expect(deleteBacklogItem).toHaveBeenNthCalledWith(2, { kind: 'feature', id: '4', confirm: true });
      expect(structured<{ deleted?: { id: string } }>(res).deleted?.id).toBe('4');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('refuses an item that still has dependents and names the blocker relation', async () => {
    const listStories = jest.fn(async () => [{ id: '9', key: 'US_9', title: 'Pay with card' }]);
    const deleteBacklogItem = jest.fn(async () => ({
      dryRun: true,
      deleted: false,
      dependencies: [{ id: 9, counts: { tcArr: [41, 42], taskArr: [7] } }],
    }));
    const adapter = { listStories, deleteBacklogItem } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({ name: 'backlog_delete', arguments: { kind: 'story', ref: 'US_9', confirm: true } });

      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("Cannot delete story **Pay with card** (id 9)");
      expect(textOf(res)).toContain('- tc: 2 (ids 41, 42)');
      expect(textOf(res)).toContain('- task: 1 (ids 7)');
      expect(deleteBacklogItem).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('deletes nothing when the ref is ambiguous', async () => {
    const listTasks = jest.fn(async () => [
      { id: '3', code: 'TK_3', title: 'Fix login' },
      { id: '5', code: 'TK_5', title: 'Fix login' },
    ]);
    const deleteBacklogItem = jest.fn();
    const adapter = { listTasks, deleteBacklogItem } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({ name: 'backlog_delete', arguments: { kind: 'task', ref: 'Fix login' } });

      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('matches 2 tasks — ambiguous, nothing was deleted');
      expect(textOf(res)).toContain('Fix login (id 3)');
      expect(textOf(res)).toContain('Fix login (id 5)');
      expect(deleteBacklogItem).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('reports the closest matches when nothing matches and never probes the delete', async () => {
    const listDefects = jest.fn(async () => [{ id: '77', code: 'DF_77', title: 'Cart total wrong' }]);
    const deleteBacklogItem = jest.fn();
    const adapter = { listDefects, deleteBacklogItem } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({ name: 'backlog_delete', arguments: { kind: 'defect', ref: 'DF_99' } });

      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('No defect matching "DF_99" was found.');
      expect(textOf(res)).toContain('Cart total wrong (id 77)');
      expect(textOf(res)).toContain('Nothing was deleted.');
      expect(deleteBacklogItem).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

});

describe('watch_list_add / backlog_link — adapter routing', () => {
  it('forwards the watch-list members exactly and reports the resolved user ids', async () => {
    const addWatchListUsers = jest.fn(async () => ({
      users: [11, 12],
      mailersList: { users: [11, 12] },
    }));
    const adapter = { addWatchListUsers } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({
        name: 'watch_list_add',
        arguments: {
          entityType: 'userstory',
          itemId: 'US-1326',
          users: ['rohini.k@simplify3x.com', 12],
        },
      });

      expect(res.isError).toBeFalsy();
      expect(addWatchListUsers).toHaveBeenCalledWith({
        entityType: 'userstory',
        itemId: 'US-1326',
        users: ['rohini.k@simplify3x.com', 12],
      });
      expect(textOf(res)).toContain('Watch List of userstory US-1326 now has user id(s): 11, 12.');
      expect(structured<{ users?: number[] }>(res).users).toStrictEqual([11, 12]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('forwards a backlog link and renders the read-back linkages', async () => {
    const linkBacklogItem = jest.fn(async () => ({
      linkTypeKey: 'CLONES',
      destinationCode: 'DF-2293',
      linkedIssues: [
        { destinationCode: 'DF-2293', linkTypeKey: 'CLONES' },
        { destinationCode: 'US-77', linkTypeKey: 'RELATES' },
      ],
    }));
    const adapter = { linkBacklogItem } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({
        name: 'backlog_link',
        arguments: {
          sourceType: 'userstory',
          sourceId: 'US-1326',
          destType: 'defect',
          destId: 'DF-2293',
          linkType: 'Clones',
        },
      });

      expect(res.isError).toBeFalsy();
      expect(linkBacklogItem).toHaveBeenCalledWith({
        sourceType: 'userstory',
        sourceId: 'US-1326',
        destType: 'defect',
        destId: 'DF-2293',
        linkType: 'Clones',
      });
      expect(textOf(res)).toContain('Linked userstory US-1326 → defect DF-2293 (Clones, key CLONES).');
      expect(textOf(res)).toContain('DF-2293 (CLONES), US-77 (RELATES)');
      const links = structured<{ linkTypeKey?: string; links?: unknown[] }>(res);
      expect(links.linkTypeKey).toBe('CLONES');
      expect(links.links).toHaveLength(2);
    } finally {
      await client.close();
      await server.close();
    }
  });

});
