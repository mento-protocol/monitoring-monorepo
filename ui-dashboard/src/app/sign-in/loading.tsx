import { PageShellSkeleton } from "@/components/skeletons";

// Route-level fallback for `/sign-in`. The page is an async server component
// (awaits `searchParams`) and had no own loading boundary before, so it
// inherited the homepage-shaped root `loading.tsx` despite being a small
// centered card with no charts, tiles, or table. Restoring the generic
// `PageShellSkeleton` here matches the neutral fallback every route without a
// bespoke skeleton used before the homepage-shaped rework.
export default function SignInLoading() {
  return <PageShellSkeleton />;
}
