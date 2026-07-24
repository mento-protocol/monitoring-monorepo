import { PEG_POLICY_URL } from "../config.js";
import {
  assertPegPolicyRegistrySupportsPolicy,
  PegPolicyCompatibilityError,
} from "./compatibility.js";
import { pegCounters } from "./metrics.js";
import {
  PegPolicyStore,
  type PegPolicyClientOptions,
} from "./policy-client.js";
import {
  createPegPoller,
  type PegPollErrorEvent,
  type PegPollCyclePolicies,
  type PegPoller,
} from "./poller.js";
import type { PegPolicyBundle, PegPolicyVersion } from "./policy.js";
import { loadPegRegistry, type PegRegistry } from "./registry.js";

export const PEG_LOOP_INTERVAL_MS = 15_000;

export const PEG_RUNTIME_ERROR_KINDS = [
  "policy_config",
  "policy_fetch",
  "policy_compatibility",
  "registry_load",
  "poller_cycle",
] as const;

export type PegRuntimeErrorKind = (typeof PEG_RUNTIME_ERROR_KINDS)[number];

export type PegRuntimeErrorEvent =
  | PegPollErrorEvent
  | {
      kind: PegRuntimeErrorKind;
      asset: null;
      source: null;
      monitorIndex: null;
      cause: unknown;
    };

export type PegRuntimeStatus =
  | "dormant"
  | "misconfigured"
  | "waiting"
  | "active";

export interface PegRuntime {
  readonly status: PegRuntimeStatus;
  runCycle(): Promise<void>;
}

export interface PegRuntimeOptions {
  policyUrl?: string | null;
  loadRegistry?: () => Promise<PegRegistry>;
  policyStore?: PegPolicyStore;
  policyClientOptions?: PegPolicyClientOptions;
  poller?: PegPoller;
  onError?: (event: PegRuntimeErrorEvent) => void;
}

type PolicyUrlResult =
  | { status: "dormant"; url: null; error: null }
  | { status: "misconfigured"; url: null; error: Error }
  | { status: "waiting"; url: URL; error: null };

function parsePolicyUrl(raw: string | null): PolicyUrlResult {
  if (raw === null) return { status: "dormant", url: null, error: null };
  if (raw.length === 0 || raw.length > 2_048) {
    return {
      status: "misconfigured",
      url: null,
      error: new Error("PEG_POLICY_URL must contain a bounded HTTPS URL"),
    };
  }
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      throw new Error("invalid protected artifact URL");
    }
    return { status: "waiting", url, error: null };
  } catch {
    return {
      status: "misconfigured",
      url: null,
      error: new Error(
        "PEG_POLICY_URL must be an HTTPS URL without credentials or a fragment",
      ),
    };
  }
}

