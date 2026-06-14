import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Counter, Histogram } from 'prom-client';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  http,
  RpcRequestError,
  type Address,
  type PublicClient,
} from 'viem';
import * as chains from 'viem/chains';
import { ChainConfig } from './config';
import { Metric } from './metric';

const makeChain = (chain: ChainConfig): chains.Chain => ({
  id: 0,
  name: chain.id,
  nativeCurrency: {
    name: chain.id,
    symbol: chain.id,
    decimals: 18,
  },
  rpcUrls: {
    default: { http: [chain.httpRpcUrl] },
    public: { http: [chain.httpRpcUrl] },
  },
});

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// JSON-RPC error code 3 = execution reverted (EIP-1474 / Ethereum yellow paper).
const EXECUTION_REVERT_CODE = 3;

// Returns true when an RpcRequestError is a server-side execution revert rather
// than a transport problem.  Code 3 is the canonical revert code; the message
// fallback catches non-standard nodes that omit the code field.
const isRevertRpcError = (err: RpcRequestError): boolean =>
  err.code === EXECUTION_REVERT_CODE ||
  err.message.toLowerCase().includes('execution reverted') ||
  err.message.toLowerCase().includes('revert');

// Matches any viem error whose .name indicates a bad ABI definition, encoding
// failure, or argument shape problem — errors that are 100% deterministic (they
// reproduce on every healthy endpoint) but are NOT caught by isinstance checks
// alone, because viem exports many individual Abi* classes.
//
// Covered by the first branch (`/^Abi/`):
//   AbiConstructorNotFoundError, AbiConstructorParamsNotFoundError,
//   AbiDecodingDataSizeInvalidError, AbiDecodingDataSizeTooSmallError,
//   AbiDecodingZeroDataError, AbiEncodingArrayLengthMismatchError,
//   AbiEncodingBytesSizeMismatchError, AbiEncodingLengthMismatchError,
//   AbiErrorInputsNotFoundError, AbiErrorNotFoundError,
//   AbiErrorSignatureNotFoundError, AbiEventNotFoundError,
//   AbiEventSignatureEmptyTopicsError, AbiEventSignatureNotFoundError,
//   AbiFunctionNotFoundError, AbiFunctionOutputsNotFoundError,
//   AbiFunctionSignatureNotFoundError, AbiItemAmbiguityError
//
// Covered by the second branch (`/^Invalid(Abi|Array|Definition)/`):
//   InvalidAbiEncodingTypeError, InvalidAbiDecodingTypeError,
//   InvalidArrayError, InvalidDefinitionTypeError
//
// Note: InvalidAddressError (from viem/errors/address.ts) is also covered by
// /^Invalid/ but lives outside abi.ts — we include it deliberately.
const ABI_ERROR_NAME_RE =
  /^Abi[A-Za-z]*Error$|^Invalid(?:Abi|Array|Definition|Address)[A-Za-z]*Error$/;

// Transport-level failures (endpoint unreachable/slow/malformed response) are
// retryable on another endpoint and are what `view_call_rpc_errors_total` is
// meant to track. Deterministic call failures — contract reverts, bad ABI/args,
// encoding errors, invalid addresses — reproduce on every healthy endpoint, so
// they are NOT transport errors: retrying is pointless and counting them as RPC
// outages would mislead Grafana.
//
// IMPORTANT: viem's `readContract` wraps nearly ALL failures — including
// transport failures — inside ContractFunctionExecutionError. That wrapper is
// NOT a determinism signal. Only the specific cause types nested within it are.
// We use BaseError.walk() to inspect the full error chain for those causes.
// RpcRequestError can appear in both contexts: viem nests it under revert
// wrappers for on-chain reverts, but it also surfaces directly for network-level
// JSON-RPC failures.
//
// When genuinely ambiguous, we default to TRANSPORT so real outages are caught.
const isTransportError = (err: unknown): boolean => {
  if (!(err instanceof BaseError)) {
    // Unknown / non-viem error — default to transport so outages are captured.
    return true;
  }

  // Deterministic: on-chain reverts, ALL ABI/encoding/argument errors (matched
  // by name regex — covers the full viem Abi* and Invalid* surface), and
  // invalid addresses. ContractFunctionExecutionError is intentionally EXCLUDED
  // — it is the wrapper viem uses for nearly all failures, including transport
  // errors, so the wrapper alone is not a determinism signal.
  const isDeterministic = err.walk(
    (e) =>
      e instanceof ContractFunctionRevertedError ||
      // Name-based match catches the entire Abi*/Invalid* error family in viem,
      // including AbiEncoding*, AbiDecoding*, AbiFunctionNotFound*, and friends.
      (e instanceof BaseError && ABI_ERROR_NAME_RE.test(e.name)) ||
      // RpcRequestError whose code/message signals a server-side revert.
      (e instanceof RpcRequestError && isRevertRpcError(e)),
  );

  return isDeterministic === null;
};

@Injectable()
export class QueryService {
  private readonly logger = new Logger(QueryService.name);
  chains: Record<string, ChainConfig> = {};
  clients: Record<string, PublicClient> = {};
  fallbackClients: Record<string, PublicClient | undefined> = {};
  queryTime: Histogram;
  rpcErrors: Counter;

