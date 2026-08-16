import type { PegAlertEvent, PegAlertRuleKind } from "@/lib/peg-alerts";
import type {
  PegAssetPackage,
  PegMonitoringResponse,
  PegSource,
} from "@/lib/peg-monitoring";

type ExactPolicyContext = {
  asset: PegAssetPackage;
  source: PegSource | null;
};

function durationWords(seconds: number): string {
  if (seconds < 60) return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  if (seconds < 3_600) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  if (seconds < 86_400) {
    const hours = Math.max(1, Math.round(seconds / 3_600));
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.max(1, Math.round(seconds / 86_400));
  return `${days} ${days === 1 ? "day" : "days"}`;
}

function exactPolicyContext(
  event: PegAlertEvent,
  monitoring: PegMonitoringResponse,
): ExactPolicyContext | null {
  if (event.evidence.policyVersion !== monitoring.producedPolicyVersion) {
    return null;
  }
  const asset = monitoring.packages.find(
    (candidate) => candidate.asset === event.evidence.assetId,
  );
  if (asset === undefined) return null;
  return {
    asset,
    source:
      asset.sources.find(
        (candidate) => candidate.id === event.evidence.sourceId,
      ) ?? null,
  };
}

function marketName(event: PegAlertEvent): string {
  const quote = event.evidence.quoteCurrency;
  return quote === null
    ? event.evidence.assetName
    : `${event.evidence.assetName}/${quote}`;
}

function pendingSentence(
  event: PegAlertEvent,
  condition = "the condition continued",
): string {
  const seconds = event.evidence.pendingSeconds;
  return seconds === null || seconds <= 0
    ? ""
    : ` The alert fired after ${condition} for ${durationWords(seconds)}.`;
}

function blindThresholdSentence(
  event: PegAlertEvent,
  policy: ExactPolicyContext | null,
): string {
  if (
    event.evidence.rule !== "Blind Warning" &&
    event.evidence.rule !== "Blind While Stressed Critical"
  ) {
    return "";
  }
  const pollSeconds = policy?.source?.policy.pollIntervalSeconds;
  const checks = policy?.asset.policy.blindConsecutivePolls;
  return pollSeconds === undefined || checks === undefined
    ? ""
    : ` The alert fired after ${checks} checks in a row without a usable sell price (about ${durationWords(pollSeconds * checks)}).`;
}

function unknownSellPriceExplanation(
  event: PegAlertEvent,
  policy: ExactPolicyContext | null,
): string {
  const recovered = event.severity === "cleared";
  const source = event.evidence.sourceName;
  const opening = recovered
    ? `The monitor can calculate a current ${source} sell price again.`
    : `The monitor could not calculate a current ${source} sell price for the monitored amount.`;
  const causeGap =
    event.evidence.failureReason === 18
      ? " The monitor did not classify the cause."
      : " The exact cause was not recorded.";
  return `${opening}${blindThresholdSentence(event, policy)}${pendingSentence(event)}${causeGap}`;
}

function stalePriceExplanation(
  event: PegAlertEvent,
  policy: ExactPolicyContext | null,
): string {
  const source = event.evidence.sourceName;
  const market = marketName(event);
  const staleAfter = policy?.source?.policy.staleAfterSeconds;
  const blindThreshold = blindThresholdSentence(event, policy);
  if (event.severity === "cleared") {
    const wait = event.evidence.pendingSeconds;
    return `A fresh ${source} ${market} price arrived, so the alert cleared.${blindThreshold}${
      wait === null || wait <= 0
        ? ""
        : ` The data had remained too old for ${durationWords(wait)} before the alert fired.`
    }`;
  }
  const age =
    staleAfter === undefined
      ? "older than the allowed age"
      : `more than ${durationWords(staleAfter)} old`;
  return `The latest ${source} ${market} price was ${age}.${blindThreshold}${pendingSentence(event, "the data remained too old")}`;
}

function sourceFailureExplanation(
  event: PegAlertEvent,
  policy: ExactPolicyContext | null,
): string {
  if (event.evidence.failureReason === 6) {
    return stalePriceExplanation(event, policy);
  }
  const source = event.evidence.sourceName;
  const market = marketName(event);
  const explanation =
    SOURCE_FAILURE_EXPLANATIONS[event.evidence.failureReason ?? 0];
  return explanation === undefined
    ? unknownSellPriceExplanation(event, policy)
    : `${explanation(source, market, event.severity === "cleared")}${blindThresholdSentence(event, policy)}${pendingSentence(event)}`;
}

type SourceFailureExplanation = (
  source: string,
  market: string,
  cleared: boolean,
) => string;

const SOURCE_FAILURE_EXPLANATIONS: Partial<
  Record<number, SourceFailureExplanation>
> = {
  1: (source) =>
    `HTTP 429 means ${source} received too many price requests in a short period.`,
  2: (source, market) =>
    `${source} returned an HTTP error instead of ${market} order-book data.`,
  3: (source) =>
    `${source} did not answer within the monitor's request time limit.`,
  4: (source) =>
    `The monitor could not establish a network connection to ${source}.`,
  5: (source, market) =>
    `${source} responded, but its response did not contain valid ${market} order-book data.`,
  7: (source, market) =>
    `${source} repeated an earlier ${market} price update, so the monitor did not treat it as new evidence.`,
  8: (source) =>
    `${source} did not have enough buy orders to price the full monitored sale.`,
  9: (source, market) =>
    `${source} reported that the ${market} market was halted.`,
  10: (source) =>
    `The monitor did not have a current exchange rate for converting the ${source} price into the peg currency.`,
  11: (source) =>
    `The monitor could not calculate the currency conversion for the ${source} price.`,
  16: () =>
    "The pool's trading limits did not provide the amount that the monitor must price.",
  17: (source, _market, cleared) =>
    cleared
      ? `The Peg monitor supports ${source} again.`
      : `The Peg monitor has no price adapter for ${source}.`,
  19: (source) =>
    `More than one independent failure prevented the monitor from calculating a current ${source} sell price.`,
  20: (source, market, cleared) =>
    cleared
      ? `${source} now reports that it lists the ${market} market.`
      : `${source} reported that it does not list the ${market} market.`,
};

function listingExplanation(
  event: PegAlertEvent,
  policy: ExactPolicyContext | null,
): string {
  const checks = policy?.source?.policy.listingAbsentConsecutiveChecks;
  if (event.severity === "cleared") {
    const originalWait =
      checks === undefined
        ? ""
        : ` The original alert fired after ${checks} consecutive listing checks reported the market missing.`;
    return `${event.evidence.sourceName} now reports that it lists the ${marketName(event)} market.${originalWait}${pendingSentence(event)}`;
  }
  const confirmation =
    checks === undefined
      ? ""
      : ` The monitor confirmed this across ${checks} consecutive listing checks.`;
  return `${event.evidence.sourceName} reported that it does not list the ${marketName(event)} market.${confirmation}${pendingSentence(event)}`;
}

function movementExplanation(
  event: PegAlertEvent,
  policy: ExactPolicyContext | null,
): string {
  const seconds =
    event.evidence.rule === "Deep-Venue Downside Critical"
      ? policy?.asset.policy.criticalSustainSeconds
      : policy?.asset.policy.warnSustainSeconds;
  const window =
    seconds === undefined
      ? ""
      : ` The rule evaluates new sell-price decisions across a ${durationWords(seconds)} window.`;
  return `The monitor uses the average price available when selling the monitored amount, not the midpoint between buy and sell prices.${window}${pendingSentence(event)}`;
}

type RuleExplanation = (
  event: PegAlertEvent,
  policy: ExactPolicyContext | null,
  monitoring: PegMonitoringResponse,
) => string;

const RULE_EXPLANATIONS: Record<PegAlertRuleKind, RuleExplanation> = {
  "Blind Warning": sourceFailureExplanation,
  "Blind While Stressed Critical": sourceFailureExplanation,
  "Source Permanently Dead": sourceFailureExplanation,
  "Source Unhealthy": sourceFailureExplanation,
  "Critical Path Unreachable": listingExplanation,
  "Registry Rot": listingExplanation,
  "Deep-Venue Downside Critical": movementExplanation,
  "Downside Warning": movementExplanation,
  "Premium Warning": movementExplanation,
  "Deep-Venue Spread Warning": (event) =>
    `The gap between the best available buy and sell prices exceeded the allowed spread.${pendingSentence(event)}`,
  "Structural Saturation Warning": (event) =>
    `Pool flow stayed close to the trading limit.${pendingSentence(event)}`,
  "Heartbeat Missing": (event, policy) => {
    const freshness = policy?.asset.policy.freshnessGraceSeconds;
    const condition =
      freshness === undefined
        ? "The Peg monitor did not complete a new poll within its allowed delay."
        : `The Peg monitor did not complete a new poll within ${durationWords(freshness)}.`;
    return `${condition}${pendingSentence(event)}`;
  },
  "Indexed Pool Unreachable": (event) =>
    `The monitor could not verify the indexed pool that supplies trading-limit and flow data. Current market prices remain separate.${pendingSentence(event)}`,
  "Policy Rollover Stuck": (event, _policy, monitoring) =>
    `${
      event.evidence.policyVersion === monitoring.approvedActivePolicyVersion
        ? `The Peg monitor did not load the approved policy within ${durationWords(monitoring.rolloverAckExpectedSeconds)}.`
        : "The Peg monitor did not load the approved policy within the allowed time."
    }${pendingSentence(event)}`,
  Unknown: (event) =>
    `The alert history did not contain a recognized Peg rule or a precise cause.${pendingSentence(event)}`,
};

export function pegAlertExplanation(
  event: PegAlertEvent,
  monitoring: PegMonitoringResponse,
): string {
  const policy = exactPolicyContext(event, monitoring);
  return RULE_EXPLANATIONS[event.evidence.rule](event, policy, monitoring);
}
