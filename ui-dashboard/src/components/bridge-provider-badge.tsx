import type { BridgeProvider } from "@/lib/types";

const PROVIDER_LABELS: Record<BridgeProvider, string> = {
  WORMHOLE: "Wormhole",
};

export function BridgeProviderBadge({
  provider,
}: {
  provider: BridgeProvider;
}) {
  return (
    <span className="inline-flex rounded-full bg-slate-800 px-2 py-0.5 text-[10px] uppercase tracking-wider font-medium text-slate-200">
      {PROVIDER_LABELS[provider] ?? provider}
    </span>
  );
}
