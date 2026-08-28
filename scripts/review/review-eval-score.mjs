// Scoring for the review-skill evaluation: turn one condition's review
// transcript into the numbers a ledger row carries. Ported from the
// benchmark-v2 scorers (`bench2/match_findings.py`, `bench2/judge_novel.py`),
// keeping their two stages. A cheap structural pass proposes candidate matches
// on file and line; a blind judge decides whether a candidate is really the
// same defect. Text overlap alone both over-credits (same file, different bug)
// and under-credits (same bug, different words), and neither error is
// acceptable when the point is measuring recall.
//
// Every model call goes through an injected `exec` function, so nothing here
// reaches a model on its own and the tests never call one. `exec` is
// `async ({ prompt, model, effort }) => string` returning the model's text; a
// Claude CLI JSON envelope is unwrapped if one arrives. A judge reply that
// cannot be parsed throws `JudgeOutputError` instead of degrading to "nothing
// matched": an unparsable judge and a review that found nothing produce the
// same recall number, and only one of them is a result.

import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Truncations, claim caps, and the line-proximity window are bench2 values.
// Changing one changes the score, so they move only with `matcher_digest`.
const MAX_SPLIT_REVIEW_CHARS = 40000;
const MAX_JUDGE_REVIEW_CHARS = 30000;
const MAX_CLAIMS = 25;
const MAX_CLAIM_CHARS = 600;
const MAX_DETAIL_CHARS = 400;
const MAX_KNOWN_TITLE_CHARS = 90;
const LINE_PROXIMITY = 25;

const DEFAULT_JUDGE_MODEL = "claude-opus-5";
const DEFAULT_JUDGE_EFFORT = "high";
const NOVEL_JUDGE_TOOLS = ["Read", "Grep", "Glob", "Bash"];
const NOVEL_JUDGE_MAX_TURNS = 60;
const DEFAULT_CALIBRATION_CONCURRENCY = 4;

// The match judge, the claim splitter and the calibration replay are blind by
// construction: bench2 gave them a prompt and nothing else. Ported here that
// means no tools, one turn, and a working directory that is not the monorepo
// checkout — `--score` runs from the developer's repo, where the answer key,
// the truth files and the ledger are all one `cat` away. Only `classifyNovel`
// keeps tools, and only inside the fixture, exactly as `judge_novel.py` does.
export const BLIND_JUDGE_TOOLS = [];
export const BLIND_JUDGE_MAX_TURNS = 1;

export const NOVEL_CLASSES = ["real", "wrong", "vague", "known"];
export const CALIBRATION_VERDICTS = ["matched", "unmatched"];

// The `.tf`, `.hcl`, `.toml`, and `.tftest.hcl` extensions were missing from
// the original matcher, so Terraform findings were never candidates at all.
// Absolute paths are fine here: only the basename is compared.
const LOCATION_PATTERN =
  /([\w./-]+\.(?:md|sh|mjs|js|ts|tsx|py|json|ya?ml|tf|hcl|toml|tftest\.hcl))(?::(\d+))?/g;

