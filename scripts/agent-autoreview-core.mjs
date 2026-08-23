import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
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

export function assertStableFileRead(initialStat, finalStat, label) {
  if (
    !sameFileIdentity(initialStat, finalStat) ||
    initialStat.mode !== finalStat.mode ||
    initialStat.nlink !== finalStat.nlink ||
    initialStat.size !== finalStat.size ||
    initialStat.mtimeMs !== finalStat.mtimeMs ||
    initialStat.ctimeMs !== finalStat.ctimeMs
  ) {
    throw new Error(`${label} changed while it was being read`);
  }
}

export function readBoundedRegularFile(
  filePath,
  label,
  maxBytes = MAX_REVIEW_INPUT_BYTES,
) {
  const pathStat = lstatSync(filePath);
  if (!pathStat.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  if (pathStat.nlink !== 1) {
    throw new Error(`refusing hard-linked ${label}`);
  }
  const descriptor = openSync(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
  );
  try {
    const initialStat = fstatSync(descriptor);
    if (!initialStat.isFile()) {
      throw new Error(`${label} must be a regular file`);
    }
    if (initialStat.nlink !== 1) {
      throw new Error(`refusing hard-linked ${label}`);
    }
    if (initialStat.dev !== pathStat.dev || initialStat.ino !== pathStat.ino) {
      throw new Error(`${label} changed while it was being opened`);
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
    const finalStat = fstatSync(descriptor);
    assertStableFileRead(initialStat, finalStat, label);
    return {
      data: Buffer.concat(chunks, totalBytes),
      fileStat: finalStat,
    };
  } finally {
    closeSync(descriptor);
  }
}

export function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  const traversesParent =
    relative === ".." || relative.startsWith(`..${path.sep}`);
  return relative === "" || (!traversesParent && !path.isAbsolute(relative));
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

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function lstatIfPresent(filePath) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function prepareReviewOutputPath(outputPath) {
  const absolute = path.resolve(outputPath);
  const parent = realpathSync(path.dirname(absolute));
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(
      `review prompt output parent must be a real directory: ${parent}`,
    );
  }
  const destination = path.join(parent, path.basename(absolute));
  const destinationStat = lstatIfPresent(destination);
  if (
    destinationStat &&
    (!destinationStat.isFile() || destinationStat.isSymbolicLink())
  ) {
    throw new Error(
      `refusing unsafe review prompt output path: ${destination}`,
    );
  }
  return { destination, parent, parentStat };
}

function assertStableReviewOutputParent(plan) {
  const resolvedParent = realpathSync(plan.parent);
  const parentStat = lstatSync(resolvedParent);
  if (
    resolvedParent !== plan.parent ||
    !parentStat.isDirectory() ||
    !sameFileIdentity(parentStat, plan.parentStat)
  ) {
    throw new Error(
      `review prompt output parent changed while publishing: ${plan.parent}`,
    );
  }
}

let reviewOutputTemporaryId = 0;

function writeReviewOutputAtomically(plan, content) {
  assertStableReviewOutputParent(plan);
  const existing = lstatIfPresent(plan.destination);
  if (existing) {
    throw new Error(
      `refusing to replace an existing review prompt output: ${plan.destination}`,
    );
  }

  let descriptor = null;
  let temporaryPath = null;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      reviewOutputTemporaryId += 1;
      temporaryPath = path.join(
        plan.parent,
        `.${path.basename(plan.destination)}.autoreview-${process.pid}-${reviewOutputTemporaryId}.tmp`,
      );
      try {
        descriptor = openSync(
          temporaryPath,
          fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            (fsConstants.O_NOFOLLOW || 0),
          0o600,
        );
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    if (descriptor === null || temporaryPath === null) {
      throw new Error(
        `unable to reserve a temporary review prompt output in ${plan.parent}`,
      );
    }
    writeFileSync(descriptor, content, "utf8");
    const temporaryStat = fstatSync(descriptor);
    closeSync(descriptor);
    descriptor = null;

    assertStableReviewOutputParent(plan);
    const destinationStat = lstatIfPresent(plan.destination);
    if (destinationStat) {
      throw new Error(
        `refusing to replace an existing review prompt output: ${plan.destination}`,
      );
    }
    try {
      linkSync(temporaryPath, plan.destination);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error(
          `refusing to replace an existing review prompt output: ${plan.destination}`,
          { cause: error },
        );
      }
      throw error;
    }
    const publishedStat = lstatSync(plan.destination);
    if (
      !publishedStat.isFile() ||
      publishedStat.isSymbolicLink() ||
      !sameFileIdentity(publishedStat, temporaryStat)
    ) {
      const current = lstatIfPresent(plan.destination);
      if (
        current?.isFile() &&
        !current.isSymbolicLink() &&
        sameFileIdentity(current, temporaryStat)
      ) {
        unlinkSync(plan.destination);
      }
      throw new Error(
        `review prompt output changed while publishing: ${plan.destination}`,
      );
    }
    unlinkSync(temporaryPath);
    temporaryPath = null;
    return publishedStat;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (temporaryPath !== null) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Preserve the primary publication failure if best-effort cleanup loses.
      }
    }
  }
}

export function writeReviewPromptOutputs(outputPath, prompts) {
  const outputs = reviewPromptOutputPaths(outputPath, prompts.length);
  const plans = outputs.map(prepareReviewOutputPath);
  if (prompts.length === 1) {
    writeReviewOutputAtomically(plans[0], prompts[0]);
    return outputs;
  }
  for (const plan of plans) {
    if (lstatIfPresent(plan.destination)) {
      throw new Error(
        `refusing to replace an existing multi-pass review prompt set: ${plan.destination}`,
      );
    }
  }
  const companions = outputs.slice(1);
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
  const published = [];
  try {
    plans.slice(1).forEach((plan, index) => {
      published.push({
        plan,
        stat: writeReviewOutputAtomically(plan, prompts[index]),
      });
    });
    writeReviewOutputAtomically(plans[0], lines.join("\n"));
  } catch (error) {
    for (const { plan, stat } of published.reverse()) {
      try {
        assertStableReviewOutputParent(plan);
        const current = lstatIfPresent(plan.destination);
        if (
          current?.isFile() &&
          !current.isSymbolicLink() &&
          sameFileIdentity(current, stat)
        ) {
          unlinkSync(plan.destination);
        }
      } catch {
        // Preserve the publication error if best-effort rollback loses a race.
      }
    }
    throw error;
  }
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

// A shell parameter expansion carrying a default, assign, alternate, or error
// operator resolves at runtime exactly the way a bare `${VAR}` does, so
// `GH_API_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"` names values it does not
// carry. The word after `:-`, `-`, `:=`, `=`, `:+`, `+`, `:?`, or `?` is
// accepted only when it is empty, an exactly-empty quoted word, or itself a
// shell-native reference, because a default can inline a real credential
// (`${GH_TOKEN:-ghp_real}`) and that must still fail closed — a quoted word with
// anything in it stays subject to the literal rules. The word is deliberately
// not measured against the whole
// placeholder grammar: under shell semantics a word such as `secrets.ghp_real`
// is a plain literal, not a reference, so the broader grammar would let one
// through. Nesting is parsed rather than pattern-matched, and the brace closing
// the leading `${` has to be the last character, so a literal fused to an
// expansion (`${VAR:-}ghp_real`) is not a reference either. Any other expansion
// form — `${VAR#prefix}`, `${VAR/a/b}` — leaves a non-empty, non-reference word
// and stays subject to the literal rules.
//
// Nesting is bounded because each level recurses and rescans its own substring.
// A single diff line of deeply nested reference-only expansions otherwise costs
// quadratic time and one stack frame per level. Measured on this scanner before
// the bound: 20,000 levels took 8.9s, and 100,000 levels ran 38s and then threw
// `RangeError: Maximum call stack size exceeded` out of the scan, aborting
// bundle preparation instead of returning a verdict. Bounded, the same
// 100,000-level line returns a refusal in 118ms. Real shell defaults nest one to three deep, so anything past the
// bound is treated as not a reference — the fail-closed direction, since the
// value then stays subject to the literal rules.
const MAX_SHELL_EXPANSION_NESTING = 8;

// The length at which the literal rules start treating a value as a credential.
// Every rule that measures a value, a word, or a segment reads it from here, so
// tuning it moves the whole scanner at once. Two line patterns mirror it as a
// `{12,}` quantifier, where a computed bound would obscure the pattern; change
// those with it.
const CREDENTIAL_LITERAL_MIN_LENGTH = 12;

function shellExpansionWord(word) {
  return (
    word === "" ||
    word === "''" ||
    word === '""' ||
    /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9])$/.test(word) ||
    shellExpansionReference(word)
  );
}

