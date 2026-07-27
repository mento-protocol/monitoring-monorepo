function heredocDelimiters(line) {
  const delimiters = [];
  let quote;
  let escaped = false;
  let parameterExpansionDepth = 0;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "$" && line[index + 1] === "{") {
      parameterExpansionDepth += 1;
      index += 1;
      continue;
    }
    if (parameterExpansionDepth > 0) {
      if (character === "{") parameterExpansionDepth += 1;
      if (character === "}") parameterExpansionDepth -= 1;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/u.test(line[index - 1])))
      break;
    if (character !== "<" || line[index + 1] !== "<") continue;
    if (line[index + 2] === "<") {
      index += 2;
      continue;
    }
    let delimiterIndex = index + 2;
    const stripTabs = line[delimiterIndex] === "-";
    if (stripTabs) delimiterIndex += 1;
    while (/\s/u.test(line[delimiterIndex])) delimiterIndex += 1;
    if (!line[delimiterIndex]) continue;
    let delimiter = "";
    const delimiterQuote = line[delimiterIndex];
    if (delimiterQuote === "'" || delimiterQuote === '"') {
      delimiterIndex += 1;
      while (
        delimiterIndex < line.length &&
        line[delimiterIndex] !== delimiterQuote
      ) {
        delimiter += line[delimiterIndex];
        delimiterIndex += 1;
      }
      if (line[delimiterIndex] !== delimiterQuote) continue;
    } else {
      while (
        delimiterIndex < line.length &&
        !/[\s;|&<>()]/u.test(line[delimiterIndex])
      ) {
        delimiter += line[delimiterIndex];
        delimiterIndex += 1;
      }
    }
    if (!delimiter) continue;
    delimiters.push({ delimiter, stripTabs });
    index = delimiterIndex;
  }
  return delimiters;
}

export function executableShellLines(contents) {
  const lines = [];
  const pendingHeredocs = [];
  for (const line of contents.split(/\r?\n/u)) {
    if (pendingHeredocs.length > 0) {
      const { delimiter, stripTabs } = pendingHeredocs[0];
      const candidate = stripTabs ? line.replace(/^\t+/u, "") : line;
      if (candidate === delimiter) pendingHeredocs.shift();
      continue;
    }
    lines.push(line);
    pendingHeredocs.push(...heredocDelimiters(line));
  }
  return lines;
}
