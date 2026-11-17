import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { Formula } from '../domain/types.js';

export type FormulaToolsDeps = {
  getAdapter?: (() => ProviderAdapter | null) | undefined;
};

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Two prefab DESCRIPTIONS are swapped in the product's formula docs (verified against the engine:
 * STATE("India") → "Puducherry", ZIPCODE("India") → "480559"). Rendering them verbatim steers a
 * caller asking for a postal code to STATE, so the two texts are exchanged here.
 */
const DETAIL_FIXUPS: Record<string, string> = {
  STATE: 'Returns a state/province for the specified country.',
  ZIPCODE: 'Returns a postal code for the specified country.',
};

/** "EMAIL_ID()" / "EMAIL([prefix], …)" → "EMAIL_ID" / "EMAIL". */
function bareName(s: string): string {
  return s.replace(/\s*\(.*\)\s*$/, '').trim();
}

const SCOPE_LABEL: Record<Formula['scope'], string> = {
  default: 'DEFAULT prefabs (customer-wide)',
  customer: 'CUSTOM · customer-wide',
  project: 'CUSTOM · this project',
};

export function registerFormulaTools(server: McpServer, deps: FormulaToolsDeps): void {
  server.registerTool(
    'tc_list_formulas',
    {
      title: 'List testdata formulas available in the current project',
      description:
        'Return the formulas the connected project can use for testdata generation — DEFAULT prefabs ' +
        '(FIRST_NAME, LAST_NAME, COUNTRY_NAME, EMAIL_ID, PHONE_NUMBER, …) plus any CUSTOM formulas ' +
        'defined at customer or project scope. EVERY line starts with the NAME to pass as `name`; the ' +
        'parenthesised part after it is the human signature (it can differ — e.g. the name is EMAIL_ID ' +
        'while its signature reads EMAIL(...)), and `args:` lists the argument keys the formula accepts ' +
        '(matched case-insensitively). Feed a chosen `{name, args}` into `tc_generate_testdata.formulas` ' +
        'and that column is auto-filled fresh per row by the agent\'s formula engine. Use this when the ' +
        'user says "use a formula" / "generate an email" / "first name, phone, country…" / "list formulas".',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const adapter = deps.getAdapter?.();
      if (!adapter) return err('Not connected to a product. Use qa_connect first.');
      if (!adapter.listFormulas) return err('This provider does not expose a formulas store.');
      let formulas: Formula[];
      try {
        formulas = await adapter.listFormulas();
      } catch (e) {
        return err(`Could not list formulas: ${describeError(e)}`);
      }
      if (formulas.length === 0) {
        return ok('No formulas configured for this project.', { formulas: [] });
      }
      const groups: Record<Formula['scope'], Formula[]> = { default: [], customer: [], project: [] };
      for (const f of formulas) groups[f.scope].push(f);
      const section = (scope: Formula['scope']): string => {
        const items = groups[scope];
        if (items.length === 0) return '';
        const lines = items.map((f) => {
          // Lead with the NAME the caller must pass. The signature alone was ambiguous: EMAIL_ID's
          // signature reads "EMAIL([prefix], [domain], [format])", so a model picked "EMAIL" — a
          // different function (which ignores its arguments) that is not even in this list.
          const canon = bareName(f.name);
          const sig = f.signature || `${f.name}()`;
          const head = bareName(sig).toUpperCase() === canon.toUpperCase() ? sig : `${canon} · ${sig}`;
          const args = (f.parameters ?? []).map((p) => p.keyName.replace(/:$/, '').trim()).filter(Boolean);
          const argNote = args.length ? `  args: ${args.join(', ')}` : '';
          const rawDetails = DETAIL_FIXUPS[canon.toUpperCase()] ?? f.details ?? '';
          const details = rawDetails.trim().length > 140
            ? rawDetails.trim().slice(0, 137).trimEnd() + '…'
            : rawDetails.trim();
          const whatItDoes = details ? ` — ${details}` : '';
          const ex = f.example ? `  e.g. ${f.example}` : '';
          return `- ${head}${whatItDoes}${argNote}${ex}`;
        });
        return `\n${SCOPE_LABEL[scope]} (${items.length}):\n${lines.join('\n')}`;
      };
      const text =
        `${formulas.length} formula(s) available:` +
        section('default') + section('customer') + section('project') +
        '\n\nPass one into tc_generate_testdata: formulas: { <paramName>: { name: "FIRST_NAME", args: { "country name": "United States" } } }';
      return ok(text, { formulas });
    },
  );
}
