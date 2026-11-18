import { registerEnvironmentTools } from './environment.tools.js';

function setup() {
  const created: any[] = [];
  const updated: any[] = [];
  const adapter: any = {
    createEnvironment: async (input: any) => {
      created.push(input);
      return { id: 'env-1', key: input.key ?? 'CUSTFIELD_Mcp_env_7_abcde', name: input.name };
    },
    updateEnvironment: async (ref: string, patch: any) => {
      updated.push({ ref, patch });
      return { id: 'env-1', key: patch.key ?? 'k', name: patch.name ?? ref };
    },
  };
  const handlers: Record<string, (a: any) => Promise<any>> = {};
  const server: any = { registerTool: (n: string, _c: unknown, fn: (a: any) => Promise<any>) => { handlers[n] = fn; } };
  registerEnvironmentTools(server, { getAdapter: () => adapter });
  return { env: (a: any) => handlers['environment_manage']!(a), created, updated };
}

describe('environment_manage', () => {
  test('create passes the name through and reports the saved environment', async () => {
    const { env, created } = setup();
    const res = await env({ action: 'create', name: 'Mcp env' });
    expect(res.isError).toBeFalsy();
    expect(created[0]).toMatchObject({ name: 'Mcp env' });
    expect(res.content[0].text).toMatch(/Created environment "Mcp env"/);
  });

  test('update needs the existing environment, and reports the rename', async () => {
    const { env, updated } = setup();
    const missing = await env({ action: 'update', name: 'New' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/needs: environment/);

    const res = await env({ action: 'update', environment: 'Mcp env', name: 'Mcp env UAT' });
    expect(res.isError).toBeFalsy();
    expect(updated[0]).toMatchObject({ ref: 'Mcp env', patch: { name: 'Mcp env UAT' } });
    expect(res.content[0].text).toMatch(/Updated environment "Mcp env" → "Mcp env UAT"/);
  });

  test('delete is two-step: preview first, then the adapter call', async () => {
    const deleted: string[] = [];
    const handlers: Record<string, (a: any) => Promise<any>> = {};
    const server: any = { registerTool: (n: string, _c: unknown, fn: (a: any) => Promise<any>) => { handlers[n] = fn; } };
    registerEnvironmentTools(server, {
      getAdapter: () => ({ deleteEnvironment: async (ref: string) => { deleted.push(ref); return { id: 'e1', name: 'Tmp env', key: 'k' }; } }) as any,
    });
    const preview = await handlers['environment_manage']!({ action: 'delete', environment: 'Tmp env' });
    expect(preview.isError).toBeFalsy();
    expect(preview.content[0].text).toMatch(/About to delete environment "Tmp env"/);
    expect(deleted).toHaveLength(0);

    const done = await handlers['environment_manage']!({ action: 'delete', environment: 'Tmp env', confirm: true });
    expect(done.isError).toBeFalsy();
    expect(deleted).toEqual(['Tmp env']);
    expect(done.content[0].text).toMatch(/Deleted environment "Tmp env"/);
  });

  test('a refusal from the adapter is surfaced as a tool error', async () => {    const handlers: Record<string, (a: any) => Promise<any>> = {};
    const server: any = { registerTool: (n: string, _c: unknown, fn: (a: any) => Promise<any>) => { handlers[n] = fn; } };
    registerEnvironmentTools(server, {
      getAdapter: () => ({ createEnvironment: async () => { throw new Error('An environment named "Mcp env" already exists in this project.'); } }) as any,
    });
    const res = await handlers['environment_manage']!({ action: 'create', name: 'Mcp env' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/already exists/);
  });
});
