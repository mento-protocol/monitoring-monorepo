"use client";

import { useRovingTabIndex } from "@/lib/use-roving-tab-index";
import { BADGE_LABELS, type BadgeKind } from "../_lib/transactions";

/** Order in which type-filter pills are rendered. Matches the visual
 *  groupings in BADGE_STYLES (event-level first, then trove ops). */
export const TX_FILTER_TYPE_ORDER: readonly BadgeKind[] = [
  "liquidation",
  "userRedemption",
  "rebalanceRedemption",
  "spRebalance",
  "troveOpen",
  "troveClose",
  "troveAdjust",
  "troveInterestRateChange",
  "troveBatch",
];

/** Single-select pill row with an "All" sentinel — same WAI-ARIA
 *  radiogroup contract as `BridgeStatusFilter`. */
export function CdpTxTypeFilter({
  options,
  selected,
  onChange,
}: {
  options: readonly BadgeKind[];
  selected: BadgeKind | null;
  onChange: (next: BadgeKind | null) => void;
}) {
  return (
    <RadioPillGroup<BadgeKind, BadgeKind>
      ariaLabel="Filter CDP transactions by type"
      labelText="Type:"
      options={options}
      selected={selected}
      onChange={onChange}
      renderLabel={(value) => BADGE_LABELS[value]}
    />
  );
}

export interface CdpTxMarketOption {
  id: string;
  symbol: string;
}

/** Same pill contract as `CdpTxTypeFilter` but typed for the market
 *  options — one pill per CDP collateral plus "All". */
export function CdpTxMarketFilter({
  options,
  selected,
  onChange,
}: {
  options: readonly CdpTxMarketOption[];
  selected: string | null;
  onChange: (next: string | null) => void;
}) {
  return (
    <RadioPillGroup<CdpTxMarketOption, string>
      ariaLabel="Filter CDP transactions by market"
      labelText="Market:"
      options={options}
      selected={selected}
      onChange={onChange}
      getValue={(o) => o.id}
      renderLabel={(o) => o.symbol}
    />
  );
}

/** Pill radiogroup with a leading "All" (null) option. Generic over the
 *  option type so type-filter and market-filter share the same WAI-ARIA
 *  + roving-tabindex behavior without duplicating the keyboard logic. */
function RadioPillGroup<TOption, TValue extends string>({
  ariaLabel,
  labelText,
  options,
  selected,
  onChange,
  getValue,
  renderLabel,
}: {
  ariaLabel: string;
  labelText: string;
  options: readonly TOption[];
  selected: TValue | null;
  onChange: (next: TValue | null) => void;
  getValue?: (o: TOption) => TValue;
  renderLabel: (o: TOption) => string;
}) {
  const resolveValue = (o: TOption): TValue =>
    getValue ? getValue(o) : (o as unknown as TValue);
  const activeIndex =
    selected === null
      ? 0
      : Math.max(0, options.findIndex((o) => resolveValue(o) === selected) + 1);

  function valueAt(index: number): TValue | null {
    if (index === 0) return null;
    const opt = options[index - 1];
    return opt == null ? null : resolveValue(opt);
  }

  const { groupRef, getItemProps, handleKeyDown } = useRovingTabIndex({
    activeIndex,
    itemCount: options.length + 1,
    activation: "automatic",
    arrowKeys: "all",
    onActivate: (index) => onChange(valueAt(index)),
  });
  const allProps = getItemProps(0);

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={ariaLabel}
      className="flex flex-wrap items-center gap-1.5"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <span className="text-xs text-slate-500 mr-1">{labelText}</span>
      <button
        type="button"
        role="radio"
        aria-checked={selected === null}
        ref={allProps.ref}
        tabIndex={allProps.tabIndex}
        onFocus={allProps.onFocus}
        onClick={() => selected !== null && onChange(null)}
        className={pillClasses(selected === null, true)}
      >
        All
      </button>
      {options.map((option, i) => {
        const value = resolveValue(option);
        const active = selected === value;
        const props = getItemProps(i + 1);
        const label = renderLabel(option);
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            ref={props.ref}
            tabIndex={props.tabIndex}
            onFocus={props.onFocus}
            onClick={() => !active && onChange(value)}
            className={pillClasses(active, false)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function pillClasses(active: boolean, isAll: boolean): string {
  const base =
    "rounded-full px-2.5 py-0.5 text-[10px] uppercase tracking-wider font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ";
  if (!active)
    return base + "bg-slate-800/60 text-slate-400 hover:text-slate-200";
  return (
    base +
    (isAll ? "bg-indigo-900/40 text-indigo-200" : "bg-slate-700 text-slate-200")
  );
}

/** Free-text address filter — when populated, the parent table narrows
 *  to TroveOperationEvent rows whose `owner` matches (case-insensitive,
 *  trimmed). Other event kinds don't have a single-trove owner dimension
 *  so the parent hides them whenever this filter is active.
 *
 *  Trim + lowercase normalization is intentionally done at the
 *  comparison site (in the table) rather than here so the user sees
 *  whatever they typed; we keep this component a controlled text input
 *  with no derived state. */
export function CdpTxAddressFilter({
  value,
  onChange,
  disabled,
  disabledHint,
}: {
  value: string;
  onChange: (next: string) => void;
  /** When the snapshot-isolated query (the source of owner data) hasn't
   *  resolved yet, render the input disabled with a small hint so users
   *  understand why the filter is unavailable instead of seeing zero
   *  matches after typing an address. */
  disabled?: boolean;
  disabledHint?: string;
}) {
  return (
    <label className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-slate-500">Owner:</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0x… (filter by trove owner)"
        spellCheck={false}
        autoComplete="off"
        aria-label="Filter CDP transactions by trove owner address"
        disabled={disabled}
        className="w-72 max-w-full rounded border border-slate-700/60 bg-slate-900/40 px-2 py-1 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
      />
      {disabled && disabledHint != null && (
        <span className="text-[10px] text-slate-500">{disabledHint}</span>
      )}
    </label>
  );
}

/** Normalize a user-entered address to the canonical form stored on
 *  `TroveOperationEvent.owner` (lowercase, whitespace-trimmed). Returns
 *  empty string for blank input, which the caller treats as "no filter". */
export function normalizeAddressFilter(raw: string): string {
  return raw.trim().toLowerCase();
}
