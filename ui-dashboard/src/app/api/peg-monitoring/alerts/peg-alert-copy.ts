import { PEG_ALERT_RULE_KINDS, type PegAlertRuleKind } from "@/lib/peg-alerts";

export interface PegAlertCopyLine {
  ruleTitle: string;
  values: {
    A?: number | undefined;
    Fill?: number | undefined;
    Structural?: number | undefined;
    Reason?: number | undefined;
    HttpStatus?: number | undefined;
  };
  labels: {
    asset: string;
    source: string;
    policy_version: string;
  };
}

export interface PegAlertCauseCopy {
  lead: string;
  includesAsset: boolean;
}

const ASSET_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  europ: "EUROP",
  kesm: "KESm",
};

const PROVIDER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  bitvavo: "Bitvavo",
  kraken: "Kraken",
  valr: "VALR",
};

export function pegAlertRuleKind(line: PegAlertCopyLine): PegAlertRuleKind {
  const title = line.ruleTitle.match(/^Peg (.+?)(?: \[|$)/)?.[1];
  return (
    PEG_ALERT_RULE_KINDS.find((candidate) => candidate === title) ?? "Unknown"
  );
}

export function pegAlertAssetName(asset: string): string {
  const symbol = asset.split("-", 1)[0] ?? asset;
  return ASSET_DISPLAY_NAMES[symbol] ?? symbol.toUpperCase();
}

export function pegAlertSourceName(source: string): string {
  const provider = source.split("_", 1)[0] ?? source;
  if (provider === "") return "Price source";
  return (
    PROVIDER_DISPLAY_NAMES[provider] ??
    `${provider.slice(0, 1).toUpperCase()}${provider.slice(1)}`
  );
}

export function pegAlertSourceCurrency(source: string): string | null {
  const currency = source.split("_")[1];
  return currency === undefined ? null : currency.toUpperCase();
}

function numberLabel(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value) || value < 0) return null;
  return value.toFixed(1).replace(/\.0$/, "");
}

function withMeasurement(
  measured: string | null,
  precise: (value: string) => string,
  fallback: string,
): string {
  return measured === null ? fallback : precise(measured);
}

function httpStatus(line: PegAlertCopyLine): number | null {
  const value = line.values.HttpStatus;
  return value !== undefined &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : null;
}

function form(cleared: boolean, past: string, present: string): string {
  return cleared ? past : present;
}

interface SourceFailureContext {
  source: string;
  cleared: boolean;
  fill: string | null;
  status: number | null;
}

type SourceFailureFormatter = (context: SourceFailureContext) => string;

const SOURCE_FAILURE_LEADS: Partial<Record<number, SourceFailureFormatter>> = {
  1: ({ source, cleared, status }) =>
    `${source} ${form(cleared, "rejected", "is rejecting")} price requests because its rate limit ${form(cleared, "was", "is")} reached${status === null ? "" : ` (HTTP ${status})`}`,
  2: ({ source, cleared, status }) =>
    `${source} price request ${form(cleared, "returned", "returns")} ${status === null ? "an HTTP error" : `HTTP ${status}`}`,
  3: ({ source, cleared }) =>
    `${source} price request ${form(cleared, "timed out", "is timing out")}`,
  4: ({ source, cleared }) =>
    `${source} ${form(cleared, "could not be reached", "cannot be reached")}`,
  5: ({ source, cleared }) =>
    `${source} ${form(cleared, "returned", "is returning")} invalid price data`,
  6: ({ source, cleared }) =>
    `${source} price data ${form(cleared, "is fresh again", "is too old")}`,
  7: ({ source, cleared }) =>
    `${source} ${form(cleared, "repeated", "is repeating")} old price data`,
  8: ({ source, cleared, fill }) =>
    `${source} ${form(cleared, "could not", "cannot")} fill the monitored sell size${fill === null ? "" : `; only ${fill}% ${form(cleared, "was", "is")} available`}`,
  9: ({ source, cleared }) =>
    `${source} market ${form(cleared, "was", "is")} halted`,
  10: ({ source, cleared }) =>
    `${source} price ${form(cleared, "could not", "cannot")} be converted to the peg currency`,
  11: ({ source, cleared }) =>
    `${source} price conversion ${form(cleared, "failed", "is failing")}`,
  16: ({ cleared }) =>
    `Pool data ${form(cleared, "did not provide", "does not provide")} the monitored sell size`,
  17: ({ source, cleared }) =>
    `${source} ${form(cleared, "was", "is")} not supported by the monitor`,
  19: ({ source, cleared }) =>
    `Multiple failures ${form(cleared, "prevented", "are preventing")} a usable ${source} price`,
  20: ({ source, cleared }) =>
    `${source} ${form(cleared, "did not list", "does not list")} this market`,
};

function sourceFailureCause(
  line: PegAlertCopyLine,
  cleared: boolean,
): PegAlertCauseCopy {
  const context: SourceFailureContext = {
    source: pegAlertSourceName(line.labels.source),
    cleared,
    fill: numberLabel(line.values.Fill),
    status: httpStatus(line),
  };
  const formatter = SOURCE_FAILURE_LEADS[line.values.Reason ?? 0];
  const lead =
    formatter?.(context) ??
    form(
      cleared,
      `${context.source} sell price is available again`,
      `${context.source} sell price is unavailable`,
    );
  return { lead, includesAsset: false };
}

interface IndexedPoolContext {
  asset: string;
  cleared: boolean;
}

type IndexedPoolFormatter = (context: IndexedPoolContext) => string;

