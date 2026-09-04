import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildFindings,
  classifySeverity,
  cleanBody,
  deriveTitle,
  encodeJsonString,
  flattenPages,
  formatSummaryLine,
  harvestPr,
  isActedOn,
  isDeclined,
  normalizeRemoteRepo,
  parseGhJson,
  parseHarvestArgs,
  resolveBaseSha,
  runHarvest,
  selectFirstHead,
  serializeTruth,
  stripDetailsBlocks,
} from "./review-eval-harvest-truth.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const HEAD = "a".repeat(40);
const LATER = "b".repeat(40);
const BASE = "c".repeat(40);
const AUTHOR = "chapati23";

function botReview(login, submittedAt, commitId, id) {
  return {
    id,
    user: { login },
    submitted_at: submittedAt,
    commit_id: commitId,
  };
}

function rootComment(overrides) {
  return {
    id: 1,
    user: { login: "coderabbitai[bot]" },
    in_reply_to_id: null,
    original_commit_id: HEAD,
    path: "scripts/a.mjs",
    line: 10,
    body: "a finding",
    ...overrides,
  };
}

// --- first-head selection -------------------------------------------------

test("first head is the earliest submitted bot review's commit", () => {
  const head = selectFirstHead({
    reviews: [
      botReview("coderabbitai[bot]", "2026-08-20T12:00:00Z", LATER, 3),
      botReview(
        "chatgpt-codex-connector[bot]",
        "2026-08-20T09:00:00Z",
        HEAD,
        2,
      ),
      botReview("some-human", "2026-08-20T01:00:00Z", BASE, 1),
      { id: 4, user: { login: "claude[bot]" }, commit_id: LATER },
    ],
    commits: [{ sha: BASE }, { sha: LATER }],
  });
  assert.deepEqual(head, { sha: HEAD, source: "bot-review", review_id: 2 });
});

test("equal submit times break ties on review id", () => {
  const head = selectFirstHead({
    reviews: [
      botReview("cursor[bot]", "2026-08-20T09:00:00Z", LATER, 9),
      botReview("cursor[bot]", "2026-08-20T09:00:00Z", HEAD, 4),
    ],
    commits: [{ sha: BASE }],
  });
  assert.equal(head.sha, HEAD);
});

test("first head falls back to commits[0] when no bot reviewed", () => {
  const head = selectFirstHead({
    reviews: [botReview("some-human", "2026-08-20T01:00:00Z", LATER, 1)],
    commits: [{ sha: HEAD }, { sha: LATER }],
  });
  assert.deepEqual(head, {
    sha: HEAD,
    source: "first-commit",
    review_id: null,
  });
});

test("first head with neither a bot review nor commits is an error", () => {
  assert.throws(
    () => selectFirstHead({ reviews: [], commits: [] }),
    /no commits and no bot review/,
  );
});

// --- finding selection ----------------------------------------------------

test("later-head findings are excluded and counted", () => {
  const { findings, excludedLaterHead } = buildFindings({
    comments: [
      rootComment({ id: 1 }),
      rootComment({ id: 2, original_commit_id: LATER }),
      rootComment({ id: 3, original_commit_id: LATER }),
      rootComment({ id: 4, user: { login: "a-human" } }),
      rootComment({
        id: 5,
        in_reply_to_id: 1,
        user: { login: AUTHOR },
        body: "Fixed in abc1234",
      }),
    ],
    firstHead: HEAD,
    author: AUTHOR,
  });
  assert.deepEqual(
    findings.map((finding) => finding.id),
    [1],
  );
  assert.equal(excludedLaterHead, 2);
  assert.equal(findings[0].acted_on, true);
  assert.equal(findings[0].declined, false);
});

test("a human root comment on a later head is not counted as excluded", () => {
  const { findings, excludedLaterHead } = buildFindings({
    comments: [rootComment({ id: 7, user: { login: "a-human" } })],
    firstHead: LATER,
    author: AUTHOR,
  });
  assert.equal(findings.length, 0);
  assert.equal(excludedLaterHead, 0);
});

test("line falls back to original_line and path may be absent", () => {
  const { findings } = buildFindings({
    comments: [rootComment({ line: null, original_line: 42, path: undefined })],
    firstHead: HEAD,
    author: AUTHOR,
  });
  assert.equal(findings[0].line, 42);
  assert.equal(findings[0].path, null);
});

// --- dispositions: the pull request author's replies only -----------------

