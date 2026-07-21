import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export const NAVIGATION_EVAL_MARKER = "<!-- docs-navigation-eval-issue:v1 -->";
export const NAVIGATION_EVAL_MONTH_MARKER_PREFIX =
  "<!-- docs-navigation-eval-month:v1 ";
export const NAVIGATION_EVAL_SCHEMA_VERSION = 1;
export const NAVIGATION_EVAL_SUITE_ID = "documentation-navigation-v1";
export const NAVIGATION_EVAL_EPIC = 1341;
export const NAVIGATION_EVAL_MAX_EVIDENCE_LINES = 21;

const REQUIRED_CATEGORIES = [
  "packages",
  "deployment",
  "architecture",
  "pr-hazards",
  "commands",
  "operator-workflows",
];
const ISSUE_STATE_LABELS = [
  "needs-grooming",
  "agent-ready",
  "agent-active",
  "in-pr",
];
const ISSUE_LABELS = [
  "agent-ready",
  "documentation",
  "pkg:tooling",
  "kind:refactor",
  "source:audit",
  "priority:p2",
  "risk:low",
];
const NAVIGATION_EVAL_OWNERSHIP_LABEL = "source:audit";

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(values) {
  return (
    Array.isArray(values) &&
    values.every((value) => typeof value === "string" && value.length > 0) &&
    new Set(values).size === values.length
  );
}

export function inventoryMap(inventory) {
  return new Map(inventory.records.map((record) => [record.path, record]));
}

export function fixtureDigest(suite) {
  return createHash("sha256").update(JSON.stringify(suite)).digest("hex");
}

export function isNavigationEvalAnswerArtifact(file) {
  return (
    typeof file === "string" &&
    /^docs\/evals\/documentation-navigation-.*\.json$/.test(file) &&
    file !== "docs/evals/documentation-navigation-fixtures.json" &&
    file !== "docs/evals/documentation-navigation-result.schema.json"
  );
}

export function navigationContextFloor(suite, inventory) {
  const records = inventoryMap(inventory);
  const uniqueSources = new Set(suite.bootstrap_sources);
  const questions = suite.questions.map((question) => {
    const routes = question.accepted_routes
      .map((route) => ({
        route,
        bytes: route.reduce((sum, file) => {
          const record = records.get(file);
          if (!record) throw new Error(`missing documentation route: ${file}`);
          return sum + record.bytes;
        }, 0),
      }))
      .sort(
        (left, right) =>
          left.bytes - right.bytes ||
          left.route.length - right.route.length ||
          left.route.join("\n").localeCompare(right.route.join("\n")),
      );
    const selected = routes[0];
    if (!selected) throw new Error(`question ${question.id} has no route`);
    for (const file of selected.route) uniqueSources.add(file);
    return {
      question_id: question.id,
      route: [...selected.route],
      source_bytes: selected.bytes,
    };
  });
  return {
    max_question_route_bytes: Math.max(
      ...questions.map((question) => question.source_bytes),
    ),
    total_unique_route_bytes: [...uniqueSources].reduce((sum, file) => {
      const record = records.get(file);
      if (!record) throw new Error(`missing documentation source: ${file}`);
      return sum + record.bytes;
    }, 0),
    questions,
  };
}

