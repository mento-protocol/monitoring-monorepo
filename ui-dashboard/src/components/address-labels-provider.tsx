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
import {
  upgradeEntry,
  type AddressEntry,
  type AddressEntryRecord,
  type AddressLabelRecord,
} from "@/lib/address-labels";

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

type AddressLabelsContextValue = {
  /** Merged name: custom name > static contract name > truncated address */
  getName: (address: string | null) => string;
  /** Tags for an address (custom entries only; contracts return []) */
  getTags: (address: string | null) => string[];
  /** True if address has any name (custom or static) */
  hasName: (address: string | null) => boolean;
  /** True if address has a user-created custom entry (not from contracts.json) */
  isCustom: (address: string | null) => boolean;
  /** Full entry metadata for custom entries only */
  getEntry: (address: string | null) => AddressEntry | undefined;
  /** All custom entry records for the current network, sorted by name */
  customEntries: AddressEntryRecord[];
  /** Add or update a custom entry */
  upsertEntry: (
    address: string,
    entry: {
      name: string;
      tags: string[];
      notes?: string;
      isPublic?: boolean;
    },
  ) => Promise<void>;
  /** Remove a custom entry */
  deleteEntry: (address: string) => Promise<void>;
  isLoading: boolean;
  error: Error | undefined;

  // Deprecated aliases (remove after all consumers updated in Phase 2+3)
  /** @deprecated Use getName instead */
  getLabel: (address: string | null) => string;
  /** @deprecated Use hasName instead */
  hasLabel: (address: string | null) => boolean;
  /** @deprecated Use isCustom instead */
  isCustomLabel: (address: string | null) => boolean;
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

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

async function fetchLabels(
  chainId: number,
): Promise<Record<string, AddressEntry>> {
  const res = await fetch(`/api/address-labels?chainId=${chainId}`);
  if (!res.ok) throw new Error(`Failed to fetch address labels: ${res.status}`);
  return res.json() as Promise<Record<string, AddressEntry>>;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Client-side backward compat: if SWR cache contains stale v1 entries
 * (with `label` instead of `name`), auto-upgrade them.
 */
function ensureUpgraded(
  data: Record<string, unknown>,
): Record<string, AddressEntry> {
  const result: Record<string, AddressEntry> = {};
  for (const [address, rawEntry] of Object.entries(data)) {
    if (typeof rawEntry !== "object" || rawEntry === null) continue;
    const entry = rawEntry as Record<string, unknown>;
    // Already v2 shape
    if (typeof entry.name === "string") {
      result[address] = {
        name: entry.name,
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        notes: typeof entry.notes === "string" ? entry.notes : undefined,
        isPublic: entry.isPublic === true ? true : undefined,
        updatedAt:
          typeof entry.updatedAt === "string"
            ? entry.updatedAt
            : new Date().toISOString(),
      };
    } else {
      // Stale v1 cache entry — upgrade
      result[address] = upgradeEntry(entry);
    }
  }
  return result;
}

export function AddressLabelsProvider({ children }: { children: ReactNode }) {
  const { network } = useNetwork();
  const { mutate } = useSWRConfig();
  const chainId = network.chainId;

  const { data, error, isLoading } = useSWR<Record<string, AddressEntry>>(
    ["address-labels", chainId],
    () => fetchLabels(chainId),
    { refreshInterval: 30_000, fallbackData: {} },
  );

  // Client-side backward compat for stale SWR cache.
  // Memoised on `data` identity — SWR stabilises the reference when data
  // hasn't changed, so this only re-runs on actual fetches/mutations.
  const customData = useMemo(
    () => (data ? ensureUpgraded(data as Record<string, unknown>) : {}),
    [data],
  );

  // Pre-build sorted records list — stable as long as customData is stable.
  const customEntries: AddressEntryRecord[] = useMemo(
    () =>
      Object.entries(customData)
        .map(([address, entry]) => ({ address, ...entry }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [customData],
  );

  const getName = useCallback(
    (address: string | null): string => {
      if (!address) return "\u2014";
      const lower = address.toLowerCase();
      const customName = customData[lower]?.name;
      if (customName) return customName;
      return network.addressLabels[lower] ?? truncateAddress(address);
    },
    [customData, network.addressLabels],
  );

  const getTags = useCallback(
    (address: string | null): string[] => {
      if (!address) return [];
      return customData[address.toLowerCase()]?.tags ?? [];
    },
    [customData],
  );

  const hasName = useCallback(
    (address: string | null): boolean => {
      if (!address) return false;
      const lower = address.toLowerCase();
      const customName = customData[lower]?.name;
      return (
        (customName !== undefined && customName !== "") ||
        lower in network.addressLabels
      );
    },
    [customData, network.addressLabels],
  );

  const isCustom = useCallback(
    (address: string | null): boolean => {
      if (!address) return false;
      return address.toLowerCase() in customData;
    },
    [customData],
  );

  const getEntry = useCallback(
    (address: string | null): AddressEntry | undefined => {
      if (!address) return undefined;
      return customData[address.toLowerCase()];
    },
    [customData],
  );

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
      const optimistic: AddressEntry = {
        name: entry.name,
        tags: entry.tags,
        notes: entry.notes,
        isPublic: entry.isPublic,
        updatedAt: new Date().toISOString(),
      };

      await mutate(
        ["address-labels", chainId],
        async (current: Record<string, AddressEntry> = {}) => {
          const res = await fetch("/api/address-labels", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chainId,
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
          return { ...current, [lower]: optimistic };
        },
        {
          optimisticData: { ...customData, [lower]: optimistic },
          rollbackOnError: true,
        },
      );
    },
    [mutate, chainId, customData],
  );

  const deleteEntry = useCallback(
    async (address: string): Promise<void> => {
      const lower = address.toLowerCase();

      await mutate(
        ["address-labels", chainId],
        async (current: Record<string, AddressEntry> = {}) => {
          const res = await fetch("/api/address-labels", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chainId, address }),
          });
          if (!res.ok) {
            const body = (await res.json()) as { error?: string };
            throw new Error(body.error ?? "Failed to delete entry");
          }
          const next = { ...current };
          delete next[lower];
          return next;
        },
        {
          optimisticData: (() => {
            const next = { ...customData };
            delete next[lower];
            return next;
          })(),
          rollbackOnError: true,
        },
      );
    },
    [mutate, chainId, customData],
  );

  // Deprecated alias: upsertLabel(address, label, category?, notes?, isPublic?)
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
    // Deprecated aliases
    getLabel: getName,
    hasLabel: hasName,
    isCustomLabel: isCustom,
    customLabels: customEntries,
    upsertLabel,
    deleteLabel: deleteEntry,
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
