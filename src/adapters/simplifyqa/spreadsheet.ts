/**
 * Minimal spreadsheet reader for the Excel import tool: `.xlsx` and `.csv` / `.tsv`.
 *
 * An .xlsx is a ZIP of XML parts; this reads it with Node's zlib only (no dependency): the central
 * directory is walked, `xl/sharedStrings.xml` + the first worksheet are inflated, and the rows are
 * turned into a plain `string[][]` (column letters honoured, so a sparse row keeps its gaps).
 * `.csv` / `.tsv` are parsed with RFC-4180 quoting (a quoted field may contain the delimiter, quotes
 * and newlines).
 */

import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

export type Sheet = { rows: string[][] };

// --------------------------------------------------------------------------- ZIP

type ZipEntry = { name: string; method: number; compressedSize: number; dataStart: number };

function zipEntries(buf: Buffer): ZipEntry[] {
  // End of central directory: scan backwards for 0x06054b50 (comment may follow).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (no ZIP end-of-central-directory found).');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    // Local header carries its OWN name/extra lengths — they can differ from the central copy.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    entries.push({ name, method, compressedSize, dataStart });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipRead(buf: Buffer, entry: ZipEntry): Buffer {
  const raw = buf.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`Unsupported ZIP compression method ${entry.method} in ${entry.name}.`);
}

// --------------------------------------------------------------------------- XML helpers

function unescapeXml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Text of every `<t>` inside a fragment (shared strings split runs into several `<t>`). */
function textOfTs(fragment: string): string {
  const out: string[] = [];
  for (const m of fragment.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) out.push(unescapeXml(m[1] ?? ''));
  return out.join('');
}

function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n > 0 ? n - 1 : 0;
}

function parseSheetXml(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    const body = rm[1] ?? '';
    for (const cm of body.matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] ?? '';
      const inner = cm[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '';
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? '';
      let value = '';
      if (type === 's') {
        const idx = Number.parseInt(/<v[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '', 10);
        value = Number.isFinite(idx) ? (shared[idx] ?? '') : '';
      } else if (type === 'inlineStr') {
        value = textOfTs(inner);
      } else {
        value = unescapeXml(/<v[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
      }
      const at = ref ? columnIndex(ref) : cells.length;
      while (cells.length < at) cells.push('');
      cells[at] = value;
    }
    rows.push(cells);
  }
  return rows;
}

// --------------------------------------------------------------------------- CSV

export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, ''); // Excel's UTF-8 BOM
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  // Drop a trailing empty row (a file ending in a newline).
  return rows.filter((r, i) => !(i === rows.length - 1 && r.length === 1 && r[0] === ''));
}

// --------------------------------------------------------------------------- Entry point

export async function readSpreadsheet(filePath: string): Promise<Sheet> {
  const ext = (filePath.split('.').pop() ?? '').toLowerCase();
  if (!['csv', 'txt', 'tsv', 'xlsx'].includes(ext)) {
    throw new Error(`Unsupported file type ".${ext}" — import a .xlsx, .csv or .tsv file.`);
  }
  const buf = await readFile(filePath);
  if (ext === 'csv' || ext === 'txt') {
    return { rows: parseDelimited(buf.toString('utf8'), ',') };
  }
  if (ext === 'tsv') {
    return { rows: parseDelimited(buf.toString('utf8'), '\t') };
  }
  if (ext !== 'xlsx') {
    throw new Error(`Unsupported file type ".${ext}" — import a .xlsx, .csv or .tsv file.`);
  }
  const entries = zipEntries(buf);
  const byName = new Map(entries.map((e) => [e.name.replace(/^\//, ''), e]));
  const read = (name: string): string | undefined => {
    const e = byName.get(name);
    return e ? zipRead(buf, e).toString('utf8') : undefined;
  };
  const sharedXml = read('xl/sharedStrings.xml') ?? '';
  const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOfTs(m[1] ?? ''));
  // First worksheet: workbook.xml lists sheets in order with their rIds; fall back to sheet1.xml.
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const workbook = read('xl/workbook.xml');
  const rels = read('xl/_rels/workbook.xml.rels');
  const firstSheet = workbook?.match(/<sheet\b[^>]*>/)?.[0] ?? '';
  const rid = /\br:id="([^"]+)"/.exec(firstSheet)?.[1];
  if (rid && rels) {
    const rel = new RegExp(`<Relationship\\b[^>]*\\bId="${rid}"[^>]*>`).exec(rels)?.[0] ?? '';
    const target = /\bTarget="([^"]+)"/.exec(rel)?.[1];
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  }
  const sheetXml = read(sheetPath);
  if (!sheetXml) throw new Error(`The workbook has no readable worksheet (looked for ${sheetPath}).`);
  return { rows: parseSheetXml(sheetXml, shared) };
}
