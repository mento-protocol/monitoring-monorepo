#!/bin/bash -p
set -euo pipefail

# Privileged Bash mode suppresses BASH_ENV and imported shell functions before
# this file starts. Strip child-runtime injection knobs before launching even
# fixed-path system utilities.
unset \
  BASH_ENV \
  ENV \
  NODE_OPTIONS \
  NODE_PATH \
  OPENSSL_CONF \
  OPENSSL_MODULES \
  PERL5LIB \
  PERL5OPT \
  PYTHONHOME \
  PYTHONPATH \
  RUBYLIB \
  RUBYOPT \
  LD_AUDIT \
  LD_DEBUG \
  LD_DEBUG_OUTPUT \
  LD_LIBRARY_PATH \
  LD_ORIGIN_PATH \
  LD_PRELOAD \
  LD_PROFILE \
  LD_SHOW_AUXV \
  GLIBC_TUNABLES \
  AUTOREVIEW_ATTESTED_NODE_LIBRARY_PATH \
  DYLD_FALLBACK_FRAMEWORK_PATH \
  DYLD_FALLBACK_LIBRARY_PATH \
  DYLD_FRAMEWORK_PATH \
  DYLD_IMAGE_SUFFIX \
  DYLD_INSERT_LIBRARIES \
  DYLD_LIBRARY_PATH \
  DYLD_PRINT_TO_FILE \
  DYLD_ROOT_PATH \
  DYLD_SHARED_REGION \
  DYLD_VERSIONED_FRAMEWORK_PATH \
  DYLD_VERSIONED_LIBRARY_PATH

# Loader variables are an open-ended namespace.  Do not rely on a finite list
# when the wrapper is about to attest and relaunch a path-untrusted Node binary.
# Bash only imports valid shell names, which covers the dynamic loaders' LD_*
# controls and GLIBC_TUNABLES.
while IFS= read -r ambient_loader_name; do
  case "$ambient_loader_name" in
    LD_* | GLIBC_TUNABLES)
      unset "$ambient_loader_name"
      ;;
  esac
done < <(compgen -e)
unset ambient_loader_name

untrusted_helper_exposed=0

# The focused Linux/root regression may opt into one fixed trust-stage code.
# Normal invocations keep the existing generic error and never print paths,
# owners, metadata, digests, or inherited environment values.
root_node_snapshot_diagnostics=0
if [[ "${AUTOREVIEW_TEST_NODE_SNAPSHOT_DIAGNOSTICS:-}" == "1" ]]; then
  root_node_snapshot_diagnostics=1
fi
root_node_snapshot_stage="source-proof"
root_node_snapshot_diagnostic_file=""

set_root_node_snapshot_stage() {
  case "$1" in
    source-proof | snapshot-trust | native-format | preload-policy | \
      elf-metadata | interpreter-path | loader-policy | ambient-loader-exec | \
      ambient-loader-stderr | ambient-loader-parse | ambient-loader-policy | \
      dependency-closure | alias-policy | controlled-loader-list | \
      manifest-seal | closure-attestation | version-exec | version-output | \
      version-reattest | smoke-exec | smoke-reattest)
      root_node_snapshot_stage="$1"
      ;;
    *)
      root_node_snapshot_stage="source-proof"
      ;;
  esac
}

report_root_node_snapshot_rejection() {
  [[ "$root_node_snapshot_diagnostics" -eq 1 ]] || return 0
  local rank=1
  local existing_rank=0
  local existing_stage=""
  local rejected_stage="$root_node_snapshot_stage"
  local record=""
  local temporary=""
  case "$root_node_snapshot_stage" in
    source-proof) rank=1 ;;
    snapshot-trust) rank=2 ;;
    native-format) rank=3 ;;
    preload-policy) rank=4 ;;
    elf-metadata) rank=5 ;;
    interpreter-path) rank=6 ;;
    loader-policy) rank=7 ;;
    ambient-loader-exec) rank=8 ;;
    ambient-loader-stderr) rank=9 ;;
    ambient-loader-parse) rank=10 ;;
    ambient-loader-policy) rank=11 ;;
    dependency-closure) rank=12 ;;
    alias-policy) rank=13 ;;
    controlled-loader-list) rank=14 ;;
    manifest-seal) rank=15 ;;
    closure-attestation) rank=16 ;;
    version-exec) rank=17 ;;
    version-output) rank=18 ;;
    version-reattest) rank=19 ;;
    smoke-exec) rank=20 ;;
    smoke-reattest) rank=21 ;;
  esac
  [[ -n "$root_node_snapshot_diagnostic_file" ]] || return 0
  if [[
    -f "$root_node_snapshot_diagnostic_file" &&
      ! -L "$root_node_snapshot_diagnostic_file"
  ]]; then
    IFS= read -r record <"$root_node_snapshot_diagnostic_file" || record=""
    if [[ "$record" =~ ^([0-9]+):([a-z-]+)$ ]]; then
      existing_rank="${BASH_REMATCH[1]}"
      existing_stage="${BASH_REMATCH[2]}"
      case "$existing_stage" in
        source-proof | snapshot-trust | native-format | preload-policy | \
          elf-metadata | interpreter-path | loader-policy | \
          ambient-loader-exec | ambient-loader-stderr | ambient-loader-parse | \
          ambient-loader-policy | dependency-closure | alias-policy | \
          controlled-loader-list | manifest-seal | closure-attestation | \
          version-exec | version-output | version-reattest | smoke-exec | \
          smoke-reattest) ;;
        *) existing_rank=0 ;;
      esac
    fi
  fi
  if [[ "$rank" -gt "$existing_rank" ]]; then
    temporary="$root_node_snapshot_diagnostic_file.$BASHPID"
    (umask 077 && printf '%s:%s\n' "$rank" "$rejected_stage" >"$temporary") ||
      return 0
    /bin/chmod 0600 "$temporary" 2>/dev/null || return 0
    /bin/mv "$temporary" "$root_node_snapshot_diagnostic_file" 2>/dev/null ||
      return 0
  fi
}

script_path="${BASH_SOURCE[0]}"
script_parent="${script_path%/*}"
if [[ "$script_parent" == "$script_path" ]]; then
  script_parent="."
fi
script_dir="$(cd -- "$script_parent" && pwd -P)"
repo_root="$(cd -- "$script_dir/.." && pwd -P)"
default_helper="$repo_root/scripts/agent-autoreview.mjs"
helper="${AUTOREVIEW_HELPER:-$default_helper}"

invocation_cwd="$(pwd -P)"
checkout_root="$invocation_cwd"
checkout_root_found=0
while [[ ! -e "$checkout_root/.git" ]]; do
  checkout_parent="${checkout_root%/*}"
  if [[ -z "$checkout_parent" ]]; then
    checkout_parent="/"
  fi
  if [[ "$checkout_parent" == "$checkout_root" ]]; then
    break
  fi
  checkout_root="$checkout_parent"
done
if [[ -e "$checkout_root/.git" ]]; then
  checkout_root_found=1
fi

rejected_command_roots=("$repo_root")
if [[ "$checkout_root_found" -eq 1 && "$checkout_root" != "$repo_root" ]]; then
  rejected_command_roots+=("$checkout_root")
elif [[
  "$checkout_root_found" -eq 0 &&
    "$invocation_cwd" != "/" &&
    "$invocation_cwd" != "$repo_root"
]]; then
  rejected_command_roots+=("$invocation_cwd")
fi

