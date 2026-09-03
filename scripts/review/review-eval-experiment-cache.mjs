// Small content-addressed caches for review-skill experiments.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";

import { materializeFixture } from "./review-eval-fixtures.mjs";
import {
  claudeArgv,
  claudeStreamEnvelope,
} from "./review-eval-run-execution.mjs";
import { expandHome, skillDigest } from "./review-eval-run-plan.mjs";
import {
  digestObject,
  MAX_FIXTURE_LANES,
} from "./review-eval-experiment-contract.mjs";

const CACHE_KINDS = new Set(["raw", "score", "novel", "stage"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const execFileAsync = promisify(execFile);

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function readPinnedExperimentFile({ repoRoot, record, label }) {
  const file = path.resolve(repoRoot, record?.file ?? "");
  const bytes = readFileSync(file);
  if (sha256Bytes(bytes) !== record?.sha256) {
    throw new Error(`${label} digest differs from the experiment plan`);
  }
  return bytes.toString("utf8");
}

export function defaultExperimentPrepareFixture({
  contract,
  lane,
  fixtureCacheDir,
  repoRoot,
}) {
  return materializeFixture({
    contract,
    pr: lane.pr,
    cacheDir: fixtureCacheDir,
    srcRepo: repoRoot,
    repoRoot,
  });
}

export function defaultExperimentTruth({ repoRoot, lane }) {
  return JSON.parse(
    readPinnedExperimentFile({
      repoRoot,
      record: {
        file: lane.fixture.truth_file,
        sha256: lane.fixture.truth_sha256,
      },
      label: `PR ${lane.pr} truth`,
    }),
  );
}

export function experimentProviderText(value, label) {
  const text =
    typeof value === "string"
      ? value
      : typeof value?.stdout === "string"
        ? value.stdout
        : null;
  if (text === null) throw new Error(`${label} returned no text`);
  return text;
}

/**
 * The contestant envelope, rebuilt from the cell's `stream-json` session.
 *
 * `result` is every assistant message the reviewer wrote, in order, separated
 * by a blank line. The single-shot `--output-format json` envelope this
 * replaced carried only the last one, so a cell that filed its report, ran one
 * more tool call and then posted an addendum was scored on the addendum.
 */
export function parseExperimentContestantEnvelope(raw) {
  let envelope;
  try {
    envelope = claudeStreamEnvelope(experimentProviderText(raw, "contestant"), {
      label: "contestant",
      resultText: "session",
    });
  } catch (error) {
    throw new Error(`contestant returned malformed JSON: ${error.message}`, {
      cause: error,
    });
  }
  if (envelope.is_error !== false || typeof envelope.result !== "string") {
    throw new Error("contestant returned no usable review text");
  }
  return envelope;
}

export function liveFinderHandoff(value, maxBytes = 30_000) {
  const bytes = Buffer.from(String(value ?? ""));
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  const text = bytes.subarray(start).toString("utf8");
  return { text, digest: sha256Bytes(text) };
}

export function experimentCellId(lane, treatment) {
  return `${lane.lane_id}-${treatment}`;
}

export function experimentTreatment(plan, treatment) {
  if (treatment === "incumbent") return plan.incumbent;
  if (treatment === "candidate") return plan.candidate;
  throw new Error(`unknown experiment treatment ${treatment}`);
}

export function experimentModel(plan, name) {
  const selected = plan.inputs?.models?.[name];
  if (
    !selected ||
    typeof selected.model !== "string" ||
    typeof selected.effort !== "string"
  ) {
    throw new Error(`experiment plan has no ${name} model`);
  }
  return selected;
}

export function renderExperimentHandoff(template, source) {
  if (!template.includes("{{OTHER_REVIEW}}")) {
    throw new Error("experiment handoff prompt has no placeholder");
  }
  return template.replace("{{OTHER_REVIEW}}", () => source);
}

function skillBody(text) {
  const lines = text.split("\n");
  if (lines[0] !== "---") return text;
  const end = lines.indexOf("---", 1);
  return end === -1 ? text : lines.slice(end + 1).join("\n");
}

function bundledSkillFiles(root, relative = "", files = []) {
  for (const entry of readdirSync(path.join(root, relative), {
    withFileTypes: true,
  }).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) bundledSkillFiles(root, child, files);
    else if (entry.isFile() && child !== "SKILL.md") files.push(child);
  }
  return files;
}

export function purgeExperimentSkill(fixturePath) {
  rmSync(path.join(fixturePath, ".skill"), { recursive: true, force: true });
}

export function stageExperimentSkill({ fixturePath, skill }) {
  const source = expandHome(skill.skill_ref);
  if (skillDigest(source) !== skill.skill_digest) {
    throw new Error(`${skill.id} skill changed after experiment planning`);
  }
  const target = path.join(fixturePath, ".skill");
  purgeExperimentSkill(fixturePath);
  try {
    cpSync(source, target, {
      recursive: true,
      filter: (candidate) =>
        candidate === source ||
        ![".git", ".DS_Store"].includes(path.basename(candidate)),
    });
    if (skillDigest(target) !== skill.skill_digest) {
      throw new Error(`${skill.id} staged skill differs from its plan`);
    }
    const body = skillBody(readFileSync(path.join(target, "SKILL.md"), "utf8"));
    if (!body.trim()) throw new Error(`${skill.id} skill has no instructions`);
    const extras = bundledSkillFiles(target);
    return [
      "A skill has been loaded for this task. Treat it as authoritative.",
      "",
      "<skill-instructions>",
      body,
      "</skill-instructions>",
      ...(extras.length === 0
        ? []
        : [
            "",
            "Bundled files ship with these instructions in `.skill/` of your working directory; a relative path in the instructions resolves to `.skill/<path>`:",
            ...extras.map((file) => `  - .skill/${file}`),
          ]),
    ].join("\n");
  } catch (error) {
    purgeExperimentSkill(fixturePath);
    throw error;
  }
}

export function experimentContestantArgv({ prompt, model, systemPrompt }) {
  return [
    ...claudeArgv({ prompt, model: model.model, effort: model.effort }),
    "--append-system-prompt",
    systemPrompt,
  ];
}

async function execExperimentArgv({ argv, cwd, env, label }) {
  const { stdout } = await execFileAsync(argv[0], argv.slice(1), {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 3_600_000,
  });
  return experimentProviderText(stdout, label);
}

export function defaultExperimentFinderExec({ argv, cwd, env }) {
  return execExperimentArgv({ argv, cwd, env, label: "live finder" });
}

export function defaultExperimentContestantExec({ argv, fixturePath, env }) {
  return execExperimentArgv({
    argv: ["claude", ...argv],
    cwd: fixturePath,
    env,
    label: "contestant",
  });
}

export async function resetExperimentFixture({ reset, fixture, lane, label }) {
  const resetOk = await reset({
    fixturePath: fixture.path,
    head: lane.fixture.first_head,
    cellId: label,
  });
  if (resetOk === false) {
    throw new Error(
      `fixture for PR ${lane.pr} could not reset before ${label}`,
    );
  }
}

export function assertExperimentConcurrency(concurrency) {
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_FIXTURE_LANES
  ) {
    throw new Error(`fixture lane concurrency must be 1..${MAX_FIXTURE_LANES}`);
  }
}

