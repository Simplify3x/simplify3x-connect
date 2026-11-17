/**
 * Tiny stderr logger, plus the redaction every log line passes through.
 *
 * Why stderr: in stdio mode stdout IS the MCP transport, so anything written there corrupts the
 * protocol stream. `console.error` is safe for both transports.
 *
 * Why redaction lives here: a single sink means a single guarantee. Callers should still use
 * `mask()` for a token in a message, but `log()` also scrubs patterns defensively, so an accidental
 * `log(headers)` or `log(error)` cannot leak a credential. The file logger in vendor/logger.ts
 * reuses the same patterns.
 */

/** Patterns that are secrets no matter where they appear. */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Authorization: Bearer <token>
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
  // JWTs (three base64url segments)
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '***JWT***'],
  // Provider-style API keys
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '***KEY***'],
  // key=value / key: value forms
  // (?!\*\*\*) so an already-scrubbed value is not redacted twice ("Bearer ***" stays readable).
  [/\b(token|api[_-]?key|apikey|authorization|password|passwd|secret)\s*[=:]\s*(?!\*\*\*|Bearer\b)("[^"]*"|'[^']*'|[^\s"',;}]+)/gi, '$1=***'],
];

/** Strips credentials from one string. Exported so the file logger can reuse exactly these rules. */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Reports only whether a secret is set. No part of the value is ever emitted. */
export const mask = (t?: string | undefined): string => (t ? '(redacted)' : '(unset)');

function scrub(arg: unknown): unknown {
  if (typeof arg === 'string') return redact(arg);
  if (arg instanceof Error) return redact(arg.stack ?? arg.message);
  if (arg && typeof arg === 'object') {
    try { return redact(JSON.stringify(arg)); } catch { return '[unserialisable]'; }
  }
  return arg;
}

export const log = (...a: unknown[]) => console.error('[qa-mcp]', ...a.map(scrub));
