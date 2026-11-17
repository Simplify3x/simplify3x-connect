import { registerProjectTools } from './project.tools.js';

function setup() {
  const created: any[] = [];
  const deleted: any[] = [];
  const projects: Record<string, any> = {
    '9': { id: 9, code: 'PR-9', name: 'MCP Project Probe', description: 'probe' },
  };
  const adapter: any = {
    createProject: async (input: any) => {
      created.push(input);
      return { id: '9', created: true };
    },
    getProjectById: async (id: string) => projects[String(id).replace(/\D/g, '')] ?? {},
    deleteProject: async (id: string) => {
      deleted.push(id);
      return { deleted: true };
    },
  };
  const handlers: Record<string, (a: any) => Promise<any>> = {};
  const server: any = { registerTool: (n: string, _c: unknown, fn: (a: any) => Promise<any>) => { handlers[n] = fn; } };
  registerProjectTools(server, { getAdapter: () => adapter });
  return {
    create: (a: any) => handlers['project_create']!(a),
    del: (a: any) => handlers['project_delete']!(a),
    created,
    deleted,
  };
}

describe('project_create / project_delete', () => {
  test('create sends the name + description and reports the read-back code', async () => {
    const { create, created } = setup();
    const res = await create({ name: 'MCP Project Probe', description: 'probe' });
    expect(res.isError).toBeFalsy();
    expect(created[0]).toMatchObject({ name: 'MCP Project Probe', description: 'probe' });
    expect(res.content[0].text).toMatch(/Created project PR-9 "MCP Project Probe" \(id 9\)/);
  });

  test('a backend failure is reported as a tool error, not a crash', async () => {
    const handlers: Record<string, (a: any) => Promise<any>> = {};
    const server: any = { registerTool: (n: string, _c: unknown, fn: (a: any) => Promise<any>) => { handlers[n] = fn; } };
    registerProjectTools(server, {
      getAdapter: () => ({ createProject: async () => { throw new Error('HTTP 400 "Report Expiry Month" is required'); } }) as any,
    });
    const res = await handlers['project_create']!({ name: 'Bad Project' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Could not create the project: .*Report Expiry Month/);
  });

  test('delete previews first and only deletes with confirm:true', async () => {
    const { del, deleted } = setup();
    const preview = await del({ projectId: 'PR-9' });
    expect(preview.isError).toBeFalsy();
    expect(preview.content[0].text).toMatch(/About to delete project PR-9 "MCP Project Probe"/);
    expect(deleted).toHaveLength(0);

    const confirmed = await del({ projectId: 'PR-9', confirm: true });
    expect(confirmed.isError).toBeFalsy();
    expect(deleted[0]).toBe('9');
    expect(confirmed.content[0].text).toMatch(/Deleted project PR-9/);
  });
});
