import { PEG_POLICY_AUTH_MODE, PEG_POLICY_URL } from "../config.js";
import {
  assertPegPolicyRegistrySupportsPolicy,
  PegPolicyCompatibilityError,
} from "./compatibility.js";
import { pegCounters } from "./metrics.js";
import {
  GcpMetadataBearerTokenProvider,
  parsePinnedGcsJsonMediaUrl,
} from "./gcp-metadata-auth.js";
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
  policyAuthMode?: string | null;
  /**
   * Permit an unauthenticated HTTPS artifact for deliberate local or test use.
   * Environment configuration cannot enable this code-only guard.
   */
  allowUnauthenticatedPolicy?: boolean;
  loadRegistry?: () => Promise<PegRegistry>;
  policyStore?: PegPolicyStore;
  policyClientOptions?: PegPolicyClientOptions;
  poller?: PegPoller;
  onError?: (event: PegRuntimeErrorEvent) => void;
}

type PolicyUrlResult =
  | { status: "dormant"; url: null; authMode: null; error: null }
  | { status: "misconfigured"; url: null; authMode: null; error: Error }
  | {
      status: "waiting";
      url: URL;
      authMode: "none" | "gcp-metadata";
      error: null;
    };

function misconfiguredPolicy(message: string): PolicyUrlResult {
  return {
    status: "misconfigured",
    url: null,
    authMode: null,
    error: new Error(message),
  };
}

function parsePolicyAuthMode(
  raw: string | null,
): "none" | "gcp-metadata" | null {
  return raw === "none" || raw === "gcp-metadata" ? raw : null;
}

function parseUnauthenticatedPolicyUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    url.href !== raw ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error("invalid local policy URL");
  }
  return url;
}

interface ConfiguredPolicy {
  rawUrl: string;
  authMode: "none" | "gcp-metadata";
}

function configuredPolicy(
  raw: string | null,
  rawAuthMode: string | null,
  allowUnauthenticatedPolicy: boolean,
  hasBearerTokenProvider: boolean,
): ConfiguredPolicy {
  if (raw === null) {
    throw new Error(
      "PEG_POLICY_URL and PEG_POLICY_AUTH_MODE must be configured together",
    );
  }
  if (raw.length === 0 || raw.length > 2_048) {
    throw new Error("PEG_POLICY_URL must contain a bounded HTTPS URL");
  }
  const authMode = parsePolicyAuthMode(rawAuthMode);
  if (authMode === null) {
    throw new Error(
      "PEG_POLICY_URL and PEG_POLICY_AUTH_MODE must be configured together with a supported mode",
    );
  }
  if (authMode === "none" && !allowUnauthenticatedPolicy) {
    throw new Error(
      "PEG_POLICY_AUTH_MODE=none requires an explicit code-level local or test opt-in",
    );
  }
  if (authMode === "none" && hasBearerTokenProvider) {
    throw new Error(
      "PEG_POLICY_AUTH_MODE=none cannot use a bearer token provider",
    );
  }
  return { rawUrl: raw, authMode };
}

function parseConfiguredPolicyUrl(configured: ConfiguredPolicy): URL {
  try {
    return configured.authMode === "gcp-metadata"
      ? parsePinnedGcsJsonMediaUrl(configured.rawUrl)
      : parseUnauthenticatedPolicyUrl(configured.rawUrl);
  } catch {
    throw new Error(
      configured.authMode === "gcp-metadata"
        ? "PEG_POLICY_URL must be an exact generation-pinned GCS JSON media URL"
        : "PEG_POLICY_URL must be a canonical HTTPS URL without credentials or a fragment",
    );
  }
}

function parsePolicyUrl(
  raw: string | null,
  rawAuthMode: string | null,
  allowUnauthenticatedPolicy: boolean,
  hasBearerTokenProvider: boolean,
): PolicyUrlResult {
  if (raw === null && rawAuthMode === null) {
    return {
      status: "dormant",
      url: null,
      authMode: null,
      error: null,
    };
  }
  try {
    const configured = configuredPolicy(
      raw,
      rawAuthMode,
      allowUnauthenticatedPolicy,
      hasBearerTokenProvider,
    );
    return {
      status: "waiting",
      url: parseConfiguredPolicyUrl(configured),
      authMode: configured.authMode,
      error: null,
    };
  } catch (error) {
    return misconfiguredPolicy(
      error instanceof Error
        ? error.message
        : "invalid Peg policy configuration",
    );
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
      await this.options.poller.pollCycle({
        registry,
        policies,
        approvedActivePolicyVersion: bundle.active.version,
        retainedPreviousPolicyVersion: bundle.previous?.version ?? null,
      });
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

function configuredValue<T>(provided: T | undefined, fallback: T): T {
  return provided === undefined ? fallback : provided;
}

function withConfiguredPolicyAuth(
  policyUrl: PolicyUrlResult,
  configured: PegPolicyClientOptions | undefined,
): PegPolicyClientOptions | undefined {
  if (
    policyUrl.status === "waiting" &&
    policyUrl.authMode === "gcp-metadata" &&
    configured?.bearerTokenProvider === undefined
  ) {
    return {
      ...configured,
      bearerTokenProvider: new GcpMetadataBearerTokenProvider({
        ...(configured?.fetch === undefined ? {} : { fetch: configured.fetch }),
      }),
    };
  }
  return configured;
}

export function createPegRuntime(options: PegRuntimeOptions = {}): PegRuntime {
  const configuredUrl = configuredValue(
    options.policyUrl,
    PEG_POLICY_URL ?? null,
  );
  const configuredAuthMode = configuredValue(
    options.policyAuthMode,
    PEG_POLICY_AUTH_MODE ?? null,
  );
  const policyUrl = parsePolicyUrl(
    configuredUrl,
    configuredAuthMode,
    options.allowUnauthenticatedPolicy === true,
    options.policyClientOptions?.bearerTokenProvider !== undefined,
  );
  const report = safeReporter(options.onError ?? defaultErrorReporter);
  const poller = options.poller ?? createPegPoller({ onError: report });
  return new DefaultPegRuntime({
    policyUrl,
    loadRegistry: options.loadRegistry ?? loadPegRegistry,
    policyStore: options.policyStore ?? new PegPolicyStore(),
    policyClientOptions: withConfiguredPolicyAuth(
      policyUrl,
      options.policyClientOptions,
    ),
    poller,
    report,
  });
}

export function startPegPolling(runtime = createPegRuntime()): PegRuntime {
  if (runtime.status === "dormant") {
    console.log(
      "metrics-bridge peg polling dormant: PEG_POLICY_URL and PEG_POLICY_AUTH_MODE are not provisioned",
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
