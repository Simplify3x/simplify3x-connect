/**
 * SQA step descriptions write parameters as `${name}`. Model-authored steps (and story→manual
 * conversions) frequently arrive with the API-style DOUBLE-brace form `${{name}}`, which the
 * product does not recognise: it renders literally in the editor and never binds a parameter.
 *
 * Normalising at the boundary (draft creation + payload build) keeps the stored description
 * readable (`${username}`, shown as a parameter chip) and lets the parameter actually be created.
 */
const DOUBLE_BRACE_TOKEN = /\$\{\{\s*([^{}]+?)\s*\}\}/g;

/** Rewrite `${{name}}` → `${name}` anywhere in a step's prose. Returns the input unchanged when
 *  there is nothing to normalise (including undefined/empty). */
export function normalizeParamTokens(text: string | undefined): string | undefined {
  if (!text) return text;
  return text.replace(DOUBLE_BRACE_TOKEN, (_whole, name: string) => '${' + String(name).trim() + '}');
}

const SINGLE_BRACE_TOKEN = /\$\{\s*([^{}]+?)\s*\}/g;

/** Manual test cases are read/executed by a human: the `${name}` wrapper is noise in the prose.
 *  Replace it with the bare parameter name ("Enter ${username} in…" → "Enter username in…") while
 *  the parameter binding (parameterIds / recordedParam) stays intact. */
export function stripParamTokens(text: string | undefined): string | undefined {
  if (!text) return text;
  return text.replace(SINGLE_BRACE_TOKEN, (_whole, name: string) => String(name).trim());
}

/** Normalise the prose fields of a neutral step (description + expected result). */
export function normalizeStepProse<T extends { description?: string | undefined; expectedResult?: string | undefined }>(step: T): T {
  const description = normalizeParamTokens(step.description);
  const expectedResult = normalizeParamTokens(step.expectedResult);
  if (description === step.description && expectedResult === step.expectedResult) return step;
  return {
    ...step,
    ...(description !== undefined ? { description } : {}),
    ...(expectedResult !== undefined ? { expectedResult } : {}),
  };
}

/** Strip the `${name}` wrapper from a step's prose (manual test cases). */
export function stripStepProse<T extends { description?: string | undefined; expectedResult?: string | undefined }>(step: T): T {
  const description = stripParamTokens(step.description);
  const expectedResult = stripParamTokens(step.expectedResult);
  if (description === step.description && expectedResult === step.expectedResult) return step;
  return {
    ...step,
    ...(description !== undefined ? { description } : {}),
    ...(expectedResult !== undefined ? { expectedResult } : {}),
  };
}
