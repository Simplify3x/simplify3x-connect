import { deflateRawSync } from 'node:zlib';

/**
 * Minimal dependency-free .xlsx writer: one or more sheets, a bold header row, text and number cells. Strings are
 * written as inline strings (never evaluated as formulas), so test-case names that start with `=`/`+`
 * are safe. Enough for tabular exports; not a general spreadsheet library.
 */
export type XlsxCell = string | number | boolean | null | undefined;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const comp = deflateRawSync(e.data);
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + comp.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

const xmlEsc = (s: string) =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colName(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Named cell styles (index into cellXfs below). Body cells wrap, align to the top and have a thin border,
 * so long root causes / reasons read like the PDF table instead of spilling across the sheet.
 */
const STYLE = {
  default: 0, header: 1, text: 2, number: 3, link: 4,
  APP_DEFECT: 5, NEW_CHANGE: 6, AUTOMATION_DATA: 7, UNCLASSIFIED: 8,
  title: 9, note: 10, totalLabel: 11, totalNumber: 12, bold: 13,
} as const;
export type XlsxStyle = keyof typeof STYLE;

/** A cell with an explicit style and/or a clickable link (an external URL). */
export type XlsxRichCell = { v: XlsxCell; style?: XlsxStyle; link?: string };
export type XlsxAnyCell = XlsxCell | XlsxRichCell;

/** Excel's hard limit per cell is 32,767 characters. */
const MAX_CELL_CHARS = 32_000;

const isRich = (c: XlsxAnyCell): c is XlsxRichCell => typeof c === 'object' && c !== null;

function cell(ref: string, v: XlsxCell, style?: number): string {
  const s = style ? ` s="${style}"` : '';
  if (v === null || v === undefined || v === '') return `<c r="${ref}"${s}/>`;
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
  if (typeof v === 'boolean') return `<c r="${ref}"${s} t="b"><v>${v ? 1 : 0}</v></c>`;
  const text = String(v);
  const clipped = text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS - 3)}...` : text;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(clipped)}</t></is></c>`;
}

export type XlsxSheet = {
  name: string;
  headers: string[];
  rows: XlsxAnyCell[][];
  /** Big bold title in A1, then `notes` (one per row), a blank row, then the table. */
  title?: string;
  notes?: string[];
  /** Column widths in characters; default 50 for column B and 18 for the rest. */
  widths?: number[];
  /** Add an Excel filter dropdown on the header row (default true when there are rows). */
  autoFilter?: boolean;
  /** Rows appended under the table with a bold "total" style (no filter applied to them). */
  totals?: XlsxAnyCell[][];
};

function sheetXml(sh: XlsxSheet, linkRelId: (url: string) => string): { xml: string } {
  const sheetRows: string[] = [];
  let rn = 1;
  if (sh.title) {
    sheetRows.push(`<row r="${rn}" ht="24" customHeight="1">${cell(`A${rn}`, sh.title, STYLE.title)}</row>`);
    rn++;
    for (const n of sh.notes ?? []) {
      sheetRows.push(`<row r="${rn}">${cell(`A${rn}`, n, STYLE.note)}</row>`);
      rn++;
    }
    rn++; // blank row before the table
  }
  const headerRow = rn;
  const ncols = Math.max(sh.headers.length, ...sh.rows.map((r) => r.length), ...(sh.totals ?? []).map((r) => r.length), 1);
  sheetRows.push(`<row r="${rn}">${sh.headers.map((h, c) => cell(`${colName(c)}${rn}`, h, STYLE.header)).join('')}</row>`);
  rn++;
  const links: Array<{ ref: string; id: string }> = [];
  const writeRow = (r: XlsxAnyCell[], total: boolean): void => {
    const cells = r.map((raw, c) => {
      const ref = `${colName(c)}${rn}`;
      const rich = isRich(raw) ? raw : { v: raw };
      const base: XlsxStyle = total
        ? (typeof rich.v === 'number' ? 'totalNumber' : 'totalLabel')
        : typeof rich.v === 'number' ? 'number' : 'text';
      // Only http(s) urls become links (never javascript:, file:, …).
      const linkOk = !!rich.link && /^https?:\/\//i.test(rich.link);
      const style = rich.style ?? (linkOk ? 'link' : base);
      if (linkOk) links.push({ ref, id: linkRelId(rich.link!) });
      return cell(ref, rich.v, STYLE[style]);
    });
    sheetRows.push(`<row r="${rn}">${cells.join('')}</row>`);
    rn++;
  };
  for (const r of sh.rows) writeRow(r, false);
  const lastDataRow = rn - 1;
  for (const r of sh.totals ?? []) writeRow(r, true);

  const width = (c: number): number => sh.widths?.[c] ?? (c === 1 ? 50 : 18);
  const cols = Array.from({ length: ncols }, (_, c) => `<col min="${c + 1}" max="${c + 1}" width="${width(c)}" customWidth="1"/>`).join('');
  const top = `${colName(0)}${headerRow + 1}`;
  const pane = `<pane ySplit="${headerRow}" topLeftCell="${top}" activePane="bottomLeft" state="frozen"/>`;
  const filter = (sh.autoFilter ?? true) && sh.rows.length > 0 && sh.headers.length > 0
    ? `<autoFilter ref="A${headerRow}:${colName(sh.headers.length - 1)}${lastDataRow}"/>` : '';
  const hyperlinks = links.length
    ? `<hyperlinks>${links.map((l) => `<hyperlink ref="${l.ref}" r:id="${l.id}"/>`).join('')}</hyperlinks>` : '';
  return {
    xml:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
      `<sheetViews><sheetView workbookViewId="0" zoomScale="90">${pane}</sheetView></sheetViews>` +
      `<sheetFormatPr defaultRowHeight="15"/>` +
      `<cols>${cols}</cols><sheetData>${sheetRows.join('')}</sheetData>${filter}${hyperlinks}` +
      '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>' +
      '<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>' +
      '</worksheet>',
  };
}

