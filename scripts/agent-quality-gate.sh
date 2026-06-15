#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/agent-quality-gate.sh [--dry-run|--run] [--base <ref>] [--head <ref>] [--changed-paths-file <file>] [--allow-package-script-changes] [--fail-fast|--keep-going] [--skip-if-fresh] [--parallel <n>]

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
  --skip-if-fresh
                 With --run, skip execution when the previous successful run
                 used the same base, changed paths, command plan, gate
                 implementation, and validated file content. Intended for the
                 pre-push hook only.
  --parallel <n> With --run, execute independent quality commands with up to
                 n concurrent jobs. Default: auto, capped at 4. Fail-fast mode
                 stays sequential so it still stops before starting the next
                 mapped command.
  -h, --help     Show this help.

Environment:
  AGENT_QUALITY_BASE  Override the default base ref.
  AGENT_QUALITY_HEAD  Override the default head ref.
  AGENT_QUALITY_ALLOW_PACKAGE_SCRIPT_CHANGES
                      Same acknowledgement as --allow-package-script-changes
                      when set to 1 or true.
  AGENT_QUALITY_FAIL_FAST
                      Same behavior as --fail-fast when set to 1 or true.
  AGENT_QUALITY_PARALLELISM
                      Same behavior as --parallel. Use auto for the default.
USAGE
}

mode="dry-run"
base_ref="${AGENT_QUALITY_BASE:-origin/main}"
head_ref="${AGENT_QUALITY_HEAD:-HEAD}"
changed_paths_input_file=""
allow_package_script_changes="${AGENT_QUALITY_ALLOW_PACKAGE_SCRIPT_CHANGES:-}"
fail_fast="${AGENT_QUALITY_FAIL_FAST:-false}"
skip_if_fresh="${AGENT_QUALITY_SKIP_IF_FRESH:-false}"
quality_parallelism="${AGENT_QUALITY_PARALLELISM:-auto}"
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
    --skip-if-fresh)
      skip_if_fresh="true"
      shift
      ;;
    --parallel|--jobs)
      quality_parallelism="${2:-}"
      if [[ -z "$quality_parallelism" ]]; then
        echo "error: $1 requires a positive integer" >&2
        exit 2
      fi
      shift 2
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

auto_quality_parallelism() {
  local cpu_count
  cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)"
  if [[ ! "$cpu_count" =~ ^[0-9]+$ || "$cpu_count" -lt 1 ]]; then
    cpu_count="$(sysctl -n hw.ncpu 2>/dev/null || true)"
  fi
  if [[ ! "$cpu_count" =~ ^[0-9]+$ || "$cpu_count" -lt 1 ]]; then
    cpu_count=2
  fi
  if [[ "$cpu_count" -gt 4 ]]; then
    echo 4
  else
    echo "$cpu_count"
  fi
}

if [[ "$quality_parallelism" == "auto" ]]; then
  quality_parallelism="$(auto_quality_parallelism)"
fi

if [[ ! "$quality_parallelism" =~ ^[0-9]+$ || "$quality_parallelism" -lt 1 ]]; then
  echo "error: --parallel requires a positive integer" >&2
  exit 2
fi

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
success_stamp_file="$scratch_dir/last-success.stamp"
success_stamp_ttl_seconds=900
# Avoid overriding a usable TMPDIR: Terraform providers use go-plugin grpc on
# a socket in TMPDIR, and repo-local paths can be blocked by agent seatbelts.
# Trunk hooks can strip TMPDIR entirely, so prefer the system temp directory
# before falling back to the repo scratch dir.
tmpdir_candidate="${TMPDIR:-${TMP:-${TEMP:-/tmp}}}"
if [[ -d "$tmpdir_candidate" && -w "$tmpdir_candidate" ]]; then
  export TMPDIR="$tmpdir_candidate"
else
  export TMPDIR="$scratch_dir"
fi

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
  local command_key
  local entry_key
  command_key="$(command_dedupe_key "$command")"
  for entry in "$@"; do
    entry_key="$(command_dedupe_key "${entry%%|*}")"
    [[ "$entry_key" == "$command_key" ]] && return 0
  done
  return 1
}

# The package.json script and direct shell entrypoint are the same regression
# suite; keep them as one mapped command when both are touched.
command_dedupe_key() {
  local command="$1"
  case "$command" in
    "pnpm agent:quality-gate:test"|"bash scripts/agent-quality-gate.test.sh")
      echo "agent-quality-gate.test"
      ;;
    *)
      echo "$command"
      ;;
  esac
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

turbo_local_cache_command() {
  local package_name="$1"
  local task_name="$2"
  printf 'pnpm exec turbo run %s --filter=%s --cache=local:rw' "$task_name" "$package_name"
}

add_turbo_package_task() {
  local package_name="$1"
  local task_name="$2"
  local reason="$3"
  add_command "$(turbo_local_cache_command "$package_name" "$task_name")" "$reason"
}

