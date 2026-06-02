import { ConfigService } from '@nestjs/config';
import { UUID, randomUUID } from 'crypto';
import { Gauge, register } from 'prom-client';
import type { ChainConfig, TokenConfig } from './config';
import { MetricSource } from './config/MetricSource';

/**
 * Solidity type bounds for validation
 */
const SOLIDITY_TYPE_BOUNDS = {
  uint8: { min: 0n, max: 255n },
  uint32: { min: 0n, max: 4294967295n },
  int48: { min: -140737488355328n, max: 140737488355327n },
} as const;

const ORACLE_RATE_DECIMAL_SCALE = 1_000_000_000_000n;

const inputName = (input: { name?: string }, index: number): string =>
  input.name ?? `in${index}`;

type MetricParser = (output: unknown) => number | number[];

/**
 * Metric class manages Prometheus gauges for on-chain contract queries.
 *
 * Multi-Gauge Support:
 * Solidity functions can return multiple values (e.g., a struct with several fields).
 * Instead of combining these into a single metric, we create separate Prometheus gauges
 * for each return value, allowing independent tracking and querying of each field.
 *
 * For example, `Broker.tradingLimitsState()` returns 5 values: two timestamps and three
 * netflow values. Multi-gauge support creates 5 separate gauges, one for each field,
 * making it possible to query and alert on individual fields independently.
 *
 * Implementation:
 * - Single return value → one gauge with base metric name (e.g., `BreakerBox_getRateFeedTradingMode`)
 * - Multiple return values → one gauge per value with suffix based on ABI output name
 *   (e.g., `Broker_tradingLimitsState_netflow0`, `Broker_tradingLimitsState_netflow1`)
 * - The parse() method returns either a single number or array of numbers accordingly
 * - The update() method automatically distributes array values to corresponding gauges
 *
 * Example:
 *   Function: Broker.tradingLimitsState()(uint32 lastUpdated0, uint32 lastUpdated1, ...)
 *   Creates 5 separate gauges:
 *     - Broker_tradingLimitsState_lastUpdated0
 *     - Broker_tradingLimitsState_lastUpdated1
 *     - Broker_tradingLimitsState_netflow0
 *     - Broker_tradingLimitsState_netflow1
 *     - Broker_tradingLimitsState_netflowGlobal
 */
export class Metric {
  id: UUID = randomUUID();
  gauge: Gauge | Gauge[];

  private labels: Record<string, string> = {};
  private tokenDecimalsBySymbol: Record<string, number> = {};

  private readonly metricParsers: Record<string, MetricParser> = {
    'BreakerBox.getRateFeedTradingMode': (output) =>
      this.bigintToSafeNumber(output as bigint),
    'CELOToken.balanceOf': (output) => this.tokenAmountToWholeUnits(output, 18),
    // Native handles non-ERC20 native gas tokens (e.g. MON, ETH) fetched via
    // eth_getBalance. Like CELO (which is ERC20-compatible), they use 18 decimals.
    'Native.balanceOf': (output) => this.tokenAmountToWholeUnits(output, 18),
    'USDC.balanceOf': (output) => this.tokenAmountToWholeUnits(output, 6),
    'USDT.balanceOf': (output) => this.tokenAmountToWholeUnits(output, 6),
    'axlUSDC.balanceOf': (output) => this.tokenAmountToWholeUnits(output, 6),
    'SortedOracles.medianRate': (output) => this.parseMedianRate(output),
    'SortedOracles.isOldestReportExpired': (output) =>
      this.parseOldestReportExpired(output),
    'Broker.tradingLimitsState': (output) =>
      this.parseTradingLimitsState(output),
    'Broker.tradingLimitsConfig': (output) =>
      this.parseTradingLimitsConfig(output),
  };

  /**
   * Validates that a bigint value is within the specified Solidity type range and converts to number.
   * @param val - The bigint value to validate
   * @param typeName - Name of the Solidity type (must be a key in SOLIDITY_TYPE_BOUNDS)
   * @returns The value as a JavaScript number
   */
  private validateSolidityType(
    val: bigint,
    typeName: keyof typeof SOLIDITY_TYPE_BOUNDS,
  ): number {
    const { min, max } = SOLIDITY_TYPE_BOUNDS[typeName];
    if (val < min || val > max) {
      throw new Error(
        `Value ${val} outside ${typeName} range [${min}, ${max}]`,
      );
    }
    const numVal = Number(val);
    if (numVal > Number.MAX_SAFE_INTEGER || numVal < Number.MIN_SAFE_INTEGER) {
      throw new Error(`value ${val} is outside safe integer range`);
    }
    return numVal;
  }