export function validateFixtureSuite(suite, inventory) {
  const errors = [];
  const records = inventoryMap(inventory);
  if (!isObject(suite)) return ["fixture suite must be a JSON object"];
  if (suite.schema_version !== NAVIGATION_EVAL_SCHEMA_VERSION) {
    errors.push("fixture schema_version must be 1");
  }
  if (suite.suite_id !== NAVIGATION_EVAL_SUITE_ID) {
    errors.push(`fixture suite_id must be ${NAVIGATION_EVAL_SUITE_ID}`);
  }
  const targets = suite.targets;
  if (!isObject(targets)) {
    errors.push("fixtures.targets must be an object");
  } else {
    if (
      !Number.isFinite(targets.routing_accuracy_percent) ||
      targets.routing_accuracy_percent < 90 ||
      targets.routing_accuracy_percent > 100
    ) {
      errors.push("routing_accuracy_percent must be between 90 and 100");
    }
    if (targets.unqualified_noncanonical_sources !== 0) {
      errors.push("unqualified_noncanonical_sources target must be zero");
    }
    if (
      !Number.isFinite(targets.answer_evidence_percent) ||
      targets.answer_evidence_percent < 0 ||
      targets.answer_evidence_percent > 100
    ) {
      errors.push("answer_evidence_percent must be between 0 and 100");
    }
    if (
      !Number.isSafeInteger(targets.questions_over_context_budget) ||
      targets.questions_over_context_budget < 0
    ) {
      errors.push(
        "questions_over_context_budget must be a non-negative integer",
      );
    }
    for (const field of [
      "max_question_source_bytes",
      "max_total_unique_source_bytes",
    ]) {
      if (!Number.isSafeInteger(targets[field]) || targets[field] <= 0) {
        errors.push(`${field} must be a positive integer`);
      }
    }
  }

  if (
    !uniqueStrings(suite.bootstrap_sources) ||
    suite.bootstrap_sources.length < 2
  ) {
    errors.push("bootstrap_sources must contain at least two unique paths");
  } else {
    for (const file of suite.bootstrap_sources) {
      const record = records.get(file);
      if (!record) errors.push(`bootstrap source is not documented: ${file}`);
      else if (record.authority !== "canonical") {
        errors.push(`bootstrap source must be canonical: ${file}`);
      }
    }
  }
  if (!uniqueStrings(suite.forbidden_sources)) {
    errors.push("forbidden_sources must contain unique paths");
  }

  if (
    !Array.isArray(suite.questions) ||
    suite.questions.length < 15 ||
    suite.questions.length > 20
  ) {
    errors.push("fixtures must define 15 to 20 questions");
    return errors;
  }
  const ids = new Set();
  const categories = new Set();
  for (const question of suite.questions) {
    if (!isObject(question)) {
      errors.push("every question must be an object");
      continue;
    }
    if (typeof question.id !== "string" || !/^[a-z0-9-]+$/.test(question.id)) {
      errors.push("question ids must use lowercase kebab-case");
    } else if (ids.has(question.id)) {
      errors.push(`duplicate question id: ${question.id}`);
    } else {
      ids.add(question.id);
    }
    if (!REQUIRED_CATEGORIES.includes(question.category)) {
      errors.push(
        `question ${question.id ?? "unknown"} has an invalid category`,
      );
    } else {
      categories.add(question.category);
    }
    if (
      typeof question.question !== "string" ||
      question.question.length < 20
    ) {
      errors.push(`question ${question.id ?? "unknown"} is too short`);
    }
    if (
      !Array.isArray(question.accepted_routes) ||
      question.accepted_routes.length === 0
    ) {
      errors.push(
        `question ${question.id ?? "unknown"} needs an accepted route`,
      );
    } else {
      for (const route of question.accepted_routes) {
        if (!uniqueStrings(route) || route.length === 0) {
          errors.push(`question ${question.id} has an invalid accepted route`);
          continue;
        }
        for (const file of route) {
          const record = records.get(file);
          if (!record)
            errors.push(`question ${question.id} route is missing: ${file}`);
          else if (record.authority !== "canonical") {
            errors.push(
              `question ${question.id} route is not canonical: ${file}`,
            );
          }
        }
      }
    }
    if (!Array.isArray(question.sources_requiring_verification)) {
      errors.push(
        `question ${question.id} must define sources_requiring_verification`,
      );
    } else {
      for (const source of question.sources_requiring_verification) {
        const sourceRecord = records.get(source?.path);
        if (!sourceRecord) {
          errors.push(
            `question ${question.id} verification source is missing: ${source?.path}`,
          );
        } else if (sourceRecord.authority === "canonical") {
          errors.push(
            `question ${question.id} verification source is already canonical: ${source.path}`,
          );
        }
        if (
          !uniqueStrings(source?.verify_against) ||
          source.verify_against.length === 0
        ) {
          errors.push(
            `question ${question.id} verification source needs canonical targets`,
          );
        } else {
          for (const target of source.verify_against) {
            if (records.get(target)?.authority !== "canonical") {
              errors.push(
                `question ${question.id} verification target is not canonical: ${target}`,
              );
            }
          }
        }
      }
    }
  }
  for (const category of REQUIRED_CATEGORIES) {
    if (!categories.has(category))
      errors.push(`fixtures do not cover category: ${category}`);
  }
  if (errors.length === 0) {
    const floor = navigationContextFloor(suite, inventory);
    if (floor.max_question_route_bytes > targets.max_question_source_bytes) {
      errors.push(
        `cheapest accepted route needs ${floor.max_question_route_bytes} bytes; max_question_source_bytes is ${targets.max_question_source_bytes}`,
      );
    }
    if (
      floor.total_unique_route_bytes > targets.max_total_unique_source_bytes
    ) {
      errors.push(
        `cheapest accepted route union needs ${floor.total_unique_route_bytes} bytes; max_total_unique_source_bytes is ${targets.max_total_unique_source_bytes}`,
      );
    }
  }
  return errors;
}

