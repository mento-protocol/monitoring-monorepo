/**
 * Bounded in-process retry for a single delivery attempt (Discord or
 * Telegram sends). Callers classify their own errors via `isRetryable` —
 * discord.js's `WebhookClient` and the raw Telegram `fetch` call have
 * different error shapes and different rate-limit semantics (discord.js
 * queues 429s internally; Telegram does not), so classification stays
 * transport-specific. This helper only owns the generic bounded-attempt loop
 * with capped exponential backoff.
 *
 * Retry budget: with the defaults below (2 retries, 250ms base delay
 * doubling per attempt), the *added* backoff latency for one exhausted
 * delivery is 250ms + 500ms = 750ms. This helper only bounds the delay
 * *between* attempts — callers are responsible for bounding each attempt's
 * own duration (e.g. a per-request timeout) so that attempts × per-attempt
 * timeout + backoff stays well under the 60s Cloud Function timeout (see
 * infra/cloud_function.tf).
 */
interface SendWithRetryOptions {
  /** Returns true if a failed attempt should be retried. */
  isRetryable: (error: unknown) => boolean;
  /** Called after each failed attempt, before the (possible) retry delay. */
  onAttemptFailed?: (
    error: unknown,
    attempt: number,
    willRetry: boolean,
  ) => void;
  maxRetries?: number;
  baseDelayMs?: number;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 250;

export async function sendWithRetry<T>(
  attempt: () => Promise<T>,
  options: SendWithRetryOptions,
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  for (let attemptNumber = 0; attemptNumber <= maxRetries; attemptNumber++) {
    try {
      return await attempt();
    } catch (error) {
      const isLastAttempt = attemptNumber === maxRetries;
      const willRetry = !isLastAttempt && options.isRetryable(error);
      options.onAttemptFailed?.(error, attemptNumber, willRetry);

      if (!willRetry) {
        throw error;
      }

      await sleep(baseDelayMs * 2 ** attemptNumber);
    }
  }

  // Unreachable: every loop iteration either returns or throws above.
  throw new Error("sendWithRetry: exhausted retries without a terminal error");
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
