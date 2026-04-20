"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

export function useReportError(error: Error & { digest?: string }): void {
  useEffect(() => {
    // Fallback signal: if the Sentry DSN is missing or transport fails,
    // the stack still lands in browser + Vercel runtime logs.
    console.error(error);
    Sentry.captureException(error);
  }, [error]);
}
