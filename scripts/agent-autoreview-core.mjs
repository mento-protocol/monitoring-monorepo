import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const MAX_REVIEW_PROMPT_BYTES = 512_000;
export const MAX_REVIEW_CHUNK_CONTEXT_BYTES = 64_000;
export const MAX_REVIEW_PASSES = 8;
export const MAX_REVIEW_INPUT_BYTES =
  MAX_REVIEW_PROMPT_BYTES * MAX_REVIEW_PASSES;

export function utf8Size(text) {
  return Buffer.byteLength(text, "utf8");
}

export function createReviewInputCollector(
  maxBytes = MAX_REVIEW_INPUT_BYTES,
  label = "review input",
) {
  const parts = [];
  let bytes = 0;
  return {
    add(partLabel, value) {
      const text = String(value);
      const addedBytes = (parts.length > 0 ? 2 : 0) + utf8Size(text);
      if (bytes + addedBytes > maxBytes) {
        const error = new Error(
          `${label} exceeds the ${maxBytes}-byte aggregate limit while adding ${partLabel}`,
        );
        error.code = "AUTOREVIEW_INPUT_TOO_LARGE";
        throw error;
      }
      parts.push(text);
      bytes += addedBytes;
    },
    remainingBytes() {
      return maxBytes - bytes;
    },
    sizeBytes() {
      return bytes;
    },
    toString() {
      return parts.join("\n\n");
    },
  };
}

export function normalizedGitFileMode(fileStat) {
  return fileStat.mode & 0o111 ? "100755" : "100644";
}

export function readBoundedRegularFile(
  filePath,
  label,
  maxBytes = MAX_REVIEW_INPUT_BYTES,
) {
  const descriptor = openSync(filePath, "r");
  try {
    const initialStat = fstatSync(descriptor);
    if (!initialStat.isFile()) {
      throw new Error(`${label} must be a regular file`);
    }
    if (initialStat.size > maxBytes) {
      const error = new Error(
        `${label} is too large to review safely (${initialStat.size} bytes); split the evidence`,
      );
      error.code = "AUTOREVIEW_INPUT_TOO_LARGE";
      throw error;
    }
    const chunks = [];
    let totalBytes = 0;
    while (totalBytes <= maxBytes) {
      const remaining = maxBytes + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > maxBytes) {
      const error = new Error(
        `${label} is too large to review safely (more than ${maxBytes} bytes); split the evidence`,
      );
      error.code = "AUTOREVIEW_INPUT_TOO_LARGE";
      throw error;
    }
    return {
      data: Buffer.concat(chunks, totalBytes),
      fileStat: fstatSync(descriptor),
    };
  } finally {
    closeSync(descriptor);
  }
}

export function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function literalLfLines(text) {
  const parts = text.split("\n");
  const lines = parts.slice(0, -1).map((part) => `${part}\n`);
  if (parts.at(-1)) lines.push(parts.at(-1));
  return lines;
}

function splitUtf8Fragment(text, limit, firstLimit = null) {
  let currentLimit = firstLimit ?? limit;
  if (Math.min(limit, currentLimit) < 4) {
    throw new Error("review chunk byte limit is too small");
  }
  const fragments = [];
  let current = "";
  let currentBytes = 0;
  for (const character of text) {
    const characterBytes = utf8Size(character);
    if (current && currentBytes + characterBytes > currentLimit) {
      fragments.push(current);
      current = "";
      currentBytes = 0;
      currentLimit = limit;
    }
    current += character;
    currentBytes += characterBytes;
  }
  if (current) fragments.push(current);
  return fragments;
}

function reviewBundleUnits(bundle) {
  const sectionBoundaries = new Set([
    "# Git Status\n",
    "# Staged Diff\n",
    "# Unstaged Diff\n",
    "# Untracked Files\n",
    "# Untracked File\n",
    "# Branch Diff\n",
    "# Commit Diff\n",
  ]);
  const units = [];
  let current = "";
  for (const line of literalLfLines(bundle)) {
    const boundary =
      line.startsWith("diff --git ") || sectionBoundaries.has(line);
    if (boundary && current) {
      units.push(current);
      current = "";
    }
    current += line;
  }
  if (current) units.push(current);
  return units;
}

