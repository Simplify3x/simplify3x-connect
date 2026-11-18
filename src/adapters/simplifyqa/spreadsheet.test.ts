import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDelimited, readSpreadsheet } from './spreadsheet.js';

describe('spreadsheet reader', () => {
  test('CSV: quoted fields keep commas, quotes and newlines', () => {
    const rows = parseDelimited('name,description,steps\r\n"Login, happy","say ""hi""","step 1\nstep 2"\r\n', ',');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(['name', 'description', 'steps']);
    expect(rows[1]).toEqual(['Login, happy', 'say "hi"', 'step 1\nstep 2']);
  });

  test('TSV via readSpreadsheet (file on disk, BOM stripped)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sqa-imp-'));
    const file = join(dir, 'rows.tsv');
    await writeFile(file, '\uFEFFname\tmodule\nLogin\t7\n', 'utf8');
    const { rows } = await readSpreadsheet(file);
    expect(rows[0]).toEqual(['name', 'module']);
    expect(rows[1]).toEqual(['Login', '7']);
  });

  test('rejects an unsupported extension', async () => {
    await expect(readSpreadsheet('C:/nope/data.pdf')).rejects.toThrow(/Unsupported file type/);
  });
});
