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
 * 5.3.15 over every printable ASCII character in seven positions — alone, at
 * the start, at the end, mid-word, and after `=`, `:` and `/`:
 *
 *   unescaped   A-Z a-z 0-9 and . / - _ # ~ = : @ % +
 *   escaped     space ' " $ * [ ] ( ) & ; | \ ! , ^ { } < > ?
 *   empty       ''
 *   control     ANSI-C form, e.g. a newline gives $'a\nb' and ESC gives $'a\Eb'
 *
 * `#` and `~` are NOT escaped mid-string, which is the detail a hand-written
 * "escape anything unusual" implementation gets wrong; `,` and `^` ARE, which
 * is the detail a "shell metacharacters only" implementation gets wrong.
 *
 * TWO CHARACTERS DEPEND ON POSITION, and the measurement is the only way to
 * know it:
 *
 *   - A LEADING `#` is escaped by both builds — `#file` gives `\#file`. It has
 *     to be: an unescaped `#` opening a word comments out the rest of the
 *     command.
 *   - A `~` where a tilde expansion could START — index 0, or straight after
 *     `=` or `:` — is escaped by 5.3.15 and left alone by 3.2.57. The two
 *     builds DISAGREE, so there is no single string to emit, and `shellQuote`
 *     refuses rather than guessing. See the refusal below.
 *
 * A byte >= 0x80 is the same shape of problem one level out: the answer depends
 * on the LOCALE, not on the build. Measured, `printf %q` of `aéb` gives
 * `$'a\303\251b'` under `LC_ALL=C` and `aéb` under `LC_ALL=en_US.UTF-8` on both
 * builds — and with the locale unset, 3.2.57 escapes where 5.3.15 does not. The
 * retained `--pre-push` compatibility path can run with a stripped environment,
 * so both answers are reachable on one machine. `shellQuote` refuses those too.
 * No tracked path in this repository carries a non-ASCII byte.
 *
 * `shell-quote.test.mjs` asks bash itself rather than trusting this comment.
 */

/** Characters bash leaves alone inside `%q`. */
const SAFE = /[A-Za-z0-9._/\-#~=:@%+]/;

/**
 * True where a `~` could begin a tilde expansion, and the supported bash
 * builds therefore answer differently.
 *
 * Measured: `~`, `~x`, `a=~b` and `a:~b` are escaped by 5.3.15 and untouched by
 * 3.2.57, while `a~b`, `x~` and `a/~b` are untouched by both.
 */
const tildeIsAmbiguous = (value, index) =>
  value[index] === "~" &&
  (index === 0 || value[index - 1] === "=" || value[index - 1] === ":");

/** The one shape of failure this module has: two answers, so neither. */
const refusal = (value, why) => {
  const error = new Error(
    `cannot reproduce printf %q for ${JSON.stringify(value)}: ${why}`,
  );
  error.exitCode = 2;
  return error;
};

/**
 * The ANSI-C escapes bash emits inside `$'…'`.
 *
 * ESC is the one that is not guessable from the C escape table: bash's
 * `ansic_quote` carries `case ESC: c = 'E'`, so 0x1b comes back as `\E` rather
 * than as the octal `\033` every other unnamed control character gets.
 * Measured on 3.2.57 and 5.3.15 — both agree, in both locales.
 */
const ANSI_C = new Map([
  ["\x07", "\\a"],
  ["\b", "\\b"],
  ["\f", "\\f"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
  ["\v", "\\v"],
  ["\x1b", "\\E"],
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

  // REFUSE rather than pick a side. The gate's own quoting is whatever bash is
  // running it, under whatever locale it inherited, so a guess here is a
  // command string that matches the gate on one machine and not on another — a
  // plan whose freshness stamp never lands and whose parity is a coin flip. No
  // path in this repository holds either shape.
  for (let index = 0; index < value.length; index += 1) {
    if (tildeIsAmbiguous(value, index)) {
      throw refusal(
        value,
        "bash 3.2 leaves a leading-position `~` alone and bash 5.3 escapes it, so the quoted form depends on which bash runs the gate",
      );
    }
    if (value.codePointAt(index) > 0x7f) {
      throw refusal(
        value,
        "a byte >= 0x80 is octal-escaped under LC_ALL=C and passed through under a UTF-8 locale, so the quoted form depends on the environment the gate inherited",
      );
    }
  }

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
  let first = true;
  for (const character of value) {
    // Anything outside ASCII is passed through, matching both measured builds.
    const safe = SAFE.test(character) || character.codePointAt(0) > 0x7f;
    // A `#` opening the word is the one SAFE character that is not safe there.
    const passthrough = safe && !(first && character === "#");
    quoted += passthrough ? character : `\\${character}`;
    first = false;
  }
  return quoted;
}
