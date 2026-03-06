"use client";

import { createContext, use, useCallback, type ReactNode } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useNetwork } from "@/components/network-provider";
import { truncateAddress } from "@/lib/format";
import type {
  AddressLabelEntry,
  AddressLabelRecord,
} from "@/lib/address-labels";

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

type AddressLabelsContextValue = {
  /** Merged label: custom label > static contract label > truncated address */
  getLabel: (address: string | null) => string;
  /** True if address has any label (custom or static) */
  hasLabel: (address: string | null) => boolean;
  /** True if address has a user-created custom label (not from contracts.json) */
  isCustomLabel: (address: string | null) => boolean;
  /** Full entry metadata for custom labels only */
  getEntry: (address: string | null) => AddressLabelEntry | undefined;
  /** All custom label records for the current network, sorted by label */
  customLabels: AddressLabelRecord[];
  /** Add or update a custom label */
  upsertLabel: (
    address: string,
    label: string,
    category?: string,
    notes?: string,
  ) => Promise<void>;
  /** Remove a custom label */
  deleteLabel: (address: string) => Promise<void>;
  isLoading: boolean;
  error: Error | undefined;
};

const AddressLabelsContext = createContext<AddressLabelsContextValue | null>(
  null,
);

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

async function fetchLabels(
  chainId: number,
): Promise<Record<string, AddressLabelEntry>> {
  const res = await fetch(`/api/address-labels?chainId=${chainId}`);
  if (!res.ok) throw new Error(`Failed to fetch address labels: ${res.status}`);
  return res.json() as Promise<Record<string, AddressLabelEntry>>;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AddressLabelsProvider({ children }: { children: ReactNode }) {
  const { network } = useNetwork();
  const { mutate } = useSWRConfig();
  const chainId = network.chainId;

  const { data, error, isLoading } = useSWR<Record<string, AddressLabelEntry>>(
    ["address-labels", chainId],
    () => fetchLabels(chainId),
    { refreshInterval: 30_000, fallbackData: {} },
  );

  const customData = data ?? {};

  // Pre-build sorted records list once per render
  const customLabels: AddressLabelRecord[] = Object.entries(customData)
    .map(([address, entry]) => ({ address, ...entry }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const getLabel = useCallback(
    (address: string | null): string => {
      if (!address) return "\u2014";
      const lower = address.toLowerCase();
      return (
        customData[lower]?.label ??
        network.addressLabels[lower] ??
        truncateAddress(address)
      );
    },
    [customData, network.addressLabels],
  );

  const hasLabel = useCallback(
    (address: string | null): boolean => {
      if (!address) return false;
      const lower = address.toLowerCase();
      return lower in customData || lower in network.addressLabels;
    },
    [customData, network.addressLabels],
  );

  const isCustomLabel = useCallback(
    (address: string | null): boolean => {
      if (!address) return false;
      return address.toLowerCase() in customData;
    },
    [customData],
  );

  const getEntry = useCallback(
    (address: string | null): AddressLabelEntry | undefined => {
      if (!address) return undefined;
      return customData[address.toLowerCase()];
    },
    [customData],
  );

  const upsertLabel = useCallback(
    async (
      address: string,
      label: string,
      category?: string,
      notes?: string,
    ): Promise<void> => {
      const lower = address.toLowerCase();
      const optimistic: AddressLabelEntry = {
        label,
        category,
        notes,
        updatedAt: new Date().toISOString(),
      };

      await mutate(
        ["address-labels", chainId],
        async (current: Record<string, AddressLabelEntry> = {}) => {
          const res = await fetch("/api/address-labels", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chainId, address, label, category, notes }),
          });
          if (!res.ok) {
            const body = (await res.json()) as { error?: string };
            throw new Error(body.error ?? "Failed to save label");
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

  const deleteLabel = useCallback(
    async (address: string): Promise<void> => {
      const lower = address.toLowerCase();

      await mutate(
        ["address-labels", chainId],
        async (current: Record<string, AddressLabelEntry> = {}) => {
          const res = await fetch("/api/address-labels", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chainId, address }),
          });
          if (!res.ok) {
            const body = (await res.json()) as { error?: string };
            throw new Error(body.error ?? "Failed to delete label");
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

  const value: AddressLabelsContextValue = {
    getLabel,
    hasLabel,
    isCustomLabel,
    getEntry,
    customLabels,
    upsertLabel,
    deleteLabel,
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