function shellExpansionReference(expression) {
  const head = /^\$\{(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+)(?::?[-=+?])?/.exec(
    expression,
  );
  if (!head) return false;
  let depth = 0;
  let closing = -1;
  for (let index = 0; index < expression.length; index += 1) {
    if (expression[index] === "$" && expression[index + 1] === "{") {
      depth += 1;
      if (depth > MAX_SHELL_EXPANSION_NESTING) return false;
      index += 1;
      continue;
    }
    if (expression[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) {
      closing = index;
      break;
    }
  }
  if (closing !== expression.length - 1) return false;
  return shellExpansionWord(expression.slice(head[0].length, closing).trim());
}

// A value is a placeholder (never a committed literal secret) when it is an
// env/context REFERENCE rather than an inline value. The `${{ <context>.path }}`
// clause covers GitHub Actions expressions: their contents resolve at runtime,
// so `${{ github.token }}` or `${{ steps.app-token.outputs.token }}` are as safe
// to bundle as `${{ secrets.X }}` — a real literal secret cannot take that form.
// The context set is the fixed GHA list (github, env, inputs, matrix, needs,
// steps, job(s), runner, strategy, secrets, vars); the trailing path only allows
// [A-Z0-9_.-], so a trailing inline secret (`"${{ secrets.X }}ghp_real"`) still
// fails the `^…$` anchor and is caught.
// The `<scope>.path` clauses — both bare and the legacy `${…}` interpolation
// wrapper — cover Terraform/HCL traversal references
// (var, local, module, data) the same way — `var.x`, `local.audit_token`,
// `data.terraform_remote_state.platform.outputs.token` name a value resolved at
// plan/apply time, never an inline secret, so a `github_actions_secret` block
// whose `value = local.x`/`data.x.y` (or a credential-named local set from one)
// is a reference, not a committed literal. Same `[A-Z0-9_.-]` path + `^…$`
// anchor, so a trailing inline secret (`local.x ghp_real`, `"local.x"; realKey`)
// still fails to match and is caught.
function placeholderValue(value) {
  const trimmed = value.trim();
  return (
    shellExpansionReference(trimmed) ||
    // One leading backslash still leaves a reference. Inside a JS template
    // literal `\${VAR:-}` is a JS escape, so the emitted shell script receives
    // `${VAR:-}` — a parameter expansion that yields the variable's value when
    // set and non-null, and the (empty) default otherwise, always at run time.
    // Either way the committed source carries no literal credential, which is
    // what this scanner guards. Where the backslash instead survives
    // literally, the value is placeholder text, not credential material. Exactly one backslash is
    // stripped and the remainder has to be a whole reference on its own; the
    // narrow form is the point, because normalizing the backslash ahead of the
    // entire grammar below would also clear escaped GitHub Actions forms
    // (`\${{ secrets.X }}`) and escaped HCL (`\${var.x}`). Those keep refusing
    // here: `shellExpansionReference` accepts neither, so only the shell
    // expansion form is widened.
    (trimmed.startsWith("\\") && shellExpansionReference(trimmed.slice(1))) ||
    /^(?:\$\{(?:[A-Z_][A-Z0-9_]*|(?:secrets|vars|var|local|module|data)\.[A-Z0-9_.-]+|process\.env(?:\.[A-Z_][A-Z0-9_]*|\[["'][A-Z_][A-Z0-9_]*["']\]))\}|\$\{\{\s*(?:secrets|vars|github|env|inputs|matrix|needs|steps|job|jobs|runner|strategy)\.[A-Z0-9_.-]+\s*\}\}|\$[A-Z_][A-Z0-9_]*|process\.env(?:\.[A-Z_][A-Z0-9_]*|\[["'][A-Z_][A-Z0-9_]*["']\])|(?:secrets|vars|var|local|module|data)\.[A-Z0-9_.-]+)$/i.test(
      trimmed,
    ) ||
    /^(?:process(?:\.|\?\.)env(?:(?:\.|\?\.)[A-Z_][A-Z0-9_]*|(?:\?\.)?\[["'][A-Z_][A-Z0-9_]*["']\])|\$\{process(?:\.|\?\.)env(?:(?:\.|\?\.)[A-Z_][A-Z0-9_]*|(?:\?\.)?\[["'][A-Z_][A-Z0-9_]*["']\])\})$/i.test(
      trimmed,
    ) ||
    /^(?:(?:redacted|placeholder|example|sample|dummy|test|fixture|prefix|suffix)(?:[-_ ](?:api|auth|access|service|client|private|secret|key|token|credential|value|placeholder|example|sample|dummy|test|fixture|prefix|suffix))*|changeme|replace[-_ ]?me|not[-_ ]?set)$/i.test(
      trimmed,
    ) ||
    /^<[^>]+>$/.test(trimmed)
  );
}

function normalizeCredentialKey(rawKey) {
  return rawKey
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

const RECOVERY_PHRASE_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);

function recoveryPhraseAssignmentKey(rawKey) {
  const key = normalizeCredentialKey(rawKey);
  return /(?:^|[_-])(?:mnemonic(?:[_-]?(?:phrase|words))?|seed(?:[_-]?(?:phrase|words))?|recovery[_-]?(?:phrase|words|seed)|backup[_-]?(?:phrase|words|seed))$/.test(
    key,
  );
}

function recoveryPhraseValue(value) {
  const candidate = value.trim();
  if (!candidate || placeholderValue(candidate)) return false;
  const words = candidate.split(/\s+/u);
  return (
    RECOVERY_PHRASE_WORD_COUNTS.has(words.length) &&
    words.every((word) => /^[\p{L}\p{M}]+$/u.test(word))
  );
}

function unquotedRecoveryPhraseValue(value) {
  return value
    .replace(/[ \t]+(?:#|\/\/).*$/u, "")
    .replace(/[ \t]+\/\*[^\r\n]*\*\/[ \t]*$/u, "")
    .replace(/[;,][ \t]*$/u, "")
    .trim();
}

function diffPayloadLine(line) {
  return /^[+-]/u.test(line) ? line.slice(1) : line;
}

function collectionRecoveryPhraseValue(value) {
  const candidate = unquotedRecoveryPhraseValue(
    value.split(/\r?\n/u).map(diffPayloadLine).join("\n"),
  );
  const closing = { "(": ")", "[": "]" }[candidate[0]];
  if (
    !closing ||
    candidate.at(-1) !== closing ||
    !balancedDelimitedExpression(candidate, 0)
  ) {
    return null;
  }
  const body = candidate.slice(1, -1);
  const items = [];
  for (let index = 0; index < body.length; index += 1) {
    if (/[,\s]/u.test(body[index])) continue;
    const quoted = readQuotedLiteral(body, index);
    if (quoted) {
      if (quoted.interpolated) return null;
      items.push(quoted.value);
      index = quoted.end;
      continue;
    }
    let end = index;
    while (end < body.length && !/[,\s]/u.test(body[end])) end += 1;
    const item = body.slice(index, end);
    if (!/^[\p{L}\p{M}]+$/u.test(item)) return null;
    items.push(item);
    index = end - 1;
  }
  if (items.length === 0) return null;
  return items.join(" ");
}

function yamlRecoveryPhraseValue(text) {
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const headerLine = diffPayloadLine(lines[index]);
    const header =
      /^\s*["']?([A-Za-z][A-Za-z0-9_-]*)["']?\s*:\s*([|>](?:[1-9][+-]?|[+-][1-9]?)?)?\s*(?:#.*)?$/u.exec(
        headerLine,
      );
    if (!header || !recoveryPhraseAssignmentKey(header[1])) continue;
    if (header[2]) {
      const headerIndent = /^\s*/u.exec(headerLine)?.[0].length ?? 0;
      const fragments = [];
      for (
        let blockIndex = index + 1;
        blockIndex < lines.length;
        blockIndex += 1
      ) {
        const line = diffPayloadLine(lines[blockIndex]);
        if (/^\s*$/u.test(line)) {
          fragments.push("");
          continue;
        }
        const indentation = /^\s*/u.exec(line)?.[0].length ?? 0;
        if (indentation <= headerIndent) break;
        fragments.push(line.trim());
      }
      const candidate = fragments.join(" ");
      if (recoveryPhraseValue(candidate)) return candidate;
      continue;
    }
    const items = [];
    for (let itemIndex = index + 1; itemIndex < lines.length; itemIndex += 1) {
      const line = diffPayloadLine(lines[itemIndex]);
      if (/^\s*$/u.test(line)) {
        if (items.length > 0) continue;
        break;
      }
      const item =
        /^\s*-\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([\p{L}\p{M}]+))\s*(?:#.*)?$/u.exec(
          line,
        );
      if (!item) break;
      items.push(item[1] ?? item[2] ?? item[3]);
      if (items.length > Math.max(...RECOVERY_PHRASE_WORD_COUNTS)) break;
    }
    const candidate = items.join(" ");
    if (recoveryPhraseValue(candidate)) return candidate;
  }
  return null;
}

function balancedDelimitedExpression(value, openingIndex) {
  const stack = [];
  let quote = null;
  let escaped = false;
  for (let index = openingIndex; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      stack.push(character);
      continue;
    }
    if (character === ")" || character === "]" || character === "}") {
      const expected = character === ")" ? "(" : character === "]" ? "[" : "{";
      if (stack.pop() !== expected) return false;
      if (stack.length === 0 && index !== value.length - 1) return false;
    }
  }
  return quote === null && stack.length === 0;
}

function unwrapBalancedExpression(value) {
  let expression = value.trim();
  const closingDelimiter = { "(": ")", "[": "]", "{": "}" };
  while (
    expression.length >= 2 &&
    closingDelimiter[expression[0]] === expression.at(-1) &&
    balancedDelimitedExpression(expression, 0)
  ) {
    expression = expression.slice(1, -1).trim();
  }
  return expression;
}

function unquotedCodeExpression(value, trailingComma, propertyContext = false) {
  const expression = unwrapBalancedExpression(value);
  if (
    propertyContext &&
    (/^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|\?\.)[A-Za-z_$][A-Za-z0-9_$]*)+$/.test(
      expression,
    ) ||
      (trailingComma && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(expression)))
  ) {
    return true;
  }

  const callHead =
    /^(?:await\s+)?(?:new\s+)?[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|\?\.)[A-Za-z_$][A-Za-z0-9_$]*)*\s*\(/.exec(
      expression,
    );
  if (!callHead || !expression.endsWith(")")) return false;

  const openingIndex = callHead[0].lastIndexOf("(");
  return balancedDelimitedExpression(expression, openingIndex);
}

// The scanner reads a whole diff and has no file type, so a rule that proves
// one language's syntax has to carry its own discriminator. A shell assignment
// forbids whitespace around `=` — `TOKEN = value` runs the command `TOKEN` — so
// requiring whitespace on both sides is a syntactic proof that the line is not
// a shell assignment, and it is what separates an HCL attribute from
// `TOKEN=each.value.<literal>` in a script.
function spacedAssignmentOperator(operator) {
  return /^[ \t]+=[ \t]+$/.test(operator);
}

// HCL iteration traversals name a value the plan resolves, exactly like the
// `var`/`local`/`module`/`data` traversals `placeholderValue()` already accepts:
// `each` and `count` are the fixed `for_each`/`count` scopes, `self` is a
// resource's own attributes, and `rule` is the dynamic-block iterator this
// repo's alert rules declare. The grammar is a bare dotted identifier path
// anchored end to end, so a literal fused to a traversal
// (`rule.value.token ghp_real`) is not one. Only the unquoted branches consult
// it, which is what keeps a quoted traversal-shaped value a literal: in HCL a
// quoted value is a string, and the traversal proof is the absence of quotes.
// It reads the spaced `=` form only; the `key: value` form of the same path is
// already a property traversal to `unquotedCodeExpression()`.
const HCL_ITERATION_TRAVERSAL =
  /^(?:count|each|rule|self)(?:\.[A-Za-z_][A-Za-z0-9_-]*)+$/;

function hclIterationTraversal(value) {
  return HCL_ITERATION_TRAVERSAL.test(value.trim());
}

// A TypeScript type annotation occupies type position: `token: string |
// undefined` declares a shape and carries no value at all. The accepted set is
// closed rather than shaped: every member of the union or intersection has to
// be one of the built-in type keywords below, optionally suffixed with `[]`.
// Because the whole value is then drawn from a twelve-word vocabulary, it
// cannot carry a credential in any language — not as one member and not split
// across several, which a shape rule measuring member length would allow. A
// named type (`Address | undefined`) is outside the vocabulary and stays
// subject to the literal rules; that is the fail-closed direction, and the
// scanner has no file type with which to prove a name is a type.
const TYPE_ANNOTATION_KEYWORDS = new Set([
  "any",
  "bigint",
  "boolean",
  "never",
  "null",
  "number",
  "object",
  "string",
  "symbol",
  "undefined",
  "unknown",
  "void",
]);

const TYPE_ANNOTATION_MEMBER = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\[\])*$/;

function typeAnnotationValue(value) {
  const members = value.trim().split(/\s*[|&]\s*/);
  if (members.length < 2) return false;
  return members.every((member) => {
    const parsed = TYPE_ANNOTATION_MEMBER.exec(member);
    return parsed !== null && TYPE_ANNOTATION_KEYWORDS.has(parsed[1]);
  });
}

// Words inside an accepted command substitution are read by position, because
// the two positions carry different risk. Arguments are where a literal can
// sit, so each one is bounded whole by the length the literal rules treat as
// credential-sized: a shell-native reference, a flag whose name and optional
// value each stay under it, or a bare word that does. One uniform bound leaves
// no position in which a long literal can hide, prefixed with `--` or split
// across separators. It also refuses a long real argument such as a deep path,
// which is the fail-closed direction and costs a line only when it sits in a
// credential-named assignment with a control tail.
//
// The command word names something the shell executes, never a value, so it is
// measured only for opaque runs — a real command or function name
// (`get_access_token`) is short segments joined by separators. Bounding it whole
// would refuse those names, and the position already carries whatever a bare
// `$(cmd)` value carries today.
const SHELL_WORD_ALPHABET = /^[A-Za-z0-9_./-]+$/;
const SHELL_FLAG_WORD =
  /^(--?[A-Za-z0-9][A-Za-z0-9-]*)(?:=([A-Za-z0-9_./-]*))?$/;

function shellCommandWord(word) {
  return (
    SHELL_WORD_ALPHABET.test(word) &&
    word
      .split(/[-_./]/)
      .every((segment) => segment.length < CREDENTIAL_LITERAL_MIN_LENGTH)
  );
}

function shellArgumentWord(word) {
  if (shellExpansionWord(word)) return true;
  const flag = SHELL_FLAG_WORD.exec(word);
  if (flag)
    return (
      flag[1].length < CREDENTIAL_LITERAL_MIN_LENGTH &&
      (flag[2] ?? "").length < CREDENTIAL_LITERAL_MIN_LENGTH
    );
  return (
    word.length < CREDENTIAL_LITERAL_MIN_LENGTH &&
    SHELL_WORD_ALPHABET.test(word)
  );
}

// The head of an accepted command list is a command substitution whose own
// words are inert, so a literal argument fails closed
// (`token=$(echo <literal>) || return 1`) even though the call-expression rule
// that governs a bare `$(cmd)` value would take it. A backtick head, an
// arithmetic expansion, and a plain call expression are all outside this form.
function shellCommandSubstitution(head) {
  if (!head.startsWith("$(") || !head.endsWith(")")) return false;
  if (!balancedDelimitedExpression(head, 1)) return false;
  const [command, ...args] = head
    .slice(2, -1)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return (
    command !== undefined &&
    shellCommandWord(command) &&
    args.every(shellArgumentWord)
  );
}

// Operators are found at parenthesis depth zero so that `$(a || b)` stays one
// substitution; quotes need no tracking because the callers' value groups
// exclude them.
function shellControlOperatorIndex(expression) {
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      continue;
    }
    if (
      depth === 0 &&
      (character === "|" || character === "&") &&
      expression[index + 1] === character
    ) {
      return index;
    }
  }
  return -1;
}

// A shell command list continues past the assignment: in
// `access_token=$(get_access_token) || return 1` the assigned value is the
// command substitution, resolved when the script runs, and `return 1` is a
// separate command the operator guards. The line patterns carry no shell
// grammar, so they capture the tail too and read the whole span as a literal.
// The tail is stricter than the substitution: whole words under credential
// length from an alphabet with no `=`, `:`, quote, `$`, or parenthesis, so
// neither a second assignment (`token=$(get) || SERVICE_TOKEN=<literal>`) nor a
// command argument (`token=$(get) || echo <literal>`) can carry one, split
// across separators or not. A real guard tail is `|| return 1`, `|| exit 1`,
// `&& log ok`. Callers read `=` values only — the languages that write a
// command list into an assignment all use `=`.
function shellCommandListValue(value) {
  const expression = value.trim();
  const operatorIndex = shellControlOperatorIndex(expression);
  if (operatorIndex === -1) return false;
  if (!shellCommandSubstitution(expression.slice(0, operatorIndex).trim())) {
    return false;
  }
  const words = expression
    .slice(operatorIndex)
    .replace(/^(?:\|\||&&)\s*/, "")
    .split(/\s+/)
    .filter(Boolean);
  return (
    words.length > 0 &&
    words.every(
      (word) =>
        word === "||" ||
        word === "&&" ||
        (word.length < CREDENTIAL_LITERAL_MIN_LENGTH &&
          SHELL_WORD_ALPHABET.test(word)),
    )
  );
}

function wrappedQuotedLiteral(value) {
  const expression = unwrapBalancedExpression(value);
  const quote = expression[0];
  if (
    (quote !== '"' && quote !== "'" && quote !== "`") ||
    expression.length < 2
  ) {
    return null;
  }
  const parsed = readQuotedLiteral(expression, 0);
  if (!parsed || parsed.end !== expression.length - 1 || parsed.interpolated) {
    return null;
  }
  return parsed.value;
}

function readQuotedLiteral(source, start) {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let value = "";
  let escaped = false;
  let interpolated = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      value += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote === "`" && character === "$" && source[index + 1] === "{") {
      interpolated = true;
      const closingIndex = findTemplateInterpolationEnd(source, index + 1);
      if (closingIndex !== null) {
        value += source.slice(index, closingIndex + 1);
        index = closingIndex;
        continue;
      }
    }
    if (character === quote) {
      return { end: index, interpolated, value };
    }
    value += character;
  }
  return null;
}

function findTemplateInterpolationEnd(source, openingIndex) {
  const stack = ["{"];
  let quote = null;
  let escaped = false;
  for (let index = openingIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      stack.push(character);
      continue;
    }
    if (character === ")" || character === "]" || character === "}") {
      const expected = character === ")" ? "(" : character === "]" ? "[" : "{";
      if (stack.pop() !== expected) return null;
      if (stack.length === 0) return index;
    }
  }
  return null;
}

function templateLiteralValues(source) {
  const staticValue = staticTemplateValue(source);
  if (staticValue !== null) return [staticValue];
  const values = [];
  let chunk = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && index + 1 < source.length) {
      chunk += source[index + 1];
      index += 1;
      continue;
    }
    if (character === "$" && source[index + 1] === "{") {
      if (chunk) values.push(chunk);
      chunk = "";
      const closingIndex = findTemplateInterpolationEnd(source, index + 1);
      if (closingIndex === null) {
        chunk += source.slice(index);
        break;
      }
      values.push(
        ...quotedLiteralValues(source.slice(index + 2, closingIndex)),
      );
      index = closingIndex;
      continue;
    }
    chunk += character;
  }
  if (chunk) values.push(chunk);
  return values;
}