const MARKUP_PATTERN = /<[^>]+>|[*`]/g;
const PLACEHOLDER_PATTERN = /\{\{([A-Z_]+)\}\}/g;

const promptDir = fileURLToPath(new URL("./prompts", import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
// Every file that can change a recorded number or a recorded verdict. The
// extraction and the matcher live here, CLI scoring orchestration lives in
// `review-eval.mjs`, the per-condition fold and the leak signal live in
// `review-eval-run.mjs`, the recompute lives in
// `review-eval-result-shape.mjs`, timestamp validation lives in
// `review-eval-ledger.mjs`, and the verdict rules live in
// `review-eval-report.mjs`.
//
// The two fixture helpers are hashed for the same reason. `gridFixtures()`
// chooses the matrix, `fixtureForPr()` selects the truth file and the recall
// denominator, and `forbiddenShasForFixture()` gates the leak verdict, so an
// edit there moves recorded numbers without touching any other scoring file.
// `build-fixture.sh` materializes the checkout the contestant reviews and
// carries the tree-hash and forbidden-sha checks that verify it, so an edit
// there changes what was reviewed — or weakens the check that proves it — and
// the drift table's `fixture content` row is only as strong as those bytes.
//
// Editing any of them changes what a row means, so all of them are hashed into
// `matcher_digest` and comparison is refused across the change.
export const SCORING_MODULES = [
  "review-eval.mjs",
  "review-eval-run.mjs",
  "review-eval-result-shape.mjs",
  "review-eval-ledger.mjs",
  "review-eval-report.mjs",
  "review-eval-fixtures.mjs",
  "build-fixture.sh",
].map((name) => fileURLToPath(new URL(`./${name}`, import.meta.url)));
const promptCache = new Map();

export class JudgeOutputError extends Error {
  constructor(message, { raw = "", cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "JudgeOutputError";
    this.raw = String(raw).slice(0, 2000);
  }
}

export function loadPrompt(name, { dir = promptDir } = {}) {
  const key = `${dir}/${name}`;
  if (!promptCache.has(key)) {
    promptCache.set(key, readFileSync(path.join(dir, `${name}.md`), "utf8"));
  }
  return promptCache.get(key);
}

// The unfilled-placeholder guard scans the TEMPLATE, never the rendered output.
// Every value substituted here is content the harness declares untrusted — a
// contestant transcript, an extracted claim, a truth title — so a `{{TOKEN}}`
// inside a value must pass through as literal text. Scanning the rendered text
// turned any such token into a one-token denial of scoring for a whole matrix.
export function renderPrompt(template, values) {
  const missing = template
    .match(PLACEHOLDER_PATTERN)
    ?.find((token) => !Object.hasOwn(values, token.slice(2, -2)));
  if (missing) {
    throw new Error(`prompt placeholder ${missing} has no value`);
  }
  return template.replace(PLACEHOLDER_PATTERN, (match, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}

// Digest over the whole scoring pipeline and its prompts. It is the
// `matcher_digest` half of the ledger's comparability key: a change anywhere in
// the code that turns a transcript into recorded bits, counters, or a verdict
// must break comparison rather than silently pair two different scorers.
export function scorerDigest({
  script = scriptPath,
  dir = promptDir,
  modules = SCORING_MODULES,
} = {}) {
  const hash = createHash("sha256");
  hash.update(readFileSync(script));
  for (const module of modules) {
    hash.update(path.basename(module));
    hash.update(readFileSync(module));
  }
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".md")) continue;
    hash.update(file);
    hash.update(readFileSync(path.join(dir, file)));
  }
  return hash.digest("hex");
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function basenameOf(value) {
  return String(value ?? "")
    .split("/")
    .pop();
}

function unwrapExecResult(raw) {
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return text;
  try {
    const envelope = JSON.parse(trimmed);
    if (isObject(envelope) && typeof envelope.result === "string") {
      return envelope.result;
    }
  } catch {
    // Not a CLI envelope. The judge's own JSON is handled below.
  }
  return text;
}

// One repair attempt, and only for damage a model reliably produces: fenced
// output, trailing commas, and `//` comments. Anything else is a real parse
// failure and must surface.
function repairJson(text) {
  return text
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
}

function sliceJson(text, shape) {
  const pattern = shape === "array" ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const match = text.match(pattern);
  return match ? match[0] : null;
}

export function parseJudgeJson(
  raw,
  { shape = "object", label = "judge" } = {},
) {
  const text = unwrapExecResult(raw);
  for (const candidate of [text, repairJson(text)]) {
    const sliced = sliceJson(candidate, shape);
    if (!sliced) continue;
    try {
      const parsed = JSON.parse(sliced);
      const shapeOk =
        shape === "array" ? Array.isArray(parsed) : isObject(parsed);
      if (shapeOk) return parsed;
    } catch {
      // Fall through to the repaired candidate, then to the throw below.
    }
  }
  throw new JudgeOutputError(`${label} returned no parseable JSON ${shape}`, {
    raw: text,
  });
}

/**
 * The match judge's promised shape. A reply whose `matches` field is absent or
 * is not an array is not "the review matched nothing": both produce zero
 * matched defects, and only one of them is a result. A silent empty set records
 * every candidate as missed, which can flip a regression or turn a row RED.
 * `classifyNovel` refuses a missing `verdicts` object for the same reason.
 *
 * The entries carry the same weight as the array itself. `{"matches":[99]}` or
 * `{"matches":["unknown"]}` is not a shorter match list — it is a judge that
 * answered about defects nobody asked it about, and dropping those entries
 * quietly records every candidate as missed. `candidateCount` is the 1-based
 * range the prompt offered, so every entry is checked against it and a reply
 * that leaves it poisons the scoring pass instead. A numeric string is still
 * accepted — a judge that writes `"1"` for `1` answered the question — but
 * nothing else is.
 */
function requireMatches(parsed, label, candidateCount) {
  if (!Array.isArray(parsed?.matches)) {
    throw new JudgeOutputError(`${label} returned no matches array`, {
      raw: JSON.stringify(parsed ?? null),
    });
  }
  const indices = [];
  for (const entry of parsed.matches) {
    const numeric = typeof entry === "number" || typeof entry === "string";
    const index = numeric ? Number(entry) : Number.NaN;
    if (!Number.isInteger(index) || index < 1 || index > candidateCount) {
      throw new JudgeOutputError(
        `${label} returned match entry ${JSON.stringify(entry ?? null)}, ` +
          `which is not a defect index in 1..${candidateCount}`,
        { raw: JSON.stringify(parsed) },
      );
    }
    indices.push(index);
  }
  return indices;
}

let blindCwd = null;

/**
 * An empty scratch directory for the blind judges. Created once per process
 * and never written to: it exists so a judge that ignores `allowedTools: []`
 * still starts nowhere near the repository that holds the answer key.
 */
export function blindJudgeCwd() {
  if (!blindCwd) {
    blindCwd = mkdtempSync(path.join(tmpdir(), "review-eval-blind-"));
  }
  return blindCwd;
}

function blindRequest({ prompt, model, effort }) {
  return {
    prompt,
    model,
    effort,
    cwd: blindJudgeCwd(),
    allowedTools: BLIND_JUDGE_TOOLS,
    maxTurns: BLIND_JUDGE_MAX_TURNS,
  };
}

async function callJudge(exec, request, label, shape) {
  if (typeof exec !== "function") {
    throw new TypeError("exec must be an async function");
  }
  let raw;
  try {
    raw = await exec(request);
  } catch (cause) {
    throw new JudgeOutputError(
      `${label} call failed: ${cause?.message ?? cause}`,
      {
        cause,
      },
    );
  }
  return parseJudgeJson(raw, { shape, label });
}

/** file:line and bare-file references in a review's prose. */
export function mentionedLocations(text) {
  const found = new Map();
  for (const match of String(text ?? "").matchAll(LOCATION_PATTERN)) {
    const file = basenameOf(match[1]);
    const line = match[2] ? Number(match[2]) : null;
    found.set(`${file}:${line ?? ""}`, { file, line });
  }
  return [...found.values()];
}

/** Findings whose file is named in the output — the set worth judging. */
export function structuralCandidates({ truthFindings, output }) {
  const locations = mentionedLocations(output);
  const files = new Set(locations.map((location) => location.file));
  const candidates = [];
  for (const finding of truthFindings) {
    const base = basenameOf(finding.path);
    if (!base) continue;
    if (!files.has(base)) continue;
    const lineNear = locations.some(
      (location) =>
        location.file === base &&
        location.line !== null &&
        Number.isFinite(finding.line) &&
        Math.abs(location.line - finding.line) <= LINE_PROXIMITY,
    );
    candidates.push({ finding, fileHit: true, lineNear });
  }
  return candidates;
}

function defectDetail(finding) {
  return String(finding.body ?? "")
    .replace(MARKUP_PATTERN, "")
    .slice(0, MAX_DETAIL_CHARS)
    .trim();
}

function defectBlock(findings) {
  return findings
    .map((finding, index) => {
      const line = finding.line ?? "unknown";
      return (
        `${index + 1}. [${finding.severity}] ${finding.path}:${line} — ${finding.title}\n` +
        `   detail: ${defectDetail(finding)}`
      );
    })
    .join("\n");
}

function selectScorable(truthFindings, scorableIds) {
  const wanted = new Set(scorableIds);
  const selected = truthFindings.filter((finding) => wanted.has(finding.id));
  if (selected.length !== wanted.size) {
    const present = new Set(selected.map((finding) => finding.id));
    const missing = [...wanted].filter((id) => !present.has(id));
    throw new Error(
      `truth findings are missing scorable ids: ${missing.join(", ")}`,
    );
  }
  return selected;
}

/**
 * Split a review into discrete claims.
 *
 * Model-driven on purpose: a regex over headings and bullets scored reviews by
 * formatting rather than content — one contestant that wrote findings as bold
 * numbered paragraphs extracted zero claims from a review containing several.
 *
 * Every element must be a string. `String({})` is `"[object Object]"`, a
 * non-empty claim that survives the filter below, reads as vague to the novel
 * judge, and — because the review no longer extracts to zero claims — hides the
 * zero-finding RED gate. A malformed extractor reply poisons the pass instead.
 */
export async function extractClaims({
  transcript,
  exec,
  model = DEFAULT_JUDGE_MODEL,
  effort = DEFAULT_JUDGE_EFFORT,
}) {
  const review = String(transcript ?? "");
  if (!review.trim()) return [];
  const prompt = renderPrompt(loadPrompt("extract-claims"), {
    REVIEW: review.slice(0, MAX_SPLIT_REVIEW_CHARS),
  });
  const parsed = await callJudge(
    exec,
    blindRequest({ prompt, model, effort }),
    "claim extraction",
    "array",
  );
  for (const claim of parsed) {
    if (typeof claim !== "string") {
      throw new JudgeOutputError(
        `claim extraction returned a non-string claim ${JSON.stringify(claim ?? null)}`,
        { raw: JSON.stringify(parsed) },
      );
    }
  }
  return parsed
    .map((claim) => claim.slice(0, MAX_CLAIM_CHARS))
    .filter((claim) => claim.trim().length > 0)
    .slice(0, MAX_CLAIMS);
}

/**
 * Judge the review against the frozen scorable defects.
 *
 * `transcript` is the review text when the caller still holds it; that is what
 * bench2 judged. Without it the extracted claims stand in for the review.
 */
export async function matchClaims({
  claims,
  truthFindings,
  scorableIds,
  exec,
  transcript,
  model = DEFAULT_JUDGE_MODEL,
  effort = DEFAULT_JUDGE_EFFORT,
}) {
  const scorable = selectScorable(truthFindings, scorableIds);
  const review = String(transcript ?? "").trim()
    ? String(transcript)
    : (claims ?? []).join("\n");
  const candidates = structuralCandidates({
    truthFindings: scorable,
    output: review,
  });
  const shape = candidates.map((candidate, index) => ({
    index: index + 1,
    id: candidate.finding.id,
    path: candidate.finding.path,
    line: candidate.finding.line ?? null,
    severity: candidate.finding.severity,
    title: candidate.finding.title,
    lineNear: candidate.lineNear,
  }));
  if (candidates.length === 0) {
    return { matchedIds: [], judgeReasoning: {}, candidates: shape };
  }
  const prompt = renderPrompt(loadPrompt("judge-match"), {
    DEFECTS: defectBlock(candidates.map((candidate) => candidate.finding)),
    REVIEW: review.slice(0, MAX_JUDGE_REVIEW_CHARS),
  });
  const parsed = await callJudge(
    exec,
    blindRequest({ prompt, model, effort }),
    "match judge",
    "object",
  );
  const matches = requireMatches(parsed, "match judge", candidates.length);
  const matchedIds = [
    ...new Set(matches.map((entry) => candidates[entry - 1].finding.id)),
  ].sort((a, b) => a - b);
  // bench2 keyed reasoning by candidate index, which is meaningless once the
  // candidate list is gone. Key it by defect id so a ledger detail file stays
  // readable on its own.
  const reasoning = isObject(parsed.reasoning) ? parsed.reasoning : {};
  const judgeReasoning = {};
  for (const [key, why] of Object.entries(reasoning)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 1 || index > candidates.length)
      continue;
    judgeReasoning[String(candidates[index - 1].finding.id)] = String(why);
  }
  return { matchedIds, judgeReasoning, candidates: shape };
}

