#!/usr/bin/env node
/**
 * Fail when workflow or composite-action `uses:` references point at mutable
 * third-party refs. Local relative actions (`./...` / `../...`) are allowed;
 * external actions must use a full 40-character commit SHA.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(process.env["GITHUB_ACTION_PINS_ROOT"] ?? process.cwd());
const PINNED_REF = /^[0-9a-fA-F]{40}$/;
const SCAN_DIRS = [".github/workflows", ".github/actions", ".trunk/setup-ci"];

/** @param {string} path */
function isYaml(path) {
  return path.endsWith(".yml") || path.endsWith(".yaml");
}

/** @param {string} dir */
function* walkYaml(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkYaml(path);
    } else if (entry.isFile() && isYaml(path)) {
      yield path;
    }
  }
}

/** @param {string} raw */
function splitInlineComment(raw) {
  let quote = "";
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if ((char === '"' || char === "'") && (i === 0 || raw[i - 1] !== "\\")) {
      quote = quote === char ? "" : quote === "" ? char : quote;
    }
    if (char === "#" && quote === "") {
      return {
        value: raw.slice(0, i).trim(),
        comment: raw.slice(i + 1).trim(),
      };
    }
  }
  return { value: raw.trim(), comment: "" };
}

/** @param {string} raw */
function normalizeUsesValue(raw) {
  const { value } = splitInlineComment(raw);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

/** @param {string} value */
function isLocalAction(value) {
  return value.startsWith("./") || value.startsWith("../");
}

/** @param {string} value */
function isPinnedExternalAction(value) {
  const atIndex = value.lastIndexOf("@");
  if (atIndex === -1) return false;
  const ref = value.slice(atIndex + 1);
  return PINNED_REF.test(ref);
}

/** @param {string} raw */
function hasReleaseTagComment(raw) {
  const { comment } = splitInlineComment(raw);
  return /^v\d+(?:[.\w-].*)?$/.test(comment);
}

/** @param {string} root @param {string} path */
function isInsideRoot(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

/** @param {string} fromFile @param {string} value */
function localActionManifestPaths(fromFile, value) {
  const base = value.startsWith("../")
    ? resolve(dirname(fromFile), value)
    : resolve(ROOT, value);
  if (!isInsideRoot(ROOT, base)) return [];
  return ["action.yml", "action.yaml"]
    .map((name) => join(base, name))
    .filter((path) => existsSync(path));
}

const failures = [];
const files = SCAN_DIRS.flatMap((dir) => [...walkYaml(join(ROOT, dir))]).sort();
const queuedFiles = new Set(files);

for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
  const file = files[fileIndex];
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = line.match(
      /^\s*(?:-\s*)?(?:"uses"|'uses'|uses)\s*:\s*(.+?)\s*$/,
    );
    if (!match) return;
    const rawValue = match[1] ?? "";
    const value = normalizeUsesValue(rawValue);
    if (value === "") return;
    if (isLocalAction(value)) {
      for (const manifest of localActionManifestPaths(file, value)) {
        if (!queuedFiles.has(manifest)) {
          queuedFiles.add(manifest);
          files.push(manifest);
        }
      }
      return;
    }
    if (isPinnedExternalAction(value) && hasReleaseTagComment(rawValue)) {
      return;
    }
    failures.push({
      file: relative(ROOT, file),
      line: index + 1,
      value,
    });
  });
}

if (failures.length > 0) {
  console.error("Unpinned or undocumented GitHub Actions references found:");
  for (const failure of failures) {
    console.error(`- ${failure.file}:${failure.line} uses: ${failure.value}`);
  }
  console.error(
    "Third-party actions must use a full 40-character commit SHA. " +
      "Keep the release tag as an inline comment, e.g. `uses: org/action@<sha> # v1.2.3`.",
  );
  process.exit(1);
}

console.log(
  `All ${files.length} workflow/composite-action YAML files use pinned external actions.`,
);