const INDEXED_POOL_LEADS: Partial<Record<number, IndexedPoolFormatter>> = {
  12: ({ asset, cleared }) =>
    `${asset} pool data ${form(cleared, "could not be fetched", "cannot be fetched")}`,
  13: ({ asset, cleared }) =>
    `${asset} pool ${form(cleared, "was", "is")} missing from indexed data`,
  14: ({ asset, cleared }) =>
    `${asset} indexed pool ${form(cleared, "did not match", "does not match")} the registry`,
  15: ({ asset, cleared }) =>
    `${asset} pool data ${form(cleared, "was", "is")} invalid`,
  19: ({ asset, cleared }) =>
    `Multiple indexed-data failures ${form(cleared, "blocked", "are blocking")} the ${asset} pool`,
};

function indexedPoolCause(
  line: PegAlertCopyLine,
  cleared: boolean,
): PegAlertCauseCopy {
  const context = { asset: pegAlertAssetName(line.labels.asset), cleared };
  const formatter = INDEXED_POOL_LEADS[line.values.Reason ?? 0];
  return {
    lead:
      formatter?.(context) ??
      `${context.asset} pool data ${form(cleared, "was", "is")} unavailable`,
    includesAsset: true,
  };
}

function marketListingCause(
  line: PegAlertCopyLine,
  cleared: boolean,
): PegAlertCauseCopy {
  const asset = pegAlertAssetName(line.labels.asset);
  const source = pegAlertSourceName(line.labels.source);
  const currency = pegAlertSourceCurrency(line.labels.source);
  const market = currency === null ? asset : `${asset}/${currency}`;
  return {
    lead: `${source} ${form(cleared, "did not list", "does not list")} the ${market} market`,
    includesAsset: true,
  };
}

type CauseBuilder = (
  line: PegAlertCopyLine,
  cleared: boolean,
) => PegAlertCauseCopy;

const downsideCause: CauseBuilder = (line, cleared) => {
  const source = pegAlertSourceName(line.labels.source);
  const present = form(cleared, "was", "is");
  return {
    lead: withMeasurement(
      numberLabel(line.values.A),
      (distance) => `${source} sell price ${present} ${distance} bps below peg`,
      `${source} sell price ${present} below peg`,
    ),
    includesAsset: false,
  };
};

const premiumCause: CauseBuilder = (line, cleared) => {
  const source = pegAlertSourceName(line.labels.source);
  const present = form(cleared, "was", "is");
  return {
    lead: withMeasurement(
      numberLabel(line.values.A),
      (distance) => `${source} sell price ${present} ${distance} bps above peg`,
      `${source} sell price ${present} above peg`,
    ),
    includesAsset: false,
  };
};

const spreadCause: CauseBuilder = (line, cleared) => {
  const source = pegAlertSourceName(line.labels.source);
  const present = form(cleared, "were", "are");
  return {
    lead: withMeasurement(
      numberLabel(line.values.A),
      (spread) =>
        `${source} buy and sell prices ${present} ${spread} bps apart`,
      `${source} buy and sell prices ${present} unusually far apart`,
    ),
    includesAsset: false,
  };
};

const structuralCause: CauseBuilder = (line, cleared) => {
  const asset = pegAlertAssetName(line.labels.asset);
  return {
    lead: withMeasurement(
      numberLabel(line.values.Structural),
      (used) =>
        `${asset} pool flow ${form(cleared, "used", "is using")} ${used}% of its trading limit`,
      `${asset} pool flow ${form(cleared, "was", "is")} close to its trading limit`,
    ),
    includesAsset: true,
  };
};

const stressedSourceCause: CauseBuilder = (line, cleared) => {
  const failure = sourceFailureCause(line, cleared);
  return {
    ...failure,
    lead: `${failure.lead} while separate market data ${form(cleared, "also showed", "also shows")} stress`,
  };
};

const heartbeatCause: CauseBuilder = (line, cleared) => ({
  lead: `${pegAlertAssetName(line.labels.asset)} monitor data ${form(cleared, "stopped", "has stopped")} updating`,
  includesAsset: true,
});

const rolloverCause: CauseBuilder = (line, cleared) => ({
  lead: `Peg monitor ${form(cleared, "did not load", "has not loaded")} policy ${line.labels.policy_version}`,
  includesAsset: true,
});

const unknownCause: CauseBuilder = (line, cleared) => ({
  lead: `${pegAlertAssetName(line.labels.asset)} monitor ${form(cleared, "reported", "is reporting")} an unknown condition`,
  includesAsset: true,
});

const CAUSE_BUILDERS: Record<PegAlertRuleKind, CauseBuilder> = {
  "Blind Warning": sourceFailureCause,
  "Blind While Stressed Critical": stressedSourceCause,
  "Critical Path Unreachable": marketListingCause,
  "Deep-Venue Downside Critical": downsideCause,
  "Deep-Venue Spread Warning": spreadCause,
  "Downside Warning": downsideCause,
  "Heartbeat Missing": heartbeatCause,
  "Indexed Pool Unreachable": indexedPoolCause,
  "Policy Rollover Stuck": rolloverCause,
  "Premium Warning": premiumCause,
  "Registry Rot": marketListingCause,
  "Source Permanently Dead": sourceFailureCause,
  "Source Unhealthy": sourceFailureCause,
  "Structural Saturation Warning": structuralCause,
  Unknown: unknownCause,
};

export function pegAlertCauseCopy(
  line: PegAlertCopyLine,
  cleared: boolean,
): PegAlertCauseCopy {
  return CAUSE_BUILDERS[pegAlertRuleKind(line)](line, cleared);
}
