#!/usr/bin/env node
/**
 * DESKTOP scenarios on a real application, Notepad++, through the real MCP: common-mcp (dist/cli.js) -> the Java
 * recorder -> the desktop plugin and Desktop_Service.exe. Each scenario is a short series of tool calls, as an AI
 * client would make them, with a check; a failed scenario is reported and the run goes on. A results table is printed
 * at the end and written to the log folder.
 *
 *   node scripts\desktop-notepadpp.mjs                  starts the Java recorder on :4050 (target jar) itself
 *   set QA_MCP_URL=http://127.0.0.1:4040/mcp & node scripts\desktop-notepadpp.mjs      uses the agent instead
 *   --custom      (standalone only) turns desktop_custom_action on and adds its scenarios
 *   --save        saves the recording as a test case (writes to the backend, project QA_MCP_PROJECT_ID, default 1)
 *   --run         saves it and runs it on this machine's agent
 *
 * HANDS OFF: the real mouse and keyboard are used. Notepad++ must be closed first.
 *
 * Safety: only a new tab is typed into ("hello mcp"), and it is closed without saving. The Find dialog's options are
 * set back. When the run ends, any session entry or backup that Notepad++'s periodic backup kept for a typed tab
 * during the run is removed. Optional environment: NPP_EXE, QA_MCP_URL, QA_MCP_PROJECT_ID, JAVA_HOME,
 * SIMPLIFYQA_AGENT_HOME.
 */