path_is_rejected() {
  local candidate="${1%/}"
  local rejected_root
  for rejected_root in "${rejected_command_roots[@]}"; do
    case "$candidate" in
      "$rejected_root" | "$rejected_root"/*)
        return 0
        ;;
    esac
  done
  return 1
}

build_external_path() {
  local path_entries=()
  local path_entry
  local physical_entry
  local trusted_path=""
  IFS=: read -r -a path_entries <<<"${PATH:-}"
  path_entries+=(/usr/bin /bin /usr/sbin /sbin)
  for path_entry in "${path_entries[@]}"; do
    [[ "$path_entry" == /* && -d "$path_entry" ]] || continue
    path_is_rejected "$path_entry" && continue
    physical_entry="$(cd -P -- "$path_entry" 2>/dev/null && pwd -P)" || continue
    path_is_rejected "$physical_entry" && continue
    case ":$trusted_path:" in
      *":$physical_entry:"*) continue ;;
    esac
    if [[ -n "$trusted_path" ]]; then
      trusted_path+=":"
    fi
    trusted_path+="$physical_entry"
  done
  printf '%s\n' "$trusted_path"
}

external_command_path="$(build_external_path)"
PATH="/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

if [[
  ! -x /usr/bin/env ||
    ! -x /usr/bin/perl ||
    ! -x /usr/bin/mktemp ||
    ! -x /usr/bin/uname ||
    ! -x /bin/chmod ||
    ! -x /bin/ln ||
    ! -x /bin/ls ||
    ! -x /bin/mkdir ||
    ! -x /bin/mv ||
    ! -x /bin/rm
]]; then
  echo "agent:autoreview requires trusted system env, perl, mktemp, uname, chmod, ln, ls, mkdir, mv, and rm executables" >&2
  exit 127
fi

system_perl() {
  /usr/bin/env -i \
    PATH=/usr/bin:/bin \
    LC_ALL=C \
    /usr/bin/perl "$@"
}

# `system_perl -e` receives literal Perl source; its `$...` forms must not
# expand in Bash.
canonicalize_external_path() {
  # shellcheck disable=SC2016
  system_perl -MCwd=abs_path -e '
    use strict;
    use warnings;
    my $resolved = abs_path($ARGV[0]);
    exit 1 if !defined($resolved) || $resolved =~ /[\r\n\0]/;
    print "$resolved\n";
  ' "$1"
}

trusted_shared_temp_root() {
  # shellcheck disable=SC2016
  system_perl -MCwd=abs_path -MFcntl=:mode -MFile::Basename=dirname -e '
    use strict;
    use warnings;
    my ($requested, $euid) = @ARGV;
    my $current = abs_path($requested);
    exit 1 if !defined($current) || $current =~ /[\r\n\0]/;
    my $root = $current;
    while (1) {
      my @stat = lstat($current);
      exit 1 if !@stat || !S_ISDIR($stat[2]) || S_ISLNK($stat[2]);
      exit 1 if $stat[4] != 0 && $stat[4] != $euid;
      my $shared_writable = ($stat[2] & 0022) != 0;
      my $sticky = ($stat[2] & 01000) != 0;
      exit 1 if $shared_writable && !$sticky;
      my $parent = dirname($current);
      last if $parent eq $current;
      $current = $parent;
    }
    print "$root\n";
  ' "$1" "$EUID"
}

path_acl_is_trusted() {
  local candidate="$1"
  local acl_output
  local line
  local first_line=1
  [[ "$(/usr/bin/uname -s)" == "Darwin" ]] || return 0
  acl_output="$(
    /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C \
      /bin/ls -lde "$candidate" 2>/dev/null
  )" || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$first_line" -eq 1 ]]; then
      first_line=0
      continue
    fi
    if [[
      "$line" =~ [[:space:]]allow[[:space:]].*(write|append|add_file|add_subdirectory|delete|delete_child|writeattr|writeextattr|writesecurity|chown)(,|[[:space:]]|$)
    ]]; then
      return 1
    fi
  done <<<"$acl_output"
}

command_path_is_strictly_trusted() {
  local candidate="$1"
  local current
  local parent
  # shellcheck disable=SC2016
  system_perl -MFcntl=:mode -MFile::Basename=dirname -e '
    use strict;
    use warnings;
    my ($candidate, $euid) = @ARGV;
    my @before = lstat($candidate);
    exit 1 if !@before || !S_ISREG($before[2]) || S_ISLNK($before[2]);
    exit 1 if ($before[4] != 0 && $before[4] != $euid) || ($before[2] & 06022);
    my $current = dirname($candidate);
    while (1) {
      my @stat = lstat($current);
      exit 1 if !@stat || !S_ISDIR($stat[2]) || S_ISLNK($stat[2]);
      exit 1 if ($stat[4] != 0 && $stat[4] != $euid) || ($stat[2] & 0022);
      my $parent = dirname($current);
      last if $parent eq $current;
      $current = $parent;
    }
    my @after = lstat($candidate);
    exit 1 if !@after;
    for my $index (0, 1, 2, 3, 4, 7, 9, 10) {
      exit 1 if $before[$index] != $after[$index];
    }
  ' "$candidate" "$EUID" || return 1
  current="$candidate"
  while true; do
    path_acl_is_trusted "$current" || return 1
    [[ "$current" != "/" ]] || break
    parent="${current%/*}"
    [[ -n "$parent" ]] || parent="/"
    current="$parent"
  done
}

trusted_temp_root="$(trusted_shared_temp_root /tmp || true)"
if [[ -n "$trusted_temp_root" ]]; then
  trusted_temp_ancestor="$trusted_temp_root"
  while true; do
    if ! path_acl_is_trusted "$trusted_temp_ancestor"; then
      trusted_temp_root=""
      break
    fi
    [[ "$trusted_temp_ancestor" != "/" ]] || break
    trusted_temp_ancestor="${trusted_temp_ancestor%/*}"
    [[ -n "$trusted_temp_ancestor" ]] || trusted_temp_ancestor="/"
  done
  unset trusted_temp_ancestor
fi
if [[ -z "$trusted_temp_root" ]]; then
  echo "agent:autoreview requires a trusted sticky or private system temporary directory" >&2
  exit 127
fi
command_runtime_dir="$(
  /usr/bin/mktemp -d \
    "$trusted_temp_root/agent-autoreview-command-runtime.XXXXXX" \
    2>/dev/null || true
)"
if [[ -z "$command_runtime_dir" || ! -d "$command_runtime_dir" || -L "$command_runtime_dir" ]]; then
  echo "agent:autoreview failed to create a private external-command runtime" >&2
  exit 127
fi
/bin/chmod 0700 "$command_runtime_dir"
command_runtime_dir="$(cd "$command_runtime_dir" && pwd -P)"
if ! path_acl_is_trusted "$command_runtime_dir"; then
  /bin/rm -rf -- "$command_runtime_dir"
  echo "agent:autoreview failed to create an ACL-private external-command runtime" >&2
  exit 127
fi
command_runtime_identity="$({
  # shellcheck disable=SC2016
  system_perl -MFcntl=:mode -e '
    use strict;
    use warnings;
    my ($directory, $euid) = @ARGV;
    my @stat = lstat($directory);
    exit 1 if !@stat || !S_ISDIR($stat[2]) || S_ISLNK($stat[2]);
    exit 1 if $stat[4] != $euid || ($stat[2] & 0077);
    print join(":", @stat[0, 1, 2, 4]), "\n";
  ' "$command_runtime_dir" "$EUID"
} 2>/dev/null)" || command_runtime_identity=""
if [[ -z "$command_runtime_identity" ]]; then
  /bin/rm -rf -- "$command_runtime_dir"
  echo "agent:autoreview failed to pin the private external-command runtime" >&2
  exit 127
fi
root_node_snapshot_diagnostic_file="$command_runtime_dir/root-node-trust-stage"

cleanup_command_runtime() {
  local current_identity=""
  if [[
    -n "${command_runtime_dir:-}" &&
      "$command_runtime_dir" == "$trusted_temp_root"/agent-autoreview-command-runtime.* &&
      -d "$command_runtime_dir" &&
      ! -L "$command_runtime_dir"
  ]]; then
    if [[ "$untrusted_helper_exposed" -eq 1 ]]; then
      echo "agent:autoreview: leaving external-command runtime because an explicit helper may have surviving same-UID writers: $command_runtime_dir" >&2
      return 0
    fi
    current_identity="$({
      # shellcheck disable=SC2016
      system_perl -e '
        use strict;
        use warnings;
        my @stat = lstat($ARGV[0]);
        exit 1 if !@stat;
        print join(":", @stat[0, 1, 2, 4]), "\n";
      ' "$command_runtime_dir"
    } 2>/dev/null)" || current_identity=""
    if [[ "$current_identity" == "$command_runtime_identity" ]]; then
      /bin/rm -rf -- "$command_runtime_dir"
    else
      echo "agent:autoreview: leaving changed external-command runtime for identity-safe cleanup: $command_runtime_dir" >&2
    fi
  fi
}
trap cleanup_command_runtime EXIT

snapshot_path_is_trusted() {
  local candidate="$1"
  local current
  local parent
  # shellcheck disable=SC2016
  system_perl -MDigest::SHA -MFcntl=:DEFAULT,:mode -MFile::Basename=dirname -e '
    use strict;
    use warnings;
    my ($runtime, $expected_runtime, $candidate, $euid) = @ARGV;
    exit 1 if index($candidate, "$runtime/") != 0;
    my @runtime_stat = lstat($runtime);
    exit 1 if !@runtime_stat || !S_ISDIR($runtime_stat[2]) || S_ISLNK($runtime_stat[2]);
    exit 1 if $runtime_stat[4] != $euid || ($runtime_stat[2] & 0077);
    exit 1 if join(":", @runtime_stat[0, 1, 2, 4]) ne $expected_runtime;
    my $current = dirname($candidate);
    while ($current ne $runtime) {
      exit 1 if index($current, "$runtime/") != 0;
      my @directory_stat = lstat($current);
      exit 1 if !@directory_stat || !S_ISDIR($directory_stat[2]) || S_ISLNK($directory_stat[2]);
      exit 1 if $directory_stat[4] != $euid || ($directory_stat[2] & 0077);
      $current = dirname($current);
    }
    my @file_stat = lstat($candidate);
    exit 1 if !@file_stat || !S_ISREG($file_stat[2]) || S_ISLNK($file_stat[2]);
    exit 1 if $file_stat[4] != $euid || $file_stat[3] != 1;
    exit 1 if ($file_stat[2] & 07777) != 0500;
    my ($expected_digest) = $candidate =~ /\.([0-9a-f]{64})$/;
    exit 1 if !defined($expected_digest);
    sysopen(my $input, $candidate, O_RDONLY | O_NOFOLLOW) or exit 1;
    binmode($input);
    my $digest = Digest::SHA->new(256);
    my $buffer;
    while (1) {
      my $read = sysread($input, $buffer, 65536);
      exit 1 if !defined($read);
      last if $read == 0;
      $digest->add(substr($buffer, 0, $read));
    }
    close($input) or exit 1;
    exit 1 if $digest->hexdigest ne $expected_digest;
  ' "$command_runtime_dir" "$command_runtime_identity" "$candidate" "$EUID" || return 1
  current="$candidate"
  while true; do
    path_acl_is_trusted "$current" || return 1
    [[ "$current" != "$command_runtime_dir" ]] || break
    parent="${current%/*}"
    [[ -n "$parent" ]] || return 1
    current="$parent"
  done
}

native_executable_has_system_closure() {
  local candidate="$1"
  local libraries
  local load_commands
  local line
  local trimmed
  local dependency
  local current_load_command=""
  local saw_system_dylinker=0
  local library_line_pattern='^(.+) \(compatibility version [^,]+, current version [^)]+\)$'
  local dylinker_line_pattern='^name (.+) \(offset [0-9]+\)$'
  [[ "$(/usr/bin/uname -s)" == "Darwin" && -x /usr/bin/otool ]] || return 1
  libraries="$(
    /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C \
      /usr/bin/otool -L "$candidate" 2>/dev/null
  )" || return 1
  local saw_header=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == $'\t'* ]]; then
      dependency="${line#$'\t'}"
      [[ "$dependency" =~ $library_line_pattern ]] || return 1
      dependency="${BASH_REMATCH[1]}"
      case "$dependency/" in
        *"/../"* | *"/./"* | *"//"*) return 1 ;;
      esac
      case "$dependency" in
        /usr/lib/* | /System/Library/*) ;;
        *) return 1 ;;
      esac
    elif [[ "$line" == "$candidate"*: ]]; then
      saw_header=1
    elif [[ -n "$line" ]]; then
      return 1
    fi
  done <<<"$libraries"
  [[ "$saw_header" -eq 1 ]] || return 1
  load_commands="$(
    /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C \
      /usr/bin/otool -l "$candidate" 2>/dev/null
  )" || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="${line#"${line%%[![:space:]]*}"}"
    case "$trimmed" in
      "cmd LC_RPATH" | "cmd LC_DYLD_ENVIRONMENT")
        return 1
        ;;
      "cmd "*)
        current_load_command="${trimmed#cmd }"
        ;;
      "name "*)
        if [[ "$current_load_command" == "LC_LOAD_DYLINKER" ]]; then
          [[ "$trimmed" =~ $dylinker_line_pattern ]] || return 1
          dependency="${BASH_REMATCH[1]}"
          [[ "$dependency" == "/usr/lib/dyld" ]] || return 1
          saw_system_dylinker=1
        fi
        ;;
    esac
  done <<<"$load_commands"
  [[ "$saw_system_dylinker" -eq 1 ]] || return 1
  return 0
}

snapshot_has_safe_native_closure() {
  local candidate="$1"
  snapshot_path_is_trusted "$candidate" || return 1
  native_executable_has_system_closure "$candidate" || return 1
  snapshot_path_is_trusted "$candidate"
}

snapshot_external_executable() {
  local source="$1"
  local command_name="$2"
  local snapshot_dir
  local destination
  local digest
  [[
    "$command_name" == "node" ||
      "$command_name" == "gh" ||
      "$command_name" == "volta"
  ]] || return 1
  path_acl_is_trusted "$source" || return 1
  snapshot_dir="$(
    /usr/bin/mktemp -d \
      "$command_runtime_dir/$command_name.XXXXXX" \
      2>/dev/null || true
  )"
  [[ -n "$snapshot_dir" && -d "$snapshot_dir" && ! -L "$snapshot_dir" ]] || return 1
  /bin/chmod 0700 "$snapshot_dir"
  destination="$snapshot_dir/$command_name"
  # shellcheck disable=SC2016
  if ! digest="$(system_perl -MDigest::SHA -MFcntl=:DEFAULT,:mode -e '
    use strict;
    use warnings;
    my ($source, $destination, $euid) = @ARGV;
    sysopen(my $input, $source, O_RDONLY | O_NOFOLLOW) or exit 1;
    binmode($input);
    my @before = stat($input);
    exit 1 if !@before || !S_ISREG($before[2]) || $before[3] != 1;
    exit 1 if ($before[4] != 0 && $before[4] != $euid) || ($before[2] & 06022);
    exit 1 if ($before[2] & 0111) == 0;
    sysopen(my $output, $destination, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600) or exit 1;
    binmode($output);
    my $source_digest = Digest::SHA->new(256);
    my $buffer;
    while (1) {
      my $read = sysread($input, $buffer, 65536);
      exit 1 if !defined($read);
      last if $read == 0;
      $source_digest->add(substr($buffer, 0, $read));
      my $offset = 0;
      while ($offset < $read) {
        my $written = syswrite($output, $buffer, $read - $offset, $offset);
        exit 1 if !defined($written) || $written == 0;
        $offset += $written;
      }
    }
    close($output) or exit 1;
    chmod(0500, $destination) == 1 or exit 1;
    my @after = stat($input);
    exit 1 if !@after;
    for my $index (0, 1, 2, 3, 4, 7, 9, 10) {
      exit 1 if $before[$index] != $after[$index];
    }
    my @published = lstat($destination);
    exit 1 if !@published || !S_ISREG($published[2]) || S_ISLNK($published[2]);
    exit 1 if $published[4] != $euid || $published[3] != 1;
    exit 1 if ($published[2] & 07777) != 0500 || $published[7] != $before[7];
    sysopen(my $published_input, $destination, O_RDONLY | O_NOFOLLOW) or exit 1;
    binmode($published_input);
    my $published_digest = Digest::SHA->new(256);
    while (1) {
      my $read = sysread($published_input, $buffer, 65536);
      exit 1 if !defined($read);
      last if $read == 0;
      $published_digest->add(substr($buffer, 0, $read));
    }
    close($published_input) or exit 1;
    my $source_hex = $source_digest->hexdigest;
    exit 1 if $published_digest->hexdigest ne $source_hex;
    print "$source_hex\n";
  ' "$source" "$destination" "$EUID")"; then
    /bin/rm -rf -- "$snapshot_dir"
    return 1
  fi
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || {
    /bin/rm -rf -- "$snapshot_dir"
    return 1
  }
  /bin/mv "$destination" "$destination.$digest"
  destination="$destination.$digest"
  if ! path_acl_is_trusted "$source" ||
    ! snapshot_has_safe_native_closure "$destination"; then
    /bin/rm -rf -- "$snapshot_dir"
    return 1
  fi
  printf '%s\n' "$destination"
}

resolve_external_command() {
  local command_name="$1"
  local path_entries=()
  local path_entry
  local candidate
  local resolved
  local fallback_candidates=()
  IFS=: read -r -a path_entries <<<"$external_command_path"
  for path_entry in "${path_entries[@]}"; do
    candidate="$path_entry/$command_name"
    [[ "$candidate" == /* && -f "$candidate" && -x "$candidate" ]] || continue
    path_is_rejected "$candidate" && continue
    resolved="$(canonicalize_external_path "$candidate" 2>/dev/null)" || continue
    [[ "$resolved" == /* && -f "$resolved" && -x "$resolved" ]] || continue
    path_is_rejected "$resolved" && continue
    if command_path_is_strictly_trusted "$resolved"; then
      printf '%s\n' "$resolved"
      return 0
    fi
    fallback_candidates+=("$resolved")
  done
  if [[ "$command_name" == "gh" ]]; then
    for resolved in "${fallback_candidates[@]+"${fallback_candidates[@]}"}"; do
      if resolved="$(snapshot_external_executable "$resolved" "$command_name")"; then
        printf '%s\n' "$resolved"
        return 0
      fi
    done
  fi
  return 1
}

native_node_candidate_is_trusted() {
  local candidate="$1"
  case "$(/usr/bin/uname -s)" in
    Darwin)
      native_executable_has_system_closure "$candidate"
      ;;
    Linux)
      # shellcheck disable=SC2016
      system_perl -e '
        use strict;
        use warnings;
        open(my $input, "<", $ARGV[0]) or exit 1;
        binmode($input);
        read($input, my $prefix, 4) == 4 or exit 1;
        exit 1 if unpack("H*", $prefix) ne "7f454c46";
      ' "$candidate"
      ;;
    *)
      return 1
      ;;
  esac
}

strict_linux_elf_metadata() {
  local candidate="$1"
  local interpreter_policy="$2"
  # Parse the bounded ELF structures directly. readelf renders unescaped
  # string-table bytes and therefore is not a security authority here.
  # shellcheck disable=SC2016
  system_perl -MConfig -MFcntl=:DEFAULT,:mode -e '
    use strict;
    use warnings;
    my ($candidate, $interpreter_policy) = @ARGV;
    exit 1 if $Config{ivsize} < 8 ||
      $interpreter_policy !~ /\A(?:required|forbidden|optional)\z/;

    my $same_metadata = sub {
      my ($left, $right) = @_;
      for my $index (0, 1, 2, 3, 4, 5, 6, 7, 9, 10) {
        return 0 if $left->[$index] != $right->[$index];
      }
      return 1;
    };
    my $read_exact = sub {
      my ($input, $offset, $length) = @_;
      exit 1 if $offset < 0 || $length < 0;
      sysseek($input, $offset, 0) == $offset or exit 1;
      my $value = "";
      while (length($value) < $length) {
        my $remaining = $length - length($value);
        my $read = sysread($input, my $buffer, $remaining);
        exit 1 if !defined($read) || $read == 0;
        $value .= substr($buffer, 0, $read);
      }
      return $value;
    };

    sysopen(my $input, $candidate, O_RDONLY | O_NOFOLLOW) or exit 1;
    binmode($input);
    my @before = stat($input);
    exit 1 if !@before || !S_ISREG($before[2]) || $before[7] < 64;
    my $header = $read_exact->($input, 0, 64);
    exit 1 if substr($header, 0, 4) ne "\x7fELF";
    my $class = ord(substr($header, 4, 1));
    my $data = ord(substr($header, 5, 1));
    my $ident_version = ord(substr($header, 6, 1));
    exit 1 if ($class != 1 && $class != 2) ||
      ($data != 1 && $data != 2) || $ident_version != 1;
    my $elf64 = $class == 2;
    my $little = $data == 1;
    my $u16 = $little
      ? sub { unpack("v", substr($_[0], $_[1], 2)) }
      : sub { unpack("n", substr($_[0], $_[1], 2)) };
    my $u32 = $little
      ? sub { unpack("V", substr($_[0], $_[1], 4)) }
      : sub { unpack("N", substr($_[0], $_[1], 4)) };
    my $u64 = $little
      ? sub { unpack("Q<", substr($_[0], $_[1], 8)) }
      : sub { unpack("Q>", substr($_[0], $_[1], 8)) };
    my $word = $elf64 ? $u64 : $u32;
    my $header_size = $elf64 ? 64 : 52;
    my $program_header_size = $elf64 ? 56 : 32;
    my $elf_type = $u16->($header, 16);
    my $elf_version = $u32->($header, 20);
    my $program_header_offset = $word->($header, $elf64 ? 32 : 28);
    my $declared_header_size = $u16->($header, $elf64 ? 52 : 40);
    my $declared_program_header_size = $u16->(
      $header,
      $elf64 ? 54 : 42,
    );
    my $program_header_count = $u16->($header, $elf64 ? 56 : 44);
    exit 1 if ($elf_type != 2 && $elf_type != 3) || $elf_version != 1 ||
      $declared_header_size != $header_size ||
      $declared_program_header_size != $program_header_size ||
      $program_header_count == 0 || $program_header_count == 0xffff ||
      $program_header_count > 1024 ||
      $program_header_offset < $header_size ||
      $program_header_offset > $before[7];
    my $program_table_bytes = $program_header_count * $program_header_size;
    exit 1 if $program_table_bytes > $before[7] - $program_header_offset;
    my $program_headers = $read_exact->(
      $input,
      $program_header_offset,
      $program_table_bytes,
    );

    my @loads;
    my @interpreters;
    my @dynamics;
    for my $index (0 .. $program_header_count - 1) {
      my $base = $index * $program_header_size;
      my $type = $u32->($program_headers, $base);
      my $segment_offset = $word->(
        $program_headers,
        $base + ($elf64 ? 8 : 4),
      );
      my $virtual_address = $word->(
        $program_headers,
        $base + ($elf64 ? 16 : 8),
      );
      my $file_size = $word->(
        $program_headers,
        $base + ($elf64 ? 32 : 16),
      );
      my $memory_size = $word->(
        $program_headers,
        $base + ($elf64 ? 40 : 20),
      );
      exit 1 if $file_size > 0 &&
        ($segment_offset > $before[7] ||
          $file_size > $before[7] - $segment_offset);
      if ($type == 1) {
        exit 1 if $memory_size < $file_size;
        push @loads, [$segment_offset, $virtual_address, $file_size];
      } elsif ($type == 3) {
        push @interpreters, [$segment_offset, $file_size];
      } elsif ($type == 2) {
        push @dynamics, [
          $segment_offset,
          $virtual_address,
          $file_size,
          $memory_size,
        ];
      }
    }
    exit 1 if @dynamics != 1;
    exit 1 if
      ($interpreter_policy eq "required" && @interpreters != 1) ||
      ($interpreter_policy eq "forbidden" && @interpreters != 0) ||
      ($interpreter_policy eq "optional" && @interpreters > 1);

    my $interpreter = "";
    if (@interpreters == 1) {
      my ($offset, $size) = @{$interpreters[0]};
      exit 1 if $size < 2 || $size > 4096;
      my $bytes = $read_exact->($input, $offset, $size);
      exit 1 if substr($bytes, -1) ne "\0" ||
        index($bytes, "\0") != length($bytes) - 1;
      $interpreter = substr($bytes, 0, -1);
      exit 1 if $interpreter !~
        m{\A/(?:[A-Za-z0-9_+.,:@%=-]+/)*[A-Za-z0-9_+.,:@%=-]+\z};
    }

    my (
      $dynamic_offset,
      $dynamic_address,
      $dynamic_size,
      $dynamic_memory_size,
    ) = @{$dynamics[0]};
    my $dynamic_entry_size = $elf64 ? 16 : 8;
    exit 1 if $dynamic_size < $dynamic_entry_size ||
      $dynamic_size > 1024 * 1024 ||
      $dynamic_size % $dynamic_entry_size != 0 ||
      $dynamic_memory_size != $dynamic_size;
    # Runtime loaders consume PT_DYNAMIC through p_vaddr, not p_offset. Bind
    # the two views so an unsafe in-memory table cannot hide behind benign
    # bytes at an unrelated file offset.
    my @dynamic_mappings;
    for my $load (@loads) {
      my ($file_offset, $virtual_address, $file_size) = @{$load};
      next if $dynamic_address < $virtual_address;
      my $delta = $dynamic_address - $virtual_address;
      next if $delta > $file_size ||
        $dynamic_size > $file_size - $delta;
      push @dynamic_mappings, $file_offset + $delta;
    }
    exit 1 if @dynamic_mappings != 1 ||
      $dynamic_mappings[0] != $dynamic_offset;
    my $dynamic = $read_exact->($input, $dynamic_offset, $dynamic_size);
    my %forbidden = map { $_ => 1 } (
      0x0f,
      0x1d,
      0x6ffffefa,
      0x6ffffefb,
      0x6ffffefc,
      0x7ffffffd,
      0x7fffffff,
    );
    my @string_offsets;
    my $string_table_address;
    my $string_table_size;
    my $saw_null = 0;
    for (
      my $offset = 0;
      $offset < length($dynamic);
      $offset += $dynamic_entry_size
    ) {
      my $tag = $word->($dynamic, $offset);
      my $value = $word->($dynamic, $offset + ($elf64 ? 8 : 4));
      if ($saw_null) {
        exit 1 if $tag != 0 || $value != 0;
        next;
      }
      if ($tag == 0) {
        $saw_null = 1;
        next;
      }
      exit 1 if $forbidden{$tag};
      if ($tag == 1 || $tag == 14) {
        push @string_offsets, [$tag, $value];
      } elsif ($tag == 5) {
        exit 1 if defined($string_table_address);
        $string_table_address = $value;
      } elsif ($tag == 10) {
        exit 1 if defined($string_table_size);
        $string_table_size = $value;
      }
    }
    exit 1 if !$saw_null || !defined($string_table_address) ||
      !defined($string_table_size) || $string_table_size < 1 ||
      $string_table_size > 64 * 1024 * 1024;
    my @mappings;
    for my $load (@loads) {
      my ($file_offset, $virtual_address, $file_size) = @{$load};
      next if $string_table_address < $virtual_address;
      my $delta = $string_table_address - $virtual_address;
      next if $delta > $file_size ||
        $string_table_size > $file_size - $delta;
      push @mappings, $file_offset + $delta;
    }
    exit 1 if @mappings != 1 ||
      $mappings[0] > $before[7] ||
      $string_table_size > $before[7] - $mappings[0];
    my $strings = $read_exact->(
      $input,
      $mappings[0],
      $string_table_size,
    );
    my %seen_needed;
    my @needed;
    my $soname = "";
    for my $record (@string_offsets) {
      my ($tag, $offset) = @{$record};
      exit 1 if $offset < 0 || $offset >= length($strings);
      my $end = index($strings, "\0", $offset);
      exit 1 if $end < $offset;
      my $value = substr($strings, $offset, $end - $offset);
      exit 1 if $value !~ /\A[A-Za-z0-9_+.-]+\z/ ||
        $value eq "." || $value eq "..";
      if ($tag == 1) {
        exit 1 if $seen_needed{$value}++;
        push @needed, $value;
      } else {
        exit 1 if $soname ne "";
        $soname = $value;
      }
    }
    my @after = stat($input);
    my @path_after = lstat($candidate);
    exit 1 if !@after || !@path_after ||
      !$same_metadata->(\@before, \@after) ||
      !$same_metadata->(\@before, \@path_after);
    close($input) or exit 1;
    print "interpreter\t$interpreter\n" if $interpreter ne "";
    print "soname\t$soname\n" if $soname ne "";
    print "needed\t$_\n" for @needed;
  ' "$candidate" "$interpreter_policy"
}

strict_linux_loader_list_metadata() {
  local output="$1"
  local resolved_interpreter="$2"
  shift 2
  # shellcheck disable=SC2016
  system_perl -MDigest::SHA -MFcntl=:DEFAULT,:mode -e '
    use strict;
    use warnings;
    my ($output, $resolved_interpreter, $euid, @needed) = @ARGV;
    my $same_metadata = sub {
      my ($left, $right) = @_;
      for my $index (0, 1, 2, 3, 4, 5, 6, 7, 9, 10) {
        return 0 if $left->[$index] != $right->[$index];
      }
      return 1;
    };
    sysopen(my $input, $output, O_RDONLY | O_NOFOLLOW) or exit 1;
    my @before = stat($input);
    exit 1 if !@before || !S_ISREG($before[2]) || $before[4] != $euid ||
      $before[3] != 1 || $before[7] > 8 * 1024 * 1024;
    my $content = "";
    while (1) {
      my $read = sysread($input, my $buffer, 65536);
      exit 1 if !defined($read);
      last if $read == 0;
      $content .= substr($buffer, 0, $read);
      exit 1 if length($content) > 8 * 1024 * 1024;
    }
    my @after = stat($input);
    exit 1 if !@after || !$same_metadata->(\@before, \@after) ||
      length($content) != $before[7];
    close($input) or exit 1;
    exit 1 if $content eq "" || $content =~ /[^\x09\x0a\x20-\x7e]/;
    my %aliases;
    my %paths;
    my %standalone;
    my %virtuals;
    my @lines = split(/\n/, $content, -1);
    exit 1 if @lines > 2049;
    for my $index (0 .. $#lines) {
      my $line = $lines[$index];
      next if $line eq "" && $index == $#lines;
      exit 1 if $line eq "" || $line =~ /=>\s+not found\b/;
      if ($line =~
        m{^\s*([A-Za-z0-9_+.-]+)\s+=>\s+(/(?:[A-Za-z0-9_+.,:@%=-]+/)*[A-Za-z0-9_+.,:@%=-]+)\s+\(0x[0-9A-Fa-f]+\)\s*$}) {
        exit 1 if $1 eq "." || $1 eq ".." || exists($aliases{$1});
        $aliases{$1} = $2;
        $paths{$2} = 1;
      } elsif ($line =~
        m{^\s*(/(?:[A-Za-z0-9_+.,:@%=-]+/)*[A-Za-z0-9_+.,:@%=-]+)\s+\(0x[0-9A-Fa-f]+\)\s*$}) {
        exit 1 if $standalone{$1}++;
        $paths{$1} = 1;
      } elsif ($line =~
        /^\s*(linux-(?:vdso(?:32|64)?|gate)\.so\.1)\s+\(0x[0-9A-Fa-f]+\)\s*$/) {
        exit 1 if $virtuals{$1}++;
      } else {
        exit 1;
      }
      exit 1 if keys(%aliases) + keys(%standalone) + keys(%virtuals) > 1024;
    }
    exit 1 if !keys(%paths);
    my @interpreter_stat = stat($resolved_interpreter);
    exit 1 if !@interpreter_stat || !S_ISREG($interpreter_stat[2]);
    my $self_matches = 0;
    my $matched_interpreter_path = "";
    for my $path (keys(%standalone)) {
      my @path_stat = stat($path);
      exit 1 if !@path_stat || !S_ISREG($path_stat[2]);
      if ($path_stat[0] == $interpreter_stat[0] &&
          $path_stat[1] == $interpreter_stat[1]) {
        $self_matches++;
        $matched_interpreter_path = $path;
      }
    }
    exit 1 if $self_matches != 1;
    my ($interpreter_name) =
      $matched_interpreter_path =~ m{/([A-Za-z0-9_+.-]+)\z};
    exit 1 if !defined($interpreter_name) || $interpreter_name eq "." ||
      $interpreter_name eq "..";
    my %seen_needed;
    my $self_needed = 0;
    for my $name (@needed) {
      exit 1 if $name !~ /\A[A-Za-z0-9_+.-]+\z/ || $name eq "." ||
        $name eq ".." || $seen_needed{$name}++;
      # glibc renders its own interpreter as the one standalone path even when
      # the executable also declares the loader SONAME in DT_NEEDED. Bind that
      # exceptional name to the inode-matched interpreter; every other needed
      # object must still appear in the explicit alias map.
      next if exists($aliases{$name});
      exit 1 if $name ne $interpreter_name || $self_needed++;
    }
    my $digest = Digest::SHA->new(256);
    for my $name (sort keys(%aliases)) {
      $digest->add("alias\0$name\0$aliases{$name}\0");
    }
    $digest->add("path\0$_\0") for sort keys(%paths);
    $digest->add("standalone\0$_\0") for sort keys(%standalone);
    $digest->add("virtual\0$_\0") for sort keys(%virtuals);
    print "digest\t", $digest->hexdigest, "\n";
    print "interpreter\t$interpreter_name\t$matched_interpreter_path\n";
    print "alias\t$_\t$aliases{$_}\n" for sort keys(%aliases);
    print "standalone\t$_\n" for sort keys(%standalone);
    print "path\t$_\n" for sort keys(%paths);
  ' "$output" "$resolved_interpreter" "$EUID" "$@"
}

strict_linux_loader_path_fingerprint() {
  local candidate="$1"
  local require_executable="$2"
  shift 2
  # Resolve and fingerprint every lexical and symlink-expanded component. This
  # keeps common root-owned /lib and /lib64 symlinks working while rejecting a
  # chain that crosses writable or reviewed-repository ancestry.
  # shellcheck disable=SC2016
  system_perl -MCwd=abs_path -MDigest::SHA -MFcntl=:DEFAULT,:mode -e '
    use strict;
    use warnings;
    my ($candidate, $euid, $require_executable, @rejected_roots) = @ARGV;
    exit 1 if $euid != 0 || $require_executable !~ /\A[01]\z/;
    exit 1 if $candidate !~
      m{\A/(?:[A-Za-z0-9_+.,:@%=-]+/)*[A-Za-z0-9_+.,:@%=-]+\z};

    my $rejected = sub {
      my ($path) = @_;
      for my $root (@rejected_roots) {
        $root =~ s{/+\z}{} if $root ne "/";
        return 1 if $path eq $root || index($path, "$root/") == 0;
      }
      return 0;
    };

    sub normalize_absolute {
      my ($value) = @_;
      return if !defined($value) || substr($value, 0, 1) ne "/" ||
        $value =~ /[\r\n\0]/;
      my @parts;
      for my $part (split(m{/+}, $value)) {
        next if $part eq "" || $part eq ".";
        if ($part eq "..") {
          pop @parts if @parts;
        } else {
          push @parts, $part;
        }
      }
      return "/" . join("/", @parts);
    }

    my $trusted_owner = sub {
      my ($uid) = @_;
      return $uid == 0 || $uid == $euid;
    };

    my $digest = Digest::SHA->new(256);
    my $same_metadata = sub {
      my ($left, $right) = @_;
      for my $index (0, 1, 2, 3, 4, 5, 6, 7, 9, 10) {
        return 0 if $left->[$index] != $right->[$index];
      }
      return 1;
    };
    my $executable_digest = sub {
      my ($path, @path_stat) = @_;
      sysopen(my $input, $path, O_RDONLY | O_NOFOLLOW) or exit 1;
      binmode($input);
      my @before = stat($input);
      exit 1 if !@before || !$same_metadata->(\@path_stat, \@before) ||
        $before[7] < 1 || $before[7] > 64 * 1024 * 1024;
      my $content_digest = Digest::SHA->new(256);
      my $total = 0;
      while (1) {
        my $read = sysread($input, my $buffer, 65536);
        exit 1 if !defined($read);
        last if $read == 0;
        $total += $read;
        exit 1 if $total > $before[7];
        $content_digest->add(substr($buffer, 0, $read));
      }
      my @after = stat($input);
      my @path_after = lstat($path);
      exit 1 if $total != $before[7] || !@after || !@path_after ||
        !$same_metadata->(\@before, \@after) ||
        !$same_metadata->(\@before, \@path_after);
      close($input) or exit 1;
      return $content_digest->hexdigest;
    };
    my $record_entry = sub {
      my ($type, $path, $target, @stat) = @_;
      exit 1 if $rejected->($path) || !$trusted_owner->($stat[4]);
      if ($type eq "directory") {
        exit 1 if !S_ISDIR($stat[2]) || ($stat[2] & 0022);
      } elsif ($type eq "symlink") {
        exit 1 if !S_ISLNK($stat[2]);
      } elsif ($type eq "file") {
        exit 1 if !S_ISREG($stat[2]) || ($stat[2] & 06022) || $stat[3] < 1;
        exit 1 if $require_executable && ($stat[2] & 0111) == 0;
      } else {
        exit 1;
      }
      $digest->add(join("\0", $type, $path, $target,
        @stat[0, 1, 2, 3, 4, 5, 6, 7, 9, 10]), "\0");
    };

    my @root_stat = lstat("/");
    exit 1 if !@root_stat;
    $record_entry->("directory", "/", "", @root_stat);
    my @pending = grep { length($_) } split(m{/}, $candidate);
    my $current = "/";
    my $symlinks = 0;
    while (@pending) {
      my $component = shift @pending;
      exit 1 if $component eq "." || $component eq "..";
      my $next = $current eq "/" ? "/$component" : "$current/$component";
      my @stat = lstat($next);
      exit 1 if !@stat;
      if (S_ISLNK($stat[2])) {
        exit 1 if ++$symlinks > 40;
        my $target = readlink($next);
        exit 1 if !defined($target) || $target eq "" || $target =~ /[\r\n\0]/;
        $record_entry->("symlink", $next, $target, @stat);
        my $target_path = substr($target, 0, 1) eq "/"
          ? $target
          : ($current eq "/" ? "/$target" : "$current/$target");
        my $combined = $target_path;
        $combined .= "/" . join("/", @pending) if @pending;
        $combined = normalize_absolute($combined);
        exit 1 if !defined($combined);
        @pending = grep { length($_) } split(m{/}, $combined);
        $current = "/";
        next;
      }
      if (@pending) {
        $record_entry->("directory", $next, "", @stat);
      } else {
        my $content_digest = $require_executable
          ? $executable_digest->($next, @stat)
          : "";
        $record_entry->("file", $next, $content_digest, @stat);
      }
      $current = $next;
    }
    my $resolved = abs_path($candidate);
    exit 1 if !defined($resolved) || $resolved ne $current ||
      $rejected->($resolved);
    print "$resolved\t", $digest->hexdigest, "\n";
  ' "$candidate" "$EUID" "$require_executable" "$@"
}

strict_linux_snapshot_alias_path_fingerprint() {
  local snapshot_candidate="$1"
  local alias_path="$2"
  local expected_target="$3"
  local target_record
  local target_record_after
  local resolved_target
  local target_fingerprint
  local alias_fingerprint
  target_record="$({
    strict_linux_loader_path_fingerprint \
      "$expected_target" \
      0 \
      "${rejected_command_roots[@]}"
  } 2>/dev/null)" || return 1
  [[ "$target_record" == *$'\t'* ]] || return 1
  resolved_target="${target_record%%$'\t'*}"
  target_fingerprint="${target_record#*$'\t'}"
  [[
    "$resolved_target" == "$expected_target" &&
      "$target_fingerprint" =~ ^[0-9a-f]{64}$
  ]] || return 1
  # The alias is the only loader-controlled path allowed below the sticky
  # system temporary root. Bind it to this exact snapshot, the pinned private
  # runtime, a root-owned 0700 alias directory, and an already validated
  # dependency target. Ordinary dependency paths continue to use the stricter
  # system-ancestry validator above.
  # shellcheck disable=SC2016
  alias_fingerprint="$(system_perl \
    -MDigest::SHA \
    -MFcntl=:mode \
    -MFile::Basename=dirname \
    -e '
      use strict;
      use warnings;
      my (
        $runtime,
        $expected_runtime,
        $temporary_root,
        $snapshot,
        $alias_path,
        $expected_target,
        $target_fingerprint,
        $euid,
      ) = @ARGV;
      exit 1 if $euid != 0 || $target_fingerprint !~ /\A[0-9a-f]{64}\z/;
      for my $path ($runtime, $temporary_root, $snapshot, $alias_path,
          $expected_target) {
        exit 1 if $path !~
          m{\A/(?:[A-Za-z0-9_+.,:@%=-]+/)*[A-Za-z0-9_+.,:@%=-]+\z};
      }
      my $snapshot_directory = dirname($snapshot);
      my $alias_directory = dirname($alias_path);
      my $alias_name = substr($alias_path, length($alias_directory) + 1);
      exit 1 if dirname($runtime) ne $temporary_root ||
        index($snapshot_directory, "$runtime/") != 0 ||
        dirname($snapshot_directory) ne $runtime ||
        $alias_directory ne "$snapshot_directory/loader-aliases" ||
        $alias_name !~ /\A[A-Za-z0-9_+.-]+\z/ ||
        $alias_name eq "." || $alias_name eq "..";

      my $digest = Digest::SHA->new(256);
      my $record = sub {
        my ($kind, $path, $target, @stat) = @_;
        $digest->add(join("\0", $kind, $path, $target,
          @stat[0, 1, 2, 3, 4, 5, 6, 7, 9, 10]), "\0");
      };
      my $record_directory = sub {
        my ($kind, $path, @stat) = @_;
        # Directory timestamps legitimately change when the wrapper creates
        # its manifest/recheck files and when unrelated users write to /tmp.
        # Bind the stable identity/authority fields instead.
        $digest->add(join("\0", $kind, $path,
          @stat[0, 1, 2, 4]), "\0");
      };
      my @runtime_stat = lstat($runtime);
      exit 1 if !@runtime_stat || !S_ISDIR($runtime_stat[2]) ||
        S_ISLNK($runtime_stat[2]) || $runtime_stat[4] != $euid ||
        ($runtime_stat[2] & 07777) != 0700 ||
        join(":", @runtime_stat[0, 1, 2, 4]) ne $expected_runtime;
      $record_directory->("private-directory", $runtime, @runtime_stat);

      my $current = $temporary_root;
      while (1) {
        my @stat = lstat($current);
        exit 1 if !@stat || !S_ISDIR($stat[2]) || S_ISLNK($stat[2]) ||
          ($stat[4] != 0 && $stat[4] != $euid);
        my $shared_writable = ($stat[2] & 0022) != 0;
        exit 1 if $shared_writable && ($stat[2] & 01000) == 0;
        $record_directory->("temporary-ancestor", $current, @stat);
        my $parent = dirname($current);
        last if $parent eq $current;
        $current = $parent;
      }

      for my $directory ($snapshot_directory, $alias_directory) {
        my @stat = lstat($directory);
        exit 1 if !@stat || !S_ISDIR($stat[2]) || S_ISLNK($stat[2]) ||
          $stat[4] != $euid || ($stat[2] & 07777) != 0700;
        $record_directory->("private-directory", $directory, @stat);
      }
      my @snapshot_stat = lstat($snapshot);
      exit 1 if !@snapshot_stat || !S_ISREG($snapshot_stat[2]) ||
        S_ISLNK($snapshot_stat[2]) || $snapshot_stat[4] != $euid ||
        $snapshot_stat[3] != 1 || ($snapshot_stat[2] & 07777) != 0500;
      $record->("snapshot", $snapshot, "", @snapshot_stat);

      my @alias_stat = lstat($alias_path);
      exit 1 if !@alias_stat || !S_ISLNK($alias_stat[2]) ||
        $alias_stat[4] != $euid;
      my $target = readlink($alias_path);
      exit 1 if !defined($target) || $target ne $expected_target;
      my @followed = stat($alias_path);
      my @target_stat = stat($expected_target);
      exit 1 if !@followed || !@target_stat || !S_ISREG($target_stat[2]) ||
        $followed[0] != $target_stat[0] ||
        $followed[1] != $target_stat[1];
      $record->("alias", $alias_path, $target, @alias_stat);
      $record->("target", $expected_target, $target_fingerprint, @target_stat);
      print $digest->hexdigest, "\n";
    ' \
    "$command_runtime_dir" \
    "$command_runtime_identity" \
    "$trusted_temp_root" \
    "$snapshot_candidate" \
    "$alias_path" \
    "$expected_target" \
    "$target_fingerprint" \
    "$EUID")" || return 1
  [[ "$alias_fingerprint" =~ ^[0-9a-f]{64}$ ]] || return 1
  target_record_after="$({
    strict_linux_loader_path_fingerprint \
      "$expected_target" \
      0 \
      "${rejected_command_roots[@]}"
  } 2>/dev/null)" || return 1
  [[ "$target_record_after" == "$target_record" ]] || return 1
  printf '%s\t%s\n' "$resolved_target" "$alias_fingerprint"
}

linux_glibc_preload_is_absent() {
  # A missing preload file is useful only when an untrusted user cannot create
  # it between checks. Pin /etc and every ancestor to root-owned, non-writable
  # real directories before and after the raw lstat absence check.
  # shellcheck disable=SC2016
  system_perl -MErrno=ENOENT -MFcntl=:mode -MFile::Basename=dirname -e '
    use strict;
    use warnings;
    my $euid = $ARGV[0];
    exit 1 if $euid != 0;
    my @directories;
    my $current = "/etc";
    while (1) {
      my @stat = lstat($current);
      exit 1 if !@stat || !S_ISDIR($stat[2]) || S_ISLNK($stat[2]) ||
        $stat[4] != 0 || ($stat[2] & 0022);
      push @directories, [$current, @stat];
      my $parent = dirname($current);
      last if $parent eq $current;
      $current = $parent;
    }
    $! = 0;
    my @preload = lstat("/etc/ld.so.preload");
    exit 1 if @preload || $! != ENOENT;
    for my $record (@directories) {
      my ($path, @before) = @{$record};
      my @after = lstat($path);
      exit 1 if !@after || !S_ISDIR($after[2]) || S_ISLNK($after[2]) ||
        $after[4] != 0 || ($after[2] & 0022);
      for my $index (0, 1, 2, 4) {
        exit 1 if $before[$index] != $after[$index];
      }
    }
  ' "$EUID"
}

strict_linux_glibc_loader_is_supported() {
  local loader="$1"
  local loader_name="${loader##*/}"
  local version_output
  local version_output_file
  linux_glibc_preload_is_absent || return 1
  case "$loader_name" in
    ld-linux*.so.[0-9]* | ld64.so.[0-9]* | ld.so.[0-9]*) ;;
    *) return 1 ;;
  esac
  version_output_file="$({
    /usr/bin/mktemp "$command_runtime_dir/glibc-loader-version.XXXXXX"
  } 2>/dev/null)" || return 1
  /bin/chmod 0600 "$version_output_file"
  if ! {
    /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C \
      "$loader" --version >"$version_output_file" 2>&1
  }; then
    /bin/rm -f -- "$version_output_file"
    return 1
  fi
  # Validate the raw bytes before putting them in a Bash variable. Bash cannot
  # represent NUL, so a `$'\0'` pattern would silently become an empty string
  # and could never provide the intended check.
  # shellcheck disable=SC2016
  if ! version_output="$(system_perl -MFcntl=:DEFAULT,:mode -e '
    use strict;
    use warnings;
    my ($output, $euid) = @ARGV;
    my $same_metadata = sub {
      my ($left, $right) = @_;
      for my $index (0, 1, 2, 3, 4, 5, 6, 7, 9, 10) {
        return 0 if $left->[$index] != $right->[$index];
      }
      return 1;
    };
    sysopen(my $input, $output, O_RDONLY | O_NOFOLLOW) or exit 1;
    binmode($input);
    my @before = stat($input);
    exit 1 if !@before || !S_ISREG($before[2]) || $before[4] != $euid ||
      $before[3] != 1 || ($before[2] & 07777) != 0600 ||
      $before[7] < 1 || $before[7] > 16 * 1024;
    my $content = "";
    while (1) {
      my $read = sysread($input, my $buffer, 4096);
      exit 1 if !defined($read);
      last if $read == 0;
      $content .= substr($buffer, 0, $read);
      exit 1 if length($content) > 16 * 1024;
    }
    my @after = stat($input);
    my @path_after = lstat($output);
    exit 1 if !@after || !@path_after ||
      !$same_metadata->(\@before, \@after) ||
      !$same_metadata->(\@before, \@path_after) ||
      length($content) != $before[7] ||
      $content =~ /[^\x09\x0a\x20-\x7e]/;
    close($input) or exit 1;
    print $content;
  ' "$version_output_file" "$EUID")"; then
    /bin/rm -f -- "$version_output_file"
    return 1
  fi
  /bin/rm -f -- "$version_output_file"
  [[
    -n "$version_output" &&
      (
        "$version_output" == *GLIBC* ||
          "$version_output" == *"GNU libc"* ||
          "$version_output" == *"GNU C Library"*
      )
  ]] && linux_glibc_preload_is_absent
}

linux_node_alias_dir_for_candidate() {
  local candidate="$1"
  printf '%s/loader-aliases\n' "${candidate%/*}"
}

strict_linux_alias_directory_metadata() {
  local directory="$1"
  # shellcheck disable=SC2016
  system_perl -MDigest::SHA -MFcntl=:mode -e '
    use strict;
    use warnings;
    my ($directory, $euid) = @ARGV;
    exit 1 if $euid != 0 || $directory !~
      m{\A/(?:[A-Za-z0-9_+.,:@%=-]+/)*[A-Za-z0-9_+.,:@%=-]+\z};
    my @before = lstat($directory);
    exit 1 if !@before || !S_ISDIR($before[2]) || S_ISLNK($before[2]) ||
      $before[4] != $euid || ($before[2] & 07777) != 0700;
    opendir(my $handle, $directory) or exit 1;
    my %targets;
    while (defined(my $name = readdir($handle))) {
      next if $name eq "." || $name eq "..";
      exit 1 if $name !~ /\A[A-Za-z0-9_+.-]+\z/ || exists($targets{$name});
      exit 1 if keys(%targets) >= 1024;
      my $path = "$directory/$name";
      my @stat = lstat($path);
      exit 1 if !@stat || !S_ISLNK($stat[2]) || $stat[4] != $euid;
      my $target = readlink($path);
      exit 1 if !defined($target) || $target !~
        m{\A/(?:[A-Za-z0-9_+.,:@%=-]+/)*[A-Za-z0-9_+.,:@%=-]+\z};
      $targets{$name} = $target;
    }
    closedir($handle) or exit 1;
    exit 1 if !keys(%targets);
    my @after = lstat($directory);
    exit 1 if !@after;
    for my $index (0, 1, 2, 3, 4, 5, 7, 9, 10) {
      exit 1 if $before[$index] != $after[$index];
    }
    my $digest = Digest::SHA->new(256);
    for my $name (sort keys(%targets)) {
      $digest->add("alias\0$name\0$targets{$name}\0");
    }
    print "digest\t", $digest->hexdigest, "\n";
    print "alias\t$_\t$targets{$_}\n" for sort keys(%targets);
  ' "$directory" "$EUID"
}

