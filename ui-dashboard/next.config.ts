import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

// Build the Content-Security-Policy once so it's auditable in one place.
// Notes:
// - `'unsafe-inline'` on script-src/style-src is currently required by Next.js
//   App Router for hydration + styled-jsx. Moving to nonces is a follow-up.
// - Sentry tunnels through `/monitoring` (see `tunnelRoute` below), so we
//   don't need to whitelist `*.sentry.io` in connect-src.
// - `vercel.live` is whitelisted so Vercel Live (preview comments toolbar)
//   works on preview deployments; prod is unaffected since the toolbar only
//   loads on Vercel previews.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://vercel.live",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://vercel.live https://assets.vercel.com",
  "connect-src 'self' https://vercel.live wss://ws-us3.pusher.com",
  "frame-src 'self' https://vercel.live",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // Drop the `x-powered-by: Next.js` fingerprint header.
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV || "development",
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "Content-Security-Policy", value: CSP_DIRECTIVES },
        ],
      },
    ];
  },
};

// TODO(sentry-turbopack): re-add disableLogger + automaticVercelMonitors once SDK ships Turbopack support.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  tunnelRoute: "/monitoring",
});
