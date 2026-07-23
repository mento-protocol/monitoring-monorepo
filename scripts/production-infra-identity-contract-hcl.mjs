export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function heredocStartAt(contents, index) {
  const match = /^<<-?([A-Za-z_][A-Za-z0-9_]*)(?=[ \t\r\n]|$)/u.exec(
    contents.slice(index),
  );
  return match
    ? {
        delimiter: match[1],
      }
    : undefined;
}

function maskNonNewlines(target, contents, start, end) {
  for (let index = start; index < end; index += 1) {
    if (contents[index] !== "\r" && contents[index] !== "\n") {
      target[index] = " ";
    }
  }
}

function isTemplateExpressionStart(contents, index) {
  const marker = contents[index];
  if (!["$", "%"].includes(marker) || contents[index + 1] !== "{") {
    return false;
  }
  let markerCount = 1;
  for (
    let cursor = index - 1;
    cursor >= 0 && contents[cursor] === marker;
    cursor -= 1
  ) {
    markerCount += 1;
  }
  return markerCount % 2 === 1;
}

function analyzeHcl(contents) {
  const commentMasked = contents.split("");
  const structural = contents.split("");
  const delimiters = contents.split("");
  const contexts = [{ type: "expression" }];
  let templateDepth = 0;
  let lineComment = false;
  let blockComment = false;
  let heredoc;
  let pendingHeredoc;

  for (let index = 0; index < contents.length; index += 1) {
    if (heredoc) {
      const newlineIndex = contents.indexOf("\n", index);
      const lineEnd = newlineIndex === -1 ? contents.length : newlineIndex + 1;
      const line = contents.slice(index, lineEnd);
      const isEnd = new RegExp(
        `^[ \\t]*${escapeRegExp(heredoc.delimiter)}[ \\t]*(?:\\r?\\n)?$`,
        "u",
      ).test(line);
      maskNonNewlines(structural, contents, index, lineEnd);
      maskNonNewlines(delimiters, contents, index, lineEnd);
      if (isEnd) heredoc = undefined;
      index = lineEnd - 1;
      continue;
    }

    const character = contents[index];
    const next = contents[index + 1];
    const context = contexts.at(-1);
    if (templateDepth > 0 && character !== "\r" && character !== "\n") {
      delimiters[index] = " ";
    }

    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        if (pendingHeredoc) {
          heredoc = pendingHeredoc;
          pendingHeredoc = undefined;
        }
      } else {
        commentMasked[index] = " ";
        structural[index] = " ";
        delimiters[index] = " ";
      }
      continue;
    }

    if (blockComment) {
      if (character === "*" && next === "/") {
        commentMasked[index] = " ";
        commentMasked[index + 1] = " ";
        structural[index] = " ";
        structural[index + 1] = " ";
        delimiters[index] = " ";
        delimiters[index + 1] = " ";
        blockComment = false;
        index += 1;
      } else if (character !== "\n") {
        commentMasked[index] = " ";
        structural[index] = " ";
        delimiters[index] = " ";
      } else if (pendingHeredoc) {
        heredoc = pendingHeredoc;
        pendingHeredoc = undefined;
      }
      continue;
    }

    if (context.type === "template") {
      if (context.escaped) {
        context.escaped = false;
      } else if (character === "\\") {
        context.escaped = true;
      } else if (isTemplateExpressionStart(contents, index)) {
        delimiters[index + 1] = " ";
        contexts.push({ type: "expression", braceDepth: 1 });
        index += 1;
      } else if (character === '"') {
        contexts.pop();
        templateDepth -= 1;
      }
      continue;
    }

    if (character === '"') {
      delimiters[index] = " ";
      contexts.push({ type: "template", escaped: false });
      templateDepth += 1;
    } else if (character === "#") {
      commentMasked[index] = " ";
      structural[index] = " ";
      delimiters[index] = " ";
      lineComment = true;
    } else if (character === "/" && next === "/") {
      commentMasked[index] = " ";
      commentMasked[index + 1] = " ";
      structural[index] = " ";
      structural[index + 1] = " ";
      delimiters[index] = " ";
      delimiters[index + 1] = " ";
      lineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      commentMasked[index] = " ";
      commentMasked[index + 1] = " ";
      structural[index] = " ";
      structural[index + 1] = " ";
      delimiters[index] = " ";
      delimiters[index + 1] = " ";
      blockComment = true;
      index += 1;
    } else if (character === "<" && next === "<") {
      pendingHeredoc = heredocStartAt(contents, index) ?? pendingHeredoc;
    } else if (context.braceDepth && character === "{") {
      context.braceDepth += 1;
    } else if (context.braceDepth && character === "}") {
      context.braceDepth -= 1;
      if (context.braceDepth === 0) contexts.pop();
    } else if (character === "\n" && pendingHeredoc) {
      heredoc = pendingHeredoc;
      pendingHeredoc = undefined;
    }
  }

  return {
    commentMasked: commentMasked.join(""),
    structural: structural.join(""),
    delimiters: delimiters.join(""),
    unterminatedHeredoc: heredoc ?? pendingHeredoc,
    unterminatedTemplate:
      contexts.length > 1 ? contexts.at(-1).type : undefined,
    unterminatedBlockComment: blockComment,
  };
}

