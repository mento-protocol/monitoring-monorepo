#!/usr/bin/env bash
# Materialize one leak-proof review-eval fixture: the repository as it stood at
# a pull request's first head, with every later commit genuinely unreachable.
#
# Reachability is the control that makes the evaluation a review instead of a
# memory test. A reviewer that can reach the fix commits, the reply threads or
# the merge scores by reading the answer key. Every leak check below therefore
# exits non-zero with a one-line reason; none of them warn.
#
# The two commits come from the contract's eval tags, which pin objects the
# repository already stores. Merged pull request branches are deleted, so
# refs/pull/<n>/head is the only fallback and GitHub does not promise to keep
# it. A tag that resolves to a different commit than the contract pins is a
# hard failure, never a fallback.
#
# The fixture is cached under --cache-dir, keyed by the head SHA, and reused
# only after it passes the same leak checks again. Keep the cache outside the
# monorepo checkout: a fixture inside it can be walked up into a working tree
# of main that carries the frozen truth.
#
# Usage:
#   build-fixture.sh --src PATH --pr N --head SHA --base SHA --cache-dir DIR
#                    [--tag-head REF] [--tag-base REF] [--url URL]
#                    [--forbidden SHA]... [--force]
#
# Prints one JSON object on stdout:
#   {"path":…,"status":"built"|"reused","head":…,"base":…,"commits":N,
#    "tag_pinned":true|false|null}

set -euo pipefail

SRC=""
PR=""
HEAD_SHA=""
BASE_SHA=""
CACHE_DIR=""
TAG_HEAD=""
TAG_BASE=""
URL=""
FORCE=0
FORBIDDEN=()
COMMIT_COUNT=0
TAG_PINNED=null
TMP=""
REFS=""

fail() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'Usage: build-fixture.sh --src PATH --pr N --head SHA --base SHA --cache-dir DIR\n'
  printf '                        [--tag-head REF] [--tag-base REF] [--url URL]\n'
  printf '                        [--forbidden SHA]... [--force]\n'
}

