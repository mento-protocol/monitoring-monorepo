#!/usr/bin/env bash
# Shared content-hash install markers, sourced by the bootstrap scripts that
# skip expensive install/codegen work when their inputs are unchanged
# (scripts/setup.sh, scripts/bootstrap/claude-code-web-setup.sh).
#
# A marker file holds the hash of every input that produced the state it
# guards. A rerun recomputes the hash, compares it to the marker, and skips the
# work only on an exact match. Markers live inside gitignored trees
# (node_modules, indexer-envio/.envio) so they are discarded with the state.
#
# Source-only: defines functions, leaves shell options to the caller, and never
# runs work of its own.

# Hash every file reachable from the given paths. Directories expand to their
# files, missing paths are ignored, and the list is sorted so the hash does not
# depend on argument or directory order. Returns non-zero when no input exists,
# so a caller guarded with `|| true` gets an empty hash and rebuilds rather than
# matching a marker it should not.
install_marker_hash_inputs() {
  local file_list
  file_list="$(mktemp "${TMPDIR:-/tmp}/monitoring-install-marker.XXXXXX")" || return 1

  local p
  for p in "$@"; do
    if [ -d "$p" ]; then
      find "$p" -type f 2>/dev/null
    elif [ -e "$p" ]; then
      printf '%s\n' "$p"
    fi
  done | LC_ALL=C sort -u >"$file_list"

  if [ ! -s "$file_list" ]; then
    rm -f "$file_list"
    return 1
  fi

  local hasher
  if command -v sha256sum >/dev/null 2>&1; then
    hasher=(sha256sum)
  else
    hasher=(shasum -a 256)
  fi

  # NUL-delimit the list: `xargs` splits on whitespace by default, so a path
  # containing a space would be passed as two nonexistent files and silently
  # drop out of the hash. Container checkouts and worktrees can sit under such
  # a path.
  local input_count
  input_count="$(wc -l <"$file_list" | tr -d ' ')"

  local per_file
  per_file="$(tr '\n' '\0' <"$file_list" | xargs -0 "${hasher[@]}" 2>/dev/null)"
  rm -f "$file_list"

  # Every input must produce a digest line. A file that cannot be hashed — gone
  # between the listing and the read, or unreadable — would otherwise drop out
  # silently, and a hash that omits the same file on every run still matches its
  # marker, so the guarded work never reruns. Refuse instead.
  local digest_count
  digest_count="$(printf '%s\n' "$per_file" | grep -c '.' || true)"
  [ -n "$per_file" ] || return 1
  [ "$digest_count" = "$input_count" ] || return 1

  local hash
  hash="$(printf '%s\n' "$per_file" | "${hasher[@]}" | awk '{print $1}')"
  [ -n "$hash" ] || return 1
  printf '%s\n' "$hash"
}

# True when the marker file holds exactly this hash. An empty hash never
# matches, so a failed hash run forces the work to rerun.
install_marker_matches() {
  local marker_path="$1"
  local hash="$2"

  [ -n "$hash" ] || return 1
  [ "$(cat "$marker_path" 2>/dev/null)" = "$hash" ]
}

# Record the hash that produced the current state. Callers write the marker only
# after verifying the work succeeded, so a failed run never caches a broken
# state. A no-op on an empty hash, which leaves the next run to rebuild.
install_marker_write() {
  local marker_path="$1"
  local hash="$2"

  [ -n "$hash" ] || return 0
  printf '%s' "$hash" >"$marker_path"
}
