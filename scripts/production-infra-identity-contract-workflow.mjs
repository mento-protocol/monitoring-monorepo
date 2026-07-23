import {
  APPLY_WORKFLOWS,
  PRODUCTION_PROVIDER_VARIABLE,
  PRODUCTION_SERVICE_ACCOUNT_VARIABLE,
  REFRESH_SERVICE_ACCOUNT_VARIABLE,
  SERVICE_AND_DRIFT_WORKFLOWS,
} from "./production-infra-identity-contract-constants.mjs";
import {
  escapeRegExp,
  requireFile,
} from "./production-infra-identity-contract-hcl.mjs";

function stripYamlComments(contents) {
  return contents
    .split(/(?<=\n)/u)
    .map((line) => {
      let singleQuoted = false;
      let doubleQuoted = false;
      let escaped = false;
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (doubleQuoted) {
          if (escaped) {
            escaped = false;
          } else if (character === "\\") {
            escaped = true;
          } else if (character === '"') {
            doubleQuoted = false;
          }
          continue;
        }
        if (singleQuoted) {
          if (character === "'") singleQuoted = false;
          continue;
        }
        if (character === '"') {
          doubleQuoted = true;
        } else if (character === "'") {
          singleQuoted = true;
        } else if (
          character === "#" &&
          (index === 0 || /\s/u.test(line[index - 1]))
        ) {
          return `${line.slice(0, index)}${line
            .slice(index)
            .replace(/[^\r\n]/gu, " ")}`;
        }
      }
      return line;
    })
    .join("");
}

function extractTopLevelJob(contents, jobName) {
  const startPattern = new RegExp(`^  ${escapeRegExp(jobName)}:\\s*$`, "mu");
  const match = startPattern.exec(contents);
  if (!match) return undefined;
  const remainder = contents.slice(match.index + match[0].length);
  const nextJob = /^ {2}[A-Za-z0-9_-]+:\s*$/mu.exec(remainder);
  const end = nextJob
    ? match.index + match[0].length + nextJob.index
    : contents.length;
  return {
    start: match.index,
    end,
    text: contents.slice(match.index, end),
  };
}

function extractJobSteps(jobText) {
  const stepsHeader = /^ {4}steps:\s*$/mu.exec(jobText);
  if (!stepsHeader) return [];
  const bodyStart = stepsHeader.index + stepsHeader[0].length;
  const remainder = jobText.slice(bodyStart);
  const nextJobProperty = /^ {4}[A-Za-z0-9_-]+:\s*(?:.*)$/mu.exec(remainder);
  const bodyEnd = nextJobProperty
    ? bodyStart + nextJobProperty.index
    : jobText.length;
  const body = jobText.slice(bodyStart, bodyEnd);
  const starts = [...body.matchAll(/^ {6}-(?:\s|$)/gmu)].map(
    (match) => bodyStart + match.index,
  );
  return starts.map((start, index) => ({
    start,
    end: starts[index + 1] ?? bodyEnd,
    text: jobText.slice(start, starts[index + 1] ?? bodyEnd),
  }));
}

function contextVariableOccurrences(contents, contextName, variableName) {
  const pattern = new RegExp(
    `\\b${escapeRegExp(contextName)}\\s*(?:\\.\\s*${escapeRegExp(variableName)}\\b|\\[\\s*["']${escapeRegExp(variableName)}["']\\s*\\])`,
    "gu",
  );
  return [...contents.matchAll(pattern)].map((match) => match.index);
}

function variableOccurrences(contents, variableName) {
  return contextVariableOccurrences(contents, "vars", variableName);
}

