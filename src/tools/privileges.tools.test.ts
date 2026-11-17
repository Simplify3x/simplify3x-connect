import {
  buildPrivilegeReport,
  requiredForTechnology,
  RECORD_REQUIRED,
} from './privileges.tools.js';

const FULL = [
  ...RECORD_REQUIRED,
  'view_testcase',
  'view_parameter',
  'view_object',
  'view_function',
  'view_testdata',
  'view_requirementmanagement',
];

const base = {
  projectId: '1',
  userId: '36',
  roleId: 1,
  roleName: 'QA',
  hasRole: true,
  tokenValid: true,
  privileges: [...FULL],
};

describe('requiredForTechnology', () => {
  it('adds mobile integration keys for ANDROID / IOS only', () => {
    expect(requiredForTechnology('ANDROID')).toEqual(['allow_mobile_integration', 'mobile_automation']);
    expect(requiredForTechnology('ios')).toEqual(['allow_mobile_integration', 'mobile_automation']);
    expect(requiredForTechnology('MAINFRAME')).toEqual(['mainframe_automation']);
    expect(requiredForTechnology('WEB')).toEqual([]);
    expect(requiredForTechnology('API')).toEqual([]);
    expect(requiredForTechnology(undefined)).toEqual([]);
  });

  it('adds allow_cloud_integration for cloud device providers', () => {
    expect(requiredForTechnology('ANDROID', 'lambdatest')).toContain('allow_cloud_integration');
    expect(requiredForTechnology('IOS', 'browserstack')).toContain('allow_cloud_integration');
    expect(requiredForTechnology('ANDROID', 'local')).not.toContain('allow_cloud_integration');
  });
});

describe('buildPrivilegeReport', () => {
  it('is ok when every required key is held', () => {
    const r = buildPrivilegeReport(base);
    expect(r.verdict).toBe('ok');
    expect(r.missing).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.role).toEqual({ id: 1, name: 'QA' });
    expect(r.can['recordTestCase']).toBe(true);
    expect(r.can['createObject']).toBe(true);
    expect(r.can['createParameter']).toBe(true);
    expect(r.hint).toBeUndefined();
  });

  it('refuses when a creation privilege is missing and names the exact keys', () => {
    const r = buildPrivilegeReport({ ...base, privileges: FULL.filter((p) => p !== 'add_parameter') });
    expect(r.verdict).toBe('missing-privileges');
    expect(r.missing).toEqual(['add_parameter']);
    expect(r.can['createParameter']).toBe(false);
    expect(r.hint).toContain('add_parameter');
    expect(r.hint).toContain('QA');
  });

  it('refuses for add_object even though the backend does not gate object creation', () => {
    const r = buildPrivilegeReport({ ...base, privileges: FULL.filter((p) => p !== 'add_object') });
    expect(r.verdict).toBe('missing-privileges');
    expect(r.missing).toEqual(['add_object']);
  });

  it('reports no-role with a switch-project hint', () => {
    const { roleId: _rid, roleName: _rname, ...noRoleBase } = base;
    const r = buildPrivilegeReport({ ...noRoleBase, hasRole: false, privileges: [] });
    expect(r.verdict).toBe('no-role');
    expect(r.hasRole).toBe(false);
    expect(r.hint).toContain('qa_switch_project');
  });

  it('reports invalid-token before anything else and never claims a role', () => {
    const r = buildPrivilegeReport({ ...base, tokenValid: false, hasRole: false, privileges: [] });
    expect(r.verdict).toBe('invalid-token');
    expect(r.hint).toContain('qa_connect');
  });

  it('warns (does not block) when only advisory read keys are missing', () => {
    const r = buildPrivilegeReport({
      ...base,
      privileges: [...RECORD_REQUIRED, 'view_testcase'],
    });
    expect(r.verdict).toBe('ok');
    expect(r.missing).toEqual([]);
    expect(r.warnings).toEqual(
      expect.arrayContaining(['view_parameter', 'view_object', 'view_function', 'view_testdata']),
    );
    expect(r.hint).toContain('Recordable');
  });

  it('blocks Android recording without the mobile integration keys', () => {
    const r = buildPrivilegeReport(base, { technology: 'ANDROID' });
    expect(r.verdict).toBe('missing-privileges');
    expect(r.missing).toEqual(
      expect.arrayContaining(['allow_mobile_integration', 'mobile_automation']),
    );
  });

  it('honours extra `need` keys', () => {
    const r = buildPrivilegeReport(base, { need: ['add_userstory'] });
    expect(r.missing).toEqual(['add_userstory']);
  });

  it('does not duplicate a key required by both the common set and the technology', () => {
    const r = buildPrivilegeReport(base, { need: ['add_testcase'] });
    expect(r.required.filter((k) => k === 'add_testcase')).toHaveLength(1);
  });
});
