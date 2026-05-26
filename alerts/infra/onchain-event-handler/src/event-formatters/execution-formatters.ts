/**
 * Formatters for execution events (ExecutionSuccess, ExecutionFailure)
 */

import type { NotificationField, QuickNodeDecodedLog } from "../types";

export async function formatExecutionEvent(
  log: QuickNodeDecodedLog,
  chainConfig: { decimals: number; symbol: string },
): Promise<NotificationField[]> {
  const fields: NotificationField[] = [];

  if (log.payment !== undefined) {
    try {
      const payment =
        typeof log.payment === "string"
          ? BigInt(log.payment)
          : BigInt(Number(log.payment));
      const paymentFormatted = Number(payment) / 10 ** chainConfig.decimals;
      if (paymentFormatted > 0) {
        fields.push({
          name: "Payment",
          value: `${paymentFormatted.toFixed(6)} ${chainConfig.symbol}`,
          inline: false,
        });
      }
    } catch {
      // Ignore parsing errors
    }
  }

  return fields;
}
