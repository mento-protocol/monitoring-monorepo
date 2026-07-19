#!/usr/bin/env bash
if [[ "${AUTOREVIEW_TEST_SYSTEM_BASH:-}" != "1" && -x /bin/bash ]]; then
  export AUTOREVIEW_TEST_SYSTEM_BASH=1
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail
umask 077
unset SSL_CERT_DIR

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
original_path="$PATH"
node_bin="$(command -v node)"
trusted_fixture_parent=""
for fixture_parent_candidate in \
  "${TMPDIR:-/tmp}" \
  "${XDG_RUNTIME_DIR:-}" \
  "${HOME:-}" \
  "${repo_root%/*}"; do
  [[ -n "$fixture_parent_candidate" && -d "$fixture_parent_candidate" ]] || continue
  if "$node_bin" -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const candidate = fs.realpathSync(process.argv[1]);
    const repo = fs.realpathSync(process.argv[2]);
    const euid = BigInt(process.geteuid());
    if (candidate === repo || candidate.startsWith(repo + path.sep)) process.exit(1);
    fs.accessSync(candidate, fs.constants.W_OK);
    let current = candidate;
    for (;;) {
      const stat = fs.lstatSync(current, { bigint: true });
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (stat.uid !== 0n && stat.uid !== euid) ||
        (stat.mode & 0o022n) !== 0n
      ) process.exit(1);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  ' "$fixture_parent_candidate" "$repo_root"; then
    trusted_fixture_parent="$(cd "$fixture_parent_candidate" && pwd -P)"
    break
  fi
done
if [[ -z "$trusted_fixture_parent" ]]; then
  printf 'autoreview adversarial tests require a writable fixture parent with non-shared-writable ancestry\n' >&2
  exit 1
fi
tmp_dir="$(/usr/bin/mktemp -d "$trusted_fixture_parent/agent-autoreview-test.XXXXXX")"
tmp_dir="$(cd "$tmp_dir" && pwd -P)"
repo_untracked="$repo_root/.agent-autoreview-test-untracked.$$.$RANDOM.txt"
repo_node_test_dir="$repo_root/.agent-autoreview-node-test.$$.$RANDOM"
trap 'rm -rf "$tmp_dir" "$repo_untracked" "$repo_node_test_dir"' EXIT
node_exec_path="$("$node_bin" -p 'process.execPath')"
trusted_test_node_dir="$tmp_dir/trusted-test-node"
mkdir "$trusted_test_node_dir"
ln -s "$node_exec_path" "$trusted_test_node_dir/node"
PATH="$trusted_test_node_dir:$PATH"
export PATH

terminal_manifest_node_dir="$tmp_dir/terminal-manifest-node"
terminal_manifest_node="$terminal_manifest_node_dir/node"
terminal_manifest_node_source="$terminal_manifest_node_dir/node-proxy.c"
terminal_manifest_preload="$terminal_manifest_node_dir/preload.cjs"
mkdir "$terminal_manifest_node_dir"
cat >"$terminal_manifest_preload" <<'NODE'
'use strict';
const fs = require('node:fs');
const originalReadFileSync = fs.readFileSync;
if (process.env.AUTOREVIEW_TEST_TERMINAL_MANIFEST) {
  let descriptorReads = 0;
  fs.readFileSync = function (...args) {
    const content = Reflect.apply(originalReadFileSync, this, args);
    if (typeof args[0] === 'number' && ++descriptorReads === 2) {
      fs.linkSync(
        process.env.AUTOREVIEW_TEST_EARLY_FILE,
        process.env.AUTOREVIEW_TEST_EARLY_ALIAS,
      );
    }
    return content;
  };
}
if (process.env.AUTOREVIEW_TEST_DIRECTORY_BASELINE) {
  const originalLstatSync = fs.lstatSync;
  let changedDirectory = false;
  fs.lstatSync = function (...args) {
    const stat = Reflect.apply(originalLstatSync, this, args);
    if (
      !changedDirectory &&
      args[0] === process.env.AUTOREVIEW_TEST_DIRECTORY_PATH
    ) {
      changedDirectory = true;
      fs.chmodSync(
        args[0],
        Number.parseInt(process.env.AUTOREVIEW_TEST_DIRECTORY_MODE, 8),
      );
    }
    return stat;
  };
}
NODE
cat >"$terminal_manifest_node_source" <<'NODE_PROXY'
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int replace_direct_runtime_for_identity_test(int argc, char **argv) {
  const char *marker = getenv("AUTOREVIEW_TEST_DIRECT_IDENTITY_MARKER");
  const char *runtime;
  char *helper;
  char *backup;
  FILE *output;
  size_t helper_size;
  size_t backup_size;

  if (marker == NULL || argc < 4 || strcmp(argv[1], "-e") != 0 ||
      strstr(argv[2], "stat.dev") == NULL) {
    return 0;
  }
  runtime = argv[3];
  if (strstr(runtime, "/agent-autoreview-direct.") == NULL) {
    return 0;
  }
  helper_size = strlen(runtime) + strlen("/scripts/agent-autoreview.mjs") + 1;
  helper = malloc(helper_size);
  if (helper == NULL) {
    perror("malloc");
    return 127;
  }
  snprintf(helper, helper_size, "%s/scripts/agent-autoreview.mjs", runtime);
  if (access(helper, F_OK) != 0) {
    free(helper);
    return 0;
  }
  free(helper);

  backup_size = strlen(runtime) + strlen(".identity-test-original") + 1;
  backup = malloc(backup_size);
  if (backup == NULL) {
    perror("malloc");
    return 127;
  }
  snprintf(backup, backup_size, "%s.identity-test-original", runtime);
  if (rename(runtime, backup) != 0 || mkdir(runtime, 0700) != 0) {
    perror("replace direct runtime");
    free(backup);
    return 127;
  }
  free(backup);
  output = fopen(marker, "w");
  if (output == NULL) {
    perror("direct identity marker");
    return 127;
  }
  fprintf(output, "%s\n", runtime);
  fclose(output);
  return 0;
}

static void record_node_argv0(int argc, char **argv) {
  const char *marker = getenv("AUTOREVIEW_TEST_NODE_ARGV0_MARKER");
  FILE *output;

  if (marker == NULL || argc < 2 ||
      strstr(argv[1], "/scripts/agent-autoreview.mjs") == NULL) {
    return;
  }
  output = fopen(marker, "w");
  if (output == NULL) {
    return;
  }
  fprintf(output, "%s\n", argv[0]);
  fclose(output);
}

static void mark_hostile_cwd_node_use(void) {
  const char *marker = getenv("AUTOREVIEW_TEST_HOSTILE_CWD_MARKER");
  FILE *output;

  if (marker == NULL) {
    return;
  }
  output = fopen(marker, "w");
  if (output == NULL) {
    return;
  }
  fputs("hostile cwd Node executed\n", output);
  fclose(output);
}

static void mark_direct_tmp_use(int argc, char **argv) {
  const char *root = getenv("AUTOREVIEW_TEST_DIRECT_TMP_ROOT");
  const char *marker = getenv("AUTOREVIEW_TEST_DIRECT_TMP_MARKER");
  DIR *directory;
  struct dirent *entry;

  if (root == NULL || marker == NULL || argc < 2 ||
      strstr(argv[1], "/scripts/agent-autoreview.mjs") == NULL) {
    return;
  }
  directory = opendir(root);
  if (directory == NULL) {
    return;
  }
  while ((entry = readdir(directory)) != NULL) {
    if (strncmp(entry->d_name, "agent-autoreview-direct.", 24) == 0) {
      FILE *output = fopen(marker, "w");
      if (output != NULL) {
        fputs("caller TMPDIR contained the direct-helper runtime\n", output);
        fclose(output);
      }
      break;
    }
  }
  closedir(directory);
}

int main(int argc, char **argv) {
  const char *real_node = getenv("AUTOREVIEW_TEST_REAL_NODE");
  const char *preload = getenv("AUTOREVIEW_TEST_PRELOAD");
  const int inject_preload =
      argc > 2 && real_node != NULL && preload != NULL &&
      (getenv("AUTOREVIEW_TEST_TERMINAL_MANIFEST") != NULL ||
       getenv("AUTOREVIEW_TEST_DIRECTORY_BASELINE") != NULL) &&
      strcmp(argv[1], "-e") == 0 &&
      strstr(argv[2], "prepared-bundle file changed after hashing:") != NULL;
  const int injected_args = inject_preload ? 2 : 0;
  char **child_argv;
  int child_index = 0;

  if (real_node == NULL || real_node[0] != '/') {
    fputs("AUTOREVIEW_TEST_REAL_NODE must be an absolute path\n", stderr);
    return 127;
  }
  if (replace_direct_runtime_for_identity_test(argc, argv) != 0) {
    return 127;
  }
  mark_hostile_cwd_node_use();
  record_node_argv0(argc, argv);
  mark_direct_tmp_use(argc, argv);
  child_argv = calloc((size_t)argc + (size_t)injected_args + 1, sizeof(char *));
  if (child_argv == NULL) {
    perror("calloc");
    return 127;
  }
  if (inject_preload &&
      getenv("AUTOREVIEW_TEST_TERMINAL_MANIFEST") != NULL) {
    const char *bundle = argc > 3 ? argv[3] : NULL;
    char *early_file;
    size_t early_file_size;
    if (bundle == NULL) {
      fputs("terminal manifest fixture is missing its bundle path\n", stderr);
      return 127;
    }
    early_file_size = strlen(bundle) + strlen("/README.md") + 1;
    early_file = malloc(early_file_size);
    if (early_file == NULL) {
      perror("malloc");
      return 127;
    }
    snprintf(early_file, early_file_size, "%s/README.md", bundle);
    if (setenv("AUTOREVIEW_TEST_EARLY_FILE", early_file, 1) != 0) {
      perror("setenv");
      return 127;
    }
  }
  child_argv[child_index++] = (char *)real_node;
  if (inject_preload) {
    child_argv[child_index++] = "-r";
    child_argv[child_index++] = (char *)preload;
  }
  for (int index = 1; index < argc; ++index) {
    child_argv[child_index++] = argv[index];
  }
  child_argv[child_index] = NULL;
  execv(real_node, child_argv);
  perror("execv");
  free(child_argv);
  return 127;
}
NODE_PROXY
if [[ ! -x /usr/bin/cc ]]; then
  printf 'autoreview adversarial tests require /usr/bin/cc\n' >&2
  exit 1
fi
/usr/bin/cc -O2 -Wall -Wextra -o "$terminal_manifest_node" "$terminal_manifest_node_source"

TMPDIR="$tmp_dir" "$node_bin" "$repo_root/scripts/agent-autoreview-core.test.mjs"
TMPDIR="$tmp_dir" \
  "$node_bin" "$repo_root/scripts/agent-autoreview-target-guard.test.mjs"
adapter_help="$("$node_bin" "$repo_root/scripts/agent-autoreview.mjs" --help)"
if [[
  "$adapter_help" != *"--verify-bundle-dir <dir>"* ||
    "$adapter_help" != *"--expected-bundle-manifest <sha>"* ||
    "$adapter_help" != *"--serialize-untracked-file <path>"* ||
    "$adapter_help" != *"a repo adapter should use --prepare-bundle-dir"*
]]; then
  printf 'autoreview help omitted prepared-bundle replacement options\n' >&2
  exit 1
fi

helper="$tmp_dir/autoreview-helper"
trusted_direct_helper_dir="$tmp_dir/trusted-direct-helper"
trusted_direct_helper="$trusted_direct_helper_dir/agent-autoreview.mjs"
capture="$tmp_dir/args"
stdout="$tmp_dir/stdout"
stderr="$tmp_dir/stderr"

mkdir "$trusted_direct_helper_dir"
cp "$repo_root/scripts/agent-autoreview.mjs" \
  "$repo_root/scripts/agent-autoreview-core.mjs" \
  "$trusted_direct_helper_dir/"
chmod +x "$trusted_direct_helper"

cat >"$helper" <<'HELPER'
#!/usr/bin/env bash
if [[ "${1:-}" == "--source-snapshot-only" ]]; then
  printf 'invoked\n' >>"$AUTOREVIEW_CAPTURE.snapshot"
  snapshot_count="$(wc -l <"$AUTOREVIEW_CAPTURE.snapshot" | tr -d ' ')"
  if [[
    -n "${AUTOREVIEW_FAKE_MUTATE_ON_SECOND_SNAPSHOT:-}" &&
      "$snapshot_count" == "2" &&
      -s "$AUTOREVIEW_CAPTURE.bundle-output"
  ]]; then
    printf '# mutated after prompt validation\n' \
      >"$(cat "$AUTOREVIEW_CAPTURE.bundle-output")"
  fi
  if [[ -n "${AUTOREVIEW_FAKE_BAD_SNAPSHOT:-}" ]]; then
    printf 'not-a-source-snapshot\n'
    exit 0
  fi
  exec "$AUTOREVIEW_SNAPSHOT_HELPER" --source-snapshot-only
fi
if [[ "${1:-}" == "--serialize-untracked-file" ]]; then
  printf '%s\n' "${2:-}" >>"$AUTOREVIEW_CAPTURE.serialize"
  exec "$AUTOREVIEW_SNAPSHOT_HELPER" "$@"
fi
printf '%s\n' "$@" >"$AUTOREVIEW_CAPTURE"
pwd >"$AUTOREVIEW_CAPTURE.cwd"
bundle_output=""
bundle_output_display=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle-output)
      bundle_output="$2"
      shift 2
      ;;
    --bundle-output-display)
      bundle_output_display="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
if [[ -n "$bundle_output" ]]; then
  printf '%s\n' "$bundle_output" >"$AUTOREVIEW_CAPTURE.bundle-output"
fi
if [[ -n "$bundle_output" && -z "${AUTOREVIEW_FAKE_SKIP_BUNDLE_OUTPUT:-}" ]]; then
  mkdir -p "$(dirname "$bundle_output")"
  if [[ -n "${AUTOREVIEW_FAKE_MISSING_REVIEW_PASS:-}" ]]; then
    {
      printf '# Autoreview Prompt Index\n\n'
      printf '%s\n' '- Pass 1/1: autoreview-prompt.pass-01-of-01.md'
    } >"$bundle_output"
  elif [[ -n "${AUTOREVIEW_FAKE_INCOMPLETE_REVIEW_INDEX:-}" ]]; then
    {
      printf '\r\n'
      printf '\357\273\277# Autoreview Prompt Index\r\n\r\n'
      printf '%s\r\n' '- Pass 1/2: autoreview-prompt.pass-01-of-02.md'
    } >"$bundle_output"
    printf '# first pass only\n' \
      >"$(dirname "$bundle_output")/autoreview-prompt.pass-01-of-02.md"
  elif [[ -n "${AUTOREVIEW_FAKE_DUPLICATE_REVIEW_PASS:-}" ]]; then
    {
      printf '# Autoreview Prompt Index\n\n'
      printf '%s\n' '- Pass 1/2: autoreview-prompt.pass-01-of-02.md'
      printf '%s\n' '- Pass 2/2: autoreview-prompt.pass-01-of-02.md'
    } >"$bundle_output"
    printf '# duplicated pass\n' \
      >"$(dirname "$bundle_output")/autoreview-prompt.pass-01-of-02.md"
  elif [[ -n "${AUTOREVIEW_FAKE_EXTRA_REVIEW_PASS:-}" ]]; then
    {
      printf '# Autoreview Prompt Index\n\n'
      printf '%s\n' '- Pass 1/1: autoreview-prompt.pass-01-of-01.md'
    } >"$bundle_output"
    printf '# declared pass\n' \
      >"$(dirname "$bundle_output")/autoreview-prompt.pass-01-of-01.md"
    printf '# undeclared pass\n' \
      >"$(dirname "$bundle_output")/autoreview-prompt.pass-02-of-02.md"
  elif [[ -n "${AUTOREVIEW_FAKE_SELF_REVIEW_PASS:-}" ]]; then
    {
      printf '# Autoreview Prompt Index\n\n'
      printf '%s\n' '- Pass 1/1: autoreview-prompt.md'
    } >"$bundle_output"
  elif [[ -n "${AUTOREVIEW_FAKE_SINGLE_WITH_EXTRA_PASS:-}" ]]; then
    printf '# fake autoreview prompt\n' >"$bundle_output"
    printf '# undeclared pass\n' \
      >"$(dirname "$bundle_output")/autoreview-prompt.pass-01-of-01.md"
  else
    printf '# fake autoreview prompt\n' >"$bundle_output"
  fi
  reported_bundle_output="${bundle_output_display:-$bundle_output}"
  printf 'bundle_output: %s\n' "$reported_bundle_output"
  printf '{"bundle_output":"%s","bundle_outputs":["%s"]}\n' \
    "$reported_bundle_output" "$reported_bundle_output"
fi
if [[ -n "${AUTOREVIEW_FAKE_HARDLINK_SOURCE:-}" && -n "$bundle_output" ]]; then
  ln -- \
    "$AUTOREVIEW_FAKE_HARDLINK_SOURCE" \
    "${bundle_output%/*}/hardlinked-evidence.txt"
fi
if [[ -n "${AUTOREVIEW_FAKE_MUTATE_WRAPPER_EVIDENCE:-}" && -n "$bundle_output" ]]; then
  printf 'mutated wrapper evidence\n' >"${bundle_output%/*}/patches/branch.diff"
fi
if [[ -n "${AUTOREVIEW_MUTATE_PATH:-}" ]]; then
  printf 'concurrent mutation\n' >>"$AUTOREVIEW_MUTATE_PATH"
fi
if [[ -n "${AUTOREVIEW_FAKE_SWAP_STAGING:-}" && -n "$bundle_output" ]]; then
  staging_dir="${bundle_output%/*}"
  swapped_staging_dir="${staging_dir}.swapped-original"
  mv -- "$staging_dir" "$swapped_staging_dir"
  mkdir -- "$staging_dir"
  cp -R "$swapped_staging_dir/." "$staging_dir/"
  printf 'swapped staging tree\n' >"$staging_dir/swapped-evidence.txt"
fi
if [[ -n "${AUTOREVIEW_FAKE_CREATE_BUNDLE_DESTINATION:-}" ]]; then
  mkdir -- "$AUTOREVIEW_FAKE_CREATE_BUNDLE_DESTINATION"
fi
if [[ -n "${AUTOREVIEW_FAKE_UNSAFE_BUNDLE_PARENT:-}" ]]; then
  chmod 0777 "$AUTOREVIEW_FAKE_UNSAFE_BUNDLE_PARENT"
fi
if [[ -n "${AUTOREVIEW_FAKE_UNSAFE_BUNDLE_PARENT_ACL:-}" ]]; then
  /bin/chmod +a \
    "everyone allow add_file,delete_child" \
    "$AUTOREVIEW_FAKE_UNSAFE_BUNDLE_PARENT_ACL"
fi
if [[
  -n "${AUTOREVIEW_FAKE_UNSAFE_BUNDLE_ENTRY_ACL:-}" &&
    -n "$bundle_output"
]]; then
  /bin/chmod +a \
    "everyone allow write,delete" \
    "${bundle_output%/*}/README.md"
fi
printf 'fake helper complete\n'
HELPER
chmod +x "$helper"