export function buildNavigationPrompt(
  suite,
  { baseCommit, questionId = null } = {},
) {
  const selectedQuestions = questionId
    ? suite.questions.filter((question) => question.id === questionId)
    : suite.questions;
  if (selectedQuestions.length === 0) {
    throw new Error(`unknown question: ${questionId}`);
  }
  if (!/^[0-9a-f]{40}$/.test(baseCommit ?? "")) {
    throw new Error("prompt generation requires a 40-character base commit");
  }
  const questions = selectedQuestions
    .map(
      (question, index) =>
        `${index + 1}. [${question.id}] (${question.category}) ${question.question}`,
    )
    .join("\n");
  const answerScope = questionId
    ? `- This is a bounded escalation for \`${questionId}\`. Return exactly one answer object in the \`answers\` array. Validate it with \`pnpm docs:navigation-eval -- --validate <result.json> --question ${questionId}\`.`
    : "- Answer every question in the suite; the `answers` array must contain all 15-20 answers.";
  return `# Fresh-agent documentation navigation evaluation

You are a fresh, read-only repository agent. Measure whether the repository's
documentation routes you to current authority without loading the whole corpus.

Rules:

- Do not edit files, mutate GitHub, deploy, or use secrets.
- Do not use network access; this is a repository-local retrieval evaluation.
- Begin with the already supplied bootstrap sources: ${suite.bootstrap_sources
    .map((file) => `\`${file}\``)
    .join(", ")}.
- Retrieve only the narrowest documentation needed for each question. Do not
  inventory or preload the full documentation tree.
- Do not open these evaluation-answer sources: ${suite.forbidden_sources
    .map((file) => `\`${file}\``)
    .join(", ")}.
- Do not open any evaluation answer artifact matching
  \`docs/evals/documentation-navigation-*.json\`. The fixture contract is not
  an answer artifact but remains forbidden by the explicit list above; the
  result schema remains allowed.
- Treat canonical documents as current operating authority. If you consult a
  non-canonical or unmanaged document, qualify it explicitly and verify its
  claim against a canonical document before relying on it.
- Report every additional Markdown source you read for each question, its
  exact UTF-8 byte count, and its SHA-256. Report targeted one-based line
  evidence; each evidence entry may span at most ${NAVIGATION_EVAL_MAX_EVIDENCE_LINES} lines, inclusive. Split wider support
  into multiple targeted entries.
- Keep the additional sources for every single question within
  ${suite.targets.max_question_source_bytes.toLocaleString("en-US")} UTF-8 bytes. Keep the union of bootstrap and additional
  sources for the complete run within
  ${suite.targets.max_total_unique_source_bytes.toLocaleString("en-US")} UTF-8 bytes. Report a source in every answer that relies
  on it; the scorer automatically de-duplicates the complete-run byte total.
- Include one authority-qualification entry for every reported source;
  canonical sources may use an empty qualification and verification list.
- The bootstrap sources are reported once in \`run.bootstrap_sources\`; do not
  repeat them in an answer's \`loaded_sources\` or authority qualifications.
- ${answerScope.slice(2)}
- Return only one JSON object matching
  \`docs/evals/documentation-navigation-result.schema.json\`.
- Set \`fresh_context\` and \`read_only\` to true. Use the 40-character commit
  \`${baseCommit}\` as \`repository_base_commit\`, and use fixture digest
  \`${fixtureDigest(suite)}\`.

Questions:

${questions}
`;
}