  constructor(
    public source: MetricSource,
    public args: string[],
    public chain: string,
    public chainLabel: string,
    public type: string,
    configService: ConfigService,
  ) {
    const chains = configService.get<ChainConfig[]>('chains');
    if (!chains) {
      throw new Error('No chains configured');
    }
    const chainConfig = this.getChainConfig(chains, chainLabel);
    this.tokenDecimalsBySymbol = this.getTokenDecimals(configService);
    this.labels = this.buildLabels(args, chainConfig);
    this.gauge = this.buildGauge();
  }

  get name(): string {
    // NOTE: We can't use a dot in prometheus metric names so we use an underscore instead
    return `${this.source.contract}_${this.source.functionAbi.name}`;
  }

  get nameWithLabels(): string {
    return `${this.name}${JSON.stringify(this.labels)}`;
  }

  update(value: number | number[]) {
    if (Array.isArray(value)) {
      if (!Array.isArray(this.gauge)) {
        throw new Error('Cannot update single gauge with array of values');
      }
      if (value.length !== this.gauge.length) {
        throw new Error(
          `Value array length mismatch: expected ${this.gauge.length} values, got ${value.length}`,
        );
      }
      const gauges = this.gauge;
      value.forEach((val, idx) => {
        const gauge = gauges[idx];
        if (!gauge) {
          throw new Error(`Missing gauge at index ${idx} for ${this.name}`);
        }
        gauge.labels(this.labels).set(val);
      });
    } else {
      if (Array.isArray(this.gauge)) {
        throw new Error('Cannot update multiple gauges with single value');
      }
      this.gauge.labels(this.labels).set(value);
    }
  }

  parse(
    output: unknown,
    contractName: string,
    functionName: string,
  ): number | number[] {
    const metricName = `${contractName}.${functionName}`;
    const totalSupply = this.parseConfiguredTokenTotalSupply(
      output,
      contractName,
      functionName,
    );
    if (totalSupply !== undefined) {
      return totalSupply;
    }

    const parser = this.metricParsers[metricName];
    if (parser) return parser(output);

    throw new Error(
      `Unknown metric '${metricName}'. If this is a totalSupply metric, add '${contractName}' to the 'tokens' map in config.yaml. Otherwise, add a parser entry to Metric.metricParsers.`,
    );
  }

  private getChainConfig(
    chains: ChainConfig[],
    chainLabel: string,
  ): ChainConfig {
    const chainConfig = chains.find(
      (conf: ChainConfig) => conf.label === chainLabel,
    );
    if (!chainConfig) {
      throw new Error(`Unknown chain label ${chainLabel}`);
    }
    return chainConfig;
  }

  private getTokenDecimals(
    configService: ConfigService,
  ): Record<string, number> {
    const tokenConfigs =
      configService.get<Record<string, TokenConfig>>('tokens') ?? {};
    return Object.fromEntries(
      Object.entries(tokenConfigs).map(([symbol, config]) => [
        symbol,
        config.decimals,
      ]),
    );
  }

  private buildLabels(
    args: string[],
    chainConfig: ChainConfig,
  ): Record<string, string> {
    const labels = this.source.functionAbi.inputs.reduce(
      (acc, input, idx) => {
        const arg = args[idx];
        const name = inputName(input, idx);
        if (arg === undefined) {
          throw new Error(
            `Missing argument ${idx} for ${this.source.contract}.${this.source.functionAbi.name}`,
          );
        }
        acc[name] = arg;
        acc[`${name}Value`] = chainConfig.vars[arg] ?? arg;
        return acc;
      },
      {} as Record<string, string>,
    );
    labels.chain = this.chainLabel;
    return labels;
  }

  private buildGauge(): Gauge | Gauge[] {
    if (this.source.functionAbi.outputs.length > 1) {
      return this.buildMultiGauge();
    }
    return this.getOrCreateGauge(
      this.name,
      `Return value of ${this.source.raw}`,
    );
  }

