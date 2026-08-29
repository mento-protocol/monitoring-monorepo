/**
 * Parse the agent-facing GitHub broker protocol.
 *
 * Every request selects one reviewed permission profile and one named
 * operation. The installed broker repeats this parse before it mints a token.
 */

export const EXACT_REPOSITORY = "mento-protocol/monitoring-monorepo";

export const PROFILE = Object.freeze({
  READ: "read",
  PR_ISSUE: "pr-issue-write",
  GIT_PUBLICATION: "git-publish",
  ISSUE_BOARD: "issue-board-write",
});

export const TRUSTED_PROFILES = Object.freeze(Object.values(PROFILE));

// #2111 is not merged. Its final custom-ref namespace and transaction
// operation must enter reviewed source together. Agent input cannot activate it.
export const ISSUE_BOARD_MUTEX_REF_PREFIX = "";

// A future root-owned service must import objects into a clean broker-owned
// mirror. No token-bearing Git process may read an agent checkout.
export const GIT_PUBLICATION_SERVICE_ENABLED = false;

export const FORBIDDEN_AMBIENT_ENV = Object.freeze([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_CONFIG_DIR",
  "GIT_CONFIG_PARAMETERS",
  "GITHUB_OWNER",
  "GITHUB_ORGANIZATION",
  "GITHUB_BASE_URL",
  "TF_VAR_github_token",
  "TF_VAR_local_agent_github_app_private_key",
]);

const OPERATION_PROFILES = Object.freeze({
  "issue-close": new Set([PROFILE.PR_ISSUE]),
  "issue-comment": new Set([PROFILE.PR_ISSUE]),
  "issue-create": new Set([PROFILE.PR_ISSUE]),
  "issue-list": new Set([PROFILE.READ]),
  "issue-reopen": new Set([PROFILE.PR_ISSUE]),
  "issue-view": new Set([PROFILE.READ]),
  "pr-close": new Set([PROFILE.PR_ISSUE]),
  "pr-comment": new Set([PROFILE.PR_ISSUE]),
  "pr-create": new Set([PROFILE.PR_ISSUE]),
  "pr-list": new Set([PROFILE.READ]),
  "pr-reopen": new Set([PROFILE.PR_ISSUE]),
  "pr-review": new Set([PROFILE.PR_ISSUE]),
  "pr-view": new Set([PROFILE.READ]),
  "repo-view": new Set([PROFILE.READ]),
  "run-list": new Set([PROFILE.READ]),
  "run-view": new Set([PROFILE.READ]),
});

export class ClientFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "ClientFailure";
  }
}

function fail(message) {
  throw new ClientFailure(message);
}

function positiveSafeInteger(name, raw, maximum = Number.MAX_SAFE_INTEGER) {
  if (!/^[1-9][0-9]*$/u.test(String(raw ?? ""))) {
    fail(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    fail(`${name} is outside its supported bound`);
  }
  return value;
}

function exactArgCount(args, minimum, maximum = minimum) {
  if (args.length < minimum || args.length > maximum) {
    fail("the structured operation has the wrong number of arguments");
  }
}

function hasUnsafeText(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint === 0 || codePoint === 0x7f;
  });
}

function boundedText(name, raw, { allowEmpty = false, maximum }) {
  const value = String(raw ?? "");
  if (
    (!allowEmpty && value === "") ||
    value.length > maximum ||
    hasUnsafeText(value)
  ) {
    fail(`${name} was empty, too large, or contained a forbidden character`);
  }
  return value;
}

function listParameters(args) {
  exactArgCount(args, 0, 2);
  const state = args[0] ?? "open";
  if (!new Set(["all", "closed", "open"]).has(state)) {
    fail("list state must be all, closed, or open");
  }
  return {
    state,
    limit: positiveSafeInteger("list limit", args[1] ?? "30", 100),
  };
}

function numberParameter(args, name) {
  exactArgCount(args, 1);
  return { number: positiveSafeInteger(name, args[0]) };
}

function commentParameters(args, { reserveIssueBoardProtocol = false } = {}) {
  exactArgCount(args, 2);
  const parameters = {
    number: positiveSafeInteger("comment target", args[0]),
    body: boundedText("comment body", args[1], { maximum: 65_536 }),
  };
  if (
    reserveIssueBoardProtocol &&
    /^(?:Agent claim:|Moved to review:|Released agent claim:)/u.test(
      parameters.body,
    )
  ) {
    fail("the issue-board comment protocol requires its trusted adapter");
  }
  return parameters;
}

function issueCreateParameters(args) {
  exactArgCount(args, 1, 2);
  return {
    title: boundedText("issue title", args[0], { maximum: 256 }),
    body: boundedText("issue body", args[1] ?? "", {
      allowEmpty: true,
      maximum: 65_536,
    }),
  };
}

