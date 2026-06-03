import type { Request, Response } from "@google-cloud/functions-framework";
import config from "./config";
import { logger } from "./logger";
import { handleRotation } from "./rotation";

export async function handleOncallRotation(
  req: Request,
  res: Response,
): Promise<void> {
  if (req.method === "GET") {
    res.status(200).json({ ok: true, service: "oncall-announcer" });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {
    const result = await handleRotation(config);
    res.status(200).json({
      announced: result.announced,
      changed: result.changed,
      slackUserId: result.slackUserId,
      victoropsUsername: result.current.username,
    });
  } catch (error) {
    logger.error("Failed to handle on-call rotation", {
      error:
        error instanceof Error
          ? {
              message: error.message,
              name: error.name,
              stack: error.stack,
            }
          : String(error),
    });
    res.status(500).send("Internal Server Error");
  }
}
