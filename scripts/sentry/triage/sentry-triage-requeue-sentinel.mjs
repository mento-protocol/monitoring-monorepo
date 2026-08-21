/**
 * THE SETTLEMENT SENTINEL, and the unwind it triggers (issue #1929, ADR 0069).
 *
 * The re-queue chokepoint's invariant 7 revalidates a snapshot-derived premise
 * immediately BEFORE mutating. That leaves the write window itself uncovered:
 * `.github/workflows/sentry-triage-archive.yml` holds its own per-issue
 * concurrency group, so a human-approved archive can settle the stub between the
 * revalidating read and the writes — and the shed then removed `sentry:archived`
 * with a `--remove-label` that reports nothing, so no later read could testify
 * that the marker had ever been there.
 *
 * A sentinel is a label that answers exactly that question. The chokepoint
 * withholds it from the shed, so it survives to be READ on the confirming
 * end-state read; observing it there means the settlement landed inside this
 * window, and this module undoes the re-queue rather than letting it report
 * success over an occurrence a human approved archiving.
 *
 * WHAT THE MARKER PROVES is that an archive run WROTE it — not that the run
 * accepted its own settlement. Those come apart when the archive's verification
 * rejects the shape this re-queue produced and it starts rolling back while this
 * unwind runs. No read can tell the two apart: the archive publishes nothing
 * after its verification, and a marker it published would be one more racing
 * write rather than a lock. Both runs then converge on the archive's own
 * post-rollback shape (open, verdicted, unqueued), both go red, and ingest's
 * stranded sweep repairs it. ADR 0069 records that trade.
 *
 * Split out of scripts/sentry/triage/sentry-triage-requeue.mjs to keep that
 * module under the 1,000-line hard cap. It imports the label contract and
 * `node:` nothing else, so it stays loadable from a workflow that ran
 * setup-node without an install, like every module in this family.
 */

import {
  NEEDS_TRIAGE_LABEL,
  NEVER_RESTORED_LABELS,
  REOPEN_SHED_LABELS,
  VERDICT_LABELS,
} from "./sentry-triage-queue-contract.mjs";

/**
 * The corrections that undo a re-queue, in the order every PREFIX of them is
 * safe.
 *
 * `sentry:needs-triage` goes FIRST because selectability is the only property
 * that lets another run act on this stub, so an unwind that dies half-way must
 * already have taken it away. The markers come back next, and they are
 * load-bearing rather than tidy: the settling run's own post-settlement
 * verification demands closed + its terminal marker + a verdict label, so a stub
 * left verdict-less makes THAT run roll a correct archive back. The close goes
 * last, for the same reason the re-queue puts its state change last — it is the
 * transition another stage can see.
 *
 * `premise` is the revalidating read: an OBSERVATION, the same thing the
 * archive's `reconcileToTarget` rolls back to. Nothing here replays a log of
 * what we believe we wrote.
 *
 * `NEVER_RESTORED_LABELS` is the one marker that does not come back. A spent
 * approval is authority, not a record.
 *
 * Exported for the test, which asserts the ordering directly rather than
 * inferring it from a fake's call log.
 */
export function restorableMarkers({ sentinelLabel, premise }) {
  return REOPEN_SHED_LABELS.filter(
    (name) =>
      name !== sentinelLabel &&
      !NEVER_RESTORED_LABELS.includes(name) &&
      (premise?.labels ?? []).includes(name),
  );
}

export function buildUnwindCorrections({
  repo,
  issueNumber,
  sentinelLabel,
  premise,
}) {
  const restore = restorableMarkers({ sentinelLabel, premise });
  const edit = (flag, value) => [
    "issue",
    "edit",
    String(issueNumber),
    "-R",
    repo,
    flag,
    value,
  ];
  return [
    {
      what: "drop-needs-triage",
      args: edit("--remove-label", NEEDS_TRIAGE_LABEL),
    },
    ...(restore.length
      ? [
          {
            what: `restore-${restore.join("+")}`,
            args: edit("--add-label", restore.join(",")),
          },
        ]
      : []),
    {
      what: "close",
      args: [
        "issue",
        "close",
        String(issueNumber),
        "-R",
        repo,
        "--reason",
        "completed",
      ],
    },
  ];
}

/**
 * Undo this re-queue and leave the settled shape standing.
 *
 * A write here can land and lose its response, so the corrections are
 * PROVISIONAL and one confirming read decides — the same ambiguous-response
 * discipline the rest of this pipeline uses. An unconfirmed unwind THROWS: the
 * stub is then neither re-queued nor demonstrably settled, which is exactly the
 * state that needs a human.
 *
 * Returns the chokepoint's own result shape, with `reason: "settled-underneath"`
 * so a caller can tell this apart from the pre-write `revalidated-away` decline.
 */
