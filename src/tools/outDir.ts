/**
 * Where an export tool may write. A caller-chosen `outDir` is honoured only when the server is reachable
 * from this machine alone (stdio, or an HTTP gateway bound to loopback) — there the caller is the local
 * user. A server reachable from other machines always writes under its own `<cwd>/qa-reports`, so a remote
 * client can never make it create folders or files elsewhere on the host.
 */
import { join, resolve } from 'node:path';

export const DEFAULT_OUT_DIR = 'qa-reports';

export type OutDir = { dir: string; note?: string };

const IGNORED_NOTE = 'outDir was ignored: this server is reachable from other machines, so it only saves under its own qa-reports folder.';

export function resolveOutDir(outDir: string | undefined, allowCustom: boolean, cwd: string = process.cwd()): OutDir {
  const base = join(cwd, DEFAULT_OUT_DIR);
  const wanted = outDir?.trim();
  if (!wanted) return { dir: base };
  if (!allowCustom) return { dir: base, note: IGNORED_NOTE };
  if (wanted.includes('\0')) throw new Error('outDir is invalid (contains a NUL character).');
  if (/^[\\/]{2}/.test(wanted)) throw new Error('outDir must be a folder on this machine, not a network (UNC) path.');
  return { dir: resolve(cwd, wanted) };
}

/** True for addresses only this machine can reach: localhost, 127.0.0.0/8, ::1. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}
