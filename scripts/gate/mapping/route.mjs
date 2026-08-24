/**
 * Walk the routing table over a changed-path set and build the command plan.
 *
 * This is the control flow the gate's thirteen `case` statements used to
 * express, run as data instead. The rules it has to keep are the ones D5a's
 * table made explicit:
 *
 *   - Every GROUP runs for every path. Groups do not shadow one another.
 *   - Within a group the FIRST matching arm wins and no later arm in that group
 *     runs. That is why arm order is routing.
 *   - A `realTreeOnly` group is skipped entirely against a stub fixture
 *     repository, because those repositories own neither the suites nor the
 *     symlinks it enumerates.
 *   - A `dynamic` group's patterns are built from an engine-computed set, and
 *     its arm carries `stop: true` so it fires once per path rather than once
 *     per member.
 *
 * An unknown verb, guard, dispatch subject or dynamic source THROWS. The caller
 * turns that into a refusal, because a mapper that skipped what it did not
 * understand would emit a smaller plan and the gate would run fewer checks and
 * still exit 0.
 */

import { PATH_TOKEN } from "../routing-table/schema.mjs";
import { casePatternToRegExp } from "../routing-table/pattern.mjs";
import { shellQuote } from "./shell-quote.mjs";
import * as verbs from "./verbs.mjs";

/** Verb name → implementation. Every name the table may hold appears here. */
const VERBS = {
  add_command: (plan, args) => plan.addCommand(args[0], args[1]),
  add_preflight_command: (plan, args) => plan.addPreflight(args[0], args[1]),
  add_surface: (plan, args) => plan.addSurface(args[0]),
  add_checklist: (plan, args) => plan.addChecklist(args[0], args[1]),
  add_adr_reminder: (plan, args, facts) =>
    verbs.addAdrReminder(plan, args[0], facts),
  add_turbo_package_task: (plan, args) =>
    plan.addCommand(verbs.turboLocalCacheCommand(args[0], args[1]), args[2]),
  add_package_quality_commands: (plan, args) =>
    verbs.addPackageQualityCommands(plan, args[0], args[1]),
  add_package_vitest_typecheck_commands: (plan, args) =>
    verbs.addPackageVitestTypecheckCommands(plan, args[0], args[1]),
  add_workspace_quality_commands: (plan, args) =>
    verbs.addWorkspaceQualityCommands(plan, args[0]),
  add_dashboard_quality_commands: (plan, args) =>
    verbs.addDashboardQualityCommands(plan, args[0]),
  add_aegis_quality_commands: (plan, args) =>
    verbs.addAegisQualityCommands(plan, args[0]),
  add_alerts_oncall_quality_commands: (plan, args) =>
    verbs.addAlertsOncallQualityCommands(plan, args[0]),
  add_root_tooling_package_script_checks: (plan, args) =>
    verbs.addRootToolingPackageScriptChecks(plan, args[0]),
  add_terraform_validate_commands: (plan, args) =>
    verbs.addTerraformValidateCommands(plan, args[0], args[1]),
  add_registered_terraform_validate_commands: (plan, args, facts) =>
    verbs.addRegisteredTerraformValidateCommands(plan, args[0], facts),
  add_sentry_suite_gate_commands: (plan, args) =>
    verbs.addSentrySuiteGateCommands(plan, args[0]),
  add_ui_react_doctor_diff: (plan, args, facts) =>
    verbs.addUiReactDoctorDiff(plan, args[0], facts),
  add_ui_react_doctor_full_score: (plan, args) =>
    verbs.addUiReactDoctorFullScore(plan, args[0]),
  add_ui_mutation_baseline: (plan, args) =>
    verbs.addUiMutationBaseline(plan, args[0]),
  add_ui_size_limit: (plan, args) => verbs.addUiSizeLimit(plan, args[0]),
  add_bridge_mutation_baseline: (plan, args) =>
    verbs.addBridgeMutationBaseline(plan, args[0]),
  add_indexer_mutation_baseline: (plan, args) =>
    verbs.addIndexerMutationBaseline(plan, args[0]),
  add_dashboard_codegen: (plan, args) =>
    verbs.addDashboardCodegen(plan, args[0]),
  add_all_indexer_codegen: (plan, args) =>
    verbs.addAllIndexerCodegen(plan, args[0]),
  add_indexer_mainnet_codegen: (plan, args) =>
    verbs.addIndexerMainnetCodegen(plan, args[0]),
  add_indexer_testnet_codegen: (plan, args) =>
    verbs.addIndexerTestnetCodegen(plan, args[0]),
  add_bridge_codegen_then_restore_mainnet: (plan, args) =>
    verbs.addBridgeCodegenThenRestoreMainnet(plan, args[0]),
  add_reserve_yield_codegen_then_restore_mainnet: (plan, args) =>
    verbs.addReserveYieldCodegenThenRestoreMainnet(plan, args[0]),
  route_lockfile_change: (plan, args, facts, context) =>
    context.routeLockfileChange(plan, facts),
};

