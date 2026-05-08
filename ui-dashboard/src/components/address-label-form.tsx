"use client";

import { useMemo, useRef, useState, type RefObject } from "react";
import { useAddressLabels } from "@/components/address-labels-provider";
import type { AddressEntry } from "@/lib/address-labels-shared";
import { TagInput } from "@/components/tag-input";
import { SUGGESTED_TAGS, getUsedTags } from "@/lib/tag-suggestions";
import { isValidAddress } from "@/lib/format";

// Pure helpers (exported for testing and re-exported via address-label-editor
// for back-compat with existing test imports).

/**
 * Determine whether the editor is operating on a contract row (existing address
 * that hasn't yet received a custom label). In this mode the name field is
 * optional; leaving it blank preserves the static contract name.
 */
export function resolveIsContractRow(opts: {
  isNewAddress: boolean;
  initial: { name?: string; label?: string } | undefined;
  isCustom: boolean;
}): boolean {
  return !opts.isNewAddress && opts.initial !== undefined && !opts.isCustom;
}

/**
 * Compute the name that will actually be persisted.
 * - For contract rows an empty name input falls back to the initial contract name.
 * - For all other rows the typed value is used as-is (required, validated upstream).
 */
export function resolveEffectiveName(
  nameInput: string,
  isContractRow: boolean,
  initialName: string | undefined,
): string {
  if (isContractRow && !nameInput.trim()) {
    return initialName ?? "";
  }
  return nameInput.trim();
}

/**
 * Validate the form inputs for the entry editor.
 * Returns an error string or null when valid.
 *
 * Relaxed validation: name is not required if tags are present.
 */
export function validateEntryForm(opts: {
  isNewAddress: boolean;
  address: string;
  name: string;
  tags?: string[];
  isContractRow: boolean;
}): string | null {
  if (opts.isNewAddress && !isValidAddress(opts.address.trim())) {
    return "Enter a valid 0x address.";
  }
  const hasTags = opts.tags && opts.tags.length > 0;
  if (!opts.isContractRow && !opts.name.trim() && !hasTags) {
    return "Name or at least one tag is required.";
  }
  return null;
}

type Props = {
  /** Empty string allows the user to type a new address. Otherwise rendered as static text. */
  address: string;
  /** Pre-filled values when editing an existing entry. */
  initial?: AddressEntry;
  /**
   * Bubbles the typed address up to the parent every time it changes (only
   * in new-address mode — the input only renders when `address === ""`).
   * The modal listens for this so the Forensic Report tab can read the
   * draft instead of the empty initial prop. The detail page never
   * triggers it (always opens with a non-empty URL address) and can omit
   * this prop.
   */
  onAddressChange?: (next: string) => void;
  /** Called after a successful save. The modal uses this to close itself; the detail page can use it for revalidation/toast. */
  onSaved?: () => void;
  /** Called after a successful delete. Modal closes here; detail page navigates back. */
  onDeleted?: () => void;
  /** When provided, renders a Cancel button in the form footer. Used by the modal. */
  onCancel?: () => void;
  /**
   * Optional ref attached to the form's first focusable field (address input
   * in new-address mode, name input otherwise). The modal owns focus
   * management and calls `.focus()` AFTER `dialog.showModal()` settles —
   * doing it inside this component would race the dialog's own focus steps
   * and land focus on the dialog's close button instead of the field.
   */
  firstFieldRef?: RefObject<HTMLInputElement | null>;
  /**
   * Fires whenever an in-flight save begins / ends. The detail page uses
   * this to pin its remount key during the save: `upsertEntry`'s optimistic
   * SWR update bumps `entry.updatedAt` immediately, and a key that includes
   * `updatedAt` would otherwise unmount the saving form and remount a fresh
   * one (`saving=false`) while the PUT is still in flight, re-enabling Save
   * for a window where a double-click can submit overlapping writes. The
   * modal doesn't need this — its key is stable across opens.
   */
  onSavingChange?: (saving: boolean) => void;
  /**
   * Same as `onSavingChange` but for the delete flow. `deleteEntry`'s
   * optimistic update REMOVES the entry, transitioning the page key from
   * `custom:<updatedAt>` → `new`. Without this latch, a fresh form
   * (`deleting=false`) mounts mid-DELETE and a save typed into it can
   * race the in-flight DELETE — if the DELETE completes last it wipes
   * out the just-saved label.
   */
  onDeletingChange?: (deleting: boolean) => void;
};

