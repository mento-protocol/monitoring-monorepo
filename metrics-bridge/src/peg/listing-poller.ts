import type { BitvavoListingRequest } from "./adapters/bitvavo.js";
import type { KrakenListingRequest } from "./adapters/kraken.js";
import type { PegPollSourceState } from "./poll-cycle.js";
import type { PegSource } from "./registry.js";
import {
  MARKET_STATES,
  type AuthoritativeListingCheck,
  type RecordListingCheck,
} from "./types.js";

type ListingState = Pick<
  PegPollSourceState,
  | "listingLastAttemptAt"
  | "listingState"
  | "listingCheckedAt"
  | "listingAbsentConsecutiveChecks"
>;

export interface ListingFetcherDependencies {
  fetchBitvavoListing:
    | ((request: BitvavoListingRequest) => Promise<AuthoritativeListingCheck>)
    | null;
  fetchKrakenListing:
    | ((request: KrakenListingRequest) => Promise<AuthoritativeListingCheck>)
    | null;
}

export function cadenceDue(
  lastAttemptAt: number | null,
  nowSeconds: number,
  pollIntervalSeconds: number,
): boolean {
  return (
    lastAttemptAt === null || nowSeconds - lastAttemptAt >= pollIntervalSeconds
  );
}

export function listingCadenceDue(
  state: ListingState,
  nowSeconds: number,
  pollIntervalSeconds: number,
): boolean {
  return cadenceDue(
    state.listingLastAttemptAt,
    nowSeconds,
    pollIntervalSeconds,
  );
}

export function fetchListing(
  source: PegSource,
  dependencies: ListingFetcherDependencies,
): Promise<AuthoritativeListingCheck> | null {
  if (source.provider === "bitvavo") {
    return dependencies.fetchBitvavoListing?.({ market: source.pair }) ?? null;
  }
  if (source.provider === "kraken") {
    return dependencies.fetchKrakenListing?.({ symbol: source.pair }) ?? null;
  }
  throw new Error(`Unsupported peg provider: ${source.provider}`);
}

export function acceptListingCheck(
  state: ListingState,
  check: AuthoritativeListingCheck | undefined,
  listingAbsentConsecutiveCheckLimit: number,
  cadenceDue: boolean,
): Error | null {
  if (check === undefined) return null;
  if (!Number.isFinite(check.checkedAt) || check.checkedAt < 0) {
    return new Error("listing check time must be finite and non-negative");
  }
  if (!MARKET_STATES.includes(check.state)) {
    return new Error("listing check state is unsupported");
  }
  if (
    state.listingCheckedAt !== null &&
    check.checkedAt < state.listingCheckedAt
  ) {
    return new Error("listing check timestamp regressed");
  }
  const listingAbsentConsecutiveChecks =
    check.state !== "absent"
      ? 0
      : state.listingState !== "absent"
        ? 1
        : cadenceDue
          ? Math.min(
              state.listingAbsentConsecutiveChecks + 1,
              listingAbsentConsecutiveCheckLimit,
            )
          : state.listingAbsentConsecutiveChecks;
  state.listingState = check.state;
  state.listingCheckedAt = check.checkedAt;
  state.listingAbsentConsecutiveChecks = listingAbsentConsecutiveChecks;
  return null;
}

export function createListingCheckRecorder(): {
  listingChecks: AuthoritativeListingCheck[];
  onListingChecked: RecordListingCheck;
} {
  const listingChecks: AuthoritativeListingCheck[] = [];
  return {
    listingChecks,
    onListingChecked: (check) => {
      if (listingChecks.length !== 0) {
        throw new Error("provider emitted more than one listing check");
      }
      if (!Number.isFinite(check.checkedAt) || check.checkedAt < 0) {
        throw new Error("listing check time must be finite and non-negative");
      }
      listingChecks.push({ ...check });
    },
  };
}

export function acceptRecordedListingCheck(
  state: ListingState,
  listingChecks: AuthoritativeListingCheck[],
  listingAbsentConsecutiveCheckLimit: number,
  cadenceDue: boolean,
): Error | null {
  return acceptListingCheck(
    state,
    listingChecks[0],
    listingAbsentConsecutiveCheckLimit,
    cadenceDue,
  );
}

export async function pollListingOnly({
  state,
  nowSeconds,
  listingCadenceIsDue,
  request,
  listingAbsentConsecutiveCheckLimit,
  report,
}: {
  state: ListingState;
  nowSeconds: number;
  listingCadenceIsDue: boolean;
  request: Promise<AuthoritativeListingCheck> | null;
  listingAbsentConsecutiveCheckLimit: number;
  report: (cause: unknown) => void;
}): Promise<boolean> {
  if (!listingCadenceIsDue) return true;
  if (request === null) return false;
  state.listingLastAttemptAt = nowSeconds;
  try {
    const error = acceptListingCheck(
      state,
      await request,
      listingAbsentConsecutiveCheckLimit,
      true,
    );
    if (error !== null) throw error;
  } catch (cause) {
    report(cause);
  }
  return true;
}
