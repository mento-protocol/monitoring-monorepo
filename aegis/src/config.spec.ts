import { ZodError } from 'zod';
import { MetricSource } from './config/MetricSource';

type LoadedConfig = {
  chains: Array<{
    id: string;
    vars: Record<string, string>;
  }>;
  metrics: Array<{
    id: string;
    source: {
      contract: string;
      functionAbi: {
        name: string;
        inputs: ReadonlyArray<{ type: string; name: string }>;
        outputs: ReadonlyArray<{ type: string; name: string }>;
      };
      raw: string;
    };
  }>;
};

const loadConfiguration = async (yamlSource: string): Promise<LoadedConfig> => {
  let configuration: (() => LoadedConfig) | undefined;

  await jest.isolateModulesAsync(async () => {
    jest.doMock('fs', () => ({
      readFileSync: jest.fn(() => yamlSource),
    }));
    const configModule = await import('./config');
    configuration = configModule.default as unknown as () => LoadedConfig;
  });

  jest.dontMock('fs');
  jest.resetModules();

  if (!configuration) {
    throw new Error('Configuration module did not load');
  }
  return configuration();
};

const validConfigYaml = `
global:
  vars:
    FeedId: "0xfeed"
    Shared: "global"
tokens:
  USDm:
    decimals: 18
chains:
  - id: test
    label: Test Chain
    httpRpcUrl: http://localhost:8545
    contracts:
      BreakerBox: "0x0000000000000000000000000000000000000001"
      USDm: "0x0000000000000000000000000000000000000002"
    vars:
      Shared: "chain"
metrics:
  - source: "BreakerBox.getRateFeedTradingMode(bytes32 rateFeedId)(uint8 mode)"
    schedule: "* * * * * *"
    type: gauge
    chains: all
    variants:
      - [FeedId]
  - source: "Native.balanceOf(address account)(uint256 balance)"
    schedule: "* * * * * *"
    type: gauge
    chains: [test]
    variants:
      - ["0x0000000000000000000000000000000000000003"]
`;

describe('MetricSource', () => {
  it('parses normalized function signatures into ABI inputs and outputs', () => {
    const source = MetricSource.parse(`
      Broker.tradingLimitsState(
        bytes32 limitId
      )(
        uint32 lastUpdated0,
        int48 netflow0
      )
    `);

    expect(source).toMatchObject({
      contract: 'Broker',
      functionAbi: {
        name: 'tradingLimitsState',
        inputs: [{ type: 'bytes32', name: 'limitId' }],
        outputs: [
          { type: 'uint32', name: 'lastUpdated0' },
          { type: 'int48', name: 'netflow0' },
        ],
      },
    });
  });

  it('rejects signatures without explicit output parentheses', () => {
    expect(() =>
      MetricSource.parse('BreakerBox.getRateFeedTradingMode(bytes32 feedId)'),
    ).toThrow(ZodError);
  });
});

describe('configuration loader', () => {
  afterEach(() => {
    jest.dontMock('fs');
    jest.resetModules();
  });

  it('loads YAML, parses metric sources, and merges chain vars over globals', async () => {
    const config = await loadConfiguration(validConfigYaml);

    expect(config.chains[0]?.vars).toEqual({
      FeedId: '0xfeed',
      Shared: 'chain',
    });
    expect(config.metrics[0]?.id).toEqual(expect.any(String));
    expect(config.metrics[0]?.source).toMatchObject({
      contract: 'BreakerBox',
      functionAbi: {
        name: 'getRateFeedTradingMode',
        inputs: [{ type: 'bytes32', name: 'rateFeedId' }],
        outputs: [{ type: 'uint8', name: 'mode' }],
      },
    });
  });

  it('allows Native metrics without declaring a synthetic contract', async () => {
    const config = await loadConfiguration(validConfigYaml);

    expect(config.metrics[1]?.source.contract).toBe('Native');
  });

  it('rejects metrics that reference undeclared contracts on selected chains', async () => {
    const invalidConfigYaml = validConfigYaml.replace(
      '      BreakerBox: "0x0000000000000000000000000000000000000001"\n',
      '',
    );

    await expect(loadConfiguration(invalidConfigYaml)).rejects.toThrow(
      "Contract BreakerBox isn't declared in network test",
    );
  });

  it('rejects totalSupply metrics without token metadata', async () => {
    const invalidConfigYaml = validConfigYaml
      .replace(
        '      USDm: "0x0000000000000000000000000000000000000002"',
        [
          '      USDm: "0x0000000000000000000000000000000000000002"',
          '      MissingToken: "0x0000000000000000000000000000000000000004"',
        ].join('\n'),
      )
      .replace(
        '  - source: "Native.balanceOf(address account)(uint256 balance)"',
        '  - source: "MissingToken.totalSupply()(uint256 supply)"',
      )
      .replace(
        '      - ["0x0000000000000000000000000000000000000003"]',
        '      - []',
      );

    await expect(loadConfiguration(invalidConfigYaml)).rejects.toThrow(
      "Token config missing for totalSupply source 'MissingToken'",
    );
  });
});
