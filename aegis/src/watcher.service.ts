import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { MetricTemplate } from './config';
import { MetricsService } from './metrics.service';

@Injectable()
export class WatcherService implements OnModuleDestroy {
  private readonly logger = new Logger(WatcherService.name);
  private readonly metricIds: string[] = [];

  constructor(
    private schedulerRegistry: SchedulerRegistry,
    private metricsService: MetricsService,
    private configService: ConfigService,
  ) {
    const metrics = this.configService.get<MetricTemplate[]>('metrics');
    if (!metrics) {
      throw new Error('No metrics configured');
    }
    metrics.forEach((metric) => {
      const job = new CronJob(metric.schedule, () =>
        this.metricsService.refreshTemplate(metric.id),
      );
      this.logger.debug(
        `Adding cron job: ${metric.source.raw}: ${metric.schedule}`,
      );
      this.schedulerRegistry.addCronJob(metric.id, job);
      this.metricIds.push(metric.id);
      job.start();
    });
  }

  onModuleDestroy(): void {
    this.metricIds.forEach((metricId) => {
      void this.schedulerRegistry.getCronJob(metricId).stop();
    });
  }
}
