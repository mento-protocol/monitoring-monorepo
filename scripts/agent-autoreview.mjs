#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "findings",
    "overall_correctness",
    "overall_explanation",
    "overall_confidence",
  ],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "body",
          "priority",
          "confidence",
          "category",
          "code_location",
        ],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 140 },
          body: { type: "string", minLength: 1, maxLength: 2000 },
          priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          category: {
            type: "string",
            enum: [
              "bug",
              "security",
              "regression",
              "test_gap",
              "maintainability",
            ],
          },
          code_location: {
            type: "object",
            additionalProperties: false,
            required: ["file_path", "line"],
            properties: {
              file_path: { type: "string", minLength: 1 },
              line: { type: "integer", minimum: 1 },
            },
          },
        },
      },
    },
    overall_correctness: {
      type: "string",
      enum: ["patch is correct", "patch is incorrect"],
    },
    overall_explanation: { type: "string", minLength: 1, maxLength: 3000 },
    overall_confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

const ENGINES = new Set(["codex", "claude", "local"]);
const TARGET_MODES = new Set(["auto", "local", "branch", "commit"]);
const MAX_BUNDLE_CHARS = 180_000;
const MAX_FILE_CHARS = 40_000;

function usage() {
  console.log(`Usage:
  scripts/agent-autoreview.mjs [options]
  pnpm agent:autoreview -- [options]  # when a repo exposes an adapter

Options:
  --mode <auto|local|branch|commit>  Review target mode (default: auto)
  --base <ref>                       Base ref for branch mode
  --commit <ref>                     Commit ref for commit mode (default: HEAD)
  --engine <codex|claude|local>      Review engine (default: AUTOREVIEW_ENGINE or codex)
  --model <name>                     Model passed through to the engine
  --thinking <level>                 Codex reasoning effort or Claude effort
  --prompt <text>                    Extra review instruction (repeatable)
  --prompt-file <path>               Extra review instruction file (repeatable)
  --dataset <path>                   Extra evidence file to include (repeatable)
  --output <path>                    Write human output to a file as well as stdout
  --json-output <path>               Write validated structured JSON
  --bundle-output <path>             Write the full review prompt/change bundle
  --prepare-only                     Build target/bundle metadata for subagent review, then exit
  --parallel-tests <command>         Run a shell test command while review runs
  --timeout-seconds <seconds>        Reviewer process timeout (default: 1800)
  --dry-run                          Print target/engine without invoking a reviewer
  --no-tools                         Disable Claude tools; Codex requires read-only sandbox
  --no-web-search                    Disable Claude WebSearch/WebFetch tools
  --stream-engine-output             Show raw engine output before structured parsing
  --help                             Show this help

Note:
  Inside an active Codex session, prefer --prepare-only --bundle-output <path>
  and spawn a fresh-context read-only subagent instead of nested codex exec.
`);
}

