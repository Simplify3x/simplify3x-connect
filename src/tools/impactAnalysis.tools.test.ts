// impact_analysis — handler smoke tests. Cover: anchor-guard, story-anchor happy path
// (walks story → sprint → release + returns AT_RISK when an open critical defect exists),
// and sprint anchor rolling up to READY when clean.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { DefectSummary, Story, TestCase } from '../domain/types.js';
import { registerImpactAnalysisTools } from './impactAnalysis.tools.js';

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

describe('impact_analysis handler — anchor guards', () => {
  it('errors when not connected', async () => {
    const cap = captureHandler('impact_analysis');
    registerImpactAnalysisTools(cap.server, { getAdapter: () => null });
    const res = await cap.get()({ storyId: 'US_1' });
    expect(res.isError).toBe(true);
  });

  it('errors when no anchor is provided', async () => {
    const cap = captureHandler('impact_analysis');
    const adapter = { listStories: async () => [], getStory: async () => ({} as Story) } as unknown as ProviderAdapter;
    registerImpactAnalysisTools(cap.server, { getAdapter: () => adapter });
    const res = await cap.get()({});
    expect(res.isError).toBe(true);
  });
});

describe('impact_analysis handler — story anchor', () => {
  it('returns AT_RISK when an open critical defect hits the story', async () => {
    const story: Story = {
      id: 'US_10', key: 'US_10', title: 'Password reset',
      acceptanceCriteria: ['user requests reset', 'user receives email'],
      sprintId: 'SP_5', releaseId: 'R_2',
    };
    const tc: TestCase = {
      id: 'TC_20', title: 'Reset flow', priority: 'medium', category: 'manual',
      storyRef: 'US_10',
      steps: [
        mkStep(1, 'user requests reset', 'reset requested'),
        mkStep(2, 'user receives email', 'email received'),
      ],
    };
    const defects: DefectSummary[] = [
      { id: '77', code: 'DF_77', title: 'Reset email not sent', state: 'open', severity: 'critical', tcIds: ['TC_20'] },
    ];

    const adapter = {
      listStories: async (q: { sprintId?: string }) =>
        q.sprintId === 'SP_5' ? [{ id: 'US_10', key: 'US_10', title: 'Password reset' }] : [],
      getStory: async () => story,
      listTestCases: async () => [{ id: 'TC_20', title: 'Reset flow', priority: 'medium' }],
      getTestCase: async () => tc,
      listDefects: async () => defects,
      listSprints: async () => [{ id: 'SP_5', name: 'Sprint 5', releaseId: 'R_2', plannedEndDate: '2099-12-31' }],
      listReleases: async () => [{ id: 'R_2', name: 'Release 2', plannedEndDate: '2099-12-31' }],
    } as unknown as ProviderAdapter;

    const cap = captureHandler('impact_analysis');
    registerImpactAnalysisTools(cap.server, { getAdapter: () => adapter });
    const res = await cap.get()({ storyId: 'US_10' });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      verdict: string;
      chain: Array<{ kind: string; id: string }>;
      metrics: { openCriticalDefects: number };
    };
    expect(sc.verdict).toBe('AT_RISK');
    expect(sc.metrics.openCriticalDefects).toBe(1);
    // Chain reaches the release.
    expect(sc.chain.some((n) => n.kind === 'release' && n.id === 'R_2')).toBe(true);
  });
});

describe('impact_analysis handler — sprint anchor', () => {
  it('returns READY when the sprint has no defects and full coverage', async () => {
    const story: Story = {
      id: 'US_30', key: 'US_30', title: 'Audit log',
      acceptanceCriteria: ['action is logged'],
    };
    const tc: TestCase = {
      id: 'TC_30', title: 'Audit', priority: 'medium', category: 'manual',
      storyRef: 'US_30',
      steps: [mkStep(1, 'action is logged', 'row appears in log')],
    };
    const adapter = {
      listStories: async () => [{ id: 'US_30', key: 'US_30', title: 'Audit log' }],
      getStory: async () => story,
      listTestCases: async () => [{ id: 'TC_30', title: 'Audit', priority: 'medium' }],
      getTestCase: async () => tc,
      listDefects: async () => [],
      listSprints: async () => [{ id: 'SP_9', name: 'Sprint 9', plannedEndDate: '2099-12-31' }],
      listReleases: async () => [],
    } as unknown as ProviderAdapter;

    const cap = captureHandler('impact_analysis');
    registerImpactAnalysisTools(cap.server, { getAdapter: () => adapter });
    const res = await cap.get()({ sprintId: 'SP_9' });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { verdict: string; metrics: { openCriticalDefects: number; uncoveredAcs: number } };
    expect(sc.verdict).toBe('READY');
    expect(sc.metrics.openCriticalDefects).toBe(0);
    expect(sc.metrics.uncoveredAcs).toBe(0);
  });
});
