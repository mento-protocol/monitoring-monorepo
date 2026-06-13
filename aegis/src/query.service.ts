import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Counter, Histogram } from 'prom-client';
import {
  createPublicClient,
  http,
  HttpRequestError,
  RpcRequestError,
  TimeoutError,
  WebSocketRequestError,
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

// Transport-level failures (endpoint unreachable/slow/malformed response) are
// retryable on another endpoint and are what `view_call_rpc_errors_total` is
// meant to track. Deterministic call failures — contract reverts, bad ABI/args,
// invalid addresses — reproduce on every healthy endpoint, so they are NOT
// transport errors: retrying is pointless and counting them as RPC outages
// would mislead Grafana. viem nests the underlying cause, so walk the chain.
const isTransportError = (err: unknown): boolean => {
  let current: unknown = err;
  for (let depth = 0; current != null && depth < 10; depth += 1) {
    if (
      current instanceof HttpRequestError ||
      current instanceof RpcRequestError ||
      current instanceof TimeoutError ||
      current instanceof WebSocketRequestError
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
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
      this.clients[chain.id] = createPublicClient({
        chain:
          (chains as Record<string, chains.Chain>)[chain.id] ??
          makeChain(chain),
        transport: http(chain.httpRpcUrl),
      });
      this.fallbackClients[chain.id] = chain.fallbackHttpRpcUrl
        ? createPublicClient({
            chain:
              (chains as Record<string, chains.Chain>)[chain.id] ??
              makeChain(chain),
            transport: http(chain.fallbackHttpRpcUrl),
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
