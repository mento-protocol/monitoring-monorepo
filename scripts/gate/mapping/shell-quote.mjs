/**
 * Bash's `printf %q`, reproduced.
 *
 * Several routed commands interpolate a changed path — `bash -n {path}`,
 * `node --check {path}`, the targeted Trunk invocation, the ADR reminder's
 * `--changed-paths-file` — and the gate builds every one of them through
 * `quote_path`, which is `printf %q`. The command string is what the freshness
 * stamp hashes and what the self-test asserts on, so "close enough" quoting is
 * a different command: a plan that differs from the gate's by one backslash is
 * a plan whose stamp never matches and whose parity run reds.
 *
 * MEASURED, not inferred, on `/bin/bash` 3.2.57 and `/opt/homebrew/bin/bash`
 * 5.3.15 — both agree exactly:
 *
 *   unescaped   A-Z a-z 0-9 and . / - _ # ~ = : @ % +   (and any byte >= 0x80)
 *   escaped     space ' " $ * [ ] ( ) & ; | \ ! , ^ { } < > ?
 *   empty       ''
 *   control     ANSI-C form, e.g. a newline gives $'a\nb'
 *
 * `#` and `~` are NOT escaped mid-string, which is the detail a hand-written
 * "escape anything unusual" implementation gets wrong; `,` and `^` ARE, which
 * is the detail a "shell metacharacters only" implementation gets wrong.
 * `shell-quote.test.mjs` asks bash itself rather than trusting this comment.
 */

/** Characters bash leaves alone inside `%q`. */
const SAFE = /[A-Za-z0-9._/\-#~=:@%+]/;

/** The ANSI-C escapes bash emits inside `$'…'`. */
const ANSI_C = new Map([
  ["\x07", "\\a"],
  ["\b", "\\b"],
  ["\f", "\\f"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
  ["\v", "\\v"],
  ["\\", "\\\\"],
  ["'", "\\'"],
]);

const isControl = (character) => {
  const code = character.codePointAt(0);
  return code < 0x20 || code === 0x7f;
};

/**
 * Quote one string the way `printf %q` would.
 *
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  if (value === "") return "''";

  // A control character forces the whole word into ANSI-C quoting; bash does
  // not mix the two forms.
  if ([...value].some(isControl)) {
    let body = "";
    for (const character of value) {
      if (ANSI_C.has(character)) {
        body += ANSI_C.get(character);
      } else if (isControl(character)) {
        body += `\\${character.codePointAt(0).toString(8).padStart(3, "0")}`;
      } else {
        body += character;
      }
    }
    return `$'${body}'`;
  }

  let quoted = "";
  for (const character of value) {
    // Anything outside ASCII is passed through, matching both measured builds.
    const passthrough = SAFE.test(character) || character.codePointAt(0) > 0x7f;
    quoted += passthrough ? character : `\\${character}`;
  }
  return quoted;
}