function safeGitRef(name, raw) {
  const value = boundedText(name, raw, { maximum: 256 });
  if (
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    value === "@" ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.split("/").some((component) => component.startsWith(".")) ||
    /[~^:?*\u005b\\\s]/u.test(value)
  ) {
    fail(`${name} was not a safe Git ref name`);
  }
  return value;
}

function prCreateParameters(args) {
  exactArgCount(args, 4);
  return {
    head: safeGitRef("pull-request head", args[0]),
    base: safeGitRef("pull-request base", args[1]),
    title: boundedText("pull-request title", args[2], { maximum: 256 }),
    body: boundedText("pull-request body", args[3], {
      allowEmpty: true,
      maximum: 65_536,
    }),
  };
}

function reviewParameters(args) {
  exactArgCount(args, 3);
  const decision = args[1];
  if (!new Set(["comment", "request-changes"]).has(decision)) {
    fail("review decision was not supported");
  }
  const body = boundedText("review body", args[2], {
    maximum: 65_536,
  });
  return {
    number: positiveSafeInteger("review target", args[0]),
    decision,
    body,
  };
}

export function parseStructuredOperation(profile, operation, args) {
  if (!TRUSTED_PROFILES.includes(profile)) fail("unknown broker profile");
  if (!Object.hasOwn(OPERATION_PROFILES, operation)) {
    fail("unknown structured GitHub operation");
  }
  if (!OPERATION_PROFILES[operation].has(profile)) {
    fail("the selected profile cannot run this operation");
  }

  if (["issue-list", "pr-list"].includes(operation)) {
    return listParameters(args);
  }
  if (operation === "run-list") {
    exactArgCount(args, 0, 1);
    return { limit: positiveSafeInteger("run limit", args[0] ?? "30", 100) };
  }
  if (operation === "repo-view") {
    exactArgCount(args, 0);
    return {};
  }
  if (["issue-view", "pr-view"].includes(operation)) {
    return numberParameter(args, "repository item number");
  }
  if (operation === "run-view") {
    exactArgCount(args, 1);
    return { runId: positiveSafeInteger("workflow run ID", args[0]) };
  }
  if (operation === "issue-comment") {
    return commentParameters(args, { reserveIssueBoardProtocol: true });
  }
  if (operation === "pr-comment") return commentParameters(args);
  if (operation === "issue-create") return issueCreateParameters(args);
  if (operation === "pr-create") return prCreateParameters(args);
  if (operation === "pr-review") return reviewParameters(args);
  if (
    ["issue-close", "issue-reopen", "pr-close", "pr-reopen"].includes(operation)
  ) {
    return numberParameter(args, "state-change target");
  }
  fail("the structured operation has no active parser");
}

export function assertNoAmbientGithubCredential(env) {
  for (const name of FORBIDDEN_AMBIENT_ENV) {
    const configured =
      name === "GIT_CONFIG_PARAMETERS" ||
      name === "GITHUB_OWNER" ||
      name === "GITHUB_ORGANIZATION" ||
      name === "GITHUB_BASE_URL"
        ? Object.hasOwn(env, name)
        : String(env[name] ?? "") !== "";
    if (configured) fail(`refusing inherited ${name}`);
  }
}

function takeFlagValue(flags, index) {
  const value = flags[index + 1];
  if (value === undefined || value === "") fail("--profile requires a value");
  return value;
}

function parseProfileFlags(flags) {
  let profile = "";
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--profile") {
      if (profile !== "") fail("--profile may be supplied once");
      profile = takeFlagValue(flags, index);
      index += 1;
    } else if (flag.startsWith("--profile=")) {
      if (profile !== "") fail("--profile may be supplied once");
      profile = flag.slice("--profile=".length);
    } else {
      fail("unsupported github:agent flag");
    }
  }
  if (!TRUSTED_PROFILES.includes(profile)) {
    fail("one fixed --profile is required");
  }
  return profile;
}

export function parseClientArgs(argv, env) {
  const separator = argv.indexOf("--");
  if (separator === -1 || separator === argv.length - 1) {
    fail("usage: github:agent --profile <name> -- <operation> [arguments]");
  }
  const operation = argv[separator + 1];
  const args = argv.slice(separator + 2);
  const profile = parseProfileFlags(argv.slice(0, separator));
  parseStructuredOperation(profile, operation, args);
  return {
    appId: positiveSafeInteger(
      "MENTO_LOCAL_AGENT_GITHUB_APP_ID",
      env.MENTO_LOCAL_AGENT_GITHUB_APP_ID,
    ),
    installationId: positiveSafeInteger(
      "MENTO_LOCAL_AGENT_GITHUB_APP_INSTALLATION_ID",
      env.MENTO_LOCAL_AGENT_GITHUB_APP_INSTALLATION_ID,
    ),
    profile,
    operation,
    args,
  };
}

export function clientFailureMessage(error) {
  return error instanceof ClientFailure
    ? error.message
    : "internal client error";
}
