export const VENUE_STATES = [
  "ok",
  "wide",
  "one_sided_bid",
  "one_sided_ask",
  "evacuated",
  "halted",
] as const;

export type VenueState = (typeof VENUE_STATES)[number];

export const MARKET_STATES = ["listed", "halted", "absent"] as const;

export type MarketState = (typeof MARKET_STATES)[number];

export interface BookLevel {
  price: number;
  size: number;
}

export interface ExecutableSellQuote {
  vwap: number | null;
  filledFraction: number;
  capped: boolean;
}

export interface PegObservation extends ExecutableSellQuote {
  bid: number | null;
  ask: number | null;
  /** Venue-reported Unix timestamp in milliseconds. */
  lastTradeAt: number | null;
  /** Local fetch completion time in Unix milliseconds. */
  fetchedAt: number;
  /**
   * Venue-authoritative publication time in Unix milliseconds. Null only for
   * a status-only halted observation whose venue supplies no publication
   * identity.
   */
  observationAt: number | null;
  /**
   * Venue-authoritative publication identity. Null only together with
   * observationAt on a status-only halted observation.
   */
  sequence: string | null;
  venueState: VenueState;
}

export interface ParsedOrderBook {
  bids: BookLevel[];
  asks: BookLevel[];
  observationAt: number | null;
  sequence: string | null;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type Sleep = (milliseconds: number) => Promise<void>;

export interface AdapterRuntime {
  fetch?: FetchLike;
  now?: () => number;
  sleep?: Sleep;
}

export interface ObservationPolicy {
  refSize: number;
  spreadEnvelopeBps: number;
}
