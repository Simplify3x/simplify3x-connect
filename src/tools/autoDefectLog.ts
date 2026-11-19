/**
 * Auto Defect Logging has TWO switches: the project's admin toggle (Project settings → Defect management)
 * and the suite's / execution plan's own `autoDefectLog`. SimplifyQA logs a defect only when both are on,
 * and its UI refuses the second while the first is off — so the MCP does the same and says what to do.
 * The backend also builds each logged defect from the admin's assignee / priority / state, and silently
 * logs nothing when they are missing — so a run says which of these is the reason.
 */

type AutoDefectStatus = { adminEnabled: boolean; configMissing?: string[] | undefined };
type AutoDefectProbe = {
  autoDefectLogStatus?: () => Promise<AutoDefectStatus | undefined>;
  autoDefectLogOf?: (kind: 'suite' | 'plan', id: string) => Promise<boolean | undefined>;
};

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

/** What to tell the user right after a suite / plan run starts: will a failed step log a defect, and if not, why and what to do.
 *  Best-effort — it never blocks or fails the run, and says nothing when the state cannot be read. */
export async function autoDefectLogRunNote(adapter: object, kind: 'suite' | 'plan', id: string): Promise<string | undefined> {
  try {
    const probe = adapter as AutoDefectProbe;
    const [flag, status] = await Promise.all([probe.autoDefectLogOf?.(kind, id), probe.autoDefectLogStatus?.()]);
    if (flag === undefined || !status) return undefined;
    const noun = kind === 'suite' ? 'suite' : 'execution plan';
    const enable = kind === 'suite'
      ? 'suite_manage { action:"update", suiteId, settings:{ autoDefectLog:true } }'
      : 'execution_plan { action:"update", planId, autoDefectLog:true }';
    if (flag && !status.adminEnabled) {
      return `⚠️ Auto defect logging is on for this ${noun}, but the project's admin switch is off — failed steps will NOT log defects. ${ADMIN_TOGGLE_OFF}`;
    }
    if (flag && status.configMissing?.length) {
      return `⚠️ Auto defect logging is on, but the admin has not set the ${status.configMissing.join(' / ')} that logged defects get (Admin → Project settings → Defect management), so defects may not be created.`;
    }
    if (!flag && status.adminEnabled) {
      return `ℹ️ Auto defect logging is OFF for this ${noun}, so failed steps will not log defects. Turn it on with ${enable}.`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
