/**
 * Object parameterization applied AT SAVE (tc_save), so nobody runs a second tool.
 *
 * The recorder cannot mark an object parameter: a click on the PIM menu item is recorded with `PIM` fixed in the object's
 * locator. The model marks its intent by writing `${menu_name}` in the step description. A `${name}` token in the description
 * of a CLICK-like step that has an object is otherwise a plain parameter nothing can fill (a click has no value slot), which is
 * how `menu_name` ended up as an empty test-data cell. After the save, each such step becomes a real "Parameter of object":
 * the quoted text of the object's locator (`normalize-space()='PIM'`) is the value, and object_parameterize does the rest.
 */

import type { ProviderAdapter } from '../adapters/types.js';
import type { ObjectParameterizeInput, ObjectParameterizeResult } from '../adapters/simplifyqa/adapter.js';

type Capable = ProviderAdapter & Partial<{
  objectParameterize: (i: ObjectParameterizeInput) => Promise<ObjectParameterizeResult>;
  /** numeric action id → display name ("184" → "Click"): a saved step only carries the id */
  actionNamesById: (ids: string[]) => Promise<Record<string, string>>;
}>;

/** Actions that act on an element and take no value of their own. */
const CLICK_LIKE = /^(click|double click|right click|hover|mouse|tap)\b/i;
const TOKEN = /\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g;
/** The literal a locator is built around: normalize-space()='PIM', text()='PIM', contains(., 'PIM'), @title='PIM'. */
const LITERAL = [
  /normalize-space\(\s*(?:\.|text\(\))?\s*\)\s*=\s*'([^']+)'/,
  /text\(\)\s*=\s*'([^']+)'/,
  /contains\(\s*[^,]+,\s*'([^']+)'\s*\)/,
  /@(?:title|aria-label|alt|value)\s*=\s*'([^']+)'/,
];

export function literalOfLocators(locators: Array<{ name: string; value: string }>): string | undefined {
  for (const rx of LITERAL) {
    for (const l of locators) {
      if (/\{\{\d+\}\}/.test(l.value)) continue;           // already a parameter
      const m = rx.exec(l.value);
      if (m?.[1]) return m[1];
    }
  }
  return undefined;
}

/** Turn every `${name}` click step of a saved test case into an object parameter. Best effort: returns the lines to add to the
 *  save reply (what was done, what could not be), and never throws — the save itself already succeeded. */
export async function applyObjectParameters(adapter: ProviderAdapter, tcId: string): Promise<string> {
  const a = adapter as Capable;
  if (!a.objectParameterize || !a.getTestCase || !a.getDefaultIteration || !a.getObject) return '';
  const notes: string[] = [];
  try {
    const tc = await a.getTestCase(tcId);
    // a saved step carries the action ID ("184"), not its name — resolve the names of the steps that could qualify
    const withToken = (tc.steps ?? []).filter((s) => (s.sourceObjectId ?? s.objectRef?.id) && /\$\{\s*[A-Za-z_]/.test(s.description ?? ''));
    if (!withToken.length) return '';
    const ids = [...new Set(withToken.map((s) => String(s.actionType ?? '').trim()).filter((t) => /^\d+$/.test(t)))];
    let names: Record<string, string> = {};
    if (ids.length && a.actionNamesById) {
      try { names = await a.actionNamesById(ids); } catch { /* ids stay unresolved — those steps are left alone below */ }
    }
    const candidates: Array<{ n: number; name: string; objectId: string }> = [];
    for (const s of withToken) {
      const raw = String(s.actionType ?? '').trim();
      const action = names[raw] ?? raw;
      if (/^\d+$/.test(action)) { notes.push(`⚠️ Step ${s.n} mentions a \${…} parameter but its action (${raw}) could not be named, so it was left as it is.`); continue; }
      if (!CLICK_LIKE.test(action)) continue;
      const objectId = s.sourceObjectId ?? s.objectRef?.id;
      for (const m of (s.description ?? '').matchAll(TOKEN)) candidates.push({ n: s.n, name: m[1]!, objectId: String(objectId) });
    }
    if (!candidates.length) return notes.length ? `\n${notes.join('\n')}` : '';
    // only tokens that are still EMPTY plain parameters — a value already there means it is not this case
    const tpl = await a.getDefaultIteration({ tcId });
    const empty = new Set(tpl.parameters.filter((p) => !p.protected && p.seed === '').map((p) => p.name.trim().toLowerCase()));
    const done = new Set<string>();
    for (const c of candidates) {
      const key = c.name.toLowerCase();
      if (!empty.has(key) || done.has(key)) continue;
      const obj = await a.getObject(c.objectId);
      const literal = literalOfLocators(obj.locators ?? []);
      if (!literal) {
        notes.push(`⚠️ Step ${c.n} mentions \${${c.name}} but no locator of "${obj.name}" has quoted text to turn into it — run object_parameterize with the text.`);
        continue;
      }
      const r = await a.objectParameterize({ tcId, step: c.n, parameterName: c.name, value: literal, replace: literal, confirm: true });
      done.add(key);
      notes.push(`Object parameter ${c.name} = ${literal} set on step${r.steps.length > 1 ? 's' : ''} ${r.steps.join(', ')} (object "${r.objectName}", test data: ${r.testdata}).`);
    }
  } catch (e) {
    notes.push(`⚠️ Could not apply the object parameters: ${e instanceof Error ? e.message : String(e)}.`);
  }
  return notes.length ? `\n${notes.join('\n')}` : '';
}