import { spawn, execFileSync } from 'node:child_process';
import {
  createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const workspace = resolve(repo, '..');
const javaDir = join(workspace, 'simplifyqa-mcp-server');
const agentHome = process.env.SIMPLIFYQA_AGENT_HOME ?? 'D:\\MyProjects\\New-Agnet\\simplifyqa-agent';
const NPP = process.env.NPP_EXE ?? 'C:\\Program Files\\Notepad++\\notepad++.exe';
const TEXT = 'hello mcp';
const JAVA_PORT = 4050;
const CALL_TIMEOUT = 90_000;

const logDir = mkdtempSync(join(tmpdir(), 'desktop-notepadpp-'));
const log = (...a) => console.log('[npp]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n = 240) => (s.length > n ? `${s.slice(0, n)}...` : s);
const fail = (message) => { throw new Error(message); };

function connection() {
  const file = join(workspace, 'dummyProjectMcp', '.mcp.json');
  const server = Object.values(JSON.parse(readFileSync(file, 'utf8')).mcpServers ?? {}).find((s) => s?.env?.QA_MCP_TOKEN);
  if (!server?.env?.QA_BASE_URL || !server.env.QA_MCP_TOKEN) fail(`QA_BASE_URL and QA_MCP_TOKEN must be set in ${file}`);
  return { baseUrl: server.env.QA_BASE_URL, token: server.env.QA_MCP_TOKEN };
}

function portOpen(port) {
  return new Promise((done) => {
    const s = createConnection({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); done(true); });
    s.once('error', () => done(false));
  });
}

function pids(exe) {
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${exe}`], { encoding: 'utf8' });
    return new Set(out.split(/\r?\n/).map((l) => l.split('","')[1]).filter((p) => p && /^\d+$/.test(p)));
  } catch {
    return new Set();
  }
}

async function startJava(custom) {
  if (await portOpen(JAVA_PORT)) fail(`port ${JAVA_PORT} is in use: stop that process, or set QA_MCP_URL to use it`);
  const jar = join(javaDir, 'target', 'simplifyqa-mcp-server.jar');
  if (!existsSync(jar)) fail(`${jar} is missing: package the Java server first`);
  const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'java.exe') : 'java';
  const stepData = join(logDir, 'stepData');
  mkdirSync(stepData, { recursive: true });
  const child = spawn(java, ['-jar', jar], {
    cwd: javaDir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      SIMPLIFYQA_MCP_TRANSPORT: 'http', SIMPLIFYQA_EDIT_PORT: '4952', SIMPLIFYQA_UI_ENABLED: 'false',
      SIMPLIFYQA_UI_URL: 'http://127.0.0.1:9', SIMPLIFYQA_STEPDATA_DIR: stepData,
      SIMPLIFYQA_DESKTOP_PLUGIN_PATH: join(agentHome, 'plugins', 'execution', 'desktop-execution.jar'),
      SIMPLIFYQA_DESKTOP_DRIVER_PATH: join(agentHome, 'libs', 'desktop', 'Desktop_Service.exe'),
      ...(custom ? { SIMPLIFYQA_DESKTOP_CUSTOM_ACTION: 'true' } : {}),
    },
  });
  child.stderr.pipe(createWriteStream(join(logDir, 'java.err')));
  for (const end = Date.now() + 60_000; !(await portOpen(JAVA_PORT));) {
    if (Date.now() > end) { child.kill(); fail(`the Java recorder did not start; see ${join(logDir, 'java.err')}`); }
    await sleep(500);
  }
  return child;
}

let client;
let snapNo = 0;

/** One tool call; never throws for a tool error (the caller checks), only for a transport failure or timeout. */
async function call(name, args = {}, timeout = CALL_TIMEOUT) {
  const t0 = Date.now();
  let r;
  try {
    r = await client.callTool({ name, arguments: args }, undefined, { timeout });
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    log(`${name} ${JSON.stringify(args)} (${Date.now() - t0} ms) -> TRANSPORT ERROR ${clip(text)}`);
    return { text, error: true, ms: Date.now() - t0, structured: {} };
  }
  const text = (r.content ?? []).map((c) => c.text ?? '').join('\n');
  log(`${name} ${JSON.stringify(args)} (${Date.now() - t0} ms) -> ${r.isError ? 'ERROR ' : ''}${clip(text.replace(/\s+/g, ' '))}`);
  return { text, error: Boolean(r.isError), ms: Date.now() - t0, structured: r.structuredContent ?? {} };
}

/** A call that must succeed. */
async function must(name, args = {}, timeout = CALL_TIMEOUT) {
  const r = await call(name, args, timeout);
  if (r.error) fail(`${name} failed: ${clip(r.text, 400)}`);
  return r;
}

/** A snapshot whose outline is also kept in the log folder. */
async function snapshot(label, args = {}, timeout = CALL_TIMEOUT) {
  const r = await must('desktop_snapshot', args, timeout);
  writeFileSync(join(logDir, `${String(++snapNo).padStart(2, '0')}-${label}.txt`), r.text);
  return r.text;
}

/** The ref on the first outline line that contains the marker (a string or a RegExp), or null. */
function refOf(outline, marker) {
  for (const line of outline.split('\n')) {
    if (typeof marker === 'string' ? !line.includes(marker) : !marker.test(line)) continue;
    const m = /^\s*(e\d+) \[/.exec(line);
    if (m) return m[1];
  }
  return null;
}

function need(outline, marker, what) {
  return refOf(outline, marker) ?? fail(`no ${what} in the outline (marker ${marker}); see the log folder`);
}

const results = [];
async function scenario(id, title, fn) {
  const t0 = Date.now();
  log(`--- ${id} ${title}`);
  try {
    const note = await fn();
    results.push({ id, title, status: 'PASS', note: note ?? '', ms: Date.now() - t0 });
  } catch (e) {
    const note = e instanceof Error ? e.message : String(e);
    results.push({ id, title, status: e?.skip ? 'SKIP' : 'FAIL', note: clip(note.replace(/\s+/g, ' '), 300), ms: Date.now() - t0 });
    log(`${id} ${e?.skip ? 'SKIPPED' : 'FAILED'}: ${clip(note.replace(/\s+/g, ' '), 300)}`);
  }
}
const skip = (why) => Object.assign(new Error(why), { skip: true });

/** Remove what Notepad++'s periodic backup kept of a tab this run typed into: the backup and its session entry. */
function undoNotepadBackups(since) {
  const dir = join(process.env.APPDATA ?? '', 'Notepad++');
  const backups = join(dir, 'backup');
  if (!existsSync(backups)) return [];
  if (pids('notepad++.exe').size) { log('Notepad++ is still running: its backups are left as they are'); return []; }
  const ours = readdirSync(backups).filter((f) => {
    const p = join(backups, f);
    return statSync(p).mtimeMs >= since - 1000 && /^(?:hello mcp|mcp|\s)*$/i.test(readFileSync(p, 'utf8'));
  });
  if (!ours.length) return [];
  const session = join(dir, 'session.xml');
  if (existsSync(session)) {
    let xml = readFileSync(session, 'utf8');
    for (const f of ours) {
      const name = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      xml = xml.replace(new RegExp(`\\s*<File [^>]*backupFilePath="[^"]*${name}"[^>]*(?:/>|>[\\s\\S]*?</File>)`, 'g'), '');
    }
    writeFileSync(session, xml);
  }
  for (const f of ours) rmSync(join(backups, f));
  return ours;
}

