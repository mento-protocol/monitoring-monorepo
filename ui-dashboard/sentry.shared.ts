import type { ErrorEvent, init } from "@sentry/nextjs";

type Options = Parameters<typeof init>[0];
type TransactionEvent = Parameters<
  NonNullable<Options["beforeSendTransaction"]>
>[0];

// Redact URL credentials + query strings from any URL embedded in free-form
// text (typically exception messages or breadcrumb descriptions). Host +
// path are preserved so "which provider failed" stays debuggable, but
// `?api_key=...`, `https://user:pass@...`, and `#fragment` are stripped.
// Does NOT cover path-embedded tokens (e.g. Infura `/v3/<key>`) — routes
// that call upstream RPC providers must do an additional targeted
// replacement at the call site.
function redactUrlQueryAndAuth(input: string): string {
  return input.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => {
    try {
      const u = new URL(url);
      u.search = "";
      u.hash = "";
      u.username = "";
      u.password = "";
      return u.href;
    } catch {
      return url;
    }
  });
}

// Scrub sensitive data before Sentry ships the event:
// - Session cookies + auth headers on the request.
// - URL credentials + query strings on `event.request.url` itself
//   (OAuth callbacks carry `code`/`state` there; NextAuth logger.error
//   captures include full URLs via the server request context).
// - URL credentials + query strings in every exception `value` and every
//   breadcrumb `message` / `data.url` field.
// Shared across the error + transaction paths — both event shapes carry
// the same optional `request.headers` bag. Exported so the browser SDK
// (instrumentation-client.ts) can apply the same scrubber.
export function stripAuthHeaders<T extends ErrorEvent | TransactionEvent>(
  event: T,
): T {
  if (event.request?.headers) {
    delete event.request.headers.cookie;
    delete event.request.headers.Cookie;
    delete event.request.headers.authorization;
    delete event.request.headers.Authorization;
  }
  if (typeof event.request?.url === "string") {
    event.request.url = redactUrlQueryAndAuth(event.request.url);
  }
  if ("exception" in event && event.exception?.values) {
    for (const exc of event.exception.values) {
      if (typeof exc.value === "string") {
        exc.value = redactUrlQueryAndAuth(exc.value);
      }
    }
  }
  if (event.breadcrumbs) {
    for (const bc of event.breadcrumbs) {
      if (typeof bc.message === "string") {
        bc.message = redactUrlQueryAndAuth(bc.message);
      }
      const url = bc.data?.url;
      if (typeof url === "string" && bc.data) {
        bc.data.url = redactUrlQueryAndAuth(url);
      }
    }
  }
  return event;
}

// Sample 20% of traces in production to stay within Sentry quota at scale;
// keep 100% on preview + local where traffic is low and full fidelity is
// useful for debugging. Tune once we have real volume data.
//
// Exported as a pure function so the client config (which reads
// NEXT_PUBLIC_VERCEL_ENV because plain VERCEL_ENV isn't exposed to the
// browser bundle) can share the same table of rates.
export function resolveTracesSampleRate(vercelEnv: string | undefined): number {
  return vercelEnv === "production" ? 0.2 : 1.0;
}

export function getServerSentryOptions(): Options {
  return {
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.VERCEL_ENV ?? "development",
    tracesSampleRate: resolveTracesSampleRate(process.env.VERCEL_ENV),
    sendDefaultPii: false,
    beforeSend: stripAuthHeaders,
    beforeSendTransaction: stripAuthHeaders,
  };
}
