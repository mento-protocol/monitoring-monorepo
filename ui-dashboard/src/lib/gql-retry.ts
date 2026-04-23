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

// Schedules `revalidate(opts)` after `delayMs`, but defers the timer until
// the tab is visible AND the browser reports online. Hooks that disable
// both `revalidateOnFocus` and `revalidateOnReconnect` (both `useGQL` and
// `useBridgeGQL`) bypass SWR's "skip onErrorRetry while inactive" gate, so
// without this guard errored hooks would keep retrying in hidden or
// offline tabs — burning quota for no user benefit and growing
// `retryCount` during outages so reconnects see multi-minute backoffs
// before the next retry fires.
function scheduleWhenActive(
  revalidate: (opts: { retryCount: number; dedupe: boolean }) => void,
  opts: { retryCount: number; dedupe: boolean },
  delayMs: number,
): void {
  const run = () => revalidate(opts);
  const isHidden = () =>
    typeof document !== "undefined" && document.hidden === true;
  const isOffline = () =>
    typeof navigator !== "undefined" && navigator.onLine === false;

  if (!isHidden() && !isOffline()) {
    setTimeout(run, delayMs);
    return;
  }

  const check = () => {
    if (isHidden() || isOffline()) return;
    cleanup();
    setTimeout(run, delayMs);
  };
  const cleanup = () => {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", check);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("online", check);
    }
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", check);
  }
  if (typeof window !== "undefined") {
    window.addEventListener("online", check);
  }
}

// Retries 429s using the server's Retry-After (clamped to 60s…5m). For every
// other error class, falls back to SWR's built-in exponential backoff + jitter
// with no retry cap — matching SWR's default so transient 5xx don't wedge the
// hook. SWR's polling loop skips revalidation while the cache is errored, so
// an early `return` here would leave the hook stuck until focus/reconnect.
// `opts` is forwarded unchanged to `revalidate` so SWR's `dedupe: true` flag
// (set internally when scheduling retries) survives the round-trip — dropping
// it would fan duplicate retry requests across components sharing a key.
export const rateLimitAwareRetry: NonNullable<
  SWRConfiguration["onErrorRetry"]
> = (err, _key, config, revalidate, opts) => {
  const backoff = retryAfterMs(err);
  if (backoff !== null) {
    scheduleWhenActive(revalidate, opts, backoff);
    return;
  }
  const maxRetryCount = config.errorRetryCount;
  if (maxRetryCount !== undefined && opts.retryCount > maxRetryCount) return;
  const exponent = opts.retryCount < 8 ? opts.retryCount : 8;
  const timeout =
    ~~((Math.random() + 0.5) * (1 << exponent)) *
    (config.errorRetryInterval ?? 5_000);
  scheduleWhenActive(revalidate, opts, timeout);
};
