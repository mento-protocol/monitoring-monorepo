import type { ErrorEvent, init } from "@sentry/nextjs";

type Options = Parameters<typeof init>[0];
type TransactionEvent = Parameters<
  NonNullable<Options["beforeSendTransaction"]>
>[0];

// Strip session cookies + auth headers so upstream request metadata never
// reaches Sentry. Shared across the error + transaction paths — both event
// shapes carry the same optional `request.headers` bag. Exported so the
// browser SDK (instrumentation-client.ts) can apply the same scrubber.
export function stripAuthHeaders<T extends ErrorEvent | TransactionEvent>(
  event: T,
): T {
  if (event.request?.headers) {
    delete event.request.headers.cookie;
    delete event.request.headers.Cookie;
    delete event.request.headers.authorization;
    delete event.request.headers.Authorization;
  }
  return event;
}

// Sample 20% of traces in production to stay within Sentry quota at scale;
// keep 100% on preview + local where traffic is low and full fidelity is
// useful for debugging. Tune once we have real volume data.
export const tracesSampleRate =
  process.env.VERCEL_ENV === "production" ? 0.2 : 1.0;

export function getServerSentryOptions(): Options {
  return {
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.VERCEL_ENV ?? "development",
    tracesSampleRate,
    sendDefaultPii: false,
    beforeSend: stripAuthHeaders,
    beforeSendTransaction: stripAuthHeaders,
  };
}