function parseArgs(argv) {
  const args = {
    mode: "auto",
    base: null,
    commit: "HEAD",
    engine: process.env.AUTOREVIEW_ENGINE || "codex",
    model: null,
    thinking: null,
    prompts: [],
    promptFiles: [],
    datasets: [],
    output: null,
    jsonOutput: null,
    bundleOutput: null,
    prepareOnly: false,
    parallelTests: null,
    dryRun: false,
    tools: true,
    webSearch: true,
    streamEngineOutput: false,
    timeoutSeconds: 1800,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`${value} requires an argument`);
      }
      return argv[index];
    };

    switch (value) {
      case "--":
        break;
      case "--mode":
        args.mode = next();
        break;
      case "--base":
        args.base = next();
        break;
      case "--commit":
        args.commit = next();
        break;
      case "--engine":
        args.engine = next();
        break;
      case "--model":
        args.model = next();
        break;
      case "--thinking":
        args.thinking = next();
        break;
      case "--prompt":
        args.prompts.push(next());
        break;
      case "--prompt-file":
        args.promptFiles.push(next());
        break;
      case "--dataset":
        args.datasets.push(next());
        break;
      case "--output":
        args.output = next();
        break;
      case "--json-output":
        args.jsonOutput = next();
        break;
      case "--bundle-output":
        args.bundleOutput = next();
        break;
      case "--prepare-only":
        args.prepareOnly = true;
        break;
      case "--parallel-tests":
        args.parallelTests = next();
        break;
      case "--timeout-seconds":
        args.timeoutSeconds = Number.parseInt(next(), 10);
        if (!Number.isFinite(args.timeoutSeconds) || args.timeoutSeconds <= 0) {
          throw new Error("--timeout-seconds must be a positive integer");
        }
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--no-tools":
        args.tools = false;
        break;
      case "--no-web-search":
        args.webSearch = false;
        break;
      case "--stream-engine-output":
        args.streamEngineOutput = true;
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${value}`);
    }
  }

  if (!TARGET_MODES.has(args.mode)) {
    throw new Error(`invalid --mode: ${args.mode}`);
  }
  if (!ENGINES.has(args.engine)) {
    throw new Error(`invalid --engine: ${args.engine}`);
  }
  return args;
}

function runGit(repo, gitArgs, { check = true } = {}) {
  const result = spawnSync("git", gitArgs, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (check && result.status !== 0) {
    throw new Error(
      `git ${gitArgs.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function repoRoot() {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error("autoreview must run inside a git repository");
  }
  return path.resolve(result.stdout.trim());
}

function currentBranch(repo) {
  return runGit(repo, ["branch", "--show-current"], { check: false }).trim();
}

function isDirty(repo) {
  return runGit(repo, ["status", "--porcelain"]).trim() !== "";
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function commandExists(command) {
  const result = spawnSync("sh", ["-c", `command -v ${shellQuote(command)}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0;
}

function detectPrBase(repo) {
  if (!commandExists("gh")) return null;
  const result = spawnSync(
    "gh",
    ["pr", "view", "--json", "baseRefName", "--jq", ".baseRefName"],
    {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const base = result.stdout.trim();
  return result.status === 0 && base ? `origin/${base}` : null;
}

function chooseTarget(repo, args) {
  const branch = currentBranch(repo);
  const dirty = isDirty(repo);
  const branchTarget = branch && branch !== "main";
  if (
    args.mode === "local" ||
    (args.mode === "auto" && dirty && !branchTarget)
  ) {
    return { mode: "local", ref: null };
  }
  if (args.mode === "commit") {
    return { mode: "commit", ref: args.commit };
  }
  if (
    args.mode === "branch" ||
    (args.mode === "auto" && branch && branch !== "main")
  ) {
    const ref = args.base || detectPrBase(repo) || "origin/main";
    if (args.mode === "auto" && dirty) {
      return { mode: "branch-local", ref };
    }
    return {
      mode: "branch",
      ref,
    };
  }
  throw new Error("no review target: clean main checkout and no forced mode");
}

function bounded(text, limit = MAX_BUNDLE_CHARS) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated at ${limit} characters]\n`;
}

function readText(filePath, limit = MAX_FILE_CHARS) {
  try {
    const data = readFileSync(filePath);
    if (data.includes(0)) return "[binary file omitted]";
    return bounded(data.toString("utf8"), limit);
  } catch (error) {
    return `[unreadable: ${error.message}]`;
  }
}

function localBundle(repo) {
  const parts = [
    "# Git Status",
    runGit(repo, ["status", "--short"]),
    "# Staged Diff",
    runGit(repo, ["diff", "--cached", "--stat"]),
    bounded(runGit(repo, ["diff", "--cached", "--patch", "--find-renames"])),
    "# Unstaged Diff",
    runGit(repo, ["diff", "--stat"]),
    bounded(runGit(repo, ["diff", "--patch", "--find-renames"])),
  ];
  const untracked = runGit(repo, ["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .filter(Boolean);
  if (untracked.length > 0) {
    parts.push("# Untracked Files");
    for (const rel of untracked) {
      parts.push(`## ${rel}\n${readText(path.join(repo, rel))}`);
    }
  }
  return parts.join("\n\n");
}

function branchBundle(repo, baseRef) {
  return [
    "# Branch Diff",
    `base: ${baseRef}`,
    runGit(repo, ["diff", "--stat", `${baseRef}...HEAD`]),
    bounded(
      runGit(repo, ["diff", "--patch", "--find-renames", `${baseRef}...HEAD`]),
    ),
  ].join("\n\n");
}

function branchLocalBundle(repo, baseRef) {
  return [branchBundle(repo, baseRef), "# Local Diff", localBundle(repo)].join(
    "\n\n",
  );
}

function commitBundle(repo, commitRef) {
  return [
    "# Commit Diff",
    `commit: ${commitRef}`,
    runGit(repo, ["show", "--stat", "--format=fuller", commitRef]),
    bounded(
      runGit(repo, [
        "show",
        "--patch",
        "--find-renames",
        "--format=fuller",
        commitRef,
      ]),
    ),
  ].join("\n\n");
}

function changedPaths(repo, target) {
  const sources =
    target.mode === "local"
      ? [
          runGit(repo, ["diff", "--name-only", "--cached"]),
          runGit(repo, ["diff", "--name-only"]),
          runGit(repo, ["ls-files", "--others", "--exclude-standard"]),
        ]
      : target.mode === "branch"
        ? [runGit(repo, ["diff", "--name-only", `${target.ref}...HEAD`])]
        : target.mode === "branch-local"
          ? [
              runGit(repo, ["diff", "--name-only", `${target.ref}...HEAD`]),
              runGit(repo, ["diff", "--name-only", "--cached"]),
              runGit(repo, ["diff", "--name-only"]),
              runGit(repo, ["ls-files", "--others", "--exclude-standard"]),
            ]
          : [runGit(repo, ["show", "--name-only", "--format=", target.ref])];

  return new Set(
    sources
      .join("\n")
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function loadExtras(repo, args) {
  const chunks = [];
  for (const prompt of args.prompts) chunks.push(prompt);
  for (const file of args.promptFiles) {
    const fullPath = path.resolve(repo, file);
    if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
      throw new Error(`--prompt-file must be a file, got directory: ${file}`);
    }
    chunks.push(`# Prompt file: ${file}\n${readText(fullPath)}`);
  }
  for (const file of args.datasets) {
    const fullPath = path.resolve(repo, file);
    if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
      throw new Error(`--dataset must be a file, got directory: ${file}`);
    }
    chunks.push(`# Dataset: ${file}\n${readText(fullPath)}`);
  }
  return chunks.join("\n\n");
}

function buildPrompt(repo, target, bundle, extras) {
  const targetLine = target.ref ? `${target.mode} ${target.ref}` : target.mode;
  return `You are a skeptical senior code reviewer. Review the provided git change bundle only.

Return exactly one JSON object and nothing else. The JSON object must match this schema exactly:
${JSON.stringify(REVIEW_SCHEMA, null, 2)}

Hard rules:
- Do not modify files.
- Do not invoke nested reviewers or review tools.
- Shell commands, if available, must be read-only inspection commands.
- Do not run tests, formatters, package installs, generators, network mutation commands, git mutation commands, or commands that write files.
- Report only actionable defects introduced or exposed by this change.
- Prefer high-signal findings over style feedback.
- Include security findings only for concrete, actionable risk.
- If there are no actionable findings, return an empty findings array and mark the patch correct.

Review target: ${targetLine}
Repository: ${repo}

${extras}

# Change Bundle
${bundle}`;
}

function runCommandWithInput(
  command,
  args,
  repo,
  prompt,
  { stream = false, timeoutSeconds = 1800 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repo,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer = null;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      killTimer.unref?.();
    }, timeoutSeconds * 1000);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (stream) process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      if (stream) process.stderr.write(text);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutSeconds}s`));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `${command} failed (${code ?? signal}): ${stderr || stdout}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(prompt);
  });
}

async function runCodex(repo, args, prompt) {
  if (!commandExists("codex")) {
    throw new Error("codex CLI is not available");
  }
  if (!args.tools) {
    throw new Error(
      "--no-tools is not supported for Codex; use read-only sandbox",
    );
  }
  const tempDir = mkdtempSync(path.join(tmpdir(), "autoreview-codex."));
  const schemaPath = path.join(tempDir, "schema.json");
  const outputPath = path.join(tempDir, "last-message.json");
  writeFileSync(schemaPath, JSON.stringify(REVIEW_SCHEMA));
  try {
    const codexArgs = [
      "exec",
      "--ephemeral",
      "-C",
      repo,
      "-s",
      "read-only",
      "--output-schema",
      schemaPath,
      "-o",
      outputPath,
    ];
    if (args.model) codexArgs.push("--model", args.model);
    if (args.thinking) {
      codexArgs.push("-c", `model_reasoning_effort="${args.thinking}"`);
    }
    codexArgs.push("-");
    const result = await runCommandWithInput("codex", codexArgs, repo, prompt, {
      stream: args.streamEngineOutput,
      timeoutSeconds: args.timeoutSeconds,
    });
    return existsSync(outputPath)
      ? readFileSync(outputPath, "utf8")
      : result.stdout;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runClaude(repo, args, prompt) {
  if (!commandExists("claude")) {
    throw new Error("claude CLI is not available");
  }
  const claudeArgs = [
    "--print",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(REVIEW_SCHEMA),
    "--permission-mode",
    "dontAsk",
  ];
  if (args.model) claudeArgs.push("--model", args.model);
  if (args.thinking) claudeArgs.push("--effort", args.thinking);
  if (args.tools) {
    const tools = args.webSearch
      ? "Read,Grep,Glob,WebSearch,WebFetch"
      : "Read,Grep,Glob";
    claudeArgs.push("--allowedTools", tools);
  } else {
    claudeArgs.push("--allowedTools", "");
  }
  const result = await runCommandWithInput("claude", claudeArgs, repo, prompt, {
    stream: args.streamEngineOutput,
    timeoutSeconds: args.timeoutSeconds,
  });
  return result.stdout;
}

function parseJsonCandidate(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    // Claude's JSON output mode can wrap the actual review JSON as a string.
    if (typeof parsed === "string") return parseJsonCandidate(parsed) ?? parsed;
    return parsed;
  } catch {
    return null;
  }
}

function extractReviewJson(raw) {
  const direct = parseJsonCandidate(raw);
  const candidates = [];
  if (direct) candidates.push(direct);

  if (direct && typeof direct === "object") {
    for (const key of [
      "structured_output",
      "result",
      "content",
      "text",
      "message",
    ]) {
      if (direct[key] && typeof direct[key] === "object") {
        candidates.push(direct[key]);
      }
      if (typeof direct[key] === "string") {
        const nested = parseJsonCandidate(direct[key]);
        if (nested) candidates.push(nested);
      }
    }
  }

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) {
    const sliced = parseJsonCandidate(raw.slice(first, last + 1));
    if (sliced) candidates.push(sliced);
  }

  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate === "object" &&
      Array.isArray(candidate.findings)
    ) {
      return candidate;
    }
  }
  throw new Error("review engine did not return the expected structured JSON");
}