/** Excel sheet names: max 31 chars, none of []:*?/\, unique case-insensitively (duplicates get " (2)", " (3)"…). */
function uniqueSheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    const base = raw.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Sheet';
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

export function buildXlsxBook(sheets: XlsxSheet[]): Buffer {
  const book = sheets.length > 0 ? sheets : [{ name: 'Sheet1', headers: [], rows: [] }];
  const names = uniqueSheetNames(book.map((s) => s.name));
  // fonts: 0 normal · 1 bold · 2 bold white (header) · 3 link · 4 title · 5 note (grey)
  // fills: 0 none · 1 gray125 (required) · 2 header navy · 3 app defect · 4 new change · 5 automation/data · 6 unclassified
  // borders: 0 none · 1 thin grey all round
  const fill = (rgb: string) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
  const xf = (font: number, fillId: number, border: number, align: string) =>
    `<xf numFmtId="0" fontId="${font}" fillId="${fillId}" borderId="${border}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment ${align}/></xf>`;
  const TOP_WRAP = 'vertical="top" wrapText="1"';
  const CENTER_TOP = 'horizontal="center" vertical="top" wrapText="1"';
  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="6">' +
    '<font><sz val="10"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="10"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>' +
    '<font><u/><sz val="10"/><color rgb="FF0563C1"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="16"/><color rgb="FF1F3A5F"/><name val="Calibri"/></font>' +
    '<font><sz val="10"/><color rgb="FF444444"/><name val="Calibri"/></font>' +
    '</fonts>' +
    `<fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fill('1F3A5F')}${fill('F8D7DA')}${fill('FFF3CD')}${fill('D6E4F5')}${fill('E2E3E5')}</fills>` +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border><left style="thin"><color rgb="FFB0B6C3"/></left><right style="thin"><color rgb="FFB0B6C3"/></right><top style="thin"><color rgb="FFB0B6C3"/></top><bottom style="thin"><color rgb="FFB0B6C3"/></bottom><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="14">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' + // 0 default
    xf(2, 2, 1, 'horizontal="center" vertical="center" wrapText="1"') + // 1 header
    xf(0, 0, 1, TOP_WRAP) + // 2 text
    xf(0, 0, 1, CENTER_TOP) + // 3 number
    xf(3, 0, 1, TOP_WRAP) + // 4 link
    xf(1, 3, 1, CENTER_TOP) + // 5 APP_DEFECT
    xf(1, 4, 1, CENTER_TOP) + // 6 NEW_CHANGE
    xf(1, 5, 1, CENTER_TOP) + // 7 AUTOMATION_DATA
    xf(1, 6, 1, CENTER_TOP) + // 8 UNCLASSIFIED
    xf(4, 0, 0, 'vertical="center"') + // 9 title
    xf(5, 0, 0, 'vertical="top"') + // 10 note
    xf(1, 6, 1, TOP_WRAP) + // 11 total label
    xf(1, 6, 1, CENTER_TOP) + // 12 total number
    xf(1, 0, 1, TOP_WRAP) + // 13 bold
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const sheetOverrides = book
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('');
  const sheetEntries = names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const sheetRels = book
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join('');
  const stylesRel = `<Relationship Id="rId${book.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  const files: Array<{ name: string; data: Buffer }> = [
    { name: '[Content_Types].xml', data: Buffer.from(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheetOverrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`) },
    { name: '_rels/.rels', data: Buffer.from(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: 'xl/workbook.xml', data: Buffer.from(`${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEntries}</sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}${stylesRel}</Relationships>`) },
    { name: 'xl/styles.xml', data: Buffer.from(styles) },
  ];
  book.forEach((sh, i) => {
    // One relationship per distinct link url in this sheet (external hyperlinks).
    const rels = new Map<string, string>();
    const { xml } = sheetXml(sh, (url) => {
      let id = rels.get(url);
      if (!id) { id = `rIdL${rels.size + 1}`; rels.set(url, id); }
      return id;
    });
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(xml) });
    if (rels.size) {
      const body = [...rels]
        .map(([url, id]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEsc(url)}" TargetMode="External"/>`)
        .join('');
      files.push({ name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`, data: Buffer.from(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`) });
    }
  });
  return zip(files);
}

export function buildXlsx(sheetName: string, headers: string[], rows: XlsxCell[][]): Buffer {
  return buildXlsxBook([{ name: sheetName, headers, rows }]);
}
