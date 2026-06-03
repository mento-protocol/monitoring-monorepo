import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { UUID } from 'crypto';
import { MetricTemplate } from './config';
import { MetricsService } from './metrics.service';
import { WatcherService } from './watcher.service';

type ScheduledJob = {
  schedule: string;
  onTick: () => Promise<void>;
  start: jest.Mock<void, []>;
  stop: jest.Mock<void, []>;
};

const mockCronJobs: ScheduledJob[] = [];

jest.mock('cron', () => ({
  CronJob: jest.fn((schedule: string, onTick: () => Promise<void>) => {
    const job: ScheduledJob = {
      schedule,
      onTick,
      start: jest.fn(),
      stop: jest.fn(),
    };
    mockCronJobs.push(job);
    return job;
  }),
}));

const metricId = '00000000-0000-4000-8000-000000000001' as UUID;

const metricTemplate = {
  id: metricId,
  schedule: '*/5 * * * * *',
  source: {
    raw: 'BreakerBox.getRateFeedTradingMode(bytes32 rateFeedId)(uint8 mode)',
  },
} as MetricTemplate;

const makeConfigService = (
  metrics: MetricTemplate[] | undefined = [metricTemplate],
  hasMetrics = true,
): jest.Mocked<ConfigService> =>
  ({
    get: jest.fn((key: string) => {
      if (key === 'metrics') return hasMetrics ? metrics : undefined;
      return undefined;
    }),
  }) as unknown as jest.Mocked<ConfigService>;

const makeMetricsService = (): jest.Mocked<MetricsService> =>
  ({
    refreshTemplate: jest.fn().mockResolvedValue(undefined),
  }) as unknown as jest.Mocked<MetricsService>;

const makeSchedulerRegistry = (): jest.Mocked<SchedulerRegistry> => {
  const jobs = new Map<string, ScheduledJob>();
  return {
    addCronJob: jest.fn((name: string, job: ScheduledJob) => {
      jobs.set(name, job);
    }),
    getCronJob: jest.fn((name: string) => {
      const job = jobs.get(name);
      if (!job) {
        throw new Error(`Missing job ${name}`);
      }
      return job;
    }),
  } as unknown as jest.Mocked<SchedulerRegistry>;
};

describe('WatcherService', () => {
  beforeEach(() => {
    mockCronJobs.length = 0;
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('registers and starts configured metric cron jobs', () => {
    const schedulerRegistry = makeSchedulerRegistry();
    const metricsService = makeMetricsService();

    new WatcherService(schedulerRegistry, metricsService, makeConfigService());

    expect(mockCronJobs).toHaveLength(1);
    expect(mockCronJobs[0]?.schedule).toBe('*/5 * * * * *');
    expect(schedulerRegistry.addCronJob).toHaveBeenCalledWith(
      metricId,
      mockCronJobs[0],
    );
    expect(mockCronJobs[0]?.start).toHaveBeenCalledTimes(1);
  });

  it('refreshes the matching metric template when a cron cycle fires', async () => {
    const schedulerRegistry = makeSchedulerRegistry();
    const metricsService = makeMetricsService();

    new WatcherService(schedulerRegistry, metricsService, makeConfigService());

    await mockCronJobs[0]?.onTick();

    expect(metricsService.refreshTemplate).toHaveBeenCalledWith(metricId);
  });

  it('stops registered jobs on module destroy so stale cycles do not continue', () => {
    const schedulerRegistry = makeSchedulerRegistry();
    const service = new WatcherService(
      schedulerRegistry,
      makeMetricsService(),
      makeConfigService(),
    );

    service.onModuleDestroy();

    expect(schedulerRegistry.getCronJob).toHaveBeenCalledWith(metricId);
    expect(mockCronJobs[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it('throws when no metrics are configured', () => {
    expect(
      () =>
        new WatcherService(
          makeSchedulerRegistry(),
          makeMetricsService(),
          makeConfigService(undefined, false),
        ),
    ).toThrow('No metrics configured');
  });
});