export function monthForDate(dateInput) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    throw new Error(`invalid date: ${dateInput}`);
  }
  const date = new Date(`${dateInput}T00:00:00Z`);
  if (
    Number.isNaN(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== dateInput
  ) {
    throw new Error(`invalid date: ${dateInput}`);
  }
  return dateInput.slice(0, 7);
}

export function navigationMonthMarker(month, digest) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`invalid month: ${month}`);
  if (!/^[0-9a-f]{64}$/.test(digest ?? "")) {
    throw new Error("invalid fixture digest");
  }
  return `${NAVIGATION_EVAL_MONTH_MARKER_PREFIX}${JSON.stringify({ month, fixture_digest: digest })} -->`;
}

export function parseLeadingNavigationEvalMarkers(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  if (lines[0] !== NAVIGATION_EVAL_MARKER) return null;
  const marker = lines[1] ?? "";
  if (
    !marker.startsWith(NAVIGATION_EVAL_MONTH_MARKER_PREFIX) ||
    !marker.endsWith(" -->")
  ) {
    throw new Error(
      "navigation-eval issue has a missing or malformed month marker",
    );
  }
  let metadata;
  try {
    metadata = JSON.parse(
      marker.slice(NAVIGATION_EVAL_MONTH_MARKER_PREFIX.length, -" -->".length),
    );
  } catch (error) {
    throw new Error("navigation-eval month marker is not valid JSON", {
      cause: error,
    });
  }
  if (
    !/^\d{4}-\d{2}$/.test(metadata?.month ?? "") ||
    !/^[0-9a-f]{64}$/.test(metadata?.fixture_digest ?? "")
  ) {
    throw new Error("navigation-eval month marker has invalid metadata");
  }
  return metadata;
}

function labelName(label) {
  return typeof label === "string" ? label : label?.name;
}

export function normalizeNavigationEvalIssuePages(pages) {
  const unique = new Map();
  for (const issue of (pages ?? []).flat()) {
    if (!issue || issue.pull_request || unique.has(issue.number)) continue;
    const labels = (issue.labels ?? []).map(labelName).filter(Boolean);
    unique.set(issue.number, {
      number: issue.number,
      title: String(issue.title ?? ""),
      body: String(issue.body ?? ""),
      state: String(issue.state ?? "").toUpperCase(),
      labels,
      url: issue.html_url ?? null,
      marker: labels.includes(NAVIGATION_EVAL_OWNERSHIP_LABEL)
        ? parseLeadingNavigationEvalMarkers(issue.body)
        : null,
    });
  }
  return [...unique.values()];
}

function stateLabels(issue) {
  return issue.labels.filter((label) => ISSUE_STATE_LABELS.includes(label));
}

export function isRoutingSensitivePath(file) {
  if (isNavigationEvalAnswerArtifact(file)) return false;
  return (
    file === "AGENTS.md" ||
    file.endsWith("/AGENTS.md") ||
    file === "package.json" ||
    file === "README.md" ||
    file.endsWith("/README.md") ||
    file.startsWith("docs/") ||
    file.startsWith(".agents/skills/") ||
    file.startsWith(".claude/skills/") ||
    file.startsWith(".claude/commands/") ||
    file.startsWith(".github/workflows/")
  );
}