function staticConcatenation(source, first) {
  if (first.interpolated) return null;
  let combined = first.value;
  let count = 1;
  let end = first.end;
  while (end + 1 < source.length) {
    const separator =
      /^(?:(?:\r?\n[+ -]?[ \t]*|[ \t]+|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n[+ -]?[ \t]*|$))*)\+(?:(?:\r?\n[+ -]?[ \t]*|[ \t]+|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n[+ -]?[ \t]*|$))*)/.exec(
        source.slice(end + 1),
      );
    if (!separator) break;
    const nextStart = end + 1 + separator[0].length;
    const next = readQuotedLiteral(source, nextStart);
    if (!next || next.interpolated) break;
    combined += next.value;
    count += 1;
    end = next.end;
  }
  return count > 1 ? { end, value: combined } : null;
}

function staticStringExpression(source) {
  const expression = unwrapBalancedExpression(source);
  const first = readQuotedLiteral(expression, 0);
  if (!first) return null;
  const concatenation = staticConcatenation(expression, first);
  if (concatenation) {
    return expression.slice(concatenation.end + 1).trim() === ""
      ? concatenation.value
      : null;
  }
  if (first.end !== expression.length - 1) return null;
  if (first.interpolated) {
    return staticTemplateValue(expression.slice(1, first.end));
  }
  return first.value;
}

function staticTemplateValue(source) {
  let value = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && index + 1 < source.length) {
      value += source[index + 1];
      index += 1;
      continue;
    }
    if (character === "$" && source[index + 1] === "{") {
      const closingIndex = findTemplateInterpolationEnd(source, index + 1);
      if (closingIndex === null) return null;
      const interpolation = staticStringExpression(
        source.slice(index + 2, closingIndex),
      );
      if (interpolation === null) return null;
      value += interpolation;
      index = closingIndex;
      continue;
    }
    value += character;
  }
  return value;
}

function processEnvironmentPropertyLiteral(source, start, end) {
  return (
    /process\s*(?:\.|\?\.)\s*env\s*(?:\?\.)?\s*\[\s*$/i.test(
      source.slice(0, start),
    ) && /^\s*\]/.test(source.slice(end + 1))
  );
}

function quotedLiteralContainingPositionOnLine(source, position) {
  const lineStart = source.lastIndexOf("\n", position - 1) + 1;
  for (let index = lineStart; index <= position; index += 1) {
    const quoted = readQuotedLiteral(source, index);
    if (!quoted) continue;
    if (quoted.end >= position) return quoted;
    index = quoted.end;
  }
  return null;
}

function inlineAssignmentLiteralEnd(source, match, key, computed) {
  const matchStart = match.index ?? 0;
  if (computed) {
    return (
      quotedLiteralContainingPositionOnLine(source, matchStart)?.end ?? null
    );
  }
  const keyOffset = match[0].indexOf(key);
  if (keyOffset < 0) return matchStart;
  const keyPosition = matchStart + keyOffset;
  const preceding = source[keyPosition - 1];
  const following = source[keyPosition + key.length];
  const contextPosition = "\"'`".includes(preceding)
    ? following === preceding
      ? keyPosition - 2
      : keyPosition - 1
    : keyPosition;
  return (
    quotedLiteralContainingPositionOnLine(source, contextPosition)?.end ?? null
  );
}

