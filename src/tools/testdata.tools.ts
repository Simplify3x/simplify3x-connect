import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { TestdataRows } from '../domain/types.js';

export type TestdataToolsDeps = {
  getAdapter?: (() => ProviderAdapter | null) | undefined;
};

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Human-readable dump of iterations: one line per row, `name = value` cells. */
function summarizeTestdata(rows: TestdataRows): string {
  const head =
    `${rows.entityType === 'SU' ? 'Suite' : rows.entityType === 'FN' ? 'Function' : 'Test case'} ${rows.id} · ` +
    `env ${rows.environmentType} · ${rows.iterations.length} row(s)`;
  const lines = rows.iterations.map((it) => {
    const isDefault = rows.defaultIterationId && String(it.id) === String(rows.defaultIterationId);
    const cells = it.data
      .filter((c) => c.paramId != null)
      .map((c) => {
        const name = c.name ?? rows.parameterNames[String(c.paramId)] ?? String(c.paramId);
        const value = c.formulaValue ? `${c.value ?? ''} [${c.formulaValue}]` : (c.value ?? '');
        return `${name}=${value}`;
      });
    const shown = cells.slice(0, 15).join(', ');
    const more = cells.length > 15 ? ` … (+${cells.length - 15} more)` : '';
    return `- ${it.name || it.id}${isDefault ? ' (default)' : ''}: ${shown || '(no cells)'}${more}`;
  });
  return `${head}\n${lines.join('\n')}`;
}

/** Reject an `environmentType` that doesn't match a real configured env. Null means accepted
 *  (a match, or listing wasn't possible — the adapter's own call is then the judge). */
async function rejectUnlistedEnv(adapter: ProviderAdapter, environmentType: string): Promise<string | null> {
  let envs: Awaited<ReturnType<ProviderAdapter['listEnvironments']>>;
  try {
    envs = await adapter.listEnvironments();
  } catch {
    return null;
  }
  if (!envs.length) return null;
  const wanted = environmentType.trim().toLowerCase();
  const match = envs.some((e) => (e.key ?? e.id)?.toLowerCase() === wanted);
  if (match) return null;
  const options = envs.map((e) => `${e.name} · key: ${e.key ?? e.id}`).join(', ');
  return (
    `"${environmentType}" is not a configured environment for this project — configured options are: ` +
    `${options}. Call tc_list_environments, show these to the user, ask which one, and retry with the ` +
    'real `key` value (don\'t guess or reuse a value from a different project).'
  );
}

async function checkVersionSelection(
  adapter: ProviderAdapter,
  tcId: string,
  versionId: string | undefined,
  entityType: 'TC' | 'FN' = 'TC',
): Promise<{ error: string } | { versionId: string | undefined }> {
  if (versionId !== undefined) return { versionId: versionId === '' ? undefined : versionId };
  if (entityType === 'FN') {
    if (!adapter.getFunction) return { versionId: undefined };
    const fn = await adapter.getFunction(tcId);
    const fnVersions = fn.versions ?? [];
    if (fnVersions.length > 1) {
      const listing = fnVersions
        .map((v) => `  • \`${v.id}\` — **${v.name}**${v.isCurrent ? ' (current)' : ''}`)
        .join('\n');
      return {
        error:
          `Function ${fn.id ?? tcId} has ${fnVersions.length} versions — ASK the user which one ` +
          `they want testdata for, then call again with \`versionId\`. Pass \`versionId: ''\` to accept ` +
          `the current version.\n\n${listing}`,
      };
    }
    return { versionId: undefined };
  }
  const preview = await adapter.getTestCase(tcId);
  const versions = preview.versions ?? [];
  if (versions.length > 1) {
    const listing = versions
      .map((v) => `  • \`${v.id}\` — **${v.name}**${v.isCurrent ? ' (current)' : ''}${v.reviewApproveStatus ? ` · ${v.reviewApproveStatus}` : ''}`)
      .join('\n');
    return {
      error:
        `Test case ${preview.id ?? tcId} has ${versions.length} versions — ASK the user which one ` +
        `they want testdata for, then call again with \`versionId\`. Pass \`versionId: ''\` to accept ` +
        `the current version.\n\n${listing}`,
    };
  }
  return { versionId: undefined };
}

