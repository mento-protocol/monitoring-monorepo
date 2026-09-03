/**
 * The command plan the routing builds up: four ordered buckets, two ordered
 * sets, and the global flags the routing mutates as it goes.
 *
 * This is the Node half of what `agent-quality-gate.sh` does with six bash
 * arrays. Every rule here mirrors one the gate already has, and the ones that
 * look arbitrary are the ones that matter:
 *
 *   - Dedupe is on the command STRING, and the FIRST reason registered wins.
 *     `production-infra-identity-contract/routing.test.mjs` asserts on a reason
 *     string, so "first wins" is a contract rather than an implementation
 *     detail.
 *   - Three command pairs share one dedupe KEY, so the pnpm alias and the
 *     direct entry point never schedule the same suite twice.
 *   - `prepend` puts a command at the HEAD of the quality bucket. Trunk uses it,
 *     and it runs after everything else has been added, so the head is the only
 *     position that makes it first.
 *   - Buckets are emitted preflight → codegen → post-codegen → quality, which is
 *     the order `write_command_plan` writes and the freshness stamp hashes.
 */

/**
 * The commands that are the same suite reached two ways.
 *
 * `add_command` deduplicates on this key, not on the raw string, so a change
 * touching both the alias and the script schedules one run rather than two.
 *
 * `pnpm tf:test` is the expensive one. The unconditional production-infra sweep
 * schedules it for every non-empty change set, and the root-tooling bundle
 * schedules the identical suite as a direct `node` call, so a package.json edit
 * that touched only allowlisted aliases used to run the tree's largest suite
 * twice — about a minute of pure repetition. The pair is safe in either
 * direction because `check-agent-quality-gate-package-scripts.mjs` pins the
 * alias to exactly that command and runs fail-fast as a prerequisite, so no
 * `pnpm <alias>` executes under a drifted manifest.
 */
const DEDUPE_ALIASES = new Map([
  ["pnpm agent:quality-gate:test", "agent-quality-gate.test"],
  ["bash scripts/agent-quality-gate.test.sh", "agent-quality-gate.test"],
  ["pnpm tf:test", "tf-stacks.test"],
  ["node scripts/tf-stacks.test.mjs", "tf-stacks.test"],
]);

/** The dedupe identity of a command string. */
export const commandDedupeKey = (command) =>
  DEDUPE_ALIASES.get(command) ?? command;

/** The buckets, in the order the plan is written and hashed. */
export const BUCKETS = Object.freeze([
  "preflight",
  "codegen",
  "post-codegen",
  "quality",
]);

export class Plan {
  constructor() {
    /** @type {Map<string, {command: string, reason: string}[]>} */
    this.buckets = new Map(BUCKETS.map((bucket) => [bucket, []]));
    /** @type {string[]} */
    this.surfaces = [];
    /** @type {{checklist: string, reason: string}[]} */
    this.checklists = [];
    // Set by any route that escalates to the whole workspace. It disables
    // scoped tests for the entire run, so it is a property of the run rather
    // than of the arm that set it.
    this.sawWorkspaceEscalation = false;
    // Packages whose coverage floor is standing in for a dependency-bump
    // regression check; scoping must not narrow those.
    this.lockfileScopedPackages = new Set();
    this.packageScriptRiskChanged = false;
  }

  #has(bucket, command) {
    const key = commandDedupeKey(command);
    return this.buckets
      .get(bucket)
      .some((entry) => commandDedupeKey(entry.command) === key);
  }

  /** Append to a bucket unless an equivalent command is already there. */
  add(bucket, command, reason) {
    if (!this.buckets.has(bucket)) {
      throw new Error(`unknown command bucket \`${bucket}\``);
    }
    if (this.#has(bucket, command)) return;
    this.buckets.get(bucket).push({ command, reason });
  }

  addCommand(command, reason) {
    this.add("quality", command, reason);
  }

  addPreflight(command, reason) {
    this.add("preflight", command, reason);
  }

  addCodegen(command, reason) {
    this.add("codegen", command, reason);
  }

  addPostCodegen(command, reason) {
    this.add("post-codegen", command, reason);
  }

  /**
   * Put a command at the head of the quality bucket.
   *
   * Trunk is prepended after every other command has been added, which is the
   * only way it ends up first. Prepending something already present is a no-op
   * rather than a move — the same as the gate's `prepend_command`.
   */
  prependCommand(command, reason) {
    if (this.#has("quality", command)) return;
    this.buckets.get("quality").unshift({ command, reason });
  }

  addSurface(surface) {
    if (!this.surfaces.includes(surface)) this.surfaces.push(surface);
  }

  /** Checklists deduplicate on the path alone; the first reason wins. */
  addChecklist(checklist, reason) {
    if (this.checklists.some((entry) => entry.checklist === checklist)) return;
    this.checklists.push({ checklist, reason });
  }

  markLockfileScopedPackage(packageName) {
    this.lockfileScopedPackages.add(packageName);
  }

  isLockfileScopedPackage(packageName) {
    return this.lockfileScopedPackages.has(packageName);
  }

  /** The quality bucket, for the post-passes that rewrite it in place. */
  get quality() {
    return this.buckets.get("quality");
  }

  set quality(entries) {
    this.buckets.set("quality", entries);
  }

  get codegen() {
    return this.buckets.get("codegen");
  }

  set codegen(entries) {
    this.buckets.set("codegen", entries);
  }
}
