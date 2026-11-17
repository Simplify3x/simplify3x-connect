/**
 * Filter-word → stored-value matching for `sqa_query`, ported from the AI assistant so both read a
 * question the same way (AI/ai-assistant `src/tools/_lib/lifecycle.py` `_match_one`, and
 * `query.py` `_spellings` for enums). Pure functions, no I/O.
 *
 * The one rule that keeps existing callers safe: a value that is already stored exactly as given is
 * never touched. Translation only happens to values that would otherwise match nothing.
 */

/** One configured option of a default field (`/pm/fields` `values[]`). */
export type LifecycleOption = { key: string; label: string; category: string };

export const NEW = 'new';
export const PENDING = 'pending';
export const COMPLETED = 'completed';

/** Category words for `state` only — they select options by their `mappedTo`, never by name. */
export const SEMANTIC_STATES: Record<string, string[]> = {
  open: [NEW, PENDING],
  unresolved: [NEW, PENDING],
  outstanding: [NEW, PENDING],
  'not done': [NEW, PENDING],
  incomplete: [NEW, PENDING],
  pending: [PENDING],
  active: [PENDING],
  'in flight': [PENDING],
  wip: [PENDING],
  'work in progress': [PENDING],
  ongoing: [PENDING],
  closed: [COMPLETED],
  done: [COMPLETED],
  finished: [COMPLETED],
  complete: [COMPLETED],
};

/** How similar a word must be to an option, and by how much it must beat the runner-up. */
export const MIN_RATIO = 0.72;
export const MIN_MARGIN = 0.08;

/** `/pm/fields` values → options. Archived options and keyless rows are dropped; labels trimmed
 *  (real labels carry stray whitespace: "Released ", "QA In Progress "). */
export function toLifecycleOptions(values: unknown): LifecycleOption[] {
  if (!Array.isArray(values)) return [];
  const out: LifecycleOption[] = [];
  for (const raw of values) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const key = r['key'];
    if (typeof key !== 'string' || !key || r['archive'] === true) continue;
    const label = typeof r['value'] === 'string' ? r['value'].trim() : '';
    out.push({ key, label: label || key, category: typeof r['mappedTo'] === 'string' ? r['mappedTo'] : '' });
  }
  return out;
}

/** Lower-cased with `_`/`-` flattened, so IN_PROGRESS = In-Progress = "in progress". */
export function normal(text: string): string {
  return text.replace(/[_-]/g, ' ').toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

const squashed = (text: string): string => normal(text).replace(/ /g, '');

/** Ratcliff/Obershelp similarity — the same measure as Python's difflib.SequenceMatcher.ratio(). */
export function similarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const matches = (x: string, y: string): number => {
    if (!x.length || !y.length) return 0;
    let best = 0, bi = 0, bj = 0;
    for (let i = 0; i < x.length; i++) {
      for (let j = 0; j < y.length; j++) {
        let k = 0;
        while (i + k < x.length && j + k < y.length && x[i + k] === y[j + k]) k++;
        if (k > best) { best = k; bi = i; bj = j; }
      }
    }
    if (!best) return 0;
    return best + matches(x.slice(0, bi), y.slice(0, bj)) + matches(x.slice(bi + best), y.slice(bj + best));
  };
  return (2 * matches(a, b)) / (a.length + b.length);
}

/** One word → stored keys, most confident tier first: exact key/label, category word (state
 *  only), then a clear near-match. [] when nothing qualifies — the caller reports it. */
export function matchLifecycleWord(word: string, options: LifecycleOption[], field: string): string[] {
  const n = normal(word);
  const uniq = (keys: string[]) => [...new Set(keys)];

  const exact = options.filter((o) => normal(o.key) === n || normal(o.label) === n);
  if (exact.length) return uniq(exact.map((o) => o.key));
  const sq = squashed(word);
  const squash = options.filter((o) => squashed(o.key) === sq || squashed(o.label) === sq);
  if (squash.length) return uniq(squash.map((o) => o.key));

  if (field === 'state') {
    const cats = SEMANTIC_STATES[n];
    if (cats) {
      const grouped = options.filter((o) => cats.includes(o.category));
      if (grouped.length) return uniq(grouped.map((o) => o.key));
    }
  }

  // A longer word built on an option is a different value, not a typo: "highest" ≠ High.
  const anotherWord = (text: string) => {
    const opt = normal(text);
    return !!opt && n.startsWith(opt) && n.length - opt.length >= 3;
  };
  const scored = options
    .filter((o) => !anotherWord(o.key) && !anotherWord(o.label))
    .map((o) => ({ o, score: Math.max(similarity(n, normal(o.key)), similarity(n, normal(o.label))) }))
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top || top.score < MIN_RATIO) return [];
  if (scored.length > 1 && top.score - scored[1]!.score < MIN_MARGIN) return [];
  return [top.o.key];
}

