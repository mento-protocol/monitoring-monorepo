import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { register } from 'prom-client';
import { createPublicClient, http, HttpRequestError } from 'viem';
import { ChainConfig } from './config';
import { Metric } from './metric';
import { QueryService } from './query.service';

// Preserve viem's real error classes (HttpRequestError, etc.) so the source's
// `instanceof` transport-error checks work; only stub the two functions we mock.
jest.mock('viem', () => ({
  ...jest.requireActual('viem'),
  createPublicClient: jest.fn(),
  http: jest.fn((url: string) => ({ url })),
}));

const mockCreatePublicClient = jest.mocked(createPublicClient);
const mockHttp = jest.mocked(http);

// A representative transport-level error (endpoint unreachable). Used where a
// test needs the retry/counter path to fire.
const makeTransportError = (message: string): HttpRequestError =>
  new HttpRequestError({ url: 'http://localhost:8545', details: message });

const readContract = jest.fn();
const getBalance = jest.fn();

const chain = {
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

const makeConfigService = (
  chains: ChainConfig[] | undefined = [chain],
  hasChains = true,
): jest.Mocked<ConfigService> =>
  ({
    get: jest.fn((key: string) => {
      if (key === 'chains') return hasChains ? chains : undefined;
      return undefined;
    }),
  }) as unknown as jest.Mocked<ConfigService>;

const makeMetric = (overrides: Record<string, unknown> = {}): Metric =>
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

describe('QueryService', () => {
  beforeEach(() => {
    register.clear();
    readContract.mockReset();
    getBalance.mockReset();
    mockCreatePublicClient.mockReset();
    mockHttp.mockClear();
    mockCreatePublicClient.mockReturnValue({
      readContract,
      getBalance,
    } as unknown as ReturnType<typeof createPublicClient>);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    register.clear();
  });

  it('creates a public client for each configured chain', () => {
    new QueryService(makeConfigService());

    expect(mockHttp).toHaveBeenCalledWith('http://localhost:8545');
    expect(mockCreatePublicClient).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: expect.objectContaining({
          name: 'localnet',
        }),
        transport: { url: 'http://localhost:8545' },
      }),
    );
  });

  it('throws when no chains are configured', () => {
    expect(() => new QueryService(makeConfigService(undefined, false))).toThrow(
      'No chains configured',
    );
  });

  it('queries contracts with chain variable substitution and parses the result', async () => {
    readContract.mockResolvedValue(2n);
    const service = new QueryService(makeConfigService());
    const metric = makeMetric();

    await expect(service.query(metric)).resolves.toBe(1);

    expect(readContract).toHaveBeenCalledWith({
      address: '0x0000000000000000000000000000000000000001',
      abi: [metric.source.functionAbi],
      functionName: 'getRateFeedTradingMode',
      args: ['0xfeed', 'literal'],
    });
    expect(metric.parse).toHaveBeenCalledWith(
      2n,
      'BreakerBox',
      'getRateFeedTradingMode',
    );
  });

  it('queries native balances through getBalance', async () => {
    getBalance.mockResolvedValue(10n);
    const service = new QueryService(makeConfigService());
    const metric = makeMetric({
      source: {
        contract: 'Native',
        raw: 'Native.balanceOf(address account)(uint256 balance)',
        functionAbi: {
          type: 'function',
          name: 'balanceOf',
          stateMutability: 'view',
          inputs: [{ type: 'address', name: 'account' }],
          outputs: [{ type: 'uint256', name: 'balance' }],
        },
      },
      args: ['0x0000000000000000000000000000000000000004'],
      parse: jest.fn(() => 10),
    });

    await expect(service.query(metric)).resolves.toBe(10);

    expect(getBalance).toHaveBeenCalledWith({
      address: '0x0000000000000000000000000000000000000004',
    });
    expect(readContract).not.toHaveBeenCalled();
  });

  it('returns undefined and records an error path when a view call fails', async () => {
    const error = new Error('rpc unavailable');
    readContract.mockRejectedValue(error);
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const service = new QueryService(makeConfigService());
    const metric = makeMetric();

    await expect(service.query(metric)).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledWith(error);
    expect(metric.parse).not.toHaveBeenCalled();
  });

  it('throws before querying when the metric chain is unknown', async () => {
    const service = new QueryService(makeConfigService());

    await expect(
      service.query(makeMetric({ chain: 'missing-chain' })),
    ).rejects.toThrow(
      'Unknown chain missing-chain in metric: BreakerBox_getRateFeedTradingMode',
    );
    expect(readContract).not.toHaveBeenCalled();
  });

  it('throws before querying when the function name is missing', async () => {
    const service = new QueryService(makeConfigService());
    const metric = makeMetric({
      source: {
        contract: 'BreakerBox',
        raw: 'BreakerBox.getRateFeedTradingMode()(uint8 mode)',
        functionAbi: {
          type: 'function',
          stateMutability: 'view',
          inputs: [],
          outputs: [{ type: 'uint8', name: 'mode' }],
        },
      },
    });

    await expect(service.query(metric)).rejects.toThrow(
      'Missing function name for metric BreakerBox_getRateFeedTradingMode',
    );
    expect(readContract).not.toHaveBeenCalled();
  });

  // (A) Counter increments on a transport failure with no fallback
  it('increments rpcErrors counter when a transport call fails and no fallback is configured', async () => {
    readContract.mockRejectedValue(makeTransportError('rpc unavailable'));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = new QueryService(makeConfigService());
    const metric = makeMetric();

    await expect(service.query(metric)).resolves.toBeUndefined();

    const metrics = await service.rpcErrors.get();
    expect(metrics.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: {
            contract: 'BreakerBox',
            functionName: 'getRateFeedTradingMode',
            chain: 'localnet',
          },
          value: 1,
        }),
      ]),
    );
  });

  // (B) Fallback used when primary fails with a transport error
  it('retries via fallback client when primary RPC fails with a transport error', async () => {
    const primaryReadContract = jest
      .fn()
      .mockRejectedValue(makeTransportError('primary down'));
    const fallbackReadContract = jest.fn().mockResolvedValue(42n);

    mockCreatePublicClient
      .mockReturnValueOnce({
        readContract: primaryReadContract,
        getBalance: jest.fn(),
      } as unknown as ReturnType<typeof createPublicClient>)
      .mockReturnValueOnce({
        readContract: fallbackReadContract,
        getBalance: jest.fn(),
      } as unknown as ReturnType<typeof createPublicClient>);

    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const chainWithFallback = {
      ...chain,
      fallbackHttpRpcUrl: 'http://localhost:8546',
    } as unknown as ChainConfig;
    const service = new QueryService(makeConfigService([chainWithFallback]));
    const metric = makeMetric({ parse: jest.fn(() => 42) });

    await expect(service.query(metric)).resolves.toBe(42);

    expect(primaryReadContract).toHaveBeenCalledTimes(1);
    expect(fallbackReadContract).toHaveBeenCalledTimes(1);
  });

  // (C) Counter NOT incremented when fallback succeeds
  it('does not increment rpcErrors counter when fallback succeeds', async () => {
    const primaryReadContract = jest
      .fn()
      .mockRejectedValue(makeTransportError('primary down'));
    const fallbackReadContract = jest.fn().mockResolvedValue(42n);

    mockCreatePublicClient
      .mockReturnValueOnce({
        readContract: primaryReadContract,
        getBalance: jest.fn(),
      } as unknown as ReturnType<typeof createPublicClient>)
      .mockReturnValueOnce({
        readContract: fallbackReadContract,
        getBalance: jest.fn(),
      } as unknown as ReturnType<typeof createPublicClient>);

    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const chainWithFallback = {
      ...chain,
      fallbackHttpRpcUrl: 'http://localhost:8546',
    } as unknown as ChainConfig;
    const service = new QueryService(makeConfigService([chainWithFallback]));
    const metric = makeMetric({ parse: jest.fn(() => 42) });

    await expect(service.query(metric)).resolves.toBe(42);

    const metrics = await service.rpcErrors.get();
    const total = metrics.values.reduce((sum, v) => sum + v.value, 0);
    expect(total).toBe(0);
  });

  // (D) Counter incremented when both primary and fallback fail (transport)
  it('increments rpcErrors counter when both primary and fallback fail', async () => {
    const primaryError = makeTransportError('primary down');
    const fallbackError = makeTransportError('fallback down');
    const primaryReadContract = jest.fn().mockRejectedValue(primaryError);
    const fallbackReadContract = jest.fn().mockRejectedValue(fallbackError);

    mockCreatePublicClient
      .mockReturnValueOnce({
        readContract: primaryReadContract,
        getBalance: jest.fn(),
      } as unknown as ReturnType<typeof createPublicClient>)
      .mockReturnValueOnce({
        readContract: fallbackReadContract,
        getBalance: jest.fn(),
      } as unknown as ReturnType<typeof createPublicClient>);

    const loggerWarn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    const chainWithFallback = {
      ...chain,
      fallbackHttpRpcUrl: 'http://localhost:8546',
    } as unknown as ChainConfig;
    const service = new QueryService(makeConfigService([chainWithFallback]));
    const metric = makeMetric();

    await expect(service.query(metric)).resolves.toBeUndefined();

    // The warn fires before the fallback is attempted and carries the primary error.
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Primary RPC failed for BreakerBox.getRateFeedTradingMode on localnet',
      ),
    );
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('primary down'),
    );
    // When both fail, the error log surfaces BOTH errors, not just the fallback.
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('primary down'),
    );
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('fallback down'),
    );

    const metrics = await service.rpcErrors.get();
    expect(metrics.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: {
            contract: 'BreakerBox',
            functionName: 'getRateFeedTradingMode',
            chain: 'localnet',
          },
          value: 1,
        }),
      ]),
    );
  });

  // (E) Counter NOT incremented when the RPC succeeds but parse throws.
  // The counter tracks RPC-transport failures only, not parse/validation errors.
  it('does not increment rpcErrors counter when parse fails after a successful RPC', async () => {
    readContract.mockResolvedValue(2n);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = new QueryService(makeConfigService());
    const metric = makeMetric({
      parse: jest.fn(() => {
        throw new Error('unparseable value');
      }),
    });

    await expect(service.query(metric)).resolves.toBeUndefined();

    const metrics = await service.rpcErrors.get();
    const total = metrics.values.reduce((sum, v) => sum + v.value, 0);
    expect(total).toBe(0);
  });

  // (F) A deterministic call failure (e.g. contract revert) is NOT a transport
  // error: the fallback must not be tried and the counter must stay flat, since
  // the same error would reproduce on every healthy endpoint.
  it('does not retry fallback or increment counter on a non-transport (deterministic) error', async () => {
    const primaryReadContract = jest
      .fn()
      .mockRejectedValue(new Error('execution reverted'));
    const fallbackReadContract = jest.fn().mockResolvedValue(99n);

    mockCreatePublicClient
      .mockReturnValueOnce({
        readContract: primaryReadContract,
        getBalance: jest.fn(),
      } as unknown as ReturnType<typeof createPublicClient>)
      .mockReturnValueOnce({
        readContract: fallbackReadContract,
        getBalance: jest.fn(),
      } as unknown as ReturnType<typeof createPublicClient>);

    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const chainWithFallback = {
      ...chain,
      fallbackHttpRpcUrl: 'http://localhost:8546',
    } as unknown as ChainConfig;
    const service = new QueryService(makeConfigService([chainWithFallback]));
    const metric = makeMetric();

    await expect(service.query(metric)).resolves.toBeUndefined();

    // Fallback must NOT be attempted for a deterministic error.
    expect(fallbackReadContract).not.toHaveBeenCalled();

    // Counter must stay flat — this is a protocol/config failure, not an outage.
    const metrics = await service.rpcErrors.get();
    const total = metrics.values.reduce((sum, v) => sum + v.value, 0);
    expect(total).toBe(0);
  });
});
