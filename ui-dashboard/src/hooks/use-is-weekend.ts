"use client";

import { useSyncExternalStore } from "react";
import { isWeekend } from "@/lib/weekend";

// Re-read the weekend flag on each hour boundary so a session left open across
// a market transition (Fri 21:00 / Sun 23:00 UTC) self-corrects without a
// refresh. This matters beyond the informational banner: health-panel's
// weekend-pause message and deviation-cell's hidden deviation bar are gated on
// the same flag, so a stale value would otherwise linger until the next
// navigation. Hourly granularity is plenty (a banner up to ~1h late is fine)
// and each wakeup is a single Date comparison.
const subscribe = (notify: () => void): (() => void) => {
  const id = setInterval(notify, 60 * 60 * 1000);
  return () => clearInterval(id);
};

/**
 * SSR-safe FX-weekend flag.
 *
 * Returns `initialIsWeekend` on the server render and the client's hydration
 * render (the `getServerSnapshot`), then the real `isWeekend()` value on the
 * client after commit (`getSnapshot`). The default stays `false` for consumers
 * that do not receive a server-computed clock snapshot. A seeded consumer must
 * pass the exact same serialized value on the server and client so hydration
 * never recomputes wall-clock state independently. `useSyncExternalStore` then
 * synchronously compares against the live clock immediately after hydration
 * and corrects any ISR-stale seed before keeping the hourly subscription.
 * This seeded path is intentionally limited to the informational weekend
 * banner; operator-safety state with async inputs must still render neutral
 * until those inputs resolve.
 */
export function useIsWeekend(initialIsWeekend = false): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isWeekend(),
    () => initialIsWeekend,
  );
}
