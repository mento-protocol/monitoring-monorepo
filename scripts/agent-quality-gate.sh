#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/agent-quality-gate.sh [--dry-run|--run] [--base <ref>] [--head <ref>] [--changed-paths-file <file>] [--allow-package-script-changes] [--fail-fast|--keep-going]

Maps changed paths to the local commands and PR checklists an agent should run
before opening or updating a PR. Defaults to dry-run.

Options:
  --dry-run      Print the mapped commands/checklists without running them.
  --run          Execute the mapped safe local commands.
  --base <ref>   Base ref for changed-path detection. Default: origin/main.
  --head <ref>   Head ref for changed-path detection. Default: HEAD.
  --changed-paths-file <file>
                 Read changed paths from a newline-delimited file instead of git.
  --allow-package-script-changes
                 With --run, acknowledge that changed package manifests may
                 alter lifecycle/package scripts before they execute.
  --fail-fast    With --run, stop after the first failed mapped command.
  --keep-going   With --run, continue after failures and report the total.
  -h, --help     Show this help.

Environment:
  AGENT_QUALITY_BASE  Override the default base ref.
  AGENT_QUALITY_HEAD  Override the default head ref.
  AGENT_QUALITY_ALLOW_PACKAGE_SCRIPT_CHANGES
                      Same acknowledgement as --allow-package-script-changes
                      when set to 1 or true.
  AGENT_QUALITY_FAIL_FAST
                      Same behavior as --fail-fast when set to 1 or true.
USAGE
}

mode="dry-run"
base_ref="${AGENT_QUALITY_BASE:-origin/main}"
head_ref="${AGENT_QUALITY_HEAD:-HEAD}"
changed_paths_input_file=""
allow_package_script_changes="${AGENT_QUALITY_ALLOW_PACKAGE_SCRIPT_CHANGES:-}"
fail_fast="${AGENT_QUALITY_FAIL_FAST:-false}"
if [[ -z "$allow_package_script_changes" ]]; then
  allow_package_script_changes="$(git config --bool --get agent.qualityGate.allowPackageScriptChanges 2>/dev/null || true)"
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      mode="dry-run"
      shift
      ;;
    --run)
      mode="run"
      shift
      ;;
    --base)
      base_ref="${2:-}"
      if [[ -z "$base_ref" ]]; then
        echo "error: --base requires a ref" >&2
        exit 2
      fi
      shift 2
      ;;
    --head)
      head_ref="${2:-}"
      if [[ -z "$head_ref" ]]; then
        echo "error: --head requires a ref" >&2
        exit 2
      fi
      shift 2
      ;;
    --changed-paths-file)
      changed_paths_input_file="${2:-}"
      if [[ -z "$changed_paths_input_file" ]]; then
        echo "error: --changed-paths-file requires a file path" >&2
        exit 2
      fi
      shift 2
      ;;
    --allow-package-script-changes)
      allow_package_script_changes="true"
      shift
      ;;
    --fail-fast)
      fail_fast="true"
      shift
      ;;
    --keep-going)
      fail_fast="false"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

# Use a repo-local scratch dir for tmpfiles so we don't depend on TMPDIR
# being writable — pre-push hooks fork off trunk's daemon, which may carry
# a TMPDIR that's outside a host sandbox's writable allowlist. Also export
# TMPDIR so mapped subprocesses (e.g. agent-quality-gate.test.sh's bare
# `mktemp -d`) inherit a writable scratch path instead of falling back to
# the system default (which sandboxed shells often cannot write to).
scratch_dir="$repo_root/.tmp/agent-quality-gate"
mkdir -p "$scratch_dir"
export TMPDIR="$scratch_dir"

# Trunk's pre-push hook callback runs the gate without a TTY and strips most
# env vars from the calling shell. Re-assert non-interactive markers so the
# mapped commands (e.g. pnpm install) take the CI codepath instead of asking
# for TTY confirmation.
export CI="${CI:-true}"

