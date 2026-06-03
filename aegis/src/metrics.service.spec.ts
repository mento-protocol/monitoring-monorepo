import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UUID } from 'crypto';
import { register } from 'prom-client';
import { ChainConfig, MetricTemplate } from './config';
import { MetricSource } from './config/MetricSource';
import { MetricsService } from './metrics.service';
import { QueryService } from './query.service';

const source: MetricSource = {
  contract: 'BreakerBox',
  functionAbi: {
    type: 'function',
    name: 'getRateFeedTradingMode',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32', name: 'rateFeedId' }],
    outputs: [{ type: 'uint8', name: 'mode' }],
  },
  raw: 'BreakerBox.getRateFeedTradingMode(bytes32 rateFeedId)(uint8 mode)',
};

const chains = [
  {
    id: 'chain-a',
    label: 'Chain A',
    httpRpcUrl: 'http://chain-a.local',
    contracts: { BreakerBox: '0x0000000000000000000000000000000000000001' },
    vars: { FeedId: '0xfeed-a' },
  },
  {
    id: 'chain-b',
    label: 'Chain B',
    httpRpcUrl: 'http://chain-b.local',
    contracts: { BreakerBox: '0x0000000000000000000000000000000000000002' },
    vars: { FeedId: '0xfeed-b' },
  },
] as unknown as ChainConfig[];

const templateId = '00000000-0000-4000-8000-000000000001' as UUID;

const makeTemplate = (
  overrides: Partial<MetricTemplate> = {},
): MetricTemplate =>
  ({
    id: templateId,
    source,
    schedule: '* * * * * *',
    type: 'gauge',
    chains: 'all',
    variants: [['FeedId']],
    ...overrides,
  }) as unknown as MetricTemplate;

const makeConfigService = (
  metrics: MetricTemplate[] | undefined = [makeTemplate()],
  chainConfig: ChainConfig[] | undefined = chains,
  hasMetrics = true,
  hasChains = true,
): jest.Mocked<ConfigService> =>
  ({
    get: jest.fn((key: string) => {
      if (key === 'chains') return hasChains ? chainConfig : undefined;
      if (key === 'metrics') return hasMetrics ? metrics : undefined;
      if (key === 'tokens') return {};
      return undefined;
    }),
  }) as unknown as jest.Mocked<ConfigService>;

const makeQueryService = (): jest.Mocked<QueryService> =>
  ({
    query: jest.fn(),
  }) as unknown as jest.Mocked<QueryService>;

describe('MetricsService', () => {
  beforeEach(() => {
    register.clear();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    register.clear();
  });

  it('builds metric instances for every variant and selected chain', () => {
    const service = new MetricsService(
      makeConfigService([makeTemplate({ chains: ['chain-a'] })]),
      makeQueryService(),
    );

    expect(service.chainIds).toEqual(['chain-a', 'chain-b']);
    expect(service.metrics[templateId]).toHaveLength(1);
    expect(service.metrics[templateId]?.[0]?.nameWithLabels).toContain(
      '"chain":"Chain A"',
    );
  });

  it('expands all-chain templates across all configured chains', () => {
    const service = new MetricsService(
      makeConfigService([makeTemplate()]),
      makeQueryService(),
    );

    expect(service.metrics[templateId]).toHaveLength(2);
  });

  it('throws when a template references an unknown chain', () => {
    expect(
      () =>
        new MetricsService(
          makeConfigService([makeTemplate({ chains: ['unknown-chain'] })]),
          makeQueryService(),
        ),
    ).toThrow(`Unknown chain unknown-chain in metric template ${source.raw}`);
  });

  it('throws when chains are missing from config', () => {
    expect(
      () =>
        new MetricsService(
          makeConfigService([makeTemplate()], undefined, true, false),
          makeQueryService(),
        ),
    ).toThrow('No chains configured');
  });

  it('throws when metrics are missing from config', () => {
    expect(
      () =>
        new MetricsService(
          makeConfigService(undefined, chains, false),
          makeQueryService(),
        ),
    ).toThrow('No metrics configured');
  });

  it('refreshes every known template during module initialization', async () => {
    const service = new MetricsService(makeConfigService(), makeQueryService());
    const refreshAll = jest.spyOn(service, 'refreshAll').mockResolvedValue([]);

    await service.onModuleInit();

    expect(refreshAll).toHaveBeenCalledTimes(1);
  });

  it('propagates successful query values into metric gauges', async () => {
    const queryService = makeQueryService();
    queryService.query.mockResolvedValue(2);
    const service = new MetricsService(makeConfigService(), queryService);
    const metric = service.metrics[templateId]?.[0];

    if (!metric) {
      throw new Error('Metric fixture was not created');
    }

    const update = jest.spyOn(metric, 'update');
    const setToCurrentTime = jest
      .spyOn(service.lastUpdatedAt, 'setToCurrentTime')
      .mockImplementation(() => undefined);

    await service.refreshMetric(metric);

    expect(queryService.query).toHaveBeenCalledWith(metric);
    expect(update).toHaveBeenCalledWith(2);
    expect(setToCurrentTime).toHaveBeenCalledTimes(1);
  });

  it('leaves gauges untouched when a query returns no result', async () => {
    const queryService = makeQueryService();
    queryService.query.mockResolvedValue(undefined);
    const service = new MetricsService(makeConfigService(), queryService);
    const metric = service.metrics[templateId]?.[0];

    if (!metric) {
      throw new Error('Metric fixture was not created');
    }

    const update = jest.spyOn(metric, 'update');
    const setToCurrentTime = jest.spyOn(
      service.lastUpdatedAt,
      'setToCurrentTime',
    );

    await service.refreshMetric(metric);

    expect(update).not.toHaveBeenCalled();
    expect(setToCurrentTime).not.toHaveBeenCalled();
  });

  it('rejects unknown template refreshes', async () => {
    const service = new MetricsService(makeConfigService(), makeQueryService());

    await expect(
      service.refreshTemplate('00000000-0000-4000-8000-000000000099' as UUID),
    ).rejects.toThrow(
      'Unknown metric template 00000000-0000-4000-8000-000000000099',
    );
  });
});
