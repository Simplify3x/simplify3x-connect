// gap_analysis — handler smoke tests. Verify scope-guard, classification (covered / no_tests /
// partial / no_ac), and that gapScore comes out of the counts as advertised.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { Story, TestCase } from '../domain/types.js';
import { registerGapAnalysisTools } from './gapAnalysis.tools.js';

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

function captureHandler(name: string): { server: McpServer; get: () => Handler } {
  let handler: Handler | undefined;
  const server = {
    registerTool: (n: string, _meta: unknown, h: Handler) => {
      if (n === name) handler = h;
    },
  } as unknown as McpServer;
  return {
    server,
    get: () => {
      if (!handler) throw new Error(`${name} handler not registered`);
      return handler;
    },
  };
}

const mkStep = (n: number, description: string, expectedResult?: string) => ({
  n,
  description,
  actionType: 'manualStep',
  stepType: 'web' as const,
  ...(expectedResult ? { expectedResult } : {}),
});

describe('gap_analysis handler — scope guards', () => {
  it('errors when not connected', async () => {
    const cap = captureHandler('gap_analysis');
    registerGapAnalysisTools(cap.server, { getAdapter: () => null });
    const res = await cap.get()({ sprintId: 'SP_1' });
    expect(res.isError).toBe(true);
  });

  it('errors when no scope is provided', async () => {
    const cap = captureHandler('gap_analysis');
    const adapter = { listStories: async () => [], getStory: async () => ({} as Story) } as unknown as ProviderAdapter;
    registerGapAnalysisTools(cap.server, { getAdapter: () => adapter });
    const res = await cap.get()({});
    expect(res.isError).toBe(true);
    expect(String((res.content?.[0] as { text?: string })?.text ?? '')).toMatch(/exactly one/i);
  });

  it('errors when two scopes are provided', async () => {
    const cap = captureHandler('gap_analysis');
    const adapter = { listStories: async () => [], getStory: async () => ({} as Story) } as unknown as ProviderAdapter;
    registerGapAnalysisTools(cap.server, { getAdapter: () => adapter });
    const res = await cap.get()({ sprintId: 'SP_1', releaseId: 'R_1' });
    expect(res.isError).toBe(true);
    expect(String((res.content?.[0] as { text?: string })?.text ?? '')).toMatch(/exactly one scope/i);
  });
});

describe('gap_analysis handler — classification', () => {
  it('classifies covered / no_tests / no_ac and computes gapScore', async () => {
    // Three stories in the sprint:
    //   US_1 has 1 AC and a TC whose only step matches it     → covered
    //   US_2 has 1 AC and NO test cases                       → no_tests
    //   US_3 has NO ACs                                       → no_ac
    const storiesById: Record<string, Story> = {
      US_1: { id: 'US_1', key: 'US_1', title: 'Login', acceptanceCriteria: ['user submits valid credentials'] },
      US_2: { id: 'US_2', key: 'US_2', title: 'Logout', acceptanceCriteria: ['user clicks logout button'] },
      US_3: { id: 'US_3', key: 'US_3', title: 'Roles' },
    };
    const tcsByStory: Record<string, TestCase[]> = {
      US_1: [
        {
          id: 'TC_1', title: 'Login flow', priority: 'medium', category: 'manual',
          storyRef: 'US_1',
          steps: [mkStep(1, 'user submits valid credentials', 'session started')],
        },
      ],
      US_2: [],
      US_3: [],
    };

    const adapter = {
      listStories: async () => [
        { id: 'US_1', key: 'US_1', title: 'Login' },
        { id: 'US_2', key: 'US_2', title: 'Logout' },
        { id: 'US_3', key: 'US_3', title: 'Roles' },
      ],
      getStory: async (id: string) => storiesById[id]!,
      listTestCases: async (q: { storyId?: string }) =>
        (tcsByStory[q.storyId ?? ''] ?? []).map((tc) => ({
          id: tc.id!, title: tc.title, priority: tc.priority as string,
        })),
      getTestCase: async (id: string) => {
        for (const tcs of Object.values(tcsByStory)) {
          const hit = tcs.find((t) => t.id === id);
          if (hit) return hit;
        }
        throw new Error(`no such tc ${id}`);
      },
    } as unknown as ProviderAdapter;

    const cap = captureHandler('gap_analysis');
    registerGapAnalysisTools(cap.server, { getAdapter: () => adapter });
    const res = await cap.get()({ sprintId: 'SP_1' });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      gapScore: number;
      counts: { total: number; covered: number; noTests: number; noAc: number; partial: number };
      stories: Array<{ verdict: string; key?: string }>;
    };
    expect(sc.counts.total).toBe(3);
    expect(sc.counts.covered).toBe(1);
    expect(sc.counts.noTests).toBe(1);
    expect(sc.counts.noAc).toBe(1);
    // 1 covered + 0 partial out of 3 → 33
    expect(sc.gapScore).toBe(33);
    const byKey = Object.fromEntries(sc.stories.map((s) => [s.key, s.verdict]));
    expect(byKey.US_1).toBe('covered');
    expect(byKey.US_2).toBe('no_tests');
    expect(byKey.US_3).toBe('no_ac');
  });
});
