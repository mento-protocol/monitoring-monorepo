// Content-Security-Policy builder, shared by middleware (per-request nonce)
// and next.config.ts (static headers fallback). Keep the connect-src list
// here — it's load-bearing: every new external fetch needs an entry, and the
// friction is the feature.
//
// Notes:
// - `'unsafe-inline'` is kept on style-src because React's inline `style={}`
//   props compile to `style="..."` HTML attributes. Browsers require
//   `'unsafe-inline'` to allow those; nonces only apply to <style> *tags*,
//   not attribute-level inline styles. The nonce on script-src is the high-
//   value XSS protection; style-src inline is lower risk for a read-only UI.
// - Sentry tunnels through `/monitoring` (see `tunnelRoute` in next.config.ts),
//   so we don't need to whitelist `*.sentry.io` in connect-src.
// - `vercel.live` is whitelisted for Vercel Live preview comments toolbar;
//   it only loads on preview deployments.
// - `va.vercel-scripts.com` is the Vercel Analytics script host.
// - connect-src: Hasura (indexer.hyperindex.xyz) for GraphQL, plus the RPC
//   endpoints the bridge-redeem flow polls for tx receipts.

import { clientEnv } from "@/env";

function browserTestConnectSrc(): string[] {
  if (!clientEnv.NEXT_PUBLIC_BROWSER_TEST_FIXTURES) return [];
  const hasuraUrl = clientEnv.NEXT_PUBLIC_HASURA_URL;
  if (!hasuraUrl) return [];
  try {
    return [new URL(hasuraUrl).origin];
  } catch {
    return [];
  }
}

// Next.js dev HMR needs eval during fixture-mode browser tests.
const browserTestScriptSrc = clientEnv.NEXT_PUBLIC_BROWSER_TEST_FIXTURES
  ? ["'unsafe-eval'"]
  : [];

const CSP_CONNECT_SRC = [
  "'self'",
  "https://vercel.live",
  "wss://ws-us3.pusher.com",
  "https://indexer.hyperindex.xyz",
  "https://forno.celo.org",
  "https://forno.celo-sepolia.celo-testnet.org",
  "https://rpc2.monad.xyz",
  ...browserTestConnectSrc(),
].join(" ");

/**
 * Build the CSP header value for a given per-request nonce.
 *
 * The nonce is injected into `script-src` so Next.js can apply it to the
 * inline scripts it emits for RSC hydration. `'unsafe-inline'` is removed
 * from `script-src` — the nonce replaces it.
 */
export function buildCspWithNonce(nonce: string): string {
  return [
    "default-src 'self'",
    [
      "script-src",
      "'self'",
      `'nonce-${nonce}'`,
      ...browserTestScriptSrc,
      "https://vercel.live",
      "https://va.vercel-scripts.com",
    ].join(" "),
    // Sentry's session-replay SDK spins up a Web Worker compiled from a
    // blob: URL. Browsers fall back from missing worker-src to script-src,
    // so without this directive the worker gets blocked. Narrower than
    // adding `blob:` to script-src.
    "worker-src 'self' blob:",
    // `'unsafe-inline'` is required for React inline `style={}` props.
    // Nonces on style-src only apply to <style> tags, not attribute styles.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://vercel.live https://assets.vercel.com",
    `connect-src ${CSP_CONNECT_SRC}`,
    "frame-src 'self' https://vercel.live",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}