run_strict_linux_loader_list() {
  # Use the attested PT_INTERP spelling, not its resolved target. glibc emits
  # its own loader as a standalone row only when the invocation name matches;
  # the metadata parser still binds that row to the resolved loader inode.
  local loader="$1"
  local candidate="$2"
  local library_path="$3"
  local output="$4"
  local error="$5"
  linux_glibc_preload_is_absent || return 1
  if [[ "$library_path" == "-" ]]; then
    /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C \
      "$loader" --list "$candidate" >"$output" 2>"$error"
  else
    [[ "$library_path" == /* && -d "$library_path" && ! -L "$library_path" ]] ||
      return 1
    /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C \
      "LD_LIBRARY_PATH=$library_path" \
      "$loader" --list "$candidate" >"$output" 2>"$error"
  fi
}

linux_node_add_name_mapping() {
  local name="$1"
  local target="$2"
  local mapping_index
  [[
    "$name" =~ ^[A-Za-z0-9_+.-]+$ &&
      "$name" != "." &&
      "$name" != ".." &&
      "$target" == /*
  ]] || return 1
  for mapping_index in "${!name_map_names[@]}"; do
    if [[ "${name_map_names[$mapping_index]}" == "$name" ]]; then
      [[ "${name_map_targets[$mapping_index]}" == "$target" ]]
      return
    fi
  done
  [[ "${#name_map_names[@]}" -lt 1024 ]] || return 1
  name_map_names+=("$name")
  name_map_targets+=("$target")
}

linux_node_add_needed_name() {
  local name="$1"
  local existing
  [[
    "$name" =~ ^[A-Za-z0-9_+.-]+$ &&
      "$name" != "." &&
      "$name" != ".."
  ]] || return 1
  for existing in "${needed_names[@]+"${needed_names[@]}"}"; do
    [[ "$existing" != "$name" ]] || return 0
  done
  [[ "${#needed_names[@]}" -lt 1024 ]] || return 1
  needed_names+=("$name")
}

strict_linux_dependency_elf_metadata() {
  local candidate="$1"
  local expected_interpreter_record="$2"
  local metadata
  local metadata_kind
  local metadata_value
  local metadata_extra
  local interpreter_count=0
  metadata="$({
    strict_linux_elf_metadata "$candidate" optional
  } 2>/dev/null)" || return 1
  while IFS=$'\t' read -r metadata_kind metadata_value metadata_extra; do
    [[ -z "$metadata_extra" ]] || return 1
    case "$metadata_kind" in
      interpreter)
        [[ "$interpreter_count" -eq 0 && "$metadata_value" == /* ]] || return 1
        interpreter_count=1
        [[
          "$({
            strict_linux_loader_path_fingerprint \
              "$metadata_value" \
              1 \
              "${rejected_command_roots[@]}"
          } 2>/dev/null)" == "$expected_interpreter_record"
        ]] || return 1
        ;;
      needed | soname)
        printf '%s\t%s\n' "$metadata_kind" "$metadata_value"
        ;;
      *) return 1 ;;
    esac
  done <<<"$metadata"
}

linux_node_closure_manifest_path() {
  local candidate="$1"
  local manifests=("$candidate".loader-closure.*)
  [[
    "${#manifests[@]}" -eq 1 &&
      -f "${manifests[0]}" &&
      ! -L "${manifests[0]}"
  ]] || return 1
  # shellcheck disable=SC2016
  system_perl -MDigest::SHA -MFcntl=:DEFAULT,:mode -e '
    use strict;
    use warnings;
    my ($manifest, $euid) = @ARGV;
    my @stat = lstat($manifest);
    exit 1 if !@stat || !S_ISREG($stat[2]) || S_ISLNK($stat[2]);
    exit 1 if $stat[4] != $euid || $stat[3] != 1 ||
      ($stat[2] & 07777) != 0400 || $stat[7] > 1024 * 1024;
    my ($expected) = $manifest =~ /\.loader-closure\.([0-9a-f]{64})\z/;
    exit 1 if !defined($expected);
    sysopen(my $input, $manifest, O_RDONLY | O_NOFOLLOW) or exit 1;
    binmode($input);
    my $digest = Digest::SHA->new(256);
    my $buffer;
    while (1) {
      my $read = sysread($input, $buffer, 65536);
      exit 1 if !defined($read);
      last if $read == 0;
      $digest->add(substr($buffer, 0, $read));
    }
    close($input) or exit 1;
    exit 1 if $digest->hexdigest ne $expected;
    print "$manifest\n";
  ' "${manifests[0]}" "$EUID"
}

linux_node_snapshot_closure_is_trusted() {
  local candidate="$1"
  local manifest
  local alias_dir=""
  local expected_alias_digest=""
  local expected_loader_digest=""
  local loader_requested=""
  local loader_resolved=""
  local loader_count=0
  local policy_count=0
  local line_number=0
  local record_count=0
  local kind
  local executable
  local requested
  local resolved
  local expected_fingerprint
  local extra
  local index
  local current
  local found
  local alias_metadata
  local alias_metadata_after
  local alias_metadata_kind
  local alias_metadata_name
  local alias_metadata_target
  local current_alias_digest=""
  local loader_output
  local loader_error
  local loader_metadata
  local metadata_kind
  local metadata_value
  local metadata_third
  local metadata_extra
  local current_loader_digest=""
  local loader_interpreter_count=0
  local needed_names=()
  local needed_targets=()
  local manifest_alias_names=()
  local manifest_alias_targets=()
  local actual_alias_names=()
  local actual_alias_targets=()
  local record_executables=()
  local record_kinds=()
  local record_requested=()
  local record_resolved=()
  local record_fingerprints=()

  [[ "$(/usr/bin/uname -s)" == "Linux" && "$EUID" -eq 0 ]] || return 1
  linux_glibc_preload_is_absent || return 1
  snapshot_path_is_trusted "$candidate" || return 1
  manifest="$(linux_node_closure_manifest_path "$candidate")" || return 1
  while IFS=$'\t' read -r kind executable requested resolved expected_fingerprint extra; do
    line_number=$((line_number + 1))
    if [[ "$line_number" -eq 1 ]]; then
      [[
        "$kind" == "loader-closure-v3" &&
          -z "$executable" &&
          -z "$requested" &&
          -z "$resolved" &&
          -z "$expected_fingerprint" &&
          -z "$extra"
      ]] || return 1
      continue
    fi
    case "$kind" in
      policy)
        [[
          "$policy_count" -eq 0 &&
            "$executable" == "0" &&
            "$requested" == /* &&
            "$resolved" == "-" &&
            "$expected_fingerprint" =~ ^[0-9a-f]{64}$ &&
            "$extra" =~ ^[0-9a-f]{64}$
        ]] || return 1
        policy_count=1
        alias_dir="$requested"
        expected_alias_digest="$expected_fingerprint"
        expected_loader_digest="$extra"
        continue
        ;;
      loader)
        [[
          "$loader_count" -eq 0 &&
            "$executable" == "1" &&
            "$requested" == /* &&
            "$resolved" == /* &&
            "$expected_fingerprint" =~ ^[0-9a-f]{64}$ &&
            "$extra" == "-"
        ]] || return 1
        loader_count=1
        loader_requested="$requested"
        loader_resolved="$resolved"
        ;;
      needed)
        [[
          "$executable" == "0" &&
            "$requested" =~ ^[A-Za-z0-9_+.-]+$ &&
            "$requested" != "." &&
            "$requested" != ".." &&
            "$resolved" == /* &&
            "$expected_fingerprint" == "-" &&
            "$extra" == "-"
        ]] || return 1
        for index in "${!needed_names[@]}"; do
          [[ "${needed_names[$index]}" != "$requested" ]] || return 1
        done
        needed_names+=("$requested")
        needed_targets+=("$resolved")
        continue
        ;;
      alias)
        [[
          "$executable" == "0" &&
            "$requested" == /* &&
            "$resolved" == /* &&
            "$expected_fingerprint" =~ ^[0-9a-f]{64}$ &&
            "$extra" =~ ^[A-Za-z0-9_+.-]+$ &&
            "$extra" != "." &&
            "$extra" != ".."
        ]] || return 1
        manifest_alias_names+=("$extra")
        manifest_alias_targets+=("$resolved")
        ;;
      file)
        [[
          "$executable" == "0" &&
            "$requested" == /* &&
            "$resolved" == /* &&
            "$expected_fingerprint" =~ ^[0-9a-f]{64}$ &&
            "$extra" == "-"
        ]] || return 1
        ;;
      *) return 1 ;;
    esac
    record_count=$((record_count + 1))
    [[ "$record_count" -le 3072 ]] || return 1
    path_is_rejected "$requested" && return 1
    path_is_rejected "$resolved" && return 1
    record_kinds+=("$kind")
    record_executables+=("$executable")
    record_requested+=("$requested")
    record_resolved+=("$resolved")
    record_fingerprints+=("$expected_fingerprint")
  done <"$manifest"
  [[
    "$line_number" -ge 4 &&
      "$policy_count" -eq 1 &&
      "$loader_count" -eq 1 &&
      "${#needed_names[@]}" -gt 0 &&
      "${#needed_names[@]}" -eq "${#manifest_alias_names[@]}" &&
      "$alias_dir" == "$(linux_node_alias_dir_for_candidate "$candidate")"
  ]] || return 1
  path_is_rejected "$alias_dir" && return 1

  alias_metadata="$({
    strict_linux_alias_directory_metadata "$alias_dir"
  } 2>/dev/null)" || return 1
  while IFS=$'\t' read -r alias_metadata_kind alias_metadata_name alias_metadata_target metadata_extra; do
    [[ -z "$metadata_extra" ]] || return 1
    case "$alias_metadata_kind" in
      digest)
        [[
          -z "$current_alias_digest" &&
            "$alias_metadata_name" =~ ^[0-9a-f]{64}$ &&
            -z "$alias_metadata_target"
        ]] || return 1
        current_alias_digest="$alias_metadata_name"
        ;;
      alias)
        [[
          "$alias_metadata_name" =~ ^[A-Za-z0-9_+.-]+$ &&
            "$alias_metadata_name" != "." &&
            "$alias_metadata_name" != ".." &&
            "$alias_metadata_target" == /*
        ]] || return 1
        actual_alias_names+=("$alias_metadata_name")
        actual_alias_targets+=("$alias_metadata_target")
        ;;
      *) return 1 ;;
    esac
  done <<<"$alias_metadata"
  [[
    "$current_alias_digest" == "$expected_alias_digest" &&
      "${#actual_alias_names[@]}" -eq "${#needed_names[@]}"
  ]] || return 1
  for index in "${!needed_names[@]}"; do
    found=0
    for current in "${!actual_alias_names[@]}"; do
      if [[ "${actual_alias_names[$current]}" == "${needed_names[$index]}" ]]; then
        [[ "${actual_alias_targets[$current]}" == "${needed_targets[$index]}" ]] ||
          return 1
        found=$((found + 1))
      fi
    done
    [[ "$found" -eq 1 ]] || return 1
    found=0
    for current in "${!manifest_alias_names[@]}"; do
      if [[ "${manifest_alias_names[$current]}" == "${needed_names[$index]}" ]]; then
        [[ "${manifest_alias_targets[$current]}" == "${needed_targets[$index]}" ]] ||
          return 1
        found=$((found + 1))
      fi
    done
    [[ "$found" -eq 1 ]] || return 1
  done

  for index in "${!record_requested[@]}"; do
    if [[ "${record_kinds[$index]}" == "alias" ]]; then
      current="$({
        strict_linux_snapshot_alias_path_fingerprint \
          "$candidate" \
          "${record_requested[$index]}" \
          "${record_resolved[$index]}"
      } 2>/dev/null)" || return 1
    else
      current="$({
        strict_linux_loader_path_fingerprint \
          "${record_requested[$index]}" \
          "${record_executables[$index]}" \
          "${rejected_command_roots[@]}"
      } 2>/dev/null)" || return 1
    fi
    [[
      "$current" == "${record_resolved[$index]}"$'\t'"${record_fingerprints[$index]}"
    ]] || return 1
  done
  # Validate the sealed manifest fingerprint before executing the loader for
  # either --version or --list during re-attestation.
  strict_linux_glibc_loader_is_supported "$loader_resolved" || return 1

  loader_output="$({
    /usr/bin/mktemp "$candidate.loader-recheck.XXXXXX"
  } 2>/dev/null)" || return 1
  loader_error="$loader_output.err"
  [[ ! -e "$loader_error" && ! -L "$loader_error" ]] || {
    /bin/rm -f -- "$loader_output"
    return 1
  }
  : >"$loader_error"
  /bin/chmod 0600 "$loader_output" "$loader_error"
  if ! run_strict_linux_loader_list \
    "$loader_requested" \
    "$candidate" \
    "$alias_dir" \
    "$loader_output" \
    "$loader_error"; then
    /bin/rm -f -- "$loader_output" "$loader_error"
    return 1
  fi
  if [[ -s "$loader_error" ]]; then
    /bin/rm -f -- "$loader_output" "$loader_error"
    return 1
  fi
  loader_metadata="$({
    strict_linux_loader_list_metadata \
      "$loader_output" \
      "$loader_resolved" \
      "${needed_names[@]+"${needed_names[@]}"}"
  } 2>/dev/null)" || {
    /bin/rm -f -- "$loader_output" "$loader_error"
    return 1
  }
  /bin/rm -f -- "$loader_output" "$loader_error"
  while IFS=$'\t' read -r metadata_kind metadata_value metadata_third metadata_extra; do
    [[ -z "$metadata_extra" ]] || return 1
    case "$metadata_kind" in
      interpreter)
        [[
          "$loader_interpreter_count" -eq 0 &&
            "$metadata_value" =~ ^[A-Za-z0-9_+.-]+$ &&
            "$metadata_value" != "." &&
            "$metadata_value" != ".." &&
            "$metadata_third" == /*
        ]] || return 1
        loader_interpreter_count=1
        ;;
      digest)
        [[
          -z "$current_loader_digest" &&
            "$metadata_value" =~ ^[0-9a-f]{64}$ &&
            -z "$metadata_third"
        ]] || return 1
        current_loader_digest="$metadata_value"
        ;;
      alias)
        [[
          "$metadata_value" =~ ^[A-Za-z0-9_+.-]+$ &&
            "$metadata_third" == /*
        ]] || return 1
        ;;
      path | standalone)
        [[ "$metadata_value" == /* && -z "$metadata_third" ]] || return 1
        ;;
      *) return 1 ;;
    esac
  done <<<"$loader_metadata"
  [[
    "$loader_interpreter_count" -eq 1 &&
      "$current_loader_digest" == "$expected_loader_digest"
  ]] || return 1

  for index in "${!record_requested[@]}"; do
    if [[ "${record_kinds[$index]}" == "alias" ]]; then
      current="$({
        strict_linux_snapshot_alias_path_fingerprint \
          "$candidate" \
          "${record_requested[$index]}" \
          "${record_resolved[$index]}"
      } 2>/dev/null)" || return 1
    else
      current="$({
        strict_linux_loader_path_fingerprint \
          "${record_requested[$index]}" \
          "${record_executables[$index]}" \
          "${rejected_command_roots[@]}"
      } 2>/dev/null)" || return 1
    fi
    [[
      "$current" == "${record_resolved[$index]}"$'\t'"${record_fingerprints[$index]}"
    ]] || return 1
  done
  alias_metadata_after="$({
    strict_linux_alias_directory_metadata "$alias_dir"
  } 2>/dev/null)" || return 1
  [[ "$alias_metadata_after" == "$alias_metadata" ]] || return 1
  linux_glibc_preload_is_absent || return 1
  [[ "$loader_requested" == "${record_requested[0]}" ]] || return 1
  snapshot_path_is_trusted "$candidate" || return 1
  [[ "$(linux_node_closure_manifest_path "$candidate")" == "$manifest" ]]
}

linux_node_snapshot_has_safe_closure() {
  local candidate="$1"
  local elf_metadata
  local file_metadata
  local needed_names=()
  local name_map_names=()
  local name_map_targets=()
  local interpreter=""
  local interpreter_count=0
  local metadata_kind
  local metadata_value
  local metadata_third
  local metadata_extra
  local interpreter_record=""
  local resolved_interpreter
  local interpreter_fingerprint
  local loader_output="$candidate.loader-list.out"
  local loader_error="$candidate.loader-list.err"
  local loader_metadata
  local ambient_loader_digest=""
  local controlled_loader_digest=""
  local ambient_interpreter_count=0
  local ambient_interpreter_name=""
  local ambient_interpreter_path=""
  local controlled_interpreter_count=0
  local controlled_interpreter_name=""
  local controlled_interpreter_path=""
  local ambient_alias_names=()
  local ambient_alias_paths=()
  local closure_paths=()
  local closure_path
  local fingerprint_record
  local resolved_path
  local fingerprint
  local after_fingerprint_record
  local file_soname
  local inspected_path
  local already_inspected
  local inspected_resolved_paths=()
  local closure_requested_paths=()
  local closure_resolved_paths=()
  local closure_fingerprints=()
  local controlled_paths=()
  local controlled_alias_names=()
  local controlled_alias_paths=()
  local controlled_requested_paths=()
  local controlled_resolved_paths=()
  local controlled_fingerprints=()
  local alias_dir
  local alias_path
  local alias_metadata
  local alias_metadata_after
  local alias_digest=""
  local alias_metadata_kind
  local alias_metadata_name
  local alias_metadata_target
  local alias_count=0
  local target
  local found
  local index
  local mapping_index
  local manifest="$candidate.loader-closure"
  local manifest_digest
  [[ "$(/usr/bin/uname -s)" == "Linux" && "$EUID" -eq 0 ]] || return 1
  set_root_node_snapshot_stage preload-policy
  linux_glibc_preload_is_absent || return 1
  set_root_node_snapshot_stage snapshot-trust
  snapshot_path_is_trusted "$candidate" || return 1
  set_root_node_snapshot_stage native-format
  native_node_candidate_is_trusted "$candidate" || return 1
  set_root_node_snapshot_stage elf-metadata
  elf_metadata="$({
    strict_linux_elf_metadata "$candidate" required
  } 2>/dev/null)" ||
    return 1
  while IFS=$'\t' read -r metadata_kind metadata_value metadata_extra; do
    [[ -z "$metadata_extra" ]] || return 1
    case "$metadata_kind" in
      interpreter)
        [[ "$interpreter_count" -eq 0 && "$metadata_value" == /* ]] ||
          return 1
        interpreter_count=1
        interpreter="$metadata_value"
        ;;
      needed)
        linux_node_add_needed_name "$metadata_value" || return 1
        ;;
      soname)
        [[
          "$metadata_value" =~ ^[A-Za-z0-9_+.-]+$ &&
            "$metadata_value" != "." &&
            "$metadata_value" != ".."
        ]] || return 1
        ;;
      *)
        return 1
        ;;
    esac
  done <<<"$elf_metadata"
  [[ "$interpreter_count" -eq 1 ]] || return 1

  set_root_node_snapshot_stage interpreter-path
  path_is_rejected "$interpreter" && return 1
  interpreter_record="$({
    strict_linux_loader_path_fingerprint \
      "$interpreter" \
      1 \
      "${rejected_command_roots[@]}"
  } 2>/dev/null)" || return 1
  [[ "$interpreter_record" == *$'\t'* ]] || return 1
  resolved_interpreter="${interpreter_record%%$'\t'*}"
  interpreter_fingerprint="${interpreter_record#*$'\t'}"
  [[
    "$resolved_interpreter" == /* &&
      "$interpreter_fingerprint" =~ ^[0-9a-f]{64}$
  ]] || return 1
  path_is_rejected "$resolved_interpreter" && return 1
  set_root_node_snapshot_stage loader-policy
  strict_linux_elf_metadata "$resolved_interpreter" forbidden >/dev/null 2>&1 ||
    return 1
  strict_linux_glibc_loader_is_supported "$resolved_interpreter" || return 1
  [[
    "$({
      strict_linux_loader_path_fingerprint \
        "$interpreter" \
        1 \
        "${rejected_command_roots[@]}"
    } 2>/dev/null)" == "$interpreter_record"
  ]] || return 1
  [[ ! -e "$loader_output" && ! -L "$loader_output" ]] || return 1
  [[ ! -e "$loader_error" && ! -L "$loader_error" ]] || return 1
  : >"$loader_output"
  : >"$loader_error"
  /bin/chmod 0600 "$loader_output" "$loader_error"
  set_root_node_snapshot_stage ambient-loader-exec
  if ! run_strict_linux_loader_list \
    "$interpreter" \
    "$candidate" \
    - \
    "$loader_output" \
    "$loader_error"; then
    /bin/rm -f -- "$loader_output" "$loader_error"
    return 1
  fi
  set_root_node_snapshot_stage ambient-loader-stderr
  if [[ -s "$loader_error" ]]; then
    /bin/rm -f -- "$loader_output" "$loader_error"
    return 1
  fi
  set_root_node_snapshot_stage ambient-loader-parse
  loader_metadata="$({
    strict_linux_loader_list_metadata \
      "$loader_output" \
      "$resolved_interpreter" \
      "${needed_names[@]+"${needed_names[@]}"}"
  } 2>/dev/null)" || {
    /bin/rm -f -- "$loader_output" "$loader_error"
    return 1
  }
  /bin/rm -f -- "$loader_output" "$loader_error"
  set_root_node_snapshot_stage ambient-loader-policy
  while IFS=$'\t' read -r metadata_kind metadata_value metadata_third metadata_extra; do
    [[ -z "$metadata_extra" ]] || return 1
    case "$metadata_kind" in
      interpreter)
        [[
          "$ambient_interpreter_count" -eq 0 &&
            "$metadata_value" =~ ^[A-Za-z0-9_+.-]+$ &&
            "$metadata_value" != "." &&
            "$metadata_value" != ".." &&
            "$metadata_third" == /*
        ]] || return 1
        ambient_interpreter_count=1
        ambient_interpreter_name="$metadata_value"
        ambient_interpreter_path="$metadata_third"
        ;;
      digest)
        [[
          -z "$ambient_loader_digest" &&
            "$metadata_value" =~ ^[0-9a-f]{64}$ &&
            -z "$metadata_third"
        ]] ||
          return 1
        ambient_loader_digest="$metadata_value"
        ;;
      alias)
        [[
          "$metadata_value" =~ ^[A-Za-z0-9_+.-]+$ &&
            "$metadata_value" != "." &&
            "$metadata_value" != ".." &&
            "$metadata_third" == /*
        ]] || return 1
        ambient_alias_names+=("$metadata_value")
        ambient_alias_paths+=("$metadata_third")
        ;;
      path)
        [[ "$metadata_value" == /* && -z "$metadata_third" ]] || return 1
        closure_paths+=("$metadata_value")
        ;;
      standalone)
        [[ "$metadata_value" == /* && -z "$metadata_third" ]] || return 1
        ;;
      *)
        return 1
        ;;
    esac
  done <<<"$loader_metadata"
  [[
    "$ambient_interpreter_count" -eq 1 &&
      -n "$ambient_loader_digest" &&
      "${#closure_paths[@]}" -gt 0 &&
      "$({
        strict_linux_loader_path_fingerprint \
          "$ambient_interpreter_path" \
          1 \
          "${rejected_command_roots[@]}"
      } 2>/dev/null)" == "$interpreter_record"
  ]] || return 1

  for metadata_value in "${needed_names[@]+"${needed_names[@]}"}"; do
    if [[ "$metadata_value" == "$ambient_interpreter_name" ]]; then
      linux_node_add_name_mapping "$metadata_value" "$resolved_interpreter" ||
        return 1
    fi
  done

  # Parse every object selected by the clean glibc resolver.  Collect the full
  # recursive DT_NEEDED name set and bind each SONAME/requested alias to one
  # validated physical file.
  set_root_node_snapshot_stage dependency-closure
  for closure_path in "${closure_paths[@]}"; do
    [[ -n "$closure_path" ]] || return 1
    [[ "$closure_path" != "$candidate" ]] || continue
    path_is_rejected "$closure_path" && return 1
    fingerprint_record="$({
      strict_linux_loader_path_fingerprint \
        "$closure_path" \
        0 \
        "${rejected_command_roots[@]}"
    } 2>/dev/null)" || return 1
    [[ "$fingerprint_record" == *$'\t'* ]] || return 1
    resolved_path="${fingerprint_record%%$'\t'*}"
    fingerprint="${fingerprint_record#*$'\t'}"
    [[
      "$resolved_path" == /* &&
        "$fingerprint" =~ ^[0-9a-f]{64}$
    ]] || return 1
    path_is_rejected "$resolved_path" && return 1
    closure_requested_paths+=("$closure_path")
    closure_resolved_paths+=("$resolved_path")
    closure_fingerprints+=("$fingerprint")
    already_inspected=0
    for inspected_path in "${inspected_resolved_paths[@]}"; do
      [[ "$inspected_path" != "$resolved_path" ]] || already_inspected=1
    done
    if [[ "$already_inspected" -eq 0 ]]; then
      file_metadata="$({
        strict_linux_dependency_elf_metadata \
          "$resolved_path" \
          "$interpreter_record"
      } 2>/dev/null)" || return 1
      file_soname=""
      while IFS=$'\t' read -r metadata_kind metadata_value metadata_extra; do
        [[ -z "$metadata_extra" ]] || return 1
        case "$metadata_kind" in
          soname)
            [[ -z "$file_soname" ]] || return 1
            file_soname="$metadata_value"
            ;;
          needed)
            linux_node_add_needed_name "$metadata_value" || return 1
            ;;
          *) return 1 ;;
        esac
      done <<<"$file_metadata"
      if [[ -n "$file_soname" ]]; then
        linux_node_add_name_mapping "$file_soname" "$resolved_path" || return 1
      fi
      inspected_resolved_paths+=("$resolved_path")
    fi
    after_fingerprint_record="$({
      strict_linux_loader_path_fingerprint \
        "$closure_path" \
        0 \
        "${rejected_command_roots[@]}"
    } 2>/dev/null)" || return 1
    [[ "$after_fingerprint_record" == "$fingerprint_record" ]] || return 1
  done

  for index in "${!ambient_alias_names[@]}"; do
    found=0
    target=""
    for mapping_index in "${!closure_requested_paths[@]}"; do
      if [[
        "${closure_requested_paths[$mapping_index]}" == "${ambient_alias_paths[$index]}"
      ]]; then
        target="${closure_resolved_paths[$mapping_index]}"
        found=$((found + 1))
      fi
    done
    [[ "$found" -eq 1 && -n "$target" ]] || return 1
    linux_node_add_name_mapping "${ambient_alias_names[$index]}" "$target" ||
      return 1
  done

  for metadata_value in "${needed_names[@]+"${needed_names[@]}"}"; do
    found=0
    target=""
    for mapping_index in "${!name_map_names[@]}"; do
      if [[ "${name_map_names[$mapping_index]}" == "$metadata_value" ]]; then
        target="${name_map_targets[$mapping_index]}"
        found=$((found + 1))
      fi
    done
    [[ "$found" -eq 1 && -n "$target" ]] || return 1
  done

  set_root_node_snapshot_stage alias-policy
  alias_dir="$(linux_node_alias_dir_for_candidate "$candidate")" || return 1
  [[ ! -e "$alias_dir" && ! -L "$alias_dir" ]] || return 1
  /bin/mkdir -m 0700 -- "$alias_dir" || return 1
  for metadata_value in "${needed_names[@]+"${needed_names[@]}"}"; do
    target=""
    for mapping_index in "${!name_map_names[@]}"; do
      if [[ "${name_map_names[$mapping_index]}" == "$metadata_value" ]]; then
        target="${name_map_targets[$mapping_index]}"
      fi
    done
    [[ -n "$target" ]] || return 1
    /bin/ln -s -- "$target" "$alias_dir/$metadata_value" || return 1
  done
  alias_metadata="$({
    strict_linux_alias_directory_metadata "$alias_dir"
  } 2>/dev/null)" || return 1
  while IFS=$'\t' read -r alias_metadata_kind alias_metadata_name alias_metadata_target metadata_extra; do
    [[ -z "$metadata_extra" ]] || return 1
    case "$alias_metadata_kind" in
      digest)
        [[
          -z "$alias_digest" &&
            "$alias_metadata_name" =~ ^[0-9a-f]{64}$ &&
            -z "$alias_metadata_target"
        ]] || return 1
        alias_digest="$alias_metadata_name"
        ;;
      alias)
        alias_count=$((alias_count + 1))
        ;;
      *) return 1 ;;
    esac
  done <<<"$alias_metadata"
  [[
    "$alias_digest" =~ ^[0-9a-f]{64}$ &&
      "$alias_count" -eq "${#needed_names[@]}"
  ]] || return 1

  # Resolve again with the sealed alias directory first in the search policy.
  # This digest, rather than the ambient discovery pass, is what every later
  # launch and before/after check must reproduce.
  : >"$loader_output"
  : >"$loader_error"
  /bin/chmod 0600 "$loader_output" "$loader_error"
  set_root_node_snapshot_stage controlled-loader-list
  if ! run_strict_linux_loader_list \
    "$interpreter" \
    "$candidate" \
    "$alias_dir" \
    "$loader_output" \
    "$loader_error"; then
    /bin/rm -f -- "$loader_output" "$loader_error"
    return 1
  fi
  if [[ -s "$loader_error" ]]; then
    /bin/rm -f -- "$loader_output" "$loader_error"
    return 1
  fi
  loader_metadata="$({
    strict_linux_loader_list_metadata \
      "$loader_output" \
      "$resolved_interpreter" \
      "${needed_names[@]+"${needed_names[@]}"}"
  } 2>/dev/null)" || {
    /bin/rm -f -- "$loader_output" "$loader_error"
    return 1
  }
  /bin/rm -f -- "$loader_output" "$loader_error"
  while IFS=$'\t' read -r metadata_kind metadata_value metadata_third metadata_extra; do
    [[ -z "$metadata_extra" ]] || return 1
    case "$metadata_kind" in
      interpreter)
        [[
          "$controlled_interpreter_count" -eq 0 &&
            "$metadata_value" =~ ^[A-Za-z0-9_+.-]+$ &&
            "$metadata_value" != "." &&
            "$metadata_value" != ".." &&
            "$metadata_third" == /*
        ]] || return 1
        controlled_interpreter_count=1
        controlled_interpreter_name="$metadata_value"
        controlled_interpreter_path="$metadata_third"
        ;;
      digest)
        [[
          -z "$controlled_loader_digest" &&
            "$metadata_value" =~ ^[0-9a-f]{64}$ &&
            -z "$metadata_third"
        ]] || return 1
        controlled_loader_digest="$metadata_value"
        ;;
      alias)
        [[
          "$metadata_value" =~ ^[A-Za-z0-9_+.-]+$ &&
            "$metadata_third" == /*
        ]] || return 1
        controlled_alias_names+=("$metadata_value")
        controlled_alias_paths+=("$metadata_third")
        ;;
      path)
        [[ "$metadata_value" == /* && -z "$metadata_third" ]] || return 1
        controlled_paths+=("$metadata_value")
        ;;
      standalone)
        [[ "$metadata_value" == /* && -z "$metadata_third" ]] || return 1
        ;;
      *) return 1 ;;
    esac
  done <<<"$loader_metadata"
  [[
    "$controlled_interpreter_count" -eq 1 &&
      "$controlled_interpreter_name" == "$ambient_interpreter_name" &&
      "$({
        strict_linux_loader_path_fingerprint \
          "$controlled_interpreter_path" \
          1 \
          "${rejected_command_roots[@]}"
      } 2>/dev/null)" == "$interpreter_record" &&
      "$controlled_loader_digest" =~ ^[0-9a-f]{64}$ &&
      "${#controlled_paths[@]}" -gt 0
  ]] || return 1

  for index in "${!controlled_alias_names[@]}"; do
    found=0
    target=""
    for mapping_index in "${!needed_names[@]}"; do
      if [[ "${needed_names[$mapping_index]}" == "${controlled_alias_names[$index]}" ]]; then
        found=$((found + 1))
      fi
    done
    [[ "$found" -eq 1 ]] || return 1
    for mapping_index in "${!name_map_names[@]}"; do
      if [[ "${name_map_names[$mapping_index]}" == "${controlled_alias_names[$index]}" ]]; then
        target="${name_map_targets[$mapping_index]}"
      fi
    done
    [[ -n "$target" ]] || return 1
    fingerprint_record="$({
      strict_linux_snapshot_alias_path_fingerprint \
        "$candidate" \
        "${controlled_alias_paths[$index]}" \
        "$target"
    } 2>/dev/null)" || return 1
    resolved_path="${fingerprint_record%%$'\t'*}"
    [[ "$resolved_path" == "$target" ]] || return 1
  done

  for closure_path in "${controlled_paths[@]}"; do
    [[ "$closure_path" != "$candidate" ]] || continue
    if [[ "$closure_path" == "$alias_dir"/* ]]; then
      metadata_value="${closure_path##*/}"
      target=""
      for mapping_index in "${!name_map_names[@]}"; do
        if [[ "${name_map_names[$mapping_index]}" == "$metadata_value" ]]; then
          target="${name_map_targets[$mapping_index]}"
        fi
      done
      [[ -n "$target" ]] || return 1
      fingerprint_record="$({
        strict_linux_snapshot_alias_path_fingerprint \
          "$candidate" \
          "$closure_path" \
          "$target"
      } 2>/dev/null)" || return 1
      [[ "$fingerprint_record" == "$target"$'\t'* ]] || return 1
      continue
    fi
    fingerprint_record="$({
      strict_linux_loader_path_fingerprint \
        "$closure_path" \
        0 \
        "${rejected_command_roots[@]}"
    } 2>/dev/null)" || return 1
    resolved_path="${fingerprint_record%%$'\t'*}"
    fingerprint="${fingerprint_record#*$'\t'}"
    [[ "$resolved_path" == /* && "$fingerprint" =~ ^[0-9a-f]{64}$ ]] ||
      return 1
    found=0
    [[ "$resolved_path" != "$resolved_interpreter" ]] || found=1
    for mapping_index in "${!name_map_targets[@]}"; do
      [[ "${name_map_targets[$mapping_index]}" != "$resolved_path" ]] || found=1
    done
    [[ "$found" -eq 1 ]] || return 1
    strict_linux_dependency_elf_metadata \
      "$resolved_path" \
      "$interpreter_record" >/dev/null 2>&1 || return 1
    after_fingerprint_record="$({
      strict_linux_loader_path_fingerprint \
        "$closure_path" \
        0 \
        "${rejected_command_roots[@]}"
    } 2>/dev/null)" || return 1
    [[ "$after_fingerprint_record" == "$fingerprint_record" ]] || return 1
    controlled_requested_paths+=("$closure_path")
    controlled_resolved_paths+=("$resolved_path")
    controlled_fingerprints+=("$fingerprint")
  done
  alias_metadata_after="$({
    strict_linux_alias_directory_metadata "$alias_dir"
  } 2>/dev/null)" || return 1
  [[ "$alias_metadata_after" == "$alias_metadata" ]] || return 1

  set_root_node_snapshot_stage manifest-seal
  [[ ! -e "$manifest" && ! -L "$manifest" ]] || return 1
  : >"$manifest"
  /bin/chmod 0600 "$manifest"
  printf '%s\n' 'loader-closure-v3' >"$manifest"
  printf 'policy\t0\t%s\t-\t%s\t%s\n' \
    "$alias_dir" \
    "$alias_digest" \
    "$controlled_loader_digest" >>"$manifest"
  printf 'loader\t1\t%s\t%s\t%s\t-\n' \
    "$interpreter" \
    "$resolved_interpreter" \
    "$interpreter_fingerprint" >>"$manifest"
  for metadata_value in "${needed_names[@]+"${needed_names[@]}"}"; do
    target=""
    for mapping_index in "${!name_map_names[@]}"; do
      if [[ "${name_map_names[$mapping_index]}" == "$metadata_value" ]]; then
        target="${name_map_targets[$mapping_index]}"
      fi
    done
    [[ -n "$target" ]] || return 1
    printf 'needed\t0\t%s\t%s\t-\t-\n' \
      "$metadata_value" \
      "$target" >>"$manifest"
    alias_path="$alias_dir/$metadata_value"
    fingerprint_record="$({
      strict_linux_snapshot_alias_path_fingerprint \
        "$candidate" \
        "$alias_path" \
        "$target"
    } 2>/dev/null)" || return 1
    resolved_path="${fingerprint_record%%$'\t'*}"
    fingerprint="${fingerprint_record#*$'\t'}"
    [[ "$resolved_path" == "$target" && "$fingerprint" =~ ^[0-9a-f]{64}$ ]] ||
      return 1
    printf 'alias\t0\t%s\t%s\t%s\t%s\n' \
      "$alias_path" \
      "$target" \
      "$fingerprint" \
      "$metadata_value" >>"$manifest"
  done
  for index in "${!controlled_requested_paths[@]}"; do
    printf 'file\t0\t%s\t%s\t%s\t-\n' \
      "${controlled_requested_paths[$index]}" \
      "${controlled_resolved_paths[$index]}" \
      "${controlled_fingerprints[$index]}" >>"$manifest"
  done
  # shellcheck disable=SC2016
  manifest_digest="$(system_perl -MDigest::SHA -MFcntl=:DEFAULT,:mode -e '
    use strict;
    use warnings;
    my $manifest = $ARGV[0];
    sysopen(my $input, $manifest, O_RDONLY | O_NOFOLLOW) or exit 1;
    my @stat = stat($input);
    exit 1 if !@stat || !S_ISREG($stat[2]) || $stat[7] > 1024 * 1024;
    my $digest = Digest::SHA->new(256);
    my $buffer;
    while (1) {
      my $read = sysread($input, $buffer, 65536);
      exit 1 if !defined($read);
      last if $read == 0;
      $digest->add(substr($buffer, 0, $read));
    }
    close($input) or exit 1;
    print $digest->hexdigest, "\n";
  ' "$manifest")" || return 1
  [[ "$manifest_digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  /bin/chmod 0400 "$manifest"
  /bin/mv "$manifest" "$manifest.$manifest_digest"
  set_root_node_snapshot_stage closure-attestation
  linux_node_snapshot_closure_is_trusted "$candidate"
}

snapshot_linux_root_ancestor_node() {
  local source="$1"
  local snapshot_dir
  local destination
  local digest
  local alias_dir
  local node_version
  local smoke_output
  set_root_node_snapshot_stage source-proof
  [[ "$(/usr/bin/uname -s)" == "Linux" && "$EUID" -eq 0 ]] || return 1
  [[ "$source" == /* && -f "$source" && -x "$source" && ! -L "$source" ]] ||
    return 1
  path_is_rejected "$source" && return 1
  snapshot_dir="$(
    /usr/bin/mktemp -d \
      "$command_runtime_dir/node.XXXXXX" \
      2>/dev/null || true
  )"
  [[ -n "$snapshot_dir" && -d "$snapshot_dir" && ! -L "$snapshot_dir" ]] ||
    return 1
  /bin/chmod 0700 "$snapshot_dir"
  destination="$snapshot_dir/node"
  # A root-run package-manager process may inherit an image-installed Node
  # whose on-disk owner is the image build user. Trust only the exact native
  # executable already running in this wrapper's live ancestor chain, then
  # copy it through /proc into the private command runtime.
  # shellcheck disable=SC2016
  if ! digest="$(system_perl -MDigest::SHA -MFcntl=:DEFAULT,:mode -e '
    use strict;
    use warnings;
    my ($source, $destination, $euid) = @ARGV;
    my $maximum_size = 256 * 1024 * 1024;

    sub read_proc_identity {
      my ($pid) = @_;
      return if !defined($pid) || $pid !~ /\A[1-9][0-9]*\z/;
      my $stat_path = "/proc/$pid/stat";
      sysopen(my $input, $stat_path, O_RDONLY | O_NOFOLLOW) or return;
      my $content = "";
      my $buffer;
      while (1) {
        my $read = sysread($input, $buffer, 4096);
        return if !defined($read);
        last if $read == 0;
        $content .= substr($buffer, 0, $read);
        return if length($content) > 8192;
      }
      close($input) or return;
      my $closing = rindex($content, ") ");
      return if $closing < 0;
      my $fields_text = substr($content, $closing + 2);
      $fields_text =~ s/\s+\z//;
      my @fields = split(/\s+/, $fields_text);
      return if @fields < 20;
      my ($ppid, $starttime) = @fields[1, 19];
      return if $ppid !~ /\A[0-9]+\z/ || $starttime !~ /\A[0-9]+\z/;

      my $status_path = "/proc/$pid/status";
      sysopen(my $status, $status_path, O_RDONLY | O_NOFOLLOW) or return;
      my $status_content = "";
      while (1) {
        my $read = sysread($status, $buffer, 4096);
        return if !defined($read);
        last if $read == 0;
        $status_content .= substr($buffer, 0, $read);
        return if length($status_content) > 1024 * 1024;
      }
      close($status) or return;
      my ($real_uid, $effective_uid, $saved_uid, $filesystem_uid) =
        $status_content =~ /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*$/m;
      return if !defined($filesystem_uid);
      return ($ppid, $starttime, $real_uid, $effective_uid, $saved_uid,
        $filesystem_uid);
    }

    sub find_live_ancestor {
      my ($device, $inode, $wanted_pid, $wanted_starttime) = @_;
      my $pid = getppid();
      my %seen;
      for (1 .. 64) {
        return if !$pid || $seen{$pid}++;
        my ($ppid, $starttime, @uids) = read_proc_identity($pid);
        return if !defined($ppid) || !defined($starttime) || @uids != 4;
        my $all_root_uids = !grep { $_ ne "0" } @uids;
        return if !$all_root_uids;
        my @executable = stat("/proc/$pid/exe");
        if (@executable && $executable[0] == $device &&
            $executable[1] == $inode) {
          if (!defined($wanted_pid) ||
              ($pid == $wanted_pid && $starttime eq $wanted_starttime)) {
            return ($pid, $starttime);
          }
        }
        last if $ppid == 0 || $ppid == $pid;
        $pid = $ppid;
      }
      return;
    }

    sub same_metadata {
      my ($left, $right) = @_;
      for my $index (0, 1, 2, 3, 4, 5, 7, 9, 10) {
        return 0 if $left->[$index] != $right->[$index];
      }
      return 1;
    }

    sub digest_open_file {
      my ($input, $expected_size, $maximum_size) = @_;
      return if $expected_size <= 0 || $expected_size > $maximum_size;
      sysseek($input, 0, 0) == 0 or return;
      my $digest = Digest::SHA->new(256);
      my $total = 0;
      my $buffer;
      while (1) {
        my $read = sysread($input, $buffer, 65536);
        return if !defined($read);
        last if $read == 0;
        $total += $read;
        return if $total > $expected_size || $total > $maximum_size;
        $digest->add(substr($buffer, 0, $read));
      }
      return if $total != $expected_size;
      return $digest->hexdigest;
    }

    exit 1 if $euid != 0;
    sysopen(my $candidate, $source, O_RDONLY | O_NOFOLLOW) or exit 1;
    binmode($candidate);
    my @candidate_before = stat($candidate);
    exit 1 if !@candidate_before || !S_ISREG($candidate_before[2]);
    # Tool caches may publish a root-owned, foreign-owned, writable, or
    # hard-linked executable. The exact all-root-UID live ancestor plus
    # before/after metadata and digest bind the copied inode; keep rejecting
    # set-ID execution semantics that the sealed copy drops.
    exit 1 if $candidate_before[3] < 1 || ($candidate_before[2] & 06000);
    exit 1 if ($candidate_before[2] & 0111) == 0;
    exit 1 if $candidate_before[7] <= 0 || $candidate_before[7] > $maximum_size;
    my $prefix;
    exit 1 if sysread($candidate, $prefix, 4) != 4;
    exit 1 if unpack("H*", $prefix) ne "7f454c46";
    sysseek($candidate, 0, 0) == 0 or exit 1;

    my ($ancestor_pid, $ancestor_starttime) = find_live_ancestor(
      $candidate_before[0],
      $candidate_before[1],
      undef,
      undef,
    );
    exit 1 if !defined($ancestor_pid) || !defined($ancestor_starttime);
    my $proc_source = "/proc/$ancestor_pid/exe";
    # /proc/<pid>/exe is an intentional kernel-owned symlink to the already
    # running executable, so this one open must follow the final component.
    sysopen(my $input, $proc_source, O_RDONLY) or exit 1;
    binmode($input);
    my @input_before = stat($input);
    exit 1 if !@input_before ||
      !same_metadata(\@candidate_before, \@input_before);

    sysopen(
      my $output,
      $destination,
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
      0600,
    ) or exit 1;
    binmode($output);
    my $source_digest = Digest::SHA->new(256);
    my $total = 0;
    my $buffer;
    while (1) {
      my $read = sysread($input, $buffer, 65536);
      exit 1 if !defined($read);
      last if $read == 0;
      $total += $read;
      exit 1 if $total > $maximum_size || $total > $input_before[7];
      $source_digest->add(substr($buffer, 0, $read));
      my $offset = 0;
      while ($offset < $read) {
        my $written = syswrite($output, $buffer, $read - $offset, $offset);
        exit 1 if !defined($written) || $written == 0;
        $offset += $written;
      }
    }
    exit 1 if $total != $input_before[7];
    my $source_hex = $source_digest->hexdigest;
    close($output) or exit 1;
    chmod(0500, $destination) == 1 or exit 1;

    my @input_after = stat($input);
    my @candidate_after = stat($candidate);
    my @path_after = lstat($source);
    exit 1 if !@input_after ||
      !same_metadata(\@input_before, \@input_after);
    exit 1 if !@candidate_after ||
      !same_metadata(\@candidate_before, \@candidate_after);
    exit 1 if !@path_after ||
      !same_metadata(\@candidate_before, \@path_after);
    my ($verified_pid, $verified_starttime) = find_live_ancestor(
      $candidate_before[0],
      $candidate_before[1],
      $ancestor_pid,
      $ancestor_starttime,
    );
    exit 1 if !defined($verified_pid) || !defined($verified_starttime);
    my $ancestor_hex_after = digest_open_file(
      $input,
      $total,
      $maximum_size,
    );
    my $candidate_hex_after = digest_open_file(
      $candidate,
      $total,
      $maximum_size,
    );
    exit 1 if !defined($ancestor_hex_after) ||
      !defined($candidate_hex_after) ||
      $ancestor_hex_after ne $source_hex ||
      $candidate_hex_after ne $source_hex;
    close($input) or exit 1;
    close($candidate) or exit 1;

    my @published = lstat($destination);
    exit 1 if !@published || !S_ISREG($published[2]) || S_ISLNK($published[2]);
    exit 1 if $published[4] != $euid || $published[3] != 1;
    exit 1 if ($published[2] & 07777) != 0500 || $published[7] != $total;
    sysopen(my $published_input, $destination, O_RDONLY | O_NOFOLLOW) or exit 1;
    binmode($published_input);
    my $published_digest = Digest::SHA->new(256);
    while (1) {
      my $read = sysread($published_input, $buffer, 65536);
      exit 1 if !defined($read);
      last if $read == 0;
      $published_digest->add(substr($buffer, 0, $read));
    }
    close($published_input) or exit 1;
    exit 1 if $published_digest->hexdigest ne $source_hex;
    print "$source_hex\n";
  ' "$source" "$destination" "$EUID")"; then
    report_root_node_snapshot_rejection
    /bin/rm -rf -- "$snapshot_dir"
    return 1
  fi
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || {
    /bin/rm -rf -- "$snapshot_dir"
    return 1
  }
  /bin/mv "$destination" "$destination.$digest"
  destination="$destination.$digest"
  set_root_node_snapshot_stage snapshot-trust
  if ! snapshot_path_is_trusted "$destination"; then
    report_root_node_snapshot_rejection
    /bin/rm -rf -- "$snapshot_dir"
    return 1
  fi
  set_root_node_snapshot_stage native-format
  if ! native_node_candidate_is_trusted "$destination"; then
    report_root_node_snapshot_rejection
    /bin/rm -rf -- "$snapshot_dir"
    return 1
  fi
  if ! linux_node_snapshot_has_safe_closure "$destination"; then
    report_root_node_snapshot_rejection
    /bin/rm -rf -- "$snapshot_dir"
    return 1
  fi
  set_root_node_snapshot_stage closure-attestation
  linux_node_snapshot_closure_is_trusted "$destination" || {
    report_root_node_snapshot_rejection
    /bin/rm -rf -- "$snapshot_dir"
    return 1
  }
  alias_dir="$(linux_node_alias_dir_for_candidate "$destination")" || {
    set_root_node_snapshot_stage alias-policy
    report_root_node_snapshot_rejection
    /bin/rm -rf -- "$snapshot_dir"
    return 1
  }
  set_root_node_snapshot_stage version-exec
  node_version="$(
    /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C \
      "LD_LIBRARY_PATH=$alias_dir" \
      "AUTOREVIEW_ATTESTED_NODE_LIBRARY_PATH=$alias_dir" \
      "$destination" --version 2>/dev/null
  )" || {
    report_root_node_snapshot_rejection
    /bin/rm -rf -- "$snapshot_dir"
    return 1
  }
  [[
    "$node_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.+-]+)?$
  ]] || {
    set_root_node_snapshot_stage version-output
    report_root_node_snapshot_rejection
    /bin/rm -rf -- "$snapshot_dir"
    return 1
  }
  set_root_node_snapshot_stage version-reattest
  linux_node_snapshot_closure_is_trusted "$destination" || {
    report_root_node_snapshot_rejection
    /bin/rm -rf -- "$snapshot_dir"
    return 1
  }
  set_root_node_snapshot_stage smoke-exec
  smoke_output="$(
    /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C \
      "LD_LIBRARY_PATH=$alias_dir" \
      "AUTOREVIEW_ATTESTED_NODE_LIBRARY_PATH=$alias_dir" \
      "$destination" \
      -e 'process.stdout.write("agent-autoreview-node-smoke")' \
      2>/dev/null
  )" || {
    report_root_node_snapshot_rejection
    /bin/rm -rf -- "$snapshot_dir"
    return 1
  }
  if [[ "$smoke_output" != "agent-autoreview-node-smoke" ]] ||
    ! linux_node_snapshot_closure_is_trusted "$destination"; then
    set_root_node_snapshot_stage smoke-reattest
    report_root_node_snapshot_rejection
    /bin/rm -rf -- "$snapshot_dir"
    return 1
  fi
  printf '%s\n' "$destination"
}

snapshot_node_candidate() {
  local source="$1"
  local snapshotted
  if snapshotted="$(snapshot_linux_root_ancestor_node "$source")"; then
    printf '%s\n' "$snapshotted"
    return 0
  fi
  snapshot_external_executable "$source" node
}

trusted_login_home() {
  # shellcheck disable=SC2016
  system_perl -MCwd=abs_path -e '
    use strict;
    use warnings;
    my @entry = getpwuid($>);
    exit 1 if !@entry;
    my $home = abs_path($entry[7]);
    exit 1 if !defined($home) || $home !~ m{^/} || $home =~ /[\r\n\0]/;
    print "$home\n";
  '
}

resolve_volta_node() {
  local shim="$1"
  local volta_candidate
  local volta_bin=""
  local resolved
  local login_home
  local executable
  local snapshotted_node
  local volta_candidates=("${shim%/volta-shim}/volta")
  if [[ "$shim" == */bin/volta-shim ]]; then
    volta_candidates+=("${shim%/bin/volta-shim}/libexec/bin/volta")
  fi
  for volta_candidate in "${volta_candidates[@]}"; do
    [[ -f "$volta_candidate" && -x "$volta_candidate" ]] || continue
    resolved="$(canonicalize_external_path "$volta_candidate" 2>/dev/null)" || continue
    path_is_rejected "$resolved" && continue
    if command_path_is_strictly_trusted "$resolved" &&
      native_node_candidate_is_trusted "$resolved"; then
      volta_bin="$resolved"
      break
    fi
    if volta_bin="$(snapshot_external_executable "$resolved" volta)"; then
      break
    fi
    volta_bin=""
  done
  [[ -n "$volta_bin" ]] || return 1
  snapshot_path_is_trusted "$volta_bin" 2>/dev/null ||
    command_path_is_strictly_trusted "$volta_bin" || return 1
  login_home="$(trusted_login_home)" || return 1
  path_is_rejected "$login_home" && return 1
  if ! executable="$(
    /usr/bin/env -i \
      "HOME=$login_home" \
      PATH=/usr/bin:/bin:/usr/sbin:/sbin \
      "$volta_bin" which node 2>/dev/null
  )"; then
    return 1
  fi
  [[
    "$executable" == /* &&
      "$executable" != *$'\n'* &&
      -f "$executable" &&
      -x "$executable"
  ]] || return 1
  resolved="$(canonicalize_external_path "$executable" 2>/dev/null)" || return 1
  path_is_rejected "$resolved" && return 1
  if command_path_is_strictly_trusted "$resolved" &&
    native_node_candidate_is_trusted "$resolved"; then
    printf '%s\n' "$resolved"
    return 0
  fi
  if snapshotted_node="$(snapshot_node_candidate "$resolved")"; then
    printf '%s\n' "$snapshotted_node"
    return 0
  fi
  return 1
}

resolve_node_command() {
  local path_entries=()
  local path_entry
  local candidate
  local resolved
  local snapshotted_node
  local fallback_candidates=()
  local volta_shims=()
  IFS=: read -r -a path_entries <<<"$external_command_path"
  for path_entry in "${path_entries[@]}"; do
    candidate="$path_entry/node"
    [[ "$candidate" == /* && -f "$candidate" && -x "$candidate" ]] || continue
    path_is_rejected "$candidate" && continue
    resolved="$(canonicalize_external_path "$candidate" 2>/dev/null)" || continue
    [[ "$resolved" == /* && -f "$resolved" && -x "$resolved" ]] || continue
    path_is_rejected "$resolved" && continue
    if [[ "${resolved##*/}" == "volta-shim" ]]; then
      volta_shims+=("$resolved")
      continue
    fi
    if command_path_is_strictly_trusted "$resolved" &&
      native_node_candidate_is_trusted "$resolved"; then
      printf '%s\n' "$resolved"
      return 0
    fi
    if snapshotted_node="$(
      snapshot_linux_root_ancestor_node "$resolved"
    )"; then
      printf '%s\n' "$snapshotted_node"
      return 0
    fi
    fallback_candidates+=("$resolved")
  done
  for resolved in "${volta_shims[@]+"${volta_shims[@]}"}"; do
    if resolved="$(resolve_volta_node "$resolved")"; then
      printf '%s\n' "$resolved"
      return 0
    fi
  done
  for resolved in "${fallback_candidates[@]+"${fallback_candidates[@]}"}"; do
    if resolved="$(snapshot_external_executable "$resolved" node)"; then
      printf '%s\n' "$resolved"
      return 0
    fi
  done
  return 1
}

