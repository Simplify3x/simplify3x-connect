import { SimplifyQaAdapter } from './adapter.js';
import { registerBacklogTools } from '../../tools/backlog.tools.js';

/**
 * "Delete the Clones link from EP-71 to DE-2293" — driven through the REAL unlinkBacklogItem against a fake backend that stores a link the way the
 * product does: one row on the source and a mirror row on the destination under the SAME id, `GET /pm/linkages/:id/:type` listing only live rows, and a
 * save of the source that marks a row deleted only if it is sent with `deleted:true` AND its destinationCode (the real service errors without it).
 */
const row = (over: Record<string, unknown>) => ({
  projectId: 19, deleted: false, linkId: 1, jiraIssueId: '', jiraIssueKey: '', jiraLinkId: '', ...over,
});
// EP-71 --Clones--> DE-2293, with its mirror on DE-2293
const clones = () => [
  row({ id: 'u1', parentId: 71, parentType: 'EP', destinationId: 2293, destinationCode: 'DE-2293', destinationType: 'DE', parentName: 'a defect', linkTypeKey: 'Clones', linkType: 'outwardType' }),
  row({ id: 'u1', parentId: 2293, parentType: 'DE', destinationId: 71, destinationCode: 'EP-71', destinationType: 'EP', parentName: 'mcp epic', linkTypeKey: 'Is cloned by', linkType: 'inwardType' }),
];
const blocks = () => [
  row({ id: 'u2', linkId: 2, parentId: 71, parentType: 'EP', destinationId: 2293, destinationCode: 'DE-2293', destinationType: 'DE', parentName: 'a defect', linkTypeKey: 'Blocks', linkType: 'outwardType' }),
  row({ id: 'u2', linkId: 2, parentId: 2293, parentType: 'DE', destinationId: 71, destinationCode: 'EP-71', destinationType: 'EP', parentName: 'mcp epic', linkTypeKey: 'Is blocked by', linkType: 'inwardType' }),
];
const other = () => [
  row({ id: 'u3', parentId: 71, parentType: 'EP', destinationId: 50, destinationCode: 'US-50', destinationType: 'US', parentName: 'a story', linkTypeKey: 'Relates to', linkType: 'outwardType' }),
];

const DOCS: Record<string, Record<string, any>> = {
  '/pm/epic/71': { id: 71, code: 'EP-71', name: 'mcp epic', updateVersion: 3 },
  '/pm/defect/2293': { id: 2293, code: 'DE-2293', name: 'a defect', updateVersion: 1 },
  '/pm/userstory/1326': { id: 1326, code: 'US-1326', name: 'a story' },
  '/pm/defect/7': { id: 7, code: 'DE-7', name: 'seven', updateVersion: 0 },
};

function backend(opts: { rows?: any[]; ignoreDelete?: boolean; oneSideOnly?: boolean } = {}) {
  const rows = opts.rows ?? clones();
  const puts: Array<{ path: string; body: any }> = [];
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: 'http://backend' };
  a.requireProjectId = () => 19;
  a.http = {
    postJson: async () => ({ data: [] }),
    getJson: async (path: string) => {
      const base = path.split('?')[0]!;
      if (DOCS[base]) return [DOCS[base]];
      let m = /^\/pm\/linkages\/(\d+)\/([A-Z]{2})$/.exec(base);
      if (m) return rows.filter((r) => !r.deleted && String(r.parentId) === m![1] && r.parentType === m![2]).map((r) => ({ ...r }));
      if (/^\/pm\/fields\/10$/.test(base)) {
        return [
          { id: 1, outwardType: { key: 'Clones', value: 'Clones' }, inwardType: { key: 'Is cloned by', value: 'Is cloned by' } },
          { id: 2, outwardType: { key: 'Blocks', value: 'Blocks' }, inwardType: { key: 'Is blocked by', value: 'Is blocked by' } },
        ];
      }
      throw new Error(`unexpected GET ${path}`);
    },
    putJson: async (path: string, body: any) => {
      puts.push({ path, body });
      if (!/^\/pm\/(epic|feature|userstory|defect|task)\/\d+$/.test(path)) throw new Error(`unexpected PUT ${path}`);
      for (const e of body.linkedIssues ?? []) {
        if (!e.id || !e.deleted) continue;                                   // a row without `deleted` is skipped
        if (typeof e.destinationCode !== 'string') throw new Error('APIError: Cannot convert undefined or null to object');
        if (opts.ignoreDelete) continue;
        for (const r of rows) if (r.id === e.id && (!opts.oneSideOnly || String(r.parentId) === String(/\/(\d+)$/.exec(path)![1]))) r.deleted = true;
      }
      return { status: true };
    },
  };
  return { a, puts, rows };
}
const live = (rows: any[]) => rows.filter((r) => !r.deleted).map((r) => `${r.parentType}-${r.parentId}→${r.destinationCode}(${r.linkTypeKey})`);

