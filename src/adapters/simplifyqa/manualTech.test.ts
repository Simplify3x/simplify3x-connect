import { buildTestcasePayload } from './mapper.js';

/** A MANUAL draft keeps the technology the caller asked for instead of always WEB. */
function manual(over: Record<string, unknown> = {}): any {
  return {
    title: 'Manual case', category: 'manual', folderOrModule: '1',
    steps: [{ n: 1, description: 'Open the app', expectedResult: 'It opens', stepType: 'manual', actionType: 'manual' }],
    ...over,
  };
}

const payload = (tc: any) => buildTestcasePayload({ projectId: 7, moduleId: 3, tc, paramIdByName: new Map() }) as any;

describe('manual test case technology', () => {
  test('defaults to WEB when the caller names none', () => {
    expect(payload(manual()).tcfnObj.tcType).toBe('WEB');
  });

  test('honours DESKTOP / ANDROID / IOS / API instead of forcing WEB', () => {
    for (const tech of ['DESKTOP', 'ANDROID', 'IOS', 'API', 'DATABASE', 'MAINFRAME', 'SAP', 'WEB']) {
      expect(payload(manual({ technologyType: tech })).tcfnObj.tcType).toBe(tech);
    }
  });

  test('accepts a lower-case technology', () => {
    expect(payload(manual({ technologyType: 'desktop' })).tcfnObj.tcType).toBe('DESKTOP');
  });

  test('an unknown technology is refused, never silently saved as WEB', () => {
    expect(() => payload(manual({ technologyType: 'SMART-TV' }))).toThrow(/Unknown technology "SMART-TV"/);
  });

  test('an explicit technology wins over the copied raw doc on re-save', () => {
    const tc = manual({ technologyType: 'ANDROID', sourceTc: { tcType: 'WEB', name: 'Manual case' } });
    expect(payload(tc).tcfnObj.tcType).toBe('ANDROID');
  });
});
