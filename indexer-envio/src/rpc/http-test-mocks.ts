import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  decodeFunctionData,
  encodeFunctionResult,
  toHex,
  type Abi,
} from "viem";

import { registerHttpTestRpcHandlers } from "./http-test-mock-bridge.js";
import { CONTRACT_NAMESPACE_BY_CHAIN } from "../contractAddresses.js";
import { env } from "../env.js";
import {
  BI_POOL_MANAGER_GET_POOL_EXCHANGE_ABI,
  BREAKER_BOX_ABI,
  ERC20_DECIMALS_ABI,
  FPMM_FEE_ABI,
  FPMM_MINIMAL_ABI,
  FPMM_TRADING_LIMITS_ABI,
  MEDIAN_DELTA_BREAKER_ABI,
  SortedOraclesContract,
  SUSDS_CONVERT_TO_ASSETS_ABI,
  VALUE_DELTA_BREAKER_ABI,
} from "../abis.js";

const TEST_CHAIN_IDS = Array.from(
  new Set([
    ...Object.keys(CONTRACT_NAMESPACE_BY_CHAIN)
      .map((chainId) => Number(chainId))
      .filter((chainId) => Number.isFinite(chainId)),
    1,
  ]),
);

const GET_BREAKERS_ABI = [
  {
    type: "function",
    name: "getBreakers",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
    stateMutability: "view",
  },
] as const;

// BreakerBox dependency-graph getters (#712) — the array-walk getter and the
// `getRateFeeds()` control read used by `fetchRateFeedDependencies`.
const RATE_FEED_DEPS_ABI = [
  {
    type: "function",
    name: "rateFeedDependencies",
    inputs: [
      { name: "", type: "address" },
      { name: "", type: "uint256" },
    ],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getRateFeeds",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
    stateMutability: "view",
  },
] as const;

const TEST_RPC_ABI = [
  ...FPMM_MINIMAL_ABI,
  ...FPMM_FEE_ABI,
  ...FPMM_TRADING_LIMITS_ABI,
  ...ERC20_DECIMALS_ABI,
  ...BI_POOL_MANAGER_GET_POOL_EXCHANGE_ABI,
  ...BREAKER_BOX_ABI,
  ...MEDIAN_DELTA_BREAKER_ABI,
  ...VALUE_DELTA_BREAKER_ABI,
  ...GET_BREAKERS_ABI,
  ...RATE_FEED_DEPS_ABI,
  ...SUSDS_CONVERT_TO_ASSETS_ABI,
  ...(SortedOraclesContract.abi as Abi),
] as const satisfies Abi;

type JsonRpcRequest = {
  id?: number | string | null;
  method?: string;
  params?: unknown[];
};

type MockCall =
  | {
      group: string;
      kind: "result";
      functionName: string;
      result: unknown;
    }
  | { group: string; kind: "raw"; result: string }
  | { group: string; kind: "error"; message: string };

type MockCode =
  | { group: string; kind: "result"; result: string }
  | { group: string; kind: "error"; message: string };

const callMocks = new Map<string, MockCall>();
const codeMocks = new Map<string, MockCode>();

let serverUrl: string | undefined;
let rpcServer: Server | undefined;
let serverReady: Promise<void> | undefined;

function testRpcPort(): number {
  const explicit = env.ENVIO_TEST_RPC_PORT;
  if (explicit !== undefined && explicit > 0) return explicit;
  return 45_000 + (process.pid % 10_000);
}

function publishServerUrl(url: string): void {
  serverUrl = url;
  for (const chainId of TEST_CHAIN_IDS) {
    process.env[`ENVIO_RPC_URL_${chainId}`] = `${serverUrl}/${chainId}`;
    process.env[`ENVIO_RPC_FALLBACK_URL_${chainId}`] =
      `${serverUrl}/${chainId}`;
  }
}

function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    return value.startsWith("0x") ? value.toLowerCase() : value;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}

function argsKey(args: readonly unknown[] | undefined): string {
  return JSON.stringify(normalize(args ?? []));
}

function callKey(
  chainId: number,
  address: string,
  functionName: string,
  args: readonly unknown[] | undefined,
): string {
  return `${chainId}:${address.toLowerCase()}:${functionName}:${argsKey(args)}`;
}

function codeKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

function chainIdFromRequest(req: IncomingMessage): number {
  const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
  const raw = parsed.pathname.replace("/", "");
  const chainId = Number(raw);
  return Number.isFinite(chainId) ? chainId : 42220;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function jsonResponse(id: JsonRpcRequest["id"], result: unknown): object {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonError(id: JsonRpcRequest["id"], message: string): object {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code: -32000, message },
  };
}