export async function unwindAfterSettlement(
  { writeGh, readStub },
  { repo, issueNumber, sentinel, premise },
) {
  const provisional = [];
  for (const correction of buildUnwindCorrections({
    repo,
    issueNumber,
    sentinelLabel: sentinel.label,
    premise,
  })) {
    try {
      await writeGh(correction.args);
    } catch (err) {
      provisional.push(
        `${correction.what} reported: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // BOUNDED RETRY on the confirming read, the same allowance the chokepoint
  // gives its revalidating read. A compensation often runs precisely because a
  // `gh` read on this stub just failed, so this read is correlated with a
  // usually-transient failure — and one unretried attempt would turn that blip
  // into an `::error::` telling a human to repair a stub the three writes above
  // had already left correctly settled. Bounded, so a real outage still lands in
  // the throw below.
  let after = null;
  let readError = null;
  for (let round = 1; round <= 2 && after === null; round += 1) {
    try {
      // Normalised, so a reader that resolves to nothing is treated as a read
      // that failed rather than crashing the report below.
      after = (await readStub(issueNumber)) ?? null;
      readError = after === null ? "the read returned nothing" : null;
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `::notice::Could not read #${issueNumber} to confirm the unwind (${readError}); attempt ${round} of 2.\n`,
      );
    }
  }
  // The confirmation asks for the SETTLED shape the settling run itself demands
  // (`settlementHeld` in scripts/sentry/triage/sentry-triage-archive.mjs:
  // closed, its terminal marker, and a verdict label) — not merely for the three
  // corrections above having been attempted. Asking the weaker question let the
  // unwind confirm a stub that run then rejects, which is the outcome the unwind
  // exists to prevent.
  //
  // Two ways the verdict can be absent: the re-add REPORTED a real failure, and
  // the premise never carried one to restore. Both are the same answer here — a
  // verdict-less closed archive is a state only a human can resolve — so both
  // land in the throw below rather than in a quiet decline.
  const missing = restorableMarkers({
    sentinelLabel: sentinel.label,
    premise,
  }).filter((name) => !(after?.labels ?? []).includes(name));
  const verdictHolds = VERDICT_LABELS.some((name) =>
    (after?.labels ?? []).includes(name),
  );
  const held =
    after !== null &&
    String(after.state ?? "").toUpperCase() === "CLOSED" &&
    (after.labels ?? []).includes(sentinel.label) &&
    !(after.labels ?? []).includes(NEEDS_TRIAGE_LABEL) &&
    missing.length === 0 &&
    verdictHolds;
  if (!held) {
    const seen = after
      ? `state=${after.state}, labels=${(after.labels ?? []).join("|")}${
          missing.length ? `, never restored: ${missing.join("|")}` : ""
        }${verdictHolds ? "" : ", no verdict label"}`
      : `unreadable (${readError})`;
    process.stderr.write(
      `::error::Queue stub #${issueNumber} settled underneath a re-queue (${sentinel.label} appeared inside the write window), but the re-queue could not be unwound (${seen})${
        provisional.length
          ? `; corrections reported: ${provisional.join("; ")}`
          : ""
      }. Repair it by hand: close it, remove ${NEEDS_TRIAGE_LABEL}, restore the previous round's markers, and leave ${sentinel.label} in place — the settling run already archived the underlying occurrence.\n`,
    );
    throw new Error(
      `Queue stub #${issueNumber} settled underneath a re-queue and the re-queue could not be unwound (${seen}).`,
    );
  }

  // Correct the stub's written record LAST, once the state it describes is
  // confirmed. Advisory, like every other note the chokepoint posts: a failed
  // post must not undo a converged unwind.
  if (sentinel.unwindNote) {
    try {
      await writeGh([
        "issue",
        "comment",
        String(issueNumber),
        "-R",
        repo,
        "--body",
        sentinel.unwindNote(after),
      ]);
    } catch (err) {
      process.stderr.write(
        `::notice::The settled-underneath note on #${issueNumber} could not be posted (${
          err instanceof Error ? err.message : String(err)
        }); the stub itself is correctly settled.\n`,
      );
    }
  }
  if (provisional.length) {
    process.stderr.write(
      `::notice::The unwind of #${issueNumber} reported failures the verification read disproves (${provisional.join("; ")}).\n`,
    );
  }
  return {
    requeued: false,
    reason: "settled-underneath",
    verified: after,
    labelError: null,
  };
}
