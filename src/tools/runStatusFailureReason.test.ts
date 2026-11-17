import { registerRunTools } from './run.tools.js';

async function runStatus(stepResults: Array<{ n: number; description: string; status: string; error?: string }>) {
  const adapter: any = {
    getRun: async () => ({ runId: '424812', state: 'failed', stepResults, reportUrl: 'https://x/user/reports/reports-page?type=TESTCASE&parentId=1&id=424812&projectId=25' }),
  };
  const handlers = new Map<string, (x: any) => Promise<any>>();
  registerRunTools({ registerTool: (n: string, _c: unknown, fn: (x: any) => Promise<any>) => { handlers.set(n, fn); } } as any,
    { getAdapter: () => adapter } as any);
  return (await handlers.get('run_status')!({ runId: '424812' })).content[0].text as string;
}

describe('run_status: a failed DB / API step always says why, or that nothing was reported', () => {
  test('a reported reason is shown (DB plugin error line)', async () => {
    const text = await runStatus([
      { n: 1, description: 'Connect to DB', status: 'passed' },
      { n: 2, description: 'Execute Query', status: 'failed', error: "Fail to executeQuery : No active SQL database connection - add a 'Connect to DB' step before this one" },
    ]);
    expect(text).toContain('**Failed at:**');
    expect(text).toContain('No active SQL database connection');
    expect(text).not.toContain('no error text was reported');
  });

  test('a failed step with NO reason is flagged, in the failed summary and in the step list', async () => {
    const text = await runStatus([{ n: 3, description: 'Update', status: 'failed' }]);
    expect((text.match(/no error text was reported/g) ?? []).length).toBe(2);
    expect(text).toContain('check the agent log');
  });

  test('a passed step is never given that note', async () => {
    const text = await runStatus([{ n: 1, description: 'Connect to DB', status: 'passed' }]);
    expect(text).not.toContain('no error text was reported');
  });
});
