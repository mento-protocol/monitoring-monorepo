// Generic GitHub Actions workflow-YAML and shell-run helpers. No identity, IAM,
// or deployment policy lives here: these are parsing primitives shared by the
// production-infra identity contract and the ADR 0053 deploy-staging contract.
import { isDeepStrictEqual } from "node:util";

export function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeWorkflowScalar(value) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

export function workflowJobSteps(job) {
  return Array.isArray(job?.steps) ? job.steps.filter(isMapping) : [];
}

export function stripShellComment(line) {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\" && !singleQuoted) {
      escaped = true;
    } else if (character === "'" && !doubleQuoted) {
      singleQuoted = !singleQuoted;
    } else if (character === '"' && !singleQuoted) {
      doubleQuoted = !doubleQuoted;
    } else if (
      character === "#" &&
      !singleQuoted &&
      !doubleQuoted &&
      (index === 0 || /[\s;&|()]/u.test(line[index - 1]))
    ) {
      return line.slice(0, index);
    }
  }
  return line;
}

export function terraformPlanCommands(run) {
  if (typeof run !== "string") return [];
  const commands = [];
  let pending = "";
  for (const rawLine of run.split(/\r?\n/u)) {
    const line = stripShellComment(rawLine).trim();
    if (!line || line.startsWith("#")) continue;
    pending = `${pending}${pending ? " " : ""}${line}`;
    if (pending.endsWith("\\")) {
      pending = pending.slice(0, -1).trimEnd();
      continue;
    }
    const command = normalizeWorkflowScalar(pending);
    if (command.startsWith("terraform plan ")) commands.push(command);
    pending = "";
  }
  return commands;
}

export function terraformPlanFlagsMatch(command, expectedTargets, pr) {
  const flags = normalizeWorkflowScalar(command).split(" ");
  const targets = [...command.matchAll(/(?:^|\s)-target=([^\s]+)/gu)]
    .map((match) => match[1])
    .sort();
  return (
    flags.includes("-lock=false") &&
    !command.includes("-lock-timeout") &&
    flags.includes("-refresh=false") === pr &&
    isDeepStrictEqual(targets, [...expectedTargets].sort())
  );
}
