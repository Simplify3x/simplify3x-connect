import type { ProviderAdapter } from '../adapters/types.js';
import type { JournalView } from '../domain/types.js';

const SENSITIVE = /password|passwd|pwd|secret|token|api_?key|auth|credential|confirm|retype|re-?enter|repeat/i;

/** The values a recording typed, by parameter NAME (first non-empty value wins). Sensitive-looking names are left out:
 *  a protected cell is masked and must never be written back as plain text. */
export function recordedValuesOf(view: JournalView | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const add = (name: string, value: unknown, isProtected = false): void => {
    const v = typeof value === 'string' ? value : '';
    if (!name || !v.trim() || isProtected || /^\d+$/.test(name) || SENSITIVE.test(name)) return;
    if (!out.has(name.toLowerCase())) out.set(name.toLowerCase(), v);
  };
  for (const s of view?.steps ?? []) {
    for (const [name, value] of Object.entries(s.recordedParam ?? {})) add(name, value);
    // The recorder keeps an OBJECT parameter's value apart from recordedParam, in the step's `objectParameters`:
    // [{ name: "menu_name", recValue: "PIM", id: 33707, type: "Local", protected: false }].
    const objectParams = (s as { objectParameters?: unknown }).objectParameters;
    for (const p of Array.isArray(objectParams) ? objectParams : []) {
      const o = p as { name?: unknown; id?: unknown; recValue?: unknown; value?: unknown; defaultValue?: unknown; protected?: unknown };
      if (typeof o?.name !== 'string') continue;
      // recValue is what the recorder captured; an id-keyed recordedParam entry ({ "33707": "PIM" }) is the same value by id
      const byId = o.id != null ? (s.recordedParam as Record<string, unknown> | undefined)?.[String(o.id)] : undefined;
      add(o.name, o.recValue ?? byId ?? o.value ?? o.defaultValue, o.protected === true);
    }
  }
  return out;
}

/** After a save: an OBJECT parameter (one a step lists in objectParameterIds) whose test-data cell is still EMPTY. Nothing the
 *  MCP can read said what the value is, so it cannot be filled here — but it must never stay empty without anyone knowing: the
 *  reply names the parameter and the exact call that fixes it (the model knows the value the user asked for). */
export async function warnEmptyObjectParameters(adapter: ProviderAdapter, tcId: string): Promise<string> {
  if (!adapter.getTestCase || !adapter.getDefaultIteration) return '';
  try {
    const tc = await adapter.getTestCase(tcId);
    const stepsOf = new Map<number, number[]>();
    for (const s of tc.steps ?? []) for (const id of s.sourceObjectParameterIds ?? []) stepsOf.set(id, [...(stepsOf.get(id) ?? []), s.n]);
    if (!stepsOf.size) return '';
    const tpl = await adapter.getDefaultIteration({ tcId });
    const empty = tpl.parameters.filter((p) => stepsOf.has(p.paramId) && !p.protected && p.seed === '');
    if (!empty.length) return '';
    return '\n⚠️ Object parameter(s) with an EMPTY test-data value: ' +
      empty.map((p) => `${p.name} (step${stepsOf.get(p.paramId)!.length > 1 ? 's' : ''} ${stepsOf.get(p.paramId)!.join(', ')})`).join(', ') +
      `. The recording did not hand the value over. Set it now with tc_update_testdata({ tcId: "${tcId}", cells: [${empty.map((p) => `{ param: "${p.name}", value: "<the value the user gave>" }`).join(', ')}] }).`;
  } catch {
    return '';
  }
}

/** After the recorder window's Save: a parameter the recording gave a value (an OBJECT parameter such as `menu_name = PIM`
 *  included) can come back with an EMPTY test-data cell. Fill only cells that are empty — never overwrite a value. */
export async function backfillRecordedValues(
  adapter: ProviderAdapter, tcId: string, recorded: Map<string, string>,
): Promise<string> {
  if (!recorded.size || !adapter.getDefaultIteration || !adapter.patchTestdataCells) return '';
  try {
    const tpl = await adapter.getDefaultIteration({ tcId });
    const cells = tpl.parameters
      .filter((p) => !p.protected && p.seed === '' && recorded.has(p.name.trim().toLowerCase()))
      .map((p) => ({ paramName: p.name, value: recorded.get(p.name.trim().toLowerCase())! }));
    if (!cells.length) return '';
    const r = await adapter.patchTestdataCells({ tcId, cells, versionId: tpl.versionId, environmentType: tpl.environmentType });
    return r.patched > 0
      ? `\nFilled ${r.patched} empty test-data value(s) from the recording: ${cells.map((c) => `${c.paramName} = ${c.value}`).join(', ')}.`
      : '';
  } catch (e) {
    return `\n⚠️ Could not check that the recorded values reached the test data: ${e instanceof Error ? e.message : String(e)}.`;
  }
}
