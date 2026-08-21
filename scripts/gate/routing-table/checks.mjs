/**
 * The two checks the data conversion exists to make possible.
 *
 * Both enforce rules that ADR 0064 states as prose and nothing enforces today.
 * The pairing lint is pure over the table and therefore runs at import, beside
 * the schema. The staleness check reads the tree, so it belongs to the test
 * suite: the gate runs against throwaway fixture repositories that own none of
 * these files, and a check that consulted the filesystem at import would fail
 * every fixture run for the wrong reason.
 */

import { isGlob } from "./pattern.mjs";
import { MIN_REASON, literalPatterns, walkArms } from "./schema.mjs";

const SCRIPTS = "scripts/";

/** The any-depth sibling ADR 0064 requires beside a `scripts/`-anchored pattern. */
export function pairedSibling(pattern) {
  if (!pattern.startsWith(SCRIPTS)) return null;
  const basename = pattern.slice(pattern.lastIndexOf("/") + 1);
  if (basename === "") return null;
  return `${SCRIPTS}*/${basename}`;
}

/**
 * A pattern anchored on a LITERAL PREFIX at the top of `scripts/` — the shape
 * ADR 0064 names: `scripts/deploy-*.sh`, `scripts/sentry-*.test.mjs`. It stops
 * matching the moment the file it names sits one directory down, and NOTHING
 * REDS when it does; the arm's extra commands simply stop being scheduled.
 *
 * An exact path is deliberately not in this shape. A move makes an exact
 * pattern STALE, and the staleness check reds loudly on that — which is a
 * better guarantee than pairing, not a weaker one. The prefix glob is the case
 * staleness cannot see, because a glob keeps matching something.
 */
function isLiteralPrefixGlob(pattern) {
  if (!pattern.startsWith(SCRIPTS)) return false;
  const rest = pattern.slice(SCRIPTS.length);
  if (rest.includes("/")) return false;
  const prefix = rest.slice(0, rest.search(/[*?[]/));
  return isGlob(rest) && prefix.length > 0;
}

/**
 * ADR 0064's pairing rule, mechanised.
 *
 * Two obligations, and the second is the one that keeps the first honest over
 * time:
 *
 * 1. A literal-prefix glob under `scripts/` must carry its any-depth sibling —
 *    `scripts/` then a star, a slash, and the same basename — in the same arm,
 *    or say in the arm why it deliberately does not.
 * 2. An arm that DOES carry a pair must declare `pairing: "paired"`. Without
 *    this a later edit can delete the sibling and leave a green table: the glob
 *    still matches the file where it lives today, the run still looks routed,
 *    and only a future move goes quiet. "Leaving one unpaired below a widened
 *    glob is the worst case, not the safe one" — ADR 0064.
 *
 * @param {object[]} groups normalized groups, with the raw arms alongside
 * @returns {string[]} one message per violation; empty means clean
 */
export function pairingProblems(rawGroups) {
  const problems = [];
  for (const { groupId, arm } of walkArms(rawGroups)) {
    const patterns = arm.patterns;
    const pairs = patterns.filter((pattern) => {
      const sibling = pairedSibling(pattern);
      return (
        sibling !== null && sibling !== pattern && patterns.includes(sibling)
      );
    });
    const unpaired = patterns.filter(
      (pattern) =>
        isLiteralPrefixGlob(pattern) &&
        !patterns.includes(pairedSibling(pattern)),
    );

    if (unpaired.length > 0 && arm.pairing !== "deliberately-unpaired") {
      problems.push(
        `group \`${groupId}\`, arm [${patterns.join(" | ")}]: ` +
          `${unpaired.map((pattern) => `\`${pattern}\``).join(", ")} is a literal-prefix glob at the top of scripts/ ` +
          `with no \`${pairedSibling(unpaired[0])}\` sibling in this arm. ` +
          "It stops matching one directory down and nothing reds when it does (ADR 0064). " +
          'Add the sibling, or set `pairing: "deliberately-unpaired"` with a `why` that says which move it is accepting.',
      );
    }
    if (pairs.length > 0 && arm.pairing === undefined) {
      problems.push(
        `group \`${groupId}\`, arm [${patterns.join(" | ")}]: ` +
          `carries the any-depth pair for ${pairs.map((pattern) => `\`${pattern}\``).join(", ")} ` +
          'but does not declare `pairing: "paired"`. Declaring it is what stops a later edit deleting the sibling unnoticed.',
      );
    }
    if (arm.pairing === "paired" && pairs.length === 0) {
      problems.push(
        `group \`${groupId}\`, arm [${patterns.join(" | ")}]: ` +
          'declares `pairing: "paired"` but holds no `scripts/*/…` sibling for any of its patterns.',
      );
    }
    if (arm.pairing === "deliberately-unpaired" && unpaired.length === 0) {
      problems.push(
        `group \`${groupId}\`, arm [${patterns.join(" | ")}]: ` +
          'declares `pairing: "deliberately-unpaired"` but holds no unpaired literal-prefix glob.',
      );
    }
    // The opt-out has to cost something. A bare flag would let anyone suppress
    // the rule this table exists to enforce with one word and no argument, and
    // the next reader would have no way to tell a considered exception from a
    // lint someone silenced. The reason is the exception.
    if (
      arm.pairing === "deliberately-unpaired" &&
      (typeof arm.why !== "string" || arm.why.trim().length < MIN_REASON)
    ) {
      problems.push(
        `group \`${groupId}\`, arm [${patterns.join(" | ")}]: ` +
          'declares `pairing: "deliberately-unpaired"` without a `why` that says which move it accepts. ' +
          `The reason must be at least ${MIN_REASON} characters — a flag on its own is not an exception, it is a silenced check.`,
      );
    }
  }
  return problems;
}

