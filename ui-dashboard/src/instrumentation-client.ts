import * as Sentry from "@sentry/nextjs";
import {
  resolveTracesSampleRate,
  shouldEnableSentry,
  stripAuthHeaders,
} from "../sentry.shared";
import { clientEnv } from "./env";

if (shouldEnableSentry(clientEnv.NEXT_PUBLIC_VERCEL_ENV)) {
  Sentry.init({
    dsn: clientEnv.NEXT_PUBLIC_SENTRY_DSN,
    environment: clientEnv.NEXT_PUBLIC_VERCEL_ENV ?? "development",
    // NEXT_PUBLIC_VERCEL_ENV is the build-time-inlined mirror of VERCEL_ENV
    // used by the server config; see resolveTracesSampleRate in sentry.shared.
    tracesSampleRate: resolveTracesSampleRate(clientEnv.NEXT_PUBLIC_VERCEL_ENV),
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    sendDefaultPii: false,
    beforeSend: stripAuthHeaders,
    beforeSendTransaction: stripAuthHeaders,
    integrations: [Sentry.replayIntegration()],
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