function incrementLine(line) {
  return line === null ? null : line + 1;
}

function updateReviewChunkContext(state, line) {
  if (line.startsWith("diff --git ")) {
    state.context = [line];
    state.nextNewLine = null;
    state.nextOldLine = null;
    state.inHunk = false;
    return;
  }
  if (line === "# Untracked File\n") {
    state.context = [line];
    state.nextNewLine = null;
    state.nextOldLine = null;
    state.inHunk = false;
    return;
  }
  if (state.context[0] === "# Untracked File\n" && line.startsWith("path: ")) {
    state.context.push(line);
    return;
  }
  if (state.context.length === 0) return;
  if (state.context[0] === "# Untracked File\n") {
    const match = line.match(/^source-line (\d+): /);
    if (match) state.nextNewLine = Number.parseInt(match[1], 10) + 1;
    state.nextOldLine = null;
    state.inHunk = false;
    return;
  }
  if (!state.inHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) {
    const headerPrefix = line.slice(0, 4);
    state.context = state.context.filter(
      (entry) => !entry.startsWith(headerPrefix),
    );
    state.context.push(line);
    return;
  }
  if (line.startsWith("@@ ")) {
    state.context = state.context.filter((entry) => !entry.startsWith("@@ "));
    state.context.push(line);
    const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    state.nextNewLine = match ? Number.parseInt(match[2], 10) : null;
    state.nextOldLine = match ? Number.parseInt(match[1], 10) : null;
    state.inHunk = true;
    return;
  }
  if (state.inHunk && line.startsWith(" ")) {
    state.nextNewLine = incrementLine(state.nextNewLine);
    state.nextOldLine = incrementLine(state.nextOldLine);
  } else if (state.inHunk && line.startsWith("+")) {
    state.nextNewLine = incrementLine(state.nextNewLine);
  } else if (state.inHunk && line.startsWith("-")) {
    state.nextOldLine = incrementLine(state.nextOldLine);
  }
}

function compactReviewChunkContext(context) {
  if (context.length === 0 || context[0] === "# Untracked File\n") {
    return [...context];
  }
  const newHeader = context.find((entry) => entry.startsWith("+++ "));
  const oldHeader = context.find((entry) => entry.startsWith("--- "));
  const hunkHeader = context.find((entry) => entry.startsWith("@@ "));
  const pathHeader =
    newHeader && newHeader !== "+++ /dev/null\n" ? newHeader : oldHeader;
  const compact = [pathHeader ?? context[0]];
  if (hunkHeader) compact.push(hunkHeader);
  return compact;
}

function reviewChunkContext(
  state,
  { continuedLine = false, diffLineMarker = null, sourceLine = null } = {},
) {
  const lines = compactReviewChunkContext(state.context);
  const nextNewLine = sourceLine ?? state.nextNewLine;
  if (state.context[0] === "# Untracked File\n" && nextNewLine !== null) {
    lines.push(
      `[Continuation begins at untracked source line ${nextNewLine}.]\n`,
    );
  } else if (
    nextNewLine !== null &&
    state.nextOldLine !== null &&
    nextNewLine !== state.nextOldLine
  ) {
    lines.push(
      `[Continuation position: new-file line ${nextNewLine}; old-file line ${state.nextOldLine}.]\n`,
    );
  } else if (nextNewLine !== null) {
    lines.push(`[Continuation begins at new-file line ${nextNewLine}.]\n`);
  } else if (state.nextOldLine !== null) {
    lines.push(
      `[Continuation begins at old-file line ${state.nextOldLine}; use this positive line for deleted content.]\n`,
    );
  }
  if (continuedLine) {
    lines.push(
      diffLineMarker
        ? `[The change content below continues a unified-diff line whose original marker is \`${diffLineMarker}\`.]\n`
        : "[The change content below continues the preceding long line.]\n",
    );
  }
  const text = lines.join("");
  if (utf8Size(text) > MAX_REVIEW_CHUNK_CONTEXT_BYTES) {
    throw new Error(
      "review continuation context exceeds the bounded prompt allowance; shorten the changed path or split the review target",
    );
  }
  return text;
}

