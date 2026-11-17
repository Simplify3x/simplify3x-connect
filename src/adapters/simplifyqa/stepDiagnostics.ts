/**
 * Step diagnostics derived ONLY from what the backend already stores for a step run — no agent / plugin change.
 *
 * The plugins report some failures badly (a connection-less DB step surfaces a raw NullPointerException message, an
 * API request that got no response is stored as a fake 5xx reply and PASSES when nothing asserts on it, a DB read that
 * matched nothing stores "[]"). These helpers turn that stored evidence into a plain-language reason or warning for
 * `run_status`. They never change a step's status.
 */

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The API plugin stores a request that got NO response (connection refused, DNS failure, timeout…) as a made-up reply:
 *   503 + "Could not send request  <message>"          (ResourceAccessException)
 *   500 + "Unexpected error occurred: <message>"        (any other exception)
 * A real server's 5xx always carries response headers; the made-up one has none. Returns the underlying message, or
 * undefined when the stored response is a real one.
 */
export function apiTransportFailure(api: unknown): string | undefined {
  if (!isRec(api) || !isRec(api['responseData'])) return undefined;
  const r = api['responseData'];
  const status = Number(r['statusCode']);
  const body = typeof r['responseBody'] === 'string' ? r['responseBody'].trim() : '';
  const headers = r['responseHeaders'];
  if (isRec(headers) && Object.keys(headers).length > 0) return undefined;   // a real server answered
  if (status === 503 && /^Could not send request\b/i.test(body)) {
    return body.replace(/^Could not send request\s*/i, '').trim() || 'no response from the server';
  }
  if (status === 500 && /^Unexpected error occurred:/i.test(body)) {
    return body.replace(/^Unexpected error occurred:\s*/i, '').trim() || 'unexpected error';
  }
  return undefined;
}

/** DB plugin errors that say nothing useful, mapped to what they mean. Order: most specific first. */
const DB_HINTS: Array<{ re: RegExp; hint: string }> = [
  {
    // JDK helpful-NPE text for a driver call on a driver that was never created
    re: /because "this\.(sql|mongo|no_?sql|db)\w*" is null|Cannot invoke ".*(SQLDriver|NoSQLDriver|ISQLDriver|INoSQLDriver)[^"]*"/i,
    hint: 'There is no active database connection for this step. Add a "Connect to DB" step before it and check that it passed.',
  },
  {
    re: /Fail to \w+ : (null)?\s*$/i,
    hint: 'The action failed without an error message. Most often the connection is missing or closed - check the connect step above it.',
  },
  {
    re: /Invalid JSON input|JSON reader was expecting|org\.bson\.json\.JsonParseException/i,
    hint: 'A filter/document is not valid JSON. If it contains ${name}, that parameter was not substituted - re-save the step so it is bound as {{name}}.',
  },
];

/** A readable hint for a FAILED database step, from its error text. Undefined when nothing recognisable. */
export function dbFailureHint(errorText: string | undefined): string | undefined {
  if (!errorText) return undefined;
  for (const { re, hint } of DB_HINTS) if (re.test(errorText)) return hint;
  return undefined;
}

type TestdataRow = Rec;

const valueOf = (t: TestdataRow): string => (t['protected'] ? '' : String(t['value'] ?? '')).trim();

/** A `${name}` left inside a stored argument value: the agent never substitutes that form (only `{{name}}`), so the
 *  step ran with the literal text. */
export function unresolvedPlaceholders(testdata: unknown): string[] {
  const rows = Array.isArray(testdata) ? (testdata as TestdataRow[]) : [];
  const found: string[] = [];
  for (const t of rows) {
    if (!isRec(t)) continue;
    for (const m of valueOf(t).matchAll(/\$\{([^{}]+?)\}/g)) {
      if (!found.includes(m[1]!)) found.push(m[1]!);
    }
  }
  return found;
}

/** A PASSED read step whose stored result is an empty list ("[]"): it matched nothing, which is a valid answer for the
 *  plugin but is almost always the cause of the next step's failure. */
export function emptyReadWarning(description: string, testdata: unknown): string | undefined {
  if (!/\bread\b.*\b(documents?|data|collection|table)\b/i.test(description)) return undefined;
  const rows = Array.isArray(testdata) ? (testdata as TestdataRow[]) : [];
  const empty = rows.filter((t) => isRec(t) && valueOf(t) === '[]');
  if (empty.length === 0) return undefined;
  const name = String(empty[0]!['paramName'] ?? empty[0]!['runtimeKey'] ?? 'the result');
  return `the read stored an empty result ("[]") in ${name} - no document/row matched. Check the filter or query and the data it should match. ` +
    'A MongoDB error (wrong credentials or authSource, wrong database name, unreachable server, timeout) is swallowed by the read action and also stores "[]" ' +
    '(the connect step passes without contacting the server) - if the data does exist, look for MongoSecurityException / MongoTimeoutException in the agent console.';
}
