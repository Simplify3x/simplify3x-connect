import { createHash, randomInt } from 'node:crypto';

export const ANALYSIS_TTL_MS = 2 * 60 * 60 * 1000;
export const MAX_ANALYSES_PER_OWNER = 20;

const ID_PREFIX = 'FA-';
const ID_LENGTH = 8;
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

export type StoredAnalysis = { id: string; owner: string; createdAt: number };

/** Owner scope: a hash of the token (never the raw token) plus the project id. */
export function ownerKey(token: string, projectId: string | undefined): string {
  return `${createHash('sha256').update(token).digest('hex').slice(0, 16)}:${projectId ?? ''}`;
}

type Entry<T> = { value: T; createdAt: number };

/**
 * In-memory, owner-scoped store for failure analyses.
 *
 * - Expiry is measured from `createdAt` (ms). An entry is live while `now - createdAt <= ANALYSIS_TTL_MS`.
 * - Expired entries are purged on every `put`, `get` and `replace`.
 * - `put` evicts the owner's oldest entry (by createdAt) once the owner already holds MAX_ANALYSES_PER_OWNER.
 * - `replace` only updates an existing live id owned by `a.owner`. It keeps the original createdAt, so the
 *   expiry does not move. It THROWS for an unknown, expired or other-owner id, so a caller cannot silently
 *   lose an update or overwrite another owner's analysis.
 */
export class FailureAnalysisStore<T extends StoredAnalysis = StoredAnalysis> {
  private readonly entries = new Map<string, { owner: string } & Entry<T>>();

  constructor(private readonly now: () => number = Date.now) {}

  newId(): string {
    let id: string;
    do {
      let suffix = '';
      for (let i = 0; i < ID_LENGTH; i++) suffix += BASE36[randomInt(BASE36.length)];
      id = ID_PREFIX + suffix;
    } while (this.entries.has(id));
    return id;
  }

  put(a: T): void {
    this.purge();
    const existing = this.entries.get(a.id);
    if (existing && existing.owner !== a.owner) {
      throw new Error('analysis id already in use');
    }
    if (!existing) {
      const owned = [...this.entries.entries()].filter(([, e]) => e.owner === a.owner);
      if (owned.length >= MAX_ANALYSES_PER_OWNER) {
        let oldestId: string | undefined;
        let oldestAt = Infinity;
        for (const [id, e] of owned) {
          if (e.createdAt < oldestAt) {
            oldestAt = e.createdAt;
            oldestId = id;
          }
        }
        if (oldestId !== undefined) this.entries.delete(oldestId);
      }
    }
    // Clamp so a caller-supplied future createdAt cannot extend the TTL.
    const createdAt = Math.min(a.createdAt, this.now());
    this.entries.set(a.id, { owner: a.owner, value: a, createdAt });
  }

  get(id: string, owner: string): T | undefined {
    this.purge();
    const e = this.entries.get(id);
    if (!e || e.owner !== owner) return undefined;
    return e.value;
  }

  replace(a: T): void {
    this.purge();
    const e = this.entries.get(a.id);
    if (!e || e.owner !== a.owner) {
      throw new Error(`failure analysis not found or expired: ${a.id}`);
    }
    e.value = a;
  }

  private purge(): void {
    const t = this.now();
    for (const [id, e] of this.entries) {
      if (t - e.createdAt > ANALYSIS_TTL_MS) this.entries.delete(id);
    }
  }
}
