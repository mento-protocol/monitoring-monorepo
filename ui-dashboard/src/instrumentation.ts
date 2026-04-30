import * as Sentry from "@sentry/nextjs";
import { shouldEnableSentry } from "../sentry.shared";

export async function register() {
  if (!shouldEnableSentry()) return;
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
