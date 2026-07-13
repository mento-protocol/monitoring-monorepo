import { PageShellSkeleton } from "@/components/skeletons";

// Route-level fallback for `/entities` and `/entities/[slug]` (the nearer
// ancestor loading.tsx covers both — the slug route has no own loading.tsx).
// Both are async server components with real awaits (getAuthSession, Redis
// HKEYS/entity reads) and neither had its own loading boundary before, so
// both inherited the homepage-shaped root `loading.tsx` despite this being a
// narrow `max-w-2xl` search page with no charts, tiles, or table. Restoring
// the generic `PageShellSkeleton` here matches the neutral fallback every
// route without a bespoke skeleton used before the homepage-shaped rework.
export default function EntitiesLoading() {
  return <PageShellSkeleton />;
}
