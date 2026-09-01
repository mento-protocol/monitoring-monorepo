// In-memory source sealing for one paid experiment stage.

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { BUILD_FIXTURE_SCRIPT } from "./review-eval-fixtures.mjs";
import { digestObject } from "./review-eval-experiment-contract.mjs";
import { resolveExperimentArtifactPath } from "./review-eval-experiment-evidence.mjs";
import { loadPrompt, scorerDigest } from "./review-eval-score.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactFile(artifactRoot, relativePath) {
  const file = resolveExperimentArtifactPath({ artifactRoot, relativePath });
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return file;
}

function writeBytesOnce(file, bytes, mode = 0o600, beforeWrite = null) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (existsSync(file)) {
    if (!readFileSync(file).equals(value)) {
      throw new Error(`sealed source ${file} already has different content`);
    }
    return;
  }
  beforeWrite?.();
  const temporary = `${file}.${process.pid}-${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { flag: "wx", mode });
  try {
    beforeWrite?.();
    linkSync(temporary, file);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (!readFileSync(file).equals(value)) {
      throw new Error(`sealed source ${file} already has different content`, {
        cause: error,
      });
    }
  } finally {
    unlinkSync(temporary);
  }
}

function writeJsonOnce(file, value, beforeWrite = null) {
  writeBytesOnce(
    file,
    `${JSON.stringify(value, null, 2)}\n`,
    0o600,
    beforeWrite,
  );
}

function captureSkillFiles(root, relative = "", output = []) {
  for (const entry of readdirSync(path.join(root, relative), {
    withFileTypes: true,
  }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === ".git" || entry.name === ".DS_Store") continue;
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`skill file ${child} is a symlink`);
    }
    if (entry.isDirectory()) captureSkillFiles(root, child, output);
    else if (entry.isFile()) {
      const file = path.join(root, child);
      output.push({
        relative: child,
        bytes: readFileSync(file),
        mode: statSync(file).mode & 0o777,
      });
    }
  }
  return output;
}

export function capturedSkillDigest(files) {
  const hash = createHash("sha256");
  const updateFramed = (bytes) => {
    const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(value.length));
    hash.update(length);
    hash.update(value);
  };
  for (const file of [...files].sort((left, right) =>
    left.relative < right.relative
      ? -1
      : left.relative > right.relative
        ? 1
        : 0,
  )) {
    updateFramed(file.relative);
    updateFramed((file.mode & 0o777).toString(8).padStart(3, "0"));
    updateFramed(file.bytes);
  }
  return hash.digest("hex");
}

/** Digest the exact bytes and portable modes that the experiment will stage. */
export function experimentSkillDigest(root) {
  return capturedSkillDigest(captureSkillFiles(path.resolve(root)));
}

function captureTreatment(selected) {
  const files = captureSkillFiles(selected.skill_ref);
  const skillFile = files.find((file) => file.relative === "SKILL.md");
  if (!skillFile) {
    throw new Error(`${selected.id} skill snapshot has no SKILL.md`);
  }
  if (
    !skillBody(skillFile.bytes.toString("utf8"))
      .split("\n")
      .some((line) => line.trim().length > 0)
  ) {
    throw new Error(`${selected.id} skill snapshot has no instruction body`);
  }
  const digest = capturedSkillDigest(files);
  if (digest !== selected.skill_digest) {
    throw new Error(
      `${selected.id} skill changed after planning: expected ${selected.skill_digest}, got ${digest}`,
    );
  }
  return { id: selected.id, digest, files };
}

function skillBody(bytes) {
  const lines = String(bytes).split("\n");
  if (lines[0] !== "---") return lines.join("\n");
  const end = lines.indexOf("---", 1);
  return end === -1 ? lines.join("\n") : lines.slice(end + 1).join("\n");
}

export function stageExperimentSkill({ fixturePath, snapshot }) {
  const target = path.join(fixturePath, ".skill");
  rmSync(target, { recursive: true, force: true });
  for (const file of snapshot.files) {
    const destination = path.join(target, file.relative);
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, file.bytes, { mode: file.mode });
  }
  const skillFile = snapshot.files.find((file) => file.relative === "SKILL.md");
  if (!skillFile) throw new Error("staged skill has no SKILL.md");
  const body = skillBody(skillFile.bytes.toString("utf8"));
  if (!body.split("\n").some((line) => line.trim().length > 0)) {
    throw new Error("staged skill has no instruction body");
  }
  const extras = snapshot.files
    .map((file) => file.relative)
    .filter((file) => file !== "SKILL.md");
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
          "Bundled files are available under `.skill/`:",
          ...extras.map((file) => `  - .skill/${file}`),
        ]),
  ].join("\n");
}

/** Hold all answer-key bytes in parent memory before any paid process starts. */
export function sealExperimentRuntimeSources({
  plan,
  contract,
  artifactRoot,
  repoRoot,
  calibrationPath,
  beforeWrite = null,
}) {
  const prefix = `snapshots/runtime/${plan.plan_digest}`;
  const skillSnapshots = Object.fromEntries(
    [plan.incumbent, ...plan.candidates].map((selected) => [
      selected.id,
      captureTreatment(selected),
    ]),
  );
  for (const name of ["extract-claims", "judge-match", "judge-novel"]) {
    loadPrompt(name);
  }

  const handoffBytes = readFileSync(
    path.resolve(repoRoot, contract.prompts.handoff.file),
  );
  if (sha256(handoffBytes) !== contract.prompts.handoff.sha256) {
    throw new Error("handoff prompt changed before source sealing");
  }
  const lanes = plan.candidate_plans.flatMap((candidate) =>
    Object.values(candidate.stages).flatMap((stage) => stage.lanes),
  );
  const truthByPr = {};
  const finderReports = {};
  for (const lane of lanes) {
    if (!truthByPr[String(lane.pr)]) {
      const truthBytes = readFileSync(
        path.resolve(repoRoot, lane.fixture.truth_file),
      );
      if (sha256(truthBytes) !== lane.fixture.truth_sha256) {
        throw new Error(`truth changed for PR ${lane.pr}`);
      }
      truthByPr[String(lane.pr)] = JSON.parse(truthBytes.toString("utf8"));
    }
    if (
      lane.source.kind === "frozen-replay" &&
      !Object.hasOwn(finderReports, lane.source.file)
    ) {
      const reportBytes = readFileSync(
        path.resolve(repoRoot, lane.source.file),
      );
      if (sha256(reportBytes) !== lane.source.sha256) {
        throw new Error(`frozen finder report changed for PR ${lane.pr}`);
      }
      const report = reportBytes.toString("utf8");
      if (!report.trim()) {
        throw new Error(`frozen finder report is empty for PR ${lane.pr}`);
      }
      finderReports[lane.source.file] = report;
    }
  }

  const calibrationBytes = readFileSync(calibrationPath);
  if (sha256(calibrationBytes) !== plan.identities.calibration_digest) {
    throw new Error("calibration changed before source sealing");
  }
  const fixtureScriptBytes = readFileSync(BUILD_FIXTURE_SCRIPT);
  const sealedFixtureScript = artifactFile(
    artifactRoot,
    `${prefix}/build-fixture.sh`,
  );
  writeBytesOnce(sealedFixtureScript, fixtureScriptBytes, 0o700, beforeWrite);
  chmodSync(sealedFixtureScript, 0o700);

  const currentScorerDigest = scorerDigest();
  if (currentScorerDigest !== plan.identities.matcher_digest) {
    throw new Error("scorer changed before source sealing");
  }
  const manifest = {
    schema_version: 1,
    namespace: plan.namespace,
    plan_digest: plan.plan_digest,
    matcher_digest: currentScorerDigest,
    handoff_digest: sha256(handoffBytes),
    calibration_digest: sha256(calibrationBytes),
    fixture_script_digest: sha256(fixtureScriptBytes),
    skill_digests: Object.fromEntries(
      [plan.incumbent, ...plan.candidates].map((selected) => [
        selected.id,
        selected.skill_digest,
      ]),
    ),
  };
  manifest.manifest_digest = digestObject(manifest);
  writeJsonOnce(
    artifactFile(artifactRoot, `${prefix}/manifest.json`),
    manifest,
    beforeWrite,
  );
  return {
    manifest,
    handoff_template: handoffBytes.toString("utf8"),
    truth_by_pr: truthByPr,
    finder_reports: finderReports,
    skill_snapshots: skillSnapshots,
    calibration_bytes: calibrationBytes,
    fixture_script: sealedFixtureScript,
  };
}
