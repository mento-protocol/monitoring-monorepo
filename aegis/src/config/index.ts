import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { join } from 'path';
import z from 'zod';

import { MetricSource } from './MetricSource';

const YAML_CONFIG_FILENAME = 'config.yaml';

const GlobalConfig = z.object({
  vars: z.record(z.string(), z.string()),
});

export const ChainConfig = z
  .object({
    id: z.string(),
    label: z.string(),
    httpRpcUrl: z.string(),
    contracts: z.record(z.string(), z.string()),
    vars: z.record(z.string(), z.string()),
  })
  .brand('ChainConfig');
export type ChainConfig = z.infer<typeof ChainConfig>;

const MetricTemplate = z
  .object({
    source: MetricSource,
    schedule: z.string(),
    type: z.enum([
      // Todo do we need others?
      'gauge',
    ] as const),
    chains: z.literal('all').or(z.array(z.string())),
    variants: z.array(z.array(z.string())).refine((v) => v.length > 0, {
      message: 'Must have at least one variant',
    }),
  })
  .transform((v) => {
    return {
      ...v,
      id: randomUUID(),
    };
  })
  .brand<'MetricTemplate'>();
export type MetricTemplate = z.infer<typeof MetricTemplate>;

const Config = z
  .object({
    global: GlobalConfig,
    chains: z.array(ChainConfig),
    metrics: z.array(MetricTemplate),
  })
  .brand<'Config'>();

export default () => {
  const rawConfig = yaml.load(
    readFileSync(join(__dirname, '../../', YAML_CONFIG_FILENAME), 'utf8'),
  ) as unknown;

  const config = Config.parse(rawConfig);

  config.chains.forEach((chain) => {
    chain.vars = {
      ...(config.global.vars || {}),
      ...(chain.vars || {}),
    };
  });

  const allChains = config.chains.map((chain) => chain.id);

  config.metrics.forEach((metric) => {
    const { contract } = metric.source;
    const chains = metric.chains === 'all' ? allChains : metric.chains;
    chains.forEach((chainId) => {
      if (!chainId) {
        throw new Error(`Empty chain id in metric ${contract}`);
      }
      const chain = config.chains.find((chain) => chain.id === chainId);
      if (!chain) {
        throw new Error(`Unknown chain ${chainId} in metric ${contract}`);
      }
      if (chain.contracts[contract] === undefined) {
        throw new Error(
          `Contract ${contract} isn't declared in network ${chain.id}`,
        );
      }
    });
  });

  return config;
};
