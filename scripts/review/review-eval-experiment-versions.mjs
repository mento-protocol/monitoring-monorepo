// Provider CLI versions for the non-ledger experiment lane: plan identity,
// per-phase provider sets, drift against a plan, and the change a stage sees
// while it runs.
//
// The contract module imports this one, so this module imports nothing from it.
// The two value guards below live here for that reason and the contract reads
// them from here rather than keeping a second copy.

import { spawnSync } from "node:child_process";

/** The live version of one provider CLI, probed once and never cached. */
export function providerVersion(name, env) {
  const result = spawnSync(name, ["--version"], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error || result.status !== 0 || !String(result.stdout).trim()) {
    throw new Error(
      `${name} version probe failed: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`,
    );
  }
  return String(result.stdout).trim();
}

export function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function nonempty(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function cliIdentity(cliVersions, identities) {
  const supplied = cliVersions ?? {
    claude: identities?.claude_cli,
    codex: identities?.codex_cli,
    judge: identities?.judge_cli,
  };
  const claude = nonempty(supplied?.claude, "cliVersions.claude");
  return {
    claude,
    codex: nonempty(supplied?.codex, "cliVersions.codex"),
    judge: nonempty(supplied?.judge ?? claude, "cliVersions.judge"),
  };
}

const CLI_PROVIDERS = Object.freeze(["claude", "codex", "judge"]);

/** Normalize probed or recorded provider versions into the plan identity. */
export function cliVersionIdentity(cliVersions, identities = null) {
  return cliIdentity(cliVersions, identities);
}

/**
 * Compare the versions a plan recorded with the versions probed now. A plan
 * keeps its recorded versions forever, so an upgrade mid-campaign is drift to
 * label, never a reason to refuse the plan.
 */
export function cliVersionDrift({ planned, live }) {
  if (live === null || live === undefined) return null;
  const recorded = cliVersionIdentity(planned);
  const current = cliVersionIdentity(live);
  const providers = CLI_PROVIDERS.filter(
    (provider) => recorded[provider] !== current[provider],
  ).map((provider) => ({
    provider,
    planned: recorded[provider],
    live: current[provider],
  }));
  if (providers.length === 0) return null;
  return {
    providers,
    planned: recorded,
    live: current,
    summary: providers
      .map((entry) => `${entry.provider} ${entry.planned} -> ${entry.live}`)
      .join(", "),
  };
}

/** The providers each cache phase can invoke, in the order it records them. */
const PHASE_PROVIDERS = Object.freeze({
  raw: Object.freeze(["claude", "codex"]),
  score: Object.freeze(["judge"]),
  novel: Object.freeze(["judge"]),
});

function phaseProviders(phase) {
  if (!Object.hasOwn(PHASE_PROVIDERS, phase)) {
    throw new Error(`unknown experiment cache phase ${JSON.stringify(phase)}`);
  }
  return PHASE_PROVIDERS[phase];
}

/**
 * Normalize one phase's provider set. Every key must name a provider that phase
 * can invoke and every value a non-empty version. An empty set is valid: it
 * says the phase reached its answer without calling a provider.
 */
export function normalizePhaseCliVersions(phase, versions, label) {
  if (!Object.hasOwn(PHASE_PROVIDERS, phase)) {
    throw new Error(
      `${label} names unknown cache phase ${JSON.stringify(phase)}`,
    );
  }
  const providers = PHASE_PROVIDERS[phase];
  if (!isObject(versions)) {
    throw new Error(`${label} ${phase} CLI versions must be an object`);
  }
  for (const [provider, version] of Object.entries(versions)) {
    if (!providers.includes(provider)) {
      throw new Error(
        `${label} names ${phase} provider ${JSON.stringify(provider)}, ` +
          "which that phase never invokes",
      );
    }
    nonempty(version, `${label} ${phase}.${provider}`);
  }
  return Object.fromEntries(
    providers
      .filter((provider) => Object.hasOwn(versions, provider))
      .map((provider) => [provider, versions[provider]]),
  );
}

/**
 * The providers one cache phase invokes, at the versions it invokes them at.
 * A frozen-report lane never spawns the finder, so `codex` belongs to a
 * live-finder raw phase alone; scoring and novelty classification are judge
 * calls only when they have something to send the judge. Pass
 * `invokesJudge: false` for the deterministic cases the caller short-circuits —
 * an empty reviewer transcript to score, a cell with no claims to classify — so
 * the phase records the empty provider set it actually used. These versions go
 * into the phase's cache identity and into the artifact it writes, so a phase
 * can never be attributed to a provider it did not run or to a version it did
 * not run under.
 */
export function phaseCliVersions({
  phase,
  cliVersions,
  source = null,
  invokesJudge = true,
}) {
  phaseProviders(phase);
  const live = cliVersionIdentity(cliVersions);
  if (phase === "raw") {
    return source?.kind === "live-finder"
      ? { claude: live.claude, codex: live.codex }
      : { claude: live.claude };
  }
  return invokesJudge === false ? {} : { judge: live.judge };
}

/**
 * The provider set one cache identity is keyed on.
 *
 * A cache identity carries the LIVE version of every provider its phase
 * invokes, exactly as the canonical lane's cell fingerprint does, so an
 * artifact produced under another runtime is never found, the cell reruns, and
 * no decision mixes two runtimes inside one phase. `phaseVersions` names the
 * exact set instead: a caller that already knows the versions — read back from
 * the artifact's own record, or computed once for the phase it is about to run
 * — passes them here, and a caller starting from a live probe passes
 * `cliVersions`.
 */
export function phaseVersionsFor(
  phase,
  { cliVersions, phaseVersions = null, source = null } = {},
) {
  return phaseVersions === null || phaseVersions === undefined
    ? phaseCliVersions({ phase, cliVersions, source })
    : normalizePhaseCliVersions(
        phase,
        phaseVersions,
        `${phase} cache identity`,
      );
}

/**
 * The provider CLIs one stage can invoke, and so the only ones worth probing
 * for a change while it runs. Every stage runs contestant and judge calls
 * through the Claude CLI. Only a stage with a `live-paired` finder lane spawns
 * Codex, so a Codex release during a frozen-report stage cannot have reached
 * any cell and must not be reported as a runtime change.
 */
export function stageProbeProviders(stagePlan) {
  const live = (stagePlan?.lanes ?? []).some(
    (lane) => lane?.source?.kind === "live-finder",
  );
  return live ? ["claude", "codex"] : ["claude"];
}

/**
 * The versions one record's own artifact stored for a phase. A later phase
 * rebuilds an earlier artifact's identity from these bytes rather than from the
 * live probe, so a judge upgrade between a screen and its holdout still finds
 * the screen scores instead of failing to match them.
 */
export function recordedPhaseCliVersions({ record, phase }) {
  const label = record?.cell_id ? `record ${record.cell_id}` : "record";
  const versions = record?.cli_versions?.[phase];
  if (versions === undefined || versions === null) {
    throw new Error(
      `${label} stores no ${phase} runtime provenance; re-run the cell`,
    );
  }
  return normalizePhaseCliVersions(phase, versions, label);
}

/**
 * Read the versions every record actually ran under out of the records
 * themselves, and name each transition away from the planned versions with the
 * cells it touched. Records carry what their artifacts stored, so a stage
 * retried later reports the runtime that produced each artifact rather than the
 * runtime of the retry. Pass every record the decision reads, including screen
 * records folded into a holdout decision.
 *
 * Broken provenance throws rather than being skipped. A record whose versions
 * cannot be read is a record whose drift cannot be reported, and skipping it
 * would present an unattributed upgrade as a clean run.
 */
export function recordRuntimeDrift({ planned, records }) {
  const recorded = cliVersionIdentity(planned);
  const transitions = new Map();
  for (const record of records ?? []) {
    const label = record?.cell_id ? `record ${record.cell_id}` : "record";
    if (!isObject(record?.cli_versions)) {
      throw new Error(`${label} stores no runtime provenance; re-run the cell`);
    }
    for (const [phaseName, stored] of Object.entries(record.cli_versions)) {
      const phase = normalizePhaseCliVersions(phaseName, stored, label);
      for (const [provider, version] of Object.entries(phase)) {
        if (version === recorded[provider]) continue;
        const key = `${provider}\u0000${version}`;
        if (!transitions.has(key)) {
          transitions.set(key, {
            provider,
            planned: recorded[provider],
            live: version,
            cells: new Set(),
          });
        }
        transitions.get(key).cells.add(record.cell_id);
      }
    }
  }
  if (transitions.size === 0) return null;
  const providers = [...transitions.values()]
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        left.live.localeCompare(right.live),
    )
    .map(({ cells, ...entry }) => ({ ...entry, cell_ids: [...cells].sort() }));
  return {
    providers,
    cell_ids: [...new Set(providers.flatMap((entry) => entry.cell_ids))].sort(),
    summary: providers
      .map((entry) => `${entry.provider} ${entry.planned} -> ${entry.live}`)
      .join(", "),
  };
}

