#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { fetchReadyState, parseArgs } from "./pr-ready-state.mjs";
import { summarizeFeedbackState } from "./pr-feedback-state-core.mjs";

function usage() {
  return `Usage: pnpm pr:feedback-state <pr-number-or-url> [--repo <[host/]owner/name>] [--json] [--watch]
       pnpm pr:feedback-state --pr <pr-number-or-url> [--repo <[host/]owner/name>] [--json] [--watch]
       pnpm pr:feedback-state --help

Note: output is always JSON. --watch emits one compact JSON object per poll.
`;
}

function parseFeedbackArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true, watch: false, prArg: null, repoArg: null };
  }

  const unsupported = argv.filter((arg) => ["--compact"].includes(String(arg)));
  if (unsupported.length > 0) {
    throw new Error(`${unsupported[0]} is not supported\n${usage()}`);
  }

  const parsed = parseArgs(
    argv.includes("--json") ? argv : [...argv, "--json"],
  );
  return {
    help: false,
    watch: parsed.watch,
    prArg: parsed.prArg,
    repoArg: parsed.repoArg ?? null,
  };
}

function renderFeedbackState(feedbackState, { watch = false } = {}) {
  return `${JSON.stringify(feedbackState, null, watch ? 0 : 2)}\n`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  try {
    const { help, watch, prArg, repoArg } = parseFeedbackArgs(
      process.argv.slice(2),
    );
    if (help) {
      process.stdout.write(usage());
      return;
    }

    for (;;) {
      try {
        const readyState = await fetchReadyState({ prArg, repoArg });
        process.stdout.write(
          renderFeedbackState(summarizeFeedbackState(readyState), { watch }),
        );
      } catch (err) {
        if (!watch) throw err;
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[pr-feedback-state] ${message}\n`);
      }
      if (!watch) return;
      await sleep(60_000);
    }
  } catch (err) {
    process.stderr.write(err instanceof Error ? err.message : String(err));
    if (!String(err).endsWith("\n")) process.stderr.write("\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

export { parseFeedbackArgs, renderFeedbackState };