run_adapter() {
  : >"$capture"
  : >"$capture.snapshot"
  : >"$capture.bundle-output"
  : >"$stdout"
  : >"$stderr"
  local env_args=(
    "PATH=$PATH"
    "HOME=$HOME"
    "TMPDIR=${TMPDIR:-/tmp}"
    "AUTOREVIEW_HELPER=$helper"
    "AUTOREVIEW_CAPTURE=$capture"
    "AUTOREVIEW_SNAPSHOT_HELPER=$repo_root/scripts/agent-autoreview.mjs"
  )
  while [[ $# -gt 0 && "$1" == *=* ]]; do
    env_args+=("$1")
    shift
  done

  local status=0
  env -i "${env_args[@]}" "$repo_root/scripts/agent-autoreview.sh" "$@" >"$stdout" 2>"$stderr" || status=$?
  if [[ "$status" -ne 0 ]]; then
    printf 'adapter failed\nstdout:\n%s\nstderr:\n%s\n' "$(cat "$stdout")" "$(cat "$stderr")" >&2
    return "$status"
  fi
}

run_adapter_expect_failure() {
  : >"$capture"
  : >"$capture.snapshot"
  : >"$capture.bundle-output"
  : >"$stdout"
  : >"$stderr"
  local env_args=(
    "PATH=$PATH"
    "HOME=$HOME"
    "TMPDIR=${TMPDIR:-/tmp}"
    "AUTOREVIEW_HELPER=$helper"
    "AUTOREVIEW_CAPTURE=$capture"
    "AUTOREVIEW_SNAPSHOT_HELPER=$repo_root/scripts/agent-autoreview.mjs"
  )
  while [[ $# -gt 0 && "$1" == *=* ]]; do
    env_args+=("$1")
    shift
  done

  set +e
  env -i "${env_args[@]}" "$repo_root/scripts/agent-autoreview.sh" "$@" >"$stdout" 2>"$stderr"
  local status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    printf 'expected adapter call from line %s to fail\nstdout:\n%s\nstderr:\n%s\n' \
      "${BASH_LINENO[0]:-unknown}" \
      "$(cat "$stdout")" \
      "$(cat "$stderr")" >&2
    exit 1
  fi
}

expect_args() {
  local expected="$1"
  local actual
  actual="$(cat "$capture")"
  if [[ "$actual" != "$expected" ]]; then
    printf 'unexpected helper args\nexpected:\n%s\nactual:\n%s\n' "$expected" "$actual" >&2
    exit 1
  fi
}

expect_capture_contains_line() {
  local expected="$1"
  if ! grep -Fxq -- "$expected" "$capture"; then
    printf 'expected captured args to contain line %s\nargs:\n%s\n' "$expected" "$(cat "$capture")" >&2
    exit 1
  fi
}

expect_capture_not_contains_line() {
  local unexpected="$1"
  if grep -Fxq -- "$unexpected" "$capture"; then
    printf 'expected captured args not to contain line %s\nargs:\n%s\n' "$unexpected" "$(cat "$capture")" >&2
    exit 1
  fi
}

expect_stderr_contains() {
  local expected="$1"
  if ! grep -Fq -- "$expected" "$stderr"; then
    printf 'expected stderr to contain %s\nstderr:\n%s\n' "$expected" "$(cat "$stderr")" >&2
    exit 1
  fi
}

expect_stdout_contains() {
  local expected="$1"
  if ! grep -Fq -- "$expected" "$stdout"; then
    printf 'expected stdout to contain %s\nstdout:\n%s\n' "$expected" "$(cat "$stdout")" >&2
    exit 1
  fi
}

expect_stdout_not_contains() {
  local unexpected="$1"
  if grep -Fq -- "$unexpected" "$stdout"; then
    printf 'expected stdout not to contain %s\nstdout:\n%s\n' "$unexpected" "$(cat "$stdout")" >&2
    exit 1
  fi
}

expect_empty_stderr() {
  if [[ -s "$stderr" ]]; then
    printf 'expected empty stderr, got:\n%s\n' "$(cat "$stderr")" >&2
    exit 1
  fi
}

expect_file_exists() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    printf 'expected file to exist: %s\n' "$path" >&2
    exit 1
  fi
}

expect_file_contains() {
  local path="$1"
  local expected="$2"
  if ! grep -Fq -- "$expected" "$path"; then
    printf 'expected %s to contain %s\nactual:\n%s\n' "$path" "$expected" "$(cat "$path")" >&2
    exit 1
  fi
}

expect_file_not_contains() {
  local path="$1"
  local unexpected="$2"
  if grep -Fq -- "$unexpected" "$path"; then
    printf 'expected %s not to contain %s\nactual:\n%s\n' "$path" "$unexpected" "$(cat "$path")" >&2
    exit 1
  fi
}

expect_prompt_policy_contains() {
  local path="$1"
  local expected="$2"
  local policy
  policy="$(awk '/^# Change Bundle$/ { exit } { print }' "$path")"
  if [[ "$policy" != *"$expected"* ]]; then
    printf 'expected prompt policy in %s to contain %s\npolicy:\n%s\n' \
      "$path" "$expected" "$policy" >&2
    exit 1
  fi
}

expect_prompt_policy_not_contains() {
  local path="$1"
  local unexpected="$2"
  local policy
  policy="$(awk '/^# Change Bundle$/ { exit } { print }' "$path")"
  if [[ "$policy" == *"$unexpected"* ]]; then
    printf 'expected prompt policy in %s not to contain %s\npolicy:\n%s\n' \
      "$path" "$unexpected" "$policy" >&2
    exit 1
  fi
}

run_default_adapter() {
  : >"$stdout"
  : >"$stderr"
  env -i \
    "PATH=$PATH" \
    "HOME=$HOME" \
    "TMPDIR=${TMPDIR:-/tmp}" \
    "AUTOREVIEW_HELPER=$trusted_direct_helper" \
    "$repo_root/scripts/agent-autoreview.sh" \
    --base origin/main --engine local --dry-run >"$stdout" 2>"$stderr"
}

run_default_adapter_in_clean_main() {
  local clean_repo="$tmp_dir/clean-main"
  mkdir "$clean_repo"
  git -C "$clean_repo" init -b main >/dev/null
  printf 'clean\n' >"$clean_repo/README.md"
  git -C "$clean_repo" add README.md
  git -C "$clean_repo" \
    -c user.name="Agent Test" \
    -c user.email="agent-test@example.invalid" \
    commit -m init >/dev/null

  : >"$stdout"
  : >"$stderr"
  (
    cd "$clean_repo"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "AUTOREVIEW_HELPER=$trusted_direct_helper" \
      "$repo_root/scripts/agent-autoreview.sh" \
      --engine local --dry-run >"$stdout" 2>"$stderr"
  )
}

run_default_adapter_with_inline_engine() {
  : >"$stdout"
  : >"$stderr"
  env -i \
    "PATH=$PATH" \
    "HOME=$HOME" \
    "TMPDIR=${TMPDIR:-/tmp}" \
    "AUTOREVIEW_HELPER=$trusted_direct_helper" \
    "$repo_root/scripts/agent-autoreview.sh" \
    --base origin/main --engine=local --dry-run >"$stdout" 2>"$stderr"
}

init_review_repo() {
  local review_repo="$1"
  mkdir "$review_repo"
  git -C "$review_repo" init -b main >/dev/null
  git -C "$review_repo" config user.name "Agent Test"
  git -C "$review_repo" config user.email "agent-test@example.invalid"
}

commit_review_repo() {
  local review_repo="$1"
  local message="$2"
  git -C "$review_repo" add -A
  git -C "$review_repo" commit -m "$message" >/dev/null
  if [[ "$(git -C "$review_repo" branch --show-current)" == "main" ]] &&
    ! git -C "$review_repo" rev-parse --verify --quiet \
      "refs/remotes/origin/main^{commit}" >/dev/null; then
    git -C "$review_repo" update-ref \
      refs/remotes/origin/main \
      HEAD
  fi
}

run_helper_in_repo() {
  local review_repo="$1"
  shift
  : >"$stdout"
  : >"$stderr"
  local status=0
  (
    cd "$review_repo"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "$repo_root/scripts/agent-autoreview.sh" \
      "$@" >"$stdout" 2>"$stderr"
  ) || status=$?
  if [[ "$status" -ne 0 ]]; then
    printf 'helper failed unexpectedly\nstdout:\n%s\nstderr:\n%s\n' \
      "$(cat "$stdout")" "$(cat "$stderr")" >&2
    return "$status"
  fi
}

run_helper_in_repo_expect_failure() {
  local review_repo="$1"
  shift
  : >"$stdout"
  : >"$stderr"
  local status=0
  (
    cd "$review_repo"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "$repo_root/scripts/agent-autoreview.sh" \
      "$@" >"$stdout" 2>"$stderr"
  ) || status=$?
  if [[ "$status" -eq 0 ]]; then
    printf 'expected helper to fail\nstdout:\n%s\nstderr:\n%s\n' "$(cat "$stdout")" "$(cat "$stderr")" >&2
    exit 1
  fi
}

run_node_helper_in_repo_expect_failure() {
  local review_repo="$1"
  shift
  : >"$stdout"
  : >"$stderr"
  local status=0
  (
    cd "$review_repo"
    env -i \
      "PATH=/bin:/usr/bin" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "GIT_CONFIG_GLOBAL=/dev/null" \
      "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" \
      "$@" >"$stdout" 2>"$stderr"
  ) || status=$?
  if [[ "$status" -eq 0 ]]; then
    printf 'expected helper to fail\nstdout:\n%s\nstderr:\n%s\n' "$(cat "$stdout")" "$(cat "$stderr")" >&2
    exit 1
  fi
}

run_helper_with_path_in_repo() {
  local review_repo="$1"
  local extra_path="$2"
  shift 2
  : >"$capture"
  : >"$stdout"
  : >"$stderr"
  local unrelated_secret_value="must-not-$$-reach-reviewer"
  local env_args=(
    "PATH=$extra_path:$PATH"
    "HOME=$HOME"
    "TMPDIR=${TMPDIR:-/tmp}"
    "AUTOREVIEW_CAPTURE=$capture"
    "AUTOREVIEW_FAKE_CAPTURE=$capture"
    "AUTOREVIEW_HEARTBEAT_SECONDS=${AUTOREVIEW_HEARTBEAT_SECONDS:-60}"
    "UNRELATED_SECRET=$unrelated_secret_value"
  )
  local key
  local value
  for key in \
    ANTHROPIC_VERTEX_PROJECT_ID \
    AWS_CONFIG_FILE \
    AWS_CONTAINER_AUTHORIZATION_TOKEN \
    AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE \
    AWS_CONTAINER_CREDENTIALS_FULL_URI \
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI \
    AWS_EC2_METADATA_DISABLED \
    AWS_ROLE_ARN \
    AWS_ROLE_SESSION_NAME \
    AWS_SDK_LOAD_CONFIG \
    AWS_SHARED_CREDENTIALS_FILE \
    AWS_WEB_IDENTITY_TOKEN_FILE \
    GOOGLE_APPLICATION_CREDENTIALS \
    SSL_CERT_DIR \
    SSL_CERT_FILE \
    AUTOREVIEW_FAKE_CREDENTIAL_PROCESS_MARKER \
    AUTOREVIEW_FAKE_MUTATE_AWS_CONFIG_SOURCE; do
    value="${!key-}"
    if [[ -n "$value" ]]; then
      env_args+=("$key=$value")
    fi
  done
  (
    cd "$review_repo"
    env -i "${env_args[@]}" \
      "$repo_root/scripts/agent-autoreview.sh" \
      "$@" >"$stdout" 2>"$stderr"
  )
}

run_helper_with_path_in_repo_expect_failure() {
  local review_repo="$1"
  local extra_path="$2"
  shift 2
  local status=0
  set +e
  run_helper_with_path_in_repo "$review_repo" "$extra_path" "$@"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    printf 'expected isolated helper to fail\nstdout:\n%s\nstderr:\n%s\n' "$(cat "$stdout")" "$(cat "$stderr")" >&2
    exit 1
  fi
}

run_parallel_tests_removed_regression() {
  local review_repo="$tmp_dir/parallel-tests"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"

  run_helper_in_repo_expect_failure "$review_repo" --mode local --engine local --parallel-tests true
  expect_stderr_contains "--parallel-tests was removed"
  expect_stderr_contains "pnpm agent:quality-gate --run"
}

run_review_target_metadata_regression() {
  local review_repo="$tmp_dir/review-target-metadata"
  local prompt="$tmp_dir/review-target-metadata.md"
  local base_oid
  local head_oid
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  base_oid="$(git -C "$review_repo" rev-parse HEAD)"
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  printf 'feature\n' >>"$review_repo/README.md"
  commit_review_repo "$review_repo" feature
  head_oid="$(git -C "$review_repo" rev-parse HEAD)"

  run_helper_in_repo "$review_repo" \
    --mode branch \
    --base main \
    --engine local \
    --prepare-only \
    --bundle-output "$prompt"
  expect_file_contains \
    "$prompt" \
    "Review target: branch base main (frozen base $base_oid; frozen reviewed head $head_oid)"
  expect_file_not_contains "$prompt" "frozen commit $base_oid"
  expect_stdout_contains "ref: $base_oid"
  expect_stdout_contains "head: $head_oid"
  expect_empty_stderr
}

run_branch_diff_check_regression() {
  local review_repo="$tmp_dir/branch-diff-check"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  printf 'bad trailing   \n' >>"$review_repo/README.md"
  commit_review_repo "$review_repo" "add trailing whitespace"

  run_helper_in_repo_expect_failure "$review_repo" --mode branch --base main --engine local
  expect_stdout_contains "Diff contains whitespace"
  expect_empty_stderr
}

run_local_deleted_reference_regression() {
  local review_repo="$tmp_dir/deleted-reference"
  init_review_repo "$review_repo"
  mkdir "$review_repo/docs"
  printf 'old docs\n' >"$review_repo/docs/old.md"
  printf 'See docs/old.md\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  rm "$review_repo/docs/old.md"
  printf 'No old docs\n' >"$review_repo/README.md"

  run_helper_in_repo "$review_repo" --mode local --engine local
  expect_stdout_contains "autoreview clean"
  expect_stdout_not_contains "Deleted file is still referenced"
  expect_empty_stderr
}

run_commit_target_reads_selected_ref_regression() {
  local review_repo="$tmp_dir/commit-target"
  init_review_repo "$review_repo"
  mkdir -p "$review_repo/.github/workflows"
  cat >"$review_repo/.github/workflows/terraform-drift.yml" <<'BAD_WORKFLOW'
name: drift
jobs:
  drift:
    steps:
      - run: terraform plan | tee /tmp/tf-plan.txt
BAD_WORKFLOW
  commit_review_repo "$review_repo" "add unsafe drift workflow"
  local unsafe_commit
  unsafe_commit="$(git -C "$review_repo" rev-parse HEAD)"
  cat >"$review_repo/.github/workflows/terraform-drift.yml" <<'FIXED_WORKFLOW'
name: drift
jobs:
  drift:
    steps:
      - run: terraform plan >/tmp/tf-plan.raw
FIXED_WORKFLOW
  commit_review_repo "$review_repo" "fix drift workflow"

  run_helper_in_repo_expect_failure "$review_repo" --mode commit --commit "$unsafe_commit" --engine local
  expect_stdout_contains "autoreview target: commit"
  expect_stdout_contains "Drift workflow logs raw Terraform plan output"
  expect_empty_stderr
}

run_non_utf8_git_blob_regression() {
  local review_repo="$tmp_dir/non-utf8-git-blob"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  printf '\377\376\375' >"$review_repo/README.md"
  commit_review_repo "$review_repo" "add non-UTF-8 README"

  run_helper_in_repo "$review_repo" --mode branch --base main --engine local
  expect_stdout_contains "autoreview target: branch"
  expect_stdout_contains "autoreview clean"
  expect_empty_stderr
}

run_non_utf8_git_path_regression() {
  local review_repo="$tmp_dir/non-utf8-git-path"
  local fake_bin="$tmp_dir/non-utf8-git-path-bin"
  local head_oid
  local real_git
  real_git="$(command -v git)"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  printf 'feature\n' >"$review_repo/feature.txt"
  commit_review_repo "$review_repo" feature
  head_oid="$(git -C "$review_repo" rev-parse HEAD)"
  mkdir "$fake_bin"
  cat >"$fake_bin/git" <<GIT
#!/usr/bin/env bash
is_status=0
is_nul=0
for arg in "\$@"; do
  [[ "\$arg" == "status" ]] && is_status=1
  [[ "\$arg" == "-z" ]] && is_nul=1
done
if [[ "\$is_status" -eq 1 && "\$is_nul" -eq 1 ]]; then
  printf '# branch.oid $head_oid\0# branch.head feature\0? ignored-\377.txt\0'
  exit 0
fi
exec "$real_git" "\$@"
GIT
  chmod +x "$fake_bin/git"

  run_helper_with_path_in_repo "$review_repo" "$fake_bin" \
    --mode branch --base main --engine local
  expect_stdout_contains "autoreview target: branch"
  expect_stdout_contains "autoreview clean"
  expect_empty_stderr
}

run_auto_dirty_branch_regression() {
  local review_repo="$tmp_dir/dirty-branch"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  printf 'branch trailing   \n' >>"$review_repo/README.md"
  commit_review_repo "$review_repo" "add branch change"
  printf 'local clean\n' >"$review_repo/local.txt"

  run_helper_in_repo_expect_failure "$review_repo" --base main --engine local
  expect_stdout_contains "autoreview target: branch-local"
  expect_stdout_contains "Diff contains whitespace"
  expect_empty_stderr
}

run_branch_local_diff_check_fixed_regression() {
  local review_repo="$tmp_dir/dirty-branch-fixed"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  printf 'branch trailing   \n' >>"$review_repo/README.md"
  commit_review_repo "$review_repo" "add branch whitespace"
  printf 'base\nbranch trailing\n' >"$review_repo/README.md"

  run_helper_in_repo "$review_repo" --base main --engine local
  expect_stdout_contains "autoreview target: branch-local"
  expect_stdout_contains "autoreview clean"
  expect_stdout_not_contains "Diff contains whitespace"
  expect_empty_stderr
}

run_branch_local_deleted_reference_regression() {
  local review_repo="$tmp_dir/branch-local-deleted-reference"
  init_review_repo "$review_repo"
  mkdir "$review_repo/docs"
  printf 'old docs\n' >"$review_repo/docs/old.md"
  printf 'See docs/old.md\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  rm "$review_repo/docs/old.md"
  commit_review_repo "$review_repo" "delete stale docs without reference fix"
  printf 'local clean\n' >"$review_repo/local.txt"

  run_helper_in_repo_expect_failure "$review_repo" --base main --engine local
  expect_stdout_contains "autoreview target: branch-local"
  expect_stdout_contains "Deleted file is still referenced"
  expect_empty_stderr
}

run_branch_local_deleted_reference_fixed_regression() {
  local review_repo="$tmp_dir/branch-local-deleted-reference-fixed"
  init_review_repo "$review_repo"
  mkdir "$review_repo/docs"
  printf 'old docs\n' >"$review_repo/docs/old.md"
  printf 'See docs/old.md\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  rm "$review_repo/docs/old.md"
  commit_review_repo "$review_repo" "delete stale docs without reference fix"
  printf 'No old docs\n' >"$review_repo/README.md"

  run_helper_in_repo "$review_repo" --base main --engine local
  expect_stdout_contains "autoreview target: branch-local"
  expect_stdout_contains "autoreview clean"
  expect_stdout_not_contains "Deleted file is still referenced"
  expect_empty_stderr
}

run_requested_codex_missing_regression() {
  local review_repo="$tmp_dir/missing-codex"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"

  run_node_helper_in_repo_expect_failure "$review_repo" --mode local --engine codex
  expect_stdout_contains "autoreview target: local"
  expect_stderr_contains "codex CLI is not available"
  expect_stdout_not_contains "autoreview clean"
}

run_claude_no_tools_regression() {
  local review_repo="$tmp_dir/claude-no-tools"
  local fake_bin="$tmp_dir/fake-claude-bin"
  local aws_config_file="$tmp_dir/aws-config-source/shared-config"
  local aws_credentials_file="$tmp_dir/aws-credentials-source/shared-config"
  local aws_container_auth_file="$tmp_dir/aws-container-authorization"
  local aws_web_identity_target="$tmp_dir/aws-web-identity-token"
  local aws_web_identity_file="$tmp_dir/aws-web-identity-token-link"
  local google_application_credentials="$tmp_dir/google-application-credentials.json"
  local ssl_cert_dir="$review_repo/repo-controlled-certificates"
  local ssl_cert_file="$tmp_dir/reviewer-ca.pem"
  local credential_process_marker="$tmp_dir/credential-process-ran"
  local canonical_aws_config_file
  local canonical_aws_credentials_file
  local canonical_aws_container_auth_file
  local canonical_aws_web_identity_file
  local canonical_google_application_credentials
  local canonical_ssl_cert_file
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"
  mkdir -p "$(dirname "$aws_config_file")" "$(dirname "$aws_credentials_file")"
  printf '[default]\nregion = us-east-1\n' >"$aws_config_file"
  printf '[default]\naws_access_key_id = test\n' >"$aws_credentials_file"
  printf 'container-authorization-placeholder\n' >"$aws_container_auth_file"
  printf 'web-identity-placeholder\n' >"$aws_web_identity_target"
  printf '{"type":"external_account"}\n' >"$google_application_credentials"
  mkdir "$ssl_cert_dir"
  printf '%s\n' '-----BEGIN CERTIFICATE-----' 'placeholder-ca' '-----END CERTIFICATE-----' >"$ssl_cert_file"
  chmod 0600 \
    "$aws_config_file" \
    "$aws_credentials_file" \
    "$aws_container_auth_file" \
    "$aws_web_identity_target" \
    "$google_application_credentials"
  chmod 0644 "$ssl_cert_file"
  ln -s "$(basename "$aws_web_identity_target")" "$aws_web_identity_file"
  canonical_aws_config_file="$(cd "$(dirname "$aws_config_file")" && printf '%s/%s' "$(pwd -P)" "$(basename "$aws_config_file")")"
  canonical_aws_credentials_file="$(cd "$(dirname "$aws_credentials_file")" && printf '%s/%s' "$(pwd -P)" "$(basename "$aws_credentials_file")")"
  canonical_aws_container_auth_file="$(cd "$(dirname "$aws_container_auth_file")" && printf '%s/%s' "$(pwd -P)" "$(basename "$aws_container_auth_file")")"
  canonical_aws_web_identity_file="$(cd "$(dirname "$aws_web_identity_target")" && printf '%s/%s' "$(pwd -P)" "$(basename "$aws_web_identity_target")")"
  canonical_google_application_credentials="$(cd "$(dirname "$google_application_credentials")" && printf '%s/%s' "$(pwd -P)" "$(basename "$google_application_credentials")")"
  canonical_ssl_cert_file="$(cd "$(dirname "$ssl_cert_file")" && printf '%s/%s' "$(pwd -P)" "$(basename "$ssl_cert_file")")"
  mkdir "$fake_bin"
  cat >"$fake_bin/claude" <<'CLAUDE'
#!/usr/bin/env bash
printf 'invoked\n' >"$AUTOREVIEW_FAKE_CAPTURE.invoked"
if [[ -n "${AUTOREVIEW_FAKE_MUTATE_AWS_CONFIG_SOURCE:-}" ]]; then
  printf '[default]\ncredential_process = attacker-controlled-command\n' \
    >"$AUTOREVIEW_FAKE_MUTATE_AWS_CONFIG_SOURCE"
fi
if [[ "${1:-}" == "--version" ]]; then
  printf '2.1.210\n'
  exit 0
fi
if [[ "${1:-}" == "--help" ]]; then
  printf '%s\n' --safe-mode --setting-sources --strict-mcp-config --disallowedTools --tools
  exit 0
fi
printf '%s\n' "$@" >"$AUTOREVIEW_FAKE_CAPTURE"
pwd >"$AUTOREVIEW_FAKE_CAPTURE.cwd"
env >"$AUTOREVIEW_FAKE_CAPTURE.env"
node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const keys = [
  "AWS_CONFIG_FILE",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "SSL_CERT_FILE",
];
const capture = process.env.AUTOREVIEW_FAKE_CAPTURE;
let metadata = "";
for (const key of keys) {
  const value = process.env[key];
  if (!value) continue;
  const fileStat = fs.lstatSync(value, { bigint: true });
  const parentStat = fs.lstatSync(path.dirname(value), { bigint: true });
  metadata += `${key}=${value}\n`;
  metadata += `${key}_FILE=${fileStat.isFile()}\n`;
  metadata += `${key}_SYMLINK=${fileStat.isSymbolicLink()}\n`;
  metadata += `${key}_MODE=${Number(fileStat.mode & 0o777n).toString(8)}\n`;
  metadata += `${key}_NLINK=${fileStat.nlink}\n`;
  metadata += `${key}_PARENT_MODE=${Number(parentStat.mode & 0o777n).toString(8)}\n`;
  fs.writeFileSync(`${capture}.${key}`, fs.readFileSync(value));
}
fs.writeFileSync(`${capture}.snapshots`, metadata);
NODE
if [[ -n "${AUTOREVIEW_FAKE_CREDENTIAL_PROCESS_MARKER:-}" ]] && \
  /usr/bin/grep -q 'credential_process[[:space:]]*=' "$AWS_CONFIG_FILE"; then
  : >"$AUTOREVIEW_FAKE_CREDENTIAL_PROCESS_MARKER"
fi
cat >/dev/null
cat <<'JSON'
{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}
JSON
CLAUDE
  chmod +x "$fake_bin/claude"

  ANTHROPIC_VERTEX_PROJECT_ID="autoreview-vertex-project" \
    AWS_CONFIG_FILE="$aws_config_file" \
    AWS_CONTAINER_AUTHORIZATION_TOKEN="placeholder-auth-token" \
    AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE="$aws_container_auth_file" \
    AWS_CONTAINER_CREDENTIALS_FULL_URI="http://169.254.170.2/v2/credentials" \
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI="/v2/credentials" \
    AWS_EC2_METADATA_DISABLED="true" \
    AWS_ROLE_ARN="arn:aws:iam::123456789012:role/autoreview-test" \
    AWS_ROLE_SESSION_NAME="autoreview-session" \
    AWS_SDK_LOAD_CONFIG="1" \
    AWS_SHARED_CREDENTIALS_FILE="$aws_credentials_file" \
    AWS_WEB_IDENTITY_TOKEN_FILE="$aws_web_identity_file" \
    GOOGLE_APPLICATION_CREDENTIALS="$google_application_credentials" \
    SSL_CERT_FILE="$ssl_cert_file" \
    run_helper_with_path_in_repo "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  expect_capture_contains_line "--tools"
  expect_capture_contains_line "--mcp-config"
  expect_capture_contains_line '{"mcpServers":{}}'
  expect_capture_contains_line "--strict-mcp-config"
  expect_capture_contains_line "--safe-mode"
  expect_capture_contains_line "--setting-sources"
  expect_capture_contains_line "--disallowedTools"
  expect_capture_not_contains_line "--allowedTools"
  expect_capture_not_contains_line "--allowed-tools"
  expect_capture_not_contains_line "Read,Grep,Glob"
  expect_file_not_contains "$capture.cwd" "$review_repo"
  expect_file_contains "$capture.cwd" "autoreview-claude-workspace."
  expect_file_contains "$capture.env" "ANTHROPIC_VERTEX_PROJECT_ID=autoreview-vertex-project"
  expect_file_contains "$capture.env" "AWS_CONTAINER_AUTHORIZATION_TOKEN=placeholder-auth-token"
  expect_file_contains "$capture.env" "AWS_CONTAINER_CREDENTIALS_FULL_URI=http://169.254.170.2/v2/credentials"
  expect_file_contains "$capture.env" "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/v2/credentials"
  expect_file_contains "$capture.env" "AWS_EC2_METADATA_DISABLED=true"
  expect_file_contains "$capture.env" "AWS_ROLE_ARN=arn:aws:iam::123456789012:role/autoreview-test"
  expect_file_contains "$capture.env" "AWS_ROLE_SESSION_NAME=autoreview-session"
  expect_file_contains "$capture.env" "AWS_SDK_LOAD_CONFIG=1"
  local key
  local snapshot_path
  local expected_source
  local aws_config_snapshot
  local aws_credentials_snapshot
  for key in \
    AWS_CONFIG_FILE \
    AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE \
    AWS_SHARED_CREDENTIALS_FILE \
    AWS_WEB_IDENTITY_TOKEN_FILE \
    GOOGLE_APPLICATION_CREDENTIALS \
    SSL_CERT_FILE; do
    snapshot_path="$(sed -n "s/^${key}=//p" "$capture.snapshots")"
    if [[ -z "$snapshot_path" ]]; then
      printf 'Claude did not receive a snapshot for %s\n' "$key" >&2
      exit 1
    fi
    case "$key" in
      AWS_CONFIG_FILE)
        expected_source="$canonical_aws_config_file"
        aws_config_snapshot="$snapshot_path"
        ;;
      AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE)
        expected_source="$canonical_aws_container_auth_file"
        ;;
      AWS_SHARED_CREDENTIALS_FILE)
        expected_source="$canonical_aws_credentials_file"
        aws_credentials_snapshot="$snapshot_path"
        ;;
      AWS_WEB_IDENTITY_TOKEN_FILE)
        expected_source="$canonical_aws_web_identity_file"
        ;;
      GOOGLE_APPLICATION_CREDENTIALS)
        expected_source="$canonical_google_application_credentials"
        ;;
      SSL_CERT_FILE)
        expected_source="$canonical_ssl_cert_file"
        ;;
    esac
    if [[ "$snapshot_path" == "$expected_source" ]]; then
      printf 'Claude received the original %s path instead of a snapshot\n' "$key" >&2
      exit 1
    fi
    expect_file_contains "$capture.snapshots" "${key}_FILE=true"
    expect_file_contains "$capture.snapshots" "${key}_SYMLINK=false"
    expect_file_contains "$capture.snapshots" "${key}_MODE=600"
    expect_file_contains "$capture.snapshots" "${key}_NLINK=1"
    expect_file_contains "$capture.snapshots" "${key}_PARENT_MODE=700"
    expect_file_contains "$capture.env" "${key}=$snapshot_path"
    expect_file_not_contains "$capture.env" "${key}=$expected_source"
    cmp "$capture.$key" "$expected_source"
    if [[ -e "$snapshot_path" ]]; then
      printf 'Claude %s snapshot survived engine cleanup: %s\n' "$key" "$snapshot_path" >&2
      exit 1
    fi
  done
  if [[ "$aws_config_snapshot" == "$aws_credentials_snapshot" ]]; then
    printf 'same-basename AWS inputs collided in the snapshot directory\n' >&2
    exit 1
  fi
  expect_file_not_contains "$capture.env" "UNRELATED_SECRET"
  expect_stdout_contains "autoreview clean"
  expect_empty_stderr

  printf '[default]\nregion = us-east-1\n' >"$aws_config_file"
  rm -f "$capture.invoked" "$credential_process_marker"
  AUTOREVIEW_FAKE_CREDENTIAL_PROCESS_MARKER="$credential_process_marker" \
    AUTOREVIEW_FAKE_MUTATE_AWS_CONFIG_SOURCE="$aws_config_file" \
    AWS_CONFIG_FILE="$aws_config_file" \
    run_helper_with_path_in_repo "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  expect_file_contains "$capture.AWS_CONFIG_FILE" "region = us-east-1"
  expect_file_not_contains "$capture.AWS_CONFIG_FILE" "credential_process"
  expect_file_contains "$aws_config_file" "credential_process = attacker-controlled-command"
  if [[ -e "$credential_process_marker" ]]; then
    printf 'Claude observed a post-snapshot AWS credential_process mutation\n' >&2
    exit 1
  fi
  expect_stdout_contains "autoreview clean"
  expect_empty_stderr

  printf '[default]\ncredential_process = attacker-controlled-command\n' >"$aws_config_file"
  chmod 0666 "$aws_config_file"
  rm -f "$capture.invoked" "$credential_process_marker"
  TMPDIR="$tmp_dir" \
    AUTOREVIEW_FAKE_CREDENTIAL_PROCESS_MARKER="$credential_process_marker" \
    AWS_CONFIG_FILE="$aws_config_file" \
    SSL_CERT_FILE="$ssl_cert_file" \
    run_helper_with_path_in_repo_expect_failure "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  chmod 0600 "$aws_config_file"
  expect_stderr_contains "AWS_CONFIG_FILE must point to a trusted regular file"
  if [[ -e "$capture.invoked" || -e "$credential_process_marker" ]]; then
    printf 'Claude executed with an untrusted AWS credential_process config\n' >&2
    exit 1
  fi
  if find "$tmp_dir" -maxdepth 1 -type d -name 'autoreview-claude-workspace.*' -print -quit | grep -q .; then
    printf 'Claude credential snapshot workspace survived setup failure\n' >&2
    exit 1
  fi

  local fifo_credential_file="$tmp_dir/aws-config-fifo"
  local fifo_helper_pid
  local fifo_completed=0
  mkfifo "$fifo_credential_file"
  chmod 0600 "$fifo_credential_file"
  rm -f "$capture.invoked"
  (
    AWS_CONFIG_FILE="$fifo_credential_file" \
      run_helper_with_path_in_repo_expect_failure "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  ) &
  fifo_helper_pid=$!
  for _ in {1..200}; do
    if ! kill -0 "$fifo_helper_pid" 2>/dev/null; then
      fifo_completed=1
      break
    fi
    sleep 0.05
  done
  if [[ "$fifo_completed" -eq 0 ]]; then
    "$node_bin" -e '
      const fs = require("node:fs");
      try {
        const fd = fs.openSync(
          process.argv[1],
          fs.constants.O_WRONLY | fs.constants.O_NONBLOCK,
        );
        fs.writeSync(fd, "unblock-regression\n");
        fs.closeSync(fd);
      } catch {}
    ' "$fifo_credential_file"
  fi
  wait "$fifo_helper_pid"
  if [[ "$fifo_completed" -eq 0 ]]; then
    printf 'AWS config FIFO blocked before regular-file validation\n' >&2
    exit 1
  fi
  expect_stderr_contains "AWS_CONFIG_FILE must point to a trusted regular file"
  if [[ -e "$capture.invoked" ]]; then
    printf 'Claude executed with an AWS config FIFO\n' >&2
    exit 1
  fi
  rm "$fifo_credential_file"

  local unsafe_credential_parent="$tmp_dir/unsafe-credential-parent"
  local unsafe_credential_file="$unsafe_credential_parent/aws-config"
  mkdir "$unsafe_credential_parent"
  printf '[default]\nregion = us-east-1\n' >"$unsafe_credential_file"
  chmod 0600 "$unsafe_credential_file"
  chmod 0777 "$unsafe_credential_parent"
  rm -f "$capture.invoked"
  AWS_CONFIG_FILE="$unsafe_credential_file" \
    run_helper_with_path_in_repo_expect_failure "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  chmod 0700 "$unsafe_credential_parent"
  expect_stderr_contains "AWS_CONFIG_FILE has non-sticky shared-writable ancestry"
  if [[ -e "$capture.invoked" ]]; then
    printf 'Claude executed through unsafe AWS config ancestry\n' >&2
    exit 1
  fi

  if [[ "$(/usr/bin/uname -s)" == "Darwin" ]]; then
    printf '[default]\nregion = us-east-1\n' >"$aws_config_file"
    /bin/chmod +a 'everyone allow write,delete' "$aws_config_file"
    rm -f "$capture.invoked"
    AWS_CONFIG_FILE="$aws_config_file" \
      run_helper_with_path_in_repo_expect_failure "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
    /bin/chmod -N "$aws_config_file"
    expect_stderr_contains "AWS_CONFIG_FILE must point to a trusted regular file"
    if [[ -e "$capture.invoked" ]]; then
      printf 'Claude executed with a write-ACL AWS config\n' >&2
      exit 1
    fi

    local acl_credential_parent="$tmp_dir/acl-credential-parent"
    local acl_credential_file="$acl_credential_parent/aws-config"
    mkdir "$acl_credential_parent"
    printf '[default]\nregion = us-east-1\n' >"$acl_credential_file"
    chmod 0600 "$acl_credential_file"
    /bin/chmod +a \
      'everyone allow add_file,delete_child' \
      "$acl_credential_parent"
    rm -f "$capture.invoked"
    AWS_CONFIG_FILE="$acl_credential_file" \
      run_helper_with_path_in_repo_expect_failure "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
    /bin/chmod -N "$acl_credential_parent"
    expect_stderr_contains "AWS_CONFIG_FILE has write-granting ACL ancestry"
    if [[ -e "$capture.invoked" ]]; then
      printf 'Claude executed through write-ACL AWS config ancestry\n' >&2
      exit 1
    fi
  fi

  printf 'repo-controlled-token\n' >"$review_repo/.git/aws-web-identity-token"
  rm -f "$capture.invoked"
  AWS_WEB_IDENTITY_TOKEN_FILE="$review_repo/.git/aws-web-identity-token" \
    run_helper_with_path_in_repo_expect_failure "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  expect_stderr_contains "AWS_WEB_IDENTITY_TOKEN_FILE must point to an existing regular file outside the reviewed repository"
  if [[ -e "$capture.invoked" ]]; then
    printf 'Claude executed despite a repo-contained AWS credential path\n' >&2
    exit 1
  fi

  printf '{"type":"external_account"}\n' >"$review_repo/.git/google-application-credentials.json"
  rm -f "$capture.invoked"
  GOOGLE_APPLICATION_CREDENTIALS="$review_repo/.git/google-application-credentials.json" \
    run_helper_with_path_in_repo_expect_failure "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  expect_stderr_contains "GOOGLE_APPLICATION_CREDENTIALS must point to an existing regular file outside the reviewed repository"
  if [[ -e "$capture.invoked" ]]; then
    printf 'Claude executed despite a repo-contained Google credential path\n' >&2
    exit 1
  fi

  rm -f "$capture.invoked"
  TMPDIR="$tmp_dir" \
    SSL_CERT_DIR="$ssl_cert_dir" \
    run_helper_with_path_in_repo_expect_failure "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  expect_stderr_contains "SSL_CERT_DIR cannot be safely preserved for semantic autoreview"
  if [[ -e "$capture.invoked" ]]; then
    printf 'Claude executed with SSL_CERT_DIR enabled\n' >&2
    exit 1
  fi
  if find "$tmp_dir" -maxdepth 1 -type d -name 'autoreview-claude-workspace.*' -print -quit | grep -q .; then
    printf 'Claude workspace survived SSL_CERT_DIR rejection\n' >&2
    exit 1
  fi
}

