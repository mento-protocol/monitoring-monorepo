# Work Log — feat/google-auth-address-labels

## Phase 1 — Auth infrastructure + security headers ✅
**Commit:** `b41f8f2` feat(auth): add Google OAuth with Auth.js v5 and security headers

### What was done
- Installed `next-auth@5.0.0-beta.30`
- `src/auth.ts`: NextAuth config with Google provider, JWT sessions (30-day max), `@mentolabs.xyz` domain restriction in `signIn` callback
- `src/auth.d.ts`: Session type augmentation ensuring `user.email` is always a string
- `src/app/api/auth/[...nextauth]/route.ts`: Auth.js route handler
- `src/middleware.ts`: Protects `/address-book/*` (redirect to `/sign-in`) and `/api/address-labels` write routes (JSON 401). GET on `/api/address-labels` is public.
- `src/app/sign-in/page.tsx`: Google sign-in form with `callbackUrl` sanitization (only relative paths starting with `/` but not `//`)
- `src/components/auth-status.tsx`: Shows email + sign-out button; clears SWR cache before `signOut()` to prevent private label leakage
- `src/app/layout.tsx`: Wrapped in `<SessionProvider>`, `<AuthStatus />` added to nav
- `next.config.ts`: Security headers (`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`)

### Security constraints applied
1. `callbackUrl` sanitized — only relative paths, no `//` prefix
5. SWR cache cleared before `signOut()`
7. Security headers in next.config.ts

---

## Phase 2 — API protection + backup hardening ✅
**Commit:** `e4a8244` feat(auth): protect API routes and harden backup storage

### What was done
- `src/lib/address-labels.ts`:
  - Added `isPublic?: boolean` to `AddressLabelEntry`
  - `getRedis()` exported (needed by backup route)
  - `getLabels()` accepts `{ publicOnly?: boolean }` — filters to `isPublic === true` when set
  - `importLabels()`: strict `isPublic === true` coercion (rejects truthy strings)
- `src/app/api/address-labels/route.ts`: Full replacement — `getAuthSession()` helper; GET returns `publicOnly` labels for unauthenticated requests; PUT/DELETE require auth
- `src/app/api/address-labels/export/route.ts`: Auth guard added (401 if not `@mentolabs.xyz`)
- `src/app/api/address-labels/import/route.ts`: Auth guard added
- `src/app/api/address-labels/backup/route.ts`: **Replaced Vercel Blob with Redis storage**; 30-day TTL; random suffix per backup key; `CRON_SECRET` required in non-dev (500 if unset)
- Tests: 8 new tests for `getLabels publicOnly`, `upsertLabel isPublic`, `importLabels coercion`; 3 auth signIn callback tests; export route test updated to mock `@/auth`

### Security constraints applied
2. Backup stored in Redis only, NOT Vercel Blob
3. `CRON_SECRET` required in non-dev; 500 if missing
4. Middleware + route-level auth covers all write paths
6. `isPublic === true` strict check in importLabels

---

## Phase 3 — UI visibility toggle ✅
**Commit:** `b2d9549` feat(auth): add isPublic visibility toggle to address book

### What was done
- `src/components/address-labels-provider.tsx`: `upsertLabel` signature updated to accept `isPublic?: boolean`, passes it through the PUT body
- `src/components/address-label-editor.tsx`: `isPublic` state initialized from `initial?.isPublic`, toggle switch UI added after Notes field, passed to `upsertLabel`
- `src/app/address-book/page.tsx`: `isPublic` added to `AddressRowProps`, passed from `entry?.isPublic`, new **Visibility** column in thead, emerald badge for public / amber badge for private custom labels

---

## Status: All phases complete
- 327 tests passing
- Typecheck: clean
- Build: successful (Next.js 16.1.7)
- Branch: `feat/google-auth-address-labels`

## Next steps
- Set env vars: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET` (generate with `npx auth secret`)
- Add `CRON_SECRET` for backup cron job in production
- Open PR for review