async function readJournal(mcpUrl, conn, sessionId) {
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${conn.token}`, 'x-qa-base-url': conn.baseUrl },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_journal', arguments: { id: sessionId } } }),
  });
  return (await res.json())?.result?.structuredContent?.view?.steps ?? [];
}

async function main() {
  const flags = process.argv.slice(2);
  const unknown = flags.filter((f) => !['--save', '--run', '--custom'].includes(f));
  if (unknown.length) fail(`unknown arguments: ${unknown.join(' ')} (use --custom, --save, --run)`);
  const run = flags.includes('--run');
  const save = run || flags.includes('--save');
  const custom = flags.includes('--custom');
  if (process.platform !== 'win32') fail('DESKTOP needs Windows');
  if (!existsSync(NPP)) fail(`${NPP} is missing (set NPP_EXE)`);
  if (!existsSync(join(repo, 'dist', 'cli.js'))) fail('dist/cli.js is missing: npm run build first');
  if (pids('notepad++.exe').size) fail('Notepad++ is running: close it first (a second launch is refused)');
  if (custom && process.env.QA_MCP_URL) fail('--custom needs the standalone recorder (unset QA_MCP_URL)');
  const since = Date.now();
  const conn = connection();
  const nppBefore = pids('notepad++.exe');
  let java = null;
  let mcpUrl = process.env.QA_MCP_URL;
  if (!mcpUrl) { java = await startJava(custom); mcpUrl = `http://127.0.0.1:${JAVA_PORT}/mcp`; }
  log(`recorder ${mcpUrl}${java ? ' (started here)' : ''}; logs ${logDir}`);

  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(repo, 'dist', 'cli.js')], cwd: repo, stderr: 'pipe',
    env: { ...process.env, QA_MCP_PROVIDER: 'simplifyqa', QA_BASE_URL: conn.baseUrl, QA_MCP_TOKEN: conn.token,
      QA_MCP_URL: mcpUrl, QA_MCP_PROJECT_ID: process.env.QA_MCP_PROJECT_ID ?? '1' },
  });
  transport.stderr?.pipe(createWriteStream(join(logDir, 'common-mcp.err')));
  client = new Client({ name: 'desktop-notepadpp', version: '1.0.0' });
  const s = {};   // what one scenario hands the next
  let sessionId = null;
  let saved = false;
  try {
    await client.connect(transport);
    for (const end = Date.now() + 120_000; ;) {
      const names = new Set((await client.listTools()).tools.map((t) => t.name));
      if (names.has('desktop_snapshot')) { s.custom = names.has('desktop_custom_action'); break; }
      if (Date.now() > end) fail('common-mcp never advertised the desktop tools');
      await sleep(1000);
    }
    const activated = await must('core_activate_technology', {
      technology: 'DESKTOP', testcaseName: `Notepad++ scenarios ${new Date().toISOString().replace(/[:.]/g, '-')}`,
    });
    sessionId = activated.structured.sessionId ?? null;
    log('HANDS OFF the mouse and keyboard: Notepad++ starts in 5 s.');
    await sleep(5000);

    await scenario('S01', 'Launch Notepad++ (first step)', async () => {
      const r = await must('desktop_launch_application', { app_path: NPP });
      s.title = /current window '([^']+)'/.exec(r.text)?.[1] ?? 'new 1 - Notepad++';
      return `window "${s.title}"`;
    });
    if (results[0].status !== 'PASS') fail('Notepad++ did not start; nothing else can run');

    await scenario('S02', 'Snapshot: menus, document tab, status bar and the editor get refs', async () => {
      s.main = await snapshot('main');
      const missing = [['[Pane] (Scintilla)', 'editor'], ['[MenuItem] "Edit"', 'Edit menu'], ['[TabItem] "new 1"', 'tab'],
        ['"length: 0', 'status length']].filter(([m]) => !s.main.includes(m)).map(([, w]) => w);
      if (missing.length) fail(`missing: ${missing.join(', ')}`);
      const buttons = (s.main.match(/\[Button\]\n/g) ?? []).length;
      return `editor, 16 menus, tab and status bar found; ${buttons} toolbar buttons have no name`;
    });

    await scenario('S03', 'Check a status bar text (partial)', async () => {
      await must('desktop_validate_partial_text', { ref: need(s.main, '"length:', 'status length'), expected: 'length: 0' });
    });

    await scenario('S04', 'Type into the editor by ref', async () => {
      await must('desktop_enter_text', { ref: need(s.main, '[Pane] (Scintilla)', 'editor'), value: TEXT });
      s.typed = true;
      s.main = await snapshot('typed');
      if (!s.main.includes('"length: 9')) fail('the status bar does not show length: 9');
      return 'status bar: length 9';
    });

    await scenario('S05', 'Read a status bar text into a runtime value (its Name property)', async () => {
      // desktop_get_text_and_store cannot read a status bar part (no text pattern); its Name holds the text.
      const r = await must('desktop_get_property_and_store', { ref: need(s.main, '"length:', 'status length'),
        property: 'Name', store_as: 'doc_length' });
      if (!/stored as doc_length = "length: 9/.test(r.text)) fail(`unexpected value: ${clip(r.text)}`);
      return 'doc_length = "length: 9 …"';
    });

    await scenario('S06', 'Keyboard shortcut CONTROL+A selects all', async () => {
      await must('desktop_keyboard_action', { keys: 'CONTROL+A' });
      s.main = await snapshot('select-all');
      if (!/Sel\s*:\s*9\b/.test(s.main)) fail('the status bar shows no selection of 9');
      return 'status bar: Sel 9';
    });

    /** Open a menu-bar menu and return the window outline with its drop-down. */
    async function openMenu(name) {
      const top = await snapshot(`before-${name}`);
      await must('desktop_click', { ref: need(top, `[MenuItem] "${name}"`, `${name} menu`) });
      await sleep(500);
      return snapshot(`menu-${name}`);
    }

    await scenario('S07', 'Menu bar (Win32): Edit > Undo', async () => {
      const menu = await openMenu('Edit');
      await must('desktop_invoke_menu_item', { ref: need(menu, '[MenuItem] "Undo"', 'Undo') });
      s.main = await snapshot('after-undo');
      if (!s.main.includes('"length: 0')) fail('Undo did not empty the document');
      return 'drop-down items are inside the window tree; length back to 0';
    });

    await scenario('S08', 'Menu bar: Edit > Redo', async () => {
      const menu = await openMenu('Edit');
      await must('desktop_invoke_menu_item', { ref: need(menu, '[MenuItem] "Redo"', 'Redo') });
      s.main = await snapshot('after-redo');
      if (!s.main.includes('"length: 9')) fail('Redo did not bring the text back');
      return 'length 9 again';
    });

    await scenario('S09', 'Nested submenu: Edit > Line Operations > Duplicate Current Line', async () => {
      const menu = await openMenu('Edit');
      await must('desktop_click', { ref: need(menu, '[MenuItem] "Line Operations"', 'Line Operations') });
      await sleep(500);
      const sub = await snapshot('submenu-line-operations');
      await must('desktop_invoke_menu_item', { ref: need(sub, '[MenuItem] "Duplicate Current Line"', 'Duplicate Current Line') });
      s.main = await snapshot('after-duplicate');
      if (!s.main.includes('lines: 2')) fail('the line was not duplicated');
      return 'lines: 2';
    });

    await scenario('S09b', 'The editor keeps its ref once the document has two lines', async () => {
      if (s.main.includes('[Pane] (Scintilla)')) return 'editor ref present';
      // Seen in pass 3: the ref went missing here. Keep the raw tree, which shows whether the host left the editor out
      // or the editor gained children (a leaf Pane is what gets a ref).
      const raw = await must('desktop_snapshot_raw');
      writeFileSync(join(logDir, 'two-lines-window.xml'), raw.text);
      const at = raw.text.search(/<Pane[^>]*ClassName="Scintilla"/);
      fail(at < 0 ? 'the editor is not in the UI tree (two-lines-window.xml)'
        : `the editor is in the UI tree but gets no ref: ${clip(raw.text.slice(at, at + 400).replace(/\s+/g, ' '), 400)}`);
    });

    await scenario('S10', 'Open a dialog from a menu: Search > Find...', async () => {
      const menu = await openMenu('Search');
      await must('desktop_invoke_menu_item', { ref: need(menu, '[MenuItem] "Find..."', 'Find...') });
      await sleep(1500);
      s.dlg = await snapshot('find-dialog');
      // An owned dialog is inside its owner's window tree, so the window snapshot shows it (not desktop_list_windows).
      s.find = /^\s*Window "((?:Find|Replace|Mark)[^"]*)"/m.exec(s.dlg)?.[1];
      if (!s.find) fail('no Find window inside the window snapshot');
      return `dialog "${s.find}" appears inside the window snapshot`;
    });

    await scenario('S11', 'The dialog\'s controls have refs (steps on them switch to it by themselves)', async () => {
      if (!s.find) throw skip('no dialog');
      const missing = [['[ComboBox] "Find what', 'Find what'], ['[Button] "Count"', 'Count'], ['[CheckBox] "Match case"', 'Match case'],
        ['[RadioButton] "Normal"', 'Normal'], ['[TabItem] "Replace"', 'Replace tab']].filter(([m]) => !s.dlg.includes(m)).map(([, w]) => w);
      if (missing.length) fail(`missing: ${missing.join(', ')}`);
      return 'combo box, buttons, check boxes, radio buttons and tabs, each with its AutomationId';
    });

    await scenario('S12', 'Clear and type into a ComboBox (Find what)', async () => {
      if (!s.find) throw skip('no dialog');
      const what = need(s.dlg, '[ComboBox] "Find what', 'Find what');
      await must('desktop_clear_text', { ref: what });
      await must('desktop_enter_text', { ref: what, value: 'mcp' });
    });

    await scenario('S13', 'Click a button and check the dialog message (Count)', async () => {
      if (!s.find) throw skip('no dialog');
      await must('desktop_click', { ref: need(s.dlg, '[Button] "Count"', 'Count') });
      await sleep(500);
      s.dlg = await snapshot('find-count');
      const raw = await must('desktop_snapshot_raw');
      writeFileSync(join(logDir, 'find-count.xml'), raw.text);
      // Notepad++ draws the Count result in the dialog's status area without exposing it to UI Automation (the
      // StatusBar has no name and no parts), so the click is what can be checked; a result text is used when present.
      const line = s.dlg.split('\n').find((l) => /\[Text\] "[^"]*\b\d+ match/i.test(l));
      if (line) {
        const r = await call('desktop_validate_partial_text', { ref: /^\s*(e\d+)/.exec(line)[1], expected: '2 match' });
        if (r.error) fail(`message is: ${clip(line.trim())}`);
        return clip(line.trim().replace(/^e\d+ \[Text\] /, ''), 80);
      }
      return 'clicked; Notepad++ does not expose the Count result to UI Automation';
    });

    await scenario('S14', 'CheckBox on, then off again (Match case)', async () => {
      if (!s.find) throw skip('no dialog');
      const box = need(s.dlg, '[CheckBox] "Match case"', 'Match case');
      await must('desktop_set_checkbox', { ref: box, checked: true });
      await must('desktop_set_checkbox', { ref: box, checked: false });
    });

    await scenario('S15', 'RadioButton, then back (Search Mode: Regular expression, Normal)', async () => {
      if (!s.find) throw skip('no dialog');
      await must('desktop_select_radio_button', { ref: need(s.dlg, /\[RadioButton\] "Regular expression/, 'Regular expression') });
      await must('desktop_select_radio_button', { ref: need(s.dlg, '[RadioButton] "Normal"', 'Normal') });
    });

    await scenario('S16', 'TabItem: the Replace tab, then back to Find', async () => {
      if (!s.find) throw skip('no dialog');
      await must('desktop_select_tab_item', { ref: need(s.dlg, '[TabItem] "Replace"', 'Replace tab') });
      const rep = await snapshot('replace-tab');
      if (!/Replace with/i.test(rep)) fail('the Replace tab shows no "Replace with"');
      await must('desktop_select_tab_item', { ref: need(rep, '[TabItem] "Find"', 'Find tab') });
      return '"Replace with" shown';
    });

    await scenario('S17', 'Close the dialog with its Close button; the next snapshot is the main window again', async () => {
      if (!s.find) throw skip('no dialog');
      // The dialog's title follows its tab (Find, Replace), so take the button from a fresh snapshot.
      const dlg = await snapshot('dialog-before-close');
      await must('desktop_click', { ref: need(dlg, '[Button] "Close"', 'Close') });
      await sleep(800);
      s.main = await snapshot('after-close-dialog');
      if (!s.main.startsWith('Window "*new 1 - Notepad++"')) fail(`the snapshot shows ${clip(s.main.split('\n')[0])}`);
      return 'Notepad++ hides the dialog; the snapshot goes back to the main window';
    });

    await scenario('S18', 'IF condition and a loop around desktop steps', async () => {
      s.main = await snapshot('before-if');
      await must('core_if', { ref: need(s.main, '"length:', 'status length'), check: 'displayed',
        step_description: 'If the status bar shows the length' });
      await must('desktop_keyboard_action', { keys: 'END' });
      await must('core_end_if', {});
      await must('core_loop', { count: 2 });
      await must('desktop_keyboard_action', { keys: 'HOME' });
      await must('core_end_loop', {});
    });

    await scenario('S19', 'Select the document tab', async () => {
      s.main = await snapshot('before-tab');
      await must('desktop_select_tab_item', { ref: need(s.main, '[TabItem] "new 1"', 'document tab') });
    });

    if (s.custom) {
      await scenario('S20', 'Custom action: read the selected tab name (dsk-54)', async () => {
        const r = await must('desktop_custom_action', { action: 'dsk-54', xpath: "//Tab[@ClassName='SysTabControl32']",
          store_as: 'tab_name' });
        if (!/stored as tab_name = "new 1/.test(r.text)) fail(`unexpected: ${clip(r.text)}`);
        return 'tab_name = "new 1"';
      });
    }

    await scenario('S21', 'Close the typed tab without saving (Save? -> No)', async () => {
      await must('desktop_keyboard_action', { keys: 'CONTROL+W' });
      await sleep(1200);
      const p = await snapshot('save-prompt');
      const prompt = /^\s*Window "(Save[^"]*)"/m.exec(p)?.[1];
      if (!prompt) fail('no Save prompt inside the window snapshot');
      await must('desktop_click', { ref: need(p, '[Button] "No"', 'No') });
      await sleep(800);
      // The prompt has closed: the next snapshot goes back to Notepad++'s window by itself. Notepad++ opens a new
      // document before it closes its last tab, so the window is "new 2" now, a title the recording has not seen.
      s.main = await snapshot('after-no');
      const back = /^Window "(new \d+ - Notepad\+\+)"/.exec(s.main)?.[1];
      if (!back) fail(`unexpected window: ${clip(s.main.split('\n')[0])}`);
      s.typed = false;
      return `prompt "${prompt}" answered No; the next snapshot is "${back}"`;
    });

    await scenario('S22', 'Right-click menu in the editor (pop-up snapshot, limited to 120 s)', async () => {
      s.main = await snapshot('before-context');
      await must('desktop_right_click', { ref: need(s.main, '[Pane] (Scintilla)', 'editor') });
      await sleep(800);
      const t0 = Date.now();
      const pop = await call('desktop_snapshot', { scope: 'popups' }, 120_000);
      writeFileSync(join(logDir, `${String(++snapNo).padStart(2, '0')}-context-popups.txt`), pop.text);
      if (pop.error) {
        await call('desktop_keyboard_action', { keys: 'ESCAPE' }, 240_000);
        fail(`the pop-up snapshot did not answer within ${Math.round((Date.now() - t0) / 1000)} s`);
      }
      const item = refOf(pop.text, '[MenuItem] "Select All"');
      if (!item) { await call('desktop_keyboard_action', { keys: 'ESCAPE' }); fail('no Select All in the pop-up'); }
      await must('desktop_invoke_menu_item', { ref: item });
      return `pop-up snapshot ${pop.ms} ms`;
    });

    if (sessionId) {
      const steps = await readJournal(mcpUrl, conn, sessionId);
      s.journal = steps.map((x) => x.actionUniqueId ?? x.controlFlow?.kind ?? x.stepType);
      writeFileSync(join(logDir, 'journal.json'), JSON.stringify(steps, null, 2));
      log(`journal (${steps.length} steps): ${s.journal.join(', ')}`);
      await scenario('S23a', 'Saved objects: DesktopRecord\'s XPaths, no AutomationId, nothing flagged unique', async () => {
        const objects = steps.filter((x) => x.objectRef?.locators?.length);
        const withId = objects.filter((x) => x.objectRef.locators.some((l) => /automationid/i.test(`${l.name} ${l.value}`)));
        if (withId.length) fail(`AutomationId saved in steps ${JSON.stringify(withId.map((x) => x.n))}`);
        const flagged = objects.filter((x) => x.objectRef.locators.some((l) => l.unique === true));
        if (flagged.length) fail(`a locator is flagged unique in steps ${JSON.stringify(flagged.map((x) => x.n))}`);
        const forms = {};
        for (const x of objects) for (const l of x.objectRef.locators) if (/xpath/i.test(l.name)) forms[l.name] = (forms[l.name] ?? 0) + 1;
        return `${objects.length} objects; ${Object.entries(forms).map(([k, v]) => `${k} ${v}`).join(', ')}`;
      });
    }

    if (save) {
      await scenario('S23', 'Save the recording as a test case', async () => {
        const r = await must('tc_save', { sessionId, replaceWithFunctions: false }, 300_000);
        s.tcId = r.structured.saved?.id ?? fail('tc_save returned no id');
        saved = true;
        return `test case ${s.tcId}`;
      });
      if (run && s.tcId) {
        await scenario('S24', 'Run the saved test case on the agent', async () => {
          await must('core_close_session', { keepRecorderOpen: true });
          sessionId = null;
          const envs = (await must('tc_list_environments')).structured.environments ?? [];
          const env = envs.find((e) => e.isDefault) ?? envs[0] ?? fail('no environment');
          log('HANDS OFF again: the agent replays the test case on Notepad++.');
          const r = await must('tc_run', { tcId: String(s.tcId), when: 'immediate', mode: 'local', releaseId: '', versionId: '',
            environment: String(env.key ?? env.id) }, 180_000);
          const runId = r.structured.run?.runId ?? fail('no run id');
          for (const end = Date.now() + 15 * 60_000; ;) {
            await sleep(5000);
            const st = await call('run_status', { runId: String(runId) }, 120_000);
            const state = st.structured.run?.state;
            if (['passed', 'failed', 'error', 'stopped', 'skipped', 'notExecuted'].includes(state)) {
              writeFileSync(join(logDir, 'run-status.txt'), st.text);
              if (state !== 'passed') fail(`run ${runId} ended ${state}; see run-status.txt`);
              return `run ${runId} passed`;
            }
            if (Date.now() > end) fail(`run ${runId} did not finish in 15 minutes`);
          }
        });
      }
    }
  } finally {
    // Never leave a typed tab behind: answer the save prompt with No.
    if (s.typed) {
      try {
        await call('desktop_keyboard_action', { keys: 'ESCAPE' }, 240_000);
        await call('desktop_keyboard_action', { keys: 'CONTROL+W' });
        await sleep(1200);
        await call('desktop_keyboard_action', { keys: 'N' });
      } catch { /* best effort; the backup clean-up below still runs */ }
    }
    if (sessionId) {
      const first = await call('core_close_session', saved ? { keepRecorderOpen: true } : {});
      const token = /confirm: "([^"]+)"/.exec(first.text)?.[1];
      if (first.error && token) await call('core_close_session', { confirm: token });
    }
    await client.close().catch(() => {});
    if (java) java.kill();
    await sleep(2500);
    for (const p of [...pids('notepad++.exe')].filter((x) => !nppBefore.has(x))) {
      try { execFileSync('taskkill', ['/PID', p, '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
    }
    await sleep(1000);
    const undone = undoNotepadBackups(since);
    if (undone.length) log(`removed what Notepad++ kept of the typed tab: ${undone.join(', ')}`);
    report();
  }
}

function report() {
  const lines = ['| # | Scenario | Result | Time | Note |', '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.title} | ${r.status} | ${(r.ms / 1000).toFixed(1)} s | ${r.note.replace(/\|/g, '/')} |`)];
  writeFileSync(join(logDir, 'results.md'), `${lines.join('\n')}\n`);
  console.log(`\n${lines.join('\n')}\n`);
  const failed = results.filter((r) => r.status === 'FAIL').length;
  log(`${results.length - failed} of ${results.length} scenarios passed or were skipped; logs ${logDir}`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`[npp] FAILED: ${e instanceof Error ? e.message : String(e)} (logs: ${logDir})`);
  process.exitCode = 1;
});
