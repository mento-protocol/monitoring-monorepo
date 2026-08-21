/**
 * Compile a bash `case` pattern to a JavaScript regular expression.
 *
 * WHY THIS IS HAND-WRITTEN, AND WHY IT MUST STAY THAT WAY
 *
 * A bash `case` pattern is not a filesystem glob, and the difference is not
 * academic. Verified on `/bin/bash` 3.2.57(1)-release, the floor this repo
 * supports: `*` and `?` BOTH match `/`, and there is no globstar. So
 * `scripts/*.sh` matches `scripts/repo-health/dev-janitor.sh`, `*.md` matches
 * every file under `docs/`, and `a?b` matches `a/b`.
 *
 * `picomatch`, `minimatch` and `fast-glob` all default to pathname semantics,
 * where `*` stops at `/`. Compiling this table with any of them would silently
 * NARROW every arm: the gate would map fewer commands, exit 0, and print "All
 * mapped commands passed." while checks it used to run quietly stopped running.
 * That is the exact failure class ADR 0064 records four times over. No glob
 * library may be introduced here, however convenient.
 *
 * Because a hand-written translator is only as good as its proof, its test uses
 * `/bin/bash` ITSELF as the oracle over every pattern in the table crossed with
 * a large path corpus — see `pattern-oracle.test.mjs`.
 */

/**
 * Every character that is special to a JavaScript regular expression.
 *
 * `*`, `?`, `[` and `\` are in the list even though the compiler handles them
 * as metacharacters, because a backslash escape (`\*`) routes the character
 * they escape through here as a literal — and a `*` that reached the output
 * unescaped would silently widen the arm it came from.
 */
const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\/-]/g;

const escapeLiteral = (text) => text.replace(REGEXP_SPECIAL, "\\$&");

/**
 * POSIX character classes are valid inside a bash bracket expression and have
 * no JavaScript equivalent that is faithful under every locale. Nothing in the
 * table uses one, so the compiler refuses rather than approximating: an
 * approximation here would be a matcher that disagrees with the shell on paths
 * nobody thought to test.
 */
const POSIX_CLASS = /\[[:.=]/;

/**
 * Read a bracket expression starting at `start` (the `[`).
 *
 * Returns the compiled class and the index of its closing `]`, or `null` when
 * there is no closing bracket — which bash treats as a literal `[`.
 */
function readBracket(pattern, start) {
  let index = start + 1;
  let negated = false;
  if (pattern[index] === "!" || pattern[index] === "^") {
    negated = true;
    index += 1;
  }
  // A `]` immediately after the (optional) negation is a literal member, not
  // the terminator. Both bash and POSIX say so, and getting it wrong turns
  // `[]]` into an unterminated class.
  let body = "";
  if (pattern[index] === "]") {
    body += "\\]";
    index += 1;
  }
  for (; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "]") {
      return { regexp: `[${negated ? "^" : ""}${body}]`, end: index };
    }
    if (character === "\\") {
      // MEASURED, not assumed. Inside a bracket expression bash treats `\` as an
      // ESCAPE, not as the literal member POSIX specifies: on both 3.2.57 and
      // 5.3.15, `[\]]` matches `]`, `[\a]` matches `a` and not `\`, and `[a\]`
      // matches nothing at all because the `\]` escapes the terminator and
      // leaves the class unterminated.
      //
      // That last shape is why this refuses rather than implements. Getting the
      // first two right is easy; getting "unterminated because the terminator
      // was escaped" right, and keeping it right, is a subtlety no pattern in
      // this table needs — nothing here uses a bracket expression at all. A
      // compiler that half-understands a shape is the failure this whole
      // conversion exists to remove, so the shape is refused at the door and the
      // measurement is recorded here for whoever needs it later.
      throw new Error(
        `bracket expression in \`${pattern}\` contains a backslash. Bash treats it as an escape inside brackets, not as a literal member, and an escaped \`]\` leaves the class unterminated; this compiler refuses the shape rather than approximate it. No pattern in this table needs one.`,
      );
    }
    if (POSIX_CLASS.test(pattern.slice(index, index + 2))) {
      throw new Error(
        `bracket expression in \`${pattern}\` uses a POSIX class; this compiler refuses to approximate one, because an approximation would disagree with the shell on inputs no test happened to cover`,
      );
    }
    // `-` keeps its range meaning; everything else that is special to a
    // JavaScript character class is escaped.
    body += character === "-" ? "-" : character.replace(/[\\^\]]/g, "\\$&");
  }
  return null;
}

