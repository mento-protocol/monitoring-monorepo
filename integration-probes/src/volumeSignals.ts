import type { AggregatorAdapter } from "./adapters.js";
import type { FetchLike, VolumeSignal, VolumeSignalCategory } from "./types.js";

const DEFILLAMA_DEX_AGGREGATORS_URL =
  "https://api.llama.fi/overview/aggregators?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true";
const DEFILLAMA_BRIDGE_AGGREGATORS_URL =
  "https://api.llama.fi/overview/bridge-aggregators?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true";

type DefillamaEndpoint = "dex-aggregators" | "bridge-aggregators";

type DefillamaVolumeSource = {
  kind: "defillama";
  endpoint: DefillamaEndpoint;
  protocolName: string;
  category: VolumeSignalCategory;
};

type UnavailableVolumeSource = {
  kind: "unavailable";
  category: VolumeSignalCategory;
  sourceLabel: string;
  sourceUrl: string | null;
  note: string;
};

type VolumeSource = DefillamaVolumeSource | UnavailableVolumeSource;

const DEFILLAMA_SOURCE_LABELS: Record<DefillamaEndpoint, string> = {
  "dex-aggregators": "DefiLlama DEX aggregators",
  "bridge-aggregators": "DefiLlama bridge aggregators",
};

const DEFILLAMA_ENDPOINT_URLS: Record<DefillamaEndpoint, string> = {
  "dex-aggregators": DEFILLAMA_DEX_AGGREGATORS_URL,
  "bridge-aggregators": DEFILLAMA_BRIDGE_AGGREGATORS_URL,
};

const VOLUME_SOURCES: Record<string, VolumeSource> = {
  lifi: defillama("bridge-aggregators", "Jumper (LI.FI powered)"),
  squid: unavailable(
    "official-stats",
    "Squid official stats",
    "https://www.squidrouter.com/stats",
    "Official stats page exposes a 30D view, but no stable public 30d API value is configured.",
  ),
  openocean: defillama("dex-aggregators", "OpenOcean"),
  kyberswap: defillama("dex-aggregators", "KyberSwap Aggregator"),
  okx: defillama("dex-aggregators", "OKX Swap"),
  "1inch": defillama("dex-aggregators", "1inch"),
  "0x": defillama("dex-aggregators", "0x Aggregator"),
  "cow-swap": defillama("dex-aggregators", "CoWSwap"),
  paraswap: defillama("dex-aggregators", "Velora"),
  relay: unavailable(
    "official-stats",
    "Relay public stats",
    "https://relay.link/",
    "No stable public 30d API value is configured; Relay reports public all-time settled volume.",
  ),
  odos: defillama("dex-aggregators", "ODOS"),
  socket: defillama(
    "bridge-aggregators",
    "Bungee Bridge Aggregator",
    "bridge-aggregator",
  ),
  rango: defillama("bridge-aggregators", "Rango", "bridge-aggregator"),
  rubic: defillama("dex-aggregators", "Rubic"),
  debridge: unavailable(
    "direct-bridge",
    "deBridge public docs",
    "https://docs.debridge.com/home/welcome",
    "No stable public 30d API value is configured; deBridge reports public all-time cross-chain volume.",
  ),
};

export async function volumeSignalsForAdapters(args: {
  adapters: readonly AggregatorAdapter[];
  fetcher: FetchLike;
}): Promise<Map<string, VolumeSignal | null>> {
  const sources = new Map(
    args.adapters.map((adapter) => [adapter.id, VOLUME_SOURCES[adapter.id]]),
  );
  const endpoints = uniqueDefillamaEndpoints([...sources.values()]);
  const [dexProtocols, bridgeProtocols] = await Promise.all([
    endpoints.has("dex-aggregators")
      ? fetchDefillamaProtocols(args.fetcher, "dex-aggregators")
      : Promise.resolve(new Map<string, number>()),
    endpoints.has("bridge-aggregators")
      ? fetchDefillamaProtocols(args.fetcher, "bridge-aggregators")
      : Promise.resolve(new Map<string, number>()),
  ]);
  const protocolsByEndpoint: Record<DefillamaEndpoint, Map<string, number>> = {
    "dex-aggregators": dexProtocols,
    "bridge-aggregators": bridgeProtocols,
  };

  return new Map(
    args.adapters.map((adapter) => [
      adapter.id,
      signalForSource(sources.get(adapter.id), protocolsByEndpoint),
    ]),
  );
}

function defillama(
  endpoint: DefillamaEndpoint,
  protocolName: string,
  category: VolumeSignalCategory = endpoint === "dex-aggregators"
    ? "dex-aggregator"
    : "bridge-aggregator",
): DefillamaVolumeSource {
  return { kind: "defillama", endpoint, protocolName, category };
}

function unavailable(
  category: VolumeSignalCategory,
  sourceLabel: string,
  sourceUrl: string | null,
  note: string,
): UnavailableVolumeSource {
  return { kind: "unavailable", category, sourceLabel, sourceUrl, note };
}

function uniqueDefillamaEndpoints(
  sources: Array<VolumeSource | undefined>,
): ReadonlySet<DefillamaEndpoint> {
  return new Set(
    sources
      .filter((source): source is DefillamaVolumeSource => {
        return source?.kind === "defillama";
      })
      .map((source) => source.endpoint),
  );
}

function signalForSource(
  source: VolumeSource | undefined,
  protocolsByEndpoint: Record<DefillamaEndpoint, Map<string, number>>,
): VolumeSignal | null {
  if (!source) return null;
  if (source.kind === "unavailable") {
    return {
      window: "30d",
      category: source.category,
      valueUsd: null,
      sourceLabel: source.sourceLabel,
      sourceUrl: source.sourceUrl,
      sourceProtocol: null,
      note: source.note,
    };
  }

  const valueUsd =
    protocolsByEndpoint[source.endpoint].get(source.protocolName) ?? null;
  return {
    window: "30d",
    category: source.category,
    valueUsd,
    sourceLabel: DEFILLAMA_SOURCE_LABELS[source.endpoint],
    sourceUrl: DEFILLAMA_ENDPOINT_URLS[source.endpoint],
    sourceProtocol: source.protocolName,
    note:
      valueUsd === null
        ? `No 30d value found for ${source.protocolName}.`
        : null,
  };
}

async function fetchDefillamaProtocols(
  fetcher: FetchLike,
  endpoint: DefillamaEndpoint,
): Promise<Map<string, number>> {
  try {
    const response = await fetcher(DEFILLAMA_ENDPOINT_URLS[endpoint]);
    if (!response.ok) return new Map();
    return protocolVolumes(await response.json());
  } catch {
    return new Map();
  }
}

function protocolVolumes(payload: unknown): Map<string, number> {
  if (!payload || typeof payload !== "object" || !("protocols" in payload)) {
    return new Map();
  }
  const protocols = (payload as { protocols?: unknown }).protocols;
  if (!Array.isArray(protocols)) return new Map();

  return new Map(
    protocols.flatMap((protocol) => {
      if (!protocol || typeof protocol !== "object") return [];
      const name = (protocol as { name?: unknown }).name;
      const total30d = (protocol as { total30d?: unknown }).total30d;
      if (typeof name !== "string" || !Number.isFinite(total30d)) return [];
      return [[name, Number(total30d)] as const];
    }),
  );
}
