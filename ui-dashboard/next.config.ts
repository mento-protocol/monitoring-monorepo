import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Drop the `x-powered-by: Next.js` fingerprint header.
  poweredByHeader: false,
  env: {
    // Mirror VERCEL_ENV verbatim — empty on localhost, set to
    // production/preview/development on Vercel deployments. The
    // localhost-empty case is load-bearing for `shouldEnableSentry`
    // in instrumentation-client.ts; do not add a fallback here.
    NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV ?? "",
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Static security headers — applied to every response including
          // static assets. Content-Security-Policy is NOT set here; it is
          // injected per-request by middleware (src/middleware.ts) so that
          // a unique nonce can be embedded in each page's script-src.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          // Dashboard is read-only monitoring — deny all device / sensor /
          // payment APIs. `interest-cohort` opts out of FLoC/Topics.
          {
            key: "Permissions-Policy",
            value:
              "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()",
          },
        ],
      },
    ];
  },
};

// TODO(sentry-turbopack): re-add disableLogger + automaticVercelMonitors once SDK ships Turbopack support.
export default withSentryConfig(nextConfig, {
  ...(process.env.SENTRY_ORG ? { org: process.env.SENTRY_ORG } : {}),
  ...(process.env.SENTRY_PROJECT
    ? { project: process.env.SENTRY_PROJECT }
    : {}),
  ...(process.env.SENTRY_AUTH_TOKEN
    ? { authToken: process.env.SENTRY_AUTH_TOKEN }
    : {}),
  silent: !process.env.CI,
  widenClientFileUpload: true,
  tunnelRoute: "/monitoring",
});
