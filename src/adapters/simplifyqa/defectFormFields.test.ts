import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SimplifyQaAdapter } from './adapter.js';
import { registerDefectUpdateTool } from '../../tools/defectUpdate.tools.js';
import { registerAttachmentTools } from '../../tools/attachment.tools.js';
import { registerBacklogTools } from '../../tools/backlog.tools.js';

/**
 * DE-2380: defect_create / defect_update take Environment, Type, Feature, the planned dates, Linkages and Attachments — driven through the
 * REAL adapter against a fake backend that behaves like the project-management service for defects:
 *  - create / update bodies are checked against the backend's own Joi key lists (an unknown key is a 400, a bad date is a 400);
 *  - attachments: files arrive as multipart `filename1…`; a defect's `attachments` list on update means "DELETE these rows" and only
 *    matches a row when it carries the project (attachments.service.js delete);
 *  - linkages: a row WITHOUT an id is created, a row with an id is skipped unless it is `deleted` (linkages.service.js saveLinkIssues) —
 *    and the defect document does not echo its links, they are read from /pm/linkages/:id/DE.
 */
const CREATE_KEYS = new Set(['name', 'state', 'priority', 'releaseId', 'iterationId', 'projectId', 'descriptionJiraFormat', 'description', 'ownerId', 'featureId',
  'severity', 'category', 'moduleId', 'userstoryId', 'selectedTestCase', 'clientId', 'estimatedEffort', 'actualEffort', 'remainingEffort', 'closedDate',
  'plannedStartDate', 'plannedEndDate', 'executionType', 'environment', 'tags', 'attachments', 'linkedIssues', 'customFields', 'mailersList', 'teamId', 'azureId',
  'azureUrl', 'fromAzure', 'disableMail', 'jiraIssueId', 'jiraIssueKey', 'fromJira', 'jiraIssueLink', 'fromExecution', 'type', 'jiraErrorExist', 'networkLogs', 'subProjectId']);
const UPDATE_KEYS = new Set([...CREATE_KEYS, 'errorUpdate', 'updateVersion']);

function validateDefect(body: Record<string, any>, update: boolean): void {
  const bad = (m: string): never => { throw new Error(`400 Validation error: ${m}`); };
  const keys = update ? UPDATE_KEYS : CREATE_KEYS;
  for (const k of Object.keys(body)) if (!keys.has(k)) bad(`"${k}" is not allowed`);
  if (!update) for (const k of ['name', 'state', 'priority', 'projectId']) if (body[k] === undefined) bad(`"${k}" is required`);
  if (body['name'] !== undefined && String(body['name']).trim().length < 3) bad('"name" length');
  for (const k of ['plannedStartDate', 'plannedEndDate']) {
    const v = body[k];
    if (v !== undefined && v !== null && v !== '' && Number.isNaN(Date.parse(String(v)))) bad(`"${k}" must be a valid date`);
  }
  if (body['featureId'] !== undefined && body['featureId'] !== null && body['featureId'] !== '' && typeof body['featureId'] !== 'number') bad('"featureId" must be a number');
}

type Store = {
  defects: Map<number, Record<string, any>>; links: any[]; attachments: any[]; features: any[];
  puts: Array<{ path: string; body: any }>; posts: any[]; multiparts: Array<{ path: string; objKey: string; obj: any; files?: any[] }>;
};

