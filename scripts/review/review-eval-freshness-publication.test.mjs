import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  parseLeadingReviewEvalMarkers,
  REVIEW_EVAL_MARKER,
  reviewEvalMonthMarker,
  scheduleIssuePayload,
} from "./review-eval-report.mjs";
import {
  createPublicationSafeStalenessIssue,
  publicationSafeStalenessIssuePayload,
  runFreshnessPublication,
} from "./review-eval-freshness-publication.mjs";

const DIGEST = "a".repeat(64);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function legacyPayload() {
  return scheduleIssuePayload({
    freshnessResult: {
      level: "red",
      contractDigest: DIGEST,
      evaluatedAt: "2026-12-20T00:00:00Z",
      lastFullAt: null,
      reasons: ["freshness_red 60"],
    },
    contract: {
      cadence_days: {
        canary: 45,
        full: 90,
        freshness_red: 60,
        complete_red: 90,
        full_red: 120,
      },
    },
    contractDigest: DIGEST,
    month: "2026-12",
  });
}

test("staleness issues require the publication helper and PR body", () => {
  const safe = publicationSafeStalenessIssuePayload(legacyPayload());
  assert.doesNotMatch(safe.body, /generated report as its body/);
  assert.match(
    safe.body,
    /Prepare the run with `review-eval-publication\.mjs` and use `\$PR_BODY`/,
  );
  assert.match(
    safe.body,
    /node scripts\/review\/review-eval-publication\.mjs \\\n {2}--detail-dir "\$DETAIL_DIR" >"\$PR_BODY"/,
  );
  assert.deepEqual(parseLeadingReviewEvalMarkers(safe.body), {
    month: "2026-12",
    contract_digest: DIGEST,
  });
  assert.equal(safe.body.split("\n")[0], REVIEW_EVAL_MARKER);
  assert.equal(
    safe.body.split("\n")[1],
    reviewEvalMonthMarker("2026-12", DIGEST),
  );
});

test("the publication-safe issue transform is idempotent and fails on drift", () => {
  const safe = publicationSafeStalenessIssuePayload(legacyPayload());
  assert.deepEqual(publicationSafeStalenessIssuePayload(safe), safe);
  assert.throws(
    () =>
      publicationSafeStalenessIssuePayload({
        ...legacyPayload(),
        body: legacyPayload().body.replace(
          "generated report as its body",
          "raw report as its body",
        ),
      }),
    /acceptance criterion drifted/,
  );
});

test("issue creation sends only the publication-safe body to GitHub", async () => {
  let args = null;
  await createPublicationSafeStalenessIssue(
    { repo: "mento-protocol/monitoring-monorepo" },
    legacyPayload(),
    async (next) => {
      args = next;
      return "created";
    },
  );
  const body = args[args.indexOf("--body") + 1];
  assert.match(body, /review-eval-publication\.mjs/);
  assert.match(body, /\$PR_BODY/);
  assert.doesNotMatch(body, /generated report as its body/);
});

test("the live scheduler cannot bypass the publication transform", async () => {
  let created = null;
  const { result } = await runFreshnessPublication(
    ["--root", repoRoot, "--date", "2027-06-01"],
    {
      env: {},
      listIssues: async () => [],
      authorize: async () => {},
      ensureLabels: async () => {},
      createIssue: async (_options, payload) => {
        created = payload;
      },
    },
  );
  assert.equal(result.action, "create");
  assert.match(created.body, /review-eval-publication\.mjs/);
  assert.match(created.body, /\$PR_BODY/);
  assert.doesNotMatch(created.body, /generated report as its body/);
});
