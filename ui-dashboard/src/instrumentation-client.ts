import * as Sentry from "@sentry/nextjs";
import {
  filterAndStripSentryEvent,
  resolveTracesSampleRate,
  shouldEnableSentry,
} from "../sentry.shared";
import { clientEnv } from "./env";

// Session Replay is registered lazily (see below) so the rrweb recorder
// (~55 KB brotli) stays out of the critical client bundle. A dynamic
// import keeps the replay chunk on our own origin (script-src 'self');
// Sentry.lazyLoadIntegration() would instead fetch it from
// browser.sentry-cdn.com, which our CSP blocks. @/lib/sentry-replay
// re-exports only replayIntegration so the async chunk tree-shakes down
// to the recorder instead of retaining the whole "@sentry/nextjs" barrel.
//
// Trade-off: errors thrown before the idle-time chunk finishes loading
// lose the pre-error replay buffer, so replaysOnErrorSampleRate degrades
// slightly for very-early errors. Session-sample recording starts when the
// integration attaches, moments after load.
function lazyLoadReplayIntegration(): void {
  const load = () => {
    import("@/lib/sentry-replay")
      .then(({ replayIntegration }) => {
        const client = Sentry.getClient();
        // Client can be undefined if init failed; skip double-registration
        // (e.g. dev fast-refresh re-running this module).
        if (!client || client.getIntegrationByName("Replay")) return;
        client.addIntegration(replayIntegration());
      })
      .catch(() => {
        // Chunk failed to load (offline, blocked) — run without replay.
      });
  };

  // requestIdleCallback is missing from older Safari; ES2017-safe fallback.
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(load);
  } else {
    window.setTimeout(load, 0);
  }
}

if (shouldEnableSentry(clientEnv.NEXT_PUBLIC_VERCEL_ENV)) {
  Sentry.init({
    dsn: clientEnv.NEXT_PUBLIC_SENTRY_DSN,
    environment: clientEnv.NEXT_PUBLIC_VERCEL_ENV ?? "development",
    // NEXT_PUBLIC_VERCEL_ENV is the build-time-inlined mirror of VERCEL_ENV
    // used by the server config; see resolveTracesSampleRate in sentry.shared.
    tracesSampleRate: resolveTracesSampleRate(clientEnv.NEXT_PUBLIC_VERCEL_ENV),
    // Replay sample rates stay here even though replayIntegration() is added
    // lazily — the SDK reads them from the client options when the
    // integration attaches.
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    sendDefaultPii: false,
    beforeSend: filterAndStripSentryEvent,
    beforeSendTransaction: filterAndStripSentryEvent,
  });

  lazyLoadReplayIntegration();
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
