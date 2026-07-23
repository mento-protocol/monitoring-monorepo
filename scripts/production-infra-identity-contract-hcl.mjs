export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function maskHclComments(contents) {
  const characters = [...contents];
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    const next = characters[index + 1];

    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
      } else {
        characters[index] = " ";
      }
      continue;
    }

    if (blockComment) {
      if (character === "*" && next === "/") {
        characters[index] = " ";
        characters[index + 1] = " ";
        blockComment = false;
        index += 1;
      } else if (character !== "\n") {
        characters[index] = " ";
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "#") {
      characters[index] = " ";
      lineComment = true;
    } else if (character === "/" && next === "/") {
      characters[index] = " ";
      characters[index + 1] = " ";
      lineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      characters[index] = " ";
      characters[index + 1] = " ";
      blockComment = true;
      index += 1;
    }
  }

  return characters.join("");
}

function maskHeredocBodies(contents) {
  const lines = contents.split(/(?<=\n)/u);
  let delimiter;

  return lines
    .map((line) => {
      if (delimiter) {
        const isEnd = new RegExp(
          `^\\s*${escapeRegExp(delimiter)}\\s*(?:\\r?\\n)?$`,
          "u",
        ).test(line);
        if (isEnd) {
          delimiter = undefined;
          return line.replace(/[^\r\n]/gu, " ");
        }
        return line.replace(/[^\r\n]/gu, " ");
      }

      const start = line.match(/<<-?([A-Za-z_][A-Za-z0-9_]*)/u);
      if (start) delimiter = start[1];
      return line;
    })
    .join("");
}

function findMatchingDelimiter(contents, openingIndex, open, close) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = openingIndex; index < contents.length; index += 1) {
    const character = contents[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === open) {
      depth += 1;
    } else if (character === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }

  return contents.length;
}

export function terraformResourceBlocks(files, requestedType) {
  const blocks = [];
  const resourceStart = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/gu;

  for (const [filePath, contents] of Object.entries(files)) {
    if (!filePath.endsWith(".tf")) continue;

    const commentMasked = maskHclComments(contents);
    const structural = maskHeredocBodies(commentMasked);
    for (const match of structural.matchAll(resourceStart)) {
      const [fullMatch, type, name] = match;
      if (requestedType && type !== requestedType) continue;
      const openingBrace = match.index + fullMatch.lastIndexOf("{");
      const end = findMatchingDelimiter(structural, openingBrace, "{", "}");
      blocks.push({
        filePath,
        type,
        name,
        text: contents.slice(match.index, end),
        code: commentMasked.slice(match.index, end),
      });
    }
  }

  return blocks;
}

export function nestedBlocks(block, requestedType) {
  if (!block) return [];
  const structural = maskHeredocBodies(block.code);
  const outerOpeningBrace = structural.indexOf("{");
  if (outerOpeningBrace === -1) return [];

  const blocks = [];
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = outerOpeningBrace; index < structural.length; index += 1) {
    const character = structural[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      continue;
    }
    if (character !== "{") continue;

    if (depth === 1) {
      const lineStart = structural.lastIndexOf("\n", index - 1) + 1;
      const header = structural.slice(lineStart, index).trim();
      if (header === requestedType) {
        const end = findMatchingDelimiter(structural, index, "{", "}");
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

export function expectMapEntry(block, key, value, errors, label) {
  const pattern = new RegExp(
    `^\\s*"${escapeRegExp(key)}"\\s*=\\s*"${escapeRegExp(value)}"\\s*$`,
    "gmu",
  );
  if ([...block.code.matchAll(pattern)].length !== 1) {
    errors.push(`${label}: must map ${key} exactly from ${value}`);
  }
}

export function extractStringSet(contents, localName) {
  const code = maskHclComments(contents);
  const startPattern = new RegExp(
    `\\b${escapeRegExp(localName)}\\s*=\\s*toset\\s*\\(\\s*\\[`,
    "gu",
  );
  const matches = [...code.matchAll(startPattern)];
  if (matches.length !== 1) return undefined;
  const openingBracket = matches[0].index + matches[0][0].lastIndexOf("[");
  const end = findMatchingDelimiter(code, openingBracket, "[", "]");
  if (end === code.length) return undefined;
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
  const end = findMatchingDelimiter(block.code, openingBrace, "{", "}");
  if (end === block.code.length) return undefined;
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
  const end = findMatchingDelimiter(block.code, openingBracket, "[", "]");
  if (end === block.code.length) return undefined;
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
