// backlog.tools — epic/feature/story CRUD tool registration + adapter routing.
// Covers: not-connected error path, adapter-missing-capability path, happy-path list/get/create/update
// that asserts each tool called the right adapter method with the right payload.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type {
  Epic, EpicInput, EpicSummary, EpicUpdate,
  Feature, FeatureInput, FeatureSummary, FeatureUpdate,
  SavedRef, StoryInput, StoryUpdate,
} from '../domain/types.js';
import { registerBacklogTools } from './backlog.tools.js';

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

function captureAll(): { server: McpServer; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (n: string, _meta: unknown, h: Handler) => { handlers.set(n, h); },
  } as unknown as McpServer;
  return { server, handlers };
}

describe('backlog.tools registration', () => {
  it('registers all 10 tools', () => {
    const cap = captureAll();
    registerBacklogTools(cap.server, { getAdapter: () => null });
    for (const name of [
      'epic_list', 'epic_get', 'epic_create', 'epic_update',
      'feature_list', 'feature_get', 'feature_create', 'feature_update',
      'story_create', 'story_update',
    ]) {
      expect(cap.handlers.has(name)).toBe(true);
    }
  });

  it('every tool errors when not connected', async () => {
    const cap = captureAll();
    registerBacklogTools(cap.server, { getAdapter: () => null });
    for (const [name, args] of [
      ['epic_list', {}],
      ['epic_get', { id: 'EP_1' }],
      ['epic_create', { name: 'x', state: 's', estimatedEffort: 1, plannedStartDate: 'a', plannedEndDate: 'b' }],
      ['epic_update', { id: 'EP_1' }],
      ['feature_list', {}],
      ['feature_get', { id: 'FT_1' }],
      ['feature_create', { name: 'x', estimatedEffort: 1, plannedStartDate: 'a', plannedEndDate: 'b' }],
      ['feature_update', { id: 'FT_1' }],
      ['story_create', { name: 'x', state: 's', estimatedEffort: 1 }],
      ['story_update', { id: 'US_1' }],
    ] as const) {
      const res = await cap.handlers.get(name)!(args as Record<string, unknown>);
      expect(res.isError).toBe(true);
    }
  });

  it('surfaces adapter-does-not-support when a method is missing', async () => {
    const cap = captureAll();
    // Adapter with NO backlog methods at all — every tool must report "does not expose".
    const adapter = {} as ProviderAdapter;
    registerBacklogTools(cap.server, { getAdapter: () => adapter });
    const res = await cap.handlers.get('epic_list')!({});
    expect(res.isError).toBe(true);
    const text = (res.content?.[0] as { text?: string } | undefined)?.text ?? '';
    expect(text).toMatch(/does not expose/);
  });
});

