/**
 * Fixtures the gate-probe test modules share.
 *
 * `gateFixture`, `installedBashes` and `legacyFunctionSource` are used by both
 * the extraction tests and the runtime tests, so they sit here rather than in
 * either — the seam the module split did not have (GitHub issue #1803).
 */

import { spawnSync } from "node:child_process";
import {
  bashFunctionSource,
  GATE_CLASSIFIER,
} from "./check-sentry-suites-in-ci-probes.mjs";

// Re-exported so a test module importing fixtures need not also reach past them.
export { bashFunctionSource, GATE_CLASSIFIER };

export const TRUSTED_PATH = "/scripts/agent:quality-gate";
export const UNTRUSTED_PATH = "/scripts/__not_an_allowlisted_alias__";

/**
 * A synthetic agent-quality-gate.sh: a `json_change_paths` the probe stubs over,
 * one classifier with the real one's shape, and slots for the variations each
 * test needs. Built from one template so the difference under test is the only
 * difference in the file.
 */
export const gateFixture = ({
  prelude = "",
  header = `${GATE_CLASSIFIER}() {`,
  inner = "",
  verdict = `  if [[ "$saw_tooling" == true ]]; then
    echo "root-tooling-scripts"
  else
    echo "package-scripts"
  fi`,
  closer = "}",
  trailer = 'root_package_json_class=""',
}) => `#!/usr/bin/env bash
set -euo pipefail

json_change_paths() {
  echo "__unknown__"
}
${prelude}
${header}
  local change
  local saw_tooling=false
  while IFS= read -r change; do
    [[ -n "$change" ]] || continue
    case "$change" in
      ${TRUSTED_PATH}) saw_tooling=true ;;
    esac
  done < <(json_change_paths "package.json")
${inner}
${verdict}
${closer}

${trailer}
`;

/**
 * The terminator this probe used to use: the first line that is exactly `}` at
 * column 0. Kept here, in the test rather than the probe, so each fixture below
 * has to prove it actually discriminates — a fixture the old rule reads
 * correctly would pin nothing.
 */
export const legacyFunctionSource = (script) => {
  const header = `\n${GATE_CLASSIFIER}() {\n`;
  const start = script.indexOf(header);
  if (start < 0) return null;
  const rest = script.slice(start + 1);
  const end = rest.indexOf("\n}\n");
  return end > 0 ? rest.slice(0, end + 3) : null;
};

/**
 * Every distinct bash on this machine, by resolved path. macOS ships 3.2 at
 * /bin/bash and contributors usually have a newer one earlier on PATH, so this
 * finds both; a runner with one bash yields one entry and the test still runs.
 */
export const installedBashes = () => {
  const found = new Map();
  for (const candidate of ["bash", "/bin/bash"]) {
    const probe = spawnSync(
      candidate,
      [
        "-c",
        'printf "%s\\t%s.%s" "$BASH" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}"',
      ],
      { encoding: "utf8" },
    );
    if (probe.error || probe.status !== 0) continue;
    const [path, version] = probe.stdout.split("\t");
    if (!found.has(path)) found.set(path, { candidate, version });
  }
  return [...found.entries()];
};
