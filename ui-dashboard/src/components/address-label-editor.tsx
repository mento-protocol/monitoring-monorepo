"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import {
  AddressLabelForm,
  resolveIsContractRow,
} from "@/components/address-label-form";
import { AddressReportEditor } from "@/components/address-report-editor";
import { useAddressLabels } from "@/components/address-labels-provider";
import type { AddressEntry } from "@/lib/address-labels-shared";

// Re-export pure helpers so existing test imports
// (`address-label-editor.test.ts`) keep working without churn.
export {
  resolveIsContractRow,
  resolveEffectiveName,
  validateEntryForm,
} from "@/components/address-label-form";

type EditorTab = "label" | "report";

type AddressDraftState = {
  sourceAddress: string;
  draftAddress: string;
};

type AddressDraftAction =
  | { type: "source-changed"; address: string }
  | { type: "draft-changed"; address: string };

type Props = {
  /** Pass empty string to allow the user to type a new address */
  address: string;
  /** Pre-filled initial values when editing an existing entry */
  initial?: AddressEntry | undefined;
  onClose: () => void;
  /**
   * Forwarded to the inner form. Forces an explicit name when set —
   * used when the address is registered as a contract under multiple
   * disagreeing names so a tag-only save can't persist an empty
   * global label that suppresses every contract row in the index.
   */
  requireExplicitName?: boolean | undefined;
  // Forwarded to the label form. Hosts (e.g. `AddressBookClient`)
  // wire these into the provider's pending-mutation ledger so a
  // save started in one surface (modal) blocks competing writes
  // from another (detail page) for the same address. The third
  // argument is the form's CURRENT address state (which the user
  // may have just typed in the new-address flow), so the host
  // marks pending against the correct address — not against
  // `editTarget.address` which is `""` for the add-new modal.
  onLabelSavingChange?:
    | ((saving: boolean, formId: string, address: string) => void)
    | undefined;
  onLabelDeletingChange?:
    | ((deleting: boolean, formId: string, address: string) => void)
    | undefined;
  /** Disable the entire label form (inputs + buttons). */
  externallyDisabledLabel?: boolean | undefined;
  // Same callbacks but for the forensic-report editor inside the
  // Report tab. Tracked separately so a label save doesn't block a
  // report save against the same address (or vice versa).
  onReportSavingChange?:
    | ((saving: boolean, editorId: string, address: string) => void)
    | undefined;
  onReportDeletingChange?:
    | ((deleting: boolean, editorId: string, address: string) => void)
    | undefined;
  /** Disable the entire forensic-report editor. */
  externallyDisabledReport?: boolean | undefined;
  /**
   * Bubbles the form's current address state up to the host. Used by
   * `AddressBookClient` in the add-new flow to evaluate
   * `requireExplicitName` and pending-ledger state against the
   * address the user is typing (the modal's `address` prop is `""`
   * on mount and never updates until close).
   */
  onDraftAddressChange?: ((next: string) => void) | undefined;
};

function addressDraftReducer(
  state: AddressDraftState,
  action: AddressDraftAction,
): AddressDraftState {
  if (action.type === "draft-changed") {
    return { ...state, draftAddress: action.address };
  }

  if (state.sourceAddress === action.address) return state;
  return { sourceAddress: action.address, draftAddress: action.address };
}

function createAddressDraftState(address: string): AddressDraftState {
  return { sourceAddress: address, draftAddress: address };
}

function useAddressDraft(address: string): [string, (next: string) => void] {
  const [state, dispatch] = useReducer(
    addressDraftReducer,
    address,
    createAddressDraftState,
  );
  useEffect(() => {
    dispatch({ type: "source-changed", address });
  }, [address]);
  return [
    state.draftAddress,
    (next: string) => dispatch({ type: "draft-changed", address: next }),
  ];
}

