// Hermetic test guard: tests must not reach live network endpoints.
// Only loopback hosts (local mock servers) are allowed; anything else
// rejects so a forgotten mock fails fast instead of silently passing
// against live infrastructure. Issue #848. Keep this file byte-identical
// across all vitest workspaces.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const realFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = ((
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => {
  const rawUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const url = new URL(rawUrl, "http://127.0.0.1/");
  if (url.protocol !== "data:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    return Promise.reject(
      new Error(
        `[hermetic-test-guard] Blocked outbound request to ${rawUrl}. ` +
          "Tests must mock network calls; only loopback hosts are allowed.",
      ),
    );
  }
  return realFetch(input, init);
}) as typeof fetch;

export {};
