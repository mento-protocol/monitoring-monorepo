import { describe, expect, it } from "vitest";
import {
  loadPegRegistry,
  parsePegRegistry,
  PEG_REGISTRY_MAX_ASSETS,
  PEG_REGISTRY_MAX_SOURCES_PER_ASSET,
  type PegAsset,
  type PegConversion,
  type PegRegistry,
} from "../src/peg/registry.js";

function europAsset(registry: PegRegistry): PegAsset {
  const asset = registry["europ-schuman"];
  if (!asset) throw new Error("Production registry is missing europ-schuman");
  return asset;
}

function usdConversion(asset: PegAsset): PegConversion {
  const conversion = asset.sources.find(
    (source) => source.id === "kraken_usd",
  )?.convertVia;
  if (!conversion) throw new Error("kraken_usd is missing its conversion");
  return conversion;
}

async function validInput(): Promise<PegRegistry> {
  return structuredClone(await loadPegRegistry());
}

function setUnknown(target: object, key: string, value: unknown): void {
  Reflect.set(target, key, value);
}

describe("peg registry production data", () => {
  it("loads and validates the production registry relative to the module", async () => {
    const registry = await loadPegRegistry();
    const asset = europAsset(registry);

    expect(parsePegRegistry(registry)).toEqual(registry);
    expect(asset).toMatchObject({
      peg: "EUR",
      tokenRefs: [
        {
          chainId: 137,
          address: "0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51",
        },
      ],
      monitors: [
        {
          chainId: 137,
          poolAddress: "0xcd8c6811d975981f57e7fb32e59f0bee66af3201",
          rateFeedId: "0xc22418a83dfc262b10a1f57e25309db83e7ea79e",
          monitoredTokenAddress: "0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51",
        },
      ],
      coverageClass: "cex-book+indexed-pool",
    });
    expect(asset.sources).toEqual([
      {
        id: "bitvavo_eur",
        provider: "bitvavo",
        pair: "EUROP-EUR",
        baseCurrency: "EUROP",
        quoteCurrency: "EUR",
        role: "primary",
      },
      {
        id: "kraken_eur",
        provider: "kraken",
        pair: "EUROP/EUR",
        baseCurrency: "EUROP",
        quoteCurrency: "EUR",
        role: "secondary",
      },
      {
        id: "kraken_usd",
        provider: "kraken",
        pair: "EUROP/USD",
        baseCurrency: "EUROP",
        quoteCurrency: "USD",
        role: "display",
        convertVia: {
          chainId: 137,
          rateFeedId: "0xec57482aa55e3ad026c315a0e4a692b776c318ca",
          fromCurrency: "USD",
          toCurrency: "EUR",
        },
      },
    ]);
    expect(asset.rejectedSources.map(({ provider }) => provider)).toEqual([
      "bit2me",
      "curve",
      "xrpl",
      "xrpl",
    ]);
  });
});

describe("peg registry identity constraints", () => {
  it.each(["EUROP", "europ", "europ_schuman", "europ--schuman"])(
    "rejects the ticker-like or invalid asset key %s",
    async (slug) => {
      const registry = await validInput();

      expect(() =>
        parsePegRegistry({ [slug]: europAsset(registry) }),
      ).toThrow();
    },
  );

  it.each([
    ["short token address", "token", "0x1234"],
    [
      "mixed-case token address",
      "token",
      "0x888883B5f5d21fb10dfeb70e8f9722b9fb0e5e51",
    ],
    ["short pool address", "pool", "0x1234"],
    [
      "mixed-case monitor feed",
      "monitor-feed",
      "0xC22418a83dfc262b10a1f57e25309db83e7ea79e",
    ],
    [
      "mixed-case monitored token",
      "monitored-token",
      "0x888883B5f5d21fb10dfeb70e8f9722b9fb0e5e51",
    ],
    [
      "mixed-case conversion feed",
      "conversion-feed",
      "0xEC57482aa55e3ad026c315a0e4a692b776c318ca",
    ],
  ] as const)("rejects a %s", async (_description, field, value) => {
    const registry = await validInput();
    const asset = europAsset(registry);

    if (field === "token") asset.tokenRefs[0]!.address = value;
    if (field === "pool") asset.monitors[0]!.poolAddress = value;
    if (field === "monitor-feed") asset.monitors[0]!.rateFeedId = value;
    if (field === "monitored-token") {
      asset.monitors[0]!.monitoredTokenAddress = value;
    }
    if (field === "conversion-feed") {
      usdConversion(asset).rateFeedId = value;
    }

    expect(() => parsePegRegistry(registry)).toThrow();
  });

  it("rejects duplicate source ids", async () => {
    const registry = await validInput();
    const asset = europAsset(registry);
    asset.sources.push(structuredClone(asset.sources[0]!));

    expect(() => parsePegRegistry(registry)).toThrow(/Duplicate source id/);
  });

  it("rejects duplicate monitor identities", async () => {
    const registry = await validInput();
    const asset = europAsset(registry);
    asset.monitors.push(structuredClone(asset.monitors[0]!));

    expect(() => parsePegRegistry(registry)).toThrow(
      /Duplicate monitor identity/,
    );
  });
});

