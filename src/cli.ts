#!/usr/bin/env node
/**
 * `simplify3x-connect` CLI — the published bin. Two jobs, Playwright-style:
 *   • (default / `serve`)      run the Common QA MCP over stdio (what an AI client launches via npx)
 *   • `init-agents --loop=<c>`  install the Common QA agent into your project for a given AI client
 *
 * stdout is the MCP transport in serve mode, so this file writes ONLY to stderr.
 */
import { startStdioServer } from './serve.js';
import { runInitAgents } from './initAgents.js';

function printUsage(): void {
  process.stderr.write(
    'simplify3x-connect — Simplify3x Connect\n\n' +
      'Usage:\n' +
      '  simplify3x-connect [serve]             Start the MCP server over stdio (default; AI clients launch this)\n' +
      '  simplify3x-connect init-agents --loop=<c>  Install the QA agent into this project\n' +
      '                                         <c> = claude | cursor | windsurf | vscode | codex | devin | all\n' +
      '     [--server-name <name>]              MCP server name to scope tool access to (default\n' +
      '                                         "simplify3x-connect"). Must match the server name in your editor config.\n',
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === 'init-agents') {
    await runInitAgents(argv.slice(1));
    return;
  }
  if (cmd === undefined || cmd === 'serve') {
    await startStdioServer();
    return;
  }
  printUsage();
  process.exitCode = cmd === 'help' || cmd === '--help' || cmd === '-h' ? 0 : 1;
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
