import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

export const WORKSPACES = [
  "alerts/infra/oncall-announcer",
  "alerts/infra/onchain-event-handler",
  "governance-watchdog",
  "indexer-envio",
  "integration-probes",
  "metrics-bridge",
  "shared-config",
  "ui-dashboard",
];

export const SETUP_FILES = WORKSPACES.map(
  (workspace) => `${workspace}/vitest.hermetic-setup.ts`,
);

const hashFile = (root, relativePath) => {
  const absolutePath = path.join(root, relativePath);
  if (!existsSync(absolutePath)) {
    return { relativePath, hash: "__missing__" };
  }
  const hash = createHash("sha256")
    .update(readFileSync(absolutePath))
    .digest("hex");
  return { relativePath, hash };
};

export const guardConfigReference = "./vitest.hermetic-setup.ts";

export function stripTypeScriptComments(contents) {
  let output = "";
  let index = 0;
  let mode = "code";

  while (index < contents.length) {
    const char = contents[index];
    const next = contents[index + 1];

    if (mode === "lineComment") {
      if (char === "\n") {
        output += char;
        mode = "code";
      }
      index++;
      continue;
    }

    if (mode === "blockComment") {
      if (char === "*" && next === "/") {
        index += 2;
        mode = "code";
      } else {
        if (char === "\n") output += char;
        index++;
      }
      continue;
    }

    if (
      mode === "singleQuote" ||
      mode === "doubleQuote" ||
      mode === "template"
    ) {
      output += char;
      const quote =
        mode === "singleQuote" ? "'" : mode === "doubleQuote" ? '"' : "`";
      if (char === "\\") {
        if (index + 1 < contents.length) {
          output += contents[index + 1];
          index += 2;
          continue;
        }
      } else if (char === quote) {
        mode = "code";
      }
      index++;
      continue;
    }

    if (char === "/" && next === "/") {
      mode = "lineComment";
      index += 2;
      continue;
    }

    if (char === "/" && next === "*") {
      mode = "blockComment";
      index += 2;
      continue;
    }

    if (char === "'") {
      mode = "singleQuote";
    } else if (char === '"') {
      mode = "doubleQuote";
    } else if (char === "`") {
      mode = "template";
    }

    output += char;
    index++;
  }

  return output;
}

function skipWhitespace(source, index) {
  while (index < source.length && /\s/.test(source[index])) index++;
  return index;
}

function readStringLiteral(source, start) {
  const quote = source[start];
  if (quote !== "'" && quote !== '"' && quote !== "`") return null;

  let value = "";
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      if (index + 1 >= source.length) return null;
      value += source[index + 1];
      index += 2;
      continue;
    }
    if (char === quote) {
      return { value, end: index + 1 };
    }
    value += char;
    index++;
  }
  return null;
}

function readArrayLiteral(source, start) {
  if (source[start] !== "[") return null;

  let depth = 0;
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === "'" || char === '"' || char === "`") {
      const literal = readStringLiteral(source, index);
      if (!literal) return null;
      index = literal.end;
      continue;
    }

    if (char === "[") {
      depth++;
    } else if (char === "]") {
      depth--;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
    index++;
  }

  return null;
}

function stringLiterals(source) {
  const literals = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "'" || char === '"' || char === "`") {
      const literal = readStringLiteral(source, index);
      if (literal) {
        literals.push(literal.value);
        index = literal.end;
        continue;
      }
    }
    index++;
  }
  return literals;
}

function isIdentifierChar(char) {
  return typeof char === "string" && /[A-Za-z0-9_$]/.test(char);
}

function setupFilesValueStarts(source) {
  const starts = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    if (char === "'" || char === '"' || char === "`") {
      const literal = readStringLiteral(source, index);
      if (!literal) break;
      if (literal.value === "setupFiles") {
        const colonIndex = skipWhitespace(source, literal.end);
        if (source[colonIndex] === ":") {
          starts.push(skipWhitespace(source, colonIndex + 1));
        }
      }
      index = literal.end;
      continue;
    }

    if (
      source.startsWith("setupFiles", index) &&
      !isIdentifierChar(source[index - 1]) &&
      !isIdentifierChar(source[index + "setupFiles".length])
    ) {
      const colonIndex = skipWhitespace(source, index + "setupFiles".length);
      if (source[colonIndex] === ":") {
        starts.push(skipWhitespace(source, colonIndex + 1));
      }
      index += "setupFiles".length;
      continue;
    }

    index++;
  }

  return starts;
}

export function setupFilesLoadsGuard(contents) {
  const source = stripTypeScriptComments(contents);

  for (const valueStart of setupFilesValueStarts(source)) {
    const firstChar = source[valueStart];

    if (firstChar === "'" || firstChar === '"' || firstChar === "`") {
      const literal = readStringLiteral(source, valueStart);
      if (literal?.value === guardConfigReference) return true;
      continue;
    }

    if (firstChar === "[") {
      const arrayLiteral = readArrayLiteral(source, valueStart);
      if (
        arrayLiteral &&
        stringLiterals(arrayLiteral).includes(guardConfigReference)
      ) {
        return true;
      }
    }
  }

  return false;
}

export const configLoadsGuard = (root, workspace) => {
  const relativePath = `${workspace}/vitest.config.ts`;
  const absolutePath = path.join(root, relativePath);
  if (!existsSync(absolutePath)) {
    return { relativePath, ok: false, reason: "missing config" };
  }
  const contents = readFileSync(absolutePath, "utf8");
  if (!setupFilesLoadsGuard(contents)) {
    return { relativePath, ok: false, reason: "missing setupFiles guard" };
  }
  return { relativePath, ok: true };
};

export function validateHermeticVitestSetup(root = repoRoot) {
  const results = SETUP_FILES.map((relativePath) =>
    hashFile(root, relativePath),
  );
  const uniqueHashes = new Set(results.map((result) => result.hash));
  const configResults = WORKSPACES.map((workspace) =>
    configLoadsGuard(root, workspace),
  );

  return {
    results,
    uniqueHashes,
    missingConfigReferences: configResults.filter((result) => !result.ok),
  };
}

function main() {
  const { results, uniqueHashes, missingConfigReferences } =
    validateHermeticVitestSetup();

  if (uniqueHashes.size !== 1 || uniqueHashes.has("__missing__")) {
    console.error(
      "ERROR: vitest.hermetic-setup.ts files have diverged across workspaces:",
    );
    for (const result of results) {
      console.error(`${result.hash}  ${result.relativePath}`);
    }
    process.exit(1);
  }

  if (missingConfigReferences.length > 0) {
    console.error(
      "ERROR: vitest configs must load ./vitest.hermetic-setup.ts via setupFiles:",
    );
    for (const result of missingConfigReferences) {
      console.error(`${result.reason}: ${result.relativePath}`);
    }
    process.exit(1);
  }

  console.log(
    `OK: ${SETUP_FILES.length} vitest.hermetic-setup.ts files are byte-identical (${results[0].hash}) and wired from vitest.config.ts`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
