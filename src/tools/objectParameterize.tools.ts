/**
 * `object_parameterize` — make part of a step's object locator a PARAMETER OF THE OBJECT (SimplifyQA).
 *
 * The recorder cannot do this: it records the locator with the text fixed in it (`//a[normalize-space()='PIM']`). In the
 * SimplifyQA editor the object's locator carries `{{<paramId>}}`, the step shows it in "Parameter of object", and the
 * value sits in the test-data cell. This tool does that on a saved test case, and reads the test data back.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { ObjectParameterizeInput, ObjectParameterizeResult } from '../adapters/simplifyqa/adapter.js';

export type ObjectParameterizeToolDeps = { getAdapter: () => ProviderAdapter | null };

const NOT_CONNECTED = 'Not connected to a product. Use qa_connect({ url, token, projectId }) first — object_parameterize needs a live SimplifyQA connection.';

export function registerObjectParameterizeTool(server: McpServer, deps: ObjectParameterizeToolDeps): void {
  server.registerTool(
    'object_parameterize',
    {
      title: 'Parameterize an object locator (SimplifyQA)',
      description:
        'Turn part of a saved step\'s OBJECT locator into a "Parameter of object", as the SimplifyQA editor does: e.g. step 7 clicks the object ' +
        'whose locator is //a[normalize-space()=\'PIM\'] — pass `replace:"PIM"`, `parameterName:"menu_name"` and the locator becomes ' +
        '//a[normalize-space()=\'{{<id>}}\'], the step shows menu_name under "Parameter of object", and the test-data cell holds PIM. ' +
        'The recorder cannot do this itself. WITHOUT `confirm:true` it only reports what would change. The object is SHARED: other steps ' +
        'and test cases that use it will resolve the same parameter, so they need a value for it too. Reads the test data back and says ' +
        'whether the value is stored.',
      inputSchema: {
        tcId: z.string().describe('Test case id or code, e.g. TC-12862.'),
        step: z.number().int().min(1).describe('1-based number of the step whose object holds the locator.'),
        parameterName: z.string().describe('Name of the parameter, e.g. menu_name. Created if it does not exist.'),
        value: z.string().optional().describe('The value for the test-data cell, e.g. PIM. Also the locator text to replace unless `replace` is given.'),
        replace: z.string().optional().describe('The text inside the locator to turn into the parameter, when it differs from `value`.'),
        locator: z.string().optional().describe('Only rewrite the locator with this name (e.g. "Xpath by Role and Name"). Default: every locator containing the text.'),
        versionId: z.string().optional().describe('A non-current version of the test case (id or name like v2.0).'),
        confirm: z.boolean().optional().describe('true = write it. Omit to preview.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & Partial<{ objectParameterize: (i: ObjectParameterizeInput) => Promise<ObjectParameterizeResult> }>) | null;
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.objectParameterize) return err('object_parameterize is available only on a SimplifyQA connection.');
      try {
        const r = await adapter.objectParameterize(args as ObjectParameterizeInput);
        const changes = r.changes.map((c) => `  • ${c.locator}: ${c.before}  →  ${c.after}`).join('\n');
        const head = r.written
          ? `Parameterized object "${r.objectName}" in ${r.tcId}: parameter ${r.parameter.name} (id ${r.parameter.id}) is now a Parameter of object on step${r.steps.length > 1 ? 's' : ''} ${r.steps.join(', ')}.`
          : `Preview only — nothing was written. Object "${r.objectName}" of ${r.tcId} (step${r.steps.length > 1 ? 's' : ''} ${r.steps.join(', ')} use${r.steps.length > 1 ? '' : 's'} it), parameter ${r.parameter.name}:`;
        const tail = r.written
          ? `Test data: ${r.testdata === 'seeded' ? `${r.parameter.name} = ${r.value} (stored)` : r.testdata === 'patched' ? `${r.parameter.name} = ${r.value} (written to the default row)` : 'could not be confirmed — open the test data and check the column.'}`
          : `Value for the test data: ${r.value}. Run again with confirm:true to apply.`;
        return ok([head, changes, tail, ...r.notes.map((n) => `⚠️ ${n}`)].filter(Boolean).join('\n'), { ...r } as unknown as Record<string, unknown>);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