function quotedLiteralValues(source) {
  const values = [];
  for (let index = 0; index < source.length; index += 1) {
    const parsed = readQuotedLiteral(source, index);
    if (!parsed) continue;
    if (processEnvironmentPropertyLiteral(source, index, parsed.end)) {
      index = parsed.end;
      continue;
    }
    if (parsed.interpolated) {
      values.push(
        ...templateLiteralValues(source.slice(index + 1, parsed.end)),
      );
      index = parsed.end;
      continue;
    }
    const concatenation = staticConcatenation(source, parsed);
    if (concatenation) {
      values.push(concatenation.value);
      index = concatenation.end;
      continue;
    }
    values.push(parsed.value);
    index = parsed.end;
  }
  return values;
}

function expressionContinuesBetweenLines(currentSource, nextSource) {
  const currentLine = currentSource.replace(/^[+ -]?\s*/, "").trimEnd();
  const nextLine = nextSource.replace(/^[+ -]?\s*/, "").trimStart();
  return (
    /(?:\?\?|\|\||&&|[+*/%?:=.,([{!<>-])$/.test(currentLine) ||
    /^(?:\?\?|\|\||&&|[+*/%?:=.,)\]}!<>-])/.test(nextLine)
  );
}

function assignmentContinuesAcrossLine(source, lineStart, newlineIndex) {
  const nextLineEnd = source.indexOf("\n", newlineIndex + 1);
  return expressionContinuesBetweenLines(
    source.slice(lineStart, newlineIndex),
    source.slice(
      newlineIndex + 1,
      nextLineEnd === -1 ? source.length : nextLineEnd,
    ),
  );
}

function boundedAssignmentExpression(source, start) {
  const maximumEnd = Math.min(source.length, start + 65536);
  const stack = [];
  let lineStart = start;
  let linePrefixPending = start === 0 || source[start - 1] === "\n";
  let sawContent = false;
  for (let index = start; index < maximumEnd; index += 1) {
    const character = source[index];
    if (character === "\r") continue;
    if (character === "\n") {
      if (
        stack.length === 0 &&
        sawContent &&
        !assignmentContinuesAcrossLine(source, lineStart, index)
      ) {
        return source.slice(start, index);
      }
      lineStart = index + 1;
      linePrefixPending = true;
      continue;
    }
    if (linePrefixPending) {
      linePrefixPending = false;
      if (character === "+" || character === "-" || character === " ") {
        continue;
      }
    }
    if (/\s/.test(character)) continue;

    const quoted = readQuotedLiteral(source, index);
    if (quoted) {
      sawContent = true;
      index = quoted.end;
      continue;
    }
    if (
      character === "/" &&
      source[index + 1] === "/" &&
      source[index - 1] !== ":"
    ) {
      const newline = source.indexOf("\n", index + 2);
      if (newline === -1) {
        return maximumEnd < source.length ? null : source.slice(start, index);
      }
      if (newline >= maximumEnd) {
        return null;
      }
      const nextLineEnd = source.indexOf("\n", newline + 1);
      if (
        stack.length === 0 &&
        sawContent &&
        !expressionContinuesBetweenLines(
          source.slice(lineStart, index),
          source.slice(
            newline + 1,
            nextLineEnd === -1 ? source.length : nextLineEnd,
          ),
        )
      ) {
        return source.slice(start, index);
      }
      index = newline;
      lineStart = newline + 1;
      linePrefixPending = true;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const closing = source.indexOf("*/", index + 2);
      if (closing === -1 || closing + 2 > maximumEnd) {
        return null;
      }
      index = closing + 1;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      stack.push(character);
      sawContent = true;
      continue;
    }
    if (character === ")" || character === "]" || character === "}") {
      const expected = character === ")" ? "(" : character === "]" ? "[" : "{";
      if (stack.at(-1) !== expected) return source.slice(start, index);
      stack.pop();
      sawContent = true;
      continue;
    }
    if (stack.length === 0 && (character === "," || character === ";")) {
      return source.slice(start, index);
    }
    sawContent = true;
  }
  return maximumEnd < source.length ? null : source.slice(start, maximumEnd);
}

function completeAssignmentExpression(value) {
  const expression = value.trim();
  const quoted = readQuotedLiteral(expression, 0);
  if (quoted?.end === expression.length - 1) return true;
  if (
    expression.length >= 2 &&
    "([{".includes(expression[0]) &&
    balancedDelimitedExpression(expression, 0)
  ) {
    return true;
  }
  return unquotedCodeExpression(expression, true, true);
}

function stripTrailingExpressionComment(value) {
  const expression = value.trim();
  for (let index = 0; index < expression.length - 1; index += 1) {
    const quoted = readQuotedLiteral(expression, index);
    if (quoted) {
      index = quoted.end;
      continue;
    }
    if (
      expression[index] !== "/" ||
      (expression[index + 1] !== "/" && expression[index + 1] !== "*")
    ) {
      continue;
    }
    let prefix = expression.slice(0, index).trimEnd();
    if (prefix.endsWith(",")) prefix = prefix.slice(0, -1).trimEnd();
    if (completeAssignmentExpression(prefix)) return prefix;
  }
  return expression;
}

function literalAuthorizationCredential(value) {
  const trimmed = value.trim();
  if (placeholderValue(trimmed)) return false;
  const scheme = /^(?:bearer|basic|token|digest|apikey)\s+(.+)$/i.exec(trimmed);
  const credential = (scheme?.[1] ?? trimmed).trim();
  return (
    credential.length >= (scheme ? 8 : CREDENTIAL_LITERAL_MIN_LENGTH) &&
    !placeholderValue(credential)
  );
}

const STRONG_CREDENTIAL_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{24,}\b/g,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
];

const DIFF_HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

// Merged, ordered spans of every strong-pattern match on one line. Overlapping
// matches collapse so a span never splits a single credential-shaped run.
function strongCredentialSpans(line) {
  const spans = [];
  for (const pattern of STRONG_CREDENTIAL_PATTERNS) {
    for (const match of line.matchAll(pattern)) {
      spans.push([match.index, match.index + match[0].length]);
    }
  }
  if (spans.length < 2) return spans;
  spans.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [spans[0]];
  for (const span of spans.slice(1)) {
    const last = merged.at(-1);
    if (span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push(span);
  }
  return merged;
}

// Maps each diff line to the hunk it belongs to and collects that hunk's added
// content. Only `+`/`-` lines between a hunk header and the first line that is
// neither diff content nor context belong to a hunk, so file headers such as
// `--- a/x` and `+++ b/x` are never mistaken for hunk lines.
function splitDiffHunks(lines) {
  const hunkOfLine = new Array(lines.length).fill(-1);
  const hunks = [];
  let current = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (DIFF_HUNK_HEADER.test(line)) {
      hunks.push([]);
      current = hunks.length - 1;
      continue;
    }
    if (current === -1) continue;
    const marker = line.charAt(0);
    if (line === "" || marker === " " || marker === "\\") continue;
    if (marker === "+") {
      hunks[current].push(line.slice(1));
      hunkOfLine[index] = current;
      continue;
    }
    if (marker === "-") {
      hunkOfLine[index] = current;
      continue;
    }
    current = -1;
  }
  return { hunkOfLine, hunks };
}

// True when `added` is `removed` with every credential-shaped span replaced by
// placeholder vocabulary and nothing else changed. Every literal segment around
// the spans must match exactly, so a rewritten line, a line that merely happens
// to mention a placeholder, or a swap to a different opaque literal all fail.
// The leftmost search for each following segment is deterministic; when it does
// not reconstruct `removed` exactly the answer is false, which refuses.
function placeholderRedactionOf(removed, spans, added) {
  let removedIndex = 0;
  let addedIndex = 0;
  for (let index = 0; index < spans.length; index += 1) {
    const [start, end] = spans[index];
    const prefix = removed.slice(removedIndex, start);
    if (!added.startsWith(prefix, addedIndex)) return false;
    addedIndex += prefix.length;
    removedIndex = end;
    const nextStart =
      index + 1 < spans.length ? spans[index + 1][0] : removed.length;
    const following = removed.slice(removedIndex, nextStart);
    let replacementEnd;
    if (following === "") {
      if (index + 1 < spans.length) return false;
      replacementEnd = added.length;
    } else {
      const found = added.indexOf(following, addedIndex + 1);
      if (found === -1) return false;
      replacementEnd = found;
    }
    const replacement = added.slice(addedIndex, replacementEnd);
    if (replacement.length === 0 || !placeholderValue(replacement))
      return false;
    addedIndex = replacementEnd;
  }
  return added.slice(addedIndex) === removed.slice(removedIndex);
}

// A credential-shaped token is refused wherever it appears, with one narrow
// exception: on the REMOVED side of a hunk whose added side carries the same
// line with that token replaced by placeholder vocabulary — a redaction, not an
// exfiltration. A removal with no replacement, a removal replaced by a different
// credential-shaped literal, a replacement in another hunk, and every addition
// or context line stay refused. Each added line redacts at most one removal, so
// a single placeholder cannot cover a second credential-bearing removal that is
// really an unreplaced deletion.
//
// The exception applies only when `gitDiff` is set, which one call site does for
// the git-generated review bundle. Supplemental input — `--prompt`, prompt
// files, datasets, branch names, refs — is arbitrary text that an author can
// shape at will, so no line there belongs to a hunk and every credential-shaped
// token is refused exactly as it was before the exception existed. Requiring a
// `diff --git` header instead would not close this: an author who can write
// `@@ -1 +1 @@` into a prompt can write that header too.
function strongCredentialTokenReason(text, gitDiff) {
  const lines = text.split("\n");
  const { hunkOfLine, hunks } = gitDiff
    ? splitDiffHunks(lines)
    : { hunkOfLine: new Array(lines.length).fill(-1), hunks: [] };
  const claimed = hunks.map(() => new Set());
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const hunk = hunkOfLine[index];
    const isRemoval = hunk !== -1 && line.startsWith("-");
    const scanned = isRemoval ? line.slice(1) : line;
    const spans = strongCredentialSpans(scanned);
    if (spans.length === 0) continue;
    if (!isRemoval) return "credential-like token";
    const additions = hunks[hunk];
    let redaction = -1;
    for (let candidate = 0; candidate < additions.length; candidate += 1) {
      if (claimed[hunk].has(candidate)) continue;
      if (placeholderRedactionOf(scanned, spans, additions[candidate])) {
        redaction = candidate;
        break;
      }
    }
    if (redaction === -1) return "credential-like token";
    claimed[hunk].add(redaction);
  }
  return null;
}

