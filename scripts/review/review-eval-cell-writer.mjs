#!/usr/bin/env node

// Turn one finished contestant stream into the cell's `result.json`.
//
// The orchestrator runs this out of its sealed source snapshot, beside the
// stream parser it imports, so the bytes that decide what a paid cell records
// are the bytes the plan's `orchestrator_digest` names. Reading the parser out
// of the live checkout instead let it change between two cells of one run while
// every cell fingerprint stayed identical.
//
// Arguments: the raw stream file, the finder report file, and the result path.
// `--preflight` loads the parser and exits, which is what the orchestrator runs
// before the paid call.
//
// Exit codes: 4 is a harness fault — the parser did not load — and the caller
// keeps the paid cell directory; 3 is a stream the cell itself broke, and the
// caller caches nothing.

import { readFileSync, writeFileSync } from "node:fs";

const [first, ...rest] = process.argv.slice(2);

// The import is dynamic so a parser that will not load exits 4 instead of
// node's own 1, which the caller reads as the cell failing.
let stream;
try {
  stream = await import("./review-eval-stream.mjs");
} catch (error) {
  writeFileSync(
    2,
    `the stream parser beside ${import.meta.url} did not load: ${error.message}\n`,
  );
  process.exit(4);
}

if (first === "--preflight") process.exit(0);

const [rawPath, otherPath, resultPath] = [first, ...rest];
const raw = readFileSync(rawPath, "utf8");
let envelope;
try {
  envelope = stream.claudeStreamEnvelope(raw, { label: "contestant" });
} catch (error) {
  // The parser names what it could not read — a truncated line, a missing
  // result event. Swallowing that left exit 3 as the only evidence, and a
  // caller reading the run log could not tell one broken stream from another.
  writeFileSync(2, `the contestant stream did not parse: ${error.message}\n`);
  process.exit(3);
}
if (envelope.is_error || envelope.result.trim() === "") process.exit(3);
const other = readFileSync(otherPath, "utf8");
// The write is synchronous because `process.exit` drops a queued asynchronous
// one.
writeFileSync(
  resultPath,
  `${JSON.stringify(
    {
      cell_id: process.env.REVIEW_EVAL_CELL,
      pr: Number(process.env.REVIEW_EVAL_PR),
      condition: process.env.REVIEW_EVAL_CONDITION,
      draw: Number(process.env.REVIEW_EVAL_DRAW),
      model: process.env.REVIEW_EVAL_MODEL,
      effort: process.env.REVIEW_EVAL_EFFORT,
      finder: process.env.REVIEW_EVAL_FINDER || null,
      fixture_path: process.env.REVIEW_EVAL_FIXTURE,
      fingerprint: JSON.parse(process.env.REVIEW_EVAL_FINGERPRINT),
      ok: true,
      output: envelope.result,
      assistant_messages: envelope.assistant_messages,
      assistant_messages_kept: envelope.assistant_messages_kept,
      stream_chars: envelope.stream_chars,
      other_review: other,
      finder_chars: Number(process.env.REVIEW_EVAL_FINDER_CHARS),
      seconds: Number(process.env.REVIEW_EVAL_SECONDS),
      cost_usd: envelope.total_cost_usd ?? 0,
      turns: envelope.num_turns ?? null,
    },
    null,
    1,
  )}\n`,
);
