/**
 * HTTP publisher for the /tc-edit live-edit wire (see plan/tc-edit-live-protocol.md).
 * Streams TC_EDIT_* events + opens the tc-viewer window on the Electron desktop app
 * running at http://localhost:4504. Mirrors the Java UiPublisher fail-soft pattern:
 * a POST failure logs and returns — never throws into the tool call, because live-view
 * is a nice-to-have on top of the draft-store mutation that already happened.
 */

import { log } from '../log.js';

const DEFAULT_ELECTRON_BASE = 'http://localhost:4504';

function baseUrl(): string {
  return process.env['SIMPLIFYQA_UI_URL']?.replace(/\/$/, '') ?? DEFAULT_ELECTRON_BASE;
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; status?: number }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3000);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok && res.status !== 409) {
      log(`[tc-edit] ${path} -> HTTP ${res.status}`);
    }
    return { ok: res.ok, status: res.status };
  } catch (e) {
    log(`[tc-edit] ${path} push failed (${(e as Error).message}). Is the desktop app running on ${baseUrl()}?`);
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Emit one wire event to the given session's window. Best-effort. */
export async function emitTcEdit(
  sessionId: string | undefined,
  event: string,
  payload: unknown,
): Promise<void> {
  if (!sessionId) return;   // no bound window (draft opened without tc_edit_open) — silently no-op
  await post('/tc-edit/emit', { sessionId, event, payload: payload ?? {} });
}

/** Open the tc-viewer window on the desktop app for a given TC + session. */
export async function openTcViewerWindow(args: {
  sessionId: string;
  tcId: string;
  hashRoute?: string;
  baseUrl?: string;
  accessToken?: string;
  userId?: string | number;
  projectId?: string | number;
}): Promise<boolean> {
  const { ok } = await post('/tc-viewer/open', args);
  return ok;
}

/**
 * Ask the still-open recorder window to RE-READ the test case it is editing.
 *
 * A save performed from chat (tc_save in append mode) writes the test case through the backend API,
 * so the window — still open — keeps the step list it had before that save (observed: 7 of 11 steps).
 * The window re-reads the test case on this event and matches what the save stored.
 * Best-effort: a closed window or a stopped desktop app is fine.
 */
export async function refreshRecorderWindow(sessionId: string | undefined): Promise<boolean> {
  if (!sessionId) return false;
  const r = await post('/mcp-recorder/refresh', { sessionId });
  return r.ok;
}
