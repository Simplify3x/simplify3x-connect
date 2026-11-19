/**
 * Single source of truth for the version this server reports over MCP.
 *
 * It MUST equal `package.json`'s `version`. `npm version` only bumps the manifest, so a hard-coded
 * literal in server.ts / remoteMcp drifts silently — which already happened: npm was at 0.28.0 while
 * the code still announced 0.27.0. `src/version.test.ts` fails when the two disagree, so a release
 * that forgets this file is caught before publishing rather than after.
 */
export const VERSION = '0.31.3';
