// coverage.report — report_download, failure_analysis and the gap_analysis "next actions" block.
// The handlers are driven through the real in-process MCP server; the fake adapter records the
// exact download/analysis arguments so the tests pin what leaves the MCP, not just the wording.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { Story } from '../domain/types.js';
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

type Content = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

function contentOf(res: unknown): Content {
  return ((res as { content?: Content }).content ?? []);
}

function textOf(res: unknown): string {
  return contentOf(res).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
}

function structured<T>(res: unknown): T {
  return (res as { structuredContent?: T }).structuredContent as T;
}

describe('report_download', () => {
  it('errors when no product is connected', async () => {
    const { client, server } = await connect(null);
    try {
      const res = await client.callTool({ name: 'report_download', arguments: { target: 'testcase', ref: 'TC_1' } });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('Not connected to a product. Use qa_connect first');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns the choice list (and options) when reportTypes is omitted', async () => {
    const downloadReports = jest.fn();
    const adapter = { downloadReports } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({ name: 'report_download', arguments: { target: 'testcase', ref: 'TC_123' } });

      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toContain('Which report(s) do you want for this testcase?');
      expect(textOf(res)).toContain('`detailed` — detailed report');
      expect(textOf(res)).toContain('`summary` — summary report');
      expect(textOf(res)).toContain('then call `report_download` again with `reportTypes`');
      const sc = structured<{ needs?: string; options?: string[] }>(res);
      expect(sc.needs).toBe('reportTypes');
      expect(sc.options).toStrictEqual(['detailed', 'summary']);
      expect(downloadReports).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects a suite-only report type on a testcase target', async () => {
    const downloadReports = jest.fn();
    const adapter = { downloadReports } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({
        name: 'report_download',
        arguments: { target: 'testcase', ref: 'TC_123', reportTypes: ['suite'] },
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('Report type(s) "suite" are not available for a testcase.');
      expect(textOf(res)).toContain('Choose from: detailed, summary.');
      expect(downloadReports).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('downloads the requested kinds for an explicit execution and reports the files', async () => {
    const downloadReports = jest.fn(async () => ({
      scope: 'testcase' as const,
      runLabel: 'Build 42',
      files: [
        { kind: 'detailed' as const, label: 'Detailed report', path: '/tmp/qa/detailed.pdf', bytes: 2048 },
        { kind: 'summary' as const, label: 'Summary report', path: '/tmp/qa/summary.pdf', bytes: 1024 },
      ],
      notes: ['Protected parameters are masked.'],
    }));
    const adapter = { downloadReports } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({
        name: 'report_download',
        arguments: {
          target: 'testcase', ref: 'TC_123', reportTypes: ['detailed', 'summary'],
          runId: '42', outDir: '/tmp/qa',
        },
      });

      expect(res.isError).toBeFalsy();
      expect(downloadReports).toHaveBeenCalledWith({ runId: '42', kinds: ['detailed', 'summary'], outDir: '/tmp/qa' });
      expect(textOf(res)).toContain('Generated 2 PDF reports for testcase **TC_123** (Build 42).');
      expect(textOf(res)).toContain('Used execution EX-42 as requested.');
      expect(textOf(res)).toContain('- Detailed report — `/tmp/qa/detailed.pdf` (2 KB)');
      expect(textOf(res)).toContain('- Summary report — `/tmp/qa/summary.pdf` (1 KB)');
      expect(textOf(res)).toContain('Notes:\n- Protected parameters are masked.');
      expect(structured<{ execution?: string }>(res).execution).toBe('42');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('resolves a suite by name and reports on its most recent execution, naming the others', async () => {
    const listSuites = jest.fn(async () => [{ id: '31', name: 'Smoke Suite', memberCount: 4 }]);
    const listRecentRuns = jest.fn(async () => [
      { runId: '10', state: 'passed' as const, endedAt: '2026-01-01' },
      { runId: '9', state: 'failed' as const },
    ]);
    const downloadReports = jest.fn(async () => ({
      scope: 'suite' as const,
      runLabel: 'Suite run 10',
      files: [{ kind: 'suite' as const, label: 'Suite report', path: '/tmp/r/suite.pdf', bytes: 1024 }],
      notes: [],
    }));
    const adapter = { listSuites, listRecentRuns, downloadReports } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({
        name: 'report_download',
        arguments: { target: 'suite', ref: 'smoke suite', reportTypes: ['suite'] },
      });

      expect(res.isError).toBeFalsy();
      expect(listSuites).toHaveBeenCalledWith();
      expect(listRecentRuns).toHaveBeenCalledWith('SUITE', '31', 10);
      expect(downloadReports).toHaveBeenCalledWith({ runId: '10', kinds: ['suite'], outDir: expect.any(String) });
      expect(textOf(res)).toContain('Generated 1 PDF report for suite **smoke suite** (Suite run 10).');
      expect(textOf(res)).toContain('Used the most recent of');
      expect(textOf(res)).toContain('(EX-10, ended 2026-01-01)');
      expect(textOf(res)).toContain('pass `runId` to choose another: EX-9.');
    } finally {
      await client.close();
      await server.close();
    }
  });

});

describe('failure_analysis', () => {
  it('errors when no product is connected', async () => {
    const { client, server } = await connect(null);
    try {
      const res = await client.callTool({ name: 'failure_analysis', arguments: { code: 'TC-1' } });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('Not connected to a product.');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('requires code or executionId before calling the adapter', async () => {
    const getFailureReport = jest.fn();
    const adapter = { getFailureReport } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({ name: 'failure_analysis', arguments: { includeLogs: true } });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('Provide `code` (TC-123 / SU-123 / PL-123) or `executionId`');
      expect(getFailureReport).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('derives TC-<n> from tcId, forwards the flags and returns the card + inline screenshots', async () => {
    const getFailureReport = jest.fn(async () => ({
      text: '### Why TC-123 failed\n\n| step | error |\n|---|---|\n| 3 | timeout |',
      images: [{ caption: 'Screenshot: step 3', data: 'AAAA', mimeType: 'image/png' }],
    }));
    const adapter = { getFailureReport } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({
        name: 'failure_analysis',
        arguments: { tcId: 'TC_123', includeLogs: false, maxLogLines: 12, includeImages: true, includeScreenshots: false },
      });

      expect(res.isError).toBeFalsy();
      expect(getFailureReport).toHaveBeenCalledWith({
        code: 'TC-123',
        includeLogs: false,
        maxLogLines: 12,
        includeImages: true,
        includeScreenshots: false,
      });
      expect(textOf(res)).toContain('### Why TC-123 failed');
      const content = contentOf(res);
      expect(content.map((c) => c.type)).toStrictEqual(['text', 'text', 'image']);
      expect(content[1]!.text).toBe('Screenshot: step 3');
      expect(content[2]!.data).toBe('AAAA');
      expect(content[2]!.mimeType).toBe('image/png');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('gap_analysis — next-actions text', () => {
  it('emits tc_draft_create / story_update hints for no_tests and no_ac verdicts', async () => {
    const summaries = [
      { id: 'US_1', key: 'US_1', title: 'Story with no criteria' },
      { id: 'US_2', key: 'US_2', title: 'Story with no tests' },
    ];
    const listStories = jest.fn(async () => summaries);
    const getStory = jest.fn(async (id: string): Promise<Story> => (
      id === 'US_1'
        ? { id, key: id, title: 'Story with no criteria' }
        : { id, key: id, title: 'Story with no tests', acceptanceCriteria: ['User can pay'] }
    ));
    const listTestCases = jest.fn(async () => []);
    const adapter = { listStories, getStory, listTestCases } as unknown as ProviderAdapter;
    const { client, server } = await connect(adapter);
    try {
      const res = await client.callTool({ name: 'gap_analysis', arguments: { releaseId: 'R-1' } });

      expect(res.isError).toBeFalsy();
      expect(listStories).toHaveBeenCalledWith({ releaseId: 'R-1', limit: 500 });
      expect(textOf(res)).toContain('**Release R-1** · 2 stories · GAP SCORE 0/100 (critical)');
      expect(textOf(res)).toContain('Coverage: 0 covered · 0 partial · 1 no_tests · 1 no_ac');
      expect(textOf(res)).toContain('Next actions the caller can chain (nothing has been done):');
      expect(textOf(res)).toContain('tc_draft_create for US_2  (1 AC — no test yet)');
      expect(textOf(res)).toContain('story_update US_1 to add acceptanceCriteria');
      const sc = structured<{ counts?: { noTests?: number; noAc?: number } }>(res);
      expect(sc.counts?.noTests).toBe(1);
      expect(sc.counts?.noAc).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
