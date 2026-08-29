/**
 * Issue-board argv parsing and usage text.
 *
 * Pure: it reads `process.env` for defaults but performs no IO, so the offline
 * suite drives `parseArgs` directly with an injected environment.
 */

import {
  DEFAULT_PROJECT_NUMBER,
  DEFAULT_PROJECT_OWNER,
  DEFAULT_REPO,
  splitRepo,
} from "./issue-board-state.mjs";

export function usage() {
  return `Usage:
  pnpm issue:claim --count 3 [--agent codex] [--branch <name>] [--dry-run]
  pnpm issue:claim --issue 901 --issue 902 [--agent claude]
  pnpm issue:review --pr 123 --issue 901 [--issue 902]
  pnpm issue:release --issue 901 [--needs-grooming]
  pnpm issue:board sync [--dry-run] (repository-wide)
  pnpm issue:board backfill --issue 901 [--dry-run]

Options:
  --repo <owner/name>              Repository to operate on (default: ${DEFAULT_REPO})
  --project-owner <owner>          Project owner (default: ${DEFAULT_PROJECT_OWNER})
  --project-number <number>        Project number (default: ${DEFAULT_PROJECT_NUMBER})
  --issue, --issues <numbers>      Issue number(s), comma-separated or repeated; not valid for sync
  --count <number>                 Number of ready issues to claim (default: 1)
  --agent <name>                   Agent/session label for comments and project fields
  --branch <name>                  Branch/worktree hint for comments and project fields
  --pr <number-or-url>             Pull request number or URL for review moves
  --needs-grooming                 Release issues to needs-grooming instead of agent-ready
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
    agent: defaultAgent(env),
    branch: env.AGENT_BRANCH ?? "",
    pr: null,
    prValue: null,
    dryRun: false,
    json: false,
    comment: true,
    releaseState: "ready",
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
        break;
      case "--project-owner":
        options.projectOwner = readValue();
        break;
      case "--project-number":
        options.projectNumber = Number(readValue());
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
      case "--agent":
        options.agent = readValue();
        break;
      case "--branch":
        options.branch = readValue();
        break;
      case "--pr":
        options.prValue = readValue();
        break;
      case "--needs-grooming":
        options.releaseState = "grooming";
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
  if (options.command === "sync" && options.issueValues.length > 0) {
    throw new Error(
      "sync is repository-wide and does not accept --issue, --issues, or positional issue arguments",
    );
  }
  options.issues = parseIssueNumbers(options.issueValues, options.repo);
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
