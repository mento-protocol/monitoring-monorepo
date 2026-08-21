import { conciseErrorMessage, KeyedLogRateLimiter } from './rpc-log';

describe('conciseErrorMessage', () => {
  it('prefers a viem-style short message', () => {
    expect(
      conciseErrorMessage({
        shortMessage: 'The request took too long to respond.',
        message: 'large nested request dump',
      }),
    ).toBe('The request took too long to respond.');
  });

  it('keeps only the first non-empty line of a normal error', () => {
    expect(
      conciseErrorMessage(new Error('\nrequest failed\nrequest body')),
    ).toBe('request failed');
  });

  it('treats an isolated carriage return as a line separator', () => {
    expect(conciseErrorMessage(new Error('\rrequest failed\rrequest body'))).toBe(
      'request failed',
    );
  });

  it('bounds long messages', () => {
    expect(conciseErrorMessage(new Error('x'.repeat(500)))).toHaveLength(240);
  });
});

describe('KeyedLogRateLimiter', () => {
  it('rejects invalid intervals', () => {
    expect(() => new KeyedLogRateLimiter(0)).toThrow(
      'Log rate-limit interval must be positive',
    );
  });

  it('allows one log per key and reports suppressed events next time', () => {
    const limiter = new KeyedLogRateLimiter(60_000);

    expect(limiter.take('polygon', 1_000)).toBe(0);
    expect(limiter.take('polygon', 2_000)).toBeUndefined();
    expect(limiter.take('polygon', 3_000)).toBeUndefined();
    expect(limiter.take('celo', 3_000)).toBe(0);
    expect(limiter.take('polygon', 61_000)).toBe(2);
  });

  it('starts a new window when the clock moves backwards', () => {
    const limiter = new KeyedLogRateLimiter(60_000);

    expect(limiter.take('polygon', 10_000)).toBe(0);
    expect(limiter.take('polygon', 9_000)).toBe(0);
  });
});
