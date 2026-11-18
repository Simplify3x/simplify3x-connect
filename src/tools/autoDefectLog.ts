/**
 * Auto Defect Logging has TWO switches: the project's admin toggle (Project settings → Defect management)
 * and the suite's / execution plan's own `autoDefectLog`. SimplifyQA logs a defect only when both are on,
 * and its UI refuses the second while the first is off — so the MCP does the same and says what to do.
 */

type AutoDefectProbe = { autoDefectLogStatus?: () => Promise<{ adminEnabled: boolean } | undefined> };

export const ADMIN_TOGGLE_OFF =
  'Auto Defect Logging is not enabled for this project. Ask a project admin to turn on "Auto Defect Logging" ' +
  '(Admin → Project settings → Defect management, with the assignee / priority / state the logged defects get), then try again.';

/** Returns the refusal text when `autoDefectLog:true` cannot take effect, else undefined (also when the
 *  admin setting cannot be read — the backend then stays the judge). */
export async function autoDefectLogRefusal(adapter: object, what: 'suite' | 'execution plan'): Promise<string | undefined> {
  const status = await (adapter as AutoDefectProbe).autoDefectLogStatus?.();
  if (!status || status.adminEnabled) return undefined;
  return `Not saved — the ${what}'s autoDefectLog was left unchanged. ${ADMIN_TOGGLE_OFF}`;
}

/** One line for a read-back: the suite/plan flag is on but nothing will be logged. */
export async function autoDefectLogNote(adapter: object, flagOn: boolean): Promise<string | undefined> {
  if (!flagOn) return undefined;
  const status = await (adapter as AutoDefectProbe).autoDefectLogStatus?.();
  return status && !status.adminEnabled ? `⚠️ No defect will be logged: ${ADMIN_TOGGLE_OFF}` : undefined;
}
