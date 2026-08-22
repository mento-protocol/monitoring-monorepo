import { Logger } from '@nestjs/common';
import { register } from 'prom-client';
import { createPublicClient, http } from 'viem';
import { QueryService } from './query.service';
import { makeConfigService, makeMetric } from './query.service.test-fixtures';

jest.mock('viem', () => ({
  ...jest.requireActual('viem'),
  createPublicClient: jest.fn(),
  http: jest.fn((url: string, opts?: Record<string, unknown>) => ({
    url,
    ...opts,
  })),
}));

const mockCreatePublicClient = jest.mocked(createPublicClient);
const mockHttp = jest.mocked(http);
const readContract = jest.fn();
const getBalance = jest.fn();

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

  it('creates a public client for each configured chain with retryCount 0', () => {
    new QueryService(makeConfigService());

    expect(mockHttp).toHaveBeenCalledWith('http://localhost:8545', {
      retryCount: 0,
    });
    expect(mockCreatePublicClient).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: expect.objectContaining({
          name: 'localnet',
        }),
        transport: { url: 'http://localhost:8545', retryCount: 0 },
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
    readContract.mockRejectedValue(new Error('rpc unavailable'));
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const service = new QueryService(makeConfigService());
    const metric = makeMetric();

    await expect(service.query(metric)).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledWith(
      'RPC call failed for BreakerBox.getRateFeedTradingMode on localnet: rpc unavailable',
    );
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
});