export async function mapExperimentLimit(values, concurrency, worker) {
  const output = new Array(values.length);
  let next = 0;
  let stopped = false;
  let firstError;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (!stopped && next < values.length) {
        const index = next;
        next += 1;
        try {
          output[index] = await worker(values[index], index);
        } catch (error) {
          if (!stopped) {
            stopped = true;
            firstError = error;
          }
        }
      }
    },
  );
  await Promise.all(workers);
  if (stopped) throw firstError;
  return output;
}

function assertKind(kind) {
  if (!CACHE_KINDS.has(kind)) {
    throw new Error(
      "experiment cache kind must be raw, score, novel, or stage",
    );
  }
  return kind;
}

function assertIdentity(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error("experiment cache identity must be an object");
  }
  if (!SHA256_PATTERN.test(String(identity.digest ?? ""))) {
    throw new Error(
      "experiment cache identity digest must be a lowercase sha256",
    );
  }
  const inputs = { ...identity };
  delete inputs.digest;
  if (digestObject(inputs) !== identity.digest) {
    throw new Error("experiment cache identity digest does not recompute");
  }
  return identity;
}

function artifactDigest(artifact) {
  const value = { ...artifact };
  delete value.content_digest;
  return digestObject(value);
}

function parseArtifact(bytes, file) {
  try {
    return JSON.parse(bytes);
  } catch (error) {
    throw new Error(`experiment cache ${file} is not valid JSON`, {
      cause: error,
    });
  }
}