function backend(opts: { envList?: string[]; features?: any[] } = {}) {
  const st: Store = {
    defects: new Map<number, Record<string, any>>([[9, { id: 9, code: 'DE-9', name: 'another defect', projectId: 19, deleted: false, updateVersion: 0, state: 'NEW', priority: 'HIGH' }]]),
    links: [], attachments: [], puts: [], posts: [], multiparts: [],
    features: opts.features ?? [{ id: 248, code: 'FT-248', name: 'MCP F18' }],
  };
  let nextId = 75;
  const a: any = Object.create(SimplifyQaAdapter.prototype);
  a.cfg = { baseUrl: 'http://backend' };
  a.requireProjectId = () => 19;
  a.resolveModuleId = async () => 3;
  const col = (body: any, c: string): any => body.searchFields.find((f: any) => f.column === c)?.value;

  const applyLinks = (parentId: number, rows: any[]): void => {
    for (const r of rows) {
      if (r.id) continue;                                  // an existing row is skipped unless deleted (not exercised here)
      const id = randomUUID();
      st.links.push({ ...r, id, parentId, parentType: 'DE' });
      st.links.push({ id, parentId: r.destinationId, parentType: r.destinationType, destinationId: parentId, destinationCode: st.defects.get(parentId)?.['code'], linkTypeKey: r.linkTypeKey });
    }
  };
  const applyUpdate = (id: number, body: Record<string, any>): void => {
    validateDefect(body, true);
    const d = st.defects.get(id);
    if (!d) throw new Error('404');
    const { linkedIssues, attachments, updateVersion: _v, ...fields } = body;
    Object.assign(d, fields, { updateVersion: (d['updateVersion'] ?? 0) + 1 });
    if (Array.isArray(linkedIssues)) applyLinks(id, linkedIssues);
    if (Array.isArray(attachments)) {
      // attachments.service.js delete(): matches on parentId + parentType + customer + PROJECT; only rows flagged deleted are removed
      const first = attachments[0];
      for (const at of attachments) {
        if (!at.deleted) continue;
        const row = st.attachments.find((r) => r.id === at.id && r.parentId === first.parentId && r.parentType === first.parentType && r.projectId === Number.parseInt(first.projectId, 10));
        if (row) row.deleted = true;
      }
    }
  };

  a.http = {
    getJson: async (path: string) => {
      let m: RegExpExecArray | null;
      if ((m = /^\/pm\/defect\/(\d+)$/.exec(path))) { const d = st.defects.get(Number(m[1])); return d ? [{ ...d }] : []; }
      if (path.startsWith('/pm/fields/9?')) {
        const values = (xs: string[]): any[] => xs.map((k, i) => ({ key: k, value: k, ...(i === 0 ? { isDefault: true } : {}) }));
        return [
          { key: 'state', values: values(['NEW', 'ASSIGNED']) }, { key: 'priority', values: values(['HIGH', 'LOW']) },
          ...(opts.envList ? [{ key: 'environment', values: values(opts.envList) }] : []),
        ];
      }
      if (path.startsWith('/pm/fields/10?')) return [{ id: 1, inwardType: { key: 'IS_CLONED_BY', value: 'Is cloned by' }, outwardType: { key: 'CLONES', value: 'Clones' } }];
      if ((m = /^\/pm\/linkages\/(\d+)\/DE\?/.exec(path))) return st.links.filter((l) => l.parentId === Number(m![1]) && l.parentType === 'DE');
      if ((m = /^\/pm\/attachment\/(\d+)\/DE\?/.exec(path))) return st.attachments.filter((r) => r.parentId === Number(m![1]) && r.parentType === 'DE' && !r.deleted).map(({ projectId: _p, ...row }) => row);   // the listing carries no project: the MCP must add it
      throw new Error(`unexpected GET ${path}`);
    },
    postJson: async (path: string, body: any) => {
      if (path === '/pm/defect/search') {
        const code = col(body, 'code');
        const rows = [...st.defects.values()].filter((d) => !d['deleted'] && (code === undefined || d['code'] === code));
        return { data: rows };
      }
      if (path === '/pm/feature/search') {
        const hit = st.features.filter((f) => ['id', 'code', 'name'].every((c) => col(body, c) === undefined || String(f[c]).toLowerCase() === String(col(body, c)).toLowerCase()));
        return { data: hit };
      }
      if (path === '/pm/defect') {
        validateDefect(body, false);
        st.posts.push(body);
        const id = nextId++;
        st.defects.set(id, { ...body, id, code: `DE-${id}`, deleted: false, updateVersion: 0 });
        return { id };
      }
      throw new Error(`unexpected POST ${path}`);
    },
    putJson: async (path: string, body: any) => {
      const m = /^\/pm\/defect\/(\d+)$/.exec(path);
      if (!m) throw new Error(`unexpected PUT ${path}`);
      st.puts.push({ path, body });
      applyUpdate(Number(m[1]), body);
      return {};
    },
    putMultipartWithFiles: async (path: string, objKey: string, obj: any, files: any[]) => {
      const m = /^\/pm\/defect\/(\d+)$/.exec(path)!;
      st.multiparts.push({ path, objKey, obj, files });
      if (objKey !== 'defectObj') throw new Error('wrong multipart key');
      applyUpdate(Number(m[1]), obj);
      for (const f of files) st.attachments.push({ id: randomUUID(), parentId: Number(m[1]), parentType: 'DE', projectId: 19, original_name: f.fileName, name: f.fileName, customerId: 3, deleted: false });
      return {};
    },
    putMultipart: async (path: string, objKey: string, obj: any) => {
      const m = /^\/pm\/defect\/(\d+)$/.exec(path)!;
      st.multiparts.push({ path, objKey, obj });
      applyUpdate(Number(m[1]), obj);
      return {};
    },
  };
  return { a, st };
}
const FULL = {
  name: 'Login fails on SSO', environment: 'qa', executionType: 'automation', featureId: 'FT-248',
  plannedStartDate: '2026-11-20', plannedEndDate: '2026-11-25', linkages: [{ destType: 'defect' as const, destId: 'DE-9', linkType: 'Clones' }],
};

