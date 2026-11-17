import { buildTestcasePayload } from './mapper.js';
import type { TestCase } from '../../domain/types.js';

/** Validates the automation `testcaseObj` payload shape against the real SQA TC-584 sample
 *  (WEB variant here — Android differs only in tcType + executionPlatform requirement). If a
 *  future SQA change adds a new required field on `automationSteps[]`, this test breaks first
 *  instead of a 400 on a real save. */

function paramMap(...pairs: Array<[string, number]>): Map<string, number> {
  return new Map(pairs);
}

test('WEB automation payload matches the SQA saved-TC shape', () => {
  const tc: TestCase = {
    title: 'Login smoke',
    priority: 'medium',
    category: 'automated',
    folderOrModule: '1',
    steps: [
      { n: 1, description: 'Launch app', actionType: 'Launch Application', stepType: 'web',
        recordedParam: { url: 'https://app.example.com' } },
      { n: 2, description: 'Click Sign In', actionType: 'Click', stepType: 'web',
        objectRef: { name: 'Sign In button', locators: [{ name: 'id', value: 'signin-btn' }] } },
    ],
  };
  const payload = buildTestcasePayload({
    projectId: 1,
    moduleId: 1,
    tc,
    paramIdByName: paramMap(['url', 500]),
    stepResolutions: [
      { actionId: 178, objectId: null },  // Launch: no object
      { actionId: 164, objectId: 400 },   // Click: object required
    ],
  });

  const tcfnObj = payload['tcfnObj'] as Record<string, unknown>;
  expect(tcfnObj['tcType']).toBe('WEB');
  expect(tcfnObj['executionType']).toBe('AUTOMATION');
  expect(tcfnObj['originalExecutinType']).toBe('AUTOMATION');
  expect(tcfnObj['mailersList']).toEqual({ users: [], nonUsers: [], groups: [] });
  expect(tcfnObj['suiteId']).toEqual([]);
  // Review/approve status is per VERSION, so it lives on versionsDetails now, not on tcfnObj
  // (commit c3503ad: "TC save fidelity" — mirrors the UI payload).
  expect(tcfnObj['reviewApproveStatus']).toBeUndefined();
  expect(tcfnObj['executionPlatform']).toBeUndefined();   // WEB → backend defaults to Chrome

  const versionsDetails = payload['versionsDetails'] as Record<string, unknown>;
  expect(versionsDetails).toEqual({
    name: 'v1.0', id: '', syncONOFF: '',
    manualStepsTopreview: false, updateVersion: 0,
    executionType: 'AUTOMATION', reviewApproveStatus: '', functionProjectIds: [1],
  });

  const steps = payload['steps'] as { automationSteps: Array<Record<string, unknown>>; manualSteps: unknown[] };
  expect(steps.manualSteps).toEqual([]);
  expect(steps.automationSteps).toHaveLength(2);

  const launch = steps.automationSteps[0]!;
  expect(launch['actionId']).toBe(178);
  expect(launch['objectId']).toBeNull();
  expect(launch['stepType']).toBe('NORMAL_STATEMENT');
  expect(launch['technologyType']).toBe('WEB');
  // browserType is only emitted when the caller explicitly set one (commit 9012607: a re-save must not
  // stamp CHROME onto every step) — WEB defaults to Chrome in the backend.
  expect(launch['browserType']).toBeUndefined();
  expect(launch['executionType']).toBe('AUTOMATION');
  expect(launch['parameterIds']).toEqual([500]);
  expect(launch['recordedParam']).toEqual({ '500': 'https://app.example.com' });
  expect(launch['conditions']).toEqual({ ifstring: '', children: [] });
  expect(launch['loop']).toEqual({ loopType: 'for', loopIteration: null });
  expect(launch['stepLevelActions']).toEqual({
    skip: false, captureScreenshot: false, continueOnFailure: false, skippedReport: false,
  });
  expect(launch['attachments']).toEqual([]);
  expect(launch['objectParameterIds']).toEqual([]);

  const click = steps.automationSteps[1]!;
  expect(click['actionId']).toBe(164);
  expect(click['objectId']).toBe(400);
  expect(click['parameterIds']).toEqual([]);
  expect(click['recordedParam']).toEqual({});
});