require_value() {
  if [[ -z ${2:-} || ${2:-} == --* ]]; then
    fail "$1 requires a value"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --src)
      require_value "$@"
      SRC=$2
      shift 2
      ;;
    --pr)
      require_value "$@"
      PR=$2
      shift 2
      ;;
    --head)
      require_value "$@"
      HEAD_SHA=$2
      shift 2
      ;;
    --base)
      require_value "$@"
      BASE_SHA=$2
      shift 2
      ;;
    --cache-dir)
      require_value "$@"
      CACHE_DIR=$2
      shift 2
      ;;
    --tag-head)
      require_value "$@"
      TAG_HEAD=$2
      shift 2
      ;;
    --tag-base)
      require_value "$@"
      TAG_BASE=$2
      shift 2
      ;;
    --url)
      require_value "$@"
      URL=$2
      shift 2
      ;;
    --forbidden)
      require_value "$@"
      FORBIDDEN+=("$2")
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[[ -n $SRC ]] || fail "--src is required"
[[ -d $SRC ]] || fail "--src $SRC is not a directory"
[[ $PR =~ ^[0-9]+$ ]] || fail "--pr must be a pull request number"
[[ $HEAD_SHA =~ ^[0-9a-f]{40}$ ]] || fail "--head must be a 40-character lowercase sha"
[[ $BASE_SHA =~ ^[0-9a-f]{40}$ ]] || fail "--base must be a 40-character lowercase sha"
[[ $HEAD_SHA != "$BASE_SHA" ]] || fail "--head and --base must differ"
[[ -n $CACHE_DIR ]] || fail "--cache-dir is required"
[[ $CACHE_DIR != *'"'* ]] || fail "--cache-dir must not contain a quote"
if [[ ${#FORBIDDEN[@]} -gt 0 ]]; then
  for sha in "${FORBIDDEN[@]}"; do
    [[ $sha =~ ^[0-9a-f]{40}$ ]] || fail "--forbidden $sha must be a 40-character lowercase sha"
    [[ $sha != "$HEAD_SHA" && $sha != "$BASE_SHA" ]] ||
      fail "--forbidden $sha is one of the pinned commits"
  done
fi

mkdir -p "$CACHE_DIR" || fail "cannot create the fixture cache at $CACHE_DIR"
CACHE_DIR=$(cd "$CACHE_DIR" && pwd)
DEST="$CACHE_DIR/fx-$PR-${HEAD_SHA:0:12}"
STAMP=".git/review-eval-fixture"

cleanup() {
  [[ -n $TMP ]] && rm -rf "$TMP"
  [[ -n $REFS ]] && rm -f "$REFS"
  return 0
}
trap cleanup EXIT

# Prints the reachable commit count on success, or a one-line reason on
# failure. Run against a freshly built fixture and again before any reuse: a
# previous evaluation run can have edited the working tree, and a cache that is
# trusted without rechecking is a cache that leaks.
verify_fixture() {
  local dir=$1
  local head tree expected_tree base all union sha
  if [[ ! -d "$dir/.git" ]]; then
    echo "no repository at $dir"
    return 1
  fi
  head=$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)
  if [[ $head != "$HEAD_SHA" ]]; then
    echo "HEAD is ${head:-unreadable}, the contract pins $HEAD_SHA"
    return 1
  fi
  tree=$(git -C "$dir" rev-parse 'HEAD^{tree}' 2>/dev/null || true)
  expected_tree=$(git -C "$dir" rev-parse "$HEAD_SHA^{tree}" 2>/dev/null || true)
  if [[ -z $tree || $tree != "$expected_tree" ]]; then
    echo "HEAD tree ${tree:-unreadable} is not the pinned head tree ${expected_tree:-unreadable}"
    return 1
  fi
  base=$(git -C "$dir" rev-parse refs/heads/base 2>/dev/null || true)
  if [[ $base != "$BASE_SHA" ]]; then
    echo "branch base is ${base:-missing}, the contract pins $BASE_SHA"
    return 1
  fi
  # --ignored is load-bearing: the review tooling writes .reviews/ and .tmp/,
  # both gitignored, so a plain --porcelain calls a dirty cached fixture clean.
  if [[ -n $(git -C "$dir" status --porcelain --ignored 2>/dev/null || true) ]]; then
    echo "the working tree carries changes"
    return 1
  fi
  if [[ -n $(git -C "$dir" remote 2>/dev/null || true) ]]; then
    echo "a remote survives"
    return 1
  fi
  if [[ ${#FORBIDDEN[@]} -gt 0 ]]; then
    for sha in "${FORBIDDEN[@]}"; do
      if git -C "$dir" cat-file -e "$sha" 2>/dev/null; then
        echo "forbidden object $sha is still reachable"
        return 1
      fi
    done
  fi
  all=$(git -C "$dir" rev-list --all --count 2>/dev/null || true)
  union=$(git -C "$dir" rev-list --count "$HEAD_SHA" "$BASE_SHA" 2>/dev/null || true)
  if [[ -z $all || -z $union ]]; then
    echo "the commit graph is unreadable"
    return 1
  fi
  if [[ $all != "$union" ]]; then
    echo "$all commits are reachable, only the $union commits of head and base belong here"
    return 1
  fi
  if find "$dir" -path "$dir/.git" -prune -o -type d -name '.skill' -print 2>/dev/null | grep -q .; then
    echo "a .skill directory survives in the fixture"
    return 1
  fi
  echo "$all"
  return 0
}

emit() {
  printf '{"path":"%s","status":"%s","head":"%s","base":"%s","commits":%s,"tag_pinned":%s}\n' \
    "$DEST" "$1" "$HEAD_SHA" "$BASE_SHA" "$COMMIT_COUNT" "$TAG_PINNED"
}

if [[ $FORCE -eq 0 && -d $DEST ]]; then
  if outcome=$(verify_fixture "$DEST"); then
    COMMIT_COUNT=$outcome
    if [[ -f "$DEST/$STAMP" ]]; then
      TAG_PINNED=$(sed -n 's/^tag_pinned=//p' "$DEST/$STAMP" | head -1)
      [[ -n $TAG_PINNED ]] || TAG_PINNED=null
    fi
    emit reused
    exit 0
  fi
  printf 'rebuilding %s: %s\n' "$DEST" "$outcome" >&2
fi

TMP="$CACHE_DIR/.build-$PR-$$"
rm -rf "$TMP"
git clone --quiet --no-local --no-checkout "$SRC" "$TMP" ||
  fail "cannot clone $SRC into the fixture cache"

# Make one eval tag available and confirm it names the commit the contract
# pins. Absence is a fallback; disagreement is a corrupted contract.
fetch_tag() {
  local ref=$1
  [[ -n $ref ]] || return 1
  git -C "$TMP" rev-parse -q --verify "refs/tags/$ref^{commit}" >/dev/null 2>&1 && return 0
  git -C "$TMP" fetch --quiet --no-tags "$SRC" "+refs/tags/$ref:refs/tags/$ref" >/dev/null 2>&1 && return 0
  [[ -n $URL ]] || return 1
  git -C "$TMP" fetch --quiet --no-tags "$URL" "+refs/tags/$ref:refs/tags/$ref" >/dev/null 2>&1
}

check_tag() {
  local ref=$1 expected=$2 sha
  fetch_tag "$ref" || return 1
  sha=$(git -C "$TMP" rev-parse -q --verify "refs/tags/$ref^{commit}" 2>/dev/null || true)
  [[ -n $sha ]] || return 1
  [[ $sha == "$expected" ]] || fail "tag $ref resolves to $sha, the contract pins $expected"
  return 0
}

head_pinned=1
base_pinned=1
check_tag "$TAG_HEAD" "$HEAD_SHA" || head_pinned=0
check_tag "$TAG_BASE" "$BASE_SHA" || base_pinned=0
if [[ $head_pinned -eq 1 && $base_pinned -eq 1 ]]; then
  TAG_PINNED=true
else
  TAG_PINNED=false
fi

if ! git -C "$TMP" cat-file -e "$HEAD_SHA" 2>/dev/null && [[ -n $URL ]]; then
  git -C "$TMP" fetch --quiet --no-tags "$URL" "+refs/pull/$PR/head:refs/heads/__prhead" >/dev/null 2>&1 || true
fi
git -C "$TMP" cat-file -e "$HEAD_SHA" 2>/dev/null ||
  fail "first head $HEAD_SHA is unreachable from $SRC, ${TAG_HEAD:-no tag} and refs/pull/$PR/head"

if ! git -C "$TMP" cat-file -e "$BASE_SHA" 2>/dev/null && [[ -n $URL ]]; then
  git -C "$TMP" fetch --quiet --no-tags "$URL" "$BASE_SHA" >/dev/null 2>&1 || true
fi
git -C "$TMP" cat-file -e "$BASE_SHA" 2>/dev/null ||
  fail "base $BASE_SHA is unreachable from $SRC and ${TAG_BASE:-no tag}"

git -C "$TMP" checkout --quiet --detach "$HEAD_SHA" || fail "cannot check out $HEAD_SHA"
git -C "$TMP" branch --quiet --force base "$BASE_SHA" || fail "cannot point branch base at $BASE_SHA"

# Drop every other ref, then make the dropped objects genuinely unreachable.
git -C "$TMP" remote remove origin >/dev/null 2>&1 || true
REFS=$(mktemp)
git -C "$TMP" for-each-ref --format='%(refname)' >"$REFS"
while read -r ref; do
  if [[ $ref == "refs/heads/base" ]]; then
    continue
  fi
  git -C "$TMP" update-ref -d "$ref" >/dev/null 2>&1 ||
    git -C "$TMP" symbolic-ref -d "$ref" >/dev/null 2>&1 ||
    fail "cannot delete ref $ref"
done <"$REFS"
rm -f "$REFS"
REFS=""
rm -f "$TMP/.git/FETCH_HEAD" "$TMP/.git/ORIG_HEAD"
git -C "$TMP" reflog expire --expire=now --expire-unreachable=now --all ||
  fail "cannot expire the reflog"
git -C "$TMP" gc --quiet --prune=now || fail "cannot prune unreachable objects"

if outcome=$(verify_fixture "$TMP"); then
  COMMIT_COUNT=$outcome
else
  fail "leak check failed for PR $PR: $outcome"
fi

printf 'tag_pinned=%s\n' "$TAG_PINNED" >"$TMP/$STAMP"
rm -rf "$DEST"
mv "$TMP" "$DEST"
TMP=""
emit built
