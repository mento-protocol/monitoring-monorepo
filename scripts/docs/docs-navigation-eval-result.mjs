import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import {
  classifyDocumentation,
  isDocumentationPath,
  parseDocumentationMetadata,
} from "../context/docs-index-helpers.mjs";
import {
  fixtureDigest,
  isNavigationEvalAnswerArtifact,
  NAVIGATION_EVAL_MAX_EVIDENCE_LINES,
  NAVIGATION_EVAL_SCHEMA_VERSION,
} from "./docs-navigation-eval-helpers.mjs";
import {
  isObject,
  uniqueStrings,
  validateNavigationResultShape,
} from "./docs-navigation-eval-result-shape.mjs";

const SOURCE_AT_COMMIT_CACHE = new Map();
const DEFAULT_BRANCH_REF = "refs/remotes/origin/main";

function roundPercent(numerator, denominator) {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1_000) / 10;
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

function defaultBranchReachability(repoRoot, commit) {
  try {
    execFileSync(
      "git",
      ["rev-parse", "--verify", "--quiet", `${DEFAULT_BRANCH_REF}^{commit}`],
      {
        cwd: repoRoot,
        stdio: "ignore",
      },
    );
  } catch {
    return {
      reachable: false,
      error: `default branch ref is not available locally: ${DEFAULT_BRANCH_REF}`,
    };
  }

  try {
    execFileSync(
      "git",
      ["merge-base", "--is-ancestor", commit, DEFAULT_BRANCH_REF],
      {
        cwd: repoRoot,
        stdio: "ignore",
      },
    );
    return { reachable: true, error: null };
  } catch {
    return {
      reachable: false,
      error: `result.run.repository_base_commit is not reachable from ${DEFAULT_BRANCH_REF}: ${commit}`,
    };
  }
}

function authorityFromMetadata(metadata) {
  if (metadata?.canonical === "true") return "canonical";
  if (metadata?.canonical === "false") return "non-canonical";
  return "unmanaged";
}

function resultSourcePaths(suite, result, questions = suite.questions) {
  const paths = fixtureSourcePaths(suite, questions);
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

function fixtureSourcePaths(suite, questions = suite?.questions ?? []) {
  const paths = new Set(
    Array.isArray(suite?.bootstrap_sources) ? suite.bootstrap_sources : [],
  );
  for (const question of questions) {
    for (const route of question.accepted_routes ?? []) {
      for (const file of route) paths.add(file);
    }
    for (const source of question.sources_requiring_verification ?? []) {
      if (typeof source?.path === "string") paths.add(source.path);
      for (const target of source?.verify_against ?? []) paths.add(target);
    }
  }
  return paths;
}

function historicalInventoryMap(
  repoRoot,
  commit,
  paths,
  errors,
  readSource = readSourceAtCommit,
) {
  const records = new Map();
  for (const file of paths) {
    if (!isDocumentationPath(file)) continue;
    let content;
    try {
      content = readSource(repoRoot, commit, file);
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

export function buildHistoricalNavigationInventory({
  suite,
  repoRoot,
  commit,
}) {
  const errors = [];
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
    return {
      records: [],
      errors: [
        "historical inventory commit must be a 40-character lowercase commit",
      ],
      warnings: [],
      broken_links: [],
    };
  }
  if (!commitIsReadable(repoRoot, commit)) {
    return {
      records: [],
      errors: [
        `historical inventory commit is not available locally: ${commit}`,
      ],
      warnings: [],
      broken_links: [],
    };
  }
  const records = historicalInventoryMap(
    repoRoot,
    commit,
    fixtureSourcePaths(suite),
    errors,
  );
  return {
    records: [...records.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    errors,
    warnings: [],
    broken_links: [],
  };
}

function validateLoadedSources({
  sources,
  records,
  forbidden,
  label,
  errors,
  repoRoot,
  baseCommit,
  readSource = readSourceAtCommit,
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
    if (isNavigationEvalAnswerArtifact(source.path)) {
      errors.push(
        `${label} loaded forbidden navigation evaluation answer artifact ${source.path}`,
      );
    } else if (forbidden.has(source.path)) {
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
      content = readSource(repoRoot, baseCommit, source.path);
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

// `readSource` resolves one declared source to its bytes at the evaluated
// commit. The default reads the repository, which is what makes a result unable
// to lie about what it loaded, so production callers must leave it alone. Tests
// of the scoring arithmetic pass a fixture corpus instead, so their sizes are
// chosen rather than inherited from whatever the documentation weighs today.
export function scoreNavigationResult({
  suite,
  result,
  repoRoot,
  questionId = null,
  readSource = readSourceAtCommit,
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
  const baseCommitReadable = baseCommit
    ? commitIsReadable(repoRoot, baseCommit)
    : false;
  if (baseCommit && !baseCommitReadable) {
    errors.push(
      `result.run.repository_base_commit is not available locally: ${baseCommit}`,
    );
  }
  if (baseCommit && baseCommitReadable) {
    const reachability = defaultBranchReachability(repoRoot, baseCommit);
    if (!reachability.reachable) errors.push(reachability.error);
  }
  const sourceCommit = baseCommit && baseCommitReadable ? baseCommit : "HEAD";
  const records = historicalInventoryMap(
    repoRoot,
    sourceCommit,
    resultSourcePaths(suite, result, evaluatedQuestions),
    errors,
    readSource,
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
    readSource,
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
      readSource,
    });
    for (const file of loaded.paths) {
      if (bootstrap.paths.has(file)) {
        errors.push(
          `answer ${question.id} repeats bootstrap source ${file} in loaded_sources`,
        );
      }
    }
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
      chosen.size > 0 &&
      [...chosen].every(
        (file) => available.has(file) && evidencePaths.has(file),
      ),
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
