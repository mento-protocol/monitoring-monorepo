"use client";

import { useRef, useEffect, useState } from "react";
import { useAddressLabels } from "@/components/address-labels-provider";
import type { AddressLabelEntry } from "@/lib/address-labels";

const CATEGORIES = [
  "CEX",
  "DEX",
  "Market Maker",
  "Arbitrageur",
  "DAO",
  "Team",
  "Treasury",
  "Protocol",
  "Wallet",
  "Other",
] as const;

type Props = {
  /** Pass empty string to allow the user to type a new address */
  address: string;
  /** Pre-filled initial values when editing an existing label */
  initial?: AddressLabelEntry;
  onClose: () => void;
};

export function AddressLabelEditor({
  address: initialAddress,
  initial,
  onClose,
}: Props) {
  const { upsertLabel, deleteLabel, isCustomLabel } = useAddressLabels();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  const isNewAddress = initialAddress === "";
  const [address, setAddress] = useState(initialAddress);
  const [label, setLabel] = useState(initial?.label ?? "");
  const [category, setCategory] = useState(initial?.category ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    dialog.showModal();
    firstInputRef.current?.focus();

    // Close when clicking the native backdrop (target === dialog element itself)
    const handleBackdropClick = (e: MouseEvent) => {
      if (e.target === dialog) onClose();
    };
    dialog.addEventListener("click", handleBackdropClick);
    return () => dialog.removeEventListener("click", handleBackdropClick);
  }, [onClose]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (isNewAddress && !/^0x[0-9a-fA-F]{40}$/.test(address.trim())) {
      setError("Enter a valid 0x address.");
      return;
    }
    if (!label.trim()) {
      setError("Label is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await upsertLabel(
        address,
        label.trim(),
        category.trim() || undefined,
        notes.trim() || undefined,
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save label.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      await deleteLabel(address);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete label.");
    } finally {
      setDeleting(false);
    }
  }

  const hasExistingCustomLabel = isCustomLabel(address);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="rounded-xl border border-slate-700 bg-slate-900 p-0 text-slate-100 shadow-2xl backdrop:bg-black/60 w-full max-w-md"
    >
      <form onSubmit={handleSave} noValidate>
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <h2 className="text-sm font-semibold text-white">
            {hasExistingCustomLabel ? "Edit label" : "Add label"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-slate-500 hover:text-slate-300 transition-colors text-lg leading-none"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Address */}
          <div>
            <label
              htmlFor="al-address"
              className="block text-xs font-medium text-slate-400 mb-1"
            >
              Address{" "}
              {isNewAddress && <span className="text-indigo-400">*</span>}
            </label>
            {isNewAddress ? (
              <input
                ref={firstInputRef}
                id="al-address"
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="0x…"
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 font-mono text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            ) : (
              <p className="font-mono text-xs text-slate-300 break-all select-all">
                {address}
              </p>
            )}
          </div>

          {/* Label */}
          <div>
            <label
              htmlFor="al-label"
              className="block text-xs font-medium text-slate-400 mb-1"
            >
              Label <span className="text-indigo-400">*</span>
            </label>
            <input
              ref={isNewAddress ? undefined : firstInputRef}
              id="al-label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Binance Hot Wallet"
              required
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          {/* Category */}
          <div>
            <label
              htmlFor="al-category"
              className="block text-xs font-medium text-slate-400 mb-1"
            >
              Category <span className="text-slate-500">(optional)</span>
            </label>
            <select
              id="al-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="">— none —</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          {/* Notes */}
          <div>
            <label
              htmlFor="al-notes"
              className="block text-xs font-medium text-slate-400 mb-1"
            >
              Notes <span className="text-slate-500">(optional)</span>
            </label>
            <textarea
              id="al-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Any context about this address…"
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
            />
          </div>

          {error && (
            <p role="alert" className="text-xs text-red-400">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-slate-800 px-5 py-4">
          <div>
            {hasExistingCustomLabel && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting || saving}
                className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 transition-colors"
              >
                {deleting ? "Removing…" : "Remove label"}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-700 px-4 py-2 text-xs text-slate-300 hover:border-slate-500 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || deleting}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