/**
 * Second pass: judge claims that fall OUTSIDE the ground-truth set. Recall
 * alone can only measure agreement with four CI bots. It scores a real defect
 * they missed as zero, and scores a confident hallucination as zero too — the
 * same number for opposite outcomes. This pass separates them by making a blind
 * judge verify each extra claim against the actual code.
 */
export async function classifyNovel({
  claims,
  matchedIds = [],
  truthFindings,
  exec,
  fixturePath = "",
  model = DEFAULT_JUDGE_MODEL,
  effort = DEFAULT_JUDGE_EFFORT,
}) {
  const list = (claims ?? []).filter(
    (claim) => String(claim).trim().length > 0,
  );
  const counts = { real: 0, wrong: 0, vague: 0, known: 0 };
  const summary = (verdicts) => ({
    claims: list.length,
    novelReal: counts.real,
    novelWrong: counts.wrong,
    novelVague: counts.vague,
    restatedKnown: counts.known,
    alreadyMatched: matchedIds.length,
    verdicts,
  });
  if (list.length === 0) return summary({});
  // `judge_novel.py` builds the known list from the acted-on findings alone.
  // A finding the author never acted on is not scored anywhere, so listing it
  // here turns a reviewer that correctly raised it into `restatedKnown` — a
  // bucket the ledger drops — instead of `novel_real`.
  const known = truthFindings
    .filter((finding) => finding.acted_on === true)
    .map(
      (finding) =>
        `- ${finding.path}:${finding.line ?? "unknown"} ` +
        `${String(finding.title ?? "").slice(0, MAX_KNOWN_TITLE_CHARS)}`,
    )
    .join("\n");
  const prompt = renderPrompt(loadPrompt("judge-novel"), {
    FIXTURE: fixturePath,
    CLAIMS: list.map((claim, index) => `${index + 1}. ${claim}`).join("\n"),
    KNOWN: known,
  });
  const parsed = await callJudge(
    exec,
    {
      prompt,
      model,
      effort,
      cwd: fixturePath,
      allowedTools: NOVEL_JUDGE_TOOLS,
      maxTurns: NOVEL_JUDGE_MAX_TURNS,
    },
    "novel judge",
    "object",
  );
  if (!isObject(parsed.verdicts)) {
    throw new JudgeOutputError("novel judge returned no verdicts object", {
      raw: JSON.stringify(parsed).slice(0, 2000),
    });
  }
  // Every claim needs its own verdict. A judge that answers for a subset — the
  // ordinary failure of a long reply — would otherwise have its omissions
  // counted as nothing at all, and `wrong_claims` is one of the two counters
  // that can turn a row RED on its own. A short reply and a clean review must
  // not produce the same number.
  const expectedKeys = list.map((_claim, index) => String(index + 1));
  const missing = expectedKeys.filter(
    (key) => !Object.hasOwn(parsed.verdicts, key),
  );
  const unexpected = Object.keys(parsed.verdicts).filter(
    (key) => !expectedKeys.includes(key),
  );
  if (missing.length || unexpected.length) {
    throw new JudgeOutputError(
      `novel judge returned ${Object.keys(parsed.verdicts).length} verdicts for ${list.length} claims` +
        (missing.length ? `; missing ${missing.join(", ")}` : "") +
        (unexpected.length ? `; unexpected ${unexpected.join(", ")}` : ""),
      { raw: JSON.stringify(parsed).slice(0, 2000) },
    );
  }
  // The counter below reads `verdict.class`, so a verdict that is not an
  // object is unparsable however plausible its contents. `{"1": "wrong"}`
  // carries a valid class name but `verdict.class` is `undefined`, so the
  // claim would land in no bucket and `novel_wrong` would stay at zero — the
  // same silent understatement of `wrong_claims` the class check exists to
  // prevent. Reject the shape before any class is read.
  const misshaped = Object.entries(parsed.verdicts).filter(
    ([, verdict]) => !isObject(verdict),
  );
  if (misshaped.length) {
    throw new JudgeOutputError(
      `novel judge returned ${misshaped.length} non-object verdict(s): ` +
        misshaped
          .map(([key, verdict]) => `${key}=${JSON.stringify(verdict)}`)
          .join(", "),
      { raw: JSON.stringify(parsed).slice(0, 2000) },
    );
  }
  // A class outside the four the prompt promises is an unparsable reply, not a
  // fifth bucket. Counted as `unknownClass` it was dropped by `foldCondition`:
  // a judge that misspelled or invented a class recorded neither a real nor a
  // wrong claim, so a parseable malformed reply understated `wrong_claims` —
  // one of the two counters that can turn a row RED on its own — and no number
  // anywhere said the verdict was missing.
  const offContract = Object.entries(parsed.verdicts)
    .map(([key, verdict]) => [key, verdict.class])
    .filter(([, cls]) => !NOVEL_CLASSES.includes(cls));
  if (offContract.length) {
    throw new JudgeOutputError(
      `novel judge returned ${offContract.length} verdict(s) outside ${NOVEL_CLASSES.join(", ")}: ` +
        offContract
          .map(([key, cls]) => `${key}=${JSON.stringify(cls)}`)
          .join(", "),
      { raw: JSON.stringify(parsed).slice(0, 2000) },
    );
  }
  for (const verdict of Object.values(parsed.verdicts)) {
    counts[verdict.class] += 1;
  }
  return summary(parsed.verdicts);
}

