import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import {
  assertAuditedCase,
  runAuditedProbe,
} from "./review-eval-v2-probe-trust.mjs";
import path from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;
const validId = (value) => typeof value === "string" && ID.test(value);
const nonempty = (value) =>
  typeof value === "string" && value.trim().length > 0;

export function loadDataset({ file }) {
  const resolved = path.resolve(file);
  const bytes = readFileSync(resolved);
  const dataset = JSON.parse(bytes);
  const errors = validateDataset({ dataset, rootDir: path.dirname(resolved) });
  if (errors.length)
    throw new Error(`Invalid v2 dataset: ${errors.join("; ")}`);
  return { dataset, digest: sha256(bytes), path: resolved };
}

export function resolveRepairPath({ rootDir, repair }) {
  if (!nonempty(repair?.file) || path.isAbsolute(repair.file)) {
    throw new Error("repair must name a relative file");
  }
  const root = realpathSync(rootDir);
  const target = realpathSync(path.resolve(root, repair.file));
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error("repair escapes dataset directory");
  }
  return target;
}

export function validateDataset({ dataset, rootDir }) {
  const errors = [];
  if (dataset?.schema_version !== 2) errors.push("schema_version must be 2");
  if (!nonempty(dataset?.repo)) errors.push("repo is required");
  if (
    dataset?.label_authority !== "agent-audited" ||
    dataset?.labels_complete !== false
  ) {
    errors.push("pilot must disclose agent-audited partial labels");
  }
  if (!nonempty(dataset?.exposure) || !nonempty(dataset?.split_policy)) {
    errors.push("exposure and split policy are required");
  }
  if (!Array.isArray(dataset?.limitations) || !dataset.limitations.length) {
    errors.push("limitations are required");
  }
  const roots = Array.isArray(dataset?.roots) ? dataset.roots : [];
  const cases = Array.isArray(dataset?.cases) ? dataset.cases : [];
  if (!roots.length || !cases.length)
    errors.push("cases and roots are required");
  const rootIds = new Set();
  const sourceIds = new Set();
  for (const root of roots) {
    if (!root || typeof root !== "object") {
      errors.push("invalid root object");
      continue;
    }
    if (!validId(root.id) || rootIds.has(root.id))
      errors.push(`duplicate or invalid root ${root.id}`);
    rootIds.add(root.id);
    for (const key of [
      "family_id",
      "title",
      "trigger",
      "mechanism",
      "consequence",
    ]) {
      if (!nonempty(root[key])) errors.push(`${root.id}: missing ${key}`);
    }
    if (!/^P[0-3]$/.test(root.severity))
      errors.push(`${root.id}: invalid severity`);
    if (root.label_authority !== "agent-audited")
      errors.push(`${root.id}: invalid label authority`);
    if (
      !Array.isArray(root.source_finding_ids) ||
      !root.source_finding_ids.length ||
      root.source_finding_ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
    ) {
      errors.push(`${root.id}: source finding IDs are required`);
    }
    for (const sourceId of Array.isArray(root.source_finding_ids)
      ? root.source_finding_ids
      : []) {
      if (sourceIds.has(sourceId))
        errors.push(`${root.id}: repeated source finding ${sourceId}`);
      sourceIds.add(sourceId);
    }
    if (
      !Array.isArray(root.locations) ||
      !root.locations.length ||
      root.locations.some(
        (location) =>
          !location ||
          !nonempty(location.path) ||
          !Number.isInteger(location.line_start) ||
          location.line_start < 1 ||
          !Number.isInteger(location.line_end) ||
          location.line_end < location.line_start,
      )
    )
      errors.push(`${root.id}: invalid source locations`);
  }
  const caseIds = new Set();
  const families = new Map();
  const prSplits = new Map();
  for (const item of cases) {
    if (!item || typeof item !== "object") {
      errors.push("invalid case object");
      continue;
    }
    if (!validId(item.id) || caseIds.has(item.id))
      errors.push(`duplicate or invalid case ${item.id}`);
    caseIds.add(item.id);
    try {
      assertAuditedCase({ repo: dataset.repo, item });
    } catch (error) {
      errors.push(error.message);
    }
    if (!Number.isSafeInteger(item.pr) || item.pr < 1)
      errors.push(`${item.id}: invalid PR`);
    if (
      !SHA.test(item.first_head) ||
      !SHA.test(item.base_sha) ||
      item.first_head === item.base_sha
    ) {
      errors.push(`${item.id}: invalid pinned commits`);
    }
    if (
      !Array.isArray(item.forbidden_shas) ||
      item.forbidden_shas.some(
        (sha) =>
          !SHA.test(sha) || sha === item.first_head || sha === item.base_sha,
      )
    )
      errors.push(`${item.id}: invalid forbidden commits`);
    if (!["development", "confirmation"].includes(item.split))
      errors.push(`${item.id}: invalid split`);
    if (prSplits.has(item.pr) && prSplits.get(item.pr) !== item.split)
      errors.push(`${item.id}: PR crosses splits`);
    prSplits.set(item.pr, item.split);
    if (!validId(item.family_id)) errors.push(`${item.id}: invalid family`);
    const family = families.get(item.family_id) ?? [];
    family.push(item);
    families.set(item.family_id, family);
    for (const field of ["expected_root_ids", "negative_control_root_ids"]) {
      const ids = item[field];
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length) {
        errors.push(`${item.id}: invalid ${field}`);
        continue;
      }
      for (const id of ids) {
        if (
          !roots.some(
            (root) => root?.id === id && root.family_id === item.family_id,
          )
        ) {
          errors.push(`${item.id}: unknown or foreign root ${id}`);
        }
      }
    }
    if (item.variant === "original") {
      if (
        item.repair !== null ||
        !item.expected_root_ids?.length ||
        item.negative_control_root_ids?.length
      ) {
        errors.push(
          `${item.id}: original must have positive roots and no repair`,
        );
      }
    } else if (item.variant === "repaired") {
      if (
        item.expected_root_ids?.length ||
        !item.negative_control_root_ids?.length ||
        !DIGEST.test(item.repair?.sha256)
      ) {
        errors.push(
          `${item.id}: repaired must have negative roots and a pinned patch`,
        );
      }
      try {
        const repairPath = resolveRepairPath({ rootDir, repair: item.repair });
        if (sha256(readFileSync(repairPath)) !== item.repair.sha256)
          errors.push(`${item.id}: repair digest mismatch`);
      } catch (error) {
        errors.push(`${item.id}: ${error.message}`);
      }
    } else errors.push(`${item.id}: invalid variant`);
  }
  for (const [id, family] of families) {
    const original = family.find((item) => item.variant === "original");
    const repaired = family.find((item) => item.variant === "repaired");
    if (family.length !== 2 || !original || !repaired) {
      errors.push(`${id}: requires one original and one repaired case`);
      continue;
    }
    for (const field of ["split", "pr", "first_head", "base_sha"]) {
      if (original[field] !== repaired[field])
        errors.push(`${id}: inconsistent ${field}`);
    }
    if (
      JSON.stringify(
        [
          ...(Array.isArray(original.expected_root_ids)
            ? original.expected_root_ids
            : []),
        ].sort(),
      ) !==
      JSON.stringify(
        [
          ...(Array.isArray(repaired.negative_control_root_ids)
            ? repaired.negative_control_root_ids
            : []),
        ].sort(),
      )
    )
      errors.push(`${id}: repair roots differ`);
  }
  for (const root of roots.filter((item) => item && typeof item === "object")) {
    if (
      !cases.some(
        (item) =>
          Array.isArray(item?.expected_root_ids) &&
          item.expected_root_ids.includes(root.id),
      )
    )
      errors.push(`${root.id}: orphan root`);
  }
  return errors;
}

