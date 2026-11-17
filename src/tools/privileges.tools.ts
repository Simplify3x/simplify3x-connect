/**
 * `qa_privileges` — can this user RECORD in this project?
 *
 * SimplifyQA gates every recording write behind a project-scoped role privilege
 * (`checkPrivilegesForApi`, mirrored by `SimplifyQaAdapter.getProjectPrivileges`). The recorder
 * creates a test case, parameters and objects as it runs, so a role without those keys used to
 * fail MID-recording (a `createParamSeq` 403) after half the entities already existed. This tool
 * answers the question up front, and the product agent enforces the same set in
 * `core_activate_technology` before anything launches.
 *
 * The split below is deliberate:
 *   REQUIRED — the writes a recording really performs. Missing one = refuse (the backend would).
 *   ADVISORY — reads the recorder WINDOW wants. Missing one degrades the UI, never the data, so
 *              it is reported as a warning instead of a false refusal.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';

export type PrivilegeToolsDeps = {
  getAdapter: () => ProviderAdapter | null;
};

/** Writes every recording performs, whatever the technology. */
export const RECORD_REQUIRED = ['add_testcase', 'add_parameter', 'add_object'] as const;

/** Reads the recorder window uses. Missing them does not corrupt anything — warn, don't block. */
export const RECORD_ADVISORY = [
  'view_testcase',
  'view_parameter',
  'view_object',
  'view_function',
  'view_testdata',
  'view_requirementmanagement',
] as const;

/** Per-technology extras on top of the common set. */
const TECH_REQUIRED: Record<string, readonly string[]> = {
  ANDROID: ['allow_mobile_integration', 'mobile_automation'],
  IOS: ['allow_mobile_integration', 'mobile_automation'],
  MAINFRAME: ['mainframe_automation'],
};

/** Per-technology keys that only WARN. DESKTOP's key name is not confirmed in the backend yet, so a missing
 *  `desktop_automation` is reported but never refuses (the product agent does the same). */
const TECH_ADVISORY: Record<string, readonly string[]> = {
  DESKTOP: ['desktop_automation'],
};

/** The keys a recording of `technology` should have but can record without (warn-only). */
export function advisoryForTechnology(technology?: string): string[] {
  return [...(TECH_ADVISORY[(technology ?? 'WEB').trim().toUpperCase()] ?? [])];
}

const CLOUD_PROVIDERS = new Set(['lambdatest', 'browserstack', 'saucelabs', 'pcloudy']);

/** The keys a recording of `technology` needs beyond the common set. */
export function requiredForTechnology(technology?: string, provider?: string): string[] {
  const tech = (technology ?? 'WEB').trim().toUpperCase();
  const extra = [...(TECH_REQUIRED[tech] ?? [])];
  if (CLOUD_PROVIDERS.has((provider ?? '').trim().toLowerCase())) extra.push('allow_cloud_integration');
  return extra;
}

export type PrivilegeVerdict = 'ok' | 'no-role' | 'missing-privileges' | 'invalid-token';

export type PrivilegeReport = {
  verdict: PrivilegeVerdict;
  projectId: string;
  userId?: string;
  role?: { id?: number; name?: string };
  hasRole: boolean;
  tokenValid: boolean;
  can: Record<string, boolean>;
  required: string[];
  missing: string[];
  warnings: string[];
  hint?: string;
};

/**
 * Turn a resolved privilege list into the report both `qa_privileges` and `project_info` return.
 * Pure, so it is unit-testable without a live backend.
 */