/** One reason string naming each transition and the cells that ran under it. */
export function runtimeDriftReason(drift) {
  if (!isObject(drift) || !Array.isArray(drift.providers)) return null;
  if (drift.providers.length === 0) return null;
  const transitions = drift.providers.map((entry) => {
    const move = `${entry.provider} ${entry.planned} -> ${entry.live}`;
    const cells = [...new Set(entry.cell_ids ?? [])].sort();
    return cells.length === 0 ? move : `${move} on ${cells.join(", ")}`;
  });
  return `runtime drift: ${transitions.join("; ")}`;
}

/** One probe, read as the partial identity the probed providers imply. */
function probedIdentity(probe, label) {
  const identity = {};
  for (const [provider, version] of Object.entries(probe ?? {})) {
    if (!CLI_PROVIDERS.includes(provider)) {
      throw new Error(`${label} names unknown provider ${provider}`);
    }
    identity[provider] = nonempty(version, `${label}.${provider}`);
  }
  // The judge runs on the Claude CLI, so a Claude probe reports the judge too.
  if (identity.claude !== undefined && identity.judge === undefined) {
    identity.judge = identity.claude;
  }
  return identity;
}

/**
 * The providers whose live version moved between the probe that opened the
 * stage and a probe taken after its cells ran.
 *
 * Cells are keyed on the versions probed at stage start. A provider that
 * auto-updates while the stage runs therefore leaves the cells that ran after
 * the update recorded and keyed under the earlier version. Probing once per
 * artifact would not close that window — the probe still precedes the spawn —
 * and it would fragment the phase cache, so the stage reports the change over
 * the whole stage instead of attributing it to individual cells.
 *
 * Each probe carries only the providers the stage can invoke, and each is
 * compared with the stage-start versions rather than with the probe before it,
 * so an update that lands during scoring is still named when a second update
 * follows it.
 */
export function stageRuntimeChange(start, probed) {
  const baseline = cliVersionIdentity(start);
  const seen = new Map();
  for (const [index, live] of (probed ?? []).entries()) {
    const identity = probedIdentity(live, `stage probe ${index}`);
    for (const [provider, version] of Object.entries(identity)) {
      if (version === baseline[provider]) continue;
      seen.set(`${provider}\u0000${version}`, {
        provider,
        start: baseline[provider],
        end: version,
      });
    }
  }
  if (seen.size === 0) return null;
  const providers = [...seen.values()].sort(
    (left, right) =>
      left.provider.localeCompare(right.provider) ||
      left.end.localeCompare(right.end),
  );
  return {
    providers,
    summary: providers
      .map((entry) => `${entry.provider} ${entry.start} -> ${entry.end}`)
      .join(", "),
  };
}

/** One line naming a provider CLI that changed while one stage was running. */
export function stageRuntimeChangeReason(stage, change) {
  return (
    `runtime changed during the ${stage} stage: ${change.summary}; ` +
    "cells that ran after the change may have used the later version and " +
    "are keyed on the earlier one"
  );
}