/**
 * Fold k draws of one condition into the ledger's per-defect bit vectors.
 *
 * `per_defect` is what makes every later comparison deterministic: McNemar runs
 * on committed booleans, so no model is re-invoked to compare two months.
 */
export function aggregateDraws({ scorableIds, p1Ids = [], draws }) {
  if (!Array.isArray(draws) || draws.length === 0) {
    throw new Error("aggregateDraws needs at least one draw");
  }
  const p1 = new Set(p1Ids);
  // A draw may declare the defect ids it covered. A defect whose PR never ran
  // that draw gets no bit at all, so its bit vector is as long as the number of
  // draws its own PR completed and `opportunities` shrinks instead of `matched`.
  const covered = draws.map((draw) =>
    Array.isArray(draw) || !Array.isArray(draw.scorableIds)
      ? null
      : new Set(draw.scorableIds.map(String)),
  );
  const perDefect = {};
  for (const id of scorableIds) {
    perDefect[String(id)] = draws
      .filter(
        (_draw, index) => !covered[index] || covered[index].has(String(id)),
      )
      .map((draw) => (new Set(draw.matchedIds ?? draw).has(id) ? 1 : 0));
  }
  const bucket = (ids) => {
    const matched = ids.reduce(
      (total, id) => total + perDefect[String(id)].reduce((a, b) => a + b, 0),
      0,
    );
    const opportunities = ids.reduce(
      (total, id) => total + perDefect[String(id)].length,
      0,
    );
    const rate =
      opportunities === 0 ? null : Number((matched / opportunities).toFixed(3));
    return { matched, opportunities, rate };
  };
  return {
    draws: draws.length,
    recall: bucket(scorableIds),
    p1: bucket(scorableIds.filter((id) => p1.has(id))),
    per_defect: perDefect,
  };
}

