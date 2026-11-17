import { registerCloseSessionWithSaveGuard } from './recording.tools.js';

/** Register the wrapped core_close_session against a fake server/agent and capture what it sends to the agent. */
function setup(unsavedSteps: number) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const adapter: any = {
    callRaw: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === 'core_active_recordings') {
        return { structuredContent: { recordings: unsavedSteps ? [{ sessionId: 's1', mcpSessionKey: 'stdio', stepCount: unsavedSteps }] : [] } };
      }
      return { content: [{ type: 'text', text: 'closed' }] };
    },
  };
  let handler: ((a: any) => Promise<any>) | undefined;
  let config: any;
  const server: any = { registerTool: (_n: string, cfg: unknown, fn: (a: any) => Promise<any>) => { config = cfg; handler = fn; } };
  const deps: any = { getAdapter: () => adapter, drafts: { listUnsavedRecordings: () => [] } };
  registerCloseSessionWithSaveGuard(server, deps, { name: 'core_close_session', description: 'close' } as any);
  return { call: (a: any) => handler!(a), calls, config };
}

describe('core_close_session wrapper: keep the recorder open', () => {
  test('keepRecorderOpen closes only the browser: no guard probe, no refusal, flag forwarded', async () => {
    const { call, calls } = setup(9);
    const res = await call({ keepRecorderOpen: true });
    expect(res.isError).toBeFalsy();
    expect(calls.map((c) => c.name)).toEqual(['core_close_session']);       // the unsaved-steps probe is skipped
    expect(calls[0]!.args).toEqual({ keepRecorderOpen: true });
  });

  test('a plain close with unsaved steps is still refused, and the refusal offers the keep-open option', async () => {
    const { call, calls } = setup(9);
    const res = await call({});
    expect(res.isError).toBe(true);
    const text = res.content[0].text as string;
    expect(text).toContain('KEEP THE RECORDER');
    expect(text).toContain('keepRecorderOpen: true');
    expect(text).toContain('confirm:');                                       // the discard path is unchanged
    expect(calls.map((c) => c.name)).toEqual(['core_active_recordings']);     // nothing was closed
  });

  test('closeTestcaseWindow is forwarded to the agent; nothing unsaved -> a plain close passes through', async () => {
    const { call, calls } = setup(0);
    await call({ closeTestcaseWindow: true });
    expect(calls.at(-1)).toEqual({ name: 'core_close_session', args: { closeTestcaseWindow: true } });
    const plain = setup(0);
    await plain.call({});
    expect(plain.calls.at(-1)).toEqual({ name: 'core_close_session', args: {} });
  });

  test('both options are in the tool schema, so the client does not strip them', () => {
    const { config } = setup(0);
    expect(Object.keys(config.inputSchema).sort()).toEqual(['closeTestcaseWindow', 'confirm', 'keepRecorderOpen']);
  });
});
