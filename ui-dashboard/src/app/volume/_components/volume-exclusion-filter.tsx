"use client";

import { useMemo, useState } from "react";
import {
  hasVolumeExclusions,
  mergeVolumeExclusions,
  parseVolumeExclusionInput,
  type VolumeExclusionState,
} from "@/lib/volume-exclusions";

type Props = {
  exclusions: VolumeExclusionState;
  sourceOptions: readonly string[];
  onChange: (next: VolumeExclusionState) => void;
};

const MAX_SOURCE_OPTIONS = 10;

export function VolumeExclusionFilter({
  exclusions,
  sourceOptions,
  onChange,
}: Props) {
  const [draft, setDraft] = useState("");
  const [invalidTokens, setInvalidTokens] = useState<string[]>([]);
  const active = hasVolumeExclusions(exclusions);

  const availableSourceOptions = useMemo(
    () =>
      sourceOptions
        .filter((source) => !exclusions.sources.includes(source))
        .slice(0, MAX_SOURCE_OPTIONS),
    [exclusions.sources, sourceOptions],
  );

  const addDraft = () => {
    const parsed = parseVolumeExclusionInput(draft);
    setInvalidTokens(parsed.invalid);
    if (parsed.addresses.length === 0 && parsed.sources.length === 0) return;
    onChange(mergeVolumeExclusions(exclusions, parsed));
    setDraft("");
    setInvalidTokens([]);
  };

  const removeAddress = (address: string) => {
    onChange({
      ...exclusions,
      addresses: exclusions.addresses.filter((item) => item !== address),
    });
  };
  const removeSource = (source: string) => {
    onChange({
      ...exclusions,
      sources: exclusions.sources.filter((item) => item !== source),
    });
  };

  return (
    <section className="rounded-md border border-slate-800/70 bg-slate-950/40 p-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <ExclusionSummary
          exclusions={exclusions}
          active={active}
          onRemoveAddress={removeAddress}
          onRemoveSource={removeSource}
        />
        <ExclusionControls
          draft={draft}
          invalidTokens={invalidTokens}
          active={active}
          sourceOptions={availableSourceOptions}
          onDraftChange={setDraft}
          onAddDraft={addDraft}
          onAddSource={(source) =>
            onChange(
              mergeVolumeExclusions(exclusions, {
                addresses: [],
                sources: [source],
              }),
            )
          }
          onClear={() => onChange({ addresses: [], sources: [] })}
        />
      </div>
    </section>
  );
}

function ExclusionSummary({
  exclusions,
  active,
  onRemoveAddress,
  onRemoveSource,
}: {
  exclusions: VolumeExclusionState;
  active: boolean;
  onRemoveAddress: (address: string) => void;
  onRemoveSource: (source: string) => void;
}) {
  return (
    <div className="min-w-0 flex-1 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium text-slate-300">
          Exploratory exclusions
        </h2>
        {active && (
          <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300">
            Analysis filter active
          </span>
        )}
      </div>
      <p className="max-w-3xl text-xs text-slate-500">
        Applies to loaded top-window rows with matching trader addresses or
        source attribution. Canonical hero totals and pool snapshots stay
        unfiltered.
      </p>
      <ExclusionChips
        exclusions={exclusions}
        active={active}
        onRemoveAddress={onRemoveAddress}
        onRemoveSource={onRemoveSource}
      />
    </div>
  );
}

function ExclusionChips({
  exclusions,
  active,
  onRemoveAddress,
  onRemoveSource,
}: {
  exclusions: VolumeExclusionState;
  active: boolean;
  onRemoveAddress: (address: string) => void;
  onRemoveSource: (source: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {exclusions.addresses.map((address) => (
        <FilterChip
          key={address}
          label={shortAddress(address)}
          detail="address"
          onRemove={() => onRemoveAddress(address)}
        />
      ))}
      {exclusions.sources.map((source) => (
        <FilterChip
          key={source}
          label={source}
          detail="source"
          onRemove={() => onRemoveSource(source)}
        />
      ))}
      {!active && (
        <span className="text-xs text-slate-500">
          No exploratory exclusions.
        </span>
      )}
    </div>
  );
}

function ExclusionControls({
  draft,
  invalidTokens,
  active,
  sourceOptions,
  onDraftChange,
  onAddDraft,
  onAddSource,
  onClear,
}: {
  draft: string;
  invalidTokens: readonly string[];
  active: boolean;
  sourceOptions: readonly string[];
  onDraftChange: (next: string) => void;
  onAddDraft: () => void;
  onAddSource: (source: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="w-full space-y-2 lg:w-[25rem]">
      <label
        htmlFor="volume-exclusion-input"
        className="text-xs font-medium text-slate-400"
      >
        Add address or source
      </label>
      <div className="flex gap-2">
        <input
          id="volume-exclusion-input"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onAddDraft();
            }
          }}
          placeholder="0x... or cluster-..."
          className="min-w-0 flex-1 rounded-md border border-slate-800 bg-slate-950 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
        <button
          type="button"
          onClick={onAddDraft}
          className="rounded-md bg-slate-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        >
          Add
        </button>
      </div>
      {invalidTokens.length > 0 && (
        <p className="text-xs text-red-300" role="alert">
          Ignored: {invalidTokens.join(", ")}
        </p>
      )}
      <SourceOptionButtons sources={sourceOptions} onAddSource={onAddSource} />
      {active && (
        <button
          type="button"
          onClick={onClear}
          className="text-xs font-medium text-slate-400 underline decoration-slate-600 underline-offset-4 hover:text-slate-200"
        >
          Clear exclusions
        </button>
      )}
    </div>
  );
}

function SourceOptionButtons({
  sources,
  onAddSource,
}: {
  sources: readonly string[];
  onAddSource: (source: string) => void;
}) {
  if (sources.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {sources.map((source) => (
        <button
          key={source}
          type="button"
          onClick={() => onAddSource(source)}
          className="rounded bg-slate-800/80 px-2 py-1 text-[11px] font-medium text-slate-300 hover:bg-slate-700 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        >
          {source}
        </button>
      ))}
    </div>
  );
}

function FilterChip({
  label,
  detail,
  onRemove,
}: {
  label: string;
  detail: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center overflow-hidden rounded bg-slate-800/80 text-xs text-slate-200">
      <span className="border-r border-slate-700 px-2 py-1">
        {label}
        <span className="ml-1 text-slate-500">{detail}</span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="px-1.5 py-1 text-slate-400 hover:bg-slate-700 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
      >
        x
      </button>
    </span>
  );
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
