#!/usr/bin/env node
/**
 * Proves the HCL scan cache in `hcl.mjs` is an identity, not an optimization
 * that changes answers.
 *
 * Run: node scripts/lib/hcl.test.mjs (`pnpm tf:test` imports it)
 *
 * The scan is a pure function of the source text, so memoizing it may only ever
 * return the strings the first scan produced. That is checkable rather than
 * assumable: the same derivation runs over every real `.tf` file in the tree
 * with the cache off and with it on, and the two results have to match byte for
 * byte. The cache is keyed by content, so the control that matters is the
 * opposite one — two texts that differ by a single byte must not collapse onto
 * one entry.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  commentMaskedHcl,
  hclAnalysisCacheSize,
  nestedBlocks,
  structuralHcl,
  terraformTopLevelBlocks,
} from "./hcl.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** Every `.tf` file in the working tree, walked from the repo root. */
function terraformFiles(directory, found = {}) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      terraformFiles(full, found);
    } else if (entry.isFile() && entry.name.endsWith(".tf")) {
      found[path.relative(repoRoot, full)] = readFileSync(full, "utf8");
    }
  }
  return found;
}

/**
 * Every view the module derives from one scan, as one comparable string.
 *
 * `terraformTopLevelBlocks` is what reaches the delimiter view and the three
 * unterminated-construct flags, which the two exported masks never expose.
 */
function derivedViews(files) {
  const errors = [];
  const blocks = terraformTopLevelBlocks(files, errors);
  return JSON.stringify(
    {
      errors,
      masks: Object.entries(files).map(([filePath, contents]) => [
        filePath,
        commentMaskedHcl(contents),
        structuralHcl(contents),
      ]),
      blocks: blocks.map((block) => [
        block.filePath,
        block.kind,
        block.labels,
        block.start,
        block.end,
        block.text,
        block.code,
        nestedBlocks(block, "lifecycle").map((nested) => nested.code),
        nestedBlocks(block, "condition").map((nested) => nested.code),
      ]),
    },
    null,
    0,
  );
}

function withCache(enabled, run) {
  const previous = process.env.HCL_ANALYSIS_CACHE;
  if (enabled) delete process.env.HCL_ANALYSIS_CACHE;
  else process.env.HCL_ANALYSIS_CACHE = "0";
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.HCL_ANALYSIS_CACHE;
    else process.env.HCL_ANALYSIS_CACHE = previous;
  }
}

const realTree = terraformFiles(repoRoot);
assert.ok(
  Object.keys(realTree).length > 50,
  `expected the repo's Terraform tree, found ${Object.keys(realTree).length} files`,
);

// Awkward shapes the masks and the three flags key off, kept alongside the real
// tree because a well-formed tree never reaches those branches.
const edgeCases = {
  "edge/heredoc.tf": 'x = <<-EOT\n  # not a comment\n  "not a string"\nEOT\n',
  "edge/unterminated-heredoc.tf": "x = <<EOT\nnever closed\n",
  "edge/unterminated-template.tf": 'resource "a" "b" {\n  x = "open\n',
  "edge/unterminated-comment.tf": '/* open\nresource "a" "b" {}\n',
  "edge/interpolation.tf":
    'locals {\n  x = "${var.a}-$${literal}-%{if true}y%{endif}"\n}\n',
  "edge/crlf.tf": 'resource "a" "b" {\r\n  # comment\r\n  x = "y"\r\n}\r\n',
};

const uncached = withCache(false, () => derivedViews(realTree));
const cachedFirst = withCache(true, () => derivedViews(realTree));
const cachedAgain = withCache(true, () => derivedViews(realTree));
assert.equal(cachedFirst, uncached, "memoized real-tree views drifted");
assert.equal(cachedAgain, uncached, "a pure cache-hit pass drifted");

const uncachedEdges = withCache(false, () => derivedViews(edgeCases));
assert.equal(
  withCache(true, () => derivedViews(edgeCases)),
  uncachedEdges,
  "memoized views of unterminated or templated HCL drifted",
);

// The control: a content-keyed cache must not serve one text's scan for
// another's. A single changed byte is the smallest way to prove the key
// discriminates, and it lands on live code because both reads go through the
// same populated cache.
const original = 'resource "a" "b" {\n  x = "y" # note\n}\n';
const mutated = original.replace('x = "y"', 'x = "z"');
const originalMask = withCache(true, () => commentMaskedHcl(original));
const mutatedMask = withCache(true, () => commentMaskedHcl(mutated));
assert.equal(
  originalMask,
  withCache(false, () => commentMaskedHcl(original)),
  "the cached mask disagrees with a fresh scan of the same text",
);
assert.notEqual(
  originalMask,
  mutatedMask,
  "two texts collapsed onto one cache entry",
);

// The ceiling exists for a caller that streams unique text. Pinning the real
// tree's distance from it is what makes clearing-on-overflow the right policy:
// nothing this repo runs ever gets close enough to thrash.
assert.ok(
  hclAnalysisCacheSize() < 2048,
  `the real tree filled ${hclAnalysisCacheSize()} cache entries, close to the 4096 ceiling`,
);

// The overflow-clear branch itself: once the cache reaches the 4096 ceiling,
// the next insert clears the whole cache rather than evicting one entry or
// growing past it. Push enough unique text through to force several clear
// cycles, then confirm the size stayed bounded — unbounded growth here would
// mean the clear stopped running. One extra insert past the even 2x4096
// multiple keeps the final size independent of how many entries earlier
// tests left behind: 4096*2 alone can land exactly on the ceiling (still
// failing `< 4096`) whenever the starting size is a multiple of the cycle.
withCache(true, () => {
  for (let index = 0; index < 4096 * 2 + 1; index += 1) {
    commentMaskedHcl(`resource "overflow" "probe${index}" {}\n`);
  }
  assert.ok(
    hclAnalysisCacheSize() < 4096,
    `cache held ${hclAnalysisCacheSize()} entries after forcing overflow; the clear-on-ceiling branch did not run`,
  );
});

console.log("HCL scan cache tests passed");
