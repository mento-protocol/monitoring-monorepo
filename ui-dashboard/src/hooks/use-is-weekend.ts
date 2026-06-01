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
 * Returns `false` on the server render and the client's hydration render (the
 * `getServerSnapshot`), then the real `isWeekend()` value on the client after
 * commit (`getSnapshot`). This keeps the server HTML and the first client
 * render in agreement, so weekend-dependent UI (e.g. the FX "markets closed"
 * banner) can never trigger a hydration mismatch — the server's wall-clock day
 * can differ from the viewer's, and a statically-cached SSR payload can outlive
 * the weekend entirely. `useSyncExternalStore` is the idiomatic way to read a
 * client-only value with a server fallback (no setState-in-effect dance).
 */
export function useIsWeekend(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isWeekend(),
    () => false,
  );
}