/** Compiled patterns are reused across the whole run; there are ~470 of them. */
const compiled = new Map();
const matches = (pattern, path) => {
  if (!compiled.has(pattern))
    compiled.set(pattern, casePatternToRegExp(pattern));
  return compiled.get(pattern).test(path);
};

const substitute = (pattern, value) =>
  pattern.replace(/\$\{[a-z_][a-z_0-9]*\}/, value);

function evaluateGuard(guard, path, facts) {
  // `[[ -f ]]`, not `[[ -e ]]`: a directory, a symlink to a directory and a
  // gitlink all exist without being regular files, and the gate does not
  // schedule `bash -n` or `node --check` against any of them.
  if (guard === "pathIsFile") return facts.pathIsFile(path);
  if (guard === "pathIsSymlink") return facts.pathIsSymlink(path);
  if (guard === "realTreeOnly") return facts.isRealTree;
  if (guard === "nonEmpty") return facts.terraformStackPaths.length > 0;
  if (guard !== null && typeof guard === "object" && "pathEquals" in guard) {
    return path === guard.pathEquals;
  }
  throw new Error(`unknown routing guard ${JSON.stringify(guard)}`);
}

/** Apply one arm's effects. Returns true when the arm asked routing to stop. */
function applyEffects(effects, plan, path, facts, context) {
  for (const effect of effects) {
    if (effect.kind === "break") return true;

    if (effect.kind === "set") {
      if (effect.name === "package_script_risk_changed") {
        plan.packageScriptRiskChanged = true;
      } else if (effect.name === "root_package_json_class") {
        // Reading it is what memoizes it; the dispatch below consults the same
        // cached answer.
        facts.rootPackageJsonClass();
      } else {
        throw new Error(`unknown assignment \`${effect.name}\``);
      }
      continue;
    }

    if (effect.kind === "when") {
      if (evaluateGuard(effect.guard, path, facts)) {
        if (applyEffects(effect.effects, plan, path, facts, context))
          return true;
      }
      continue;
    }

    if (effect.kind === "dispatch") {
      const subject =
        effect.subject === "path" ? path : facts.rootPackageJsonClass();
      if (
        effect.subject !== "path" &&
        effect.subject !== "root_package_json_class"
      ) {
        throw new Error(`unknown dispatch subject \`${effect.subject}\``);
      }
      for (const arm of effect.arms) {
        if (!arm.patterns.some((pattern) => matches(pattern, subject)))
          continue;
        if (applyEffects(arm.effects, plan, path, facts, context)) return true;
        break; // first match wins
      }
      continue;
    }

    if (effect.kind !== "call") {
      throw new Error(`unknown routing effect kind \`${effect.kind}\``);
    }
    const implementation = VERBS[effect.verb];
    if (implementation === undefined) {
      throw new Error(`no implementation for routing verb \`${effect.verb}\``);
    }
    // The changed path reaches a templated command through this one token, and
    // it arrives `printf %q`-quoted because that is what `quote_path` does.
    // The arms that carry it are guarded on the file existing.
    const args = effect.args.map((argument) =>
      argument.includes(PATH_TOKEN)
        ? argument.split(PATH_TOKEN).join(shellQuote(path))
        : argument,
    );
    implementation(plan, args, facts, context);
  }
  return false;
}

/** Route one changed path through every group, in order. */
function routePath(groups, plan, path, facts, context) {
  for (const group of groups) {
    if (group.realTreeOnly && !facts.isRealTree) continue;

    if (group.dynamic !== null) {
      const members =
        group.dynamic === "scriptsSymlinkTargets"
          ? facts.scriptsSymlinkTargets
          : group.dynamic === "registeredTerraformStacks"
            ? facts.terraformStackPaths
            : null;
      if (members === null) {
        throw new Error(`unknown dynamic pattern source \`${group.dynamic}\``);
      }
      if (group.requiresNonEmpty && members.length === 0) continue;
      // One arm, one substitution per member, stopping at the first hit —
      // the `break` inside the gate's `for` loop.
      for (const member of members) {
        let stopped = false;
        for (const arm of group.arms) {
          const armMatches = arm.patterns.some((pattern) =>
            matches(substitute(pattern, member), path),
          );
          if (!armMatches) continue;
          stopped = applyEffects(
            arm.effects.map((effect) => substituteArgs(effect, member)),
            plan,
            path,
            facts,
            context,
          );
          break;
        }
        if (stopped) break;
      }
      continue;
    }

    for (const arm of group.arms) {
      if (!arm.patterns.some((pattern) => matches(pattern, path))) continue;
      applyEffects(arm.effects, plan, path, facts, context);
      break; // first match wins
    }
  }
}

/** Replace a dynamic group's placeholder inside effect arguments. */
function substituteArgs(effect, member) {
  if (effect.kind !== "call") return effect;
  return {
    ...effect,
    args: effect.args.map((argument) =>
      /^\$\{[a-z_][a-z_0-9]*\}$/.test(argument) ? member : argument,
    ),
  };
}

export function routeChangedPaths(groups, changedPaths, facts, context) {
  const plan = context.plan;
  for (const path of changedPaths) {
    routePath(groups, plan, path, facts, context);
  }
  return plan;
}