run_codex_isolation_regression() {
  local review_repo="$tmp_dir/codex-isolation"
  local fake_bin="$tmp_dir/fake-codex-bin"
  local ssl_cert_dir="$tmp_dir/codex-reviewer-certificates"
  local ssl_cert_file="$tmp_dir/codex-reviewer-ca.pem"
  local ssl_snapshot_path
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"
  printf '%s\n' '-----BEGIN CERTIFICATE-----' 'codex-placeholder-ca' '-----END CERTIFICATE-----' >"$ssl_cert_file"
  chmod 0644 "$ssl_cert_file"
  mkdir "$fake_bin" "$ssl_cert_dir"
  cat >"$fake_bin/codex" <<'CODEX'
#!/usr/bin/env bash
printf 'invoked\n' >"$AUTOREVIEW_FAKE_CAPTURE.codex-invoked"
printf '%s\n' "$@" >"$AUTOREVIEW_FAKE_CAPTURE"
pwd >"$AUTOREVIEW_FAKE_CAPTURE.cwd"
env >"$AUTOREVIEW_FAKE_CAPTURE.env"
node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const value = process.env.SSL_CERT_FILE;
const fileStat = fs.lstatSync(value, { bigint: true });
const parentStat = fs.lstatSync(path.dirname(value), { bigint: true });
const metadata = [
  `SSL_CERT_FILE=${value}`,
  `SSL_CERT_FILE_FILE=${fileStat.isFile()}`,
  `SSL_CERT_FILE_SYMLINK=${fileStat.isSymbolicLink()}`,
  `SSL_CERT_FILE_MODE=${Number(fileStat.mode & 0o777n).toString(8)}`,
  `SSL_CERT_FILE_NLINK=${fileStat.nlink}`,
  `SSL_CERT_FILE_PARENT_MODE=${Number(parentStat.mode & 0o777n).toString(8)}`,
  "",
].join("\n");
fs.writeFileSync(`${process.env.AUTOREVIEW_FAKE_CAPTURE}.codex-ssl`, metadata);
fs.writeFileSync(
  `${process.env.AUTOREVIEW_FAKE_CAPTURE}.codex-ssl-content`,
  fs.readFileSync(value),
);
NODE
output=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o)
      output="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
cat >/dev/null
printf '%s\n' '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}' >"$output"
CODEX
  chmod +x "$fake_bin/codex"

  SSL_CERT_FILE="$ssl_cert_file" \
    run_helper_with_path_in_repo "$review_repo" "$fake_bin" --mode local --engine codex
  expect_capture_contains_line "--ask-for-approval"
  expect_capture_contains_line "never"
  expect_capture_contains_line "--ignore-user-config"
  expect_capture_contains_line "--ignore-rules"
  expect_capture_contains_line "--skip-git-repo-check"
  expect_capture_contains_line "project_doc_max_bytes=0"
  expect_capture_contains_line "features.hooks=false"
  expect_capture_contains_line "features.plugins=false"
  expect_capture_contains_line "skills.include_instructions=false"
  expect_capture_not_contains_line "--search"
  expect_file_not_contains "$capture.cwd" "$review_repo"
  expect_file_contains "$capture.cwd" "/workspace"
  ssl_snapshot_path="$(sed -n 's/^SSL_CERT_FILE=//p' "$capture.codex-ssl")"
  if [[ -z "$ssl_snapshot_path" || "$ssl_snapshot_path" == "$ssl_cert_file" ]]; then
    printf 'Codex did not receive a private SSL_CERT_FILE snapshot\n' >&2
    exit 1
  fi
  expect_file_contains "$capture.codex-ssl" "SSL_CERT_FILE_FILE=true"
  expect_file_contains "$capture.codex-ssl" "SSL_CERT_FILE_SYMLINK=false"
  expect_file_contains "$capture.codex-ssl" "SSL_CERT_FILE_MODE=600"
  expect_file_contains "$capture.codex-ssl" "SSL_CERT_FILE_NLINK=1"
  expect_file_contains "$capture.codex-ssl" "SSL_CERT_FILE_PARENT_MODE=700"
  expect_file_contains "$capture.env" "SSL_CERT_FILE=$ssl_snapshot_path"
  expect_file_not_contains "$capture.env" "SSL_CERT_FILE=$ssl_cert_file"
  cmp "$capture.codex-ssl-content" "$ssl_cert_file"
  if [[ -e "$ssl_snapshot_path" ]]; then
    printf 'Codex SSL_CERT_FILE snapshot survived engine cleanup\n' >&2
    exit 1
  fi
  expect_file_not_contains "$capture.env" "UNRELATED_SECRET"
  expect_stdout_contains "autoreview clean"
  expect_empty_stderr

  rm -f "$capture.codex-invoked"
  TMPDIR="$tmp_dir" \
    SSL_CERT_DIR="$ssl_cert_dir" \
    SSL_CERT_FILE="$ssl_cert_file" \
    run_helper_with_path_in_repo_expect_failure "$review_repo" "$fake_bin" --mode local --engine codex
  expect_stderr_contains "SSL_CERT_DIR cannot be safely preserved for semantic autoreview"
  if [[ -e "$capture.codex-invoked" ]]; then
    printf 'Codex executed with SSL_CERT_DIR enabled\n' >&2
    exit 1
  fi
  if find "$tmp_dir" -maxdepth 1 -type d -name 'autoreview-codex-workspace.*' -print -quit | grep -q .; then
    printf 'Codex workspace survived SSL_CERT_DIR rejection\n' >&2
    exit 1
  fi

  SSL_CERT_FILE="$ssl_cert_file" \
    run_helper_with_path_in_repo "$review_repo" "$fake_bin" \
      --mode local --engine codex --web-search
  expect_capture_contains_line "--search"
  expect_stdout_contains "autoreview clean"
  expect_empty_stderr
}

run_engine_signal_cleanup_regression() {
  local review_repo="$tmp_dir/engine-signal-cleanup"
  local fake_bin="$tmp_dir/engine-signal-bin"
  local signal_tmp="$tmp_dir/engine-signal-tmp"
  local ssl_cert_file="$tmp_dir/engine-signal-ca.pem"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"
  mkdir "$fake_bin" "$signal_tmp"
  chmod 0700 "$signal_tmp"
  printf '%s\n' '-----BEGIN CERTIFICATE-----' 'signal-placeholder-ca' '-----END CERTIFICATE-----' >"$ssl_cert_file"
  chmod 0600 "$ssl_cert_file"

  cat >"$fake_bin/claude" <<'CLAUDE'
#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
function captureAndHang() {
  process.on("SIGTERM", () => {});
  const grandchild = spawn(
    process.execPath,
    [
      "-e",
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
    ],
    {
      detached: Boolean(process.env.AUTOREVIEW_FAKE_DETACH_GRANDCHILD),
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  fs.writeFileSync(
    `${process.env.AUTOREVIEW_FAKE_CAPTURE}.child-pid`,
    `${process.pid}\n`,
  );
  fs.writeFileSync(
    `${process.env.AUTOREVIEW_FAKE_CAPTURE}.helper-pid`,
    `${process.ppid}\n`,
  );
  fs.writeFileSync(
    `${process.env.AUTOREVIEW_FAKE_CAPTURE}.grandchild-pid`,
    `${grandchild.pid}\n`,
  );
  fs.writeFileSync(
    `${process.env.AUTOREVIEW_FAKE_CAPTURE}.snapshot`,
    `${process.env.SSL_CERT_FILE}\n`,
  );
  setInterval(() => {}, 1000);
}
if (
  process.argv[2] === "--version" &&
  !process.env.AUTOREVIEW_FAKE_HANG_CLAUDE_PROBE
) {
  process.stdout.write("2.1.210\n");
  process.exit(0);
}
if (process.argv[2] === "--help") {
  process.stdout.write(
    "--safe-mode\n--setting-sources\n--strict-mcp-config\n--disallowedTools\n--tools\n",
  );
  process.exit(0);
}
captureAndHang();
CLAUDE
  cat >"$fake_bin/codex" <<'CODEX'
#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const leaderExitsOnTermination = Boolean(
  process.env.AUTOREVIEW_FAKE_EXIT_LEADER_ON_TERM,
);
const leaderExitCodeText =
  process.env.AUTOREVIEW_FAKE_EXIT_LEADER_NORMALLY || "";
const leaderExitCode = /^[0-9]+$/.test(leaderExitCodeText)
  ? Number.parseInt(leaderExitCodeText, 10)
  : null;
const leaderExitsNormally = leaderExitCode !== null;
let stdinEnded = !leaderExitsNormally;
let grandchildReady = !leaderExitsNormally;
function maybeExitNormally() {
  if (!leaderExitsNormally || !stdinEnded || !grandchildReady) return;
  if (leaderExitCode === 0) {
    const args = process.argv.slice(2);
    const outputIndex = args.indexOf("-o");
    fs.writeFileSync(
      args[outputIndex + 1],
      '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}\n',
    );
  }
  process.exit(leaderExitCode);
}
process.on("SIGTERM", () => {
  if (leaderExitsOnTermination) process.exit(0);
});
const grandchild = spawn(
  process.execPath,
  [
    "-e",
    'const fs = require("node:fs"); process.on("SIGTERM", () => {}); fs.writeFileSync(`${process.env.AUTOREVIEW_FAKE_CAPTURE}.grandchild-ready`, "ready\\n"); if (process.send) { process.send("ready"); process.disconnect(); } setInterval(() => {}, 1000);',
  ],
  {
    detached: Boolean(process.env.AUTOREVIEW_FAKE_DETACH_GRANDCHILD),
    stdio: leaderExitsNormally
      ? ["ignore", "ignore", "ignore", "ipc"]
      : leaderExitsOnTermination
        ? ["ignore", "ignore", "ignore"]
        : ["ignore", "inherit", "inherit"],
  },
);
if (leaderExitsNormally) {
  grandchild.once("message", () => {
    grandchildReady = true;
    maybeExitNormally();
  });
  process.stdin.resume();
  process.stdin.on("end", () => {
    stdinEnded = true;
    maybeExitNormally();
  });
}
fs.writeFileSync(
  `${process.env.AUTOREVIEW_FAKE_CAPTURE}.child-pid`,
  `${process.pid}\n`,
);
fs.writeFileSync(
  `${process.env.AUTOREVIEW_FAKE_CAPTURE}.helper-pid`,
  `${process.ppid}\n`,
);
fs.writeFileSync(
  `${process.env.AUTOREVIEW_FAKE_CAPTURE}.grandchild-pid`,
  `${grandchild.pid}\n`,
);
fs.writeFileSync(
  `${process.env.AUTOREVIEW_FAKE_CAPTURE}.snapshot`,
  `${process.env.SSL_CERT_FILE}\n`,
);
if (!leaderExitsNormally) setInterval(() => {}, 1000);
CODEX
  chmod +x "$fake_bin/claude" "$fake_bin/codex"

  local scenario
  local engine
  local engine_capture
  local engine_pid
  local helper_pid
  local child_pid
  local descendant_pid
  local grandchild_pid
  local snapshot_path
  local launched
  local snapshot_unlinked
  local helper_exited
  local descendants_exited
  local completion_mode
  local leader_exit_code
  local termination_mode
  local wait_status
  local launch_dir
  local -a signal_env_args
  local -a termination_args
  launch_dir="$(pwd -P)"
  for scenario in claude-probe claude codex; do
    engine="${scenario%%-*}"
    engine_capture="$tmp_dir/engine-signal-$scenario"
    rm -f \
      "$engine_capture.child-pid" \
      "$engine_capture.grandchild-pid" \
      "$engine_capture.helper-pid" \
      "$engine_capture.snapshot"
    signal_env_args=(
      "PATH=$fake_bin:$PATH"
      "HOME=$HOME"
      "TMPDIR=$signal_tmp"
      "SSL_CERT_FILE=$ssl_cert_file"
      "AUTOREVIEW_FAKE_CAPTURE=$engine_capture"
      "AUTOREVIEW_HEARTBEAT_SECONDS=60"
    )
    if [[ "$scenario" == "claude-probe" ]]; then
      signal_env_args+=(
        "AUTOREVIEW_FAKE_DETACH_GRANDCHILD=1"
        "AUTOREVIEW_FAKE_HANG_CLAUDE_PROBE=1"
      )
    fi
    cd "$review_repo"
    /usr/bin/env -i "${signal_env_args[@]}" \
      "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" \
      --mode local --engine "$engine" >"$engine_capture.stdout" 2>"$engine_capture.stderr" &
    engine_pid=$!
    cd "$launch_dir"
    launched=0
    for _ in {1..200}; do
      if [[
        -s "$engine_capture.child-pid" &&
          -s "$engine_capture.grandchild-pid" &&
          -s "$engine_capture.helper-pid" &&
          -s "$engine_capture.snapshot"
      ]]; then
        launched=1
        break
      fi
      if ! kill -0 "$engine_pid" 2>/dev/null; then
        break
      fi
      sleep 0.05
    done
    if [[ "$launched" -ne 1 ]]; then
      kill -TERM "$engine_pid" 2>/dev/null || true
      wait "$engine_pid" 2>/dev/null || true
      printf '%s did not reach the signal-cleanup fixture\n' "$scenario" >&2
      cat "$engine_capture.stderr" >&2
      exit 1
    fi
    child_pid="$(cat "$engine_capture.child-pid")"
    grandchild_pid="$(cat "$engine_capture.grandchild-pid")"
    helper_pid="$(cat "$engine_capture.helper-pid")"
    snapshot_path="$(cat "$engine_capture.snapshot")"
    if [[ ! -f "$snapshot_path" ]]; then
      printf '%s engine credential snapshot was absent before interruption\n' "$engine" >&2
      exit 1
    fi
    kill -TERM "$helper_pid"
    snapshot_unlinked=0
    for _ in {1..40}; do
      if [[ ! -e "$snapshot_path" ]]; then
        snapshot_unlinked=1
        break
      fi
      if ! kill -0 "$helper_pid" 2>/dev/null; then
        break
      fi
      if [[ "$scenario" == "claude-probe" ]] && ! kill -0 "$grandchild_pid" 2>/dev/null; then
        break
      fi
      sleep 0.05
    done
    if [[ "$snapshot_unlinked" -ne 1 ]]; then
      kill -KILL "$helper_pid" "$engine_pid" "$child_pid" "$grandchild_pid" 2>/dev/null || true
      wait "$engine_pid" 2>/dev/null || true
      printf '%s credential snapshot remained readable during interruption grace period\n' "$scenario" >&2
      exit 1
    fi
    if ! kill -0 "$helper_pid" 2>/dev/null; then
      kill -KILL "$engine_pid" "$child_pid" "$grandchild_pid" 2>/dev/null || true
      printf '%s helper exited before credential snapshot cleanup was observed\n' "$scenario" >&2
      cat "$engine_capture.stderr" >&2
      exit 1
    fi
    if [[ "$scenario" == "claude-probe" ]] && ! kill -0 "$grandchild_pid" 2>/dev/null; then
      kill -KILL "$helper_pid" "$engine_pid" "$child_pid" 2>/dev/null || true
      wait "$engine_pid" 2>/dev/null || true
      printf 'detached probe grandchild exited before credential snapshot cleanup was observed\n' >&2
      exit 1
    fi
    kill -TERM "$helper_pid"
    helper_exited=0
    for _ in {1..240}; do
      if ! kill -0 "$helper_pid" 2>/dev/null; then
        helper_exited=1
        break
      fi
      sleep 0.05
    done
    if [[ "$helper_exited" -ne 1 ]]; then
      kill -KILL "$helper_pid" "$engine_pid" "$child_pid" "$grandchild_pid" 2>/dev/null || true
      wait "$engine_pid" 2>/dev/null || true
      printf '%s helper did not terminate within the signal-cleanup deadline\n' "$scenario" >&2
      exit 1
    fi
    set +e
    wait "$engine_pid" 2>/dev/null
    wait_status=$?
    set -e
    if [[ "$wait_status" -eq 0 ]]; then
      printf '%s helper exited successfully after SIGTERM\n' "$scenario" >&2
      exit 1
    fi
    descendants_exited=0
    for _ in {1..100}; do
      if ! kill -0 "$child_pid" 2>/dev/null; then
        descendants_exited=1
        break
      fi
      sleep 0.05
    done
    if [[ "$descendants_exited" -ne 1 ]]; then
      kill -KILL "$child_pid" "$grandchild_pid" 2>/dev/null || true
      printf '%s direct engine child survived helper interruption\n' "$scenario" >&2
      exit 1
    fi
    if [[ -e "$snapshot_path" ]]; then
      kill -KILL "$grandchild_pid" 2>/dev/null || true
      printf '%s credential snapshot survived SIGTERM cleanup: %s\n' "$scenario" "$snapshot_path" >&2
      exit 1
    fi
    if [[ "$scenario" != "claude-probe" ]]; then
      descendants_exited=0
      for _ in {1..100}; do
        if ! kill -0 "$grandchild_pid" 2>/dev/null; then
          descendants_exited=1
          break
        fi
        sleep 0.05
      done
      if [[ "$descendants_exited" -ne 1 ]]; then
        kill -KILL "$grandchild_pid" 2>/dev/null || true
        printf '%s same-group grandchild survived helper interruption\n' "$scenario" >&2
        exit 1
      fi
    fi
    if find "$signal_tmp" -mindepth 1 -maxdepth 1 -type d -name 'autoreview-*' -print -quit | grep -q .; then
      kill -KILL "$grandchild_pid" 2>/dev/null || true
      printf '%s engine runtime survived SIGTERM cleanup\n' "$scenario" >&2
      exit 1
    fi
    if [[ "$scenario" == "claude-probe" ]]; then
      kill -KILL "$grandchild_pid" 2>/dev/null || true
    fi
  done

  for termination_mode in signal timeout; do
    engine_capture="$tmp_dir/engine-leader-exit-$termination_mode"
    rm -f \
      "$engine_capture.child-pid" \
      "$engine_capture.grandchild-pid" \
      "$engine_capture.grandchild-ready" \
      "$engine_capture.helper-pid" \
      "$engine_capture.snapshot"
    signal_env_args=(
      "PATH=$fake_bin:$PATH"
      "HOME=$HOME"
      "TMPDIR=$signal_tmp"
      "SSL_CERT_FILE=$ssl_cert_file"
      "AUTOREVIEW_FAKE_CAPTURE=$engine_capture"
      "AUTOREVIEW_FAKE_EXIT_LEADER_ON_TERM=1"
      "AUTOREVIEW_HEARTBEAT_SECONDS=60"
    )
    termination_args=(--mode local --engine codex)
    if [[ "$termination_mode" == "timeout" ]]; then
      termination_args+=(--timeout-seconds 3)
    fi
    cd "$review_repo"
    /usr/bin/env -i "${signal_env_args[@]}" \
      "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" \
      "${termination_args[@]}" >"$engine_capture.stdout" 2>"$engine_capture.stderr" &
    engine_pid=$!
    cd "$launch_dir"
    launched=0
    for _ in {1..200}; do
      if [[
        -s "$engine_capture.child-pid" &&
          -s "$engine_capture.grandchild-pid" &&
          -s "$engine_capture.grandchild-ready" &&
          -s "$engine_capture.helper-pid" &&
          -s "$engine_capture.snapshot"
      ]]; then
        launched=1
        break
      fi
      if ! kill -0 "$engine_pid" 2>/dev/null; then
        break
      fi
      sleep 0.05
    done
    if [[ "$launched" -ne 1 ]]; then
      kill -KILL "$engine_pid" 2>/dev/null || true
      wait "$engine_pid" 2>/dev/null || true
      printf 'leader-exit %s fixture did not launch\n' "$termination_mode" >&2
      cat "$engine_capture.stderr" >&2
      exit 1
    fi
    child_pid="$(cat "$engine_capture.child-pid")"
    grandchild_pid="$(cat "$engine_capture.grandchild-pid")"
    helper_pid="$(cat "$engine_capture.helper-pid")"
    snapshot_path="$(cat "$engine_capture.snapshot")"
    if [[ ! -f "$snapshot_path" ]]; then
      kill -KILL "$helper_pid" "$engine_pid" "$child_pid" "$grandchild_pid" 2>/dev/null || true
      printf 'leader-exit %s credential snapshot was absent before termination\n' "$termination_mode" >&2
      exit 1
    fi
    if [[ "$termination_mode" == "signal" ]]; then
      kill -TERM "$helper_pid"
    fi
    helper_exited=0
    for _ in {1..240}; do
      if ! kill -0 "$helper_pid" 2>/dev/null; then
        helper_exited=1
        break
      fi
      sleep 0.05
    done
    if [[ "$helper_exited" -ne 1 ]]; then
      kill -KILL "$helper_pid" "$engine_pid" "$child_pid" "$grandchild_pid" 2>/dev/null || true
      wait "$engine_pid" 2>/dev/null || true
      printf 'leader-exit %s helper did not terminate within the deadline\n' "$termination_mode" >&2
      exit 1
    fi
    set +e
    wait "$engine_pid" 2>/dev/null
    wait_status=$?
    set -e
    if [[ "$wait_status" -eq 0 ]]; then
      kill -KILL "$child_pid" "$grandchild_pid" 2>/dev/null || true
      printf 'leader-exit %s helper exited successfully\n' "$termination_mode" >&2
      exit 1
    fi
    for descendant_pid in "$child_pid" "$grandchild_pid"; do
      descendants_exited=0
      for _ in {1..100}; do
        if ! kill -0 "$descendant_pid" 2>/dev/null; then
          descendants_exited=1
          break
        fi
        sleep 0.05
      done
      if [[ "$descendants_exited" -ne 1 ]]; then
        kill -KILL "$descendant_pid" 2>/dev/null || true
        printf 'leader-exit %s descendant survived termination: %s\n' \
          "$termination_mode" "$descendant_pid" >&2
        exit 1
      fi
    done
    if [[ -e "$snapshot_path" ]]; then
      printf 'leader-exit %s credential snapshot survived termination\n' "$termination_mode" >&2
      exit 1
    fi
    if find "$signal_tmp" -mindepth 1 -maxdepth 1 -type d -name 'autoreview-*' -print -quit | grep -q .; then
      printf 'leader-exit %s engine runtime survived termination\n' "$termination_mode" >&2
      exit 1
    fi
    if [[ "$termination_mode" == "timeout" ]]; then
      expect_file_contains "$engine_capture.stderr" "timed out after 3s"
    fi
  done

  for completion_mode in success failure; do
    engine_capture="$tmp_dir/engine-leader-completion-$completion_mode"
    rm -f \
      "$engine_capture.child-pid" \
      "$engine_capture.grandchild-pid" \
      "$engine_capture.grandchild-ready" \
      "$engine_capture.helper-pid" \
      "$engine_capture.snapshot"
    if [[ "$completion_mode" == "success" ]]; then
      leader_exit_code=0
    else
      leader_exit_code=7
    fi
    signal_env_args=(
      "PATH=$fake_bin:$PATH"
      "HOME=$HOME"
      "TMPDIR=$signal_tmp"
      "SSL_CERT_FILE=$ssl_cert_file"
      "AUTOREVIEW_FAKE_CAPTURE=$engine_capture"
      "AUTOREVIEW_FAKE_EXIT_LEADER_NORMALLY=$leader_exit_code"
      "AUTOREVIEW_HEARTBEAT_SECONDS=60"
    )
    set +e
    (
      cd "$review_repo"
      /usr/bin/env -i "${signal_env_args[@]}" \
        "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" \
        --mode local --engine codex \
        >"$engine_capture.stdout" 2>"$engine_capture.stderr"
    )
    wait_status=$?
    set -e
    if [[ "$completion_mode" == "success" && "$wait_status" -ne 0 ]]; then
      printf 'ordinary-success helper failed with status %s\n' "$wait_status" >&2
      cat "$engine_capture.stderr" >&2
      exit 1
    fi
    if [[ "$completion_mode" == "failure" && "$wait_status" -eq 0 ]]; then
      printf 'ordinary-failure helper exited successfully\n' >&2
      exit 1
    fi
    if [[
      ! -s "$engine_capture.child-pid" ||
        ! -s "$engine_capture.grandchild-pid" ||
        ! -s "$engine_capture.grandchild-ready" ||
        ! -s "$engine_capture.snapshot"
    ]]; then
      printf 'ordinary-%s fixture did not complete startup\n' \
        "$completion_mode" >&2
      exit 1
    fi
    grandchild_pid="$(cat "$engine_capture.grandchild-pid")"
    snapshot_path="$(cat "$engine_capture.snapshot")"
    descendants_exited=0
    for _ in {1..100}; do
      if ! kill -0 "$grandchild_pid" 2>/dev/null; then
        descendants_exited=1
        break
      fi
      sleep 0.05
    done
    if [[ "$descendants_exited" -ne 1 ]]; then
      kill -KILL "$grandchild_pid" 2>/dev/null || true
      printf 'ordinary-%s background descendant survived completion\n' \
        "$completion_mode" >&2
      exit 1
    fi
    if [[ -e "$snapshot_path" ]]; then
      printf 'ordinary-%s credential snapshot survived completion\n' \
        "$completion_mode" >&2
      exit 1
    fi
    if find "$signal_tmp" -mindepth 1 -maxdepth 1 -type d -name 'autoreview-*' -print -quit | grep -q .; then
      printf 'ordinary-%s engine runtime survived completion\n' \
        "$completion_mode" >&2
      exit 1
    fi
    if [[ "$completion_mode" == "success" ]]; then
      expect_file_contains "$engine_capture.stdout" "autoreview clean"
    else
      expect_file_contains "$engine_capture.stderr" "failed (7)"
    fi
  done
}

run_symlinked_node_codex_regression() {
  local review_repo="$tmp_dir/symlinked-node-codex"
  local fake_bin="$tmp_dir/symlinked-node-codex-bin"
  local fake_target_dir="$tmp_dir/symlinked-node-codex-target"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"
  mkdir "$fake_bin" "$fake_target_dir"
  cat >"$fake_target_dir/codex.js" <<'CODEX'
#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("-o");
fs.writeFileSync(
  `${process.env.AUTOREVIEW_FAKE_CAPTURE}.command`,
  `${process.argv[1]}\n`,
);
process.stdin.resume();
process.stdin.on("end", () => {
  fs.writeFileSync(
    args[outputIndex + 1],
    '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}\n',
  );
});
CODEX
  chmod +x "$fake_target_dir/codex.js"
  ln -s "$fake_target_dir/codex.js" "$fake_bin/codex"

  run_helper_with_path_in_repo "$review_repo" "$fake_bin" --mode local --engine codex
  expect_file_contains "$capture.command" "$fake_target_dir/codex.js"
  expect_file_not_contains "$capture.command" "$fake_bin/codex"
  expect_stdout_contains "autoreview clean"
  expect_empty_stderr
}

run_repo_controlled_node_regression() {
  local review_repo="$tmp_dir/repo-controlled-node"
  local fake_bin="$tmp_dir/repo-controlled-node-bin"
  local marker="$tmp_dir/repo-controlled-node-ran"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"
  mkdir "$fake_bin" "$repo_node_test_dir"
  cat >"$repo_node_test_dir/node" <<NODE
#!/usr/bin/env bash
printf 'unsafe\n' >"$marker"
exit 99
NODE
  chmod +x "$repo_node_test_dir/node"
  ln -s "$repo_node_test_dir/node" "$fake_bin/node"

  run_helper_with_path_in_repo "$review_repo" "$fake_bin" \
    --mode local --engine local
  if [[ -e "$marker" ]]; then
    printf 'repo-controlled node shim executed during runtime resolution\n' >&2
    exit 1
  fi
  rm -rf "$repo_node_test_dir"
  expect_stdout_contains "autoreview clean"
  expect_empty_stderr
}

run_pr_base_detection_regression() {
  local review_repo="$tmp_dir/pr-base-detection"
  local fake_bin="$tmp_dir/pr-base-detection-bin"
  local fake_pr_list="$tmp_dir/pr-base-detection.json"
  init_review_repo "$review_repo"
  git -C "$review_repo" remote add origin \
    https://github.com/mento-protocol/monitoring-monorepo.git
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  local release_oid
  release_oid="$(git -C "$review_repo" rev-parse HEAD)"
  git -C "$review_repo" update-ref refs/remotes/origin/release "$release_oid"
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  printf 'feature\n' >"$review_repo/feature.txt"
  commit_review_repo "$review_repo" feature
  mkdir "$fake_bin"
  printf '%s\n' \
    '[{"baseRefName":"release","headRepositoryOwner":{"login":"mento-protocol"}}]' \
    >"$fake_pr_list"
  cat >"$fake_bin/gh" <<GH
#!/usr/bin/env bash
git rev-parse --show-toplevel >/dev/null || exit 81
if [[ "\$1" == "repo" && "\$2" == "view" ]]; then
  printf '%s\n' '{"owner":{"login":"mento-protocol"}}'
  exit 0
fi
if [[ "\$1" == "pr" && "\$2" == "list" ]]; then
  cat "$fake_pr_list"
  exit 0
fi
exit 82
GH
  chmod +x "$fake_bin/gh"

  : >"$stdout"
  : >"$stderr"
  (
    cd "$review_repo"
    env -i \
      "PATH=$fake_bin:$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "$repo_root/scripts/agent-autoreview.sh" \
      --engine local --dry-run >"$stdout" 2>"$stderr"
  )
  expect_stdout_contains "ref: origin/release"
  expect_stdout_not_contains "requested_ref:"
  expect_empty_stderr

  printf '%s\n' \
    '[{"baseRefName":"release","headRepositoryOwner":{"login":"mento-protocol"}},{"baseRefName":"main","headRepositoryOwner":{"login":"mento-protocol"}}]' \
    >"$fake_pr_list"
  : >"$stdout"
  : >"$stderr"
  local status=0
  (
    cd "$review_repo"
    env -i \
      "PATH=$fake_bin:$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "$repo_root/scripts/agent-autoreview.sh" \
      --engine local --dry-run >"$stdout" 2>"$stderr"
  ) || status=$?
  if [[ "$status" -eq 0 ]]; then
    printf 'ambiguous PR base lookup unexpectedly succeeded\n' >&2
    exit 1
  fi
  expect_stderr_contains "multiple open PRs match head branch feature"

  printf '%s\n' \
    '[{"baseRefName":"release","headRepositoryOwner":{"login":"fork-owner"}}]' \
    >"$fake_pr_list"
  : >"$stdout"
  : >"$stderr"
  status=0
  (
    cd "$review_repo"
    env -i \
      "PATH=$fake_bin:$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "$repo_root/scripts/agent-autoreview.sh" \
      --engine local --dry-run >"$stdout" 2>"$stderr"
  ) || status=$?
  if [[ "$status" -eq 0 ]]; then
    printf 'fork-owned PR base lookup unexpectedly succeeded\n' >&2
    exit 1
  fi
  expect_stderr_contains "open PR for head branch feature is not owned by mento-protocol"
}

run_target_selection_drift_regression() {
  local review_repo="$tmp_dir/target-selection-drift"
  local fake_bin="$tmp_dir/target-selection-drift-bin"
  init_review_repo "$review_repo"
  git -C "$review_repo" remote add origin \
    https://github.com/mento-protocol/monitoring-monorepo.git
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  git -C "$review_repo" update-ref refs/remotes/origin/release HEAD
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  printf 'feature\n' >"$review_repo/feature.txt"
  commit_review_repo "$review_repo" feature
  mkdir "$fake_bin"
  cat >"$fake_bin/gh" <<GH
#!/usr/bin/env bash
if [[ "\$1" == "repo" && "\$2" == "view" ]]; then
  printf '%s\n' '{"owner":{"login":"mento-protocol"}}'
  exit 0
fi
if [[ "\$1" == "pr" && "\$2" == "list" ]]; then
  printf 'late local change\n' >"$review_repo/late.txt"
  printf '%s\n' '[{"baseRefName":"release","headRepositoryOwner":{"login":"mento-protocol"}}]'
  exit 0
fi
exit 1
GH
  chmod +x "$fake_bin/gh"

  run_helper_with_path_in_repo_expect_failure \
    "$review_repo" \
    "$fake_bin" \
    --engine local
  expect_stderr_contains "source changed while the review target was being selected"
  expect_stdout_not_contains "autoreview clean"
}

run_dry_run_unresolved_ref_regression() {
  local review_repo="$tmp_dir/dry-run-unresolved-ref"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  git -C "$review_repo" switch -c feature >/dev/null 2>&1

  run_helper_in_repo "$review_repo" \
    --mode branch \
    --base origin/not-fetched \
    --engine local \
    --dry-run
  expect_stdout_contains "autoreview target: branch"
  expect_stdout_contains "ref: origin/not-fetched"
  expect_stdout_not_contains "requested_ref:"
  expect_empty_stderr
}

run_dirty_source_drift_regression() {
  local review_repo="$tmp_dir/dirty-source-drift"
  local fake_bin="$tmp_dir/dirty-source-drift-bin"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'review me\n' >>"$review_repo/README.md"
  mkdir "$fake_bin"
  cat >"$fake_bin/claude" <<CLAUDE
#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf '2.1.210\n'
  exit 0
fi
if [[ "\${1:-}" == "--help" ]]; then
  printf '%s\n' --safe-mode --setting-sources --strict-mcp-config --disallowedTools --tools
  exit 0
fi
cat >/dev/null
printf 'concurrent change\n' >>"$review_repo/README.md"
cat <<'JSON'
{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}
JSON
CLAUDE
  chmod +x "$fake_bin/claude"

  run_helper_with_path_in_repo_expect_failure "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  expect_stderr_contains "source changed during semantic review"
  expect_stdout_not_contains "autoreview clean"
}

run_untracked_churn_scope_regression() {
  local review_repo="$tmp_dir/untracked-churn-scope"
  local fake_bin="$tmp_dir/untracked-churn-scope-bin"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  printf 'review me\n' >"$review_repo/feature.txt"
  commit_review_repo "$review_repo" feature
  mkdir "$fake_bin"
  cat >"$fake_bin/claude" <<CLAUDE
#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf '2.1.210\n'
  exit 0
fi
if [[ "\${1:-}" == "--help" ]]; then
  printf '%s\n' --safe-mode --setting-sources --strict-mcp-config --disallowedTools --tools
  exit 0
fi
cat >/dev/null
printf 'unrelated churn\n' >"$review_repo/late-untracked.txt"
cat <<'JSON'
{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}
JSON
CLAUDE
  chmod +x "$fake_bin/claude"

  run_helper_with_path_in_repo "$review_repo" "$fake_bin" \
    --mode branch --base main --engine claude --no-tools
  expect_stdout_contains "autoreview clean"
  expect_empty_stderr

  rm "$review_repo/late-untracked.txt"
  run_helper_with_path_in_repo_expect_failure "$review_repo" "$fake_bin" \
    --mode auto --base main --engine claude --no-tools
  expect_stderr_contains "source changed during semantic review"
  expect_stdout_not_contains "autoreview clean"
}

run_index_source_drift_regression() {
  local review_repo="$tmp_dir/index-source-drift"
  local fake_bin="$tmp_dir/index-source-drift-bin"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'staged review\n' >>"$review_repo/README.md"
  git -C "$review_repo" add README.md
  git -C "$review_repo" restore --source=HEAD --worktree README.md
  mkdir "$fake_bin"
  cat >"$fake_bin/claude" <<CLAUDE
#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf '2.1.210\n'
  exit 0
fi
if [[ "\${1:-}" == "--help" ]]; then
  printf '%s\n' --safe-mode --setting-sources --strict-mcp-config --disallowedTools --tools
  exit 0
fi
cat >/dev/null
git -C "$review_repo" restore --staged README.md
cat <<'JSON'
{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}
JSON
CLAUDE
  chmod +x "$fake_bin/claude"

  run_helper_with_path_in_repo_expect_failure "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  expect_stderr_contains "source changed during semantic review"
  expect_stdout_not_contains "autoreview clean"
}

run_mode_source_drift_regression() {
  local review_repo="$tmp_dir/mode-source-drift"
  local fake_bin="$tmp_dir/mode-source-drift-bin"
  local snapshot_before
  local snapshot_after
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf '#!/usr/bin/env bash\nprintf test\n' >"$review_repo/script.sh"
  chmod 0644 "$review_repo/script.sh"
  snapshot_before="$(cd "$review_repo" && "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" --source-snapshot-only)"
  chmod 0755 "$review_repo/script.sh"
  snapshot_after="$(cd "$review_repo" && "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" --source-snapshot-only)"
  if [[ "$snapshot_before" == "$snapshot_after" ]]; then
    printf 'expected executable-mode change to alter the source snapshot\n' >&2
    exit 1
  fi
  chmod 0644 "$review_repo/script.sh"
  mkdir "$fake_bin"
  cat >"$fake_bin/claude" <<CLAUDE
#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf '2.1.210\n'
  exit 0
fi
if [[ "\${1:-}" == "--help" ]]; then
  printf '%s\n' --safe-mode --setting-sources --strict-mcp-config --disallowedTools --tools
  exit 0
fi
cat >/dev/null
chmod 0755 "$review_repo/script.sh"
cat <<'JSON'
{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}
JSON
CLAUDE
  chmod +x "$fake_bin/claude"

  run_helper_with_path_in_repo_expect_failure "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  expect_stderr_contains "source changed during semantic review"
  expect_stdout_not_contains "autoreview clean"
}

run_branch_identity_source_drift_regression() {
  local review_repo="$tmp_dir/branch-identity-source-drift"
  local fake_bin="$tmp_dir/branch-identity-source-drift-bin"
  local feature_snapshot
  local sibling_snapshot
  local detached_snapshot
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  git -C "$review_repo" -c branch.autoSetupMerge=false branch sibling
  printf 'review me\n' >>"$review_repo/README.md"
  feature_snapshot="$(cd "$review_repo" && "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" --source-snapshot-only)"
  git -C "$review_repo" switch sibling >/dev/null 2>&1
  sibling_snapshot="$(cd "$review_repo" && "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" --source-snapshot-only)"
  if [[ "$feature_snapshot" == "$sibling_snapshot" ]]; then
    printf 'expected same-OID branch switch to alter the source snapshot\n' >&2
    exit 1
  fi
  git -C "$review_repo" switch --detach >/dev/null 2>&1
  detached_snapshot="$(cd "$review_repo" && "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" --source-snapshot-only)"
  if [[ "$sibling_snapshot" == "$detached_snapshot" ]]; then
    printf 'expected detached HEAD to alter the source snapshot\n' >&2
    exit 1
  fi
  git -C "$review_repo" switch feature >/dev/null 2>&1
  mkdir "$fake_bin"
  cat >"$fake_bin/claude" <<CLAUDE
#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf '2.1.210\n'
  exit 0
fi
if [[ "\${1:-}" == "--help" ]]; then
  printf '%s\n' --safe-mode --setting-sources --strict-mcp-config --disallowedTools --tools
  exit 0
fi
cat >/dev/null
git -C "$review_repo" switch sibling >/dev/null 2>&1
cat <<'JSON'
{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}
JSON
CLAUDE
  chmod +x "$fake_bin/claude"

  run_helper_with_path_in_repo_expect_failure "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  expect_stderr_contains "source changed during semantic review"
  expect_stdout_not_contains "autoreview clean"
}

run_explicit_snapshot_scope_regression() {
  local review_repo="$tmp_dir/explicit-snapshot-scope"
  local local_before
  local local_after
  local branch_before
  local branch_after
  local commit_before
  local commit_after
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  printf 'tracked\n' >"$review_repo/tracked.txt"
  commit_review_repo "$review_repo" init
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  printf 'feature\n' >"$review_repo/feature.txt"
  commit_review_repo "$review_repo" feature

  local_before="$(
    cd "$review_repo"
    "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" \
      --source-snapshot-only --mode local
  )"
  branch_before="$(
    cd "$review_repo"
    "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" \
      --source-snapshot-only --mode branch
  )"
  commit_before="$(
    cd "$review_repo"
    "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" \
      --source-snapshot-only --mode commit
  )"

  printf 'staged\n' >>"$review_repo/tracked.txt"
  git -C "$review_repo" add tracked.txt
  printf 'unstaged\n' >>"$review_repo/tracked.txt"
  printf 'untracked\n' >"$review_repo/untracked.txt"

  local_after="$(
    cd "$review_repo"
    "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" \
      --source-snapshot-only --mode local
  )"
  branch_after="$(
    cd "$review_repo"
    "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" \
      --source-snapshot-only --mode branch
  )"
  commit_after="$(
    cd "$review_repo"
    "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" \
      --source-snapshot-only --mode commit
  )"

  if [[ "$local_before" == "$local_after" ]]; then
    printf 'local source snapshot ignored tracked and untracked changes\n' >&2
    exit 1
  fi
  if [[ "$branch_before" != "$branch_after" ]]; then
    printf 'branch source snapshot included unrelated worktree changes\n' >&2
    exit 1
  fi
  if [[ "$commit_before" != "$commit_after" ]]; then
    printf 'commit source snapshot included unrelated worktree changes\n' >&2
    exit 1
  fi
}

