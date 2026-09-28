import type { Request, Response } from "@google-cloud/functions-framework";

// Cloud Functions loads package.main before selecting an entry point. Keep
// the two import graphs separate so the private retry runtime never loads the
// public webhook's signing-secret and multisig configuration on boot.
export async function processQuicknodeWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  const handler = await import("./index");
  await handler.processQuicknodeWebhook(req, res);
}

export async function retryPoolLiquidityWithdrawals(
  req: Request,
  res: Response,
): Promise<void> {
  const handler = await import("./pool-liquidity-retry");
  await handler.retryPoolLiquidityWithdrawals(req, res);
}