// ------------------------------------------------------------------ people and named records
// Ported from ai-assistant `_lib/resolve.py` (owner_ids, _close_names, scope_id) and
// `query.py` (_coded_ids).

export const SELF_WORDS = new Set(['me', 'my', 'mine', 'myself', 'i', 'my own']);
/** How close a misspelt person name must be ("prahrsha" → "praharsha" is 0.94). */
export const CLOSE_NAME_CUTOFF = 0.85;

/** A person as typed, reduced to something matchable: "@sunil.g," → "sunil.g". */
export function personQuery(name: string): string {
  return name.trim().replace(/^@+/, '').trim().replace(/^[,.;:]+|[,.;:]+$/g, '').toLowerCase();
}

export type Person = { id: number; name?: string; username?: string; email?: string };

/**
 * Every user a name means: exact name/username/email → that user; else every user containing it
 * ("Priya" = any Priya — never a silently narrower filter); else the closest spelling (≥ 0.85,
 * 4+ letters, ties kept). [] = nobody. "me" is the caller's job (it needs the session user).
 */
export function matchPeople(query: string, people: Person[]): number[] {
  const byName = new Map<string, number>();
  for (const p of people) {
    for (const v of [p.name, p.username, p.email]) {
      if (typeof v === 'string' && v.trim()) byName.set(v.trim().toLowerCase(), p.id);
    }
  }
  const exact = byName.get(query);
  if (exact !== undefined) return [exact];
  const hits = new Set<number>();
  for (const [key, id] of byName) if (key.includes(query)) hits.add(id);
  if (hits.size) return [...hits].sort((a, b) => a - b);
  if (query.length < 4) return [];
  let best = 0;
  let ids = new Set<number>();
  for (const [key, id] of byName) {
    const score = Math.max(...[key, ...key.split(/\s+/)].map((part) => similarity(query, part)));
    if (score < CLOSE_NAME_CUTOFF) continue;
    if (score > best) { best = score; ids = new Set([id]); }
    else if (score === best) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

/** "US-12", "us 12", "US12", "us_12" → "US-12"; anything else → undefined. */
export function normaliseCode(text: string): string | undefined {
  const m = /^([A-Za-z]{2,4})[\s_-]?(\d+)$/.exec(text.trim());
  return m ? `${m[1]!.toUpperCase()}-${m[2]}` : undefined;
}

export type NamedRecord = { id: number; name?: string; code?: string };

/**
 * Records a word names: its code, else every record with that exact name (trimmed, any case — a
 * shared name means all of them, as four sprints are called "Sprint 1"), else one clear
 * near-match when `fuzzy` (sprints/releases). [] = none.
 */
export function matchNamed(word: string, records: NamedRecord[], fuzzy = false): number[] {
  const text = word.trim().toLowerCase();
  const code = normaliseCode(word)?.toLowerCase();
  const byCode = records.filter((r) => r.code && r.code.trim().toLowerCase() === (code ?? text));
  if (byCode.length) return [...new Set(byCode.map((r) => r.id))];
  const exact = records.filter((r) => r.name && r.name.trim().toLowerCase() === text);
  if (exact.length) return [...new Set(exact.map((r) => r.id))];
  if (!fuzzy) return [];
  const scored = records
    .filter((r) => r.name)
    .map((r) => ({ r, score: similarity(normal(text), normal(r.name!)) }))
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top || top.score < MIN_RATIO) return [];
  if (scored.length > 1 && top.score - scored[1]!.score < MIN_MARGIN) return [];
  return [top.r.id];
}

// ------------------------------------------------------------------------------- versions

/**
 * One row per entity for collections that store each version as its own document (stories,
 * epics). Prefer the app's canonical row (`parent: true`), then the newest — `parent:true` alone
 * is not enough (some stories have none). Rows without an id are kept. Order of first appearance.
 * Ported from ai-assistant `_lib/versions.py` latest_by_id.
 */
export const VERSION_RANK_FIELDS = ['parent', 'updateVersion', 'updatedAt'];

export function latestById<T extends Record<string, unknown>>(rows: T[]): T[] {
  const rank = (r: T): [number, number, string] => [
    r['parent'] === true ? 1 : 0,
    typeof r['updateVersion'] === 'number' ? r['updateVersion'] : 0,
    String(r['updatedAt'] ?? ''),
  ];
  const better = (a: T, b: T) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] !== y[0] ? x[0] > y[0] : x[1] !== y[1] ? x[1] > y[1] : x[2] > y[2];
  };
  const best = new Map<unknown, T>();
  const out: Array<T | unknown> = [];
  for (const r of rows) {
    const id = r['id'];
    if (id === undefined || id === null) { out.push(r); continue; }
    const cur = best.get(id);
    if (!cur) { best.set(id, r); out.push(id); }
    else if (better(r, cur)) best.set(id, r);
  }
  return out.map((x) => (typeof x === 'object' && x !== null ? (x as T) : best.get(x)!));
}

