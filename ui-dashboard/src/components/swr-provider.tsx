"use client";

import type { ReactNode } from "react";
import { SWRConfig, type SWRConfiguration } from "swr";
import * as Sentry from "@sentry/nextjs";

// Global SWR onError handler: funnel every fetch failure to Sentry with the
// SWR cache key attached as extra data. Without this, caught errors surface
// as an ErrorBox in the UI and vanish from observability. Individual hooks
// can still override by passing their own `onError` to useSWR.

// Polling hooks (useGQL @ 10s, useAllNetworksData @ 30s) across multiple
// open tabs would otherwise flood Sentry during an upstream outage — one
// Hasura timeout fans out to dozens of identical events per minute. Cap at
// one capture per unique SWR key per 60 seconds.
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
