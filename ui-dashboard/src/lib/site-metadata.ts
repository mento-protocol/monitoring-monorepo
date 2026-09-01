export const PRODUCTION_SITE_ORIGIN = "https://monitoring.mento.org";

type HeaderReader = Pick<Headers, "get">;

function firstForwardedValue(value: string | null): string | null {
  const first = value?.split(",", 1)[0]?.trim();
  return first ? first : null;
}

function inferredProtocol(host: string): "http" | "https" {
  return host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("[::1]")
    ? "http"
    : "https";
}

function isAllowedMetadataHostname(hostname: string): boolean {
  return (
    hostname === new URL(PRODUCTION_SITE_ORIGIN).hostname ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".vercel.app")
  );
}

/**
 * Resolve social image URLs against the host that served the page. This keeps
 * localhost ports and Vercel preview deployments self-contained, while the
 * canonical production origin remains the fallback for build-time metadata.
 */
export function resolveMetadataBase(headers: HeaderReader): URL {
  const host = firstForwardedValue(
    headers.get("x-forwarded-host") ?? headers.get("host"),
  );
  if (host === null) return new URL(PRODUCTION_SITE_ORIGIN);
  const forwardedProtocol = firstForwardedValue(
    headers.get("x-forwarded-proto"),
  );
  const protocol =
    forwardedProtocol === "http" || forwardedProtocol === "https"
      ? forwardedProtocol
      : inferredProtocol(host);
  try {
    const candidate = new URL(`${protocol}://${host}`);
    return candidate.host === host &&
      isAllowedMetadataHostname(candidate.hostname)
      ? candidate
      : new URL(PRODUCTION_SITE_ORIGIN);
  } catch {
    return new URL(PRODUCTION_SITE_ORIGIN);
  }
}
