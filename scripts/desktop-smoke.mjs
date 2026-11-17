#!/usr/bin/env node
/**
 * DESKTOP end-to-end smoke (plan.md P4, P5). It drives common-mcp exactly as an AI client does:
 *
 *   1. starts the Java recorder in HTTP mode on :4050 with DESKTOP enabled (skipped when QA_MCP_URL names a running
 *      recorder, for example the agent's http://127.0.0.1:4040/mcp);
 *   2. starts common-mcp (dist/cli.js, stdio) with the SimplifyQA connection from ../dummyProjectMcp/.mcp.json. The
 *      token is handed to the child process and never printed;
 *   3. records the TestForm flow by snapshot ref (login, then the text box's context menu) and checks the journal;
 *   4. by default closes the recording WITHOUT saving it. With --save (P5, needs the agent's recorder) it saves the
 *      test case through the recorder window and checks it is a DESKTOP test case with DESKTOP steps; --run also runs
 *      it on this machine's agent and waits for PASSED.
 *   5. --rerecord <tcId> (P6.3) records the same flow INTO that existing DESKTOP test case and saves it as its next
 *      version: the save must add exactly one version to that test case, not create another one. It writes to the
 *      backend; with --run the new version is run too.
 *   6. --controlflow (P9.4) also records a count loop (3 clicks), a stored value and two comparisons. It checks the
 *      journal keeps the loop's count and the comparisons' literal expected values under unique names; with --save,
 *      that the test case holds ITERATOR_START/ITERATOR_END with the count (never a WHILE) and comparisons with 3
 *      parameters; with --run, that the run repeats the click 3 times and reaches the last comparison.
 *
 * Exit code 0 when every step and check passes. Logs go to a temporary folder named at the end.
 *
 *   node scripts\desktop-smoke.mjs
 *   set QA_MCP_URL=http://127.0.0.1:4040/mcp & set QA_MCP_PROJECT_ID=1 & node scripts\desktop-smoke.mjs --save --run
 *
 * HANDS OFF: the flow uses the real mouse and keyboard.
 *
 * Optional environment: QA_MCP_URL, QA_MCP_PROJECT_ID, JAVA_HOME, SIMPLIFYQA_AGENT_HOME (default
 * D:\MyProjects\New-Agnet\simplifyqa-agent), SIMPLIFYQA_DESKTOP_PLUGIN_PATH, SIMPLIFYQA_DESKTOP_DRIVER_PATH,
 * SIMPLIFYQA_DESKTOP_TEST_EXE (default ../simplifyqa-mcp-server/target/desktop/TestForm.exe).
 */
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
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
const testExe = process.env.SIMPLIFYQA_DESKTOP_TEST_EXE ?? join(javaDir, 'target', 'desktop', 'TestForm.exe');
const FORM = 'MCP Desktop Test Form';
const JAVA_PORT = 4050;
/**
 * What the flow below journals, with or without the agent: the first step in the window records its dsk-13, and
 * entering the context menu records a pop-up wait (generic-20) before its dsk-23.
 */
const EXPECTED = ['dsk-1', 'dsk-13', 'dsk-3', 'dsk-32', 'dsk-2', 'dsk-6', 'dsk-9', 'generic-20', 'dsk-23', 'dsk-34',
  'dsk-13', 'dsk-6'];

const logDir = mkdtempSync(join(tmpdir(), 'desktop-smoke-'));
const log = (...a) => console.log('[smoke]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n = 300) => (s.length > n ? `${s.slice(0, n)}...` : s);

function fail(message) {
  throw new Error(message);
}

/** The SimplifyQA connection the dummy project uses. Only the base URL is ever printed. */
function connection() {
  const file = join(workspace, 'dummyProjectMcp', '.mcp.json');
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  const server = Object.values(cfg.mcpServers ?? {}).find((s) => s?.env?.QA_MCP_TOKEN);
  if (!server) fail(`no MCP server with QA_MCP_TOKEN in ${file}`);
  const { QA_BASE_URL: baseUrl, QA_MCP_TOKEN: token } = server.env;
  if (!baseUrl || !token) fail(`QA_BASE_URL and QA_MCP_TOKEN must both be set in ${file}`);
  return { baseUrl, token };
}

function portOpen(port) {
  return new Promise((done) => {
    const s = createConnection({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); done(true); });
    s.once('error', () => done(false));
  });
}

