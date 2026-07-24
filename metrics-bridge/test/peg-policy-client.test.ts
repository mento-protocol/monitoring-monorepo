import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PegPolicyStore,
  validatePolicyTransition,
} from "../src/peg/policy-client.js";
import {
  parsePegPolicyBundle,
  pegPolicyVersionForContent,
  type PegPolicyBundle,
  type PegPolicyVersion,
} from "../src/peg/policy.js";
import type { FetchLike } from "../src/peg/types.js";

const POLICY_PATH = new URL(
  "../../alerts/rules/peg-thresholds.json",
  import.meta.url,
);
const PINNED_POLICY_URL = new URL(
  "https://storage.googleapis.com/download/storage/v1/b/mento-monitoring-peg-policy/o/peg-policy%2Fcurrent.json?alt=media&generation=1750000000000000",
);

async function policy(): Promise<PegPolicyBundle> {
  return parsePegPolicyBundle(
    JSON.parse(await readFile(POLICY_PATH, "utf8")) as unknown,
  );
}

function response(bundle: PegPolicyBundle, status = 200): Response {
  return new Response(JSON.stringify(bundle), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function versioned(
  prefix: string,
  candidate: PegPolicyVersion,
): PegPolicyVersion {
  return {
    ...candidate,
    version: pegPolicyVersionForContent(prefix, candidate),
  };
}

function trackedErrorResponse(status: number): {
  cancel: ReturnType<typeof vi.fn>;
  response: Response;
} {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("policy unavailable"));
    },
    cancel,
  });
  return { cancel, response: new Response(body, { status }) };
}

describe("Peg policy transitions", () => {
  it("treats object-key order as the same immutable policy content", async () => {
    const current = await policy();
    const asset = current.active.assets["europ-schuman"]!;
    const reversedSources = Object.fromEntries(
      Object.entries(asset.sources).reverse(),
    );
    const reordered = parsePegPolicyBundle({
      ...current,
      active: {
        ...current.active,
        assets: {
          "europ-schuman": { ...asset, sources: reversedSources },
        },
      },
    });

    expect(() => validatePolicyTransition(current, reordered)).not.toThrow();
  });

  it("rejects content mutation under a stale content-addressed version", async () => {
    const current = await policy();
    const activeAsset = current.active.assets["europ-schuman"];
    expect(activeAsset).toBeDefined();
    expect(() =>
      parsePegPolicyBundle({
        ...current,
        active: {
          ...current.active,
          assets: {
            ...current.active.assets,
            "europ-schuman": { ...activeAsset, warnDeviationBps: 30 },
          },
        },
      }),
    ).toThrow(/content digest/);
  });

  it("requires and verifies the complete previous package on rollover", async () => {
    const current = await policy();
    const nextActive = versioned("europ-v2", {
      ...current.active,
      version: "pending",
    });
    const missingPrevious = parsePegPolicyBundle({
      ...current,
      active: nextActive,
      previous: null,
    });
    expect(() => validatePolicyTransition(current, missingPrevious)).toThrow(
      /retain the complete previous version/,
    );

    const valid = parsePegPolicyBundle({
      ...current,
      active: nextActive,
      previous: current.active,
    });
    expect(() => validatePolicyTransition(current, valid)).not.toThrow();
  });

  it("allows reviewed post-ACK removal but not mutation of the retained previous package", async () => {
    const original = await policy();
    const nextActive = versioned("europ-v2", {
      ...original.active,
      version: "pending",
    });
    const current = parsePegPolicyBundle({
      ...original,
      active: nextActive,
      previous: original.active,
    });
    const droppedPrevious = parsePegPolicyBundle({
      ...current,
      previous: null,
    });
    expect(() =>
      validatePolicyTransition(current, droppedPrevious),
    ).not.toThrow();

    const mutatedPreviousPolicy = versioned("europ-v1-mutated", {
      ...current.previous!,
      version: "pending",
      rolloverAckExpectedSeconds: 301,
    });
    const mutatedPrevious = parsePegPolicyBundle({
      ...current,
      previous: mutatedPreviousPolicy,
    });
    expect(() => validatePolicyTransition(current, mutatedPrevious)).toThrow(
      /retained previous policy in place/,
    );

    expect(() => validatePolicyTransition(droppedPrevious, current)).toThrow(
      /retained previous policy in place/,
    );
  });

  it("requires ACK cleanup before another active rollover", async () => {
    const original = await policy();
    const secondActive = versioned("europ-v2", {
      ...original.active,
      version: "pending",
      rolloverAckExpectedSeconds: 301,
    });
    const second = parsePegPolicyBundle({
      ...original,
      active: secondActive,
      previous: original.active,
    });
    const thirdActive = versioned("europ-v3", {
      ...secondActive,
      version: "pending",
      rolloverAckExpectedSeconds: 302,
    });
    const third = parsePegPolicyBundle({
      ...second,
      active: thirdActive,
      previous: second.active,
    });

    expect(() => validatePolicyTransition(second, third)).toThrow(
      /requires ACK cleanup .* before another active rollover/,
    );

    const acknowledgedSecond = parsePegPolicyBundle({
      ...second,
      previous: null,
    });
    expect(() =>
      validatePolicyTransition(acknowledgedSecond, third),
    ).not.toThrow();
  });
});