export function validateWorkflowContract(files, errors) {
  for (const workflowPath of [
    ...APPLY_WORKFLOWS,
    ...SERVICE_AND_DRIFT_WORKFLOWS,
  ]) {
    requireFile(files, workflowPath, errors);
  }

  const workflowPaths = Object.keys(files)
    .filter((filePath) => /^\.github\/workflows\/.+\.ya?ml$/u.test(filePath))
    .sort();

  for (const workflowPath of workflowPaths) {
    const code = stripYamlComments(files[workflowPath]);
    if (
      variableOccurrences(code, REFRESH_SERVICE_ACCOUNT_VARIABLE).length > 0
    ) {
      errors.push(
        `${workflowPath}: vars.${REFRESH_SERVICE_ACCOUNT_VARIABLE} must not be used during bootstrap`,
      );
    }

    const providerUses = variableOccurrences(
      code,
      PRODUCTION_PROVIDER_VARIABLE,
    );
    const serviceAccountUses = variableOccurrences(
      code,
      PRODUCTION_SERVICE_ACCOUNT_VARIABLE,
    );

    if (!APPLY_WORKFLOWS.includes(workflowPath)) {
      if (providerUses.length > 0 || serviceAccountUses.length > 0) {
        errors.push(
          `${workflowPath}: production identity variables are allowed only in a protected apply auth step`,
        );
      }
      continue;
    }

    const applyJob = extractTopLevelJob(code, "apply");
    if (!applyJob) {
      errors.push(`${workflowPath}: apply job is missing`);
      continue;
    }
    const scalarEnvironment = /^ {4}environment:\s*production-infra\s*$/mu.test(
      applyJob.text,
    );
    const mappedEnvironment =
      /^ {4}environment:\s*$\n^ {6}name:\s*production-infra\s*$/mu.test(
        applyJob.text,
      );
    if (!scalarEnvironment && !mappedEnvironment) {
      errors.push(
        `${workflowPath}: apply job must use exactly the production-infra environment`,
      );
    }

    const steps = extractJobSteps(applyJob.text);
    const authUses = [
      ...applyJob.text.matchAll(
        /^\s*(?:-\s*)?uses:\s*google-github-actions\/auth@[^\s]+\s*$/gmu,
      ),
    ];
    const authSteps = steps.filter((step) =>
      /^\s*(?:-\s*)?uses:\s*google-github-actions\/auth@[^\s]+\s*$/mu.test(
        step.text,
      ),
    );
    if (authUses.length !== 1 || authSteps.length !== 1) {
      errors.push(
        `${workflowPath}: apply job must contain exactly one Google auth action`,
      );
      continue;
    }

    const authStep = authSteps[0];
    const exactProvider = new RegExp(
      `^\\s*workload_identity_provider:\\s*\\$\\{\\{\\s*vars\\.${escapeRegExp(PRODUCTION_PROVIDER_VARIABLE)}\\s*\\}\\}\\s*$`,
      "mu",
    ).test(authStep.text);
    const exactServiceAccount = new RegExp(
      `^\\s*service_account:\\s*\\$\\{\\{\\s*vars\\.${escapeRegExp(PRODUCTION_SERVICE_ACCOUNT_VARIABLE)}\\s*\\}\\}\\s*$`,
      "mu",
    ).test(authStep.text);
    if (!exactProvider || !exactServiceAccount) {
      errors.push(
        `${workflowPath}: apply auth must use only the production provider and service account variables`,
      );
    }
    if (
      [
        "GCP_WORKLOAD_IDENTITY_PROVIDER",
        "GCP_SERVICE_ACCOUNT",
        "GCP_SERVICE_ACCOUNT_PLAN",
      ].some(
        (name) =>
          contextVariableOccurrences(authStep.text, "secrets", name).length > 0,
      )
    ) {
      errors.push(
        `${workflowPath}: apply auth must not fall back to a generic or plan identity`,
      );
    }

    const authStart = applyJob.start + authStep.start;
    const authEnd = applyJob.start + authStep.end;
    const outsideAuth = (index) => index < authStart || index >= authEnd;
    if (
      providerUses.length !== 1 ||
      serviceAccountUses.length !== 1 ||
      providerUses.some(outsideAuth) ||
      serviceAccountUses.some(outsideAuth)
    ) {
      errors.push(
        `${workflowPath}: production identity variables must appear exactly once and only in the apply auth step`,
      );
    }

    const protectionChecks = [
      ...applyJob.text.matchAll(/verify-github-environment-protection\.mjs/gu),
    ];
    const protectionIndex = protectionChecks[0]?.index ?? -1;
    if (
      protectionChecks.length !== 1 ||
      protectionIndex === -1 ||
      protectionIndex > authStep.start
    ) {
      errors.push(
        `${workflowPath}: apply job must verify environment protection exactly once before Google authentication`,
      );
    }
  }
}
