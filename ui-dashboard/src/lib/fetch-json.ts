/**
 * Shared fetcher for SWR hooks talking to our own `/api/*` routes.
 *
 * The contract: routes either return JSON (any status) or fail outright.
 * Non-2xx responses with `{ error: "..." }` get re-thrown with that message
 * so SWR's `error` field surfaces something the user can read.
 */

import {
  isApiFailureClass,
  isHttpStatus,
  type ApiErrorBody,
  type ApiFailureClass,
} from "@/lib/api-failure";

/** Default per-request deadline. SWR polling hooks revalidate on cadences
 *  starting at 30s, and the polling-Hasura PR checklist requires a
 *  deadline below the refresh interval — otherwise a wedged route can
 *  stall the loop and keep the request alive past the next refresh tick.
 *  Callers can override per-call via `opts.timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 25_000;

function requestPath(url: string): string | null {
  try {
    const path = new URL(url, "http://dashboard.local").pathname;
    return path.startsWith("/api/") ? path : null;
  } catch {
    return null;
  }
}

function rejectedFetchFailure(error: unknown): ApiFailureClass {
  return error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
    ? "timeout"
    : "network";
}

function responseBodyReadError(
  error: unknown,
  url: string,
  label: string,
  status: number,
): FetchJsonError | null {
  if (error instanceof SyntaxError) return null;
  const failureClass = rejectedFetchFailure(error);
  return new FetchJsonError(
    failureClass === "timeout"
      ? `${label} request timed out`
      : `${label} request failed`,
    {
      failureClass,
      requestPath: requestPath(url),
      status,
    },
  );
}

export class FetchJsonError extends Error {
  readonly failureClass: ApiFailureClass;
  readonly requestPath: string | null;
  readonly status: number | null;
  readonly upstreamStatus: number | null;

  constructor(
    message: string,
    details: {
      failureClass: ApiFailureClass;
      requestPath: string | null;
      status?: number;
      upstreamStatus?: number;
    },
  ) {
    super(message);
    this.name = "FetchJsonError";
    this.failureClass = details.failureClass;
    this.requestPath = details.requestPath;
    this.status = details.status ?? null;
    this.upstreamStatus = details.upstreamStatus ?? null;
  }
}

async function fetchResponse(
  url: string,
  label: string,
  opts: { timeoutMs?: number; method?: "GET" | "POST" },
): Promise<Response> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return await fetch(url, {
      ...(opts.method === undefined ? {} : { method: opts.method }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    const failureClass = rejectedFetchFailure(error);
    throw new FetchJsonError(
      failureClass === "timeout"
        ? `${label} request timed out`
        : `${label} request failed`,
      {
        failureClass,
        requestPath: requestPath(url),
      },
    );
  }
}

async function parseSuccessJson<T>(
  response: Response,
  url: string,
  label: string,
): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    const readError = responseBodyReadError(error, url, label, response.status);
    if (readError !== null) throw readError;
    throw new FetchJsonError(`${label} returned invalid JSON`, {
      failureClass: "invalid-payload",
      requestPath: requestPath(url),
      status: response.status,
    });
  }
}

async function responseError(
  response: Response,
  url: string,
  label: string,
): Promise<FetchJsonError> {
  let body: Partial<ApiErrorBody> | null = null;
  try {
    body = (await response.json()) as Partial<ApiErrorBody>;
  } catch (error) {
    const readError = responseBodyReadError(error, url, label, response.status);
    if (readError !== null) throw readError;
  }
  return new FetchJsonError(
    typeof body?.error === "string"
      ? body.error
      : `${label} failed (HTTP ${response.status})`,
    {
      failureClass: isApiFailureClass(body?.failureClass)
        ? body.failureClass
        : "http",
      requestPath: requestPath(url),
      status: response.status,
      ...(isHttpStatus(body?.upstreamStatus)
        ? { upstreamStatus: body.upstreamStatus }
        : {}),
    },
  );
}

export async function fetchJsonOrThrow<T>(
  url: string,
  label: string,
  opts: { timeoutMs?: number; method?: "GET" | "POST" } = {},
): Promise<T> {
  const res = await fetchResponse(url, label, opts);
  if (!res.ok) throw await responseError(res, url, label);
  return parseSuccessJson<T>(res, url, label);
}

/**
 * Like `fetchJsonOrThrow`, but resolves to `null` on a 404 instead of
 * throwing. Use for SWR hooks where the absence of a record is a
 * legitimate "nothing to render" state, not an error — e.g. the Arkham
 * detail panels where most addresses simply have no enriched data.
 *
 * Other non-2xx responses still throw so SWR can surface the message.
 */
export async function fetchJsonOr404<T>(
  url: string,
  label: string,
  opts: { timeoutMs?: number } = {},
): Promise<T | null> {
  const res = await fetchResponse(url, label, opts);
  if (res.status === 404) return null;
  if (!res.ok) throw await responseError(res, url, label);
  return parseSuccessJson<T>(res, url, label);
}
