/**
 * Part of the quality gate's routing table. Read
 * `scripts/gate/routing-table/index.mjs` first: it owns the group order, the
 * schema, and the pairing lint, and it is the only module anything outside this
 * directory should import.
 *
 * ORDER IS ROUTING. Arms match first-to-last within a group, so an arm's index
 * is its precedence: move one and the gate schedules something else. Nothing
 * checks that. `routing-table.test.mjs` pins only the GROUP order, against a
 * written-out list.
 */

/**
 * The `scripts/*.mjs` arm — one outer arm whose nested dispatch routes each Node
 * module under `scripts/` to the suite that covers it.
 *
 * It is the longest arm in the table by a wide margin, so its nested arms are
 * held in three modules and concatenated here IN ORDER. The concatenation is
 * routing: `case` takes the first matching arm, and every one of these names an
 * exact path today, so a reorder is invisible until two arms overlap.
 *
 * The outer patterns reach every depth, because `*` crosses `/` in a `case`
 * pattern — `scripts/*.mjs` matches `scripts/sentry/triage/…`. That is the
 * property `pattern.mjs` exists to preserve.
 */

import { AGENT_MODULE_ARMS } from "./arms-agent-modules.mjs";
import { SENTRY_MODULE_ARMS } from "./arms-sentry-modules.mjs";
import { TOOLING_MODULE_ARMS } from "./arms-tooling-modules.mjs";

export const SCRIPT_MODULE_ARMS = [
  {
    patterns: [
      "scripts/*.mjs",
      "scripts/*.cjs",
      "scripts/*.js",
      "eslint.config.mjs",
    ],
    effects: [
      {
        why: "`.dependency-cruiser.cjs` is handled fully by its dedicated case block above (runs `pnpm code-health:deps` + `pnpm lint:scripts`). Don't list it here too or `add_command` dedupes a redundant entry.",
        surface: "scripts",
      },
      { command: "pnpm lint:scripts", reason: "root build script changed" },
      {
        dispatch: "path",
        arms: [
          ...AGENT_MODULE_ARMS,
          ...SENTRY_MODULE_ARMS,
          ...TOOLING_MODULE_ARMS,
        ],
      },
    ],
  },
];