git_bin="$(resolve_external_command git || true)"
node_bin="$(resolve_node_command || true)"
if [[
  "$root_node_snapshot_diagnostics" -eq 1 &&
    -z "$node_bin"
]]; then
  root_node_snapshot_stage="source-proof"
  diagnostic_record=""
  if [[
    -f "$root_node_snapshot_diagnostic_file" &&
      ! -L "$root_node_snapshot_diagnostic_file"
  ]]; then
    IFS= read -r diagnostic_record <"$root_node_snapshot_diagnostic_file" ||
      diagnostic_record=""
  fi
  if [[ "$diagnostic_record" =~ ^[0-9]+:([a-z-]+)$ ]]; then
    set_root_node_snapshot_stage "${BASH_REMATCH[1]}"
  fi
  printf 'agent:autoreview: root Node trust rejected at %s\n' \
    "$root_node_snapshot_stage" >&2
fi
/bin/rm -f -- "$root_node_snapshot_diagnostic_file"
unset AUTOREVIEW_TEST_NODE_SNAPSHOT_DIAGNOSTICS
unset AUTOREVIEW_TEST_REQUIRE_ROOT_SNAPSHOT
root_node_snapshot_diagnostics=0

if [[ ! -x "$helper" ]]; then
  cat >&2 <<EOF
agent:autoreview requires an executable autoreview helper:
  $helper

This repo vendors its default helper at:
  $default_helper

Restore that file, or set AUTOREVIEW_HELPER to an executable helper path.
EOF
  exit 127
fi
if [[ -z "$git_bin" || ! -x "$git_bin" ]]; then
  echo "agent:autoreview requires a trusted git executable" >&2
  exit 127
fi
if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
  echo "agent:autoreview requires a trusted node executable" >&2
  exit 127
fi

