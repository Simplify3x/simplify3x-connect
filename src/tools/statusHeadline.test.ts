import { statusText } from './run.tools.js';
import type { RunStatus } from '../domain/types.js';

const base = (warning?: string): RunStatus => ({
  runId: 'EX-1', state: 'passed',
  stepResults: [{ n: 1, description: 'Read Documents', status: 'passed', ...(warning ? { warning } : {}) }],
});

describe('statusText headline', () => {
  it('flags a green run that carries a step warning', () => {
    const t = statusText(base('read returned []'));
    expect(t).toContain('**passed, but 1 step(s) need attention**');
    expect(t).toContain('step 1: read returned []');
  });
  it('leaves a clean passed run unchanged', () => {
    expect(statusText(base())).toContain('Run EX-1 · **passed**');
  });
});
