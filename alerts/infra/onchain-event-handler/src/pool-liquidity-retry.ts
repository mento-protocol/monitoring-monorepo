import type { Request, Response } from "@google-cloud/functions-framework";
import { retryPendingPoolLiquidityWithdrawals } from "./pool-liquidity-withdrawal";
import { logger } from "./logger";

// Deployed as a separate private Cloud Function, callable only by Scheduler IAM.
export async function retryPoolLiquidityWithdrawals(
  req: Request,
  res: Response,
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }
  try {
    const attempted = await retryPendingPoolLiquidityWithdrawals();
    res.status(200).json({ attempted });
  } catch (error) {
    logger.error("Watched LP withdrawal retry failed", {
      reason: "pool_liquidity_retry_failed",
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send("Watched LP retry failed");
  }
}
