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
// the tab is visible AND the browser reports online. Re-checks the same
// conditions when the timer fires — the tab may have been backgrounded (or
// the network dropped) during the delay, and firing anyway would reintroduce
// the quota burn in hidden tabs. Hooks that disable both `revalidateOnFocus`
// and `revalidateOnReconnect` (both `useGQL` and `useBridgeGQL`) bypass SWR's
// "skip onErrorRetry while inactive" gate, so this helper is the only thing
// protecting the quota during the retry window.
function scheduleWhenActive(
  revalidate: (opts: { retryCount: number; dedupe: boolean }) => void,
  opts: { retryCount: number; dedupe: boolean },
  delayMs: number,
): void {
  const isHidden = () =>
    typeof document !== "undefined" && document.hidden === true;
  const isOffline = () =>
    typeof navigator !== "undefined" && navigator.onLine === false;
  const canRun = () => !isHidden() && !isOffline();

  let attached = false;
  const onStateChange = () => {
    if (!canRun()) return;
    detach();
    setTimeout(fire, delayMs);
  };
  const attach = () => {
    if (attached) return;
    attached = true;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onStateChange);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", onStateChange);
    }
  };
  const detach = () => {
    if (!attached) return;
    attached = false;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onStateChange);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("online", onStateChange);
    }
  };
  const fire = () => {
    if (canRun()) {
      revalidate(opts);
      return;
    }
    attach();
  };

  if (canRun()) {
    setTimeout(fire, delayMs);
  } else {
    attach();
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
