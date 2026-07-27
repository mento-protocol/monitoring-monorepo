import { load as loadYaml } from "js-yaml";
import { isMapping } from "./production-infra-identity-contract/workflow-inventory.mjs";
import {
  gcloudCommandKind,
  isShellScript,
  opaqueShellErrors,
  shellCommandRecords,
} from "./deploy-staging-shell-discovery.mjs";

function visitYaml(value, path, callback) {
  callback(value, path);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      visitYaml(entry, `${path}[${index}]`, callback),
    );
    return;
  }
  if (!isMapping(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    visitYaml(entry, path ? `${path}.${key}` : key, callback);
  }
}

export function parseDeployStagingStructuredFile(filePath, contents, errors) {
  try {
    return filePath.endsWith(".json")
      ? JSON.parse(contents)
      : loadYaml(contents);
  } catch (error) {
    errors.push(
      `${filePath}: cannot parse executable source for deploy-staging discovery: ${error.message}`,
    );
    return undefined;
  }
}

export function discoverDeployStagingCallsites(files, errors = []) {
  const records = [];
  for (const [filePath, contents] of Object.entries(files)) {
    if (filePath.endsWith("package.json")) {
      const packageJson = parseDeployStagingStructuredFile(
        filePath,
        contents,
        errors,
      );
      if (!isMapping(packageJson?.scripts)) continue;
      for (const [name, command] of Object.entries(packageJson.scripts)) {
        if (typeof command !== "string") continue;
        const surface = `scripts.${name}`;
        opaqueShellErrors(filePath, surface, command, errors);
        records.push(...shellCommandRecords(filePath, surface, command));
      }
      continue;
    }

    if (
      filePath.endsWith(".yml") ||
      filePath.endsWith(".yaml") ||
      filePath.endsWith(".json")
    ) {
      if (filePath.endsWith(".json") && !contents.includes("gcloud")) continue;
      const document = parseDeployStagingStructuredFile(
        filePath,
        contents,
        errors,
      );
      visitYaml(document, "", (value, path) => {
        if (typeof value === "string") {
          opaqueShellErrors(filePath, path, value, errors);
          records.push(...shellCommandRecords(filePath, path, value));
        }
        if (
          !isMapping(value) ||
          !/^gcr\.io\/cloud-builders\/gcloud(?::|@|$)/u.test(value.name) ||
          !Array.isArray(value.args)
        ) {
          return;
        }
        const args = value.args.map(String);
        const kind = gcloudCommandKind(["gcloud", ...args], 0);
        if (kind)
          records.push({ filePath, surface: `${path}.args`, kind, args });
      });
      continue;
    }

    if (isShellScript(filePath, contents)) {
      opaqueShellErrors(filePath, "shell", contents, errors);
      records.push(...shellCommandRecords(filePath, "shell", contents));
    }
  }
  return records;
}
