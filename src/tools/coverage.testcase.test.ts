// coverage.testcase — the authoring/save surface (tc_draft_*, tc_save create-vs-update, the
// recorder-save and journal-fallback paths, tc_automate guides) plus the per-environment testdata
// tools. Driven through a real in-process MCP client against a real DraftStore, so the create →
// update binding and the unsaved-draft rules are exercised as a caller sees them.
//
// Fake adapters carry `listAgentTools` (no `callRaw`) unless the test is about the recorder hop, so
// the recording passthrough either short-circuits or stays out of the way.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { TestCase } from '../domain/types.js';
import { DraftStore } from '../drafts/store.js';
import { buildServer } from '../server.js';

type Harness = { client: Client; server: McpServer };

async function connect(adapter: ProviderAdapter | null, drafts = new DraftStore()): Promise<Harness> {
  const server = buildServer({
    adapter,
    connection: undefined,
    mode: 'connected',
    drafts,
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

const NO_AGENT = { listAgentTools: async () => [{ name: 'info' }] };

const manualTc = (over: Partial<TestCase> = {}): TestCase => ({
  id: '42',
  title: 'Login flow',
  category: 'manual',
  technologyType: 'WEB',
  storyRef: 'US_7',
  folderOrModule: 'MOD_12',
  preconditions: 'Have an account',
  currentVersionId: 'v-1',
  versions: [{ id: 'v-1', name: 'v1.0', isCurrent: true }],
  steps: [{ n: 1, description: 'Enter admin in Username', stepType: 'manual', actionType: 'manual', expectedResult: 'Logged in' }],
  ...over,
});

describe('tc_save — draft path', () => {
  it('creates a draft as a test case, files it under the Default Module, renames a taken title, then UPDATES it', async () => {
    const createTestCase = jest.fn(async (_tc: TestCase) => ({ id: '100', productUrl: 'https://qa/tc/100' }));
    const updateTestCase = jest.fn(async (_id: string, _tc: TestCase) => ({ id: '100' }));
    const listModules = jest.fn(async () => [{ id: '7', name: 'Default Module' }]);
    const listTestCases = jest.fn(async () => [{ id: '1', code: 'TC_1', title: 'Login' }]);
    const { client, server } = await connect({
      ...NO_AGENT, createTestCase, updateTestCase, listModules, listTestCases,
    } as unknown as ProviderAdapter);
    try {
      const made = await client.callTool({
        name: 'tc_draft_create',
        arguments: {
          title: 'Login',
          category: 'automated',
          steps: [{ description: 'Open ${url}', actionType: 'Click', stepType: 'web' }],
          data: { url: 'https://shop.test' },
        },
      });
      expect(made.isError).toBeFalsy();
      const draftId = structured<{ draftId: string }>(made).draftId;

      const created = await client.callTool({ name: 'tc_save', arguments: { draftId } });
      expect(created.isError).toBeFalsy();
      expect(listModules).toHaveBeenCalled();
      expect(listTestCases).toHaveBeenCalledWith({ search: 'Login', limit: 200 });
      const savedTc = createTestCase.mock.calls.at(-1)![0] as TestCase;
      expect(savedTc).toMatchObject({ title: 'Login_1', folderOrModule: '7', category: 'automated' });
      expect(textOf(created)).toContain('Created test case 100. "Login" already existed, so it was saved as "Login_1".');
      expect(textOf(created)).toContain('https://qa/tc/100');
      expect(structured<{ saved: { id: string }; draftId: string }>(created)).toMatchObject({
        saved: { id: '100' },
        draftId,
      });

      // The draft is now bound to the created id — a second save is an UPDATE, not a duplicate.
      const updated = await client.callTool({ name: 'tc_save', arguments: { draftId } });
      expect(updated.isError).toBeFalsy();
      expect(createTestCase).toHaveBeenCalledTimes(1);
      expect(updateTestCase).toHaveBeenCalledTimes(1);
      expect(updateTestCase.mock.calls[0]![0]).toBe('100');
      expect(textOf(updated)).toContain('Updated test case 100.');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('refuses a missing draft, an empty draft, unresolvable step tokens and a bad argument pair', async () => {
    const createTestCase = jest.fn();
    const { client, server } = await connect({ ...NO_AGENT, createTestCase } as unknown as ProviderAdapter);
    try {
      const both = await client.callTool({ name: 'tc_save', arguments: { draftId: 'd1', sessionId: 's1' } });
      expect(both.isError).toBe(true);
      expect(textOf(both)).toContain('Pass exactly one of draftId (save a draft) or sessionId');

      const missing = await client.callTool({ name: 'tc_save', arguments: { draftId: 'nope' } });
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toContain('No draft "nope". Author one with tc_draft_create');

      const empty = await client.callTool({ name: 'tc_draft_create', arguments: { title: 'Nothing yet', category: 'automated' } });
      const emptyId = structured<{ draftId: string }>(empty).draftId;
      const emptySave = await client.callTool({ name: 'tc_save', arguments: { draftId: emptyId } });
      expect(emptySave.isError).toBe(true);
      expect(textOf(emptySave)).toContain('the draft has no steps, so there is nothing to persist');

      const tokened = await client.callTool({
        name: 'tc_draft_create',
        arguments: {
          title: 'Manual login',
          category: 'manual',
          steps: [{ description: 'Enter ${username} in the Username field', actionType: 'manual', stepType: 'manual' }],
        },
      });
      const tokenedId = structured<{ draftId: string }>(tokened).draftId;
      const tokenedSave = await client.callTool({ name: 'tc_save', arguments: { draftId: tokenedId } });
      expect(tokenedSave.isError).toBe(true);
      expect(textOf(tokenedSave)).toContain('these step tokens have no resolvable value: step 1: ${username}');
      expect(createTestCase).not.toHaveBeenCalled();

      // A RECORDED value lives in recordedParam, not in `data`/`value` — it must satisfy the check
      // (the save builder binds it and the backend writes it into the default test-data row). Without
      // this the recorded step was refused and its parameter landed with an empty test-data cell.
      const recorded = await client.callTool({
        name: 'tc_draft_create',
        arguments: {
          title: 'Recorded token',
          category: 'automated',
          steps: [{
            description: 'Click ${lob_name}', actionType: 'Click', stepType: 'web',
            objectRef: { id: '198' }, recordedParam: { lob_name: 'Medical-FI' },
          }],
        },
      });
      const recordedId = structured<{ draftId: string }>(recorded).draftId;
      const recordedSave = await client.callTool({ name: 'tc_save', arguments: { draftId: recordedId } });
      expect(textOf(recordedSave)).not.toContain('no resolvable value');
      expect(createTestCase).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('runs the draft lifecycle: create, get, edit, open as a link, discard', async () => {
    const { client, server } = await connect(NO_AGENT as unknown as ProviderAdapter);
    try {
      const created = await client.callTool({
        name: 'tc_draft_create',
        arguments: {
          title: 'Draft steps',
          category: 'manual',
          steps: [{ description: 'Open the app', actionType: 'manual', stepType: 'manual' }],
        },
      });
      expect(created.isError).toBeFalsy();
      const draftId = structured<{ draftId: string }>(created).draftId;
      expect(textOf(created)).toContain(`Draft ${draftId} ·`);

      const added = await client.callTool({
        name: 'tc_draft_update',
        arguments: {
          draftId,
          ops: [
            { op: 'set_meta', patch: { title: 'Draft steps v2' } },
            { op: 'add_step', step: { description: 'Click login', actionType: 'manual', stepType: 'manual' } },
          ],
        },
      });
      expect(added.isError).toBeFalsy();
      const sc = structured<{ tc: TestCase; issues: unknown[] }>(added);
      expect(sc.tc.title).toBe('Draft steps v2');
      expect(sc.tc.steps.map((s) => s.n)).toStrictEqual([1, 2]);
      expect(sc.issues).toStrictEqual([]);

      const got = await client.callTool({ name: 'tc_draft_get', arguments: { draftId } });
      expect(got.isError).toBeFalsy();
      expect(structured<{ tc: TestCase }>(got).tc.steps).toHaveLength(2);

      const opened = await client.callTool({ name: 'tc_draft_open', arguments: { draftId, frontendOrigin: 'https://ui.test/' } });
      expect(opened.isError).toBeFalsy();
      const url = structured<{ url: string; openedIn: string }>(opened).url;
      expect(structured<{ openedIn: string }>(opened).openedIn).toBe('link');
      expect(url.startsWith('https://ui.test/embed/test-case-draft#d=')).toBe(true);
      expect(decodeURIComponent(Buffer.from(url.split('#d=')[1]!, 'base64url').toString('utf8'))).toContain('Draft steps v2');

      const discarded = await client.callTool({ name: 'tc_draft_discard', arguments: { draftId } });
      expect(discarded.isError).toBeFalsy();
      expect(textOf(discarded)).toContain(`Discarded draft ${draftId}. Nothing was ever persisted.`);

      const gone = await client.callTool({ name: 'tc_draft_get', arguments: { draftId } });
      expect(gone.isError).toBe(true);
      expect(textOf(gone)).toContain(`No draft found for id "${draftId}"`);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('tc_save — live recording path', () => {
  it('asks the recorder window to save and reports the test case, testdata copy and formulas', async () => {
    const callRaw = jest.fn(async (name: string) => {
      if (name === 'core_active_recordings') return { structuredContent: { recordings: [] } };
      return {
        structuredContent: {
          saved: { tcId: '555', code: 'TC-555', productUrl: 'https://qa/tc/555', versionName: 'v2.0', formulasApplied: 2 },
        },
      };
    });
    const copyTestdata = jest.fn(async () => ({ copied: 3, skipped: ['ghost'] }));
    const { client, server } = await connect({ callRaw, copyTestdata } as unknown as ProviderAdapter);
    try {
      const res = await client.callTool({
        name: 'tc_save',
        arguments: { sessionId: 's-1', replaceWithFunctions: false, copyTestdataFrom: '42' },
      });
      expect(res.isError).toBeFalsy();
      expect(callRaw).toHaveBeenCalledWith('core_save_session', { sessionId: 's-1', timeoutMs: 60000 });
      expect(copyTestdata).toHaveBeenCalledWith({ fromTcId: '42', toTcId: '555' });
      const text = textOf(res);
      expect(text).toContain('Created test case TC-555 as v2.0.');
      expect(text).toContain('https://qa/tc/555');
      expect(text).toContain('Testdata copied from 42: 3 value(s); skipped (no matching parameter): ghost.');
      expect(text).toContain('2 recorded formula(s) applied to the default test-data iteration.');
      expect(structured<{ saved: Record<string, unknown> }>(res).saved).toStrictEqual({
        id: '555', productUrl: 'https://qa/tc/555', copyTestdataFrom: '42', formulasApplied: 2, versionName: 'v2.0',
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('falls back to the journal when the recorder save fails, creating a NEW VERSION of the target TC', async () => {
    const callRaw = jest.fn(async (name: string) => {
      if (name === 'core_active_recordings') {
        return {
          structuredContent: {
            recordings: [{ testcaseId: '42', versionId: 'v-1', saveMode: 'new-version', copyTestdata: true }],
          },
        };
      }
      throw new Error('recorder save request failed: null');
    });
    const base: TestCase = {
      id: '42', title: 'Login flow', category: 'automated', folderOrModule: '7',
      currentVersionId: 'v-1', versions: [{ id: 'v-1', name: 'v1.0', isCurrent: true }], steps: [],
    };
    const readJournal = jest.fn(async () => ({
      tcId: 's-1',
      source: 'journal' as const,
      steps: [{
        n: 1, description: 'POST /login', actionType: 'API Call', stepType: 'web' as const,
        apiData: { method: 'POST', url: 'https://api.test/login' },
        recordedParam: { token: 'abc' }, recordedParamFormula: { token: '=UUID()' },
      }],
    }));
    const evaluateFormula = jest.fn(async () => ({ value: 'uuid-1', expression: '=UUID()' }));
    const patchTestdataCells = jest.fn(async () => ({ patched: 1, skipped: [] }));
    const saveAsNewVersion = jest.fn(async (_tcId: string, _opts: Record<string, unknown>) => ({ id: '42', productUrl: 'https://qa/tc/42' }));
    const getTestCase = jest.fn(async () => base);
    const { client, server } = await connect({
      callRaw, readJournal, evaluateFormula, patchTestdataCells, saveAsNewVersion, getTestCase,
    } as unknown as ProviderAdapter);
    try {
      const res = await client.callTool({
        name: 'tc_save', arguments: { sessionId: 's-1', replaceWithFunctions: false },
      });
      expect(res.isError).toBeFalsy();
      const text = textOf(res);
      expect(text).toContain('Created v2.0 of 42 from the recording journal — the recorder\'s own Save was unavailable (recorder save request failed: null).');
      expect(text).toContain('Parameters and test data were rebuilt from the journal\'s recorded values.');
      expect(text).toContain('1 formula(s) were applied to the default test-data row.');

      const [, opts] = saveAsNewVersion.mock.calls.at(-1) as unknown as [string, {
        versionName: string; tc: TestCase; tdCopy: boolean; sourceVersionId?: string;
      }];
      expect(saveAsNewVersion.mock.calls.at(-1)![0]).toBe('42');
      expect(opts.versionName).toBe('v2.0');
      expect(opts.tdCopy).toBe(true);
      expect(opts.sourceVersionId).toBe('v-1');
      // The journal's "API Call" row is normalised into a real API step, and the EXISTING TC's
      // metadata (title / module) is preserved rather than replaced.
      expect(opts.tc.steps[0]).toMatchObject({ stepType: 'api', api: { method: 'POST' } });
      expect(opts.tc.title).toBe('Login flow');
      expect(evaluateFormula).toHaveBeenCalledWith({ expression: '=UUID()' });
      expect(patchTestdataCells).toHaveBeenCalledWith({
        tcId: '42', cells: [{ paramName: 'token', value: 'uuid-1', formulaValue: '=UUID()' }], versionId: 'v-1',
      });
      expect(structured<{ saved: Record<string, unknown> }>(res).saved).toMatchObject({
        id: '42', versionName: 'v2.0', via: 'journal', formulasApplied: 1,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('tc_automate', () => {
  it('builds a WEB recording guide from a manual TC, carrying the story, module and source testdata', async () => {
    const getTestCase = jest.fn(async () => manualTc());
    const getDefaultIteration = jest.fn(async () => ({
      tcId: '42', versionId: 'v-1', environmentType: 'general',
      parameters: [
        { paramId: 1, name: 'username', seed: 'admin' },
        { paramId: 2, name: 'password', seed: '*****', protected: true },
      ],
    }));
    const { client, server } = await connect({ ...NO_AGENT, getTestCase, getDefaultIteration } as unknown as ProviderAdapter);
    try {
      const res = await client.callTool({
        name: 'tc_automate',
        arguments: { tcId: '42', url: 'https://app.test', extra: 'Use admin/admin123' },
      });
      expect(res.isError).toBeFalsy();
      const text = textOf(res);
      expect(text).toContain('testcaseName:"Login flow"');
      expect(text).toContain('Story: userstoryId:7 — is already selected in the recorder\'s story picker.');
      expect(text).toContain('Module: moduleId:12 — is already selected in the recorder\'s module bar.');
      expect(text).toContain('Preconditions: Have an account');
      expect(text).toContain('Start URL: https://app.test');
      expect(text).toContain('1. Enter admin in Username (expect: Logged in)');
      expect(text).toContain('- username = "admin"');
      expect(text).toContain('- password = [PROTECTED on the source TC — ASK the user for the value; do not invent]');
      expect(text).toContain('core_activate_technology({ technology: "WEB", testcaseName, userstoryId: 7 (REQUIRED');
      expect(text).toContain('web_launch_application("https://app.test")');
      expect(text).toContain('tc_save({ sessionId, copyTestdataFrom: "42" })');
      expect(getDefaultIteration).toHaveBeenCalledWith({ tcId: '42', versionId: 'v-1' });
      const sc = structured<{
        sourceTcId: string; userstoryId: number; moduleId: number;
        testData: { environmentType: string; parameters: Array<Record<string, unknown>> };
      }>(res);
      expect(sc.sourceTcId).toBe('42');
      expect(sc.userstoryId).toBe(7);
      expect(sc.moduleId).toBe(12);
      expect(sc.testData.environmentType).toBe('general');
      expect(sc.testData.parameters[1]).toStrictEqual({ name: 'password', seed: '*****', protected: true });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('refuses a non-manual source and a manual source with no URL, and builds a DESKTOP guide', async () => {
    const automated = jest.fn(async () => manualTc({ category: 'automated' }));
    const automatedRun = await connect({ ...NO_AGENT, getTestCase: automated } as unknown as ProviderAdapter);
    try {
      const res = await automatedRun.client.callTool({ name: 'tc_automate', arguments: { tcId: '42', url: 'https://x' } });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('is not manual (category: automated).');
      expect(textOf(res)).toContain('tc_automate promotes MANUAL → automated.');
    } finally {
      await automatedRun.client.close();
      await automatedRun.server.close();
    }

    const getTestCase = jest.fn(async () => manualTc({ steps: [{ n: 1, description: 'Click login', stepType: 'manual', actionType: 'manual' }] }));
    const { client, server } = await connect({ ...NO_AGENT, getTestCase } as unknown as ProviderAdapter);
    try {
      const noUrl = await client.callTool({ name: 'tc_automate', arguments: { tcId: '42' } });
      expect(noUrl.isError).toBe(true);
      expect(textOf(noUrl)).toContain('To automate "Login flow" I need the app URL — the manual steps don\'t contain one.');

      const desktopAdapter = jest.fn(async () => manualTc({ technologyType: 'DESKTOP', steps: [{ n: 1, description: 'Open the app', stepType: 'manual', actionType: 'manual' }] }));
      const desktop = await connect({ ...NO_AGENT, getTestCase: desktopAdapter } as unknown as ProviderAdapter);
      try {
        const guide = await desktop.client.callTool({
          name: 'tc_automate',
          arguments: { tcId: '42', app_path: 'C:\\apps\\demo.exe' },
        });
        expect(guide.isError).toBeFalsy();
        expect(textOf(guide)).toContain('Application: C:\\apps\\demo.exe');
        expect(textOf(guide)).toContain('core_activate_technology({ technology: "DESKTOP", testcaseName,');
        expect(textOf(guide)).toContain('desktop_launch_application({ app_path: "C:\\\\apps\\\\demo.exe" })');
        expect(structured<{ technology: string }>(guide).technology).toBe('DESKTOP');
      } finally {
        await desktop.client.close();
        await desktop.server.close();
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('testdata tools', () => {
  const tpl = {
    tcId: '42', versionId: 'v-1', environmentType: 'general',
    parameters: [
      { paramId: 1, name: 'username', seed: 'admin' },
      { paramId: 2, name: 'password', seed: '*****', protected: true },
    ],
  };
  const envs = [
    { id: 'e1', name: 'General', key: 'general', isDefault: true },
    { id: 'e2', name: 'UAT', key: 'uat' },
  ];

  it('lists environments and reads a template, including a called function row and a protected seed', async () => {
    const listEnvironments = jest.fn(async () => envs);
    const getDefaultIteration = jest.fn(async () => tpl);
    const getTestCase = jest.fn(async () => ({
      ...manualTc({ category: 'automated', steps: [] }),
      steps: [
        { n: 1, description: 'Call login', stepType: 'function' as const, actionType: '', functionCall: { testCaseId: '9', testCaseCode: 'FN_9', testCaseName: 'Login helper', versionId: 'fv-1', versionName: 'v2.0' } },
        { n: 2, description: 'Call login again', stepType: 'function' as const, actionType: '', functionCall: { testCaseId: '9', testCaseCode: 'FN_9', testCaseName: 'Login helper', versionId: 'fv-1', versionName: 'v2.0' } },
      ],
    }));
    // Two versions on the TC: the tool must ask before reading testdata.
    const { client, server } = await connect({
      ...NO_AGENT, listEnvironments, getDefaultIteration,
      getTestCase: async () => ({
        ...(await getTestCase()),
        versions: [{ id: 'v-1', name: 'v1.0', isCurrent: true }, { id: 'v-2', name: 'v2.0' }],
      }),
    } as unknown as ProviderAdapter);
    try {
      const envList = await client.callTool({ name: 'tc_list_environments', arguments: {} });
      expect(envList.isError).toBeFalsy();
      expect(textOf(envList)).toContain('2 environments configured — ask the user which one');
      expect(textOf(envList)).toContain('- General (default) · key: general');
      expect(textOf(envList)).toContain('- UAT · key: uat');

      const noEnv = await client.callTool({ name: 'tc_get_testdata', arguments: { tcId: '42' } });
      expect(noEnv.isError).toBe(true);
      expect(textOf(noEnv)).toContain('environmentType is required');

      const badEnv = await client.callTool({ name: 'tc_get_testdata', arguments: { tcId: '42', environmentType: 'production' } });
      expect(badEnv.isError).toBe(true);
      expect(textOf(badEnv)).toContain('"production" is not a configured environment for this project — configured options are: General · key: general, UAT · key: uat.');
      expect(getDefaultIteration).not.toHaveBeenCalled();

      const versions = await client.callTool({ name: 'tc_get_testdata', arguments: { tcId: '42', environmentType: 'general' } });
      expect(versions.isError).toBe(true);
      expect(textOf(versions)).toContain('has 2 versions — ASK the user which one they want testdata for');

      const res = await client.callTool({
        name: 'tc_get_testdata', arguments: { tcId: '42', environmentType: 'general', versionId: '' },
      });
      expect(res.isError).toBeFalsy();
      const text = textOf(res);
      expect(text).toContain('Testdata template for 42 · env general · version v-1');
      expect(text).toContain('3 row(s) (1 of these is a called function\'s name + version, not its testdata):');
      expect(text).toContain('- username = "admin"');
      expect(text).toContain('- password = ***** [PROTECTED — value hidden, not exposed by this tool]');
      expect(text).toContain('- FN_9 - Login helper (called function) = "v2.0"');
      expect(text).toContain('call tc_get_testdata again with tcId: "9", entityType: "FN", versionId: "fv-1", environmentType: "general"');
      expect(getDefaultIteration).toHaveBeenCalledWith({ tcId: '42', environmentType: 'general' });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('saves generated rows, promoting "=NAME(...)" cells to formulas and masking protected columns', async () => {
    const listEnvironments = jest.fn(async () => envs);
    const getDefaultIteration = jest.fn(async () => tpl);
    const saveGeneratedIterations = jest.fn(async () => ({ tcId: '42', inserted: 2, datasetUrl: 'https://qa/ds/1' }));
    const { client, server } = await connect({
      ...NO_AGENT, listEnvironments, getDefaultIteration, saveGeneratedIterations,
      getTestCase: async () => manualTc({ category: 'automated', versions: [{ id: 'v-1', name: 'v1.0', isCurrent: true }] }),
    } as unknown as ProviderAdapter);
    try {
      const nothing = await client.callTool({
        name: 'tc_generate_testdata', arguments: { tcId: '42', environmentType: 'general' },
      });
      expect(nothing.isError).toBe(true);
      expect(textOf(nothing)).toContain('Provide either `rows` (1..20) or `formulas` together with `count` (1..20).');

      const incomplete = await client.callTool({
        name: 'tc_generate_testdata',
        arguments: { tcId: '42', environmentType: 'general', formulas: { username: {} }, count: 1 },
      });
      expect(incomplete.isError).toBe(true);
      expect(textOf(incomplete)).toContain('Formula for column(s) username needs a `name` (from tc_list_formulas) or a full `expression`.');

      const res = await client.callTool({
        name: 'tc_generate_testdata',
        arguments: {
          tcId: '42', environmentType: 'general',
          rows: [{ Username: 'admin', password: 'seed', UnknownCol: 'x' }, { username: '=FIRST_NAME()' }],
        },
      });
      expect(res.isError).toBeFalsy();
      expect(saveGeneratedIterations).toHaveBeenCalledWith({
        tcId: '42',
        versionId: 'v-1',
        environmentType: 'general',
        rows: [{ username: 'admin', password: 'seed' }, {}],
        parameters: tpl.parameters,
        formulas: { username: { expression: '=FIRST_NAME()' } },
      });
      const text = textOf(res);
      expect(text).toContain('Saved 2 testdata row(s) for 42 · env general.');
      expect(text).toContain('https://qa/ds/1');
      expect(text).toContain('Formula columns: username (evaluated per row).');
      expect(text).toContain('(Ignored unknown param name(s): UnknownCol — not in the template.)');
      expect(text).toContain('Protected column(s) [password] are masked below');
      expect(text).toContain('1. username=admin | password=*****');
      expect(text).toContain('2. username=<=FIRST_NAME()> | password=');
      const sc = structured<{ generated: number; preview: Array<Record<string, string>> }>(res);
      expect(sc.generated).toBe(2);
      expect(sc.preview[0]!['password']).toBe('*****');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('updates the DEFAULT iteration cells, evaluating formulas and reading the row back', async () => {
    const listEnvironments = jest.fn(async () => envs);
    const evaluateFormula = jest.fn(async () => ({ value: 'Ani', expression: '=FIRST_NAME()' }));
    const patchTestdataCells = jest.fn(async () => ({ patched: 2, skipped: ['ghost: not in template'] }));
    const getDefaultIteration = jest.fn(async () => ({
      ...tpl,
      parameters: [
        { paramId: 1, name: 'username', seed: 'Ani' },
        { paramId: 2, name: 'password', seed: '*****', protected: true },
      ],
    }));
    const { client, server } = await connect({
      ...NO_AGENT, listEnvironments, evaluateFormula, patchTestdataCells, getDefaultIteration,
      getTestCase: async () => manualTc({ category: 'automated' }),
    } as unknown as ProviderAdapter);
    try {
      const noCellValue = await client.callTool({
        name: 'tc_update_testdata',
        arguments: { tcId: '42', environmentType: 'general', cells: [{ param: 'username' }] },
      });
      expect(noCellValue.isError).toBe(true);
      expect(textOf(noCellValue)).toContain('Cell "username": give a `value` or a `formula`.');

      const res = await client.callTool({
        name: 'tc_update_testdata',
        arguments: {
          tcId: '42', environmentType: 'general',
          cells: [{ param: 'username', formula: { name: 'FIRST_NAME' } }, { param: 'password', value: '' }],
        },
      });
      expect(res.isError).toBeFalsy();
      expect(evaluateFormula).toHaveBeenCalledWith({ name: 'FIRST_NAME' });
      expect(patchTestdataCells).toHaveBeenCalledWith({
        tcId: '42',
        cells: [
          { paramName: 'username', value: 'Ani', formulaValue: '=FIRST_NAME()' },
          { paramName: 'password', value: '' },
        ],
        environmentType: 'general',
        overwriteFormula: true,
      });
      const text = textOf(res);
      expect(text).toContain('Updated 2 cell(s) on the DEFAULT test data row of 42 · env general.');
      expect(text).toContain('- username = =FIRST_NAME()  →  Ani');
      expect(text).toContain('- password = (empty)');
      expect(text).toContain('Skipped: ghost: not in template');
      expect(text).toContain('Default iteration (ITR-1) now:');
      expect(text).toContain('- password = *****');
      expect(structured<{ patched: number; readBack: Array<{ name: string; seed: string }> }>(res).readBack).toStrictEqual([
        { name: 'username', seed: 'Ani' },
        { name: 'password', seed: '*****' },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('reads, copies and deletes SUITE-level test-data rows without touching member test cases', async () => {
    const rows = {
      entityType: 'SU' as const, id: 'SU-24', testdataId: 'td-1', environmentType: 'general',
      defaultIterationId: 'i1',
      iterations: [
        { id: 'i1', name: 'ITR-1', data: [{ paramId: 1, name: 'u', value: 'a' }, { paramId: 2, name: 'p', value: 'x', formulaValue: '=PICK_RANDOM(a,b)' }] },
        { id: 'i2', name: 'ITR-2', data: [{ paramId: 1, value: 'b' }] },
      ],
      parameterNames: { '1': 'u', '2': 'p' },
    };
    const getSuiteTestdata = jest.fn(async () => rows);
    const copySuiteTestdataIteration = jest.fn(async () => ({ iterationId: 'i3', name: 'ITR-3', rows }));
    const deleteTestdataIterations = jest.fn(async () => ({ deleted: ['ITR-3'], rows }));
    const { client, server } = await connect({
      ...NO_AGENT, getSuiteTestdata, copySuiteTestdataIteration, deleteTestdataIterations,
      listEnvironments: async () => envs,
    } as unknown as ProviderAdapter);
    try {
      const read = await client.callTool({
        name: 'suite_get_testdata', arguments: { suiteId: 'SU-24', environmentType: 'general' },
      });
      expect(read.isError).toBeFalsy();
      const text = textOf(read);
      expect(text).toContain('Suite SU-24 · env general · 2 row(s)');
      expect(text).toContain('- ITR-1 (default): u=a, p=x [=PICK_RANDOM(a,b)]');
      expect(text).toContain('- ITR-2: u=b');
      expect(getSuiteTestdata).toHaveBeenCalledWith({ suiteId: 'SU-24', environmentType: 'general' });

      const copied = await client.callTool({
        name: 'suite_copy_testdata',
        arguments: { suiteId: 'SU-24', environmentType: 'general', from: 'ITR-1', name: 'ITR-3' },
      });
      expect(copied.isError).toBeFalsy();
      expect(copySuiteTestdataIteration).toHaveBeenCalledWith({
        suiteId: 'SU-24', environmentType: 'general', from: 'ITR-1', name: 'ITR-3',
      });
      expect(textOf(copied)).toContain('Created suite-level iteration "ITR-3" (id i3) on suite SU-24 — member test cases were not touched.');

      const deleted = await client.callTool({
        name: 'testdata_delete_iterations',
        arguments: { suiteId: 'SU-24', environmentType: 'general', iterations: ['ITR-3'] },
      });
      expect(deleted.isError).toBeFalsy();
      expect(deleteTestdataIterations).toHaveBeenCalledWith({
        entityType: 'SU', id: 'SU-24', environmentType: 'general', iterations: ['ITR-3'],
      });
      expect(textOf(deleted)).toContain('Deleted 1 iteration row(s) from suite SU-24 — env general. Rows now:');

      const noId = await client.callTool({
        name: 'testdata_delete_iterations',
        arguments: { entityType: 'TC', environmentType: 'general', iterations: ['ITR-2'] },
      });
      expect(noId.isError).toBe(true);
      expect(textOf(noId)).toContain('Pass tcId for entityType "TC".');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