function splitOversizedReviewUnit(unit, limit, firstLimit = null) {
  const chunks = [];
  let current = "";
  let currentBytes = 0;
  let currentContext = "";
  const state = {
    context: [],
    nextNewLine: null,
    nextOldLine: null,
    inHunk: false,
  };
  const currentLimit = () =>
    chunks.length === 0 && firstLimit !== null ? firstLimit : limit;
  const flush = () => {
    if (!current) return;
    chunks.push({ content: current, context: currentContext });
    current = "";
    currentBytes = 0;
    currentContext = "";
  };

  for (const line of literalLfLines(unit)) {
    const lineBytes = utf8Size(line);
    const diffLineMarker = state.inHunk && /^[+ -]/.test(line) ? line[0] : null;
    const sourceMatch =
      state.context[0] === "# Untracked File\n"
        ? line.match(/^source-line (\d+): /)
        : null;
    const sourceLine = sourceMatch ? Number.parseInt(sourceMatch[1], 10) : null;
    let chunkLimit = currentLimit();

    if (current && currentBytes + lineBytes > chunkLimit) {
      if (lineBytes <= limit) {
        flush();
        chunkLimit = currentLimit();
      } else {
        const remainingLineBytes = chunkLimit - currentBytes;
        if (remainingLineBytes < 4) {
          flush();
          chunkLimit = currentLimit();
        } else {
          const fragments = splitUtf8Fragment(line, limit, remainingLineBytes);
          current += fragments[0];
          flush();
          const continuedContext = reviewChunkContext(state, {
            continuedLine: true,
            diffLineMarker,
            sourceLine,
          });
          for (const fragment of fragments.slice(1, -1)) {
            chunks.push({ content: fragment, context: continuedContext });
          }
          if (fragments.length > 1) {
            current = fragments.at(-1);
            currentBytes = utf8Size(current);
            currentContext = continuedContext;
          }
          updateReviewChunkContext(state, line);
          continue;
        }
      }
    }

    if (lineBytes > chunkLimit) {
      flush();
      const fragments = splitUtf8Fragment(line, limit, chunkLimit);
      for (const [index, fragment] of fragments.slice(0, -1).entries()) {
        chunks.push({
          content: fragment,
          context: reviewChunkContext(state, {
            continuedLine: index > 0,
            diffLineMarker,
            sourceLine,
          }),
        });
      }
      current = fragments.at(-1);
      currentBytes = utf8Size(current);
      currentContext = reviewChunkContext(state, {
        continuedLine: fragments.length > 1,
        diffLineMarker,
        sourceLine,
      });
      updateReviewChunkContext(state, line);
      continue;
    }

    if (!current) currentContext = reviewChunkContext(state);
    current += line;
    currentBytes += lineBytes;
    updateReviewChunkContext(state, line);
  }
  flush();
  return chunks;
}