export function buildPrivilegeReport(
  input: {
    projectId: string;
    userId?: string;
    roleId?: number;
    roleName?: string;
    hasRole: boolean;
    tokenValid: boolean;
    privileges: string[];
  },
  opts: { technology?: string; provider?: string; need?: string[] } = {},
): PrivilegeReport {
  const held = new Set(input.privileges.map((p) => p.trim()));
  const required = [...new Set([...RECORD_REQUIRED, ...requiredForTechnology(opts.technology, opts.provider), ...(opts.need ?? [])])];
  const advisory = [...RECORD_ADVISORY, ...advisoryForTechnology(opts.technology)].filter((k) => !required.includes(k));

  // No role / dead token: there is nothing to be "missing" — the whole project is unavailable, and
  // listing the core keys as `missing` would read as a fixable role gap. `required` still shows
  // what recording would need.
  const resolvable = input.tokenValid && input.hasRole;
  const missing = resolvable ? required.filter((k) => !held.has(k)) : [];
  const warnings = resolvable ? advisory.filter((k) => !held.has(k)) : [];

  const can: Record<string, boolean> = {
    recordTestCase: held.has('add_testcase'),
    createObject: held.has('add_object'),
    createParameter: held.has('add_parameter'),
    recordWeb: held.has('add_testcase') && held.has('add_object') && held.has('add_parameter'),
    recordMobile: held.has('add_testcase') && held.has('allow_mobile_integration') && held.has('mobile_automation'),
    recordMainframe: held.has('add_testcase') && held.has('mainframe_automation'),
    runTests: held.has('execute_execution_plan') || held.has('local_execution') || held.has('cloud_execution'),
  };

  let verdict: PrivilegeVerdict = 'ok';
  let hint: string | undefined;
  if (!input.tokenValid) {
    verdict = 'invalid-token';
    hint =
      'The token was rejected by the product. Reconnect with a current token: ' +
      'qa_connect({ url, token, projectId, auth }). Nothing was created.';
  } else if (!input.hasRole) {
    verdict = 'no-role';
    hint =
      `You have no role in project ${input.projectId}, so nothing can be created or recorded there. ` +
      'List the projects you belong to with sqa_query({ op:"search", collection:"projects", ' +
      'where:[{ field:"member", value:true }] }), then qa_switch_project({ projectId }). ' +
      'An admin grants access in Configuration → Project → Users.';
  } else if (missing.length > 0) {
    verdict = 'missing-privileges';
    hint =
      `Role "${input.roleName ?? input.roleId ?? '?'}" in project ${input.projectId} is missing ` +
      `${missing.join(', ')}. These are created WHILE recording, so the backend would reject the ` +
      `save. Ask an admin to grant them to that role (Configuration → Roles → ${input.roleName ?? '…'} → ` +
      'Test Management), then retry. Nothing was created.';
  } else if (warnings.length > 0) {
    hint =
      `Recordable. Note: role "${input.roleName ?? input.roleId ?? '?'}" lacks ${warnings.join(', ')} — ` +
      'recording still saves, but parts of the recorder window (object/parameter/testdata lists) may ' +
      'show as empty.';
  }
  if (verdict === 'ok' && warnings.includes('desktop_automation')) {
    hint = `${hint ?? ''} desktop_automation is the expected desktop recording key; its name in the backend is not ` +
      'confirmed yet, so a missing key only warns.';
  }

  return {
    verdict,
    projectId: input.projectId,
    ...(input.userId ? { userId: input.userId } : {}),
    role: { ...(input.roleId != null ? { id: input.roleId } : {}), ...(input.roleName ? { name: input.roleName } : {}) },
    hasRole: input.hasRole,
    tokenValid: input.tokenValid,
    can,
    required,
    missing,
    warnings,
    ...(hint ? { hint } : {}),
  };
}

export function renderPrivilegeReport(r: PrivilegeReport): string {
  const role = r.role?.name ? `${r.role.name}${r.role.id != null ? ` (role ${r.role.id})` : ''}` : 'none';
  const head =
    r.verdict === 'ok'
      ? `✅ Recording is allowed in project ${r.projectId} — role ${role}.`
      : r.verdict === 'invalid-token'
        ? `❌ The token is invalid or expired, so no project could be checked.`
        : r.verdict === 'no-role'
          ? `❌ No role in project ${r.projectId} — recording is refused.`
          : `❌ Recording is refused in project ${r.projectId} — role ${role} is missing ${r.missing.length} privilege${r.missing.length === 1 ? '' : 's'}.`;
  const lines = [head];
  if (r.missing.length) lines.push(`   missing: ${r.missing.join(', ')}`);
  if (r.warnings.length) lines.push(`   not granted (non-blocking): ${r.warnings.join(', ')}`);
  if (r.hint) lines.push('', r.hint);
  return lines.join('\n');
}

const NOT_CONNECTED =
  'Not connected to a product. Use qa_connect({ url, token, projectId }) first — privileges are read ' +
  'from the product for the connected user.';

export function registerPrivilegeTools(server: McpServer, deps: PrivilegeToolsDeps): void {
  server.registerTool(
    'qa_privileges',
    {
      title: 'Check what you may create in a project',
      description:
        'READ-ONLY preflight for recording: resolves the role the connected user holds in a project and ' +
        'that role\'s privilege keys, then says whether recording is allowed there. Answers the three ' +
        'failure modes BEFORE anything is created: invalid/expired token, no role in the project, or a ' +
        'role missing a write the recorder needs (add_testcase / add_parameter / add_object, plus ' +
        'mobile/mainframe/cloud integration keys for those technologies).\n\n' +
        'Returns verdict ok | no-role | missing-privileges | invalid-token, the role name, the full ' +
        'privilege list, a `can` summary, and the exact keys to ask an admin for. The product agent ' +
        'runs the same check inside core_activate_technology, so you never need to call this first — ' +
        'call it when you want to warn the user, or to explain a refusal.',
      inputSchema: {
        projectId: z.string().optional().describe('Project to check. Defaults to the selected project.'),
        technology: z.enum(['WEB', 'ANDROID', 'IOS', 'MAINFRAME', 'API', 'DATABASE', 'DESKTOP']).optional()
          .describe('Check the extra privileges this recording technology needs (mobile/mainframe integration keys). Default: WEB.'),
        provider: z.string().optional().describe('Device provider for ANDROID/IOS (local|emulator|simplifyqa|lambdatest|browserstack|saucelabs) — cloud providers also need allow_cloud_integration.'),
        need: z.array(z.string()).optional().describe('Extra privilege keys to verify, e.g. ["add_userstory"].'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ projectId, technology, provider, need }) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.getProjectPrivileges) {
        return err(
          'This product has no per-project privilege model, so there is nothing to check — the connected ' +
          'provider does not gate creation by role.',
        );
      }
      try {
        const raw = await adapter.getProjectPrivileges(projectId);
        const report = buildPrivilegeReport(raw, {
          ...(technology ? { technology } : {}),
          ...(provider ? { provider } : {}),
          ...(need ? { need } : {}),
        });
        return ok(renderPrivilegeReport(report), report);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
