#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runIntegrationProbes } from "./runner.js";
import type { ProbeChainId } from "./types.js";
import { writeSnapshotToUpstash } from "./upstash.js";

type CliOptions = {
  amountUsd: string;
  output?: string | undefined;
  writeUpstash: boolean;
  pretty: boolean;
  adapterIds: string[];
  chainIds: ProbeChainId[];
  timeoutMs: number;
  pairLimit?: number | undefined;
};

type BooleanFlagHandler = (options: CliOptions) => void;
type ValueFlagHandler = (
  value: string,
  options: CliOptions,
  flag: string,
) => void;

const BOOLEAN_FLAGS: Record<string, BooleanFlagHandler> = {
  "--write-upstash": (options) => {
    options.writeUpstash = true;
  },
  "--compact": (options) => {
    options.pretty = false;
  },
  "--help": () => {
    usage();
    process.exit(0);
  },
  "-h": () => {
    usage();
    process.exit(0);
  },
};

const VALUE_FLAGS: Record<string, ValueFlagHandler> = {
  "--amount-usd": (value, options) => {
    options.amountUsd = value;
  },
  "--adapter": (value, options) => {
    options.adapterIds.push(...parseCsv(value));
  },
  "--chain": (value, options) => {
    options.chainIds.push(parseChain(value));
  },
  "--timeout-ms": (value, options, flag) => {
    options.timeoutMs = parsePositiveInt(value, flag);
  },
  "--pair-limit": (value, options, flag) => {
    options.pairLimit = parsePositiveInt(value, flag);
  },
  "--output": (value, options) => {
    options.output = value;
  },
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const snapshot = await runIntegrationProbes({
    amountUsd: options.amountUsd,
    adapterIds: options.adapterIds,
    chainIds: options.chainIds.length > 0 ? options.chainIds : undefined,
    timeoutMs: options.timeoutMs,
    pairLimit: options.pairLimit,
  });
  const json = JSON.stringify(snapshot, null, options.pretty ? 2 : 0);
  if (options.output) {
    const outputPath = resolveOutputPath(options.output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${json}\n`, "utf8");
  } else {
    process.stdout.write(`${json}\n`);
  }
  if (options.writeUpstash) {
    const result = await writeSnapshotToUpstash({ snapshot });
    process.stderr.write(
      `Wrote integration probe snapshot to ${result.latestKey} and ${result.historyKey}\n`,
    );
  }
}

function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    amountUsd: "1",
    writeUpstash: false,
    pretty: true,
    adapterIds: [],
    chainIds: [],
    timeoutMs: 15_000,
  };
  for (let index = 0; index < args.length; index += 1) {
    index = parseArgAt(args, index, options);
  }
  return options;
}

function parseArgAt(
  args: readonly string[],
  index: number,
  options: CliOptions,
): number {
  const arg = requireValue(args, index, "argument");
  const booleanHandler = BOOLEAN_FLAGS[arg];
  if (booleanHandler) {
    booleanHandler(options);
    return index;
  }
  if (arg.includes("=")) return parseEqualsArg(arg, index, options);
  const valueHandler = VALUE_FLAGS[arg];
  if (!valueHandler) throw new Error(`Unknown argument: ${arg}`);
  valueHandler(requireValue(args, index + 1, arg), options, arg);
  return index + 1;
}

function parseEqualsArg(
  arg: string,
  index: number,
  options: CliOptions,
): number {
  const { flag, value } = splitEqualsArg(arg);
  const handler = VALUE_FLAGS[flag];
  if (!handler) throw new Error(`Unknown argument: ${arg}`);
  handler(value, options, flag);
  return index;
}

function splitEqualsArg(arg: string): { flag: string; value: string } {
  const equalsIndex = arg.indexOf("=");
  const flag = arg.slice(0, equalsIndex);
  const value = arg.slice(equalsIndex + 1);
  if (!value) throw new Error(`${flag} requires a value`);
  return { flag, value };
}

function requireValue(
  args: readonly string[],
  index: number,
  flag: string,
): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseChain(value: string): ProbeChainId {
  const chainId = Number(value);
  if (chainId === 42220 || chainId === 143) return chainId;
  throw new Error(`Unsupported probe chain: ${value}`);
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

function resolveOutputPath(value: string): string {
  if (path.isAbsolute(value)) return value;
  return path.join(process.env.INIT_CWD ?? process.cwd(), value);
}

function usage(): void {
  process.stdout.write(`Usage: pnpm integrations:probe [options]

Options:
  --amount-usd <n>    Stable-unit amount per route direction (default: 1)
  --adapter <id[,id]> Probe only selected adapter ids
  --chain <id>        Probe only selected chain ids (42220 or 143)
  --pair-limit <n>    Limit USDm hub pairs per chain for debugging
  --timeout-ms <n>    Per-request timeout in milliseconds (default: 15000)
  --write-upstash     Write latest + dated snapshots to Upstash Redis
  --output <path>     Also write the snapshot JSON to a file
  --compact           Emit compact JSON
  -h, --help          Show this help
`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
