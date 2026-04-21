"use client";

import type { ReactNode } from "react";
import { SWRConfig, type SWRConfiguration } from "swr";
import * as Sentry from "@sentry/nextjs";

// Global SWR onError handler: funnel every fetch failure to Sentry with the
// SWR cache key attached as extra data. Without this, caught errors surface
// as an ErrorBox in the UI and vanish from observability. Individual hooks
// can still override by passing their own `onError` to useSWR.
//
// Capture is throttled per-key so polling hooks don't flood Sentry during
// an upstream outage — one Hasura timeout fans out to dozens of identical
// events per minute otherwise.
const THROTTLE_MS = 60_000;
const lastCapturedAt = new Map<string, number>();

function normalizeKey(key: unknown): string {
  return typeof key === "string" ? key : JSON.stringify(key);
}

function shouldCapture(normalized: string): boolean {
  const now = Date.now();
  const last = lastCapturedAt.get(normalized) ?? 0;
  if (now - last < THROTTLE_MS) return false;
  lastCapturedAt.set(normalized, now);
  return true;
}

// Hoisted to module scope so the config object identity is stable across
// renders — an inline object literal would bust context consumers every
// time SwrProvider re-renders.
//
// Focus/reconnect revalidation is *not* disabled globally — only the
// bridge-flows hook opts out (see `use-bridge-gql.ts`), since that's where
// the 429 fanout came from. Leaving the global default on means regular
// one-shot SWR reads still refresh when the user returns to a tab or the
// network recovers.
const swrConfig: SWRConfiguration = {
  onError(err, key) {
    const normalized = normalizeKey(key);
    if (!shouldCapture(normalized)) return;
    Sentry.captureException(err, {
      tags: { source: "swr" },
      extra: { swrKey: normalized },
    });
  },
};

export function SwrProvider({ children }: { children: ReactNode }) {
  return <SWRConfig value={swrConfig}>{children}</SWRConfig>;
}