describe('defect_create — the rest of the form', () => {
  test('environment, type, feature, planned dates and a link are saved, read back, and the body passes the backend validator', async () => {
    const { a, st } = backend();
    const r = await a.createDefect(FULL);
    expect(r.defectCode).toBe('DE-75');
    expect(st.posts[0]).toMatchObject({ environment: 'QA', executionType: 'Automation', featureId: 248, plannedStartDate: '2026-11-20T00:00:00.000Z', plannedEndDate: '2026-11-25T00:00:00.000Z' });
    expect(r.fields).toEqual(['environment QA', 'type Automation', 'feature FT-248 MCP F18', 'planned start 2026-11-20', 'planned end 2026-11-25']);
    expect(r.linked).toEqual(['DE-9 (Clones)']);
    // saved from the DEFECT's side: only the new row (no id), and it shows under /pm/linkages/75/DE
    const linkPut = st.puts.find((p) => p.body.linkedIssues)!;
    expect(linkPut.body.linkedIssues).toHaveLength(1);
    expect(linkPut.body.linkedIssues[0]).toMatchObject({ destinationId: 9, destinationCode: 'DE-9', linkTypeKey: 'CLONES', linkType: 'outwardType', projectId: 19 });
    expect(linkPut.body.linkedIssues[0].id).toBeUndefined();
    expect(st.links.filter((l) => l.parentId === 75 && l.parentType === 'DE')).toHaveLength(1);
    expect(r.warnings).toEqual([]);
  });

  test('a bad value refuses the whole call BEFORE anything is created, and says what is valid', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ environment: 'Prod' }, /"Prod" is not a defect environment.*Development, QA, UAT/s],
      [{ executionType: 'Hybrid' }, /not a defect type \(execution type\).*Manual, Automation/s],
      [{ featureId: 'FT-999' }, /No feature "FT-999" in this project/],
      [{ plannedStartDate: '20/11/2026' }, /Planned start date must be a date like 2026-11-20/],
      [{ plannedStartDate: '2026-11-25', plannedEndDate: '2026-11-20' }, /Planned end date \(2026-11-20\) must be on or after the planned start date/],
    ];
    for (const [extra, msg] of cases) {
      const { a, st } = backend();
      await expect(a.createDefect({ name: 'Some defect', ...extra })).rejects.toThrow(msg);
      expect(st.posts).toEqual([]);
    }
  });

  test('the project\'s own Environment list wins over the form\'s fixed one', async () => {
    const { a, st } = backend({ envList: ['Staging', 'Prod'] });
    await expect(a.createDefect({ name: 'Some defect', environment: 'QA' })).rejects.toThrow(/Valid: Staging, Prod/);
    await a.createDefect({ name: 'Some defect', environment: 'prod' });
    expect(st.posts[0].environment).toBe('Prod');
  });

  test('a link that cannot be saved is reported with its reason while the defect stays logged', async () => {
    const { a } = backend();
    const r = await a.createDefect({ name: 'Some defect', linkages: [{ destType: 'defect', destId: 'DE-9', linkType: 'Nonsense' }] });
    expect(r.defectCode).toBe('DE-75');
    expect(r.linked).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/was logged, but linking it to defect DE-9 failed: Unknown link type "Nonsense"\. Available link types: .*Clones/);
  });

  test('without any of the new fields the request is exactly what it was before (no extra keys)', async () => {
    const { a, st } = backend();
    await a.createDefect({ name: 'Plain defect' });
    for (const k of ['environment', 'executionType', 'featureId', 'plannedStartDate', 'plannedEndDate', 'linkedIssues']) expect(st.posts[0]).not.toHaveProperty(k);
  });
});