// eslint-disable-next-line max-lines-per-function -- Modal owns label/report tab wiring so pending-mutation ownership stays in one surface.
export function AddressLabelEditor({
  address,
  initial,
  onClose,
  requireExplicitName,
  onLabelSavingChange,
  onLabelDeletingChange,
  externallyDisabledLabel,
  onReportSavingChange,
  onReportDeletingChange,
  externallyDisabledReport,
  onDraftAddressChange,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<EditorTab>("label");
  // Mirror the form's typed address so the Forensic Report tab can read
  // the draft — `onAddressChange` bubbles every keystroke from
  // `AddressLabelForm` up here. `address` seeds the local draft and is
  // re-applied only when the parent switches this already-mounted editor
  // to a different address; normal add-new typing keeps `address === ""`
  // and stays owned by the draft state.
  const [draftAddress, setDraftAddress] = useAddressDraft(address);
  const { isCustom } = useAddressLabels();

  // Mount-only effect — every caller passes an inline `() => setX(false)`
  // arrow as `onClose`, so depending on it would re-fire `showModal()` on
  // every parent re-render and throw `InvalidStateError` on the
  // already-open dialog. Latch the close handler in a ref so the cleanup
  // closure can call the latest version without invalidating the effect.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (!dialog.open) dialog.showModal();
    // Focus the form's first field AFTER showModal — running it before
    // would race the dialog's native focus steps and the eventual focus
    // would land on the dialog's close button instead of the editable
    // field. Wrap in rAF so the focus call lands after the dialog's
    // initial focus pass.
    requestAnimationFrame(() => {
      firstInputRef.current?.focus();
    });

    // Close on backdrop click (target === dialog element itself).
    const handleBackdropClick = (e: MouseEvent) => {
      if (e.target === dialog) onCloseRef.current();
    };
    dialog.addEventListener("click", handleBackdropClick);
    return () => dialog.removeEventListener("click", handleBackdropClick);
    // Mount-only by design. The effect captures `onCloseRef.current` lazily
    // (re-read inside the click handler) so it always sees the latest
    // `onClose` without re-firing `showModal()` when the parent re-renders
    // with a fresh inline arrow.
  }, []);

  // Re-derive isContractRow at the editor level so the modal title stays
  // accurate. The form computes its own copy too — both call sites must
  // agree, but keeping the editor's check avoids exposing the form's
  // internal state across the API boundary. Drives off `draftAddress` so
  // the title flips correctly when a user types a known contract address
  // in the new-address flow.
  const isContractRow = resolveIsContractRow({
    isNewAddress: draftAddress === "",
    initial,
    isCustom: isCustom(draftAddress),
  });
  const hasExistingCustomEntry = initial !== undefined && !isContractRow;

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      // Forensic reports need more horizontal room than label/tag editing — bump
      // the modal width when the report tab is active so markdown tables and
      // code blocks render without horizontal scroll.
      className={`fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 mx-auto rounded-xl border border-slate-700 bg-slate-900 p-0 text-slate-100 shadow-2xl backdrop:bg-black/60 w-full ${
        activeTab === "report" ? "max-w-3xl" : "max-w-md"
      }`}
    >
      <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
        <h2 className="text-sm font-semibold text-white">
          {hasExistingCustomEntry ? "Edit label" : "Add label"}
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

      {/* Tab strip — separates the structural label/tag fields from the
          long-form forensic report so each has its own save action and the
          markdown body doesn't share scope with a 200-char Name input. */}
      <div
        role="tablist"
        aria-label="Address detail tabs"
        className="flex border-b border-slate-800 px-3"
      >
        <button
          type="button"
          role="tab"
          id="al-tab-label"
          aria-selected={activeTab === "label"}
          aria-controls="al-tab-label-panel"
          onClick={() => setActiveTab("label")}
          className={`px-3 py-2 text-xs font-medium transition-colors ${
            activeTab === "label"
              ? "border-b-2 border-indigo-500 text-white"
              : "text-slate-400 hover:text-slate-200"
          }`}
        >
          Label &amp; Tags
        </button>
        <button
          type="button"
          role="tab"
          id="al-tab-report"
          aria-selected={activeTab === "report"}
          aria-controls="al-tab-report-panel"
          onClick={() => setActiveTab("report")}
          className={`px-3 py-2 text-xs font-medium transition-colors ${
            activeTab === "report"
              ? "border-b-2 border-indigo-500 text-white"
              : "text-slate-400 hover:text-slate-200"
          }`}
        >
          Forensic Report
        </button>
      </div>

      {/* Both tab panels stay mounted — toggling visibility via `hidden`
          (instead of conditional render) preserves user-typed state in the
          label form when they peek at the report tab and switch back. */}
      <div
        role="tabpanel"
        id="al-tab-label-panel"
        aria-labelledby="al-tab-label"
        hidden={activeTab !== "label"}
      >
        <AddressLabelForm
          address={address}
          initial={initial}
          onAddressChange={(next) => {
            setDraftAddress(next);
            onDraftAddressChange?.(next);
          }}
          onSaved={onClose}
          onDeleted={onClose}
          onCancel={onClose}
          firstFieldRef={firstInputRef}
          requireExplicitName={requireExplicitName}
          onSavingChange={onLabelSavingChange}
          onDeletingChange={onLabelDeletingChange}
          externallyDisabled={externallyDisabledLabel}
        />
      </div>
      <div
        role="tabpanel"
        id="al-tab-report-panel"
        aria-labelledby="al-tab-report"
        hidden={activeTab !== "report"}
      >
        <AddressReportEditor
          address={draftAddress}
          onSavingChange={onReportSavingChange}
          onDeletingChange={onReportDeletingChange}
          externallyDisabled={externallyDisabledReport}
        />
      </div>
    </dialog>
  );
}
