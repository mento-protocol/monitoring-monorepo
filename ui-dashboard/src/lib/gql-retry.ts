import { ClientError } from "graphql-request";
import type { SWRConfiguration } from "swr";
import { GraphQLSchemaError } from "@/lib/graphql-schema-error";
import { SNAPSHOT_REFRESH_MS } from "@/lib/volume";

// Envio's "small" tier returns 429 "Tier Quota" without a Retry-After header
// once the monthly allotment is burned. Back off long enough that we don't
// keep hammering the endpoint, but recover automatically when the quota
// window resets.
const RATE_LIMIT_BACKOFF_MS = 60_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 5 * 60_000;

// Schema-drift recovery cadence. Schema validation failures are deterministic
// for a given response shape, so we don't want SWR's default exponential
// backoff burning Hasura quota during a multi-minute resync window. But once
// the indexer redeploys and Hasura starts returning the expected shape, the
// hook needs to recover automatically — SWR's polling loop skips revalidation
// while `cache.error` is set, so without a scheduled retry the page would
// stay stuck in the error state until remount or manual mutate. 60s recovery
// cadence: long enough to avoid quota burn, short enough that the heal
// window after a deploy is invisible to users.
const SCHEMA_ERROR_BACKOFF_MS = 60_000;

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
  // SWR's `Revalidator` actually returns `Promise<boolean>`; previously this
  // parameter was typed as `() => void`, which silently hid the fact that we
  // were dropping the promise. Keep the type honest so `no-misused-promises`
  // doesn't have to flag the call sites — the `void revalidate(opts)` inside
  // `fire` makes the discard explicit.
  revalidate: (opts: {
    retryCount: number;
    dedupe: boolean;
  }) => Promise<unknown> | void,
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
      // Discard the returned promise — SWR's `Revalidator` resolves with a
      // boolean we don't need, and rejection bubbles up to SWR's own
      // `onErrorRetry` path (this function IS the onErrorRetry handler).
      void revalidate(opts);
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
  // Schema-validation failures are deterministic: retrying the same request
  // hits the same parse failure until the underlying schema heals (typically
  // an indexer redeploy + resync). Replace SWR's default exponential backoff
  // with a low-frequency recovery probe so we (a) don't burn Hasura quota
  // while a drift is sustained, and (b) DO unstick the hook once the indexer
  // catches up — SWR's polling loop skips revalidation while `cache.error` is
  // set, so an unconditional early-return here would leave the page errored
  // until remount/manual mutate.
  if (err instanceof GraphQLSchemaError) {
    scheduleWhenActive(revalidate, opts, SCHEMA_ERROR_BACKOFF_MS);
    return;
  }
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

// Shared SWR config for the cross-network GraphQL hooks. Disables the
// focus/reconnect/hidden-tab revalidations (pool pages fan out 15–20 parallel
// queries; an alt-tab would otherwise fire all of them at once) and wires the
// 429-aware retry handler. One place to tune for every bulk-fetch hook.
export const SHARED_QUERY_SWR_CONFIG: SWRConfiguration = {
  refreshInterval: SNAPSHOT_REFRESH_MS,
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  refreshWhenHidden: false,
  onErrorRetry: rateLimitAwareRetry,
};
