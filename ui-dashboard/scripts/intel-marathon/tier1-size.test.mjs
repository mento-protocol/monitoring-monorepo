import { readFileSync } from "node:fs";
import { Linter } from "eslint";
import { expect, it } from "vitest";

// Dashboard ESLint excludes .mjs files. Enforce its effective-line cap here.
const linter = new Linter();
const config = {
  rules: {
    "max-lines": [
      "error",
      { max: 1000, skipBlankLines: true, skipComments: true },
    ],
  },
};

it.each(["bulk-enrich", "discovery", "quota", "writes", "progress"])(
  "keeps tier1-%s below the 1,000 effective-line cap",
  (name) => {
    const source = readFileSync(
      new URL(`./tier1-${name}.mjs`, import.meta.url),
      "utf8",
    );
    expect(linter.verify(source, config)).toEqual([]);
  },
);
