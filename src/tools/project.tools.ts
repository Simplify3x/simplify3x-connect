/**
 * `project_create` — create a PROJECT in SimplifyQA (the admin Project screen's New Project form).
 *
 * POST /pm/project with the name/description and the member `users` (empty = only the caller).
 * The response carries the new project's id + code; the tool reads it back to confirm.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';

export type ProjectDeps = { getAdapter: () => ProviderAdapter | null };

type ProjectWrites = {
  createProject: (input: { name: string; description?: string | undefined; users?: number[] | undefined }) => Promise<{ id: string; created: boolean; code?: string; productUrl?: string }>;
  getProjectById?: ((id: string) => Promise<Record<string, any>>) | undefined;
  deleteProject?: ((id: string) => Promise<{ deleted: boolean }>) | undefined;
  listProjectMembers?: ((projectId: string) => Promise<Array<{ userId: number; roleId: number }>>) | undefined;
  findUserByEmail?: ((email: string) => Promise<{ id: number; code?: string; name?: string; email?: string } | null>) | undefined;
  inviteUser?: ((input: { email: string; name?: string | undefined; roleId?: number | undefined; projectId?: string | undefined }) => Promise<{ id: number; code?: string }>) | undefined;
  addProjectMembers?: ((projectId: string, members: Array<{ userId: number; roleId: number }>) => Promise<{ added: number[]; updated: number[]; total: number }>) | undefined;
  removeProjectMembers?: ((projectId: string, userIds: number[]) => Promise<{ removed: number[]; total: number }>) | undefined;
};

const NOT_CONNECTED = 'Not connected to a product. Use qa_connect({ url, token, projectId }) first.';

export function registerProjectTools(server: McpServer, deps: ProjectDeps): void {
  server.registerTool(
    'project_create',
    {
      title: 'Create a project (SimplifyQA)',
      description:
        'Create a new PROJECT with a name and description. The new project is returned with its id and ' +
        'business code (PR-x), and is read back to confirm. Use qa_switch_project to work in it afterwards.',
      inputSchema: {
        name: z.string().min(1).max(200).describe('Project name.'),
        description: z.string().optional().describe('Project description.'),
        users: z.array(z.number()).optional().describe('Optional numeric userIds to add as project members.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ name, description, users }) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & Partial<ProjectWrites>) | null;
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.createProject) return err('Creating projects is available only on a SimplifyQA connection.');
      try {
        const ref = await adapter.createProject({ name, ...(description !== undefined ? { description } : {}), ...(users ? { users } : {}) });
        let readBack: Record<string, any> | undefined;
        if (adapter.getProjectById) {
          try { readBack = await adapter.getProjectById(ref.id); } catch { /* the create response is enough */ }
        }
        const code = readBack?.['code'];
        return ok(
          `Created project ${code ? `${code} ` : ''}"${readBack?.['name'] ?? name}" (id ${ref.id}).`,
          { savedRef: ref, project: readBack ?? { id: ref.id, name, description } } as unknown as Record<string, unknown>,
        );
      } catch (e) {
        return err(`Could not create the project: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    'project_delete',
    {
      title: 'Delete a project (SimplifyQA)',
      description:
        'DESTRUCTIVE. Delete ONE project by id or code (e.g. "5" or "PR-7"). TWO-STEP: call without ' +
        '`confirm` to get a preview of the project that will be deleted; show it and ASK the user; only ' +
        'then call again with `confirm:true`. It removes the project and everything inside it.',
      inputSchema: {
        projectId: z.string().describe('Project id or code (e.g. "5", "PR-7").'),
        confirm: z.boolean().optional().describe('Set true only after the user explicitly confirms.'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ projectId, confirm }) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & Partial<ProjectWrites>) | null;
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.deleteProject) return err('Deleting projects is available only on a SimplifyQA connection.');
      try {
        let project: Record<string, any> | undefined;
        if (adapter.getProjectById) {
          try { project = await adapter.getProjectById(projectId); } catch { /* preview without the name */ }
        }
        const label = `${project?.['code'] ?? projectId}${project?.['name'] ? ` "${project['name']}"` : ''}`;
        if (confirm !== true) {
          return ok(
            `About to delete project ${label}. Everything inside it goes too — this cannot be undone.\n\n` +
              '**Ask the user to confirm**, then call `project_delete` again with `confirm:true`.',
            { preview: true, needs: 'confirm', project: project ?? { id: projectId } },
          );
        }
        const res = await adapter.deleteProject(String(project?.['id'] ?? projectId));
        if (!res.deleted) return err(`The product did not delete project ${label}.`);
        return ok(`Deleted project ${label}.`, { deleted: { id: project?.['id'] ?? projectId, name: project?.['name'] } });
      } catch (e) {
        return err(`Could not delete the project: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    'project_user_add',
    {
      title: 'Add or invite a user to a project (SimplifyQA)',
      description:
        'Add a person to a project with a role — the admin Project screen\'s "Invite Users". The email is ' +
        'resolved to an existing user; when nobody has it the user is INVITED (created and the invitation ' +
        'email sent) unless `invite:false`. Existing members are preserved — the project\'s member list is ' +
        'merged, never replaced — and the membership is read back to confirm. Defaults to the connected ' +
        'project and to the project\'s QA role.',
      inputSchema: {
        email: z.string().describe('Email address of the person to add, e.g. someone@yopmail.com.'),
        projectId: z.string().optional().describe('Project id. Defaults to the connected project.'),
        roleId: z.number().optional().describe('Role id inside that project. Default 1 (the QA role).'),
        name: z.string().optional().describe('Display name — used only when the user has to be invited.'),
        invite: z.boolean().optional().describe('Invite the user when the email is unknown (default true). false = fail instead.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ email, projectId, roleId, name, invite }) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & Partial<ProjectWrites>) | null;
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.listProjectMembers || !adapter.addProjectMembers || !adapter.findUserByEmail) {
        return err('Adding project members is available only on a SimplifyQA connection.');
      }
      try {
        const info = (await adapter.info()) as unknown as { projectId?: string | number };
        const pid = (projectId ?? (info.projectId != null ? String(info.projectId) : '')).trim();
        if (!pid) return err('No project selected: pass `projectId` (or connect with qa_connect to a project).');
        const role = Number.isFinite(Number(roleId)) && Number(roleId) > 0 ? Number(roleId) : 1;

        let user = await adapter.findUserByEmail(email);
        let invited = false;
        if (!user) {
          if (invite === false) {
            return err(`No user has the email ${email}, and invite:false was passed. Nothing was changed.`);
          }
          if (!adapter.inviteUser) return err('Inviting a new user is available only on a SimplifyQA connection.');
          const created = await adapter.inviteUser({
            email,
            ...(name ? { name } : {}),
            roleId: role,
            projectId: pid,
          });
          invited = true;
          user = {
            id: created.id,
            ...(created.code ? { code: created.code } : {}),
            ...(name ? { name } : {}),
            email,
          };
        }

        const res = await adapter.addProjectMembers(pid, [{ userId: user.id, roleId: role }]);
        const members = await adapter.listProjectMembers(pid);
        const row = members.find((m) => m.userId === user!.id);
        if (!row) {
          return err(
            `The product did not persist the membership: user ${user.id} is not among the ${members.length} ` +
              `members of project ${pid} after the update.`,
          );
        }
        return ok(
          `${invited ? 'Invited' : 'Added'} ${user.email ?? email}` +
            `${user.code ? ` (${user.code})` : ''} to project ${pid} with role ${row.roleId}` +
            `${invited ? ' — invitation email sent' : ''}. Project now has ${members.length} member(s).`,
          {
            user: { id: user.id, ...(user.code ? { code: user.code } : {}), email: user.email ?? email },
            projectId: pid,
            roleId: row.roleId,
            invited,
            added: res.added,
            memberCount: members.length,
          },
        );
      } catch (e) {
        return err(`Could not add the user to the project: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    'project_user_remove',
    {
      title: 'Remove a user from a project (SimplifyQA)',
      description:
        'Remove ONE person from a project (their membership row only — the user account and the person\'s ' +
        'other projects are untouched). Identify them by `email` or `userId`; the remaining membership is ' +
        'read back to confirm and the removed list is reported. The project\'s other members are preserved.',
      inputSchema: {
        email: z.string().optional().describe('Email of the person to remove.'),
        userId: z.number().optional().describe('Numeric user id (alternative to email).'),
        projectId: z.string().optional().describe('Project id. Defaults to the connected project.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ email, userId, projectId }) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & Partial<ProjectWrites>) | null;
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.listProjectMembers || !adapter.removeProjectMembers) {
        return err('Removing project members is available only on a SimplifyQA connection.');
      }
      try {
        const info = (await adapter.info()) as unknown as { projectId?: string | number };
        const pid = (projectId ?? (info.projectId != null ? String(info.projectId) : '')).trim();
        if (!pid) return err('No project selected: pass `projectId` (or connect with qa_connect to a project).');

        let uid = Number.isFinite(Number(userId)) && Number(userId) > 0 ? Number(userId) : undefined;
        if (uid == null && email && adapter.findUserByEmail) {
          const found = await adapter.findUserByEmail(email);
          if (!found) return err(`No user has the email ${email}. Nothing was changed.`);
          uid = found.id;
        }
        if (uid == null) return err('Pass `email` or `userId`.');
        const res = await adapter.removeProjectMembers(pid, [uid]);
        const members = await adapter.listProjectMembers(pid);
        if (members.some((m) => m.userId === uid)) {
          return err(`The product did not remove user ${uid} from project ${pid} (still a member).`);
        }
        return ok(
          res.removed.length
            ? `Removed user ${uid} from project ${pid}. Project now has ${members.length} member(s).`
            : `User ${uid} was not a member of project ${pid}; nothing changed.`,
          { projectId: pid, removed: res.removed, memberCount: members.length },
        );
      } catch (e) {
        return err(`Could not remove the user from the project: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
