import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerImportTools } from './import.tools.js';

async function csvFile(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sqa-imp-tool-'));
  const file = join(dir, 'rows.csv');
  await writeFile(file, body, 'utf8');
  return file;
}

function setup() {
  const created: any[] = [];
  const adapter: any = {
    createTestCase: async (tc: any) => { created.push(tc); return { id: String(created.length) }; },
  };
  const handlers: Record<string, (a: any) => Promise<any>> = {};
  const server: any = { registerTool: (n: string, _c: unknown, fn: (a: any) => Promise<any>) => { handlers[n] = fn; } };
  registerImportTools(server, { getAdapter: () => adapter });
  return { run: (a: any) => handlers['excel_import']!(a), created };
}

describe('excel_import', () => {
  test('testcases: dry run writes nothing, the real run creates one MANUAL TC per row', async () => {
    const file = await csvFile('Name,Description,Steps,Expected Result\nLogin,from csv,"Open app|Click login",Logged in\n');
    const { run, created } = setup();

    const dry = await run({ filePath: file, kind: 'testcases', dryRun: true });
    expect(dry.isError).toBeFalsy();
    expect(dry.content[0].text).toMatch(/DRY RUN/);
    expect(created).toHaveLength(0);

    const real = await run({ filePath: file, kind: 'testcases' });
    expect(real.isError).toBeFalsy();
    expect(created).toHaveLength(1);
    expect(created[0].category).toBe('manual');
    expect(created[0].title).toBe('Login');
    expect(created[0].steps.map((s: any) => s.description)).toEqual(['Open app', 'Click login']);
    expect(created[0].steps[0].expectedResult).toBe('Logged in');
  });

  test('testcases without a name column is refused before any write', async () => {
    const file = await csvFile('Description,Steps\nno name here,Step 1\n');
    const { run, created } = setup();
    const res = await run({ filePath: file, kind: 'testcases' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/No "name"/);
    expect(created).toHaveLength(0);
  });

  test('testdata needs tcId + environmentType', async () => {
    const file = await csvFile('url\na\n');
    const { run } = setup();
    expect((await run({ filePath: file, kind: 'testdata' })).isError).toBe(true);
    expect((await run({ filePath: file, kind: 'testdata', tcId: 'TC-1' })).content[0].text).toMatch(/environmentType/);
  });
});