function isNumberInRange(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function validateReport(report, paths) {
  const required = [
    "findings",
    "overall_correctness",
    "overall_explanation",
    "overall_confidence",
  ];
  for (const key of required) {
    if (!(key in report)) throw new Error(`review JSON missing ${key}`);
  }
  if (!Array.isArray(report.findings)) {
    throw new Error("review JSON findings must be an array");
  }
  if (
    !["patch is correct", "patch is incorrect"].includes(
      report.overall_correctness,
    )
  ) {
    throw new Error("review JSON has invalid overall_correctness");
  }
  if (!isNumberInRange(report.overall_confidence)) {
    throw new Error("review JSON has invalid overall_confidence");
  }
  if (
    typeof report.overall_explanation !== "string" ||
    report.overall_explanation.length === 0
  ) {
    throw new Error("review JSON has invalid overall_explanation");
  }

  const kept = [];
  for (const [index, finding] of report.findings.entries()) {
    if (!finding || typeof finding !== "object") {
      throw new Error(`finding ${index} must be an object`);
    }
    const location = finding.code_location;
    const rel = location?.file_path;
    if (
      typeof finding.title !== "string" ||
      typeof finding.body !== "string" ||
      !["P0", "P1", "P2", "P3"].includes(finding.priority) ||
      !isNumberInRange(finding.confidence) ||
      ![
        "bug",
        "security",
        "regression",
        "test_gap",
        "maintainability",
      ].includes(finding.category) ||
      !location ||
      typeof rel !== "string" ||
      typeof location.line !== "number"
    ) {
      throw new Error(`finding ${index} has invalid shape`);
    }
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
      throw new Error(`finding ${index} has invalid path: ${rel}`);
    }
    if (!paths.has(rel)) {
      console.error(`autoreview ignored out-of-scope finding ${index}: ${rel}`);
      continue;
    }
    kept.push(finding);
  }
  if (kept.length !== report.findings.length) {
    report.findings = kept;
    if (kept.length === 0) report.overall_correctness = "patch is correct";
  }
  return report;
}

