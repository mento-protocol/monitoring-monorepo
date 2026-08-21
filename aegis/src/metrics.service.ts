import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UUID } from 'crypto';
import { Gauge } from 'prom-client';
import { ChainConfig, MetricTemplate } from './config';
import { Metric } from './metric';
import { QueryService } from './query.service';

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private readonly inFlightRefreshes = new Map<UUID, Promise<void>>();
  templates: Record<UUID, MetricTemplate> = {};
  metrics: Record<UUID, Metric[]> = {};
  lastUpdatedAt: Gauge;
  chainIds: Array<string>;

  constructor(
    configService: ConfigService,
    private queryService: QueryService,
  ) {
    const chains = configService.get<ChainConfig[]>('chains');
    if (!chains) {
      throw new Error('No chains configured');
    }
    this.chainIds = chains.map((chain) => chain.id);
    const templates = configService.get<MetricTemplate[]>('metrics');
    if (!templates) {
      throw new Error('No metrics configured');
    }
    templates.forEach((template) => {
      this.metrics[template.id] = template.variants
        .map((args) => {
          return (
            template.chains === 'all' ? this.chainIds : template.chains
          ).map((chain) => {
            const chainConfig = chains.find((c) => c.id === chain);
            if (!chainConfig) {
              throw new Error(
                `Unknown chain ${chain} in metric template ${template.source.raw}`,
              );
            }
            return new Metric(
              template.source,
              args,
              chain,
              chainConfig.label,
              template.type,
              configService,
            );
          });
        })
        .flat();
      this.templates[template.id] = template;
    });

    this.lastUpdatedAt = new Gauge({
      name: 'lastUpdatedAt',
      help: 'Aegis last updated at timestamp',
    });
  }

  async onModuleInit(): Promise<void> {
    await this.refreshAll();
  }

  async refreshAll() {
    return Promise.all(Object.keys(this.metrics).map(this.refreshTemplate));
  }

  refreshTemplate = (templateID: UUID): Promise<void> => {
    const template = this.templates[templateID];
    const metrics = this.metrics[templateID];
    if (!template || !metrics) {
      return Promise.reject(new Error(`Unknown metric template ${templateID}`));
    }

    const inFlight = this.inFlightRefreshes.get(templateID);
    if (inFlight) {
      this.logger.debug(
        `Refresh already active for ${template.source.raw}; coalescing this cycle`,
      );
      return inFlight;
    }

    const refresh = this.runRefreshTemplate(template, metrics).finally(() => {
      if (this.inFlightRefreshes.get(templateID) === refresh) {
        this.inFlightRefreshes.delete(templateID);
      }
    });
    this.inFlightRefreshes.set(templateID, refresh);
    return refresh;
  };

  private async runRefreshTemplate(
    template: MetricTemplate,
    metrics: Metric[],
  ): Promise<void> {
    this.logger.debug(
      `Refreshing ${metrics.length} metrics for ${template.source.raw}`,
    );
    const now = performance.now();
    await Promise.all(metrics.map(this.refreshMetric));
    const duration = (performance.now() - now).toFixed(2);
    this.logger.debug(
      `Refreshed ${metrics.length} metrics for ${template.source.raw} in ${duration}ms`,
    );
  }

  refreshMetric = async (metric: Metric) => {
    this.logger.debug(`Refreshing metrics ${metric.nameWithLabels}`);
    const value = await this.queryService.query(metric);
    if (value !== undefined) {
      metric.update(value);
      this.lastUpdatedAt.setToCurrentTime();
      this.logger.debug(`${metric.nameWithLabels} = ${JSON.stringify(value)}`);
    }
  };
}