attested_node_library_path=""
if [[
  "$(/usr/bin/uname -s)" == "Linux" &&
    "$EUID" -eq 0 &&
    "$node_bin" == "$command_runtime_dir"/*
]]; then
  attested_node_library_path="$(linux_node_alias_dir_for_candidate "$node_bin")"
  if [[
    "$attested_node_library_path" != /* ||
      ! -d "$attested_node_library_path" ||
      -L "$attested_node_library_path"
  ]] || ! linux_node_snapshot_closure_is_trusted "$node_bin"; then
    echo "agent:autoreview: attested Node loader policy changed before use" >&2
    exit 127
  fi
fi

command_file_identity() {
  # shellcheck disable=SC2016
  system_perl -MFcntl=:mode -e '
    use strict;
    use warnings;
    my @stat = lstat($ARGV[0]);
    exit 1 if !@stat || !S_ISREG($stat[2]) || S_ISLNK($stat[2]);
    print join(":", @stat[0, 1, 2, 3, 4, 7, 9, 10]), "\n";
  ' "$1"
}

git_bin_identity="$(command_file_identity "$git_bin")"
node_bin_identity="$(command_file_identity "$node_bin")"

prepared_helper_override=""
attested_helper_override=""
attested_helper_runtime_dir=""
attested_helper_runtime_identity=""
attested_helper_runtime_manifest=""

resolved_command_is_trusted() {
  local candidate="$1"
  if [[ "$candidate" == "$node_bin" ]]; then
    if [[ "$candidate" == "$command_runtime_dir"/* ]]; then
      if [[ "$(/usr/bin/uname -s)" == "Linux" && "$EUID" -eq 0 ]]; then
        linux_node_snapshot_closure_is_trusted "$candidate"
      else
        snapshot_path_is_trusted "$candidate"
      fi
    else
      [[ "$(command_file_identity "$candidate" 2>/dev/null || true)" == "$node_bin_identity" ]]
    fi
  elif [[ "$candidate" == "$command_runtime_dir"/* ]]; then
    snapshot_path_is_trusted "$candidate"
  elif [[ "$candidate" == "$git_bin" ]]; then
    [[ "$(command_file_identity "$candidate" 2>/dev/null || true)" == "$git_bin_identity" ]]
  else
    command_path_is_strictly_trusted "$candidate"
  fi
}

run_trusted_external() {
  local executable="$1"
  local status
  shift
  resolved_command_is_trusted "$executable" || {
    echo "agent:autoreview: resolved executable changed before launch: $executable" >&2
    return 127
  }
  if /usr/bin/env \
    -u NODE_OPTIONS \
    -u NODE_PATH \
    -u OPENSSL_CONF \
    -u OPENSSL_MODULES \
    -u GLIBC_TUNABLES \
    -u LD_AUDIT \
    -u LD_DEBUG \
    -u LD_DEBUG_OUTPUT \
    -u LD_PRELOAD \
    -u LD_LIBRARY_PATH \
    -u LD_ORIGIN_PATH \
    -u LD_PROFILE \
    -u LD_SHOW_AUXV \
    -u DYLD_INSERT_LIBRARIES \
    -u DYLD_LIBRARY_PATH \
    -u DYLD_FRAMEWORK_PATH \
    -u DYLD_FALLBACK_LIBRARY_PATH \
    -u DYLD_FALLBACK_FRAMEWORK_PATH \
    -u DYLD_IMAGE_SUFFIX \
    -u DYLD_PRINT_TO_FILE \
    -u DYLD_ROOT_PATH \
    -u DYLD_SHARED_REGION \
    -u DYLD_VERSIONED_FRAMEWORK_PATH \
    -u DYLD_VERSIONED_LIBRARY_PATH \
    "$executable" "$@"; then
    status=0
  else
    status=$?
  fi
  resolved_command_is_trusted "$executable" || {
    echo "agent:autoreview: resolved executable changed after launch: $executable" >&2
    return 127
  }
  return "$status"
}

run_trusted_node() {
  local status
  if [[ -z "$attested_node_library_path" ]]; then
    run_trusted_external "$node_bin" "$@"
    return
  fi
  linux_node_snapshot_closure_is_trusted "$node_bin" || {
    echo "agent:autoreview: attested Node closure changed before launch" >&2
    return 127
  }
  if /usr/bin/env \
    -u NODE_OPTIONS \
    -u NODE_PATH \
    -u OPENSSL_CONF \
    -u OPENSSL_MODULES \
    -u GLIBC_TUNABLES \
    -u LD_AUDIT \
    -u LD_DEBUG \
    -u LD_DEBUG_OUTPUT \
    -u LD_PRELOAD \
    -u LD_LIBRARY_PATH \
    -u LD_ORIGIN_PATH \
    -u LD_PROFILE \
    -u LD_SHOW_AUXV \
    "LD_LIBRARY_PATH=$attested_node_library_path" \
    "AUTOREVIEW_ATTESTED_NODE_LIBRARY_PATH=$attested_node_library_path" \
    "$node_bin" "$@"; then
    status=0
  else
    status=$?
  fi
  linux_node_snapshot_closure_is_trusted "$node_bin" || {
    echo "agent:autoreview: attested Node closure changed after launch" >&2
    return 127
  }
  return "$status"
}

run_trusted_node_in_clean_env() {
  local environment_count="$1"
  local environment_index
  local environment_name
  local environment_args=()
  local status
  shift
  [[ "$environment_count" =~ ^[0-9]+$ && "$environment_count" -le 64 ]] ||
    return 127
  for ((environment_index = 0; environment_index < environment_count; environment_index++)); do
    [[ "$#" -gt 0 && "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*=.*$ ]] || return 127
    environment_name="${1%%=*}"
    case "$environment_name" in
      LD_* | GLIBC_TUNABLES | AUTOREVIEW_ATTESTED_NODE_LIBRARY_PATH | \
        NODE_OPTIONS | NODE_PATH | OPENSSL_CONF | OPENSSL_MODULES)
        return 127
        ;;
    esac
    environment_args+=("$1")
    shift
  done
  if [[ -n "$attested_node_library_path" ]]; then
    linux_node_snapshot_closure_is_trusted "$node_bin" || {
      echo "agent:autoreview: attested Node closure changed before clean-environment launch" >&2
      return 127
    }
    if /usr/bin/env -i \
      "${environment_args[@]}" \
      "LD_LIBRARY_PATH=$attested_node_library_path" \
      "AUTOREVIEW_ATTESTED_NODE_LIBRARY_PATH=$attested_node_library_path" \
      "$node_bin" "$@"; then
      status=0
    else
      status=$?
    fi
    linux_node_snapshot_closure_is_trusted "$node_bin" || {
      echo "agent:autoreview: attested Node closure changed after clean-environment launch" >&2
      return 127
    }
    return "$status"
  fi
  resolved_command_is_trusted "$node_bin" || {
    echo "agent:autoreview: resolved node executable changed before clean-environment launch" >&2
    return 127
  }
  if /usr/bin/env -i "${environment_args[@]}" "$node_bin" "$@"; then
    status=0
  else
    status=$?
  fi
  resolved_command_is_trusted "$node_bin" || {
    echo "agent:autoreview: resolved node executable changed after clean-environment launch" >&2
    return 127
  }
  return "$status"
}

run_helper() {
  if [[ -n "$attested_helper_override" && "$helper" == "$default_helper" ]]; then
    run_attested_helper "$@"
  elif [[ -n "$prepared_helper_override" ]]; then
    PATH="$external_command_path" \
      run_trusted_node "$prepared_helper_override" "$@"
  elif [[ "$helper" == "$default_helper" ]]; then
    PATH="$external_command_path" run_trusted_node "$helper" "$@"
  else
    PATH="$external_command_path" /usr/bin/env \
      -u NODE_OPTIONS \
      -u NODE_PATH \
      -u LD_AUDIT \
      -u LD_DEBUG \
      -u LD_DEBUG_OUTPUT \
      -u LD_PRELOAD \
      -u LD_LIBRARY_PATH \
      -u LD_ORIGIN_PATH \
      -u LD_PROFILE \
      -u LD_SHOW_AUXV \
      -u DYLD_INSERT_LIBRARIES \
      -u DYLD_LIBRARY_PATH \
      -u DYLD_FRAMEWORK_PATH \
      -u DYLD_FALLBACK_LIBRARY_PATH \
      -u DYLD_FALLBACK_FRAMEWORK_PATH \
      -u DYLD_IMAGE_SUFFIX \
      -u DYLD_PRINT_TO_FILE \
      -u DYLD_ROOT_PATH \
      -u DYLD_SHARED_REGION \
      -u DYLD_VERSIONED_FRAMEWORK_PATH \
      -u DYLD_VERSIONED_LIBRARY_PATH \
      "$helper" "$@"
  fi
}

run_attested_helper() {
  local attested_helper
  local after_manifest
  local status=0
  if [[ -n "$attested_helper_override" ]]; then
    attested_helper="$attested_helper_override"
    if [[
      -z "$attested_helper_runtime_dir" ||
        -z "$attested_helper_runtime_identity" ||
        -z "$attested_helper_runtime_manifest"
    ]] || ! after_manifest="$(
      bundle_content_manifest \
        "$attested_helper_runtime_dir" \
        "$attested_helper_runtime_identity"
    )" || [[ "$after_manifest" != "$attested_helper_runtime_manifest" ]]; then
      echo "agent:autoreview: wrapper-attested helper runtime changed before launch" >&2
      return 1
    fi
  elif [[ -n "$prepared_helper_override" ]]; then
    attested_helper="$prepared_helper_override"
  else
    attested_helper="$default_helper"
  fi
  if [[ ! -x "$attested_helper" ]]; then
    echo "agent:autoreview: wrapper-attested helper runtime is unavailable: $attested_helper" >&2
    return 127
  fi
  PATH="$external_command_path" run_trusted_node "$attested_helper" "$@" || status=$?
  if [[ -n "$attested_helper_override" ]]; then
    if ! after_manifest="$(
      bundle_content_manifest \
        "$attested_helper_runtime_dir" \
        "$attested_helper_runtime_identity"
    )" || [[ "$after_manifest" != "$attested_helper_runtime_manifest" ]]; then
      echo "agent:autoreview: wrapper-attested helper runtime changed during launch" >&2
      return 1
    fi
  fi
  return "$status"
}

run_external_command() {
  PATH="$external_command_path" run_trusted_external "$@"
}

exec_helper() {
  if [[ -n "$prepared_helper_override" ]]; then
    PATH="$external_command_path" run_trusted_node \
      "$prepared_helper_override" "$@"
  elif [[ "$helper" == "$default_helper" ]]; then
    PATH="$external_command_path" run_trusted_node "$helper" "$@"
  else
    PATH="$external_command_path" /usr/bin/env \
      -u NODE_OPTIONS \
      -u NODE_PATH \
      -u LD_AUDIT \
      -u LD_DEBUG \
      -u LD_DEBUG_OUTPUT \
      -u LD_PRELOAD \
      -u LD_LIBRARY_PATH \
      -u LD_ORIGIN_PATH \
      -u LD_PROFILE \
      -u LD_SHOW_AUXV \
      -u DYLD_INSERT_LIBRARIES \
      -u DYLD_LIBRARY_PATH \
      -u DYLD_FRAMEWORK_PATH \
      -u DYLD_FALLBACK_LIBRARY_PATH \
      -u DYLD_FALLBACK_FRAMEWORK_PATH \
      -u DYLD_IMAGE_SUFFIX \
      -u DYLD_PRINT_TO_FILE \
      -u DYLD_ROOT_PATH \
      -u DYLD_SHARED_REGION \
      -u DYLD_VERSIONED_FRAMEWORK_PATH \
      -u DYLD_VERSIONED_LIBRARY_PATH \
      "$helper" "$@"
  fi
}

if [[ "${1:-}" == "--" ]]; then
  shift
fi

prepare_bundle_dir=""
verify_bundle_dir=""
verify_expected_manifest=""
feedback_pr=""
forward_args=()
prepare_staging_dir=""
prepare_staging_identity=""
direct_helper_runtime_dir=""
direct_helper_runtime_identity=""

cleanup_prepare_staging() {
  if [[ -n "$prepare_staging_dir" ]]; then
    if [[ ! -e "$prepare_staging_dir" && ! -L "$prepare_staging_dir" ]]; then
      :
    elif [[ "$untrusted_helper_exposed" -eq 1 ]]; then
      echo "agent:autoreview: leaving failed prepared-bundle staging directory because an explicit helper may have surviving same-UID writers: $prepare_staging_dir" >&2
    elif ! safe_remove_tree \
      "$prepare_staging_dir" \
      "$prepare_staging_identity" \
      "prepared-bundle staging"; then
      echo "agent:autoreview: leaving failed prepared-bundle staging directory for identity-safe cleanup: $prepare_staging_dir" >&2
    fi
  fi
  if [[ -n "$direct_helper_runtime_dir" ]]; then
    safe_remove_tree \
      "$direct_helper_runtime_dir" \
      "$direct_helper_runtime_identity" \
      "direct helper runtime" || true
  fi
}

cleanup_autoreview_runtime() {
  local status=$?
  trap - EXIT
  cleanup_prepare_staging
  cleanup_command_runtime
  exit "$status"
}

trap cleanup_autoreview_runtime EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prepare-bundle-dir)
      if [[ $# -lt 2 ]]; then
        echo "agent:autoreview: $1 requires a directory argument" >&2
        exit 2
      fi
      if [[ -z "$2" ]]; then
        echo "agent:autoreview: $1 requires a non-empty directory argument" >&2
        exit 2
      fi
      prepare_bundle_dir="$2"
      shift 2
      ;;
    --verify-bundle-dir)
      if [[ $# -lt 2 ]]; then
        echo "agent:autoreview: $1 requires a directory argument" >&2
        exit 2
      fi
      if [[ -z "$2" ]]; then
        echo "agent:autoreview: $1 requires a non-empty directory argument" >&2
        exit 2
      fi
      verify_bundle_dir="$2"
      shift 2
      ;;
    --expected-bundle-manifest)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "agent:autoreview: $1 requires a SHA-256 manifest digest" >&2
        exit 2
      fi
      verify_expected_manifest="$2"
      shift 2
      ;;
    --feedback-pr)
      if [[ $# -lt 2 ]]; then
        echo "agent:autoreview: --feedback-pr requires a PR number or 'auto'" >&2
        exit 2
      fi
      feedback_pr="$2"
      shift 2
      ;;
    --)
      shift
      forward_args+=("$@")
      break
      ;;
    *)
      forward_args+=("$1")
      shift
      ;;
  esac
done

set -- "${forward_args[@]+"${forward_args[@]}"}"

if [[ -n "$feedback_pr" && -z "$prepare_bundle_dir" ]]; then
  echo "agent:autoreview: --feedback-pr requires --prepare-bundle-dir" >&2
  exit 2
fi
if [[ -n "$verify_expected_manifest" && -z "$verify_bundle_dir" ]]; then
  echo "agent:autoreview: --expected-bundle-manifest requires --verify-bundle-dir" >&2
  exit 2
fi
if [[
  -n "$verify_expected_manifest" &&
    ! "$verify_expected_manifest" =~ ^[0-9a-f]{64}$
]]; then
  echo "agent:autoreview: --expected-bundle-manifest must be a lowercase SHA-256 digest" >&2
  exit 2
fi
if [[ -n "$verify_bundle_dir" && ( -n "$prepare_bundle_dir" || -n "$feedback_pr" || $# -gt 0 ) ]]; then
  echo "agent:autoreview: --verify-bundle-dir cannot be combined with review or bundle-preparation arguments" >&2
  exit 2
fi

running_inside_codex_sandbox() {
  [[ -n "${CODEX_SANDBOX:-}" || -n "${CODEX_THREAD_ID:-}" ]]
}

has_explicit_engine() {
  if [[ -n "${AUTOREVIEW_ENGINE:-}" ]]; then
    return 0
  fi

  local arg
  for arg in "$@"; do
    case "$arg" in
      --engine | --engine=*)
        return 0
        ;;
    esac
  done

  return 1
}

has_prepare_only() {
  local arg
  for arg in "$@"; do
    if [[ "$arg" == "--prepare-only" ]]; then
      return 0
    fi
  done

  return 1
}

has_bundle_output() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --bundle-output | --bundle-output=*)
        return 0
        ;;
    esac
  done

  return 1
}

has_dry_run() {
  local arg
  for arg in "$@"; do
    if [[ "$arg" == "--dry-run" ]]; then
      return 0
    fi
  done
  return 1
}

arg_value() {
  local flag="$1"
  local default_value="$2"
  shift 2

  while [[ $# -gt 0 ]]; do
    case "$1" in
      "$flag")
        if [[ $# -ge 2 ]]; then
          printf '%s\n' "$2"
          return 0
        fi
        ;;
      "$flag="*)
        printf '%s\n' "${1#*=}"
        return 0
        ;;
    esac
    shift
  done

  printf '%s\n' "$default_value"
}

detect_unique_pr_record() {
  local repo="$1"
  local branch="$2"
  local gh_bin
  local lookup
  local count
  local values
  local base_ref
  local pr_number
  local head_repository_owner
  local repository_owner
  local repository_slug

  if [[ -z "$branch" ]]; then
    return 0
  fi

  gh_bin="$(resolve_external_command gh || true)"
  if [[ -z "$gh_bin" ]]; then
    return 0
  fi
  if ! repository_slug="$(github_repository_slug "$repo")"; then
    echo "agent:autoreview: automatic PR lookup requires a canonical github.com origin remote" >&2
    return 1
  fi

  if ! lookup="$(
    cd "$repo" &&
      unset GH_HOST GH_REPO &&
      GH_PAGER=cat GH_PROMPT_DISABLED=1 run_trusted_external "$gh_bin" pr list \
        --repo "$repository_slug" \
        --head "$branch" \
        --state open \
        --limit 2 \
        --json baseRefName,headRepositoryOwner,number \
        --jq 'length, .[].baseRefName, .[].number, .[].headRepositoryOwner.login'
  )"; then
    echo "agent:autoreview: failed to inspect PR metadata for head branch $branch" >&2
    return 1
  fi

  count="${lookup%%$'\n'*}"
  case "$count" in
    0)
      if [[ "$lookup" != "0" ]]; then
        echo "agent:autoreview: failed to inspect PR metadata: gh returned malformed output" >&2
        return 1
      fi
      return 0
      ;;
    1)
      if [[ "$lookup" != *$'\n'* ]]; then
        echo "agent:autoreview: failed to inspect PR metadata: gh omitted the base, number, and head owner" >&2
        return 1
      fi
      values="${lookup#*$'\n'}"
      if [[ "$values" != *$'\n'* ]]; then
        echo "agent:autoreview: failed to inspect PR metadata: gh omitted the PR number" >&2
        return 1
      fi
      base_ref="${values%%$'\n'*}"
      values="${values#*$'\n'}"
      if [[ "$values" != *$'\n'* ]]; then
        echo "agent:autoreview: failed to inspect PR metadata: gh omitted the head repository owner" >&2
        return 1
      fi
      pr_number="${values%%$'\n'*}"
      head_repository_owner="${values#*$'\n'}"
      if [[
        -z "$base_ref" ||
          -z "$pr_number" ||
          ! "$pr_number" =~ ^[0-9]+$ ||
          -z "$head_repository_owner" ||
          "$head_repository_owner" == *$'\n'*
      ]]; then
        echo "agent:autoreview: failed to inspect PR metadata: gh returned malformed base, number, or head owner" >&2
        return 1
      fi
      if ! repository_owner="$(
        cd "$repo" &&
          unset GH_HOST GH_REPO &&
          GH_PAGER=cat GH_PROMPT_DISABLED=1 run_trusted_external "$gh_bin" repo view \
            "$repository_slug" \
            --json owner \
            --jq '.owner.login'
      )"; then
        echo "agent:autoreview: failed to inspect repository owner" >&2
        return 1
      fi
      if [[ -z "$repository_owner" || "$repository_owner" == *$'\n'* ]]; then
        echo "agent:autoreview: failed to inspect repository owner: gh returned malformed output" >&2
        return 1
      fi
      if [[ "$head_repository_owner" != "$repository_owner" ]]; then
        echo "agent:autoreview: open PR for head branch $branch is not owned by $repository_owner; pass --base and --feedback-pr explicitly" >&2
        return 1
      fi
      printf '%s\t%s\t%s\n' "$base_ref" "$pr_number" "$repository_slug"
      ;;
    2)
      echo "agent:autoreview: multiple open PRs match head branch $branch; pass --base and --feedback-pr explicitly" >&2
      return 1
      ;;
    *)
      echo "agent:autoreview: failed to inspect PR metadata: gh returned malformed output" >&2
      return 1
      ;;
  esac
}

branch_base_ref() {
  local detected_base="$1"
  shift
  local base_ref
  base_ref="$(arg_value --base "" "$@")"
  if [[ -z "$base_ref" && -n "$detected_base" ]]; then
    base_ref="origin/$detected_base"
  fi
  printf '%s\n' "${base_ref:-origin/main}"
}

git_output() {
  local repo="$1"
  shift
  (
    unset \
      GIT_ALTERNATE_OBJECT_DIRECTORIES \
      GIT_CEILING_DIRECTORIES \
      GIT_COMMON_DIR \
      GIT_CONFIG \
      GIT_CONFIG_PARAMETERS \
      GIT_DIR \
      GIT_DISCOVERY_ACROSS_FILESYSTEM \
      GIT_INDEX_FILE \
      GIT_NAMESPACE \
      GIT_OBJECT_DIRECTORY \
      GIT_SSH \
      GIT_SSH_COMMAND \
      GIT_WORK_TREE
    export GIT_CONFIG_COUNT=0
    export GIT_CONFIG_GLOBAL=/dev/null
    export GIT_CONFIG_NOSYSTEM=1
    export GIT_CONFIG_SYSTEM=/dev/null
    export GIT_EXTERNAL_DIFF=""
    export GIT_NO_REPLACE_OBJECTS=1
    export GIT_OPTIONAL_LOCKS=0
    export GIT_PAGER=cat
    export GIT_TERMINAL_PROMPT=0
    export PAGER=cat
    run_trusted_external "$git_bin" \
      -c core.fsmonitor=false \
      -c core.quotePath=false \
      -c diff.renames=false \
      -C "$repo" \
      "$@"
  )
}

github_repository_slug() {
  local repo="$1"
  local remote_url
  local slug
  remote_url="$(git_output "$repo" config --get remote.origin.url)" || return 1
  case "$remote_url" in
    https://github.com/*)
      slug="${remote_url#https://github.com/}"
      ;;
    git@github.com:*)
      slug="${remote_url#git@github.com:}"
      ;;
    ssh://git@github.com/*)
      slug="${remote_url#ssh://git@github.com/}"
      ;;
    *)
      return 1
      ;;
  esac
  slug="${slug%.git}"
  slug="${slug%/}"
  if [[ ! "$slug" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    return 1
  fi
  printf '%s\n' "$slug"
}

git_blob_mode() {
  local repo="$1"
  local snapshot_ref="$2"
  local relative_path="$3"
  local entry
  if ! entry="$(git_output "$repo" ls-tree "$snapshot_ref" -- "$relative_path")"; then
    return 1
  fi
  if [[
    -z "$entry" ||
      "$entry" == *$'\n'* ||
      "$entry" != *$'\t'"$relative_path"
  ]]; then
    return 1
  fi
  printf '%s\n' "${entry%% *}"
}

verify_current_wrapper_matches_ref() {
  local repo="$1"
  local snapshot_ref="$2"
  local relative_path="scripts/agent-autoreview.sh"
  local current_path="$repo/$relative_path"
  local mode
  local current_mode
  local expected_oid
  local current_oid
  if ! mode="$(git_blob_mode "$repo" "$snapshot_ref" "$relative_path")" ||
    [[ "$mode" != "100644" && "$mode" != "100755" ]]; then
    echo "agent:autoreview: trusted wrapper is not a regular Git blob at $snapshot_ref" >&2
    return 1
  fi
  if [[ ! -f "$current_path" || -L "$current_path" ]]; then
    echo "agent:autoreview: current autoreview wrapper must be a regular file" >&2
    return 1
  fi
  if ! current_mode="$(
    run_trusted_node -e '
      const fs = require("node:fs");
      const stat = fs.lstatSync(process.argv[1]);
      if (!stat.isFile() || stat.isSymbolicLink()) process.exit(1);
      process.stdout.write((stat.mode & 0o111) === 0 ? "100644\n" : "100755\n");
    ' "$current_path"
  )" ||
    [[ "$current_mode" != "$mode" ]]; then
    echo "agent:autoreview: current autoreview wrapper mode does not match frozen HEAD" >&2
    return 1
  fi
  if ! expected_oid="$(
    git_output "$repo" rev-parse --verify --end-of-options \
      "${snapshot_ref}:${relative_path}"
  )" ||
    ! current_oid="$(
      git_output "$repo" hash-object --no-filters -- "$relative_path"
    )" ||
    [[ "$current_oid" != "$expected_oid" ]]; then
    echo "agent:autoreview: explicit branch/commit review requires scripts/agent-autoreview.sh to match frozen HEAD" >&2
    return 1
  fi
}

verify_current_helper_matches_ref() {
  local repo="$1"
  local snapshot_ref="$2"
  local relative_path
  local current_path
  local mode
  local current_mode
  local expected_oid
  local current_oid
  local helper_paths=(
    scripts/agent-autoreview.mjs
    scripts/agent-autoreview-core.mjs
  )

  for relative_path in "${helper_paths[@]}"; do
    current_path="$repo/$relative_path"
    if ! mode="$(git_blob_mode "$repo" "$snapshot_ref" "$relative_path")" ||
      [[ "$mode" != "100644" && "$mode" != "100755" ]]; then
      echo "agent:autoreview: frozen helper is not a regular Git blob: $relative_path" >&2
      return 1
    fi
    if [[ ! -f "$current_path" || -L "$current_path" ]]; then
      echo "agent:autoreview: current helper must be a regular file: $relative_path" >&2
      return 1
    fi
    if ! current_mode="$(
      run_trusted_node -e '
        const fs = require("node:fs");
        const stat = fs.lstatSync(process.argv[1]);
        if (!stat.isFile() || stat.isSymbolicLink()) process.exit(1);
        process.stdout.write((stat.mode & 0o111) === 0 ? "100644\n" : "100755\n");
      ' "$current_path"
    )" ||
      [[ "$current_mode" != "$mode" ]] ||
      ! expected_oid="$(
        git_output "$repo" rev-parse --verify --end-of-options \
          "${snapshot_ref}:${relative_path}"
      )" ||
      ! current_oid="$(
        git_output "$repo" hash-object --no-filters -- "$relative_path"
      )" ||
      [[ "$current_oid" != "$expected_oid" ]]; then
      cat >&2 <<EOF
agent:autoreview: local review target changes executable autoreview runtime: $relative_path
Prepare this self-review from a separate trusted checkout with an explicit compatible AUTOREVIEW_HELPER.
EOF
      return 1
    fi
  done
}

verify_autoreview_runtime_matches_baseline() {
  local repo="$1"
  local baseline_ref="$2"
  local candidate_ref="$3"
  local relative_path
  local baseline_mode
  local candidate_mode
  local baseline_oid
  local candidate_oid
  local runtime_paths=(
    scripts/agent-autoreview.sh
    scripts/agent-autoreview.mjs
    scripts/agent-autoreview-core.mjs
  )

  for relative_path in "${runtime_paths[@]}"; do
    if ! baseline_mode="$(git_blob_mode "$repo" "$baseline_ref" "$relative_path")" ||
      ! candidate_mode="$(git_blob_mode "$repo" "$candidate_ref" "$relative_path")" ||
      [[
        ( "$baseline_mode" != "100644" && "$baseline_mode" != "100755" ) ||
          ( "$candidate_mode" != "100644" && "$candidate_mode" != "100755" )
      ]] ||
      ! baseline_oid="$(
        git_output "$repo" rev-parse --verify --end-of-options \
          "${baseline_ref}:${relative_path}"
      )" ||
      ! candidate_oid="$(
        git_output "$repo" rev-parse --verify --end-of-options \
          "${candidate_ref}:${relative_path}"
      )" ||
      [[
        "$baseline_mode" != "$candidate_mode" ||
          "$baseline_oid" != "$candidate_oid"
      ]]; then
      cat >&2 <<EOF
agent:autoreview: executable autoreview runtime differs from its trusted pre-change snapshot: $relative_path
Review the runtime change from a separate trusted checkout with an explicit compatible AUTOREVIEW_HELPER.
EOF
      return 1
    fi
  done
}

materialize_trusted_autoreview_runtime() {
  local repo="$1"
  local snapshot_ref="$2"
  local runtime_dir="$3"
  local relative_path
  local output_path
  local mode
  local sealed_mode
  local size
  local size_value
  local expected_oid
  local materialized_oid
  local total_size=0
  local max_runtime_bytes=2097152
  local runtime_paths=(
    scripts/agent-autoreview.mjs
    scripts/agent-autoreview-core.mjs
  )

  for relative_path in "${runtime_paths[@]}"; do
    if ! mode="$(git_blob_mode "$repo" "$snapshot_ref" "$relative_path")" ||
      [[ "$mode" != "100644" && "$mode" != "100755" ]]; then
      echo "agent:autoreview: trusted helper runtime is not a regular Git blob: $relative_path" >&2
      return 1
    fi
    if ! size="$(
      git_output "$repo" cat-file -s "${snapshot_ref}:${relative_path}"
    )" ||
      [[ ! "$size" =~ ^[0-9]+$ ]]; then
      echo "agent:autoreview: trusted helper runtime is missing $relative_path at $snapshot_ref" >&2
      return 1
    fi
    if [[ "${#size}" -gt "${#max_runtime_bytes}" ]]; then
      echo "agent:autoreview: trusted helper runtime exceeds the ${max_runtime_bytes}-byte aggregate limit" >&2
      return 1
    fi
    size_value=$((10#$size))
    if ((size_value > max_runtime_bytes - total_size)); then
      echo "agent:autoreview: trusted helper runtime exceeds the ${max_runtime_bytes}-byte aggregate limit" >&2
      return 1
    fi
    total_size=$((total_size + size_value))
  done

  mkdir -p "$runtime_dir/scripts"
  /bin/chmod 0700 "$runtime_dir/scripts"
  for relative_path in "${runtime_paths[@]}"; do
    output_path="$runtime_dir/$relative_path"
    if ! git_output "$repo" cat-file blob \
      "${snapshot_ref}:${relative_path}" >"$output_path"; then
      echo "agent:autoreview: failed to materialize trusted helper runtime file: $relative_path" >&2
      return 1
    fi
    if [[ "$relative_path" == "scripts/agent-autoreview.mjs" ]]; then
      sealed_mode=0700
    else
      sealed_mode=0600
    fi
    /bin/chmod "$sealed_mode" "$output_path"
    # The embedded Perl program is intentionally literal.
    # shellcheck disable=SC2016
    if ! expected_oid="$(
      git_output "$repo" rev-parse --verify --end-of-options \
        "${snapshot_ref}:${relative_path}"
    )" ||
      ! materialized_oid="$(
        git_output "$repo" hash-object --no-filters -- "$output_path"
      )" ||
      [[ "$materialized_oid" != "$expected_oid" ]] ||
      ! system_perl -MFcntl=:mode -MFile::Basename=dirname -e '
        use strict;
        use warnings;
        my ($path, $euid, $expected_mode) = @ARGV;
        my $parent = dirname($path);
        my @parent_stat = lstat($parent);
        exit 1 if !@parent_stat ||
          !S_ISDIR($parent_stat[2]) ||
          S_ISLNK($parent_stat[2]) ||
          $parent_stat[4] != $euid ||
          ($parent_stat[2] & 0077);
        my @file_stat = lstat($path);
        exit 1 if !@file_stat ||
          !S_ISREG($file_stat[2]) ||
          S_ISLNK($file_stat[2]) ||
          $file_stat[3] != 1 ||
          $file_stat[4] != $euid ||
          ($file_stat[2] & 07777) != oct($expected_mode);
      ' "$output_path" "$EUID" "$sealed_mode"; then
      echo "agent:autoreview: failed to validate trusted helper runtime file: $relative_path" >&2
      return 1
    fi
  done
}

wrapper_runtime_source_snapshot() {
  local source_scripts_dir="$1"
  # shellcheck disable=SC2016
  system_perl -MFcntl=:mode -MFile::Basename=dirname -e '
    use strict;
    use warnings;
    my ($source_dir, $euid) = @ARGV;
    exit 1 if $source_dir !~ m{^/} || $source_dir =~ /[\r\n\0]/;
    my $current = $source_dir;
    while (1) {
      my @stat = lstat($current);
      exit 1 if !@stat || !S_ISDIR($stat[2]) || S_ISLNK($stat[2]);
      exit 1 if $stat[4] != 0 && $stat[4] != $euid;
      my $shared_writable = ($stat[2] & 0022) != 0;
      my $sticky = ($stat[2] & 01000) != 0;
      exit 1 if $shared_writable && !$sticky;
      # Shared sticky ancestors can legitimately gain unrelated entries while
      # this wrapper runs. Bind their identity, ownership, and mode without
      # treating ambient directory size/time churn as source substitution.
      print join(":", "directory", @stat[0, 1, 2, 4]), "\n";
      my $parent = dirname($current);
      last if $parent eq $current;
      $current = $parent;
    }
    for my $name ("agent-autoreview.mjs", "agent-autoreview-core.mjs") {
      my @stat = lstat("$source_dir/$name");
      exit 1 if !@stat ||
        !S_ISREG($stat[2]) ||
        S_ISLNK($stat[2]) ||
        $stat[3] != 1 ||
        ($stat[4] != 0 && $stat[4] != $euid) ||
        ($stat[2] & 0022);
      print join(":", "file", @stat[0, 1, 2, 3, 4, 7, 9, 10]), "\n";
    }
  ' "$source_scripts_dir" "$EUID"
}

wrapper_runtime_source_acl_is_trusted() {
  local source_scripts_dir="$1"
  local current="$source_scripts_dir"
  local parent
  local source_file
  for source_file in \
    "$source_scripts_dir/agent-autoreview.mjs" \
    "$source_scripts_dir/agent-autoreview-core.mjs"; do
    path_acl_is_trusted "$source_file" || return 1
  done
  while true; do
    path_acl_is_trusted "$current" || return 1
    [[ "$current" != "/" ]] || break
    parent="${current%/*}"
    [[ -n "$parent" ]] || parent="/"
    current="$parent"
  done
}

materialize_filesystem_autoreview_runtime() {
  local source_scripts_dir="$1"
  local runtime_dir="$2"
  mkdir "$runtime_dir/scripts"
  /bin/chmod 0700 "$runtime_dir/scripts"
  # Copy the wrapper sibling runtime before an explicit helper can run. Each
  # source is opened no-follow and revalidated after the private copy closes.
  # shellcheck disable=SC2016
  system_perl -MFcntl=:DEFAULT,:mode,O_DIRECTORY,O_NOFOLLOW -e '
    use strict;
    use warnings;

    my ($source_dir, $runtime_dir, $euid) = @ARGV;
    my @names = (
      "agent-autoreview.mjs",
      "agent-autoreview-core.mjs",
    );
    my $aggregate = 0;
    my $aggregate_limit = 2 * 1024 * 1024;
    sysopen(my $source_dir_fh, $source_dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
      or die "cannot pin wrapper runtime source directory: $source_dir: $!";
    my @source_dir_before = stat($source_dir_fh);
    die "unsafe wrapper runtime source directory: $source_dir"
      if !@source_dir_before ||
        !S_ISDIR($source_dir_before[2]) ||
        ($source_dir_before[4] != 0 && $source_dir_before[4] != $euid) ||
        ($source_dir_before[2] & 0022);
    chdir($source_dir_fh)
      or die "cannot enter pinned wrapper runtime source directory: $source_dir: $!";
    for my $name (@names) {
      my $source = "$source_dir/$name";
      my $destination = "$runtime_dir/scripts/$name";
      sysopen(my $input, $name, O_RDONLY | O_NOFOLLOW)
        or die "cannot open wrapper runtime source: $source: $!";
      binmode($input);
      my @before = stat($input);
      die "unsafe wrapper runtime source: $source"
        if !@before ||
          !S_ISREG($before[2]) ||
          $before[3] != 1 ||
          ($before[4] != 0 && $before[4] != $euid) ||
          ($before[2] & 0022);
      $aggregate += $before[7];
      die "wrapper runtime exceeds aggregate size limit"
        if $aggregate > $aggregate_limit;
      my $mode = $name eq "agent-autoreview.mjs" ? 0500 : 0400;
      sysopen(
        my $output,
        $destination,
        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
        0600,
      ) or die "cannot create wrapper runtime snapshot: $destination: $!";
      binmode($output);
      my $buffer;
      while (1) {
        my $read = sysread($input, $buffer, 65536);
        die "cannot read wrapper runtime source: $source: $!"
          if !defined($read);
        last if $read == 0;
        my $offset = 0;
        while ($offset < $read) {
          my $written = syswrite(
            $output,
            $buffer,
            $read - $offset,
            $offset,
          );
          die "cannot write wrapper runtime snapshot: $destination: $!"
            if !defined($written) || $written == 0;
          $offset += $written;
        }
      }
      chmod($mode, $output) == 1
        or die "cannot seal wrapper runtime snapshot: $destination: $!";
      close($output)
        or die "cannot close wrapper runtime snapshot: $destination: $!";
      my @after = stat($input);
      die "wrapper runtime source changed while copying: $source"
        if !@after;
      for my $index (0, 1, 2, 3, 4, 7, 9, 10) {
        die "wrapper runtime source changed while copying: $source"
          if $before[$index] != $after[$index];
      }
      close($input)
        or die "cannot close wrapper runtime source: $source: $!";
      my @published = lstat($destination);
      die "invalid wrapper runtime snapshot: $destination"
        if !@published ||
          !S_ISREG($published[2]) ||
          S_ISLNK($published[2]) ||
          $published[3] != 1 ||
          $published[4] != $euid ||
          ($published[2] & 07777) != $mode ||
          $published[7] != $before[7];
    }
    my @source_dir_after = stat($source_dir_fh);
    my @source_dir_path = lstat($source_dir);
    die "wrapper runtime source directory changed while copying: $source_dir"
      if !@source_dir_after || !@source_dir_path;
    for my $index (0, 1, 2, 3, 4, 7, 9, 10) {
      die "wrapper runtime source directory changed while copying: $source_dir"
        if $source_dir_before[$index] != $source_dir_after[$index] ||
          $source_dir_before[$index] != $source_dir_path[$index];
    }
    close($source_dir_fh)
      or die "cannot close wrapper runtime source directory: $source_dir: $!";
  ' "$source_scripts_dir" "$runtime_dir" "$EUID"
}

materialize_feedback_runtime() {
  local repo="$1"
  local snapshot_ref="$2"
  local runtime_dir="$3"
  local relative_path
  local output_path
  local mode
  local size
  local size_value
  local total_size=0
  local max_runtime_bytes=2097152
  local runtime_paths=(
    scripts/pr-feedback-state.mjs \
    scripts/pr-feedback-state-core.mjs \
    scripts/pr-ready-state.mjs \
    scripts/pr-ready-state-core.mjs \
    scripts/pr-ready-state-format.mjs
  )

  for relative_path in "${runtime_paths[@]}"; do
    if ! mode="$(git_blob_mode "$repo" "$snapshot_ref" "$relative_path")" ||
      [[ "$mode" != "100644" && "$mode" != "100755" ]]; then
      echo "agent:autoreview: trusted feedback runtime is not a regular Git blob: $relative_path" >&2
      return 1
    fi
    if ! size="$(
      git_output "$repo" cat-file -s "${snapshot_ref}:${relative_path}"
    )" ||
      [[ ! "$size" =~ ^[0-9]+$ ]]; then
      echo "agent:autoreview: trusted feedback runtime is missing $relative_path at $snapshot_ref" >&2
      return 1
    fi
    if [[ "${#size}" -gt "${#max_runtime_bytes}" ]]; then
      echo "agent:autoreview: trusted feedback runtime exceeds the ${max_runtime_bytes}-byte aggregate limit" >&2
      return 1
    fi
    size_value=$((10#$size))
    if ((size_value > max_runtime_bytes - total_size)); then
      echo "agent:autoreview: trusted feedback runtime exceeds the ${max_runtime_bytes}-byte aggregate limit" >&2
      return 1
    fi
    total_size=$((total_size + size_value))
  done

  mkdir -p "$runtime_dir/scripts"
  for relative_path in "${runtime_paths[@]}"; do
    output_path="$runtime_dir/$relative_path"
    if ! git_output "$repo" cat-file blob "${snapshot_ref}:${relative_path}" >"$output_path"; then
      echo "agent:autoreview: trusted feedback runtime is missing $relative_path at $snapshot_ref" >&2
      return 1
    fi
  done
}

pin_protected_main_ref() {
  local repo="$1"
  local protected_ref
  if ! protected_ref="$(
    git_output "$repo" rev-parse --verify --end-of-options \
      "origin/main^{commit}"
  )"; then
    echo "agent:autoreview: protected policy/runtime baseline is unavailable: origin/main" >&2
    return 1
  fi
  if [[ ! "$protected_ref" =~ ^[0-9a-fA-F]{40,64}$ ]]; then
    echo "agent:autoreview: protected policy/runtime baseline did not resolve to an object ID: origin/main" >&2
    return 1
  fi
  printf '%s\n' "$protected_ref"
}

capture_feedback_state() {
  local repo="$1"
  local runtime_dir="$2"
  local pr_number="$3"
  local repository_slug="$4"
  local gh_bin
  local trusted_bin="$runtime_dir/trusted-bin"
  local env_args=()
  gh_bin="$(resolve_external_command gh || true)"
  if [[ -z "$gh_bin" ]]; then
    echo "agent:autoreview: PR feedback capture requires a trusted gh executable" >&2
    return 127
  fi
  resolved_command_is_trusted "$gh_bin" || {
    echo "agent:autoreview: resolved gh executable changed before feedback capture" >&2
    return 127
  }
  resolved_command_is_trusted "$node_bin" || {
    echo "agent:autoreview: resolved node executable changed before feedback capture" >&2
    return 127
  }
  mkdir "$trusted_bin"
  ln -s "$gh_bin" "$trusted_bin/gh"
  env_args=(
    "PATH=$trusted_bin:/usr/bin:/bin:/usr/sbin:/sbin"
    "HOME=$HOME"
    "TMPDIR=${TMPDIR:-/tmp}"
    "GH_PAGER=cat"
    "GH_PROMPT_DISABLED=1"
  )
  if [[ -n "${GH_TOKEN:-}" ]]; then
    env_args+=("GH_TOKEN=$GH_TOKEN")
  fi
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    env_args+=("GITHUB_TOKEN=$GITHUB_TOKEN")
  fi
  (
    cd "$repo"
    run_trusted_node_in_clean_env \
      "${#env_args[@]}" \
      "${env_args[@]}" \
      "$runtime_dir/scripts/pr-feedback-state.mjs" \
      --pr "$pr_number" \
      --repo "$repository_slug" \
      --json
  )
}

target_selection_snapshot() {
  local repo="$1"
  git_output "$repo" status \
    --porcelain=v2 \
    --branch \
    --no-ahead-behind \
    --untracked-files=normal
}

parse_target_selection_state() {
  local state="$1"
  local line
  local branch_oid=""
  local branch_head=""
  local dirty=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "# branch.oid "*)
        if [[ -n "$branch_oid" ]]; then
          echo "agent:autoreview: git status returned duplicate branch.oid metadata" >&2
          return 1
        fi
        branch_oid="${line#\# branch.oid }"
        ;;
      "# branch.head "*)
        if [[ -n "$branch_head" ]]; then
          echo "agent:autoreview: git status returned duplicate branch.head metadata" >&2
          return 1
        fi
        branch_head="${line#\# branch.head }"
        ;;
      "# "*)
        ;;
      *)
        [[ -n "$line" ]] && dirty=1
        ;;
    esac
  done <<<"$state"
  if [[ ! "$branch_oid" =~ ^[0-9a-fA-F]{40,64}$ ]]; then
    echo "agent:autoreview: git status omitted a valid branch.oid" >&2
    return 1
  fi
  if [[ -z "$branch_head" ]]; then
    echo "agent:autoreview: git status omitted branch.head" >&2
    return 1
  fi
  frozen_head_oid="$branch_oid"
  if [[ "$branch_head" == "(detached)" ]]; then
    frozen_branch=""
  else
    frozen_branch="$branch_head"
  fi
  frozen_dirty="$dirty"
}

source_snapshot() {
  local repo="$1"
  local target_mode="$2"
  local snapshot
  local snapshot_args=(--source-snapshot-only)
  case "$target_mode" in
    local | branch-local)
      snapshot_args+=(--mode local)
      ;;
    branch | commit)
      snapshot_args+=(--mode "$target_mode")
      ;;
    *)
      echo "agent:autoreview: unsupported source snapshot target: $target_mode" >&2
      return 2
      ;;
  esac
  if ! snapshot="$(cd "$repo" && run_attested_helper "${snapshot_args[@]}")"; then
    echo "agent:autoreview: wrapper-attested helper could not fingerprint the prepared-bundle source" >&2
    return 1
  fi
  if [[ ! "$snapshot" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "agent:autoreview: wrapper-attested helper source fingerprint must be exactly one SHA-256 digest" >&2
    return 1
  fi
  printf '%s\n' "$snapshot"
}

path_identity() {
  # The single-quoted string is JavaScript source, not shell interpolation.
  # shellcheck disable=SC2016
  run_trusted_node -e '
    const fs = require("node:fs");
    const stat = fs.lstatSync(process.argv[1], { bigint: true });
    process.stdout.write(`${stat.dev}:${stat.ino}\n`);
  ' "$1"
}

assert_bundle_ancestry_acl_trusted() {
  local current="$1"
  local ancestor
  while true; do
    if ! path_acl_is_trusted "$current"; then
      echo "agent:autoreview: unsafe prepared-bundle parent ACL: $current" >&2
      return 1
    fi
    [[ "$current" != "/" ]] || break
    ancestor="${current%/*}"
    [[ -n "$ancestor" ]] || ancestor="/"
    current="$ancestor"
  done
}

assert_safe_bundle_parent_ancestry() {
  local bundle_parent="$1"
  # A sticky, root-owned shared directory such as /tmp is safe because another
  # unprivileged UID cannot replace this user's children. Every other ancestor
  # must be private against group/other writers, and an attacker-owned sticky
  # directory is never trusted.
  assert_bundle_ancestry_acl_trusted "$bundle_parent" || return 1
  # The single-quoted string is JavaScript source, not shell interpolation.
  # shellcheck disable=SC2016
  if ! run_trusted_node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const parent = process.argv[1];
    const euid = BigInt(process.geteuid());
    let current = parent;
    for (;;) {
      const stat = fs.lstatSync(current, { bigint: true });
      const mode = stat.mode & 0o7777n;
      const ownerIsTrusted = stat.uid === euid || stat.uid === 0n;
      const sharedWritable = (mode & 0o022n) !== 0n;
      const sticky = (mode & 0o1000n) !== 0n;
      if (
        fs.realpathSync(current) !== current ||
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !ownerIsTrusted ||
        (sharedWritable && !sticky)
      ) {
        console.error(
          `agent:autoreview: unsafe prepared-bundle parent ancestor: ${current}`,
        );
        process.exit(1);
      }
      const ancestor = path.dirname(current);
      if (ancestor === current) break;
      current = ancestor;
    }
  ' "$bundle_parent"; then
    return 1
  fi
  assert_bundle_ancestry_acl_trusted "$bundle_parent"
}

assert_bundle_tree_acl_trusted() {
  local root="$1"
  local expected_root_identity="$2"
  [[ "$(/usr/bin/uname -s)" == "Darwin" ]] || return 0
  # macOS exposes NFSv4-style ACLs through ls rather than Node fs.stat. Walk
  # every entry from a pinned root and reject write-granting allow entries.
  # shellcheck disable=SC2016
  run_trusted_node -e '
    const { execFileSync } = require("node:child_process");
    const fs = require("node:fs");
    const path = require("node:path");
    const [root, expectedRootIdentity] = process.argv.slice(1);
    const statIdentity = (stat) => `${stat.dev}:${stat.ino}`;
    const assertRoot = () => {
      const stat = fs.lstatSync(root, { bigint: true });
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        statIdentity(stat) !== expectedRootIdentity
      ) {
        throw new Error("prepared-bundle staging identity changed");
      }
    };
    const forbidden =
      /(?:^|[,\s])(write|append|add_file|add_subdirectory|delete|delete_child|writeattr|writeextattr|writesecurity|chown)(?:,|\s|$)/;
    const hasUnsafeAcl = (output) =>
      output
        .split(/\r?\n/)
        .some(
          (line) =>
            /^\s*\d+:\s+.*\sallow\s/.test(line) && forbidden.test(line),
        );
    const readAcls = (candidates) =>
      execFileSync("/bin/ls", ["-lde", ...candidates], {
        encoding: "utf8",
        env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
        maxBuffer: 8 * 1024 * 1024,
      });
    const assertAclBatch = (entries) => {
      let chunk = [];
      let chunkBytes = 0;
      const flush = () => {
        if (chunk.length === 0) return;
        if (hasUnsafeAcl(readAcls(chunk))) {
          for (const candidate of chunk) {
            if (hasUnsafeAcl(readAcls([candidate]))) {
              throw new Error(
                `unsafe prepared-bundle ACL grants write access: ${candidate}`,
              );
            }
          }
          throw new Error(
            "unsafe prepared-bundle ACL grants write access",
          );
        }
        chunk = [];
        chunkBytes = 0;
      };
      for (const { candidate } of entries) {
        const candidateBytes = Buffer.byteLength(candidate) + 1;
        if (chunk.length >= 128 || chunkBytes + candidateBytes > 64 * 1024) {
          flush();
        }
        chunk.push(candidate);
        chunkBytes += candidateBytes;
      }
      flush();
    };
    const entries = [];
    const visit = (candidate) => {
      assertRoot();
      const stat = fs.lstatSync(candidate, { bigint: true });
      if (stat.isSymbolicLink()) {
        throw new Error(`prepared-bundle ACL scan refuses symlink: ${candidate}`);
      }
      if (!stat.isDirectory() && !stat.isFile()) {
        throw new Error(`prepared-bundle ACL scan refuses special file: ${candidate}`);
      }
      entries.push({
        candidate,
        identity: statIdentity(stat),
        isDirectory: stat.isDirectory(),
        mode: stat.mode,
        size: stat.size,
        nlink: stat.nlink,
        mtimeNs: stat.mtimeNs,
        ctimeNs: stat.ctimeNs,
      });
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(candidate).sort()) {
          visit(path.join(candidate, name));
        }
      }
      assertRoot();
    };
    const assertEntriesUnchanged = () => {
      for (const entry of entries) {
        const stat = fs.lstatSync(entry.candidate, { bigint: true });
        if (
          stat.isSymbolicLink() ||
          statIdentity(stat) !== entry.identity ||
          stat.isDirectory() !== entry.isDirectory ||
          stat.mode !== entry.mode ||
          stat.size !== entry.size ||
          stat.nlink !== entry.nlink ||
          stat.mtimeNs !== entry.mtimeNs ||
          stat.ctimeNs !== entry.ctimeNs
        ) {
          throw new Error(
            `prepared-bundle entry changed during ACL scan: ${entry.candidate}`,
          );
        }
      }
      assertRoot();
    };
    visit(root);
    assertAclBatch(entries);
    assertEntriesUnchanged();
  ' "$root" "$expected_root_identity"
}

safe_remove_tree() {
  local path="$1"
  local expected_identity="$2"
  local label="$3"
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    return 0
  fi
  # Move the candidate to a random sibling, open the exact moved inode, and
  # recurse only after fchdir pins that inode as the cleanup root. A helper may
  # rename either pathname after that point, but it cannot retarget recursive
  # deletion at a replacement tree. Later pathname cleanup is non-recursive
  # and fails closed on any identity mismatch.
  # shellcheck disable=SC2016
  system_perl \
    -MFcntl=:DEFAULT,:mode,O_DIRECTORY,O_NOFOLLOW \
    -MFile::Basename=basename,dirname \
    -MFile::Path=remove_tree \
    -MFile::Temp=tempdir \
    -e '
      use strict;
      use warnings;

      my ($candidate, $expected_identity, $label) = @ARGV;
      my $identity_changed = 0;
      my $failure = "";
      my $quarantine = "";
      my $quarantine_name = "";
      my $quarantine_identity = "";
      my $quarantined = "";
      my $root_cleaned = 0;
      my ($origin_fh, $parent_fh, $tree_fh);

      sub identity {
        my (@stat) = @_;
        return "$stat[0]:$stat[1]";
      }

      sub path_exists {
        my ($target) = @_;
        my @stat = lstat($target);
        return scalar(@stat) != 0;
      }

      sub directory_matches {
        my ($target, $expected) = @_;
        my @stat = lstat($target);
        return 0 if !@stat || S_ISLNK($stat[2]) || !S_ISDIR($stat[2]);
        return identity(@stat) eq $expected;
      }

      if ($expected_identity !~ /\A[0-9]+:[0-9]+\z/) {
        print STDERR "agent:autoreview: failed to remove $label safely: $candidate\n";
        exit 1;
      }
      if (!directory_matches($candidate, $expected_identity)) {
        print STDERR "agent:autoreview: refusing to remove $label after its identity changed: $candidate\n";
        exit 1;
      }

      my $parent = dirname($candidate);
      my $candidate_name = basename($candidate);
      if ($candidate_name eq "" || $candidate_name eq "." || $candidate_name eq "..") {
        print STDERR "agent:autoreview: failed to remove $label safely: $candidate\n";
        exit 1;
      }

      eval {
        sysopen($origin_fh, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
          or die "cannot open original working directory: $!";
        sysopen($parent_fh, $parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
          or die "cannot open cleanup parent: $!";

        $quarantine = tempdir(
          ".agent-autoreview-cleanup.XXXXXXXX",
          DIR => $parent,
          CLEANUP => 0,
        );
        my @quarantine_stat = lstat($quarantine);
        die "cannot stat cleanup quarantine"
          if !@quarantine_stat ||
            S_ISLNK($quarantine_stat[2]) ||
            !S_ISDIR($quarantine_stat[2]);
        $quarantine_identity = identity(@quarantine_stat);
        $quarantine_name = basename($quarantine);
        $quarantined = "$quarantine_name/tree";

        chdir($parent_fh) or die "cannot pin cleanup parent: $!";
        if (!directory_matches($candidate_name, $expected_identity)) {
          $identity_changed = 1;
          die "candidate identity changed before quarantine";
        }
        if (!directory_matches($quarantine_name, $quarantine_identity)) {
          $identity_changed = 1;
          die "quarantine identity changed before move";
        }
        rename($candidate_name, $quarantined)
          or die "cannot quarantine cleanup candidate: $!";

        if (!directory_matches($quarantined, $expected_identity)) {
          $identity_changed = 1;
          die "candidate identity changed while entering quarantine";
        }
        sysopen($tree_fh, $quarantined, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
          or die "cannot open quarantined cleanup root: $!";
        my @opened_stat = stat($tree_fh);
        if (
          !@opened_stat ||
          !S_ISDIR($opened_stat[2]) ||
          identity(@opened_stat) ne $expected_identity
        ) {
          $identity_changed = 1;
          die "opened cleanup root identity changed";
        }
        chdir($tree_fh) or die "cannot pin quarantined cleanup root: $!";
        my @pinned_stat = stat(".");
        if (
          !@pinned_stat ||
          !S_ISDIR($pinned_stat[2]) ||
          identity(@pinned_stat) ne $expected_identity
        ) {
          $identity_changed = 1;
          die "pinned cleanup root identity changed";
        }

        my $errors;
        remove_tree(
          ".",
          {
            safe => 1,
            keep_root => 1,
            error => \$errors,
          },
        );
        if ($errors && @{$errors}) {
          die "descriptor-rooted recursive cleanup failed";
        }
        my @after_stat = stat($tree_fh);
        if (
          !@after_stat ||
          !S_ISDIR($after_stat[2]) ||
          identity(@after_stat) ne $expected_identity
        ) {
          $identity_changed = 1;
          die "cleanup root identity changed during recursive removal";
        }
        opendir(my $verify_fh, ".") or die "cannot verify cleanup root: $!";
        my @remaining = grep { $_ ne "." && $_ ne ".." } readdir($verify_fh);
        closedir($verify_fh) or die "cannot close cleanup verification: $!";
        die "cleanup root is not empty" if @remaining;
        $root_cleaned = 1;
        1;
      } or do {
        $failure = $@ || "unknown cleanup failure";
      };

      if (defined($parent_fh)) {
        if (!chdir($parent_fh)) {
          $failure ||= "cannot return to pinned cleanup parent: $!";
        }
      }

      if ($root_cleaned && $quarantined ne "") {
        if (directory_matches($quarantined, $expected_identity)) {
          if (!rmdir($quarantined)) {
            $failure ||= "cannot remove empty cleanup root: $!";
          }
        }
        else {
          $identity_changed = 1;
          $failure ||= "cleanup root pathname identity changed";
        }
      }

      if (path_exists($candidate_name)) {
        $identity_changed = 1;
        $failure ||= "replacement appeared at cleanup source";
      }

      if ($quarantine_name ne "") {
        if (directory_matches($quarantine_name, $quarantine_identity)) {
          if (!rmdir($quarantine_name) && !$failure) {
            $failure = "cannot remove cleanup quarantine: $!";
          }
        }
        elsif (path_exists($quarantine_name)) {
          $identity_changed = 1;
          $failure ||= "cleanup quarantine identity changed";
        }
      }

      if (defined($origin_fh) && !chdir($origin_fh)) {
        $failure ||= "cannot restore original working directory: $!";
      }
      close($tree_fh) if defined($tree_fh);
      close($parent_fh) if defined($parent_fh);
      close($origin_fh) if defined($origin_fh);

      if ($failure ne "") {
        if ($identity_changed) {
          print STDERR "agent:autoreview: refusing to remove $label after its identity changed: $candidate\n";
        }
        else {
          print STDERR "agent:autoreview: failed to remove $label safely: $candidate\n";
        }
        if ($quarantine ne "" && path_exists($quarantine)) {
          print STDERR "agent:autoreview: retained cleanup quarantine: $quarantine\n";
        }
        exit 1;
      }
    ' \
    "$path" \
    "$expected_identity" \
    "$label"
}

bundle_content_manifest() {
  local root="$1"
  local expected_root_identity="$2"
  shift 2
  local ignored_root_entries=("$@")
  local digest
  assert_bundle_tree_acl_trusted "$root" "$expected_root_identity" || return 1
  # The single-quoted string is JavaScript source, not shell interpolation.
  # shellcheck disable=SC2016
  if ! digest="$(run_trusted_node -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const path = require("node:path");
    const [root, expectedRootIdentity, ...ignoredRootEntries] =
      process.argv.slice(1);
    const ignoresRootEntry = (name) =>
      ignoredRootEntries.some(
        (entry) =>
          entry === name ||
          (entry === "autoreview-prompt.pass-*.md" &&
            /^autoreview-prompt\.pass-[0-9]+-of-[0-9]+\.md$/.test(name)),
      );
    const statIdentity = (stat) => `${stat.dev}:${stat.ino}`;
    const identity = (candidate) =>
      statIdentity(fs.lstatSync(candidate, { bigint: true }));
    const assertRoot = () => {
      if (identity(root) !== expectedRootIdentity) {
        throw new Error("prepared-bundle staging identity changed");
      }
    };
    const assertDirectory = (candidate, expectedIdentity) => {
      const current = fs.lstatSync(candidate, { bigint: true });
      if (
        current.isSymbolicLink() ||
        !current.isDirectory() ||
        statIdentity(current) !== expectedIdentity
      ) {
        throw new Error(`prepared-bundle directory identity changed: ${candidate}`);
      }
      return current;
    };
    const assertDirectoryUnchanged = (candidate, expectedIdentity, before) => {
      const current = assertDirectory(candidate, expectedIdentity);
      if (
        current.size !== before.size ||
        current.mode !== before.mode ||
        current.nlink !== before.nlink ||
        current.mtimeNs !== before.mtimeNs ||
        current.ctimeNs !== before.ctimeNs
      ) {
        throw new Error(`prepared-bundle directory changed while hashing: ${candidate}`);
      }
      return current;
    };
    const records = [];
    const heldDirectories = [];
    const heldFiles = [];
    const assertFileUnchanged = (descriptor, relative, before) => {
      const current = fs.fstatSync(descriptor, { bigint: true });
      if (
        !current.isFile() ||
        statIdentity(current) !== statIdentity(before) ||
        current.size !== before.size ||
        current.mode !== before.mode ||
        current.nlink !== 1n ||
        current.mtimeNs !== before.mtimeNs ||
        current.ctimeNs !== before.ctimeNs
      ) {
        throw new Error(`prepared-bundle file changed after hashing: ${relative}`);
      }
    };
    const visit = (directory, relativeDirectory, expectedDirectoryIdentity) => {
      assertRoot();
      const openedDirectory = assertDirectory(
        directory,
        expectedDirectoryIdentity,
      );
      heldDirectories.push({
        directory,
        expectedDirectoryIdentity,
        openedDirectory,
      });
      if (relativeDirectory === "") {
        records.push(["r", Number(openedDirectory.mode & 0o777n)]);
      } else {
        records.push([
          "d",
          relativeDirectory,
          Number(openedDirectory.mode & 0o777n),
          statIdentity(openedDirectory),
        ]);
      }
      const names = fs.readdirSync(directory).sort();
      assertRoot();
      assertDirectoryUnchanged(
        directory,
        expectedDirectoryIdentity,
        openedDirectory,
      );
      for (const name of names) {
        assertRoot();
        assertDirectoryUnchanged(
          directory,
          expectedDirectoryIdentity,
          openedDirectory,
        );
        if (relativeDirectory === "" && ignoresRootEntry(name)) continue;
        const absolute = path.join(directory, name);
        const relative = relativeDirectory
          ? `${relativeDirectory}/${name}`
          : name;
        const listed = fs.lstatSync(absolute, { bigint: true });
        if (listed.isSymbolicLink()) {
          throw new Error(`prepared-bundle manifest refuses symlink: ${relative}`);
        }
        if (listed.isDirectory()) {
          visit(absolute, relative, statIdentity(listed));
          continue;
        }
        if (!listed.isFile()) {
          throw new Error(`prepared-bundle manifest refuses special file: ${relative}`);
        }
        const descriptor = fs.openSync(
          absolute,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
        );
        let retainDescriptor = false;
        try {
          const opened = fs.fstatSync(descriptor, { bigint: true });
          if (
            !opened.isFile() ||
            statIdentity(opened) !== statIdentity(listed) ||
            opened.nlink !== 1n
          ) {
            throw new Error(
              `prepared-bundle file identity changed or is externally linked: ${relative}`,
            );
          }
          const content = fs.readFileSync(descriptor);
          const after = fs.fstatSync(descriptor, { bigint: true });
          if (
            statIdentity(after) !== statIdentity(opened) ||
            after.size !== opened.size ||
            after.size !== BigInt(content.length) ||
            after.mode !== opened.mode ||
            after.nlink !== 1n ||
            after.mtimeNs !== opened.mtimeNs ||
            after.ctimeNs !== opened.ctimeNs
          ) {
            throw new Error(`prepared-bundle file changed while hashing: ${relative}`);
          }
          records.push([
            "f",
            relative,
            Number(after.mode & 0o777n),
            statIdentity(after),
            content.length,
            crypto.createHash("sha256").update(content).digest("hex"),
          ]);
          heldFiles.push({ descriptor, relative, opened: after });
          retainDescriptor = true;
        } finally {
          if (!retainDescriptor) fs.closeSync(descriptor);
        }
      }
      assertRoot();
      assertDirectoryUnchanged(
        directory,
        expectedDirectoryIdentity,
        openedDirectory,
      );
    };
    let digest;
    try {
      assertRoot();
      visit(root, "", expectedRootIdentity);
      assertRoot();
      for (const {
        directory,
        expectedDirectoryIdentity,
        openedDirectory,
      } of heldDirectories) {
        assertDirectoryUnchanged(
          directory,
          expectedDirectoryIdentity,
          openedDirectory,
        );
      }
      for (const { descriptor, relative, opened } of heldFiles) {
        assertFileUnchanged(descriptor, relative, opened);
      }
      assertRoot();
      digest = crypto
        .createHash("sha256")
        .update(JSON.stringify(records))
        .digest("hex");
    } finally {
      for (const { descriptor } of heldFiles) {
        try {
          fs.closeSync(descriptor);
        } catch {
          // Preserve the primary verification failure.
        }
      }
    }
    process.stdout.write(`${digest}\n`);
  ' "$root" "$expected_root_identity" \
    "${ignored_root_entries[@]+"${ignored_root_entries[@]}"}")"; then
    return 1
  fi
  assert_bundle_tree_acl_trusted "$root" "$expected_root_identity" || return 1
  printf '%s\n' "$digest"
}

publish_bundle_with_reservation() {
  local staging_dir="$1"
  local bundle_dir="$2"
  local bundle_parent="$3"
  local bundle_parent_identity="$4"
  local staging_identity="$5"
  local expected_bundle_manifest="$6"
  local published_identity
  if ! assert_safe_bundle_parent_ancestry "$bundle_parent" ||
    ! assert_bundle_tree_acl_trusted "$staging_dir" "$staging_identity"; then
    echo "agent:autoreview: failed to publish the prepared bundle safely" >&2
    return 1
  fi
  # The single-quoted string is JavaScript source, not shell interpolation.
  # shellcheck disable=SC2016
  if ! run_trusted_node -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const path = require("node:path");
    if (process.argv.length !== 7) process.exit(2);
    const [
      staging,
      destination,
      parent,
      expectedParentIdentity,
      expectedStagingIdentity,
      expectedBundleManifest,
    ] = process.argv.slice(1);
    const completionName = ".agent-autoreview-complete";
    const statIdentity = (stat) => `${stat.dev}:${stat.ino}`;
    const identity = (candidate) =>
      statIdentity(fs.lstatSync(candidate, { bigint: true }));
    const assertSafeParentAncestry = (candidate) => {
      const euid = BigInt(process.geteuid());
      let current = candidate;
      for (;;) {
        const stat = fs.lstatSync(current, { bigint: true });
        const mode = stat.mode & 0o7777n;
        const ownerIsTrusted = stat.uid === euid || stat.uid === 0n;
        const sharedWritable = (mode & 0o022n) !== 0n;
        const sticky = (mode & 0o1000n) !== 0n;
        if (
          fs.realpathSync(current) !== current ||
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          !ownerIsTrusted ||
          (sharedWritable && !sticky)
        ) {
          throw new Error(`unsafe prepared-bundle parent ancestor: ${current}`);
        }
        const ancestor = path.dirname(current);
        if (ancestor === current) break;
        current = ancestor;
      }
    };
    const manifest = (root, expectedRootIdentity) => {
      const assertRoot = () => {
        if (identity(root) !== expectedRootIdentity) {
          throw new Error("prepared-bundle manifest root identity changed");
        }
      };
      const assertDirectory = (candidate, expectedIdentity) => {
        const current = fs.lstatSync(candidate, { bigint: true });
        if (
          current.isSymbolicLink() ||
          !current.isDirectory() ||
          statIdentity(current) !== expectedIdentity
        ) {
          throw new Error(`prepared-bundle directory identity changed: ${candidate}`);
        }
        return current;
      };
      const assertDirectoryUnchanged = (candidate, expectedIdentity, before) => {
        const current = assertDirectory(candidate, expectedIdentity);
        if (
          current.size !== before.size ||
          current.mode !== before.mode ||
          current.nlink !== before.nlink ||
          current.mtimeNs !== before.mtimeNs ||
          current.ctimeNs !== before.ctimeNs
        ) {
          throw new Error(`prepared-bundle directory changed while hashing: ${candidate}`);
        }
        return current;
      };
      const records = [];
      const heldDirectories = [];
      const heldFiles = [];
      const assertFileUnchanged = (descriptor, relative, before) => {
        const current = fs.fstatSync(descriptor, { bigint: true });
        if (
          !current.isFile() ||
          statIdentity(current) !== statIdentity(before) ||
          current.size !== before.size ||
          current.mode !== before.mode ||
          current.nlink !== 1n ||
          current.mtimeNs !== before.mtimeNs ||
          current.ctimeNs !== before.ctimeNs
        ) {
          throw new Error(`prepared-bundle file changed after hashing: ${relative}`);
        }
      };
      const visit = (directory, relativeDirectory, expectedDirectoryIdentity) => {
        assertRoot();
        const openedDirectory = assertDirectory(
          directory,
          expectedDirectoryIdentity,
        );
        heldDirectories.push({
          directory,
          expectedDirectoryIdentity,
          openedDirectory,
        });
        if (relativeDirectory === "") {
          records.push(["r", Number(openedDirectory.mode & 0o777n)]);
        } else {
          records.push([
            "d",
            relativeDirectory,
            Number(openedDirectory.mode & 0o777n),
            statIdentity(openedDirectory),
          ]);
        }
        const names = fs.readdirSync(directory).sort();
        assertRoot();
        assertDirectoryUnchanged(
          directory,
          expectedDirectoryIdentity,
          openedDirectory,
        );
        for (const name of names) {
          assertRoot();
          assertDirectoryUnchanged(
            directory,
            expectedDirectoryIdentity,
            openedDirectory,
          );
          const absolute = path.join(directory, name);
          const relative = relativeDirectory
            ? `${relativeDirectory}/${name}`
            : name;
          const listed = fs.lstatSync(absolute, { bigint: true });
          if (listed.isSymbolicLink()) {
            throw new Error(`prepared-bundle manifest refuses symlink: ${relative}`);
          }
          if (listed.isDirectory()) {
            visit(absolute, relative, statIdentity(listed));
            continue;
          }
          if (!listed.isFile()) {
            throw new Error(`prepared-bundle manifest refuses special file: ${relative}`);
          }
          const descriptor = fs.openSync(
            absolute,
            fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
          );
          let retainDescriptor = false;
          try {
            const opened = fs.fstatSync(descriptor, { bigint: true });
            if (
              !opened.isFile() ||
              statIdentity(opened) !== statIdentity(listed) ||
              opened.nlink !== 1n
            ) {
              throw new Error(
                `prepared-bundle file identity changed or is externally linked: ${relative}`,
              );
            }
            const content = fs.readFileSync(descriptor);
            const after = fs.fstatSync(descriptor, { bigint: true });
            if (
              statIdentity(after) !== statIdentity(opened) ||
              after.size !== opened.size ||
              after.size !== BigInt(content.length) ||
              after.mode !== opened.mode ||
              after.nlink !== 1n ||
              after.mtimeNs !== opened.mtimeNs ||
              after.ctimeNs !== opened.ctimeNs
            ) {
              throw new Error(`prepared-bundle file changed while hashing: ${relative}`);
            }
            records.push([
              "f",
              relative,
              Number(after.mode & 0o777n),
              statIdentity(after),
              content.length,
              crypto.createHash("sha256").update(content).digest("hex"),
            ]);
            heldFiles.push({ descriptor, relative, opened: after });
            retainDescriptor = true;
          } finally {
            if (!retainDescriptor) fs.closeSync(descriptor);
          }
        }
        assertRoot();
        assertDirectoryUnchanged(
          directory,
          expectedDirectoryIdentity,
          openedDirectory,
        );
      };
      try {
        assertRoot();
        visit(root, "", expectedRootIdentity);
        assertRoot();
        for (const {
          directory,
          expectedDirectoryIdentity,
          openedDirectory,
        } of heldDirectories) {
          assertDirectoryUnchanged(
            directory,
            expectedDirectoryIdentity,
            openedDirectory,
          );
        }
        for (const { descriptor, relative, opened } of heldFiles) {
          assertFileUnchanged(descriptor, relative, opened);
        }
        assertRoot();
        return crypto
          .createHash("sha256")
          .update(JSON.stringify(records))
          .digest("hex");
      } finally {
        for (const { descriptor } of heldFiles) {
          try {
            fs.closeSync(descriptor);
          } catch {
            // Preserve the primary verification failure.
          }
        }
      }
    };
    assertSafeParentAncestry(parent);
    const parentStat = fs.lstatSync(parent);
    const stagingName = path.basename(staging);
    const destinationName = path.basename(destination);
    if (
      fs.realpathSync(parent) !== parent ||
      !parentStat.isDirectory() ||
      parentStat.isSymbolicLink() ||
      identity(parent) !== expectedParentIdentity ||
      path.dirname(staging) !== parent ||
      path.dirname(destination) !== parent ||
      stagingName === "." ||
      stagingName === ".." ||
      destinationName === "." ||
      destinationName === ".." ||
      stagingName === destinationName
    ) {
      process.exit(3);
    }
    process.chdir(parent);
    if (
      fs.realpathSync(".") !== parent ||
      identity(".") !== expectedParentIdentity
    ) {
      process.exit(3);
    }
    const stagingStat = fs.lstatSync(stagingName, { bigint: true });
    if (
      fs.realpathSync(stagingName) !== staging ||
      !stagingStat.isDirectory() ||
      stagingStat.isSymbolicLink() ||
      statIdentity(stagingStat) !== expectedStagingIdentity ||
      manifest(stagingName, expectedStagingIdentity) !== expectedBundleManifest
    ) {
      process.exit(4);
    }

    const completionSource = `${stagingName}.complete`;
    const completionDestination = path.join(destinationName, completionName);
    try {
      fs.lstatSync(path.join(stagingName, completionName));
      throw new Error("helper produced the reserved bundle completion marker");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    fs.writeFileSync(
      completionSource,
      `autoreview-bundle-v2\nmanifest-sha256:${expectedBundleManifest}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
    const completionSourceIdentity = identity(completionSource);

    let destinationIdentity = "";
    try {
      try {
        assertSafeParentAncestry(parent);
        if (identity(".") !== expectedParentIdentity) {
          throw new Error("prepared-bundle parent identity changed");
        }
        fs.mkdirSync(destinationName, { mode: Number(stagingStat.mode & 0o777n) });
      } catch (error) {
        if (error?.code === "EEXIST") {
          console.error(
            "agent:autoreview: prepared-bundle destination already exists; refusing to replace it",
          );
        }
        throw error;
      }
      fs.chmodSync(destinationName, Number(stagingStat.mode & 0o777n));
      const destinationStat = fs.lstatSync(destinationName);
      if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
        throw new Error("prepared-bundle reservation is not a directory");
      }
      destinationIdentity = identity(destinationName);

      if (identity(stagingName) !== expectedStagingIdentity) {
        throw new Error("prepared-bundle staging identity changed");
      }
      const stagedEntries = fs.readdirSync(stagingName);
      if (identity(stagingName) !== expectedStagingIdentity) {
        throw new Error("prepared-bundle staging identity changed");
      }
      for (const entry of stagedEntries) {
        if (
          identity(".") !== expectedParentIdentity ||
          identity(destinationName) !== destinationIdentity ||
          identity(stagingName) !== expectedStagingIdentity
        ) {
          throw new Error("prepared-bundle reservation identity changed");
        }
        fs.renameSync(
          path.join(stagingName, entry),
          path.join(destinationName, entry),
        );
        if (identity(stagingName) !== expectedStagingIdentity) {
          throw new Error("prepared-bundle staging identity changed");
        }
      }
      const remainingEntries = fs.readdirSync(stagingName);
      if (
        remainingEntries.length !== 0 ||
        identity(".") !== expectedParentIdentity ||
        identity(stagingName) !== expectedStagingIdentity ||
        identity(destinationName) !== destinationIdentity ||
        identity(completionSource) !== completionSourceIdentity ||
        manifest(destinationName, destinationIdentity) !==
          expectedBundleManifest
      ) {
        throw new Error("prepared-bundle staging state changed");
      }
      fs.rmdirSync(stagingName);
      let stagingAbsent = false;
      try {
        fs.lstatSync(stagingName);
      } catch (error) {
        if (error?.code === "ENOENT") stagingAbsent = true;
        else throw error;
      }
      if (
        !stagingAbsent ||
        identity(".") !== expectedParentIdentity ||
        identity(destinationName) !== destinationIdentity ||
        identity(completionSource) !== completionSourceIdentity ||
        manifest(destinationName, destinationIdentity) !==
          expectedBundleManifest
      ) {
        throw new Error("prepared-bundle completion state changed");
      }
      // This exclusive hard link is the publication commit. Every fallible
      // transfer, removal, and identity check must remain above it.
      fs.linkSync(completionSource, completionDestination);
      try {
        if (identity(completionSource) === completionSourceIdentity) {
          fs.unlinkSync(completionSource);
        }
      } catch {
        // A leftover private staging marker is harmless after commit.
      }
    } catch (error) {
      try {
        if (identity(completionSource) === completionSourceIdentity) {
          fs.unlinkSync(completionSource);
        }
      } catch {
        // Never remove an object whose identity can no longer be proven.
      }
      if (destinationIdentity) {
        console.error(
          "agent:autoreview: publication left an incomplete, unmarked destination; inspect and remove it before retrying",
        );
      }
      throw error;
    }
  ' \
    "$staging_dir" \
    "$bundle_dir" \
    "$bundle_parent" \
    "$bundle_parent_identity" \
    "$staging_identity" \
    "$expected_bundle_manifest"; then
    echo "agent:autoreview: failed to publish the prepared bundle safely" >&2
    return 1
  fi
  if ! assert_safe_bundle_parent_ancestry "$bundle_parent" ||
    [[ "$(path_identity "$bundle_parent")" != "$bundle_parent_identity" ]] ||
    ! published_identity="$(path_identity "$bundle_dir")" ||
    ! assert_bundle_tree_acl_trusted "$bundle_dir" "$published_identity"; then
    echo "agent:autoreview: published bundle ACL or parent state changed" >&2
    return 1
  fi
}

bundle_completion_record() {
  local bundle_dir="$1"
  local expected_root_identity="$2"
  # The single-quoted string is JavaScript source, not shell interpolation.
  # shellcheck disable=SC2016
  run_trusted_node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [root, expectedRootIdentity] = process.argv.slice(1);
    const statIdentity = (stat) => `${stat.dev}:${stat.ino}`;
    const identity = (candidate) =>
      statIdentity(fs.lstatSync(candidate, { bigint: true }));
    const assertRoot = () => {
      const rootStat = fs.lstatSync(root, { bigint: true });
      if (
        fs.realpathSync(root) !== root ||
        !rootStat.isDirectory() ||
        rootStat.isSymbolicLink() ||
        statIdentity(rootStat) !== expectedRootIdentity
      ) {
        throw new Error("prepared-bundle root identity changed");
      }
    };
    assertRoot();
    const marker = path.join(root, ".agent-autoreview-complete");
    const listed = fs.lstatSync(marker, { bigint: true });
    if (listed.isSymbolicLink() || !listed.isFile() || listed.nlink !== 1n) {
      throw new Error("prepared-bundle completion marker is not an unaliased regular file");
    }
    const descriptor = fs.openSync(
      marker,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        statIdentity(opened) !== statIdentity(listed)
      ) {
        throw new Error("prepared-bundle completion marker identity changed");
      }
      const content = fs.readFileSync(descriptor, "utf8");
      const after = fs.fstatSync(descriptor, { bigint: true });
      if (
        statIdentity(after) !== statIdentity(opened) ||
        after.size !== opened.size ||
        after.size !== BigInt(Buffer.byteLength(content, "utf8")) ||
        after.mode !== opened.mode ||
        after.nlink !== 1n ||
        after.mtimeNs !== opened.mtimeNs ||
        after.ctimeNs !== opened.ctimeNs
      ) {
        throw new Error("prepared-bundle completion marker changed while reading");
      }
      const match = /^autoreview-bundle-v2\nmanifest-sha256:([0-9a-f]{64})\n$/.exec(
        content,
      );
      if (!match) {
        throw new Error("prepared-bundle completion marker has an unsupported format");
      }
      assertRoot();
      process.stdout.write(`${statIdentity(after)}\t${match[1]}\n`);
    } finally {
      fs.closeSync(descriptor);
    }
  ' "$bundle_dir" "$expected_root_identity"
}

verify_context_bundle() {
  local requested_bundle_dir="$1"
  local retained_manifest="${2:-}"
  local bundle_parent
  local bundle_name
  local bundle_dir
  local bundle_identity
  local completion_before
  local completion_after
  local expected_manifest
  local actual_manifest
  if [[ -z "$requested_bundle_dir" || "$requested_bundle_dir" == "/" ]]; then
    echo "agent:autoreview: --verify-bundle-dir requires a specific published bundle directory" >&2
    return 1
  fi
  case "$requested_bundle_dir" in
    /*) ;;
    *) requested_bundle_dir="$(pwd -P)/$requested_bundle_dir" ;;
  esac
  bundle_parent="$(dirname "$requested_bundle_dir")"
  bundle_name="$(basename "$requested_bundle_dir")"
  if [[
    "$bundle_name" == "/" ||
      "$bundle_name" == "." ||
      "$bundle_name" == ".."
  ]]; then
    echo "agent:autoreview: --verify-bundle-dir requires a specific published bundle directory" >&2
    return 1
  fi
  if [[ ! -d "$bundle_parent" || -L "$requested_bundle_dir" ]]; then
    echo "agent:autoreview: --verify-bundle-dir requires a published bundle directory" >&2
    return 1
  fi
  bundle_parent="$(cd "$bundle_parent" && pwd -P)"
  if ! assert_safe_bundle_parent_ancestry "$bundle_parent"; then
    echo "agent:autoreview: refusing to verify a bundle through unsafe parent ancestry" >&2
    return 1
  fi
  bundle_dir="$bundle_parent/$bundle_name"
  if [[ ! -d "$bundle_dir" || -L "$bundle_dir" ]]; then
    echo "agent:autoreview: --verify-bundle-dir requires a published bundle directory" >&2
    return 1
  fi
  bundle_identity="$(path_identity "$bundle_dir")"
  if ! assert_bundle_tree_acl_trusted "$bundle_dir" "$bundle_identity"; then
    echo "agent:autoreview: refusing to verify a bundle with unsafe entry ACLs" >&2
    return 1
  fi
  validate_prepared_prompt_outputs "$bundle_dir"
  if ! completion_before="$(
    bundle_completion_record "$bundle_dir" "$bundle_identity"
  )"; then
    echo "agent:autoreview: prepared-bundle completion marker verification failed" >&2
    return 1
  fi
  expected_manifest="${completion_before#*$'\t'}"
  if [[ "$expected_manifest" == "$completion_before" ]]; then
    echo "agent:autoreview: prepared-bundle completion marker is malformed" >&2
    return 1
  fi
  if [[
    -n "$retained_manifest" &&
      "$expected_manifest" != "$retained_manifest"
  ]]; then
    echo "agent:autoreview: prepared bundle does not match the retained pre-review manifest" >&2
    return 1
  fi
  if ! actual_manifest="$(
    bundle_content_manifest \
      "$bundle_dir" \
      "$bundle_identity" \
      ".agent-autoreview-complete"
  )"; then
    echo "agent:autoreview: prepared-bundle manifest verification failed" >&2
    return 1
  fi
  if ! completion_after="$(
    bundle_completion_record "$bundle_dir" "$bundle_identity"
  )"; then
    echo "agent:autoreview: prepared-bundle completion marker changed during verification" >&2
    return 1
  fi
  if [[
    "$completion_after" != "$completion_before" ||
      "$actual_manifest" != "$expected_manifest"
  ]]; then
    echo "agent:autoreview: prepared-bundle content does not match its completion marker" >&2
    return 1
  fi
  printf 'agent:autoreview verified context bundle: %s (manifest %s)\n' \
    "$bundle_dir" \
    "$expected_manifest"
}

validate_prepared_prompt_outputs() {
  local staging_dir="$1"
  local prompt="$staging_dir/autoreview-prompt.md"
  local first_line=""
  local saw_header=0
  local bom=$'\357\273\277'
  local line
  local companion
  local companion_count=0
  local declared_total=0
  local pass_index
  local pass_total
  local pass_width
  local padded_index
  local padded_total
  local expected_companion
  local actual_companions=()
  local nullglob_was_set=0
  local pass_line_re='^- Pass ([0-9]+)/([0-9]+): ([^/]+)$'
  if [[ ! -f "$prompt" || -L "$prompt" || ! -s "$prompt" ]]; then
    echo "agent:autoreview: helper did not produce a validated autoreview prompt" >&2
    return 1
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="${line#"$bom"}"
    if [[ "$saw_header" -eq 0 ]]; then
      if [[ "$line" =~ ^[[:space:]]*$ ]]; then
        continue
      fi
      first_line="$line"
      if [[ "$first_line" != "# Autoreview Prompt Index" ]]; then
        if [[ "$first_line" == "# Autoreview Prompt Index"* ]]; then
          echo "agent:autoreview: helper produced a malformed review prompt index heading" >&2
          return 1
        fi
        if shopt -q nullglob; then
          nullglob_was_set=1
        else
          shopt -s nullglob
        fi
        actual_companions=("$staging_dir"/autoreview-prompt.pass-*.md)
        if [[ "$nullglob_was_set" -eq 0 ]]; then
          shopt -u nullglob
        fi
        if [[ "${#actual_companions[@]}" -ne 0 ]]; then
          echo "agent:autoreview: helper produced undeclared review pass files" >&2
          return 1
        fi
        return 0
      fi
      saw_header=1
      continue
    fi
    case "$line" in
      "- Pass "*)
        if [[ ! "$line" =~ $pass_line_re ]]; then
          echo "agent:autoreview: helper produced a malformed review prompt index" >&2
          return 1
        fi
        pass_index=$((10#${BASH_REMATCH[1]}))
        pass_total=$((10#${BASH_REMATCH[2]}))
        companion="${BASH_REMATCH[3]}"
        if [[
          "$pass_index" -ne $((companion_count + 1)) ||
            "$pass_total" -lt 1 ||
            ( "$declared_total" -ne 0 && "$pass_total" -ne "$declared_total" )
        ]]; then
          echo "agent:autoreview: helper produced an inconsistent review prompt index" >&2
          return 1
        fi
        declared_total="$pass_total"
        pass_width="${#BASH_REMATCH[2]}"
        if [[ "$pass_width" -lt 2 ]]; then
          pass_width=2
        fi
        printf -v padded_index "%0${pass_width}d" "$pass_index"
        printf -v padded_total "%0${pass_width}d" "$pass_total"
        expected_companion="autoreview-prompt.pass-${padded_index}-of-${padded_total}.md"
        if [[ "$companion" != "$expected_companion" ]]; then
          echo "agent:autoreview: helper produced an invalid review pass path" >&2
          return 1
        fi
        case "$companion" in
          "" | "." | ".." | */*)
            echo "agent:autoreview: helper produced an invalid review pass path" >&2
            return 1
            ;;
        esac
        if [[
          ! -f "$staging_dir/$companion" ||
            -L "$staging_dir/$companion" ||
            ! -s "$staging_dir/$companion"
        ]]; then
          echo "agent:autoreview: helper did not produce every validated review pass" >&2
          return 1
        fi
        companion_count=$((companion_count + 1))
        ;;
    esac
  done <"$prompt"
  if [[ "$companion_count" -eq 0 || "$companion_count" -ne "$declared_total" ]]; then
    echo "agent:autoreview: helper produced an incomplete review prompt index" >&2
    return 1
  fi
  if shopt -q nullglob; then
    nullglob_was_set=1
  else
    shopt -s nullglob
  fi
  actual_companions=("$staging_dir"/autoreview-prompt.pass-*.md)
  if [[ "$nullglob_was_set" -eq 0 ]]; then
    shopt -u nullglob
  fi
  if [[ "${#actual_companions[@]}" -ne "$companion_count" ]]; then
    echo "agent:autoreview: helper produced undeclared review pass files" >&2
    return 1
  fi
}