/**
 * Every path the table asserts exists: literal patterns, the repo-relative
 * paths named inside the commands the table schedules, and the checklists it
 * points a reviewer at.
 *
 * The three fail differently, and the quiet ones are why this exists. A stale
 * literal PATTERN is invisible — a `case` arm naming a deleted path simply
 * never matches, and no check reds. A stale path inside a scheduled COMMAND
 * fails loudly the moment that command runs. A stale CHECKLIST is the quietest
 * of the three: it is only ever printed as a reminder, so a renamed
 * `docs/pr-checklists/*.md` leaves the gate pointing every reviewer at a
 * document that is not there and nothing anywhere reds.
 *
 * `allowStale: "<reason>"` on an arm exempts that arm's literal patterns. ADR
 * 0064 documents the legitimate case — a pre-move probe path held until no open
 * PR bases on a pre-move tree — and this table adds one more: a config file the
 * repo does not carry today but routes correctly the day someone adds it.
 *
 * @param {readonly object[]} groups the raw table
 * @returns {{ path: string, groupId: string, kind: string, command?: string }[]}
 */
export function stalenessSubjects(groups) {
  const subjects = [];
  const exempt = new Set();
  for (const { arm } of walkArms(groups)) {
    for (const pattern of exemptedLiterals(arm)) exempt.add(pattern);
  }
  for (const [pattern, groupId] of literalPatterns(groups)) {
    if (exempt.has(pattern)) continue;
    subjects.push({ path: pattern, groupId, kind: "pattern" });
  }
  for (const { groupId, arm } of walkArms(groups)) {
    for (const effect of arm.effects ?? []) {
      collectEffectPaths(effect, groupId, subjects);
    }
  }
  return subjects;
}

/**
 * The literal patterns an `allowStale` arm exempts.
 *
 * Only the literals, because only literals are staleness subjects in the first
 * place. An arm whose exempted patterns are ALL globs exempts nothing, and the
 * "is this exemption still doing something" check would be inert on it: asking
 * whether a glob exists on disk is a question with a constant answer, so an
 * exemption checked that way could never be retired.
 *
 * @param {object} arm
 * @returns {string[]}
 */
export function exemptedLiterals(arm) {
  if (typeof arm.allowStale !== "string") return [];
  return arm.patterns.filter((pattern) => !isGlob(pattern));
}

/**
 * Repo-relative paths inside a scheduled command.
 *
 * Only tokens that look like a path AND carry a directory separator count. A
 * bare `package.json` in a command line is nearly always an argument to a tool
 * rather than a file the arm names, and demanding it exist would make the check
 * noisy exactly where it needs to be believed.
 */
const COMMAND_PATH =
  /(?:^|\s)((?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+\.[A-Za-z]+)(?=\s|$)/g;

function collectEffectPaths(effect, groupId, subjects) {
  if (Object.hasOwn(effect, "when")) {
    for (const nested of effect.effects) {
      collectEffectPaths(nested, groupId, subjects);
    }
    return;
  }
  if (Object.hasOwn(effect, "dispatch")) {
    // Nested arms are visited by `walkArms`, which reaches their effects on its
    // own pass; recursing here as well would double-count every path.
    return;
  }
  const checklist =
    effect.checklist ??
    (effect.verb === "add_checklist" ? effect.args[0] : undefined);
  if (checklist !== undefined) {
    subjects.push({ path: checklist, groupId, kind: "checklist" });
  }
  const command =
    effect.command ??
    effect.preflight ??
    (effect.verb === "add_command" || effect.verb === "add_preflight_command"
      ? effect.args[0]
      : undefined);
  if (command === undefined) return;
  // A templated command carries the changed path, which exists by construction
  // — the arm that schedules it is guarded on `[[ -f "$path" ]]`.
  if (command.includes("{path}")) return;
  for (const match of command.matchAll(COMMAND_PATH)) {
    subjects.push({ path: match[1], groupId, kind: "command", command });
  }
}