export function splitReviewBundle(bundle, limit) {
  if (utf8Size(bundle) <= limit) return [{ content: bundle, context: "" }];
  const chunks = [];
  let pending = null;
  const flushPending = () => {
    if (pending) chunks.push(pending);
    pending = null;
  };

  for (const unit of reviewBundleUnits(bundle)) {
    const unitBytes = utf8Size(unit);
    const pendingBytes = pending ? utf8Size(pending.content) : 0;
    const remaining = limit - pendingBytes;
    if (pending && unitBytes <= remaining) {
      pending = { ...pending, content: pending.content + unit };
      continue;
    }
    if (pending && remaining >= 256) {
      const firstLine = literalLfLines(unit)[0];
      if (utf8Size(firstLine) > remaining && utf8Size(firstLine) <= limit) {
        flushPending();
        const pieces = splitOversizedReviewUnit(unit, limit);
        chunks.push(...pieces.slice(0, -1));
        pending = pieces.at(-1);
        continue;
      }
      const [first, ...rest] = splitOversizedReviewUnit(unit, limit, remaining);
      pending = {
        ...pending,
        content: pending.content + first.content,
      };
      flushPending();
      if (rest.length > 0) {
        chunks.push(...rest.slice(0, -1));
        pending = rest.at(-1);
      }
      continue;
    }
    flushPending();
    if (unitBytes <= limit) {
      pending = { content: unit, context: "" };
      continue;
    }
    const pieces = splitOversizedReviewUnit(unit, limit);
    chunks.push(...pieces.slice(0, -1));
    pending = pieces.at(-1);
  }
  flushPending();
  if (chunks.map((chunk) => chunk.content).join("") !== bundle) {
    throw new Error(
      "internal error: review bundle chunking omitted or reordered input",
    );
  }
  return chunks;
}

export function buildBoundedReviewPrompts(bundle, renderPrompt) {
  const fullPrompt = renderPrompt({ content: bundle, context: "" }, null);
  if (utf8Size(fullPrompt) <= MAX_REVIEW_PROMPT_BYTES) return [fullPrompt];

  const emptyChunkPrompt = renderPrompt(
    { content: "", context: "" },
    { index: 999_999, total: 999_999 },
  );
  let contentLimit =
    MAX_REVIEW_PROMPT_BYTES -
    utf8Size(emptyChunkPrompt) -
    MAX_REVIEW_CHUNK_CONTEXT_BYTES -
    4_096;
  if (contentLimit < 16_000) {
    throw new Error(
      "review prompt files and datasets leave too little room for change chunks; reduce the extra review context",
    );
  }
  if (utf8Size(bundle) > contentLimit * MAX_REVIEW_PASSES) {
    throw new Error(
      `review bundle requires more than ${MAX_REVIEW_PASSES} bounded passes; reduce or split the change before review`,
    );
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const chunks = splitReviewBundle(bundle, contentLimit);
    if (chunks.length > MAX_REVIEW_PASSES) {
      throw new Error(
        `review bundle requires ${chunks.length} bounded passes; limit ${MAX_REVIEW_PASSES}; reduce or split the change before review`,
      );
    }
    const prompts = chunks.map((chunk, index) =>
      renderPrompt(chunk, { index: index + 1, total: chunks.length }),
    );
    const largest = Math.max(...prompts.map(utf8Size));
    if (largest <= MAX_REVIEW_PROMPT_BYTES) return prompts;
    contentLimit -= largest - MAX_REVIEW_PROMPT_BYTES + 1_024;
    if (contentLimit < 16_000) break;
  }
  throw new Error(
    "unable to partition the review bundle within the aggregate prompt limit",
  );
}

function promptCompanionPath(outputPath, index, total) {
  const parsed = path.parse(outputPath);
  const width = Math.max(2, String(total).length);
  const part = String(index).padStart(width, "0");
  const count = String(total).padStart(width, "0");
  return path.join(
    parsed.dir,
    `${parsed.name}.pass-${part}-of-${count}${parsed.ext || ".md"}`,
  );
}

export function reviewPromptOutputPaths(outputPath, promptCount) {
  if (promptCount === 1) return [outputPath];
  return [
    outputPath,
    ...Array.from({ length: promptCount }, (_, index) =>
      promptCompanionPath(outputPath, index + 1, promptCount),
    ),
  ];
}

export function writeReviewPromptOutputs(outputPath, prompts) {
  const outputs = reviewPromptOutputPaths(outputPath, prompts.length);
  if (prompts.length === 1) {
    writeFileSync(outputs[0], prompts[0]);
    return outputs;
  }
  const companions = outputs.slice(1);
  companions.forEach((companion, index) => {
    writeFileSync(companion, prompts[index]);
  });
  const lines = [
    "# Autoreview Prompt Index",
    "",
    `The complete review target is split across ${prompts.length} bounded passes. One reviewer must inspect every pass before declaring the target clean so cross-pass contracts remain visible.`,
    "",
    ...companions.map(
      (companion, index) =>
        `- Pass ${index + 1}/${prompts.length}: ${path.basename(companion)}`,
    ),
    "",
  ];
  writeFileSync(outputPath, lines.join("\n"));
  return outputs;
}

