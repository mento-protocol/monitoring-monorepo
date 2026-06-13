import loadConfig from './config';

describe('production config.yaml', () => {
  it('loads the committed config.yaml without throwing', () => {
    expect(() => loadConfig()).not.toThrow();
  });

  it('produces metrics, each with a contract and function name', () => {
    const config = loadConfig();
    expect(config.metrics.length).toBeGreaterThan(0);
    for (const m of config.metrics) {
      expect(m.id).toBeTruthy();
      expect(m.source.contract).toBeTruthy();
      expect(m.source.functionAbi.name).toBeTruthy();
    }
  });
});
