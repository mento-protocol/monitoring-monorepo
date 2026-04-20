"use client";

import {
  createContext,
  use,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import useSWR, { useSWRConfig } from "swr";
import { useNetwork } from "@/components/network-provider";
import { truncateAddress } from "@/lib/format";
import { NETWORKS, networkIdForChainId, type Network } from "@/lib/networks";
import { upgradeEntries, type AddressEntry } from "@/lib/address-labels-shared";

/** A custom address entry, labelled across all chains with its originating chainId. */
type AddressEntryRow = AddressEntry & {
  address: string;
  chainId: number;
};

type AddressLabelsContextValue = {
  /** Merged name: custom name > static contract name > truncated address */
  getName: (address: string | null, chainId?: number) => string;
  /** Tags for an address (custom entries only; contracts return []) */
  getTags: (address: string | null, chainId?: number) => string[];
  /** True if address has any name (custom or static) on the given chain */
  hasName: (address: string | null, chainId?: number) => boolean;
  /** True if address has a user-created custom entry on the given chain */
  isCustom: (address: string | null, chainId?: number) => boolean;
  /** Full entry metadata for custom entries only */
  getEntry: (
    address: string | null,
    chainId?: number,
  ) => AddressEntry | undefined;
  /** All custom entry rows across every chain, sorted by name. */
  customEntries: AddressEntryRow[];
  /** Add or update a custom entry. `chainId` defaults to the current network. */
  upsertEntry: (
    address: string,
    entry: {
      name: string;
      tags: string[];
      notes?: string;
      isPublic?: boolean;
    },
    chainId?: number,
  ) => Promise<void>;
  /** Remove a custom entry. `chainId` defaults to the current network. */
  deleteEntry: (address: string, chainId?: number) => Promise<void>;
  isLoading: boolean;
  error: Error | undefined;
};

const AddressLabelsContext = createContext<AddressLabelsContextValue | null>(
  null,
);

type EntriesByChain = Map<number, Record<string, AddressEntry>>;

const SWR_KEY = "address-labels:all";

async function fetchAllLabels(): Promise<EntriesByChain> {
  const res = await fetch("/api/address-labels");
  if (!res.ok) throw new Error(`Failed to fetch address labels: ${res.status}`);
  const raw = (await res.json()) as Record<string, Record<string, unknown>>;
  const result: EntriesByChain = new Map();
  for (const [chainIdStr, entries] of Object.entries(raw)) {
    const chainId = Number(chainIdStr);
    if (!Number.isFinite(chainId)) continue;
    result.set(chainId, upgradeEntries(entries as Record<string, unknown>));
  }
  return result;
}

function networkForChainId(chainId: number): Network | null {
  const id = networkIdForChainId(chainId);
  return id ? NETWORKS[id] : null;
}

/** Fallback for multichain addresses (e.g. CREATE2/CREATE3-deterministic
 * bridge contracts, multichain operator EOAs) where the user only set the
 * custom label on one chain. Look at every known chain's custom + static
 * entries and return the first matching name. Per-chain lookups still take
 * precedence — this only fires on miss. */
function findNameAcrossChains(
  lower: string,
  entriesByChain: EntriesByChain,
): string | null {
  for (const [, chainEntries] of entriesByChain) {
    const name = chainEntries[lower]?.name;
    if (name) return name;
  }
  for (const net of Object.values(NETWORKS)) {
    const name = net.addressLabels[lower];
    if (name) return name;
  }
  return null;
}

export function AddressLabelsProvider({ children }: { children: ReactNode }) {
  const { network } = useNetwork();
  const { mutate } = useSWRConfig();

  // Fetch for all sessions — the API returns `isPublic: true` labels for
  // anonymous requests and full labels for authenticated ones. Gating on the
  // client would hide public labels from logged-out users.
  const { data, error, isLoading } = useSWR<EntriesByChain>(
    SWR_KEY,
    fetchAllLabels,
    {
      refreshInterval: 30_000,
      fallbackData: new Map(),
    },
  );

  const entriesByChain: EntriesByChain = data ?? new Map();

  const customEntries: AddressEntryRow[] = useMemo(() => {
    const rows: AddressEntryRow[] = [];
    for (const [chainId, chainEntries] of entriesByChain) {
      for (const [address, entry] of Object.entries(chainEntries)) {
        rows.push({ address, chainId, ...entry });
      }
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }, [entriesByChain]);

  const defaultChainId = network.chainId;

  const getName = useCallback(
    (address: string | null, chainId?: number): string => {
      if (!address) return "\u2014";
      const lower = address.toLowerCase();
      const cid = chainId ?? defaultChainId;
      const customName = entriesByChain.get(cid)?.[lower]?.name;
      if (customName) return customName;
      const net = networkForChainId(cid) ?? network;
      const staticName = net.addressLabels[lower];
      if (staticName) return staticName;
      const crossChainName = findNameAcrossChains(lower, entriesByChain);
      if (crossChainName) return crossChainName;
      return truncateAddress(address);
    },
    [entriesByChain, network, defaultChainId],
  );

  const getTags = useCallback(
    (address: string | null, chainId?: number): string[] => {
      if (!address) return [];
      const cid = chainId ?? defaultChainId;
      return entriesByChain.get(cid)?.[address.toLowerCase()]?.tags ?? [];
    },
    [entriesByChain, defaultChainId],
  );

  const hasName = useCallback(
    (address: string | null, chainId?: number): boolean => {
      if (!address) return false;
      const lower = address.toLowerCase();
      const cid = chainId ?? defaultChainId;
      const entry = entriesByChain.get(cid)?.[lower];
      const net = networkForChainId(cid) ?? network;
      if (entry !== undefined && (entry.name !== "" || entry.tags.length > 0)) {
        return true;
      }
      if (lower in net.addressLabels) return true;
      return findNameAcrossChains(lower, entriesByChain) !== null;
    },
    [entriesByChain, network, defaultChainId],
  );

  const isCustom = useCallback(
    (address: string | null, chainId?: number): boolean => {
      if (!address) return false;
      const cid = chainId ?? defaultChainId;
      return address.toLowerCase() in (entriesByChain.get(cid) ?? {});
    },
    [entriesByChain, defaultChainId],
  );

  const getEntry = useCallback(
    (address: string | null, chainId?: number): AddressEntry | undefined => {
      if (!address) return undefined;
      const cid = chainId ?? defaultChainId;
      return entriesByChain.get(cid)?.[address.toLowerCase()];
    },
    [entriesByChain, defaultChainId],
  );

  const applyOptimistic = (
    current: EntriesByChain,
    chainId: number,
    address: string,
    next: AddressEntry | null,
  ): EntriesByChain => {
    const result = new Map(current);
    const chainEntries = { ...(result.get(chainId) ?? {}) };
    if (next === null) {
      delete chainEntries[address];
    } else {
      chainEntries[address] = next;
    }
    result.set(chainId, chainEntries);
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
      chainId?: number,
    ): Promise<void> => {
      const lower = address.toLowerCase();
      const cid = chainId ?? defaultChainId;
      const optimistic: AddressEntry = {
        name: entry.name,
        tags: entry.tags,
        notes: entry.notes,
        isPublic: entry.isPublic,
        updatedAt: new Date().toISOString(),
      };

      await mutate(
        SWR_KEY,
        async (current: EntriesByChain = new Map()) => {
          const res = await fetch("/api/address-labels", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chainId: cid,
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
          return applyOptimistic(current, cid, lower, optimistic);
        },
        {
          optimisticData: (current: EntriesByChain = new Map()) =>
            applyOptimistic(current, cid, lower, optimistic),
          rollbackOnError: true,
        },
      );
    },
    [mutate, defaultChainId],
  );

  const deleteEntry = useCallback(
    async (address: string, chainId?: number): Promise<void> => {
      const lower = address.toLowerCase();
      const cid = chainId ?? defaultChainId;

      await mutate(
        SWR_KEY,
        async (current: EntriesByChain = new Map()) => {
          const res = await fetch("/api/address-labels", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chainId: cid, address }),
          });
          if (!res.ok) {
            const body = (await res.json()) as { error?: string };
            throw new Error(body.error ?? "Failed to delete entry");
          }
          return applyOptimistic(current, cid, lower, null);
        },
        {
          optimisticData: (current: EntriesByChain = new Map()) =>
            applyOptimistic(current, cid, lower, null),
          rollbackOnError: true,
        },
      );
    },
    [mutate, defaultChainId],
  );

  const value: AddressLabelsContextValue = {
    getName,
    getTags,
    hasName,
    isCustom,
    getEntry,
    customEntries,
    upsertEntry,
    deleteEntry,
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