run_frozen_checklist_provenance_regression() {
  local review_repo="$tmp_dir/frozen-checklist-provenance"
  local branch_bundle="$tmp_dir/trusted-checklist-branch-bundle"
  local branch_local_bundle="$tmp_dir/trusted-checklist-branch-local-bundle"
  local commit_bundle="$tmp_dir/trusted-checklist-commit-bundle"
  local local_bundle="$tmp_dir/trusted-checklist-local-bundle"
  local checked_bundle
  init_review_repo "$review_repo"
  mkdir -p \
    "$review_repo/docs/pr-checklists" \
    "$review_repo/indexer-envio/src" \
    "$review_repo/scripts"
  printf 'base\n' >"$review_repo/README.md"
  printf 'base recurring checklist\n' \
    >"$review_repo/docs/pr-checklists/recurring-review-patterns.md"
  printf 'base exclusions checklist\n' \
    >"$review_repo/docs/pr-checklists/review-prompt-exclusions.md"
  printf 'trusted pre-change code-health checklist\n' \
    >"$review_repo/docs/pr-checklists/code-health.md"
  printf 'trusted pre-change indexer-handler checklist\n' \
    >"$review_repo/docs/pr-checklists/indexer-handler-invariants.md"
  commit_review_repo "$review_repo" init
  git -C "$review_repo" switch -c release >/dev/null 2>&1
  printf 'malicious PR-base checklist injection\n' \
    >"$review_repo/docs/pr-checklists/code-health.md"
  commit_review_repo "$review_repo" "poison PR-base checklist"
  git -C "$review_repo" update-ref refs/remotes/origin/release HEAD
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  printf 'review branch script\n' >"$review_repo/scripts/café.mjs"
  printf 'review branch indexer handler\n' \
    >"$review_repo/indexer-envio/src/EventHandlers.ts"
  printf 'malicious reviewed checklist injection\n' \
    >"$review_repo/docs/pr-checklists/code-health.md"
  commit_review_repo "$review_repo" feature

  run_helper_in_repo "$review_repo" \
    --prepare-bundle-dir "$branch_bundle" \
    --mode branch \
    --base origin/release \
    --engine local
  if [[ ! -f "$branch_bundle/selected-checklists.txt" ]]; then
    printf 'branch checklist bundle was not published\nstdout:\n%s\nstderr:\n%s\n' \
      "$(cat "$stdout")" "$(cat "$stderr")" >&2
    exit 1
  fi

  run_helper_in_repo "$review_repo" \
    --prepare-bundle-dir "$commit_bundle" \
    --mode commit \
    --commit HEAD \
    --engine local

  printf 'branch-local review body\n' >"$review_repo/local.txt"
  run_helper_in_repo "$review_repo" \
    --prepare-bundle-dir "$branch_local_bundle" \
    --mode auto \
    --base origin/release \
    --engine local
  rm "$review_repo/local.txt"

  git -C "$review_repo" switch main >/dev/null 2>&1
  mkdir -p "$review_repo/scripts"
  printf 'malicious local checklist injection\n' \
    >"$review_repo/docs/pr-checklists/code-health.md"
  printf 'local review script\n' >"$review_repo/scripts/local-review.sh"
  run_helper_in_repo "$review_repo" \
    --prepare-bundle-dir "$local_bundle" \
    --mode local \
    --engine local

  for checked_bundle in \
    "$branch_bundle" \
    "$branch_local_bundle" \
    "$commit_bundle" \
    "$local_bundle"; do
    expect_file_contains \
      "$checked_bundle/selected-checklists.txt" \
      "docs/pr-checklists/code-health.md"
    expect_file_contains \
      "$checked_bundle/checklists/code-health.md" \
      "trusted pre-change code-health checklist"
    expect_file_not_contains \
      "$checked_bundle/checklists/code-health.md" \
      "malicious PR-base checklist injection"
    expect_file_not_contains \
      "$checked_bundle/checklists/code-health.md" \
      "malicious reviewed checklist injection"
    expect_file_not_contains \
      "$checked_bundle/checklists/code-health.md" \
      "malicious local checklist injection"
    expect_prompt_policy_contains \
      "$checked_bundle/autoreview-prompt.md" \
      "trusted pre-change code-health checklist"
    expect_prompt_policy_not_contains \
      "$checked_bundle/autoreview-prompt.md" \
      "malicious PR-base checklist injection"
    expect_prompt_policy_not_contains \
      "$checked_bundle/autoreview-prompt.md" \
      "malicious reviewed checklist injection"
    expect_prompt_policy_not_contains \
      "$checked_bundle/autoreview-prompt.md" \
      "malicious local checklist injection"
  done

  for checked_bundle in \
    "$branch_bundle" \
    "$branch_local_bundle" \
    "$commit_bundle"; do
    expect_file_contains \
      "$checked_bundle/selected-checklists.txt" \
      "docs/pr-checklists/indexer-handler-invariants.md"
    expect_file_contains \
      "$checked_bundle/checklists/indexer-handler-invariants.md" \
      "trusted pre-change indexer-handler checklist"
    expect_prompt_policy_contains \
      "$checked_bundle/autoreview-prompt.md" \
      "trusted pre-change indexer-handler checklist"
  done

  expect_file_contains "$branch_bundle/changed-paths.txt" "scripts/café.mjs"
  expect_file_contains \
    "$branch_bundle/changed-paths.txt" \
    "indexer-envio/src/EventHandlers.ts"
  expect_file_contains \
    "$branch_bundle/patches/branch.diff" \
    "malicious reviewed checklist injection"
  expect_file_contains \
    "$branch_local_bundle/patches/branch.diff" \
    "malicious reviewed checklist injection"
  expect_file_contains \
    "$commit_bundle/patches/commit.diff" \
    "malicious reviewed checklist injection"
  expect_file_contains \
    "$local_bundle/patches/unstaged.diff" \
    "malicious local checklist injection"
  expect_empty_stderr
}

run_frozen_checklist_symlink_regression() {
  local review_repo="$tmp_dir/frozen-checklist-symlink"
  local bundle_dir="$tmp_dir/frozen-checklist-symlink-bundle"
  init_review_repo "$review_repo"
  mkdir -p "$review_repo/docs/pr-checklists" "$review_repo/scripts"
  printf 'base\n' >"$review_repo/README.md"
  ln -s ../../README.md \
    "$review_repo/docs/pr-checklists/code-health.md"
  commit_review_repo "$review_repo" "add trusted symlinked checklist"
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  printf 'review branch script\n' >"$review_repo/scripts/review.sh"
  commit_review_repo "$review_repo" "add review script"

  run_helper_in_repo_expect_failure "$review_repo" \
    --prepare-bundle-dir "$bundle_dir" \
    --mode branch \
    --base main \
    --engine local
  expect_stderr_contains "protected-main checklist is not a regular Git blob"
  if [[ -e "$bundle_dir" ]]; then
    printf 'bundle was published with a symlinked frozen checklist\n' >&2
    exit 1
  fi
}

run_git_replace_ref_regression() {
  local review_repo="$tmp_dir/git-replace-ref"
  local bundle_dir="$tmp_dir/git-replace-ref-bundle"
  local base_oid
  local head_oid
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  base_oid="$(git -C "$review_repo" rev-parse HEAD)"
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  printf 'feature\n' >"$review_repo/feature.txt"
  commit_review_repo "$review_repo" feature
  head_oid="$(git -C "$review_repo" rev-parse HEAD)"
  git -C "$review_repo" replace "$head_oid" "$base_oid"

  : >"$stdout"
  : >"$stderr"
  (
    cd "$review_repo"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" \
      --mode branch \
      --base main \
      --engine local >"$stdout" 2>"$stderr"
  )
  expect_stdout_contains "scope_baseline: changed_files=1"
  expect_stdout_not_contains "no changed files"
  expect_empty_stderr

  run_helper_in_repo "$review_repo" \
    --prepare-bundle-dir "$bundle_dir" \
    --mode branch \
    --base main \
    --engine local
  expect_file_contains "$bundle_dir/changed-paths.txt" "feature.txt"
  expect_file_contains "$bundle_dir/patches/branch.diff" "feature"
  expect_empty_stderr
}

