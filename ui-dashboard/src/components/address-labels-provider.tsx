"use client";

import {
  createContext,
  use,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { useSession } from "next-auth/react";
import useSWR, { useSWRConfig } from "swr";
import { useNetwork } from "@/components/network-provider";
import { truncateAddress } from "@/lib/format";
import { NETWORKS, networkIdForChainId, type Network } from "@/lib/networks";
import {
  upgradeEntries,
  type AddressEntry,
  type Scope,
} from "@/lib/address-labels-shared";

/** A custom address entry, labelled across scopes with its originating scope. */
export type AddressEntryRow = AddressEntry & {
  address: string;
  scope: Scope;
};

/** Internal state shape: global entries + per-chain entries. */
type EntriesState = {
  global: Record<string, AddressEntry>;
  chains: Map<number, Record<string, AddressEntry>>;
};

/** Full resolved entry with the scope it came from. */
export type ResolvedEntry = {
  entry: AddressEntry;
  scope: Scope;
};

type AddressLabelsContextValue = {
  /** Merged name: custom (per-chain > global) > static contract > truncated */
  getName: (address: string | null, chainId?: number) => string;
  /** Tags for an address (custom entries only; contracts return []) */
  getTags: (address: string | null, chainId?: number) => string[];
  /** True if address has any name (custom or static) on the given chain */
  hasName: (address: string | null, chainId?: number) => boolean;
  /** True if address has a user-created custom entry (per-chain or global) */
  isCustom: (address: string | null, chainId?: number) => boolean;
  /** Full entry metadata + scope for custom entries only */
  getEntry: (
    address: string | null,
    chainId?: number,
  ) => ResolvedEntry | undefined;
  /** All custom entry rows across every scope, sorted by name. */
  customEntries: AddressEntryRow[];
  /** Add or update a custom entry at the given scope. */
  upsertEntry: (
    address: string,
    entry: {
      name: string;
      tags: string[];
      notes?: string;
      isPublic?: boolean;
    },
    scope: Scope,
  ) => Promise<void>;
  /** Remove a custom entry at the given scope. */
  deleteEntry: (address: string, scope: Scope) => Promise<void>;
  /**
   * Force a re-fetch of the labels cache. Use after external writes (e.g. a
   * bulk import POSTed directly) so the UI doesn't sit on stale data until
   * the next 30 s poll.
   */
  revalidate: () => Promise<void>;
  isLoading: boolean;
  error: Error | undefined;
};

const AddressLabelsContext = createContext<AddressLabelsContextValue | null>(
  null,
);

const SWR_KEY = "address-labels:all";

// API GET payload shape: { global: {...}, chains: { [chainId]: {...} } }
type ApiLabelsPayload = {
  global?: Record<string, unknown>;
  chains?: Record<string, Record<string, unknown>>;
};

async function fetchAllLabels(): Promise<EntriesState> {
  const res = await fetch("/api/address-labels");
  if (!res.ok) throw new Error(`Failed to fetch address labels: ${res.status}`);
  const raw = (await res.json()) as ApiLabelsPayload;
  const global = raw.global
    ? upgradeEntries(raw.global as Record<string, unknown>)
    : {};
  const chains = new Map<number, Record<string, AddressEntry>>();
  if (raw.chains) {
    for (const [chainIdStr, entries] of Object.entries(raw.chains)) {
      const chainId = Number(chainIdStr);
      if (!Number.isFinite(chainId)) continue;
      chains.set(chainId, upgradeEntries(entries as Record<string, unknown>));
    }
  }
  return { global, chains };
}

function networkForChainId(chainId: number): Network | null {
  const id = networkIdForChainId(chainId);
  return id ? NETWORKS[id] : null;
}

function emptyState(): EntriesState {
  return { global: {}, chains: new Map() };
}

export function AddressLabelsProvider({ children }: { children: ReactNode }) {
  const { network } = useNetwork();
  const { mutate } = useSWRConfig();
  const { status } = useSession();

  // Labels are private — only fetch when the user is signed in. For
  // unauthenticated views, the provider returns empty state and the UI falls
  // back to truncated addresses / contract registry names.
  const { data, error, isLoading } = useSWR<EntriesState>(
    status === "authenticated" ? SWR_KEY : null,
    fetchAllLabels,
    {
      refreshInterval: 30_000,
      fallbackData: emptyState(),
    },
  );

  const state: EntriesState = data ?? emptyState();

  const customEntries: AddressEntryRow[] = useMemo(() => {
    const rows: AddressEntryRow[] = [];
    for (const [address, entry] of Object.entries(state.global)) {
      rows.push({ address, scope: "global", ...entry });
    }
    for (const [chainId, chainEntries] of state.chains) {
      for (const [address, entry] of Object.entries(chainEntries)) {
        rows.push({ address, scope: chainId, ...entry });
      }
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }, [state]);

  const defaultChainId = network.chainId;

  const getName = useCallback(
    (address: string | null, chainId?: number): string => {
      if (!address) return "\u2014";
      const lower = address.toLowerCase();
      const cid = chainId ?? defaultChainId;
      const chainName = state.chains.get(cid)?.[lower]?.name;
      if (chainName) return chainName;
      const globalName = state.global[lower]?.name;
      if (globalName) return globalName;
      const net = networkForChainId(cid) ?? network;
      return net.addressLabels[lower] ?? truncateAddress(address);
    },
    [state, network, defaultChainId],
  );

  const getTags = useCallback(
    (address: string | null, chainId?: number): string[] => {
      if (!address) return [];
      const lower = address.toLowerCase();
      const cid = chainId ?? defaultChainId;
      const chainTags = state.chains.get(cid)?.[lower]?.tags;
      if (chainTags && chainTags.length > 0) return chainTags;
      return state.global[lower]?.tags ?? [];
    },
    [state, defaultChainId],
  );

  const hasName = useCallback(
    (address: string | null, chainId?: number): boolean => {
      if (!address) return false;
      const lower = address.toLowerCase();
      const cid = chainId ?? defaultChainId;
      const chainEntry = state.chains.get(cid)?.[lower];
      if (
        chainEntry !== undefined &&
        (chainEntry.name !== "" || chainEntry.tags.length > 0)
      ) {
        return true;
      }
      const globalEntry = state.global[lower];
      if (
        globalEntry !== undefined &&
        (globalEntry.name !== "" || globalEntry.tags.length > 0)
      ) {
        return true;
      }
      const net = networkForChainId(cid) ?? network;
      return lower in net.addressLabels;
    },
    [state, network, defaultChainId],
  );

  const isCustom = useCallback(
    (address: string | null, chainId?: number): boolean => {
      if (!address) return false;
      const lower = address.toLowerCase();
      const cid = chainId ?? defaultChainId;
      return lower in (state.chains.get(cid) ?? {}) || lower in state.global;
    },
    [state, defaultChainId],
  );

  const getEntry = useCallback(
    (address: string | null, chainId?: number): ResolvedEntry | undefined => {
      if (!address) return undefined;
      const lower = address.toLowerCase();
      const cid = chainId ?? defaultChainId;
      const chainEntry = state.chains.get(cid)?.[lower];
      if (chainEntry) return { entry: chainEntry, scope: cid };
      const globalEntry = state.global[lower];
      if (globalEntry) return { entry: globalEntry, scope: "global" };
      return undefined;
    },
    [state, defaultChainId],
  );

  // Apply a write/delete optimistically and enforce strict either/or: remove
  // the address from every OTHER scope (mirrors the server's pipeline HDEL).
  const applyOptimistic = (
    current: EntriesState,
    scope: Scope,
    address: string,
    next: AddressEntry | null,
  ): EntriesState => {
    const lower = address.toLowerCase();
    const result: EntriesState = {
      global: { ...current.global },
      chains: new Map(current.chains),
    };

    if (scope === "global") {
      if (next === null) {
        delete result.global[lower];
      } else {
        result.global[lower] = next;
      }
      // Strict either/or: drop from every chain scope on upsert.
      if (next !== null) {
        for (const [cid, entries] of current.chains) {
          if (lower in entries) {
            const copy = { ...entries };
            delete copy[lower];
            result.chains.set(cid, copy);
          }
        }
      }
    } else {
      const chainEntries = { ...(current.chains.get(scope) ?? {}) };
      if (next === null) {
        delete chainEntries[lower];
      } else {
        chainEntries[lower] = next;
      }
      result.chains.set(scope, chainEntries);
      // Strict either/or: drop from global and every other chain on upsert.
      if (next !== null) {
        if (lower in result.global) {
          delete result.global[lower];
        }
        for (const [cid, entries] of current.chains) {
          if (cid !== scope && lower in entries) {
            const copy = { ...entries };
            delete copy[lower];
            result.chains.set(cid, copy);
          }
        }
      }
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
      scope: Scope,
    ): Promise<void> => {
      const lower = address.toLowerCase();
      const optimistic: AddressEntry = {
        name: entry.name,
        tags: entry.tags,
        notes: entry.notes,
        isPublic: entry.isPublic,
        updatedAt: new Date().toISOString(),
      };

      await mutate(
        SWR_KEY,
        async (current: EntriesState = emptyState()) => {
          const res = await fetch("/api/address-labels", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              scope,
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
          return applyOptimistic(current, scope, lower, optimistic);
        },
        {
          optimisticData: (current: EntriesState = emptyState()) =>
            applyOptimistic(current, scope, lower, optimistic),
          rollbackOnError: true,
        },
      );
    },
    [mutate],
  );

  const deleteEntry = useCallback(
    async (address: string, scope: Scope): Promise<void> => {
      const lower = address.toLowerCase();

      await mutate(
        SWR_KEY,
        async (current: EntriesState = emptyState()) => {
          const res = await fetch("/api/address-labels", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scope, address }),
          });
          if (!res.ok) {
            const body = (await res.json()) as { error?: string };
            throw new Error(body.error ?? "Failed to delete entry");
          }
          return applyOptimistic(current, scope, lower, null);
        },
        {
          optimisticData: (current: EntriesState = emptyState()) =>
            applyOptimistic(current, scope, lower, null),
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