test("only the pull request author's reply sets a disposition", () => {
  const authorReply = { user: { login: AUTHOR }, body: "Fixed in 1234abc" };
  const botReply = {
    user: { login: "coderabbitai[bot]" },
    body: "`@chapati23`, confirmed. Fixed in 1234abc, verified.",
  };
  assert.equal(isActedOn([authorReply], AUTHOR), true);
  assert.equal(isActedOn([botReply], AUTHOR), false);
  assert.equal(isActedOn([botReply, authorReply], AUTHOR), true);
  assert.equal(isActedOn([authorReply], undefined), false);
  const authorDecline = { user: { login: AUTHOR }, body: "Won't fix: by fiat" };
  const botDecline = {
    user: { login: "cursor[bot]" },
    body: "The author said Won't fix, so I am closing this.",
  };
  assert.equal(isDeclined([authorDecline], AUTHOR), true);
  assert.equal(isDeclined([botDecline], AUTHOR), false);
});

test("a bot reply quoting the fixed form does not mark a finding acted on", () => {
  const { findings } = buildFindings({
    comments: [
      rootComment({ id: 1 }),
      rootComment({ id: 2 }),
      rootComment({
        id: 3,
        in_reply_to_id: 1,
        user: { login: AUTHOR },
        body: "Fixed in deadbee — split out",
      }),
      rootComment({
        id: 4,
        in_reply_to_id: 2,
        user: { login: "claude[bot]" },
        body: "Fixed in deadbee by my own push.",
      }),
    ],
    firstHead: HEAD,
    author: AUTHOR,
  });
  assert.deepEqual(
    findings.map((finding) => [finding.id, finding.acted_on]),
    [
      [1, true],
      [2, false],
    ],
  );
});

test("disposition reads the mandated reply forms", () => {
  const say = (body) => [{ user: { login: AUTHOR }, body }];
  assert.equal(isActedOn(say("Fixed in 1234abc — split out"), AUTHOR), true);
  assert.equal(isActedOn(say("fixed in 1234abc"), AUTHOR), true);
  assert.equal(isActedOn(say("Prefixed instead"), AUTHOR), false);
  assert.equal(isActedOn([], AUTHOR), false);
  assert.equal(isDeclined(say("Won't fix: covered upstream"), AUTHOR), true);
  assert.equal(isDeclined(say("won't fix, by design"), AUTHOR), true);
  assert.equal(isDeclined(say("Not applicable here"), AUTHOR), true);
  assert.equal(isDeclined(say("will fix next round"), AUTHOR), false);
});

// --- body cleaning --------------------------------------------------------

// The shape that motivated the rule: a CodeRabbit comment whose collapsed
// analysis chain runs for thousands of characters before the finding.
function longAnalysisChainComment() {
  const chain =
    "<details>\n<summary>🧩 Analysis chain</summary>\n\n" +
    "🏁 Script executed:\n\n```shell\nrg -n 'flushWrites' .\n```\n".repeat(
      140,
    ) +
    "\n</details>";
  const finding =
    "**A failed flush discards the pending batch.**\n\n" +
    "`flushWrites` splices the batch out before it calls `pipeline`.\n".repeat(
      25,
    );
  const body =
    "_🗄️ Data Integrity & Integration_ | _🟠 Major_ | _🏗️ Heavy lift_\n\n" +
    `${chain}\n\n${finding}`;
  return { body, chain };
}

test("a long collapsed analysis chain never reaches the stored body", () => {
  const { body, chain } = longAnalysisChainComment();
  assert.ok(body.length > 9000, `comment is ${body.length} characters`);
  assert.ok(chain.length > 7000, `chain is ${chain.length} characters`);
  // Before the rule: the first 400 characters are shell noise, not a finding.
  assert.ok(body.slice(0, 400).includes("Script executed"));
  assert.ok(!body.slice(0, 400).includes("A failed flush"));

  const { findings } = buildFindings({
    comments: [rootComment({ id: 1, body })],
    firstHead: HEAD,
    author: AUTHOR,
  });
  const stored = findings[0];
  // After it: the diagnosis is inside the characters a match judge reads.
  assert.ok(
    stored.body.slice(0, 400).includes("A failed flush discards the pending"),
    stored.body.slice(0, 200),
  );
  assert.ok(!stored.body.includes("Script executed"));
  assert.equal(stored.title, "A failed flush discards the pending batch.");
  // The badge line leaves the body but still decides the severity.
  assert.equal(stored.severity, "P1");
  assert.ok(!stored.body.includes("Heavy lift"));
});

