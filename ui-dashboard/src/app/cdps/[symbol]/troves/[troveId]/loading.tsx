// Route-level Suspense fallback. The skeleton itself lives in
// `_components/trove-detail-skeleton.tsx` — shared with
// `trove-detail-client.tsx`'s own SWR loading branches so the client-side
// data fetch keeps the same page shape this file paints first.

import { TroveDetailSkeleton } from "./_components/trove-detail-skeleton";

export default function TroveDetailLoading() {
  return <TroveDetailSkeleton />;
}
