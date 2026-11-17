/**
 * The test case name each recording was started with (`core_activate_technology`'s `testcaseName`), keyed by the
 * session id the recorder returned. `tc_save`'s journal fallback names the test case with it: the recorder can keep
 * one session id for many recordings (the agent keeps it until it restarts), so a name built from the session id
 * repeats, and the backend refuses the second test case. Process-local and in memory only.
 */
const names = new Map<string, string>();

export function rememberRecordingName(sessionId: string, name: string): void {
  const n = name.trim();
  if (sessionId && n) names.set(sessionId, n);
}

export function recordingName(sessionId: string): string | undefined {
  return names.get(sessionId);
}