function exampleOrTemplatePath(normalized) {
  const name = path.posix.basename(normalized).toLowerCase();
  return /(?:^|[._-])(example|sample|template)(?:[._-]|$)/.test(name);
}

export function sensitivePathReason(rawPath) {
  const normalized = rawPath.replaceAll("\\", "/").toLowerCase();
  const rooted = `/${normalized.replace(/^\/+/, "")}`;
  const parts = normalized.split("/").filter(Boolean);
  const name = parts.at(-1) ?? "";
  if (exampleOrTemplatePath(normalized)) return null;
  if (parts.some((part) => [".aws", ".ssh", ".gnupg"].includes(part))) {
    return "credential directory";
  }
  if (
    rooted.includes("/.config/gcloud/") ||
    rooted.endsWith("/.docker/config.json")
  ) {
    return "credential store";
  }
  if (
    name === ".env" ||
    name.startsWith(".env.") ||
    [
      "terraform.tfvars",
      "auth.json",
      "credentials.json",
      "service-account.json",
    ].includes(name)
  ) {
    return "sensitive configuration path";
  }
  if ([".key", ".pem", ".p12", ".pfx"].includes(path.posix.extname(name))) {
    return "private credential file";
  }
  if (
    /(?:^|[._-])(secret|credentials?|service-account)(?:[._-]|$)/.test(name) &&
    /\.(?:json|ya?ml|toml|ini|cfg|conf)$/.test(name)
  ) {
    return "sensitive data filename";
  }
  return null;
}

