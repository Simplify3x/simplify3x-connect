// tc_automate is a pure guide-composer now: reads the manual TC, returns a recording brief
// that names the granular agent tools (web_launch_application, web_snapshot, web_click, ...).
// No callRaw, no polling, no in-place update — the Electron /mcp-recorder window opens as a
// side-effect of the agent's web_launch_application, and the user saves from that UI to create
// a NEW automated TC. These tests pin the guide shape + the refusal paths.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { TestCase } from '../domain/types.js';
import { registerTestcaseTools } from './testcase.tools.js';
import { DraftStore } from '../drafts/store.js';

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

function captureHandler(name: string): { server: McpServer; get: () => Handler } {
  let handler: Handler | undefined;
  const server = {
    registerTool: (n: string, _meta: unknown, h: Handler) => { if (n === name) handler = h; },
  } as unknown as McpServer;
  return { server, get: () => { if (!handler) throw new Error(`${name} handler not registered`); return handler; } };
}

function mockAdapter(tc: TestCase): ProviderAdapter {
  return { getTestCase: async () => tc } as unknown as ProviderAdapter;
}

const baseTc: TestCase = {
  title: 'Complete purchase',
  priority: 'medium',
  category: 'manual',
  steps: [
    { n: 1, description: 'Navigate to app', stepType: 'web', actionType: 'manual' },
    { n: 2, description: 'Log in', stepType: 'web', actionType: 'manual' },
  ],
};

function bodyText(res: CallToolResult): string {
  const text = res.content?.find((c: { type: string }) => c.type === 'text');
  return (text as { text?: string } | undefined)?.text ?? '';
}

describe('tc_automate — recording-guide composer', () => {
  it('embeds userstoryId + moduleId from storyRef "US_7" and folderOrModule "12"', async () => {
    const cap = captureHandler('tc_automate');
    registerTestcaseTools(cap.server, {
      drafts: new DraftStore(),
      getAdapter: () => mockAdapter({ ...baseTc, storyRef: 'US_7', folderOrModule: '12' }),
    });
    const res = await cap.get()({ tcId: 'TC_42', url: 'https://saucedemo.com' });
    const body = bodyText(res);
    expect(body).toContain('userstoryId:7');
    expect(body).toContain('moduleId:12');
    expect(body).toContain('testcaseName:"Complete purchase"');
    expect(body).toContain('web_launch_application("https://saucedemo.com")');
    expect(body).toContain('web_snapshot');
    expect(body).toContain('is already selected');
    const sc = res.structuredContent as { userstoryId?: number; moduleId?: number };
    expect(sc.userstoryId).toBe(7);
    expect(sc.moduleId).toBe(12);
  });

  it('omits userstoryId when storyRef is absent (do not invent)', async () => {
    const cap = captureHandler('tc_automate');
    registerTestcaseTools(cap.server, {
      drafts: new DraftStore(),
      getAdapter: () => mockAdapter({ ...baseTc, folderOrModule: '12' }),
    });
    const res = await cap.get()({ tcId: 'TC_42', url: 'https://saucedemo.com' });
    const body = bodyText(res);
    expect(body).not.toContain('userstoryId:');
    expect(body).toContain('moduleId:12');
    expect(body).toContain('will need to be picked at Save');
  });

  it('coerces bare-numeric storyRef "7" (no US_ prefix) correctly', async () => {
    const cap = captureHandler('tc_automate');
    registerTestcaseTools(cap.server, {
      drafts: new DraftStore(),
      getAdapter: () => mockAdapter({ ...baseTc, storyRef: '7' }),
    });
    const res = await cap.get()({ tcId: 'TC_42', url: 'https://x' });
    expect(bodyText(res)).toContain('userstoryId:7');
  });

  it('refuses when the source TC is not manual', async () => {
    const cap = captureHandler('tc_automate');
    registerTestcaseTools(cap.server, {
      drafts: new DraftStore(),
      getAdapter: () => mockAdapter({ ...baseTc, category: 'automated' }),
    });
    const res = await cap.get()({ tcId: 'TC_42', url: 'https://x' });
    expect(res.isError).toBe(true);
    expect(bodyText(res)).toContain('not manual');
  });

  it('refuses when no URL is available (not in url arg, extra, or step text)', async () => {
    const cap = captureHandler('tc_automate');
    registerTestcaseTools(cap.server, {
      drafts: new DraftStore(),
      getAdapter: () => mockAdapter(baseTc),
    });
    const res = await cap.get()({ tcId: 'TC_42' });
    expect(res.isError).toBe(true);
    expect(bodyText(res)).toContain('I need the app URL');
  });

  it('accepts URL found inline in the manual step text', async () => {
    const cap = captureHandler('tc_automate');
    const tc: TestCase = { ...baseTc, steps: [
      { n: 1, description: 'Go to https://saucedemo.com', stepType: 'web', actionType: 'manual' },
    ] };
    registerTestcaseTools(cap.server, {
      drafts: new DraftStore(),
      getAdapter: () => mockAdapter(tc),
    });
    const res = await cap.get()({ tcId: 'TC_42' });
    expect(res.isError).toBeFalsy();
    expect(bodyText(res)).toContain('Manual steps');
  });
});