run_trusted_helper_runtime_regression() {
  local review_repo="$tmp_dir/trusted-helper-runtime"
  local branch_bundle="$tmp_dir/trusted-helper-branch-bundle"
  local commit_bundle="$tmp_dir/trusted-helper-commit-bundle"
  local dirty_helper_bundle="$tmp_dir/trusted-helper-dirty-helper-bundle"
  local dirty_shell_bundle="$tmp_dir/trusted-helper-dirty-shell-bundle"
  local changed_runtime_bundle="$tmp_dir/trusted-helper-changed-runtime-bundle"
  local changed_runtime_commit_bundle="$tmp_dir/trusted-helper-changed-runtime-commit-bundle"
  local changed_runtime_local_bundle="$tmp_dir/trusted-helper-changed-runtime-local-bundle"
  local hostile_base_repo="$tmp_dir/trusted-helper-hostile-base"
  local hostile_base_bundle="$tmp_dir/trusted-helper-hostile-base-bundle"
  local hostile_base_trusted_bundle="$tmp_dir/trusted-helper-hostile-base-trusted-bundle"
  local hostile_base_marker="$tmp_dir/trusted-helper-hostile-base-ran"
  local hostile_direct_tmp="$tmp_dir/trusted-helper-hostile-direct-tmp"
  local hostile_direct_tmp_marker="$tmp_dir/trusted-helper-hostile-direct-tmp-ran"
  local direct_identity_marker="$tmp_dir/trusted-helper-direct-identity-changed"
  local repo_local_direct_tmp="$hostile_base_repo/.agent-autoreview-direct-tmp"
  local repo_local_direct_tmp_marker="$tmp_dir/trusted-helper-repo-direct-tmp-ran"
  local unsafe_native_node_bin="$tmp_dir/trusted-helper-unsafe-native-node-bin"
  local native_node_argv0_marker="$tmp_dir/trusted-helper-native-node-argv0"
  local node_options_hook="$tmp_dir/trusted-helper-node-options.cjs"
  local node_options_marker="$tmp_dir/trusted-helper-node-options-ran"
  local local_stdout="$tmp_dir/trusted-helper.stdout"
  local local_stderr="$tmp_dir/trusted-helper.stderr"
  local changed_runtime_commit
  local changed_runtime_parent
  local changed_runtime_path
  local native_node_argv0
  local status=0
  init_review_repo "$review_repo"
  mkdir -p "$review_repo/scripts"
  cp "$repo_root/scripts/agent-autoreview.sh" \
    "$repo_root/scripts/agent-autoreview.mjs" \
    "$repo_root/scripts/agent-autoreview-core.mjs" \
    "$review_repo/scripts/"
  chmod +x \
    "$review_repo/scripts/agent-autoreview.sh" \
    "$review_repo/scripts/agent-autoreview.mjs"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  printf 'feature\n' >"$review_repo/feature.txt"
  commit_review_repo "$review_repo" feature

  printf '\nthis is intentionally invalid JavaScript\n' \
    >>"$review_repo/scripts/agent-autoreview.mjs"
  printf '\nthis is intentionally invalid JavaScript\n' \
    >>"$review_repo/scripts/agent-autoreview-core.mjs"

  (
    cd "$review_repo"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "$review_repo/scripts/agent-autoreview.sh" \
      --prepare-bundle-dir "$branch_bundle" \
      --mode branch \
      --base main \
      --engine local >"$local_stdout" 2>"$local_stderr"
  )
  expect_file_exists "$branch_bundle/autoreview-prompt.md"
  if grep -Fq "intentionally invalid JavaScript" \
    "$branch_bundle/autoreview-prompt.md"; then
    printf 'branch bundle used dirty worktree helper code\n' >&2
    exit 1
  fi

  (
    cd "$review_repo"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "$review_repo/scripts/agent-autoreview.sh" \
      --prepare-bundle-dir "$commit_bundle" \
      --mode commit \
      --commit HEAD \
      --engine local >"$local_stdout" 2>"$local_stderr"
  )
  expect_file_exists "$commit_bundle/autoreview-prompt.md"

  set +e
  (
    cd "$review_repo"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "$review_repo/scripts/agent-autoreview.sh" \
      --prepare-bundle-dir "$dirty_helper_bundle" \
      --mode local \
      --engine local >"$local_stdout" 2>"$local_stderr"
  )
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    printf 'local bundle executed a dirty helper runtime\n' >&2
    exit 1
  fi
  if ! grep -Fq "local review target changes executable autoreview runtime" \
    "$local_stderr"; then
    printf 'dirty local helper failed for the wrong reason:\n%s\n' \
      "$(cat "$local_stderr")" >&2
    exit 1
  fi
  if [[ -e "$dirty_helper_bundle" ]]; then
    printf 'bundle was published with a dirty local helper runtime\n' >&2
    exit 1
  fi

  git -C "$review_repo" checkout -- \
    scripts/agent-autoreview.mjs \
    scripts/agent-autoreview-core.mjs
  printf '\n# dirty wrapper\n' \
    >>"$review_repo/scripts/agent-autoreview.sh"
  set +e
  (
    cd "$review_repo"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "$review_repo/scripts/agent-autoreview.sh" \
      --prepare-bundle-dir "$dirty_shell_bundle" \
      --mode branch \
      --base main \
      --engine local >"$local_stdout" 2>"$local_stderr"
  )
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    printf 'explicit branch bundle accepted a dirty wrapper\n' >&2
    exit 1
  fi
  if ! grep -Fq "requires scripts/agent-autoreview.sh to match frozen HEAD" \
    "$local_stderr"; then
    printf 'dirty wrapper failed for the wrong reason:\n%s\n' \
      "$(cat "$local_stderr")" >&2
    exit 1
  fi
  if [[ -e "$dirty_shell_bundle" ]]; then
    printf 'bundle was published with a dirty wrapper\n' >&2
    exit 1
  fi

  git -C "$review_repo" checkout -- scripts/agent-autoreview.sh
  printf '\nthrow new Error("reviewed helper runtime executed");\n' \
    >>"$review_repo/scripts/agent-autoreview.mjs"
  commit_review_repo "$review_repo" "change reviewed helper runtime"
  changed_runtime_commit="$(git -C "$review_repo" rev-parse HEAD)"
  changed_runtime_parent="$(git -C "$review_repo" rev-parse HEAD^)"
  set +e
  (
    cd "$review_repo"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "$review_repo/scripts/agent-autoreview.sh" \
      --prepare-bundle-dir "$changed_runtime_bundle" \
      --mode branch \
      --base main \
      --engine local >"$local_stdout" 2>"$local_stderr"
  )
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    printf 'explicit branch bundle executed a reviewed helper runtime\n' >&2
    exit 1
  fi
  if ! grep -Fq \
    "executable autoreview runtime differs from its trusted pre-change snapshot" \
    "$local_stderr"; then
    printf 'changed helper runtime failed for the wrong reason:\n%s\n' \
      "$(cat "$local_stderr")" >&2
    exit 1
  fi
  if grep -Fq "reviewed helper runtime executed" "$local_stderr"; then
    printf 'reviewed helper runtime executed before the trust check\n' >&2
    exit 1
  fi
  if [[ -e "$changed_runtime_bundle" ]]; then
    printf 'bundle was published with a reviewed helper runtime\n' >&2
    exit 1
  fi

  git -C "$review_repo" switch --detach "$changed_runtime_parent" >/dev/null 2>&1
  set +e
  (
    cd "$review_repo"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "$review_repo/scripts/agent-autoreview.sh" \
      --prepare-bundle-dir "$changed_runtime_commit_bundle" \
      --mode commit \
      --commit "$changed_runtime_commit" \
      --engine local >"$local_stdout" 2>"$local_stderr"
  )
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    printf 'commit bundle accepted a selected runtime change\n' >&2
    exit 1
  fi
  if ! grep -Fq \
    "executable autoreview runtime differs from its trusted pre-change snapshot" \
    "$local_stderr"; then
    printf 'selected commit runtime failed for the wrong reason:\n%s\n' \
      "$(cat "$local_stderr")" >&2
    exit 1
  fi
  if grep -Fq "reviewed helper runtime executed" "$local_stderr"; then
    printf 'selected commit runtime executed before the trust check\n' >&2
    exit 1
  fi
  if [[ -e "$changed_runtime_commit_bundle" ]]; then
    printf 'commit bundle was published with a selected runtime change\n' >&2
    exit 1
  fi
  git -C "$review_repo" switch feature >/dev/null 2>&1

  printf 'dirty branch-local work\n' >>"$review_repo/feature.txt"
  set +e
  (
    cd "$review_repo"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "$review_repo/scripts/agent-autoreview.sh" \
      --prepare-bundle-dir "$changed_runtime_local_bundle" \
      --base main \
      --engine local >"$local_stdout" 2>"$local_stderr"
  )
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    printf 'branch-local bundle executed a reviewed helper runtime\n' >&2
    exit 1
  fi
  if ! grep -Fq \
    "executable autoreview runtime differs from its trusted pre-change snapshot" \
    "$local_stderr"; then
    printf 'branch-local runtime failed for the wrong reason:\n%s\n' \
      "$(cat "$local_stderr")" >&2
    exit 1
  fi
  if grep -Fq "reviewed helper runtime executed" "$local_stderr"; then
    printf 'reviewed helper runtime executed during branch-local capture\n' >&2
    exit 1
  fi
  if [[ -e "$changed_runtime_local_bundle" ]]; then
    printf 'branch-local bundle was published with a reviewed helper runtime\n' >&2
    exit 1
  fi

  init_review_repo "$hostile_base_repo"
  mkdir -p "$hostile_base_repo/scripts"
  cp "$repo_root/scripts/agent-autoreview.sh" \
    "$repo_root/scripts/agent-autoreview.mjs" \
    "$repo_root/scripts/agent-autoreview-core.mjs" \
    "$hostile_base_repo/scripts/"
  chmod +x \
    "$hostile_base_repo/scripts/agent-autoreview.sh" \
    "$hostile_base_repo/scripts/agent-autoreview.mjs"
  printf 'protected main\n' >"$hostile_base_repo/README.md"
  commit_review_repo "$hostile_base_repo" init
  git -C "$hostile_base_repo" switch -c release >/dev/null 2>&1
  printf '\nwriteFileSync("%s", "hostile base helper executed\\n");\n' \
    "$hostile_base_marker" \
    >>"$hostile_base_repo/scripts/agent-autoreview.mjs"
  commit_review_repo "$hostile_base_repo" "poison release helper runtime"
  git -C "$hostile_base_repo" switch -c feature >/dev/null 2>&1
  printf 'feature\n' >"$hostile_base_repo/feature.txt"
  commit_review_repo "$hostile_base_repo" feature
  printf 'require("node:fs").writeFileSync("%s", "NODE_OPTIONS executed\\n");\n' \
    "$node_options_marker" >"$node_options_hook"

  set +e
  (
    cd "$hostile_base_repo"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "GH_TOKEN=must-not-reach-hostile-base-helper" \
      "NODE_OPTIONS=--require=$node_options_hook" \
      "$hostile_base_repo/scripts/agent-autoreview.sh" \
      --prepare-bundle-dir "$hostile_base_bundle" \
      --mode branch \
      --base release \
      --engine local >"$local_stdout" 2>"$local_stderr"
  )
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    printf 'branch bundle accepted a helper runtime inherited from a hostile base\n' >&2
    exit 1
  fi
  if ! grep -Fq \
    "executable autoreview runtime differs from its trusted pre-change snapshot" \
    "$local_stderr"; then
    printf 'hostile-base helper failed for the wrong reason:\n%s\n' \
      "$(cat "$local_stderr")" >&2
    exit 1
  fi
  if [[ -e "$hostile_base_marker" ]]; then
    printf 'hostile-base helper executed with the wrapper environment\n' >&2
    exit 1
  fi
  if [[ -e "$node_options_marker" ]]; then
    printf 'ambient NODE_OPTIONS executed during protected runtime checks\n' >&2
    exit 1
  fi
  if [[ -e "$hostile_base_bundle" ]]; then
    printf 'bundle was published with a hostile-base helper runtime\n' >&2
    exit 1
  fi

  set +e
  (
    cd "$hostile_base_repo"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "GH_TOKEN=must-not-reach-hostile-base-helper" \
      "NODE_OPTIONS=--require=$node_options_hook" \
      "$hostile_base_repo/scripts/agent-autoreview.sh" \
      --mode branch \
      --base release \
      --engine local \
      --dry-run >"$local_stdout" 2>"$local_stderr"
  )
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    printf 'direct review accepted a helper runtime inherited from a hostile base\n' >&2
    exit 1
  fi
  if [[ -e "$hostile_base_marker" || -e "$node_options_marker" ]]; then
    printf 'hostile runtime hook executed during direct review trust checks\n' >&2
    exit 1
  fi

  git -C "$hostile_base_repo" checkout main -- \
    scripts/agent-autoreview.sh \
    scripts/agent-autoreview.mjs \
    scripts/agent-autoreview-core.mjs
  commit_review_repo "$hostile_base_repo" "restore protected runtime"
  (
    cd "$hostile_base_repo"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "GH_TOKEN=must-not-reach-hostile-base-helper" \
      "NODE_OPTIONS=--require=$node_options_hook" \
      "$hostile_base_repo/scripts/agent-autoreview.sh" \
      --prepare-bundle-dir "$hostile_base_trusted_bundle" \
      --mode branch \
      --base release \
      --engine local >"$local_stdout" 2>"$local_stderr"
  )
  expect_file_exists "$hostile_base_trusted_bundle/autoreview-prompt.md"
  expect_file_contains \
    "$hostile_base_trusted_bundle/changed-paths.txt" \
    "feature.txt"
  if [[ -e "$hostile_base_marker" || -e "$node_options_marker" ]]; then
    printf 'hostile runtime hook executed despite restored protected HEAD\n' >&2
    exit 1
  fi
  if [[ -s "$local_stderr" ]]; then
    printf 'protected hostile-base bundle wrote stderr:\n%s\n' \
      "$(cat "$local_stderr")" >&2
    exit 1
  fi

  (
    cd "$hostile_base_repo"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "GH_TOKEN=must-not-reach-hostile-base-helper" \
      "NODE_OPTIONS=--require=$node_options_hook" \
      "$hostile_base_repo/scripts/agent-autoreview.sh" \
      --mode branch \
      --base release \
      --engine local \
      --dry-run >"$local_stdout" 2>"$local_stderr"
  )
  expect_file_contains "$local_stdout" "engine: local"
  if [[ -e "$hostile_base_marker" || -e "$node_options_marker" ]]; then
    printf 'hostile runtime hook executed during protected direct review\n' >&2
    exit 1
  fi
  if [[ -s "$local_stderr" ]]; then
    printf 'protected direct review wrote stderr:\n%s\n' \
      "$(cat "$local_stderr")" >&2
    exit 1
  fi

  mkdir "$hostile_direct_tmp" "$repo_local_direct_tmp"
  chmod 0777 "$hostile_direct_tmp"
  (
    cd "$hostile_base_repo"
    env -i \
      "PATH=$terminal_manifest_node_dir" \
      "HOME=$HOME" \
      "TMPDIR=$hostile_direct_tmp" \
      "AUTOREVIEW_TEST_REAL_NODE=$node_bin" \
      "AUTOREVIEW_TEST_DIRECT_TMP_ROOT=$hostile_direct_tmp" \
      "AUTOREVIEW_TEST_DIRECT_TMP_MARKER=$hostile_direct_tmp_marker" \
      "$hostile_base_repo/scripts/agent-autoreview.sh" \
      --mode branch \
      --base release \
      --engine local \
      --dry-run >"$local_stdout" 2>"$local_stderr"
  )
  expect_file_contains "$local_stdout" "engine: local"
  if [[ -e "$hostile_direct_tmp_marker" ]]; then
    printf 'direct helper runtime used caller-controlled shared-writable TMPDIR\n' >&2
    exit 1
  fi
  if [[ -s "$local_stderr" ]]; then
    printf 'hostile-TMPDIR direct review wrote stderr:\n%s\n' \
      "$(cat "$local_stderr")" >&2
    exit 1
  fi

  (
    cd "$hostile_base_repo"
    env -i \
      "PATH=$terminal_manifest_node_dir" \
      "HOME=$HOME" \
      "TMPDIR=$repo_local_direct_tmp" \
      "AUTOREVIEW_TEST_REAL_NODE=$node_bin" \
      "AUTOREVIEW_TEST_DIRECT_TMP_ROOT=$repo_local_direct_tmp" \
      "AUTOREVIEW_TEST_DIRECT_TMP_MARKER=$repo_local_direct_tmp_marker" \
      "$hostile_base_repo/scripts/agent-autoreview.sh" \
      --mode branch \
      --base release \
      --engine local \
      --dry-run >"$local_stdout" 2>"$local_stderr"
  )
  expect_file_contains "$local_stdout" "engine: local"
  if [[ -e "$repo_local_direct_tmp_marker" ]]; then
    printf 'direct helper runtime contaminated a repo-local TMPDIR\n' >&2
    exit 1
  fi
  if [[ -s "$local_stderr" ]]; then
    printf 'repo-local-TMPDIR direct review wrote stderr:\n%s\n' \
      "$(cat "$local_stderr")" >&2
    exit 1
  fi

  set +e
  (
    cd "$hostile_base_repo"
    env -i \
      "PATH=$terminal_manifest_node_dir" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "AUTOREVIEW_TEST_REAL_NODE=$node_bin" \
      "AUTOREVIEW_TEST_DIRECT_IDENTITY_MARKER=$direct_identity_marker" \
      "$hostile_base_repo/scripts/agent-autoreview.sh" \
      --mode branch \
      --base release \
      --engine local \
      --dry-run >"$local_stdout" 2>"$local_stderr"
  )
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    printf 'direct review ignored a changed helper-runtime identity\n' >&2
    exit 1
  fi
  expect_file_exists "$direct_identity_marker"
  expect_file_contains \
    "$local_stderr" \
    "direct helper runtime identity changed before launch"
  expect_file_not_contains "$local_stdout" "engine: local"
  changed_runtime_path="$(cat "$direct_identity_marker")"
  case "$changed_runtime_path" in
    /tmp/agent-autoreview-direct.* | /private/tmp/agent-autoreview-direct.*) ;;
    *)
      printf 'identity test reported an unexpected runtime path: %s\n' \
        "$changed_runtime_path" >&2
      exit 1
      ;;
  esac
  if [[ -L "$changed_runtime_path" || -L "$changed_runtime_path.identity-test-original" ]]; then
    printf 'identity test runtime cleanup target became a symlink\n' >&2
    exit 1
  fi
  rm -rf -- \
    "$changed_runtime_path" \
    "$changed_runtime_path.identity-test-original"

  if [[
    "$(/usr/bin/uname -s)" == "Darwin" &&
      ! -x /usr/bin/node &&
      ! -x /bin/node &&
      ! -x /usr/sbin/node &&
      ! -x /sbin/node
  ]]; then
    mkdir "$unsafe_native_node_bin"
    chmod 0777 "$unsafe_native_node_bin"
    cp "$terminal_manifest_node" "$unsafe_native_node_bin/node"
    chmod 0755 "$unsafe_native_node_bin/node"
    (
      cd "$hostile_base_repo"
      env -i \
        "PATH=$unsafe_native_node_bin" \
        "HOME=$HOME" \
        "TMPDIR=${TMPDIR:-/tmp}" \
        "AUTOREVIEW_TEST_REAL_NODE=$node_bin" \
        "AUTOREVIEW_TEST_NODE_ARGV0_MARKER=$native_node_argv0_marker" \
        "$hostile_base_repo/scripts/agent-autoreview.sh" \
        --mode branch \
        --base release \
        --engine local \
        --dry-run >"$local_stdout" 2>"$local_stderr"
    )
    expect_file_contains "$local_stdout" "engine: local"
    expect_file_exists "$native_node_argv0_marker"
    native_node_argv0="$(cat "$native_node_argv0_marker")"
    if [[ "$native_node_argv0" == "$unsafe_native_node_bin/node" ]]; then
      printf 'unsafe native Node candidate executed without a sealed snapshot\n' >&2
      exit 1
    fi
    case "$native_node_argv0" in
      */agent-autoreview-command-runtime.*/node.*) ;;
      *)
        printf 'native Node did not execute from the sealed command runtime: %s\n' \
          "$native_node_argv0" >&2
        exit 1
        ;;
    esac
    if [[ -s "$local_stderr" ]]; then
      printf 'snapshotted native-node direct review wrote stderr:\n%s\n' \
        "$(cat "$local_stderr")" >&2
      exit 1
    fi
  fi
}

run_prepared_untracked_symlink_regression() {
  local review_repo="$tmp_dir/prepared-untracked-symlink"
  local bundle_dir="$tmp_dir/prepared-untracked-symlink-bundle"
  local outside_file="$tmp_dir/prepared-untracked-outside-secret"
  local secret_value="outside-secret-must-not-be-staged-$$"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'tracked change\n' >>"$review_repo/README.md"
  printf '%s\n' "$secret_value" >"$outside_file"
  ln -s "$outside_file" "$review_repo/untracked-link.txt"

  run_helper_in_repo_expect_failure "$review_repo" \
    --prepare-bundle-dir "$bundle_dir" \
    --mode local \
    --engine local
  expect_stderr_contains "untracked file"
  if grep -Fq "$secret_value" "$stdout" "$stderr"; then
    printf 'untracked symlink target leaked into adapter output\n' >&2
    exit 1
  fi
  if [[ -e "$bundle_dir" ]]; then
    printf 'bundle was published with an untracked symlink\n' >&2
    exit 1
  fi
}

run_feedback_runtime_aggregate_regression() {
  local review_repo="$tmp_dir/feedback-runtime-aggregate"
  local bundle_dir="$tmp_dir/feedback-runtime-aggregate-bundle"
  local missing_baseline_bundle="$tmp_dir/feedback-runtime-missing-baseline-bundle"
  local protected_main_oid
  local runtime_file
  init_review_repo "$review_repo"
  git -C "$review_repo" remote add origin \
    https://github.com/mento-protocol/monitoring-monorepo.git
  mkdir -p "$review_repo/scripts"
  printf 'base\n' >"$review_repo/README.md"
  dd if=/dev/zero bs=1100000 count=1 2>/dev/null |
    tr '\000' 'a' >"$review_repo/scripts/pr-feedback-state.mjs"
  dd if=/dev/zero bs=1100000 count=1 2>/dev/null |
    tr '\000' 'b' >"$review_repo/scripts/pr-feedback-state-core.mjs"
  for runtime_file in \
    pr-ready-state.mjs \
    pr-ready-state-core.mjs \
    pr-ready-state-format.mjs; do
    printf 'export {};\n' >"$review_repo/scripts/$runtime_file"
  done
  commit_review_repo "$review_repo" init
  protected_main_oid="$(git -C "$review_repo" rev-parse HEAD)"
  git -C "$review_repo" update-ref -d refs/remotes/origin/main
  git -C "$review_repo" update-ref refs/remotes/origin/release HEAD
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  printf 'feature\n' >"$review_repo/feature.txt"
  commit_review_repo "$review_repo" feature

  run_helper_in_repo_expect_failure "$review_repo" \
    --prepare-bundle-dir "$missing_baseline_bundle" \
    --mode branch \
    --base origin/release \
    --feedback-pr 1299 \
    --engine local
  expect_stderr_contains \
    "protected policy/runtime baseline is unavailable: origin/main"
  if [[ -e "$missing_baseline_bundle" ]]; then
    printf 'bundle was published without a protected policy/runtime baseline\n' >&2
    exit 1
  fi

  git -C "$review_repo" update-ref \
    refs/remotes/origin/main \
    "$protected_main_oid"
  run_helper_in_repo_expect_failure "$review_repo" \
    --prepare-bundle-dir "$bundle_dir" \
    --mode branch \
    --base origin/release \
    --feedback-pr 1299 \
    --engine local
  expect_stderr_contains "trusted feedback runtime exceeds the 2097152-byte aggregate limit"
  if [[ -e "$bundle_dir" ]]; then
    printf 'bundle was published after oversized feedback runtime preflight\n' >&2
    exit 1
  fi
}

run_large_untracked_bound_regression() {
  local review_repo="$tmp_dir/large-untracked-bound"
  local branch_bundle="$tmp_dir/large-untracked-branch-bundle"
  local commit_bundle="$tmp_dir/large-untracked-commit-bundle"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  printf 'feature\n' >"$review_repo/feature.txt"
  commit_review_repo "$review_repo" "add feature file"
  dd if=/dev/zero of="$review_repo/large.bin" bs=1048576 count=5 2>/dev/null

  run_node_helper_in_repo_expect_failure "$review_repo" --source-snapshot-only
  expect_stderr_contains "untracked file is too large to review safely"
  run_node_helper_in_repo_expect_failure "$review_repo" --mode local --engine local
  expect_stderr_contains "untracked file is too large to review safely"

  run_helper_in_repo "$review_repo" --mode branch --base main --engine local
  expect_stdout_contains "autoreview target: branch"
  expect_stdout_contains "autoreview clean"
  expect_empty_stderr

  run_helper_in_repo "$review_repo" --mode commit --commit HEAD --engine local
  expect_stdout_contains "autoreview target: commit"
  expect_stdout_contains "autoreview clean"
  expect_empty_stderr

  run_helper_in_repo "$review_repo" \
    --prepare-bundle-dir "$branch_bundle" \
    --mode branch \
    --base main \
    --engine local
  expect_file_contains "$branch_bundle/changed-paths.txt" "feature.txt"
  expect_file_not_contains "$branch_bundle/changed-paths.txt" "large.bin"
  if [[ -e "$branch_bundle/patches/untracked.diff" ]]; then
    printf 'branch bundle unexpectedly captured unrelated untracked content\n' >&2
    exit 1
  fi
  expect_empty_stderr

  run_helper_in_repo "$review_repo" \
    --prepare-bundle-dir "$commit_bundle" \
    --mode commit \
    --commit HEAD \
    --engine local
  expect_file_contains "$commit_bundle/changed-paths.txt" "feature.txt"
  expect_file_not_contains "$commit_bundle/changed-paths.txt" "large.bin"
  if [[ -e "$commit_bundle/patches/untracked.diff" ]]; then
    printf 'commit bundle unexpectedly captured unrelated untracked content\n' >&2
    exit 1
  fi
  expect_empty_stderr
}

run_aggregate_untracked_bound_regression() {
  local review_repo="$tmp_dir/aggregate-untracked-bound"
  local bundle_output="$tmp_dir/aggregate-untracked-prompt.md"
  local adapter_bundle="$tmp_dir/aggregate-untracked-bundle"
  local index
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  for index in 1 2 3 4 5 6; do
    dd if=/dev/zero bs=819200 count=1 2>/dev/null |
      tr '\000' 'a' >"$review_repo/large-$index.txt"
  done

  run_node_helper_in_repo_expect_failure "$review_repo" \
    --mode local \
    --engine local \
    --prepare-only \
    --bundle-output "$bundle_output"
  expect_stderr_contains "aggregate limit"

  run_helper_in_repo_expect_failure "$review_repo" \
    --prepare-bundle-dir "$adapter_bundle" \
    --mode local \
    --engine local
  expect_stderr_contains "capture budget"
  if [[ -e "$adapter_bundle" ]]; then
    printf 'aggregate-overflow prepared bundle was published\n' >&2
    exit 1
  fi
}

run_bundle_output_deferred_regression() {
  local review_repo="$tmp_dir/bundle-output-deferred"
  local fake_bin="$tmp_dir/bundle-output-deferred-bin"
  local bundle_output="$review_repo/review-output.md"
  local bundle_output_display="/published/review-output.md"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"
  printf 'review-output.md\n' >>"$review_repo/.git/info/exclude"
  mkdir "$fake_bin"
  cat >"$fake_bin/claude" <<CLAUDE
#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf '2.1.210\n'
  exit 0
fi
if [[ "\${1:-}" == "--help" ]]; then
  printf '%s\n' --safe-mode --setting-sources --strict-mcp-config --disallowedTools --tools
  exit 0
fi
cat >/dev/null
if [[ -e "$bundle_output" ]]; then
  printf 'bundle output existed before semantic review\n' >&2
  exit 91
fi
cat <<'JSON'
{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}
JSON
CLAUDE
  chmod +x "$fake_bin/claude"

  run_helper_with_path_in_repo "$review_repo" "$fake_bin" --mode local --engine claude --no-tools --bundle-output review-output.md --bundle-output-display "$bundle_output_display"
  expect_file_exists "$bundle_output"
  expect_stdout_contains "bundle_output: $bundle_output_display"
  expect_stdout_contains "autoreview clean"
  expect_empty_stderr
}

