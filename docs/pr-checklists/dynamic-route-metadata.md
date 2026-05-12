# Dynamic-route metadata + private data PR Checklist

Use this checklist for any PR that adds or changes a Next.js dynamic route whose `generateMetadata` reads access-controlled data — labels, reports, anything Redis-backed, anything that should not be visible to an unauthenticated crawler.

## Operating rule

> **`generateMetadata` runs without a session and the rendered tags are visible to every crawler / shared-link preview. Treat it as an unauth-reachable surface — gate every emitted field on an explicit "is public" flag.**

The tags `<title>`, `<meta name="description">`, `<meta property="og:title">`, `<meta name="twitter:title">`, etc. are inert HTML the moment the page renders. Anyone who guesses the URL — Slackbot unfurling a pasted link, a search-engine crawler, a third-party preview service — sees them, no auth required. If `getLabel(addr)` returned `name = "Wintermute hot wallet"` and you put that in `<title>`, you've leaked a private attribution to anyone who guesses the address.

This bit us on PR #345 (codex round 4 — the only P1 in the entire review).

---

## 1. Privacy gate every emitted field

For every dynamic route handler that has `generateMetadata`:

```tsx
export async function generateMetadata({ params }): Promise<Metadata> {
  const { address } = await params;
  if (!isValidAddress(address)) return FALLBACK_METADATA;

  const label = await withTimeout(getLabel(address), 5000).catch(() => null);

  // Privacy gate — return generic fallback unless the data is explicitly public
  if (!label || label.isPublic !== true) return FALLBACK_METADATA;

  return {
    title: `${label.name} — …`,
    description: …,
    openGraph: { … },
    twitter: { … },
  };
}
```

Reports are NEVER public per AGENTS rules — never include report content in metadata regardless of any flag. Labels default to private (`isPublic !== true`).

## 2. `revalidate = 0` when data is access-controlled

```tsx
export const revalidate = 0;
```

Non-zero ISR caching means an editor toggling a label from public → private leaves the prior public tags served from the edge cache for the cache window. Privacy revocation must be honoured immediately. Per-request Redis cost is bounded by `withTimeout(5000)` and only fires for crawler unfurls — regular page loads use the client-side SWR provider, not this metadata path.

## 3. `withTimeout` every Redis call

```tsx
const METADATA_FETCH_TIMEOUT_MS = 5000;
const label = await withTimeout(
  getLabel(address),
  METADATA_FETCH_TIMEOUT_MS,
).catch(() => null);
```

Without a per-call timeout, a hung Upstash REST endpoint blocks `generateMetadata` until Vercel's function timeout (300s) fires. That stalls every crawler unfurl and shared-link preview. The Upstash SDK doesn't expose a per-call signal — wrap each promise in `Promise.race` against a `setTimeout`.

## 4. Metadata helper lives in its own file (RSC leak guard scope)

The metadata-fetching body MUST live in a dedicated helper file:

```
src/app/<route>/_lib/og-metadata.ts   ← exports buildOgMetadata(rawParam)
src/app/<route>/layout.tsx            ← imports the helper, calls it from generateMetadata
```

NOT inline in `layout.tsx` or `page.tsx`. Reason: the RSC label-leak guard test (`ui-dashboard/src/__tests__/rsc-label-leak-guard.test.ts`) allowlists files that legitimately read Redis. Allowlisting a whole layout means a future edit can quietly add an untrusted call inside the default render path and the guard silently passes. Helper-file scope keeps the guard tight — the layout itself never imports the Redis-backed module.

## 5. Run the leak guard locally

```bash
pnpm --filter ui-dashboard test src/__tests__/rsc-label-leak-guard.test.ts
```

Confirm:

- The new helper file is the ONLY addition to the allowlist
- The layout/page itself is NOT in the allowlist
- The detector self-tests still pass (alias / relative / dynamic / submodule import shapes all detected)

## 6. Decline UI / "fail closed"

Helpers that return data MUST return `null` on any error / timeout, and the caller MUST treat `null` as "no data" → fallback metadata. Don't fail open — a thrown error in `generateMetadata` propagates up to the Next.js build/render pipeline and breaks OG generation for the whole route.

```tsx
const label = await withTimeout(getLabel(address), 5000).catch(() => null);
if (!label || label.isPublic !== true) return FALLBACK_METADATA;
```

## 7. `decodeURIComponent` is wrapped

URL params come URI-encoded. `decodeURIComponent("%zz")` throws `URIError`. Wrap in try-catch and fall through to `isValidAddress` which rejects garbage paths to a soft redirect:

```tsx
let address: string;
try {
  address = decodeURIComponent(rawParam).toLowerCase();
} catch {
  address = rawParam.toLowerCase();
}
if (!isValidAddress(address)) return FALLBACK_METADATA;
```

---

## Why this exists

PR #345 introduced `/address-book/[address]` and the original `generateMetadata` happily emitted private label names into `<title>` and `<meta>` tags. Codex caught it as a P1. The full sequence of follow-up findings (cache-window leak after `isPublic` toggle, leak-guard allowlist scope, layout vs page placement, decodeURIComponent crash) ate ~3 review rounds. Future dynamic routes for access-controlled data should pass this checklist locally before opening the PR.
