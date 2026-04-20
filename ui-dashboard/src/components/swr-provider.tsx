"use client";

import type { ReactNode } from "react";
import { SWRConfig, type SWRConfiguration } from "swr";
import * as Sentry from "@sentry/nextjs";

// Global SWR onError handler: funnel every fetch failure to Sentry with the
// SWR cache key attached as extra data. Without this, caught errors surface
// as an ErrorBox in the UI and vanish from observability. Individual hooks
// can still override by passing their own `onError` to useSWR.
//
// Hoisted to module scope so the config object identity is stable across
// renders — an inline object literal would bust context consumers every
// time SwrProvider re-renders.
const swrConfig: SWRConfiguration = {
  onError(err, key) {
    Sentry.captureException(err, {
      tags: { source: "swr" },
      extra: { swrKey: typeof key === "string" ? key : JSON.stringify(key) },
    });
  },
};

export function SwrProvider({ children }: { children: ReactNode }) {
  return <SWRConfig value={swrConfig}>{children}</SWRConfig>;
}
