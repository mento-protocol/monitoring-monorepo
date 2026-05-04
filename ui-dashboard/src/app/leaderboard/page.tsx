import { Suspense } from "react";
import { LeaderboardClient } from "./page-client";

export const metadata = {
  title: "Volume Leaderboard | Mento Analytics",
  description:
    "Top traders on Mento by USD volume — sorted by 24h, 7d, 30d, or all-time, with per-pool flow breakdown.",
};

export default function LeaderboardPage() {
  return (
    <Suspense>
      <LeaderboardClient />
    </Suspense>
  );
}
