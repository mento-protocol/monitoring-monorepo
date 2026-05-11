#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/agent-quality-gate.sh [--dry-run|--run] [--base <ref>] [--head <ref>]

Maps changed paths to the local commands and PR checklists an agent should run
before opening or updating a PR. Defaults to dry-run.

Options:
  --dry-run      Print the mapped commands/checklists without running them.
  --run          Execute the mapped safe local commands.
  --base <ref>   Base ref for changed-path detection. Default: origin/main.
  --head <ref>   Head ref for changed-path detection. Default: HEAD.
  -h, --help     Show this help.

Environment:
  AGENT_QUALITY_BASE  Override the default base ref.
  AGENT_QUALITY_HEAD  Override the default head ref.
USAGE
}

mode="dry-run"
base_ref="${AGENT_QUALITY_BASE:-origin/main}"
head_ref="${AGENT_QUALITY_HEAD:-HEAD}"

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
    --)
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

changed_paths_file="$(mktemp)"
trap 'rm -f "$changed_paths_file"' EXIT

{
  if ! git diff --name-only "${base_ref}...${head_ref}" 2>/dev/null; then
    git diff --name-only "$base_ref" "$head_ref"
  fi

  if [[ "$head_ref" == "HEAD" ]]; then
    git diff --name-only
    git diff --cached --name-only
    git ls-files --others --exclude-standard
  fi
} | sed '/^$/d' | sort -u > "$changed_paths_file"

if [[ ! -s "$changed_paths_file" ]]; then
  echo "No changed paths detected against ${base_ref}...${head_ref}."
  exit 0
fi

commands=()
checklists=()
surfaces=()

has_command() {
  local command="$1"
  local entry
  for entry in "${commands[@]}"; do
    if [[ "${entry%%|*}" == "$command" ]]; then
      return 0
    fi
  done
  return 1
}

add_command() {
  local command="$1"
  local reason="$2"
  if ! has_command "$command"; then
    commands+=("${command}|${reason}")
  fi
}

has_checklist() {
  local checklist="$1"
  local entry
  for entry in "${checklists[@]}"; do
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
  for entry in "${surfaces[@]}"; do
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

add_package_quality_commands() {
  local package_name="$1"
  local reason="$2"
  add_command "pnpm --filter ${package_name} lint" "$reason"
  add_command "pnpm --filter ${package_name} typecheck" "$reason"
  add_command "pnpm --filter ${package_name} test" "$reason"
}

add_command "./tools/trunk check" "changed files should pass repo-wide Trunk linters"

while IFS= read -r path; do
  case "$path" in
    ui-dashboard/*)
      add_surface "ui-dashboard"
      add_package_quality_commands "@mento-protocol/ui-dashboard" "ui-dashboard changed"
      add_command "pnpm dashboard:react-doctor:diff" "ui-dashboard client code should keep React Doctor clean"
      case "$path" in
        ui-dashboard/src/lib/graphql.ts|ui-dashboard/src/hooks/*|ui-dashboard/src/lib/queries/*)
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
        ui-dashboard/src/components/*|ui-dashboard/src/app/*/_components/*)
          add_checklist "docs/pr-checklists/keyboard-a11y-controlled-widgets.md" "controlled dashboard component changed"
          ;;
      esac
      ;;
    indexer-envio/*)
      add_surface "indexer-envio"
      add_package_quality_commands "@mento-protocol/indexer-envio" "indexer-envio changed"
      case "$path" in
        indexer-envio/schema.graphql|indexer-envio/config.*.yaml|indexer-envio/src/*|indexer-envio/src/handlers/*|indexer-envio/src/rpc/*)
          add_command "pnpm indexer:codegen" "indexer schema/config/handler path changed"
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "indexer data flow changed"
          ;;
      esac
      case "$path" in
        indexer-envio/config.multichain.testnet.yaml)
          add_command "pnpm indexer:testnet:codegen" "testnet indexer config changed"
          ;;
      esac
      ;;
    metrics-bridge/*)
      add_surface "metrics-bridge"
      add_package_quality_commands "@mento-protocol/metrics-bridge" "metrics-bridge changed"
      ;;
    shared-config/*)
      add_surface "shared-config"
      add_package_quality_commands "@mento-protocol/monitoring-config" "shared-config changed"
      add_command "pnpm --filter @mento-protocol/monitoring-config build" "shared-config exports changed"
      ;;
    .github/workflows/*|.github/actions/*)
      add_surface "github-workflows"
      add_checklist "docs/pr-checklists/ci-workflow-gates.md" "GitHub Actions workflow/action changed"
      ;;
    terraform/*)
      add_surface "terraform"
      add_command "terraform -chdir=terraform fmt -check" "Terraform changed"
      add_checklist "docs/pr-checklists/terraform-cloudrun.md" "Terraform/Cloud Run path changed"
      ;;
    docs/*|README.md|AGENTS.md|*/AGENTS.md|BACKLOG.md)
      add_surface "docs"
      ;;
    scripts/*.sh)
      add_surface "scripts"
      add_command "bash -n $(quote_path "$path")" "shell script changed"
      ;;
    scripts/*|tools/*)
      add_surface "scripts"
      ;;
    package.json)
      add_surface "workspace"
      ;;
    pnpm-lock.yaml|pnpm-workspace.yaml)
      add_surface "workspace"
      add_package_quality_commands "@mento-protocol/ui-dashboard" "workspace dependency/config changed"
      add_package_quality_commands "@mento-protocol/indexer-envio" "workspace dependency/config changed"
      add_package_quality_commands "@mento-protocol/metrics-bridge" "workspace dependency/config changed"
      add_package_quality_commands "@mento-protocol/monitoring-config" "workspace dependency/config changed"
      ;;
  esac
done < "$changed_paths_file"

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
  for surface in "${surfaces[@]}"; do
    echo "- ${surface}"
  done
  echo
fi

if [[ ${#checklists[@]} -gt 0 ]]; then
  echo "Required checklist review:"
  for entry in "${checklists[@]}"; do
    echo "- ${entry%%|*} (${entry#*|})"
  done
  echo
fi

echo "Mapped safe local commands:"
for entry in "${commands[@]}"; do
  echo "- ${entry%%|*} (${entry#*|})"
done
echo

if [[ "$mode" == "dry-run" ]]; then
  echo "Dry run only. Re-run with --run to execute the mapped commands."
  exit 0
fi

failures=0
for entry in "${commands[@]}"; do
  command="${entry%%|*}"
  echo
  echo "+ ${command}"
  if ! bash -lc "$command"; then
    failures=$((failures + 1))
  fi
done

if [[ "$failures" -gt 0 ]]; then
  echo
  echo "${failures} mapped command(s) failed." >&2
  exit 1
fi

echo
echo "All mapped commands passed."
