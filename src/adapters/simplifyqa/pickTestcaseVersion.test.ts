import { pickTestcaseVersion } from './adapter.js';

const TC = {
  id: 12826, code: 'TC-12826',
  versionId: 'v1-id', versionName: 'v1.0',
  versions: [
    { id: 'v1-id', name: 'v1.0' },
    { id: 'v2-id', name: 'v2.0' },
  ],
};

describe('pickTestcaseVersion', () => {
  test('no request → the test case\'s current version', () => {
    expect(pickTestcaseVersion(TC)).toEqual({ versionId: 'v1-id', versionName: 'v1.0' });
  });

  test('picks a version by NAME (case-insensitive)', () => {
    expect(pickTestcaseVersion(TC, undefined, 'V2.0')).toEqual({ versionId: 'v2-id', versionName: 'v2.0' });
  });

  test('picks a version by ID', () => {
    expect(pickTestcaseVersion(TC, 'v2-id')).toEqual({ versionId: 'v2-id', versionName: 'v2.0' });
  });

  test('an unknown version is an error that lists the real ones', () => {
    expect(() => pickTestcaseVersion(TC, undefined, 'v9.0')).toThrow(/TC-12826 has no version "v9\.0"\. Available versions: v1\.0 \(v1-id\), v2\.0 \(v2-id\)/);
  });
});