describe("peg registry conversion constraints", () => {
  it("rejects a conversion that does not start at the source quote currency", async () => {
    const registry = await validInput();
    usdConversion(europAsset(registry)).fromCurrency = "EUR";

    expect(() => parsePegRegistry(registry)).toThrow(/source quote currency/);
  });

  it("rejects a conversion that does not end at the peg currency", async () => {
    const registry = await validInput();
    usdConversion(europAsset(registry)).toCurrency = "GBP";

    expect(() => parsePegRegistry(registry)).toThrow(/peg currency/);
  });

  it("rejects a conversion chain not bound to the asset", async () => {
    const registry = await validInput();
    usdConversion(europAsset(registry)).chainId = 1;

    expect(() => parsePegRegistry(registry)).toThrow(/asset token reference/);
  });

  it.each([
    [
      "missing chainId",
      (conversion: PegConversion) => {
        Reflect.deleteProperty(conversion, "chainId");
      },
    ],
    [
      "string chainId",
      (conversion: PegConversion) => {
        setUnknown(conversion, "chainId", "137");
      },
    ],
    [
      "zero chainId",
      (conversion: PegConversion) => {
        conversion.chainId = 0;
      },
    ],
  ] as const)("rejects a conversion with %s", async (_description, mutate) => {
    const registry = await validInput();
    mutate(usdConversion(europAsset(registry)));

    expect(() => parsePegRegistry(registry)).toThrow();
  });

  it("requires a conversion when the quote and peg currencies differ", async () => {
    const registry = await validInput();
    Reflect.deleteProperty(assetSource(registry, "kraken_usd"), "convertVia");

    expect(() => parsePegRegistry(registry)).toThrow(/requires a conversion/);
  });
});

function assetSource(registry: PegRegistry, sourceId: string) {
  const source = europAsset(registry).sources.find(({ id }) => id === sourceId);
  if (!source) throw new Error(`Production registry is missing ${sourceId}`);
  return source;
}

describe("peg registry policy boundary", () => {
  it("bounds registry and per-asset source cardinality", async () => {
    const registry = await validInput();
    const asset = europAsset(registry);
    const source = asset.sources[0]!;
    asset.sources = Array.from(
      { length: PEG_REGISTRY_MAX_SOURCES_PER_ASSET + 1 },
      (_, index) => ({
        ...source,
        id: `source_${String(index).padStart(2, "0")}`,
      }),
    );
    expect(() => parsePegRegistry(registry)).toThrow(/<=16 items/);

    const boundedAsset = europAsset(await validInput());
    const tooManyAssets = Object.fromEntries(
      Array.from({ length: PEG_REGISTRY_MAX_ASSETS + 1 }, (_, index) => [
        `asset-${String(index).padStart(2, "0")}`,
        structuredClone(boundedAsset),
      ]),
    );
    expect(() => parsePegRegistry(tooManyAssets)).toThrow(/at most 32/);
  });

  it.each([
    ["target", "asset"],
    ["refSize", "source"],
    ["cadence", "source"],
    ["staleness", "source"],
    ["spreadEnvelope", "source"],
    ["deepVenue", "asset"],
    ["alertAuthority", "source"],
    ["unknownField", "monitor"],
  ] as const)(
    "rejects the page-policy or unknown key %s",
    async (key, owner) => {
      const registry = await validInput();
      const asset = europAsset(registry);
      const target =
        owner === "asset"
          ? asset
          : owner === "source"
            ? asset.sources[0]!
            : asset.monitors[0]!;
      setUnknown(target, key, 1);

      expect(() => parsePegRegistry(registry)).toThrow();
    },
  );

  it("rejects an unsupported coverage class", async () => {
    const registry = await validInput();
    setUnknown(europAsset(registry), "coverageClass", "full");

    expect(() => parsePegRegistry(registry)).toThrow();
  });

  it("rejects a source role that claims alert authority", async () => {
    const registry = await validInput();
    setUnknown(assetSource(registry, "bitvavo_eur"), "role", "authoritative");

    expect(() => parsePegRegistry(registry)).toThrow();
  });
});
