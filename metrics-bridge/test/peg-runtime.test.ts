import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { assertPegPolicyRegistrySupportsPolicy } from "../src/peg/compatibility.js";
import {
  parsePegPolicyBundle,
  pegPolicyVersionForContent,
  type PegPolicyVersion,
} from "../src/peg/policy.js";
import type { PegPoller } from "../src/peg/poller.js";
import { loadPegRegistry, parsePegRegistry } from "../src/peg/registry.js";
import {
  createPegRuntime,
  startPegPolling,
  type PegRuntimeErrorEvent,
} from "../src/peg/runtime.js";

const POLICY_PATH = new URL(
  "../../alerts/rules/peg-thresholds.json",
  import.meta.url,
);

async function policy() {
  return parsePegPolicyBundle(
    JSON.parse(await readFile(POLICY_PATH, "utf8")) as unknown,
  );
}

function policyResponse(value: Awaited<ReturnType<typeof policy>>): Response {
  return new Response(JSON.stringify(value), {
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

function poller(
  implementation: PegPoller["pollCycle"] = vi.fn().mockResolvedValue([]),
): PegPoller {
  return { pollCycle: implementation };
}

describe("Peg runtime isolation", () => {
  it("starts in dormant mode without scheduling or loading protected state", () => {
    const loadRegistry = vi.fn();
    const runtime = createPegRuntime({
      policyUrl: null,
      loadRegistry,
      poller: poller(),
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(startPegPolling(runtime)).toBe(runtime);
    expect(log).toHaveBeenCalledWith(
      "metrics-bridge peg polling dormant: PEG_POLICY_URL is not provisioned",
    );
    expect(loadRegistry).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("stays intentionally dormant without a protected policy URL", async () => {
    const loadRegistry = vi.fn();
    const pegPoller = poller();
    const runtime = createPegRuntime({
      policyUrl: null,
      loadRegistry,
      poller: pegPoller,
    });

    await expect(runtime.runCycle()).resolves.toBeUndefined();
    expect(runtime.status).toBe("dormant");
    expect(loadRegistry).not.toHaveBeenCalled();
    expect(pegPoller.pollCycle).not.toHaveBeenCalled();
  });

  it("reports malformed configuration once without touching the primary loop", async () => {
    const errors: PegRuntimeErrorEvent[] = [];
    const loadRegistry = vi.fn();
    const runtime = createPegRuntime({
      policyUrl: "not a protected URL",
      loadRegistry,
      onError: (event) => errors.push(event),
    });

    await runtime.runCycle();
    await runtime.runCycle();
    expect(runtime.status).toBe("misconfigured");
    expect(errors.map(({ kind }) => kind)).toEqual(["policy_config"]);
    expect(loadRegistry).not.toHaveBeenCalled();
  });

  it("loads the static registry once and refreshes policy every cycle", async () => {
    const bundle = await policy();
    const registry = await loadPegRegistry();
    const loadRegistry = vi.fn().mockResolvedValue(registry);
    const fetch = vi.fn().mockImplementation(() => policyResponse(bundle));
    const pegPoller = poller();
    const runtime = createPegRuntime({
      policyUrl: "https://policy.invalid/peg.json",
      loadRegistry,
      policyClientOptions: { fetch },
      poller: pegPoller,
    });

    await runtime.runCycle();
    await runtime.runCycle();
    expect(runtime.status).toBe("active");
    expect(loadRegistry).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(pegPoller.pollCycle).toHaveBeenCalledTimes(2);
    expect(pegPoller.pollCycle).toHaveBeenLastCalledWith({
      registry,
      policies: [bundle.active],
    });
  });

  it("retains and polls the last-good policy after a refresh outage", async () => {
    const bundle = await policy();
    const registry = await loadPegRegistry();
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => policyResponse(bundle))
      .mockResolvedValue(new Response("unavailable", { status: 503 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const errors: PegRuntimeErrorEvent[] = [];
    const pegPoller = poller();
    const runtime = createPegRuntime({
      policyUrl: "https://policy.invalid/peg.json",
      loadRegistry: vi.fn().mockResolvedValue(registry),
      policyClientOptions: { fetch, sleep },
      poller: pegPoller,
      onError: (event) => errors.push(event),
    });

    await runtime.runCycle();
    await runtime.runCycle();
    expect(runtime.status).toBe("active");
    expect(pegPoller.pollCycle).toHaveBeenCalledTimes(2);
    expect(errors.map(({ kind }) => kind)).toEqual(["policy_fetch"]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retries registry load on a later cycle without escaping failures", async () => {
    const bundle = await policy();
    const registry = await loadPegRegistry();
    const loadRegistry = vi
      .fn()
      .mockRejectedValueOnce(new Error("registry unavailable"))
      .mockResolvedValueOnce(registry);
    const errors: PegRuntimeErrorEvent[] = [];
    const pegPoller = poller();
    const runtime = createPegRuntime({
      policyUrl: "https://policy.invalid/peg.json",
      loadRegistry,
      policyClientOptions: {
        fetch: vi.fn().mockImplementation(() => policyResponse(bundle)),
      },
      poller: pegPoller,
      onError: (event) => errors.push(event),
    });

    await expect(runtime.runCycle()).resolves.toBeUndefined();
    expect(runtime.status).toBe("waiting");
    await expect(runtime.runCycle()).resolves.toBeUndefined();
    expect(runtime.status).toBe("active");
    expect(loadRegistry).toHaveBeenCalledTimes(2);
    expect(errors.map(({ kind }) => kind)).toEqual(["registry_load"]);
    expect(pegPoller.pollCycle).toHaveBeenCalledOnce();
  });

  it("contains an unexpected poller rejection", async () => {
    const bundle = await policy();
    const registry = await loadPegRegistry();
    const errors: PegRuntimeErrorEvent[] = [];
    const runtime = createPegRuntime({
      policyUrl: "https://policy.invalid/peg.json",
      loadRegistry: vi.fn().mockResolvedValue(registry),
      policyClientOptions: {
        fetch: vi.fn().mockImplementation(() => policyResponse(bundle)),
      },
      poller: poller(vi.fn().mockRejectedValue(new Error("unexpected"))),
      onError: (event) => errors.push(event),
    });

    await expect(runtime.runCycle()).resolves.toBeUndefined();
    expect(runtime.status).toBe("waiting");
    expect(errors.map(({ kind }) => kind)).toEqual(["poller_cycle"]);
  });

  it.each([
    ["primary", "deep"],
    ["primary", "secondary"],
    ["primary", "display"],
    ["secondary", "secondary"],
    ["secondary", "display"],
    ["display", "display"],
  ] as const)(
    "supports %s registry topology with %s policy authority",
    async (role, authority) => {
      const bundle = await policy();
      const registry = structuredClone(await loadPegRegistry());
      const registrySource = registry["europ-schuman"]!.sources.find(
        ({ id }) => id === "kraken_eur",
      )!;
      const policyVersion = structuredClone(bundle.active);
      registrySource.role = role;
      policyVersion.assets["europ-schuman"]!.sources.kraken_eur!.authority =
        authority;

      expect(() =>
        assertPegPolicyRegistrySupportsPolicy(registry, policyVersion),
      ).not.toThrow();
    },
  );

  it.each([
    ["secondary", "deep", /deep authority requires primary topology/],
    ["display", "deep", /deep authority requires primary topology/],
    ["display", "secondary", /display topology cannot carry alert authority/],
  ] as const)(
    "rejects %s registry topology with %s policy authority",
    async (role, authority, expected) => {
      const bundle = await policy();
      const registry = structuredClone(await loadPegRegistry());
      const registrySource = registry["europ-schuman"]!.sources.find(
        ({ id }) => id === "kraken_eur",
      )!;
      const policyVersion = structuredClone(bundle.active);
      registrySource.role = role;
      policyVersion.assets["europ-schuman"]!.sources.kraken_eur!.authority =
        authority;

      expect(() =>
        assertPegPolicyRegistrySupportsPolicy(registry, policyVersion),
      ).toThrow(expected);
    },
  );

  it.each(["active", "previous"] as const)(
    "accepts display authority on secondary topology in the %s policy",
    async (versionName) => {
      const bundle = await policy();
      const registry = await loadPegRegistry();
      const displayVersion = structuredClone(bundle.active);
      displayVersion.assets["europ-schuman"]!.sources.kraken_eur!.authority =
        "display";
      const compatibleDisplay = versioned(
        `europ-${versionName}-display`,
        displayVersion,
      );
      const rollover = parsePegPolicyBundle({
        ...bundle,
        active: versionName === "active" ? compatibleDisplay : bundle.active,
        previous:
          versionName === "previous" ? compatibleDisplay : bundle.active,
      });
      const pegPoller = poller();
      const runtime = createPegRuntime({
        policyUrl: "https://policy.invalid/peg.json",
        loadRegistry: vi.fn().mockResolvedValue(registry),
        policyClientOptions: {
          fetch: vi.fn().mockImplementation(() => policyResponse(rollover)),
        },
        poller: pegPoller,
      });

      await runtime.runCycle();

      expect(runtime.status).toBe("active");
      expect(pegPoller.pollCycle).toHaveBeenCalledWith({
        registry,
        policies: [rollover.active, rollover.previous],
      });
    },
  );

  it.each(["active", "previous"] as const)(
    "fails closed for deep authority on secondary topology in the %s policy",
    async (versionName) => {
      const bundle = await policy();
      const registry = await loadPegRegistry();
      const invalidVersion = structuredClone(bundle.active);
      const invalidAsset = invalidVersion.assets["europ-schuman"]!;
      invalidAsset.sources.bitvavo_eur!.authority = "secondary";
      invalidAsset.sources.kraken_eur!.authority = "deep";
      invalidAsset.deepVenueSource = "kraken_eur";
      const incompatible = versioned(
        `europ-${versionName}-deep`,
        invalidVersion,
      );
      const rollover = parsePegPolicyBundle({
        ...bundle,
        active: versionName === "active" ? incompatible : bundle.active,
        previous: versionName === "previous" ? incompatible : bundle.active,
      });
      const errors: PegRuntimeErrorEvent[] = [];
      const pegPoller = poller();
      const runtime = createPegRuntime({
        policyUrl: "https://policy.invalid/peg.json",
        loadRegistry: vi.fn().mockResolvedValue(registry),
        policyClientOptions: {
          fetch: vi.fn().mockImplementation(() => policyResponse(rollover)),
        },
        poller: pegPoller,
        onError: (event) => errors.push(event),
      });

      await runtime.runCycle();

      if (versionName === "active") {
        expect(runtime.status).toBe("active");
        expect(pegPoller.pollCycle).toHaveBeenCalledWith({
          registry,
          policies: [bundle.active],
        });
        expect(errors).toEqual([]);
      } else {
        expect(runtime.status).toBe("waiting");
        expect(pegPoller.pollCycle).not.toHaveBeenCalled();
        expect(errors.map(({ kind }) => kind)).toEqual([
          "policy_compatibility",
        ]);
      }
    },
  );

  it("does not acknowledge policy for topology the baked registry cannot serve", async () => {
    const bundle = await policy();
    const registry = await loadPegRegistry();
    const asset = bundle.active.assets["europ-schuman"]!;
    const incompatibleActive = versioned("europ-incompatible", {
      ...bundle.active,
      assets: {
        ...bundle.active.assets,
        "europ-schuman": {
          ...asset,
          sources: {
            ...asset.sources,
            kraken_extra: {
              ...asset.sources.kraken_eur!,
              authority: "secondary",
            },
          },
        },
      },
    });
    const incompatible = parsePegPolicyBundle({
      ...bundle,
      active: incompatibleActive,
    });
    const errors: PegRuntimeErrorEvent[] = [];
    const pegPoller = poller();
    const runtime = createPegRuntime({
      policyUrl: "https://policy.invalid/peg.json",
      loadRegistry: vi.fn().mockResolvedValue(registry),
      policyClientOptions: {
        fetch: vi.fn().mockImplementation(() => policyResponse(incompatible)),
      },
      poller: pegPoller,
      onError: (event) => errors.push(event),
    });

    await runtime.runCycle();

    expect(runtime.status).toBe("waiting");
    expect(pegPoller.pollCycle).not.toHaveBeenCalled();
    expect(errors.map(({ kind }) => kind)).toEqual(["policy_compatibility"]);
  });

  it("accepts a rollover artifact and polls its retained policy when active exceeds the baked topology", async () => {
    const bundle = await policy();
    const registry = await loadPegRegistry();
    const asset = bundle.active.assets["europ-schuman"]!;
    const incompatibleActive = versioned("europ-v2", {
      ...bundle.active,
      assets: {
        ...bundle.active.assets,
        "europ-schuman": {
          ...asset,
          sources: {
            ...asset.sources,
            kraken_extra: {
              ...asset.sources.kraken_eur!,
              authority: "secondary",
            },
          },
        },
      },
    });
    const incompatible = parsePegPolicyBundle({
      ...bundle,
      active: incompatibleActive,
      previous: bundle.active,
    });
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => policyResponse(bundle))
      .mockImplementationOnce(() => policyResponse(incompatible));
    const errors: PegRuntimeErrorEvent[] = [];
    const pegPoller = poller();
    const runtime = createPegRuntime({
      policyUrl: "https://policy.invalid/peg.json",
      loadRegistry: vi.fn().mockResolvedValue(registry),
      policyClientOptions: { fetch },
      poller: pegPoller,
      onError: (event) => errors.push(event),
    });

    await runtime.runCycle();
    await runtime.runCycle();

    expect(runtime.status).toBe("active");
    expect(pegPoller.pollCycle).toHaveBeenCalledTimes(2);
    expect(pegPoller.pollCycle).toHaveBeenLastCalledWith({
      registry,
      policies: [bundle.active],
    });
    expect(pegPoller.pollCycle).not.toHaveBeenCalledWith(
      expect.objectContaining({
        policies: expect.arrayContaining([incompatibleActive]),
      }),
    );
    expect(errors).toEqual([]);
  });

  it("cold-starts from the retained policy when only it matches the baked registry", async () => {
    const bundle = await policy();
    const registry = await loadPegRegistry();
    const asset = bundle.active.assets["europ-schuman"]!;
    const incompatibleActive = versioned("europ-v2", {
      ...bundle.active,
      assets: {
        ...bundle.active.assets,
        "europ-schuman": {
          ...asset,
          sources: {
            ...asset.sources,
            kraken_extra: {
              ...asset.sources.kraken_eur!,
              authority: "secondary",
            },
          },
        },
      },
    });
    const rollover = parsePegPolicyBundle({
      ...bundle,
      active: incompatibleActive,
      previous: bundle.active,
    });
    const errors: PegRuntimeErrorEvent[] = [];
    const pegPoller = poller();
    const runtime = createPegRuntime({
      policyUrl: "https://policy.invalid/peg.json",
      loadRegistry: vi.fn().mockResolvedValue(registry),
      policyClientOptions: {
        fetch: vi.fn().mockImplementation(() => policyResponse(rollover)),
      },
      poller: pegPoller,
      onError: (event) => errors.push(event),
    });

    await runtime.runCycle();

    expect(runtime.status).toBe("active");
    expect(pegPoller.pollCycle).toHaveBeenCalledOnce();
    expect(pegPoller.pollCycle).toHaveBeenCalledWith({
      registry,
      policies: [bundle.active],
    });
    expect(pegPoller.pollCycle).not.toHaveBeenCalledWith(
      expect.objectContaining({
        policies: expect.arrayContaining([incompatibleActive]),
      }),
    );
    expect(errors).toEqual([]);
  });

  it("polls active first and retained previous when both match the baked registry", async () => {
    const bundle = await policy();
    const registry = await loadPegRegistry();
    const compatibleActive = versioned("europ-v2", {
      ...bundle.active,
      rolloverAckExpectedSeconds: 360,
    });
    const rollover = parsePegPolicyBundle({
      ...bundle,
      active: compatibleActive,
      previous: bundle.active,
    });
    const pegPoller = poller();
    const runtime = createPegRuntime({
      policyUrl: "https://policy.invalid/peg.json",
      loadRegistry: vi.fn().mockResolvedValue(registry),
      policyClientOptions: {
        fetch: vi.fn().mockImplementation(() => policyResponse(rollover)),
      },
      poller: pegPoller,
    });

    await runtime.runCycle();

    expect(runtime.status).toBe("active");
    expect(pegPoller.pollCycle).toHaveBeenCalledOnce();
    expect(pegPoller.pollCycle).toHaveBeenCalledWith({
      registry,
      policies: [compatibleActive, bundle.active],
    });
  });

  it("rejects active-only production while retained topology is unsupported", async () => {
    const bundle = await policy();
    const registry = await loadPegRegistry();
    const asset = bundle.active.assets["europ-schuman"]!;
    const incompatiblePrevious = versioned("europ-v0", {
      ...bundle.active,
      assets: {
        ...bundle.active.assets,
        "europ-schuman": {
          ...asset,
          sources: {
            ...asset.sources,
            kraken_extra: {
              ...asset.sources.kraken_eur!,
              authority: "secondary",
            },
          },
        },
      },
    });
    const activeOnly = parsePegPolicyBundle({
      ...bundle,
      previous: incompatiblePrevious,
    });
    const errors: PegRuntimeErrorEvent[] = [];
    const pegPoller = poller();
    const runtime = createPegRuntime({
      policyUrl: "https://policy.invalid/peg.json",
      loadRegistry: vi.fn().mockResolvedValue(registry),
      policyClientOptions: {
        fetch: vi.fn().mockImplementation(() => policyResponse(activeOnly)),
      },
      poller: pegPoller,
      onError: (event) => errors.push(event),
    });

    await runtime.runCycle();

    expect(runtime.status).toBe("waiting");
    expect(pegPoller.pollCycle).not.toHaveBeenCalled();
    expect(errors.map(({ kind }) => kind)).toEqual(["policy_compatibility"]);
  });

  it("polls active and retained subsets from their union registry", async () => {
    const bundle = await policy();
    const registryInput = structuredClone(await loadPegRegistry());
    const registryAsset = registryInput["europ-schuman"]!;
    registryAsset.sources.push({
      ...structuredClone(
        registryAsset.sources.find(({ id }) => id === "kraken_eur")!,
      ),
      id: "kraken_extra",
    });
    const registry = parsePegRegistry(registryInput);
    const policyAsset = bundle.active.assets["europ-schuman"]!;
    const compatibleActive = versioned("europ-v2", {
      ...bundle.active,
      assets: {
        ...bundle.active.assets,
        "europ-schuman": {
          ...policyAsset,
          sources: {
            ...policyAsset.sources,
            kraken_extra: {
              ...policyAsset.sources.kraken_eur!,
              authority: "secondary",
            },
          },
        },
      },
    });
    const rollover = parsePegPolicyBundle({
      ...bundle,
      active: compatibleActive,
      previous: bundle.active,
    });
    const pegPoller = poller();
    const runtime = createPegRuntime({
      policyUrl: "https://policy.invalid/peg.json",
      loadRegistry: vi.fn().mockResolvedValue(registry),
      policyClientOptions: {
        fetch: vi.fn().mockImplementation(() => policyResponse(rollover)),
      },
      poller: pegPoller,
    });

    await runtime.runCycle();

    expect(runtime.status).toBe("active");
    expect(pegPoller.pollCycle).toHaveBeenCalledWith({
      registry,
      policies: [compatibleActive, bundle.active],
    });
  });

  it("keeps serving cleaned active policy from an old superset registry", async () => {
    const bundle = await policy();
    const registryInput = structuredClone(await loadPegRegistry());
    const registryAsset = registryInput["europ-schuman"]!;
    registryAsset.sources.push({
      ...structuredClone(
        registryAsset.sources.find(({ id }) => id === "kraken_eur")!,
      ),
      id: "retired_source",
    });
    const registry = parsePegRegistry(registryInput);
    const pegPoller = poller();
    const runtime = createPegRuntime({
      policyUrl: "https://policy.invalid/peg.json",
      loadRegistry: vi.fn().mockResolvedValue(registry),
      policyClientOptions: {
        fetch: vi.fn().mockImplementation(() => policyResponse(bundle)),
      },
      poller: pegPoller,
    });

    await runtime.runCycle();

    expect(runtime.status).toBe("active");
    expect(pegPoller.pollCycle).toHaveBeenCalledWith({
      registry,
      policies: [bundle.active],
    });
  });

  it("drops the retained policy from the next cycle after ACK cleanup", async () => {
    const bundle = await policy();
    const registry = await loadPegRegistry();
    const compatibleActive = versioned("europ-v2", {
      ...bundle.active,
      rolloverAckExpectedSeconds: 360,
    });
    const rollover = parsePegPolicyBundle({
      ...bundle,
      active: compatibleActive,
      previous: bundle.active,
    });
    const cleaned = parsePegPolicyBundle({
      ...rollover,
      previous: null,
    });
    const pegPoller = poller();
    const runtime = createPegRuntime({
      policyUrl: "https://policy.invalid/peg.json",
      loadRegistry: vi.fn().mockResolvedValue(registry),
      policyClientOptions: {
        fetch: vi
          .fn()
          .mockImplementationOnce(() => policyResponse(rollover))
          .mockImplementationOnce(() => policyResponse(cleaned)),
      },
      poller: pegPoller,
    });

    await runtime.runCycle();
    await runtime.runCycle();

    expect(runtime.status).toBe("active");
    expect(pegPoller.pollCycle).toHaveBeenNthCalledWith(1, {
      registry,
      policies: [compatibleActive, bundle.active],
    });
    expect(pegPoller.pollCycle).toHaveBeenNthCalledWith(2, {
      registry,
      policies: [compatibleActive],
    });
  });
});
