import { Logger } from '@nestjs/common';
import { register } from 'prom-client';
import { AbiEncodingLengthMismatchError, createPublicClient } from 'viem';
import { ChainConfig } from './config';
import { QueryService } from './query.service';
import {
  chain,
  makeConfigService,
  makeMetric,
  makeRevertError,
  makeRpcRevertError,
  makeTransportError,
  makeTransportWrappedInExecutionError,
} from './query.service.test-fixtures';

jest.mock('viem', () => ({
  ...jest.requireActual('viem'),
  createPublicClient: jest.fn(),
  http: jest.fn((url: string, opts?: Record<string, unknown>) => ({
    url,
    ...opts,
  })),
}));

const mockCreatePublicClient = jest.mocked(createPublicClient);
const readContract = jest.fn();
const getBalance = jest.fn();

const makeFallbackService = (
  primaryReadContract: jest.Mock,
  fallbackReadContract: jest.Mock,
): QueryService => {
  mockCreatePublicClient
    .mockReturnValueOnce({
      readContract: primaryReadContract,
      getBalance: jest.fn(),
    } as unknown as ReturnType<typeof createPublicClient>)
    .mockReturnValueOnce({
      readContract: fallbackReadContract,
      getBalance: jest.fn(),
    } as unknown as ReturnType<typeof createPublicClient>);

  const chainWithFallback = {
    ...chain,
    fallbackHttpRpcUrl: 'http://localhost:8546',
  } as unknown as ChainConfig;
  return new QueryService(makeConfigService([chainWithFallback]));
};

const rpcErrorTotal = async (service: QueryService): Promise<number> => {
  const metrics = await service.rpcErrors.get();
  return metrics.values.reduce((sum, value) => sum + value.value, 0);
};

describe('QueryService RPC fallback and error handling', () => {
  beforeEach(() => {
    register.clear();
    readContract.mockReset();
    getBalance.mockReset();
    mockCreatePublicClient.mockReset();
    mockCreatePublicClient.mockReturnValue({
      readContract,
      getBalance,
    } as unknown as ReturnType<typeof createPublicClient>);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    register.clear();
  });

  it('increments the counter when a transport call fails without a fallback', async () => {
    readContract.mockRejectedValue(makeTransportError('rpc unavailable'));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = new QueryService(makeConfigService());

    await expect(service.query(makeMetric())).resolves.toBeUndefined();

    expect(await rpcErrorTotal(service)).toBe(1);
  });

  it('retries through the fallback after a primary transport failure', async () => {
    const primaryReadContract = jest
      .fn()
      .mockRejectedValue(makeTransportError('primary down'));
    const fallbackReadContract = jest.fn().mockResolvedValue(42n);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = makeFallbackService(
      primaryReadContract,
      fallbackReadContract,
    );

    await expect(
      service.query(makeMetric({ parse: jest.fn(() => 42) })),
    ).resolves.toBe(42);
    expect(primaryReadContract).toHaveBeenCalledTimes(1);
    expect(fallbackReadContract).toHaveBeenCalledTimes(1);
  });

  it('does not increment the counter when the fallback succeeds', async () => {
    const primaryReadContract = jest
      .fn()
      .mockRejectedValue(makeTransportError('primary down'));
    const fallbackReadContract = jest.fn().mockResolvedValue(42n);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = makeFallbackService(
      primaryReadContract,
      fallbackReadContract,
    );

    await expect(service.query(makeMetric())).resolves.toBe(1);
    expect(await rpcErrorTotal(service)).toBe(0);
  });

  it('logs and counts a failure of both endpoints', async () => {
    const primaryReadContract = jest
      .fn()
      .mockRejectedValue(makeTransportError('primary down'));
    const fallbackReadContract = jest
      .fn()
      .mockRejectedValue(makeTransportError('fallback down'));
    const loggerWarn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const service = makeFallbackService(
      primaryReadContract,
      fallbackReadContract,
    );

    await expect(service.query(makeMetric())).resolves.toBeUndefined();

    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('Primary RPC failed for'),
    );
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('HTTP request failed.'),
    );
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('Primary: HTTP request failed.'),
    );
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('Fallback: HTTP request failed.'),
    );
    expect(await rpcErrorTotal(service)).toBe(1);
  });

  it('logs primary-only and dual-endpoint failures independently', async () => {
    const primaryReadContract = jest
      .fn()
      .mockRejectedValueOnce(makeRevertError())
      .mockRejectedValueOnce(makeTransportError('primary down'));
    const fallbackReadContract = jest
      .fn()
      .mockRejectedValue(makeTransportError('fallback down'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const service = makeFallbackService(
      primaryReadContract,
      fallbackReadContract,
    );

    await expect(service.query(makeMetric())).resolves.toBeUndefined();
    await expect(service.query(makeMetric())).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledTimes(2);
    expect(loggerError).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('RPC call failed for'),
    );
    expect(loggerError).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('Both RPC endpoints failed for'),
    );
  });

  it('does not count a parse failure as an RPC error', async () => {
    readContract.mockResolvedValue(2n);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = new QueryService(makeConfigService());

    await expect(
      service.query(
        makeMetric({
          parse: jest.fn(() => {
            throw new Error('unparseable value');
          }),
        }),
      ),
    ).resolves.toBeUndefined();
    expect(await rpcErrorTotal(service)).toBe(0);
  });

  it('does not retry or count a contract revert', async () => {
    const primaryReadContract = jest.fn().mockRejectedValue(makeRevertError());
    const fallbackReadContract = jest.fn().mockResolvedValue(99n);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = makeFallbackService(
      primaryReadContract,
      fallbackReadContract,
    );

    await expect(service.query(makeMetric())).resolves.toBeUndefined();
    expect(fallbackReadContract).not.toHaveBeenCalled();
    expect(await rpcErrorTotal(service)).toBe(0);
  });

  it('does not retry or count an RPC revert code', async () => {
    const primaryReadContract = jest
      .fn()
      .mockRejectedValue(makeRpcRevertError());
    const fallbackReadContract = jest.fn().mockResolvedValue(99n);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = makeFallbackService(
      primaryReadContract,
      fallbackReadContract,
    );

    await expect(service.query(makeMetric())).resolves.toBeUndefined();
    expect(fallbackReadContract).not.toHaveBeenCalled();
    expect(await rpcErrorTotal(service)).toBe(0);
  });

  it('retries and counts a wrapped transport failure', async () => {
    const primaryReadContract = jest
      .fn()
      .mockRejectedValue(makeTransportWrappedInExecutionError());
    const fallbackReadContract = jest
      .fn()
      .mockRejectedValue(makeTransportError('fallback down'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = makeFallbackService(
      primaryReadContract,
      fallbackReadContract,
    );

    await expect(service.query(makeMetric())).resolves.toBeUndefined();
    expect(fallbackReadContract).toHaveBeenCalledTimes(1);
    expect(await rpcErrorTotal(service)).toBe(1);
  });

  it('does not retry or count an ABI encoding error', async () => {
    const primaryReadContract = jest.fn().mockRejectedValue(
      new AbiEncodingLengthMismatchError({
        expectedLength: 1,
        givenLength: 0,
      }),
    );
    const fallbackReadContract = jest.fn().mockResolvedValue(99n);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = makeFallbackService(
      primaryReadContract,
      fallbackReadContract,
    );

    await expect(service.query(makeMetric())).resolves.toBeUndefined();
    expect(fallbackReadContract).not.toHaveBeenCalled();
    expect(await rpcErrorTotal(service)).toBe(0);
  });
});
