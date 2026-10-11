#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { makePlan, runCampaign } from "./review-eval-v2-runner.mjs";

export async function main(argv = process.argv.slice(2)) {
  const [mode, ...args] = argv.filter((arg) => arg !== "--");
  if (!mode || mode === "--help" || mode === "help") {
    process.stdout.write(
      "review:eval:v2 plan --dataset FILE --incumbent DIR --candidate DIR --out DIR [--model claude-opus-5] [--effort high]\nreview:eval:v2 run --out DIR\nreview:eval:v2 score --out DIR [--dataset FILE] [--model GRADER_MODEL] [--effort GRADER_EFFORT]\nreview:eval:v2 report --out DIR\nProvider concurrency is 1. Runs require verified Claude subscription authentication and have no dollar stop. Score overrides change grading only; omitted settings use the plan. Only run and score use model quota.\n",
    );
    return;
  }
  const { values } = parseArgs({
    args,
    strict: true,
    options: Object.fromEntries(
      [
        "dataset",
        "incumbent",
        "candidate",
        "out",
        "budget",
        "model",
        "effort",
      ].map((name) => [name, { type: "string" }]),
    ),
  });
  if (values.budget !== undefined)
    throw new Error(
      "--budget is retired; subscription runs have no dollar stop",
    );
  if (!values.out) throw new Error("--out is required");
  const allowed =
    mode === "plan"
      ? [
          "dataset",
          "incumbent",
          "candidate",
          "out",
          "budget",
          "model",
          "effort",
        ]
      : mode === "score"
        ? ["out", "dataset", "model", "effort"]
        : ["out"];
  if (Object.keys(values).some((key) => !allowed.includes(key)))
    throw new Error(`option not supported for ${mode}`);
  let result;
  if (mode === "plan") {
    for (const name of ["dataset", "incumbent", "candidate"])
      if (!values[name]) throw new Error(`--${name} is required`);
    result = makePlan({
      datasetFile: values.dataset,
      incumbent: values.incumbent,
      candidate: values.candidate,
      out: values.out,
      ...(values.model ? { model: values.model } : {}),
      ...(values.effort ? { effort: values.effort } : {}),
    });
  } else if (mode === "run" || mode === "score") {
    result = await runCampaign({
      out: values.out,
      scoreOnly: mode === "score",
      datasetFile: values.dataset,
      graderModel: values.model,
      graderEffort: values.effort,
    });
    if (result.status !== "completed") process.exitCode = 1;
  } else if (mode === "report")
    result = JSON.parse(
      readFileSync(path.join(values.out, "report.json"), "utf8"),
    );
  else throw new Error(`unknown mode ${mode}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