validate_auto_feedback_state() {
  local feedback_file="$1"
  local expected_number="$2"
  local expected_base="$3"
  local expected_head="$4"
  local expected_head_oid="$5"
  run_trusted_node -e '
    const fs = require("node:fs");
    const [file, number, base, head, headOid] = process.argv.slice(1);
    let state;
    try {
      state = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      console.error("agent:autoreview: automatic feedback state is not valid JSON");
      process.exit(1);
    }
    const pr = state?.pr;
    if (
      pr?.number !== Number(number) ||
      pr?.state !== "OPEN" ||
      pr?.baseRefName !== base ||
      pr?.headRefName !== head ||
      pr?.headRefOid !== headOid
    ) {
      console.error(
        "agent:autoreview: feedback state no longer matches the frozen automatic PR selection; rerun autoreview",
      );
      process.exit(1);
    }
  ' "$feedback_file" "$expected_number" "$expected_base" "$expected_head" "$expected_head_oid"
}

max_review_capture_bytes=$((512000 * 8))
review_capture_bytes=0

capture_output_file() {
  local output="$1"
  local label="$2"
  local allowed_status="$3"
  shift 3
  local remaining=$((max_review_capture_bytes - review_capture_bytes))
  local command_status
  local limiter_status
  local size
  local pipeline_status=()

  if ((remaining <= 0)); then
    echo "agent:autoreview: review input exceeds the ${max_review_capture_bytes}-byte capture budget while capturing $label" >&2
    return 1
  fi

  set +e
  "$@" | head -c "$((remaining + 1))" >"$output"
  pipeline_status=("${PIPESTATUS[@]}")
  set -e
  command_status="${pipeline_status[0]:-1}"
  limiter_status="${pipeline_status[1]:-1}"
  size="$(wc -c <"$output")"
  size="${size//[[:space:]]/}"

  if ((size > remaining)); then
    echo "agent:autoreview: review input exceeds the ${max_review_capture_bytes}-byte capture budget while capturing $label" >&2
    return 1
  fi
  if [[ "$command_status" -ne 0 && "$command_status" -ne "$allowed_status" ]]; then
    echo "agent:autoreview: failed to capture $label (exit $command_status)" >&2
    return "$command_status"
  fi
  if [[ "$limiter_status" -ne 0 ]]; then
    echo "agent:autoreview: failed to bound $label (exit $limiter_status)" >&2
    return "$limiter_status"
  fi

  review_capture_bytes=$((review_capture_bytes + size))
}