  private buildMultiGauge(): Gauge[] {
    return this.source.functionAbi.outputs.map((output, idx) => {
      if (!output.name || output.name.trim() === '') {
        throw new Error(
          `Output at index ${idx} for function ${this.source.functionAbi.name} must have a name for multi-gauge metrics`,
        );
      }
      return this.getOrCreateGauge(
        `${this.name}_${output.name}`,
        `Return value ${output.name} of ${this.source.raw}`,
      );
    });
  }

  private getOrCreateGauge(name: string, help: string): Gauge<string> {
    const existingMetric = register.getSingleMetric(name);
    if (existingMetric) {
      return existingMetric as Gauge<string>;
    }
    return new Gauge({
      name,
      help,
      labelNames: this.labelNames(),
    });
  }

  private labelNames(): string[] {
    return ['chain'].concat(
      this.source.functionAbi.inputs.map(inputName),
      this.source.functionAbi.inputs.map(
        (input, idx) => `${inputName(input, idx)}Value`,
      ),
    );
  }

  private parseConfiguredTokenTotalSupply(
    output: unknown,
    contractName: string,
    functionName: string,
  ): number | undefined {
    const tokenDecimals = this.tokenDecimalsBySymbol[contractName];
    if (functionName !== 'totalSupply' || tokenDecimals === undefined) {
      return undefined;
    }
    return this.tokenAmountToWholeUnits(output, tokenDecimals);
  }

  private bigintToSafeNumber(value: bigint): number {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Value ${value} is too large to be a safe integer`);
    }
    return Number(value);
  }

  private parseMedianRate(output: unknown): number[] {
    const [rate, denominator] = output as [bigint, bigint];
    const actualRate = this.oracleRateToNumber(rate, denominator);
    return [actualRate, Number(denominator)];
  }

  private parseOldestReportExpired(output: unknown): number[] {
    const [isExpired] = output as [boolean, bigint];
    return [isExpired ? 1 : 0, 0];
  }

  private parseTradingLimitsState(output: unknown): number[] {
    const [lastUpdated0, lastUpdated1, netflow0, netflow1, netflowGlobal] =
      output as [bigint, bigint, bigint, bigint, bigint];

    return [
      this.validateSolidityType(lastUpdated0, 'uint32'),
      this.validateSolidityType(lastUpdated1, 'uint32'),
      this.validateSolidityType(netflow0, 'int48'),
      this.validateSolidityType(netflow1, 'int48'),
      this.validateSolidityType(netflowGlobal, 'int48'),
    ];
  }

  private parseTradingLimitsConfig(output: unknown): number[] {
    const [timestep0, timestep1, limit0, limit1, limitGlobal, flags] =
      output as [bigint, bigint, bigint, bigint, bigint, bigint];

    return [
      this.validateSolidityType(timestep0, 'uint32'),
      this.validateSolidityType(timestep1, 'uint32'),
      this.validateSolidityType(limit0, 'int48'),
      this.validateSolidityType(limit1, 'int48'),
      this.validateSolidityType(limitGlobal, 'int48'),
      this.validateSolidityType(flags, 'uint8'),
    ];
  }

  private oracleRateToNumber(rate: bigint, denominator: bigint): number {
    if (denominator === 0n) {
      throw new Error('medianRate denominator is zero');
    }

    const integerPart = rate / denominator;
    const remainder = rate % denominator;
    if (integerPart > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Value ${integerPart} is too large to be a safe integer`);
    }

    const scaledFraction =
      (remainder * ORACLE_RATE_DECIMAL_SCALE) / denominator;
    return (
      Number(integerPart) +
      Number(scaledFraction) / Number(ORACLE_RATE_DECIMAL_SCALE)
    );
  }

  private tokenAmountToWholeUnits(output: unknown, decimals: number): number {
    const divisor = 10n ** BigInt(decimals);
    const wholeUnits = (output as bigint) / divisor;
    if (wholeUnits > Number.MAX_SAFE_INTEGER) {
      throw new Error(`Value ${wholeUnits} is too large to be a safe integer`);
    }
    return Number(wholeUnits);
  }
}
