import { Gauge, register } from 'prom-client';
import { PrometheusController } from '@willsoto/nestjs-prometheus';

// Aegis registers every gauge, counter and histogram on prom-client's global
// registry. The /metrics controller from @willsoto/nestjs-prometheus must serve
// that same registry: v7 moved to @prometheus-io/client, so /metrics answered 200
// with only default process metrics and every Aegis alert went stale.
describe('/metrics endpoint', () => {
  beforeEach(() => register.clear());
  afterEach(() => register.clear());

  it('serves metrics registered on the prom-client global registry', async () => {
    const gauge = new Gauge({
      name: 'lastUpdatedAt',
      help: 'regression: must reach /metrics',
    });
    gauge.set(1);

    let body = '';
    const response = {
      header: () => response,
      setHeader: () => response,
      send: (b: string) => {
        body = b;
        return response;
      },
      end: (b?: string) => {
        if (b) body = b;
        return response;
      },
    };

    const result: unknown = await new PrometheusController().index(
      response as never,
    );
    if (typeof result === 'string') body = body || result;

    expect(body).toContain('lastUpdatedAt 1');
  });
});