async function waitForPort(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await portOpen(port)) return true;
    await sleep(500);
  }
  return false;
}

/** Process ids of a running Windows executable. */
function pids(exe) {
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${exe}`], { encoding: 'utf8' });
    return new Set(out.split(/\r?\n/).map((l) => l.split('","')[1]).filter((p) => p && /^\d+$/.test(p)));
  } catch {
    return new Set();
  }
}

function killNew(exe, before) {
  const left = [...pids(exe)].filter((p) => !before.has(p));
  for (const p of left) {
    try { execFileSync('taskkill', ['/PID', p, '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
  }
  return left;
}

/** The Java recorder in HTTP mode with DESKTOP on; its journal goes to the log folder, not the Java repo. */
async function startJava() {
  if (await portOpen(JAVA_PORT)) fail(`port ${JAVA_PORT} is in use: stop that process, or set QA_MCP_URL to use it`);
  const jar = join(javaDir, 'target', 'simplifyqa-mcp-server.jar');
  if (!existsSync(jar)) fail(`${jar} is missing: package the Java server first (mvn -o -DskipTests package)`);
  const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'java.exe') : 'java';
  const stepData = join(logDir, 'stepData');
  mkdirSync(stepData, { recursive: true });
  const child = spawn(java, ['-jar', jar], {
    cwd: javaDir,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      SIMPLIFYQA_MCP_TRANSPORT: 'http',
      SIMPLIFYQA_EDIT_PORT: '4952',             // the agent may hold the default 4052
      // No recorder window from the standalone server: its step pushes are not shown (only the agent's are),
      // and each push to a closed port retries for seconds.
      SIMPLIFYQA_UI_ENABLED: 'false',
      SIMPLIFYQA_UI_URL: 'http://127.0.0.1:9',
      SIMPLIFYQA_STEPDATA_DIR: stepData,
      SIMPLIFYQA_DESKTOP_PLUGIN_PATH: process.env.SIMPLIFYQA_DESKTOP_PLUGIN_PATH
        ?? join(agentHome, 'plugins', 'execution', 'desktop-execution.jar'),
      SIMPLIFYQA_DESKTOP_DRIVER_PATH: process.env.SIMPLIFYQA_DESKTOP_DRIVER_PATH
        ?? join(agentHome, 'libs', 'desktop', 'Desktop_Service.exe'),
    },
  });
  child.stderr.pipe(createWriteStream(join(logDir, 'java.err')));
  if (!(await waitForPort(JAVA_PORT, 60_000))) {
    child.kill();
    fail(`the Java recorder did not start on :${JAVA_PORT}; see ${join(logDir, 'java.err')}`);
  }
  return child;
}

/** One tool call through common-mcp; it must succeed unless `refusal` is set. */
async function call(client, name, args = {}, { refusal = false } = {}) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const text = (r.content ?? []).map((c) => c.text ?? '').join('\n');
  log(`${name} ${JSON.stringify(args)} (${Date.now() - t0} ms) -> ${clip(text.replace(/\s+/g, ' '))}`);
  if (Boolean(r.isError) !== refusal) fail(`${name} ${refusal ? 'was expected to be refused' : 'failed'}: ${text}`);
  return { text, structured: r.structuredContent ?? {} };
}

/** The ref on the `nth` outline line that contains `marker` (the first by default). */
function ref(outline, marker, nth = 1) {
  let seen = 0;
  for (const line of outline.split('\n')) {
    if (!line.includes(marker)) continue;
    const m = /^\s*(e\d+) \[/.exec(line);
    if (m && ++seen === nth) return m[1];
  }
  return fail(`no ref line ${nth} with ${marker} in:\n${outline}`);
}

/** --controlflow (P9.4): what the extra steps must journal. The loop keeps its count for the save, and the
 *  comparisons keep their literal expected values under names unique in the recording. */
function checkControlFlowJournal(steps) {
  const start = steps.find((s) => s.sourceRaw?.stepType === 'ITERATOR_START');
  if (String(start?.sourceRaw?.loop?.loopIteration) !== '3') {
    fail(`the journal's loop has no saved shape with count 3: ${clip(JSON.stringify(start ?? null))}`);
  }
  if (!steps.some((s) => s.sourceRaw?.stepType === 'ITERATOR_END')) fail('the journal\'s loop end has no saved shape');
  const compares = steps.filter((s) => s.actionUniqueId === 'generic-29').map((s) => s.recordedParam ?? {});
  if (compares.length !== 2) fail(`expected 2 comparisons in the journal, found ${compares.length}`);
  const [c1, c2] = compares;
  if (c1['Expected Value'] !== 'Deleted 2') fail(`the first comparison lost its expected value: ${JSON.stringify(c1)}`);
  if (c2['Operator 2'] !== 'not_equals' || c2['Expected Value 2'] !== 'Deleted 1') {
    fail(`the second comparison's parameter names are not unique: ${JSON.stringify(c2)}`);
  }
  log(`journal control flow: loop x${start.sourceRaw.loop.loopIteration}; comparisons ${JSON.stringify(c1)} | ${JSON.stringify(c2)}`);
  const ifs = steps.filter((s) => s.sourceRaw?.stepType === 'IF');
  const kinds = ifs.map((s) => (s.desktopConditions ?? []).map((c) => c.type).join('+'));
  if (JSON.stringify(kinds) !== JSON.stringify(['VALUE', 'OBJECT'])) fail(`the journal's IFs carry conditions ${JSON.stringify(kinds)}`);
  log(`journal IFs: ${kinds.join(', ')} conditions`);
}

