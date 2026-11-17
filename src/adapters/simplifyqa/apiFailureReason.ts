/**
 * Why an API step failed, read from the step's stored `apiData` (the agent's APIReport as the backend keeps it).
 *
 * A failed ASSERTION raises no exception and writes no ERROR log line — the agent only records, per assertion, its
 * status / expected / actual — so a failed API step used to reach the caller with no reason (or with the last INFO
 * log line, "Received HTTP Response: Status=404", standing in for one). This turns that record into the reason.
 *
 * Returns undefined when `apiData` holds nothing explaining the failure.
 */
export function apiFailureReason(api: unknown): string | undefined {
  if (!api || typeof api !== 'object') return undefined;
  const a = api as {
    assertions?: unknown;
    responseData?: { statusCode?: unknown; responseTime?: unknown; responseBody?: unknown };
  };
  const parts: string[] = [];

  const assertions = Array.isArray(a.assertions) ? (a.assertions as Array<Record<string, unknown>>) : [];
  const failed = assertions.filter((x) => String(x?.['status'] ?? '').toUpperCase() === 'FAILED');
  for (const x of failed.slice(0, 5)) {
    const target = String(x['path'] ?? x['key'] ?? '').trim() || 'assertion';
    const cond = String(x['condition'] ?? '').toLowerCase().replace(/_/g, ' ');
    parts.push(`assertion failed: ${target} ${cond} expected "${x['expectedValue'] ?? ''}", actual "${x['actualValue'] ?? ''}"`);
  }
  if (failed.length > 5) parts.push(`… and ${failed.length - 5} more failed assertion(s)`);

  const status = Number(a.responseData?.statusCode);
  if (Number.isFinite(status) && status > 0 && (parts.length > 0 || status >= 400)) {
    const ms = Number(a.responseData?.responseTime);
    let http = `HTTP ${status}${Number.isFinite(ms) && ms > 0 ? ` in ${ms} ms` : ''}`;
    const body = typeof a.responseData?.responseBody === 'string' ? a.responseData.responseBody.trim() : '';
    if (status >= 400 && body) http += ` — ${body.length > 160 ? `${body.slice(0, 160)}…` : body}`;
    parts.push(http);
  }
  return parts.length ? parts.join(' · ') : undefined;
}
