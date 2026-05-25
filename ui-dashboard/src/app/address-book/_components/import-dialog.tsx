import type { RefObject } from "react";

type ImportDialogProps = {
  fileInputRef: RefObject<HTMLInputElement | null>;
  isImporting: boolean;
  onImportClick: () => void;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
};

export function ImportDialog({
  fileInputRef,
  isImporting,
  onImportClick,
  onFileChange,
}: ImportDialogProps) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        disabled={isImporting}
        onClick={onImportClick}
        className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
      >
        {isImporting ? "Importing..." : "Import"}
      </button>
      <details className="relative">
        <summary
          aria-label="Supported import formats"
          title="Supported import formats"
          className="cursor-pointer list-none rounded-full p-1 text-slate-500 hover:text-slate-300 transition-colors"
        >
          <span aria-hidden="true">&#9432;</span>
        </summary>
        <div className="absolute right-0 top-8 z-10 w-80 rounded-lg border border-slate-700 bg-slate-900 p-3 text-xs text-slate-400 shadow-xl">
          <p className="mb-2 font-semibold text-slate-300">
            Supported import formats:
          </p>
          <p className="mb-1 font-medium text-slate-400">Mento export:</p>
          <pre className="mb-2 overflow-x-auto rounded bg-slate-800 p-2 text-slate-400 text-[10px] leading-relaxed">{`{ "exportedAt": "...",\n  "chains": { "42220": {\n    "0x...": { "name": "...",\n      "tags": ["..."],\n      "notes": "..." } } } }`}</pre>
          <p className="mb-1 font-medium text-slate-400">
            Gnosis Safe address book:
          </p>
          <pre className="mb-2 overflow-x-auto rounded bg-slate-800 p-2 text-slate-400 text-[10px] leading-relaxed">{`[{ "address": "0x...",\n   "chainId": "1",\n   "name": "My Label" }]`}</pre>
          <p className="mb-1 font-medium text-slate-400">
            CSV (address,name,tags,chainId) — chainId blank = cross-chain:
          </p>
          <pre className="overflow-x-auto rounded bg-slate-800 p-2 text-slate-400 text-[10px] leading-relaxed">{`address,name,tags,chainId\n0x...,My Label,"Whale",\n0x...,Celo Rebalancer,,42220`}</pre>
        </div>
      </details>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.csv,application/json,text/csv,text/plain"
        onChange={onFileChange}
        disabled={isImporting}
        className="hidden"
        aria-label="Import address labels (JSON or CSV)"
      />
    </div>
  );
}
