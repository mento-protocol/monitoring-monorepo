"use client";

import {
  createContext,
  use,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useSession } from "next-auth/react";
import useSWR, { useSWRConfig } from "swr";
import { useNetwork } from "@/components/network-provider";
import { truncateAddress } from "@/lib/format";
import { NETWORKS, networkIdForChainId, type Network } from "@/lib/networks";
import {
  derivePreservedSource,
  normalizeArkhamLegacy,
  upgradeEntries,
  type AddressEntry,
} from "@/lib/address-labels-shared";

/** A custom address entry with the address attached (no scope — labels are
 * address-keyed only since the global-only refactor). */
export type AddressEntryRow = AddressEntry & {
  address: string;
};

/** Internal state shape: address → entry. */
type EntriesState = Record<string, AddressEntry>;

/** Full resolved entry (no scope wrapper — kept for API compat with callers
 * that destructure `.entry`). */
export type ResolvedEntry = {
  entry: AddressEntry;
};

type AddressLabelsContextValue = {
  /** Merged name: custom > static contract > truncated. The optional
   * chainId selects which static contract registry to fall back to when no
   * custom label exists; it has no effect on the custom lookup itself. */
  getName: (address: string | null, chainId?: number) => string;
  /** Tags for an address (custom entries only; contracts return []) */
  getTags: (address: string | null) => string[];
  /** True if address has any name (custom or static-on-given-chain) */
  hasName: (address: string | null, chainId?: number) => boolean;
  /** True if address has a user-created custom entry */
  isCustom: (address: string | null) => boolean;
  /** Full entry metadata for custom entries only */
  getEntry: (address: string | null) => ResolvedEntry | undefined;
  /** All custom entry rows, sorted by name. */
  customEntries: AddressEntryRow[];
  /** Add or update a custom entry. */
  upsertEntry: (
    address: string,
    entry: {
      name: string;
      tags: string[];
      notes?: string;
      isPublic?: boolean;
    },
  ) => Promise<void>;
  /** Remove a custom entry. */
  deleteEntry: (address: string) => Promise<void>;
  /**
   * Force a re-fetch of the labels cache. Use after external writes (e.g. a
   * bulk import POSTed directly) so the UI doesn't sit on stale data until
   * the next 30 s poll.
   */
  revalidate: () => Promise<void>;
  isLoading: boolean;
  /**
   * True iff the labels SWR has resolved a real response. Distinguishes
   * "successfully empty" from "still loading / not yet authenticated" —
   * `customEntries` is always `[]` until data lands, so without this flag
   * a deep-link page can't tell whether `getEntry(address)` returning
   * undefined means "no such label" or "haven't fetched yet". Save flows
   * that need to avoid stomping an existing entry should gate on this.
   */
  hasLoaded: boolean;
  error: Error | undefined;
};

const AddressLabelsContext = createContext<AddressLabelsContextValue | null>(
  null,
);

const SWR_KEY = "address-labels:all";

async function fetchAllLabels(): Promise<EntriesState> {
  const res = await fetch("/api/address-labels");
  if (!res.ok) throw new Error(`Failed to fetch address labels: ${res.status}`);
  const raw = (await res.json()) as Record<string, unknown>;
  return upgradeEntries(raw);
}

function networkForChainId(chainId: number): Network | null {
  const id = networkIdForChainId(chainId);
  return id ? NETWORKS[id] : null;
}

function emptyState(): EntriesState {
  return {};
}

