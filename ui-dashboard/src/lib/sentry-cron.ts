import * as Sentry from "@sentry/nextjs";

type MonitorConfig = NonNullable<Parameters<typeof Sentry.withMonitor>[2]>;

const SENTRY_CRON_FLUSH_TIMEOUT_MS = 2_000;

async function flushCronCheckIns(monitorSlug: string): Promise<void> {
  try {
    const flushed = await Sentry.flush(SENTRY_CRON_FLUSH_TIMEOUT_MS);
    if (!flushed) {
      console.warn(
        `[sentry/cron] timed out flushing check-ins for ${monitorSlug}`,
      );
    }
  } catch (err) {
    console.warn(
      `[sentry/cron] failed flushing check-ins for ${monitorSlug}`,
      err,
    );
  }
}

export async function withFlushedMonitor<T>(
  monitorSlug: string,
  callback: () => Promise<T>,
  monitorConfig: MonitorConfig,
): Promise<T> {
  try {
    return await Sentry.withMonitor(monitorSlug, callback, monitorConfig);
  } finally {
    await flushCronCheckIns(monitorSlug);
  }
}
