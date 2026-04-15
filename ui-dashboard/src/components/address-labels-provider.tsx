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
import {
  upgradeEntries,
  type AddressEntry,
  type AddressLabelRecord,
} from "@/lib/address-labels-shared";

/** A custom address entry, labelled across all chains with its originating chainId. */
export type AddressEntryRow = AddressEntry & {
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

  // Deprecated aliases (kept for existing callers on pool detail pages).
  /** @deprecated Use getName instead */
  getLabel: (address: string | null, chainId?: number) => string;
  /** @deprecated Use hasName instead */
  hasLabel: (address: string | null, chainId?: number) => boolean;
  /** @deprecated Use isCustom instead */
  isCustomLabel: (address: string | null, chainId?: number) => boolean;
  /** @deprecated Use customEntries instead */
  customLabels: AddressLabelRecord[];
  /** @deprecated Use upsertEntry instead */
  upsertLabel: (
    address: string,
    label: string,
    category?: string,
    notes?: string,
    isPublic?: boolean,
  ) => Promise<void>;
  /** @deprecated Use deleteEntry instead */
  deleteLabel: (address: string) => Promise<void>;
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

export function AddressLabelsProvider({ children }: { children: ReactNode }) {
  const { network } = useNetwork();
  const { mutate } = useSWRConfig();

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

  const resolveChainId = (chainId?: number) => chainId ?? network.chainId;

  const getName = useCallback(
    (address: string | null, chainId?: number): string => {
      if (!address) return "\u2014";
      const lower = address.toLowerCase();
      const cid = resolveChainId(chainId);
      const customName = entriesByChain.get(cid)?.[lower]?.name;
      if (customName) return customName;
      const net = networkForChainId(cid) ?? network;
      return net.addressLabels[lower] ?? truncateAddress(address);
    },
    [entriesByChain, network],
  );

  const getTags = useCallback(
    (address: string | null, chainId?: number): string[] => {
      if (!address) return [];
      const cid = resolveChainId(chainId);
      return entriesByChain.get(cid)?.[address.toLowerCase()]?.tags ?? [];
    },
    [entriesByChain],
  );

  const hasName = useCallback(
    (address: string | null, chainId?: number): boolean => {
      if (!address) return false;
      const lower = address.toLowerCase();
      const cid = resolveChainId(chainId);
      const entry = entriesByChain.get(cid)?.[lower];
      const net = networkForChainId(cid) ?? network;
      return (
        (entry !== undefined && (entry.name !== "" || entry.tags.length > 0)) ||
        lower in net.addressLabels
      );
    },
    [entriesByChain, network],
  );

  const isCustom = useCallback(
    (address: string | null, chainId?: number): boolean => {
      if (!address) return false;
      const cid = resolveChainId(chainId);
      return address.toLowerCase() in (entriesByChain.get(cid) ?? {});
    },
    [entriesByChain],
  );

  const getEntry = useCallback(
    (address: string | null, chainId?: number): AddressEntry | undefined => {
      if (!address) return undefined;
      const cid = resolveChainId(chainId);
      return entriesByChain.get(cid)?.[address.toLowerCase()];
    },
    [entriesByChain],
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
      const cid = resolveChainId(chainId);
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
    [mutate, network.chainId],
  );

  const deleteEntry = useCallback(
    async (address: string, chainId?: number): Promise<void> => {
      const lower = address.toLowerCase();
      const cid = resolveChainId(chainId);

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
    [mutate, network.chainId],
  );

  const upsertLabel = useCallback(
    async (
      address: string,
      label: string,
      category?: string,
      notes?: string,
      isPublic?: boolean,
    ): Promise<void> => {
      const tags = category ? [category] : [];
      return upsertEntry(address, { name: label, tags, notes, isPublic });
    },
    [upsertEntry],
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
    getLabel: getName,
    hasLabel: hasName,
    isCustomLabel: isCustom,
    customLabels: customEntries,
    upsertLabel,
    deleteLabel: (address: string) => deleteEntry(address),
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
