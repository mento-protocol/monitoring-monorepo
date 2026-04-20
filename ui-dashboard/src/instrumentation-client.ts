import * as Sentry from "@sentry/nextjs";
import { stripAuthHeaders } from "../sentry.shared";

// Sample 20% of traces in production to stay within Sentry quota at scale;
// 100% on preview + local for full-fidelity debugging. Mirrors server/edge
// config in sentry.shared.ts — kept inline because NEXT_PUBLIC_VERCEL_ENV
// is the client-reachable counterpart of VERCEL_ENV.
const tracesSampleRate =
  process.env.NEXT_PUBLIC_VERCEL_ENV === "production" ? 0.2 : 1.0;

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? "development",
  tracesSampleRate,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  sendDefaultPii: false,
  beforeSend: stripAuthHeaders,
  beforeSendTransaction: stripAuthHeaders,
  integrations: [Sentry.replayIntegration()],
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
