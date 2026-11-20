import { describe, expect, it } from '@jest/globals';
import { shareParamValuesAcrossSteps } from './mapper.js';

const step = (over: Record<string, unknown>): Record<string, unknown> => ({
  objectParameterIds: [], parameterIds: [], recordedParam: {}, ...over,
});

describe('a parameter used by two steps keeps its value in the one test-data cell', () => {
  it('moves a later step\'s value to the first step (the backend seeds the cell from the first only)', () => {
    const steps = [
      step({ objectParameterIds: [7], recordedParam: {} }),
      step({ objectParameterIds: [7], recordedParam: { '7': 'Medical' } }),
    ];
    shareParamValuesAcrossSteps(steps);
    expect((steps[0]!['recordedParam'] as any)['7']).toBe('Medical');
    expect((steps[1]!['recordedParam'] as any)['7']).toBe('Medical');
  });

  it('never overrides a value the first step already has', () => {
    const steps = [
      step({ parameterIds: [7], recordedParam: { '7': 'first' } }),
      step({ parameterIds: [7], recordedParam: { '7': 'second' } }),
    ];
    shareParamValuesAcrossSteps(steps);
    expect((steps[0]!['recordedParam'] as any)['7']).toBe('first');
  });

  it('leaves unrelated parameters, deleted steps and blank values alone', () => {
    const steps = [
      step({ parameterIds: [1], recordedParam: {} }),
      step({ parameterIds: [2], recordedParam: { '2': 'x' } }),
      step({ deleted: true, parameterIds: [1], recordedParam: { '1': 'gone' } }),
      step({ parameterIds: [1], recordedParam: { '1': '  ' } }),
    ];
    shareParamValuesAcrossSteps(steps);
    expect(steps[0]!['recordedParam']).toEqual({});
    expect(steps[1]!['recordedParam']).toEqual({ '2': 'x' });
  });
});