export function commentMaskedHcl(contents) {
  return analyzeHcl(contents).commentMasked;
}

export function structuralHcl(contents) {
  return analyzeHcl(contents).structural;
}

function delimiterHcl(contents) {
  return analyzeHcl(contents).delimiters;
}

function findMatchingDelimiter(contents, openingIndex, open, close) {
  let depth = 0;

  for (let index = openingIndex; index < contents.length; index += 1) {
    const character = contents[index];
    if (character === open) {
      depth += 1;
    } else if (character === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }

  return undefined;
}

export function terraformTopLevelBlocks(files, errors = []) {
  const blocks = [];
  const blockStart =
    /(?:^|\n)[ \t\uFEFF]*([A-Za-z_][A-Za-z0-9_-]*)(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s+"((?:[^"\\]|\\.)*)")?\s*\{/gu;

  for (const [filePath, contents] of Object.entries(files)) {
    if (filePath.endsWith(".tf.json")) {
      errors.push(
        `${filePath}: Terraform JSON configuration is forbidden by the production identity contract`,
      );
      continue;
    }
    if (!filePath.endsWith(".tf")) continue;

    const analysis = analyzeHcl(contents);
    if (analysis.unterminatedHeredoc) {
      errors.push(
        `${filePath}: unterminated HCL heredoc ${analysis.unterminatedHeredoc.delimiter}`,
      );
    }
    if (analysis.unterminatedTemplate) {
      errors.push(
        `${filePath}: unterminated HCL ${analysis.unterminatedTemplate}`,
      );
    }
    if (analysis.unterminatedBlockComment) {
      errors.push(`${filePath}: unterminated HCL block comment`);
    }

    blockStart.lastIndex = 0;
    for (let match = blockStart.exec(analysis.structural); match; ) {
      const [fullMatch, kind, firstRaw, secondRaw] = match;
      const start = match.index + (fullMatch.startsWith("\n") ? 1 : 0);
      const openingBrace = match.index + fullMatch.lastIndexOf("{");
      const end = findMatchingDelimiter(
        analysis.delimiters,
        openingBrace,
        "{",
        "}",
      );
      if (end === undefined) {
        errors.push(`${filePath}: unterminated top-level ${kind} block`);
        break;
      }
      const labels = [firstRaw, secondRaw]
        .filter((label) => label !== undefined)
        .map((label) => JSON.parse(`"${label}"`));
      blocks.push({
        filePath,
        kind,
        labels,
        type: kind === "resource" ? labels[0] : kind,
        name: kind === "resource" ? labels[1] : (labels[0] ?? kind),
        start,
        end,
        text: contents.slice(start, end),
        code: analysis.structural.slice(start, end),
      });
      blockStart.lastIndex = end;
      match = blockStart.exec(analysis.structural);
    }
  }

  return blocks;
}

export function terraformResourceBlocks(files, requestedType, errors = []) {
  return terraformTopLevelBlocks(files, errors).filter(
    (block) =>
      block.kind === "resource" &&
      (!requestedType || block.type === requestedType),
  );
}

export function nestedBlocks(block, requestedType) {
  if (!block) return [];
  const analysis = analyzeHcl(block.code);
  const structural = analysis.structural;
  const delimiters = analysis.delimiters;
  const outerOpeningBrace = structural.indexOf("{");
  if (outerOpeningBrace === -1) return [];

  const blocks = [];
  let depth = 0;

  for (let index = outerOpeningBrace; index < delimiters.length; index += 1) {
    const character = delimiters[index];
    if (character === "}") {
      depth -= 1;
      continue;
    }
    if (character !== "{") continue;

    if (depth === 1) {
      const lineStart = structural.lastIndexOf("\n", index - 1) + 1;
      const header = structural.slice(lineStart, index).trim();
      if (header === requestedType) {
        const end = findMatchingDelimiter(delimiters, index, "{", "}");
        if (end === undefined) continue;
        blocks.push({
          filePath: block.filePath,
          type: requestedType,
          name: requestedType,
          text: block.text.slice(lineStart, end),
          code: block.code.slice(lineStart, end),
        });
      }
    }
    depth += 1;
  }

  return blocks;
}