capture_append_output() {
  local output="$1"
  local label="$2"
  local allowed_status="$3"
  shift 3
  local chunk
  chunk="$(mktemp "${output}.chunk.XXXXXX")"
  if ! capture_output_file "$chunk" "$label" "$allowed_status" "$@"; then
    rm -f "$chunk"
    return 1
  fi
  cat "$chunk" >>"$output"
  rm -f "$chunk"
}

serialize_safe_untracked_file() {
  local repo="$1"
  local relative_path="$2"
  (
    cd "$repo"
    run_attested_helper --serialize-untracked-file "$relative_path"
  )
}

capture_untracked_files() {
  local repo="$1"
  local paths_file="$2"
  local output="$3"
  local untracked_path
  : >"$output"
  while IFS= read -r untracked_path; do
    [[ -z "$untracked_path" ]] && continue
    if [[ -L "$repo/$untracked_path" ]]; then
      echo "agent:autoreview: refusing symlinked untracked file: $untracked_path" >&2
      return 1
    fi
    if [[ -f "$repo/$untracked_path" ]]; then
      capture_append_output "$output" "untracked file $untracked_path" 0 \
        serialize_safe_untracked_file "$repo" "$untracked_path"
    else
      capture_append_output "$output" "untracked non-file $untracked_path" 0 \
        printf 'untracked non-file omitted: %s\n' "$untracked_path"
    fi
  done <"$paths_file"
}

emit_validated_git_path_lines() {
  local path
  while IFS= read -r -d '' path; do
    if [[
      "$path" == *$'\t'* ||
        "$path" == *$'\r'* ||
        "$path" == *$'\n'*
    ]]; then
      echo "agent:autoreview: changed paths containing tabs or line breaks are unsupported; rename the path before autoreview" >&2
      return 1
    fi
    printf '%s\n' "$path"
  done
}

emit_untracked_paths() {
  local repo="$1"
  git_output "$repo" ls-files --others --exclude-standard -z |
    emit_validated_git_path_lines |
    LC_ALL=C sort -u
}

emit_local_changed_paths() {
  local repo="$1"
  local head_oid="$2"
  {
    git_output "$repo" diff --name-only -z --cached "$head_oid" --
    git_output "$repo" diff --name-only -z
    git_output "$repo" ls-files --others --exclude-standard -z
  } | emit_validated_git_path_lines | LC_ALL=C sort -u
}

emit_branch_local_changed_paths() {
  local repo="$1"
  local target_ref="$2"
  local head_oid="$3"
  {
    git_output "$repo" diff --name-only -z "$target_ref...$head_oid" --
    git_output "$repo" diff --name-only -z --cached "$head_oid" --
    git_output "$repo" diff --name-only -z
    git_output "$repo" ls-files --others --exclude-standard -z
  } | emit_validated_git_path_lines | LC_ALL=C sort -u
}

emit_branch_changed_paths() {
  local repo="$1"
  local target_ref="$2"
  local head_oid="$3"
  git_output "$repo" diff --name-only -z "$target_ref...$head_oid" -- |
    emit_validated_git_path_lines |
    LC_ALL=C sort -u
}

emit_commit_changed_paths() {
  local repo="$1"
  local target_ref="$2"
  git_output "$repo" show --name-only --format= -z --end-of-options "$target_ref" -- |
    emit_validated_git_path_lines |
    LC_ALL=C sort -u
}

add_checklist() {
  local repo="$1"
  local rel_path="$2"
  local source_ref="$3"
  shift 3

  if [[ -n "$source_ref" ]]; then
    if ! git_output "$repo" cat-file -e "${source_ref}:${rel_path}" 2>/dev/null; then
      return 0
    fi
  elif [[ ! -f "$repo/$rel_path" ]]; then
    return 0
  fi

  local existing
  for existing in "$@"; do
    if [[ "$existing" == "$rel_path" ]]; then
      return 1
    fi
  done

  printf '%s\n' "$rel_path"
}