// `gitDiff` marks text the caller knows is a git-generated patch. It is the only
// input for which the redaction accept-shape applies; it defaults to closed so a
// new call site cannot acquire the exception by omission.
export function secretLikeReason(text, { gitDiff = false } = {}) {
  const privateKeyHeader =
    /-----BEGIN (?:(?:[A-Z0-9][A-Z0-9 -]* )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/g;
  for (const match of text.matchAll(privateKeyHeader)) {
    const remainder = text.slice((match.index ?? 0) + match[0].length);
    if (/^[ \t]*(?:(?:\r?\n)[+ -]?\s*|\\n|\\r\\n)\S/.test(remainder)) {
      return "private key material";
    }
  }
  if (
    /\bauthorization\b\s*["']?\s*[:=]\s*["'`]?\s*bearer\s+[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/i.test(
      text,
    )
  ) {
    return "Bearer JWT";
  }
  const strongCredential = strongCredentialTokenReason(text, gitDiff);
  if (strongCredential) return strongCredential;
  const secretUrlPatterns = [
    /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]{8,}\/[A-Z0-9]{8,}\/[A-Za-z0-9]{20,}/i,
    /https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]{15,20}\/[A-Za-z0-9._-]{20,}/i,
    /https:\/\/api\.telegram\.org\/bot[0-9]{6,12}:[A-Za-z0-9_-]{30,}/i,
  ];
  if (secretUrlPatterns.some((pattern) => pattern.test(text))) {
    return "secret-bearing webhook URL";
  }
  if (/\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(text)) {
    return "credentialed URL";
  }
  const sensitiveQueryNames = new Set([
    "access-token",
    "access_token",
    "apikey",
    "api-key",
    "api_key",
    "auth",
    "key",
    "secret",
    "sig",
    "signature",
    "token",
    "x-amz-signature",
    "x-goog-signature",
  ]);
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s"'`<>]+/gi)) {
    let parsed;
    try {
      parsed = new URL(match[0]);
    } catch {
      continue;
    }
    for (const [name, rawValue] of parsed.searchParams) {
      const value = rawValue.trim();
      if (
        sensitiveQueryNames.has(name.toLowerCase()) &&
        value.length >= CREDENTIAL_LITERAL_MIN_LENGTH &&
        !placeholderValue(value)
      ) {
        return "secret-bearing URL";
      }
    }
  }
  const awsCredentialPattern =
    /^[+ -]?\s*["'`]?aws[_-]?(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key|session[_-]?token)["'`]?\s*[:=]\s*["'`]?([^"'`\r\n]+?)["'`]?(?:[ \t]+(?:\/\/[^\r\n]*|\/\*[^\r\n]*\*\/)|[ \t]*(?:[#;][^\r\n]*)?)$/gim;
  for (const match of text.matchAll(awsCredentialPattern)) {
    const value = match[1].trim();
    if (
      value.length >= CREDENTIAL_LITERAL_MIN_LENGTH &&
      !placeholderValue(value)
    ) {
      return "literal AWS credential assignment";
    }
  }
  const authorizationPattern =
    /^[+ -]?\s*["'`]?authorization["'`]?\s*([:=])\s*(["'`]?)([^"'`\r\n]+?)\2[ \t]*(,?)(?:[ \t]+(?:\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)|[ \t]*(?:[#;][^\r\n]*)?)$/gim;
  for (const match of text.matchAll(authorizationPattern)) {
    const value = match[3].trim();
    if (
      !match[2] &&
      unquotedCodeExpression(value, match[4] === ",", match[1] === ":")
    ) {
      continue;
    }
    if (literalAuthorizationCredential(value)) {
      return "literal Authorization credential";
    }
  }
  const credentialAssignmentKey = (rawKey) => {
    const key = normalizeCredentialKey(rawKey);
    return /(?:^|[_-])(?:api[_-]?key|client[_-]?secret|secret[_-]?key|vercel[_-]?token|access[_-]?token|refresh[_-]?token|auth[_-]?token|npm[_-]?token|token|password|private[_-]?key|secret)$/.test(
      key,
    );
  };
  const awsCredentialAssignmentKey = (rawKey) =>
    /^aws[_-]?(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key|session[_-]?token)$/.test(
      normalizeCredentialKey(rawKey),
    );
  const publicTokenAddressForKey = (rawKey, value) => {
    const key = normalizeCredentialKey(rawKey);
    return key === "token" && /^0x[0-9a-f]{40}$/i.test(value);
  };
  const inlineQuotedAssignmentPatterns = [
    {
      computed: false,
      pattern:
        /(?:^|[^A-Za-z0-9_-])["'`]?([A-Za-z][A-Za-z0-9_-]*)["'`]?\s*[:=]\s*/gim,
    },
    {
      computed: true,
      pattern: /\[\s*["'`]([A-Za-z][A-Za-z0-9_-]*)["'`]\s*\]\s*[:=]\s*/gim,
    },
  ];
  for (const { computed, pattern } of inlineQuotedAssignmentPatterns) {
    for (const match of text.matchAll(pattern)) {
      const key = match[1];
      const authorizationKey = normalizeCredentialKey(key) === "authorization";
      const awsCredentialKey = awsCredentialAssignmentKey(key);
      const recoveryPhraseKey = recoveryPhraseAssignmentKey(key);
      if (
        !authorizationKey &&
        !awsCredentialKey &&
        !recoveryPhraseKey &&
        !credentialAssignmentKey(key)
      ) {
        continue;
      }
      const valueStart = (match.index ?? 0) + match[0].length;
      const first = readQuotedLiteral(text, valueStart);
      const literalEnd = first
        ? null
        : inlineAssignmentLiteralEnd(text, match, key, computed);
      const concatenation = first ? staticConcatenation(text, first) : null;
      const directLiteral = Boolean(
        first && !concatenation && !first.interpolated,
      );
      const multilineDirectTemplate = Boolean(
        directLiteral &&
        text[valueStart] === "`" &&
        /[\r\n]/.test(first?.value ?? ""),
      );
      let candidates;
      let recoveryCollection = null;
      if (first) {
        candidates = concatenation
          ? [concatenation.value]
          : first.interpolated
            ? templateLiteralValues(text.slice(valueStart + 1, first.end))
            : [first.value];
      } else {
        const expression =
          literalEnd === null
            ? boundedAssignmentExpression(text, valueStart)
            : text.slice(valueStart, literalEnd);
        if (expression === null) {
          return "credential assignment exceeds scan bound";
        }
        candidates = quotedLiteralValues(expression);
        if (recoveryPhraseKey) {
          recoveryCollection = collectionRecoveryPhraseValue(expression);
        }
      }
      if (
        recoveryPhraseKey &&
        (recoveryPhraseValue(recoveryCollection ?? "") ||
          recoveryPhraseValue(candidates.join(" ")))
      ) {
        return "literal wallet recovery phrase";
      }
      if (candidates.length === 0) continue;
      for (const value of candidates) {
        if (recoveryPhraseKey) {
          if (recoveryPhraseValue(value)) {
            return "literal wallet recovery phrase";
          }
          continue;
        }
        if (authorizationKey) {
          if (literalAuthorizationCredential(value)) {
            return "literal Authorization credential";
          }
          continue;
        }
        if (awsCredentialKey) {
          if (
            value.length >= CREDENTIAL_LITERAL_MIN_LENGTH &&
            !placeholderValue(value)
          ) {
            return "literal AWS credential assignment";
          }
          continue;
        }
        if (directLiteral && !computed && !multilineDirectTemplate) continue;
        if (
          value.length >= CREDENTIAL_LITERAL_MIN_LENGTH &&
          !publicTokenAddressForKey(key, value) &&
          !placeholderValue(value)
        ) {
          return directLiteral
            ? "literal credential assignment"
            : "literal credential expression";
        }
      }
    }
  }
  const unquotedRecoveryPhraseAssignmentPattern =
    /^[+ -]?\s*(?:(?:export\s+)?(?:const|let|var)\s+|export\s+)?["'`]?([A-Za-z][A-Za-z0-9_-]*)["'`]?\s*[:=]\s*([^"'`\r\n]+?)\s*$/gim;
  for (const match of text.matchAll(unquotedRecoveryPhraseAssignmentPattern)) {
    if (!recoveryPhraseAssignmentKey(match[1])) continue;
    const unquotedValue = unquotedRecoveryPhraseValue(match[2]);
    if (
      recoveryPhraseValue(
        collectionRecoveryPhraseValue(unquotedValue) ?? unquotedValue,
      )
    ) {
      return "literal wallet recovery phrase";
    }
  }
  if (yamlRecoveryPhraseValue(text) !== null) {
    return "literal wallet recovery phrase";
  }
  const genericTokenAssignmentPattern =
    /^[+ -]?\s*["'`]?(token|[a-z][a-z0-9]*(?:_[a-z0-9]+)*_token)["'`]?(\s*[:=]\s*)(["'`]?)([^"'`\r\n]+?)\3[ \t]*(,?)(?:[ \t]+(?:\/\/[^\r\n]*|\/\*[^\r\n]*\*\/)|[ \t]*(?:[#;][^\r\n]*)?)$/gim;
  for (const match of text.matchAll(genericTokenAssignmentPattern)) {
    const key = match[1];
    const operator = match[2];
    const quoted = Boolean(match[3]);
    const value = match[4].trim();
    const trailingComma = match[5] === ",";
    if (
      !quoted &&
      (unquotedCodeExpression(value, trailingComma, operator.includes(":")) ||
        (spacedAssignmentOperator(operator) && hclIterationTraversal(value)) ||
        (operator.includes("=") && shellCommandListValue(value)) ||
        (operator.includes(":") && typeAnnotationValue(value)))
    ) {
      continue;
    }
    if (
      value.length >= CREDENTIAL_LITERAL_MIN_LENGTH &&
      !publicTokenAddressForKey(key, value) &&
      !placeholderValue(value)
    ) {
      return "literal generic token assignment";
    }
  }
  const keyPattern =
    /(?:^|[^A-Za-z0-9_-])([A-Za-z][A-Za-z0-9_-]*)\s*["']?\s*[:=]\s*(["'`])((?:\\.|(?!\2)[^\\\r\n]){12,})\2/gim;
  for (const match of text.matchAll(keyPattern)) {
    const key = match[1];
    const value = match[3].trim();
    if (
      credentialAssignmentKey(key) &&
      !publicTokenAddressForKey(key, value) &&
      !placeholderValue(value)
    )
      return "literal credential assignment";
  }
  const wrappedQuotedKeyPattern =
    /^[+ -]?\s*["'`]?([A-Za-z][A-Za-z0-9_-]*)["'`]?\s*[:=]\s*(.+?)[ \t]*(,?)(?:[ \t]+(?:\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)|[ \t]*(?:[#;][^\r\n]*)?)$/gim;
  for (const match of text.matchAll(wrappedQuotedKeyPattern)) {
    const key = match[1];
    const authorizationKey = normalizeCredentialKey(key) === "authorization";
    const awsCredentialKey = awsCredentialAssignmentKey(key);
    if (
      !authorizationKey &&
      !awsCredentialKey &&
      !credentialAssignmentKey(key)
    ) {
      continue;
    }
    const assignmentValue = stripTrailingExpressionComment(match[2]);
    if (placeholderValue(unwrapBalancedExpression(assignmentValue))) {
      continue;
    }
    const wrappedValue = wrappedQuotedLiteral(assignmentValue);
    const candidates =
      wrappedValue === null
        ? quotedLiteralValues(assignmentValue)
        : [wrappedValue];
    for (const value of candidates) {
      if (authorizationKey) {
        if (literalAuthorizationCredential(value)) {
          return "literal Authorization credential";
        }
        continue;
      }
      if (awsCredentialKey) {
        if (
          value.length >= CREDENTIAL_LITERAL_MIN_LENGTH &&
          !placeholderValue(value)
        ) {
          return "literal AWS credential assignment";
        }
        continue;
      }
      if (
        value.length >= CREDENTIAL_LITERAL_MIN_LENGTH &&
        !publicTokenAddressForKey(key, value) &&
        !placeholderValue(value)
      ) {
        return "literal credential expression";
      }
    }
  }
  const registryAuthPattern =
    /^[+ -]?\s*\/\/[^=\r\n]+\/?:_(?:authToken|auth|password)\s*=\s*["'`]?([^"'`\r\n]+?)["'`]?(?:[ \t]+(?:\/\/[^\r\n]*|\/\*[^\r\n]*\*\/)|[ \t]*(?:[#;][^\r\n]*)?)$/gim;
  for (const match of text.matchAll(registryAuthPattern)) {
    const value = match[1].trim();
    if (
      value.length >= CREDENTIAL_LITERAL_MIN_LENGTH &&
      !placeholderValue(value)
    )
      return "literal registry credential assignment";
  }
  const unquotedKeyPattern =
    /^[+ -]?\s*(?:export\s+)?([A-Za-z][A-Za-z0-9_-]*)(\s*[:=]\s*)([A-Za-z0-9_$+./=:@%!?~^-]{12,})[ \t]*(,?)(?:[ \t]+(?:\/\/[^\r\n]*|\/\*[^\r\n]*\*\/)|[ \t]*(?:[#;][^\r\n]*)?)$/gim;
  for (const match of text.matchAll(unquotedKeyPattern)) {
    const key = match[1];
    const operator = match[2];
    const value = match[3].trim();
    if (
      unquotedCodeExpression(value, match[4] === ",", operator.includes(":")) ||
      (spacedAssignmentOperator(operator) && hclIterationTraversal(value))
    ) {
      continue;
    }
    if (
      credentialAssignmentKey(key) &&
      !publicTokenAddressForKey(key, value) &&
      !placeholderValue(value)
    )
      return "literal credential assignment";
  }
  return null;
}

export function assertNoSecretLikeContent(label, text, options) {
  const reason = secretLikeReason(text, options);
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

export function assertStableEvidencePathAfterRead({
  root,
  candidate,
  rootStat,
  fileStat,
  label,
}) {
  const postReadRoot = realpathSync(root);
  const postReadRootStat = lstatSync(postReadRoot);
  if (
    postReadRoot !== root ||
    !postReadRootStat.isDirectory() ||
    !sameFileIdentity(postReadRootStat, rootStat)
  ) {
    throw new Error(`${label} root changed while it was being read`);
  }
  const postReadResolved = realpathSync(candidate);
  if (!isWithin(postReadResolved, postReadRoot)) {
    throw new Error(`${label} escapes its allowed root after opening`);
  }
  const postReadPathStat = lstatSync(postReadResolved);
  if (
    !postReadPathStat.isFile() ||
    postReadPathStat.isSymbolicLink() ||
    postReadPathStat.nlink !== 1 ||
    postReadPathStat.nlink !== fileStat.nlink ||
    !sameFileIdentity(postReadPathStat, fileStat)
  ) {
    throw new Error(`${label} changed while it was being read`);
  }
  return postReadResolved;
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

  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`${label} root must be a real directory`);
  }
  assertNoSymlinkComponents(root, candidate, label);
  const resolved = realpathSync(candidate);
  if (!isWithin(resolved, root))
    throw new Error(`${label} escapes its allowed root`);
  const pathRisk = sensitivePathReason(displayPath);
  if (pathRisk) throw new Error(`refusing sensitive ${label} (${pathRisk})`);
  const { data, fileStat } = readBoundedRegularFile(resolved, label, maxBytes);
  const postReadResolved = assertStableEvidencePathAfterRead({
    root,
    candidate,
    rootStat,
    fileStat,
    label,
  });
  const content = decodeUtf8(data, label);
  assertNoSecretLikeContent(`${label} ${displayPath}`, content);
  return {
    content,
    displayPath,
    resolved: postReadResolved,
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

// One classifier owns handler-invariant routing for both autoreview and the
// quality gate's data model. Callers receive a detached, deeply frozen view so
// they can derive their own representation without changing later decisions.
const INDEXER_HANDLER_INVARIANT_FAMILIES =
  validateAndFreezeIndexerHandlerInvariantFamilies([
    {
      owner: "abi-runtime-inputs",
      route: true,
      exact: [
        "indexer-envio/abis/BiPoolManager.json",
        "indexer-envio/abis/BreakerBox.json",
        "indexer-envio/abis/Broker.json",
        "indexer-envio/abis/ERC20.json",
        "indexer-envio/abis/FPMM.json",
        "indexer-envio/abis/FPMMFactory.json",
        "indexer-envio/abis/MedianDeltaBreaker.json",
        "indexer-envio/abis/OpenLiquidityStrategy.json",
        "indexer-envio/abis/SortedOracles.json",
        "indexer-envio/abis/Susds.json",
        "indexer-envio/abis/ValueDeltaBreaker.json",
        "indexer-envio/abis/VirtualPoolFactory.json",
        "indexer-envio/abis/liquity/ActivePool.json",
        "indexer-envio/abis/liquity/BorrowerOperations.json",
        "indexer-envio/abis/liquity/CDPLiquidityStrategy.json",
        "indexer-envio/abis/liquity/CollateralRegistry.json",
        "indexer-envio/abis/liquity/DefaultPool.json",
        "indexer-envio/abis/liquity/FXPriceFeed.json",
        "indexer-envio/abis/liquity/ReserveTroveFactory.json",
        "indexer-envio/abis/liquity/StabilityPool.json",
        "indexer-envio/abis/liquity/SystemParams.json",
        "indexer-envio/abis/liquity/TroveManager.json",
        "indexer-envio/abis/liquity/TroveNFT.json",
        "indexer-envio/abis/wormhole/NttManager.json",
        "indexer-envio/abis/wormhole/WormholeTransceiver.json",
      ],
    },
    {
      owner: "config-runtime-inputs",
      route: true,
      exact: [
        "indexer-envio/config/aggregators.json",
        "indexer-envio/config/deployment-namespaces.json",
        "indexer-envio/config/fx-calendar.json",
        "indexer-envio/config/nttAddresses.json",
        "indexer-envio/config/oracle-reporters.json",
        "indexer-envio/config/protocolActors.json",
        "indexer-envio/config/replay-integrity.json",
      ],
    },
    {
      owner: "abi-nonruntime-inputs",
      route: false,
      exact: [
        "indexer-envio/abis/liquity/AddressesRegistry.json",
        "indexer-envio/abis/wormhole/NttDeployHelper.json",
      ],
    },
    {
      owner: "root-runtime-inputs",
      route: true,
      exact: [
        "indexer-envio/config.yaml",
        "indexer-envio/config.multichain.bridge-only.yaml",
        "indexer-envio/config.multichain.mainnet.yaml",
        "indexer-envio/config.multichain.testnet.yaml",
        "indexer-envio/schema.graphql",
      ],
    },
    {
      owner: "test-runtime-inputs",
      route: true,
      exact: [
        "indexer-envio/vitest.config.ts",
        "indexer-envio/vitest.fail-closed.config.ts",
        "indexer-envio/vitest.hermetic-setup.ts",
      ],
    },
    {
      owner: "source-excluded-type-only",
      route: false,
      exact: ["indexer-envio/src/pool/types.ts"],
    },
    {
      owner: "liquity-type-only",
      route: false,
      exact: [
        "indexer-envio/src/handlers/liquity/troveManagerPreloadContext.ts",
      ],
    },
    {
      owner: "wormhole-type-only",
      route: false,
      exact: ["indexer-envio/src/wormhole/handlerContext.ts"],
    },
    {
      owner: "wormhole-warning-only",
      route: false,
      exact: ["indexer-envio/src/wormhole/scratchWarnings.ts"],
    },
    {
      owner: "wormhole-runtime",
      route: true,
      exact: [
        "indexer-envio/src/wormhole/chainIds.ts",
        "indexer-envio/src/wormhole/detail.ts",
        "indexer-envio/src/wormhole/nttAddresses.ts",
        "indexer-envio/src/wormhole/pairing.ts",
        "indexer-envio/src/wormhole/status.ts",
      ],
    },
    {
      owner: "handler-modules",
      route: true,
      exact: [
        "indexer-envio/src/handlers/biPoolManager.ts",
        "indexer-envio/src/handlers/breakerBox.ts",
        "indexer-envio/src/handlers/broker.ts",
        "indexer-envio/src/handlers/feeToken.ts",
        "indexer-envio/src/handlers/fpmm.ts",
        "indexer-envio/src/handlers/fpmm/factory.ts",
        "indexer-envio/src/handlers/fpmm/limits-and-fees.ts",
        "indexer-envio/src/handlers/fpmm/liquidity.ts",
        "indexer-envio/src/handlers/fpmm/oracle-recovery.ts",
        "indexer-envio/src/handlers/fpmm/state-sync.ts",
        "indexer-envio/src/handlers/liquity/batchReplay.ts",
        "indexer-envio/src/handlers/liquity/bootstrap.ts",
        "indexer-envio/src/handlers/liquity/bootstrapHandler.ts",
        "indexer-envio/src/handlers/liquity/borrowerOperations.ts",
        "indexer-envio/src/handlers/liquity/borrowingRevenue.ts",
        "indexer-envio/src/handlers/liquity/cdpLiquidityStrategy.ts",
        "indexer-envio/src/handlers/liquity/collateralRegistry.ts",
        "indexer-envio/src/handlers/liquity/config.ts",
        "indexer-envio/src/handlers/liquity/instance.ts",
        "indexer-envio/src/handlers/liquity/keys.ts",
        "indexer-envio/src/handlers/liquity/math.ts",
        "indexer-envio/src/handlers/liquity/operations.ts",
        "indexer-envio/src/handlers/liquity/pendingOperations.ts",
        "indexer-envio/src/handlers/liquity/pools.ts",
        "indexer-envio/src/handlers/liquity/priceFeed.ts",
        "indexer-envio/src/handlers/liquity/reserveTroveFactory.ts",
        "indexer-envio/src/handlers/liquity/stabilityPool.ts",
        "indexer-envio/src/handlers/liquity/stabilityPoolLoss.ts",
        "indexer-envio/src/handlers/liquity/systemParams.ts",
        "indexer-envio/src/handlers/liquity/troveManager.ts",
        "indexer-envio/src/handlers/liquity/troveManagerPreload.ts",
        "indexer-envio/src/handlers/liquity/troveManagerTransitions.ts",
        "indexer-envio/src/handlers/liquity/troveNFT.ts",
        "indexer-envio/src/handlers/liquity/troveOperationSnapshot.ts",
        "indexer-envio/src/handlers/liquity/troveUpdates.ts",
        "indexer-envio/src/handlers/liquity/troves.ts",
        "indexer-envio/src/handlers/medianDeltaBreaker.ts",
        "indexer-envio/src/handlers/openLiquidityStrategy.ts",
        "indexer-envio/src/handlers/oracleExpiryState.ts",
        "indexer-envio/src/handlers/oracleFeedState.ts",
        "indexer-envio/src/handlers/rateFeed.ts",
        "indexer-envio/src/handlers/sortedOracles.ts",
        "indexer-envio/src/handlers/stables/bootstrap.ts",
        "indexer-envio/src/handlers/stables/classifyKind.ts",
        "indexer-envio/src/handlers/stables/config.ts",
        "indexer-envio/src/handlers/stables/custody.ts",
        "indexer-envio/src/handlers/stables/custodyState.ts",
        "indexer-envio/src/handlers/stables/dailyFlush.ts",
        "indexer-envio/src/handlers/stables/feeLeg.ts",
        "indexer-envio/src/handlers/stables/transfer.ts",
        "indexer-envio/src/handlers/steth.ts",
        "indexer-envio/src/handlers/steth/dailySnapshots.ts",
        "indexer-envio/src/handlers/steth/movements.ts",
        "indexer-envio/src/handlers/steth/positions.ts",
        "indexer-envio/src/handlers/steth/shared.ts",
        "indexer-envio/src/handlers/susds/dailySnapshots.ts",
        "indexer-envio/src/handlers/susds/movements.ts",
        "indexer-envio/src/handlers/susds/positions.ts",
        "indexer-envio/src/handlers/susds/shared.ts",
        "indexer-envio/src/handlers/susdsEvents.ts",
        "indexer-envio/src/handlers/valueDeltaBreaker.ts",
        "indexer-envio/src/handlers/virtualPool.ts",
        "indexer-envio/src/handlers/wormhole/nttManager.ts",
        "indexer-envio/src/handlers/wormhole/wormholeTransceiver.ts",
      ],
    },
    {
      owner: "rpc-effects",
      route: true,
      exact: [
        "indexer-envio/src/rpc/biPoolManager.ts",
        "indexer-envio/src/rpc/block-fallback.ts",
        "indexer-envio/src/rpc/block.ts",
        "indexer-envio/src/rpc/breakers.ts",
        "indexer-envio/src/rpc/client.ts",
        "indexer-envio/src/rpc/effects.ts",
        "indexer-envio/src/rpc/http-test-mock-bridge.ts",
        "indexer-envio/src/rpc/http-test-mocks.ts",
        "indexer-envio/src/rpc/median-timestamp-effect.ts",
        "indexer-envio/src/rpc/oracle-report-timestamps-effect.ts",
        "indexer-envio/src/rpc/oracle-state.ts",
        "indexer-envio/src/rpc/pool-fees.ts",
        "indexer-envio/src/rpc/pool-state.ts",
        "indexer-envio/src/rpc/stable-fetchers.ts",
        "indexer-envio/src/rpc/stables.ts",
        "indexer-envio/src/rpc/steth.ts",
        "indexer-envio/src/rpc/susds.ts",
        "indexer-envio/src/rpc/tracked-effect.ts",
      ],
    },
    {
      owner: "pool-runtime",
      route: true,
      exact: [
        "indexer-envio/src/pool/health.ts",
        "indexer-envio/src/pool/oracle-rollup.ts",
        "indexer-envio/src/pool/self-heal.ts",
        "indexer-envio/src/pool/snapshots.ts",
        "indexer-envio/src/pool/sources.ts",
        "indexer-envio/src/pool/upsert-stages.ts",
      ],
    },
    {
      owner: "rpc-logging-only",
      route: false,
      exact: ["indexer-envio/src/rpc/log.ts"],
    },
    {
      owner: "source-runtime",
      route: true,
      exact: [
        "indexer-envio/src/EventHandlers.ts",
        "indexer-envio/src/EventHandlersBridgeOnly.ts",
        "indexer-envio/src/abis.ts",
        "indexer-envio/src/aggregators.ts",
        "indexer-envio/src/bridge.ts",
        "indexer-envio/src/breakers.ts",
        "indexer-envio/src/constants.ts",
        "indexer-envio/src/contractAddresses.ts",
        "indexer-envio/src/deviationBreach.ts",
        "indexer-envio/src/env.ts",
        "indexer-envio/src/feeToken.ts",
        "indexer-envio/src/healthScore.ts",
        "indexer-envio/src/helpers.ts",
        "indexer-envio/src/indexer.ts",
        "indexer-envio/src/liquidityStrategies.ts",
        "indexer-envio/src/oracleExpiryState.ts",
        "indexer-envio/src/oracleFeedState.ts",
        "indexer-envio/src/oracleJump.ts",
        "indexer-envio/src/oracleReporters.ts",
        "indexer-envio/src/oracleSnapshotRetention.ts",
        "indexer-envio/src/performance.ts",
        "indexer-envio/src/pool.ts",
        "indexer-envio/src/priceDifference.ts",
        "indexer-envio/src/protocol-actors.ts",
        "indexer-envio/src/protocolFeeSnapshot.ts",
        "indexer-envio/src/rpc.ts",
        "indexer-envio/src/startupChecks.ts",
        "indexer-envio/src/swap.ts",
        "indexer-envio/src/tradingLimits.ts",
        "indexer-envio/src/usd.ts",
        "indexer-envio/src/volumeSnapshots.ts",
        "indexer-envio/src/volumeWindowFlush.ts",
        "indexer-envio/src/volumeWindowSnapshot.ts",
      ],
    },
    {
      owner: "test-excluded",
      route: false,
      exact: [
        "indexer-envio/test/aggregators-parity.test.ts",
        "indexer-envio/test/deployment-namespaces.test.ts",
        "indexer-envio/test/oracle-reporters-parity.test.ts",
        "indexer-envio/test/script-findings.test.ts",
        "indexer-envio/test/wormholeScratchWarnings.test.ts",
      ],
    },
    {
      owner: "test-invariant-support",
      route: true,
      exact: [
        "indexer-envio/test/helpers/eventFixtures.ts",
        "indexer-envio/test/helpers/httpRpc.ts",
        "indexer-envio/test/helpers/indexerTestHarness.ts",
        "indexer-envio/test/helpers/makePool.ts",
        "indexer-envio/test/hermeticGuard.test.ts",
        "indexer-envio/test/setup/publish-test-rpc.ts",
      ],
    },
    {
      owner: "invariant-tests",
      route: true,
      exact: [
        "indexer-envio/test/aggregators.test.ts",
        "indexer-envio/test/biPoolManager.test.ts",
        "indexer-envio/test/blockFallback.test.ts",
        "indexer-envio/test/breakerBootstrapBackoff.test.ts",
        "indexer-envio/test/breakerHaltSync.test.ts",
        "indexer-envio/test/breakerHandlers.test.ts",
        "indexer-envio/test/breakerScenarios.test.ts",
        "indexer-envio/test/breakers.test.ts",
        "indexer-envio/test/bridge.test.ts",
        "indexer-envio/test/bridgeHandlers.test.ts",
        "indexer-envio/test/broker.test.ts",
        "indexer-envio/test/code-quality-invariants.test.ts",
        "indexer-envio/test/config-contracts.test.ts",
        "indexer-envio/test/crossChainNamespacing.test.ts",
        "indexer-envio/test/dailySnapshot.test.ts",
        "indexer-envio/test/decimals.test.ts",
        "indexer-envio/test/deviationBreach.test.ts",
        "indexer-envio/test/deviationThresholdSharedConfigSync.test.ts",
        "indexer-envio/test/dynamicRegistration.test.ts",
        "indexer-envio/test/effects.test.ts",
        "indexer-envio/test/feeUpdated.test.ts",
        "indexer-envio/test/feeTokenAllowlist.test.ts",
        "indexer-envio/test/feeTokenSharedConfigSync.test.ts",
        "indexer-envio/test/fetchFees.test.ts",
        "indexer-envio/test/fixtures/failClosedSortedOracles.case.ts",
        "indexer-envio/test/fpmmBatchOrdering.test.ts",
        "indexer-envio/test/fx-calendar.test.ts",
        "indexer-envio/test/getPoolsByFeed.test.ts",
        "indexer-envio/test/healthScore.test.ts",
        "indexer-envio/test/healthStatusParity.test.ts",
        "indexer-envio/test/hyperRpcToken.test.ts",
        "indexer-envio/test/liquidityStrategies.test.ts",
        "indexer-envio/test/liquity.test.ts",
        "indexer-envio/test/liquityBatchReplayIdempotency.test.ts",
        "indexer-envio/test/liquityTroveLifecycle.test.ts",
        "indexer-envio/test/medianTimestampEffects.test.ts",
        "indexer-envio/test/openLiquidityStrategy.test.ts",
        "indexer-envio/test/oracle-rollup.test.ts",
        "indexer-envio/test/oracleExpiryState.test.ts",
        "indexer-envio/test/oracleFeedState.test.ts",
        "indexer-envio/test/oracleFeedStateFailClosed.test.ts",
        "indexer-envio/test/oracleFeedStateHandlers.test.ts",
        "indexer-envio/test/oracleJump.test.ts",
        "indexer-envio/test/oracleReportedMedianParity.test.ts",
        "indexer-envio/test/oracleSnapshotRetention.test.ts",
        "indexer-envio/test/performance.test.ts",
        "indexer-envio/test/pool-helpers.test.ts",
        "indexer-envio/test/pool.test.ts",
        "indexer-envio/test/poolDailyFeeSnapshot.test.ts",
        "indexer-envio/test/priceDifference.test.ts",
        "indexer-envio/test/protocol-actors.test.ts",
        "indexer-envio/test/protocol-fees.test.ts",
        "indexer-envio/test/protocolFeeSnapshot.property.test.ts",
        "indexer-envio/test/rateFeedDependencies.test.ts",
        "indexer-envio/test/rateFeedHandlers.test.ts",
        "indexer-envio/test/rebalancedUsd.test.ts",
        "indexer-envio/test/rpc-fetchers.test.ts",
        "indexer-envio/test/rpcClient.test.ts",
        "indexer-envio/test/self-heal.test.ts",
        "indexer-envio/test/snapshots.test.ts",
        "indexer-envio/test/stables.test.ts",
        "indexer-envio/test/stablesFeeLeg.test.ts",
        "indexer-envio/test/stateSyncReconcile.test.ts",
        "indexer-envio/test/steth.test.ts",
        "indexer-envio/test/susds.test.ts",
        "indexer-envio/test/swap.test.ts",
        "indexer-envio/test/swap-reserves.test.ts",
        "indexer-envio/test/startBlockInvariant.test.ts",
        "indexer-envio/test/tradingLimitConfigChange.test.ts",
        "indexer-envio/test/tradingLimits.test.ts",
        "indexer-envio/test/upsertPoolIdempotency.test.ts",
        "indexer-envio/test/upsertPoolStages.test.ts",
        "indexer-envio/test/usd.test.ts",
        "indexer-envio/test/volumeSnapshots.test.ts",
        "indexer-envio/test/volumeWindowSnapshot.property.test.ts",
        "indexer-envio/test/volumeWindowSnapshot.test.ts",
        "indexer-envio/test/wormholeCompleteFlow.test.ts",
        "indexer-envio/test/wrappedExchangeGate.test.ts",
      ],
    },
    {
      owner: "future-typescript",
      route: false,
      fallback: {
        prefixes: ["indexer-envio/src/", "indexer-envio/test/"],
        extensions: ["ts", "tsx", "mts", "cts"],
      },
    },
  ]);

function indexerRoutingFamilyError(message) {
  throw new Error(
    `invalid indexer handler invariant routing families: ${message}`,
  );
}

function assertIndexerRoutingStringList(value, where) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || entry === "")
  ) {
    indexerRoutingFamilyError(`${where} must be a non-empty string array`);
  }
  if (new Set(value).size !== value.length) {
    indexerRoutingFamilyError(`${where} contains a duplicate`);
  }
}

function isCanonicalIndexerRoutingPath(value) {
  return (
    /^[A-Za-z0-9._/@+-]+$/.test(value) &&
    value.startsWith("indexer-envio/") &&
    !value.startsWith("/") &&
    !value.includes("//") &&
    !value.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function isCanonicalIndexerRoutingFilePath(value) {
  return isCanonicalIndexerRoutingPath(value) && !value.endsWith("/");
}

function validateIndexerHandlerInvariantRoutingFamilies(families) {
  if (!Array.isArray(families) || families.length === 0) {
    indexerRoutingFamilyError("the family list must be non-empty");
  }

  const owners = new Set();
  const explicitFamilies = [];
  const fallbackFamilies = [];
  for (const [index, family] of families.entries()) {
    const where = `family ${index}`;
    if (
      family === null ||
      typeof family !== "object" ||
      Array.isArray(family)
    ) {
      indexerRoutingFamilyError(`${where} must be an object`);
    }
    const allowedKeys = new Set(["owner", "route", "exact", "fallback"]);
    const unknownKeys = Object.keys(family).filter(
      (key) => !allowedKeys.has(key),
    );
    if (unknownKeys.length > 0) {
      indexerRoutingFamilyError(
        `${where} has unknown keys: ${unknownKeys.join(", ")}`,
      );
    }
    if (typeof family.owner !== "string" || family.owner.trim() === "") {
      indexerRoutingFamilyError(`${where}.owner must be a non-empty string`);
    }
    if (owners.has(family.owner)) {
      indexerRoutingFamilyError(`owner ${family.owner} is duplicated`);
    }
    owners.add(family.owner);
    if (typeof family.route !== "boolean") {
      indexerRoutingFamilyError(`${where}.route must be boolean`);
    }

    const strategies = ["exact", "fallback"].filter(
      (key) => family[key] !== undefined,
    );
    if (strategies.length !== 1) {
      indexerRoutingFamilyError(
        `${where} must define exactly one of exact or fallback`,
      );
    }

    if (family.exact !== undefined) {
      assertIndexerRoutingStringList(family.exact, `${where}.exact`);
      if (
        family.exact.some((entry) => !isCanonicalIndexerRoutingFilePath(entry))
      ) {
        indexerRoutingFamilyError(
          `${where}.exact contains a noncanonical or Bash-unsafe literal path`,
        );
      }
      explicitFamilies.push(family);
      continue;
    }

    const fallback = family.fallback;
    if (
      fallback === null ||
      typeof fallback !== "object" ||
      Array.isArray(fallback) ||
      Object.keys(fallback).sort().join(",") !== "extensions,prefixes"
    ) {
      indexerRoutingFamilyError(
        `${where}.fallback must define only prefixes and extensions`,
      );
    }
    assertIndexerRoutingStringList(
      fallback.prefixes,
      `${where}.fallback.prefixes`,
    );
    assertIndexerRoutingStringList(
      fallback.extensions,
      `${where}.fallback.extensions`,
    );
    const requiredPrefixes = ["indexer-envio/src/", "indexer-envio/test/"];
    const requiredExtensions = ["ts", "tsx", "mts", "cts"];
    if (
      fallback.prefixes.some(
        (prefix) =>
          !prefix.endsWith("/") || !isCanonicalIndexerRoutingPath(prefix),
      ) ||
      fallback.extensions.some((extension) => !/^[a-z0-9]+$/.test(extension)) ||
      fallback.prefixes.length !== requiredPrefixes.length ||
      requiredPrefixes.some((prefix) => !fallback.prefixes.includes(prefix)) ||
      fallback.extensions.length !== requiredExtensions.length ||
      requiredExtensions.some(
        (extension) => !fallback.extensions.includes(extension),
      )
    ) {
      indexerRoutingFamilyError(
        `${where}.fallback must define only the canonical src/test TypeScript scope`,
      );
    }
    if (family.route) {
      indexerRoutingFamilyError(`${where}.fallback must remain unclassified`);
    }
    fallbackFamilies.push(family);
  }

  if (fallbackFamilies.length !== 1) {
    indexerRoutingFamilyError("exactly one future fallback family is required");
  }

  const exactPaths = explicitFamilies.flatMap(({ exact = [] }) => exact);
  for (const candidatePath of exactPaths) {
    const matches = explicitFamilies.filter((family) =>
      matchesIndexerHandlerInvariantFamily(family, candidatePath),
    );
    if (matches.length !== 1) {
      indexerRoutingFamilyError(
        `explicit path ${candidatePath} has ${matches.length} owners: ${matches
          .map(({ owner }) => owner)
          .join(", ")}`,
      );
    }
  }

  return families;
}

function validateAndFreezeIndexerHandlerInvariantFamilies(families) {
  validateIndexerHandlerInvariantRoutingFamilies(families);
  return deepFreezeIndexerRoutingValue(families);
}

function deepFreezeIndexerRoutingValue(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreezeIndexerRoutingValue(nested);
    }
  }
  return value;
}

function copyIndexerHandlerInvariantFamily(family) {
  return {
    owner: family.owner,
    route: family.route,
    ...(family.exact === undefined ? {} : { exact: [...family.exact] }),
    ...(family.fallback === undefined
      ? {}
      : {
          fallback: {
            prefixes: [...family.fallback.prefixes],
            extensions: [...family.fallback.extensions],
          },
        }),
  };
}

export function getIndexerHandlerInvariantRoutingFamilies() {
  return deepFreezeIndexerRoutingValue(
    INDEXER_HANDLER_INVARIANT_FAMILIES.map(copyIndexerHandlerInvariantFamily),
  );
}

function matchesIndexerHandlerInvariantFamily(family, candidatePath) {
  return family.exact?.includes(candidatePath) ?? false;
}

function matchesIndexerHandlerInvariantFallback(family, candidatePath) {
  return (
    family.fallback !== undefined &&
    family.fallback.prefixes.some((prefix) =>
      candidatePath.startsWith(prefix),
    ) &&
    family.fallback.extensions.some((extension) =>
      candidatePath.endsWith(`.${extension}`),
    )
  );
}

function getIndexerHandlerInvariantDecision(candidatePath, families) {
  const matches = families.filter(
    (family) =>
      family.fallback === undefined &&
      matchesIndexerHandlerInvariantFamily(family, candidatePath),
  );
  if (matches.length > 1) {
    throw new Error(
      `indexer handler invariant families overlap for ${candidatePath}: ${matches
        .map(({ owner }) => owner)
        .join(", ")}`,
    );
  }
  if (matches.length === 1) {
    return {
      path: candidatePath,
      route: matches[0].route,
      owner: matches[0].owner,
    };
  }

  const fallbacks = families.filter((family) =>
    matchesIndexerHandlerInvariantFallback(family, candidatePath),
  );
  if (fallbacks.length > 1) {
    throw new Error(
      `indexer handler invariant fallbacks overlap for ${candidatePath}: ${fallbacks
        .map(({ owner }) => owner)
        .join(", ")}`,
    );
  }
  if (fallbacks.length === 1) {
    return {
      path: candidatePath,
      route: fallbacks[0].route,
      owner: fallbacks[0].owner,
    };
  }
  return {
    path: candidatePath,
    route: false,
    owner: "outside-indexer-handler-invariant-scope",
  };
}

export function getIndexerHandlerInvariantChecklistDecisions(paths) {
  if (
    !Array.isArray(paths) ||
    paths.some((candidatePath) => typeof candidatePath !== "string")
  ) {
    throw new TypeError(
      "indexer handler invariant paths must be an array of strings",
    );
  }
  const families = getIndexerHandlerInvariantRoutingFamilies();
  return paths.map((candidatePath) =>
    getIndexerHandlerInvariantDecision(candidatePath, families),
  );
}
