const MAX_ERROR_MESSAGE_LENGTH = 240;

type ErrorWithShortMessage = {
  shortMessage?: unknown;
};

export const conciseErrorMessage = (error: unknown): string => {
  const shortMessage =
    typeof error === 'object' && error !== null
      ? (error as ErrorWithShortMessage).shortMessage
      : undefined;
  const candidate =
    typeof shortMessage === 'string'
      ? shortMessage
      : error instanceof Error
        ? error.message
        : String(error);
  const firstLine = candidate
    .split(/\r\n|[\r\n\u2028\u2029]/u)
    .map((line) => line.trim())
    .find(Boolean);
  const normalized = firstLine ?? 'Unknown error';

  return normalized.length <= MAX_ERROR_MESSAGE_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`;
};

type LogWindow = {
  startedAt: number;
  suppressed: number;
};

export class KeyedLogRateLimiter {
  private readonly windows = new Map<string, LogWindow>();

  constructor(private readonly intervalMs: number) {
    if (!Number.isFinite(intervalMs) || intervalMs < 1) {
      throw new Error('Log rate-limit interval must be positive');
    }
  }

  take(key: string, now = Date.now()): number | undefined {
    const window = this.windows.get(key);
    if (
      !window ||
      now < window.startedAt ||
      now - window.startedAt >= this.intervalMs
    ) {
      const suppressed = window?.suppressed ?? 0;
      this.windows.set(key, { startedAt: now, suppressed: 0 });
      return suppressed;
    }

    window.suppressed += 1;
    return undefined;
  }
}