/** --controlflow: the saved steps hold a count loop (never a WHILE) and two comparisons with 3 parameters each,
 *  sharing only the stored value. */
function checkControlFlowSaved(rows) {
  const loops = rows.filter((r) => /ITERATOR|WHILE/.test(String(r.stepType)));
  const start = rows.find((r) => r.stepType === 'ITERATOR_START');
  if (String(start?.loop?.loopIteration) !== '3') fail(`saved loop steps: ${clip(JSON.stringify(loops), 600)}`);
  if (!rows.some((r) => r.stepType === 'ITERATOR_END')) fail('the saved loop has no ITERATOR_END');
  if (loops.some((r) => /WHILE/.test(String(r.stepType)))) fail(`a WHILE step was saved: ${clip(JSON.stringify(loops), 600)}`);
  const compares = rows.filter((r) => /^Check the status is/.test(String(r.description ?? '')));
  if (compares.length !== 2) fail(`expected 2 saved comparisons, found ${compares.length}`);
  for (const c of compares) {
    if ((c.parameterIds ?? []).length !== 3) fail(`a saved comparison has ${(c.parameterIds ?? []).length} parameters: ${clip(JSON.stringify(c))}`);
  }
  const shared = compares[0].parameterIds.filter((id) => compares[1].parameterIds.includes(id));
  if (shared.length !== 1) fail(`the two comparisons share ${shared.length} parameters (only the stored value should be shared)`);
  log(`saved control flow: ${loops.map((r) => `${r.stepType}${r.loop?.loopIteration ? ` x${r.loop.loopIteration}` : ''}`).join(', ')}; `
    + `comparisons with ${compares.map((c) => c.parameterIds.length).join(' and ')} parameters`);
  // The IFs keep their condition rows: a value comparison of two parameters (the literal also a parameter of the IF,
  // for its test-data value), and an element check with its action and object.
  const ifs = rows.filter((r) => r.stepType === 'IF');
  const conds = ifs.map((r) => (r.conditions?.children ?? []));
  if (ifs.length !== 2 || conds.some((c) => c.length !== 1)) fail(`saved IFs: ${clip(JSON.stringify(ifs.map((r) => r.conditions)), 600)}`);
  const [v, o] = [conds[0][0], conds[1][0]];
  if (v.stepType !== 'PARAMETER' || v.parameter1?.length !== 1 || v.parameter2?.length !== 1
    || !(ifs[0].parameterIds ?? []).includes(v.parameter2[0])) {
    fail(`the saved value condition: ${clip(JSON.stringify({ row: v, parameterIds: ifs[0].parameterIds }), 500)}`);
  }
  if (o.stepType !== 'NORMAL_STATEMENT' || typeof o.actionId !== 'number' || typeof o.objectId !== 'number') {
    fail(`the saved element condition: ${clip(JSON.stringify(o), 500)}`);
  }
  // Each IF also keeps its condition text, as the recorder window's editor writes it. A run reports that text, and the
  // backend refuses an empty one (run 70176).
  const texts = ifs.map((r) => String(r.conditions?.ifstring ?? ''));
  if (texts.some((t) => !/^IF \( \(.+\)\s+\)$/.test(t))) fail(`the saved IFs' condition texts: ${clip(JSON.stringify(texts), 400)}`);
  log(`saved IFs: a ${v.stepType} row (${v.operator}) and a ${o.stepType} row (action ${o.actionId}, object ${o.objectId}); `
    + `texts ${texts.map((t) => JSON.stringify(t)).join(' and ')}`);
}

