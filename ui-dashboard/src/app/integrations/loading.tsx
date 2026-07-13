import { PageShellSkeleton } from "@/components/skeletons";

// Route-level fallback for `/integrations`. The page is an async server
// component with real awaits (getAuthSession + the Upstash integration-probe
// snapshot read) and had no own loading boundary before, so it inherited the
// homepage-shaped root `loading.tsx` despite having a tiles+probes-table
// layout with no charts. Restoring the generic `PageShellSkeleton` here
// matches the neutral fallback every route without a bespoke skeleton used
// before the homepage-shaped rework.
export default function IntegrationsLoading() {
  return <PageShellSkeleton />;
}