run_claude_multi_pass_regression() {
  local review_repo="$tmp_dir/claude-multi-pass"
  local fake_bin="$tmp_dir/fake-claude-multi-bin"
  local bundle_output="$tmp_dir/claude-multi-pass-prompt.md"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  awk 'BEGIN { for (i = 1; i <= 26000; i += 1) printf "review-line-%06d payload payload payload\n", i; print "TAIL_SENTINEL" }' >"$review_repo/large.txt"
  mkdir "$fake_bin"
  cat >"$fake_bin/claude" <<'CLAUDE'
#!/usr/bin/env bash
printf 'invoked\n' >"$AUTOREVIEW_FAKE_CAPTURE.invoked"
if [[ "${1:-}" == "--version" ]]; then
  printf '2.1.210\n'
  exit 0
fi
if [[ "${1:-}" == "--help" ]]; then
  printf '%s\n' --safe-mode --setting-sources --strict-mcp-config --disallowedTools --tools
  exit 0
fi
cat >/dev/null
cat <<'JSON'
{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}
JSON
CLAUDE
  chmod +x "$fake_bin/claude"

  if ! run_helper_with_path_in_repo "$review_repo" "$fake_bin" \
    --mode local \
    --engine claude \
    --no-tools \
    --prepare-only \
    --bundle-output "$bundle_output"; then
    printf 'multi-pass prepare failed\nstdout:\n%s\nstderr:\n%s\n' \
      "$(cat "$stdout")" "$(cat "$stderr")" >&2
    exit 1
  fi
  local pass_files=("$tmp_dir"/claude-multi-pass-prompt.pass-*.md)
  local pass_count="${#pass_files[@]}"
  local index_pass_count
  if [[ ! -f "${pass_files[0]}" ]]; then
    printf 'expected prepare-only to emit bounded pass files\n' >&2
    exit 1
  fi
  if [[ "$pass_count" -lt 2 || "$pass_count" -gt 8 ]]; then
    printf 'expected 2-8 prepared review passes, got %s\n' "$pass_count" >&2
    exit 1
  fi
  expect_file_contains "$bundle_output" "One reviewer must inspect every pass"
  index_pass_count="$(grep -c '^- Pass ' "$bundle_output")"
  if [[ "$index_pass_count" -ne "$pass_count" ]]; then
    printf 'expected prompt index to list all %s passes, listed %s\n' "$pass_count" "$index_pass_count" >&2
    exit 1
  fi
  local pass_file
  for pass_file in "${pass_files[@]}"; do
    expect_file_contains "$bundle_output" "$(basename "$pass_file")"
  done
  expect_file_contains "${pass_files[0]}" "Do not issue a final verdict until you have inspected every pass"
  expect_file_not_contains "${pass_files[0]}" "Reports from all passes are merged"
  if [[ -e "$capture.invoked" ]]; then
    printf 'Claude executed during prepare-only multi-pass bundle creation\n' >&2
    exit 1
  fi
  if ! grep -Fq -- "TAIL_SENTINEL" "${pass_files[@]}"; then
    printf 'expected the final sentinel in one prepared review pass\n' >&2
    exit 1
  fi
  expect_stdout_contains "adapter-published bundles must follow their README"
  expect_stdout_contains "bound post-review check with that retained digest"
  expect_empty_stderr

  rm -f "$capture.invoked"
  run_helper_with_path_in_repo_expect_failure "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  expect_stderr_contains "independent engine invocations cannot safely detect cross-pass defects"
  expect_stderr_contains "--prepare-bundle-dir <dir>"
  expect_stderr_contains "standalone-helper users should rerun with --prepare-only --bundle-output <path>"
  if [[ -e "$capture.invoked" ]]; then
    printf 'Claude executed despite an unsafe multi-pass semantic target\n' >&2
    exit 1
  fi
  expect_stdout_not_contains "autoreview clean"
}

run_heartbeat_regression() {
  local review_repo="$tmp_dir/heartbeat"
  local fake_bin="$tmp_dir/fake-claude-heartbeat-bin"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"
  mkdir "$fake_bin"
  cat >"$fake_bin/claude" <<'CLAUDE'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  printf '2.1.210\n'
  exit 0
fi
if [[ "${1:-}" == "--help" ]]; then
  printf '%s\n' --safe-mode --setting-sources --strict-mcp-config --disallowedTools --tools
  exit 0
fi
cat >/dev/null
sleep 2
cat <<'JSON'
{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}
JSON
CLAUDE
  chmod +x "$fake_bin/claude"

  AUTOREVIEW_HEARTBEAT_SECONDS=1 run_helper_with_path_in_repo "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  expect_stderr_contains "review still running: claude elapsed=1s pid="
  expect_stdout_contains "autoreview clean"
}

run_hostile_git_path_regression() {
  local review_repo="$tmp_dir/hostile-git-path"
  local fake_bin="$review_repo/bin"
  local outside_symlink_bin="$tmp_dir/outside-symlink-git-bin"
  local group_writable_bin="$tmp_dir/group-writable-git-bin"
  local world_writable_bin="$tmp_dir/world-writable-git-bin"
  local external_bin="$tmp_dir/external-git-bin"
  local repo_marker="$tmp_dir/repo-git-ran"
  local group_writable_marker="$tmp_dir/group-writable-git-ran"
  local world_writable_marker="$tmp_dir/world-writable-git-ran"
  local external_marker="$tmp_dir/external-git-ran"
  local system_git
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"
  mkdir \
    "$fake_bin" \
    "$outside_symlink_bin" \
    "$group_writable_bin" \
    "$world_writable_bin" \
    "$external_bin"
  chmod 0775 "$group_writable_bin"
  chmod 0757 "$world_writable_bin"
  cat >"$fake_bin/git" <<GIT
#!/usr/bin/env bash
printf 'unsafe\n' >"$repo_marker"
exit 99
GIT
  chmod +x "$fake_bin/git"
  ln -s "$fake_bin/git" "$outside_symlink_bin/git"
  cat >"$group_writable_bin/git" <<GIT
#!/bin/bash
printf 'unsafe\n' >"$group_writable_marker"
exit 99
GIT
  cat >"$world_writable_bin/git" <<GIT
#!/bin/bash
printf 'unsafe\n' >"$world_writable_marker"
exit 99
GIT
  chmod 0755 "$group_writable_bin/git" "$world_writable_bin/git"
  system_git="$(command -v git)"
  cat >"$external_bin/git" <<GIT
#!/usr/bin/env bash
printf 'safe external git\n' >"$external_marker"
exec "$system_git" "\$@"
GIT
  chmod +x "$external_bin/git"

  run_helper_with_path_in_repo \
    "$review_repo" \
    "$fake_bin:$outside_symlink_bin:$group_writable_bin:$world_writable_bin:$external_bin" \
    --mode local \
    --engine local
  if [[ -e "$repo_marker" ]]; then
    printf 'repo-local git shim executed\n' >&2
    exit 1
  fi
  if [[ -e "$group_writable_marker" ]]; then
    printf 'git shim under group-writable ancestry executed\n' >&2
    exit 1
  fi
  if [[ -e "$world_writable_marker" ]]; then
    printf 'git shim under world-writable ancestry executed\n' >&2
    exit 1
  fi
  expect_file_exists "$external_marker"
  expect_stdout_contains "autoreview clean"
  expect_empty_stderr
}

run_unsafe_script_fallback_regressions() {
  local review_repo="$tmp_dir/unsafe-script-fallbacks"
  local group_writable_bin="$tmp_dir/group-writable-script-bin"
  local world_writable_bin="$tmp_dir/world-writable-script-bin"
  local trusted_bin="$tmp_dir/trusted-script-fallback-bin"
  local group_node_marker="$tmp_dir/group-writable-node-ran"
  local world_node_marker="$tmp_dir/world-writable-node-ran"
  local group_codex_marker="$tmp_dir/group-writable-codex-ran"
  local world_codex_marker="$tmp_dir/world-writable-codex-ran"
  local node_exec
  local status=0
  local system_git

  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"

  mkdir "$group_writable_bin" "$world_writable_bin" "$trusted_bin"
  chmod 0775 "$group_writable_bin"
  chmod 0757 "$world_writable_bin"
  chmod 0700 "$trusted_bin"
  system_git="$(command -v git)"
  node_exec="$("$node_bin" -p 'process.execPath')"
  cat >"$trusted_bin/git" <<GIT
#!/bin/bash
exec "$system_git" "\$@"
GIT
  chmod 0755 "$trusted_bin/git"

  cat >"$group_writable_bin/node" <<NODE
#!/bin/bash
printf 'unsafe\n' >"$group_node_marker"
exit 99
NODE
  cat >"$world_writable_bin/node" <<NODE
#!/bin/bash
printf 'unsafe\n' >"$world_node_marker"
exit 99
NODE
  chmod 0755 "$group_writable_bin/node" "$world_writable_bin/node"

  : >"$stdout"
  : >"$stderr"
  status=0
  (
    cd "$review_repo"
    env -i \
      "PATH=$group_writable_bin:$world_writable_bin" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      /bin/bash "$repo_root/scripts/agent-autoreview.sh" \
      --mode local \
      --engine local \
      --dry-run >"$stdout" 2>"$stderr"
  ) || status=$?
  if [[ "$status" -eq 0 ]]; then
    printf 'adapter accepted only node scripts under unsafe ancestry\n' >&2
    exit 1
  fi
  expect_stderr_contains "requires a trusted node executable"
  if [[ -e "$group_node_marker" || -e "$world_node_marker" ]]; then
    printf 'node script under shared-writable ancestry executed\n' >&2
    exit 1
  fi

  ln -s "$node_exec" "$trusted_bin/node"
  : >"$stdout"
  : >"$stderr"
  status=0
  (
    cd "$review_repo"
    env -i \
      "PATH=$group_writable_bin:$world_writable_bin:$trusted_bin" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      /bin/bash "$repo_root/scripts/agent-autoreview.sh" \
      --mode local \
      --engine local \
      --dry-run >"$stdout" 2>"$stderr"
  ) || status=$?
  if [[ "$status" -ne 0 ]]; then
    printf 'adapter rejected trusted node after unsafe PATH scripts\nstdout:\n%s\nstderr:\n%s\n' \
      "$(cat "$stdout")" "$(cat "$stderr")" >&2
    exit 1
  fi
  if [[ -e "$group_node_marker" || -e "$world_node_marker" ]]; then
    printf 'node script under shared-writable ancestry executed before trusted fallthrough\n' >&2
    exit 1
  fi

  cat >"$group_writable_bin/codex" <<CODEX
#!/bin/bash
printf 'unsafe\n' >"$group_codex_marker"
exit 99
CODEX
  cat >"$world_writable_bin/codex" <<CODEX
#!/bin/bash
printf 'unsafe\n' >"$world_codex_marker"
exit 99
CODEX
  chmod 0755 "$group_writable_bin/codex" "$world_writable_bin/codex"

  : >"$stdout"
  : >"$stderr"
  status=0
  (
    cd "$review_repo"
    env -i \
      "PATH=$group_writable_bin:$world_writable_bin:$trusted_bin" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "GIT_CONFIG_GLOBAL=/dev/null" \
      "$node_exec" "$repo_root/scripts/agent-autoreview.mjs" \
      --mode local \
      --engine codex >"$stdout" 2>"$stderr"
  ) || status=$?
  if [[ "$status" -eq 0 ]]; then
    printf 'direct helper accepted codex scripts under unsafe ancestry\n' >&2
    exit 1
  fi
  expect_stderr_contains "codex CLI is not available"
  if [[ -e "$group_codex_marker" || -e "$world_codex_marker" ]]; then
    printf 'codex script under shared-writable ancestry executed\n' >&2
    exit 1
  fi
}

run_privileged_shebang_startup_regression() {
  local review_repo="$tmp_dir/privileged-shebang-startup"
  local startup_payload="$tmp_dir/hostile-bash-env.sh"
  local bash_env_marker="$tmp_dir/hostile-bash-env-ran"
  local function_marker="$tmp_dir/imported-pwd-function-ran"
  local imported_function
  local status=0

  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"
  printf 'printf '\''hostile startup payload ran\\n'\'' >"%s"\n' \
    "$bash_env_marker" >"$startup_payload"
  imported_function="() { printf 'hostile imported function ran\\n' >\"$function_marker\"; builtin pwd \"\$@\"; }"

  env -i \
    "PATH=/usr/bin:/bin" \
    "BASH_ENV=$startup_payload" \
    "BASH_FUNC_pwd%%=$imported_function" \
    /bin/bash -c 'pwd >/dev/null'
  expect_file_exists "$bash_env_marker"
  expect_file_exists "$function_marker"
  rm -f "$bash_env_marker" "$function_marker"

  : >"$stdout"
  : >"$stderr"
  (
    cd "$review_repo"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "BASH_ENV=$startup_payload" \
      "BASH_FUNC_pwd%%=$imported_function" \
      "$repo_root/scripts/agent-autoreview.sh" \
      --mode local \
      --engine local \
      --dry-run >"$stdout" 2>"$stderr"
  ) || status=$?
  if [[ "$status" -ne 0 ]]; then
    printf 'privileged shebang startup regression failed\nstdout:\n%s\nstderr:\n%s\n' \
      "$(cat "$stdout")" "$(cat "$stderr")" >&2
    exit 1
  fi
  if [[ -e "$bash_env_marker" || -e "$function_marker" ]]; then
    printf 'direct wrapper evaluated hostile Bash startup state before sanitizing it\n' >&2
    exit 1
  fi
  expect_stdout_contains "engine: local"
  expect_empty_stderr
}

run_hostile_volta_environment_regression() {
  local review_repo="$tmp_dir/hostile-volta-environment"
  local hostile_home="$tmp_dir/hostile-volta-home"
  local hostile_volta_home="$hostile_home/.volta"
  local shim_bin="$tmp_dir/hostile-volta-shim-bin"
  local fake_node_marker="$tmp_dir/hostile-volta-node-ran"
  local node_command
  local node_resolved
  local node_version
  local fake_node
  local hostile_selection
  local optimized_path
  local status=0
  local volta_command
  local fixed_node

  optimized_path="$PATH"
  PATH="$original_path"
  node_command="$(command -v node || true)"
  volta_command="$(command -v volta || true)"
  PATH="$optimized_path"
  [[ -n "$node_command" && -n "$volta_command" ]] || return 0
  node_resolved="$(
    /usr/bin/perl -MCwd=abs_path -e '
      my $resolved = abs_path($ARGV[0]);
      exit 1 if !defined($resolved);
      print "$resolved\\n";
    ' "$node_command" 2>/dev/null
  )" || return 0
  [[ "${node_resolved##*/}" == "volta-shim" ]] || return 0
  for fixed_node in /usr/bin/node /bin/node /usr/sbin/node /sbin/node; do
    [[ ! -x "$fixed_node" ]] || return 0
  done

  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"
  node_version="$("$node_bin" -p 'process.versions.node')"
  fake_node="$hostile_volta_home/tools/image/node/$node_version/bin/node"
  mkdir -p \
    "$hostile_volta_home/tools/user" \
    "$hostile_volta_home/tools/inventory/node" \
    "${fake_node%/*}" \
    "$shim_bin"
  printf \
    '{"node":{"runtime":"%s","npm":null},"pnpm":null,"yarn":null}\n' \
    "$node_version" >"$hostile_volta_home/tools/user/platform.json"
  printf '10.0.0\n' \
    >"$hostile_volta_home/tools/inventory/node/node-v${node_version}-npm"
  cat >"$fake_node" <<NODE
#!/bin/bash
printf 'hostile Volta node ran\n' >"$fake_node_marker"
exit 99
NODE
  chmod 0755 "$fake_node"
  ln -s "$node_command" "$shim_bin/node"

  hostile_selection="$(
    env -i \
      "PATH=/usr/bin:/bin" \
      "HOME=$hostile_home" \
      "VOLTA_HOME=$hostile_volta_home" \
      "$volta_command" which node 2>/dev/null
  )" || return 0
  [[ "$hostile_selection" == "$fake_node" ]] || return 0

  : >"$stdout"
  : >"$stderr"
  (
    cd "$review_repo"
    env -i \
      "PATH=$shim_bin" \
      "HOME=$hostile_home" \
      "VOLTA_HOME=$hostile_volta_home" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "$repo_root/scripts/agent-autoreview.sh" \
      --mode local \
      --engine local \
      --dry-run >"$stdout" 2>"$stderr"
  ) || status=$?
  if [[ "$status" -ne 0 ]]; then
    printf 'trusted Volta discovery failed with hostile HOME/VOLTA_HOME\nstdout:\n%s\nstderr:\n%s\n' \
      "$(cat "$stdout")" "$(cat "$stderr")" >&2
    exit 1
  fi
  if [[ -e "$fake_node_marker" ]]; then
    printf 'hostile HOME/VOLTA_HOME selected and executed a fake node\n' >&2
    exit 1
  fi
  expect_stdout_contains "engine: local"
  expect_empty_stderr
}

run_sensitive_input_regressions() {
  local review_repo="$tmp_dir/sensitive-inputs"
  local bundle_output="$tmp_dir/sensitive-prompt.md"
  local adapter_bundle="$tmp_dir/sensitive-adapter-bundle"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'api_key = "%s%s"\n' "live-value-" "abcdefghijklmnopqrstuvwxyz" >>"$review_repo/README.md"

  run_helper_in_repo_expect_failure "$review_repo" --mode local --engine local --bundle-output "$bundle_output" --prepare-only
  expect_stderr_contains "refusing to include secret-like content"
  if grep -Fq -- "live-value-abcdefghijklmnopqrstuvwxyz" "$stderr"; then
    printf 'secret scanner disclosed the rejected value\n' >&2
    exit 1
  fi

  run_helper_in_repo_expect_failure "$review_repo" --prepare-bundle-dir "$adapter_bundle" --mode local --engine local
  expect_stderr_contains "refusing to include secret-like content"
  if [[ -e "$adapter_bundle" ]]; then
    printf 'rejected sensitive prepared bundle was published: %s\n' "$adapter_bundle" >&2
    exit 1
  fi

  git -C "$review_repo" restore README.md
  mkdir "$review_repo/.aws"
  {
    printf '[default]\n'
    printf 'aws_access_key_id = ASIA%s\n' "AAAAAAAAAAAAAAAA"
    printf 'aws_secret_access_key = aws-secret-%s\n' "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    printf 'aws_session_token = aws-session-%s\n' "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  } >"$review_repo/.aws/credentials.example"
  run_helper_in_repo_expect_failure "$review_repo" --mode local --engine local --bundle-output "$bundle_output" --prepare-only
  expect_stderr_contains "refusing to include secret-like content"
  rm -rf "$review_repo/.aws"

  printf 'public=true\n' >"$review_repo/.env"
  run_helper_in_repo_expect_failure "$review_repo" --mode local --engine local --bundle-output "$bundle_output" --prepare-only
  expect_stderr_contains "refusing sensitive untracked file"

  rm "$review_repo/.env"
  ln -s README.md "$review_repo/linked.md"
  run_helper_in_repo_expect_failure "$review_repo" --mode local --engine local --bundle-output "$bundle_output" --prepare-only
  expect_stderr_contains "refusing symlinked untracked file"

  rm "$review_repo/linked.md"
  printf 'api_key = "%c%s"\n' 36 '{SERVICE_API_KEY}' >"$review_repo/.env"
  commit_review_repo "$review_repo" "add placeholder environment file"
  git -C "$review_repo" mv .env public-config.txt
  run_helper_in_repo_expect_failure "$review_repo" --mode local --engine local --bundle-output "$bundle_output" --prepare-only
  expect_stderr_contains "refusing to include sensitive changed paths"
}

run_override_untracked_serializer_regression() {
  local review_repo="$tmp_dir/override-untracked-serializer"
  local bundle_dir="$tmp_dir/override-untracked-serializer-bundle"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'safe untracked input\n' >"$review_repo/untracked.txt"
  rm -f "$capture.serialize"

  (
    cd "$review_repo"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "AUTOREVIEW_HELPER=$helper" \
      "AUTOREVIEW_CAPTURE=$capture" \
      "AUTOREVIEW_SNAPSHOT_HELPER=$repo_root/scripts/agent-autoreview.mjs" \
      "$repo_root/scripts/agent-autoreview.sh" \
      --prepare-bundle-dir "$bundle_dir" \
      --mode local \
      --engine local >"$stdout" 2>"$stderr"
  )

  expect_file_contains "$capture.serialize" "untracked.txt"
  expect_file_contains \
    "$bundle_dir/patches/untracked.diff" \
    'path: "untracked.txt"'
  expect_empty_stderr
}

run_default_adapter
expect_stdout_contains "engine: local"
expect_empty_stderr

run_default_adapter_in_clean_main
expect_stdout_contains "autoreview target: none"
expect_stdout_contains "branch: main"
expect_stdout_contains "engine: local"
expect_empty_stderr

run_default_adapter_with_inline_engine
expect_stdout_contains "engine: local"
expect_empty_stderr

test_focus="${AUTOREVIEW_TEST_FOCUS:-all}"
case "$test_focus" in
  engine-isolation)
    run_claude_no_tools_regression
    run_codex_isolation_regression
    run_engine_signal_cleanup_regression
    printf 'focused autoreview engine-isolation tests passed\n'
    exit 0
    ;;
  signal-cleanup)
    run_engine_signal_cleanup_regression
    printf 'focused autoreview signal-cleanup tests passed\n'
    exit 0
    ;;
  review-target-trust)
    run_review_target_metadata_regression
    run_trusted_helper_runtime_regression
    printf 'focused autoreview target/trust tests passed\n'
    exit 0
    ;;
  adapter | all) ;;
  *)
    printf 'unknown AUTOREVIEW_TEST_FOCUS: %s\n' "$AUTOREVIEW_TEST_FOCUS" >&2
    exit 2
    ;;
esac

if [[ "$test_focus" == "all" ]]; then
  run_parallel_tests_removed_regression
  run_review_target_metadata_regression
  run_branch_diff_check_regression
  run_local_deleted_reference_regression
  run_commit_target_reads_selected_ref_regression
  run_non_utf8_git_blob_regression
  run_non_utf8_git_path_regression
  run_auto_dirty_branch_regression
  run_branch_local_diff_check_fixed_regression
  run_branch_local_deleted_reference_regression
  run_branch_local_deleted_reference_fixed_regression
  run_requested_codex_missing_regression
  run_claude_no_tools_regression
  run_codex_isolation_regression
  run_engine_signal_cleanup_regression
  run_symlinked_node_codex_regression
  run_repo_controlled_node_regression
  run_pr_base_detection_regression
  run_target_selection_drift_regression
  run_dry_run_unresolved_ref_regression
  run_dirty_source_drift_regression
  run_untracked_churn_scope_regression
  run_index_source_drift_regression
  run_mode_source_drift_regression
  run_branch_identity_source_drift_regression
  run_explicit_snapshot_scope_regression
  run_frozen_checklist_provenance_regression
  run_frozen_checklist_symlink_regression
  run_git_replace_ref_regression
  run_trusted_helper_runtime_regression
  run_prepared_untracked_symlink_regression
  run_feedback_runtime_aggregate_regression
  run_large_untracked_bound_regression
  run_aggregate_untracked_bound_regression
  run_bundle_output_deferred_regression
  run_claude_multi_pass_regression
  run_heartbeat_regression
  run_hostile_git_path_regression
  run_unsafe_script_fallback_regressions
  run_privileged_shebang_startup_regression
  run_hostile_volta_environment_regression
  run_sensitive_input_regressions
  run_override_untracked_serializer_regression
fi

run_adapter CODEX_SANDBOX=seatbelt --dry-run
expect_args $'--engine\nlocal\n--dry-run'
expect_stderr_contains "detected Codex sandbox"

run_adapter CODEX_THREAD_ID=example-thread --dry-run
expect_args $'--engine\nlocal\n--dry-run'
expect_stderr_contains "detected Codex sandbox"

run_adapter CODEX_SANDBOX=seatbelt --engine claude --dry-run
expect_args $'--engine\nclaude\n--dry-run'
expect_empty_stderr

run_adapter CODEX_SANDBOX=seatbelt AUTOREVIEW_ENGINE=claude --dry-run
expect_args "--dry-run"
expect_empty_stderr

run_adapter CODEX_SANDBOX=seatbelt --prepare-only --dry-run
expect_args $'--prepare-only\n--dry-run'
expect_empty_stderr

run_adapter --dry-run
expect_args "--dry-run"
expect_empty_stderr

run_adapter CODEX_SANDBOX=seatbelt -- --dry-run
expect_args $'--engine\nlocal\n--dry-run'
expect_stderr_contains "detected Codex sandbox"

run_adapter_expect_failure --feedback-pr 1040
expect_stderr_contains "requires --prepare-bundle-dir"

run_adapter_expect_failure --prepare-bundle-dir ""
expect_stderr_contains "--prepare-bundle-dir requires a non-empty directory argument"

run_adapter_expect_failure --verify-bundle-dir ""
expect_stderr_contains "--verify-bundle-dir requires a non-empty directory argument"

run_adapter_expect_failure --verify-bundle-dir .
expect_stderr_contains "--verify-bundle-dir requires a specific published bundle directory"

run_adapter_expect_failure --verify-bundle-dir //
expect_stderr_contains "--verify-bundle-dir requires a specific published bundle directory"

run_adapter_expect_failure --verify-bundle-dir ////
expect_stderr_contains "--verify-bundle-dir requires a specific published bundle directory"

run_adapter_expect_failure --expected-bundle-manifest "$(printf 'a%.0s' {1..64})"
expect_stderr_contains "--expected-bundle-manifest requires --verify-bundle-dir"

run_adapter_expect_failure \
  --verify-bundle-dir "$tmp_dir/not-a-bundle" \
  --expected-bundle-manifest not-a-digest
expect_stderr_contains "--expected-bundle-manifest must be a lowercase SHA-256 digest"

dry_run_bundle="$tmp_dir/dry-run-context-bundle"
run_adapter_expect_failure \
  --prepare-bundle-dir "$dry_run_bundle" \
  --mode branch \
  --base HEAD \
  --dry-run
expect_stderr_contains "--dry-run cannot be combined with --prepare-bundle-dir"
if [[ -e "$dry_run_bundle" ]]; then
  printf 'prepared dry-run bundle was created\n' >&2
  exit 1
fi

conflicting_bundle="$tmp_dir/conflicting-context-bundle"
conflicting_output="$tmp_dir/conflicting-prompt.md"
run_adapter_expect_failure \
  --prepare-bundle-dir "$conflicting_bundle" \
  --bundle-output "$conflicting_output" \
  --mode branch \
  --base HEAD
expect_stderr_contains "--bundle-output cannot be combined with --prepare-bundle-dir"
if [[ -e "$conflicting_bundle" || -e "$conflicting_output" ]]; then
  printf 'conflicting prepared-bundle output was created\n' >&2
  exit 1
fi

bad_snapshot_bundle="$tmp_dir/bad-snapshot-context-bundle"
run_adapter_expect_failure \
  AUTOREVIEW_FAKE_BAD_SNAPSHOT=1 \
  --prepare-bundle-dir "$bad_snapshot_bundle" \
  --mode branch \
  --base HEAD
expect_stderr_contains "AUTOREVIEW_HELPER --source-snapshot-only must print exactly one SHA-256 fingerprint"
if [[ -e "$bad_snapshot_bundle" ]]; then
  printf 'prepared bundle was published with an invalid replacement-helper snapshot\n' >&2
  exit 1
fi

missing_prompt_bundle="$tmp_dir/missing-prompt-context-bundle"
run_adapter_expect_failure \
  AUTOREVIEW_FAKE_SKIP_BUNDLE_OUTPUT=1 \
  --prepare-bundle-dir "$missing_prompt_bundle" \
  --mode branch \
  --base HEAD
expect_stderr_contains "helper did not produce a validated autoreview prompt"
if [[ -e "$missing_prompt_bundle" ]]; then
  printf 'prepared bundle was published without a validated prompt\n' >&2
  exit 1
fi

missing_pass_bundle="$tmp_dir/missing-pass-context-bundle"
run_adapter_expect_failure \
  AUTOREVIEW_FAKE_MISSING_REVIEW_PASS=1 \
  --prepare-bundle-dir "$missing_pass_bundle" \
  --mode branch \
  --base HEAD
expect_stderr_contains "helper did not produce every validated review pass"
if [[ -e "$missing_pass_bundle" ]]; then
  printf 'prepared bundle was published with a missing review pass\n' >&2
  exit 1
fi