add_turbo_dashboard_task() {
  local task_name="$1"
  local reason="$2"
  add_turbo_package_task "@mento-protocol/ui-dashboard" "$task_name" "$reason"
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

ref_oid() {
  local ref="$1"
  git rev-parse --verify "${ref}^{commit}" 2>/dev/null || echo "__unresolved__:${ref}"
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
  local saw_tooling_script=false
  local saw_non_tooling_script=false
  local saw_non_script=false

  while IFS= read -r change; do
    [[ -n "$change" ]] || continue
    saw_change=true
    case "$change" in
      "__unknown__")
        echo "workspace"
        return
        ;;
      /scripts/agent:quality-gate|/scripts/agent:quality-gate:test|/scripts/agent:prewarm|/scripts/agent:prewarm:test|/scripts/agent:context-check|/scripts/agent:autoreview|/scripts/pr:feedback-state|/scripts/pr:feedback-state:test|/scripts/pr:ready-state|/scripts/pr:ready-state:test|/scripts/tf|/scripts/tf:test|/scripts/lockfile:lint|/scripts/lockfile:lint:test)
        saw_tooling_script=true
        ;;
      /scripts)
        saw_non_tooling_script=true
        ;;
      /scripts/*)
        saw_non_tooling_script=true
        ;;
      *)
        saw_non_script=true
        ;;
    esac
  done < <(json_change_paths "package.json")

  if [[ "$saw_change" != true ]]; then
    echo "workspace"
  elif [[ "$saw_tooling_script" == true && "$saw_non_tooling_script" != true && "$saw_non_script" != true ]]; then
    echo "root-tooling-scripts"
  elif [[ "$saw_tooling_script" == true || "$saw_non_tooling_script" == true ]]; then
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
  if [[ "$package_name" == "@mento-protocol/indexer-envio" ]]; then
    # Both `tsc --noEmit` and `eslint .` (with the type-aware
    # @typescript-eslint/no-unsafe-* rules active) require .envio/types.d.ts.
    # On a fresh worktree, or a PR that only touches src/, codegen wouldn't
    # otherwise run before quality commands and Envio entity imports would
    # resolve to error-`any`, tripping the unsafe-* rules. Force codegen as
    # a preflight; add_codegen_command dedups so concurrent triggers are
    # cheap.
    add_indexer_mainnet_codegen "$reason (codegen needed before indexer typecheck/lint)"
  fi
  add_turbo_package_task "$package_name" "lint" "$reason"
  add_turbo_package_task "$package_name" "typecheck" "$reason"
  add_command "pnpm --filter $package_name test:coverage" "$reason (coverage floor)"
  add_turbo_package_task "$package_name" "knip" "$reason (knip: unused files/deps/exports)"
  add_command "pnpm code-health:deps" "$reason (dep-cruiser: cross-package boundaries + cycles)"
  add_checklist "docs/pr-checklists/code-health.md" "$reason (code-health gates fire on this change)"
}

add_dashboard_quality_commands() {
  local reason="$1"
  add_package_quality_commands "@mento-protocol/ui-dashboard" "$reason"
  add_command "pnpm --filter @mento-protocol/ui-dashboard exec playwright install chromium" "$reason"
  add_turbo_dashboard_task "test:browser" "$reason"
}

add_ui_react_doctor_full_score() {
  local reason="$1"
  add_turbo_dashboard_task "react-doctor:score" "$reason"
}

add_ui_react_doctor_diff() {
  local reason="$1"
  add_command "REACT_DOCTOR_BASE_REF=$(quote_path "$base_ref") REACT_DOCTOR_BASE_CACHE_KEY=$(quote_path "$(ref_oid "$base_ref")") $(turbo_local_cache_command "@mento-protocol/ui-dashboard" "react-doctor:diff")" "$reason"
}

add_ui_mutation_baseline() {
  local reason="$1"
  add_command "pnpm dashboard:mutation" "$reason"
}

add_ui_size_limit() {
  local reason="$1"
  # `size-limit` depends on `build` in turbo.json, so one Turbo invocation
  # preserves the build guarantee without paying for a separate scheduler run.
  add_turbo_dashboard_task "size-limit" "$reason"
}

add_bridge_mutation_baseline() {
  local reason="$1"
  add_command "pnpm bridge:mutation" "$reason"
}

add_aegis_quality_commands() {
  local reason="$1"
  add_turbo_package_task "@mento-protocol/aegis" "typecheck" "$reason"
  add_command "pnpm --filter @mento-protocol/aegis build" "$reason"
  add_turbo_package_task "@mento-protocol/aegis" "lint" "$reason"
  add_turbo_package_task "@mento-protocol/aegis" "knip" "$reason (knip: unused files/deps/exports)"
  add_command "pnpm --filter @mento-protocol/aegis test:cov" "$reason"
  add_command "cd aegis && forge test" "$reason"
  add_command "pnpm code-health:deps" "$reason (dep-cruiser: cross-package boundaries + cycles)"
  add_checklist "docs/pr-checklists/code-health.md" "$reason (code-health gates fire on this change)"
}

add_alerts_oncall_quality_commands() {
  local reason="$1"
  add_turbo_package_task "@mento-protocol/alerts-oncall-announcer" "lint" "$reason"
  add_turbo_package_task "@mento-protocol/alerts-oncall-announcer" "typecheck" "$reason"
  add_command "pnpm --filter @mento-protocol/alerts-oncall-announcer test:coverage" "$reason (coverage floor)"
  add_turbo_package_task "@mento-protocol/alerts-oncall-announcer" "knip" "$reason (knip: unused files/deps/exports)"
}

add_indexer_mutation_baseline() {
  local reason="$1"
  add_command "pnpm indexer:mutation" "$reason"
}

add_workspace_quality_commands() {
  local reason="$1"
  add_all_indexer_codegen "$reason"
  # Use the lightweight dashboard quality (typecheck/lint/test/knip) for
  # workspace-wide triggers (root package.json, CI yaml, npmrc, etc.).
  # Playwright `test:browser` is high-cost and chromium's --single-process
  # mode (required in macOS sandbox per playwright.config.ts) is flaky for
  # tests using keyboard events + page.route. CI runs the full browser
  # suite in its own job — local workspace-wide triggers don't need to
  # replicate it. Direct `ui-dashboard/*` path changes still hit the full
  # `add_dashboard_quality_commands` from the per-package dispatch below.
  add_package_quality_commands "@mento-protocol/ui-dashboard" "$reason"
  add_ui_react_doctor_full_score "$reason"
  # Bundle size budget mirrors the workspace-wide CI gate in
  # `.github/workflows/size-limit.yml` — root package-manager files
  # (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`,
  # `.node-version`) appear in that workflow's filter because dep/runtime
  # changes can alter the emitted JS/CSS. Codex P2 review on PR #446
  # caught the local gate diverging from CI here.
  add_ui_size_limit "$reason"
  add_package_quality_commands "@mento-protocol/indexer-envio" "$reason"
  add_package_quality_commands "@mento-protocol/metrics-bridge" "$reason"
  add_package_quality_commands "@mento-protocol/integration-probes" "$reason"
  add_package_quality_commands "@mento-protocol/monitoring-config" "$reason"
  add_package_quality_commands "@mento-protocol/governance-watchdog" "$reason"
  add_aegis_quality_commands "$reason"
}

add_root_tooling_package_script_checks() {
  local reason="$1"
  add_command "bash scripts/check-agent-quality-gate-package-scripts.sh" "$reason"
  add_command "bash scripts/agent-quality-gate.test.sh" "$reason"
  add_command "node scripts/agent-prewarm.test.mjs" "$reason"
  add_command "node scripts/pr-feedback-state.test.mjs" "$reason"
  add_command "node scripts/pr-ready-state.test.mjs" "$reason"
  add_command "node scripts/tf-stacks.test.mjs" "$reason"
  add_command "node scripts/lockfile-lint.test.mjs" "$reason"
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
  local tf_data_dir="${module}/.terraform-agent-gate"
  add_command "TF_DATA_DIR=${tf_data_dir} terraform -chdir=${module} fmt -check -recursive" "$reason"
  add_command "TF_DATA_DIR=${tf_data_dir} terraform -chdir=${module} init -backend=false -input=false" "$reason"
  add_command "TF_DATA_DIR=${tf_data_dir} terraform -chdir=${module} validate -no-color" "$reason"
}

trunk_requires_full_scan() {
  local path
  while IFS= read -r path; do
    [[ -e "$path" ]] || return 0
    case "$path" in
      .trunk/*|tools/trunk|package.json|pnpm-lock.yaml|pnpm-workspace.yaml|.npmrc|*/.npmrc|pnpmfile.cjs|.pnpmfile.cjs|.node-version|*/package.json)
        return 0
        ;;
    esac
  done < "$changed_paths_file"

  return 1
}

