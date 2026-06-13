import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Counter, Histogram } from 'prom-client';
import {
  createPublicClient,
  http,
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

    const vars = chain.vars;
    const contractName = metric.source.contract;
    const functionName = metric.source.functionAbi.name;
    if (!functionName) {
      throw new Error(`Missing function name for metric ${metric.name}`);
    }
    const args = metric.args.map((arg) => {
      const value = vars[arg];
      if (value === undefined) {
        return arg;
      }
      return value;
    });

    const timer = this.queryTime.startTimer({
      contract: metric.source.contract,
      functionName: metric.source.functionAbi.name,
      chain: metric.chain,
    });
    try {
      let data: unknown;
      try {
        data = await this.executeCall(client, metric, chain, args);
      } catch (primaryError) {
        const fallbackClient = this.fallbackClients[metric.chain];
        if (!fallbackClient) {
          throw primaryError;
        }
        this.logger.warn(
          `Primary RPC failed for ${contractName}.${functionName} on ${metric.chain}, retrying with fallback`,
        );
        data = await this.executeCall(fallbackClient, metric, chain, args);
      }
      const value = metric.parse(data, contractName, functionName);
      timer({ status: 'success' });
      return value;
    } catch (e) {
      this.logger.error(e);
      this.rpcErrors.inc({
        contract: metric.source.contract,
        functionName: metric.source.functionAbi.name,
        chain: metric.chain,
      });
      timer({ status: 'error' });
      return undefined;
    }
  }
}
