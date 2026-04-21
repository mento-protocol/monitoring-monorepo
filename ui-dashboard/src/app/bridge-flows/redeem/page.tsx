import Link from "next/link";
import { BridgeRedeemHelper } from "@/components/bridge-redeem-cta";
import {
  getChainRedeemConfig,
  getTransceiverForToken,
} from "@/lib/bridge-flows/redeem";

export default async function BridgeRedeemPage({
  searchParams,
}: {
  searchParams: Promise<{
    txHash?: string;
    destChainId?: string;
    tokenSymbol?: string;
    statuses?: string;
  }>;
}) {
  const params = await searchParams;
  const txHash = params.txHash?.trim() ?? "";
  const destChainId = Number(params.destChainId ?? "");
  const tokenSymbol = params.tokenSymbol?.trim() ?? "";
  const statuses = params.statuses?.trim();

  const missingParam = !txHash
    ? "txHash"
    : !Number.isFinite(destChainId) || destChainId === 0
      ? "destChainId"
      : !tokenSymbol
        ? "tokenSymbol"
        : null;

  const chainConfig = missingParam ? null : getChainRedeemConfig(destChainId);
  const hasTransceiver = missingParam
    ? false
    : !!getTransceiverForToken(tokenSymbol);

  const configError = missingParam
    ? null
    : !chainConfig
      ? `Unsupported destination chain: ${destChainId}`
      : !hasTransceiver
        ? `Unknown token: ${tokenSymbol}`
        : null;

  const chainName = chainConfig?.chainName ?? "destination chain";

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link
          href={
            statuses
              ? `/bridge-flows?statuses=${encodeURIComponent(statuses)}`
              : "/bridge-flows"
          }
          className="text-sm text-slate-400 hover:text-slate-200"
        >
          ← Back to bridge flows
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-white">
            Redeem stuck transfer
          </h1>
          <p className="text-sm text-slate-400">
            Manually trigger a Wormhole redeem on {chainName}.
          </p>
        </div>
      </div>

      {missingParam ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300">
          Missing{" "}
          <span className="font-mono text-slate-100">{missingParam}</span> query
          parameter.
        </div>
      ) : configError ? (
        <div className="rounded-xl border border-red-900/60 bg-red-950/30 p-4 text-sm text-red-200">
          {configError}
        </div>
      ) : (
        <BridgeRedeemHelper
          txHash={txHash}
          destChainId={destChainId}
          tokenSymbol={tokenSymbol}
        />
      )}
    </div>
  );
}