targeted_trunk_command() {
  local path
  local args=()
  while IFS= read -r path; do
    args+=("$(quote_path "$path")")
  done < "$changed_paths_file"

  [[ ${#args[@]} -gt 0 ]] || return 1
  printf './tools/trunk check %s' "${args[*]}"
}

add_trunk_check_command() {
  local trunk_command
  if trunk_requires_full_scan; then
    prepend_command "./tools/trunk check --all" "changed paths require full-repo Trunk checks"
  elif trunk_command="$(targeted_trunk_command)"; then
    prepend_command "$trunk_command" "changed existing paths should pass targeted Trunk checks"
  else
    prepend_command "./tools/trunk check --all" "changed paths could not be mapped to targeted Trunk checks"
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

find_turbo_task_index() {
  local task="$1"
  local index
  for index in "${!turbo_group_tasks[@]}"; do
    if [[ "${turbo_group_tasks[$index]}" == "$task" ]]; then
      echo "$index"
      return 0
    fi
  done
  return 1
}

list_contains_word() {
  local needle="$1"
  local word
  shift
  for word in "$@"; do
    [[ "$word" == "$needle" ]] && return 0
  done
  return 1
}

reason_list_contains() {
  local reasons="$1"
  local reason="$2"
  [[ "; ${reasons}; " == *"; ${reason}; "* ]]
}

compact_turbo_quality_commands() {
  local compacted_kinds=()
  local compacted_values=()
  local turbo_group_tasks=()
  local turbo_group_packages=()
  local turbo_group_reasons=()
  local entry
  local command
  local reason
  local task
  local package_name
  local group_index
  local existing_packages
  local existing_reasons
  local existing_package_array
  local kind
  local value
  local package_filters
  local package

  for entry in "${quality_commands[@]+"${quality_commands[@]}"}"; do
    command="${entry%%|*}"
    reason="${entry#*|}"

    if [[ "$command" =~ ^pnpm\ exec\ turbo\ run\ ([^[:space:]]+)\ --filter=(@mento-protocol/[^[:space:]]+)\ --cache=local:rw$ ]]; then
      task="${BASH_REMATCH[1]}"
      package_name="${BASH_REMATCH[2]}"

      if group_index="$(find_turbo_task_index "$task")"; then
        existing_packages="${turbo_group_packages[$group_index]}"
        read -r -a existing_package_array <<< "$existing_packages"
        if ! list_contains_word "$package_name" "${existing_package_array[@]}"; then
          turbo_group_packages[$group_index]="${existing_packages} ${package_name}"
        fi

        existing_reasons="${turbo_group_reasons[$group_index]}"
        if ! reason_list_contains "$existing_reasons" "$reason"; then
          turbo_group_reasons[$group_index]="${existing_reasons}; ${reason}"
        fi
      else
        turbo_group_tasks+=("$task")
        turbo_group_packages+=("$package_name")
        turbo_group_reasons+=("$reason")
        compacted_kinds+=("turbo")
        compacted_values+=("$task")
      fi
    else
      compacted_kinds+=("plain")
      compacted_values+=("$entry")
    fi
  done

  quality_commands=()
  for index in "${!compacted_kinds[@]}"; do
    kind="${compacted_kinds[$index]}"
    value="${compacted_values[$index]}"
    if [[ "$kind" == "plain" ]]; then
      quality_commands+=("$value")
      continue
    fi

    group_index="$(find_turbo_task_index "$value")"
    package_filters=""
    read -r -a existing_package_array <<< "${turbo_group_packages[$group_index]}"
    for package in "${existing_package_array[@]}"; do
      package_filters+=" --filter=${package}"
    done
    quality_commands+=("pnpm exec turbo run ${value}${package_filters} --cache=local:rw|${turbo_group_reasons[$group_index]}")
  done
}

while IFS= read -r path; do
  case "$path" in
    package.json)
      root_package_json_class="$(get_root_package_json_class)"
      case "$root_package_json_class" in
        root-tooling-scripts)
          add_surface "tooling"
          add_root_tooling_package_script_checks "root package tooling script changed"
          ;;
        package-scripts)
          package_script_risk_changed=true
          add_surface "workspace"
          add_preflight_command "pnpm install --frozen-lockfile" "root package script changed"
          add_root_tooling_package_script_checks "root package script changed"
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
    .dependency-cruiser.cjs)
      add_surface "tooling"
      add_command "pnpm code-health:deps" "dep-cruiser config changed (cross-package boundaries + cycles)"
      # `.dependency-cruiser.cjs` is also linted by `pnpm lint:scripts` (see
      # eslint.config.mjs root coverage). A CJS-only edit must run both.
      add_command "pnpm lint:scripts" "dep-cruiser config changed (root ESLint coverage)"
      add_checklist "docs/pr-checklists/code-health.md" "dep-cruiser config changed"
      ;;
    */knip.json)
      # Match knip.json regardless of which package owns it. The pnpm
      # filter scope below normalizes path to package.
      add_surface "tooling"
      add_checklist "docs/pr-checklists/code-health.md" "knip config changed"
      case "$path" in
        shared-config/knip.json)
          add_turbo_package_task "@mento-protocol/monitoring-config" "knip" "knip config changed"
          ;;
        ui-dashboard/knip.json)
          add_turbo_package_task "@mento-protocol/ui-dashboard" "knip" "knip config changed"
          ;;
        indexer-envio/knip.json)
          add_turbo_package_task "@mento-protocol/indexer-envio" "knip" "knip config changed"
          ;;
        metrics-bridge/knip.json)
          add_turbo_package_task "@mento-protocol/metrics-bridge" "knip" "knip config changed"
          ;;
        integration-probes/knip.json)
          add_turbo_package_task "@mento-protocol/integration-probes" "knip" "knip config changed"
          ;;
        aegis/knip.json)
          add_turbo_package_task "@mento-protocol/aegis" "knip" "knip config changed"
          ;;
      esac
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
      # Bundle size budget gate — mirrors `.github/workflows/size-limit.yml`.
      # Any change under ui-dashboard/ that can affect the client build
      # (src files, root config files like postcss/sentry-shared/next/tsconfig)
      # re-runs the build + size-limit check locally before opening a PR.
      # Browser fixtures and other nested .mjs files are deliberately excluded:
      # they can invalidate browser-test cache entries without forcing an
      # unrelated dashboard build cache miss.
      case "$path" in
        ui-dashboard/src/*|ui-dashboard/package.json|ui-dashboard/next.config.*|ui-dashboard/postcss.config.*|ui-dashboard/sentry.*.config.*|ui-dashboard/sentry.shared.ts|ui-dashboard/tsconfig*.json|ui-dashboard/.size-limit.cjs|ui-dashboard/vercel.json|ui-dashboard/.env.production.local.example)
          add_ui_size_limit "ui-dashboard bundle inputs changed"
          ;;
      esac
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
    integration-probes/*)
      add_surface "integration-probes"
      case "$path" in
        integration-probes/src/*)
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "integration probe data flow changed"
          ;;
      esac
      add_package_quality_commands "@mento-protocol/integration-probes" "integration-probes changed"
      ;;
    aegis/*)
      add_surface "aegis"
      case "$path" in
        aegis/src/*|aegis/config.yaml|aegis/app.yaml|aegis/contracts/*|aegis/foundry.toml|aegis/foundry.lock|aegis/package.json|aegis/tsconfig*.json|aegis/nest-cli.json|aegis/eslint.config.js|aegis/eslint-baseline.json)
          add_aegis_quality_commands "aegis changed"
          ;;
        aegis/terraform/*)
          add_terraform_validate_commands "aegis/terraform" "Aegis Terraform changed"
          add_checklist "docs/pr-checklists/ci-workflow-gates.md" "Aegis Terraform/deploy-adjacent path changed"
          ;;
        aegis/grafana-agent/*|aegis/bin/*)
          add_aegis_quality_commands "aegis runtime/deploy path changed"
          add_checklist "docs/pr-checklists/ci-workflow-gates.md" "Aegis deploy path changed"
          ;;
        aegis/lib/*)
          add_command "cd aegis && forge test" "Aegis Foundry dependency changed"
          ;;
      esac
      ;;
    shared-config/*)
      add_surface "shared-config"
      add_package_quality_commands "@mento-protocol/monitoring-config" "shared-config changed"
      add_command "pnpm --filter @mento-protocol/monitoring-config build" "shared-config exports changed"
      add_command "pnpm --filter @mento-protocol/ui-dashboard typecheck" "shared-config consumers should typecheck"
      add_command "pnpm --filter @mento-protocol/metrics-bridge typecheck" "shared-config consumers should typecheck"
      add_command "pnpm --filter @mento-protocol/integration-probes typecheck" "shared-config consumers should typecheck"
      # shared-config is imported into the dashboard client bundle via
      # `@mento-protocol/monitoring-config` — changes to chain/token
      # metadata or helpers can shift the emitted JS. Mirrors the
      # `shared-config/**` entry in `.github/workflows/size-limit.yml`.
      add_ui_size_limit "shared-config exports feed the dashboard bundle"
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
      add_command "node scripts/check-github-action-pins.mjs" "GitHub Actions workflow/action changed"
      case "$path" in
        .github/workflows/ci.yml)
          add_surface "workspace"
          add_preflight_command "pnpm install --frozen-lockfile" "central CI workflow changed"
          add_workspace_quality_commands "central CI workflow changed"
          add_command "pnpm tf:test" "Terraform registry-backed CI workflow changed"
          add_terraform_validate_commands "terraform" "Terraform registry-backed CI workflow changed"
          add_terraform_validate_commands "alerts/rules" "Terraform registry-backed CI workflow changed"
          add_terraform_validate_commands "alerts/infra" "Terraform registry-backed CI workflow changed"
          add_terraform_validate_commands "aegis/terraform" "Terraform registry-backed CI workflow changed"
          ;;
        .github/workflows/infra.yml)
          add_command "pnpm tf:test" "Terraform registry workflow changed"
          add_terraform_validate_commands "terraform" "Terraform registry workflow changed"
          add_terraform_validate_commands "alerts/rules" "Terraform registry workflow changed"
          add_terraform_validate_commands "alerts/infra" "Terraform registry workflow changed"
          add_terraform_validate_commands "aegis/terraform" "Terraform registry workflow changed"
          ;;
        .github/workflows/metrics-bridge.yml)
          add_checklist "docs/pr-checklists/terraform-cloudrun.md" "metrics bridge Cloud Run workflow changed"
          add_command "pnpm agent:context-check" "Cloud Run revision suffix guard changed"
          ;;
        .github/workflows/aegis-app-engine.yml)
          add_aegis_quality_commands "Aegis App Engine workflow changed"
          ;;
        .github/workflows/lighthouse.yml)
          add_checklist "docs/pr-checklists/code-health.md" "Lighthouse CI workflow changed"
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
      add_command "node scripts/check-github-action-pins.mjs" "Trunk workflow/action setup changed"
      add_command "pnpm agent:quality-gate:test" "agent quality gate trunk hook changed"
      ;;
    turbo.json)
      add_surface "tooling"
      add_command "pnpm agent:quality-gate:test" "turbo task config changed"
      ;;
    alerts/rules/*)
      add_surface "alerts-rules"
      add_terraform_validate_commands "alerts/rules" "alerts/rules Terraform changed"
      ;;
    alerts/infra/onchain-event-handler/*)
      add_surface "alerts-infra"
      case "$path" in
        alerts/infra/onchain-event-handler/src/safe-abi.json)
          add_package_quality_commands "@mento-protocol/alerts-onchain-event-handler" "Safe ABI changed (handler imports it)"
          add_terraform_validate_commands "alerts/infra" "Safe ABI changed (listener filter uses it at plan time)"
          ;;
        alerts/infra/onchain-event-handler/src/*|alerts/infra/onchain-event-handler/package.json|alerts/infra/onchain-event-handler/pnpm-lock.yaml|alerts/infra/onchain-event-handler/pnpm-workspace.yaml|alerts/infra/onchain-event-handler/tsconfig.json|alerts/infra/onchain-event-handler/vitest.config.ts|alerts/infra/onchain-event-handler/knip.json|alerts/infra/onchain-event-handler/eslint.config.mjs)
          add_package_quality_commands "@mento-protocol/alerts-onchain-event-handler" "alerts onchain-event-handler changed"
          ;;
        alerts/infra/onchain-event-handler/*.tf)
          add_terraform_validate_commands "alerts/infra" "alerts/infra Terraform changed"
          add_checklist "docs/pr-checklists/terraform-cloudrun.md" "alerts/infra Cloud Function path changed"
          ;;
        # Other handler files (scripts/*.sh, README.md, .gcloudignore,
        # .prettierrc.json, .prettierignore) need no extra routing: shell
        # scripts hit the generic `*.sh → bash -n $(quote_path "$path")`
        # branch above; the others are doc/config-only and don't gate
        # anything.
      esac
      ;;
    alerts/infra/oncall-announcer/*)
      add_surface "alerts-infra"
      case "$path" in
        alerts/infra/oncall-announcer/src/*|alerts/infra/oncall-announcer/package.json|alerts/infra/oncall-announcer/pnpm-lock.yaml|alerts/infra/oncall-announcer/pnpm-workspace.yaml|alerts/infra/oncall-announcer/tsconfig.json|alerts/infra/oncall-announcer/vitest.config.ts|alerts/infra/oncall-announcer/knip.json|alerts/infra/oncall-announcer/eslint.config.mjs)
          add_alerts_oncall_quality_commands "alerts oncall-announcer changed"
          ;;
        alerts/infra/oncall-announcer/*.tf)
          add_terraform_validate_commands "alerts/infra" "alerts/infra Terraform changed"
          add_checklist "docs/pr-checklists/terraform-cloudrun.md" "alerts/infra Cloud Function path changed"
          ;;
      esac
      ;;
    alerts/infra/scripts/*)
      add_surface "alerts-infra"
      case "$path" in
        alerts/infra/scripts/*.sh)
          add_command "bash -n $(quote_path "$path")" "alerts infra shell script changed"
          ;;
      esac
      ;;
    alerts/infra/onchain-event-listeners/*|alerts/infra/channels/*)
      # Listener filter (filter-function.js.tpl) feeds into the handler —
      # a regression like dropping blockHash from it silently breaks the
      # handler's cross-chain detection, and the 38 vitest cases cover
      # that behavior. Route to handler tests in addition to TF validate.
      # Matches the CI alerts paths-filter in .github/workflows/ci.yml.
      add_surface "alerts-infra"
      add_package_quality_commands "@mento-protocol/alerts-onchain-event-handler" "alerts/infra listener or channels changed (handler tests cover cross-chain behavior)"
      add_terraform_validate_commands "alerts/infra" "alerts/infra Terraform changed"
      add_checklist "docs/pr-checklists/terraform-cloudrun.md" "alerts/infra Cloud Function path changed"
      ;;
    alerts/infra/*)
      add_surface "alerts-infra"
      add_terraform_validate_commands "alerts/infra" "alerts/infra Terraform changed"
      add_checklist "docs/pr-checklists/terraform-cloudrun.md" "alerts/infra Cloud Function path changed"
      ;;
    governance-watchdog/*)
      add_surface "governance-watchdog"
      case "$path" in
        governance-watchdog/src/*|governance-watchdog/bin/*.ts|governance-watchdog/package.json|governance-watchdog/pnpm-lock.yaml|governance-watchdog/pnpm-workspace.yaml|governance-watchdog/tsconfig.json|governance-watchdog/tsconfig.build.json|governance-watchdog/vitest.config.ts|governance-watchdog/knip.json|governance-watchdog/eslint.config.mjs)
          add_package_quality_commands "@mento-protocol/governance-watchdog" "governance-watchdog changed"
          ;;
        governance-watchdog/infra/*.tf)
          add_terraform_validate_commands "governance-watchdog/infra" "governance-watchdog Terraform changed"
          add_checklist "docs/pr-checklists/terraform-cloudrun.md" "governance-watchdog Cloud Function path changed"
          ;;
        governance-watchdog/infra/quicknode-filter-functions/*.js)
          # Canonical source that bin/deploy-quicknode-filter.sh pushes to the
          # live QuickNode webhook — a syntax regression would otherwise only
          # surface during a live filter update.
          add_command "node --check $(quote_path "$path")" "QuickNode filter function changed"
          ;;
        # Other files (bin/*.sh, *.md, .gcloudignore, .prettierrc, .env.example,
        # osv-scanner.toml) need no extra routing: shell scripts hit the generic
        # `*.sh → bash -n` branch above; the rest are doc/config-only.
        # bin/*.ts is routed to package quality above — the package tsconfig
        # includes `bin/**/*`, so typecheck/build cover those entrypoints.
      esac
      ;;
    terraform/*)
      add_surface "terraform"
      add_terraform_validate_commands "terraform" "Terraform changed"
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
    .lighthouserc.cjs)
      add_surface "ui-dashboard"
      add_checklist "docs/pr-checklists/code-health.md" "Lighthouse CI budget config changed"
      ;;
    docs/*|README.md|AGENTS.md|*/AGENTS.md|BACKLOG.md)
      add_surface "docs"
      case "$path" in
        docs/context-standards.md|docs/pr-checklists/recurring-review-patterns.md|AGENTS.md|*/AGENTS.md)
          add_command "pnpm agent:context-check" "agent context standards changed"
          ;;
      esac
      ;;
    .agents/skills/*|.agents/roles/*|.claude/skills/*|.claude/settings.json|.codex/hooks.json)
      add_surface "agent-context"
      add_command "pnpm agent:context-check" "agent context files changed"
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
        scripts/agent-autoreview.sh|scripts/agent-autoreview.test.sh)
          add_command "bash scripts/agent-autoreview.test.sh" "agent autoreview adapter changed"
          ;;
        scripts/deploy-bridge.sh)
          add_checklist "docs/pr-checklists/terraform-cloudrun.md" "Cloud Run deploy script changed"
          add_command "pnpm agent:context-check" "Cloud Run revision suffix guard changed"
          ;;
        scripts/agent-session-end-hook.sh)
          add_command "pnpm agent:context-check" "agent SessionEnd hook changed"
          ;;
      esac
      ;;
    scripts/*.mjs|scripts/*.cjs|scripts/*.js|eslint.config.mjs)
      # `.dependency-cruiser.cjs` is handled fully by its dedicated case
      # block above (runs `pnpm code-health:deps` + `pnpm lint:scripts`).
      # Don't list it here too or `add_command` dedupes a redundant entry.
      add_surface "scripts"
      add_command "pnpm lint:scripts" "root build script changed"
      case "$path" in
        scripts/check-agent-context.mjs)
          add_command "pnpm agent:context-check" "agent context checker changed"
          ;;
        scripts/agent-prewarm.mjs|scripts/agent-prewarm.test.mjs)
          add_command "pnpm agent:prewarm:test" "agent prewarm helper changed"
          ;;
        scripts/pr-feedback-state.mjs|scripts/pr-feedback-state-core.mjs|scripts/pr-feedback-state.test.mjs)
          add_command "pnpm pr:feedback-state:test" "PR feedback-state helper changed"
          ;;
        scripts/pr-ready-state.mjs|scripts/pr-ready-state-core.mjs|scripts/pr-ready-state-format.mjs|scripts/pr-ready-state.test.mjs)
          add_command "pnpm pr:ready-state:test" "PR ready-state helper changed"
          ;;
        scripts/tf-stacks.mjs|scripts/tf-stacks.test.mjs)
          add_command "pnpm tf:test" "Terraform stack wrapper changed"
          add_terraform_validate_commands "terraform" "Terraform stack wrapper changed"
          add_terraform_validate_commands "alerts/rules" "Terraform stack wrapper changed"
          add_terraform_validate_commands "alerts/infra" "Terraform stack wrapper changed"
          add_terraform_validate_commands "aegis/terraform" "Terraform stack wrapper changed"
          add_terraform_validate_commands "governance-watchdog/infra" "Terraform stack wrapper changed"
          ;;
        scripts/lockfile-lint.mjs|scripts/lockfile-lint.test.mjs)
          add_command "pnpm lockfile:lint:test" "lockfile lint helper changed"
          ;;
        scripts/check-github-action-pins.mjs)
          add_command "node scripts/check-github-action-pins.mjs" "GitHub Actions pin checker changed"
          add_command "node scripts/check-github-action-pins.test.mjs" "GitHub Actions pin checker changed"
          ;;
        scripts/check-github-action-pins.test.mjs)
          add_command "node scripts/check-github-action-pins.test.mjs" "GitHub Actions pin checker test changed"
          ;;
        scripts/notify-terraform-apply.mjs|scripts/notify-terraform-apply.test.mjs)
          add_command "node scripts/notify-terraform-apply.test.mjs" "Terraform apply Slack notifier changed"
          ;;
        scripts/eslint-baseline-diff.mjs)
          # The lint wrapper. A regression here would mask all per-package
          # baseline drift. Re-run every package's lint to exercise the
          # wrapper end-to-end, plus the semantic tests covering its
          # matching/growth/absorption logic directly.
          add_command "node scripts/eslint-baseline-diff.test.mjs" "ESLint baseline wrapper changed"
          add_package_quality_commands "@mento-protocol/monitoring-config" "ESLint baseline wrapper changed"
          add_package_quality_commands "@mento-protocol/ui-dashboard" "ESLint baseline wrapper changed"
          add_package_quality_commands "@mento-protocol/indexer-envio" "ESLint baseline wrapper changed"
          add_package_quality_commands "@mento-protocol/metrics-bridge" "ESLint baseline wrapper changed"
          add_package_quality_commands "@mento-protocol/integration-probes" "ESLint baseline wrapper changed"
          ;;
        scripts/eslint-baseline-diff.test.mjs)
          add_command "node scripts/eslint-baseline-diff.test.mjs" "ESLint baseline wrapper test changed"
          ;;
      esac
      ;;
    scripts/*|tools/*)
      add_surface "scripts"
      ;;
    terraform.stacks.json)
      add_surface "terraform"
      add_command "pnpm tf:test" "Terraform stack registry changed"
      add_terraform_validate_commands "terraform" "Terraform stack registry changed"
      add_terraform_validate_commands "alerts/rules" "Terraform stack registry changed"
      add_terraform_validate_commands "alerts/infra" "Terraform stack registry changed"
      add_terraform_validate_commands "aegis/terraform" "Terraform stack registry changed"
      add_terraform_validate_commands "governance-watchdog/infra" "Terraform stack registry changed"
      add_checklist "docs/pr-checklists/ci-workflow-gates.md" "Terraform stack registry changed"
      ;;
    package.json)
      root_package_json_class="$(get_root_package_json_class)"
      case "$root_package_json_class" in
        root-tooling-scripts)
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
compact_turbo_quality_commands

hash_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$@"
  else
    echo "Cannot compute sha256; please install sha256sum or shasum." >&2
    return 127
  fi
}

hash_stream() {
  hash_sha256 | awk '{ print $1 }'
}

hash_file() {
  hash_sha256 "$1" | awk '{ print $1 }'
}

write_command_plan() {
  local output_file="$1"
  local entry
  : > "$output_file"
  for entry in "${preflight_commands[@]+"${preflight_commands[@]}"}"; do
    printf 'preflight\t%s\t%s\n' "${entry%%|*}" "${entry#*|}" >> "$output_file"
  done
  for entry in "${codegen_commands[@]+"${codegen_commands[@]}"}"; do
    printf 'codegen\t%s\t%s\n' "${entry%%|*}" "${entry#*|}" >> "$output_file"
  done
  for entry in "${post_codegen_commands[@]+"${post_codegen_commands[@]}"}"; do
    printf 'post-codegen\t%s\t%s\n' "${entry%%|*}" "${entry#*|}" >> "$output_file"
  done
  for entry in "${quality_commands[@]+"${quality_commands[@]}"}"; do
    printf 'quality\t%s\t%s\n' "${entry%%|*}" "${entry#*|}" >> "$output_file"
  done
}

implementation_signature() {
  local path
  for path in \
    scripts/agent-quality-gate.sh \
    scripts/agent-quality-gate.test.sh \
    scripts/check-agent-quality-gate-package-scripts.sh \
    turbo.json \
    .trunk/trunk.yaml; do
    if [[ -f "$path" ]]; then
      printf '%s %s\n' "$path" "$(hash_file "$path")"
    else
      printf '%s __missing__\n' "$path"
    fi
  done | hash_stream
}

validation_content_signature() {
  local path

  {
    while IFS= read -r path; do
      printf 'path %s\0' "$path"
      if [[ -f "$path" ]]; then
        printf 'file %s\0' "$(hash_file "$path")"
      elif [[ -d "$path" ]]; then
        printf 'directory\0'
      elif [[ -e "$path" ]]; then
        printf 'other\0'
      else
        printf 'deleted\0'
      fi
      git diff --no-ext-diff --summary "$base_ref" -- "$path" 2>/dev/null || true
    done < "$changed_paths_file"
  } | hash_stream
}

command_plan_file="$(make_tmpfile)"
write_command_plan "$command_plan_file"

base_oid="$(ref_oid "$base_ref")"
changed_paths_hash="$(hash_file "$changed_paths_file")"
command_plan_hash="$(hash_file "$command_plan_file")"
implementation_hash="$(implementation_signature)"
validated_content_hash="$(validation_content_signature)"

stamp_line() {
  printf 'v2\tbase=%s\tpaths=%s\tplan=%s\timplementation=%s\tcontent=%s\tpackageRisk=%s\tallowPackageScripts=%s\n' \
    "$base_oid" \
    "$changed_paths_hash" \
    "$command_plan_hash" \
    "$implementation_hash" \
    "$validated_content_hash" \
    "$package_script_risk_changed" \
    "${allow_package_script_changes:-false}"
}

current_stamp="$(stamp_line)"

is_fresh_success_stamp() {
  local stamped_at
  local stamped_value
  local now
  [[ -f "$success_stamp_file" ]] || return 1
  stamped_at="$(sed -n '1s/^created_at=//p' "$success_stamp_file")"
  stamped_value="$(sed -n '2s/^stamp=//p' "$success_stamp_file")"
  [[ "$stamped_value" == "$current_stamp" ]] || return 1
  [[ "$stamped_at" =~ ^[0-9]+$ ]] || return 1
  now="$(date +%s)"
  [[ $((now - stamped_at)) -le "$success_stamp_ttl_seconds" ]]
}

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

if [[ "$skip_if_fresh" == "1" || "$skip_if_fresh" == "true" ]]; then
  if is_fresh_success_stamp; then
    echo "Previous successful agent quality gate run is still fresh; skipping mapped commands."
    exit 0
  fi
fi

if [[ "$package_script_risk_changed" == true && "$allow_package_script_changes" != "1" && "$allow_package_script_changes" != "true" ]]; then
  echo "Refusing to run because package manifests or lockfile changed." >&2
  echo "Review package scripts, lifecycle hooks, and dependency install scripts first, then re-run with --allow-package-script-changes if they are safe." >&2
  exit 2
fi

failures=0
command_summaries=()
supports_wait_n=false
if help wait 2>/dev/null | grep -q -- "-n"; then
  supports_wait_n=true
fi

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

run_mapped_command_to_files() {
  local command="$1"
  local output_file="$2"
  local status_file="$3"
  local elapsed_file="$4"
  local start_ts
  local end_ts
  local elapsed
  local exit_code

  start_ts="$(date +%s)"
  set +e
  bash -c "$command" > "$output_file" 2>&1
  exit_code=$?
  set -e
  end_ts="$(date +%s)"
  elapsed=$((end_ts - start_ts))

  printf '%s\n' "$exit_code" > "$status_file"
  printf '%s\n' "$elapsed" > "$elapsed_file"
}

is_quality_setup_command() {
  local command="$1"
  # These commands have side effects that later quality checks depend on, so
  # they must finish before the independent quality pool starts. Keep this list
  # in sync with new setup-style commands added by the path mapper above.
  case "$command" in
    "pnpm --filter @mento-protocol/ui-dashboard exec playwright install chromium")
      return 0
      ;;
    "pnpm --filter @mento-protocol/monitoring-config build")
      return 0
      ;;
    TF_DATA_DIR=*terraform\ -chdir=*)
      return 0
      ;;
  esac

  return 1
}

is_quality_serial_command() {
  local command="$1"
  # Dashboard browser tests start a Next dev server while size-limit runs a
  # build-backed Turbo task. Both touch ui-dashboard/.next, so keep them
  # mutually exclusive instead of letting the parallel pool overlap them.
  case "$command" in
    "pnpm exec turbo run test:browser --filter=@mento-protocol/ui-dashboard --cache=local:rw")
      return 0
      ;;
    "pnpm exec turbo run size-limit --filter=@mento-protocol/ui-dashboard --cache=local:rw")
      return 0
      ;;
  esac

  return 1
}

run_mapped_entries_sequential() {
  local entry
  local command
  # $1 is the phase label, accepted for call-site symmetry with the parallel
  # runner. Sequential execution does not need to print the phase.
  shift

  for entry in "$@"; do
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
}

run_mapped_entries_parallel() {
  local phase="$1"
  local max_parallel="$2"
  shift 2
  local entries=("$@")
  local total="${#entries[@]}"
  local next_index=0
  local completed=0
  local active_pids=()
  local active_commands=()
  local active_output_files=()
  local active_status_files=()
  local active_elapsed_files=()
  local next_active_pids=()
  local next_active_commands=()
  local next_active_output_files=()
  local next_active_status_files=()
  local next_active_elapsed_files=()
  local running_pids=()
  local entry
  local command
  local output_file
  local status_file
  local elapsed_file
  local pid
  local i
  local status
  local elapsed

  if [[ "$total" -eq 0 ]]; then
    return
  fi

  if [[ "$max_parallel" -le 1 || "$total" -le 1 ]]; then
    run_mapped_entries_sequential "$phase" "${entries[@]}"
    return
  fi

  echo
  echo "Running ${phase} commands with parallelism ${max_parallel}."

  while [[ "$completed" -lt "$total" ]]; do
    while [[ "$next_index" -lt "$total" && "${#active_pids[@]}" -lt "$max_parallel" ]]; do
      entry="${entries[$next_index]}"
      command="${entry%%|*}"
      output_file="$(make_tmpfile)"
      status_file="$(make_tmpfile)"
      elapsed_file="$(make_tmpfile)"

      echo
      echo "+ ${command}"
      run_mapped_command_to_files "$command" "$output_file" "$status_file" "$elapsed_file" &
      pid="$!"

      active_pids+=("$pid")
      active_commands+=("$command")
      active_output_files+=("$output_file")
      active_status_files+=("$status_file")
      active_elapsed_files+=("$elapsed_file")

      next_index=$((next_index + 1))
    done

    running_pids=()
    while IFS= read -r pid; do
      [[ -n "$pid" ]] && running_pids+=("$pid")
    done < <(jobs -pr || true)
    next_active_pids=()
    next_active_commands=()
    next_active_output_files=()
    next_active_status_files=()
    next_active_elapsed_files=()

    for i in "${!active_pids[@]}"; do
      pid="${active_pids[$i]}"
      if list_contains_word "$pid" "${running_pids[@]+"${running_pids[@]}"}"; then
        next_active_pids+=("$pid")
        next_active_commands+=("${active_commands[$i]}")
        next_active_output_files+=("${active_output_files[$i]}")
        next_active_status_files+=("${active_status_files[$i]}")
        next_active_elapsed_files+=("${active_elapsed_files[$i]}")
        continue
      fi

      if ! wait "$pid"; then
        :
      fi

      command="${active_commands[$i]}"
      output_file="${active_output_files[$i]}"
      status_file="${active_status_files[$i]}"
      elapsed_file="${active_elapsed_files[$i]}"
      status="$(cat "$status_file" 2>/dev/null || echo 127)"
      elapsed="$(cat "$elapsed_file" 2>/dev/null || echo 0)"

      if [[ "$status" -eq 0 ]]; then
        record_command_summary "ok" "$elapsed" "$command"
        echo "✓ ${command} ($(format_duration "$elapsed"))"
      else
        failures=$((failures + 1))
        record_command_summary "fail" "$elapsed" "$command"
        echo "Command failed after $(format_duration "$elapsed"): ${command}" >&2
        filter_expected_output < "$output_file" >&2
      fi

      rm -f "$output_file" "$status_file" "$elapsed_file"
      completed=$((completed + 1))
    done

    active_pids=("${next_active_pids[@]+"${next_active_pids[@]}"}")
    active_commands=("${next_active_commands[@]+"${next_active_commands[@]}"}")
    active_output_files=("${next_active_output_files[@]+"${next_active_output_files[@]}"}")
    active_status_files=("${next_active_status_files[@]+"${next_active_status_files[@]}"}")
    active_elapsed_files=("${next_active_elapsed_files[@]+"${next_active_elapsed_files[@]}"}")

    if [[ ${#active_pids[@]} -gt 0 && "$supports_wait_n" == true ]]; then
      wait -n 2>/dev/null || true
    elif [[ ${#active_pids[@]} -gt 0 ]]; then
      sleep 0.1
    fi
  done
}

run_quality_phase() {
  local setup_entries=()
  local serial_entries=()
  local parallel_entries=()
  local entry
  local command

  if [[ "$fail_fast" == "1" || "$fail_fast" == "true" || "$quality_parallelism" -le 1 ]]; then
    run_mapped_entries_sequential "quality" "${quality_commands[@]+"${quality_commands[@]}"}"
    return
  fi

  for entry in "${quality_commands[@]+"${quality_commands[@]}"}"; do
    command="${entry%%|*}"
    if is_quality_setup_command "$command"; then
      setup_entries+=("$entry")
    elif is_quality_serial_command "$command"; then
      serial_entries+=("$entry")
    else
      parallel_entries+=("$entry")
    fi
  done

  run_mapped_entries_sequential "quality setup" "${setup_entries[@]+"${setup_entries[@]}"}"
  run_mapped_entries_sequential "quality serialized" "${serial_entries[@]+"${serial_entries[@]}"}"
  run_mapped_entries_parallel "quality" "$quality_parallelism" "${parallel_entries[@]+"${parallel_entries[@]}"}"
}

run_mapped_entries_sequential "preflight" "${preflight_commands[@]+"${preflight_commands[@]}"}"
run_mapped_entries_sequential "codegen" "${codegen_commands[@]+"${codegen_commands[@]}"}"
run_mapped_entries_sequential "post-codegen" "${post_codegen_commands[@]+"${post_codegen_commands[@]}"}"
run_quality_phase

print_command_summary

if [[ "$failures" -gt 0 ]]; then
  echo
  echo "${failures} mapped command(s) failed." >&2
  exit 1
fi

echo
echo "All mapped commands passed."
{
  printf 'created_at=%s\n' "$(date +%s)"
  printf 'stamp=%s\n' "$current_stamp"
} > "$success_stamp_file"
