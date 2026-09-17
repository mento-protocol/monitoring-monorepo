import type { ErrorEvent, init } from "@sentry/nextjs";

type Options = Parameters<typeof init>[0];
type TransactionEvent = Parameters<
  NonNullable<Options["beforeSendTransaction"]>
>[0];

type RequestHeaders = Record<string, unknown>;

function normalizeHostname(hostname: string): string {
  let normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  while (normalized.endsWith(".")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function hostnameFromHostHeader(host: string): string {
  const trimmed = host.trim();
  const bracketedIpv6 = trimmed.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketedIpv6) return bracketedIpv6[1] ?? trimmed;

  const firstColon = trimmed.indexOf(":");
  const lastColon = trimmed.lastIndexOf(":");
  if (firstColon !== -1 && firstColon === lastColon) {
    return trimmed.slice(0, firstColon);
  }
  return trimmed;
}

function isIpv4Loopback(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;

  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) return Number.NaN;
    return Number(part);
  });

  return (
    octets[0] === 127 &&
    octets.every(
      (octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255,
    )
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    isIpv4Loopback(normalized)
  );
}

function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

function getHeader(headers: RequestHeaders | undefined, name: string) {
  if (!headers) return undefined;
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerName) continue;
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  }
  return undefined;
}

function isLoopbackHostHeader(headers: RequestHeaders | undefined): boolean {
  for (const headerName of ["host", "x-forwarded-host"]) {
    const header = getHeader(headers, headerName);
    if (header && isLoopbackHostname(hostnameFromHostHeader(header))) {
      return true;
    }
  }
  return false;
}

function isLoopbackOriginHeader(headers: RequestHeaders | undefined): boolean {
  for (const headerName of ["origin", "referer"]) {
    const header = getHeader(headers, headerName);
    if (header && isLoopbackUrl(header)) return true;
  }
  return false;
}

function isLoopbackRequestEvent(event: ErrorEvent | TransactionEvent): boolean {
  if (
    typeof event.request?.url === "string" &&
    isLoopbackUrl(event.request.url)
  ) {
    return true;
  }

  const headers = event.request?.headers as RequestHeaders | undefined;
  return isLoopbackHostHeader(headers) || isLoopbackOriginHeader(headers);
}

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

export function filterAndStripSentryEvent<
  T extends ErrorEvent | TransactionEvent,
>(event: T): T | null {
  if (isLoopbackRequestEvent(event)) return null;
  if (isExtensionOnlyErrorEvent(event)) return null;
  return stripAuthHeaders(event);
}

// True only when the event carries at least one usable stack frame and every
// usable frame sits in an injected extension script. Sentry's own `denyUrls`
// would be the obvious home for this, but `_getEventFilterUrl` matches a single
// frame — the throw site — so a first-party error that throws inside an
// extension callback would be dropped with it. Requiring every frame keeps that
// error. `<anonymous>` and `[native code]` carry no URL, so they are skipped the
// way @sentry/core's `_getLastValidUrl` skips them.
function isExtensionOnlyErrorEvent(event: {
  exception?: {
    values?: { stacktrace?: { frames?: { filename?: string }[] } }[];
  };
}): boolean {
  let usableFrames = 0;
  for (const value of event.exception?.values ?? []) {
    for (const frame of value.stacktrace?.frames ?? []) {
      const filename = frame.filename;
      if (
        typeof filename !== "string" ||
        filename === "" ||
        filename === "<anonymous>" ||
        filename === "[native code]"
      ) {
        continue;
      }
      if (!EXTENSION_SCRIPT_DENY_URLS.some((pattern) => pattern.test(filename)))
        return false;
      usableFrames += 1;
    }
  }
  return usableFrames > 0;
}

// Wallet extensions (the MetaMask family) inject a provider script into every
// page and report their own connection failures through it, so the whole stack
// trace sits in the injected bundle. Match the extension URL scheme rather than
// the message, so an error our own code raises is still captured even when it
// reads like the extension message. Server and edge runtimes never load
// extension scripts, so the check is inert there.
const EXTENSION_SCRIPT_DENY_URLS: RegExp[] = [
  /^chrome-extension:\/\//i,
  /^moz-extension:\/\//i,
  /^safari-web-extension:\/\//i,
];

// Sample 20% of traces in production and disable performance tracing on
// preview and development deployments to preserve the Sentry quota.
//
// Exported as a pure function so the client config (which reads
// NEXT_PUBLIC_VERCEL_ENV because plain VERCEL_ENV isn't exposed to the
// browser bundle) can share the same table of rates.
export function resolveTracesSampleRate(vercelEnv: string | undefined): number {
  return vercelEnv === "production" ? 0.2 : 0;
}

// Sentry recommends skipping `Sentry.init` entirely outside production-like
// environments rather than relying on `enabled: false` (which still loads
// instrumentation) or an undefined DSN (same caveat). VERCEL_ENV is set on
// every Vercel deployment (production / preview / development) and unset on
// localhost, so it's the natural gate.
export function shouldEnableSentry(
  vercelEnv: string | undefined = process.env.VERCEL_ENV,
): boolean {
  return Boolean(vercelEnv);
}

export function getServerSentryOptions(): Options {
  return {
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.VERCEL_ENV ?? "development",
    tracesSampleRate: resolveTracesSampleRate(process.env.VERCEL_ENV),
    sendDefaultPii: false,
    beforeSend: filterAndStripSentryEvent,
    beforeSendTransaction: filterAndStripSentryEvent,
  };
}