/**
 * Compile one bash `case` pattern.
 *
 * @param {string} pattern
 * @returns {RegExp} anchored at both ends, because `case` matches whole words
 */
/**
 * Scan a pattern ONCE, returning both what it compiles to and whether any
 * character in it actually acted as a metacharacter.
 *
 * One scanner with two consumers, deliberately. `isGlob` used to be an
 * independent regular expression over the raw text, and it disagreed with the
 * compiler on exactly the shapes where being wrong costs something: an escaped
 * metacharacter (`scripts/foo\*.mjs`) is an EXACT path that the compiler treats
 * as a literal but the old test called a glob, and an unmatched `[` (`a[b`) is
 * a literal to the compiler and was a glob to the test. Either misreading makes
 * an exact path invisible to the staleness check and to the pairing rule, and
 * feeds the oracle a synthetic path for a pattern that has no wildcards. Two
 * implementations of one question will drift; there is now only one.
 *
 * @param {string} pattern
 * @returns {{ source: string, hasMeta: boolean }}
 */
function scanPattern(pattern) {
  let source = "^";
  let hasMeta = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      // `[\s\S]*`, not `.*`: `.` excludes newline, and a path may contain one.
      source += "[\\s\\S]*";
      hasMeta = true;
      continue;
    }
    if (character === "?") {
      source += "[\\s\\S]";
      hasMeta = true;
      continue;
    }
    if (character === "\\") {
      const escaped = pattern[index + 1];
      if (escaped === undefined) {
        throw new Error(
          `pattern \`${pattern}\` ends in a backslash with nothing to escape`,
        );
      }
      // An escape produces a LITERAL, so it does not make the pattern a glob.
      source += escapeLiteral(escaped);
      index += 1;
      continue;
    }
    if (character === "[") {
      const bracket = readBracket(pattern, index);
      if (bracket === null) {
        // Unterminated: bash matches a literal `[`, so this is not a glob either.
        source += "\\[";
        continue;
      }
      source += bracket.regexp;
      hasMeta = true;
      index = bracket.end;
      continue;
    }
    source += escapeLiteral(character);
  }
  return { source: `${source}$`, hasMeta };
}

/**
 * Compile one bash `case` pattern.
 *
 * @param {string} pattern
 * @returns {RegExp} anchored at both ends, because `case` matches whole words
 */
export function casePatternToRegExp(pattern) {
  return new RegExp(scanPattern(pattern).source);
}

/**
 * Whether `pattern` holds a character that actually acts as a wildcard.
 *
 * Answered by the compiler's own scan, never by a separate regular expression
 * over the raw text — see `scanPattern`. A pattern this cannot compile is not a
 * pattern at all, and the caller has to hear about that rather than receive a
 * boolean.
 */
export const isGlob = (pattern) => scanPattern(pattern).hasMeta;

/**
 * The filesystem path a LITERAL pattern names.
 *
 * A pattern and a path are not the same string. `scripts/foo\*.mjs` is an exact
 * path whose name contains a star, and `app/\[id\]/page.tsx` is how a Next.js
 * dynamic-route directory has to be written so its brackets are not read as a
 * character class. Both are literals — `isGlob` says so — but asking the
 * filesystem about the pattern text asks about a file with backslashes in its
 * name, which never exists, and the staleness check would report every such arm
 * stale forever.
 *
 * Stripping one level of escaping is exactly what bash does to a literal
 * pattern before matching, so this is the same transformation, not a guess.
 * Only meaningful for a pattern `isGlob` calls a literal; a glob has no single
 * path to name.
 *
 * @param {string} pattern
 * @returns {string}
 */
export function literalPatternPath(pattern) {
  let path = "";
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === "\\" && index + 1 < pattern.length) {
      index += 1;
    }
    path += pattern[index];
  }
  return path;
}

/**
 * Reject a pattern this table must never hold, before anything compiles it.
 *
 * @param {string} pattern
 * @returns {string | null} the reason it is malformed, or null
 */
export function patternProblem(pattern) {
  if (typeof pattern !== "string") return "is not a string";
  if (pattern === "") return "is empty";
  if (pattern.trim() !== pattern) return "carries leading or trailing space";
  if (pattern.includes("|")) {
    return "contains `|`, which separates arms rather than belonging to one pattern";
  }
  if (pattern.includes('"') || pattern.includes("'")) return "contains a quote";
  try {
    casePatternToRegExp(pattern);
  } catch (error) {
    return error.message;
  }
  return null;
}
