import type { FetchLike } from "./types.js";

export const GCP_METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
export const GCP_METADATA_TOKEN_TIMEOUT_MS = 2_000;
export const GCP_METADATA_TOKEN_MAX_TIMEOUT_MS = 30_000;
export const GCP_METADATA_TOKEN_MAX_RESPONSE_BYTES = 16 * 1024;
export const GCP_METADATA_TOKEN_REFRESH_SKEW_MS = 60_000;
export const GCP_METADATA_TOKEN_MAX_LIFETIME_SECONDS = 24 * 60 * 60;
export const GCP_METADATA_TOKEN_MAX_REFRESH_SKEW_MS =
  GCP_METADATA_TOKEN_MAX_LIFETIME_SECONDS * 1_000;

const GCS_JSON_API_ORIGIN = "https://storage.googleapis.com";
const GCS_JSON_DOWNLOAD_PATH =
  /^\/download\/storage\/v1\/b\/([a-z0-9][a-z0-9._-]{1,220}[a-z0-9])\/o\/([^/]+)$/u;
const GCS_MAX_OBJECT_NAME_BYTES = 1_024;
const GCS_MAX_GENERATION = 9_223_372_036_854_775_807n;
const GCS_GENERATION_PATTERN = /^[1-9][0-9]{0,18}$/u;
const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+={0,}$/u;
const TOKEN_RESPONSE_KEYS = ["access_token", "expires_in", "token_type"];

export interface BearerTokenProvider {
  getToken(policyUrl: URL): Promise<string>;
}

export interface GcpMetadataBearerTokenProviderOptions {
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  refreshSkewMs?: number;
}

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

function boundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be a safe integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function hasExactPolicyQuery(url: URL): boolean {
  const altValues = url.searchParams.getAll("alt");
  const generationValues = url.searchParams.getAll("generation");
  const generation = generationValues[0];
  return (
    url.searchParams.size === 2 &&
    altValues.length === 1 &&
    altValues[0] === "media" &&
    generationValues.length === 1 &&
    generation !== undefined &&
    GCS_GENERATION_PATTERN.test(generation) &&
    BigInt(generation) <= GCS_MAX_GENERATION &&
    url.search === `?alt=media&generation=${generation}`
  );
}

function hasCanonicalObjectPath(pathname: string): boolean {
  const match = GCS_JSON_DOWNLOAD_PATH.exec(pathname);
  if (match === null) return false;
  const bucket = match[1];
  const encodedObject = match[2];
  if (
    bucket === undefined ||
    encodedObject === undefined ||
    bucket.includes("..")
  ) {
    return false;
  }
  try {
    const objectName = decodeURIComponent(encodedObject);
    return (
      objectName.length > 0 &&
      !objectName.includes("\u0000") &&
      new TextEncoder().encode(objectName).byteLength <=
        GCS_MAX_OBJECT_NAME_BYTES &&
      encodeURIComponent(objectName) === encodedObject
    );
  } catch {
    return false;
  }
}

export function isPinnedGcsJsonMediaUrl(url: URL): boolean {
  return (
    url.origin === GCS_JSON_API_ORIGIN &&
    url.protocol === "https:" &&
    url.hostname === "storage.googleapis.com" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "" &&
    hasCanonicalObjectPath(url.pathname) &&
    hasExactPolicyQuery(url)
  );
}

export function parsePinnedGcsJsonMediaUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid pinned GCS policy URL");
  }
  if (url.href !== raw || !isPinnedGcsJsonMediaUrl(url)) {
    throw new Error("invalid pinned GCS policy URL");
  }
  return url;
}

export function assertPinnedGcsJsonMediaUrl(url: URL): void {
  if (!isPinnedGcsJsonMediaUrl(url)) {
    throw new Error(
      "GCP metadata auth requires a generation-pinned GCS JSON media URL",
    );
  }
}

