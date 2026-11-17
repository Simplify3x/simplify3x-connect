import { zDraftOp, zJournalOp } from './schemas.js';

const ok = (schema: any, v: unknown) => expect(schema.safeParse(v).success).toBe(true);
const bad = (schema: any, v: unknown) => expect(schema.safeParse(v).success).toBe(false);

describe('the tool input schemas accept the new operations (and refuse malformed ones)', () => {
  for (const [name, schema] of [['draft', zDraftOp], ['journal', zJournalOp]] as const) {
    test(`${name}: duplicate_step`, () => {
      ok(schema, { op: 'duplicate_step', n: 4 });
      ok(schema, { op: 'duplicate_step', n: 4, at: 10 });
      ok(schema, { op: 'duplicate_step', n: 2, through: 5, at: 1 });
      bad(schema, { op: 'duplicate_step' });
      bad(schema, { op: 'duplicate_step', n: 0 });
    });
    test(`${name}: update_steps with every kind of criterion and patch`, () => {
      ok(schema, { op: 'update_steps', where: { actionType: 'Click' }, patch: { flags: { skip: true } } });
      ok(schema, { op: 'update_steps', where: { object: 'Login', stepType: 'web', from: 2, to: 9, descriptionContains: 'x', parameter: 'p', numbers: [1, 2] }, patch: { description: 'd' } });
      ok(schema, { op: 'update_steps', where: { all: true }, patch: { flags: { skip: false } } });
      bad(schema, { op: 'update_steps', patch: { flags: { skip: true } } });
      bad(schema, { op: 'update_steps', where: { from: -1 }, patch: {} });
    });
    test(`${name}: update_step carries swapParams, flags, action, object and recordedParam`, () => {
      ok(schema, { op: 'update_step', n: 3, patch: { swapParams: [{ from: 'username', to: 'admin_user', value: 'root' }, { from: 'a', to: 'b' }] } });
      ok(schema, { op: 'update_step', n: 3, patch: { actionType: 'Close', objectRef: { id: '777' }, flags: { skip: true }, recordedParam: { x: 'y' } } });
      bad(schema, { op: 'update_step', n: 3, patch: { swapParams: [{ from: 'a' }] } });
      bad(schema, { op: 'update_step', n: 3, patch: { swapParams: 'a->b' } });
    });
    test(`${name}: the new technology step types are accepted`, () => {
      for (const stepType of ['ios', 'desktop', 'sap', 'android', 'mainframe', 'database']) {
        ok(schema, { op: 'add_step', step: { description: 'd', actionType: 'a', stepType } });
      }
      bad(schema, { op: 'add_step', step: { description: 'd', actionType: 'a', stepType: 'nonsense' } });
    });
  }
  test('the pre-existing operations still validate (no regression)', () => {
    ok(zDraftOp, { op: 'remove_step', n: 2 });
    ok(zDraftOp, { op: 'move_step', n: 2, to: 5 });
    ok(zDraftOp, { op: 'set_meta', patch: { title: 't', folderOrModule: 'Login' } });
    ok(zJournalOp, { op: 'wrap_in_loop', from: 1, to: 3 });
    ok(zJournalOp, { op: 'insert_nested', tcId: '9' });
  });
});