test("details blocks are dropped whole, nested and unterminated alike", () => {
  assert.equal(stripDetailsBlocks("a<details>x</details>b"), "ab");
  assert.equal(
    stripDetailsBlocks("a<details><details>x</details>y</details>b"),
    "ab",
  );
  assert.equal(stripDetailsBlocks("a<details>x\nmore"), "a");
  assert.equal(stripDetailsBlocks("a</details>b"), "ab");
  assert.equal(stripDetailsBlocks("no blocks here"), "no blocks here");
  assert.equal(stripDetailsBlocks(undefined), "");
});

test("markers are stripped, real text is kept, and cleaning is idempotent", () => {
  const body =
    "_🎯 Functional Correctness_ | _🟡 Minor_ | _⚡ Quick win_\n\n" +
    "**Match the exact tfvars key.**\n\nLine 60 matches any prefix.\n\n" +
    "<!-- fingerprinting:phantom:poseidon:tapir -->\n";
  const cleaned = cleanBody(body);
  assert.equal(
    cleaned,
    "**Match the exact tfvars key.**\n\nLine 60 matches any prefix.",
  );
  assert.equal(cleanBody(cleaned), cleaned);
  assert.equal(deriveTitle(body), "Match the exact tfvars key.");
  // A comment that is nothing but a collapsed block keeps its raw text rather
  // than being stored empty.
  assert.equal(
    cleanBody("<details>only this</details>"),
    "<details>only this</details>",
  );
  // A body with no marker at all is untouched.
  assert.equal(
    cleanBody("### Refresh wipes tags\n\nplain"),
    "### Refresh wipes tags\n\nplain",
  );
});

// --- rules against the frozen fixture bodies ------------------------------

const truthFor = (pr) =>
  JSON.parse(
    readFileSync(
      path.join(repoRoot, "docs/evals/review-skill-truth", `pr-${pr}.json`),
      "utf8",
    ),
  );

const BADGE_TITLE = /^[^|]+\|[^|]+\|[^|]+$/;

test("severity still matches the frozen truth for every fixture finding", () => {
  for (const pr of [1990, 1995]) {
    for (const finding of truthFor(pr).findings) {
      assert.equal(
        classifySeverity(finding.body),
        finding.severity,
        `PR ${pr} finding ${finding.id} severity`,
      );
    }
  }
});

test("the title rule moves the CodeRabbit badge titles and nothing else", () => {
  let moved = 0;
  let keptRaw = 0;
  for (const pr of [1990, 1995]) {
    for (const finding of truthFor(pr).findings) {
      const title = deriveTitle(finding.body);
      if (!BADGE_TITLE.test(finding.title)) {
        assert.equal(
          title,
          finding.title,
          `PR ${pr} finding ${finding.id} title`,
        );
        continue;
      }
      if (cleanBody(finding.body) === finding.body.trim()) {
        // The frozen body was truncated at 2500 characters inside the
        // collapsed block, so no finding text survives to promote. Keeping the
        // raw text beats storing an empty body.
        keptRaw += 1;
        continue;
      }
      moved += 1;
      assert.notEqual(title, finding.title);
      assert.ok(title.length > 0, `PR ${pr} finding ${finding.id} title`);
      assert.ok(!BADGE_TITLE.test(title), title);
    }
  }
  assert.equal(moved, 6);
  assert.equal(keptRaw, 1);
});

test("severity tiers follow the bench2 patterns", () => {
  assert.equal(classifySeverity("![P1 Badge](x) Split the core"), "P1");
  assert.equal(classifySeverity("_Major_ concern"), "P1");
  assert.equal(classifySeverity("High Severity finding"), "P1");
  assert.equal(classifySeverity("![P2 Badge](x) Authenticate markers"), "P2");
  assert.equal(classifySeverity("Minor nit"), "P2");
  assert.equal(classifySeverity("a plain suggestion"), "P3");
  assert.equal(classifySeverity(undefined), "P3");
});

test("title strips html, markdown and image syntax and caps at 150", () => {
  assert.equal(
    deriveTitle("**<sub>![P1 Badge](https://x/y)</sub>  Split it**\n\nmore"),
    "Split it",
  );
  assert.equal(deriveTitle(`x${"y".repeat(200)}`).length, 150);
});

// --- serializer -----------------------------------------------------------

test("the serializer reproduces the frozen truth files byte for byte", () => {
  for (const pr of [1990, 1995]) {
    const file = path.join(
      repoRoot,
      "docs/evals/review-skill-truth",
      `pr-${pr}.json`,
    );
    const bytes = readFileSync(file, "utf8");
    assert.equal(serializeTruth(JSON.parse(bytes)), bytes, `PR ${pr} bytes`);
  }
});

