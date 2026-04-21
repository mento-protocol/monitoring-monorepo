import Link from "next/link";
import { BridgeRedeemHelper } from "@/components/bridge-redeem-cta";

export default async function BridgeRedeemPage({
  searchParams,
}: {
  searchParams: Promise<{ txHash?: string }>;
}) {
  const params = await searchParams;
  const txHash = params.txHash?.trim() ?? "";

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link
          href="/bridge-flows"
          className="text-sm text-slate-400 hover:text-slate-200"
        >
          ← Back to bridge flows
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-white">Redeem stuck transfer</h1>
          <p className="text-sm text-slate-400">
            Trigger a manual Wormhole redeem on Celo for an in-flight transfer.
          </p>
        </div>
      </div>

      {txHash ? (
        <BridgeRedeemHelper txHash={txHash} />
      ) : (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300">
          Missing <span className="font-mono text-slate-100">txHash</span> query
          parameter.
        </div>
      )}
    </div>
  );
}