function handleRpcCall(chainId: number, request: JsonRpcRequest): object {
  const id = request.id;
  if (request.method === "eth_chainId") {
    return jsonResponse(id, toHex(chainId));
  }
  if (request.method === "eth_blockNumber") {
    return jsonResponse(id, "0x1");
  }
  if (request.method === "eth_getCode") {
    const [address] = request.params ?? [];
    const mock = codeMocks.get(codeKey(chainId, String(address)));
    if (!mock) return jsonResponse(id, "0x");
    if (mock.kind === "error") return jsonError(id, mock.message);
    return jsonResponse(id, mock.result);
  }
  if (request.method !== "eth_call") {
    return jsonError(id, `Unsupported test RPC method: ${request.method}`);
  }

  const [rawCall] = request.params ?? [];
  const call = rawCall as { to?: string; data?: `0x${string}` };
  const to = call.to?.toLowerCase();
  const data = call.data;
  if (!to || !data) return jsonError(id, "Malformed eth_call test request");

  let decoded: ReturnType<typeof decodeFunctionData<typeof TEST_RPC_ABI>>;
  try {
    decoded = decodeFunctionData({ abi: TEST_RPC_ABI, data });
  } catch {
    return jsonError(id, `No test ABI entry for calldata ${data.slice(0, 10)}`);
  }

  const functionName = String(decoded.functionName);
  const exact = callKey(chainId, to, functionName, decoded.args);
  const mock = callMocks.get(exact);
  if (!mock) {
    return jsonError(
      id,
      `No test RPC mock for ${chainId}:${to}:${functionName}`,
    );
  }
  if (mock.kind === "error") return jsonError(id, mock.message);
  if (mock.kind === "raw") return jsonResponse(id, mock.result);
  const result = encodeFunctionResult({
    abi: TEST_RPC_ABI,
    functionName,
    result: mock.result as never,
  });
  return jsonResponse(id, result);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const chainId = chainIdFromRequest(req);
  const body = await readBody(req);
  const parsed = JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[];
  const payload = Array.isArray(parsed)
    ? parsed.map((item) => handleRpcCall(chainId, item))
    : handleRpcCall(chainId, parsed);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

export function ensureHttpTestRpc(): void {
  if (!serverUrl) {
    const explicitPort = env.ENVIO_TEST_RPC_PORT;
    const startServer = (port: number): void => {
      rpcServer = createServer((req, res) => {
        handleRequest(req, res).catch((err) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        });
      });
      if (port > 0) publishServerUrl(`http://127.0.0.1:${port}`);
      serverReady = new Promise((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          rpcServer?.off("listening", onListening);
          if (
            err.code === "EADDRINUSE" &&
            explicitPort === undefined &&
            port !== 0
          ) {
            rpcServer?.close();
            rpcServer = undefined;
            serverUrl = undefined;
            startServer(0);
            serverReady?.then(resolve, reject);
            return;
          }
          reject(err);
        };
        const onListening = () => {
          rpcServer?.off("error", onError);
          const address = rpcServer?.address();
          const actualPort =
            typeof address === "object" && address !== null
              ? address.port
              : port;
          publishServerUrl(`http://127.0.0.1:${actualPort}`);
          resolve();
        };
        rpcServer?.once("error", onError);
        rpcServer?.once("listening", onListening);
        rpcServer?.listen(port, "127.0.0.1");
      });
    };
    startServer(testRpcPort());
  }
}

export async function waitForHttpTestRpc(): Promise<void> {
  ensureHttpTestRpc();
  await serverReady;
}

export function setHttpRpcMock(args: {
  group: string;
  chainId: number;
  address: string;
  functionName: string;
  callArgs?: readonly unknown[];
  result: unknown;
}): void {
  ensureHttpTestRpc();
  callMocks.set(
    callKey(args.chainId, args.address, args.functionName, args.callArgs),
    {
      group: args.group,
      kind: "result",
      functionName: args.functionName,
      result: args.result,
    },
  );
}

export function setHttpRpcErrorMock(args: {
  group: string;
  chainId: number;
  address: string;
  functionName: string;
  callArgs?: readonly unknown[];
  message?: string;
}): void {
  ensureHttpTestRpc();
  callMocks.set(
    callKey(args.chainId, args.address, args.functionName, args.callArgs),
    {
      group: args.group,
      kind: "error",
      message: args.message ?? "Mock transient RPC failure",
    },
  );
}

export function setHttpRpcRawMock(args: {
  group: string;
  chainId: number;
  address: string;
  functionName: string;
  callArgs?: readonly unknown[];
  result: string;
}): void {
  ensureHttpTestRpc();
  callMocks.set(
    callKey(args.chainId, args.address, args.functionName, args.callArgs),
    { group: args.group, kind: "raw", result: args.result },
  );
}

export function setHttpGetCodeMock(args: {
  group: string;
  chainId: number;
  address: string;
  result: string;
}): void {
  ensureHttpTestRpc();
  codeMocks.set(codeKey(args.chainId, args.address), {
    group: args.group,
    kind: "result",
    result: args.result,
  });
}

export function setHttpGetCodeErrorMock(args: {
  group: string;
  chainId: number;
  address: string;
  message?: string;
}): void {
  ensureHttpTestRpc();
  codeMocks.set(codeKey(args.chainId, args.address), {
    group: args.group,
    kind: "error",
    message: args.message ?? "Mock getCode RPC failure",
  });
}

export function clearHttpRpcMockGroup(group: string): void {
  for (const [key, mock] of callMocks) {
    if (mock.group === group) {
      callMocks.delete(key);
    }
  }
  for (const [key, mock] of codeMocks) {
    if (mock.group === group) {
      codeMocks.delete(key);
    }
  }
}

export function clearHttpRpcMockGroupPrefix(prefix: string): void {
  for (const [key, mock] of callMocks) {
    if (mock.group.startsWith(prefix)) {
      callMocks.delete(key);
    }
  }
  for (const [key, mock] of codeMocks) {
    if (mock.group.startsWith(prefix)) {
      codeMocks.delete(key);
    }
  }
}

registerHttpTestRpcHandlers({
  setHttpRpcMock,
  setHttpRpcErrorMock,
  setHttpRpcRawMock,
  setHttpGetCodeMock,
  setHttpGetCodeErrorMock,
  clearHttpRpcMockGroup,
  clearHttpRpcMockGroupPrefix,
});
