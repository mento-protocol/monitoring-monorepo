#!/usr/bin/env bash
# The failure trace, the scoring tail and the publication of one run-eval run.
# This file is sourced after run-eval-lifecycle.sh stage `support`, whose
# `run_bounded`, `remaining_seconds` and `log_stderr_tail` it calls. Do not
# execute it directly.
#
# Reads: RUN_DIR, REPO, LEDGER, SPEC, CLI, PLAN_JSON, CONTRACT, TMPROOT, KIND,
# FINDER, SKILL_REF, OPEN_PR, DEADLINE, AGAINST.
# Writes: PUBLISHED, KEEP_CELLS, AGAINST_ARGS, SCORE_OUT, SCORE_STATUS, VERDICT,
# REPORT, REPORT_OUT, REPORT_STATUS.
#
# `fail`, `log` and `json_field` belong to the wrapper. Nothing runs at load but
# the two constants below.

# --- a failed run still leaves a trace ---------------------------------------

# The scoring artifacts a failed run must not publish beside its row.
#
# `--score` writes `calibration.json` before the first cell and one
# `result-<pr>-<condition>-<draw>.json` per cell it scores, and both survive the
# failure that follows: a judge that dies mid-pass leaves the cells already
# scored, and a scored row that then fails `--validate` leaves the whole set.
# `failedRow` publishes zero placeholders for the conditions, the calibration
# and the cost, so the freshness workflow's `--revalidate-appended` job — which
# recomputes a row from exactly these files — reads the leftovers as this run's
# real numbers and rejects the failure PR. Clear them. `cells/` stays: it is the
# paid resume cache a retry seeds from, and `KEEP_CELLS` keeps it out of the
# commit rather than off the disk.
clear_scoring_artifacts() {
  rm -f "$RUN_DIR"/calibration.json "$RUN_DIR"/result-*.json
}

# Appends the status:failed trace row. Returns non-zero when the row was not
# recorded, which is the one case the caller must not report as a clean run.
write_failed_row() {
  local reason="$1"
  local row="$RUN_DIR/row.json"
  clear_scoring_artifacts
  # shellcheck disable=SC2016  # the single-quoted block is node source
  node --input-type=module -e '
    const [planPath, contractPath, spec, ledger, rowPath, reason] = process.argv.slice(1);
    (async () => {
      const fixtures = await import(`${spec}/scripts/review/review-eval-fixtures.mjs`);
      const shape = await import(`${spec}/scripts/review/review-eval-result-shape.mjs`);
      const ledgerMod = await import(`${spec}/scripts/review/review-eval-ledger.mjs`);
      const fs = await import("node:fs");
      const { contract, digest } = fixtures.loadContract(contractPath);
      const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
      const row = shape.failedRow({ plan, contract, contractDigest: digest, reason });
      fs.writeFileSync(rowPath, `${JSON.stringify(row, null, 2)}\n`);
      ledgerMod.appendRow(ledger, row);
    })().catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });
  ' "$PLAN_JSON" "$CONTRACT" "$SPEC" "$LEDGER" "$row" "$reason" || {
    log "could not write the failed row: $reason"
    return 1
  }
  log "appended a status:failed ledger row — $reason"
}

