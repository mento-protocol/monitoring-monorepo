"use client";

import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import * as Sentry from "@sentry/nextjs";

// Global SWR onError handler: funnel every fetch failure to Sentry with the
// SWR cache key attached as extra data. Without this, caught errors surface
// as an ErrorBox in the UI and vanish from observability. Individual hooks
// can still override by passing their own `onError` to useSWR.
export function SwrProvider({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        onError(err, key) {
          Sentry.captureException(err, {
            tags: { source: "swr" },
            extra: {
              swrKey: typeof key === "string" ? key : JSON.stringify(key),
            },
          });
        },
      }}
    >
      {children}
    </SWRConfig>
  );
}
