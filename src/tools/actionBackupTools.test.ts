import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerActionBackupTools } from './actionBackup.tools.js';

const row = (id: number, name: string, template: number, uniqueId?: string) =>
  ({ id, name, disname: name, objectTemplate: template, uniqueId: uniqueId ?? '', type: 'FRAMEWORK', projectId: 1 });

function setup(live: any[]) {
  const created: any[] = [];
  const adapter: any = {
    listAllActionsFull: async () => live,
    createActionFromBackup: async (r: any) => { created.push(r); return { id: `new-${r.name}` }; },
  };
  const handlers: Record<string, (a: any) => Promise<any>> = {};
  const server: any = { registerTool: (n: string, _c: unknown, fn: (a: any) => Promise<any>) => { handlers[n] = fn; } };
  registerActionBackupTools(server, { getAdapter: () => adapter, getProjectId: () => 1 });
  return { run: (a: any) => handlers['action_template_backup']!(a), created };
}

describe('action_template_backup', () => {
  test('save → verify → restore round-trip (missing action is re-created, existing one untouched)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sqa-actions-'));
    const path = join(dir, 'snapshot.json');
    const full = [row(11, 'Click', 5, 'web-click'), row(12, 'Enter Text', 5, 'web-type')];

    // save
    const save = setup(full);
    const saved = await save.run({ action: 'save', snapshotPath: path });
    expect(saved.isError).toBeFalsy();
    const snap = JSON.parse(await readFile(path, 'utf8'));
    expect(snap.actions).toHaveLength(2);

    // a bad sync dropped "Enter Text"
    const afterSync = [row(11, 'Click', 5, 'web-click'), row(994, 'Upload excel', 5, '40_upload-v5')];
    const verify = setup(afterSync);
    const v = await verify.run({ action: 'verify', snapshotPath: path });
    expect(v.content[0].text).toMatch(/1 action\(s\) from/);
    expect(v.content[0].text).toContain('Enter Text');

    // restore is dry by default
    const dry = await verify.run({ action: 'restore', snapshotPath: path });
    expect(dry.content[0].text).toMatch(/DRY RUN/);
    expect(verify.created).toHaveLength(0);

    // confirm re-creates only the missing one
    const done = await verify.run({ action: 'restore', snapshotPath: path, confirm: true });
    expect(done.isError).toBeFalsy();
    expect(verify.created.map((c) => c.name)).toEqual(['Enter Text']);
    expect(done.content[0].text).toMatch(/Restored 1 of 1/);
  });

  test('save reports the count per template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sqa-actions-'));
    const { run } = setup([row(11, 'Click', 5), row(21, 'Connect', 2), row(22, 'Query', 2)]);
    const res = await run({ action: 'save', snapshotPath: join(dir, 's.json') });
    expect(res.content[0].text).toMatch(/template 2: 2/);
    expect(res.content[0].text).toMatch(/template 5: 1/);
  });

  test('verify on a clean catalogue says nothing is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sqa-actions-'));
    const path = join(dir, 's.json');
    const { run } = setup([row(11, 'Click', 5)]);
    await run({ action: 'save', snapshotPath: path });
    const v = await run({ action: 'verify', snapshotPath: path });
    expect(v.content[0].text).toMatch(/No action is missing/);
  });
});