# Refuse a detail_dir that must never reach `rm -rf "$REPO/$detail"`.
#
# `json_field` prints `String(doc[key])`, so a missing key arrives as the word
# "undefined" and a JSON null as "null" — neither is empty, and both would name
# a directory in the checkout root. An empty value is worse: it makes the
# removal target `$REPO/` and deletes the checkout before `cp` can fail. The
# check is on path components, so a legitimate name that merely contains ".."
# passes while a component that climbs out of the checkout does not.
# It runs in the current shell, never in a command substitution: `fail` exits,
# and inside `$(...)` that would exit the subshell and let the caller continue.
require_safe_detail() {
  local value="$1" component
  local -a parts
  case "$value" in
    "" | undefined | null)
      fail "row.json has no usable detail_dir (got '$value'); refusing to touch $REPO"
      ;;
    /*)
      fail "detail_dir must be relative to the checkout, not absolute: $value"
      ;;
  esac
  IFS=/ read -r -a parts <<<"$value"
  for component in "${parts[@]}"; do
    if [[ $component == ".." ]]; then
      fail "detail_dir must not climb out of the checkout: $value"
    fi
  done
}

# Copy the run detail into the checkout and publish the row, or print the
# commands that would. Sets PUBLISHED=1 only when a PR was actually opened.
# $1 is the verdict the branch and commit are named for; $2 is the body file
# inside the detail directory.
PUBLISHED=0

# The raw cells never belong in the PR — they are megabytes of model transcript
# — but the run directory IS the resume cache, and normally it is the very
# directory being published. Deleting `cells` there makes a retry re-spend the
# whole paid matrix. So the cells are kept out of the commit with an exclude
# pathspec instead, and removed from disk only once the run they belong to can
# no longer be resumed. `abort` sets this to 1: that run ended before it scored,
# and its completed cells are exactly what the retry must reuse.
KEEP_CELLS=0

# Stage the detail directory and name the paths the commit may touch. It runs
# `rm -rf` and `cp -R` with errexit live, so `publish_row` calls it bare.
# `detail` and `add_argv` are `publish_row`'s locals, assigned here.
publish_stage_detail() {
  require_safe_detail "$detail"
  mkdir -p "$REPO/$(dirname "$detail")"
  if [[ "$RUN_DIR" != "$REPO/$detail" ]]; then
    rm -rf "${REPO:?}/$detail"
    cp -R "$RUN_DIR" "$REPO/$detail"
    # The copy is not the cache, so its cells go whatever this run's fate.
    rm -rf "${REPO:?}/$detail/cells"
  elif [[ $KEEP_CELLS -eq 0 ]]; then
    rm -rf "${REPO:?}/$detail/cells"
  else
    log "keeping the resume cache at $REPO/$detail/cells for a retry"
  fi
  # Excluded whether or not the directory is still there: a negative pathspec
  # that matches nothing is not an error, and `$detail` matches on its own.
  add_argv=(docs/evals/review-skill-ledger.jsonl "$detail" ":(exclude)$detail/cells")
}

# The same pathspec goes on the commit, not just the add. The pre-flight only
# asks whether `$LEDGER` is dirty, and a --skill-ref candidate run skips even
# that, so the operator's index can hold unrelated staged work — and a
# pathless `git commit` sweeps the whole index into the ledger PR, publishing
# code or docs nobody meant to send. Naming the paths makes this a partial
# commit: only the ledger and the detail directory go in, and anything else
# the operator staged stays staged in their checkout.
publish_print_commands() {
  printf '\n----- ledger PR -----\n'
  printf 'git -C %q checkout -b %q\n' "$REPO" "$branch"
  printf 'git -C %q add %q %q %q\n' "$REPO" "${add_argv[@]}"
  printf 'git -C %q commit -m %q -- %q %q %q\n' "$REPO" "chore(evals): review-skill eval $verdict" "${add_argv[@]}"
  printf 'git -C %q push -u origin %q\n' "$REPO" "$branch"
  printf 'gh pr create --repo mento-protocol/monitoring-monorepo --title %q --body-file %q\n' \
    "$title" "$REPO/$detail/$body_file"
  printf '\nNo auto-merge. A human reads the report and approves.\n'
}

publish_open_pr() {
  log "opening the ledger PR"
  if git -C "$REPO" checkout -b "$branch" &&
    git -C "$REPO" add "${add_argv[@]}" &&
    git -C "$REPO" commit -m "chore(evals): review-skill eval $verdict" -- "${add_argv[@]}" &&
    git -C "$REPO" push -u origin "$branch" &&
    gh pr create --repo mento-protocol/monitoring-monorepo \
      --title "$title" --body-file "$REPO/$detail/$body_file"; then
    PUBLISHED=1
    keep_baseline_copy
  else
    log "the ledger PR could not be opened; the commands above are the recovery path"
  fi
}

publish_row() {
  local verdict="$1" body_file="$2" detail branch title
  local -a add_argv
  PUBLISHED=0
  detail="$(json_field "$RUN_DIR/row.json" detail_dir)"
  publish_stage_detail

  # The detail directory basename already identifies this run: date, the first
  # eight of the comparability key, the kind, and the skill digest. A date-only
  # branch collides the moment two runs finish on the same UTC day — which the
  # candidate procedure requires, an installed run and a --skill-ref run in one
  # sitting — and the collision surfaces at `git checkout -b` or at the push,
  # after the paid run and the ledger append are already done.
  branch="eval/review-skill-$(basename "$detail")"
  title="Review-skill eval $(date -u +%Y-%m-%d): $verdict"

  publish_print_commands

  if [[ $OPEN_PR -eq 1 ]]; then
    publish_open_pr
  fi
}

# The candidate procedure runs the installed skill and the candidate in one
# sitting and compares them with --against. Publishing leaves the checkout on
# the eval branch, and the candidate run must branch from main instead — but
# both the appended ledger row and the detail directory live only on that eval
# branch, so `git checkout main` deletes them and an --against that names the
# row's executed_at then resolves against a ledger that no longer holds it. The
# candidate's pre-flight aborts before the candidate spends anything, which is
# the right failure and still a wasted installed run.
#
# --against also takes a row file, and a row carries every bit the comparison
# reads: `buildVsBaseline` pairs the two `per_defect` vectors and needs no
# detail directory of its own. So keep one copy outside the checkout, where no
# branch switch can reach it, and print the exact argument to pass.
keep_baseline_copy() {
  local kept="$TMPROOT/review-eval-installed-row.json"
  # Only an installed run is ever the baseline, and only a complete one. A
  # candidate run writing here would overwrite the anchor of its own sitting.
  if [[ -n $SKILL_REF ]] ||
    [[ $(json_field "$RUN_DIR/row.json" status) != "complete" ]]; then
    return 0
  fi
  cp "$RUN_DIR/row.json" "$kept" || {
    log "could not keep a baseline copy of the row at $kept"
    return 0
  }
  log "baseline copy for a same-sitting candidate run: --against $kept"
}

abort() {
  # A finder probe has no ledger row to fail. `finder` is not a LEDGER_KINDS
  # value, so `write_failed_row` would clear the result-*.json the compare CLI
  # reads and then die on schema validation with a message about the ledger.
  # Keep the paid evidence and name the probe and its directory instead.
  if [[ $KIND == finder ]]; then
    fail "finder probe $FINDER failed: $1 — nothing was appended; the partial evidence is in $RUN_DIR"
  fi
  # The failed row goes into the checkout's ledger, so leaving it there and
  # exiting zero wedges the schedule: launchd reads a healthy run while the next
  # one refuses to start against a ledger with uncommitted changes, and nothing
  # ever reaches a PR or the freshness workflow. Publish the row the way a
  # scored one is published, and exit zero only when a PR actually carries it.
  # Otherwise exit non-zero with the commands that finish the job printed above.
  # This run never scored, so its completed cells are still worth money and are
  # the only thing that makes a retry cheap. Publishing must not delete them.
  KEEP_CELLS=1
  write_failed_row "$1" ||
    fail "the run failed and the failure row could not be appended: $1"
  # shellcheck disable=SC2016  # the backticks are markdown in the PR body
  printf '# Review-skill eval: run failed\n\n%s\n\nThe row is `status: failed`, `verdict: INCOMPLETE`. It exists so the run leaves a trace; it scores nothing.\n' \
    "$1" >"$RUN_DIR/failure.md"
  publish_row INCOMPLETE failure.md
  if [[ $PUBLISHED -eq 1 ]]; then
    exit 0
  fi
  fail "the run failed, the row was appended to $LEDGER, and no PR carries it yet; run the commands above (or re-run with --pr) — the next run refuses to start while that ledger has uncommitted changes"
}

# --- score, validate, report -------------------------------------------------

# Scoring runs inside the same deadline the matrix does, on the quarter of the
# budget the matrix loop reserved for it. Forty calibration replays and three
# judge calls per cell are not a bounded amount of time on their own: each judge
# call carries a one-hour timeout, so an unbounded scoring pass can outlast the
# whole matrix. `--score` writes the cells' scores under the run directory, so a
# pass stopped here re-runs against the cached cells rather than re-spending
# them.
publish_score_run() {
  # The same baseline reaches scoring, validation and the report. Naming it for
  # only one of the three would have the row scored against the same-day run and
  # then rechecked against the ledger's stored anchor, and the two verdicts would
  # disagree for no reason a reader of the PR could see.
  AGAINST_ARGS=()
  if [[ -n $AGAINST ]]; then
    AGAINST_ARGS=(--against "$AGAINST")
    log "baseline for this run: $AGAINST"
  fi

  SCORE_OUT="$(mktemp "$TMPROOT/review-eval-score.XXXXXX")"
  SCORE_STATUS=0

  log "scoring (this calls the judge)"
  run_bounded "$SCORE_OUT" "$(remaining_seconds "$DEADLINE")" \
    node "$CLI" --root "$SPEC" --ledger "$LEDGER" --score "$RUN_DIR" \
    "${AGAINST_ARGS[@]+"${AGAINST_ARGS[@]}"}" --json || SCORE_STATUS=$?
  cat "$SCORE_OUT"
  # The harness prints why it refused on stderr — a digest mismatch, an
  # unreadable plan, a judge that never answered. The failure row records only
  # "scoring failed", so without this the one line that says what happened is
  # gone by the time anyone reads the log.
  if [[ $SCORE_STATUS -ne 0 ]]; then
    log_stderr_tail "$SCORE_OUT.err"
  fi
  rm -f "$SCORE_OUT" "$SCORE_OUT.err"
  if [[ $SCORE_STATUS -eq 124 ]]; then
    abort "scoring hit the run deadline of ${DEADLINE}s"
  elif [[ $SCORE_STATUS -ne 0 ]]; then
    abort "scoring failed"
  fi
}

# A probe scores and stops: no ledger row to validate, no baseline to report
# against, no PR to open. The detail directory above is what the comparison reads.
publish_finder_probe_exit() {
  if [[ $KIND == finder ]]; then
    log "finder probe $FINDER: nothing was appended to the ledger"
    log "compare: node scripts/review/review-eval-finder-compare.mjs --anchor <full-run detail dir> --candidate $RUN_DIR"
    exit 0
  fi
}

publish_validate_row() {
  log "validating the row against its own detail"
  # --detail-dir names the run directory explicitly: the contract comes from the
  # spec worktree while the scored cells live under the real checkout, so the
  # row's repo-relative detail_dir does not resolve against --root here.
  node "$CLI" --root "$SPEC" --ledger "$LEDGER" --validate "$RUN_DIR/row.json" \
    --detail-dir "$RUN_DIR" "${AGAINST_ARGS[@]+"${AGAINST_ARGS[@]}"}" --append --json ||
    abort "the scored row did not revalidate; nothing was appended"
}

# Past this point the row is in the checkout's ledger. `set -e` exiting here
# would leave the schedule wedged exactly the way an unpublished row does: the
# ledger is dirty, the next run refuses to start against it, and no PR and no
# recovery commands were ever printed. So everything between the append and
# `publish_row` reports its own failure and carries on to publication — and
# never through `abort`, which would append a second row for the same run.
#
# The report is the PR body, and it can fail on its own: `--report` re-reads the
# ledger and the baseline, and a same-sitting `--against` file under /tmp can be
# gone by now. A stub body publishes the row and names what to re-run.
publish_build_report() {
  REPORT="$RUN_DIR/report.md"
  REPORT_OUT="$(mktemp "$TMPROOT/review-eval-report.XXXXXX")"
  REPORT_STATUS=0
  node "$CLI" --root "$SPEC" --ledger "$LEDGER" --report \
    "${AGAINST_ARGS[@]+"${AGAINST_ARGS[@]}"}" >"$REPORT_OUT" 2>"$REPORT_OUT.err" ||
    REPORT_STATUS=$?
  VERDICT="$(json_field "$RUN_DIR/row.json" verdict)" || VERDICT=""
  # `json_field` prints `String(doc[key])`, so a missing key arrives as the word
  # "undefined". Neither it nor an empty read may name a commit.
  case "$VERDICT" in "" | undefined | null) VERDICT="UNKNOWN" ;; esac
  if [[ $REPORT_STATUS -eq 0 ]]; then
    mv "$REPORT_OUT" "$REPORT"
  else
    log "the report could not be generated (exit $REPORT_STATUS); publishing the appended row with a stub body"
    log_stderr_tail "$REPORT_OUT.err"
    # shellcheck disable=SC2016  # the backticks are markdown in the PR body
    printf '# Review-skill eval: %s\n\nThe row was scored and appended to `%s`, and the report could not be generated (`--report` exited %s). The row and the run detail in this commit are the evidence; re-run `pnpm review:eval -- --report` against this ledger to produce the table.\n' \
      "$VERDICT" "docs/evals/review-skill-ledger.jsonl" "$REPORT_STATUS" >"$REPORT"
    rm -f "$REPORT_OUT"
  fi
  rm -f "$REPORT_OUT.err"
  log "verdict $VERDICT"
}
