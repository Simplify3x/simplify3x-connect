/**
 * Simple logger utility for Walnut Agent
 * Logs to console AND to a file for easy review.
 *
 * Log file location (in order of priority):
 *   1. WALNUT_LOG_FILE env var (absolute or relative path)
 *   2. Default: ./logs/walnut-agent.log (relative to process.cwd())
 *
 * The log file is created automatically. Logs are appended on each run.
 */

import fs from 'fs';
import path from 'path';
import { redact } from '../log.js';

export interface Logger {
  info: (message: string, ...args: any[]) => void;
  error: (message: string, ...args: any[]) => void;
  warn: (message: string, ...args: any[]) => void;
  debug: (message: string, ...args: any[]) => void;
}

// --- Credential redaction (module-level singleton) ---
let _credentialValues: Set<string> = new Set();

/**
 * Register credential values that should be redacted from all log output.
 * Call this after extracting credentials from tool calls.
 */
export function setCredentialValues(values: Set<string>): void {
  _credentialValues = values;
}

/**
 * Add ONE credential to the redaction set. resolveConfig calls this with the resolved token, so the
 * exact secret is scrubbed from any line — even one a caller passes unredacted.
 */
export function addCredential(value: string | undefined | null): void {
  const v = value?.trim();
  if (v && v.length >= 6) _credentialValues.add(v);
}

/** Replace credential values and credential-shaped substrings in a log line. */
function redactCredentials(line: string): string {
  // Pattern redaction first (Bearer tokens, JWTs, api keys, token=...), then the exact registered
  // values, which catches a bare secret that matches no pattern.
  let result = redact(line);
  for (const cred of _credentialValues) {
    if (cred && cred.length > 0) {
      const escaped = cred.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escaped, 'g'), '***REDACTED***');
    }
  }
  return result;
}

// --- File logging setup (singleton) ---
let logFilePath: string | null = null;
let logFileReady = false;

function ensureLogFile(): string | null {
  if (logFileReady) return logFilePath;
  logFileReady = true;

  try {
    const envPath = process.env['WALNUT_LOG_FILE'];
    logFilePath = envPath || path.join(process.cwd(), 'logs', 'walnut-agent.log');

    // Ensure directory exists
    const dir = path.dirname(logFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write a session separator on startup
    const separator = `\n${'='.repeat(80)}\n  Walnut Agent Log — Session started at ${new Date().toISOString()}\n${'='.repeat(80)}\n\n`;
    fs.appendFileSync(logFilePath, separator, 'utf8');

    return logFilePath;
  } catch {
    // If file logging fails (e.g., permissions), fall back to console-only
    logFilePath = null;
    return null;
  }
}

function writeToFile(line: string): void {
  const filePath = ensureLogFile();
  if (!filePath) return;
  try {
    fs.appendFileSync(filePath, line + '\n', 'utf8');
  } catch {
    // Silently ignore file write errors — console logging still works
  }
}

export function createLogger(namespace: string): Logger {
  const timestamp = () => new Date().toISOString();

  // Format arguments for better logging
  const formatArgs = (...args: any[]) => {
    return args.map(arg => {
      if (arg instanceof Error) {
        return `${arg.message}\n${arg.stack}`;
      }
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg, null, 2);
        } catch (e) {
          return String(arg);
        }
      }
      return arg;
    });
  };

  const formatLine = (level: string, message: string, ...args: any[]) => {
    const parts = [message, ...formatArgs(...args)];
    return `[${timestamp()}] [${namespace}] ${level}: ${parts.join(' ')}`;
  };

  return {
    info: (message: string, ...args: any[]) => {
      const line = redactCredentials(formatLine('INFO', message, ...args));
      console.log(line);
      writeToFile(line);
    },
    error: (message: string, ...args: any[]) => {
      const line = redactCredentials(formatLine('ERROR', message, ...args));
      console.error(line);
      writeToFile(line);
    },
    warn: (message: string, ...args: any[]) => {
      const line = redactCredentials(formatLine('WARN', message, ...args));
      console.warn(line);
      writeToFile(line);
    },
    debug: (message: string, ...args: any[]) => {
      if (process.env['DEBUG']) {
        const line = redactCredentials(formatLine('DEBUG', message, ...args));
        console.debug(line);
        writeToFile(line);
      }
    },
  };
}

/** Returns the path to the current log file (or null if file logging is disabled) */
export function getLogFilePath(): string | null {
  return ensureLogFile();
}

/**
 * Current byte size of the log file (0 if file logging is off). Snapshot this at
 * execution start, then pass it to readLogSince() at completion to capture exactly
 * the verbose lines written during that execution — used to ship cloud-runner
 * per-execution debug logs to S3 (local desktop already keeps the same file on disk).
 */
export function currentLogOffset(): number {
  const filePath = ensureLogFile();
  if (!filePath) return 0;
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Read the log file from `sinceOffset` to end, capped to the last `maxBytes` (keeps
 * the tail — the most recent, most relevant lines — if the slice is huge). Returns
 * '' when file logging is off or on any read error (best-effort — never throws).
 */
export function readLogSince(sinceOffset: number, maxBytes = 2 * 1024 * 1024): string {
  const filePath = ensureLogFile();
  if (!filePath) return '';
  try {
    const size = fs.statSync(filePath).size;
    let start = Math.max(0, Math.min(sinceOffset, size));
    let length = size - start;
    if (length <= 0) return '';
    if (length > maxBytes) {
      start = size - maxBytes; // keep the tail
      length = maxBytes;
    }
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}