async function readBoundedTokenResponse(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    Number(contentLength) > GCP_METADATA_TOKEN_MAX_RESPONSE_BYTES
  ) {
    await response.body?.cancel();
    throw new Error("GCP metadata token response exceeds the byte budget");
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > GCP_METADATA_TOKEN_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("GCP metadata token response exceeds the byte budget");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

function parseTokenRecord(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("GCP metadata token response is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GCP metadata token response has an invalid shape");
  }
  const candidate = parsed as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (
    keys.length !== TOKEN_RESPONSE_KEYS.length ||
    keys.some((key, index) => key !== TOKEN_RESPONSE_KEYS[index])
  ) {
    throw new Error("GCP metadata token response has an invalid shape");
  }
  return candidate;
}

function parseAccessToken(candidate: Record<string, unknown>): string {
  const accessToken = candidate.access_token;
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    accessToken.length > 8_192 ||
    !BEARER_TOKEN_PATTERN.test(accessToken)
  ) {
    throw new Error("GCP metadata token response has an invalid access token");
  }
  return accessToken;
}

function parseTokenLifetime(candidate: Record<string, unknown>): number {
  const expiresInSeconds = candidate.expires_in;
  if (
    typeof expiresInSeconds !== "number" ||
    !Number.isSafeInteger(expiresInSeconds) ||
    expiresInSeconds <= 0 ||
    expiresInSeconds > GCP_METADATA_TOKEN_MAX_LIFETIME_SECONDS
  ) {
    throw new Error("GCP metadata token response has an invalid lifetime");
  }
  return expiresInSeconds;
}

function validateTokenType(candidate: Record<string, unknown>): void {
  const tokenType = candidate.token_type;
  if (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer") {
    throw new Error("GCP metadata token response has an invalid token type");
  }
}

function parseTokenResponse(raw: string): {
  accessToken: string;
  expiresInSeconds: number;
} {
  const candidate = parseTokenRecord(raw);
  const accessToken = parseAccessToken(candidate);
  const expiresInSeconds = parseTokenLifetime(candidate);
  validateTokenType(candidate);
  return { accessToken, expiresInSeconds };
}

export class GcpMetadataBearerTokenProvider implements BearerTokenProvider {
  #cached: CachedToken | null = null;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #refreshSkewMs: number;

  constructor(options: GcpMetadataBearerTokenProviderOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = boundedInteger(
      options.timeoutMs ?? GCP_METADATA_TOKEN_TIMEOUT_MS,
      "GCP metadata token timeout",
      1,
      GCP_METADATA_TOKEN_MAX_TIMEOUT_MS,
    );
    this.#refreshSkewMs = boundedInteger(
      options.refreshSkewMs ?? GCP_METADATA_TOKEN_REFRESH_SKEW_MS,
      "GCP metadata token refresh skew",
      0,
      GCP_METADATA_TOKEN_MAX_REFRESH_SKEW_MS,
    );
  }

  async getToken(policyUrl: URL): Promise<string> {
    assertPinnedGcsJsonMediaUrl(policyUrl);
    const now = this.#now();
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now >
        Number.MAX_SAFE_INTEGER -
          GCP_METADATA_TOKEN_MAX_LIFETIME_SECONDS * 1_000
    ) {
      throw new Error("GCP metadata token clock is invalid");
    }
    if (
      this.#cached !== null &&
      now < this.#cached.expiresAtMs - this.#refreshSkewMs
    ) {
      return this.#cached.value;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(GCP_METADATA_TOKEN_URL, {
        method: "GET",
        headers: { "Metadata-Flavor": "Google" },
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
          `GCP metadata token request failed with HTTP ${response.status}`,
        );
      }
      const token = parseTokenResponse(
        await readBoundedTokenResponse(response),
      );
      const expiresAtMs = now + token.expiresInSeconds * 1_000;
      if (!Number.isSafeInteger(expiresAtMs)) {
        throw new Error("GCP metadata token response has an invalid lifetime");
      }
      this.#cached = {
        value: token.accessToken,
        expiresAtMs,
      };
      return token.accessToken;
    } finally {
      clearTimeout(timeout);
    }
  }
}
