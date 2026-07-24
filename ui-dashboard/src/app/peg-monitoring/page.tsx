import type { Metadata } from "next";
import { PegMonitoringPageClient } from "./peg-monitoring-page-client";

export const metadata: Metadata = {
  title: "Peg monitoring | Mento Monitoring",
  description:
    "Current executable-price, structural, source, and breaker evidence for Mento peg monitoring.",
};
export default function PegMonitoringPage(): React.JSX.Element {
  return <PegMonitoringPageClient />;
}