export function blockKey(block) {
  return `${block.filePath}:${block.type}.${block.name}`;
}

export function topLevelBlockKey(block) {
  const suffix = block.labels.length > 0 ? `.${block.labels.join(".")}` : "";
  return `${block.filePath}:${block.kind}${suffix}`;
}

export function requireBlock(blocks, filePath, type, name, errors, label) {
  const matches = blocks.filter(
    (block) =>
      block.filePath === filePath && block.type === type && block.name === name,
  );
  if (matches.length === 0) {
    errors.push(`${label}: required resource ${type}.${name} is missing`);
  } else if (matches.length > 1) {
    errors.push(
      `${label}: resource ${type}.${name} must be declared exactly once`,
    );
  }
  return matches[0];
}

function attributeExpressions(block, attribute) {
  if (!block) return [];
  const pattern = new RegExp(
    `^\\s*${escapeRegExp(attribute)}\\s*=\\s*(.*?)\\s*$`,
    "gmu",
  );
  return [...block.code.matchAll(pattern)].map((match) => match[1].trim());
}

export function expectNoResourceMultiplicity(block, errors, label) {
  const metaArguments = ["count", "for_each"].filter(
    (attribute) => attributeExpressions(block, attribute).length > 0,
  );
  if (metaArguments.length > 0) {
    errors.push(
      `${label}: resource multiplicity is forbidden (${metaArguments.join(", ")})`,
    );
  }
}

export function attributeExpression(block, attribute) {
  return attributeExpressions(block, attribute)[0];
}

export function parseHclString(expression) {
  if (!expression?.startsWith('"') || !expression.endsWith('"')) {
    return undefined;
  }
  try {
    return JSON.parse(expression);
  } catch {
    return undefined;
  }
}

export function stringAttribute(block, attribute) {
  return parseHclString(attributeExpression(block, attribute));
}

export function normalizeExpression(value) {
  return value?.replace(/\s+/gu, " ").trim();
}

export function expectExpression(block, attribute, expected, errors, label) {
  const expressions = attributeExpressions(block, attribute);
  if (
    expressions.length !== 1 ||
    normalizeExpression(expressions[0]) !== normalizeExpression(expected)
  ) {
    errors.push(`${label}: ${attribute} must be exactly ${expected}`);
  }
}

export function expectString(block, attribute, expected, errors, label) {
  const expressions = attributeExpressions(block, attribute);
  if (expressions.length !== 1 || parseHclString(expressions[0]) !== expected) {
    errors.push(`${label}: ${attribute} must be exactly "${expected}"`);
  }
}

