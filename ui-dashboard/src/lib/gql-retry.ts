import { ClientError } from "graphql-request";
import type { SWRConfiguration } from "swr";

// Envio's "small" tier returns 429 "Tier Quota" without a Retry-After header
// once the monthly allotment is burned. Back off long enough that we don't
// keep hammering the endpoint, but recover automatically when the quota
// window resets.
const RATE_LIMIT_BACKOFF_MS = 60_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 5 * 60_000;

function clampBackoff(ms: number): number {
  return Math.min(
    Math.max(ms, RATE_LIMIT_BACKOFF_MS),
    RATE_LIMIT_BACKOFF_MAX_MS,
  );
}

export function retryAfterMs(err: unknown): number | null {
  if (!(err instanceof ClientError)) return null;
  if (err.response.status !== 429) return null;
  const header = err.response.headers?.get?.("retry-after");
  if (!header) return RATE_LIMIT_BACKOFF_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) {
    return clampBackoff(seconds * 1000);
  }
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    return clampBackoff(date - Date.now());
  }
  return RATE_LIMIT_BACKOFF_MS;
}

// Returns 0 (pause) when the tab is backgrounded, otherwise the caller's
// configured interval. SWR v2 calls this on every polling tick, so visibility
// transitions take effect at the next scheduled interval without needing a
// re-render. `refreshWhenHidden: false` reinforces it.
export function pausableRefreshInterval(ms: number): () => number {
  return () => {
    if (typeof document !== "undefined" && document.hidden) return 0;
    return ms;
  };
}

// Retries 429s using the server's Retry-After (clamped to 60s…5m). For every
// other error class, falls back to SWR's built-in exponential backoff + jitter
// with no retry cap — matching SWR's default so transient 5xx don't wedge the
// hook. SWR's polling loop skips revalidation while the cache is errored, so
// an early `return` here would leave the hook stuck until focus/reconnect.
export const rateLimitAwareRetry: NonNullable<
  SWRConfiguration["onErrorRetry"]
> = (err, _key, config, revalidate, opts) => {
  const backoff = retryAfterMs(err);
  if (backoff !== null) {
    setTimeout(() => revalidate({ retryCount: opts.retryCount }), backoff);
    return;
  }
  const maxRetryCount = config.errorRetryCount;
  if (maxRetryCount !== undefined && opts.retryCount > maxRetryCount) return;
  const exponent = opts.retryCount < 8 ? opts.retryCount : 8;
  const timeout =
    ~~((Math.random() + 0.5) * (1 << exponent)) *
    (config.errorRetryInterval ?? 5_000);
  setTimeout(() => revalidate({ retryCount: opts.retryCount }), timeout);
};
