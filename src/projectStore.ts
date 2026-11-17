/**
 * Persist the LAST-SELECTED projectId across restarts.
 *
 * WHY. The connection boots from the startup config (env / ~/.common-qa-mcp/config.json), which
 * carries a URL + token but usually NO project — so a client relaunch drops the connection back to
 * project-less. That is not just cosmetic: downstream, AI recording resolves its LLM model pool PER
 * PROJECT, so a project-less connection makes `web({task})` fail with "no LLM model configured for
 * this project". Remembering the last project makes a relaunch transparent — no re-`qa_switch_project`.
 *
 * WHAT IT STORES. ONLY the projectId, keyed by backend URL. Never the token — the connection module
 * keeps its deliberate "no credential on disk" contract (connection.ts), and a project id is a
 * non-secret identifier. Keying by URL means a remembered project never leaks across origins, and
 * switching backends is remembered independently.
 *
 * Best-effort throughout: every read/write failure is swallowed, so a missing or unwritable home
 * directory can never break a connection or a project switch.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from './vendor/logger.js';

const logger = createLogger('QaProjectStore');

const storePath = (): string => path.join(os.homedir(), '.common-qa-mcp', 'last-project.json');

/** Stable key: drop a trailing slash and lowercase, so the same backend maps to one entry. */
const keyFor = (url: string): string => url.replace(/\/+$/, '').toLowerCase();

type Store = Record<string, string>;

function readStore(): Store {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Store;
  } catch {
    /* absent / malformed → empty */
  }
  return {};
}

/** The projectId last selected for `url`, or undefined when none was persisted. */
export function readLastProject(url: string): string | undefined {
  if (!url) return undefined;
  const val = readStore()[keyFor(url)];
  return typeof val === 'string' && val.trim() ? val : undefined;
}

/** Remember `projectId` as the last selection for `url`. Best-effort — never throws. */
export function writeLastProject(url: string, projectId: string): void {
  if (!url || !projectId) return;
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    const store = readStore();
    if (store[keyFor(url)] === projectId) return; // no-op write avoided
    store[keyFor(url)] = projectId;
    fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    logger.warn(`could not persist last project (${err instanceof Error ? err.message : String(err)})`);
  }
}