// ---------------------------------------------------------------------------------- dates
// SQA's search compares DAYS: a date filter carries `YYYY-MM-DD` plus the browser's timezone
// offset, and the backend builds the day's boundaries. Days are read in IST, as the AI assistant
// and the deployment do (ai-assistant `_lib/dates.py`).

/** `new Date().getTimezoneOffset()` in IST — what the SQA UI sends as `offset`. */
export const IST_OFFSET_MINUTES = -330;

export type DayRange = { from: string; to: string };

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** A day past the end of its month (2026-02-30) pulled back to the last real one. */
function clampDay(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1) return null;
  return `${y}-${pad(m)}-${pad(Math.min(d, lastDay(y, m)))}`;
}

function oneWindow(text: string, now: Date): DayRange | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (day) {
    const d = clampDay(Number(day[1]), Number(day[2]), Number(day[3]));
    return d ? { from: d, to: d } : null;
  }
  const month = /^(\d{4})-(\d{2})$/.exec(text);
  if (month) {
    const [y, m] = [Number(month[1]), Number(month[2])];
    if (m < 1 || m > 12) return null;
    return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay(y, m))}` };
  }
  // Relative windows, computed on the IST calendar.
  const today = new Date(now.getTime() - IST_OFFSET_MINUTES * 60_000);
  const t = ymd(today);
  const shift = (days: number) => ymd(new Date(today.getTime() - days * 86_400_000));
  const compact = text.replace(/[^a-z0-9]/g, '');
  if (compact === 'today') return { from: t, to: t };
  if (compact === 'yesterday') return { from: shift(1), to: shift(1) };
  if (compact === 'thisweek') return { from: shift((today.getUTCDay() + 6) % 7), to: t };
  if (compact === 'thismonth') return { from: `${t.slice(0, 7)}-01`, to: t };
  if (compact === 'thisyear') return { from: `${t.slice(0, 4)}-01-01`, to: t };
  // "last 7 days", "last_2_weeks", "past month" — rolling back from today. Only last/past: a window
  // ahead ("next 7 days") is not one this reads, so it is reported instead of silently flipped.
  const rel = /^(?:last|past)\s+(?:(\d+)\s+)?(day|week|month|year)s?$/.exec(text.replace(/_/g, ' ').replace(/\s+/g, ' ').trim());
  if (rel) {
    const unit = { day: 1, week: 7, month: 30, year: 365 }[rel[2] as 'day' | 'week' | 'month' | 'year'];
    return { from: shift((rel[1] ? Number(rel[1]) : 1) * unit), to: t };
  }
  return null;
}

/** A date word → the days it covers: YYYY-MM-DD, YYYY-MM, "A..B" / "A to B", today, yesterday,
 *  this week/month/year, last N days/weeks/months/years. null = not a date. */
export function dateWindow(word: string, now: Date = new Date()): DayRange | null {
  const text = word.trim().toLowerCase();
  const between = /^(.+?)\s*(?:\.\.|\bto\b)\s*(.+)$/.exec(text);
  if (between) {
    const [a, b] = [oneWindow(between[1]!.trim(), now), oneWindow(between[2]!.trim(), now)];
    return a && b ? { from: a.from, to: b.to } : null;
  }
  return oneWindow(text, now);
}

/** Every case spelling a stored enum value may have: Defect, DEFECT, defect, Defect Type. */
export function spellings(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const title = v.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    const cap = v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
    for (const form of [v, v.toUpperCase(), v.toLowerCase(), cap, title]) if (!out.includes(form)) out.push(form);
  }
  return out;
}

/** One word → enum values: a group word ("MOBILE"), else a member, any case. [] = not a value. */
export function matchEnumWord(word: string, values: string[], groups: Record<string, string[]> = {}): string[] {
  const w = word.trim().toUpperCase();
  const group = Object.entries(groups).find(([g]) => g.toUpperCase() === w);
  if (group) return group[1];
  const hit = values.find((v) => v.toUpperCase() === w);
  return hit ? [hit] : [];
}
