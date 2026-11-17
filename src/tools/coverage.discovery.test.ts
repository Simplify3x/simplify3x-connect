// coverage.discovery — the read surface (list_projects / tc_list / tc_get / backlog reads /
// modules / functions / suites / versions), the Object Repository tools, `sqa_query` rendering and
// the dependency-free .xlsx writer. Driven through a REAL in-process MCP client so these tests pin
// what a client actually receives (text + structuredContent) and the exact adapter arguments.
//
// Every fake adapter also advertises `listAgentTools` (without `callRaw`) so the server's recording
// passthrough short-circuits instead of polling for an agent that will never appear.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { ProviderAdapter } from '../adapters/types.js';
import type { SqaQueryResult } from '../adapters/simplifyqa/searchEngine.js';
import type { TestCase } from '../domain/types.js';
import { DraftStore } from '../drafts/store.js';
import { buildServer } from '../server.js';
import { buildXlsx } from './xlsx.js';

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

/** Adapter stub marker so buildServer's recording passthrough registers nothing and never polls. */
const NO_AGENT = { listAgentTools: async () => [{ name: 'info' }] };

const tc = (over: Partial<TestCase> = {}): TestCase => ({
  id: '42',
  title: 'Checkout flow',
  category: 'automated',
  currentVersionId: 'ver-1',
  versions: [{ id: 'ver-1', name: 'v1.0', isCurrent: true }],
  steps: [
    { n: 1, description: 'Open the shop', stepType: 'web', actionType: 'Launch Application' },
    { n: 2, description: 'Click login', stepType: 'web', actionType: 'Click' },
  ],
  ...over,
});

