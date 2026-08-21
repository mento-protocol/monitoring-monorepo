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
export function casePatternToRegExp(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      // `[\s\S]*`, not `.*`: `.` excludes newline, and a path may contain one.
      source += "[\\s\\S]*";
      continue;
    }
    if (character === "?") {
      source += "[\\s\\S]";
      continue;
    }
    if (character === "\\") {
      const escaped = pattern[index + 1];
      if (escaped === undefined) {
        throw new Error(
          `pattern \`${pattern}\` ends in a backslash with nothing to escape`,
        );
      }
      source += escapeLiteral(escaped);
      index += 1;
      continue;
    }
    if (character === "[") {
      const bracket = readBracket(pattern, index);
      if (bracket === null) {
        // Unterminated: bash matches a literal `[`.
        source += "\\[";
        continue;
      }
      source += bracket.regexp;
      index = bracket.end;
      continue;
    }
    source += escapeLiteral(character);
  }
  return new RegExp(`${source}$`);
}

/** Whether `pattern` contains any `case` metacharacter at all. */
export const isGlob = (pattern) => /[*?[\\]/.test(pattern);

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
