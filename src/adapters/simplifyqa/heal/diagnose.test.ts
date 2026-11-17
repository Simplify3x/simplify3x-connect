import { normaliseDiagnosis, normaliseFamily, normaliseProposal, normaliseProposals } from './diagnose.js';

describe('heal diagnose normalisation', () => {
  test('maps server vocabulary onto the heal families', () => {
    expect(normaliseFamily('object')).toBe('object_state');
    expect(normaliseFamily('Element_Not_Found')).toBe('locator');
    expect(normaliseFamily('timing')).toBe('timeout');
    expect(normaliseFamily('product_bug')).toBe('app_bug');
    expect(normaliseFamily('nonsense')).toBe('unrecognised');
  });

  test('clamps confidence and keeps evidence objects only', () => {
    const d = normaliseDiagnosis({ family: 'locator', confidence: 3, evidence: [{ step: 2 }, 'junk', null] });
    expect(d.confidence).toBe(1);
    expect(d.evidence).toHaveLength(1);
  });

  test('accepts a well-formed locator proposal', () => {
    const { proposal, problem } = normaliseProposal({
      domain: 'object', op: 'append_locator', objectId: '8812', step: 4,
      locator: { name: 'css', value: '#go', unique: true }, confidence: 0.8,
    });
    expect(problem).toBeUndefined();
    expect(proposal).toMatchObject({ domain: 'object', op: 'append_locator', objectId: '8812', step: 4 });
  });

  test('drops proposals that cannot be trusted, with a reason', () => {
    expect(normaliseProposal({ domain: 'nope', op: 'x' }).problem).toMatch(/unknown domain/);
    expect(normaliseProposal({ domain: 'object', op: 'append_locator', objectId: '1' }).problem).toMatch(/needs locator/);
    expect(normaliseProposal({ domain: 'action', op: 'repoint_action', step: 2 }).problem).toMatch(/actionType/);
    expect(normaliseProposal({ domain: 'testdata', op: 'set_cell', paramName: 'p', iterations: [] }).problem).toMatch(/iterations/);
  });

  test('a non-array proposals payload is reported, not thrown', () => {
    const res = normaliseProposals(undefined);
    expect(res.proposals).toHaveLength(0);
    expect(res.dropped[0]?.reason).toContain('no proposals');
  });
});
