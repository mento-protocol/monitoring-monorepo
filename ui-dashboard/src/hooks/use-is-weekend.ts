"use client";

import { useSyncExternalStore } from "react";
import { isWeekend } from "@/lib/weekend";

// Static store: the weekend flag is read per mount, not subscribed to a live
// source (the banner is informational, not a ticking countdown), so subscribe
// is a no-op.
const subscribe = (): (() => void) => () => {};

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