incomplete_index_bundle="$tmp_dir/incomplete-index-context-bundle"
run_adapter_expect_failure \
  AUTOREVIEW_FAKE_INCOMPLETE_REVIEW_INDEX=1 \
  --prepare-bundle-dir "$incomplete_index_bundle" \
  --mode branch \
  --base HEAD
expect_stderr_contains "helper produced an incomplete review prompt index"
if [[ -e "$incomplete_index_bundle" ]]; then
  printf 'prepared bundle was published with an incomplete review index\n' >&2
  exit 1
fi

duplicate_pass_bundle="$tmp_dir/duplicate-pass-context-bundle"
run_adapter_expect_failure \
  AUTOREVIEW_FAKE_DUPLICATE_REVIEW_PASS=1 \
  --prepare-bundle-dir "$duplicate_pass_bundle" \
  --mode branch \
  --base HEAD
expect_stderr_contains "helper produced an invalid review pass path"
if [[ -e "$duplicate_pass_bundle" ]]; then
  printf 'prepared bundle was published with a duplicate review pass\n' >&2
  exit 1
fi

extra_pass_bundle="$tmp_dir/extra-pass-context-bundle"
run_adapter_expect_failure \
  AUTOREVIEW_FAKE_EXTRA_REVIEW_PASS=1 \
  --prepare-bundle-dir "$extra_pass_bundle" \
  --mode branch \
  --base HEAD
expect_stderr_contains "helper produced undeclared review pass files"
if [[ -e "$extra_pass_bundle" ]]; then
  printf 'prepared bundle was published with an undeclared review pass\n' >&2
  exit 1
fi

single_extra_pass_bundle="$tmp_dir/single-extra-pass-context-bundle"
run_adapter_expect_failure \
  AUTOREVIEW_FAKE_SINGLE_WITH_EXTRA_PASS=1 \
  --prepare-bundle-dir "$single_extra_pass_bundle" \
  --mode branch \
  --base HEAD
expect_stderr_contains "helper produced undeclared review pass files"
if [[ -e "$single_extra_pass_bundle" ]]; then
  printf 'single-prompt bundle was published with an undeclared review pass\n' >&2
  exit 1
fi

self_pass_bundle="$tmp_dir/self-pass-context-bundle"
run_adapter_expect_failure \
  AUTOREVIEW_FAKE_SELF_REVIEW_PASS=1 \
  --prepare-bundle-dir "$self_pass_bundle" \
  --mode branch \
  --base HEAD
expect_stderr_contains "helper produced an invalid review pass path"
if [[ -e "$self_pass_bundle" ]]; then
  printf 'prepared bundle was published with a self-referential review pass\n' >&2
  exit 1
fi

snapshot_mutation_bundle="$tmp_dir/context-bundle-snapshot-mutation"
run_adapter_expect_failure \
  AUTOREVIEW_FAKE_MUTATE_ON_SECOND_SNAPSHOT=1 \
  --prepare-bundle-dir "$snapshot_mutation_bundle" \
  --mode branch \
  --base HEAD
expect_stderr_contains "prepared-bundle evidence changed during final source validation"
if [[ -e "$snapshot_mutation_bundle" ]]; then
  printf 'prepared bundle was published after final snapshot evidence mutation\n' >&2
  exit 1
fi

helper_mutation_bundle="$tmp_dir/context-bundle-helper-mutation"
run_adapter_expect_failure \
  AUTOREVIEW_FAKE_MUTATE_WRAPPER_EVIDENCE=1 \
  --prepare-bundle-dir "$helper_mutation_bundle" \
  --mode branch \
  --base HEAD
expect_stderr_contains "helper changed wrapper-owned prepared-bundle evidence"
if [[ -e "$helper_mutation_bundle" ]]; then
  printf 'prepared bundle was published after helper mutated wrapper-owned evidence\n' >&2
  exit 1
fi

hardlink_source="$tmp_dir/hardlink-source.txt"
printf 'externally aliased evidence\n' >"$hardlink_source"
hardlink_bundle="$tmp_dir/context-bundle-hardlink"
run_adapter_expect_failure \
  "AUTOREVIEW_FAKE_HARDLINK_SOURCE=$hardlink_source" \
  --prepare-bundle-dir "$hardlink_bundle" \
  --mode branch \
  --base HEAD
expect_stderr_contains "file identity changed or is externally linked"
if [[ -e "$hardlink_bundle" ]]; then
  printf 'prepared bundle was published with externally aliased evidence\n' >&2
  exit 1
fi

bundle_dir="$tmp_dir/context-bundle"
canonical_bundle_dir="$(cd "$(dirname "$bundle_dir")" && pwd -P)/$(basename "$bundle_dir")"
protected_main_oid="$(git -C "$repo_root" rev-parse 'origin/main^{commit}')"
frozen_head="$(git -C "$repo_root" rev-parse HEAD)"
frozen_base="$(git -C "$repo_root" merge-base origin/main HEAD)"
run_adapter --prepare-bundle-dir "$bundle_dir" --mode branch --base "$frozen_base"
captured_bundle_output="$(awk 'previous == "--bundle-output" { print; exit } { previous = $0 }' "$capture")"
captured_staging_dir="$(dirname "$captured_bundle_output")"
case "$captured_bundle_output" in
  "$(dirname "$canonical_bundle_dir")"/.agent-autoreview-context.*/autoreview-prompt.md) ;;
  *)
    printf 'unexpected staged bundle output path: %s\n' "$captured_bundle_output" >&2
    exit 1
    ;;
esac
expect_file_exists "$canonical_bundle_dir/selected-checklists.txt"
first_selected_checklist="$(sed -n '1p' "$canonical_bundle_dir/selected-checklists.txt")"
second_selected_checklist="$(sed -n '2p' "$canonical_bundle_dir/selected-checklists.txt")"
if [[
  "$first_selected_checklist" != "docs/pr-checklists/recurring-review-patterns.md" ||
    "$second_selected_checklist" != "docs/pr-checklists/review-prompt-exclusions.md"
]]; then
  printf 'prepared bundle omitted or reordered mandatory review policy\n' >&2
  exit 1
fi
expected_helper_args=$'--mode\nbranch\n--base\n'"$frozen_base"$'\n--trusted-input-root\n'"$captured_staging_dir"$'\n--base\n'"$frozen_base"
selected_checklists_seen="$tmp_dir/selected-checklists-seen"
selected_basenames_seen="$tmp_dir/selected-checklist-basenames-seen"
: >"$selected_checklists_seen"
: >"$selected_basenames_seen"
while IFS= read -r selected_checklist; do
  [[ -z "$selected_checklist" ]] && continue
  case "$selected_checklist" in
    docs/pr-checklists/recurring-review-patterns.md | \
      docs/pr-checklists/review-prompt-exclusions.md | \
      docs/pr-checklists/ci-workflow-gates.md | \
      docs/pr-checklists/code-health.md | \
      docs/pr-checklists/stateful-data-ui.md | \
      docs/pr-checklists/indexer-handler-invariants.md | \
      docs/pr-checklists/swr-polling-hasura.md | \
      docs/pr-checklists/keyboard-a11y-controlled-widgets.md | \
      docs/pr-checklists/dynamic-route-metadata.md | \
      docs/pr-checklists/terraform-cloudrun.md | \
      docs/pr-checklists/mutation-testing.md) ;;
    *)
      printf 'prepared bundle selected an unknown checklist: %s\n' \
        "$selected_checklist" >&2
      exit 1
      ;;
  esac
  selected_basename="${selected_checklist##*/}"
  if grep -Fxq -- "$selected_checklist" "$selected_checklists_seen"; then
    printf 'prepared bundle selected a duplicate checklist: %s\n' \
      "$selected_checklist" >&2
    exit 1
  fi
  if grep -Fxq -- "$selected_basename" "$selected_basenames_seen"; then
    printf 'prepared bundle selected colliding checklist basenames: %s\n' \
      "$selected_basename" >&2
    exit 1
  fi
  printf '%s\n' "$selected_checklist" >>"$selected_checklists_seen"
  printf '%s\n' "$selected_basename" >>"$selected_basenames_seen"
  captured_checklist="$canonical_bundle_dir/checklists/$selected_basename"
  expect_file_exists "$captured_checklist"
  protected_checklist_mode="$(
    git -C "$repo_root" ls-tree "$protected_main_oid" -- "$selected_checklist" |
      awk 'NR == 1 { print $1 }'
  )"
  if [[
    "$protected_checklist_mode" != "100644" &&
      "$protected_checklist_mode" != "100755"
  ]]; then
    printf 'selected protected-main checklist is not a regular blob: %s\n' \
      "$selected_checklist" >&2
    exit 1
  fi
  if ! git -C "$repo_root" cat-file blob \
    "${protected_main_oid}:${selected_checklist}" | cmp -s - "$captured_checklist"; then
    printf 'captured checklist differs from protected main: %s\n' \
      "$selected_checklist" >&2
    exit 1
  fi
  expected_helper_args+=$'\n--prompt-file\n'"$captured_staging_dir/checklists/$selected_basename"
done <"$canonical_bundle_dir/selected-checklists.txt"
expected_helper_args+=$'\n--bundle-output\n'"$captured_bundle_output"$'\n--bundle-output-display\n'"$canonical_bundle_dir/autoreview-prompt.md"$'\n--prepare-only'
expect_args "$expected_helper_args"
expect_empty_stderr
expect_file_exists "$canonical_bundle_dir/README.md"
expect_file_exists "$canonical_bundle_dir/changed-paths.txt"
expect_file_exists "$canonical_bundle_dir/patches/branch.diff"
expect_file_exists "$canonical_bundle_dir/checklists/recurring-review-patterns.md"
expect_file_exists "$canonical_bundle_dir/checklists/review-prompt-exclusions.md"
expect_file_exists "$canonical_bundle_dir/autoreview-prompt.md"
expect_file_exists "$canonical_bundle_dir/helper-output.txt"
expect_file_exists "$canonical_bundle_dir/.agent-autoreview-complete"
expect_file_contains "$canonical_bundle_dir/README.md" "Autoreview Context Bundle"
expect_file_contains "$canonical_bundle_dir/README.md" "- Frozen base commit: $frozen_base"
expect_file_contains "$canonical_bundle_dir/README.md" "- Frozen reviewed HEAD: $frozen_head"
expect_file_not_contains "$canonical_bundle_dir/README.md" "Frozen target commit"
expect_file_contains \
  "$canonical_bundle_dir/README.md" \
  "$repo_root/scripts/agent-autoreview.sh --verify-bundle-dir $canonical_bundle_dir"
expect_file_not_contains \
  "$canonical_bundle_dir/README.md" \
  "pnpm agent:autoreview --verify-bundle-dir"
expect_file_contains "$canonical_bundle_dir/.agent-autoreview-complete" "autoreview-bundle-v2"
expect_file_contains "$canonical_bundle_dir/.agent-autoreview-complete" "manifest-sha256:"
expect_file_contains "$canonical_bundle_dir/selected-checklists.txt" "docs/pr-checklists/review-prompt-exclusions.md"
expect_file_contains "$canonical_bundle_dir/helper-output.txt" "$canonical_bundle_dir/autoreview-prompt.md"
expect_file_not_contains "$canonical_bundle_dir/helper-output.txt" ".agent-autoreview-context."
expect_stdout_contains "$canonical_bundle_dir/autoreview-prompt.md"
expect_stdout_not_contains ".agent-autoreview-context."
expect_file_contains "$stdout" "agent:autoreview context bundle: $canonical_bundle_dir"
if [[ "$(wc -l <"$capture.snapshot" | tr -d ' ')" != "2" ]]; then
  printf 'replacement helper did not provide both prepared-bundle source snapshots\n' >&2
  exit 1
fi

run_adapter --verify-bundle-dir "$canonical_bundle_dir"
expect_stdout_contains "agent:autoreview verified context bundle: $canonical_bundle_dir"
retained_bundle_manifest="$(
  sed -n 's/.*(manifest \([0-9a-f][0-9a-f]*\)).*/\1/p' "$stdout"
)"
if [[ ! "$retained_bundle_manifest" =~ ^[0-9a-f]{64}$ ]]; then
  printf 'verifier did not return a retainable manifest digest\n' >&2
  exit 1
fi
run_adapter \
  --verify-bundle-dir "$canonical_bundle_dir" \
  --expected-bundle-manifest "$retained_bundle_manifest"
expect_stdout_contains "manifest $retained_bundle_manifest"
if [[ "$(/usr/bin/uname -s)" == "Darwin" ]]; then
  canonical_acl_entry="$canonical_bundle_dir/README.md"
  /bin/chmod +a "everyone allow write,delete" "$canonical_acl_entry"
  run_adapter_expect_failure \
    --verify-bundle-dir "$canonical_bundle_dir" \
    --expected-bundle-manifest "$retained_bundle_manifest"
  expect_stderr_contains \
    "unsafe prepared-bundle ACL grants write access: $canonical_acl_entry"
  expect_stderr_contains "refusing to verify a bundle with unsafe entry ACLs"
  /bin/chmod -N "$canonical_acl_entry"
  run_adapter \
    --verify-bundle-dir "$canonical_bundle_dir" \
    --expected-bundle-manifest "$retained_bundle_manifest"
  expect_stdout_contains "manifest $retained_bundle_manifest"
fi

external_runtime="$tmp_dir/external-autoreview-runtime"
external_wrapper="$external_runtime/scripts/agent-autoreview.sh"
external_bundle="$tmp_dir/external-wrapper-context-bundle"
external_stdout="$tmp_dir/external-wrapper.stdout"
external_stderr="$tmp_dir/external-wrapper.stderr"
standalone_verify_cwd="$tmp_dir/standalone-verify-cwd"
hostile_cwd_node_marker="$tmp_dir/standalone-hostile-cwd-node-ran"
mkdir -p \
  "$external_runtime/scripts" \
  "$standalone_verify_cwd/bin"
cp "$terminal_manifest_node" "$standalone_verify_cwd/bin/node"
chmod +x "$standalone_verify_cwd/bin/node"
cp \
  "$repo_root/scripts/agent-autoreview.sh" \
  "$repo_root/scripts/agent-autoreview.mjs" \
  "$repo_root/scripts/agent-autoreview-core.mjs" \
  "$external_runtime/scripts/"
chmod +x \
  "$external_wrapper" \
  "$external_runtime/scripts/agent-autoreview.mjs"
(
  cd "$repo_root"
  env -i \
    "PATH=$PATH" \
    "HOME=$HOME" \
    "TMPDIR=${TMPDIR:-/tmp}" \
    "AUTOREVIEW_HELPER=$helper" \
    "AUTOREVIEW_CAPTURE=$capture" \
    "AUTOREVIEW_SNAPSHOT_HELPER=$repo_root/scripts/agent-autoreview.mjs" \
    "$external_wrapper" \
    --prepare-bundle-dir "$external_bundle" \
    --mode branch \
    --base HEAD >"$external_stdout" 2>"$external_stderr"
)
if [[ -s "$external_stderr" ]]; then
  printf 'external wrapper bundle preparation wrote stderr:\n%s\n' \
    "$(cat "$external_stderr")" >&2
  exit 1
fi
expect_file_contains \
  "$external_bundle/README.md" \
  "$external_wrapper --verify-bundle-dir $external_bundle"
expect_file_not_contains \
  "$external_bundle/README.md" \
  "$repo_root/scripts/agent-autoreview.sh --verify-bundle-dir"
expect_file_not_contains \
  "$external_bundle/README.md" \
  "pnpm agent:autoreview --verify-bundle-dir"
(
  cd "$standalone_verify_cwd"
  env -i \
    "PATH=$standalone_verify_cwd/bin:$PATH" \
    "HOME=$HOME" \
    "TMPDIR=${TMPDIR:-/tmp}" \
    "AUTOREVIEW_TEST_REAL_NODE=$node_bin" \
    "AUTOREVIEW_TEST_HOSTILE_CWD_MARKER=$hostile_cwd_node_marker" \
    "$external_wrapper" \
    --verify-bundle-dir "$external_bundle" >"$external_stdout" 2>"$external_stderr"
)
if [[ -s "$external_stderr" ]]; then
  printf 'standalone detached-wrapper verification wrote stderr:\n%s\n' \
    "$(cat "$external_stderr")" >&2
  exit 1
fi
if [[ -e "$hostile_cwd_node_marker" ]]; then
  printf 'standalone verification executed Node from its non-Git cwd\n' >&2
  exit 1
fi
expect_file_contains \
  "$external_stdout" \
  "agent:autoreview verified context bundle: $external_bundle"

terminal_manifest_alias="$tmp_dir/terminal-manifest-readme-link"
run_adapter_expect_failure \
  "PATH=$terminal_manifest_node_dir:$PATH" \
  "AUTOREVIEW_TEST_REAL_NODE=$node_bin" \
  "AUTOREVIEW_TEST_PRELOAD=$terminal_manifest_preload" \
  AUTOREVIEW_TEST_TERMINAL_MANIFEST=1 \
  "AUTOREVIEW_TEST_EARLY_ALIAS=$terminal_manifest_alias" \
  --verify-bundle-dir "$canonical_bundle_dir" \
  --expected-bundle-manifest "$retained_bundle_manifest"
expect_stderr_contains "prepared-bundle file changed after hashing: README.md"
if [[ ! -f "$terminal_manifest_alias" ]]; then
  printf 'terminal manifest race fixture did not create the hardlink\n' >&2
  exit 1
fi
rm -f -- "$terminal_manifest_alias"
run_adapter \
  --verify-bundle-dir "$canonical_bundle_dir" \
  --expected-bundle-manifest "$retained_bundle_manifest"
expect_stdout_contains "manifest $retained_bundle_manifest"

checklists_directory="$canonical_bundle_dir/checklists"
checklists_directory_mode="$(
  "$node_bin" -e '
    const fs = require("node:fs");
    process.stdout.write(
      (fs.lstatSync(process.argv[1]).mode & 0o777).toString(8),
    );
  ' "$checklists_directory"
)"
if [[ "$checklists_directory_mode" == "700" ]]; then
  changed_checklists_directory_mode="755"
else
  changed_checklists_directory_mode="700"
fi
run_adapter_expect_failure \
  "PATH=$terminal_manifest_node_dir:$PATH" \
  "AUTOREVIEW_TEST_REAL_NODE=$node_bin" \
  "AUTOREVIEW_TEST_PRELOAD=$terminal_manifest_preload" \
  AUTOREVIEW_TEST_DIRECTORY_BASELINE=1 \
  "AUTOREVIEW_TEST_DIRECTORY_PATH=$checklists_directory" \
  "AUTOREVIEW_TEST_DIRECTORY_MODE=$changed_checklists_directory_mode" \
  --verify-bundle-dir "$canonical_bundle_dir" \
  --expected-bundle-manifest "$retained_bundle_manifest"
expect_stderr_contains "prepared-bundle content does not match its completion marker"
chmod "$checklists_directory_mode" "$checklists_directory"
run_adapter \
  --verify-bundle-dir "$canonical_bundle_dir" \
  --expected-bundle-manifest "$retained_bundle_manifest"
expect_stdout_contains "manifest $retained_bundle_manifest"

alternate_bundle_dir="$tmp_dir/context-bundle-alternate"
run_adapter \
  --prepare-bundle-dir "$alternate_bundle_dir" \
  --mode branch \
  --base HEAD
run_adapter --verify-bundle-dir "$alternate_bundle_dir"
expect_stdout_contains "agent:autoreview verified context bundle: $alternate_bundle_dir"
original_bundle_dir="$tmp_dir/context-bundle-original"
mv -- "$canonical_bundle_dir" "$original_bundle_dir"
mv -- "$alternate_bundle_dir" "$canonical_bundle_dir"
run_adapter --verify-bundle-dir "$canonical_bundle_dir"
expect_stdout_contains "agent:autoreview verified context bundle: $canonical_bundle_dir"
run_adapter_expect_failure \
  --verify-bundle-dir "$canonical_bundle_dir" \
  --expected-bundle-manifest "$retained_bundle_manifest"
expect_stderr_contains "does not match the retained pre-review manifest"
mv -- "$canonical_bundle_dir" "$alternate_bundle_dir"
mv -- "$original_bundle_dir" "$canonical_bundle_dir"

printf 'post-publication mutation\n' >>"$canonical_bundle_dir/README.md"
run_adapter_expect_failure \
  --verify-bundle-dir "$canonical_bundle_dir" \
  --expected-bundle-manifest "$retained_bundle_manifest"
expect_stderr_contains "prepared-bundle content does not match its completion marker"

publication_race_bundle="$tmp_dir/context-bundle-publication-race"
run_adapter_expect_failure \
  "AUTOREVIEW_FAKE_CREATE_BUNDLE_DESTINATION=$publication_race_bundle" \
  --prepare-bundle-dir "$publication_race_bundle" \
  --mode branch \
  --base HEAD
expect_stderr_contains "prepared-bundle destination already exists; refusing to replace it"
expect_stderr_contains "failed to publish the prepared bundle safely"
if [[ ! -d "$publication_race_bundle" ]]; then
  printf 'concurrently-created prepared-bundle destination was clobbered\n' >&2
  exit 1
fi
if [[ -n "$(find "$publication_race_bundle" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  printf 'concurrently-created prepared-bundle destination was replaced\n' >&2
  exit 1
fi
rmdir "$publication_race_bundle"

unsafe_publication_parent="$tmp_dir/unsafe-publication-parent"
unsafe_publication_bundle="$unsafe_publication_parent/review"
mkdir "$unsafe_publication_parent"
run_adapter_expect_failure \
  "AUTOREVIEW_FAKE_UNSAFE_BUNDLE_PARENT=$unsafe_publication_parent" \
  --prepare-bundle-dir "$unsafe_publication_bundle" \
  --mode branch \
  --base HEAD
expect_stderr_contains "unsafe prepared-bundle parent ancestor: $unsafe_publication_parent"
expect_stderr_contains "failed to publish the prepared bundle safely"
chmod 0700 "$unsafe_publication_parent"
if [[ -e "$unsafe_publication_bundle" ]]; then
  printf 'bundle was published after its parent became unsafe\n' >&2
  exit 1
fi

if [[ "$(/usr/bin/uname -s)" == "Darwin" ]]; then
  acl_publication_parent="$tmp_dir/acl-publication-parent"
  acl_publication_bundle="$acl_publication_parent/review"
  mkdir "$acl_publication_parent"
  run_adapter_expect_failure \
    "AUTOREVIEW_FAKE_UNSAFE_BUNDLE_PARENT_ACL=$acl_publication_parent" \
    --prepare-bundle-dir "$acl_publication_bundle" \
    --mode branch \
    --base HEAD
  expect_stderr_contains \
    "unsafe prepared-bundle parent ACL: $acl_publication_parent"
  /bin/chmod -N "$acl_publication_parent"
  if [[ -e "$acl_publication_bundle" ]]; then
    printf 'bundle was published after its parent gained a write ACL\n' >&2
    exit 1
  fi

  acl_staging_bundle="$tmp_dir/acl-staging-entry-bundle"
  run_adapter_expect_failure \
    AUTOREVIEW_FAKE_UNSAFE_BUNDLE_ENTRY_ACL=1 \
    --prepare-bundle-dir "$acl_staging_bundle" \
    --mode branch \
    --base HEAD
  expect_stderr_contains "unsafe prepared-bundle ACL grants write access:"
  if [[ -e "$acl_staging_bundle" ]]; then
    printf 'bundle with a write-granting staging ACL was published\n' >&2
    exit 1
  fi
fi

staging_swap_bundle="$tmp_dir/context-bundle-staging-swap"
run_adapter_expect_failure \
  "AUTOREVIEW_FAKE_SWAP_STAGING=1" \
  --prepare-bundle-dir "$staging_swap_bundle" \
  --mode branch \
  --base HEAD
expect_stderr_contains "prepared-bundle staging identity changed"
expect_stderr_contains "helper changed wrapper-owned prepared-bundle evidence"
expect_stderr_contains "leaving failed prepared-bundle staging directory for identity-safe cleanup"
if [[ -e "$staging_swap_bundle" ]]; then
  printf 'swapped prepared-bundle staging tree was published\n' >&2
  exit 1
fi
swapped_bundle_output="$(awk 'previous == "--bundle-output" { print; exit } { previous = $0 }' "$capture")"
swapped_staging_dir="$(dirname "$swapped_bundle_output")"
if [[ ! -f "$swapped_staging_dir/swapped-evidence.txt" ]]; then
  printf 'identity-swapped staging replacement was deleted during cleanup\n' >&2
  exit 1
fi

hostile_utility_bin="$tmp_dir/hostile-utility-bin"
hostile_head_marker="$tmp_dir/hostile-head-ran"
mkdir "$hostile_utility_bin"
cat >"$hostile_utility_bin/head" <<HEAD
#!/usr/bin/env bash
printf 'unsafe\n' >"$hostile_head_marker"
exit 99
HEAD
chmod +x "$hostile_utility_bin/head"
hostile_utility_bundle="$tmp_dir/context-bundle-hostile-utility"
run_adapter \
  "PATH=$hostile_utility_bin:$PATH" \
  --prepare-bundle-dir "$hostile_utility_bundle" \
  --mode branch \
  --base HEAD
if [[ -e "$hostile_head_marker" ]]; then
  printf 'external PATH utility shim executed during bundle capture\n' >&2
  exit 1
fi
expect_file_exists "$hostile_utility_bundle/autoreview-prompt.md"

bundle_mutation_repo="$tmp_dir/bundle-mutation"
init_review_repo "$bundle_mutation_repo"
printf 'base\n' >"$bundle_mutation_repo/README.md"
commit_review_repo "$bundle_mutation_repo" init
printf 'review me\n' >>"$bundle_mutation_repo/README.md"
bundle_mutation_output="$tmp_dir/context-bundle-mutation"
(
  cd "$bundle_mutation_repo"
  run_adapter_expect_failure \
    "AUTOREVIEW_MUTATE_PATH=$bundle_mutation_repo/README.md" \
    --prepare-bundle-dir "$bundle_mutation_output" \
    --mode local
)
expect_stderr_contains "source changed while the prepared bundle was being created"
if [[ -e "$bundle_mutation_output" ]]; then
  printf 'source-drifted prepared bundle was published: %s\n' "$bundle_mutation_output" >&2
  exit 1
fi

git_routing_repo="$tmp_dir/git-routing-repo"
git_routing_decoy="$tmp_dir/git-routing-decoy"
init_review_repo "$git_routing_repo"
init_review_repo "$git_routing_decoy"
printf 'intended\n' >"$git_routing_repo/README.md"
printf 'decoy\n' >"$git_routing_decoy/README.md"
commit_review_repo "$git_routing_repo" init
commit_review_repo "$git_routing_decoy" init
printf 'review intended checkout\n' >>"$git_routing_repo/README.md"
git_routing_bundle="$tmp_dir/context-bundle-git-routing"
(
  cd "$git_routing_repo"
  run_adapter \
    "GIT_DIR=$git_routing_decoy/.git" \
    "GIT_WORK_TREE=$git_routing_decoy" \
    --prepare-bundle-dir "$git_routing_bundle" \
    --mode local
)
expect_file_contains "$git_routing_bundle/changed-paths.txt" "README.md"
expect_file_contains "$git_routing_bundle/patches/unstaged.diff" "review intended checkout"
expect_file_not_contains "$git_routing_bundle/patches/unstaged.diff" "decoy"

auto_branch_local_repo="$tmp_dir/auto-branch-local-bundle"
init_review_repo "$auto_branch_local_repo"
printf 'base\n' >"$auto_branch_local_repo/README.md"
commit_review_repo "$auto_branch_local_repo" init
git -C "$auto_branch_local_repo" switch -c feature >/dev/null 2>&1
printf 'branch\n' >"$auto_branch_local_repo/branch.txt"
commit_review_repo "$auto_branch_local_repo" "add branch file"
printf 'local body\n' >"$auto_branch_local_repo/local.txt"
external_diff="$tmp_dir/external-diff"
cat >"$external_diff" <<'EXTERNAL_DIFF'
#!/usr/bin/env bash
printf 'external diff invoked\n'
EXTERNAL_DIFF
chmod +x "$external_diff"
auto_branch_local_bundle="$tmp_dir/context-bundle-auto-branch-local"
(cd "$auto_branch_local_repo" && run_adapter "GIT_EXTERNAL_DIFF=$external_diff" --prepare-bundle-dir "$auto_branch_local_bundle" --base main)
expect_file_contains "$auto_branch_local_bundle/README.md" "- Target: branch-local main"
expect_file_exists "$auto_branch_local_bundle/patches/branch.diff"
expect_file_exists "$auto_branch_local_bundle/patches/untracked.diff"
expect_file_contains "$auto_branch_local_bundle/changed-paths.txt" "branch.txt"
expect_file_contains "$auto_branch_local_bundle/changed-paths.txt" "local.txt"
expect_file_contains "$auto_branch_local_bundle/patches/branch.diff" "diff --git"
expect_file_not_contains "$auto_branch_local_bundle/patches/branch.diff" "external diff invoked"
expect_file_contains "$auto_branch_local_bundle/patches/untracked.diff" "local body"

pr_base_repo="$tmp_dir/pr-base-bundle"
hostile_feedback_marker="$tmp_dir/pr-base-feedback-runtime-ran"
init_review_repo "$pr_base_repo"
git -C "$pr_base_repo" remote add origin \
  https://github.com/mento-protocol/monitoring-monorepo.git
printf 'base\n' >"$pr_base_repo/README.md"
mkdir -p "$pr_base_repo/scripts"
cat >"$pr_base_repo/scripts/pr-feedback-state.mjs" <<'FEEDBACK_RUNTIME'
#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const result = spawnSync("gh", ["autoreview-test-feedback", ...args], {
  encoding: "utf8",
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
if (result.error || result.status !== 0) {
  process.stderr.write(
    result.error?.message || result.stderr || `gh exited ${result.status}`,
  );
  process.exit(1);
}
const state = JSON.parse(result.stdout);
state.testEvidence = {
  version: "protected-main",
  cwd: process.cwd(),
  argv: args,
  ghHostPresent: Object.hasOwn(process.env, "GH_HOST"),
  ghRepoPresent: Object.hasOwn(process.env, "GH_REPO"),
};
process.stdout.write(`${JSON.stringify(state)}\n`);
FEEDBACK_RUNTIME
for feedback_runtime_file in \
  pr-feedback-state-core.mjs \
  pr-ready-state.mjs \
  pr-ready-state-core.mjs \
  pr-ready-state-format.mjs; do
  printf 'export {};\n' >"$pr_base_repo/scripts/$feedback_runtime_file"
done
commit_review_repo "$pr_base_repo" init
protected_feedback_runtime_oid="$(git -C "$pr_base_repo" rev-parse HEAD)"
git -C "$pr_base_repo" update-ref \
  refs/remotes/origin/main \
  "$protected_feedback_runtime_oid"
git -C "$pr_base_repo" switch -c release >/dev/null 2>&1
cat >"$pr_base_repo/scripts/pr-feedback-state.mjs" <<HOSTILE_FEEDBACK_RUNTIME
#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync("$hostile_feedback_marker", "unsafe PR-base runtime executed\n");
process.stdout.write('{"findings":[]}\n');
HOSTILE_FEEDBACK_RUNTIME
commit_review_repo "$pr_base_repo" "poison PR-base feedback runtime"
git -C "$pr_base_repo" update-ref refs/remotes/origin/release HEAD
git -C "$pr_base_repo" switch -c feature >/dev/null 2>&1
printf 'feature\n' >"$pr_base_repo/feature.txt"
commit_review_repo "$pr_base_repo" "add feature file"
fake_gh_bin="$tmp_dir/fake-gh-bin"
hostile_gh_bin="$pr_base_repo/bin"
hostile_gh_marker="$tmp_dir/repo-gh-ran"
mkdir "$fake_gh_bin"
mkdir "$hostile_gh_bin"
cat >"$hostile_gh_bin/gh" <<GH
#!/usr/bin/env bash
printf 'unsafe\n' >"$hostile_gh_marker"
exit 99
GH
chmod +x "$hostile_gh_bin/gh"
cat >"$fake_gh_bin/gh" <<'GH'
#!/usr/bin/env bash
if [[ "$1" == "repo" && "$2" == "view" ]]; then
  printf 'mento-protocol\n'
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "list" ]]; then
  printf '1\nrelease\n1299\nmento-protocol\n'
  exit 0