select_checklists() {
  local repo="$1"
  local changed_paths_file="$2"
  local source_ref="$3"
  local checklists=()
  local candidate
  local path

  candidate="$(add_checklist "$repo" "docs/pr-checklists/recurring-review-patterns.md" "$source_ref" "${checklists[@]+"${checklists[@]}"}" || true)"
  [[ -n "$candidate" ]] && checklists+=("$candidate")
  candidate="$(add_checklist "$repo" "docs/pr-checklists/review-prompt-exclusions.md" "$source_ref" "${checklists[@]+"${checklists[@]}"}" || true)"
  [[ -n "$candidate" ]] && checklists+=("$candidate")

  while IFS= read -r path; do
    [[ -z "$path" ]] && continue

    case "$path" in
      .github/workflows/*)
        candidate="$(add_checklist "$repo" "docs/pr-checklists/ci-workflow-gates.md" "$source_ref" "${checklists[@]+"${checklists[@]}"}" || true)"
        [[ -n "$candidate" ]] && checklists+=("$candidate")
        ;;
    esac

    case "$path" in
      package.json|pnpm-lock.yaml|pnpm-workspace.yaml|.npmrc|patches/*|.dependency-cruiser.cjs|eslint.config.mjs|scripts/*)
        candidate="$(add_checklist "$repo" "docs/pr-checklists/code-health.md" "$source_ref" "${checklists[@]+"${checklists[@]}"}" || true)"
        [[ -n "$candidate" ]] && checklists+=("$candidate")
        ;;
    esac

    case "$path" in
      indexer-envio/*|metrics-bridge/*|ui-dashboard/src/*)
        candidate="$(add_checklist "$repo" "docs/pr-checklists/stateful-data-ui.md" "$source_ref" "${checklists[@]+"${checklists[@]}"}" || true)"
        [[ -n "$candidate" ]] && checklists+=("$candidate")
        ;;
    esac

    case "$path" in
      indexer-envio/*)
        candidate="$(add_checklist "$repo" "docs/pr-checklists/indexer-handler-invariants.md" "$source_ref" "${checklists[@]+"${checklists[@]}"}" || true)"
        [[ -n "$candidate" ]] && checklists+=("$candidate")
        ;;
    esac

    case "$path" in
      ui-dashboard/src/*)
        candidate="$(add_checklist "$repo" "docs/pr-checklists/swr-polling-hasura.md" "$source_ref" "${checklists[@]+"${checklists[@]}"}" || true)"
        [[ -n "$candidate" ]] && checklists+=("$candidate")
        ;;
    esac

    case "$path" in
      ui-dashboard/src/app/*|ui-dashboard/src/components/*)
        candidate="$(add_checklist "$repo" "docs/pr-checklists/keyboard-a11y-controlled-widgets.md" "$source_ref" "${checklists[@]+"${checklists[@]}"}" || true)"
        [[ -n "$candidate" ]] && checklists+=("$candidate")
        ;;
    esac

    case "$path" in
      ui-dashboard/src/app/*)
        candidate="$(add_checklist "$repo" "docs/pr-checklists/dynamic-route-metadata.md" "$source_ref" "${checklists[@]+"${checklists[@]}"}" || true)"
        [[ -n "$candidate" ]] && checklists+=("$candidate")
        ;;
    esac

    case "$path" in
      terraform/*|aegis/terraform/*|alerts/rules/*|scripts/deploy-*.sh)
        candidate="$(add_checklist "$repo" "docs/pr-checklists/terraform-cloudrun.md" "$source_ref" "${checklists[@]+"${checklists[@]}"}" || true)"
        [[ -n "$candidate" ]] && checklists+=("$candidate")
        ;;
    esac

    case "$path" in
      *stryker*|.github/workflows/mutation-testing.yml|docs/mutation-testing.md)
        candidate="$(add_checklist "$repo" "docs/pr-checklists/mutation-testing.md" "$source_ref" "${checklists[@]+"${checklists[@]}"}" || true)"
        [[ -n "$candidate" ]] && checklists+=("$candidate")
        ;;
    esac
  done < "$changed_paths_file"

  if [[ "${#checklists[@]}" -gt 0 ]]; then
    printf '%s\n' "${checklists[@]}"
  fi
}

prepare_context_bundle() {
  local bundle_dir="$1"
  local pr_number="$2"
  shift 2
  review_capture_bytes=0

  if has_dry_run "$@"; then
    echo "agent:autoreview: --dry-run cannot be combined with --prepare-bundle-dir; prepared bundles must complete content validation" >&2
    exit 2
  fi

  local repo
  repo="$(git_output "$(pwd -P)" rev-parse --show-toplevel)"
  local repo_abs
  local bundle_parent
  local bundle_name
  local bundle_suffix
  local bundle_ancestor
  local bundle_parent_identity
  local staging_identity
  local expected_bundle_manifest
  local pre_helper_evidence_manifest
  local post_helper_evidence_manifest
  local pre_snapshot_bundle_manifest
  local post_snapshot_bundle_manifest
  repo_abs="$(cd "$repo" && pwd -P)"
  if [[ "$repo_abs" != "$checkout_root" ]]; then
    echo "agent:autoreview: git resolved a different worktree than the physical checkout" >&2
    exit 1
  fi
  case "$bundle_dir" in
    /*) ;;
    *) bundle_dir="$(pwd -P)/$bundle_dir" ;;
  esac
  bundle_parent="$(dirname "$bundle_dir")"
  bundle_name="$(basename "$bundle_dir")"
  bundle_suffix="$bundle_name"
  bundle_ancestor="$bundle_parent"
  while [[ ! -e "$bundle_ancestor" ]]; do
    bundle_suffix="$(basename "$bundle_ancestor")/$bundle_suffix"
    bundle_ancestor="$(dirname "$bundle_ancestor")"
  done
  if [[ ! -d "$bundle_ancestor" ]]; then
    echo "agent:autoreview: --prepare-bundle-dir parent is not a directory" >&2
    exit 2
  fi
  bundle_parent="$(cd "$bundle_ancestor" && pwd -P)"
  bundle_dir="$bundle_parent/$bundle_suffix"
  if [[ -L "$bundle_dir" ]]; then
    echo "agent:autoreview: --prepare-bundle-dir must not be a symlink" >&2
    exit 2
  fi
  case "$bundle_dir/" in
    "$repo_abs"/*)
      echo "agent:autoreview: --prepare-bundle-dir must be outside the repo worktree" >&2
      exit 2
      ;;
  esac
  if [[ "$bundle_suffix" == */* ]]; then
    echo "agent:autoreview: --prepare-bundle-dir parent must already exist" >&2
    exit 2
  fi
  if [[ -d "$bundle_dir" && -n "$(find "$bundle_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    echo "agent:autoreview: --prepare-bundle-dir must be empty or absent" >&2
    exit 2
  fi
  if has_bundle_output "$@"; then
    echo "agent:autoreview: --bundle-output cannot be combined with --prepare-bundle-dir; use the prompt inside the prepared bundle" >&2
    exit 2
  fi
  if [[ -e "$bundle_dir" && ! -d "$bundle_dir" ]]; then
    echo "agent:autoreview: --prepare-bundle-dir must be a directory path" >&2
    exit 2
  fi
  if [[ -d "$bundle_dir" ]]; then
    rmdir "$bundle_dir"
  fi
  if ! assert_safe_bundle_parent_ancestry "$bundle_parent"; then
    echo "agent:autoreview: --prepare-bundle-dir parent ancestry is unsafe" >&2
    exit 2
  fi
  # The single-quoted string is JavaScript source, not shell interpolation.
  # shellcheck disable=SC2016
  bundle_parent_identity="$(
    run_trusted_node -e '
      const fs = require("node:fs");
      const stat = fs.lstatSync(process.argv[1], { bigint: true });
      if (
        fs.realpathSync(process.argv[1]) !== process.argv[1] ||
        !stat.isDirectory() ||
        stat.isSymbolicLink()
      ) {
        process.exit(1);
      }
      process.stdout.write(`${stat.dev}:${stat.ino}\n`);
    ' "$bundle_parent"
  )"
  prepare_staging_dir="$(mktemp -d "$bundle_parent/.agent-autoreview-context.XXXXXX")"
  local staging_dir="$prepare_staging_dir"
  staging_identity="$(path_identity "$staging_dir")"
  prepare_staging_identity="$staging_identity"
  mkdir -p "$staging_dir/checklists"
  mkdir -p "$staging_dir/patches"

  local mode
  local target_mode
  local target_ref=""
  local target_display_ref=""
  local source_snapshot_before
  local source_snapshot_after
  local target_selection_source_snapshot
  local target_selection_snapshot_after
  local branch
  local explicit_base
  local pr_record=""
  local detected_pr_base=""
  local detected_pr_number=""
  local frozen_repository_slug=""
  local feedback_pr_was_auto=0
  local expected_feedback_head_oid=""
  local frozen_branch=""
  local frozen_dirty=0
  local frozen_head_oid=""
  local trusted_helper_runtime_dir=""
  local trusted_helper_runtime_identity=""
  local trusted_helper_runtime_ref=""
  local external_runtime_source_snapshot=""
  local external_runtime_source_snapshot_after=""
  local protected_main_ref
  mode="$(arg_value --mode auto "$@")"
  target_selection_source_snapshot="$(target_selection_snapshot "$repo")"
  parse_target_selection_state "$target_selection_source_snapshot"
  branch="$frozen_branch"
  explicit_base="$(arg_value --base "" "$@")"
  if [[ "$pr_number" == "auto" ]]; then
    feedback_pr_was_auto=1
  fi
  if [[ "$pr_number" == "auto" && "$mode" == "commit" ]]; then
    echo "agent:autoreview: --feedback-pr auto cannot be combined with --mode commit; pass the PR number explicitly" >&2
    exit 2
  fi
  if [[ "$pr_number" == "auto" && -n "$explicit_base" ]]; then
    echo "agent:autoreview: --feedback-pr auto cannot be combined with an explicit --base; pass the PR number explicitly" >&2
    exit 2
  fi
  if [[
    "$pr_number" == "auto" ||
      (
        -z "$explicit_base" &&
          (
            "$mode" == "branch" ||
              ( "$mode" == "auto" && -n "$branch" && "$branch" != "main" )
          )
      )
  ]]; then
    if ! pr_record="$(detect_unique_pr_record "$repo" "$branch")"; then
      return 1
    fi
    if [[ -n "$pr_record" ]]; then
      if [[ "$pr_record" != *$'\t'* ]]; then
        echo "agent:autoreview: failed to inspect PR metadata: missing record separator" >&2
        return 1
      fi
      detected_pr_base="${pr_record%%$'\t'*}"
      pr_record="${pr_record#*$'\t'}"
      if [[ "$pr_record" != *$'\t'* ]]; then
        echo "agent:autoreview: failed to inspect PR metadata: missing repository identity" >&2
        return 1
      fi
      detected_pr_number="${pr_record%%$'\t'*}"
      frozen_repository_slug="${pr_record#*$'\t'}"
    fi
  fi
  if [[ "$pr_number" == "auto" && -z "$pr_record" ]]; then
    echo "agent:autoreview: --feedback-pr auto requires exactly one open PR for the frozen head branch" >&2
    return 1
  fi

  case "$mode" in
    local)
      target_mode="local"
      ;;
    commit)
      target_mode="commit"
      target_ref="$(arg_value --commit HEAD "$@")"
      ;;
    branch)
      target_mode="branch"
      target_ref="$(branch_base_ref "$detected_pr_base" "$@")"
      ;;
    auto)
      if [[ -n "$branch" && "$branch" != "main" ]]; then
        target_ref="$(branch_base_ref "$detected_pr_base" "$@")"
        if [[ "$frozen_dirty" -eq 1 ]]; then
          target_mode="branch-local"
        else
          target_mode="branch"
        fi
      elif [[ "$frozen_dirty" -eq 1 ]]; then
        target_mode="local"
      else
        echo "agent:autoreview: no review target: clean main checkout and no forced mode" >&2
        exit 2
      fi
      ;;
    *)
      echo "agent:autoreview: unsupported --mode for bundle prep: $mode" >&2
      exit 2
      ;;
  esac

  if [[ -n "$target_ref" ]]; then
    target_display_ref="$target_ref"
    if [[ "$target_ref" == "HEAD" ]]; then
      target_ref="$frozen_head_oid"
    elif ! target_ref="$(git_output "$repo" rev-parse --verify --end-of-options "${target_ref}^{commit}")"; then
      echo "agent:autoreview: review ref does not resolve to a commit: $target_display_ref" >&2
      exit 2
    fi
    if [[ ! "$target_ref" =~ ^[0-9a-fA-F]{40,64}$ ]]; then
      echo "agent:autoreview: review ref did not resolve to an object ID: $target_display_ref" >&2
      exit 2
    fi
  fi
  if ! protected_main_ref="$(pin_protected_main_ref "$repo")"; then
    return 1
  fi
  if [[ "$repo_abs" == "$repo_root" && "$helper" == "$default_helper" ]]; then
    verify_current_wrapper_matches_ref "$repo" "$frozen_head_oid"
    verify_autoreview_runtime_matches_baseline \
      "$repo" \
      "$protected_main_ref" \
      "$frozen_head_oid"
    case "$target_mode" in
      local)
        verify_current_helper_matches_ref "$repo" "$frozen_head_oid"
        ;;
      branch-local)
        verify_current_helper_matches_ref "$repo" "$frozen_head_oid"
        ;;
      commit)
        verify_autoreview_runtime_matches_baseline \
          "$repo" \
          "$protected_main_ref" \
          "$target_ref"
        ;;
    esac
    trusted_helper_runtime_ref="$protected_main_ref"
    trusted_helper_runtime_dir="$staging_dir/trusted-autoreview-runtime"
    mkdir "$trusted_helper_runtime_dir"
    trusted_helper_runtime_identity="$(path_identity "$trusted_helper_runtime_dir")"
    materialize_trusted_autoreview_runtime \
      "$repo" \
      "$trusted_helper_runtime_ref" \
      "$trusted_helper_runtime_dir"
    prepared_helper_override="$trusted_helper_runtime_dir/scripts/agent-autoreview.mjs"
  fi
  if [[
    -z "$prepared_helper_override" &&
      ( "$helper" != "$default_helper" || "$repo_abs" != "$repo_root" )
  ]]; then
    attested_helper_runtime_dir="$({
      /usr/bin/mktemp -d \
        "$command_runtime_dir/attested-autoreview-runtime.XXXXXX"
    } 2>/dev/null)" || attested_helper_runtime_dir=""
    if [[
      -z "$attested_helper_runtime_dir" ||
        ! -d "$attested_helper_runtime_dir" ||
        -L "$attested_helper_runtime_dir"
    ]]; then
      echo "agent:autoreview: failed to create a private wrapper-attested helper runtime" >&2
      return 1
    fi
    /bin/chmod 0700 "$attested_helper_runtime_dir"
    attested_helper_runtime_identity="$(path_identity "$attested_helper_runtime_dir")"
    if [[ "$repo_abs" == "$repo_root" ]]; then
      if ! verify_current_wrapper_matches_ref \
        "$repo" \
        "$protected_main_ref" ||
        ! materialize_trusted_autoreview_runtime \
          "$repo" \
          "$protected_main_ref" \
          "$attested_helper_runtime_dir"; then
        cat >&2 <<'EOF'
agent:autoreview: cannot attest an explicit helper from the runtime-changing owning checkout.
Prepare this review from a separate trusted checkout and invoke that checkout's compatible wrapper and helper.
EOF
        return 1
      fi
    else
      case "$repo_root" in
        "$repo_abs"/*)
          cat >&2 <<'EOF'
agent:autoreview: an explicit-helper trusted wrapper must be outside the reviewed checkout.
Prepare this review from a separate trusted checkout and invoke that checkout's compatible wrapper and helper.
EOF
          return 1
          ;;
      esac
      if ! external_runtime_source_snapshot="$(
        wrapper_runtime_source_snapshot "$script_dir"
      )" ||
        ! wrapper_runtime_source_acl_is_trusted "$script_dir" ||
        ! external_runtime_source_snapshot_after="$(
          wrapper_runtime_source_snapshot "$script_dir"
        )" ||
        [[ "$external_runtime_source_snapshot_after" != "$external_runtime_source_snapshot" ]]; then
        echo "agent:autoreview: external wrapper runtime source has unsafe ACL, ancestry, or identity state" >&2
        return 1
      fi
      if ! materialize_filesystem_autoreview_runtime \
        "$script_dir" \
        "$attested_helper_runtime_dir"; then
        echo "agent:autoreview: failed to copy the pinned external wrapper runtime source" >&2
        return 1
      fi
      if ! external_runtime_source_snapshot_after="$(
        wrapper_runtime_source_snapshot "$script_dir"
      )" ||
        [[ "$external_runtime_source_snapshot_after" != "$external_runtime_source_snapshot" ]] ||
        ! wrapper_runtime_source_acl_is_trusted "$script_dir" ||
        ! external_runtime_source_snapshot_after="$(
          wrapper_runtime_source_snapshot "$script_dir"
        )" ||
        [[ "$external_runtime_source_snapshot_after" != "$external_runtime_source_snapshot" ]]; then
        echo "agent:autoreview: external wrapper runtime source changed during ACL validation or copying" >&2
        return 1
      fi
    fi
    attested_helper_override="$attested_helper_runtime_dir/scripts/agent-autoreview.mjs"
    if ! attested_helper_runtime_manifest="$(
      bundle_content_manifest \
        "$attested_helper_runtime_dir" \
        "$attested_helper_runtime_identity"
    )"; then
      echo "agent:autoreview: failed to seal the wrapper-attested helper runtime" >&2
      return 1
    fi
  fi
  target_selection_snapshot_after="$(target_selection_snapshot "$repo")"
  if [[ "$target_selection_snapshot_after" != "$target_selection_source_snapshot" ]]; then
    echo "agent:autoreview: source changed while the review target was being selected; rerun autoreview" >&2
    exit 1
  fi
  source_snapshot_before="$(source_snapshot "$repo" "$target_mode")"
  target_selection_snapshot_after="$(target_selection_snapshot "$repo")"
  if [[ "$target_selection_snapshot_after" != "$target_selection_source_snapshot" ]]; then
    echo "agent:autoreview: source changed while the review target was being selected; rerun autoreview" >&2
    exit 1
  fi

  case "$target_mode" in
    local)
      capture_output_file "$staging_dir/git-status.txt" "git status" 0 \
        git_output "$repo" status --short
      capture_output_file "$staging_dir/changed-paths.txt" "changed paths" 0 \
        emit_local_changed_paths "$repo" "$frozen_head_oid"
      capture_output_file "$staging_dir/patches/staged.stat" "staged diff stat" 0 \
        git_output "$repo" diff --cached --stat --no-ext-diff --no-textconv "$frozen_head_oid" --
      capture_output_file "$staging_dir/patches/staged.diff" "staged diff" 0 \
        git_output "$repo" diff --cached --patch --no-renames --no-ext-diff --no-textconv "$frozen_head_oid" --
      capture_output_file "$staging_dir/patches/unstaged.stat" "unstaged diff stat" 0 \
        git_output "$repo" diff --stat --no-ext-diff --no-textconv
      capture_output_file "$staging_dir/patches/unstaged.diff" "unstaged diff" 0 \
        git_output "$repo" diff --patch --no-renames --no-ext-diff --no-textconv
      capture_output_file "$staging_dir/patches/untracked-paths.txt" "untracked paths" 0 \
        emit_untracked_paths "$repo"
      capture_untracked_files \
        "$repo" \
        "$staging_dir/patches/untracked-paths.txt" \
        "$staging_dir/patches/untracked.diff"
      ;;
    branch)
      capture_output_file "$staging_dir/changed-paths.txt" "changed paths" 0 \
        emit_branch_changed_paths "$repo" "$target_ref" "$frozen_head_oid"
      capture_output_file "$staging_dir/patches/branch.stat" "branch diff stat" 0 \
        git_output "$repo" diff --stat --no-ext-diff --no-textconv "$target_ref...$frozen_head_oid" --
      capture_output_file "$staging_dir/patches/branch.diff" "branch diff" 0 \
        git_output "$repo" diff --patch --no-renames --no-ext-diff --no-textconv "$target_ref...$frozen_head_oid" --
      ;;
    branch-local)
      capture_output_file "$staging_dir/git-status.txt" "git status" 0 \
        git_output "$repo" status --short
      capture_output_file "$staging_dir/changed-paths.txt" "changed paths" 0 \
        emit_branch_local_changed_paths "$repo" "$target_ref" "$frozen_head_oid"
      capture_output_file "$staging_dir/patches/branch.stat" "branch diff stat" 0 \
        git_output "$repo" diff --stat --no-ext-diff --no-textconv "$target_ref...$frozen_head_oid" --
      capture_output_file "$staging_dir/patches/branch.diff" "branch diff" 0 \
        git_output "$repo" diff --patch --no-renames --no-ext-diff --no-textconv "$target_ref...$frozen_head_oid" --
      capture_output_file "$staging_dir/patches/staged.stat" "staged diff stat" 0 \
        git_output "$repo" diff --cached --stat --no-ext-diff --no-textconv "$frozen_head_oid" --
      capture_output_file "$staging_dir/patches/staged.diff" "staged diff" 0 \
        git_output "$repo" diff --cached --patch --no-renames --no-ext-diff --no-textconv "$frozen_head_oid" --
      capture_output_file "$staging_dir/patches/unstaged.stat" "unstaged diff stat" 0 \
        git_output "$repo" diff --stat --no-ext-diff --no-textconv
      capture_output_file "$staging_dir/patches/unstaged.diff" "unstaged diff" 0 \
        git_output "$repo" diff --patch --no-renames --no-ext-diff --no-textconv
      capture_output_file "$staging_dir/patches/untracked-paths.txt" "untracked paths" 0 \
        emit_untracked_paths "$repo"
      capture_untracked_files \
        "$repo" \
        "$staging_dir/patches/untracked-paths.txt" \
        "$staging_dir/patches/untracked.diff"
      ;;
    commit)
      capture_output_file "$staging_dir/changed-paths.txt" "changed paths" 0 \
        emit_commit_changed_paths "$repo" "$target_ref"
      capture_output_file "$staging_dir/patches/commit.stat" "commit diff stat" 0 \
        git_output "$repo" show --stat --no-ext-diff --no-textconv --format=fuller "$target_ref"
      capture_output_file "$staging_dir/patches/commit.diff" "commit diff" 0 \
        git_output "$repo" show --patch --no-renames --no-ext-diff --no-textconv --format=fuller "$target_ref"
      ;;
  esac

  local selected_checklists=()
  local checklist
  while IFS= read -r checklist; do
    [[ -z "$checklist" ]] && continue
    selected_checklists+=("$checklist")
  done < <(
    select_checklists \
      "$repo" \
      "$staging_dir/changed-paths.txt" \
      "$protected_main_ref"
  )
  local helper_args=("$@")
  helper_args+=(--trusted-input-root "$staging_dir")
  if [[ "$helper" == "$default_helper" || -n "$prepared_helper_override" ]]; then
    helper_args+=(
      --frozen-target-mode "$target_mode"
      --frozen-head-oid "$frozen_head_oid"
    )
  fi
  case "$target_mode" in
    branch | branch-local)
      helper_args+=(--base "$target_ref")
      ;;
    commit)
      helper_args+=(--commit "$target_ref")
      ;;
  esac
  local captured_checklist
  local captured_checklist_mode
  for checklist in "${selected_checklists[@]+"${selected_checklists[@]}"}"; do
    if ! captured_checklist_mode="$(
      git_blob_mode "$repo" "$protected_main_ref" "$checklist"
    )" ||
      [[
        "$captured_checklist_mode" != "100644" &&
          "$captured_checklist_mode" != "100755"
      ]]; then
      echo "agent:autoreview: protected-main checklist is not a regular Git blob: $checklist" >&2
      return 1
    fi
    captured_checklist="$staging_dir/checklists/$(basename "$checklist")"
    capture_output_file "$captured_checklist" "checklist $checklist" 0 \
      git_output "$repo" cat-file blob \
        "${protected_main_ref}:${checklist}"
    helper_args+=(--prompt-file "$captured_checklist")
  done
  if [[ "${#selected_checklists[@]}" -gt 0 ]]; then
    printf '%s\n' "${selected_checklists[@]}" >"$staging_dir/selected-checklists.txt"
  else
    : >"$staging_dir/selected-checklists.txt"
  fi

  if [[ "$pr_number" == "auto" ]]; then
    pr_number="$detected_pr_number"
  fi

  if [[ -n "$pr_number" && "$pr_number" != "none" ]]; then
    local feedback_runtime_dir="$staging_dir/trusted-feedback-runtime"
    local feedback_runtime_identity
    local repository_slug="$frozen_repository_slug"
    if [[ -z "$repository_slug" ]]; then
      if ! repository_slug="$(github_repository_slug "$repo")"; then
        echo "agent:autoreview: PR feedback capture requires a canonical github.com origin remote" >&2
        return 1
      fi
    fi
    mkdir "$feedback_runtime_dir"
    feedback_runtime_identity="$(path_identity "$feedback_runtime_dir")"
    materialize_feedback_runtime \
      "$repo" \
      "$protected_main_ref" \
      "$feedback_runtime_dir"
    capture_output_file "$staging_dir/feedback-state.json" "PR feedback state" 0 \
      capture_feedback_state "$repo" "$feedback_runtime_dir" "$pr_number" "$repository_slug"
    if ! safe_remove_tree \
      "$feedback_runtime_dir" \
      "$feedback_runtime_identity" \
      "trusted feedback runtime"; then
      return 1
    fi
    if [[ "$feedback_pr_was_auto" -eq 1 ]]; then
      expected_feedback_head_oid="$frozen_head_oid"
      validate_auto_feedback_state \
        "$staging_dir/feedback-state.json" \
        "$pr_number" \
        "$detected_pr_base" \
        "$branch" \
        "$expected_feedback_head_oid"
    fi
    helper_args+=(
      --dataset "$staging_dir/feedback-state.json"
    )
  fi

  helper_args+=(
    --bundle-output "$staging_dir/autoreview-prompt.md"
    --bundle-output-display "$bundle_dir/autoreview-prompt.md"
  )
  if ! has_prepare_only "${helper_args[@]+"${helper_args[@]}"}"; then
    helper_args+=(--prepare-only)
  fi

  {
    printf '# Autoreview Context Bundle\n\n'
    printf -- '- Target: %s' "$target_mode"
    if [[ -n "$target_display_ref" ]]; then
      printf ' %s' "$target_display_ref"
    fi
    printf '\n'
    case "$target_mode" in
      branch | branch-local)
        printf -- '- Frozen base commit: %s\n' "$target_ref"
        printf -- '- Frozen reviewed HEAD: %s\n' "$frozen_head_oid"
        ;;
      commit)
        printf -- '- Frozen reviewed commit: %s\n' "$target_ref"
        ;;
      local)
        printf -- '- Frozen reviewed HEAD: %s\n' "$frozen_head_oid"
        ;;
    esac
    printf -- '- Branch: %s\n' "${branch:-detached}"
    printf -- '- Generated: %s\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '## Contents\n\n'
    printf '%s\n' "- \`changed-paths.txt\`: changed files for the selected target."
    printf '%s\n' "- \`patches/\`: stat and patch files for read-only review."
    printf '%s\n' "- \`checklists/\`: checklist policy copied from the protected origin/main snapshot."
    printf '%s\n' "- \`selected-checklists.txt\`: source paths for the copied checklists."
    printf '%s\n' "- \`autoreview-prompt.md\`: full prompt emitted by the autoreview helper."
    printf '%s\n' "- \`helper-output.txt\`: helper metadata whose artifact paths identify this published bundle."
    printf '%s\n' "- \`.agent-autoreview-complete\`: final marker binding the published evidence manifest."
    if [[ -f "$staging_dir/feedback-state.json" ]]; then
      printf '%s\n' "- \`feedback-state.json\`: \`pr:feedback-state\` ledger for PR #$pr_number."
    fi
    printf '\n## Verification\n\n'
    printf 'Before review, run the same trusted wrapper that produced this bundle:\n\n'
    printf '```bash\n'
    printf '%q --verify-bundle-dir %q\n' \
      "$script_dir/agent-autoreview.sh" \
      "$bundle_dir"
    printf '```\n\n'
    printf 'Retain its manifest digest outside this bundle. After reading every pass, run:\n\n'
    printf '```bash\n'
    printf '%q --verify-bundle-dir %q --expected-bundle-manifest %q\n' \
      "$script_dir/agent-autoreview.sh" \
      "$bundle_dir" \
      '<retained-digest>'
    printf '```\n\n'
    printf 'External helpers must leave no background writer behind; these checks do not create OS-level immutability against a malicious same-UID process that mutates and restores evidence between checks.\n'
  } >"$staging_dir/README.md"

  if ! pre_helper_evidence_manifest="$(
    bundle_content_manifest \
      "$staging_dir" \
      "$staging_identity" \
      "autoreview-prompt.md" \
      "autoreview-prompt.pass-*.md" \
      "helper-output.txt"
  )"; then
    echo "agent:autoreview: failed to freeze wrapper-owned prepared-bundle evidence before helper execution" >&2
    return 1
  fi
  if [[ "$helper" != "$default_helper" && -z "$prepared_helper_override" ]]; then
    # The wrapper-owned snapshot, serialization, feedback, and staging-runtime
    # cleanup has finished. An explicit helper is the final untrusted handoff;
    # after it runs no recursive cleanup may resolve same-UID-controlled paths.
    untrusted_helper_exposed=1
  fi
  (cd "$repo" && run_helper "${helper_args[@]+"${helper_args[@]}"}") \
    >"$staging_dir/helper-output.txt"
  if ! post_helper_evidence_manifest="$(
    bundle_content_manifest \
      "$staging_dir" \
      "$staging_identity" \
      "autoreview-prompt.md" \
      "autoreview-prompt.pass-*.md" \
      "helper-output.txt"
  )"; then
    echo "agent:autoreview: helper changed wrapper-owned prepared-bundle evidence" >&2
    return 1
  fi
  if [[ "$post_helper_evidence_manifest" != "$pre_helper_evidence_manifest" ]]; then
    echo "agent:autoreview: helper changed wrapper-owned prepared-bundle evidence" >&2
    return 1
  fi
  validate_prepared_prompt_outputs "$staging_dir"
  if ! pre_snapshot_bundle_manifest="$(
    bundle_content_manifest "$staging_dir" "$staging_identity"
  )"; then
    echo "agent:autoreview: prepared-bundle evidence changed before final source validation" >&2
    return 1
  fi
  source_snapshot_after="$(source_snapshot "$repo" "$target_mode")"
  target_selection_snapshot_after="$(target_selection_snapshot "$repo")"
  if ! post_snapshot_bundle_manifest="$(
    bundle_content_manifest "$staging_dir" "$staging_identity"
  )"; then
    echo "agent:autoreview: prepared-bundle evidence changed during final source validation" >&2
    return 1
  fi
  if [[ "$post_snapshot_bundle_manifest" != "$pre_snapshot_bundle_manifest" ]]; then
    echo "agent:autoreview: prepared-bundle evidence changed during final source validation" >&2
    return 1
  fi
  if [[
    "$source_snapshot_after" != "$source_snapshot_before" ||
      (
        "$mode" == "auto" &&
          "$target_selection_snapshot_after" != "$target_selection_source_snapshot"
      )
  ]]; then
    echo "agent:autoreview: source changed while the prepared bundle was being created; rerun autoreview" >&2
    exit 1
  fi
  validate_prepared_prompt_outputs "$staging_dir"
  if [[ -n "$trusted_helper_runtime_dir" ]]; then
    if ! safe_remove_tree \
      "$trusted_helper_runtime_dir" \
      "$trusted_helper_runtime_identity" \
      "trusted helper runtime"; then
      return 1
    fi
    trusted_helper_runtime_dir=""
    trusted_helper_runtime_identity=""
    prepared_helper_override=""
  fi
  if ! expected_bundle_manifest="$(
    bundle_content_manifest "$staging_dir" "$staging_identity"
  )"; then
    echo "agent:autoreview: prepared-bundle staging changed before publication" >&2
    return 1
  fi
  publish_bundle_with_reservation \
    "$staging_dir" \
    "$bundle_dir" \
    "$bundle_parent" \
    "$bundle_parent_identity" \
    "$staging_identity" \
    "$expected_bundle_manifest"
  prepare_staging_dir=""
  prepare_staging_identity=""
  verify_context_bundle "$bundle_dir" "$expected_bundle_manifest" >/dev/null
  cat "$bundle_dir/helper-output.txt"
  printf 'agent:autoreview context bundle: %s\n' "$bundle_dir"
}

if [[ -n "$verify_bundle_dir" ]]; then
  verify_context_bundle "$verify_bundle_dir" "$verify_expected_manifest"
  exit 0
fi

if [[ -n "$prepare_bundle_dir" ]]; then
  prepare_context_bundle "$prepare_bundle_dir" "$feedback_pr" "$@"
  exit 0
fi

if running_inside_codex_sandbox && ! has_explicit_engine "$@" && ! has_prepare_only "$@"; then
  cat >&2 <<EOF
agent:autoreview: detected Codex sandbox; defaulting to --engine local because nested codex exec is unavailable here.
agent:autoreview: pass --engine codex, --engine claude, or AUTOREVIEW_ENGINE to override.
EOF
  set -- --engine local "$@"
fi

if [[ "$helper" == "$default_helper" ]]; then
  direct_repo="$(
    git_output "$(pwd -P)" rev-parse --show-toplevel 2>/dev/null || true
  )"
  if [[ -n "$direct_repo" ]]; then
    direct_repo_abs="$(cd "$direct_repo" && pwd -P)"
    if [[ "$direct_repo_abs" == "$repo_root" ]]; then
      direct_source_snapshot="$(target_selection_snapshot "$direct_repo")"
      parse_target_selection_state "$direct_source_snapshot"
      direct_protected_main_ref="$(pin_protected_main_ref "$direct_repo")"
      verify_current_wrapper_matches_ref "$direct_repo" "$frozen_head_oid"
      verify_autoreview_runtime_matches_baseline \
        "$direct_repo" \
        "$direct_protected_main_ref" \
        "$frozen_head_oid"
      verify_current_helper_matches_ref "$direct_repo" "$frozen_head_oid"
      direct_helper_runtime_dir="$(
        /usr/bin/mktemp -d \
          "$trusted_temp_root/agent-autoreview-direct.XXXXXX" \
          2>/dev/null || true
      )"
      if [[
        -z "$direct_helper_runtime_dir" ||
          ! -d "$direct_helper_runtime_dir" ||
          -L "$direct_helper_runtime_dir"
      ]]; then
        echo "agent:autoreview: failed to create a private direct-helper runtime" >&2
        exit 127
      fi
      /bin/chmod 0700 "$direct_helper_runtime_dir"
      direct_helper_runtime_identity="$(path_identity "$direct_helper_runtime_dir")"
      if ! path_acl_is_trusted "$direct_helper_runtime_dir"; then
        echo "agent:autoreview: failed to create an ACL-private direct-helper runtime" >&2
        exit 127
      fi
      materialize_trusted_autoreview_runtime \
        "$direct_repo" \
        "$direct_protected_main_ref" \
        "$direct_helper_runtime_dir"
      prepared_helper_override="$direct_helper_runtime_dir/scripts/agent-autoreview.mjs"
      direct_status=0
      direct_helper_runtime_current_identity="$(
        path_identity "$direct_helper_runtime_dir" 2>/dev/null || true
      )"
      if [[
        -z "$direct_helper_runtime_current_identity" ||
          "$direct_helper_runtime_current_identity" != "$direct_helper_runtime_identity"
      ]]; then
        echo "agent:autoreview: direct helper runtime identity changed before launch" >&2
        direct_status=1
      else
        (cd "$direct_repo" && run_helper "$@") || direct_status=$?
      fi
      if ! safe_remove_tree \
        "$direct_helper_runtime_dir" \
        "$direct_helper_runtime_identity" \
        "direct helper runtime"; then
        direct_status=1
      fi
      direct_helper_runtime_dir=""
      direct_helper_runtime_identity=""
      prepared_helper_override=""
      exit "$direct_status"
    fi
  fi
fi

if [[ "$helper" != "$default_helper" && -z "$prepared_helper_override" ]]; then
  untrusted_helper_exposed=1
fi
exec_helper "$@"
