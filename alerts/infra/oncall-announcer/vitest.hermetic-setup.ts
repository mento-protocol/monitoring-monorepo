// Hermetic test guard: tests must not reach live network endpoints.
// Only loopback hosts (local mock servers) are allowed; anything else
// rejects so a forgotten mock fails fast instead of silently passing
// against live infrastructure. Issue #848. Keep this file byte-identical
// across all vitest workspaces.
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { afterEach } from "vitest";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

process.env.METADATA_SERVER_DETECTION ??= "none";

const realFetch = globalThis.fetch.bind(globalThis);
const realHttpRequest = http.request.bind(http) as RequestFunction;
const realHttpGet = http.get.bind(http) as RequestFunction;
const realHttpsRequest = https.request.bind(https) as RequestFunction;
const realHttpsGet = https.get.bind(https) as RequestFunction;

type RequestFunction = (...args: unknown[]) => ReturnType<typeof http.request>;

declare global {
  // Tests that intentionally assert the guard blocks a request must opt in
  // before making that request, otherwise swallowed probe failures fail teardown.
  // eslint-disable-next-line no-var
  var __hermeticTestGuardExpectBlockedRequests:
    | ((count?: number) => void)
    | undefined;
}

type RequestOptionsLike = {
  protocol?: unknown;
  hostname?: unknown;
  host?: unknown;
  port?: unknown;
  path?: unknown;
  pathname?: unknown;
};

const isRequestOptions = (value: unknown): value is RequestOptionsLike =>
  value !== null && typeof value === "object" && !(value instanceof URL);

const isAbsoluteHttpUrl = (value: string) => /^https?:/i.test(value);

const parseUrlInput = (
  input: string | URL,
  defaultProtocol: "http:" | "https:",
) => {
  const rawUrl = input instanceof URL ? input.href : input;
  if (isAbsoluteHttpUrl(rawUrl)) {
    return new URL(rawUrl);
  }
  return new URL(rawUrl, `${defaultProtocol}//127.0.0.1/`);
};

const valueAsString = (value: unknown): string | undefined => {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return undefined;
};

const normalizeProtocol = (protocol: string) =>
  protocol.endsWith(":") ? protocol : `${protocol}:`;

const bracketIpv6Hostname = (hostname: string) =>
  hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname;

const requestAuthority = (options: RequestOptionsLike) => {
  const hostname = valueAsString(options.hostname);
  if (hostname) {
    const port = valueAsString(options.port);
    const authority = bracketIpv6Hostname(hostname);
    return port ? `${authority}:${port}` : authority;
  }

  return valueAsString(options.host);
};

const applyRequestOptions = (
  url: URL,
  options: RequestOptionsLike,
  defaultProtocol: "http:" | "https:",
) => {
  const protocol = valueAsString(options.protocol);
  if (protocol) {
    url.protocol = normalizeProtocol(protocol);
  } else if (!url.protocol) {
    url.protocol = defaultProtocol;
  }

  const authority = requestAuthority(options);
  if (authority) {
    url.host = authority;
  }

  const path = valueAsString(options.path ?? options.pathname);
  if (path) {
    applyRequestPath(url, path);
  }
};

const applyRequestPath = (url: URL, path: string) => {
  const pathUrl = new URL(path, `${url.protocol}//${url.host || "127.0.0.1"}/`);
  url.pathname = pathUrl.pathname;
  url.search = pathUrl.search;
};

const requestUrlFromOptions = (
  options: RequestOptionsLike,
  defaultProtocol: "http:" | "https:",
) => {
  const protocol = normalizeProtocol(
    valueAsString(options.protocol) ?? defaultProtocol,
  );
  const authority = requestAuthority(options);
  const url = new URL(`${protocol}//${authority ?? "127.0.0.1"}/`);
  const path = valueAsString(options.path ?? options.pathname);
  if (path) {
    if (authority === undefined && isAbsoluteHttpUrl(path)) {
      return new URL(path);
    }
    try {
      applyRequestPath(url, path);
    } catch {
      return url;
    }
  }
  return url;
};

const requestUrlFromArgs = (
  defaultProtocol: "http:" | "https:",
  args: unknown[],
) => {
  try {
    const [input, maybeOptions] = args;
    if (typeof input === "string" || input instanceof URL) {
      const url = parseUrlInput(input, defaultProtocol);
      if (isRequestOptions(maybeOptions)) {
        try {
          applyRequestOptions(url, maybeOptions, defaultProtocol);
        } catch {
          return url;
        }
      }
      return url;
    }
    if (isRequestOptions(input)) {
      return requestUrlFromOptions(input, defaultProtocol);
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const redactedUrl = (url: URL) => {
  const authority = url.host || url.hostname;
  return authority ? `${url.protocol}//${authority}` : url.protocol;
};

const blockedError = (url: URL) =>
  new Error(
    `[hermetic-test-guard] Blocked outbound request to ${redactedUrl(url)}. ` +
      "Tests must mock network calls; only loopback hosts are allowed.",
  );

const blockedRequests: Error[] = [];
let expectedBlockedRequests = 0;

globalThis.__hermeticTestGuardExpectBlockedRequests = (count = 1) => {
  expectedBlockedRequests += count;
};

const recordBlockedRequest = (url: URL) => {
  const error = blockedError(url);
  blockedRequests.push(error);
  return error;
};

const assertUrlAllowed = (url: URL) => {
  if (url.protocol !== "data:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw recordBlockedRequest(url);
  }
};

afterEach(() => {
  const actual = blockedRequests.length;
  const expected = expectedBlockedRequests;
  const firstBlockedMessage = blockedRequests[0]?.message;

  blockedRequests.length = 0;
  expectedBlockedRequests = 0;

  if (actual !== expected) {
    const expectation =
      expected === 0
        ? "No blocked requests were expected."
        : `${expected} blocked request(s) were expected.`;
    throw new Error(
      `[hermetic-test-guard] ${actual} blocked request(s) observed. ${expectation}` +
        (firstBlockedMessage
          ? ` First blocked request: ${firstBlockedMessage}`
          : ""),
    );
  }
});

const guardRequest =
  (
    defaultProtocol: "http:" | "https:",
    realRequest: RequestFunction,
  ): RequestFunction =>
  (...args: unknown[]) => {
    const url = requestUrlFromArgs(defaultProtocol, args);
    if (url) {
      assertUrlAllowed(url);
    }
    return realRequest(...args);
  };

const guardedFetchInit = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Parameters<typeof fetch>[1] => {
  const redirectMode =
    init?.redirect ?? (input instanceof Request ? input.redirect : undefined);
  if (redirectMode === "manual" || redirectMode === "error") {
    return init;
  }
  return { ...init, redirect: "manual" };
};

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
  let url: URL;
  try {
    url = parseUrlInput(rawUrl, "http:");
  } catch {
    return realFetch(input, init);
  }
  try {
    assertUrlAllowed(url);
  } catch (error) {
    return Promise.reject(error);
  }
  return realFetch(input, guardedFetchInit(input, init));
}) as typeof fetch;

http.request = guardRequest("http:", realHttpRequest) as typeof http.request;
http.get = guardRequest("http:", realHttpGet) as typeof http.get;
https.request = guardRequest(
  "https:",
  realHttpsRequest,
) as typeof https.request;
https.get = guardRequest("https:", realHttpsGet) as typeof https.get;
syncBuiltinESMExports();

export {};