test('ANDROID automation refuses save without an executionPlatform', () => {
  const tc: TestCase = {
    title: 'Android smoke',
    priority: 'medium',
    category: 'automated',
    folderOrModule: '1',
    steps: [{ n: 1, description: 'Launch', actionType: 'Launch App', stepType: 'android' }],
  };
  expect(() =>
    buildTestcasePayload({
      projectId: 1, moduleId: 1, tc,
      paramIdByName: new Map(),
      stepResolutions: [{ actionId: 999, objectId: null }],
    }),
  ).toThrow(/executionPlatform/);
});

test('ANDROID automation payload carries the caller-supplied executionPlatform', () => {
  const tc: TestCase = {
    title: 'Zoom tc',
    priority: 'medium',
    category: 'automated',
    folderOrModule: '1',
    executionPlatform: {
      id: '52000422ca838659',
      name: 'samsung-sm_m305f-52000422ca838659',
      technologyType: 'ANDROID',
      type: 'REAL_DEVICE',
    },
    steps: [
      { n: 1, description: 'Start the app', actionType: 'Launch App', stepType: 'android',
        recordedParam: { packageName: 'us.zoom.videomeetings', activity: 'com.zipow.videobox.LauncherActivity' } },
    ],
  };
  const payload = buildTestcasePayload({
    projectId: 1, moduleId: 1, tc,
    paramIdByName: paramMap(['packageName', 1140], ['activity', 1141]),
    stepResolutions: [{ actionId: 178, objectId: null }],
  });
  const tcfnObj = payload['tcfnObj'] as Record<string, unknown>;
  expect(tcfnObj['tcType']).toBe('ANDROID');
  expect(tcfnObj['executionPlatform']).toEqual({
    id: '52000422ca838659',
    name: 'samsung-sm_m305f-52000422ca838659',
    technologyType: 'ANDROID',
    type: 'REAL_DEVICE',
  });
  const step = (payload['steps'] as { automationSteps: Array<Record<string, unknown>> }).automationSteps[0]!;
  expect(step['technologyType']).toBe('ANDROID');
  expect(step['browserType']).toBeUndefined();  // Android has no browser
  expect(step['parameterIds']).toEqual([1140, 1141]);
  expect(step['recordedParam']).toEqual({
    '1140': 'us.zoom.videomeetings',
    '1141': 'com.zipow.videobox.LauncherActivity',
  });
});

test('manual save is unchanged — same wire shape as before', () => {
  const tc: TestCase = {
    title: 'Login (manual)',
    priority: 'medium',
    category: 'manual',
    folderOrModule: '1',
    steps: [
      { n: 1, description: 'Open ${appUrl}', actionType: '', stepType: 'manual', value: 'https://app.example.com' },
    ],
  };
  const payload = buildTestcasePayload({
    projectId: 1, moduleId: 1, tc,
    paramIdByName: paramMap(['appUrl', 501]),
  });
  const tcfnObj = payload['tcfnObj'] as Record<string, unknown>;
  expect(tcfnObj['executionType']).toBe('MANUAL');
  expect(tcfnObj['tcType']).toBe('WEB');
  expect(tcfnObj['originalExecutinType']).toBeUndefined();  // manual doesn't emit this
  const steps = payload['steps'] as { automationSteps: unknown[]; manualSteps: Array<Record<string, unknown>> };
  expect(steps.automationSteps).toEqual([]);
  expect(steps.manualSteps[0]!['executionType']).toBe('MANUAL');
  expect(steps.manualSteps[0]!['parameterIds']).toEqual([501]);
  // No automation-only fields leak into manual
  expect(steps.manualSteps[0]!['actionId']).toBeUndefined();
  // Manual steps now ALWAYS emit recordedParam ({paramId: value}) — the UI payload does too, and the
  // loader-mutator-saver backend relies on presence. No test data here → the parameter's default ''.
  expect(steps.manualSteps[0]!['recordedParam']).toEqual({ '501': '' });
});