function exactStringMapAttribute(block, attribute) {
  if (!block) return undefined;
  const analysis = analyzeHcl(block.code);
  const assignmentPattern = new RegExp(
    `(?:^|\\n)[ \\t\\uFEFF]*${escapeRegExp(attribute)}[ \\t]*=[ \\t]*`,
    "gu",
  );
  const outerOpeningBrace = analysis.delimiters.indexOf("{");
  if (outerOpeningBrace === -1) return undefined;

  const assignments = [
    ...analysis.structural.matchAll(assignmentPattern),
  ].filter((match) => {
    const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
    let depth = 0;
    for (let index = outerOpeningBrace; index < start; index += 1) {
      if (analysis.delimiters[index] === "{") depth += 1;
      if (analysis.delimiters[index] === "}") depth -= 1;
    }
    return depth === 1;
  });
  if (assignments.length !== 1) return undefined;

  const assignment = assignments[0];
  const openingBrace = assignment.index + assignment[0].length;
  if (analysis.delimiters[openingBrace] !== "{") return undefined;
  const end = findMatchingDelimiter(
    analysis.delimiters,
    openingBrace,
    "{",
    "}",
  );
  if (end === undefined) return undefined;

  const lineEnd = analysis.structural.indexOf("\n", end);
  const trailing = analysis.structural.slice(
    end,
    lineEnd === -1 ? analysis.structural.length : lineEnd,
  );
  if (trailing.trim() !== "") return undefined;
  const following = analysis.structural.slice(end);
  const nextTokenOffset = following.search(/\S/u);
  if (nextTokenOffset !== -1) {
    const nextToken = end + nextTokenOffset;
    if (analysis.delimiters[nextToken] !== "}") {
      const nextLineStart =
        analysis.structural.lastIndexOf("\n", nextToken - 1) + 1;
      const nextLine = analysis.structural.slice(nextToken);
      if (
        analysis.structural.slice(nextLineStart, nextToken).trim() !== "" ||
        !/^[A-Za-z_][A-Za-z0-9_-]*(?:[ \t]+[^={\s]+)*[ \t]*(?:=|\{)/u.test(
          nextLine,
        )
      ) {
        return undefined;
      }
    }
  }

  const body = analysis.structural.slice(openingBrace + 1, end - 1);
  const entryPattern =
    /"((?:[^"\\]|\\.)*)"[ \t\r\n]*=[ \t\r\n]*"((?:[^"\\]|\\.)*)"[ \t\r\n]*,?/gu;
  const entries = [...body.matchAll(entryPattern)];
  const residue = body.replace(entryPattern, "").replace(/\s+/gu, "");
  if (residue !== "") return undefined;

  const mapping = Object.create(null);
  for (const entry of entries) {
    const key = parseHclString(`"${entry[1]}"`);
    const value = parseHclString(`"${entry[2]}"`);
    if (
      key === undefined ||
      value === undefined ||
      Object.hasOwn(mapping, key)
    ) {
      return undefined;
    }
    mapping[key] = value;
  }
  return mapping;
}

export function expectExactStringMap(
  block,
  attribute,
  expected,
  errors,
  label,
) {
  const actual = exactStringMapAttribute(block, attribute);
  if (
    !actual ||
    Object.keys(actual).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => actual[key] !== value)
  ) {
    errors.push(`${label}: ${attribute} must be exactly the registered map`);
  }
}

export function extractStringSet(contents, localName) {
  const code = structuralHcl(contents);
  const delimiters = delimiterHcl(code);
  const startPattern = new RegExp(
    `\\b${escapeRegExp(localName)}\\s*=\\s*toset\\s*\\(\\s*\\[`,
    "gu",
  );
  const matches = [...code.matchAll(startPattern)];
  if (matches.length !== 1) return undefined;
  const openingBracket = matches[0].index + matches[0][0].lastIndexOf("[");
  const end = findMatchingDelimiter(delimiters, openingBracket, "[", "]");
  if (end === undefined) return undefined;
  const body = code.slice(openingBracket + 1, end - 1);
  const values = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((match) =>
    JSON.parse(`"${match[1]}"`),
  );
  const residue = body
    .replace(/"((?:[^"\\]|\\.)*)"/gu, "")
    .replace(/[\s,]/gu, "");
  return residue === "" ? values : undefined;
}

export function extractForEachMap(block) {
  const match = /\bfor_each\s*=\s*\{/u.exec(block?.code ?? "");
  if (!match) return undefined;
  const openingBrace = match.index + match[0].lastIndexOf("{");
  const end = findMatchingDelimiter(
    delimiterHcl(block.code),
    openingBrace,
    "{",
    "}",
  );
  if (end === undefined) return undefined;
  const body = block.code.slice(openingBrace + 1, end - 1);
  const entries = new Map();
  let residue = body;
  const entryPattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\r\n]+?)\s*$/gmu;
  for (const matchEntry of body.matchAll(entryPattern)) {
    if (entries.has(matchEntry[1])) return undefined;
    entries.set(matchEntry[1], normalizeExpression(matchEntry[2]));
    residue = residue.replace(matchEntry[0], "");
  }
  return residue.trim() === "" ? entries : undefined;
}

export function extractExpressionList(block, attribute) {
  const startPattern = new RegExp(
    `\\b${escapeRegExp(attribute)}\\s*=\\s*\\[`,
    "gu",
  );
  const matches = [...(block?.code ?? "").matchAll(startPattern)];
  if (matches.length !== 1) return undefined;
  const openingBracket = matches[0].index + matches[0][0].lastIndexOf("[");
  const end = findMatchingDelimiter(
    delimiterHcl(block.code),
    openingBracket,
    "[",
    "]",
  );
  if (end === undefined) return undefined;
  const body = block.code.slice(openingBracket + 1, end - 1);
  const values = body
    .split(",")
    .map((value) => normalizeExpression(value))
    .filter(Boolean);
  return values.every((value) => /^[A-Za-z0-9_.]+$/u.test(value))
    ? values
    : undefined;
}

export function sameSortedValues(actual, expected) {
  return (
    actual &&
    actual.length === expected.length &&
    [...actual]
      .sort()
      .every((value, index) => value === [...expected].sort()[index])
  );
}

export function sameMap(actual, expected) {
  return (
    actual &&
    actual.size === Object.keys(expected).length &&
    Object.entries(expected).every(
      ([key, value]) => actual.get(key) === normalizeExpression(value),
    )
  );
}

export function requireFile(files, filePath, errors) {
  const contents = files[filePath];
  if (typeof contents !== "string") {
    errors.push(`${filePath}: file is required by the identity contract`);
    return "";
  }
  return contents;
}