describe("PegPolicyStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses bounded retry for a transient server response", async () => {
    const bundle = await policy();
    const retryable = trackedErrorResponse(503);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(retryable.response)
      .mockResolvedValueOnce(response(bundle));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const store = new PegPolicyStore();

    await expect(
      store.refresh(new URL("https://policy.invalid/v1.json"), {
        fetch,
        sleep,
      }),
    ).resolves.toEqual(bundle);
    expect(retryable.cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("adds a bearer token only to a validated pinned policy request", async () => {
    const bundle = await policy();
    const getToken = vi.fn().mockResolvedValue("test-token");
    const fetch = vi.fn().mockResolvedValue(response(bundle));
    const store = new PegPolicyStore();

    await store.refresh(PINNED_POLICY_URL, {
      fetch,
      bearerTokenProvider: { getToken },
    });

    expect(getToken).toHaveBeenCalledOnce();
    expect(getToken).toHaveBeenCalledWith(PINNED_POLICY_URL);
    const request = fetch.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("authorization")).toBe(
      "Bearer test-token",
    );
    expect(new Headers(request?.headers).get("Metadata-Flavor")).toBeNull();
    expect(request?.redirect).toBe("error");
  });

  it("rejects an unvalidated bearer target before token or policy fetch", async () => {
    const getToken = vi.fn().mockResolvedValue("test-token");
    const fetch = vi.fn();
    const store = new PegPolicyStore();

    await expect(
      store.refresh(new URL("https://attacker.invalid/policy.json"), {
        fetch,
        bearerTokenProvider: { getToken },
      }),
    ).rejects.toThrow(/generation-pinned GCS JSON media URL/);

    expect(getToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not retry anonymously when token acquisition fails", async () => {
    const acquisitionFailure = new Error("metadata unavailable");
    const providerFn = vi.fn().mockRejectedValue(acquisitionFailure);
    const fetch = vi.fn();
    const store = new PegPolicyStore();

    await expect(
      store.refresh(PINNED_POLICY_URL, {
        fetch,
        bearerTokenProvider: { getToken: providerFn },
      }),
    ).rejects.toThrow(/metadata unavailable/);

    expect(providerFn).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(store.current).toBeNull();
  });

  it("retains last-good policy when a later token acquisition fails", async () => {
    const bundle = await policy();
    const acquisitionFailure = new Error("metadata unavailable");
    const providerFn = vi
      .fn()
      .mockResolvedValueOnce("test-token")
      .mockRejectedValueOnce(acquisitionFailure);
    const fetch = vi.fn().mockResolvedValue(response(bundle));
    const store = new PegPolicyStore();
    const options = {
      fetch,
      bearerTokenProvider: { getToken: providerFn },
    };

    await store.refresh(PINNED_POLICY_URL, options);
    await expect(store.refresh(PINNED_POLICY_URL, options)).rejects.toThrow(
      /metadata unavailable/,
    );

    expect(fetch).toHaveBeenCalledOnce();
    expect(store.current).toEqual(bundle);
  });

  it("cancels a terminal HTTP response body before throwing", async () => {
    const terminal = trackedErrorResponse(400);
    const fetch = vi.fn().mockResolvedValueOnce(terminal.response);
    const store = new PegPolicyStore();

    await expect(
      store.refresh(new URL("https://policy.invalid/v1.json"), { fetch }),
    ).rejects.toThrow(/HTTP 400/);
    expect(terminal.cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retains last-good policy when refresh fails", async () => {
    const bundle = await policy();
    const store = new PegPolicyStore();
    await store.refresh(new URL("https://policy.invalid/v1.json"), {
      fetch: vi.fn().mockResolvedValue(response(bundle)),
    });

    await expect(
      store.refresh(new URL("https://policy.invalid/v1.json"), {
        fetch: vi
          .fn()
          .mockResolvedValueOnce(new Response("down", { status: 503 }))
          .mockResolvedValueOnce(new Response("down", { status: 503 })),
        sleep: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow(/HTTP 503/);
    expect(store.current).toEqual(bundle);
  });

  it("does not replace the last-good policy when candidate validation fails", async () => {
    const bundle = await policy();
    const nextActive = versioned("europ-v2", {
      ...bundle.active,
      version: "pending",
    });
    const candidate = parsePegPolicyBundle({
      ...bundle,
      active: nextActive,
      previous: bundle.active,
    });
    const store = new PegPolicyStore();
    await store.refresh(new URL("https://policy.invalid/v1.json"), {
      fetch: vi.fn().mockResolvedValue(response(bundle)),
    });

    await expect(
      store.refresh(
        new URL("https://policy.invalid/v1.json"),
        { fetch: vi.fn().mockResolvedValue(response(candidate)) },
        () => {
          throw new Error("candidate is incompatible with this producer");
        },
      ),
    ).rejects.toThrow(/incompatible/);
    expect(store.current).toEqual(bundle);
  });

  it("rejects an oversized response before parsing", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const store = new PegPolicyStore();
    await expect(
      store.refresh(new URL("https://policy.invalid/v1.json"), {
        fetch: vi.fn().mockResolvedValue(
          new Response(body, {
            headers: { "content-length": String(300 * 1024) },
          }),
        ),
      }),
    ).rejects.toThrow(/byte budget/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a streaming response as soon as it crosses the byte cap", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(200 * 1024));
        controller.enqueue(new Uint8Array(60 * 1024));
      },
      cancel,
    });
    const store = new PegPolicyStore();

    await expect(
      store.refresh(new URL("https://policy.invalid/v1.json"), {
        fetch: vi.fn().mockResolvedValue(new Response(body)),
      }),
    ).rejects.toThrow(/byte budget/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps the request timeout active while the response body stalls", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const fetch = vi.fn<FetchLike>(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected a request abort signal");
      observedSignal = signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener(
            "abort",
            () => controller.error(signal.reason),
            { once: true },
          );
        },
      });
      return new Response(body);
    });
    const store = new PegPolicyStore();

    const pending = store.refresh(new URL("https://policy.invalid/v1.json"), {
      fetch,
      timeoutMs: 25,
    });
    const assertion = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(25);

    await assertion;
    expect(observedSignal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