export function validateCalibrationSet(doc) {
  const problems = [];
  const check = (ok, message) => {
    if (!ok) problems.push(message);
  };
  if (!isObject(doc)) {
    return { ok: false, problems: ["calibration set must be an object"] };
  }
  check(doc.schema_version === 1, "schema_version must be 1");
  check(
    typeof doc.provenance === "string" &&
      (doc.provenance.includes("not human audits") ||
        doc.provenance.includes("re-audited")),
    "provenance must state how the labels were sourced and audited",
  );
  check(
    isObject(doc.judge) && typeof doc.judge.model === "string",
    "judge.model must be a string",
  );
  if (!Array.isArray(doc.records)) {
    return { ok: false, problems: [...problems, "records must be an array"] };
  }
  const records = doc.records;
  check(
    records.length === 40,
    `records must hold 40 pairs, found ${records.length}`,
  );
  const ids = new Set();
  const tally = { matched: 0, unmatched: 0 };
  for (const [index, record] of records.entries()) {
    const at = `records[${index}]`;
    if (!isObject(record)) {
      problems.push(`${at} must be an object`);
      continue;
    }
    const id = record.record_id;
    check(
      typeof id === "string" && id.length > 0 && !ids.has(id),
      `${at}.record_id must be a unique non-empty string`,
    );
    ids.add(id);
    if (CALIBRATION_VERDICTS.includes(record.expected_verdict)) {
      tally[record.expected_verdict] += 1;
    } else {
      problems.push(`${at}.expected_verdict must be matched or unmatched`);
    }
    check(
      typeof record.claim_excerpt === "string" &&
        record.claim_excerpt.trim().length >= 50,
      `${at}.claim_excerpt must be a review excerpt`,
    );
    check(
      typeof record.frozen_reasoning === "string" &&
        record.frozen_reasoning.length > 0,
      `${at}.frozen_reasoning must record why the frozen judge decided`,
    );
    check(
      Number.isSafeInteger(record.defect_id),
      `${at}.defect_id must be an integer`,
    );
    check(
      isObject(record.source_cell) &&
        Number.isSafeInteger(record.source_cell.pr),
      `${at}.source_cell.pr must be an integer`,
    );
    if (!isObject(record.defect)) {
      problems.push(`${at}.defect must be an object`);
      continue;
    }
    check(
      record.defect.id === record.defect_id,
      `${at}.defect.id must equal defect_id`,
    );
    for (const key of ["severity", "path", "title", "detail"]) {
      check(
        typeof record.defect[key] === "string",
        `${at}.defect.${key} must be a string`,
      );
    }
  }
  check(
    records.length !== 40 || Math.abs(tally.matched - tally.unmatched) <= 4,
    `records must be roughly balanced, found ${tally.matched} matched / ${tally.unmatched} unmatched`,
  );
  return { ok: problems.length === 0, problems };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await worker(items[index], index);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

/**
 * Replay the frozen calibration pairs through the current judge. This is the
 * only check that separates "the review skill regressed" from "the judge alias
 * now points at different weights and got stricter".
 */
export async function runCalibration({
  calibrationSet,
  exec,
  model = DEFAULT_JUDGE_MODEL,
  effort = DEFAULT_JUDGE_EFFORT,
  concurrency = DEFAULT_CALIBRATION_CONCURRENCY,
}) {
  const records = Array.isArray(calibrationSet)
    ? calibrationSet
    : (calibrationSet?.records ?? []);
  if (records.length === 0) throw new Error("calibration set is empty");
  const outcomes = await mapWithConcurrency(
    records,
    Math.max(1, concurrency),
    async (record) => {
      const prompt = renderPrompt(loadPrompt("judge-match"), {
        DEFECTS: defectBlock([record.defect]),
        REVIEW: String(record.claim_excerpt).slice(0, MAX_JUDGE_REVIEW_CHARS),
      });
      const parsed = await callJudge(
        exec,
        blindRequest({ prompt, model, effort }),
        `calibration ${record.record_id}`,
        "object",
      );
      // A calibration prompt carries exactly one defect, so 1 is the only
      // index the judge may name.
      const matches = requireMatches(
        parsed,
        `calibration ${record.record_id}`,
        1,
      );
      const actual = matches.includes(1) ? "matched" : "unmatched";
      return {
        record_id: record.record_id,
        defect_id: record.defect_id,
        expected: record.expected_verdict,
        actual,
        reasoning: isObject(parsed.reasoning)
          ? String(parsed.reasoning["1"] ?? "")
          : "",
      };
    },
  );
  const disagreements = outcomes.filter(
    (outcome) => outcome.actual !== outcome.expected,
  );
  // Every outcome is returned, not just the disagreements: `--validate`
  // re-derives `judge_calibration` from these pairs instead of trusting the
  // agreement the row states about itself.
  return {
    agreement: outcomes.length - disagreements.length,
    total: outcomes.length,
    disagreements,
    outcomes,
  };
}
