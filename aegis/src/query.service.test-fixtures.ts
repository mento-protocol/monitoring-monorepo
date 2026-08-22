import { ConfigService } from '@nestjs/config';
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  HttpRequestError,
  RpcRequestError,
} from 'viem';
import { ChainConfig } from './config';
import { Metric } from './metric';

export const makeTransportError = (message: string): HttpRequestError =>
  new HttpRequestError({ url: 'http://localhost:8545', details: message });

export const makeRevertError = (): ContractFunctionExecutionError => {
  const cause = new ContractFunctionRevertedError({
    abi: [],
    functionName: 'getRateFeedTradingMode',
    message: 'execution reverted',
  });
  return new ContractFunctionExecutionError(cause, {
    abi: [
      {
        type: 'function',
        name: 'getRateFeedTradingMode',
        inputs: [],
        outputs: [],
        stateMutability: 'view',
      },
    ],
    functionName: 'getRateFeedTradingMode',
  });
};

export const makeRpcRevertError = (): RpcRequestError =>
  new RpcRequestError({
    body: { method: 'eth_call', params: [] },
    error: { code: 3, message: 'execution reverted' },
    url: 'http://localhost:8545',
  });

export const makeTransportWrappedInExecutionError =
  (): ContractFunctionExecutionError =>
    new ContractFunctionExecutionError(
      new HttpRequestError({
        url: 'http://localhost:8545',
        details: 'connection refused',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
      {
        abi: [
          {
            type: 'function',
            name: 'getRateFeedTradingMode',
            inputs: [],
            outputs: [],
            stateMutability: 'view',
          },
        ],
        functionName: 'getRateFeedTradingMode',
      },
    );

export const chain = {
  id: 'localnet',
  label: 'Localnet',
  httpRpcUrl: 'http://localhost:8545',
  contracts: {
    BreakerBox: '0x0000000000000000000000000000000000000001',
  },
  vars: {
    FeedId: '0xfeed',
  },
} as unknown as ChainConfig;

export const makeConfigService = (
  chains: ChainConfig[] | undefined = [chain],
  hasChains = true,
): jest.Mocked<ConfigService> =>
  ({
    get: jest.fn((key: string) => {
      if (key === 'chains') return hasChains ? chains : undefined;
      return undefined;
    }),
  }) as unknown as jest.Mocked<ConfigService>;

export const makeMetric = (overrides: Record<string, unknown> = {}): Metric =>
  ({
    chain: 'localnet',
    name: 'BreakerBox_getRateFeedTradingMode',
    source: {
      contract: 'BreakerBox',
      raw: 'BreakerBox.getRateFeedTradingMode(bytes32 rateFeedId)(uint8 mode)',
      functionAbi: {
        type: 'function',
        name: 'getRateFeedTradingMode',
        stateMutability: 'view',
        inputs: [{ type: 'bytes32', name: 'rateFeedId' }],
        outputs: [{ type: 'uint8', name: 'mode' }],
      },
    },
    args: ['FeedId', 'literal'],
    parse: jest.fn(() => 1),
    ...overrides,
  }) as unknown as Metric;