export function routingSensitiveChanges(repoRoot, baseCommit) {
  if (!/^[0-9a-f]{40}$/.test(baseCommit)) {
    throw new Error("baseline repository commit is invalid");
  }
  const output = execFileSync(
    "git",
    ["diff", "--name-only", `${baseCommit}..HEAD`, "--"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const sensitive = output
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(isRoutingSensitivePath);
  return [...new Set(sensitive)].sort();
}

export function buildNavigationEvalIssueSpec({
  month,
  fixtureDigest: digest,
  routingChanges,
  epic = NAVIGATION_EVAL_EPIC,
}) {
  const displayedChanges = routingChanges.slice(0, 40);
  const changeLines = displayedChanges.length
    ? displayedChanges.map((file) => `- \`${file}\``)
    : ["- No routing-sensitive files changed since the committed baseline."];
  if (routingChanges.length > displayedChanges.length) {
    changeLines.push(
      `- ...and ${routingChanges.length - displayedChanges.length} additional routing-sensitive paths.`,
    );
  }
  const body = [
    NAVIGATION_EVAL_MARKER,
    navigationMonthMarker(month, digest),
    "",
    "### Goal",
    "",
    `Run the ${month} fresh-agent documentation navigation evaluation and compare its deterministic score with the committed pre-garden baseline.`,
    "",
    "### Context and links",
    "",
    `- Documentation-governance epic: #${epic}`,
    "- Evaluation contract: `docs/evals/documentation-navigation.md`",
    `- Fixture digest: \`${digest}\``,
    "- This issue is an issue-only reminder. The scheduled workflow never invokes a model or edits documentation.",
    "",
    "Routing-change reminder since the committed baseline:",
    "",
    ...changeLines,
    "",
    "### Acceptance criteria",
    "",
    "- [ ] Claim this issue before running the evaluation.",
    "- [ ] Generate the bounded prompt and run it in a fresh read-only context with the cheapest capable model.",
    "- [ ] Validate and score the complete structured result locally.",
    "- [ ] Post the score, context-byte totals, model/effort, and result evidence to this issue.",
    "- [ ] Compare routing failures and changed paths with the committed baseline.",
    "- [ ] Create linked agent-ready issues for confirmed routing/documentation defects; do not edit docs from the evaluation run itself.",
    "",
    "### Expected files or package area",
    "",
    "- Read-only evaluation of repository documentation.",
    "- `docs/evals/**` only when a reviewed PR intentionally updates the post-rotation comparison or evaluation contract.",
    "",
    "### Verification commands",
    "",
    "```bash",
    "pnpm docs:navigation-eval -- --check-fixtures",
    "pnpm docs:navigation-eval -- --prompt",
    "pnpm docs:navigation-eval -- --validate <result.json>",
    "```",
    "",
    "### Risks, non-goals, and do-not-touch",
    "",
    "- No hosted-model secret or unattended model invocation belongs in CI or this scheduler.",
    "- The evaluation agent is read-only and must not change docs, open PRs, deploy, or touch secrets.",
    "- A non-canonical source is never operating authority unless its claim is re-verified against a canonical source.",
    "",
    "### Dependencies or blockers",
    "",
    "None. Escalate only failed or ambiguous cases to a stronger reasoning model and an independent reviewer.",
    "",
    "### Done means",
    "",
    "A validated result and baseline comparison are posted, every confirmed routing defect has a linked issue, and this monthly evaluation issue is closed. A documentation PR is required only when a confirmed fix or intentional baseline update changes the repository.",
    "",
  ].join("\n");
  return {
    title: `[Agent task] docs: run ${month} navigation evaluation`,
    body,
    labels: [...ISSUE_LABELS],
  };
}

export function planNavigationEvalIssueSync({
  month,
  fixtureDigest: digest,
  issues,
  spec,
}) {
  const evaluationIssues = issues.filter((issue) => issue.marker);
  const open = evaluationIssues.filter((issue) => issue.state === "OPEN");
  if (open.length > 1) {
    throw new Error(
      `found ${open.length} open navigation-eval issues; expected at most one`,
    );
  }
  if (open.length === 1) {
    const issue = open[0];
    const states = stateLabels(issue);
    if (states.length !== 1) {
      throw new Error(
        `open navigation-eval issue #${issue.number} has ${states.length} queue state labels; expected exactly one`,
      );
    }
    const sameMonth = issue.marker.month === month;
    const sameFixture = issue.marker.fixture_digest === digest;
    return {
      action: sameMonth
        ? sameFixture
          ? "keep-current"
          : "skip-scope-drift"
        : "skip-prior-open",
      reason: sameMonth
        ? sameFixture
          ? `issue #${issue.number} already owns the ${month} evaluation`
          : `issue #${issue.number} owns ${month} with a different fixture digest; preserving published scope`
        : `issue #${issue.number} for ${issue.marker.month} is still open`,
      issue,
    };
  }
  const completed = evaluationIssues.find(
    (issue) => issue.state === "CLOSED" && issue.marker.month === month,
  );
  if (completed) {
    return {
      action: "skip-complete",
      reason: `${month} evaluation already completed by issue #${completed.number}`,
      issue: completed,
    };
  }
  return {
    action: "create",
    reason: `no live or completed navigation evaluation exists for ${month}`,
    spec,
  };
}