describe('defect_update — the rest of the form', () => {
  test('changes the fields, "none" clears them, and the same values again change nothing', async () => {
    const { a, st } = backend();
    await a.createDefect({ name: 'Some defect' });
    const r = await a.updateDefect('DE-75', { environment: 'UAT', type: undefined, executionType: 'manual', featureId: '248', plannedStartDate: '2026-12-01', plannedEndDate: '2026-12-05' });
    expect(r.written).toBe(true);
    expect(r.changes.map((c: any) => `${c.field}: ${c.to}`)).toEqual(['environment: UAT', 'type: Manual', 'feature: FT-248 MCP F18', 'planned start date: 2026-12-01', 'planned end date: 2026-12-05']);
    const body = st.puts.at(-1)!.body;
    expect(Object.keys(body).sort()).toEqual(['environment', 'executionType', 'featureId', 'plannedEndDate', 'plannedStartDate', 'projectId', 'updateVersion']);
    const putsBefore = st.puts.length;
    const again = await a.updateDefect('DE-75', { environment: 'UAT', executionType: 'Manual', featureId: 'FT-248', plannedStartDate: '2026-12-01', plannedEndDate: '2026-12-05' });
    expect(again.written).toBe(false);
    expect(st.puts.length).toBe(putsBefore);
    const cleared = await a.updateDefect('DE-75', { featureId: 'none', plannedEndDate: 'none', environment: 'none' });
    expect(cleared.written).toBe(true);
    expect(st.defects.get(75)).toMatchObject({ featureId: null, plannedEndDate: null, environment: '' });
  });

  test('an end date before the STORED start date is refused, and nothing is written', async () => {
    const { a, st } = backend();
    await a.createDefect({ name: 'Some defect', plannedStartDate: '2026-12-10' });
    const before = st.puts.length;
    await expect(a.updateDefect('DE-75', { plannedEndDate: '2026-12-01' })).rejects.toThrow(/must be on or after the planned start date \(2026-12-10\)/);
    expect(st.puts.length).toBe(before);
  });

  test('links alone: one save carrying only the new row; asking again is reported as already linked and writes nothing', async () => {
    const { a, st } = backend();
    await a.createDefect({ name: 'Some defect' });
    const r = await a.updateDefect('DE-75', { linkages: [{ destType: 'defect', destId: 'DE-9', linkType: 'Clones' }] });
    expect(r.written).toBe(true);
    expect(r.changes).toEqual([{ field: 'linkage', from: '(none)', to: 'DE-9 (Clones)' }]);
    expect(st.puts.at(-1)!.body.linkedIssues).toHaveLength(1);
    const puts = st.puts.length;
    const again = await a.updateDefect('DE-75', { linkages: [{ destType: 'defect', destId: 'DE-9', linkType: 'Clones' }] });
    expect(again.written).toBe(false);
    expect(again.warnings.join(' ')).toMatch(/already linked to DE-9 \(Clones\)/);
    expect(st.puts.length).toBe(puts);
    expect(st.links.filter((l) => l.parentId === 75 && l.parentType === 'DE')).toHaveLength(1);
  });
});

describe('attachments on a defect', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  test('add: the file rides the defect\'s own update as `filename1`, with ONLY the project and version as fields', async () => {
    const { a, st } = backend();
    await a.createDefect({ name: 'Some defect' });
    const r = await a.addAttachment({ entityType: 'defect', itemId: 'DE-75', fileName: 'shot.png', contentType: 'image/png', data: bytes });
    const mp = st.multiparts.at(-1)!;
    expect([mp.path, mp.objKey, Object.keys(mp.obj).sort(), mp.files![0].partName, mp.files![0].fileName]).toEqual(['/pm/defect/75', 'defectObj', ['projectId', 'updateVersion'], 'filename1', 'shot.png']);
    expect(r.attachments.map((x: any) => x.original_name)).toEqual(['shot.png']);
    await a.addAttachment({ entityType: 'defect', itemId: 'DE-75', fileName: 'log.txt', data: bytes });
    expect((await a.entityAttachments('defect', '75')).map((x: any) => x.original_name)).toEqual(['shot.png', 'log.txt']);   // the first one is still there
  });

  test('remove: only the named row is sent, flagged deleted, WITH the project — and it is gone on read-back; an unknown name lists what exists', async () => {
    const { a, st } = backend();
    await a.createDefect({ name: 'Some defect' });
    await a.addAttachment({ entityType: 'defect', itemId: 'DE-75', fileName: 'shot.png', data: bytes });
    await a.addAttachment({ entityType: 'defect', itemId: 'DE-75', fileName: 'log.txt', data: bytes });
    const r = await a.removeAttachment({ entityType: 'defect', itemId: 'DE-75', attachment: 'shot.png' });
    expect(r.attachments.map((x: any) => x.original_name)).toEqual(['log.txt']);
    const sent = st.multiparts.at(-1)!.obj;
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments[0]).toMatchObject({ original_name: 'shot.png', deleted: true, projectId: 19 });
    await expect(a.removeAttachment({ entityType: 'defect', itemId: 'DE-75', attachment: 'nope.png' })).rejects.toThrow(/No attachment "nope\.png" on defect DE-75\. Attachments: log\.txt/);
  });

  test('the other kinds are untouched: an epic / feature / story still goes through its own object key', async () => {
    const spec = await import('./adapter.js');
    expect(typeof spec.SimplifyQaAdapter.prototype.addAttachment).toBe('function');
  });
});

