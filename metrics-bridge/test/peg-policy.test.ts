import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  parsePegPolicyBundle,
  PEG_POLICY_MAX_ASSETS,
  PEG_POLICY_MAX_LISTING_ABSENT_CONSECUTIVE_CHECKS,
  effectiveListingAbsentConsecutiveChecks,
  PEG_POLICY_MAX_SOURCES_PER_ASSET,
  pegPolicyContentDigest,
  pegPolicyVersionForContent,
  type PegPolicyBundle,
} from "../src/peg/policy.js";

const POLICY_PATH = new URL(
  "../../alerts/rules/peg-thresholds.json",
  import.meta.url,
);

async function productionPolicy(): Promise<PegPolicyBundle> {
  return parsePegPolicyBundle(
    JSON.parse(await readFile(POLICY_PATH, "utf8")) as unknown,
  );
}

function versioned(
  prefix: string,
  candidate: PegPolicyBundle["active"],
): PegPolicyBundle["active"] {
  return {
    ...candidate,
    version: pegPolicyVersionForContent(prefix, candidate),
  };
}

describe("Peg policy", () => {
  it("bounds policy asset and source cardinality", async () => {
    const policy = await productionPolicy();
    const asset = policy.active.assets["europ-schuman"]!;
    const source = asset.sources.bitvavo_eur!;
    const tooManySources = Object.fromEntries(
      Array.from(
        { length: PEG_POLICY_MAX_SOURCES_PER_ASSET + 1 },
        (_, index) => [
          `source_${String(index).padStart(2, "0")}`,
          { ...source, authority: index === 0 ? "deep" : "secondary" },
        ],
      ),
    );
    expect(() =>
      parsePegPolicyBundle({
        ...policy,
        active: {
          ...policy.active,
          assets: {
            "europ-schuman": {
              ...asset,
              deepVenueSource: "source_00",
              sources: tooManySources,
            },
          },
        },
      }),
    ).toThrow(/at most 16/);

    const tooManyAssets = Object.fromEntries(
      Array.from({ length: PEG_POLICY_MAX_ASSETS + 1 }, (_, index) => [
        `asset-${String(index).padStart(2, "0")}`,
        asset,
      ]),
    );
    expect(() =>
      parsePegPolicyBundle({
        ...policy,
        active: { ...policy.active, assets: tooManyAssets },
      }),
    ).toThrow(/at most 32/);
  });

  it("parses the checked-in inactive EUROP policy bundle", async () => {
    const policy = await productionPolicy();

    expect(policy.active.version).toBe(
      "europ-2026-07-22-v1-f6cdaa2681ab92ce9d90572a4d29d32f",
    );
    expect(policy.active.assets["europ-schuman"]?.deepVenueSource).toBe(
      "bitvavo_eur",
    );
    expect(
      policy.active.assets["europ-schuman"]?.sources.bitvavo_eur
        ?.referenceSizeCap,
    ).toBe(50_000);
    expect(policy.previous?.version).toBe(
      "europ-2026-07-22-v1-a69b99aad61649957a2639dc8348b05f",
    );
    expect(
      policy.previous?.assets["europ-schuman"]?.sources.bitvavo_eur
        ?.listingAbsentConsecutiveChecks,
    ).toBeUndefined();
    expect(
      effectiveListingAbsentConsecutiveChecks(
        policy.previous!.assets["europ-schuman"]!.sources.bitvavo_eur!,
      ),
    ).toBe(2);
  });

  it("rejects a deep designation that does not own deep authority", async () => {
    const policy = await productionPolicy();
    const asset = policy.active.assets["europ-schuman"];
    expect(asset).toBeDefined();

    expect(() =>
      parsePegPolicyBundle({
        ...policy,
        active: {
          ...policy.active,
          assets: {
            ...policy.active.assets,
            "europ-schuman": { ...asset, deepVenueSource: "kraken_eur" },
          },
        },
      }),
    ).toThrow(/single source with deep alert authority/);
  });

  it("requires a bounded listing-absence confirmation threshold and matching stale gate", async () => {
    const policy = await productionPolicy();
    const asset = policy.active.assets["europ-schuman"];
    const source = asset?.sources.bitvavo_eur;
    expect(asset).toBeDefined();
    expect(source).toBeDefined();

    expect(() =>
      parsePegPolicyBundle({
        ...policy,
        active: {
          ...policy.active,
          assets: {
            ...policy.active.assets,
            "europ-schuman": {
              ...asset,
              sources: {
                ...asset?.sources,
                bitvavo_eur: { ...source, staleAfterSeconds: 59 },
              },
            },
          },
        },
      }),
    ).toThrow(/pollIntervalSeconds \* listingAbsentConsecutiveChecks/);

    expect(() =>
      parsePegPolicyBundle({
        ...policy,
        active: {
          ...policy.active,
          assets: {
            ...policy.active.assets,
            "europ-schuman": {
              ...asset,
              sources: {
                ...asset?.sources,
                bitvavo_eur: {
                  ...source,
                  listingAbsentConsecutiveChecks:
                    PEG_POLICY_MAX_LISTING_ABSENT_CONSECUTIVE_CHECKS + 1,
                },
              },
            },
          },
        },
      }),
    ).toThrow(/<=1000/);

    expect(() =>
      parsePegPolicyBundle({
        ...policy,
        active: {
          ...policy.active,
          assets: {
            ...policy.active.assets,
            "europ-schuman": {
              ...asset,
              sources: {
                ...asset?.sources,
                bitvavo_eur: {
                  ...source,
                  listingAbsentConsecutiveChecks: 1,
                },
              },
            },
          },
        },
      }),
    ).toThrow(/>=2/);
  });

  it("accepts a missing threshold only in the exact retained legacy policy", async () => {
    const policy = await productionPolicy();
    const asset = policy.active.assets["europ-schuman"]!;
    const source = asset.sources.bitvavo_eur!;
    const withoutThreshold = { ...source };
    delete withoutThreshold.listingAbsentConsecutiveChecks;

    expect(() =>
      parsePegPolicyBundle({
        ...policy,
        active: {
          ...policy.active,
          assets: {
            ...policy.active.assets,
            "europ-schuman": {
              ...asset,
              sources: {
                ...asset.sources,
                bitvavo_eur: withoutThreshold,
              },
            },
          },
        },
      }),
    ).toThrow(/must be declared by the active policy/);

    const futureLegacy = versioned("europ-2026-07-22-v0", policy.previous!);
    expect(() =>
      parsePegPolicyBundle({ ...policy, previous: futureLegacy }),
    ).toThrow(
      /may be omitted only by the exact pre-streak retained predecessor/,
    );
  });

  it("keeps asset freshness relationships executable", async () => {
    const policy = await productionPolicy();
    const asset = policy.active.assets["europ-schuman"]!;

    expect(() =>
      parsePegPolicyBundle({
        ...policy,
        active: {
          ...policy.active,
          assets: {
            ...policy.active.assets,
            "europ-schuman": {
              ...asset,
              freshnessGraceSeconds: 299,
            },
          },
        },
      }),
    ).toThrow(/slowest source poll interval/);

    expect(() =>
      parsePegPolicyBundle({
        ...policy,
        active: {
          ...policy.active,
          assets: {
            ...policy.active.assets,
            "europ-schuman": {
              ...asset,
              permanentlyDeadSeconds: asset.freshnessGraceSeconds,
            },
          },
        },
      }),
    ).toThrow(/must exceed freshnessGraceSeconds/);
  });

  it("keeps the complete previous package and version distinct", async () => {
    const policy = await productionPolicy();

    expect(() =>
      parsePegPolicyBundle({ ...policy, previous: policy.active }),
    ).toThrow(/must differ from the active version/);

    const previous = versioned("europ-2026-07-22-v0", policy.active);
    expect(
      parsePegPolicyBundle({ ...policy, previous }).previous?.assets,
    ).toEqual(policy.active.assets);
  });

  it("binds every version to its canonical content across fresh processes", async () => {
    const policy = await productionPolicy();
    const asset = policy.active.assets["europ-schuman"]!;
    const mutated = {
      ...policy.active,
      assets: {
        ...policy.active.assets,
        "europ-schuman": { ...asset, warnDeviationBps: 30 },
      },
    };

    expect(() => parsePegPolicyBundle({ ...policy, active: mutated })).toThrow(
      /policy content digest/,
    );

    const next = versioned("europ-2026-07-22-v2", mutated);
    expect(
      parsePegPolicyBundle({
        ...policy,
        active: next,
        previous: policy.active,
      }).active.version,
    ).toBe(next.version);
  });

  it("uses the same locale-independent key order as the CI validators", () => {
    expect(
      pegPolicyContentDigest({
        version: "ignored",
        assets: {
          "asset-a": {
            sources: {
              kraken_eur: { weight: 1 },
              kraken2_eur: { weight: 2 },
            },
          },
        },
        rolloverAckExpectedSeconds: 300,
      }),
    ).toBe("366f968f8c1281f3aa1a31126dfceff7");
  });

  it("rejects page-policy keys outside the reviewed contract", async () => {
    const policy = await productionPolicy();
    const asset = policy.active.assets["europ-schuman"];
    expect(asset).toBeDefined();

    expect(() =>
      parsePegPolicyBundle({
        ...policy,
        active: {
          ...policy.active,
          assets: {
            ...policy.active.assets,
            "europ-schuman": { ...asset, bypassFreshness: true },
          },
        },
      }),
    ).toThrow(/Unrecognized key/);
  });
});