  constructor(configService: ConfigService) {
    const chainConfigs = configService.get<ChainConfig[]>('chains');
    if (!chainConfigs) {
      throw new Error('No chains configured');
    }
    chainConfigs.forEach((chain) => {
      this.chains[chain.id] = chain;
      // retryCount: 0 disables viem's built-in per-transport retry loop (default
      // is 3). We manage retries explicitly via the primary→fallback logic below;
      // letting viem retry internally would compound latency and undermine the
      // single-fallback posture described in AGENTS.md.
      this.clients[chain.id] = createPublicClient({
        chain:
          (chains as Record<string, chains.Chain>)[chain.id] ??
          makeChain(chain),
        transport: http(chain.httpRpcUrl, { retryCount: 0 }),
      });
      this.fallbackClients[chain.id] = chain.fallbackHttpRpcUrl
        ? createPublicClient({
            chain:
              (chains as Record<string, chains.Chain>)[chain.id] ??
              makeChain(chain),
            transport: http(chain.fallbackHttpRpcUrl, { retryCount: 0 }),
          })
        : undefined;
    });

    this.queryTime = new Histogram({
      name: 'view_call_query_duration',
      help: 'Histogram of view calls to the blockchain node',
      labelNames: ['contract', 'functionName', 'chain', 'status'],
    });

    this.rpcErrors = new Counter({
      name: 'view_call_rpc_errors_total',
      help: 'Total number of RPC errors when querying view calls',
      labelNames: ['contract', 'functionName', 'chain'],
    });
  }

  private async executeCall(
    client: PublicClient,
    metric: Metric,
    chain: ChainConfig,
    args: unknown[],
  ): Promise<unknown> {
    const contractName = metric.source.contract;
    const functionName = metric.source.functionAbi.name;
    const abi = metric.source.functionAbi;

    if (contractName === 'Native') {
      return client.getBalance({ address: args[0] as Address });
    }
    return client.readContract({
      address: chain.contracts[contractName] as Address,
      abi: [abi],
      functionName,
      args,
    });
  }

  /**
   * Attempts the primary RPC call, then the fallback if available.
   * Returns the raw on-chain data or throws when all endpoints fail.
   *
   * The fallback is only attempted for transport-level errors (endpoint
   * down/slow). A deterministic call failure (revert, bad ABI/args) would
   * reproduce on the fallback, so it is re-thrown immediately. Logs on
   * all-endpoints-exhausted paths; never increments the counter (the caller
   * decides that based on whether the thrown error is transport-level).
   */
  private async fetchWithFallback(
    client: PublicClient,
    metric: Metric,
    chain: ChainConfig,
    args: unknown[],
  ): Promise<unknown> {
    const label = `${metric.source.contract}.${metric.source.functionAbi.name} on ${metric.chain}`;
    let primaryError: unknown;
    try {
      return await this.executeCall(client, metric, chain, args);
    } catch (e) {
      primaryError = e;
    }

    const fallbackClient = this.fallbackClients[metric.chain];
    if (fallbackClient && isTransportError(primaryError)) {
      this.logger.warn(
        `Primary RPC failed for ${label}, retrying with fallback: ${errMsg(primaryError)}`,
      );
      try {
        return await this.executeCall(fallbackClient, metric, chain, args);
      } catch (fallbackError) {
        this.logger.error(
          `Both primary and fallback RPC failed for ${label}. Primary: ${errMsg(primaryError)}. Fallback: ${errMsg(fallbackError)}`,
        );
        throw fallbackError;
      }
    }

    // No usable fallback (none configured, or the error is deterministic and
    // would just reproduce) — re-throw the primary error for the caller.
    this.logger.error(primaryError);
    throw primaryError;
  }

  async query(metric: Metric): Promise<number | number[] | undefined> {
    if (this.chains[metric.chain] === undefined) {
      throw new Error(
        `Unknown chain ${metric.chain} in metric: ${metric.name}`,
      );
    }

    const chain = this.chains[metric.chain];
    const client = this.clients[metric.chain];
    if (!chain || !client) {
      throw new Error(
        `Unknown chain ${metric.chain} in metric: ${metric.name}`,
      );
    }

    const contractName = metric.source.contract;
    const functionName = metric.source.functionAbi.name;
    if (!functionName) {
      throw new Error(`Missing function name for metric ${metric.name}`);
    }
    const args = metric.args.map((arg) => chain.vars[arg] ?? arg);

    const timer = this.queryTime.startTimer({
      contract: contractName,
      functionName,
      chain: metric.chain,
    });

    let data: unknown;
    try {
      data = await this.fetchWithFallback(client, metric, chain, args);
    } catch (rpcError) {
      // rpcErrors counts only transport-level failures (endpoint down/slow,
      // all endpoints exhausted). Deterministic call failures (revert, bad
      // ABI/args) and parse errors below are intentionally excluded — they
      // are not RPC outages and would mislabel a config/protocol problem.
      if (isTransportError(rpcError)) {
        this.rpcErrors.inc({
          contract: contractName,
          functionName,
          chain: metric.chain,
        });
      }
      timer({ status: 'error' });
      return undefined;
    }

    try {
      const value = metric.parse(data, contractName, functionName);
      timer({ status: 'success' });
      return value;
    } catch (parseError) {
      this.logger.error(parseError);
      timer({ status: 'error' });
      return undefined;
    }
  }
}
