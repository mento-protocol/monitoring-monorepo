// V2 scores a complete final report. V1 captures and scores stay unchanged.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  blindJudgeCwd,
  parseJudgeJson,
  renderPrompt,
} from "./review-eval-score.mjs";

export const FINAL_REVIEW_CONTRACT = "final-consolidated-v1";
const promptNames = ["extract-claims", "judge-match", "judge-novel"];
const directory = path.dirname(fileURLToPath(import.meta.url));
const promptPath = (name) => path.join(directory, "prompts/v2", `${name}.md`);

function currentScorerDigest() {
  const files = [
    fileURLToPath(import.meta.url),
    path.join(directory, "review-eval-score.mjs"),
    path.join(directory, "review-eval-stream.mjs"),
    // rootsForCase selects the answer-key roots sent to the grader.
    path.join(directory, "review-eval-v2-selection.mjs"),
    // Cached grades and their headline metrics must share a versioned reducer.
    path.join(directory, "review-eval-v2-report.mjs"),
    ...promptNames.map(promptPath),
  ];
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(directory, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

// ESM functions stay loaded even when their files change. Never stamp that old
// implementation with a digest of newer bytes. Intentional edits need a restart.
const loadedScorerDigest = currentScorerDigest();
export function scorerDigestV2() {
  requireValue(
    currentScorerDigest() === loadedScorerDigest,
    "scoring source changed after module load; restart the process to rescore",
  );
  return loadedScorerDigest;
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

const nonempty = (value) =>
  typeof value === "string" && value.trim().length > 0;

function requireQuote(quote, source, label) {
  requireValue(
    nonempty(quote) && source.includes(quote),
    `${label}: quote is absent from its source`,
  );
}

function exactIds(records, ids, key, label) {
  requireValue(Array.isArray(records), `${label}: expected an array`);
  const actual = records.map((record) => record?.[key]);
  requireValue(
    actual.length === ids.length &&
      new Set(actual).size === actual.length &&
      actual.every((id) => ids.includes(id)),
    `${label}: missing, duplicate, or unknown IDs`,
  );
}

async function call(judge, name, values, fixturePath, maxInputChars) {
  scorerDigestV2();
  const prompt = renderPrompt(readFileSync(promptPath(name), "utf8"), values);
  requireValue(
    prompt.length <= maxInputChars,
    `${name}: input exceeds ${maxInputChars} characters; no text was truncated`,
  );
  const sourceJudge = name === "judge-novel";
  const raw = await judge.exec({
    prompt,
    model: judge.model,
    effort: judge.effort,
    cwd: sourceJudge ? fixturePath : blindJudgeCwd(),
    allowedTools: sourceJudge ? ["Read", "Grep", "Glob"] : [],
    maxTurns: sourceJudge ? 60 : 1,
  });
  scorerDigestV2();
  // The injected executor can return a CLI envelope. An error result must not
  // become an apparently valid partial response after JSON extraction.
  try {
    const envelope = JSON.parse(raw);
    requireValue(
      envelope?.is_error !== true,
      `${name}: provider reported an error`,
    );
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return parseJudgeJson(raw, { label: name });
}

function claimsFrom(parsed, finalText) {
  requireValue(
    parsed.complete === true && Array.isArray(parsed.claims),
    "extraction did not report complete coverage",
  );
  const seen = new Set();
  for (const claim of parsed.claims) {
    requireValue(nonempty(claim?.text), "extraction returned an empty claim");
    requireQuote(claim.quote, finalText, "claim");
    const key = JSON.stringify([claim.text, claim.quote]);
    requireValue(!seen.has(key), "extraction returned duplicate claims");
    seen.add(key);
  }
  return parsed.claims.map((claim, index) => ({
    id: `c${index + 1}`,
    text: claim.text,
    quote: claim.quote,
  }));
}

function matchesFrom(parsed, defects, claims, finalText) {
  exactIds(
    parsed.defects,
    defects.map((defect) => defect.id),
    "id",
    "matching",
  );
  const claimMap = new Map(claims.map((claim) => [claim.id, claim]));
  return parsed.defects.map((record) => {
    requireValue(
      ["matched", "unmatched", "uncertain"].includes(record.verdict),
      "matching returned an invalid verdict",
    );
    requireValue(
      nonempty(record.reason) && Array.isArray(record.claim_ids),
      "matching omitted reason or claim IDs",
    );
    requireValue(
      new Set(record.claim_ids).size === record.claim_ids.length &&
        record.claim_ids.every((id) => claimMap.has(id)),
      "matching returned duplicate or unknown claim IDs",
    );
    if (record.verdict === "matched") {
      requireValue(
        record.claim_ids.length > 0,
        "matching returned a hit without a claim",
      );
      requireQuote(record.quote, finalText, "matched defect");
      requireValue(
        record.claim_ids.some((id) =>
          claimMap.get(id).quote.includes(record.quote),
        ),
        "matched quote is absent from the linked claims",
      );
    } else if (record.verdict === "unmatched") {
      requireValue(
        record.claim_ids.length === 0,
        "unmatched defect has claim IDs",
      );
    }
    return {
      id: record.id,
      verdict: record.verdict,
      claim_ids: record.claim_ids,
      quote: record.quote ?? "",
      reason: record.reason,
    };
  });
}

function verifyEvidence(evidence, fixturePath) {
  requireValue(
    Array.isArray(evidence) && evidence.length > 0,
    "source verdict has no evidence",
  );
  const root = realpathSync(fixturePath);
  for (const item of evidence) {
    requireValue(
      nonempty(item?.path) && !path.isAbsolute(item.path),
      "source evidence needs a relative path",
    );
    const file = realpathSync(path.resolve(root, item.path));
    const relative = path.relative(root, file);
    requireValue(
      relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative),
      "source evidence escapes the fixture",
    );
    requireQuote(item.quote, readFileSync(file, "utf8"), "source evidence");
  }
}

function novelFrom(parsed, claims, fixturePath) {
  exactIds(
    parsed.novel,
    claims.map((claim) => claim.id),
    "claim_id",
    "classification",
  );
  return parsed.novel.map((record) => {
    requireValue(
      ["model-supported", "wrong", "unsupported", "unverified"].includes(
        record.verdict,
      ),
      "classification returned an invalid verdict",
    );
    requireValue(nonempty(record.reason), "classification omitted its reason");
    if (["model-supported", "wrong"].includes(record.verdict))
      verifyEvidence(record.evidence, fixturePath);
    return {
      claim_id: record.claim_id,
      verdict: record.verdict,
      reason: record.reason,
      evidence: record.evidence ?? [],
    };
  });
}

/** All model calls use the injected executor, which owns usage accounting. */
export async function scoreReview({
  review,
  defects,
  fixturePath,
  sourceDiff,
  judge,
  maxInputChars = 120_000,
}) {
  const result = {
    schema_version: 2,
    status: "incomplete",
    claims: [],
    defects: [],
    novel: [],
    coverage: {
      extraction: "pending",
      matching: "pending",
      classification: "pending",
    },
    calibration: { expert_validated: false },
    limitations: [
      "Claim extraction and grading have not been validated against independent expert labels. Novel findings are model-supported, not human-confirmed.",
    ],
    errors: [],
  };
  let phase = "extraction";
  try {
    scorerDigestV2();
    requireValue(
      review?.completed === true &&
        review.outputContract === FINAL_REVIEW_CONTRACT,
      "review lacks the completed final-review contract",
    );
    requireValue(
      nonempty(review.finalText),
      "review has no final text; use an explicit no-findings report",
    );
    requireValue(
      Number.isSafeInteger(maxInputChars) && maxInputChars > 0,
      "invalid input limit",
    );
    requireValue(
      typeof judge?.exec === "function" &&
        nonempty(judge.model) &&
        nonempty(judge.effort),
      "judge configuration is incomplete",
    );
    requireValue(
      Array.isArray(defects) &&
        defects.every((defect) => nonempty(defect?.id)) &&
        new Set(defects.map((defect) => defect.id)).size === defects.length,
      "defects need distinct nonempty string IDs",
    );
    const extracted = await call(
      judge,
      "extract-claims",
      { REVIEW: review.finalText },
      fixturePath,
      maxInputChars,
    );
    result.claims = claimsFrom(extracted, review.finalText);
    result.coverage.extraction = "complete";
    phase = "matching";
    if (defects.length > 0 && result.claims.length > 0) {
      const matched = await call(
        judge,
        "judge-match",
        {
          REVIEW: review.finalText,
          CLAIMS: JSON.stringify(result.claims),
          DEFECTS: JSON.stringify(defects),
        },
        fixturePath,
        maxInputChars,
      );
      result.defects = matchesFrom(
        matched,
        defects,
        result.claims,
        review.finalText,
      );
    } else {
      result.defects = defects.map((defect) => ({
        id: defect.id,
        verdict: "unmatched",
        claim_ids: [],
        quote: "",
        reason: "The final review makes no defect claims.",
      }));
    }
    result.coverage.matching = result.defects.some(
      (defect) => defect.verdict === "uncertain",
    )
      ? "incomplete"
      : "complete";
    phase = "classification";
    const knownClaims = new Set(
      result.defects
        .filter((defect) => defect.verdict === "matched")
        .flatMap((defect) => defect.claim_ids),
    );
    const unmatched = result.claims.filter(
      (claim) => !knownClaims.has(claim.id),
    );
    if (unmatched.length > 0) {
      requireValue(
        nonempty(fixturePath),
        "unmatched claims require a source fixture",
      );
      requireValue(
        typeof sourceDiff === "string",
        "unmatched claims require the complete working-tree diff",
      );
      const classified = await call(
        judge,
        "judge-novel",
        { CLAIMS: JSON.stringify(unmatched), DIFF: sourceDiff },
        fixturePath,
        maxInputChars,
      );
      result.novel = novelFrom(classified, unmatched, fixturePath);
    }
    result.coverage.classification = result.novel.some(
      (claim) => claim.verdict === "unverified",
    )
      ? "incomplete"
      : "complete";
    if (
      Object.values(result.coverage).every(
        (coverage) => coverage === "complete",
      )
    )
      result.status = "complete";
    else
      result.limitations.push(
        "Some defect matches or claim classifications remain uncertain.",
      );
  } catch (error) {
    result.coverage[phase] = "incomplete";
    result.errors.push({ phase, message: error.message });
  }
  return result;
}
