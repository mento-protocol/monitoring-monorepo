import { describe, expect, it } from "vitest";
import { volumeSignalsForAdapters } from "../volumeSignals.js";
import type { AggregatorAdapter } from "../adapters.js";

describe("volumeSignalsForAdapters", () => {
  it("maps configured adapters to public 30d volume signals", async () => {
    const requested: string[] = [];
    const signals = await volumeSignalsForAdapters({
      adapters: [
        adapter("openocean"),
        adapter("kyberswap"),
        adapter("okx"),
        adapter("lifi"),
        adapter("socket"),
        adapter("rubic"),
        adapter("squid"),
        adapter("relay"),
      ],
      fetcher: async (input) => {
        requested.push(String(input));
        if (String(input).includes("bridge-aggregators")) {
          return new Response(
            JSON.stringify({
              protocols: [
                { name: "Jumper (LI.FI powered)", total30d: 683_152_039 },
                { name: "Bungee", total30d: 198_370_000 },
                { name: "Rubic", total30d: 27_440_000 },
              ],
            }),
          );
        }
        return new Response(
          JSON.stringify({
            protocols: [
              { name: "OpenOcean", total30d: 327_881_227 },
              { name: "KyberSwap", total30d: 6_970_000_000 },
              { name: "OKX DEX", total30d: 5_275_000_000 },
            ],
          }),
        );
      },
    });

    expect(requested).toHaveLength(2);
    expect(signals.get("openocean")).toMatchObject({
      window: "30d",
      category: "dex-aggregator",
      valueUsd: 327_881_227,
      sourceUrl: "https://defillama.com/protocols/dex-aggregators",
      sourceProtocol: "OpenOcean",
    });
    expect(signals.get("kyberswap")).toMatchObject({
      valueUsd: 6_970_000_000,
      sourceProtocol: "KyberSwap",
    });
    expect(signals.get("okx")).toMatchObject({
      valueUsd: 5_275_000_000,
      sourceProtocol: "OKX DEX",
    });
    expect(signals.get("lifi")).toMatchObject({
      window: "30d",
      category: "bridge-aggregator",
      valueUsd: 683_152_039,
      sourceUrl: "https://defillama.com/protocols/bridge-aggregators",
      sourceProtocol: "Jumper (LI.FI powered)",
    });
    expect(signals.get("socket")).toMatchObject({
      valueUsd: 198_370_000,
      sourceProtocol: "Bungee",
    });
    expect(signals.get("rubic")).toMatchObject({
      category: "bridge-aggregator",
      valueUsd: 27_440_000,
      sourceUrl: "https://defillama.com/protocols/bridge-aggregators",
      sourceProtocol: "Rubic",
    });
    expect(signals.get("squid")).toMatchObject({
      window: "30d",
      category: "official-stats",
      valueUsd: null,
      sourceLabel: "Squid official stats",
    });
    expect(signals.get("relay")).toMatchObject({
      window: "30d",
      category: "official-stats",
      valueUsd: null,
      sourceLabel: "Relay public stats",
    });
  });

  it("degrades unknown or missing public volume data to null", async () => {
    const signals = await volumeSignalsForAdapters({
      adapters: [adapter("openocean"), adapter("fixture")],
      fetcher: async () => new Response(JSON.stringify({ protocols: [] })),
    });

    expect(signals.get("openocean")).toMatchObject({
      valueUsd: null,
      note: "No 30d value found for OpenOcean.",
    });
    expect(signals.get("fixture")).toBeNull();
  });

  it("surfaces DefiLlama HTTP failures in the volume signal note", async () => {
    const signals = await volumeSignalsForAdapters({
      adapters: [adapter("openocean")],
      fetcher: async () => new Response("rate limited", { status: 429 }),
    });

    expect(signals.get("openocean")).toMatchObject({
      valueUsd: null,
      note: "DefiLlama DEX aggregators returned HTTP 429.",
    });
  });
});

function adapter(id: string): AggregatorAdapter {
  return {
    id,
    label: id,
    kind: "dex",
    tier: 2,
    support: { 42220: "supported" },
    researchNote: id,
  };
}