describe('list_projects / tc_list rendering', () => {
  it('renders the project table with counts and a "showing X of Y" header', async () => {
    const listProjects = jest.fn(async () => Object.assign([
      { id: '1', code: 'PR-1', name: 'Alpha', counts: { testCases: 12 } },
      { id: '2', code: 'PR-2', name: 'Beta' },
    ], { totalCount: 7 }));
    const { client, server } = await connect({ ...NO_AGENT, listProjects } as unknown as ProviderAdapter);
    try {
      const res = await client.callTool({ name: 'list_projects', arguments: {} });

      expect(res.isError).toBeFalsy();
      const text = textOf(res);
      expect(text).toContain('Showing 2 of 7 projects:');
      expect(text).toContain('| PR-1 | Alpha | 12 |');
      expect(text).toContain('| PR-2 | Beta | - |');
      const sc = structured<{ projects: Array<Record<string, unknown>>; totalCount: number }>(res);
      expect(sc.totalCount).toBe(7);
      expect(sc.projects).toStrictEqual([
        { code: 'PR-1', name: 'Alpha', counts: { testCases: 12 } },
        { code: 'PR-2', name: 'Beta' },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('echoes the applied filters, marks obsolete rows and forwards the query', async () => {
    const rows = Object.assign([
      { id: '1', code: 'TC_1', title: 'Login', technologyType: 'WEB', executionType: 'AUTOMATION', stepCount: 4, priority: 'high' },
      { id: '2', code: 'TC_2', title: 'Old login', technologyType: 'API', obsolete: true },
    ], { totalCount: 5 });
    const listTestCases = jest.fn(async () => rows);
    const { client, server } = await connect({ ...NO_AGENT, listTestCases } as unknown as ProviderAdapter);
    try {
      const res = await client.callTool({
        name: 'tc_list',
        arguments: { search: 'login', moduleId: 'MO_4', obsolete: false },
      });

      expect(res.isError).toBeFalsy();
      const text = textOf(res);
      expect(text).toContain('Showing 2 of 5 test cases · 1 obsolete (filters: search: login · module: MO_4 · obsolete: false):');
      expect(text).toContain('| ID | Name | technology | execution | steps | obsolete |');
      expect(text).toContain('| TC_1 | Login | WEB | AUTOMATION | 4 |  |');
      expect(text).toContain('| TC_2 | Old login | API | - | - | yes |');
      expect(listTestCases).toHaveBeenCalledWith({ search: 'login', moduleId: 'MO_4', obsolete: false });
      const sc = structured<{ testCases: Array<Record<string, unknown>>; totalCount: number; obsoleteOnPage: number }>(res);
      expect(sc.totalCount).toBe(5);
      expect(sc.obsoleteOnPage).toBe(1);
      // Display view drops the internal id/priority columns.
      expect(sc.testCases[0]).toStrictEqual({
        code: 'TC_1', title: 'Login', technologyType: 'WEB', executionType: 'AUTOMATION', stepCount: 4,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('stops at 100 matches and asks how to return the rest, then honours first100', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ id: String(i), code: `TC_${i}`, title: `Case ${i}` }));
    const listTestCases = jest.fn(async (q: { offset?: number; limit?: number }) =>
      q.offset === 100 ? [{ id: '999', code: 'TC_999', title: 'probe' }] : page);
    const { client, server } = await connect({ ...NO_AGENT, listTestCases } as unknown as ProviderAdapter);
    try {
      const asked = await client.callTool({ name: 'tc_list', arguments: { search: 'case' } });
      expect(asked.isError).toBeFalsy();
      expect(textOf(asked)).toContain('**101 test cases** match (filters: search: case) — too many to show in the chat.');
      const sc = structured<{ needs: string; totalCount: number; options: string[] }>(asked);
      expect(sc.needs).toBe('output');
      expect(sc.totalCount).toBe(101);
      expect(sc.options).toStrictEqual(['xlsx', 'first100', 'refine']);
      expect(listTestCases).toHaveBeenLastCalledWith({ search: 'case', limit: 1, offset: 100 });

      const sliced = await client.callTool({ name: 'tc_list', arguments: { search: 'case', output: 'first100' } });
      expect(sliced.isError).toBeFalsy();
      expect(textOf(sliced)).toContain('Showing the first 100 of 101 — 1 not displayed.');
      expect(structured<{ testCases: unknown[] }>(sliced).testCases).toHaveLength(100);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('exports every match to an .xlsx file instead of dumping rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cqa-xlsx-'));
    const listTestCases = jest.fn(async () => Object.assign([
      { id: '1', code: 'TC_1', title: 'Login', technologyType: 'WEB', executionType: 'AUTOMATION', stepCount: 4 },
      { id: '2', code: 'TC_2', title: '=2+2', technologyType: 'API', executionType: 'MANUAL', stepCount: 1, obsolete: true },
    ], { totalCount: 2 }));
    const { client, server } = await connect({ ...NO_AGENT, listTestCases } as unknown as ProviderAdapter);
    try {
      const res = await client.callTool({ name: 'tc_list', arguments: { output: 'xlsx', outDir: dir } });
      expect(res.isError).toBeFalsy();
      const text = textOf(res);
      expect(text).toContain('Exported **2** test cases to');
      expect(text).toContain('Columns: ID, Name, Technology, Execution type, Steps, Obsolete.');
      expect(text).toContain('Filters applied: none (all test cases in the active project).');
      const sc = structured<{ file: string; count: number }>(res);
      expect(sc.count).toBe(2);
      const bytes = await readFile(sc.file);
      expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
      expect(sc.file.startsWith(dir)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await client.close();
      await server.close();
    }
  });
});

describe('backlog / library reads', () => {
  it('renders a story list (pluralised) and a story with its acceptance criteria', async () => {
    const listStories = jest.fn(async () => Object.assign([
      { id: '7', key: 'US_7', title: 'Login', status: 'NEW' },
      { id: '8', key: 'US_8', title: 'Logout' },
    ], { totalCount: 2 }));
    const getStory = jest.fn(async () => ({
      id: '7', key: 'US_7', title: 'Login', status: 'NEW', description: 'As a user I sign in',
      acceptanceCriteria: ['Valid credentials work', 'Invalid credentials are rejected'],
    }));
    const { client, server } = await connect({ ...NO_AGENT, listStories, getStory } as unknown as ProviderAdapter);
    try {
      const list = await client.callTool({ name: 'story_list', arguments: { search: 'log' } });
      expect(list.isError).toBeFalsy();
      expect(textOf(list)).toContain('2 stories:');
      expect(textOf(list)).toContain('| US_7 | Login | NEW |');
      expect(textOf(list)).toContain('| US_8 | Logout | - |');
      expect(listStories).toHaveBeenCalledWith({ search: 'log' });

      const one = await client.callTool({ name: 'story_get', arguments: { id: 'US_7' } });
      expect(one.isError).toBeFalsy();
      const text = textOf(one);
      expect(text).toContain('**Login** · US_7 · NEW');
      expect(text).toContain('As a user I sign in');
      expect(text).toContain('**Acceptance criteria (2):**\n1. Valid credentials work\n2. Invalid credentials are rejected');
      expect(getStory).toHaveBeenCalledWith('US_7');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('lists functions and reads one with its version table', async () => {
    const listFunctions = jest.fn(async () => Object.assign([
      { id: '9', code: 'FN_9', name: 'Login helper', fnType: 'WEB', executionType: 'AUTOMATION', status: 'APPROVED', stepCount: 4 },
    ], { totalCount: 1 }));
    const getFunction = jest.fn(async () => ({
      id: '9', code: 'FN_9', name: 'Login helper', fnType: 'WEB', executionType: 'AUTOMATION',
      status: 'APPROVED', description: 'Signs in',
      steps: [{ n: 1, description: 'Click login', stepType: 'web', actionType: 'Click' }],
      versions: [
        { id: 'v2', name: 'v2.0', isCurrent: true, executionType: 'AUTOMATION', reviewApproveStatus: 'APPROVED' },
        { id: 'v1', name: 'v1.0' },
      ],
    }));
    const { client, server } = await connect({ ...NO_AGENT, listFunctions, getFunction } as unknown as ProviderAdapter);
    try {
      const list = await client.callTool({ name: 'list_functions', arguments: { search: 'login', fnType: 'WEB' } });
      expect(list.isError).toBeFalsy();
      expect(textOf(list)).toContain('1 function:');
      expect(textOf(list)).toContain('| FN_9 | Login helper | WEB | AUTOMATION | APPROVED | 4 |');
      expect(listFunctions).toHaveBeenCalledWith({ search: 'login', fnType: 'WEB' });

      const one = await client.callTool({ name: 'get_function', arguments: { id: 'FN_9' } });
      expect(one.isError).toBeFalsy();
      const text = textOf(one);
      expect(text).toContain('**Login helper** · FN_9');
      expect(text).toContain('technology: WEB · execution: AUTOMATION · status: APPROVED · 1 step');
      expect(text).toContain('2 versions: v2.0, v1.0');
      expect(text).toContain('| 1 | web | Click login |');
      expect(text).toContain('| v2.0 | `v2` | ✓ | AUTOMATION | APPROVED |');
      expect(text).toContain('| v1.0 | `v1` |  | - | - |');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('lists the module tree and reads one module', async () => {
    const listModules = jest.fn(async () => Object.assign([
      { id: '1', name: 'Root', isRoot: true, childIds: [2] },
      { id: '2', name: 'Child', parentId: '1' },
    ], { totalCount: 2 }));
    const getModule = jest.fn(async () => ({
      id: '7', name: 'Checkout', code: 'MO_7', description: 'checkout flows', childIds: [8, 9],
    }));
    const { client, server } = await connect({ ...NO_AGENT, listModules, getModule } as unknown as ProviderAdapter);
    try {
      const list = await client.callTool({ name: 'list_modules', arguments: {} });
      expect(list.isError).toBeFalsy();
      expect(textOf(list)).toContain('2 modules:');
      expect(textOf(list)).toContain('| 1 | Root | root | - | 2 |');
      expect(textOf(list)).toContain('| 2 | Child | sub | 1 | - |');

      const one = await client.callTool({ name: 'get_module', arguments: { id: '7' } });
      expect(one.isError).toBeFalsy();
      expect(textOf(one)).toBe([
        '**Module 7** — Checkout',
        'Code: MO_7',
        'Parent: (root)',
        'Description: checkout flows',
        'Child module ids: 8, 9',
      ].join('\n'));
      expect(getModule).toHaveBeenCalledWith('7');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('reads a suite with its ordered test cases', async () => {
    const getSuite = jest.fn(async () => ({
      id: 'SU-5', name: 'Smoke', description: 'nightly',
      members: [{ tcId: 'TC_1', order: 1 }, { tcId: 'TC_2', order: 2 }],
    }));
    const { client, server } = await connect({ ...NO_AGENT, getSuite } as unknown as ProviderAdapter);
    try {
      const res = await client.callTool({ name: 'suite_get', arguments: { id: 'SU-5' } });
      expect(res.isError).toBeFalsy();
      const text = textOf(res);
      expect(text).toContain('**Smoke** · SU-5\nnightly\n2 test cases');
      expect(text).toContain('| 1 | TC_1 |');
      expect(text).toContain('| 2 | TC_2 |');
      expect(structured<{ suite: { members: unknown[] } }>(res).suite.members).toHaveLength(2);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('versions / modules write surface', () => {
  const twoVersions = tc({
    versions: [
      { id: 'v-1', name: 'v1.0', isCurrent: true },
      { id: 'v-2', name: 'v2.0' },
    ],
  });

  it('dry-runs a version delete with its dependency footprint, then deletes on confirm', async () => {
    const getTestCase = jest.fn(async () => twoVersions);
    const getFunction = jest.fn(async () => ({
      id: '9', name: 'Login helper', steps: [],
      versions: [{ id: 'fv-1', name: 'v1.0', isCurrent: true }, { id: 'fv-2', name: 'v2.0' }],
    }));
    const deleteVersion = jest.fn(async (req: { kind: string }) => req.kind === 'fn'
      ? {
          dryRun: true, hasBlockers: true, deleted: false,
          dependencies: [{ tcArr: { p1: [1] }, fnArr: { p1: [2] }, wfArr: {} }],
        }
      : {
          dryRun: true, hasBlockers: true, deleted: false,
          dependencies: [{
            defectArr: { p1: [1] }, suiteArr: { p1: [2, 3] }, epArr: {}, scenarioArr: {},
            schedulerArr: {}, pipelineArr: {}, workflowArr: {},
          }],
        });
    const { client, server } = await connect({ ...NO_AGENT, getTestCase, getFunction, deleteVersion } as unknown as ProviderAdapter);
    try {
      const dry = await client.callTool({
        name: 'delete_version',
        arguments: { kind: 'tc', parentId: '42', versionId: 'v-2', versionName: 'v2.0' },
      });
      expect(dry.isError).toBeFalsy();
      expect(textOf(dry)).toContain('Dry-run: version `v-2` (v2.0) still has references.');
      expect(textOf(dry)).toContain('- 1 defect, 2 suites');
      expect(deleteVersion).toHaveBeenLastCalledWith({ kind: 'tc', parentId: '42', versionId: 'v-2', versionName: 'v2.0' });

      // FN rows have a different dependency shape (tcArr / fnArr / wfArr).
      const fnDry = await client.callTool({
        name: 'delete_version',
        arguments: { kind: 'fn', parentId: '9', versionId: 'fv-2', versionName: 'v2.0' },
      });
      expect(fnDry.isError).toBeFalsy();
      expect(textOf(fnDry)).toContain('- 1 test case, 1 function');

      deleteVersion.mockResolvedValueOnce({ dryRun: false, hasBlockers: false, deleted: true, dependencies: [] } as never);
      const done = await client.callTool({
        name: 'delete_version',
        arguments: { kind: 'tc', parentId: '42', versionId: 'v-2', versionName: 'v2.0', confirm: true },
      });
      expect(done.isError).toBeFalsy();
      expect(textOf(done)).toContain('Deleted version `v-2` (v2.0). Cascade: steps, testdata and testdata iterations for this version were soft-deleted along with it.');
      expect(deleteVersion).toHaveBeenLastCalledWith({
        kind: 'tc', parentId: '42', versionId: 'v-2', versionName: 'v2.0', confirm: true,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('refuses to delete the last remaining version', async () => {
    const deleteVersion = jest.fn();
    const { client, server } = await connect({
      ...NO_AGENT, getTestCase: async () => tc(), deleteVersion,
    } as unknown as ProviderAdapter);
    try {
      const res = await client.callTool({
        name: 'delete_version',
        arguments: { kind: 'tc', parentId: '42', versionId: 'ver-1', versionName: 'v1.0', confirm: true },
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('Test case 42 has only one version');
      expect(textOf(res)).toContain('Delete the whole test case (tc_delete) instead');
      expect(deleteVersion).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('creates a module subtree and renders the whole tree (including a mid-way failure)', async () => {
    const createModule = jest.fn(async () => ({
      id: '10', name: 'Root', code: 'MO_10', isRoot: true,
      children: [{
        id: '11', name: 'Sub', parentId: '10', linkWarning: 'also linked to project 2',
        children: [{ id: '12', name: 'Leaf', parentId: '11' }],
      }],
      failedAt: { path: 'Root/Sub2', error: 'duplicate name' },
    }));
    const { client, server } = await connect({ ...NO_AGENT, createModule } as unknown as ProviderAdapter);
    try {
      const bad = await client.callTool({
        name: 'create_module',
        arguments: { name: 'Root', projectId: 'P1', isRoot: true, parentId: '9' },
      });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toContain('parentId must be omitted when isRoot is true');
      expect(createModule).not.toHaveBeenCalled();

      const res = await client.callTool({
        name: 'create_module',
        arguments: {
          name: 'Root', projectId: 'P1', isRoot: true, description: 'top',
          children: [{ name: 'Sub', children: [{ name: 'Leaf' }] }],
        },
      });
      expect(res.isError).toBeFalsy();
      const text = textOf(res);
      expect(text).toContain('Created 3 modules:');
      expect(text).toContain('- Root [MO_10] (id 10, isRoot=true)');
      expect(text).toContain('  - Sub (id 11, parent=10)');
      expect(text).toContain('    ⚠ also linked to project 2');
      expect(text).toContain('    - Leaf (id 12, parent=11)');
      expect(text).toContain('⚠ Subtree create stopped at "Root/Sub2": duplicate name');
      expect(createModule).toHaveBeenCalledWith({
        name: 'Root', projectId: 'P1', isRoot: true, description: 'top',
        children: [{ name: 'Sub', children: [{ name: 'Leaf' }] }],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('dry-runs a module delete and reports which ids were skipped on confirm', async () => {
    const deleteModule = jest.fn(async (req: { confirm?: boolean }) => req.confirm
      ? {
          dryRun: false,
          dependencies: [
            { id: '5', tcArr: [1, 2], fnArr: [], parameterArr: [], objArr: [], defectArr: [], usArr: [] },
            { id: '6', tcArr: [], fnArr: [], parameterArr: [], objArr: [], defectArr: [], usArr: [] },
          ],
        }
      : {
          dryRun: true,
          dependencies: [
            { id: '5', tcArr: [1, 2], fnArr: [], parameterArr: [], objArr: [], defectArr: [], usArr: [] },
            { id: '6', tcArr: [], fnArr: [], parameterArr: [], objArr: [], defectArr: [], usArr: [] },
          ],
        });
    const { client, server } = await connect({ ...NO_AGENT, deleteModule } as unknown as ProviderAdapter);
    try {
      const dry = await client.callTool({
        name: 'delete_module',
        arguments: { ids: ['5', '6'], projectId: 'P1' },
      });
      expect(dry.isError).toBeFalsy();
      expect(textOf(dry)).toContain('Dry-run: 1 of 2 module(s) still have references.');
      expect(textOf(dry)).toContain('| 5 | 2 | 0 | 0 | 0 | 0 | 0 |');

      const applied = await client.callTool({
        name: 'delete_module',
        arguments: { ids: ['5', '6'], projectId: 'P1', confirm: true },
      });
      expect(applied.isError).toBeFalsy();
      expect(textOf(applied)).toContain('Deleted 1 module(s). 1 SKIPPED (still referenced).');
      expect(deleteModule).toHaveBeenLastCalledWith({ ids: ['5', '6'], projectId: 'P1', confirm: true });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('Object Repository tools', () => {
  const obj = {
    id: 'o1', name: 'LoginButton', objectType: 'WEB', moduleName: 'Auth',
    parameterNames: ['p1', 'p2'], description: 'the button',
    locators: [
      { name: 'xpath', value: '//button[@id="login"]', unique: true },
      { name: 'css', value: '#login' },
    ],
  };

  it('lists objects with a paging hint and pages internally when unpaged', async () => {
    const searchObjects = jest.fn(async (q: { limit?: number }) =>
      q.limit === 2
        ? [{ ...obj }, { ...obj, id: 'o2', name: 'Logo' }]
        : [{ ...obj }]);
    const { client, server } = await connect({ ...NO_AGENT, searchObjects } as unknown as ProviderAdapter);
    try {
      const paged = await client.callTool({ name: 'object_list', arguments: { query: 'login', limit: 2 } });
      expect(paged.isError).toBeFalsy();
      expect(textOf(paged)).toContain('2 objects (more may exist — pass offset to page):');
      expect(textOf(paged)).toContain('| o1 | LoginButton | WEB | 2 |');
      expect(searchObjects).toHaveBeenCalledWith({ query: 'login', limit: 2 });

      const all = await client.callTool({ name: 'object_list', arguments: {} });
      expect(all.isError).toBeFalsy();
      expect(textOf(all)).toContain('1 object:');
      expect(searchObjects).toHaveBeenLastCalledWith({ limit: 100, offset: 0 });
      const sc = structured<{ objects: Array<Record<string, unknown>> }>(all);
      // Summaries only — the full locator bag is what object_get is for.
      expect(sc.objects).toStrictEqual([{ id: 'o1', name: 'LoginButton', objectType: 'WEB', locatorCount: 2 }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('reads one object with its locators and usage, and flags MISSING bindings on a TC', async () => {
    const getObject = jest.fn(async () => ({ ...obj }));
    const checkObjectDependencies = jest.fn(async () => ({ tcCount: 2, fnCount: 1, wfCount: 0 }));
    const bound = tc({
      steps: [
        { n: 1, description: 'Click login', stepType: 'web', actionType: 'Click', objectRef: { id: 'o1', name: 'LoginButton' } },
        { n: 2, description: 'Click gone', stepType: 'web', actionType: 'Click', objectRef: { id: 'o2', name: 'Gone', missing: true } },
      ],
    });
    const { client, server } = await connect({
      ...NO_AGENT, getObject, checkObjectDependencies, getTestCase: async () => bound,
    } as unknown as ProviderAdapter);
    try {
      const one = await client.callTool({ name: 'object_get', arguments: { id: 'o1' } });
      expect(one.isError).toBeFalsy();
      const text = textOf(one);
      expect(text).toContain('**LoginButton** · o1 · WEB');
      expect(text).toContain('Module: Auth · Parameters: p1, p2 · Description: the button');
      expect(text).toContain('| xpath (unique) | //button[@id="login"] |');
      expect(text).toContain('Usage: referenced by 2 test cases, 1 function.');
      expect(getObject).toHaveBeenCalledWith('o1', { enrichNames: true });

      const list = await client.callTool({ name: 'tc_list_objects', arguments: { tcId: '42' } });
      expect(list.isError).toBeFalsy();
      expect(textOf(list)).toContain('2 objects bound to Checkout flow — ⚠️ 1 of them is MISSING');
      expect(textOf(list)).toContain('| o2 | ⚠ MISSING | 2 |');
      const sc = structured<{ objects: Array<{ id: string; missing: boolean; steps: number[] }> }>(list);
      expect(sc.objects).toStrictEqual([
        { id: 'o1', name: 'LoginButton', missing: false, steps: [1] },
        { id: 'o2', name: 'Gone', missing: true, steps: [2] },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('refuses an object update the backend did not apply, and previews a delete first', async () => {
    // The backend silently keeps a different name — the tool must report the mismatch, not "updated".
    const updateObject = jest.fn(async () => ({ ...obj, name: 'LoginButton' }));
    const getObject = jest.fn(async () => ({ ...obj }));
    const checkObjectDependencies = jest.fn(async () => ({ tcCount: 2, fnCount: 0, wfCount: 1 }));
    const deleteObject = jest.fn(async () => undefined);
    const { client, server } = await connect({
      ...NO_AGENT, updateObject, getObject, checkObjectDependencies, deleteObject,
    } as unknown as ProviderAdapter);
    try {
      const nothing = await client.callTool({ name: 'object_update', arguments: { id: 'o1' } });
      expect(nothing.isError).toBe(true);
      expect(textOf(nothing)).toContain('Nothing to update');

      const mismatch = await client.callTool({ name: 'object_update', arguments: { id: 'o1', name: 'LoginBtn' } });
      expect(mismatch.isError).toBe(true);
      expect(textOf(mismatch)).toContain('Update call succeeded but a fresh read of object o1 shows it did NOT take: name is "LoginButton", not "LoginBtn"');
      expect(updateObject).toHaveBeenCalledWith('o1', { name: 'LoginBtn' }, { enrichNames: true });

      const preview = await client.callTool({ name: 'object_delete', arguments: { id: 'o1' } });
      expect(preview.isError).toBeFalsy();
      expect(textOf(preview)).toContain('⚠️ About to delete **LoginButton** · WEB (o1).');
      expect(textOf(preview)).toContain('⚠️ Still referenced by 2 test cases, 1 workflow — the delete WILL BE REFUSED');
      expect(deleteObject).not.toHaveBeenCalled();

      const confirmed = await client.callTool({ name: 'object_delete', arguments: { id: 'o1', confirm: true } });
      expect(confirmed.isError).toBeFalsy();
      expect(textOf(confirmed)).toContain('Deleted object o1.');
      expect(deleteObject).toHaveBeenCalledWith('o1');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('previews a parameter edit and applies it only on confirm', async () => {
    const updateParameter = jest.fn(async () => ({ id: '12', name: 'task_doc', type: 'Runtime', changed: ['type', 'default value'] }));
    const { client, server } = await connect({ ...NO_AGENT, updateParameter } as unknown as ProviderAdapter);
    try {
      const preview = await client.callTool({
        name: 'parameter_update',
        arguments: { parameter: 'task_doc', type: 'Runtime', defaultValue: 'x' },
      });
      expect(preview.isError).toBeFalsy();
      expect(textOf(preview)).toContain('Preview only - nothing changed. This would update parameter "task_doc": type -> Runtime, default value.');
      expect(structured<{ applied: boolean }>(preview).applied).toBe(false);
      expect(updateParameter).not.toHaveBeenCalled();

      const applied = await client.callTool({
        name: 'parameter_update',
        arguments: { parameter: 'task_doc', type: 'Runtime', defaultValue: 'x', confirm: true },
      });
      expect(applied.isError).toBeFalsy();
      expect(textOf(applied)).toContain('Updated parameter "task_doc" (id 12): type, default value. Now Runtime.');
      expect(updateParameter).toHaveBeenCalledWith('task_doc', { type: 'Runtime', defaultValue: 'x' });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('sqa_query', () => {
  it('rejects unexposed collections, missing collection/id/relation before any read', async () => {
    const sqaQuery = jest.fn();
    const { client, server } = await connect({ ...NO_AGENT, sqaQuery } as unknown as ProviderAdapter);
    try {
      const logs = await client.callTool({ name: 'sqa_query', arguments: { op: 'search', collection: 'activity logs' } });
      expect(logs.isError).toBe(true);
      expect(textOf(logs)).toContain('Activity / audit logs are NOT available through this MCP.');

      const noCollection = await client.callTool({ name: 'sqa_query', arguments: { op: 'search' } });
      expect(noCollection.isError).toBe(true);
      expect(textOf(noCollection)).toContain('`collection` is required for this op.');

      const noId = await client.callTool({ name: 'sqa_query', arguments: { op: 'get', collection: 'testcases' } });
      expect(noId.isError).toBe(true);
      expect(textOf(noId)).toContain('`id` is required for op:"get"/"related".');

      const noRelation = await client.callTool({
        name: 'sqa_query', arguments: { op: 'related', collection: 'testcases', id: '684' },
      });
      expect(noRelation.isError).toBe(true);
      expect(textOf(noRelation)).toContain('`relation` is required for op:"related".');
      expect(sqaQuery).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('renders a search with visibility, interpretations, display names and paging', async () => {
    const result: SqaQueryResult = {
      op: 'search', collection: 'users',
      rows: [{ id: 1, name: 'Ani', moduleId: 46, _display: { moduleId: 'Checkout' }, _id: 'mongo', deleted: false }],
      totalCount: 341, returned: 1, offset: 0, nextOffset: 1, totalCountIsRows: true,
      resolved: [{ field: 'state', from: ['open'], to: ['NEW', 'IN_PROGRESS'] }],
    };
    const sqaQuery = jest.fn(async () => result);
    const { client, server } = await connect({ ...NO_AGENT, sqaQuery } as unknown as ProviderAdapter);
    try {
      const res = await client.callTool({
        name: 'sqa_query',
        arguments: { op: 'search', collection: 'users', where: { name: 'Ani' }, select: 'name' },
      });
      expect(res.isError).toBeFalsy();
      const text = textOf(res);
      expect(text).toContain('_**Visibility:** Only the users who share at least one project with you.');
      expect(text).toContain('_Interpreted: state "open" → NEW, IN_PROGRESS._');
      expect(text).toContain('**users** — 341 rows (offset 0):');
      expect(text).toContain('| name |');
      expect(text).toContain('_Showing 1 of 341; nextOffset=1._');
      expect(text).toContain('_The total counts stored version rows');
      // `where` given as a map and `select` as a string are normalised before reaching the adapter.
      expect(sqaQuery).toHaveBeenCalledWith({
        op: 'search', collection: 'users', where: [{ field: 'name', op: 'eq', value: 'Ani' }], select: ['name'],
      });
      const sc = structured<{ visibility?: string; nextOffset?: number; totalCount: number }>(res);
      expect(sc.totalCount).toBe(341);
      expect(sc.nextOffset).toBe(1);
      expect(sc.visibility).toContain('share at least one project');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('renders a grouped count, resolves one custom field, and prints a get row', async () => {
    const sqaQuery = jest.fn(async (req: { op: string; name?: string }) => {
      if (req.op === 'count') {
        return {
          op: 'count', collection: 'defects', total: 12, groupBy: 'severity',
          groups: [{ value: 'HIGH', label: 'High', count: 5 }],
        } as SqaQueryResult;
      }
      if (req.op === 'custom_fields') {
        return {
          op: 'custom_fields', collection: 'testcases',
          fields: [
            { key: 'SEV', label: 'Severity', column: 'customFields.SEV', fieldType: 'text', controlType: 'dropdown', mandatory: true },
            { key: 'SEV2', label: 'Severity Level', column: 'customFields.SEV2', fieldType: 'text' },
          ],
        } as SqaQueryResult;
      }
      return { op: 'get', collection: 'testcases', row: { id: '684', name: 'Login' }, expanded: { steps: [1] } } as SqaQueryResult;
    });
    const { client, server } = await connect({ ...NO_AGENT, sqaQuery } as unknown as ProviderAdapter);
    try {
      const count = await client.callTool({
        name: 'sqa_query', arguments: { op: 'count', collection: 'defects', groupBy: 'severity' },
      });
      expect(count.isError).toBeFalsy();
      expect(textOf(count)).toContain('**defects** — 12 match.');
      expect(textOf(count)).toContain('| severity | count |');
      expect(textOf(count)).toContain('| High (HIGH) | 5 |');

      const resolved = await client.callTool({
        name: 'sqa_query', arguments: { op: 'custom_fields', collection: 'testcases', name: 'severity' },
      });
      expect(resolved.isError).toBeFalsy();
      expect(textOf(resolved)).toContain('Resolved **severity** on testcases:');
      expect(textOf(resolved)).toContain('- column: `customFields.SEV`');

      const missing = await client.callTool({
        name: 'sqa_query', arguments: { op: 'custom_fields', collection: 'testcases', name: 'nope' },
      });
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toContain('Custom field "nope" not found on testcases. Available: Severity, Severity');

      const one = await client.callTool({
        name: 'sqa_query', arguments: { op: 'get', collection: 'testcases', id: '684', expand: ['steps'] },
      });
      expect(one.isError).toBeFalsy();
      expect(textOf(one)).toContain('**testcases** — row `684`');
      expect(textOf(one)).toContain('"expanded"');
      expect(sqaQuery).toHaveBeenLastCalledWith({
        op: 'get', collection: 'testcases', id: '684', expand: ['steps'],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('xlsx writer', () => {
  /** Read the local file headers of the (unencrypted, stored-name) zip the writer emits. */
  function unzip(buf: Buffer): Record<string, string> {
    const out: Record<string, string> = {};
    let off = 0;
    while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
      const compSize = buf.readUInt32LE(off + 18);
      const nameLen = buf.readUInt16LE(off + 26);
      const extraLen = buf.readUInt16LE(off + 28);
      const name = buf.subarray(off + 30, off + 30 + nameLen).toString('utf8');
      const dataStart = off + 30 + nameLen + extraLen;
      out[name] = inflateRawSync(buf.subarray(dataStart, dataStart + compSize)).toString('utf8');
      off = dataStart + compSize;
    }
    return out;
  }

  it('writes a well-formed single-sheet workbook with typed, escaped cells', () => {
    const headers = Array.from({ length: 27 }, (_, i) => `H${i + 1}`);
    const bytes = buildXlsx('My/Sheet: 1', headers, [
      [42, true, null, 'a & b <c> "d"', undefined],
      ['plain', -1.5, false, '', 'x|y'],
    ]);
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');

    const files = unzip(bytes);
    expect(Object.keys(files)).toStrictEqual([
      '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml',
    ]);
    // Sheet name: every one of \ / ? * [ ] : becomes a space.
    expect(files['xl/workbook.xml']).toContain('<sheet name="My Sheet  1" sheetId="1"');
    const sheet = files['xl/worksheets/sheet1.xml'];
    // 27 headers walked past column Z (AA1).
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">H1</t></is></c>');
    expect(sheet).toContain('<c r="AA1" s="1" t="inlineStr">');
    // Numbers, booleans, empties and escaped inline strings.
    expect(sheet).toContain('<c r="A2"><v>42</v></c>');
    expect(sheet).toContain('<c r="B2" t="b"><v>1</v></c>');
    expect(sheet).toContain('<c r="C2"/>');
    expect(sheet).toContain('a &amp; b &lt;c&gt; &quot;d&quot;');
    expect(sheet).toContain('<c r="E2"/>');
    expect(sheet).toContain('<c r="B3"><v>-1.5</v></c>');
    expect(sheet).toContain('<c r="C3" t="b"><v>0</v></c>');
    expect(sheet).toContain('x|y');
    // Column widths: the second column is the wide one.
    expect(sheet).toContain('<col min="2" max="2" width="50" customWidth="1"/>');
  });
});