test("non-ascii is escaped the way Python's json.dump escapes it", () => {
  assert.equal(
    encodeJsonString("🔴 é"),
    '"' + String.raw`\ud83d\udd34 \u00e9` + '"',
  );
  assert.equal(
    encodeJsonString(String.fromCharCode(0x7f)),
    '"' + String.raw`\u007f` + '"',
  );
  assert.equal(encodeJsonString('a"b\\c\nd\te'), `"a\\"b\\\\c\\nd\\te"`);
  assert.equal(encodeJsonString("plain/ascii"), '"plain/ascii"');
});

test("the serializer indents by one space and keeps empty containers inline", () => {
  assert.equal(
    serializeTruth({ a: [1, { b: true }], c: [], d: {}, e: null }),
    '{\n "a": [\n  1,\n  {\n   "b": true\n  }\n ],\n "c": [],\n "d": {},\n "e": null\n}',
  );
});

// --- pagination -----------------------------------------------------------

test("slurped pages are joined as values, so a body holding ][ survives", () => {
  const first = { id: 1, body: "see the [label][ref] link and matrix[i][j]" };
  const second = { id: 2, body: "second page ][ too" };
  const text = JSON.stringify([[first], [second]]);
  const items = flattenPages(parseGhJson(text));
  assert.deepEqual(items, [first, second]);
  assert.equal(items[0].body, "see the [label][ref] link and matrix[i][j]");
  assert.equal(parseGhJson("  ").length, 0);
});

test("a response that is not an array of page arrays is refused", () => {
  // bench2 spliced this form into one array and corrupted every `][` in it.
  assert.throws(() => parseGhJson('[{"id":1}][{"id":2}]'), SyntaxError);
  assert.throws(() => flattenPages([{ id: 1 }]), /array of page arrays/);
  assert.throws(() => flattenPages({ id: 1 }), /array of page arrays/);
});

// --- git boundary ---------------------------------------------------------

const ORIGIN = "https://github.com/mento-protocol/monitoring-monorepo.git";
const REPO = "mento-protocol/monitoring-monorepo";

function recordingGit(calls, { missing = false, origin = ORIGIN } = {}) {
  return ({ args, cwd }) => {
    calls.push({ args, cwd });
    if (args[0] === "remote") return `${origin}\n`;
    if (args[0] === "cat-file") {
      if (missing) throw new Error("not found");
      return "";
    }
    if (args[0] === "merge-base") return `${BASE}\n`;
    return "";
  };
}

test("base sha is the merge-base against the PR's own base ref", () => {
  const calls = [];
  const baseSha = resolveBaseSha({
    pr: 2121,
    firstHead: HEAD,
    baseRef: "release/2026-09",
    repo: REPO,
    src: "/src/dir",
    git: recordingGit(calls),
  });
  assert.equal(baseSha, BASE);
  assert.deepEqual(calls[0].args, ["remote", "get-url", "origin"]);
  const fetch = calls[1];
  assert.equal(fetch.args[0], "fetch");
  assert.equal(fetch.args[1], "origin");
  const [source, tempRef] = fetch.args[2].split(":");
  assert.equal(source, "refs/heads/release/2026-09");
  assert.match(
    tempRef,
    /^refs\/review-eval-harvest\/pr-2121-base-[0-9a-f]{12}$/,
  );
  const merge = calls.find((call) => call.args[0] === "merge-base");
  assert.deepEqual(merge.args, ["merge-base", HEAD, tempRef]);
  assert.equal(merge.cwd, "/src/dir");
  // No hardcoded branch reaches git, and the temporary ref is cleaned up.
  assert.ok(!JSON.stringify(calls).includes("origin/main"));
  assert.deepEqual(calls.at(-1).args, ["update-ref", "-d", tempRef]);
});

test("a src whose origin names another repository is refused", () => {
  const calls = [];
  assert.throws(
    () =>
      resolveBaseSha({
        pr: 2121,
        firstHead: HEAD,
        baseRef: "main",
        repo: REPO,
        src: "/src/dir",
        git: recordingGit(calls, { origin: "git@github.com:someone/fork.git" }),
      }),
    /does not name mento-protocol\/monitoring-monorepo/,
  );
  // The refusal comes before any fetch, so nothing is written to /src/dir.
  assert.deepEqual(
    calls.map((call) => call.args[0]),
    ["remote"],
  );
});

