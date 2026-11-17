import { buildTestcasePayload } from './mapper.js';
import { SimplifyQaAdapter } from './adapter.js';

/**
 * A step read from the backend and then re-added ("insert the same step again") arrives with
 * ID-keyed recordedParam (`{"7001": "sub_ln"}`), because that is how the backend stores it. The
 * save path must bind that ID — not look "7001" up as a parameter NAME, which created/bound a
 * different parameter and silently replaced the step's original one.
 */
describe('an all-digit recordedParam key is a parameter id, never a name', () => {
  const save = (step: Record<string, unknown>, paramIdByName = new Map<string, number>()) => {
    const steps = [step];
    return (buildTestcasePayload({
      projectId: 19, moduleId: 7, existingId: '42',
      tc: { id: 'TC_42', title: 't', priority: 'medium', category: 'automated', steps } as any,
      paramIdByName,
      stepResolutions: [{ actionId: 354, objectId: 1098 }],
    } as any) as any).steps.automationSteps[0];
  };

  test('a re-added step keeps the original parameter id and value', () => {
    const out = save({
      n: 1, description: 'Set the sub line', actionType: '354', stepType: 'web',
      objectRef: { id: '1098' }, recordedParam: { '7001': 'sub_ln' },
    });
    expect(out.parameterIds).toEqual([7001]);
    expect(out.recordedParam).toEqual({ '7001': 'sub_ln' });
  });

  test('the numeric key does not win over the real parameter the description names', () => {
    // `${sub_ln}` is parameter 2124; the id-keyed value patches that SAME parameter.
    const out = save({
      n: 1, description: 'Set the sub line ${sub_ln}', actionType: '354', stepType: 'web',
      objectRef: { id: '1098' }, recordedParam: { '2124': 'Sub_Ln_42' },
    }, new Map([['sub_ln', 2124]]));
    expect(out.parameterIds).toEqual([2124]);
    expect(out.recordedParam).toEqual({ '2124': 'Sub_Ln_42' });
  });

  test('a name key still resolves through the project parameter dict', () => {
    const out = save({
      n: 1, description: 'Set the sub line', actionType: '354', stepType: 'web',
      objectRef: { id: '1098' }, recordedParam: { sub_ln: 'Sub_Ln_42' },
    }, new Map([['sub_ln', 2124]]));
    expect(out.parameterIds).toEqual([2124]);
    expect(out.recordedParam).toEqual({ '2124': 'Sub_Ln_42' });
  });
});

describe('resolveParamIds never creates a parameter named after an id', () => {
  const resolve = async (step: Record<string, unknown>) => {
    const a: any = Object.create(SimplifyQaAdapter.prototype);
    const created: string[] = [];
    a.runtimeSlotNames = async () => [];
    a.findParameterId = async () => null;
    a.getOrCreateParameter = async (_p: number, _m: number, name: string) => { created.push(name); return 900; };
    const map: Map<string, number> = await a.resolveParamIds(19, 7, { steps: [step] } as any);
    return { map, created };
  };

  test('a numeric recordedParam key maps to its own id and creates nothing', async () => {
    const { map, created } = await resolve({
      n: 1, description: 'Set the sub line', actionType: '354', stepType: 'web', recordedParam: { '7001': 'sub_ln' },
    });
    expect(created).toEqual([]);
    expect(map.get('7001')).toBe(7001);
  });

  test('a name key is still get-or-created as before', async () => {
    const { map, created } = await resolve({
      n: 1, description: 'Set the sub line', actionType: '354', stepType: 'web', recordedParam: { sub_ln: 'Sub_Ln_42' },
    });
    expect(created).toEqual(['sub_ln']);
    expect(map.get('sub_ln')).toBe(900);
  });

  test('a numeric token inside a DATABASE argument is not created either', async () => {
    const { created } = await resolve({
      n: 1, description: 'Run query', actionType: '156', stepType: 'database',
      recordedParam: { filter: '{"id": "{{7001}}"}' },
    });
    expect(created).not.toContain('7001');
    expect(created).toContain('filter');       // the argument's own name is still a real parameter
  });

  test('a numeric ${token} in the description is not created as a name', async () => {
    const { created } = await resolve({
      n: 1, description: 'Set the sub line ${7001}', actionType: '354', stepType: 'web',
    });
    expect(created).toEqual([]);
  });
});