describe('delete the Clones link from EP-71 to DE-2293 (the reported case)', () => {
  test('the stored row goes back marked deleted (with its destination code), the link disappears from BOTH sides, and it is read back', async () => {
    const { a, puts, rows } = backend({ rows: [...clones(), ...other()] });
    const r = await a.unlinkBacklogItem({ sourceType: 'epic', sourceId: 'EP-71', destType: 'defect', destId: 'DE-2293' });
    expect(puts).toHaveLength(1);
    expect(puts[0]!.path).toBe('/pm/epic/71');
    expect(puts[0]!.body.updateVersion).toBe(3);
    expect(puts[0]!.body.linkedIssues).toHaveLength(1);
    expect(puts[0]!.body.linkedIssues[0]).toMatchObject({ id: 'u1', deleted: true, destinationCode: 'DE-2293', linkTypeKey: 'Clones' });
    expect(live(rows)).toEqual(['EP-71→US-50(Relates to)']);                // both rows of u1 are gone; the unrelated link stays
    expect(r).toMatchObject({ sourceCode: 'EP-71', destinationCode: 'DE-2293', removed: ['DE-2293 (Clones)'], remaining: ['US-50 (Relates to)'], warnings: [] });
  });

  test('several links to the same item: refused without linkType; with it (the key, or the name the UI shows) only that one goes', async () => {
    const both = () => backend({ rows: [...clones(), ...blocks()] });
    await expect(both().a.unlinkBacklogItem({ sourceType: 'epic', sourceId: 'EP-71', destType: 'defect', destId: 'DE-2293' })).rejects.toThrow(/has 2 links to DE-2293 \(Clones, Blocks\).*`linkType`/s);
    const byKey = both();
    await byKey.a.unlinkBacklogItem({ sourceType: 'epic', sourceId: 'EP-71', destType: 'defect', destId: 'DE-2293', linkType: 'clones' });
    expect(live(byKey.rows).filter((x) => x.startsWith('EP-71'))).toEqual(['EP-71→DE-2293(Blocks)']);
    const byName = backend({ rows: [...clones(), ...blocks()] });
    await byName.a.unlinkBacklogItem({ sourceType: 'epic', sourceId: 'EP-71', destType: 'defect', destId: 'DE-2293', linkType: 'Is Blocked By' });
    // "Is blocked by" is the inward name of Blocks, whose stored key on EP-71 is "Blocks" — the same catalogue row, so it matches
    expect(live(byName.rows).filter((x) => x.startsWith('EP-71'))).toEqual(['EP-71→DE-2293(Clones)']);
  });

  test('a link that is not there is reported with the links the source does have', async () => {
    const { a, puts } = backend({ rows: [...clones(), ...other()] });
    await expect(a.unlinkBacklogItem({ sourceType: 'epic', sourceId: 'EP-71', destType: 'defect', destId: 'DE-7' }))
      .rejects.toThrow(/EP-71 has no link to DE-7\. Its links: DE-2293 \(Clones\), US-50 \(Relates to\)/);
    await expect(a.unlinkBacklogItem({ sourceType: 'epic', sourceId: 'EP-71', destType: 'defect', destId: 'DE-2293', linkType: 'Blocks' }))
      .rejects.toThrow(/no link to DE-2293 of type "Blocks"/);
    expect(puts).toEqual([]);
  });

  test('a delete the backend did not apply is reported; a one-sided delete is flagged', async () => {
    await expect(backend({ ignoreDelete: true }).a.unlinkBacklogItem({ sourceType: 'epic', sourceId: 'EP-71', destType: 'defect', destId: 'DE-2293' }))
      .rejects.toThrow(/still show it/);
    const half = backend({ oneSideOnly: true });
    const r = await half.a.unlinkBacklogItem({ sourceType: 'epic', sourceId: 'EP-71', destType: 'defect', destId: 'DE-2293' });
    expect(r.warnings.join(' ')).toMatch(/DE-2293's own Linkages still show the link back to EP-71/);
  });

  test('works from a user story or a defect as the source too', async () => {
    const story = backend({ rows: [
      row({ id: 'u9', parentId: 1326, parentType: 'US', destinationId: 7, destinationCode: 'DE-7', destinationType: 'DE', parentName: 'seven', linkTypeKey: 'Clones', linkType: 'outwardType' }),
      row({ id: 'u9', parentId: 7, parentType: 'DE', destinationId: 1326, destinationCode: 'US-1326', destinationType: 'US', parentName: 'a story', linkTypeKey: 'Is cloned by', linkType: 'inwardType' }),
    ] });
    await story.a.unlinkBacklogItem({ sourceType: 'userstory', sourceId: 'US-1326', destType: 'defect', destId: 'DE-7' });
    expect(story.puts[0]).toMatchObject({ path: '/pm/userstory/1326', body: { projectId: 19 } });
    expect(live(story.rows)).toEqual([]);
    const defect = backend({ rows: [
      row({ id: 'u8', parentId: 7, parentType: 'DE', destinationId: 71, destinationCode: 'EP-71', destinationType: 'EP', parentName: 'mcp epic', linkTypeKey: 'Blocks', linkType: 'outwardType' }),
      row({ id: 'u8', parentId: 71, parentType: 'EP', destinationId: 7, destinationCode: 'DE-7', destinationType: 'DE', parentName: 'seven', linkTypeKey: 'Is blocked by', linkType: 'inwardType' }),
    ] });
    await defect.a.unlinkBacklogItem({ sourceType: 'defect', sourceId: 'DE-7', destType: 'epic', destId: 'EP-71' });
    expect(defect.puts[0]).toMatchObject({ path: '/pm/defect/7', body: { projectId: 19, updateVersion: 0 } });
    expect(live(defect.rows)).toEqual([]);
  });
});

describe('the backlog_unlink tool', () => {
  const tool = (adapter: any) => {
    const h: Record<string, (a: any) => Promise<any>> = {};
    registerBacklogTools({ registerTool: (n: string, _d: unknown, fn: any) => { h[n] = fn; } } as any, { getAdapter: () => adapter });
    return h['backlog_unlink']!;
  };
  const text = (r: any): string => r.content.map((c: any) => c.text).join('\n');

  test('says what was removed, that it is gone on read-back, and what the source still links to', async () => {
    const r = await tool(backend({ rows: [...clones(), ...other()] }).a)({ sourceType: 'epic', sourceId: 'EP-71', destType: 'defect', destId: 'DE-2293' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/Removed the link EP-71 → DE-2293 \(DE-2293 \(Clones\)\) and read the Linkages back: it is gone\./);
    expect(text(r)).toMatch(/EP-71's links now: US-50 \(Relates to\)\./);
  });

  test('errors and not-connected come back as messages', async () => {
    expect(text(await tool(backend().a)({ sourceType: 'epic', sourceId: 'EP-71', destType: 'defect', destId: 'DE-7' }))).toMatch(/has no link to DE-7/);
    expect(text(await tool(null)({ sourceType: 'epic', sourceId: 'EP-71', destType: 'defect', destId: 'DE-2293' }))).toMatch(/Not connected/);
  });
});
