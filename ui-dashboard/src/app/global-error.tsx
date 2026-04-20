"use client";

import { useReportError } from "@/hooks/use-report-error";

// global-error.tsx is the one boundary that catches failures inside the root
// layout (`layout.tsx`), including the async `getAuthSession()` call. It must
// render its own <html>/<body> because the root layout has crashed and is not
// available. Keep the markup self-contained — no app-level providers, fonts,
// or navigation components.

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useReportError(error);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          background: "#0f172a",
          color: "#e2e8f0",
          fontFamily: "system-ui, sans-serif",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem",
        }}
      >
        <div style={{ maxWidth: 480, width: "100%" }}>
          <h1
            style={{
              fontSize: "1.25rem",
              fontWeight: 600,
              marginBottom: "0.75rem",
            }}
          >
            Something went wrong
          </h1>
          <p
            style={{
              color: "#f87171",
              background: "rgba(127, 29, 29, 0.3)",
              border: "1px solid rgba(127, 29, 29, 0.5)",
              borderRadius: 8,
              padding: "0.75rem 1rem",
              fontSize: "0.875rem",
            }}
            role="alert"
          >
            {error.message || "The application failed to load. Try refreshing."}
          </p>
          {error.digest && (
            <p
              style={{
                marginTop: "0.5rem",
                fontSize: "0.75rem",
                color: "#94a3b8",
              }}
            >
              Error ID:{" "}
              <code style={{ fontFamily: "monospace" }}>{error.digest}</code>
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: "1rem",
              background: "#0f172a",
              color: "#e2e8f0",
              border: "1px solid #334155",
              borderRadius: 8,
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