export function registerTestdataTools(server: McpServer, deps: TestdataToolsDeps): void {
  server.registerTool(
    'tc_list_environments',
    {
      title: 'List environments configured for the connected project',
      description:
        'List every environment configured for the currently connected project (e.g. general, staging, ' +
        'production). Testdata is stored PER ENVIRONMENT — each env has its own iteration rows. ALWAYS ' +
        'call this before tc_get_testdata / tc_generate_testdata, show the user the options, and ASK which ' +
        'env they want to generate testdata for. Never assume. The value to pass onward as ' +
        '`environmentType` is the `key` field on each returned env.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const adapter = deps.getAdapter?.();
      if (!adapter) return err('Not connected to a product. Use qa_connect first.');
      try {
        const envs = await adapter.listEnvironments();
        if (!envs.length) {
          return ok(
            'This project reports zero configured environments. Do NOT assume "general" — confirm ' +
            'with the user before calling tc_get_testdata / tc_generate_testdata, since environments ' +
            'may exist under a different key than expected.',
            { environments: [] },
          );
        }
        const text =
          `${envs.length} environment${envs.length === 1 ? '' : 's'} configured — ask the user which ` +
          `one, even if there is only one option, since "general" is not guaranteed to be among them:\n\n` +
          envs.map((e) => `- ${e.name}${e.isDefault ? ' (default)' : ''} · key: ${e.key ?? e.id}`).join('\n');
        return ok(text, { environments: envs });
      } catch (e) {
        return err(`Could not list environments: ${describeError(e)}`);
      }
    },
  );

  server.registerTool(
    'tc_get_testdata',
    {
      title: 'Read the current testdata template for a test case',
      description:
        'Fetch the default iteration (template row) for TC `tcId` in a specific environment — the ' +
        'parameter list plus the CURRENT seed values. Testdata is per-env: seeds may differ across ' +
        'envs. `environmentType` is REQUIRED — this tool refuses when it is omitted, since silently ' +
        'guessing an env previously caused false "testdata not found" results. FIRST call ' +
        'tc_list_environments and ask the user which env they want. Then read the template here, and ' +
        'use the seeds + the test case\'s steps (from tc_get) to reason about realistic values before ' +
        'calling tc_generate_testdata.\n\n' +
        'VERSIONS: SimplifyQA TCs can have multiple versions with different params/seeds. When the TC ' +
        'has more than one version and `versionId` is omitted, this tool REFUSES and lists the ' +
        'available versions — ASK the user which one, then call again with `versionId`. Pass ' +
        '`versionId: \'\'` to accept the TC\'s currently-selected version. Single-version TCs are read directly.\n\n' +
        'FUNCTIONS: if a step in this TC calls a reusable FUNCTION, the `parameters` array (and the ' +
        'row list in this response\'s text) includes ONE extra row for it — a row whose "seed" is the ' +
        'function\'s NAME + VERSION, not its testdata (a called function\'s testdata is its own ' +
        'separate tc_get_testdata call, never guessed or fabricated here). It is a normal row in the ' +
        'SAME table as the TC\'s own parameters — do not pull it out into separate prose afterward. ' +
        'When one or more functions were called, this response ALSO ends with an explicit prompt ' +
        'listing each one and the exact tc_get_testdata args to fetch its testdata — ASK the user ' +
        'which (if any) they want BEFORE calling tc_get_testdata again for a function; do not fetch ' +
        'one unprompted, and do not skip the ask just because there is only one.',
      inputSchema: {
        tcId: z.string().describe('Test case id (or business key like TC_123). With entityType "FN": the function id.'),
        entityType: z.enum(['TC', 'FN']).optional().describe(
          "'TC' (default) = `tcId` is a test case. 'FN' = `tcId` is a reusable FUNCTION id — reads/saves the " +
          "FUNCTION's own testdata iterations.",
        ),
        environmentType: z.string().optional()
          .describe('Env `key` (from tc_list_environments). REQUIRED — this tool refuses when omitted. Ask the user which env before reading testdata.'),
        versionId: z.string().optional().describe(
          "Version to read testdata for (an id from the TC's `versions[]`). Omit to trigger the " +
          "ASK-user prompt when the TC has multiple versions. Pass '' to accept the TC's currently-" +
          'selected version without prompting.',
        ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ tcId, environmentType, versionId, entityType }) => {
      const adapter = deps.getAdapter?.();
      if (!adapter) return err('Not connected to a product. Use qa_connect first.');
      if (!adapter.getDefaultIteration) {
        return err('This provider does not expose a testdata store.');
      }
      if (!environmentType || !environmentType.trim()) {
        return err(
          'environmentType is required — testdata is stored per environment and this tool refuses to ' +
          'guess (a silent guess previously produced false "testdata not found" results). Call ' +
          'tc_list_environments, show the user the options, ask which env, then call tc_get_testdata ' +
          'again with that env `key` as `environmentType`.',
        );
      }
      const envError = await rejectUnlistedEnv(adapter, environmentType);
      if (envError) return err(envError);
      try {
        const vsel = await checkVersionSelection(adapter, tcId, versionId, entityType ?? 'TC');
        if ('error' in vsel) return err(vsel.error);
        const tpl = await adapter.getDefaultIteration({
          tcId,
          ...(entityType ? { entityType } : {}),
          ...(vsel.versionId !== undefined ? { versionId: vsel.versionId } : {}),
          ...(environmentType !== undefined ? { environmentType } : {}),
        });
        // List called functions by NAME + VERSION only — their own testdata lives in a separate
        // row (a separate tc_get_testdata call against that function), never fetched or guessed here.
        let calledFunctions: Array<{ id: string; code?: string; name?: string; versionId?: string; versionName?: string }> = [];
        try {
          const tc = await adapter.getTestCase(tcId, tpl.versionId);
          const seen = new Set<string>();
          for (const s of tc.steps) {
            const fc = s.functionCall;
            if (!fc?.testCaseId) continue;
            const key = `${fc.testCaseId}::${fc.versionId ?? ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            calledFunctions.push({
              id: fc.testCaseId,
              ...(fc.testCaseCode ? { code: fc.testCaseCode } : {}),
              ...(fc.testCaseName ? { name: fc.testCaseName } : {}),
              ...(fc.versionId ? { versionId: fc.versionId } : {}),
              ...(fc.versionName ? { versionName: fc.versionName } : {}),
            });
          }
        } catch {
          // Best-effort — a TC's own testdata is still useful without the called-function list.
        }
        // Synthetic ROWS added directly into the SAME `parameters` array the TC's own fields are
        // in (paramId is a negative sentinel — never a real backend param id) so a called function
        // is structurally IDENTICAL to a real row wherever this array gets rendered as a table,
        // instead of living in a side-channel field that a renderer would show separately.
        const fnParamRows: typeof tpl.parameters = calledFunctions.map((f, i) => ({
          paramId: -1 - i,
          name: `${[f.code, f.name].filter(Boolean).join(' - ') || f.id} (called function)`,
          seed: f.versionName ?? f.versionId ?? 'current',
        }));
        const displayParams = [...tpl.parameters, ...fnParamRows];

        if (!displayParams.length) {
          return ok(
            `Test case "${tcId}" has no parameterized fields in env "${tpl.environmentType}" — nothing to generate.`,
            { tcId, parameters: [] },
          );
        }
        const fnAskNote = calledFunctions.length
          ? `\n\nASK the user which called function's testdata they want (do not guess or fetch one unasked):\n` +
            calledFunctions
              .map((f) => `- ${[f.code, f.name].filter(Boolean).join(' - ') || f.id} (${f.versionName ?? f.versionId ?? 'current'}) — ` +
                `call tc_get_testdata again with tcId: "${f.id}", entityType: "FN"${f.versionId ? `, versionId: "${f.versionId}"` : ''}, ` +
                `environmentType: "${tpl.environmentType}"`)
              .join('\n')
          : '';
        const text =
          `Testdata template for ${tcId} · env ${tpl.environmentType} · version ${tpl.versionId}\n` +
          `${displayParams.length} row(s)${fnParamRows.length ? ` (${fnParamRows.length} of these is a called function's name + version, not its testdata)` : ''}:\n` +
          displayParams
            .map((p) => p.protected
              ? `- ${p.name} = ${p.seed} [PROTECTED — value hidden, not exposed by this tool]`
              : `- ${p.name} = "${p.seed}"`)
            .join('\n') +
          fnAskNote;
        return ok(text, {
          tcId,
          versionId: tpl.versionId,
          environmentType: tpl.environmentType,
          parameters: displayParams,
        });
      } catch (e) {
        return err(`Could not read testdata for "${tcId}": ${describeError(e)}`);
      }
    },
  );

  server.registerTool(
    'tc_generate_testdata',
    {
      title: 'Save generated testdata rows to a test case',
      description:
        'Persist up to 20 testdata rows for TC `tcId` into a SPECIFIC environment. Testdata is stored ' +
        'per environment — rows saved here only affect the env you pass. WORKFLOW: (1) call ' +
        'tc_list_environments and ASK the user which env; (2) call tc_get_testdata with that env to ' +
        'read seeds; (3) call this tool with the SAME `environmentType`. `environmentType` is REQUIRED ' +
        'here — this tool refuses when it is omitted. Two ways to feed values:\n' +
        '  1) Model-generated — pass `rows: [{paramName: value}, ...]`. Call tc_get_testdata first ' +
        'for the parameter names + seeds, tc_get for step context, then produce rows that fit the flow.\n' +
        '  2) Formula-driven — pass `formulas: {paramName: {name, args?}}` (names from tc_list_formulas). ' +
        'Each formula is evaluated per row by the SimplifyQA desktop AGENT (the same engine the UI and the ' +
        'executor use, so every formula from tc_list_formulas works, including nested ones) and both the ' +
        'value and the source `=NAME(...)` expression are stamped. The agent must be running (QA_MCP_URL). ' +
        'For nested / custom formulas pass `expression` instead of `name`+`args`. Use `count` to say how many rows, or provide `rows` ' +
        'for constant columns; mixing is fine (formulas win over row values for the same param).\n' +
        'Rows are appended as new iterations; they do not become the default. Hard cap: 20 rows.\n\n' +
        'VERSIONS: SimplifyQA TCs can have multiple versions with different params. When the TC has ' +
        'more than one version and `versionId` is omitted, this tool REFUSES and lists the available ' +
        'versions — ASK the user which one, then call again with `versionId`. Pass `versionId: \'\'` ' +
        'to accept the TC\'s currently-selected version.',
      inputSchema: {
        tcId: z.string().describe('Test case id (or business key like TC_123). With entityType "FN": the function id.'),
        entityType: z.enum(['TC', 'FN']).optional().describe(
          "'TC' (default) = `tcId` is a test case. 'FN' = `tcId` is a reusable FUNCTION id — reads/saves the " +
          "FUNCTION's own testdata iterations.",
        ),
        versionId: z.string().optional().describe(
          "Version to save testdata into (an id from the TC's `versions[]`). Omit to trigger the " +
          "ASK-user prompt when the TC has multiple versions. Pass '' to accept the TC's currently-" +
          'selected version without prompting.',
        ),
        rows: z.array(z.record(z.string(), z.string())).max(20).optional()
          .describe('Rows keyed by param name (from tc_get_testdata). 1..20 rows. Omit when using formulas + count.'),
        count: z.number().int().min(1).max(20).optional()
          .describe('How many rows to generate when using formulas without explicit rows. Ignored if rows is set.'),
        formulas: z.record(z.string(), z.object({
          name: z.string().optional().describe('RAW formula name from tc_list_formulas — the identifier only, no parens, no arg list. Correct: "FIRST_NAME". Wrong: "FIRST_NAME()", "FIRST_NAME(country,sex)". Give this OR `expression`.'),
          args: z.record(z.string(), z.string()).optional()
            .describe('Named args. Keys MUST match Formula.parameters[].keyName exactly, no trailing colons or extra whitespace. Correct: {"country name": "United States"}. Wrong: {"country name:": "..."}.'),
          expression: z.string().optional().describe('A complete formula, used as written — for nested or custom formulas, e.g. `=UPPER(FIRST_NAME("United States"))` or `=CONCATENATE(FIRST_NAME(),"@test.com")`. Use instead of name/args.'),
        })).optional()
          .describe('Per-column formula assignments applied to every row. Outer keys are param names from tc_get_testdata. Wins over rows[i] for the same key.'),
        environmentType: z.string().optional()
          .describe('Env `key` (from tc_list_environments). REQUIRED — this tool refuses when omitted. Ask the user which env before generating.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ tcId, rows, count, formulas, environmentType, versionId, entityType }) => {
      const adapter = deps.getAdapter?.();
      if (!adapter) return err('Not connected to a product. Use qa_connect first.');
      if (!adapter.getDefaultIteration || !adapter.saveGeneratedIterations) {
        return err('This provider does not expose a testdata store.');
      }
      if (!environmentType || !environmentType.trim()) {
        return err(
          'environmentType is required — testdata is stored per environment and this tool refuses to ' +
          'guess. Call tc_list_environments, show the user the options, ask which env, then call ' +
          'tc_generate_testdata again with that env `key` as `environmentType`.',
        );
      }
      const envError = await rejectUnlistedEnv(adapter, environmentType);
      if (envError) return err(envError);
      const vsel = await checkVersionSelection(adapter, tcId, versionId, entityType ?? 'TC');
      if ('error' in vsel) return err(vsel.error);
      const hasFormulas = formulas != null && Object.keys(formulas).length > 0;
      if (hasFormulas) {
        const incomplete = Object.entries(formulas!).filter(([, f]) => !f.name && !f.expression?.trim()).map(([k]) => k);
        if (incomplete.length) {
          return err(`Formula for column(s) ${incomplete.join(', ')} needs a \`name\` (from tc_list_formulas) or a full \`expression\`.`);
        }
      }

      // Reconcile rows vs count. Explicit rows always win; otherwise formulas + count seeds N empty
      // rows that the adapter fills column-by-column via evaluateFormula.
      let baseRows: Array<Record<string, string>>;
      if (rows && rows.length > 0) {
        baseRows = rows;
      } else if (hasFormulas && count && count > 0) {
        baseRows = Array.from({ length: count }, () => ({}));
      } else {
        return err('Provide either `rows` (1..20) or `formulas` together with `count` (1..20).');
      }
      if (baseRows.length > 20) return err('Max 20 rows per call.');

      // Resolve version + env by re-reading the template. Server-side env resolution honors project
      // config; passing rows without this echo would risk saving into the wrong env.
      let tpl;
      try {
        tpl = await adapter.getDefaultIteration({
          tcId,
          ...(entityType ? { entityType } : {}),
          ...(vsel.versionId !== undefined ? { versionId: vsel.versionId } : {}),
          ...(environmentType !== undefined ? { environmentType } : {}),
        });
      } catch (e) {
        return err(`Could not fetch the default iteration for "${tcId}": ${describeError(e)}`);
      }
      if (!tpl.parameters?.length) {
        return err(`Test case "${tcId}" has no parameterized fields — nothing to save.`);
      }
      const known = new Set(tpl.parameters.map((p) => p.name));
      // Sheet headers rarely match the stored parameter's spelling exactly ("Username" vs the
      // existing project-wide "username"), and the backend matches parameter names
      // case-insensitively. Fold to the template's canonical spelling before anything else, so the
      // rows, the unknown-name report and the preview all talk about the same columns.
      const byLower = new Map(tpl.parameters.map((p) => [p.name.trim().toLowerCase(), p.name]));
      const canonical = (k: string): string | undefined =>
        known.has(k) ? k : byLower.get(k.trim().toLowerCase());
      const unknown = new Set<string>();
      const normalizedRows = baseRows.map((r) => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(r)) {
          const name = canonical(k);
          if (!name) { unknown.add(k); continue; }
          out[name] = v;
        }
        return out;
      });
      const normalizedFormulas = hasFormulas
        ? Object.fromEntries(
            Object.entries(formulas!).flatMap(([k, v]) => {
              const name = canonical(k);
              if (!name) { unknown.add(k); return []; }
              return [[name, v] as const];
            }),
          )
        : undefined;

      // A cell written as "=NAME(...)" IS a formula — that is exactly how the SQA test-data grid
      // treats it. Saving it through `rows` would store the text as a literal value, so at run time
      // the executor would TYPE "=CONCATENATE(...)" into the application instead of evaluating it
      // (and no formulaValue would be recorded). Promote such cells to the formula path.
      const promoted: Record<string, { expression: string }> = {};
      for (const row of normalizedRows) {
        for (const [k, v] of Object.entries(row)) {
          if (typeof v === 'string' && /^\s*=/.test(v)) {
            promoted[k] = { expression: v.trim() };
            delete row[k];
          }
        }
      }
      // An explicit `formulas` entry wins over a promoted cell for the same column.
      const formulaMap = { ...promoted, ...(normalizedFormulas ?? {}) };
      const formulaColumns = Object.keys(formulaMap);

      let result;
      try {
        result = await adapter.saveGeneratedIterations({
          tcId,
          ...(entityType ? { entityType } : {}),
          versionId: tpl.versionId,
          environmentType: tpl.environmentType,
          rows: normalizedRows,
          parameters: tpl.parameters,  // reuse the just-fetched template; adapter skips its own re-fetch
          ...(formulaColumns.length ? { formulas: formulaMap } : {}),
        });
      } catch (e) {
        return err(`Save failed: ${describeError(e)}`);
      }
      const paramNames = tpl.parameters.map((p) => p.name);
      const protectedNames = new Set(tpl.parameters.filter((p) => p.protected).map((p) => p.name));
      // Mask protected columns before they reach the text or structuredContent.
      const preview = normalizedRows.slice(0, 3).map((r) => {
        const masked: Record<string, string> = { ...r };
        for (const n of protectedNames) if (n in masked) masked[n] = masked[n] ? '*****' : '(empty)';
        return masked;
      });
      const formulaNote = formulaColumns.length
        ? `\nFormula columns: ${formulaColumns.join(', ')} (evaluated per row).`
        : '';
      const warn = unknown.size
        ? `\n(Ignored unknown param name(s): ${[...unknown].join(', ')} — not in the template.)`
        : '';
      const protectedNote = protectedNames.size
        ? `\nProtected column(s) [${[...protectedNames].join(', ')}] are masked below — their values are never echoed by this tool.`
        : '';
      const link = result.datasetUrl ? `\n${result.datasetUrl}` : '';
      const text =
        `Saved ${result.inserted} testdata row(s) for ${tcId} · env ${tpl.environmentType}.${link}${formulaNote}${warn}${protectedNote}\n\n` +
        `Preview (first ${preview.length}, formula values shown as their param name):\n` +
        preview
          .map((r, i) => `${i + 1}. ${paramNames.map((n) => `${n}=${r[n] ?? (formulaMap[n] ? `<${('expression' in formulaMap[n]! ? formulaMap[n]!.expression : formulaMap[n]!.name)}>` : '')}`).join(' | ')}`)
          .join('\n');
      return ok(text, {
        tcId,
        generated: result.inserted,
        params: paramNames,
        preview,
        ...(formulaColumns.length ? { formulasUsed: formulaColumns } : {}),
        ...(result.datasetUrl ? { datasetUrl: result.datasetUrl } : {}),
        ...(result.iterationIds ? { iterationIds: result.iterationIds } : {}),
      });
    },
  );

  server.registerTool(
    'tc_update_testdata',
    {
      title: 'Update the existing test data (default iteration) of a test case',
      description:
        'UPDATE the test data a run actually uses — the DEFAULT iteration (ITR-1) — instead of appending a ' +
        'new row. Use this for "change/set/fix the test data", "add a formula to the test data", or whenever ' +
        'a value or formula must apply to the NEXT run. (tc_generate_testdata APPENDS iterations; an appended ' +
        'row never becomes the default, so a formula saved there does not affect the run.)\n\n' +
        'Each cell takes a literal `value` or a `formula` ({ name, args? } from tc_list_formulas, or a full ' +
        '`expression` — nested formulas are supported). Formulas are evaluated by the SimplifyQA desktop agent; ' +
        'the evaluated value AND the canonical =NAME(...) expression are stored, and the executor re-evaluates ' +
        'at run time. Unknown/invented names and unevaluatable formulas are rejected BEFORE anything is ' +
        'written. Only the named cells change — every other column keeps its value — and the row is read back.',
      inputSchema: {
        tcId: z.string().describe('Test case id or business key (e.g. TC_123).'),
        environmentType: z.string().describe('Env `key` from tc_list_environments. REQUIRED — test data is per environment.'),
        versionId: z.string().optional().describe("Version id from the TC's versions[]. Omit on a single-version TC; pass '' to accept the current one."),
        cells: z.array(z.object({
          param: z.string().describe('Parameter name exactly as tc_get_testdata shows it.'),
          value: z.string().optional().describe('Literal value to store. Give this OR `formula`.'),
          formula: z.object({
            name: z.string().optional().describe('Raw formula name from tc_list_formulas (identifier only, no parens).'),
            args: z.record(z.string(), z.string()).optional().describe("Formula arguments keyed by the formula's parameter keyName. Literal values only."),
            expression: z.string().optional().describe('Full expression — use for nested formulas, e.g. "=CONCATENATE(FULL_NAME(),CREDIT_CARD_NUMBER())".'),
          }).optional().describe('Formula to store on that cell (takes precedence over `value`).'),
        })).min(1).describe('Cells to change. Only these are touched.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ tcId, environmentType, versionId, cells }) => {
      const adapter = deps.getAdapter?.();
      if (!adapter) return err('Not connected to a product. Use qa_connect first.');
      if (!adapter.patchTestdataCells) return err('This provider cannot update existing test data.');
      const envError = await rejectUnlistedEnv(adapter, environmentType);
      if (envError) return err(envError);
      let vsel: { error: string } | { versionId: string | undefined };
      try {
        vsel = await checkVersionSelection(adapter, tcId, versionId);
      } catch (e) {
        return err(`Could not resolve the test case version: ${describeError(e)}`);
      }
      if ('error' in vsel) return err(vsel.error);

      const patch: Array<{ paramName: string; value: string; formulaValue?: string }> = [];
      const notes: string[] = [];
      for (const cell of cells) {
        if (cell.formula) {
          if (!adapter.evaluateFormula) return err('This provider cannot evaluate formulas.');
          const call = {
            ...(cell.formula.name ? { name: cell.formula.name } : {}),
            ...(cell.formula.args ? { args: cell.formula.args } : {}),
            ...(cell.formula.expression ? { expression: cell.formula.expression } : {}),
          };
          if (!call.name && !call.expression) return err(`Cell "${cell.param}": give the formula as { name } or { expression }.`);
          try {
            const { value, expression } = await adapter.evaluateFormula(call);
            patch.push({ paramName: cell.param, value, formulaValue: expression });
            notes.push(`${cell.param} = ${expression}  →  ${value}`);
          } catch (e) {
            return err(`Formula for "${cell.param}" could not be applied — nothing was written: ${describeError(e)}`);
          }
        } else if (cell.value !== undefined) {
          patch.push({ paramName: cell.param, value: cell.value });
          notes.push(`${cell.param} = ${cell.value === '' ? '(empty)' : cell.value}`);
        } else {
          return err(`Cell "${cell.param}": give a \`value\` or a \`formula\`.`);
        }
      }

      let res: { patched: number; skipped: string[] };
      try {
        res = await adapter.patchTestdataCells({
          tcId,
          cells: patch,
          ...(vsel.versionId !== undefined ? { versionId: vsel.versionId } : {}),
          environmentType,
          overwriteFormula: true,
        });
      } catch (e) {
        return err(`Update failed: ${describeError(e)}`);
      }

      let after: Array<{ name: string; seed: string }> = [];
      try {
        const tpl = adapter.getDefaultIteration
          ? await adapter.getDefaultIteration({
              tcId,
              ...(vsel.versionId !== undefined ? { versionId: vsel.versionId } : {}),
              environmentType,
            })
          : null;
        after = tpl ? tpl.parameters.map((p) => ({ name: p.name, seed: p.protected ? '*****' : p.seed })) : [];
      } catch { /* read-back is best-effort */ }

      const skippedNote = res.skipped.length ? `\nSkipped: ${res.skipped.join('; ')}` : '';
      const readBack = after.length
        ? `\n\nDefault iteration (ITR-1) now:\n` + after.map((p) => `- ${p.name} = ${p.seed === '' ? '(empty)' : p.seed}`).join('\n')
        : '';
      return ok(
        `Updated ${res.patched} cell(s) on the DEFAULT test data row of ${tcId} · env ${environmentType}.\n` +
          notes.map((n) => `- ${n}`).join('\n') + skippedNote + readBack,
        { tcId, environmentType, patched: res.patched, skipped: res.skipped, readBack: after },
      );
    },
  );

  server.registerTool(
    'suite_get_testdata',
    {
      title: "Read a suite's SUITE-LEVEL test data",
      description:
        'Read the SUITE-LEVEL test-data iterations of suite `suiteId` (SU-24) in an environment. ' +
        'Suite-level test data is a SEPARATE store from the member test cases\' own test data. When the ' +
        'user says "SU-24 test data", ALWAYS use this — never tc_get_testdata on a member test case. ' +
        '`environmentType` is REQUIRED: call tc_list_environments, show the keys, and ASK which env. ' +
        'The result lists every iteration (name, default marker, parameter=value cells).',
      inputSchema: {
        suiteId: z.string().describe('Suite id or business key (SU-24).'),
        environmentType: z.string().describe('Environment key from tc_list_environments (e.g. general, general_1).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ suiteId, environmentType }) => {
      const adapter = deps.getAdapter?.();
      if (!adapter) return err('Not connected to a product. Use qa_connect first.');
      if (!adapter.getSuiteTestdata) return err('Suite-level test data is not supported by the connected provider.');
      const envErr = await rejectUnlistedEnv(adapter, environmentType);
      if (envErr) return err(envErr);
      try {
        const rows = await adapter.getSuiteTestdata({ suiteId, environmentType });
        return ok(summarizeTestdata(rows), rows as unknown as Record<string, unknown>);
      } catch (e) {
        return err(`Could not read suite-level test data for ${suiteId}: ${describeError(e)}`);
      }
    },
  );

  server.registerTool(
    'suite_copy_testdata',
    {
      title: 'Copy a SUITE-LEVEL test-data row and save it on the suite',
      description:
        'Copy ONE existing suite-level row of suite `suiteId` into a NEW suite-level row and save it. ' +
        'Use for "copy ITR-1 into ITR-2 in SU-24\'s test data and save". The copy is written to the ' +
        'SUITE-LEVEL test data ONLY — member test cases\' own test data is NEVER touched. `from` names ' +
        'the source row (default: the suite default row, normally ITR-1); `name` names the new row ' +
        '(default: the next free ITR-N). The tool then reads the suite\'s test data back and confirms the ' +
        'new row exists. Refuses a duplicate row name.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        suiteId: z.string().describe('Suite id or business key (SU-24).'),
        environmentType: z.string().describe('Environment key from tc_list_environments (e.g. general, general_1).'),
        from: z.string().optional().describe('Source iteration name (e.g. "ITR-1") or id. Default: the suite default row.'),
        name: z.string().optional().describe('Name for the new row (e.g. "ITR-2"). Default: next free ITR-N.'),
      },
    },
    async ({ suiteId, environmentType, from, name }) => {
      const adapter = deps.getAdapter?.();
      if (!adapter) return err('Not connected to a product. Use qa_connect first.');
      if (!adapter.copySuiteTestdataIteration) return err('Suite-level test data is not supported by the connected provider.');
      const envErr = await rejectUnlistedEnv(adapter, environmentType);
      if (envErr) return err(envErr);
      try {
        const res = await adapter.copySuiteTestdataIteration({
          suiteId, environmentType,
          ...(from ? { from } : {}),
          ...(name ? { name } : {}),
        });
        return ok(
          `Created suite-level iteration "${res.name}" (id ${res.iterationId}) on suite ${suiteId} — ` +
          `member test cases were not touched. Read back after the save:\n\n` + summarizeTestdata(res.rows),
          { suiteId, iterationId: res.iterationId, name: res.name, rows: res.rows } as unknown as Record<string, unknown>,
        );
      } catch (e) {
        return err(`Could not copy suite-level test data for ${suiteId}: ${describeError(e)}`);
      }
    },
  );

  server.registerTool(
    'testdata_delete_iterations',
    {
      title: 'Delete test-data iteration rows (test case or suite level)',
      description:
        'Delete one or more test-data iteration rows by NAME (e.g. "ITR-2") or id. Works at TEST CASE level ' +
        '(`entityType:"TC"` + `tcId`) and at SUITE level (`entityType:"SU"` + `suiteId`). The DEFAULT row is ' +
        'refused — to replace the default, first make another row the default with testdata_set_default_iteration. Use this to remove rows created by mistake. It reads the rows back after deleting and ' +
        'reports what remains.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        entityType: z.enum(['TC', 'SU']).optional().describe('TC = a test case\'s own test data; SU = suite-level test data. Default TC.'),
        tcId: z.string().optional().describe('Test case id / TC-123 (required when entityType is TC).'),
        suiteId: z.string().optional().describe('Suite id / SU-24 (required when entityType is SU).'),
        environmentType: z.string().describe('Environment key from tc_list_environments (e.g. general, general_1).'),
        iterations: z.array(z.string()).min(1).describe('Iteration names (e.g. ["ITR-2"]) or ids to delete.'),
      },
    },
    async ({ entityType, tcId, suiteId, environmentType, iterations }) => {
      const adapter = deps.getAdapter?.();
      if (!adapter) return err('Not connected to a product. Use qa_connect first.');
      if (!adapter.deleteTestdataIterations) return err('Deleting test-data rows is not supported by the connected provider.');
      const type = entityType ?? (suiteId ? 'SU' : 'TC');
      const id = type === 'SU' ? suiteId : tcId;
      if (!id) return err(type === 'SU' ? 'Pass suiteId for entityType "SU".' : 'Pass tcId for entityType "TC".');
      const envErr = await rejectUnlistedEnv(adapter, environmentType);
      if (envErr) return err(envErr);
      try {
        const res = await adapter.deleteTestdataIterations({ entityType: type, id, environmentType, iterations });
        return ok(
          `Deleted ${res.deleted.length} iteration row(s) from ${type === 'SU' ? 'suite' : 'test case'} ${id} — env ${environmentType}. ` +
          `Rows now:\n\n` + summarizeTestdata(res.rows),
          { deleted: res.deleted, rows: res.rows } as unknown as Record<string, unknown>,
        );
      } catch (e) {
        return err(`Could not delete test-data row(s): ${describeError(e)}`);
      }
    },
  );

  server.registerTool(
    'testdata_set_default_iteration',
    {
      title: 'Make a test-data iteration the default (test case or suite level)',
      description:
        'Make one iteration row the DEFAULT of an environment — the row a run uses — e.g. "make ITR-2 the default for SU-23 in General". Works at TEST CASE ' +
        'level (`entityType:"TC"` + `tcId`) and SUITE level (`entityType:"SU"` + `suiteId`). Pass the iteration by NAME (e.g. "ITR-2") or id. The previous ' +
        'default simply stops being the default (it is NOT deleted — delete it afterwards with testdata_delete_iterations if wanted); other environments\' ' +
        'defaults are kept. It reads the test data back and reports the new default; asking for the row that already is the default changes nothing.',
      inputSchema: {
        entityType: z.enum(['TC', 'SU']).optional().describe('TC = a test case\'s own test data; SU = suite-level test data. Default TC.'),
        tcId: z.string().optional().describe('Test case id / TC-123 (required when entityType is TC).'),
        suiteId: z.string().optional().describe('Suite id / SU-23 (required when entityType is SU).'),
        environmentType: z.string().describe('Environment key from tc_list_environments (e.g. general, general_1) — each environment has its own default.'),
        iteration: z.string().min(1).describe('The iteration to make the default: its name (e.g. "ITR-2") or id.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ entityType, tcId, suiteId, environmentType, iteration }) => {
      const adapter = deps.getAdapter?.() as (ProviderAdapter & {
        setDefaultTestdataIteration?: (q: { entityType: 'TC' | 'FN' | 'SU'; id: string; environmentType: string; iteration: string }) =>
          Promise<{ iteration: string; previous?: string; changed: boolean; rows: TestdataRows }>;
      }) | null | undefined;
      if (!adapter) return err('Not connected to a product. Use qa_connect first.');
      if (!adapter.setDefaultTestdataIteration) return err('Changing the default test-data row is not supported by the connected provider.');
      const type = entityType ?? (suiteId ? 'SU' : 'TC');
      const id = type === 'SU' ? suiteId : tcId;
      if (!id) return err(type === 'SU' ? 'Pass suiteId for entityType "SU".' : 'Pass tcId for entityType "TC".');
      const envErr = await rejectUnlistedEnv(adapter, environmentType);
      if (envErr) return err(envErr);
      try {
        const res = await adapter.setDefaultTestdataIteration({ entityType: type, id, environmentType, iteration });
        const where = `${type === 'SU' ? 'suite' : 'test case'} ${id} — env ${environmentType}`;
        const head = res.changed
          ? `${res.iteration} is now the default iteration of ${where}${res.previous ? ` (it was ${res.previous}, which still exists but is no longer the default)` : ''}. Read back from SimplifyQA.`
          : `${res.iteration} is already the default iteration of ${where} — nothing was changed.`;
        return ok(`${head}\n\nRows now:\n\n` + summarizeTestdata(res.rows), { iteration: res.iteration, previous: res.previous, changed: res.changed, rows: res.rows } as unknown as Record<string, unknown>);
      } catch (e) {
        return err(`Could not change the default test-data row: ${describeError(e)}`);
      }
    },
  );
}
