/**
 * Issue-board argv parsing and usage text.
 *
 * Pure: it reads `process.env` for defaults but performs no IO, so the offline
 * suite drives `parseArgs` directly with an injected environment.
 */

import {
  assertCanonicalGithubCliEnvironment,
  DEFAULT_PROJECT_NUMBER,
  DEFAULT_PROJECT_OWNER,
  DEFAULT_REPO,
  splitRepo,
  validateClaimAgent,
  validateClaimBranch,
  validateClaimId,
  validateIssueBodySha256,
} from "./issue-board-state.mjs";

export function usage() {
  return `Usage:
  pnpm issue:claim --count 3 [--agent codex] [--branch <name>] [--dry-run]
  pnpm issue:claim --issue 901 --issue 902 [--agent claude]
  pnpm issue:claim --issue 901 --branch <name> --claim-id <token> --sweep-eligible --body-sha256 <digest>
  pnpm issue:review --pr 123 --issue 901 [--issue 902]
  pnpm issue:review --pr 123 --issue 901 --claim-id <token> --rebind-branch
  pnpm issue:release --issue 901 --claim-id <token> [--needs-grooming]
  pnpm issue:release --issue 901 --claim-id <token> --closed-unmerged-pr
  pnpm issue:release --issue 901 --claim-id <token> --merged-pr --needs-grooming
  pnpm issue:groom --issue 901 --add-label pkg:tooling,kind:workflow
  pnpm issue:board sync --dry-run       # preview repository-wide changes
  pnpm issue:board sync                 # apply; requires explicit repository-wide authority
  pnpm issue:board backfill --issue 901 [--dry-run]

Options:
  --repo <owner/name>              Repository to operate on (default: ${DEFAULT_REPO})
  --project-owner <owner>          Project owner (default: ${DEFAULT_PROJECT_OWNER})
  --project-number <number>        Project number (default: ${DEFAULT_PROJECT_NUMBER})
  --issue, --issues <numbers>      Issue number(s), comma-separated or repeated; not valid for sync
  --count <number>                 Number of ready issues to claim (default: 1)
  --agent <name>                   Agent/session label for comments and project fields
  --branch <name>                  Durable owner branch; required for sweep claims
  --claim-id <token>               Stable ownership token for one explicit claim or release
  --sweep-eligible                 Require the backlog-sweep claim predicate
  --body-sha256 <digest>           Pin the body inspected for a sweep claim
  --add-label <labels>             Routing label(s) to add for groom, comma-separated or repeated
  --pr <number-or-url>             Pull request number or URL for review moves
  --needs-grooming                 Release issues to needs-grooming instead of agent-ready
  --closed-unmerged-pr             Release a stored PR after proving it closed unmerged
  --merged-pr                      Continue a merged stored PR only in needs-grooming
  --rebind-branch                  Move review ownership to the proven PR head branch
  --no-comment                     Do not post issue comments for claim/review/release
  --dry-run                        Print mutations without applying them
  --json                           Print machine-readable command results
`;
}

function unique(values) {
  return [...new Set(values)];
}

