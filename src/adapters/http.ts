import { log } from '../log.js';
import { resolveHttpTimeoutMs } from '../defaults.js';

// First N characters of a non-2xx response body kept on the thrown error -- enough
// for a caller to show useful diagnostic text without risking logging/echoing an
// unbounded (or sensitive-data-laden) upstream error page.
const BODY_SNIPPET_LEN = 500;

// Default per-request timeout. Without one, a stalled upstream (backend or the
// external DATA_GENERATION_URL proxy behind /tm/customFormula) freezes the whole
// tool call forever and the MCP client just sits at "in progress". Override with
// QA_HTTP_TIMEOUT_MS. 30s is generous for slow proxies; individual callers can
// tighten it later if needed. The value itself lives in defaults.ts (QA_HTTP_TIMEOUT_MS overrides).
const DEFAULT_TIMEOUT_MS = resolveHttpTimeoutMs();

/**
 * Thrown by every QaHttp method on any non-2xx response. Downstream adapters branch
 * on `status` (e.g. the 409 optimistic-concurrency retry, the 503
 * EXECUTIONS_RESERVE_FIRST guidance) so `status` must be the exact upstream HTTP
 * status code. `body` is a return value on the error, not a log line -- safe to
 * surface to the model/user; the HTTP layer itself never logs bodies or headers.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: string;
  readonly url: string;

  constructor(status: number, body: string, url: string) {
    super(`HTTP ${status} ${url}${body ? ` — ${body}` : ''}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export type MakeClientOptions = {
  baseUrl: string;
  // A callback, not a captured object: invoked fresh on every single request so
  // rotating/refreshed tokens (e.g. jwt-mode's proactive refresh) are always current.
  headers: () => Record<string, string>;
  /**
   * Injectable transport. Defaults to the ambient global `fetch` (Node >=20's native
   * Fetch API) -- production code never overrides this. Tests inject a matching
   * implementation (e.g. undici's own `fetch` export, paired with `FormDataImpl`
   * below) instead of mutating `globalThis`, since Node's bundled internal undici
   * and an installed `undici` devDependency are distinct module instances that do
   * not share MockAgent's dispatcher registry.
   */
  fetchImpl?: typeof fetch;
  /**
   * Paired with `fetchImpl`. Verified empirically: a `FormData` instance built from
   * the *ambient* global `FormData` constructor, handed to a *different* fetch
   * implementation's multipart encoder, fails that encoder's internal `instanceof`
   * check and silently degrades the whole request body to the string
   * "[object FormData]" instead of an actual multipart payload. Whenever
   * `fetchImpl` is overridden, `FormDataImpl` must come from the same
   * implementation family.
   */
  FormDataImpl?: typeof FormData;
  /** Paired with FormDataImpl for symmetry; defaults to the ambient global `Blob`. */
  BlobImpl?: typeof Blob;
};

export type QaHttp = {
  getJson<T = unknown>(path: string): Promise<T>;
  postJson<T = unknown>(path: string, body: unknown): Promise<T>;
  putJson<T = unknown>(path: string, body: unknown): Promise<T>;
  patchJson<T = unknown>(path: string, body: unknown): Promise<T>;
  del(path: string): Promise<void>;
  // SimplifyQA's testcaseObj/suiteObj convention: a single JSON part, under a
  // caller-supplied part name, inside a multipart/form-data body.
  postMultipart<T = unknown>(path: string, partName: string, json: unknown): Promise<T>;
  // Optional — SimplifyQA-only (`testcaseObj` / `suiteObj` PUTs). Walnut never uses this and its
  // withProjectScopeHint wrapper deliberately does not implement it, so the type is optional here
  // to keep that wrapper conforming without adding a dead passthrough. Callers that KNOW they get
  // a concrete makeClient (i.e. the SQA adapter) can use `http.putMultipart!(...)`.
  putMultipart?<T = unknown>(path: string, partName: string, json: unknown): Promise<T>;
  /** SimplifyQA entity-attachment upload: one JSON part + one or more binary file parts
   *  (`filename1..N`), e.g. the epic/feature/user-story PUT the UI uses to attach a file. */
  putMultipartWithFiles?<T = unknown>(
    path: string, partName: string, json: unknown,
    files: Array<{ partName: string; fileName: string; contentType?: string; data: Uint8Array }>,
  ): Promise<T>;
  // Optional — raw binary GET (PDF reports). Own timeout: report generation can take minutes.
  getBinary?(path: string, timeoutMs?: number): Promise<{ data: Uint8Array; contentType: string }>;
};

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