/** The recorder's journal for a session, read straight from the Java recorder (read_journal is not advertised). */
async function readJournal(mcpUrl, conn, sessionId) {
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${conn.token}`,
      'x-qa-base-url': conn.baseUrl,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'read_journal', arguments: { id: sessionId } } }),
  });
  const body = await res.json();
  return body?.result?.structuredContent?.view ?? fail(`read_journal returned no view: ${clip(JSON.stringify(body))}`);
}

/** Every array in a result, depth first: the step rows of a `related` query, whatever key holds them. */
function arraysIn(node, out = []) {
  if (Array.isArray(node)) out.push(node);
  if (node && typeof node === 'object') for (const v of Object.values(node)) arraysIn(v, out);
  return out;
}

/** The first object in a result that has `key`, depth first. */
function withKey(node, key) {
  if (!node || typeof node !== 'object') return undefined;
  if (!Array.isArray(node) && key in node) return node;
  for (const v of Object.values(node)) {
    const found = withKey(v, key);
    if (found) return found;
  }
  return undefined;
}

/** Save the recording through the recorder window (as `tc_save({ sessionId })` does for the AI) and check it. */
async function saveAndCheck(client, sessionId, controlflow = false) {
  const saved = await call(client, 'tc_save', { sessionId, replaceWithFunctions: false });
  const tcId = saved.structured.saved?.id ?? fail('tc_save returned no test case id');
  const doc = (await call(client, 'sqa_query', { op: 'get', collection: 'testcases', id: tcId })).structured;
  const tcType = withKey(doc, 'tcType')?.tcType;
  if (String(tcType).toUpperCase() !== 'DESKTOP') fail(`test case ${tcId} was saved with tcType ${tcType}, not DESKTOP`);
  const related = (await call(client, 'sqa_query', { op: 'related', collection: 'testcases', id: tcId, relation: 'steps' })).structured;
  const rows = arraysIn(related).find((a) => a.some((r) => r && typeof r === 'object' && 'technologyType' in r)) ?? [];
  const techs = rows.map((r) => String(r.technologyType ?? '').toUpperCase());
  log(`saved test case ${tcId}: tcType ${tcType}; ${rows.length} steps, technologyType ${[...new Set(techs)].join('/')}`);
  if (rows.length < 5) fail(`test case ${tcId} has ${rows.length} steps, expected at least 5`);
  const actionTechs = controlflow ? rows.filter((r) => r.actionId != null).map((r) => String(r.technologyType ?? '').toUpperCase())
    : techs;
  if (actionTechs.some((t) => t !== 'DESKTOP')) fail(`test case ${tcId} has steps that are not DESKTOP: ${techs.join(', ')}`);
  if (controlflow) checkControlFlowSaved(rows);
  return tcId;
}

/** The test case's own row (the object that has its tcType), from sqa_query. */
async function testCaseRow(client, tcId) {
  const doc = (await call(client, 'sqa_query', { op: 'get', collection: 'testcases', id: tcId })).structured;
  return withKey(doc, 'tcType') ?? fail(`test case ${tcId} was not found`);
}

/** Save a re-recording (P6.3): it must become exactly one new version of the SAME test case. */
async function saveVersionAndCheck(client, sessionId, target) {
  const saved = await call(client, 'tc_save', { sessionId, replaceWithFunctions: false });
  const id = String(saved.structured.saved?.id ?? fail('tc_save returned no test case id')).replace(/^TC[-_ ]?/i, '');
  if (id !== target.tcId) fail(`tc_save wrote test case ${id}, not a new version of ${target.tcId}`);
  const row = await testCaseRow(client, target.tcId);
  if (String(row.tcType).toUpperCase() !== 'DESKTOP') fail(`test case ${target.tcId} has tcType ${row.tcType}, not DESKTOP`);
  const versions = Array.isArray(row.versions) ? row.versions : [];
  const added = versions.filter((v) => !target.versions.some((b) => b.id === v.id));
  log(`TC-${target.tcId} versions: ${target.versions.map((v) => v.name).join(', ')} -> ` +
    `${versions.map((v) => v.name).join(', ')}`);
  if (added.length !== 1) fail(`expected exactly one new version of TC-${target.tcId}, found ${added.length}`);
  return added[0];
}

/** Run the saved test case (a given version, or the default one) on this machine's agent and wait for its end. */
async function runAndWait(client, tcId, versionId = '') {
  const envs = (await call(client, 'tc_list_environments')).structured.environments ?? [];
  const env = envs.find((e) => e.isDefault) ?? envs[0] ?? fail('the project has no environment to run in');
  const args = { tcId, when: 'immediate', mode: 'local', releaseId: '', versionId, environment: String(env.key ?? env.id) };
  let r = await client.callTool({ name: 'tc_run', arguments: args }, undefined, { timeout: 180_000 });
  let text = (r.content ?? []).map((c) => c.text ?? '').join('\n');
  if (r.isError && /reuseConfig/.test(text)) {
    r = await client.callTool({ name: 'tc_run', arguments: { ...args, reuseConfig: false } }, undefined, { timeout: 180_000 });
    text = (r.content ?? []).map((c) => c.text ?? '').join('\n');
  }
  log(`tc_run ${JSON.stringify(args)} -> ${clip(text.replace(/\s+/g, ' '))}`);
  if (r.isError) fail(`tc_run failed: ${text}`);
  const runId = r.structuredContent?.run?.runId ?? fail('tc_run returned no run id');
  const started = Date.now();
  const end = started + 15 * 60_000;
  for (;;) {
    await sleep(5000);
    const s = await client.callTool({ name: 'run_status', arguments: { runId: String(runId) } }, undefined, { timeout: 120_000 });
    const state = s.structuredContent?.run?.state;
    // A run the agent has not picked up yet also reads "notExecuted" (an agent just restarted took about a minute on
    // 2026-11-11, run 70157, which then passed), so that state counts as final only after 3 minutes.
    if (state === 'notExecuted' && Date.now() - started < 3 * 60_000) continue;
    if (['passed', 'failed', 'error', 'stopped', 'skipped', 'notExecuted'].includes(state)) {
      const statusText = (s.content ?? []).map((c) => c.text ?? '').join('\n');
      log(`run ${runId}: ${state}${statusText ? ` -> ${clip(statusText.replace(/\s+/g, ' '), 500)}` : ''}`);
      if (state !== 'passed') fail(`run ${runId} ended ${state}`);
      return s.structuredContent?.run;
    }
    if (Date.now() > end) fail(`run ${runId} did not finish within 15 minutes (last state ${state})`);
  }
}

async function main() {
  const flags = process.argv.slice(2);
  const ri = flags.indexOf('--rerecord');
  const rerecord = ri >= 0 ? String(flags[ri + 1] ?? '').trim().replace(/^TC[-_ ]?/i, '') : null;
  if (ri >= 0 && !/^\d+$/.test(rerecord)) fail('--rerecord needs a test case id, for example --rerecord TC-86235');
  const unknown = flags.filter((f, i) => (ri < 0 || (i !== ri && i !== ri + 1)) && f !== '--save' && f !== '--run'
    && f !== '--controlflow');
  if (unknown.length) {
    fail(`unknown arguments: ${unknown.join(' ')} (use --save, --run to save and run, --rerecord <tcId>, --controlflow)`);
  }
  // P9.4: also record a count loop, a stored value and two comparisons, and check how they journal, save and run.
  const controlflow = flags.includes('--controlflow');
  const run = flags.includes('--run');
  const save = run || rerecord !== null || flags.includes('--save');
  if (process.platform !== 'win32') fail('DESKTOP needs Windows');
  if (!existsSync(testExe)) fail(`${testExe} is missing: build it with simplifyqa-mcp-server\\src\\test\\resources\\desktop\\build-testform.ps1`);
  if (!existsSync(join(repo, 'dist', 'cli.js'))) fail('dist/cli.js is missing: npm run build first');
  if (pids('TestForm.exe').size) fail('close every TestForm.exe first');
  const conn = connection();
  const hostsBefore = pids('Desktop_Service.exe');
  const formsBefore = pids('TestForm.exe');

  let java = null;
  let mcpUrl = process.env.QA_MCP_URL;
  if (!mcpUrl) {
    java = await startJava();
    mcpUrl = `http://127.0.0.1:${JAVA_PORT}/mcp`;
  }
  log(`recorder ${mcpUrl}${java ? ' (started here)' : ''}; backend ${conn.baseUrl}; logs ${logDir}`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repo, 'dist', 'cli.js')],
    cwd: repo,
    stderr: 'pipe',
    env: {
      ...process.env,
      QA_MCP_PROVIDER: 'simplifyqa',
      QA_BASE_URL: conn.baseUrl,
      QA_MCP_TOKEN: conn.token,
      QA_MCP_URL: mcpUrl,
    },
  });
  transport.stderr?.pipe(createWriteStream(join(logDir, 'common-mcp.err')));
  const client = new Client({ name: 'desktop-smoke', version: '1.0.0' });
  let closed = false;
  try {
    await client.connect(transport);
    const instructions = client.getInstructions() ?? '';
    if (!instructions.includes('DESKTOP (Windows desktop applications)')) fail('the initialize instructions have no DESKTOP section');

    // common-mcp mirrors the recorder's tools once it has polled them.
    const end = Date.now() + 120_000;
    for (;;) {
      const { tools } = await client.listTools();
      const names = new Set(tools.map((t) => t.name));
      if (['desktop_launch_application', 'desktop_snapshot', 'desktop_click'].every((n) => names.has(n))) break;
      if (Date.now() > end) fail('common-mcp never advertised the desktop tools');
      await sleep(1000);
    }

    await call(client, 'qa_connection_status');
    // --rerecord (P6.3): record into the existing test case, under its own name, and remember its versions.
    let target = null;
    if (rerecord) {
      const row = await testCaseRow(client, rerecord);
      if (String(row.tcType).toUpperCase() !== 'DESKTOP') fail(`TC-${rerecord} is a ${row.tcType} test case, not DESKTOP`);
      target = { tcId: rerecord, title: String(row.name ?? ''), versions: Array.isArray(row.versions) ? row.versions : [] };
      log(`re-recording "${target.title}" (TC-${rerecord}); versions ${target.versions.map((v) => v.name).join(', ')}`);
    }
    const testcaseName = target?.title || `MCP Desktop smoke ${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const activated = await call(client, 'core_activate_technology', {
      technology: 'DESKTOP', testcaseName, ...(target ? { testcaseId: target.tcId } : {}),
    });
    const sessionId = activated.structured.sessionId ?? fail('core_activate_technology returned no sessionId');

    log('HANDS OFF the mouse and keyboard: the recording starts in 5 s.');
    await sleep(5000);
    await call(client, 'desktop_launch_application', { app_path: testExe });
    const s1 = (await call(client, 'desktop_snapshot')).text;
    if (!s1.startsWith(`Window "${FORM}"`)) fail(`unexpected snapshot:\n${s1}`);
    await call(client, 'desktop_enter_text', { ref: ref(s1, '[Edit] "User"'), value: 'mcp' });
    await call(client, 'desktop_select_item_from_dropdown', { ref: ref(s1, '[ComboBox] "Role"'), item: 'User' });
    await call(client, 'desktop_click', { ref: ref(s1, '[Button] "Login"') });
    const s2 = (await call(client, 'desktop_snapshot')).text;
    await call(client, 'desktop_validate_text', { ref: ref(s2, '[Text] "Welcome mcp (User)"'), expected: 'Welcome mcp (User)' });
    await call(client, 'desktop_right_click', { ref: ref(s2, '[Edit] "User"') });
    const popups = (await call(client, 'desktop_snapshot', { scope: 'popups' })).text;
    await call(client, 'desktop_invoke_menu_item', { ref: ref(popups, '[MenuItem] "Select All"') });
    await call(client, 'desktop_validate_text', { ref: ref(s2, '[Text] "Welcome mcp (User)"'), expected: 'Welcome mcp (User)' });
    if (controlflow) {
      // The first comparison's expected value is the very text the stored value holds: kept as typed (P9.4).
      const s3 = (await call(client, 'desktop_snapshot')).text;
      await call(client, 'core_loop', { count: 3 });
      await call(client, 'desktop_click', { ref: ref(s3, '[Button] "Delete"', 2), step_description: 'Click the second Delete' });
      await call(client, 'core_end_loop');
      const s4 = (await call(client, 'desktop_snapshot')).text;
      await call(client, 'desktop_get_text_and_store', { ref: ref(s4, '[Text] "Deleted 2"'), store_as: 'status' });
      await call(client, 'generic_compare', { actual_value: '${status}', operator: 'equals', expected_value: 'Deleted 2',
        step_description: 'Check the status is "Deleted 2"' });
      await call(client, 'generic_compare', { actual_value: '${status}', operator: 'not_equals', expected_value: 'Deleted 1',
        step_description: 'Check the status is not "Deleted 1"' });
      // Two IFs (P9.4): a stored value against a literal, and an element check. The run reaches the last check only
      // when the first IF's condition held. The descriptions avoid object names, which the save rewrites.
      await call(client, 'core_if', { left: 'status', operator: 'eq', right: 'Deleted 2' });
      await call(client, 'desktop_click', { ref: ref(s4, '[Button] "Delete"', 1), step_description: 'Press the first one' });
      await call(client, 'core_end_if');
      const s5 = (await call(client, 'desktop_snapshot')).text;
      await call(client, 'core_if', { ref: ref(s5, '[Button] "Login"'), check: 'displayed' });
      await call(client, 'desktop_validate_text', { ref: ref(s5, '[Text] "Deleted 1"'), expected: 'Deleted 1',
        step_description: 'Confirm the status changed' });
      await call(client, 'core_end_if');
    }

    const view = await readJournal(mcpUrl, conn, sessionId);
    const ids = view.steps.map((s) => s.actionUniqueId);
    log(`journal: ${ids.join(', ')}`);
    const baseIds = controlflow ? ids.slice(0, EXPECTED.length) : ids;
    if (JSON.stringify(baseIds) !== JSON.stringify(EXPECTED)) fail(`journal ${ids.join(', ')} is not ${EXPECTED.join(', ')}`);
    const notDesktop = view.steps.slice(0, EXPECTED.length).filter((s) => s.stepType !== 'desktop');
    if (notDesktop.length) fail(`steps not typed desktop: ${JSON.stringify(notDesktop.map((s) => s.n))}`);
    if (controlflow) checkControlFlowJournal(view.steps.slice(EXPECTED.length));
    // P7: DesktopRecord's XPaths on every object, no AutomationId anywhere, nothing flagged unique.
    const objects = view.steps.filter((s) => s.objectRef?.locators?.length);
    const withId = objects.filter((s) => s.objectRef.locators.some((l) => /automationid/i.test(`${l.name} ${l.value}`)));
    if (withId.length) fail(`AutomationId saved in steps ${JSON.stringify(withId.map((s) => s.n))}`);
    const flagged = objects.filter((s) => s.objectRef.locators.some((l) => l.unique === true));
    if (flagged.length) fail(`a locator is flagged unique in steps ${JSON.stringify(flagged.map((s) => s.n))}`);
    log(`saved XPaths per object: ${objects.map((s) => s.objectRef.locators.filter((l) => /xpath/i.test(l.name))
      .map((l) => l.name).join('+')).join(' | ')}`);

    // The headless path reads the same journal into a draft (memory only; nothing is saved). It needs a project
    // selected in common-mcp; a key-scoped token without QA_MCP_PROJECT_ID has none, so then it is skipped.
    const draftCall = await client.callTool({ name: 'tc_draft_from_journal', arguments: { sessionId } }, undefined,
      { timeout: 120_000 });
    const draftText = (draftCall.content ?? []).map((c) => c.text ?? '').join('\n');
    if (draftCall.isError && /No project selected/.test(draftText)) {
      log('tc_draft_from_journal skipped: no project is selected in common-mcp (set QA_MCP_PROJECT_ID to include it)');
    } else if (draftCall.isError) {
      fail(`tc_draft_from_journal failed: ${draftText}`);
    } else {
      const draftSteps = draftCall.structuredContent?.tc?.steps ?? [];
      if (draftSteps.length !== view.steps.length) fail(`the draft has ${draftSteps.length} steps, expected ${view.steps.length}`);
      if (draftSteps.slice(0, EXPECTED.length).some((s) => s.stepType !== 'desktop')) fail('a draft step is not typed desktop');
      // tc_save({ draftId }) refuses a draft with any validation issue, so every desktop step must validate (P5).
      const issues = draftCall.structuredContent?.issues ?? [];
      if (issues.length) fail(`tc_draft_from_journal: ${issues.length} validation issue(s): ${clip(JSON.stringify(issues), 600)}`);
      log(`tc_draft_from_journal: ${draftSteps.length} desktop steps; validation clean`);
    }

    let tcId = null;
    let versionId = '';
    if (save && target) {
      const version = await saveVersionAndCheck(client, sessionId, target);
      tcId = target.tcId;
      versionId = String(version.id ?? '');
      log(`saved as ${version.name} of TC-${tcId}`);
      await call(client, 'core_close_session', { keepRecorderOpen: true });
    } else if (save) {
      tcId = await saveAndCheck(client, sessionId, controlflow);
      // Saved: release the application and the host, and leave the recorder window open (never refused).
      await call(client, 'core_close_session', { keepRecorderOpen: true });
    } else {
      // Close without saving: the guard refuses while steps are unsaved and hands back a one-shot token.
      const first = await client.callTool({ name: 'core_close_session', arguments: {} }, undefined, { timeout: 120_000 });
      const firstText = (first.content ?? []).map((c) => c.text ?? '').join('\n');
      if (first.isError) {
        const token = /confirm: "([^"]+)"/.exec(firstText)?.[1] ?? fail(`no confirm token in the refusal: ${firstText}`);
        log('core_close_session refused while steps are unsaved, as expected; discarding with its token');
        await call(client, 'core_close_session', { confirm: token });
      } else {
        log(`core_close_session -> ${clip(firstText.replace(/\s+/g, ' '))}`);
      }
    }
    closed = true;
    await sleep(1500);
    const hosts = [...pids('Desktop_Service.exe')].filter((p) => !hostsBefore.has(p));
    const forms = [...pids('TestForm.exe')].filter((p) => !formsBefore.has(p));
    if (hosts.length || forms.length) {
      fail(`left running after close: Desktop_Service.exe ${hosts.join(',') || '-'}, TestForm.exe ${forms.join(',') || '-'}`);
    }

    if (run) {
      log('HANDS OFF again: the agent now runs the saved test case with the real mouse and keyboard.');
      const finished = await runAndWait(client, tcId, versionId);
      if (controlflow) {
        // P9.4: the run gets past the loop (it used to end there as passed), repeats its click and reaches the end.
        const results = finished?.stepResults ?? [];
        // The run report names the step by its object ("Click the second Second Delete button" on 2026-11-11).
        const clicks = results.filter((r) => /^Click the second/.test(String(r.description ?? ''))).length;
        const last = results.find((r) => /Check the status is not "Deleted 1"/.test(String(r.description ?? '')));
        log(`run control flow: ${results.length} step results; the loop's click ran ${clicks} time(s); `
          + `the last comparison ${last ? String(last.status) : 'never ran'}`);
        if (clicks !== 3) fail(`the loop's click ran ${clicks} time(s), not 3`);
        if (!last) fail('the run stopped before the last comparison');
        // The IFs: the first one's click ran, so the second one's check found the changed status.
        const ifClick = results.filter((r) => /^Press the first one/.test(String(r.description ?? '')));
        const changed = results.find((r) => /^Confirm the status changed/.test(String(r.description ?? '')));
        log(`run IFs: the first IF's click ran ${ifClick.length} time(s); the second IF's check ${changed ? String(changed.status) : 'never ran'}`);
        for (const r of results.slice(-6)) log(`  ${String(r.status).padEnd(8)} ${String(r.description ?? '').slice(0, 70)}`);
        if (ifClick.length !== 1 || !changed || !/pass/i.test(String(changed.status))) fail('the IFs did not run as recorded');
      }
    }
  } finally {
    await client.close().catch(() => {});
    if (java) java.kill();
    if (!closed) {
      // Failed before the recording closed: remove what it started (never what the agent starts for a run).
      await sleep(1500);
      killNew('Desktop_Service.exe', hostsBefore);
      killNew('TestForm.exe', formsBefore);
    }
  }
}

main().then(
  () => {
    if (!process.exitCode) log(`PASSED (logs: ${logDir})`);
  },
  (e) => {
    console.error(`[smoke] FAILED: ${e instanceof Error ? e.message : String(e)} (logs: ${logDir})`);
    process.exitCode = 1;
  },
);