export function parseIssueNumbers(values, repo = DEFAULT_REPO) {
  const expectedRepo = splitRepo(repo).nameWithOwner.toLowerCase();
  const numbers = [];
  for (const value of values) {
    for (const part of String(value).split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const numberMatch = trimmed.match(/^#?(\d+)$/);
      if (numberMatch) {
        numbers.push(Number(numberMatch[1]));
        continue;
      }

      const urlMatch = trimmed.match(
        /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/,
      );
      if (urlMatch) {
        const actualRepo = `${urlMatch[1]}/${urlMatch[2]}`;
        if (actualRepo.toLowerCase() !== expectedRepo) {
          throw new Error(
            `Issue URL repository ${actualRepo} does not match selected repo ${repo}: ${trimmed}`,
          );
        }
        numbers.push(Number(urlMatch[3]));
        continue;
      }

      throw new Error(`Invalid issue reference: ${trimmed}`);
    }
  }
  return unique(numbers);
}

function parsePr(value, repo = DEFAULT_REPO) {
  const trimmed = String(value).trim();
  const numberMatch = trimmed.match(/^#?(\d+)$/);
  if (numberMatch) return Number(numberMatch[1]);

  const urlMatch = trimmed.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (urlMatch) {
    const expectedRepo = splitRepo(repo).nameWithOwner.toLowerCase();
    const actualRepo = `${urlMatch[1]}/${urlMatch[2]}`;
    if (actualRepo.toLowerCase() !== expectedRepo) {
      throw new Error(
        `PR URL repository ${actualRepo} does not match selected repo ${repo}: ${trimmed}`,
      );
    }
    return Number(urlMatch[3]);
  }

  throw new Error(`Invalid PR reference: ${trimmed}`);
}

function defaultAgent(env = process.env) {
  return env.AGENT_NAME ?? env.CODEX_AGENT_NAME ?? env.USER ?? "agent";
}

export function parseArgs(argv, env = process.env) {
  let branchExplicit = false;
  const explicitTarget = {
    repo: false,
    projectOwner: false,
    projectNumber: false,
  };
  const options = {
    command: "help",
    repo: env.AGENT_ISSUE_REPO ?? DEFAULT_REPO,
    projectOwner: env.AGENT_WORKBOARD_OWNER ?? DEFAULT_PROJECT_OWNER,
    projectNumber: Number(
      env.AGENT_WORKBOARD_PROJECT_NUMBER ?? DEFAULT_PROJECT_NUMBER,
    ),
    count: 1,
    issueValues: [],
    backfillIssueFlags: 0,
    positionalIssueValues: [],
    issues: [],
    addLabels: [],
    agent: defaultAgent(env),
    branch: env.AGENT_BRANCH ?? "",
    claimId: null,
    sweepEligible: false,
    bodySha256: null,
    pr: null,
    prValue: null,
    dryRun: false,
    json: false,
    comment: true,
    releaseState: "ready",
    closedUnmergedPr: false,
    mergedPr: false,
    rebindBranch: false,
  };

  const args = [...argv];
  if (args[0] && !args[0].startsWith("-")) {
    options.command = args.shift();
    if (options.command === "board") {
      options.command = args.shift() ?? "help";
    }
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const readValue = () => {
      const value = args[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };

    switch (arg) {
      case "--repo":
        options.repo = readValue();
        explicitTarget.repo = true;
        break;
      case "--project-owner":
        options.projectOwner = readValue();
        explicitTarget.projectOwner = true;
        break;
      case "--project-number":
        options.projectNumber = Number(readValue());
        explicitTarget.projectNumber = true;
        break;
      case "--count":
        options.count = Number(readValue());
        break;
      case "--issue":
        options.backfillIssueFlags += 1;
        options.issueValues.push(readValue());
        break;
      case "--issues":
        options.issueValues.push(readValue());
        break;
      case "--add-label":
        for (const part of readValue().split(",")) {
          const label = part.trim();
          if (label) options.addLabels.push(label);
        }
        break;
      case "--agent":
        options.agent = readValue();
        break;
      case "--branch":
        options.branch = readValue();
        branchExplicit = true;
        break;
      case "--claim-id":
        options.claimId = readValue();
        break;
      case "--sweep-eligible":
        options.sweepEligible = true;
        break;
      case "--body-sha256":
        options.bodySha256 = readValue();
        break;
      case "--pr":
        options.prValue = readValue();
        break;
      case "--needs-grooming":
        options.releaseState = "grooming";
        break;
      case "--closed-unmerged-pr":
        options.closedUnmergedPr = true;
        break;
      case "--merged-pr":
        options.mergedPr = true;
        break;
      case "--rebind-branch":
        options.rebindBranch = true;
        break;
      case "--no-comment":
        options.comment = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "-h":
      case "--help":
        options.command = "help";
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        options.issueValues.push(arg);
        options.positionalIssueValues.push(arg);
    }
  }

  if (!Number.isInteger(options.projectNumber) || options.projectNumber <= 0) {
    throw new Error("--project-number must be a positive integer");
  }
  if (!Number.isInteger(options.count) || options.count <= 0) {
    throw new Error("--count must be a positive integer");
  }

  if (options.prValue) {
    options.pr = parsePr(options.prValue, options.repo);
  }
  delete options.prValue;
  if (options.pr != null && options.command !== "review") {
    throw new Error("--pr is valid only for review");
  }
  if (options.command === "sync" && options.issueValues.length > 0) {
    throw new Error(
      "sync is repository-wide and does not accept --issue, --issues, or positional issue arguments",
    );
  }
  options.issues = parseIssueNumbers(options.issueValues, options.repo);
  const lifecycleMutation = [
    "claim",
    "review",
    "release",
    "sync",
    "backfill",
    "groom",
  ].includes(options.command);
  if (lifecycleMutation) {
    assertCanonicalGithubCliEnvironment(env);
  }
  const redirectedTargets = [
    {
      envName: "AGENT_ISSUE_REPO",
      envValue: env.AGENT_ISSUE_REPO,
      defaultValue: DEFAULT_REPO,
      explicit: explicitTarget.repo,
      flag: "--repo",
    },
    {
      envName: "AGENT_WORKBOARD_OWNER",
      envValue: env.AGENT_WORKBOARD_OWNER,
      defaultValue: DEFAULT_PROJECT_OWNER,
      explicit: explicitTarget.projectOwner,
      flag: "--project-owner",
    },
    {
      envName: "AGENT_WORKBOARD_PROJECT_NUMBER",
      envValue: env.AGENT_WORKBOARD_PROJECT_NUMBER,
      defaultValue: String(DEFAULT_PROJECT_NUMBER),
      explicit: explicitTarget.projectNumber,
      flag: "--project-number",
    },
  ].filter(
    (target) =>
      target.envValue != null &&
      String(target.envValue) !== String(target.defaultValue) &&
      !target.explicit,
  );
  if (lifecycleMutation && redirectedTargets.length > 0) {
    const target = redirectedTargets[0];
    throw new Error(
      `${target.envName} redirects a lifecycle mutation to ${target.envValue}; pass ${target.flag} explicitly to confirm the target`,
    );
  }
  if (options.claimId != null) validateClaimId(options.claimId);
  if (options.bodySha256 != null) validateIssueBodySha256(options.bodySha256);
  if (
    options.claimId != null &&
    !["claim", "release"].includes(options.command) &&
    !(options.command === "review" && options.rebindBranch)
  ) {
    throw new Error(
      "--claim-id is valid only for claim, release, or review with --rebind-branch",
    );
  }
  if (options.claimId != null && options.issues.length !== 1) {
    throw new Error("--claim-id requires exactly one explicit issue");
  }
  if (options.command === "release" && options.claimId == null) {
    throw new Error(
      "release requires --claim-id from the claim output or comment",
    );
  }
  if (options.sweepEligible && options.command !== "claim") {
    throw new Error("--sweep-eligible is valid only for claim");
  }
  if (options.sweepEligible && options.issues.length !== 1) {
    throw new Error("--sweep-eligible requires exactly one explicit issue");
  }
  if (options.sweepEligible && options.claimId == null) {
    throw new Error("--sweep-eligible requires an explicit --claim-id");
  }
  if (options.sweepEligible && (!branchExplicit || !options.branch?.trim())) {
    throw new Error("--sweep-eligible requires an explicit --branch");
  }
  if (options.sweepEligible && options.bodySha256 == null) {
    throw new Error(
      "--sweep-eligible requires --body-sha256 from the inspected issue body",
    );
  }
  if (options.bodySha256 != null && !options.sweepEligible) {
    throw new Error("--body-sha256 is valid only with --sweep-eligible");
  }
  if (branchExplicit && options.command !== "claim") {
    throw new Error(
      "--branch is valid only for claim; review rebinds from the proven PR head",
    );
  }
  if (lifecycleMutation) {
    options.agent = validateClaimAgent(options.agent);
  }
  if (branchExplicit && options.command === "claim") {
    options.branch = validateClaimBranch(options.branch);
  }
  if (options.closedUnmergedPr && options.command !== "release") {
    throw new Error("--closed-unmerged-pr is valid only for release");
  }
  if (options.mergedPr && options.command !== "release") {
    throw new Error("--merged-pr is valid only for release");
  }
  if (options.mergedPr && options.closedUnmergedPr) {
    throw new Error(
      "--merged-pr and --closed-unmerged-pr are mutually exclusive",
    );
  }
  if (options.mergedPr && options.releaseState !== "grooming") {
    throw new Error("--merged-pr requires --needs-grooming");
  }
  if (options.rebindBranch && options.command !== "review") {
    throw new Error("--rebind-branch is valid only for review");
  }
  if (options.rebindBranch && options.claimId == null) {
    throw new Error("--rebind-branch requires --claim-id");
  }
  if (options.addLabels.length > 0 && options.command !== "groom") {
    throw new Error("--add-label is valid only for groom");
  }
  if (options.command === "groom") {
    if (options.issues.length !== 1) {
      throw new Error("groom requires exactly one explicit --issue");
    }
    if (options.addLabels.length === 0) {
      throw new Error("groom requires at least one --add-label routing label");
    }
  }
  if (options.command === "backfill") {
    const explicitIssue = options.issueValues[0]?.trim();
    if (
      options.backfillIssueFlags !== 1 ||
      options.positionalIssueValues.length > 0 ||
      options.issueValues.length !== 1 ||
      !/^#?[1-9]\d*$/.test(explicitIssue ?? "") ||
      options.issues.length !== 1
    ) {
      throw new Error(
        "backfill requires exactly one explicit --issue <number>",
      );
    }
  }
  delete options.backfillIssueFlags;
  delete options.positionalIssueValues;
  return options;
}