function validateArtifact({ artifact, file, kind, identity }) {
  if (
    artifact?.schema_version !== 1 ||
    artifact.cache_kind !== kind ||
    !isDeepStrictEqual(artifact.identity, identity)
  ) {
    throw new Error(`experiment cache ${file} has a mismatched identity`);
  }
  if (
    !SHA256_PATTERN.test(String(artifact.content_digest ?? "")) ||
    artifact.content_digest !== artifactDigest(artifact)
  ) {
    throw new Error(`experiment cache ${file} has a mismatched content digest`);
  }
  if (!Object.hasOwn(artifact, "payload")) {
    throw new Error(`experiment cache ${file} has no payload`);
  }
  return artifact;
}

export function experimentCacheFile({ artifactRoot, kind, identity }) {
  assertKind(kind);
  assertIdentity(identity);
  if (typeof artifactRoot !== "string" || !path.isAbsolute(artifactRoot)) {
    throw new Error("experiment artifact root must be an absolute path");
  }
  return path.join(artifactRoot, "cache", kind, `${identity.digest}.json`);
}

/** Read only the final cache name. Temporary files are never candidates. */
export function readExperimentCache({ artifactRoot, kind, identity }) {
  const file = experimentCacheFile({ artifactRoot, kind, identity });
  if (!existsSync(file)) return null;
  const artifact = validateArtifact({
    artifact: parseArtifact(readFileSync(file, "utf8"), file),
    file,
    kind,
    identity,
  });
  return { artifact, file, payload: artifact.payload, reused: true };
}

/** Publish one complete JSON artifact without replacing a concurrent winner. */
export function writeExperimentCache({
  artifactRoot,
  kind,
  identity,
  payload,
  beforePublish = null,
}) {
  const file = experimentCacheFile({ artifactRoot, kind, identity });
  const base = {
    schema_version: 1,
    cache_kind: kind,
    identity,
    payload,
  };
  const artifact = { ...base, content_digest: digestObject(base) };
  const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

  const existing = readExperimentCache({ artifactRoot, kind, identity });
  if (existing) {
    if (!isDeepStrictEqual(existing.artifact, artifact)) {
      throw new Error(
        `experiment cache ${file} already has different content for its identity`,
      );
    }
    return existing;
  }

  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}-${randomUUID()}.tmp`,
  );
  writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    validateArtifact({
      artifact: parseArtifact(readFileSync(temporary, "utf8"), temporary),
      file: temporary,
      kind,
      identity,
    });
    beforePublish?.();
    try {
      linkSync(temporary, file);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const winner = readExperimentCache({ artifactRoot, kind, identity });
      if (!winner || !isDeepStrictEqual(winner.artifact, artifact)) {
        throw new Error(
          `experiment cache ${file} already has different content for its identity`,
          { cause: error },
        );
      }
      return winner;
    }
    return {
      ...readExperimentCache({ artifactRoot, kind, identity }),
      reused: false,
    };
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function validateRawExperimentPayload(payload, expected) {
  if (
    payload?.ok !== true ||
    payload.campaign_id !== expected.plan.campaign_id ||
    payload.candidate_id !== expected.plan.candidate.id ||
    payload.stage !== expected.stage ||
    payload.cell_id !== expected.cellId ||
    payload.pr !== expected.lane.pr ||
    payload.treatment !== expected.treatment ||
    payload.source_digest !== expected.source.digest ||
    payload.source_report !== expected.source.text ||
    typeof payload.output !== "string"
  ) {
    throw new Error("raw experiment cache payload is mismatched");
  }
  return payload;
}

export function validateScoreExperimentPayload(payload, rawDigest) {
  const leak = payload?.leak;
  if (
    payload?.raw_digest !== rawDigest ||
    !Array.isArray(payload.claims) ||
    payload.claims.some((claim) => typeof claim !== "string") ||
    !Array.isArray(payload.matched_ids) ||
    payload.matched_ids.some((id) => !Number.isSafeInteger(id)) ||
    !leak ||
    typeof leak.suspected !== "boolean" ||
    !Array.isArray(leak.hard) ||
    !Array.isArray(leak.advisory)
  ) {
    throw new Error("score experiment cache payload is malformed");
  }
  return payload;
}

export function validateNovelExperimentPayload(payload, scoreDigest) {
  if (
    payload?.score_digest !== scoreDigest ||
    !Number.isSafeInteger(payload.verdict?.novelWrong) ||
    payload.verdict.novelWrong < 0 ||
    !Number.isSafeInteger(payload.verdict?.novelReal) ||
    payload.verdict.novelReal < 0
  ) {
    throw new Error("novel experiment cache payload is malformed");
  }
  return payload;
}
