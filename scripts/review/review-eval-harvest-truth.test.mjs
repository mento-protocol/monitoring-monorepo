#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildFindings,
  cleanBody,
  resolveBaseSha,
  runHarvest,
  selectFirstHead,
  serializeTruth,
} from "./review-eval-harvest-truth.mjs";

const BOT = "coderabbitai[bot]";
const AUTHOR = "chapati";
const HEAD = "a".repeat(40);
const LATER = "b".repeat(40);
const BASE = "c".repeat(40);

const review = (login, submitted_at, commit_id, id) => ({
  user: { login },
  submitted_at,
  commit_id,
  id,
});

const comment = (overrides) => ({
  id: 1,
  user: { login: BOT },
  path: "a.mjs",
  line: 3,
  body: "**[P2] a defect**",
  original_commit_id: HEAD,
  in_reply_to_id: null,
  ...overrides,
});

const reply = (login, body) => ({
  id: 9,
  user: { login },
  body,
  in_reply_to_id: 1,
});

const findingsOf = (comments) =>
  buildFindings({ comments, head: HEAD, author: AUTHOR });

test("the first head is the earliest submitted bot review, not commits[0]", () => {
  const commits = [{ sha: BASE }, { sha: LATER }];
  const reviews = [
    // A human review is not a bot reading a head, however early it landed.
    review(AUTHOR, "2026-01-01T00:00:00Z", LATER, 1),
    review("claude[bot]", "2026-01-03T00:00:00Z", LATER, 3),
    review(BOT, "2026-01-02T00:00:00Z", HEAD, 2),
  ];
  assert.deepEqual(selectFirstHead({ reviews, commits }), {
    sha: HEAD,
    source: "bot-review",
  });
});

test("no bot review falls back to commits[0] and names the fallback", () => {
  const commits = [{ sha: HEAD }, { sha: LATER }];
  assert.deepEqual(selectFirstHead({ reviews: [], commits }), {
    sha: HEAD,
    source: "first-commit",
  });
  assert.throws(
    () => selectFirstHead({ reviews: [], commits: [] }),
    /no commits and no bot review/,
  );
});

test("bot comments on a later head are dropped and counted", () => {
  const { findings, excludedLaterHead } = findingsOf([
    comment({}),
    comment({ id: 2, original_commit_id: LATER }),
    comment({
      id: 3,
      original_commit_id: LATER,
      user: { login: "claude[bot]" },
    }),
    // A human root comment is not a finding on any head, and is not counted.
    comment({ id: 4, user: { login: AUTHOR } }),
  ]);
  assert.deepEqual(
    findings.map(({ id }) => id),
    [1],
  );
  assert.equal(excludedLaterHead, 2);
});

test("only the author's replies set a disposition, curled apostrophe included", () => {
  const disposition = (login, body) => {
    const [finding] = findingsOf([comment({}), reply(login, body)]).findings;
    return { acted_on: finding.acted_on, declined: finding.declined };
  };
  const none = { acted_on: false, declined: false };
  assert.deepEqual(disposition(BOT, "Fixed in abc1234"), none);
  assert.deepEqual(disposition(BOT, "Won't fix: quoting the author"), none);
  assert.deepEqual(disposition(AUTHOR, "Fixed in abc1234"), {
    acted_on: true,
    declined: false,
  });
  const declined = { acted_on: false, declined: true };
  assert.deepEqual(disposition(AUTHOR, "Won't fix: intended"), declined);
  assert.deepEqual(disposition(AUTHOR, "Won’t fix: intended"), declined);
});

test("a long collapsed analysis block leaves the finding statement leading", () => {
  const analysis = "x".repeat(4000);
  const body = [
    "<!-- fingerprinting:phantom -->",
    "_🎯 Correctness_ | _🟡 Minor_",
    "",
    "**The flush drops the batch.**",
    "",
    `<details><summary>A</summary><details>in</details>${analysis}</details>`,
    "",
    "Tail line.",
  ].join("\n");
  const [finding] = findingsOf([comment({ body })]).findings;
  assert.equal(finding.title, "The flush drops the batch.");
  assert.equal(finding.body.includes("x".repeat(50)), false);
  assert.ok(finding.body.startsWith("**The flush drops the batch.**"));
  assert.ok(finding.body.endsWith("Tail line."));
  // Severity still reads the raw body, where the stripped badge line lives.
  assert.equal(finding.severity, "P2");
  // A comment that is nothing but a collapsed block keeps its raw text.
  assert.equal(cleanBody("<details>only</details>"), "<details>only</details>");
});

test("the serializer reproduces a committed answer key byte for byte", () => {
  const key = new URL(
    "../../docs/evals/review-skill-truth/pr-2121.json",
    import.meta.url,
  );
  const bytes = readFileSync(key, "utf8");
  assert.equal(serializeTruth(JSON.parse(bytes)), bytes);
  // Every code unit outside space..tilde is escaped, as ensure_ascii does.
  const dash = String.fromCharCode(0x2014);
  const escaped = serializeTruth({ k: dash });
  assert.equal(escaped.includes(dash), false);
  assert.match(escaped, /u2014/);
});

test("base_sha is the merge-base of the first head and the fetched base ref", () => {
  const calls = [];
  const git = ({ args }) => {
    calls.push(args.join(" "));
    return args[0] === "merge-base" ? `${BASE}\n` : "";
  };
  const resolve = (baseRef, use = git) =>
    resolveBaseSha({ pr: 7, sha: HEAD, baseRef, src: "/src", git: use });
  assert.equal(resolve("main"), BASE);
  // The base ref is fetched last, so FETCH_HEAD names the base, not the head.
  assert.deepEqual(calls, [
    "fetch origin refs/pull/7/head",
    "fetch origin refs/heads/main",
    `merge-base ${HEAD} FETCH_HEAD`,
  ]);
  assert.throws(() => resolve("../evil"), /not a usable branch/);
  assert.throws(() => resolve("main", () => ""), /merge-base gave/);
});

test("a harvest writes one key per PR in the frozen key order", () => {
  const pages = {
    "pulls/7": { title: "t", user: { login: AUTHOR }, base: { ref: "main" } },
    "pulls/7/commits": [{ sha: BASE }, { sha: LATER }],
    "pulls/7/reviews": [review(BOT, "2026-01-02T00:00:00Z", HEAD, 2)],
    "pulls/7/comments": [
      comment({}),
      comment({ id: 2, original_commit_id: LATER }),
      reply(AUTHOR, "Fixed in abc1234"),
    ],
  };
  const gh = ({ apiPath }) => pages[apiPath];
  const git = ({ args }) => (args[0] === "merge-base" ? BASE : "");
  const out = mkdtempSync(path.join(tmpdir(), "review-eval-harvest-"));
  try {
    const [result] = runHarvest(["--pr", "7", "--out-dir", out], { gh, git });
    assert.equal(result.outPath, path.join(out, "pr-7.json"));
    assert.equal(readFileSync(result.outPath, "utf8"), result.bytes);
    assert.deepEqual(Object.keys(result.truth), [
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
    assert.equal(result.truth.base_sha, BASE);
    assert.equal(result.truth.first_head, HEAD);
    assert.equal(result.truth.last_head, LATER);
    assert.deepEqual(result.truth.counts, {
      total: 1,
      acted_on: 1,
      declined: 0,
      P1: 0,
    });
    assert.match(result.summary, /1 findings, 1 acted on/);
    assert.match(result.summary, /1 findings on later heads/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  assert.throws(() => runHarvest(["--pr", "main"]), /--pr is required/);
});
