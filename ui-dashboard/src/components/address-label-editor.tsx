"use client";

import { useEffect, useRef, useState } from "react";
import { AddressLabelForm } from "@/components/address-label-form";
import { AddressReportEditor } from "@/components/address-report-editor";
import type { AddressEntry } from "@/lib/address-labels-shared";

// Re-export pure helpers so existing test imports
// (`address-label-editor.test.ts`) keep working without churn.
export {
  resolveIsContractRow,
  resolveEffectiveName,
  validateEntryForm,
} from "@/components/address-label-form";

type EditorTab = "label" | "report";

type Props = {
  /** Pass empty string to allow the user to type a new address */
  address: string;
  /** Pre-filled initial values when editing an existing entry */
  initial?: AddressEntry;
  onClose: () => void;
};

export function AddressLabelEditor({ address, initial, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [activeTab, setActiveTab] = useState<EditorTab>("label");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    dialog.showModal();

    // Close when clicking the native backdrop (target === dialog element itself)
    const handleBackdropClick = (e: MouseEvent) => {
      if (e.target === dialog) onClose();
    };
    dialog.addEventListener("click", handleBackdropClick);
    return () => dialog.removeEventListener("click", handleBackdropClick);
  }, [onClose]);

  const hasExistingCustomEntry = initial !== undefined;

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

      {activeTab === "report" ? (
        <div
          role="tabpanel"
          id="al-tab-report-panel"
          aria-labelledby="al-tab-report"
        >
          <AddressReportEditor address={address} />
        </div>
      ) : (
        <div
          role="tabpanel"
          id="al-tab-label-panel"
          aria-labelledby="al-tab-label"
        >
          <AddressLabelForm
            address={address}
            initial={initial}
            onSaved={onClose}
            onDeleted={onClose}
            onCancel={onClose}
            focusOnMount
          />
        </div>
      )}
    </dialog>
  );
}
