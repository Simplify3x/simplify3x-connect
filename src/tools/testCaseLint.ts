import type { TestCase, Step } from '../domain/types.js';

/**
 * Pre-run checks for DATABASE and API test cases, run at save time from the definition alone (nothing is executed).
 * Every rule here is a way a DB/API run has actually failed or silently passed; each one skips whenever it cannot be
 * sure (a function call may hide a connect step, a parameter may already exist in the project with a value), so a
 * warning means "look at this", never a false alarm on a valid test case. Warnings never block a save.
 */

const TOKEN = /\$\{([^{}]+?)\}|\{\{([^{}]+?)\}\}/g;

const tokensIn = (v: unknown): string[] => {
  if (typeof v !== 'string') return [];
  const out: string[] = [];
  for (const m of v.matchAll(TOKEN)) {
    const name = (m[1] ?? m[2] ?? '').trim();
    if (name && !/^\d+$/.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
};

const stringsIn = (node: unknown, out: string[] = []): string[] => {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((v) => stringsIn(v, out));
  else if (node && typeof node === 'object') Object.values(node as Record<string, unknown>).forEach((v) => stringsIn(v, out));
  return out;
};

const TECH: Record<string, string> = {
  web: 'WEB', api: 'API', database: 'DATABASE', android: 'ANDROID', ios: 'IOS', mainframe: 'MAINFRAME',
  desktop: 'DESKTOP',
};

const isConnect =(s: Step): boolean => /connect/i.test(s.actionType ?? '') && !/disconnect|close/i.test(s.actionType ?? '');

export function lintAutomatedTestCase(tc: TestCase): string[] {
  const steps = Array.isArray(tc.steps) ? tc.steps : [];
  const warnings: string[] = [];
  const data = tc.data ?? {};
  // Names a step stores into (its Runtime slots) — available to every LATER step of this test case.
  const stored = new Set<string>();
  const hasFunction = steps.some((s) => s.stepType === 'function');
  let connected = false;
  let hiddenSetup = false;   // a function call before this point may contain the connect / store steps

  // Technology switching: a test case starts on the technology of its first technology step, and the agent changes the
  // active plugin only through a SWITCH_TO_<TECH> step (the SQA UI inserts one whenever the technology changes).
  let active: string | undefined = steps.map((x) => TECH[x.stepType]).find(Boolean);
  let switchUnknown = false;   // a function call may switch technology internally

  steps.forEach((s, i) => {
    const at = `step ${s.n ?? i + 1}`;
    if (s.stepType === 'function') switchUnknown = true;
    const kind = s.stepType === 'control_flow' ? String(s.controlFlow?.kind ?? '').toUpperCase() : '';
    if (kind.startsWith('SWITCH_TO_')) {
      const code = kind.slice('SWITCH_TO_'.length);
      active = code === 'DB' ? 'DATABASE' : code;
    } else if (TECH[s.stepType] && active && TECH[s.stepType] !== active && !switchUnknown) {
      const want = TECH[s.stepType]!;
      warnings.push(`${at}: this is a ${want} step but the active technology at this point is ${active}. Add a control_flow step with ` +
        `kind "SWITCH_TO_${want === 'DATABASE' ? 'DB' : want}" before it (the SQA UI adds a "Switch to" step whenever the technology changes); ` +
        `without it the ${want} plugin may not be active and the step can fail.`);
      active = want;   // one warning per switch is enough
    }
    if (s.stepType === 'function' || s.stepType === 'control_flow') hiddenSetup = true;
    // An earlier step of ANOTHER kind (an API call's response parameter, a web "store text") may have set the value.
    if (steps.slice(0, i).some((x) => x.stepType !== s.stepType)) hiddenSetup = true;

    if (s.stepType === 'database') {
      if (isConnect(s)) connected = true;
      else if (!connected && !hiddenSetup && !hasFunction) {
        warnings.push(`${at}: database action "${s.actionType}" has no "Connect" step before it — it will fail with no active connection. Add a connect step first.`);
        connected = true;   // one warning is enough
      }
      for (const [arg, value] of Object.entries(s.recordedParam ?? {})) {
        for (const name of tokensIn(value)) {
          if (name === arg || name in data || stored.has(name) || hiddenSetup) continue;
          warnings.push(`${at}: "${arg}" uses {{${name}}}, but ${name} is not set in this test case's data or stored by an earlier step. ` +
            'Make sure that parameter exists in the project with a value (or a previous step stores it) — otherwise it is empty at run time and the step matches nothing.');
        }
      }
      for (const n of s.runtimeParameters ?? []) stored.add(n);
    }

    if (s.stepType === 'api') {
      const api = (s.api ?? {}) as Record<string, unknown>;
      const http = ((api['requestData'] as Record<string, unknown> | undefined)?.['httpData'] ?? undefined) as Record<string, unknown> | undefined;
      const url = typeof http?.['url'] === 'string' ? (http['url'] as string).trim() : '';
      if (http && !/^(https?:\/\/|\{\{|\$\{)/i.test(url)) {
        warnings.push(`${at}: the API URL${url ? ` "${url}"` : ''} has no http:// or https:// — the request cannot be sent.`);
      }
      const assertions = Array.isArray(api['assertions']) ? (api['assertions'] as unknown[]) : [];
      if (http && assertions.length === 0) {
        warnings.push(`${at}: the API step has no assertions — it will PASS even if the server returns an error or does not answer. Add at least a statusCode assertion.`);
      }
      for (const name of [...new Set(stringsIn(api).flatMap(tokensIn))]) {
        if (name in data || stored.has(name) || hiddenSetup) continue;
        warnings.push(`${at}: the request uses {{${name}}}, but ${name} is not set in this test case's data or stored by an earlier step. ` +
          'Make sure it exists in the project with a value — otherwise it is empty when the request is sent.');
      }
    }
  });
  return warnings;
}

/** The block appended to a save confirmation. Empty string when there is nothing to say. */
export function lintBlock(warnings: string[]): string {
  return warnings.length
    ? `\n\n⚠️ Pre-run checks — ${warnings.length} thing(s) that will make this test case fail or pass for the wrong reason:\n- ${warnings.join('\n- ')}`
    : '';
}