describe('backlog.tools happy paths', () => {
  it('epic_list forwards user filters and renders markdown table', async () => {
    const cap = captureAll();
    let received: unknown;
    const rows: EpicSummary[] = [{ id: '1', key: 'EP_1', name: 'Alpha', state: 'open' }];
    const adapter = {
      listEpics: async (q: unknown) => { received = q; return rows; },
    } as unknown as ProviderAdapter;
    registerBacklogTools(cap.server, { getAdapter: () => adapter });
    const res = await cap.handlers.get('epic_list')!({
      search: 'alpha', createdBy: 'me', ownerId: '42',
    });
    expect(res.isError).toBeFalsy();
    expect(received).toEqual({ search: 'alpha', createdBy: 'me', ownerId: '42' });
    const sc = res.structuredContent as { epics: EpicSummary[] };
    expect(sc.epics).toEqual(rows);
    const text = (res.content?.[0] as { text?: string } | undefined)?.text ?? '';
    expect(text).toMatch(/EP_1/);
    expect(text).toMatch(/Alpha/);
  });

  it('epic_get returns the epic in structured content', async () => {
    const cap = captureAll();
    const epic: Epic = { id: '1', key: 'EP_1', name: 'Alpha', state: 'open', description: 'root cause' };
    const adapter = { getEpic: async () => epic } as unknown as ProviderAdapter;
    registerBacklogTools(cap.server, { getAdapter: () => adapter });
    const res = await cap.handlers.get('epic_get')!({ id: 'EP_1' });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { epic: Epic }).epic).toEqual(epic);
  });

  it('epic_create forwards the full input to the adapter', async () => {
    const cap = captureAll();
    let received: EpicInput | undefined;
    const adapter = {
      createEpic: async (input: EpicInput): Promise<SavedRef> => {
        received = input;
        return { id: '99', created: true };
      },
    } as unknown as ProviderAdapter;
    registerBacklogTools(cap.server, { getAdapter: () => adapter });
    const input: EpicInput = {
      name: 'Onboarding revamp', state: 'open', estimatedEffort: 40,
      plannedStartDate: '2026-01-01', plannedEndDate: '2026-03-01',
      description: 'Q1 initiative',
    };
    const res = await cap.handlers.get('epic_create')!(input as unknown as Record<string, unknown>);
    expect(res.isError).toBeFalsy();
    expect(received).toEqual(input);
    expect((res.structuredContent as { savedRef: SavedRef }).savedRef.id).toBe('99');
  });

  it('epic_update strips id from patch and forwards it separately', async () => {
    const cap = captureAll();
    let receivedId: string | undefined;
    let receivedPatch: EpicUpdate | undefined;
    const adapter = {
      updateEpic: async (id: string, patch: EpicUpdate): Promise<SavedRef> => {
        receivedId = id;
        receivedPatch = patch;
        return { id, created: false };
      },
    } as unknown as ProviderAdapter;
    registerBacklogTools(cap.server, { getAdapter: () => adapter });
    const res = await cap.handlers.get('epic_update')!({
      id: 'EP_7', state: 'in-progress', updateVersion: 3,
    });
    expect(res.isError).toBeFalsy();
    expect(receivedId).toBe('EP_7');
    expect(receivedPatch).toEqual({ state: 'in-progress', updateVersion: 3 });
  });

  it('feature_list passes epicId parent filter through', async () => {
    const cap = captureAll();
    let received: unknown;
    const rows: FeatureSummary[] = [
      { id: '10', key: 'FT_10', name: 'Signup', state: 'open', epicId: '1' },
    ];
    const adapter = {
      listFeatures: async (q: unknown) => { received = q; return rows; },
    } as unknown as ProviderAdapter;
    registerBacklogTools(cap.server, { getAdapter: () => adapter });
    const res = await cap.handlers.get('feature_list')!({ epicId: '1' });
    expect(res.isError).toBeFalsy();
    expect(received).toEqual({ epicId: '1' });
  });

  it('feature_get returns the feature', async () => {
    const cap = captureAll();
    const feature: Feature = { id: '10', key: 'FT_10', name: 'Signup', epicId: '1' };
    const adapter = { getFeature: async () => feature } as unknown as ProviderAdapter;
    registerBacklogTools(cap.server, { getAdapter: () => adapter });
    const res = await cap.handlers.get('feature_get')!({ id: 'FT_10' });
    expect((res.structuredContent as { feature: Feature }).feature).toEqual(feature);
  });

  it('feature_create forwards input including parent epicId', async () => {
    const cap = captureAll();
    let received: FeatureInput | undefined;
    const adapter = {
      createFeature: async (input: FeatureInput): Promise<SavedRef> => {
        received = input;
        return { id: '55', created: true };
      },
    } as unknown as ProviderAdapter;
    registerBacklogTools(cap.server, { getAdapter: () => adapter });
    const input: FeatureInput = {
      name: 'Social login', estimatedEffort: 20,
      plannedStartDate: '2026-01-10', plannedEndDate: '2026-02-01',
      epicId: 1, description: 'OAuth providers',
    };
    const res = await cap.handlers.get('feature_create')!(input as unknown as Record<string, unknown>);
    expect(res.isError).toBeFalsy();
    expect(received).toEqual(input);
  });

  it('feature_update forwards partial patch with updateVersion', async () => {
    const cap = captureAll();
    let receivedPatch: FeatureUpdate | undefined;
    const adapter = {
      updateFeature: async (_id: string, patch: FeatureUpdate): Promise<SavedRef> => {
        receivedPatch = patch;
        return { id: 'FT_10', created: false };
      },
    } as unknown as ProviderAdapter;
    registerBacklogTools(cap.server, { getAdapter: () => adapter });
    await cap.handlers.get('feature_update')!({
      id: 'FT_10', priority: 'high', updateVersion: 2,
    });
    expect(receivedPatch).toEqual({ priority: 'high', updateVersion: 2 });
  });

  it('story_create forwards story input (acceptanceCriteria as newline string)', async () => {
    const cap = captureAll();
    let received: StoryInput | undefined;
    const adapter = {
      createStory: async (input: StoryInput): Promise<SavedRef> => {
        received = input;
        return { id: '77', created: true };
      },
    } as unknown as ProviderAdapter;
    registerBacklogTools(cap.server, { getAdapter: () => adapter });
    const input: StoryInput = {
      name: 'As a user I can sign in', state: 'open', estimatedEffort: 5,
      epicId: 1, featureId: 10,
      acceptanceCriteria: 'User enters credentials\nUser sees dashboard',
    };
    const res = await cap.handlers.get('story_create')!(input as unknown as Record<string, unknown>);
    expect(res.isError).toBeFalsy();
    expect(received).toEqual(input);
  });

  it('story_update forwards partial patch, splits id off', async () => {
    const cap = captureAll();
    let receivedId: string | undefined;
    let receivedPatch: StoryUpdate | undefined;
    const adapter = {
      updateStory: async (id: string, patch: StoryUpdate): Promise<SavedRef> => {
        receivedId = id;
        receivedPatch = patch;
        return { id, created: false };
      },
    } as unknown as ProviderAdapter;
    registerBacklogTools(cap.server, { getAdapter: () => adapter });
    await cap.handlers.get('story_update')!({
      id: 'US_12', description: 'new desc', updateVersion: 7,
    });
    expect(receivedId).toBe('US_12');
    expect(receivedPatch).toEqual({ description: 'new desc', updateVersion: 7 });
  });
});