fi
exit 1
GH
chmod +x "$fake_gh_bin/gh"
pr_base_bundle="$tmp_dir/context-bundle-pr-base"
(cd "$pr_base_repo" && run_adapter "PATH=$hostile_gh_bin:$fake_gh_bin:$PATH" --prepare-bundle-dir "$pr_base_bundle" --mode branch)
expect_file_contains "$pr_base_bundle/README.md" "- Target: branch origin/release"
expect_file_contains "$pr_base_bundle/changed-paths.txt" "feature.txt"
if [[ -e "$hostile_gh_marker" ]]; then
  printf 'repo-local gh shim executed\n' >&2
  exit 1
fi

routing_gh_bin="$tmp_dir/routing-gh-bin"
hostile_git_config="$tmp_dir/hostile-git-config"
mkdir "$routing_gh_bin"
cat >"$hostile_git_config" <<'GIT_CONFIG'
[remote "origin"]
	url = https://github.com/attacker/decoy.git
GIT_CONFIG
cat >"$routing_gh_bin/gh" <<'GH'
#!/usr/bin/env bash
if [[ -n "${GH_REPO:-}" || -n "${GH_HOST:-}" ]]; then
  printf 'GitHub routing variables were inherited\n' >&2
  exit 90
fi
if [[ "$1" == "repo" && "$2" == "view" ]]; then
  [[ "$3" == "mento-protocol/monitoring-monorepo" ]] || exit 91
  printf 'mento-protocol\n'
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "list" ]]; then
  repository=""
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--repo" && $# -gt 1 ]]; then
      repository="$2"
      break
    fi
    shift
  done
  [[ "$repository" == "mento-protocol/monitoring-monorepo" ]] || exit 92
  printf '1\nrelease\n1299\nmento-protocol\n'
  exit 0
fi
exit 93
GH
chmod +x "$routing_gh_bin/gh"
routing_gh_bundle="$tmp_dir/context-bundle-gh-routing"
(
  cd "$pr_base_repo"
  run_adapter \
    "GIT_CONFIG=$hostile_git_config" \
    "GH_HOST=attacker.invalid" \
    "GH_REPO=attacker/decoy" \
    "PATH=$hostile_gh_bin:$routing_gh_bin:$PATH" \
    --prepare-bundle-dir "$routing_gh_bundle" \
    --mode branch
)
expect_file_contains "$routing_gh_bundle/README.md" "- Target: branch origin/release"
expect_empty_stderr

prepared_churn_git_bin="$tmp_dir/prepared-churn-git-bin"
prepared_churn_marker="$tmp_dir/prepared-churn-triggered"
prepared_churn_path="$pr_base_repo/late-untracked.txt"
prepared_real_git="$(command -v git)"
mkdir "$prepared_churn_git_bin"
cat >"$prepared_churn_git_bin/git" <<GIT
#!/usr/bin/env bash
for arg in "\$@"; do
  if [[ "\$arg" == "--stat" && ! -e "$prepared_churn_marker" ]]; then
    printf 'unrelated untracked churn\n' >"$prepared_churn_path"
    : >"$prepared_churn_marker"
    break
  fi
done
exec "$prepared_real_git" "\$@"
GIT
chmod +x "$prepared_churn_git_bin/git"

prepared_untracked_churn_bundle="$tmp_dir/context-bundle-untracked-churn"
(
  cd "$pr_base_repo"
  run_adapter \
    "AUTOREVIEW_HELPER=$repo_root/scripts/agent-autoreview.mjs" \
    "PATH=$prepared_churn_git_bin:$PATH" \
    --prepare-bundle-dir "$prepared_untracked_churn_bundle" \
    --mode branch \
    --base main
)
expect_file_exists "$prepared_untracked_churn_bundle/autoreview-prompt.md"
rm "$prepared_churn_path" "$prepared_churn_marker"

auto_untracked_churn_bundle="$tmp_dir/context-bundle-auto-untracked-churn"
(
  cd "$pr_base_repo"
  run_adapter_expect_failure \
    "AUTOREVIEW_HELPER=$repo_root/scripts/agent-autoreview.mjs" \
    "PATH=$prepared_churn_git_bin:$PATH" \
    --prepare-bundle-dir "$auto_untracked_churn_bundle" \
    --mode auto \
    --base main
)
expect_stderr_contains "source changed while the prepared bundle was being created"
if [[ -e "$auto_untracked_churn_bundle" ]]; then
  printf 'auto-mode bundle was published after untracked target-state churn\n' >&2
  exit 1
fi
rm "$prepared_churn_path" "$prepared_churn_marker"

git -C "$pr_base_repo" branch sibling >/dev/null 2>&1
mutating_gh_bin="$tmp_dir/mutating-gh-bin"
mkdir "$mutating_gh_bin"
cat >"$mutating_gh_bin/gh" <<GH
#!/usr/bin/env bash
if [[ "\$1" == "repo" && "\$2" == "view" ]]; then
  printf 'mento-protocol\n'
  exit 0
fi
if [[ "\$1" == "pr" && "\$2" == "list" ]]; then
  git -C "$pr_base_repo" switch sibling >/dev/null 2>&1
  printf '1\nrelease\n1299\nmento-protocol\n'
  exit 0
fi
exit 1
GH
chmod +x "$mutating_gh_bin/gh"
prepared_target_drift_bundle="$tmp_dir/context-bundle-target-selection-drift"
(
  cd "$pr_base_repo"
  run_adapter_expect_failure \
    "PATH=$hostile_gh_bin:$mutating_gh_bin:$PATH" \
    --prepare-bundle-dir "$prepared_target_drift_bundle" \
    --mode branch
)
expect_stderr_contains "source changed while the review target was being selected"
if [[ -e "$prepared_target_drift_bundle" ]]; then
  printf 'target-drifted prepared bundle was published\n' >&2
  exit 1
fi
git -C "$pr_base_repo" switch feature >/dev/null 2>&1

no_gh_bin="$tmp_dir/no-gh-bin"
no_gh_bundle="$tmp_dir/context-bundle-no-gh-feedback"
mkdir "$no_gh_bin"
ln -s "$node_bin" "$no_gh_bin/node"
(
  cd "$pr_base_repo"
  run_adapter_expect_failure \
    "PATH=$no_gh_bin:/usr/bin:/bin" \
    --prepare-bundle-dir "$no_gh_bundle" \
    --feedback-pr auto \
    --mode branch
)
expect_stderr_contains "--feedback-pr auto requires exactly one open PR"
if [[ -e "$no_gh_bundle" ]]; then
  printf 'automatic feedback bundle was published without GitHub metadata\n' >&2
  exit 1
fi

hostile_pnpm_marker="$tmp_dir/repo-pnpm-ran"
cat >"$hostile_gh_bin/pnpm" <<PNPM
#!/usr/bin/env bash
printf 'unsafe\n' >"$hostile_pnpm_marker"
exit 99
PNPM
chmod +x "$hostile_gh_bin/pnpm"
hostile_pnpm_link_bin="$tmp_dir/hostile-pnpm-link-bin"
safe_pnpm_bin="$tmp_dir/safe-pnpm-bin"
safe_pnpm_marker="$tmp_dir/safe-pnpm-ran"
safe_pnpm_args="$tmp_dir/safe-pnpm-args"
paired_gh_bin="$tmp_dir/paired-gh-bin"
paired_gh_calls="$tmp_dir/paired-gh-calls"
paired_gh_capture="$tmp_dir/paired-gh-feedback-args"
feedback_base_control="$tmp_dir/feedback-base-control"
mkdir "$hostile_pnpm_link_bin" "$safe_pnpm_bin" "$paired_gh_bin"
ln -s "$hostile_gh_bin/pnpm" "$hostile_pnpm_link_bin/pnpm"
cat >"$safe_pnpm_bin/pnpm" <<PNPM
#!/usr/bin/env bash
printf 'safe\n' >"$safe_pnpm_marker"
printf '%s\n' "\$@" >"$safe_pnpm_args"
exit 99
PNPM
chmod +x "$safe_pnpm_bin/pnpm"
cat >"$paired_gh_bin/gh" <<GH
#!/usr/bin/env bash
if [[ "\$1" == "repo" && "\$2" == "view" ]]; then
  printf 'mento-protocol\n'
  exit 0
fi
if [[ "\$1" == "pr" && "\$2" == "list" ]]; then
  printf 'call\n' >>"$paired_gh_calls"
  printf '1\nrelease\n1299\nmento-protocol\n'
  exit 0
fi
if [[ "\$1" == "autoreview-test-feedback" ]]; then
  printf '%s\n' "\$@" >"$paired_gh_capture"
  feedback_base="release"
  if [[ -f "$feedback_base_control" ]]; then
    feedback_base="\$(cat "$feedback_base_control")"
  fi
  head_oid="\$(/usr/bin/git -C "$pr_base_repo" rev-parse HEAD)"
  printf '{"pr":{"number":1299,"state":"OPEN","baseRefName":"%s","headRefName":"feature","headRefOid":"%s"},"findings":[]}\n' \
    "\$feedback_base" "\$head_oid"
  exit 0
fi
exit 1
GH
chmod +x "$paired_gh_bin/gh"
trusted_pnpm_bundle="$tmp_dir/context-bundle-trusted-pnpm"
mkdir "$pr_base_repo/subdir"
(
  cd "$pr_base_repo/subdir"
  run_adapter \
    "GH_HOST=attacker.invalid" \
    "GH_REPO=attacker/decoy" \
    "PATH=$hostile_pnpm_link_bin:$safe_pnpm_bin:$paired_gh_bin:$PATH" \
    --prepare-bundle-dir "$trusted_pnpm_bundle" \
    --feedback-pr auto \
    --mode branch
)
if [[ -e "$hostile_pnpm_marker" ]]; then
  printf 'repo-local pnpm shim executed through an external symlink\n' >&2
  exit 1
fi
if [[ -e "$safe_pnpm_marker" || -e "$safe_pnpm_args" ]]; then
  printf 'pnpm executed during direct feedback capture\n' >&2
  exit 1
fi
if [[ -e "$hostile_feedback_marker" ]]; then
  printf 'PR-base feedback runtime executed\n' >&2
  exit 1
fi
if [[ "$(wc -l <"$paired_gh_calls" | tr -d ' ')" != "1" ]]; then
  printf 'PR base and feedback metadata were resolved in separate GitHub snapshots\n' >&2
  exit 1
fi
if [[ "$(cat "$paired_gh_capture")" != $'autoreview-test-feedback\n--pr\n1299\n--repo\nmento-protocol/monitoring-monorepo\n--json' ]]; then
  printf 'trusted feedback runtime received unexpected GitHub arguments:\n%s\n' "$(cat "$paired_gh_capture")" >&2
  exit 1
fi
expect_file_exists "$trusted_pnpm_bundle/feedback-state.json"
expect_file_contains "$trusted_pnpm_bundle/feedback-state.json" '"findings":[]'
expect_file_contains \
  "$trusted_pnpm_bundle/feedback-state.json" \
  '"version":"protected-main"'
expect_file_contains "$trusted_pnpm_bundle/feedback-state.json" "\"cwd\":\"$pr_base_repo\""
expect_file_contains "$trusted_pnpm_bundle/feedback-state.json" '"ghHostPresent":false'
expect_file_contains "$trusted_pnpm_bundle/feedback-state.json" '"ghRepoPresent":false'
expect_file_contains "$trusted_pnpm_bundle/README.md" "- Target: branch origin/release"
expect_empty_stderr

mismatched_feedback_bundle="$tmp_dir/context-bundle-mismatched-feedback"
printf 'main\n' >"$feedback_base_control"
(
  cd "$pr_base_repo"
  run_adapter_expect_failure \
    "PATH=$hostile_pnpm_link_bin:$safe_pnpm_bin:$paired_gh_bin:$PATH" \
    --prepare-bundle-dir "$mismatched_feedback_bundle" \
    --feedback-pr auto \
    --mode branch
)
rm "$feedback_base_control"
expect_stderr_contains "feedback state no longer matches the frozen automatic PR selection"
if [[ -e "$mismatched_feedback_bundle" ]]; then
  printf 'bundle was published with feedback from a retargeted PR\n' >&2
  exit 1
fi

ambiguous_gh_bin="$tmp_dir/ambiguous-gh-bin"
mkdir "$ambiguous_gh_bin"
cat >"$ambiguous_gh_bin/gh" <<'GH'
#!/usr/bin/env bash
if [[ "$1" == "repo" && "$2" == "view" ]]; then
  printf 'mento-protocol\n'
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "list" ]]; then
  printf '2\nrelease\n1299\nmento-protocol\nmain\n1300\nmento-protocol\n'
  exit 0
fi
exit 1
GH
chmod +x "$ambiguous_gh_bin/gh"
ambiguous_pr_base_bundle="$tmp_dir/context-bundle-ambiguous-pr-base"
(
  cd "$pr_base_repo"
  run_adapter_expect_failure \
    "PATH=$hostile_gh_bin:$ambiguous_gh_bin:$PATH" \
    --prepare-bundle-dir "$ambiguous_pr_base_bundle" \
    --mode branch
)
expect_stderr_contains "multiple open PRs match head branch feature"
if [[ -e "$ambiguous_pr_base_bundle" ]]; then
  printf 'ambiguous PR base bundle was published\n' >&2
  exit 1
fi

fork_gh_bin="$tmp_dir/fork-gh-bin"
mkdir "$fork_gh_bin"
cat >"$fork_gh_bin/gh" <<'GH'
#!/usr/bin/env bash
if [[ "$1" == "repo" && "$2" == "view" ]]; then
  printf 'mento-protocol\n'
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "list" ]]; then
  printf '1\nrelease\n1299\nfork-owner\n'
  exit 0
fi
exit 1
GH
chmod +x "$fork_gh_bin/gh"
fork_pr_base_bundle="$tmp_dir/context-bundle-fork-pr-base"
(
  cd "$pr_base_repo"
  run_adapter_expect_failure \
    "PATH=$hostile_gh_bin:$fork_gh_bin:$PATH" \
    --prepare-bundle-dir "$fork_pr_base_bundle" \
    --mode branch
)
expect_stderr_contains "open PR for head branch feature is not owned by mento-protocol"
if [[ -e "$fork_pr_base_bundle" ]]; then
  printf 'fork-owned PR base bundle was published\n' >&2
  exit 1
fi

explicit_base_auto_feedback_bundle="$tmp_dir/context-bundle-explicit-base-auto-feedback"
(
  cd "$pr_base_repo"
  run_adapter_expect_failure \
    --prepare-bundle-dir "$explicit_base_auto_feedback_bundle" \
    --feedback-pr auto \
    --mode branch \
    --base main
)
expect_stderr_contains "--feedback-pr auto cannot be combined with an explicit --base"
if [[ -e "$explicit_base_auto_feedback_bundle" ]]; then
  printf 'auto-feedback bundle was published with an explicit base override\n' >&2
  exit 1
fi

commit_auto_feedback_bundle="$tmp_dir/context-bundle-commit-auto-feedback"
(
  cd "$pr_base_repo"
  run_adapter_expect_failure \
    --prepare-bundle-dir "$commit_auto_feedback_bundle" \
    --feedback-pr auto \
    --mode commit \
    --commit HEAD
)
expect_stderr_contains "--feedback-pr auto cannot be combined with --mode commit"
if [[ -e "$commit_auto_feedback_bundle" ]]; then
  printf 'auto-feedback bundle was published for commit mode\n' >&2
  exit 1
fi

ambiguous_feedback_bundle="$tmp_dir/context-bundle-ambiguous-feedback"
(
  cd "$pr_base_repo"
  run_adapter_expect_failure \
    "PATH=$hostile_gh_bin:$ambiguous_gh_bin:$PATH" \
    --prepare-bundle-dir "$ambiguous_feedback_bundle" \
    --feedback-pr auto \
    --mode branch
)
expect_stderr_contains "multiple open PRs match head branch feature"
if [[ -e "$ambiguous_feedback_bundle" ]]; then
  printf 'ambiguous feedback PR bundle was published\n' >&2
  exit 1
fi

failing_gh_bin="$tmp_dir/failing-gh-bin"
mkdir "$failing_gh_bin"
cat >"$failing_gh_bin/gh" <<'GH'
#!/usr/bin/env bash
printf 'simulated GitHub lookup failure\n' >&2
exit 1
GH
chmod +x "$failing_gh_bin/gh"
failed_pr_lookup_bundle="$tmp_dir/context-bundle-failed-pr-lookup"
(
  cd "$pr_base_repo"
  run_adapter_expect_failure \
    "PATH=$hostile_gh_bin:$failing_gh_bin:$PATH" \
    --prepare-bundle-dir "$failed_pr_lookup_bundle" \
    --mode branch
)
expect_stderr_contains "simulated GitHub lookup failure"
expect_stderr_contains "failed to inspect PR metadata for head branch feature"
if [[ -e "$failed_pr_lookup_bundle" ]]; then
  printf 'failed PR lookup bundle was published\n' >&2
  exit 1
fi

run_adapter_expect_failure --prepare-bundle-dir "$repo_root/.autoreview-bundle" --mode branch --base HEAD
expect_stderr_contains "must be outside the repo worktree"

nested_in_repo_parent="$repo_root/.autoreview-test-parent"
rm -rf "$nested_in_repo_parent"
run_adapter_expect_failure --prepare-bundle-dir "$nested_in_repo_parent/review" --mode branch --base HEAD
expect_stderr_contains "must be outside the repo worktree"
if [[ -e "$nested_in_repo_parent" ]]; then
  printf 'expected rejected in-repo bundle parent not to be created: %s\n' "$nested_in_repo_parent" >&2
  exit 1
fi

missing_external_parent="$tmp_dir/missing-external-parent"
run_adapter_expect_failure \
  --prepare-bundle-dir "$missing_external_parent/review" \
  --mode branch \
  --base HEAD
expect_stderr_contains "--prepare-bundle-dir parent must already exist"
if [[ -e "$missing_external_parent" ]]; then
  printf 'rejected bundle parent was created during validation\n' >&2
  exit 1
fi

unsafe_bundle_ancestor="$tmp_dir/unsafe-bundle-ancestor"
unsafe_bundle_parent="$unsafe_bundle_ancestor/private-child"
mkdir -p "$unsafe_bundle_parent"
chmod 0777 "$unsafe_bundle_ancestor"
chmod 0700 "$unsafe_bundle_parent"
run_adapter_expect_failure \
  --prepare-bundle-dir "$unsafe_bundle_parent/review" \
  --mode branch \
  --base HEAD
expect_stderr_contains "unsafe prepared-bundle parent ancestor: $unsafe_bundle_ancestor"
expect_stderr_contains "--prepare-bundle-dir parent ancestry is unsafe"
if [[ -e "$unsafe_bundle_parent/review" ]]; then
  printf 'unsafe-ancestor bundle destination was created\n' >&2
  exit 1
fi
chmod 0700 "$unsafe_bundle_ancestor"

if [[ "$(/usr/bin/uname -s)" == "Darwin" ]]; then
  acl_bundle_parent="$tmp_dir/acl-bundle-parent"
  mkdir "$acl_bundle_parent"
  /bin/chmod +a \
    "everyone allow add_file,delete_child" \
    "$acl_bundle_parent"
  run_adapter_expect_failure \
    --prepare-bundle-dir "$acl_bundle_parent/review" \
    --mode branch \
    --base HEAD
  expect_stderr_contains "unsafe prepared-bundle parent ACL: $acl_bundle_parent"
  expect_stderr_contains "--prepare-bundle-dir parent ancestry is unsafe"
  /bin/chmod -N "$acl_bundle_parent"
fi

unsafe_verify_parent="$tmp_dir/unsafe-verify-parent"
unsafe_verify_bundle="$unsafe_verify_parent/review"
mkdir "$unsafe_verify_parent"
run_adapter \
  --prepare-bundle-dir "$unsafe_verify_bundle" \
  --mode branch \
  --base HEAD
chmod 0777 "$unsafe_verify_parent"
run_adapter_expect_failure --verify-bundle-dir "$unsafe_verify_bundle"
expect_stderr_contains "unsafe prepared-bundle parent ancestor: $unsafe_verify_parent"
expect_stderr_contains "refusing to verify a bundle through unsafe parent ancestry"
chmod 0700 "$unsafe_verify_parent"
run_adapter --verify-bundle-dir "$unsafe_verify_bundle"
expect_stdout_contains "agent:autoreview verified context bundle: $unsafe_verify_bundle"
if [[ "$(/usr/bin/uname -s)" == "Darwin" ]]; then
  /bin/chmod +a \
    "everyone allow write,delete" \
    "$unsafe_verify_bundle/README.md"
  run_adapter_expect_failure --verify-bundle-dir "$unsafe_verify_bundle"
  expect_stderr_contains "unsafe prepared-bundle ACL grants write access:"
  expect_stderr_contains "refusing to verify a bundle with unsafe entry ACLs"
  /bin/chmod -N "$unsafe_verify_bundle/README.md"
  run_adapter --verify-bundle-dir "$unsafe_verify_bundle"
  expect_stdout_contains "agent:autoreview verified context bundle: $unsafe_verify_bundle"
fi

nonempty_bundle="$tmp_dir/nonempty-bundle"
mkdir -p "$nonempty_bundle"
printf 'stale\n' >"$nonempty_bundle/stale.txt"
run_adapter_expect_failure --prepare-bundle-dir "$nonempty_bundle" --mode branch --base HEAD
expect_stderr_contains "must be empty or absent"

ln -s "$repo_root" "$tmp_dir/repo-link"
run_adapter_expect_failure --prepare-bundle-dir "$tmp_dir/repo-link" --mode branch --base HEAD
expect_stderr_contains "must not be a symlink"

subdir_bundle="$tmp_dir/context-bundle-subdir"
(cd "$repo_root/scripts" && run_adapter --prepare-bundle-dir "$subdir_bundle" --mode branch --base HEAD)
expect_file_contains "$capture.cwd" "$repo_root"

printf 'untracked review body\n' >"$repo_untracked"
untracked_bundle="$tmp_dir/context-bundle-untracked"
canonical_untracked_bundle="$(cd "$(dirname "$untracked_bundle")" && pwd -P)/$(basename "$untracked_bundle")"
run_adapter --prepare-bundle-dir "$untracked_bundle" --mode local
expect_file_contains "$canonical_untracked_bundle/patches/untracked.diff" "untracked review body"

printf 'agent-autoreview adapter tests passed\n'
