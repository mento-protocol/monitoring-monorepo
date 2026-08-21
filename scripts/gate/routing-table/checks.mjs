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

import { PATH_TOKEN } from "./gate-arms.mjs";
import { isGlob } from "./pattern.mjs";
import { MIN_REASON, walkArms } from "./schema.mjs";

const SCRIPTS = "scripts/";

/**
 * Refuse a table that has already been through `normalizeGroups`.
 *
 * Both lints read fields the normal form deliberately DROPS — `pairing`,
 * `allowStale`, `why`. Handed a normalized table they would find none of them,
 * see no violations, and return "clean". A lint that reports clean because it
 * was looking at the wrong shape is worse than no lint: it is a green light
 * nobody has any reason to doubt. So the shape is checked rather than
 * documented.
 *
 * The discriminator is exact. `normalizeEffect` stamps every effect with a
 * `kind`, and the schema refuses `kind` as an unknown field on a raw effect, so
 * the two shapes can never be confused for one another. A table with no effects
 * at all is refused too — there is nothing there to have linted.
 *
 * STRUCTURE IS VALIDATED BEFORE TRAVERSAL, not assumed. `walkArms` silently
 * skips anything that is not the shape it expects, so a primitive where an
 * effect should be, or an arm with no `effects` array, would be walked past and
 * the lint would report clean over the part it did read. Import-time schema
 * validation makes those shapes unreachable for `ROUTING_GROUPS`, but both
 * lints are exported functions that anything may call with anything, and the
 * cost of checking is a few lines against a check whose whole output is the word
 * "clean".
 *
 * @param {readonly object[]} groups
 * @param {string} caller
 */
export function assertRawTable(groups, caller) {
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error(`${caller} was handed no routing groups to check`);
  }
  let effects = 0;
  const refuse = (what, where) => {
    throw new Error(`${caller} was handed ${what} at ${where}`);
  };
  const isObject = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);

  const visitEffects = (list, where) => {
    if (!Array.isArray(list))
      refuse("an `effects` that is not an array", where);
    list.forEach((effect, index) => {
      const at = `${where}.effects[${index}]`;
      if (!isObject(effect)) {
        refuse(`${JSON.stringify(effect)} where an effect object belongs`, at);
      }
      effects += 1;
      if (Object.hasOwn(effect, "kind")) {
        throw new Error(
          `${caller} was handed NORMALIZED routing groups. The normal form drops \`pairing\`, ` +
            "`allowStale` and `why`, so this check would have found no violations and reported clean. " +
            "Pass the raw table (`ROUTING_GROUPS`), not `ROUTING_PLAN`.",
        );
      }
      if (Object.hasOwn(effect, "effects")) visitEffects(effect.effects, at);
      if (Object.hasOwn(effect, "arms")) visitArms(effect.arms, at);
    });
  };

  const visitArms = (arms, where) => {
    if (!Array.isArray(arms) || arms.length === 0) {
      refuse("an `arms` that is not a non-empty array", where);
    }
    arms.forEach((arm, index) => {
      const at = `${where}.arms[${index}]`;
      if (!isObject(arm)) refuse("something that is not an arm object", at);
      if (!Array.isArray(arm.patterns) || arm.patterns.length === 0) {
        refuse("an arm with no `patterns`", at);
      }
      // Every arm carries its own `effects`, empty or not. Accepting a missing
      // one lets a sibling's effects stand in for it and the arm goes unread.
      visitEffects(arm.effects, at);
    });
  };

  groups.forEach((group, index) => {
    const at = `group[${index}]`;
    if (!isObject(group)) refuse("something that is not a routing group", at);
    visitArms(group.arms, at);
  });
  if (effects === 0) {
    throw new Error(
      `${caller} was handed a table with no effects at all, so it has checked nothing`,
    );
  }
}

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
 * Takes the RAW table. `pairing` and `why` do not survive `normalizeGroups`, so
 * a normalized table would produce no violations and read as clean —
 * `assertRawTable` refuses it rather than trusting the caller to know that.
 *
 * @param {readonly object[]} rawGroups the raw table, never `ROUTING_PLAN`
 * @returns {string[]} one message per violation; empty means clean
 */
export function pairingProblems(rawGroups) {
  assertRawTable(rawGroups, "pairingProblems");
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
 * `allowStale: "<reason>"` exempts THE DECLARING ARM'S literal patterns and
 * nothing else. The exemption is per arm, not per path: the same literal can be
 * named by several arms, and one arm accepting that a path is not here yet says
 * nothing about another arm that names it and needs it. A table-wide exemption
 * set would let a single `allowStale` silently switch the check off everywhere
 * that path appears — the fail-open shape this whole conversion exists to
 * remove. ADR 0064 documents the legitimate case (a pre-move probe path held
 * until no open PR bases on a pre-move tree); this table adds one more, a config
 * file the repo does not carry today but routes correctly the day someone adds
 * it.
 *
 * @param {readonly object[]} groups the raw table
 * @returns {{ path: string, groupId: string, kind: string, command?: string }[]}
 */
export function stalenessSubjects(groups) {
  assertRawTable(groups, "stalenessSubjects");
  const subjects = [];
  for (const { groupId, subject, dynamic, arm } of walkArms(groups)) {
    // A dispatch on the root-manifest class switches on a verdict string, and an
    // engine-computed group's patterns are built at run time; neither holds a
    // path to check.
    if (subject === "path" && dynamic === null) {
      const exempt = new Set(exemptedLiterals(arm));
      for (const pattern of arm.patterns) {
        if (isGlob(pattern) || exempt.has(pattern)) continue;
        subjects.push({ path: pattern, groupId, kind: "pattern" });
      }
    }
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
    // A `pathEquals` guard names an exact path, and it fails as quietly as a
    // stale arm pattern does: the guarded commands simply stop being scheduled
    // and nothing reds. Today both live guards repeat their path in the
    // enclosing arm's pattern list, so this covers nothing new — which is
    // precisely why it has to be here before the first one that does not.
    if (typeof effect.when?.pathEquals === "string") {
      subjects.push({ path: effect.when.pathEquals, groupId, kind: "guard" });
    }
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
  // The changed path itself exists by construction — the arms that template it
  // are guarded on `[[ -f "$path" ]]`. Only the TOKEN is exempt, though, not the
  // command that carries it: `node scripts/x.mjs {path}` names a static module
  // whose staleness matters exactly as much as any other arm's. Blanking the
  // token and scanning the rest keeps the whitespace boundaries the path
  // pattern relies on.
  const scanned = command.split(PATH_TOKEN).join(" ");
  for (const match of scanned.matchAll(COMMAND_PATH)) {
    subjects.push({ path: match[1], groupId, kind: "command", command });
  }
}