function runtimeError(
  kind: PegRuntimeErrorKind,
  cause: unknown,
): PegRuntimeErrorEvent {
  return { kind, cause, asset: null, source: null, monitorIndex: null };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function compatiblePolicy(
  registry: PegRegistry,
  policy: PegPolicyVersion,
  assertCompatibility: (
    registry: PegRegistry,
    policy: PegPolicyVersion,
  ) => void,
): PegPolicyCompatibilityError | null {
  try {
    assertCompatibility(registry, policy);
    return null;
  } catch (error) {
    if (error instanceof PegPolicyCompatibilityError) return error;
    throw error;
  }
}

function selectCompatiblePolicies(
  registry: PegRegistry,
  bundle: PegPolicyBundle,
): PegPollCyclePolicies {
  const activeError = compatiblePolicy(
    registry,
    bundle.active,
    assertPegPolicyRegistrySupportsPolicy,
  );
  const previousError =
    bundle.previous === null
      ? null
      : compatiblePolicy(
          registry,
          bundle.previous,
          assertPegPolicyRegistrySupportsPolicy,
        );

  if (
    activeError === null &&
    bundle.previous !== null &&
    previousError === null
  ) {
    return [bundle.active, bundle.previous];
  }
  if (bundle.previous === null) {
    if (activeError !== null) throw activeError;
    return [bundle.active];
  }
  if (activeError === null) throw previousError;
  if (previousError === null) {
    // Old replicas keep producing the retained version until their baked
    // registry can serve the active topology.
    return [bundle.previous];
  }
  throw activeError;
}

function defaultErrorReporter(event: PegRuntimeErrorEvent): void {
  pegCounters.pollErrors.inc({ kind: event.kind });
  const location = [
    event.asset === null ? null : `asset=${event.asset}`,
    event.source === null ? null : `source=${event.source}`,
    event.monitorIndex === null ? null : `monitor=${event.monitorIndex}`,
  ]
    .filter((value) => value !== null)
    .join(" ");
  console.error(
    `[PEG_POLL_${event.kind.toUpperCase()}]${location ? ` ${location}` : ""}: ${errorMessage(event.cause)}`,
  );
}

function safeReporter(
  callback: (event: PegRuntimeErrorEvent) => void,
): (event: PegRuntimeErrorEvent) => void {
  return (event) => {
    try {
      callback(event);
    } catch {
      // Observability failures cannot escape the isolated peg lifecycle.
    }
  };
}

interface DefaultPegRuntimeOptions {
  policyUrl: PolicyUrlResult;
  loadRegistry: () => Promise<PegRegistry>;
  policyStore: PegPolicyStore;
  policyClientOptions: PegPolicyClientOptions | undefined;
  poller: PegPoller;
  report: (event: PegRuntimeErrorEvent) => void;
}

class DefaultPegRuntime implements PegRuntime {
  #status: PegRuntimeStatus;
  #configurationReported = false;
  #registry: PegRegistry | null = null;

  constructor(private readonly options: DefaultPegRuntimeOptions) {
    this.#status = options.policyUrl.status;
  }

  get status(): PegRuntimeStatus {
    return this.#status;
  }

  async #resolveRegistry(): Promise<PegRegistry | null> {
    if (this.#registry !== null) return this.#registry;
    try {
      this.#registry = await this.options.loadRegistry();
      return this.#registry;
    } catch (error) {
      this.options.report(runtimeError("registry_load", error));
      return null;
    }
  }

  async #refreshPolicy(registry: PegRegistry): Promise<void> {
    if (this.options.policyUrl.url === null) return;
    try {
      await this.options.policyStore.refresh(
        this.options.policyUrl.url,
        this.options.policyClientOptions,
        (bundle) => {
          selectCompatiblePolicies(registry, bundle);
        },
      );
    } catch (error) {
      const kind =
        error instanceof PegPolicyCompatibilityError
          ? "policy_compatibility"
          : "policy_fetch";
      this.options.report(runtimeError(kind, error));
    }
  }

  async runCycle(): Promise<void> {
    if (this.options.policyUrl.status === "dormant") return;
    if (this.options.policyUrl.status === "misconfigured") {
      if (!this.#configurationReported) {
        this.options.report(
          runtimeError("policy_config", this.options.policyUrl.error),
        );
        this.#configurationReported = true;
      }
      return;
    }

    const registry = await this.#resolveRegistry();
    if (registry === null) {
      this.#status = "waiting";
      return;
    }
    await this.#refreshPolicy(registry);
    const bundle = this.options.policyStore.current;
    if (bundle === null) {
      this.#status = "waiting";
      return;
    }
    try {
      const policies = selectCompatiblePolicies(registry, bundle);
      await this.options.poller.pollCycle({ registry, policies });
      this.#status = "active";
    } catch (error) {
      const kind =
        error instanceof PegPolicyCompatibilityError
          ? "policy_compatibility"
          : "poller_cycle";
      this.options.report(runtimeError(kind, error));
      this.#status = "waiting";
    }
  }
}

export function createPegRuntime(options: PegRuntimeOptions = {}): PegRuntime {
  const configuredUrl =
    options.policyUrl === undefined
      ? (PEG_POLICY_URL ?? null)
      : options.policyUrl;
  const policyUrl = parsePolicyUrl(configuredUrl);
  const report = safeReporter(options.onError ?? defaultErrorReporter);
  const poller = options.poller ?? createPegPoller({ onError: report });
  return new DefaultPegRuntime({
    policyUrl,
    loadRegistry: options.loadRegistry ?? loadPegRegistry,
    policyStore: options.policyStore ?? new PegPolicyStore(),
    policyClientOptions: options.policyClientOptions,
    poller,
    report,
  });
}

export function startPegPolling(runtime = createPegRuntime()): PegRuntime {
  if (runtime.status === "dormant") {
    console.log(
      "metrics-bridge peg polling dormant: PEG_POLICY_URL is not provisioned",
    );
    return runtime;
  }

  const loop = async (): Promise<void> => {
    await runtime.runCycle();
    if (runtime.status !== "misconfigured") {
      setTimeout(() => void loop(), PEG_LOOP_INTERVAL_MS);
    }
  };
  void loop();
  return runtime;
}
