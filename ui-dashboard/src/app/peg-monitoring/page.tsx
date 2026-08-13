import type { Metadata } from "next";
import { PegMonitoringPageClient } from "./peg-monitoring-page-client";

export const metadata: Metadata = {
  title: "Peg Monitoring | Mento Monitoring",
  description:
    "Current peg measurements, decision status, and supporting evidence for Mento monitoring.",
};
export default function PegMonitoringPage(): React.JSX.Element {
  return <PegMonitoringPageClient />;
}