function lineNumber(text, needle) {
  const index =
    typeof needle === "string" ? text.indexOf(needle) : text.search(needle);
  if (index < 0) return 1;
  return text.slice(0, index).split("\n").length;
}

function targetTreeRef(target) {
  if (!target) return null;
  if (target.mode === "branch") return "HEAD";
  if (target.mode === "commit") return target.ref;
  return null;
}

function readGitBlob(repo, treeRef, rel, limit = MAX_FILE_CHARS) {
  const result = spawnSync("git", ["show", `${treeRef}:${rel}`], {
    cwd: repo,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  if (result.stdout.includes(0)) return "[binary file omitted]";
  return bounded(result.stdout.toString("utf8"), limit);
}

function readRepoFile(repo, rel, target = null) {
  const treeRef = targetTreeRef(target);
  if (treeRef) return readGitBlob(repo, treeRef, rel, Number.MAX_SAFE_INTEGER);
  const full = path.join(repo, rel);
  if (!existsSync(full)) return null;
  return readText(full, Number.MAX_SAFE_INTEGER);
}

function addLocalFinding(
  findings,
  filePath,
  line,
  title,
  body,
  priority = "P1",
  category = "bug",
) {
  findings.push({
    title,
    body,
    priority,
    confidence: 0.9,
    category,
    code_location: {
      file_path: filePath,
      line: Math.max(1, line),
    },
  });
}

function changedSetHas(paths, rel) {
  return paths.has(rel);
}

function collectWorkflowTfVars(repo, workflowPath, target) {
  const text = readRepoFile(repo, workflowPath, target);
  if (!text) return new Set();
  const vars = new Set();
  for (const line of text.split("\n")) {
    const match = line.match(/^\s+(TF_VAR_[A-Za-z0-9_]+):/);
    if (match) vars.add(match[1]);
  }
  return vars;
}

function reviewTerraformDriftWorkflow(repo, target, paths, findings) {
  const driftPath = ".github/workflows/terraform-drift.yml";
  if (!changedSetHas(paths, driftPath)) return;
  const text = readRepoFile(repo, driftPath, target);
  if (!text) return;

  if (/terraform plan[^\n]*\|\s*tee\s+\/tmp\/tf-plan\.txt/.test(text)) {
    addLocalFinding(
      findings,
      driftPath,
      lineNumber(text, /terraform plan[^\n]*\|\s*tee\s+\/tmp\/tf-plan\.txt/),
      "Drift workflow logs raw Terraform plan output",
      "The drift workflow pipes raw `terraform plan` output through `tee` before redaction. Drift plans can include destroy-time provider state such as Discord webhook tokens or QuickNode `security_token` values. Capture to a raw temp file, sanitize into `/tmp/tf-plan.txt`, and only print/read the sanitized file.",
      "P1",
      "security",
    );
  }

  if (
    /cat\s+\/tmp\/tf-plan\.raw|readFileSync\(["']\/tmp\/tf-plan\.raw["']/.test(
      text,
    )
  ) {
    addLocalFinding(
      findings,
      driftPath,
      lineNumber(
        text,
        /cat\s+\/tmp\/tf-plan\.raw|readFileSync\(["']\/tmp\/tf-plan\.raw["']/,
      ),
      "Drift workflow exposes raw Terraform plan output",
      "The workflow still prints or reads `/tmp/tf-plan.raw` after sanitization was introduced. Only `/tmp/tf-plan.txt` should be used for logs, comments, or issues because raw Terraform output can contain provider state secrets.",
      "P1",
      "security",
    );
  }

  const sourceWorkflows = [
    ".github/workflows/alerts-rules.yml",
    ".github/workflows/alerts-infra.yml",
    ".github/workflows/aegis-terraform.yml",
  ];
  const required = new Set();
  for (const workflow of sourceWorkflows) {
    for (const name of collectWorkflowTfVars(repo, workflow, target))
      required.add(name);
  }
  const present = collectWorkflowTfVars(repo, driftPath, target);
  const missing = [...required].filter((name) => !present.has(name)).sort();
  if (missing.length > 0) {
    const anchor = text.includes("Union of every TF_VAR")
      ? "Union of every TF_VAR"
      : "env:";
    addLocalFinding(
      findings,
      driftPath,
      lineNumber(text, anchor),
      "Drift workflow is missing auto-applied stack TF_VAR secrets",
      `The drift job now discovers every auto-applied stack, but its env union is missing: ${missing.join(", ")}. Those stacks will fail refresh/plan or produce misleading drift results when the scheduled workflow reaches them. Keep this union in sync with alerts-rules, alerts-infra, and aegis Terraform workflows.`,
      "P1",
      "bug",
    );
  }

  const needsRedaction =
    /TF_VAR_discord_|TF_VAR_quicknode_|discord.*webhooks|security_token/i.test(
      text,
    );
  if (
    needsRedaction &&
    !/security_token\[/.test(text) &&
    !/discord\(app\)\?/.test(text)
  ) {
    addLocalFinding(
      findings,
      driftPath,
      lineNumber(text, "terraform plan"),
      "Drift workflow lacks token redaction rules",
      "This workflow has Discord or QuickNode secret context but no matching plan-output redaction rules. Add the same sanitizer used by the alert Terraform PR-plan workflows before printing logs or opening drift issues.",
      "P1",
      "security",
    );
  }
}

function deletedFileReferenceChecks(repo, target) {
  const checks = [];
  const seen = new Set();
  const add = (deleted, treeRef) => {
    for (const rel of deleted
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean)) {
      const key = `${treeRef || "worktree"}\0${rel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      checks.push({ rel, treeRef });
    }
  };

  if (target.mode === "branch" || target.mode === "branch-local") {
    add(
      runGit(repo, [
        "diff",
        "--name-only",
        "--diff-filter=D",
        `${target.ref}...HEAD`,
      ]),
      "HEAD",
    );
  }
  if (target.mode === "commit") {
    add(
      runGit(repo, [
        "show",
        "--name-only",
        "--diff-filter=D",
        "--format=",
        target.ref,
      ]),
      target.ref,
    );
  }
  if (target.mode === "local" || target.mode === "branch-local") {
    add(
      runGit(repo, ["diff", "--name-only", "--diff-filter=D", "--cached"]),
      null,
    );
    add(runGit(repo, ["diff", "--name-only", "--diff-filter=D"]), null);
  }

  return checks;
}

function reviewDeletedFileReferences(repo, target, findings) {
  for (const { rel, treeRef } of deletedFileReferenceChecks(repo, target)) {
    const grepArgs = treeRef
      ? ["grep", "-n", "-F", "--", rel, treeRef, "--", "."]
      : ["grep", "-n", "-F", "--", rel, "--", "."];
    const result = spawnSync("git", grepArgs, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0 || !result.stdout.trim()) continue;
    const treePrefix = treeRef ? `${treeRef}:` : "";
    const hit = result.stdout
      .split("\n")
      .map((line) =>
        treePrefix && line.startsWith(treePrefix)
          ? line.slice(treePrefix.length)
          : line,
      )
      .find((line) => !line.startsWith(`${rel}:`));
    if (!hit) continue;
    const fileSeparator = hit.indexOf(":");
    if (fileSeparator === -1) continue;
    const filePath = hit.slice(0, fileSeparator);
    const lineAndContent = hit.slice(fileSeparator + 1);
    const lineSeparator = lineAndContent.indexOf(":");
    const rawLine =
      lineSeparator === -1
        ? lineAndContent
        : lineAndContent.slice(0, lineSeparator);
    addLocalFinding(
      findings,
      filePath,
      Number.parseInt(rawLine, 10) || 1,
      "Deleted file is still referenced",
      `This change deletes \`${rel}\`, but \`${filePath}\` still references that exact path. Update or remove the stale reference so future runbooks and agents do not follow a dead file path.`,
      "P2",
      "maintainability",
    );
  }
}

function reviewDocsDrift(repo, target, paths, findings) {
  const docsLike = [
    "BACKLOG.md",
    "README.md",
    "AGENTS.md",
    "SPEC.md",
    ...[...paths].filter(
      (rel) => rel.startsWith("docs/") && rel.endsWith(".md"),
    ),
  ];
  const seen = new Set();
  const stalePatterns = [
    {
      pattern: /skip[s]?\s+`?alerts-delivery`?|`alerts-delivery`[^.\n]*skip/i,
      title: "Docs still say alerts-delivery drift is skipped",
      body: "`alerts-delivery` is no longer filtered out of drift detection in this change. This stale note will make future operators expect a skip that no longer exists.",
    },
    {
      pattern:
        /aegis once PR|PR #629 lands|bring `?aegis\/terraform\/?`? under CI auto-apply/i,
      title: "Docs still describe Aegis auto-apply as future work",
      body: "Aegis is already registered as an auto-applied Terraform stack in this branch. Update this stale future-tense note so the runbook matches the workflow registry.",
    },
  ];
  for (const rel of docsLike) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const text = readRepoFile(repo, rel, target);
    if (!text) continue;
    for (const stale of stalePatterns) {
      if (!stale.pattern.test(text)) continue;
      addLocalFinding(
        findings,
        rel,
        lineNumber(text, stale.pattern),
        stale.title,
        stale.body,
        "P2",
        "maintainability",
      );
    }
  }
}

function diffCheckCommands(target) {
  if (target.mode === "branch") {
    return [["diff", "--check", `${target.ref}...HEAD`]];
  }
  if (target.mode === "commit") {
    return [["show", "--format=", "--check", target.ref]];
  }
  if (target.mode === "branch-local") {
    return [
      ["diff", "--check", `${target.ref}...HEAD`],
      ["diff", "--cached", "--check"],
      ["diff", "--check"],
    ];
  }
  return [
    ["diff", "--cached", "--check"],
    ["diff", "--check"],
  ];
}

function reviewDiffCheck(repo, target, findings) {
  const outputs = [];
  for (const gitArgs of diffCheckCommands(target)) {
    const result = spawnSync("git", gitArgs, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    if (output) outputs.push(output);
  }
  const output = outputs.join("\n");
  if (!output) return;
  const first = output.split("\n").find(Boolean) || output;
  const match = first.match(/^(.+):(\d+):\s*(.+)$/);
  addLocalFinding(
    findings,
    match?.[1] || "git diff",
    match ? Number.parseInt(match[2], 10) : 1,
    "Diff contains whitespace or conflict-marker errors",
    output.split("\n").slice(0, 10).join("\n"),
    "P2",
    "maintainability",
  );
}

function runLocalReview(
  repo,
  target,
  paths,
  reason = "deterministic local review",
) {
  const findings = [];
  reviewTerraformDriftWorkflow(repo, target, paths, findings);
  reviewDeletedFileReferences(repo, target, findings);
  reviewDocsDrift(repo, target, paths, findings);
  reviewDiffCheck(repo, target, findings);
  return {
    findings,
    overall_correctness:
      findings.length > 0 ? "patch is incorrect" : "patch is correct",
    overall_explanation:
      findings.length > 0
        ? `Local autoreview found ${findings.length} deterministic finding(s). ${reason}.`
        : `Local autoreview found no deterministic findings. ${reason}; this is not a full second-model semantic review.`,
    overall_confidence: findings.length > 0 ? 0.9 : 0.75,
  };
}

function printReport(report) {
  const lines = [];
  if (
    report.findings.length === 0 &&
    report.overall_correctness === "patch is correct"
  ) {
    lines.push("autoreview clean: no accepted/actionable findings reported");
  } else {
    lines.push(`autoreview findings: ${report.findings.length}`);
  }
  for (const finding of report.findings) {
    const loc = finding.code_location;
    lines.push("");
    lines.push(`[${finding.priority}] ${finding.title}`);
    lines.push(`${loc.file_path}:${loc.line}`);
    lines.push(finding.body);
    lines.push(`confidence: ${finding.confidence}`);
  }
  lines.push("");
  lines.push(
    `overall: ${report.overall_correctness} (${report.overall_confidence})`,
  );
  lines.push(report.overall_explanation);
  return `${lines.join("\n")}\n`;
}

function startParallelTests(command, repo) {
  console.log(`tests: ${command}`);
  const child = spawn(command, {
    cwd: repo,
    shell: true,
    stdio: "inherit",
  });
  const done = new Promise((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
  return { done };
}

function finishParallelTests(testRun) {
  return testRun?.done ?? Promise.resolve(0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = repoRoot();
  let target;
  try {
    target = chooseTarget(repo, args);
  } catch (error) {
    if (
      args.dryRun &&
      error.message ===
        "no review target: clean main checkout and no forced mode"
    ) {
      target = { mode: "none", ref: null };
    } else {
      throw error;
    }
  }
  const branch = currentBranch(repo) || "detached";

  console.log(`autoreview target: ${target.mode}`);
  console.log(`branch: ${branch}`);
  console.log(`engine: ${args.engine}`);
  if (target.ref) console.log(`ref: ${target.ref}`);
  console.log(`tools: ${args.tools ? "on" : "off"}`);
  console.log(`web_search: ${args.webSearch ? "on" : "off"}`);
  if (args.dryRun) return 0;

  const paths = changedPaths(repo, target);
  if (paths.size === 0) {
    console.log("autoreview clean: no changed files for selected target");
    return 0;
  }

  const bundle =
    target.mode === "local"
      ? localBundle(repo)
      : target.mode === "branch"
        ? branchBundle(repo, target.ref)
        : target.mode === "branch-local"
          ? branchLocalBundle(repo, target.ref)
          : commitBundle(repo, target.ref);
  const prompt = buildPrompt(repo, target, bundle, loadExtras(repo, args));
  console.log(`bundle: ${prompt.length} chars`);
  if (args.bundleOutput) {
    writeFileSync(args.bundleOutput, prompt);
    console.log(`bundle_output: ${args.bundleOutput}`);
  }
  if (args.prepareOnly) {
    console.log(
      JSON.stringify(
        {
          target,
          branch,
          engine: args.engine,
          changed_paths: [...paths].sort(),
          bundle_chars: prompt.length,
          bundle_output: args.bundleOutput,
          recommended_next_step:
            "Inside Codex, spawn a fresh-context read-only subagent with this bundle instead of running nested codex exec.",
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const tests = args.parallelTests
    ? startParallelTests(args.parallelTests, repo)
    : null;
  let report;
  try {
    if (args.engine === "local") {
      report = runLocalReview(repo, target, paths);
    } else {
      const raw =
        args.engine === "codex"
          ? await runCodex(repo, args, prompt)
          : await runClaude(repo, args, prompt);
      report = validateReport(extractReviewJson(raw), paths);
    }
  } finally {
    const testStatus = await finishParallelTests(tests);
    if (testStatus !== 0) {
      console.error(`tests failed with exit code ${testStatus}`);
      process.exitCode = 1;
    }
  }

  if (args.jsonOutput) {
    writeFileSync(args.jsonOutput, `${JSON.stringify(report, null, 2)}\n`);
  }
  const human = printReport(report);
  process.stdout.write(human);
  if (args.output) writeFileSync(args.output, human);

  if (
    process.exitCode ||
    report.findings.length > 0 ||
    report.overall_correctness === "patch is incorrect"
  ) {
    return 1;
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`autoreview failed: ${error.message}`);
    process.exitCode = 1;
  });