export function AddressLabelForm({
  address: initialAddress,
  initial,
  onAddressChange,
  onSaved,
  onDeleted,
  onCancel,
  firstFieldRef,
  onSavingChange,
  onDeletingChange,
}: Props) {
  const {
    upsertEntry,
    deleteEntry,
    isCustom: isCustomLabel,
    customEntries,
  } = useAddressLabels();
  const internalFirstInputRef = useRef<HTMLInputElement>(null);
  // Use the parent's ref when provided (modal); otherwise an internal ref
  // exists so the JSX still has a stable target.
  const firstInputRef = firstFieldRef ?? internalFirstInputRef;

  const isNewAddress = initialAddress === "";

  const [address, setAddress] = useState(initialAddress);
  const [name, setName] = useState(initial?.name ?? "");
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [isPublic, setIsPublic] = useState(initial?.isPublic ?? false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tagSuggestions = useMemo(() => {
    const used = getUsedTags(customEntries);
    const all = new Set([...SUGGESTED_TAGS, ...used]);
    return [...all].sort((a, b) => a.localeCompare(b));
  }, [customEntries]);

  // When editing an existing contract row (not a new address, no custom label yet),
  // label is optional — empty means "keep the contract name".
  const isContractRow = resolveIsContractRow({
    isNewAddress,
    initial,
    isCustom: isCustomLabel(address),
  });

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const validationError = validateEntryForm({
      isNewAddress,
      address,
      name,
      tags,
      isContractRow,
    });
    if (validationError) {
      setError(validationError);
      return;
    }
    const effectiveName = resolveEffectiveName(
      name,
      isContractRow,
      initial?.name,
    );
    setSaving(true);
    onSavingChange?.(true);
    setError(null);
    try {
      await upsertEntry(address, {
        name: effectiveName,
        tags,
        notes: notes.trim() || undefined,
        isPublic,
      });
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save label.");
    } finally {
      setSaving(false);
      onSavingChange?.(false);
    }
  }

  // Deletes the LABEL only — any forensic report on the same address survives
  // by design. Reports are evidence/history attached to the address; labels
  // are display aliases.
  async function handleDelete() {
    setDeleting(true);
    onDeletingChange?.(true);
    setError(null);
    try {
      await deleteEntry(address);
      onDeleted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete label.");
    } finally {
      setDeleting(false);
      onDeletingChange?.(false);
    }
  }

  const hasExistingCustomEntry = initial !== undefined && !isContractRow;

  return (
    <form onSubmit={handleSave} noValidate>
      <div className="px-5 py-4 space-y-4">
        {/* Address */}
        <div>
          <label
            htmlFor="al-address"
            className="block text-xs font-medium text-slate-400 mb-1"
          >
            Address {isNewAddress && <span className="text-indigo-400">*</span>}
          </label>
          {isNewAddress ? (
            <input
              ref={firstInputRef}
              id="al-address"
              type="text"
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                onAddressChange?.(e.target.value);
              }}
              placeholder="0x…"
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 font-mono text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          ) : (
            <p className="font-mono text-xs text-slate-300 break-all select-all">
              {address}
            </p>
          )}
        </div>

        {/* Name */}
        <div>
          <label
            htmlFor="al-name"
            className="block text-xs font-medium text-slate-400 mb-1"
          >
            Name{" "}
            {isContractRow ? (
              <span className="text-slate-500">(optional)</span>
            ) : (
              <span className="text-slate-500">(optional if tags added)</span>
            )}
          </label>
          <input
            ref={isNewAddress ? undefined : firstInputRef}
            id="al-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={
              isContractRow
                ? "Leave blank to keep contract name"
                : "e.g. Binance Hot Wallet"
            }
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>

        {/* Tags */}
        <div>
          <span
            id="al-tags-label"
            className="block text-xs font-medium text-slate-400 mb-1"
          >
            Tags <span className="text-slate-500">(optional)</span>
          </span>
          <TagInput
            tags={tags}
            onChange={setTags}
            suggestions={tagSuggestions}
            aria-labelledby="al-tags-label"
          />
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

        {/* Visibility toggle */}
        <div className="flex items-center gap-3">
          <label
            htmlFor="al-public"
            className="text-xs font-medium text-slate-400"
          >
            Visible to public
          </label>
          <button
            type="button"
            id="al-public"
            role="switch"
            aria-checked={isPublic}
            onClick={() => setIsPublic(!isPublic)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              isPublic ? "bg-indigo-600" : "bg-slate-700"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                isPublic ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </button>
          <span className="text-xs text-slate-500">
            {isPublic
              ? "Anyone can see this label"
              : "Only team members can see this label"}
          </span>
        </div>

        {error && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-slate-800 px-5 py-4">
        <div>
          {hasExistingCustomEntry && (
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
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-slate-700 px-4 py-2 text-xs text-slate-300 hover:border-slate-500 hover:text-white transition-colors"
            >
              Cancel
            </button>
          )}
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
  );
}