function placeholderValue(value) {
  return (
    /(?:\$\{|\$[A-Z_]|process\.env|secrets\.|vars\.|var\.)/i.test(value) ||
    /(?:^|[^a-z0-9])(?:redacted|placeholder|example|dummy|test|changeme|replace[-_ ]?me|not[-_ ]?set)(?:[^a-z0-9]|$)/i.test(
      value,
    ) ||
    /^<[^>]+>$/.test(value)
  );
}

export function secretLikeReason(text) {
  if (
    /(?:^|\n)[+ -]?\s*-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(
      text,
    )
  ) {
    return "private key material";
  }
  const strongPatterns = [
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    /\bAIza[0-9A-Za-z_-]{30,}\b/,
    /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/,
    /\bsk-[A-Za-z0-9_-]{24,}\b/,
  ];
  if (strongPatterns.some((pattern) => pattern.test(text))) {
    return "credential-like token";
  }
  if (/\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(text)) {
    return "credentialed URL";
  }
  const awsCredentialPattern =
    /^[+ -]?\s*["'`]?aws[_-]?(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key|session[_-]?token)["'`]?\s*[:=]\s*["'`]?([^"'`\r\n]+?)["'`]?[ \t]*(?:[#;][^\r\n]*)?$/gim;
  for (const match of text.matchAll(awsCredentialPattern)) {
    const value = match[1].trim();
    if (value.length >= 12 && !placeholderValue(value)) {
      return "literal AWS credential assignment";
    }
  }
  const keyPattern =
    /(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|private[_-]?key|secret)\s*["']?\s*[:=]\s*["'`]([^"'`\r\n]{12,})["'`]/gi;
  for (const match of text.matchAll(keyPattern)) {
    if (!placeholderValue(match[1].trim()))
      return "literal credential assignment";
  }
  const registryAuthPattern =
    /^[+ -]?\s*\/\/[^=\r\n]+\/?:_(?:authToken|auth|password)\s*=\s*["'`]?([^"'`\r\n]+?)["'`]?[ \t]*(?:[#;][^\r\n]*)?$/gim;
  for (const match of text.matchAll(registryAuthPattern)) {
    const value = match[1].trim();
    if (value.length >= 12 && !placeholderValue(value))
      return "literal registry credential assignment";
  }
  const unquotedKeyPattern =
    /^[+ -]?\s*(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|private[_-]?key|secret)\s*[:=]\s*([A-Za-z0-9_+./=-]{16,})[ \t]*(?:[#;][^\r\n]*)?$/gim;
  for (const match of text.matchAll(unquotedKeyPattern)) {
    if (!placeholderValue(match[1].trim()))
      return "literal credential assignment";
  }
  return null;
}

export function assertNoSecretLikeContent(label, text) {
  const reason = secretLikeReason(text);
  if (reason) {
    throw new Error(
      `refusing to include secret-like content in review bundle (${reason}); clean or redact ${label} before running autoreview`,
    );
  }
}

function decodeUtf8(data, label) {
  if (data.includes(0)) throw new Error(`refusing binary ${label}`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error(`refusing non-UTF-8 ${label}`);
  }
}

function assertNoSymlinkComponents(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (!isWithin(candidate, root)) {
    throw new Error(`${label} escapes its allowed root`);
  }
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`refusing symlinked ${label}`);
    }
  }
}

export function readSafeEvidenceFile({
  repo,
  rawPath,
  label,
  trustedRoot = null,
  allowTrustedRoot = false,
  maxBytes = MAX_REVIEW_INPUT_BYTES,
}) {
  const repoReal = realpathSync(repo);
  const input = path.normalize(rawPath);
  let root = repoReal;
  let candidate;
  let displayPath;

  if (path.isAbsolute(input)) {
    if (!allowTrustedRoot || !trustedRoot) {
      throw new Error(`${label} must be a repo-relative path: ${rawPath}`);
    }
    if (lstatSync(trustedRoot).isSymbolicLink()) {
      throw new Error("trusted input root must not be a symlink");
    }
    const lexicalRoot = path.resolve(trustedRoot);
    const lexicalCandidate = path.resolve(input);
    if (!isWithin(lexicalCandidate, lexicalRoot)) {
      throw new Error(`${label} escapes its allowed root`);
    }
    root = realpathSync(trustedRoot);
    if (isWithin(root, repoReal)) {
      throw new Error(
        "trusted input root must be outside the reviewed repository",
      );
    }
    candidate = path.resolve(
      root,
      path.relative(lexicalRoot, lexicalCandidate),
    );
    displayPath = `trusted/${path.basename(candidate)}`;
  } else {
    if (!input || input.split(path.sep).includes("..")) {
      throw new Error(`${label} must be a repo-relative path: ${rawPath}`);
    }
    candidate = path.resolve(repoReal, input);
    displayPath = path.relative(repoReal, candidate).split(path.sep).join("/");
  }

  assertNoSymlinkComponents(root, candidate, label);
  const resolved = realpathSync(candidate);
  if (!isWithin(resolved, root))
    throw new Error(`${label} escapes its allowed root`);
  const pathRisk = sensitivePathReason(displayPath);
  if (pathRisk) throw new Error(`refusing sensitive ${label} (${pathRisk})`);
  const { data, fileStat } = readBoundedRegularFile(resolved, label, maxBytes);
  const content = decodeUtf8(data, label);
  assertNoSecretLikeContent(`${label} ${displayPath}`, content);
  return {
    content,
    displayPath,
    resolved,
    mode: normalizedGitFileMode(fileStat),
  };
}

export function serializeSafeUntrackedFile(
  repo,
  relativePath,
  maxBytes = MAX_REVIEW_INPUT_BYTES,
) {
  const { content, displayPath, mode } = readSafeEvidenceFile({
    repo,
    rawPath: relativePath,
    label: "untracked file",
    maxBytes,
  });
  const sourceLines = literalLfLines(content);
  const records = (sourceLines.length > 0 ? sourceLines : [""]).map(
    (line, index) => `source-line ${index + 1}: ${JSON.stringify(line)}\n`,
  );
  return `# Untracked File\npath: ${JSON.stringify(displayPath)}\nmode: ${mode}\n${records.join("")}`;
}
