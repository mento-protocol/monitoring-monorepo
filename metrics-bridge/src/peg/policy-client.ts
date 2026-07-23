import {
  parsePegPolicyBundle,
  type PegPolicyBundle,
  type PegPolicyVersion,
} from "./policy.js";
import type { FetchLike, Sleep } from "./types.js";

export const PEG_POLICY_MAX_RESPONSE_BYTES = 256 * 1024;
export const PEG_POLICY_REQUEST_TIMEOUT_MS = 8_000;
export const PEG_POLICY_MAX_RETRIES = 1;

const defaultSleep: Sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface PegPolicyClientOptions {
  fetch?: FetchLike;
  sleep?: Sleep;
  timeoutMs?: number;
}

function validateRetainedPrevious(
  current: PegPolicyBundle,
  next: PegPolicyBundle,
): void {
  const currentPrevious = current.previous;
  const nextPrevious = next.previous;
  const reintroduced = currentPrevious === null && nextPrevious !== null;
  const mutated =
    currentPrevious !== null &&
    nextPrevious !== null &&
    policyFingerprint(currentPrevious) !== policyFingerprint(nextPrevious);
  if (reintroduced || mutated) {
    throw new Error(
      `Peg policy version ${next.active.version} changed its retained previous policy in place`,
    );
  }
}

function validateSameActiveVersion(
  current: PegPolicyBundle,
  next: PegPolicyBundle,
): void {
  if (policyFingerprint(current.active) !== policyFingerprint(next.active)) {
    throw new Error(
      `Peg policy version ${next.active.version} changed content in place`,
    );
  }
  validateRetainedPrevious(current, next);
}

function policyFingerprint(policy: PegPolicyVersion): string {
  return JSON.stringify(policy, (_key, value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  });
}

/**
 * Enforce immutable versions and an unbroken active -> previous handoff.
 * Wall clock never removes old-version acceptance: the protected rules apply
 * does that only after the producer ACKs the new active version.
 */
export function validatePolicyTransition(
  current: PegPolicyBundle | null,
  next: PegPolicyBundle,
): void {
  if (!current) return;
  if (current.active.version === next.active.version) {
    validateSameActiveVersion(current, next);
    return;
  }
  if (current.previous !== null) {
    throw new Error(
      `Peg policy rollover ${current.active.version} -> ${next.active.version} requires ACK cleanup of the retained previous policy before another active rollover`,
    );
  }
  if (next.previous?.version !== current.active.version) {
    throw new Error(
      `Peg policy rollover ${current.active.version} -> ${next.active.version} must retain the complete previous version`,
    );
  }
  if (policyFingerprint(next.previous) !== policyFingerprint(current.active)) {
    throw new Error(
      `Peg policy rollover ${next.active.version} mutated the retained previous policy`,
    );
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    Number(contentLength) > PEG_POLICY_MAX_RESPONSE_BYTES
  ) {
    await response.body?.cancel();
    throw new Error("Peg policy response exceeds the byte budget");
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > PEG_POLICY_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Peg policy response exceeds the byte budget");
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

async function fetchOnce(
  url: URL,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<
  | { kind: "success"; bundle: PegPolicyBundle }
  | { kind: "http-error"; status: number }
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { kind: "http-error", status: response.status };
    }
    const body = await readBoundedResponse(response);
    return {
      kind: "success",
      bundle: parsePegPolicyBundle(JSON.parse(body) as unknown),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchPegPolicyBundle(
  url: URL,
  options: PegPolicyClientOptions = {},
): Promise<PegPolicyBundle> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? PEG_POLICY_REQUEST_TIMEOUT_MS;

  for (let attempt = 0; attempt <= PEG_POLICY_MAX_RETRIES; attempt += 1) {
    const result = await fetchOnce(url, fetchImpl, timeoutMs);
    if (result.kind === "success") {
      return result.bundle;
    }
    const retryable = result.status === 429 || result.status >= 500;
    if (!retryable || attempt === PEG_POLICY_MAX_RETRIES) {
      throw new Error(`Peg policy request failed with HTTP ${result.status}`);
    }
    await sleep(250 * (attempt + 1));
  }
  throw new Error("Peg policy request exhausted its bounded retry budget");
}

export class PegPolicyStore {
  #bundle: PegPolicyBundle | null = null;

  get current(): PegPolicyBundle | null {
    return this.#bundle;
  }

  async refresh(
    url: URL,
    options: PegPolicyClientOptions = {},
    validate?: (bundle: PegPolicyBundle) => void,
  ): Promise<PegPolicyBundle> {
    const next = await fetchPegPolicyBundle(url, options);
    validatePolicyTransition(this.#bundle, next);
    validate?.(next);
    this.#bundle = next;
    return next;
  }
}