export function AddressLabelsProvider({ children }: { children: ReactNode }) {
  const { network } = useNetwork();
  const { mutate } = useSWRConfig();
  const { status } = useSession();

  // Labels are private — only fetch when the user is signed in. For
  // unauthenticated views, the provider returns empty state and the UI falls
  // back to truncated addresses / contract registry names.
  //
  // `hasLoaded` tracks REAL fetch completion via `onSuccess` instead of
  // `data !== undefined`. With `fallbackData`, SWR populates `data` from
  // the fallback immediately on first render — before any network fetch
  // resolves — so a `data !== undefined` check would flip to "loaded"
  // while the auth/SWR machinery is still warming up. A page that gates
  // its save UI on `hasLoaded` could otherwise let a fast save PUT empty
  // defaults over an existing label during that window.
  const [hasLoaded, setHasLoaded] = useState(false);
  const { data, error, isLoading } = useSWR<EntriesState>(
    status === "authenticated" ? SWR_KEY : null,
    fetchAllLabels,
    {
      refreshInterval: 30_000,
      fallbackData: emptyState(),
      // Fires after every successful fetch. Setting state to the same
      // value (`true`) after the first fetch is a React no-op so this
      // doesn't trigger extra renders on the 30s refresh cadence.
      onSuccess: () => setHasLoaded(true),
    },
  );

  const state: EntriesState = data ?? emptyState();

  const customEntries: AddressEntryRow[] = useMemo(() => {
    // Normalise legacy entries here so every UI consumer (table, editor
    // pre-fill, autocomplete) sees clean tags + a populated `source` field
    // for pre-migration rows. Read-only — server-side write paths still go
    // through `stripArkhamProvenance` to avoid auto-promoting user input.
    const rows: AddressEntryRow[] = [];
    for (const [address, entry] of Object.entries(state)) {
      rows.push({ address, ...normalizeArkhamLegacy(entry) });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }, [state]);

  const defaultChainId = network.chainId;

  const getName = useCallback(
    (address: string | null, chainId?: number): string => {
      if (!address) return "—";
      const lower = address.toLowerCase();
      const customName = state[lower]?.name;
      if (customName) return customName;
      const cid = chainId ?? defaultChainId;
      const net = networkForChainId(cid) ?? network;
      return net.addressLabels[lower] ?? truncateAddress(address);
    },
    [state, network, defaultChainId],
  );

  const getTags = useCallback(
    (address: string | null): string[] => {
      if (!address) return [];
      return state[address.toLowerCase()]?.tags ?? [];
    },
    [state],
  );

  const hasName = useCallback(
    (address: string | null, chainId?: number): boolean => {
      if (!address) return false;
      const lower = address.toLowerCase();
      const entry = state[lower];
      if (entry !== undefined && (entry.name !== "" || entry.tags.length > 0)) {
        return true;
      }
      const cid = chainId ?? defaultChainId;
      const net = networkForChainId(cid) ?? network;
      return lower in net.addressLabels;
    },
    [state, network, defaultChainId],
  );

  const isCustom = useCallback(
    (address: string | null): boolean => {
      if (!address) return false;
      return address.toLowerCase() in state;
    },
    [state],
  );

  const getEntry = useCallback(
    (address: string | null): ResolvedEntry | undefined => {
      if (!address) return undefined;
      const entry = state[address.toLowerCase()];
      // Normalise so legacy tag-only rows feed the editor pre-fill with
      // clean tags + populated source, matching what `customEntries` yields.
      return entry ? { entry: normalizeArkhamLegacy(entry) } : undefined;
    },
    [state],
  );

  // Apply a write/delete optimistically.
  const applyOptimistic = (
    current: EntriesState,
    address: string,
    next: AddressEntry | null,
  ): EntriesState => {
    const lower = address.toLowerCase();
    const result: EntriesState = { ...current };
    if (next === null) {
      delete result[lower];
    } else {
      result[lower] = next;
    }
    return result;
  };

  const upsertEntry = useCallback(
    async (
      address: string,
      entry: {
        name: string;
        tags: string[];
        notes?: string;
        isPublic?: boolean;
      },
    ): Promise<void> => {
      const lower = address.toLowerCase();
      // Carry server-side provenance into the optimistic write so the
      // SOURCE badge doesn't flash to "custom" between the optimistic
      // update and the SWR refetch. Mirrors the PUT handler.
      const buildOptimistic = (current: EntriesState): AddressEntry => {
        const prior = current[lower];
        const preservedSource = derivePreservedSource(prior);
        return {
          name: entry.name,
          tags: entry.tags,
          notes: entry.notes,
          isPublic: entry.isPublic,
          ...(preservedSource ? { source: preservedSource } : {}),
          updatedAt: new Date().toISOString(),
        };
      };

      await mutate(
        SWR_KEY,
        async (current: EntriesState = emptyState()) => {
          const res = await fetch("/api/address-labels", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              address,
              name: entry.name,
              tags: entry.tags,
              notes: entry.notes,
              isPublic: entry.isPublic,
            }),
          });
          if (!res.ok) {
            const body = (await res.json()) as { error?: string };
            throw new Error(body.error ?? "Failed to save entry");
          }
          return applyOptimistic(current, lower, buildOptimistic(current));
        },
        {
          optimisticData: (current: EntriesState = emptyState()) =>
            applyOptimistic(current, lower, buildOptimistic(current)),
          rollbackOnError: true,
        },
      );
    },
    [mutate],
  );

  const deleteEntry = useCallback(
    async (address: string): Promise<void> => {
      const lower = address.toLowerCase();

      await mutate(
        SWR_KEY,
        async (current: EntriesState = emptyState()) => {
          const res = await fetch("/api/address-labels", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ address }),
          });
          if (!res.ok) {
            const body = (await res.json()) as { error?: string };
            throw new Error(body.error ?? "Failed to delete entry");
          }
          return applyOptimistic(current, lower, null);
        },
        {
          optimisticData: (current: EntriesState = emptyState()) =>
            applyOptimistic(current, lower, null),
          rollbackOnError: true,
        },
      );
    },
    [mutate],
  );

  const revalidate = useCallback(async (): Promise<void> => {
    await mutate(SWR_KEY);
  }, [mutate]);

  const value: AddressLabelsContextValue = {
    getName,
    getTags,
    hasName,
    isCustom,
    getEntry,
    customEntries,
    upsertEntry,
    deleteEntry,
    revalidate,
    isLoading,
    hasLoaded,
    error: error as Error | undefined,
  };

  return <AddressLabelsContext value={value}>{children}</AddressLabelsContext>;
}

export function useAddressLabels(): AddressLabelsContextValue {
  const ctx = use(AddressLabelsContext);
  if (!ctx) {
    throw new Error(
      "useAddressLabels must be used within <AddressLabelsProvider>",
    );
  }
  return ctx;
}