// Probes execute a pinned, audited module closure in a fresh private snapshot.
// The trusted helper rejects other source/repair choices before importing code.
const PROBE = `
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [fixture, pr] = process.argv.slice(1);
const load = (file) => import(pathToFileURL(path.join(fixture, file)).href);
if (pr === '1984') {
  const {renderRefusedStubInventory} = await load('scripts/sentry/autofix/sentry-autofix-run-record.mjs');
  const actual = renderRefusedStubInventory({state:'known',count:1,issues:[123]}, null);
  const broken = actual.includes('https://github.com/null/issues/123');
  const fixed = actual.includes('https://github.com/mento-protocol/monitoring-monorepo/issues/123');
  if (!broken && !fixed) throw new Error('Unexpected inventory result');
  console.log(JSON.stringify({'inventory-null-repo':broken}));
} else if (pr === '1982') {
  const {parseClaimComment} = await load('scripts/pr/issue-board-backfill.mjs');
  const comment = {id:'probe',createdAt:'2026-08-20T00:00:00Z',authorAssociation:'MEMBER',
    body:'Agent claim: codex claimed #123 for implementation.\\n\\nClaim ID: claim-123\\nBranch: fix/test\\nClaimed at: 2026-08-20T00:00:00Z\\n\\nHand off project fields through the MCP surface.'};
  if (!parseClaimComment(comment,123)) throw new Error('Valid control claim failed');
  const trailing = parseClaimComment({...comment,body:comment.body+'\\n'},123);
  const branchless = parseClaimComment({...comment,body:comment.body.replace('Branch: fix/test\\n','')},123);
  if (branchless && (branchless.metadata.Agent !== 'codex' || 'Branch' in branchless.metadata)) throw new Error('Incorrect branchless metadata');
  console.log(JSON.stringify({'claim-trailing-newline':trailing===null,'claim-optional-branch':branchless===null}));
} else throw new Error('No audited probes for this PR');
`;

export function verifyCaseProbes({ fixturePath, caseId, dataset }) {
  const item = dataset.cases.find((entry) => entry.id === caseId);
  if (!item) throw new Error(`Unknown case ${caseId}`);
  const result = runAuditedProbe({
    repo: dataset.repo,
    item,
    fixturePath,
    script: PROBE,
  });
  if (result.status !== 0)
    throw new Error(
      `Probe failed for ${caseId}: ${result.error?.message ?? result.stderr}`,
    );
  const observed = JSON.parse(result.stdout);
  for (const id of item.expected_root_ids) {
    if (observed[id] !== true)
      throw new Error(`${caseId}: expected defect ${id} was not reproduced`);
  }
  for (const id of item.negative_control_root_ids) {
    if (observed[id] !== false)
      throw new Error(`${caseId}: repair did not remove ${id}`);
  }
  return { case_id: caseId, status: "passed", defects_present: observed };
}
