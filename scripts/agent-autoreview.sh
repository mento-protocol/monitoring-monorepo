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

script_path="${BASH_SOURCE[0]}"
script_parent="${script_path%/*}"
if [[ "$script_parent" == "$script_path" ]]; then
  script_parent="."
fi
script_dir="$(cd -- "$script_parent" && pwd -P)"
repo_root="$(cd -- "$script_dir/.." && pwd -P)"
default_helper="$repo_root/scripts/agent-autoreview.mjs"
helper="${AUTOREVIEW_HELPER:-$default_helper}"

checkout_root="$(pwd -P)"
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

rejected_command_roots=("$repo_root")
if [[ "$checkout_root" != "$repo_root" ]]; then
  rejected_command_roots+=("$checkout_root")
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
    ! -x /bin/ls ||
    ! -x /bin/mv ||
    ! -x /bin/rm
]]; then
  echo "agent:autoreview requires trusted system env, perl, mktemp, uname, chmod, ls, mv, and rm executables" >&2
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
      "$line" =~ [[:space:]]allow[[:space:]].*(write|append|delete|delete_child|writeattr|writeextattr|writesecurity|chown)(,|[[:space:]]|$)
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

cleanup_command_runtime() {
  local current_identity=""
  if [[
    -n "${command_runtime_dir:-}" &&
      "$command_runtime_dir" == "$trusted_temp_root"/agent-autoreview-command-runtime.* &&
      -d "$command_runtime_dir" &&
      ! -L "$command_runtime_dir"
  ]]; then
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
  if snapshotted_node="$(snapshot_external_executable "$resolved" node)"; then
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

resolved_command_is_trusted() {
  local candidate="$1"
  if [[ "$candidate" == "$command_runtime_dir"/* ]]; then
    snapshot_path_is_trusted "$candidate"
  elif [[ "$candidate" == "$git_bin" ]]; then
    [[ "$(command_file_identity "$candidate" 2>/dev/null || true)" == "$git_bin_identity" ]]
  elif [[ "$candidate" == "$node_bin" ]]; then
    [[ "$(command_file_identity "$candidate" 2>/dev/null || true)" == "$node_bin_identity" ]]
  else
    command_path_is_strictly_trusted "$candidate"
  fi
}

run_trusted_external() {
  local executable="$1"
  shift
  resolved_command_is_trusted "$executable" || {
    echo "agent:autoreview: resolved executable changed before launch: $executable" >&2
    return 127
  }
  /usr/bin/env \
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
    "$executable" "$@"
}

run_trusted_node() {
  run_trusted_external "$node_bin" "$@"
}

run_helper() {
  if [[ -n "$prepared_helper_override" ]]; then
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
prepare_staging_exposed=0
direct_helper_runtime_dir=""
direct_helper_runtime_identity=""

cleanup_prepare_staging() {
  if [[ -n "$prepare_staging_dir" ]]; then
    if [[ ! -e "$prepare_staging_dir" && ! -L "$prepare_staging_dir" ]]; then
      :
    elif [[ "$prepare_staging_exposed" -eq 1 ]]; then
      echo "agent:autoreview: leaving failed prepared-bundle staging directory for identity-safe cleanup: $prepare_staging_dir" >&2
    else
      safe_remove_tree \
        "$prepare_staging_dir" \
        "$prepare_staging_identity" \
        "prepared-bundle staging" || true
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
  local size
  local size_value
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
  for relative_path in "${runtime_paths[@]}"; do
    output_path="$runtime_dir/$relative_path"
    if ! git_output "$repo" cat-file blob \
      "${snapshot_ref}:${relative_path}" >"$output_path"; then
      echo "agent:autoreview: failed to materialize trusted helper runtime file: $relative_path" >&2
      return 1
    fi
  done
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
    env -i "${env_args[@]}" \
      "$node_bin" "$runtime_dir/scripts/pr-feedback-state.mjs" \
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
  if [[ "$helper" == "$default_helper" || -n "$prepared_helper_override" ]]; then
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
  fi
  if ! snapshot="$(cd "$repo" && run_helper "${snapshot_args[@]}")"; then
    echo "agent:autoreview: AUTOREVIEW_HELPER must implement --source-snapshot-only for prepared bundles" >&2
    return 1
  fi
  if [[ ! "$snapshot" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "agent:autoreview: AUTOREVIEW_HELPER --source-snapshot-only must print exactly one SHA-256 fingerprint" >&2
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

assert_safe_bundle_parent_ancestry() {
  local bundle_parent="$1"
  # A sticky, root-owned shared directory such as /tmp is safe because another
  # unprivileged UID cannot replace this user's children. Every other ancestor
  # must be private against group/other writers, and an attacker-owned sticky
  # directory is never trusted.
  # The single-quoted string is JavaScript source, not shell interpolation.
  # shellcheck disable=SC2016
  run_trusted_node -e '
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
  ' "$bundle_parent"
}

safe_remove_tree() {
  local path="$1"
  local expected_identity="$2"
  local label="$3"
  local current_identity
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    return 0
  fi
  if [[ -z "$expected_identity" ]] ||
    ! current_identity="$(path_identity "$path" 2>/dev/null)" ||
    [[ "$current_identity" != "$expected_identity" ]]; then
    echo "agent:autoreview: refusing to remove $label after its identity changed: $path" >&2
    return 1
  fi
  rm -rf -- "$path"
  if [[ -e "$path" || -L "$path" ]]; then
    echo "agent:autoreview: failed to remove $label safely: $path" >&2
    return 1
  fi
}

bundle_content_manifest() {
  local root="$1"
  local expected_root_identity="$2"
  shift 2
  local ignored_root_entries=("$@")
  # The single-quoted string is JavaScript source, not shell interpolation.
  # shellcheck disable=SC2016
  run_trusted_node -e '
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
    "${ignored_root_entries[@]+"${ignored_root_entries[@]}"}"
}

publish_bundle_with_reservation() {
  local staging_dir="$1"
  local bundle_dir="$2"
  local bundle_parent="$3"
  local bundle_parent_identity="$4"
  local staging_identity="$5"
  local expected_bundle_manifest="$6"
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
    run_helper --serialize-untracked-file "$relative_path"
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

emit_local_changed_paths() {
  local repo="$1"
  local head_oid="$2"
  {
    git_output "$repo" diff --name-only --cached "$head_oid" --
    git_output "$repo" diff --name-only
    git_output "$repo" ls-files --others --exclude-standard
  } | sort -u
}

emit_branch_local_changed_paths() {
  local repo="$1"
  local target_ref="$2"
  local head_oid="$3"
  {
    git_output "$repo" diff --name-only "$target_ref...$head_oid" --
    git_output "$repo" diff --name-only --cached "$head_oid" --
    git_output "$repo" diff --name-only
    git_output "$repo" ls-files --others --exclude-standard
  } | sort -u
}

emit_branch_changed_paths() {
  local repo="$1"
  local target_ref="$2"
  local head_oid="$3"
  git_output "$repo" diff --name-only "$target_ref...$head_oid" -- | sort -u
}

emit_commit_changed_paths() {
  local repo="$1"
  local target_ref="$2"
  git_output "$repo" show --name-only --format= "$target_ref" |
    sed '/^$/d' |
    sort -u
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
  target_selection_snapshot_after="$(target_selection_snapshot "$repo")"
  if [[ "$target_selection_snapshot_after" != "$target_selection_source_snapshot" ]]; then
    echo "agent:autoreview: source changed while the review target was being selected; rerun autoreview" >&2
    exit 1
  fi
  prepare_staging_exposed=1
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
        git_output "$repo" ls-files --others --exclude-standard
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
        git_output "$repo" ls-files --others --exclude-standard
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
    # Backticks are literal Markdown delimiters in the single-quoted format.
    # shellcheck disable=SC2016
    printf 'Before review, run `pnpm agent:autoreview --verify-bundle-dir %s` and retain its manifest digest outside this bundle.\n' \
      "$bundle_dir"
    # shellcheck disable=SC2016
    printf 'After reading every pass, run `pnpm agent:autoreview --verify-bundle-dir %s --expected-bundle-manifest <retained-digest>`.\n' \
      "$bundle_dir"
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
  prepare_staging_exposed=0
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

exec_helper "$@"