test("origin urls are compared in every form git accepts", () => {
  for (const url of [
    "https://github.com/Mento-Protocol/Monitoring-Monorepo.git",
    "git@github.com:mento-protocol/monitoring-monorepo.git",
    "ssh://git@github.com/mento-protocol/monitoring-monorepo",
    "https://github.com/mento-protocol/monitoring-monorepo",
  ]) {
    assert.equal(normalizeRemoteRepo(url), REPO, url);
  }
  assert.equal(
    normalizeRemoteRepo("git@github.com:someone/fork.git"),
    "someone/fork",
  );
  assert.equal(normalizeRemoteRepo("relative"), null);
  assert.equal(normalizeRemoteRepo(""), null);
});

test("a missing first head is fetched into a temporary ref and cleaned up", () => {
  const calls = [];
  const baseSha = resolveBaseSha({
    pr: 1990,
    firstHead: HEAD,
    baseRef: "main",
    repo: REPO,
    src: "/src/dir",
    git: recordingGit(calls, { missing: true }),
  });
  assert.equal(baseSha, BASE);
  const fetches = calls.filter((call) => call.args[0] === "fetch");
  assert.equal(fetches.length, 2);
  const [source, headRef] = fetches[1].args[2].split(":");
  assert.equal(source, "refs/pull/1990/head");
  assert.match(
    headRef,
    /^refs\/review-eval-harvest\/pr-1990-head-[0-9a-f]{12}$/,
  );
  const deleted = calls
    .filter((call) => call.args[0] === "update-ref")
    .map((call) => call.args[2]);
  assert.equal(deleted.length, 2);
  assert.ok(deleted.includes(headRef));
});

test("an unusable base ref or merge-base result is rejected", () => {
  assert.throws(
    () =>
      resolveBaseSha({
        pr: 1,
        firstHead: HEAD,
        baseRef: "../evil",
        repo: REPO,
        src: "/src/dir",
        git: recordingGit([]),
      }),
    /not a usable branch/,
  );
  assert.throws(
    () =>
      resolveBaseSha({
        pr: 1,
        firstHead: HEAD,
        baseRef: "main",
        repo: REPO,
        src: "/src/dir",
        git: ({ args }) => {
          if (args[0] === "remote") return `${ORIGIN}\n`;
          return args[0] === "merge-base" ? "not-a-sha\n" : "";
        },
      }),
    /unusable base sha/,
  );
});

// --- CLI and harvest ------------------------------------------------------

test("args parse, dedupe and resolve the default directories", () => {
  const args = parseHarvestArgs(["--pr", "1990", "--pr", "1990", "--dry-run"], {
    cwd: "/work",
  });
  assert.deepEqual(args.prs, [1990]);
  assert.equal(args.repo, REPO);
  assert.equal(
    args.outDir,
    path.join(repoRoot, "docs/evals/review-skill-truth"),
  );
  assert.equal(args.src, path.resolve(repoRoot));
  assert.equal(args.dryRun, true);
  assert.equal(args.json, false);
  assert.throws(() => parseHarvestArgs([]), /--pr is required/);
  assert.throws(() => parseHarvestArgs(["--pr", "x"]), /pull request number/);
  const custom = parseHarvestArgs(["--pr", "7", "--src", "sub"], {
    cwd: "/work",
  });
  assert.equal(custom.src, path.join("/work", "sub"));
});

function stubGh({ reviews, author = AUTHOR }) {
  return ({ apiPath }) => {
    if (apiPath === "pulls/1990") {
      return {
        title: "fix(review): x",
        base: { ref: "main" },
        user: { login: author },
      };
    }
    if (apiPath === "pulls/1990/commits") {
      return [{ sha: LATER }, { sha: HEAD }, { sha: BASE }];
    }
    if (apiPath === "pulls/1990/reviews") return reviews;
    return [
      rootComment({ id: 11, body: "![P1 Badge](x) Split it" }),
      rootComment({
        id: 12,
        in_reply_to_id: 11,
        user: { login: AUTHOR },
        body: "Fixed in deadbee",
      }),
      rootComment({ id: 13, original_commit_id: LATER }),
      rootComment({
        id: 14,
        user: { login: "cursor[bot]" },
        body: "Minor nit é",
      }),
      rootComment({
        id: 15,
        in_reply_to_id: 14,
        user: { login: AUTHOR },
        body: "Won't fix: by design",
      }),
      rootComment({
        id: 16,
        in_reply_to_id: 14,
        user: { login: "coderabbitai[bot]" },
        body: "Fixed in deadbee, confirmed.",
      }),
    ];
  };
}

