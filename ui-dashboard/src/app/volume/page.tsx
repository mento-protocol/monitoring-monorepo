import { Suspense } from "react";
import { getAuthSession } from "@/auth";
import { VolumeClient } from "./page-client";

export const metadata = {
  title: "Volume | Mento Analytics",
  description:
    "Top traders on Mento by USD volume — sorted by 24h, 7d, 30d, or all-time, with per-pool flow breakdown.",
};

export default async function VolumePage() {
  const session = await getAuthSession();

  return (
    <Suspense>
      <VolumeClient canUseVolumeFilters={!!session} />
    </Suspense>
  );
}
