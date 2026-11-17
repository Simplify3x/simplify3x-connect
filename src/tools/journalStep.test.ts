import { normalizeJournalStep } from './testcase.tools.js';
import { isApiRequestStep } from '../adapters/simplifyqa/mapper.js';
import type { Step } from '../domain/types.js';

const step = (over: Partial<Step> & Record<string, unknown>): Step =>
  ({ n: 1, description: 'd', actionType: 'x', stepType: 'web', ...over }) as Step;

describe('normalizeJournalStep — API recordings', () => {
  it('turns a step that carries apiData into a real API step', () => {
    const apiData = { requestData: { httpData: { url: 'https://x' } }, inputParameters: [] };
    const out = normalizeJournalStep(step({ description: 'POST /x', actionType: 'API Call', apiData } as never));
    expect(out.stepType).toBe('api');
    expect(out.api).toEqual(apiData);
    // A real request is what the save builder routes to an action-less API step.
    expect(isApiRequestStep(out)).toBe(true);
  });

  it('keeps a GENERIC action recorded inside an API session as an API-technology step, with no request', () => {
    // The journal stamps the session technology ("api") on EVERY step, so "Generate Random
    // Alphanumeric" arrives as stepType 'api' with no apiData. That is a legitimate
    // API-TECHNOLOGY step with a real action (the backend stores requests and generic actions
    // alike under stepType 'API'): the save builder tells them apart with isApiRequestStep() —
    // payload vs actionId — so the step must keep its action. Forcing it to 'web' misfiles the
    // action under another technology, and attaching an empty `api` payload would save it as an
    // action-less API request (its action and parameters vanish, the run dies at startup).
    const s = step({
      description: 'Generate 8-char case group name',
      actionType: 'Generate Random Alphanumeric',
      stepType: 'api',
      technologyType: 'API',
    } as never);
    const out = normalizeJournalStep(s);
    expect(out).toBe(s);
    expect(out.stepType).toBe('api');
    expect(out.api).toBeUndefined();
    expect(isApiRequestStep(out)).toBe(false);
  });

  it('leaves an ordinary web step alone', () => {
    const s = step({ actionType: 'Click' });
    expect(normalizeJournalStep(s)).toBe(s);
  });

  it('does not touch a real API step that already carries the neutral `api`', () => {
    const s = step({ stepType: 'api', api: { requestData: {} } });
    expect(normalizeJournalStep(s)).toBe(s);
  });
});