test("harvest builds the frozen field order and counts", () => {
  const { truth, summary } = harvestPr({
    pr: 1990,
    repo: REPO,
    src: "/src/dir",
    gh: stubGh({
      reviews: [
        botReview("coderabbitai[bot]", "2026-08-20T09:00:00Z", HEAD, 1),
      ],
    }),
    git: recordingGit([]),
  });
  assert.deepEqual(Object.keys(truth), [
    "pr",
    "title",
    "base",
    "base_sha",
    "first_head",
    "last_head",
    "commits",
    "reviewers",
    "findings",
    "counts",
  ]);
  assert.deepEqual(Object.keys(truth.findings[0]), [
    "id",
    "author",
    "path",
    "line",
    "severity",
    "title",
    "acted_on",
    "declined",
    "body",
  ]);
  assert.equal(truth.first_head, HEAD);
  assert.equal(truth.last_head, BASE);
  assert.equal(truth.commits, 3);
  assert.equal(truth.base_sha, BASE);
  assert.deepEqual(truth.reviewers, ["coderabbitai[bot]", "cursor[bot]"]);
  // The cursor finding carries the author's decline and a bot's "Fixed in".
  // Only the author's reply counts, so acted_on stays 1.
  assert.deepEqual(truth.counts, {
    total: 2,
    acted_on: 1,
    declined: 1,
    P1: 1,
  });
  assert.equal(summary.excluded_later_head, 1);
  assert.equal(summary.first_head_source, "bot-review");
});

test("a pull request with no readable author is refused", () => {
  assert.throws(
    () =>
      harvestPr({
        pr: 1990,
        repo: REPO,
        src: "/src/dir",
        gh: stubGh({ reviews: [], author: null }),
        git: recordingGit([]),
      }),
    /no author login/,
  );
});

test("the summary line reports the excluded denominator and the fallback", () => {
  const lines = [];
  const summaries = runHarvest(["--pr", "1990", "--dry-run"], {
    gh: stubGh({ reviews: [] }),
    git: recordingGit([]),
    log: (line) => lines.push(line),
    writeFile: () => assert.fail("dry run must not write"),
    mkdir: () => assert.fail("dry run must not create directories"),
  });
  assert.equal(summaries[0].written, false);
  assert.equal(summaries[0].first_head_source, "first-commit");
  assert.match(lines[0], /^PR 1990: /);
  // commits[0] is a head only later comments sit on, so the two findings
  // raised on HEAD fall outside the reviewed head and are reported as such.
  assert.match(lines[0], /2 excluded on later heads/);
  assert.match(lines[0], /first_head from commits\[0\]: no bot review/);
  assert.match(lines[0], /reviewers 1/);
});

test("a written run emits the serialized bytes and --json prints the summary", () => {
  const writes = [];
  const lines = [];
  runHarvest(["--pr", "1990", "--out-dir", "/out", "--json"], {
    gh: stubGh({
      reviews: [botReview("claude[bot]", "2026-08-20T09:00:00Z", HEAD, 1)],
    }),
    git: recordingGit([]),
    log: (line) => lines.push(line),
    writeFile: (file, bytes) => writes.push({ file, bytes }),
    mkdir: () => {},
  });
  assert.equal(writes[0].file, "/out/pr-1990.json");
  assert.equal(writes[0].bytes, serializeTruth(JSON.parse(writes[0].bytes)));
  assert.match(writes[0].bytes, /^\{\n "pr": 1990,\n/);
  assert.ok(
    writes[0].bytes.includes(String.raw`Minor nit \u00e9`),
    "non-ascii finding bodies are escaped in the written bytes",
  );
  assert.equal(JSON.parse(lines[0])[0].out_path, "/out/pr-1990.json");
});

test("formatSummaryLine keeps the bench2 shape", () => {
  assert.equal(
    formatSummaryLine({
      pr: 1990,
      total: 7,
      acted_on: 6,
      declined: 1,
      P1: 4,
      commits: 5,
      first_head: "6d0189349a48f5a6a553b2bdaad8dd4862fe7f75",
      reviewers: 2,
      excluded_later_head: 3,
      first_head_source: "bot-review",
    }),
    "PR 1990: 7 findings (6 acted on, 1 declined, 4 P1) | 5 commits | " +
      "first_head 6d018934 | reviewers 2 | 3 excluded on later heads",
  );
});
