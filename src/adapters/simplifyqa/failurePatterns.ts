/**
 * Pattern grouping for failure analysis v2: mask the variable parts of each failure cause, group
 * identical templates, then merge near-identical ones. Pure functions, no I/O, no model call.
 *
 * Coarser than stepRules.causeSignature on purpose: two iterations that share that signature
 * share this one — except element-level failures on DIFFERENT objects, which are split on purpose.
 * Conversely two iterations with the same object + action + family always share a group, whatever
 * their error wording. An element-level step failure (locator / timeout / interaction on a named object)
 * is keyed by its failed object + action instead of its error text: almost every Selenium failure
 * reads "No such element found.", so the text alone put waits on different screens together.
 */

import { FAMILIES, classify, type FailureFamily } from './failureCategory.js';
import type { FailureIteration } from './failureTypes.js';
import { maskWith, truncate } from './failureReport.js';

export const MERGE_THRESHOLD = 0.8;

const TEMPLATE_CAP = 200;
const MAX_SAMPLES = 2;

const DATETIME = /\b\d{4}-\d{1,2}-\d{1,2}[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const DATE = /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const TIME = /\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\b/g;
const GUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const URL_RX = /\bhttps?:\/\/[^\s'"“”]+/gi;
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
const QUOTED = /'[^']*'|"[^"]*"|“[^”]*”/g;
const HEX = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi;
const PREFIXED_ID = /\b[A-Z]{2,}[-_ ]\d{4,}\b/g;
const ALNUM_TOKEN = /\b[A-Za-z0-9]{2,}\b/g;
const DIGITS = /\d+/g;

/** Replace the variable parts of a failure cause with placeholders so the same failure on
 *  different data reads identically.
 *
 *  Coarseness guarantee: two causes that share stepRules.causeSignature because they differ only
 *  in VALUES (digits, quoted text, ids, dates) share this template. It is not guaranteed for texts
 *  that differ only beyond the 200-char cap here versus the 160-char cap there. */
export function maskCause(text: string): string {
  return maskValues(text).toLowerCase().split(/\s+/).filter(Boolean).join(' ').slice(0, TEMPLATE_CAP);
}

/** maskCause's placeholders, case and spacing kept ("Row 12" → "Row <n>"). */
function maskValues(text: string): string {
  return String(text ?? '')
    .replace(DATETIME, '<datetime>')
    .replace(DATE, '<date>')
    .replace(TIME, '<time>')
    .replace(GUID, '<guid>')
    .replace(URL_RX, '<url>')
    .replace(EMAIL, '<email>')
    .replace(QUOTED, '<v>')
    .replace(HEX, '<id>')
    .replace(PREFIXED_ID, '<id>')
    .replace(ALNUM_TOKEN, (t) => (/\d/.test(t) && /[A-Za-z]/.test(t) ? '<id>' : t))
    .replace(DIGITS, '<n>');
}

/** Families that describe a failure OF ONE ELEMENT (not there, not usable, not in time). Their error
 *  text barely varies ("No such element found."), so the failed object + action is the real key. */
const ELEMENT_FAMILIES: ReadonlySet<FailureFamily> = new Set<FailureFamily>(['locator', 'timeout', 'interaction']);

/** An object / action name as a grouping key: trimmed, lowercased, ids and numbers masked ("Row 12" = "Row 13"). */
const normaliseName = (name: string | undefined): string => maskCause(name ?? '');

export type PatternSig = {
  action: string;
  family: FailureFamily;
  template: string;
  runLevel: boolean;
  /** A step failure of an element-level family on a named object: keyed by object + action, not by error text. */
  elementLevel: boolean;
  /** Normalised object name (element-level only, else ''). */
  object: string;
};

export function patternSignature(it: FailureIteration): PatternSig {
  const runLevel = it.source !== 'step' || !it.focus;
  if (runLevel) {
    const raw = it.exception ?? it.focus?.exception ?? '';
    return { action: '', family: classify(raw || undefined), template: maskCause(raw), runLevel: true, elementLevel: false, object: '' };
  }
  const focus = it.focus!;
  const raw = focus.cause ?? focus.exception ?? focus.errorLines[0] ?? '';
  const family = classify(raw || undefined);
  const actionWord = (focus.description.split(/\s+/)[0] ?? '').toLowerCase();
  const object = normaliseName(focus.objectName);
  if (object && ELEMENT_FAMILIES.has(family)) {
    return {
      action: normaliseName(focus.actionName) || actionWord, family, template: maskCause(raw), runLevel: false, elementLevel: true, object,
    };
  }
  return { action: actionWord, family, template: maskCause(raw), runLevel: false, elementLevel: false, object: '' };
}

/** A log line's leading time stamp / level, as cleanLogLines writes it ("13:57:07 INFO "). */
const LINE_PREFIX = /^\s*(?:\d{4}-\d{2}-\d{2}[ T])?(?:\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\s*)?(?:-\s*)?/;
const LEVEL = /^\[?(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|SEVERE)\b\]?\s*:?\s*/i;
/** A real failure line: ERROR-level (bare or bracketed, "[ERROR]"), or a "[FAIL]" / "[FAILED]" marker. */
const FAIL_LINE = /^\[?(?:ERROR|FATAL|SEVERE)\b|\[FAIL(?:ED|URE)?\]/i;
/** A template that is a progress / banner log line, not a reason: "<time> info …", "=====". */
const POOR_TEMPLATE = /^(?:<(?:time|datetime|date)>\s*)*(?:-\s*)?(?:trace|debug|info|warn(?:ing)?)\b|^[\s=\-*#_~.:|<>]*$/;

const VALUE_CHARS = 60;

/** The first ERROR / [FAIL] line of the step (error lines, then logs), stamp and level dropped. */
function failLine(f: NonNullable<FailureIteration['focus']>): string | undefined {
  for (const raw of [...f.errorLines, ...f.logs]) {
    const body = String(raw ?? '').replace(LINE_PREFIX, '');
    if (!FAIL_LINE.test(body)) continue;
    const text = body.replace(LEVEL, '').replace(/\[FAIL(?:ED|URE)?\]\s*:?\s*/i, '').trim();
    if (text) return text;
  }
  return undefined;
}

/** The object name to show for a group: the raw name when every member recorded the same one; the
 *  masked name ("Row <n>") when they differ only in values; else "<object>". */
function shownObject(it: FailureIteration, members: FailureIteration[]): string {
  const raw = (f: FailureIteration): string => (f.focus?.objectName ?? '').trim();
  const mine = raw(it);
  if (members.every((x) => raw(x) === mine)) return mine;
  const masked = maskValues(mine);
  return members.every((x) => maskValues(raw(x)) === masked) ? masked : '<object>';
}

/**
 * A group's cause as shown — generic rules over the step's structure only:
 * - element-level: `<action> "<object>" failed — <family label>`;
 * - assertion, or a cause that is only an INFO / banner log line: `<action> "<object>": expected "…"
 *   — actual "…"` when the step recorded them (protected data masked, cut to 60), else the first
 *   ERROR / [FAIL] line, else (for a banner) `<action> "<object>" failed — <family label>`;
 * - otherwise the masked error template.
 */
export function patternCause(it: FailureIteration, members: FailureIteration[] = [it]): string {
  const sig = patternSignature(it);
  const f = it.focus;
  if (sig.runLevel || !f) return sig.template;
  const action = (f.actionName ?? '').trim() || f.description.trim();
  const object = shownObject(it, members);
  const subject = object ? `${action} "${object}"` : action;
  if (sig.elementLevel) return `${subject} failed — ${FAMILIES[sig.family]}`;
  const poor = POOR_TEMPLATE.test(sig.template);
  if (sig.family !== 'assertion' && !poor) return sig.template;
  const mask = maskWith(it.protectedValues ?? []);
  const value = (v: string | undefined): string => truncate(mask(v ?? '') ?? '', VALUE_CHARS);
  if ((f.expected ?? '') !== '' || (f.actual ?? '') !== '') {
    return `${subject}: expected "${value(f.expected)}" — actual "${value(f.actual)}"`;
  }
  const line = failLine(f);
  if (line) return maskCause(mask(line) ?? line);
  return poor ? `${subject} failed — ${FAMILIES[sig.family]}` : sig.template;
}

export function tokenJaccard(a: string, b: string): number {
  const sa = new Set(a.split(/\s+/).filter(Boolean));
  const sb = new Set(b.split(/\s+/).filter(Boolean));
  if (!sa.size && !sb.size) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export type PatternCandidate = { key: string; it: FailureIteration; wasRepresentative: boolean };

type Sig = PatternSig;
type Bucket = { sig: Sig; members: Array<{ c: PatternCandidate; idx: number }> };

const signatureOf = (s: Sig): string => (s.elementLevel
  ? JSON.stringify(['step', s.family, s.object, s.action])
  : JSON.stringify([s.runLevel, s.action, s.family, s.template]));

function evidence(c: PatternCandidate): number {
  const f = c.it.focus;
  return (f && f.screenshots.length > 0 ? 2 : 0) + (f && f.logCount > 0 ? 1 : 0);
}

function endedMs(c: PatternCandidate): number {
  const t = c.it.endedAt ? Date.parse(c.it.endedAt) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/** Best first: former representative, then more evidence, then newest. Stable on ties. */
function ranked(items: Array<{ c: PatternCandidate; idx: number }>): Array<{ c: PatternCandidate; idx: number }> {
  return [...items].sort((a, b) =>
    Number(b.c.wasRepresentative) - Number(a.c.wasRepresentative)
    || evidence(b.c) - evidence(a.c)
    || endedMs(b.c) - endedMs(a.c)
    || a.idx - b.idx);
}

const testcaseOf = (c: PatternCandidate): string => c.it.testcaseCode ?? c.it.label;

export function groupByPattern(items: PatternCandidate[], threshold: number = MERGE_THRESHOLD):
  Array<{ signature: string; members: PatternCandidate[]; representative: PatternCandidate; samples: PatternCandidate[] }> {
  const exact = new Map<string, Bucket>();
  items.forEach((c, idx) => {
    const sig = patternSignature(c.it);
    const k = signatureOf(sig);
    const b = exact.get(k);
    if (b) b.members.push({ c, idx });
    else exact.set(k, { sig, members: [{ c, idx }] });
  });

  // Largest first (stable by first appearance), then fold each smaller bucket into the first
  // kept bucket whose action + family match and whose template is similar enough. Element-level
  // buckets are already keyed by object + action and never near-merge (two objects stay apart).
  const ordered = [...exact.values()].sort((a, b) => b.members.length - a.members.length || a.members[0]!.idx - b.members[0]!.idx);
  const kept: Bucket[] = [];
  for (const b of ordered) {
    const host = b.sig.elementLevel ? undefined : kept.find((h) =>
      !h.sig.elementLevel && h.sig.runLevel === b.sig.runLevel && h.sig.action === b.sig.action && h.sig.family === b.sig.family
      && tokenJaccard(h.sig.template, b.sig.template) >= threshold);
    if (host) host.members.push(...b.members);
    else kept.push(b);
  }

  return kept
    .map((b) => {
      b.members.sort((x, y) => x.idx - y.idx);
      const best = ranked(b.members);
      const rep = best[0]!;
      const rest = best.slice(1);
      const samples: Array<{ c: PatternCandidate; idx: number }> = [];
      const seenTc = new Set([testcaseOf(rep.c)]);
      for (const r of rest) {
        if (samples.length >= MAX_SAMPLES) break;
        if (!seenTc.has(testcaseOf(r.c))) { samples.push(r); seenTc.add(testcaseOf(r.c)); }
      }
      for (const r of rest) {
        if (samples.length >= MAX_SAMPLES) break;
        if (!samples.includes(r)) samples.push(r);
      }
      return {
        signature: signatureOf(b.sig),
        members: b.members.map((m) => m.c),
        representative: rep.c,
        samples: samples.map((s) => s.c),
        first: b.members[0]!.idx,
      };
    })
    .sort((a, b) => b.members.length - a.members.length || a.first - b.first)
    .map(({ first: _first, ...g }) => g);
}
