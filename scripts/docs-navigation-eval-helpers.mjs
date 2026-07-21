import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import {
  classifyDocumentation,
  isDocumentationPath,
  parseDocumentationMetadata,
} from "./docs-index-helpers.mjs";

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
const SOURCE_AT_COMMIT_CACHE = new Map();

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

function roundPercent(numerator, denominator) {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1_000) / 10;
}

export function inventoryMap(inventory) {
  return new Map(inventory.records.map((record) => [record.path, record]));
}

export function fixtureDigest(suite) {
  return createHash("sha256").update(JSON.stringify(suite)).digest("hex");
}

function readSourceAtCommit(repoRoot, commit, file) {
  const cacheKey = `${repoRoot}\0${commit}\0${file}`;
  const cached = SOURCE_AT_COMMIT_CACHE.get(cacheKey);
  if (cached) return cached;
  try {
    const content = execFileSync("git", ["show", `${commit}:${file}`], {
      cwd: repoRoot,
      encoding: null,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    SOURCE_AT_COMMIT_CACHE.set(cacheKey, content);
    return content;
  } catch (error) {
    throw new Error(`cannot read ${file} at commit ${commit}`, {
      cause: error,
    });
  }
}

function commitIsReadable(repoRoot, commit) {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function authorityFromMetadata(metadata) {
  if (metadata?.canonical === "true") return "canonical";
  if (metadata?.canonical === "false") return "non-canonical";
  return "unmanaged";
}

function resultSourcePaths(suite, result, questions = suite.questions) {
  const paths = new Set(suite.bootstrap_sources);
  for (const question of questions) {
    for (const route of question.accepted_routes) {
      for (const file of route) paths.add(file);
    }
    for (const source of question.sources_requiring_verification) {
      if (typeof source?.path === "string") paths.add(source.path);
      for (const target of source?.verify_against ?? []) paths.add(target);
    }
  }
  for (const source of Array.isArray(result?.run?.bootstrap_sources)
    ? result.run.bootstrap_sources
    : []) {
    if (typeof source?.path === "string") paths.add(source.path);
  }
  for (const answer of Array.isArray(result?.answers) ? result.answers : []) {
    for (const file of Array.isArray(answer?.chosen_documents)
      ? answer.chosen_documents
      : []) {
      if (typeof file === "string") paths.add(file);
    }
    for (const field of [
      "evidence",
      "authority_qualifications",
      "loaded_sources",
    ]) {
      for (const entry of Array.isArray(answer?.[field]) ? answer[field] : []) {
        if (typeof entry?.path === "string") paths.add(entry.path);
      }
    }
  }
  return paths;
}

function historicalInventoryMap(repoRoot, commit, paths, errors) {
  const records = new Map();
  for (const file of paths) {
    if (!isDocumentationPath(file)) continue;
    let content;
    try {
      content = readSourceAtCommit(repoRoot, commit, file);
    } catch {
      continue;
    }
    const text = content.toString("utf8");
    const metadata = parseDocumentationMetadata(file, text);
    const classification = classifyDocumentation(file, metadata);
    for (const error of classification.errors) {
      errors.push(`${error} at ${commit}`);
    }
    records.set(file, {
      path: file,
      authority: authorityFromMetadata(metadata),
      bytes: content.length,
      ...classification,
    });
  }
  return records;
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

function validateLoadedSources({
  sources,
  records,
  forbidden,
  label,
  errors,
  repoRoot,
  baseCommit,
}) {
  if (!Array.isArray(sources) || sources.length === 0) {
    errors.push(`${label} must list at least one loaded source`);
    return {
      paths: new Set(),
      bytes: 0,
      sizes: new Map(),
      lineCounts: new Map(),
    };
  }
  const paths = new Set();
  const sizes = new Map();
  const lineCounts = new Map();
  let bytes = 0;
  for (const source of sources) {
    if (!isObject(source) || typeof source.path !== "string") {
      errors.push(`${label} contains an invalid loaded source`);
      continue;
    }
    if (paths.has(source.path)) {
      errors.push(`${label} repeats loaded source ${source.path}`);
      continue;
    }
    paths.add(source.path);
    if (forbidden.has(source.path)) {
      errors.push(`${label} loaded forbidden evaluation source ${source.path}`);
    }
    const record = records.get(source.path);
    if (!record) {
      errors.push(
        `${label} loaded a path outside the documentation inventory: ${source.path}`,
      );
      continue;
    }
    let content;
    try {
      content = readSourceAtCommit(repoRoot, baseCommit, source.path);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (source.bytes !== content.length) {
      errors.push(
        `${label} reports ${source.bytes} bytes for ${source.path}; expected ${content.length} at ${baseCommit}`,
      );
    }
    const expectedDigest = createHash("sha256").update(content).digest("hex");
    if (source.sha256 !== expectedDigest) {
      errors.push(
        `${label} reports the wrong sha256 for ${source.path} at ${baseCommit}`,
      );
    }
    bytes += content.length;
    sizes.set(source.path, content.length);
    lineCounts.set(source.path, content.toString("utf8").split(/\r?\n/).length);
  }
  return { paths, bytes, sizes, lineCounts };
}

function matchedRoute(question, chosenDocuments, records) {
  const matches = question.accepted_routes.filter((route) => {
    if (route.some((file) => !records.has(file))) return false;
    let lastIndex = -1;
    return route.every((file) => {
      const index = chosenDocuments.indexOf(file);
      if (index <= lastIndex) return false;
      lastIndex = index;
      return true;
    });
  });
  matches.sort(
    (left, right) =>
      left.reduce((sum, file) => sum + records.get(file).bytes, 0) -
        right.reduce((sum, file) => sum + records.get(file).bytes, 0) ||
      left.length - right.length,
  );
  return matches[0] ?? null;
}

function validateObjectContract(value, label, required, allowed, errors) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) errors.push(`${label} is missing ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push(`${label} has unexpected property ${key}`);
    }
  }
  return true;
}

function validateLoadedSourceContract(source, label, errors) {
  if (
    !validateObjectContract(
      source,
      label,
      ["path", "bytes", "sha256"],
      ["path", "bytes", "sha256"],
      errors,
    )
  ) {
    return;
  }
  if (typeof source.path !== "string" || source.path.length === 0) {
    errors.push(`${label}.path must be a non-empty string`);
  }
  if (!Number.isSafeInteger(source.bytes) || source.bytes < 1) {
    errors.push(`${label}.bytes must be a positive integer`);
  }
  if (!/^[0-9a-f]{64}$/.test(source.sha256 ?? "")) {
    errors.push(`${label}.sha256 must be a lowercase sha256`);
  }
}

export function validateNavigationResultShape(
  result,
  { minAnswers = 15, maxAnswers = 20 } = {},
) {
  const errors = [];
  if (
    !validateObjectContract(
      result,
      "result",
      ["schema_version", "suite_id", "fixture_digest", "run", "answers"],
      ["schema_version", "suite_id", "fixture_digest", "run", "answers"],
      errors,
    )
  ) {
    return errors;
  }
  if (
    validateObjectContract(
      result.run,
      "result.run",
      [
        "agent",
        "model",
        "effort",
        "executed_at",
        "repository_base_commit",
        "fresh_context",
        "read_only",
        "bootstrap_sources",
      ],
      [
        "agent",
        "model",
        "effort",
        "executed_at",
        "repository_base_commit",
        "fresh_context",
        "read_only",
        "bootstrap_sources",
      ],
      errors,
    )
  ) {
    for (const field of [
      "agent",
      "model",
      "effort",
      "executed_at",
      "repository_base_commit",
    ]) {
      if (typeof result.run[field] !== "string") {
        errors.push(`result.run.${field} must be a string`);
      }
    }
    for (const field of ["fresh_context", "read_only"]) {
      if (typeof result.run[field] !== "boolean") {
        errors.push(`result.run.${field} must be a boolean`);
      }
    }
    if (!Array.isArray(result.run.bootstrap_sources)) {
      errors.push("result.run.bootstrap_sources must be an array");
    } else {
      if (result.run.bootstrap_sources.length < 2) {
        errors.push(
          "result.run.bootstrap_sources must contain at least 2 items",
        );
      }
      result.run.bootstrap_sources.forEach((source, index) =>
        validateLoadedSourceContract(
          source,
          `result.run.bootstrap_sources[${index}]`,
          errors,
        ),
      );
    }
  }
  if (!Array.isArray(result.answers)) {
    errors.push("result.answers must be an array");
    return errors;
  }
  if (
    result.answers.length < minAnswers ||
    result.answers.length > maxAnswers
  ) {
    errors.push(
      minAnswers === maxAnswers
        ? `result.answers must contain exactly ${minAnswers} item`
        : `result.answers must contain ${minAnswers} to ${maxAnswers} items`,
    );
  }
  result.answers.forEach((answer, answerIndex) => {
    const label = `result.answers[${answerIndex}]`;
    if (
      !validateObjectContract(
        answer,
        label,
        [
          "question_id",
          "chosen_documents",
          "answer",
          "evidence",
          "authority_qualifications",
          "loaded_sources",
        ],
        [
          "question_id",
          "chosen_documents",
          "answer",
          "evidence",
          "authority_qualifications",
          "loaded_sources",
        ],
        errors,
      )
    ) {
      return;
    }
    if (typeof answer.question_id !== "string") {
      errors.push(`${label}.question_id must be a string`);
    }
    if (!uniqueStrings(answer.chosen_documents)) {
      errors.push(`${label}.chosen_documents must contain unique strings`);
    } else if (answer.chosen_documents.length === 0) {
      errors.push(`${label}.chosen_documents must not be empty`);
    }
    if (typeof answer.answer !== "string" || answer.answer.length === 0) {
      errors.push(`${label}.answer must be a non-empty string`);
    }
    if (!Array.isArray(answer.evidence)) {
      errors.push(`${label}.evidence must be an array`);
    } else {
      if (answer.evidence.length === 0) {
        errors.push(`${label}.evidence must not be empty`);
      }
      answer.evidence.forEach((evidence, evidenceIndex) => {
        const evidenceLabel = `${label}.evidence[${evidenceIndex}]`;
        if (
          !validateObjectContract(
            evidence,
            evidenceLabel,
            ["path", "line_start", "line_end", "supports"],
            ["path", "line_start", "line_end", "supports"],
            errors,
          )
        ) {
          return;
        }
        if (typeof evidence.path !== "string") {
          errors.push(`${evidenceLabel}.path must be a string`);
        }
        for (const field of ["line_start", "line_end"]) {
          if (!Number.isSafeInteger(evidence[field])) {
            errors.push(`${evidenceLabel}.${field} must be an integer`);
          }
        }
        if (typeof evidence.supports !== "string") {
          errors.push(`${evidenceLabel}.supports must be a string`);
        }
      });
    }
    if (!Array.isArray(answer.authority_qualifications)) {
      errors.push(`${label}.authority_qualifications must be an array`);
    } else {
      if (answer.authority_qualifications.length === 0) {
        errors.push(`${label}.authority_qualifications must not be empty`);
      }
      answer.authority_qualifications.forEach((qualification, index) => {
        const qualificationLabel = `${label}.authority_qualifications[${index}]`;
        if (
          !validateObjectContract(
            qualification,
            qualificationLabel,
            ["path", "authority", "qualification", "verified_against"],
            ["path", "authority", "qualification", "verified_against"],
            errors,
          )
        ) {
          return;
        }
        if (typeof qualification.path !== "string") {
          errors.push(`${qualificationLabel}.path must be a string`);
        }
        if (
          !["canonical", "non-canonical", "unmanaged"].includes(
            qualification.authority,
          )
        ) {
          errors.push(`${qualificationLabel}.authority is invalid`);
        }
        if (typeof qualification.qualification !== "string") {
          errors.push(`${qualificationLabel}.qualification must be a string`);
        }
        if (!uniqueStrings(qualification.verified_against)) {
          errors.push(
            `${qualificationLabel}.verified_against must contain unique strings`,
          );
        }
      });
    }
    if (!Array.isArray(answer.loaded_sources)) {
      errors.push(`${label}.loaded_sources must be an array`);
    } else {
      if (answer.loaded_sources.length === 0) {
        errors.push(`${label}.loaded_sources must not be empty`);
      }
      answer.loaded_sources.forEach((source, index) =>
        validateLoadedSourceContract(
          source,
          `${label}.loaded_sources[${index}]`,
          errors,
        ),
      );
    }
  });
  return errors;
}

export function scoreNavigationResult({
  suite,
  result,
  repoRoot,
  questionId = null,
}) {
  const evaluatedQuestions = questionId
    ? suite.questions.filter((question) => question.id === questionId)
    : suite.questions;
  const errors = [];
  if (questionId && evaluatedQuestions.length === 0) {
    errors.push(`unknown question: ${questionId}`);
  }
  errors.push(
    ...validateNavigationResultShape(
      result,
      questionId
        ? { minAnswers: 1, maxAnswers: 1 }
        : { minAnswers: 15, maxAnswers: 20 },
    ),
  );
  const forbidden = new Set(suite.forbidden_sources);
  if (!isObject(result)) {
    return { errors: ["result must be a JSON object"], report: null };
  }
  if (result.schema_version !== NAVIGATION_EVAL_SCHEMA_VERSION) {
    errors.push("result schema_version must be 1");
  }
  if (result.suite_id !== suite.suite_id) {
    errors.push(`result suite_id must be ${suite.suite_id}`);
  }
  if (result.fixture_digest !== fixtureDigest(suite)) {
    errors.push("result fixture_digest does not match the fixture contract");
  }
  if (!isObject(result.run)) {
    errors.push("result.run must be an object");
  }
  const run = result.run ?? {};
  for (const field of ["agent", "model", "effort"]) {
    if (typeof run[field] !== "string" || run[field].trim() === "") {
      errors.push(`result.run.${field} must be a non-empty string`);
    }
  }
  if (Number.isNaN(Date.parse(run.executed_at))) {
    errors.push("result.run.executed_at must be an ISO date-time");
  }
  if (!/^[0-9a-f]{40}$/.test(run.repository_base_commit ?? "")) {
    errors.push(
      "result.run.repository_base_commit must be a 40-character lowercase commit",
    );
  }
  const baseCommit = /^[0-9a-f]{40}$/.test(run.repository_base_commit ?? "")
    ? run.repository_base_commit
    : null;
  if (baseCommit && !commitIsReadable(repoRoot, baseCommit)) {
    errors.push(
      `result.run.repository_base_commit is not available locally: ${baseCommit}`,
    );
  }
  const sourceCommit =
    baseCommit && commitIsReadable(repoRoot, baseCommit) ? baseCommit : "HEAD";
  const records = historicalInventoryMap(
    repoRoot,
    sourceCommit,
    resultSourcePaths(suite, result, evaluatedQuestions),
    errors,
  );
  if (run.fresh_context !== true)
    errors.push("result.run.fresh_context must be true");
  if (run.read_only !== true) errors.push("result.run.read_only must be true");
  const bootstrap = validateLoadedSources({
    sources: run.bootstrap_sources,
    records,
    forbidden,
    label: "result.run.bootstrap_sources",
    errors,
    repoRoot,
    baseCommit: sourceCommit,
  });
  const expectedBootstrap = new Set(suite.bootstrap_sources);
  if (
    bootstrap.paths.size !== expectedBootstrap.size ||
    [...expectedBootstrap].some((file) => !bootstrap.paths.has(file))
  ) {
    errors.push("result bootstrap sources do not match the fixture contract");
  }

  if (!Array.isArray(result.answers)) {
    errors.push("result.answers must be an array");
  }
  const answersById = new Map();
  for (const answer of result.answers ?? []) {
    if (!isObject(answer) || typeof answer.question_id !== "string") {
      errors.push("result contains an invalid answer");
      continue;
    }
    if (answersById.has(answer.question_id)) {
      errors.push(`duplicate answer for ${answer.question_id}`);
    } else {
      answersById.set(answer.question_id, answer);
    }
  }
  for (const answerId of answersById.keys()) {
    if (!evaluatedQuestions.some((question) => question.id === answerId)) {
      errors.push(`result contains unknown question ${answerId}`);
    }
  }

  const questionReports = [];
  const totalSources = new Map(bootstrap.sizes);
  let routingCorrect = 0;
  let evidenceCorrect = 0;
  let shortestRouteCount = 0;
  let unqualifiedNoncanonical = 0;
  let questionsOverBudget = 0;
  for (const question of evaluatedQuestions) {
    const answer = answersById.get(question.id);
    if (!answer) {
      errors.push(`missing answer for ${question.id}`);
      questionReports.push({
        question_id: question.id,
        routing_correct: false,
        evidence_complete: false,
        shortest_route: false,
        source_bytes: 0,
        route_efficiency_percent: 0,
      });
      continue;
    }
    const loaded = validateLoadedSources({
      sources: answer.loaded_sources,
      records,
      forbidden,
      label: `answer ${question.id}`,
      errors,
      repoRoot,
      baseCommit: sourceCommit,
    });
    for (const [file, bytes] of loaded.sizes) totalSources.set(file, bytes);
    if (loaded.bytes > suite.targets.max_question_source_bytes) {
      questionsOverBudget += 1;
    }
    if (
      !uniqueStrings(answer.chosen_documents) ||
      answer.chosen_documents.length === 0
    ) {
      errors.push(`answer ${question.id} must choose unique documents`);
    }
    const chosen = new Set(answer.chosen_documents ?? []);
    const available = new Set([...bootstrap.paths, ...loaded.paths]);
    for (const file of chosen) {
      if (!available.has(file)) {
        errors.push(
          `answer ${question.id} chose ${file} without reporting it as loaded`,
        );
      }
    }
    if (typeof answer.answer !== "string" || answer.answer.trim() === "") {
      errors.push(`answer ${question.id} has no answer text`);
    }

    const qualificationByPath = new Map();
    if (!Array.isArray(answer.authority_qualifications)) {
      errors.push(`answer ${question.id} must report authority qualifications`);
    } else {
      for (const qualification of answer.authority_qualifications) {
        if (
          !isObject(qualification) ||
          typeof qualification.path !== "string"
        ) {
          errors.push(
            `answer ${question.id} has an invalid authority qualification`,
          );
          continue;
        }
        if (qualificationByPath.has(qualification.path)) {
          errors.push(
            `answer ${question.id} repeats authority for ${qualification.path}`,
          );
          continue;
        }
        qualificationByPath.set(qualification.path, qualification);
      }
    }
    for (const file of loaded.paths) {
      const record = records.get(file);
      if (!record) continue;
      const qualification = qualificationByPath.get(file);
      if (!qualification) {
        errors.push(`answer ${question.id} omits authority for ${file}`);
        continue;
      }
      if (qualification.authority !== record.authority) {
        errors.push(
          `answer ${question.id} misclassifies ${file} as ${qualification.authority}`,
        );
      }
      const expectedVerification = question.sources_requiring_verification.find(
        (source) => source.path === file,
      );
      if (record.authority !== "canonical") {
        const verifiedAgainst = qualification.verified_against;
        const qualified =
          typeof qualification.qualification === "string" &&
          qualification.qualification.trim().length >= 12 &&
          uniqueStrings(verifiedAgainst) &&
          verifiedAgainst.length > 0 &&
          verifiedAgainst.every(
            (target) =>
              records.get(target)?.authority === "canonical" &&
              available.has(target),
          ) &&
          (!expectedVerification ||
            expectedVerification.verify_against.every((target) =>
              verifiedAgainst.includes(target),
            ));
        if (!qualified) unqualifiedNoncanonical += 1;
      }
    }

    const evidencePaths = new Set();
    const availableLineCounts = new Map([
      ...bootstrap.lineCounts,
      ...loaded.lineCounts,
    ]);
    if (!Array.isArray(answer.evidence) || answer.evidence.length === 0) {
      errors.push(`answer ${question.id} must cite evidence`);
    } else {
      for (const evidence of answer.evidence) {
        if (!isObject(evidence) || typeof evidence.path !== "string") {
          errors.push(`answer ${question.id} has invalid evidence`);
          continue;
        }
        evidencePaths.add(evidence.path);
        if (!available.has(evidence.path)) {
          errors.push(
            `answer ${question.id} cites ${evidence.path} without loading it`,
          );
        }
        if (
          !Number.isSafeInteger(evidence.line_start) ||
          !Number.isSafeInteger(evidence.line_end) ||
          evidence.line_start < 1 ||
          evidence.line_end < evidence.line_start ||
          evidence.line_end - evidence.line_start + 1 >
            NAVIGATION_EVAL_MAX_EVIDENCE_LINES ||
          (availableLineCounts.has(evidence.path) &&
            evidence.line_end > availableLineCounts.get(evidence.path))
        ) {
          errors.push(
            `answer ${question.id} has invalid line evidence for ${evidence.path}`,
          );
        }
        if (
          typeof evidence.supports !== "string" ||
          evidence.supports.trim() === ""
        ) {
          errors.push(
            `answer ${question.id} evidence must state what it supports`,
          );
        }
      }
    }

    const route = matchedRoute(
      question,
      answer.chosen_documents ?? [],
      records,
    );
    const routingIsCorrect = Boolean(route);
    if (routingIsCorrect) routingCorrect += 1;
    const evidenceIsComplete = Boolean(
      route && route.every((file) => evidencePaths.has(file)),
    );
    if (evidenceIsComplete) evidenceCorrect += 1;
    const chosenWithoutBootstrap = [...chosen].filter(
      (file) => !bootstrap.paths.has(file),
    );
    const shortestRoute = Boolean(
      route &&
      chosenWithoutBootstrap.length === route.length &&
      route.every((file) => chosenWithoutBootstrap.includes(file)),
    );
    if (shortestRoute) shortestRouteCount += 1;
    const routeBytes = route
      ? route.reduce(
          (sum, file) =>
            sum + (totalSources.get(file) ?? records.get(file).bytes),
          0,
        )
      : 0;
    questionReports.push({
      question_id: question.id,
      routing_correct: routingIsCorrect,
      evidence_complete: evidenceIsComplete,
      shortest_route: shortestRoute,
      source_bytes: loaded.bytes,
      route_efficiency_percent:
        loaded.bytes > 0 ? roundPercent(routeBytes, loaded.bytes) : 0,
    });
  }

  const totalUniqueSourceBytes = [...totalSources.values()].reduce(
    (sum, bytes) => sum + bytes,
    0,
  );
  const questionCount = evaluatedQuestions.length;
  const report = {
    schema_version: NAVIGATION_EVAL_SCHEMA_VERSION,
    suite_id: suite.suite_id,
    question_count: questionCount,
    routing_accuracy_percent: roundPercent(routingCorrect, questionCount),
    canonical_source_compliance: {
      unqualified_noncanonical_sources: unqualifiedNoncanonical,
    },
    answer_evidence_percent: roundPercent(evidenceCorrect, questionCount),
    shortest_route_percent: roundPercent(shortestRouteCount, questionCount),
    context: {
      bootstrap_bytes: bootstrap.bytes,
      total_unique_source_bytes: totalUniqueSourceBytes,
      max_total_unique_source_bytes:
        suite.targets.max_total_unique_source_bytes,
      questions_over_budget: questionsOverBudget,
      max_question_source_bytes: suite.targets.max_question_source_bytes,
    },
    questions: questionReports,
  };
  report.passed =
    errors.length === 0 &&
    report.routing_accuracy_percent >= suite.targets.routing_accuracy_percent &&
    unqualifiedNoncanonical <= suite.targets.unqualified_noncanonical_sources &&
    report.answer_evidence_percent >= suite.targets.answer_evidence_percent &&
    questionsOverBudget <= suite.targets.questions_over_context_budget &&
    totalUniqueSourceBytes <= suite.targets.max_total_unique_source_bytes;
  return { errors, report };
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
  if (
    file === "docs/evals/documentation-navigation-baseline.json" ||
    /^docs\/evals\/documentation-navigation-post-garden-[^/]+\.json$/.test(file)
  ) {
    return false;
  }
  return (
    file === "AGENTS.md" ||
    file.endsWith("/AGENTS.md") ||
    file === "package.json" ||
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