// Every request funnels through here: resolves the url, merges fresh auth headers
// with any per-call headers, reads the body once as text, logs method+path+status
// only (never body/headers -- both carry tokens and test data), and shapes any
// non-2xx into ApiError. Callers parse the returned text as needed (or ignore it,
// for `del`).
async function send(
  opts: MakeClientOptions,
  method: string,
  path: string,
  init: { body?: BodyInit; headers?: Record<string, string> } = {},
): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = joinUrl(opts.baseUrl, path);
  // Built incrementally (not `{ method, body: init.body, headers: {...} }`) so the
  // `body` key is omitted entirely when absent, rather than present-with-`undefined`
  // -- required under exactOptionalPropertyTypes, since DOM's RequestInit.body is
  // typed `BodyInit | null` (no `| undefined`) though the property itself is optional.
  const requestInit: RequestInit = { method, headers: { ...opts.headers(), ...init.headers } };
  if (init.body !== undefined) requestInit.body = init.body;
  // AbortSignal.timeout throws a DOMException("TimeoutError") after N ms. Wrap fetch so a hung
  // upstream surfaces a readable error instead of leaving the tool call pending forever.
  if (Number.isFinite(DEFAULT_TIMEOUT_MS) && DEFAULT_TIMEOUT_MS > 0) {
    requestInit.signal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  }
  let res: Response;
  try {
    res = await doFetch(url, requestInit);
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error(`HTTP ${method} ${path} timed out after ${DEFAULT_TIMEOUT_MS}ms (upstream did not respond).`);
    }
    throw e;
  }
  const text = await res.text();
  log(method, path, res.status);
  if (res.status < 200 || res.status >= 300) {
    throw new ApiError(res.status, text.slice(0, BODY_SNIPPET_LEN), url);
  }
  return text;
}

function parseJson<T>(text: string): T {
  return (text.length ? JSON.parse(text) : undefined) as T;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Builds a QaHttp bound to one base URL + one headers-callback (one product connection). */
export function makeClient(opts: MakeClientOptions): QaHttp {
  return {
    async getJson<T>(path: string): Promise<T> {
      return parseJson<T>(await send(opts, 'GET', path));
    },
    async postJson<T>(path: string, body: unknown): Promise<T> {
      return parseJson<T>(await send(opts, 'POST', path, { body: JSON.stringify(body), headers: JSON_HEADERS }));
    },
    async putJson<T>(path: string, body: unknown): Promise<T> {
      return parseJson<T>(await send(opts, 'PUT', path, { body: JSON.stringify(body), headers: JSON_HEADERS }));
    },
    async patchJson<T>(path: string, body: unknown): Promise<T> {
      return parseJson<T>(await send(opts, 'PATCH', path, { body: JSON.stringify(body), headers: JSON_HEADERS }));
    },
    async del(path: string): Promise<void> {
      await send(opts, 'DELETE', path);
    },
    async postMultipart<T>(path: string, partName: string, json: unknown): Promise<T> {
      return parseJson<T>(await send(opts, 'POST', path, { body: multipartBody(opts, partName, json) }));
    },
    async getBinary(path: string, timeoutMs = 600_000): Promise<{ data: Uint8Array; contentType: string }> {
      const doFetch = opts.fetchImpl ?? fetch;
      const url = joinUrl(opts.baseUrl, path);
      let res: Response;
      try {
        res = await doFetch(url, { method: 'GET', headers: { ...opts.headers() }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
          throw new Error(`HTTP GET ${path} timed out after ${timeoutMs}ms (report still generating or upstream not responding).`);
        }
        throw e;
      }
      log('GET', path, res.status);
      if (res.status < 200 || res.status >= 300) {
        throw new ApiError(res.status, (await res.text()).slice(0, BODY_SNIPPET_LEN), url);
      }
      return { data: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? '' };
    },
    async putMultipart<T>(path: string, partName: string, json: unknown): Promise<T> {
      return parseJson<T>(await send(opts, 'PUT', path, { body: multipartBody(opts, partName, json) }));
    },
    async putMultipartWithFiles<T>(
      path: string, partName: string, json: unknown,
      files: Array<{ partName: string; fileName: string; contentType?: string; data: Uint8Array }>,
    ): Promise<T> {
      const FormDataCtor = opts.FormDataImpl ?? FormData;
      const BlobCtor = opts.BlobImpl ?? Blob;
      const form = new FormDataCtor();
      form.append(partName, JSON.stringify(json));
      for (const f of files) {
        const blob = new BlobCtor([f.data as unknown as BlobPart], { type: f.contentType ?? 'application/octet-stream' });
        form.append(f.partName, blob, f.fileName);
      }
      return parseJson<T>(await send(opts, 'PUT', path, { body: form }));
    },
  };
}

// Shared multipart body builder — one JSON part, no explicit Content-Type header (fetch computes
// the boundary from FormData; setting Content-Type manually would break it).
function multipartBody(opts: MakeClientOptions, partName: string, json: unknown): BodyInit {
  const FormDataCtor = opts.FormDataImpl ?? FormData;
  const form = new FormDataCtor();
  form.append(partName, JSON.stringify(json));
  return form;
}
