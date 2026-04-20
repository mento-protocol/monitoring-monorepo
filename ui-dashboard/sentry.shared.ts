import type { ErrorEvent, init } from "@sentry/nextjs";

type Options = Parameters<typeof init>[0];
type TransactionEvent = Parameters<
  NonNullable<Options["beforeSendTransaction"]>
>[0];

// Strip session cookies + auth headers so upstream request metadata never
// reaches Sentry. Shared across the error + transaction paths — both event
// shapes carry the same optional `request.headers` bag.
function stripAuthHeaders<T extends ErrorEvent | TransactionEvent>(
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

export function getServerSentryOptions(): Options {
  return {
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.VERCEL_ENV ?? "development",
    tracesSampleRate: 1.0,
    sendDefaultPii: false,
    beforeSend: stripAuthHeaders,
    beforeSendTransaction: stripAuthHeaders,
  };
}
