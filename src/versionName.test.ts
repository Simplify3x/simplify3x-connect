import { latestVersionId, nextVersionName } from './versionName.js';
import type { TestCase } from './domain/types.js';

const ver = (name: string) => ({ id: `id-${name}`, name });

const tcWith = (names: string[]): Pick<TestCase, 'versions'> => ({
  versions: names.map(ver),
});

describe('nextVersionName', () => {
  it('bumps v1.0 to v2.0', () => {
    expect(nextVersionName(tcWith(['v1.0']))).toBe('v2.0');
  });

  it('bumps the highest major', () => {
    expect(nextVersionName(tcWith(['v1.0', 'v2.0']))).toBe('v3.0');
    expect(nextVersionName(tcWith(['v3.0', 'v1.0', 'v2.0']))).toBe('v4.0');
  });

  it('ignores hand-named versions that do not match v<major>.<minor>', () => {
    expect(nextVersionName(tcWith(['Baseline', 'v2.0', 'hotfix run']))).toBe('v3.0');
  });

  it('defaults to v2.0 when nothing parses', () => {
    expect(nextVersionName(tcWith(['Baseline']))).toBe('v2.0');
    expect(nextVersionName(tcWith([]))).toBe('v2.0');
    expect(nextVersionName(null)).toBe('v2.0');
  });

  it('is case-insensitive and tolerates surrounding spaces', () => {
    expect(nextVersionName(tcWith([' V1.0 ']))).toBe('v2.0');
  });
});

describe('latestVersionId', () => {
  it('picks the highest v<major>.<minor>', () => {
    expect(latestVersionId(tcWith(['v1.0', 'v2.0']))).toBe('id-v2.0');
    expect(latestVersionId(tcWith(['v2.0', 'v1.0']))).toBe('id-v2.0');
    expect(latestVersionId(tcWith(['v1.0', 'v10.0', 'v9.0']))).toBe('id-v10.0');
  });

  it('ignores hand-named versions and empty lists', () => {
    expect(latestVersionId(tcWith(['v1.0', 'Baseline']))).toBe('id-v1.0');
    expect(latestVersionId(tcWith(['Baseline']))).toBeUndefined();
    expect(latestVersionId(null)).toBeUndefined();
  });
});
