// Shared shape for the /volume SSR-prefetch handoff (server fetch →
// `useHeroRollup` fallbackData) plus the view-parity gate. Mirrors
// `lib/pool-detail-initial-data.ts`: types only + pure helpers, importable
// from both the Server Component and the client hook.

import type { IndexerNetworkId } from "@/lib/networks";
import type {
  VolumeRangeKey,
  VolumeTodayTraderRow,
  VolumeWindowFirstDayRow,
  VolumeWindowRow,
} from "@/lib/volume";
import type { Venue } from "@/lib/volume-url-params";

// Raw response shapes for the unconditional hero queries (see
// lib/queries/volume.ts). Kept structurally identical to the inline types in
// `use-hero-rollup.ts` so the prefetched payload plugs straight into each
// `useGQL` call's `fallbackData`.
export type VolumeWindowLatestResponse = {
  volumeWindowSnapshots: VolumeWindowRow[];
};
export type BrokerVolumeWindowLatestResponse = {
  brokerVolumeWindowSnapshots: VolumeWindowRow[];
};
export type VolumeTodayTradersResponse = {
  volumeTodayTraders: VolumeTodayTraderRow[];
};
export type BrokerVolumeTodayTradersResponse = {
  brokerVolumeTodayTraders: VolumeTodayTraderRow[];
};
export type VolumeWindowFirstDayLatestResponse = {
  volumeWindowFirstDaySnapshots: VolumeWindowFirstDayRow[];
};
export type BrokerVolumeWindowFirstDayLatestResponse = {
  brokerVolumeWindowFirstDaySnapshots: VolumeWindowFirstDayRow[];
};

/**
 * Descriptor of the exact view the server prefetched. `useGQL` keys on
 * `[network.id, query, variables]`, so the client must only attach the
 * prefetched responses as `fallbackData` when every key ingredient of its
 * OWN first render matches — a silently mismatched fallback (wrong venue,
 * range, actor filter, network, or UTC day) is worse than no fallback.
 */
export type VolumeHeroView = {
  networkId: IndexerNetworkId;
  venue: Venue;
  range: VolumeRangeKey;
  includeProtocolActors: boolean;
  /** UTC midnight (seconds) the today-partial query was scoped to. */
  todayMidnight: number;
};

/**
 * Server-prefetched raw responses for the /volume hero first paint. Only the
 * fields for `view.venue` are populated; the primary pair (window + today) is
 * always present (the fetch returns `undefined` overall when either fails),
 * while the firstDay catch-up slice is optional (schema-lag resilient, same
 * as pool-detail's extension queries).
 */
export type VolumeHeroInitialData = {
  view: VolumeHeroView;
  heroV3?: VolumeWindowLatestResponse | undefined;
  todayV3?: VolumeTodayTradersResponse | undefined;
  firstDayV3?: VolumeWindowFirstDayLatestResponse | undefined;
  heroV2?: BrokerVolumeWindowLatestResponse | undefined;
  todayV2?: BrokerVolumeTodayTradersResponse | undefined;
  firstDayV2?: BrokerVolumeWindowFirstDayLatestResponse | undefined;
};

/**
 * The `isProtocolActorIn` variable both sides derive from the actor toggle
 * (`page-client.tsx` memoizes the identical expression). Centralised so the
 * server prefetch and the view-parity gate can't drift from the client.
 */
export function protocolActorInForView(
  includeProtocolActors: boolean,
): boolean[] {
  return includeProtocolActors ? [false, true] : [false];
}

/**
 * True when the client's actual first-render inputs match the prefetched
 * view descriptor — the gate for attaching `fallbackData`.
 */
export function volumeHeroViewMatches(
  view: VolumeHeroView,
  actual: {
    networkId: IndexerNetworkId;
    venue: Venue;
    range: VolumeRangeKey;
    isProtocolActorIn: ReadonlyArray<boolean>;
    todayMidnight: number;
  },
): boolean {
  const expectedActors = protocolActorInForView(view.includeProtocolActors);
  const actorsMatch =
    expectedActors.length === actual.isProtocolActorIn.length &&
    expectedActors.every((v, i) => actual.isProtocolActorIn[i] === v);
  return (
    view.networkId === actual.networkId &&
    view.venue === actual.venue &&
    view.range === actual.range &&
    view.todayMidnight === actual.todayMidnight &&
    actorsMatch
  );
}