tmpfiles=()
cleanup_tmpfiles() {
  if [[ ${#tmpfiles[@]} -gt 0 ]]; then
    rm -f "${tmpfiles[@]+"${tmpfiles[@]}"}"
  fi
}
trap cleanup_tmpfiles EXIT

make_tmpfile() {
  local tmpfile
  tmpfile="$(mktemp "$scratch_dir/agentqg.XXXXXX")"
  tmpfiles+=("$tmpfile")
  echo "$tmpfile"
}

changed_paths_file="$(make_tmpfile)"

if [[ -n "$changed_paths_input_file" ]]; then
  if [[ ! -r "$changed_paths_input_file" ]]; then
    echo "error: changed paths file not found: ${changed_paths_input_file}" >&2
    exit 2
  fi
  sed '/^$/d' "$changed_paths_input_file" | sort -u > "$changed_paths_file"
else
  {
    if ! git diff --name-only --no-renames "${base_ref}...${head_ref}" 2>/dev/null; then
      git diff --name-only --no-renames "$base_ref" "$head_ref"
    fi

    if [[ "$head_ref" == "HEAD" ]]; then
      git diff --name-only --no-renames
      git diff --cached --name-only --no-renames
      # The scratch dir is created at line 110 *before* this collection runs.
      # In a repo where .tmp/ isn't gitignored (e.g. the fresh fixture repos
      # built by scripts/agent-quality-gate.test.sh), the gate's own tmpfiles
      # would otherwise be reported as untracked user changes and bleed into
      # downstream args (e.g. the docs-only `./tools/trunk check` builder).
      git ls-files --others --exclude-standard --exclude='.tmp/agent-quality-gate/'
    fi
  } | sed '/^$/d' | sort -u > "$changed_paths_file"
fi

if [[ ! -s "$changed_paths_file" ]]; then
  echo "No changed paths detected against ${base_ref}...${head_ref}."
  exit 0
fi

preflight_commands=()
codegen_commands=()
post_codegen_commands=()
quality_commands=()
checklists=()
surfaces=()
package_script_risk_changed=false

has_command() {
  local command="$1"
  shift
  local entry
  for entry in "$@"; do
    [[ "${entry%%|*}" == "$command" ]] && return 0
  done
  return 1
}

has_preflight_command() {
  local command="$1"
  has_command "$command" "${preflight_commands[@]+"${preflight_commands[@]}"}"
}

has_codegen_command() {
  local command="$1"
  has_command "$command" "${codegen_commands[@]+"${codegen_commands[@]}"}"
}

has_post_codegen_command() {
  local command="$1"
  has_command "$command" "${post_codegen_commands[@]+"${post_codegen_commands[@]}"}"
}

has_quality_command() {
  local command="$1"
  has_command "$command" "${quality_commands[@]+"${quality_commands[@]}"}"
}

add_preflight_command() {
  local command="$1"
  local reason="$2"
  if ! has_preflight_command "$command"; then
    preflight_commands+=("${command}|${reason}")
  fi
}

add_codegen_command() {
  local command="$1"
  local reason="$2"
  if ! has_codegen_command "$command"; then
    codegen_commands+=("${command}|${reason}")
  fi
}

add_post_codegen_command() {
  local command="$1"
  local reason="$2"
  if ! has_post_codegen_command "$command"; then
    post_codegen_commands+=("${command}|${reason}")
  fi
}

add_command() {
  local command="$1"
  local reason="$2"
  if ! has_quality_command "$command"; then
    quality_commands+=("${command}|${reason}")
  fi
}

prepend_command() {
  local command="$1"
  local reason="$2"
  if ! has_quality_command "$command"; then
    quality_commands=("${command}|${reason}" "${quality_commands[@]+"${quality_commands[@]}"}")
  fi
}

has_checklist() {
  local checklist="$1"
  local entry
  for entry in "${checklists[@]+"${checklists[@]}"}"; do
    if [[ "${entry%%|*}" == "$checklist" ]]; then
      return 0
    fi
  done
  return 1
}

add_checklist() {
  local checklist="$1"
  local reason="$2"
  if ! has_checklist "$checklist"; then
    checklists+=("${checklist}|${reason}")
  fi
}

has_surface() {
  local surface="$1"
  local entry
  for entry in "${surfaces[@]+"${surfaces[@]}"}"; do
    if [[ "$entry" == "$surface" ]]; then
      return 0
    fi
  done
  return 1
}

add_surface() {
  local surface="$1"
  if ! has_surface "$surface"; then
    surfaces+=("$surface")
  fi
}

quote_path() {
  printf "%q" "$1"
}

json_change_paths() {
  local path="$1"
  local base_file
  local head_file
  base_file="$(make_tmpfile)"
  head_file="$(make_tmpfile)"

  if ! git show "${base_ref}:${path}" > "$base_file" 2>/dev/null; then
    rm -f "$base_file" "$head_file"
    echo "__unknown__"
    return
  fi

  if [[ "$head_ref" == "HEAD" && -f "$path" ]]; then
    cp "$path" "$head_file"
  elif ! git show "${head_ref}:${path}" > "$head_file" 2>/dev/null; then
    rm -f "$base_file" "$head_file"
    echo "__unknown__"
    return
  fi

  node - "$base_file" "$head_file" <<'NODE'
const fs = require("fs");

const [, , basePath, headPath] = process.argv;

const escapePointer = (part) =>
  part.replace(/~/g, "~0").replace(/\//g, "~1");

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sameScalar = (a, b) => Object.is(a, b);

const changes = [];

function walk(a, b, path) {
  if (sameScalar(a, b)) return;

  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of [...keys].sort()) {
      walk(a[key], b[key], `${path}/${escapePointer(key)}`);
    }
    return;
  }

  if (JSON.stringify(a) !== JSON.stringify(b)) {
    changes.push(path || "/");
  }
}

try {
  const baseJson = JSON.parse(fs.readFileSync(basePath, "utf8"));
  const headJson = JSON.parse(fs.readFileSync(headPath, "utf8"));
  walk(baseJson, headJson, "");
  for (const change of changes) console.log(change);
} catch {
  console.log("__unknown__");
}
NODE
  rm -f "$base_file" "$head_file"
}

classify_root_package_json_changes() {
  local change
  local saw_change=false
  local saw_agent_gate_script=false
  local saw_non_agent_script=false
  local saw_non_script=false

  while IFS= read -r change; do
    [[ -n "$change" ]] || continue
    saw_change=true
    case "$change" in
      "__unknown__")
        echo "workspace"
        return
        ;;
      /scripts/agent:quality-gate|/scripts/agent:quality-gate:test)
        saw_agent_gate_script=true
        ;;
      /scripts)
        saw_non_agent_script=true
        ;;
      /scripts/*)
        saw_non_agent_script=true
        ;;
      *)
        saw_non_script=true
        ;;
    esac
  done < <(json_change_paths "package.json")

  if [[ "$saw_change" != true ]]; then
    echo "workspace"
  elif [[ "$saw_agent_gate_script" == true && "$saw_non_agent_script" != true && "$saw_non_script" != true ]]; then
    echo "agent-quality-gate-scripts"
  elif [[ "$saw_agent_gate_script" == true || "$saw_non_agent_script" == true ]]; then
    echo "package-scripts"
  else
    echo "workspace"
  fi
}

root_package_json_class=""
get_root_package_json_class() {
  if [[ -z "$root_package_json_class" ]]; then
    root_package_json_class="$(classify_root_package_json_changes)"
  fi
  echo "$root_package_json_class"
}

add_package_quality_commands() {
  local package_name="$1"
  local reason="$2"
  add_command "pnpm --filter ${package_name} lint" "$reason"
  add_command "pnpm --filter ${package_name} typecheck" "$reason"
  if [[ "$package_name" == "@mento-protocol/indexer-envio" ]]; then
    add_command "pnpm --filter ${package_name} typecheck:strict" "$reason"
  fi
  add_command "pnpm --filter ${package_name} test" "$reason"
  add_command "pnpm --filter ${package_name} knip" "$reason (knip: unused files/deps/exports)"
  add_command "pnpm code-health:deps" "$reason (dep-cruiser: cross-package boundaries + cycles)"
}

add_dashboard_quality_commands() {
  local reason="$1"
  add_package_quality_commands "@mento-protocol/ui-dashboard" "$reason"
  add_command "pnpm --filter @mento-protocol/ui-dashboard exec playwright install chromium" "$reason"
  add_command "pnpm --filter @mento-protocol/ui-dashboard test:browser" "$reason"
}

add_ui_react_doctor_full_score() {
  local reason="$1"
  add_command "bash scripts/check-react-doctor-score.sh" "$reason"
}

add_ui_react_doctor_diff() {
  local reason="$1"
  add_command "bash scripts/check-react-doctor-diff.sh $(quote_path "$base_ref")" "$reason"
}

add_ui_mutation_baseline() {
  local reason="$1"
  add_command "pnpm dashboard:mutation" "$reason"
}

add_bridge_mutation_baseline() {
  local reason="$1"
  add_command "pnpm bridge:mutation" "$reason"
}

add_indexer_mutation_baseline() {
  local reason="$1"
  add_command "pnpm indexer:mutation" "$reason"
}

add_workspace_quality_commands() {
  local reason="$1"
  add_all_indexer_codegen "$reason"
  add_dashboard_quality_commands "$reason"
  add_ui_react_doctor_full_score "$reason"
  add_package_quality_commands "@mento-protocol/indexer-envio" "$reason"
  add_package_quality_commands "@mento-protocol/metrics-bridge" "$reason"
  add_package_quality_commands "@mento-protocol/monitoring-config" "$reason"
}

add_agent_quality_gate_package_script_checks() {
  local reason="$1"
  add_command "bash scripts/check-agent-quality-gate-package-scripts.sh" "$reason"
  add_command "bash scripts/agent-quality-gate.test.sh" "$reason"
}

add_indexer_post_codegen_install() {
  add_post_codegen_command "pnpm install --frozen-lockfile" "link generated package after indexer codegen"
}

add_indexer_mainnet_codegen() {
  local reason="$1"
  add_codegen_command "pnpm indexer:codegen" "$reason"
  add_indexer_post_codegen_install
}

add_indexer_testnet_codegen() {
  local reason="$1"
  add_codegen_command "pnpm indexer:testnet:codegen" "$reason"
  add_indexer_post_codegen_install
}

add_indexer_bridge_codegen() {
  local reason="$1"
  add_codegen_command "pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen" "$reason"
  add_indexer_post_codegen_install
}

add_all_indexer_codegen() {
  local reason="$1"
  add_indexer_bridge_codegen "$reason"
  add_indexer_testnet_codegen "$reason"
  add_indexer_mainnet_codegen "$reason"
}

add_bridge_codegen_then_restore_mainnet() {
  local bridge_reason="$1"
  add_indexer_bridge_codegen "$bridge_reason"
  add_indexer_mainnet_codegen "restore full multichain generated package after non-mainnet codegen"
}

add_terraform_validate_commands() {
  local module="$1"
  local reason="$2"
  add_command "terraform -chdir=${module} fmt -check -recursive" "$reason"
  add_command "terraform -chdir=${module} init -backend=false -input=false" "$reason"
  add_command "terraform -chdir=${module} validate -no-color" "$reason"
}

docs_targeted_trunk_command() {
  local path
  local args=()
  while IFS= read -r path; do
    [[ -e "$path" ]] || return 1
    args+=("$(quote_path "$path")")
  done < "$changed_paths_file"

  [[ ${#args[@]} -gt 0 ]] || return 1
  printf './tools/trunk check %s' "${args[*]}"
}

add_trunk_check_command() {
  if [[ ${#surfaces[@]} -eq 1 && "${surfaces[0]}" == "docs" ]]; then
    local trunk_command
    if trunk_command="$(docs_targeted_trunk_command)"; then
      prepend_command "$trunk_command" "docs-only changes should pass targeted Trunk checks"
    else
      prepend_command "./tools/trunk check --all" "docs-only changes include deleted paths; full Trunk avoids missing-path failures"
    fi
  else
    prepend_command "./tools/trunk check --all" "changed files should pass the same full-repo Trunk scope as CI"
  fi
}

sort_codegen_commands() {
  local sorted=()
  local known_command
  local entry
  local is_known
  # Envio codegen variants all overwrite indexer-envio/generated. When multiple
  # variants are needed, keep mainnet last so package checks validate the normal
  # linked generated package; single-config changes still run only that config.
  local known_codegen_commands=(
    "pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen"
    "pnpm indexer:testnet:codegen"
    "pnpm indexer:codegen"
  )

  for known_command in "${known_codegen_commands[@]}"; do
    for entry in "${codegen_commands[@]+"${codegen_commands[@]}"}"; do
      if [[ "${entry%%|*}" == "$known_command" ]]; then
        sorted+=("$entry")
        break
      fi
    done
  done

  for entry in "${codegen_commands[@]+"${codegen_commands[@]}"}"; do
    is_known=false
    for known_command in "${known_codegen_commands[@]}"; do
      if [[ "${entry%%|*}" == "$known_command" ]]; then
        is_known=true
        break
      fi
    done
    if [[ "$is_known" == false ]]; then
      sorted+=("$entry")
    fi
  done

  codegen_commands=()
  for entry in "${sorted[@]+"${sorted[@]}"}"; do
    codegen_commands+=("$entry")
  done
}

while IFS= read -r path; do
  case "$path" in
    package.json)
      root_package_json_class="$(get_root_package_json_class)"
      case "$root_package_json_class" in
        agent-quality-gate-scripts)
          add_surface "tooling"
          add_agent_quality_gate_package_script_checks "root package agent quality gate script changed"
          ;;
        package-scripts)
          package_script_risk_changed=true
          add_surface "workspace"
          add_preflight_command "pnpm install --frozen-lockfile" "root package script changed"
          add_agent_quality_gate_package_script_checks "root package script changed"
          add_workspace_quality_commands "root package script changed"
          ;;
        *)
          package_script_risk_changed=true
          add_preflight_command "pnpm install --frozen-lockfile" "workspace package manifest changed"
          ;;
      esac
      ;;
    */package.json)
      package_script_risk_changed=true
      add_preflight_command "pnpm install --frozen-lockfile" "workspace package manifest changed"
      ;;
    pnpm-lock.yaml|pnpm-workspace.yaml)
      package_script_risk_changed=true
      ;;
    .npmrc|*/.npmrc|pnpmfile.cjs|.pnpmfile.cjs)
      package_script_risk_changed=true
      add_preflight_command "pnpm install --frozen-lockfile" "package manager config changed"
      add_surface "workspace"
      add_workspace_quality_commands "package manager config changed"
      ;;
  esac
  case "$path" in
    *.sh)
      add_surface "scripts"
      if [[ -f "$path" ]]; then
        add_command "bash -n $(quote_path "$path")" "shell script changed"
      fi
      ;;
  esac
  case "$path" in
    ui-dashboard/scripts/*.sh)
      add_surface "ui-dashboard"
      case "$path" in
        ui-dashboard/scripts/vercel-ignore-build.sh|ui-dashboard/scripts/vercel-ignore-build.test.sh)
          add_command "bash ui-dashboard/scripts/vercel-ignore-build.test.sh" "Vercel ignore build script changed"
          ;;
      esac
      ;;
    ui-dashboard/*)
      add_surface "ui-dashboard"
      add_dashboard_quality_commands "ui-dashboard changed"
      add_ui_react_doctor_diff "ui-dashboard client code should keep React Doctor clean"
      add_ui_react_doctor_full_score "ui-dashboard React Doctor score should stay 100"
      case "$path" in
        ui-dashboard/src/app/*|ui-dashboard/src/components/*|ui-dashboard/src/lib/graphql.ts|ui-dashboard/src/hooks/*|ui-dashboard/src/lib/queries.ts|ui-dashboard/src/lib/queries/*|ui-dashboard/src/lib/bridge-queries.ts|ui-dashboard/src/lib/bridge-flows/use-bridge-gql.ts|ui-dashboard/src/lib/gql-retry.ts|ui-dashboard/src/lib/fetch-all-networks.ts|ui-dashboard/src/lib/fetch-json.ts|ui-dashboard/src/lib/network-fetcher/*|ui-dashboard/src/lib/og-graphql-client.ts|ui-dashboard/src/lib/homepage-og.ts|ui-dashboard/src/lib/pool-og.ts|ui-dashboard/src/lib/bridge-flows-og.ts|ui-dashboard/src/lib/hasura-timeout.ts|ui-dashboard/src/lib/mento-address-discovery.ts)
          add_checklist "docs/pr-checklists/swr-polling-hasura.md" "Hasura/SWR/query path changed"
          ;;
      esac
      case "$path" in
        ui-dashboard/src/app/*|ui-dashboard/src/components/*|ui-dashboard/src/hooks/*|ui-dashboard/src/lib/*)
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "dashboard data or UI flow changed"
          ;;
      esac
      case "$path" in
        ui-dashboard/src/app/*/layout.tsx|ui-dashboard/src/app/*/page.tsx|ui-dashboard/src/app/*/_lib/*metadata*)
          add_checklist "docs/pr-checklists/dynamic-route-metadata.md" "dynamic route or metadata-adjacent file changed"
          ;;
      esac
      case "$path" in
        ui-dashboard/src/components/*|ui-dashboard/src/app/*/_components/*|ui-dashboard/src/lib/use-roving-*)
          add_checklist "docs/pr-checklists/keyboard-a11y-controlled-widgets.md" "controlled dashboard component changed"
          ;;
      esac
      case "$path" in
        ui-dashboard/stryker.config.mjs|ui-dashboard/vitest.mutation.config.ts|ui-dashboard/src/lib/weekend.ts|ui-dashboard/src/lib/pool-id.ts|ui-dashboard/src/lib/__tests__/weekend.test.ts|ui-dashboard/src/lib/__tests__/pool-id.test.ts)
          add_checklist "docs/pr-checklists/mutation-testing.md" "dashboard mutation baseline changed"
          add_ui_mutation_baseline "dashboard mutation baseline changed"
          ;;
      esac
      ;;
    indexer-envio/*)
      add_surface "indexer-envio"
      case "$path" in
        indexer-envio/schema.graphql|indexer-envio/abis/*|indexer-envio/scripts/run-envio-with-env.mjs|indexer-envio/package.json)
          add_all_indexer_codegen "indexer schema/source/ABI/package path changed"
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "indexer data flow changed"
          ;;
        indexer-envio/src/EventHandlersBridgeOnly.ts)
          add_bridge_codegen_then_restore_mainnet "bridge handler registration path changed"
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "indexer data flow changed"
          ;;
        indexer-envio/src/handlers/wormhole/*)
          add_bridge_codegen_then_restore_mainnet "bridge handler registration path changed"
          add_indexer_testnet_codegen "indexer handler registration path changed"
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "indexer data flow changed"
          ;;
        indexer-envio/src/EventHandlers.ts|indexer-envio/src/handlers/*)
          add_indexer_testnet_codegen "indexer handler registration path changed"
          add_indexer_mainnet_codegen "indexer handler registration path changed"
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "indexer data flow changed"
          ;;
        indexer-envio/src/*)
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "indexer data flow changed"
          ;;
      esac
      case "$path" in
        indexer-envio/config/*.json)
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "indexer config data flow changed"
          ;;
      esac
      case "$path" in
        indexer-envio/config.multichain.mainnet.yaml)
          add_indexer_mainnet_codegen "mainnet indexer config changed"
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "indexer data flow changed"
          ;;
        indexer-envio/config.multichain.testnet.yaml)
          add_indexer_testnet_codegen "testnet indexer config changed"
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "indexer data flow changed"
          ;;
        indexer-envio/config.multichain.bridge-only.yaml)
          add_bridge_codegen_then_restore_mainnet "bridge-only indexer config changed"
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "indexer data flow changed"
          ;;
      esac
      case "$path" in
        indexer-envio/stryker.config.mjs|indexer-envio/vitest.mutation.config.ts|indexer-envio/src/helpers.ts|indexer-envio/src/tradingLimits.ts|indexer-envio/test/code-quality-invariants.test.ts|indexer-envio/test/pool-helpers.test.ts|indexer-envio/test/tradingLimits.test.ts)
          add_checklist "docs/pr-checklists/mutation-testing.md" "indexer mutation baseline changed"
          add_indexer_mutation_baseline "indexer mutation baseline changed"
          ;;
      esac
      add_package_quality_commands "@mento-protocol/indexer-envio" "indexer-envio changed"
      ;;
    metrics-bridge/*)
      add_surface "metrics-bridge"
      case "$path" in
        metrics-bridge/src/*)
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "metrics bridge data flow changed"
          add_checklist "docs/pr-checklists/terraform-cloudrun.md" "metrics bridge Cloud Run runtime changed"
          ;;
      esac
      case "$path" in
        metrics-bridge/Dockerfile|metrics-bridge/.dockerignore)
          add_checklist "docs/pr-checklists/terraform-cloudrun.md" "metrics bridge Cloud Run runtime changed"
          ;;
      esac
      case "$path" in
        metrics-bridge/stryker.config.mjs|metrics-bridge/vitest.mutation.config.ts|metrics-bridge/src/rebalance-probe.ts|metrics-bridge/test/rebalance-probe.test.ts)
          add_checklist "docs/pr-checklists/mutation-testing.md" "metrics bridge mutation baseline changed"
          add_bridge_mutation_baseline "metrics bridge mutation baseline changed"
          ;;
      esac
      add_package_quality_commands "@mento-protocol/metrics-bridge" "metrics-bridge changed"
      ;;
    shared-config/*)
      add_surface "shared-config"
      add_package_quality_commands "@mento-protocol/monitoring-config" "shared-config changed"
      add_command "pnpm --filter @mento-protocol/monitoring-config build" "shared-config exports changed"
      add_command "pnpm --filter @mento-protocol/ui-dashboard typecheck" "shared-config consumers should typecheck"
      add_command "pnpm --filter @mento-protocol/metrics-bridge typecheck" "shared-config consumers should typecheck"
      case "$path" in
        shared-config/deployment-namespaces.json|shared-config/fx-calendar.json)
          add_all_indexer_codegen "shared-config vendored indexer fixture changed"
          add_package_quality_commands "@mento-protocol/indexer-envio" "shared-config vendored indexer fixture changed"
          ;;
      esac
      ;;
	    .github/workflows/*|.github/actions/*)
	      add_surface "github-workflows"
	      add_checklist "docs/pr-checklists/ci-workflow-gates.md" "GitHub Actions workflow/action changed"
	      case "$path" in
        .github/workflows/ci.yml)
          add_surface "workspace"
          add_preflight_command "pnpm install --frozen-lockfile" "central CI workflow changed"
          add_workspace_quality_commands "central CI workflow changed"
          ;;
        .github/workflows/metrics-bridge.yml)
          add_checklist "docs/pr-checklists/terraform-cloudrun.md" "metrics bridge Cloud Run workflow changed"
          ;;
        .github/actions/pnpm-install/*)
          add_surface "workspace"
          add_preflight_command "pnpm install --frozen-lockfile" "pnpm install action changed"
          add_workspace_quality_commands "pnpm install action changed"
          ;;
	      esac
	      ;;
	    .trunk/*)
	      add_surface "tooling"
	      add_command "pnpm agent:quality-gate:test" "agent quality gate trunk hook changed"
	      ;;
	    terraform/*)
	      add_surface "terraform"
	      add_terraform_validate_commands "terraform" "Terraform changed"
      add_terraform_validate_commands "terraform/alerts" "Terraform changed"
      add_checklist "docs/pr-checklists/terraform-cloudrun.md" "Terraform/Cloud Run path changed"
      ;;
    cloudbuild.yaml)
      add_surface "cloudbuild"
      add_checklist "docs/pr-checklists/terraform-cloudrun.md" "Cloud Build config changed"
      add_package_quality_commands "@mento-protocol/metrics-bridge" "metrics bridge build context changed"
      ;;
    .gcloudignore)
      add_surface "cloudbuild"
      add_checklist "docs/pr-checklists/terraform-cloudrun.md" "Cloud Build ignore file changed"
      add_package_quality_commands "@mento-protocol/metrics-bridge" "metrics bridge build context changed"
      ;;
    docs/*|README.md|AGENTS.md|*/AGENTS.md|BACKLOG.md)
      add_surface "docs"
      ;;
    scripts/*.sh)
      add_surface "scripts"
      case "$path" in
        scripts/check-agent-quality-gate-package-scripts.sh)
          add_command "bash scripts/check-agent-quality-gate-package-scripts.sh" "agent quality gate package script validator changed"
          add_command "pnpm agent:quality-gate:test" "agent quality gate mapping changed"
          ;;
        scripts/agent-quality-gate.sh|scripts/agent-quality-gate.test.sh|scripts/check-react-doctor-diff.sh|scripts/check-react-doctor-score.sh)
          add_command "pnpm agent:quality-gate:test" "agent quality gate mapping changed"
          ;;
        scripts/deploy-bridge.sh)
          add_checklist "docs/pr-checklists/terraform-cloudrun.md" "Cloud Run deploy script changed"
          ;;
      esac
      ;;
    scripts/*|tools/*)
      add_surface "scripts"
      ;;
    package.json)
      root_package_json_class="$(get_root_package_json_class)"
      case "$root_package_json_class" in
        agent-quality-gate-scripts)
          ;;
        package-scripts)
          ;;
        *)
          add_surface "workspace"
          add_preflight_command "pnpm install --frozen-lockfile" "workspace dependency/config changed"
          add_command "bash scripts/agent-quality-gate.test.sh" "agent quality gate package script changed"
          add_workspace_quality_commands "workspace dependency/config changed"
          ;;
      esac
      ;;
    pnpm-lock.yaml|pnpm-workspace.yaml)
      add_surface "workspace"
      add_preflight_command "pnpm install --frozen-lockfile" "workspace dependency/config changed"
      add_workspace_quality_commands "workspace dependency/config changed"
      ;;
    .node-version)
      add_surface "workspace"
      add_preflight_command "pnpm install --frozen-lockfile" "Node version changed"
      add_workspace_quality_commands "Node version changed"
      ;;
  esac
done < "$changed_paths_file"

add_trunk_check_command
sort_codegen_commands

echo "Agent quality gate"
echo
echo "Base: ${base_ref}"
echo "Head: ${head_ref}"
echo "Mode: ${mode}"
echo
echo "Changed paths:"
sed 's/^/- /' "$changed_paths_file"
echo

if [[ ${#surfaces[@]} -gt 0 ]]; then
  echo "Detected surfaces:"
  for surface in "${surfaces[@]+"${surfaces[@]}"}"; do
    echo "- ${surface}"
  done
  echo
fi

if [[ ${#checklists[@]} -gt 0 ]]; then
  echo "Required checklist review:"
  for entry in "${checklists[@]+"${checklists[@]}"}"; do
    echo "- ${entry%%|*} (${entry#*|})"
  done
  echo
fi

echo "Mapped safe local commands:"
for entry in "${preflight_commands[@]+"${preflight_commands[@]}"}"; do
  echo "- ${entry%%|*} (${entry#*|})"
done
for entry in "${codegen_commands[@]+"${codegen_commands[@]}"}"; do
  echo "- ${entry%%|*} (${entry#*|})"
done
for entry in "${post_codegen_commands[@]+"${post_codegen_commands[@]}"}"; do
  echo "- ${entry%%|*} (${entry#*|})"
done
for entry in "${quality_commands[@]+"${quality_commands[@]}"}"; do
  echo "- ${entry%%|*} (${entry#*|})"
done
echo

if [[ "$mode" == "dry-run" ]]; then
  echo "Dry run only. Re-run with --run to execute the mapped commands."
  exit 0
fi

if [[ "$package_script_risk_changed" == true && "$allow_package_script_changes" != "1" && "$allow_package_script_changes" != "true" ]]; then
  echo "Refusing to run because package manifests or lockfile changed." >&2
  echo "Review package scripts, lifecycle hooks, and dependency install scripts first, then re-run with --allow-package-script-changes if they are safe." >&2
  exit 2
fi

failures=0
command_summaries=()

format_duration() {
  local seconds="$1"
  local minutes
  local remainder

  if [[ "$seconds" -lt 60 ]]; then
    echo "${seconds}s"
    return
  fi

  minutes=$((seconds / 60))
  remainder=$((seconds % 60))
  echo "${minutes}m${remainder}s"
}

filter_expected_output() {
  local skip_expected_stack=false
  while IFS= read -r line; do
    if [[ "$line" =~ ^\[(RPC_FAILURE|RPC_FAILURE_BURST|CONTRACT_REVERT|CONTRACT_REVERT_BURST)\] ]]; then
      skip_expected_stack=false
      continue
    fi

    if [[ "$line" =~ ^\[(rebalance-check|address-labels|address-labels/[^]]+|address-reports|backup|minipay/tag|minipay/sync|arkham/enrich)\] ]]; then
      skip_expected_stack=true
      continue
    fi

    if [[ "$skip_expected_stack" == true ]]; then
      case "$line" in
        Error:*|TypeError:*|"    at "*)
          continue
          ;;
        "")
          skip_expected_stack=false
          continue
          ;;
      esac
      echo "$line"
      continue
    fi

    skip_expected_stack=false
    echo "$line"
  done
}

record_command_summary() {
  local status="$1"
  local elapsed="$2"
  local command="$3"
  command_summaries+=("${status}|${elapsed}|${command}")
}

print_command_summary() {
  local entry
  local status
  local elapsed
  local elapsed_and_command
  local command

  if [[ ${#command_summaries[@]} -eq 0 ]]; then
    return
  fi

  echo
  echo "Command elapsed-time summary:"
  for entry in "${command_summaries[@]+"${command_summaries[@]}"}"; do
    status="${entry%%|*}"
    elapsed_and_command="${entry#*|}"
    elapsed="${elapsed_and_command%%|*}"
    command="${elapsed_and_command#*|}"
    echo "- ${status} $(format_duration "$elapsed") ${command}"
  done
}

run_mapped_command() {
  local command="$1"
  local output_file
  local start_ts
  local end_ts
  local elapsed
  local exit_code

  output_file="$(make_tmpfile)"
  start_ts="$(date +%s)"
  echo
  echo "+ ${command}"
  set +e
  bash -c "$command" > "$output_file" 2>&1
  exit_code=$?
  set -e
  end_ts="$(date +%s)"
  elapsed=$((end_ts - start_ts))

  if [[ "$exit_code" -eq 0 ]]; then
    record_command_summary "ok" "$elapsed" "$command"
    echo "✓ ${command} ($(format_duration "$elapsed"))"
    rm -f "$output_file"
    return 0
  fi

  record_command_summary "fail" "$elapsed" "$command"
  echo "Command failed after $(format_duration "$elapsed"): ${command}" >&2
  filter_expected_output < "$output_file" >&2
  rm -f "$output_file"
  return "$exit_code"
}

for entry in "${preflight_commands[@]+"${preflight_commands[@]}"}" \
  "${codegen_commands[@]+"${codegen_commands[@]}"}" \
  "${post_codegen_commands[@]+"${post_codegen_commands[@]}"}" \
  "${quality_commands[@]+"${quality_commands[@]}"}"; do
  command="${entry%%|*}"
  if ! run_mapped_command "$command"; then
    failures=$((failures + 1))
    if [[ "$fail_fast" == "1" || "$fail_fast" == "true" ]]; then
      echo
      echo "Stopping after first failed mapped command (--fail-fast)." >&2
      print_command_summary
      exit 1
    fi
  fi
done

print_command_summary

if [[ "$failures" -gt 0 ]]; then
  echo
  echo "${failures} mapped command(s) failed." >&2
  exit 1
fi

echo
echo "All mapped commands passed."
