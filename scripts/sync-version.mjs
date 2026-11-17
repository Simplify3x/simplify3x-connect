#!/usr/bin/env node
/**
 * Copies `version` from package.json into src/version.ts.
 *
 * WHY: the version used to be typed by hand in three files (package.json, remoteMcp/adapter.ts,
 * server.ts). A release bumped the manifest and forgot the others, which is how npm reached 0.28.0
 * while the code still announced 0.27.0. Now package.json is the ONLY place a human edits a number:
 *
 *   npm version patch|minor|major     <- rewrites package.json, then this script syncs src/version.ts
 *   npm run sync-version              <- manual sync, idempotent
 *
 * The build also runs it (see "prebuild"), so a direct `npm run build` cannot ship a stale version.
 * `src/version.test.ts` remains the backstop: it fails when the two disagree.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version ?? '').trim();
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`sync-version: refusing to write a bad version "${version}"`);
  process.exit(1);
}

const target = path.join(root, 'src', 'version.ts');
const current = readFileSync(target, 'utf8');
const next = current.replace(/(export const VERSION = ')[^']*(';)/, `$1${version}$2`);

if (next === current) {
  console.log(`sync-version: already ${version}`);
  process.exit(0);
}
writeFileSync(target, next, 'utf8');
console.log(`sync-version: src/version.ts -> ${version}`);
