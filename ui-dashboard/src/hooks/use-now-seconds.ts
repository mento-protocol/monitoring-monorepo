"use client";

import { useSyncExternalStore } from "react";
import { relativeTimeOrTimestamp, timestampOrUtc } from "@/lib/format";

// A shared, SSR-safe wall-clock in whole seconds for relative-time labels
// ("N ago") and freshness math in components that now render on the server (the
// pool-detail header is SSR-prefetched). It returns `null` on the server render
// AND the client's hydration render (getServerSnapshot), then the live value
// after commit (getSnapshot) — so anything derived from it can't cause a
// hydration mismatch: the server's render instant differs from the viewer's, and
// a statically-cached SSR payload can outlive the interval entirely. Consumers
// render a deterministic fallback (absolute timestamp / assume-fresh) while it is
// null, then the live label after mount. Mirrors the useIsWeekend pattern.
//
// The value is cached in a module store so getSnapshot is stable between ticks
// (returning a fresh Date.now() every call would loop useSyncExternalStore). It
// advances every 30s — plenty for "N ago" labels, and one Date read per wakeup.

// Seeded at module load so getSnapshot never returns a stale 0 before the first
// subscribe (the server render uses getServerSnapshot = null, so this value only
// ever feeds the client).
let nowSeconds = Math.floor(Date.now() / 1000);
const listeners = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  nowSeconds = Math.floor(Date.now() / 1000);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    nowSeconds = Math.floor(Date.now() / 1000);
    intervalId = setInterval(tick, 30_000);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}

/** Live wall-clock seconds, or `null` on the server + hydration render. */
export function useNowSeconds(): number | null {
  return useSyncExternalStore(
    subscribe,
    () => nowSeconds,
    () => null,
  );
}

/** SSR-safe relative-time string in one call: a deterministic UTC date on the
 *  server + hydration render, the live "N ago" label after mount. Lets a
 *  component swap `relativeTime(ts)` for `useSsrSafeRelative(ts)` with no line
 *  change. */
export function useSsrSafeRelative(ts: string | null | undefined): string {
  return relativeTimeOrTimestamp(ts ?? "", useNowSeconds());
}

/** SSR-safe absolute timestamp for title/tooltip attributes: a deterministic UTC
 *  value on the server + hydration render, the local timestamp after mount. */
export function useSsrSafeTimestamp(ts: string): string {
  return timestampOrUtc(ts, useNowSeconds());
}
