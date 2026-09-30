// This registry authorizes execution, not merely reproducibility. Adding a case
// requires auditing its module initialization, full local import closure, and repair.
import { createHash } from "node:crypto";
import {
  readFileSync,
  realpathSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const AUDITED_CASES = {
  "pr-1984-original": {
    id: "pr-1984-original",
    family_id: "pr-1984",
    pr: 1984,
    base_sha: "efcfb16d9b0b9c65fe50e7dac185295c8bb1c10a",
    first_head: "07901b22c0da7db2b27f15dbbc3f5e8ea45623df",
    variant: "original",
    forbidden_shas: ["e0f88c07b012bf180ea93b26ae490d4eaf8a68ef"],
    repo: "mento-protocol/monitoring-monorepo",
    repair_sha256: null,
    modules: {
      "scripts/sentry/autofix/sentry-autofix-run-record.mjs":
        "ce84784ed26821c2f4175087e96dac2039316ae539f0e2f04828de1ea548b47b",
      "scripts/sentry/autofix/sentry-autofix-refused-inventory.mjs":
        "d34ef1bf4cb33363554fd6b06bb2b44aeeef545cf01d40a160ee7ff98da245ed",
    },
  },
  "pr-1984-repaired": {
    id: "pr-1984-repaired",
    family_id: "pr-1984",
    pr: 1984,
    base_sha: "efcfb16d9b0b9c65fe50e7dac185295c8bb1c10a",
    first_head: "07901b22c0da7db2b27f15dbbc3f5e8ea45623df",
    variant: "repaired",
    forbidden_shas: ["e0f88c07b012bf180ea93b26ae490d4eaf8a68ef"],
    repo: "mento-protocol/monitoring-monorepo",
    repair_sha256:
      "954483bca2be6e96e93b3c9afe53a0c962e5cafe37f93f696109efe92494ed4e",
    modules: {
      "scripts/sentry/autofix/sentry-autofix-run-record.mjs":
        "2e7b36689a7712f4924262e15c40fe555f9926ce21a2d0d021235deeedcbbada",
      "scripts/sentry/autofix/sentry-autofix-refused-inventory.mjs":
        "d34ef1bf4cb33363554fd6b06bb2b44aeeef545cf01d40a160ee7ff98da245ed",
    },
  },
  "pr-1982-original": {
    id: "pr-1982-original",
    family_id: "pr-1982",
    pr: 1982,
    base_sha: "efcfb16d9b0b9c65fe50e7dac185295c8bb1c10a",
    first_head: "ee739b4142564a3a4e9273da6ba345f3cda5e8d3",
    variant: "original",
    forbidden_shas: ["25c4ed882df59c45b5fe16539fff31a79a80a073"],
    repo: "mento-protocol/monitoring-monorepo",
    repair_sha256: null,
    modules: {
      "scripts/pr/issue-board-backfill.mjs":
        "a4e75227e4bf5b15cecad4096cb9ed42bce1f2a2c9b70ddc0bc8e51081f72349",
      "scripts/pr/issue-board-state.mjs":
        "d9b4445ab42a119fbf5963aeea7accb516461bd99ae3edfb3670e63b0d1bfaaf",
    },
  },
  "pr-1982-repaired": {
    id: "pr-1982-repaired",
    family_id: "pr-1982",
    pr: 1982,
    base_sha: "efcfb16d9b0b9c65fe50e7dac185295c8bb1c10a",
    first_head: "ee739b4142564a3a4e9273da6ba345f3cda5e8d3",
    variant: "repaired",
    forbidden_shas: ["25c4ed882df59c45b5fe16539fff31a79a80a073"],
    repo: "mento-protocol/monitoring-monorepo",
    repair_sha256:
      "6740fc7372efc71cc42a5386b6405594b95b96e2222378600375f630e9bbbfda",
    modules: {
      "scripts/pr/issue-board-backfill.mjs":
        "c84c90c384d5920b713de54e0fb1650d0df5c231f6d09474850df23969445596",
      "scripts/pr/issue-board-state.mjs":
        "d9b4445ab42a119fbf5963aeea7accb516461bd99ae3edfb3670e63b0d1bfaaf",
    },
  },
};

export function assertAuditedCase({ repo, item }) {
  const trusted = AUDITED_CASES[item?.id];
  if (!trusted || repo !== trusted.repo)
    throw new Error("probe source is outside the audited pilot registry");
  for (const field of [
    "family_id",
    "pr",
    "base_sha",
    "first_head",
    "variant",
  ]) {
    if (item[field] !== trusted[field])
      throw new Error(`unaudited probe ${field} for ${item.id}`);
  }
  if (
    JSON.stringify(item.forbidden_shas) !==
    JSON.stringify(trusted.forbidden_shas)
  ) {
    throw new Error(`unaudited forbidden commits for ${item.id}`);
  }
  if ((item.repair?.sha256 ?? null) !== trusted.repair_sha256) {
    throw new Error(`unaudited probe repair for ${item.id}`);
  }
}

/** Execute only verified immutable copies, never modules selected by dataset data. */
export function runAuditedProbe({ repo, item, fixturePath, script }) {
  assertAuditedCase({ repo, item });
  const trusted = AUDITED_CASES[item.id];
  const sourceRoot = realpathSync(fixturePath);
  const modules = Object.entries(trusted.modules).map(([file, digest]) => {
    const source = path.join(sourceRoot, file);
    const resolved = realpathSync(source);
    if (
      !resolved.startsWith(`${sourceRoot}${path.sep}`) ||
      !lstatSync(source).isFile()
    ) {
      throw new Error(
        `probe module must be an in-fixture regular file: ${file}`,
      );
    }
    const bytes = readFileSync(source);
    if (sha256(bytes) !== digest)
      throw new Error(`unaudited probe module bytes: ${file}`);
    return { file, bytes };
  });
  // Import the exact buffers just verified. The source cannot change between
  // verification and import, and fixture package metadata is not copied.
  const snapshot = mkdtempSync(path.join(tmpdir(), "review-v2-audited-probe-"));
  try {
    for (const { file, bytes } of modules) {
      const target = path.join(snapshot, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes, { mode: 0o400, flag: "wx" });
    }
    return spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script, snapshot, String(item.pr)],
      {
        cwd: snapshot,
        // Do not inherit credentials, NODE_OPTIONS, preload hooks, or loader config.
        env: {},
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
    );
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}