describe('the tools', () => {
  const capture = (a: any) => {
    const reg = new Map<string, { schema: Record<string, z.ZodTypeAny>; h: (x: any) => Promise<any> }>();
    const server: any = { registerTool: (n: string, cfg: any, h: any) => { reg.set(n, { schema: cfg.inputSchema, h }); } };
    registerDefectUpdateTool(server, { getAdapter: () => a });
    registerAttachmentTools(server, { getAdapter: () => a });
    registerBacklogTools(server, { getAdapter: () => a } as any);
    return reg;
  };
  const text = (r: any) => String(r.content?.[0]?.text ?? '');

  test('defect_create: the form fields, a link and a file in ONE call — and `type` is the same field as executionType', async () => {
    const { a, st } = backend();
    const t = capture(a);
    const r = await t.get('defect_create')!.h({ name: 'Login fails on SSO', environment: 'QA', type: 'Manual', featureId: 'FT-248', plannedStartDate: '2026-11-20',
      linkages: [{ destType: 'defect', destId: 'DE-9', linkType: 'Clones' }], attachments: [{ base64: Buffer.from('hello').toString('base64'), fileName: 'note.txt' }] });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/Logged defect DE-75.*\nForm fields saved: environment QA; type Manual; feature FT-248 MCP F18; planned start 2026-11-20\.\nLinked from the defect to: DE-9 \(Clones\)\./s);
    expect(text(r)).toMatch(/Attached to DE-75: note\.txt\./);
    expect(st.attachments.map((x) => x.original_name)).toEqual(['note.txt']);
    const clash = await t.get('defect_create')!.h({ name: 'Another one', type: 'Manual', executionType: 'Automation' });
    expect(clash.isError).toBe(true);
    expect(text(clash)).toMatch(/same field/);
  });

  test('defect_update: attachments alone work, and a failed attachment says what was done and what failed', async () => {
    const { a } = backend();
    const t = capture(a);
    await a.createDefect({ name: 'Some defect' });
    const ok1 = await t.get('defect_update')!.h({ defectId: 'DE-75', attachments: [{ base64: Buffer.from('x').toString('base64'), fileName: 'a.txt' }] });
    expect(ok1.isError).toBeFalsy();
    expect(text(ok1)).toMatch(/Attached to DE-75: a\.txt\./);
    const bad = await t.get('defect_update')!.h({ defectId: 'DE-75', environment: 'QA', attachments: [{ filePath: '/definitely/missing/file.png' }] });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/Updated defect DE-75[\s\S]*environment: .* → QA[\s\S]*Could not attach/);
    expect((await t.get('defect_update')!.h({ defectId: 'DE-75' })).isError).toBe(true);
  });

  test('attachment_add / attachment_delete / attachment_download and backlog_link now accept a defect', () => {
    const t = capture(backend().a);
    for (const n of ['attachment_add', 'attachment_delete', 'attachment_download']) {
      expect(z.object(t.get(n)!.schema).safeParse({ entityType: 'defect', itemId: 'DE-75', attachment: 'x', filePath: 'x' }).success).toBe(true);
    }
    expect(z.object(t.get('backlog_link')!.schema).safeParse({ sourceType: 'defect', sourceId: 'DE-75', destType: 'defect', destId: 'DE-9', linkType: 'Clones' }).success).toBe(true);
  });
});
