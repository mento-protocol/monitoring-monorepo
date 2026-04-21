"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  buildReceiveMessageCalldata,
  getChainRedeemConfig,
  type BridgeRedeemPayload,
  type ChainRedeemConfig,
} from "@/lib/bridge-flows/redeem";
import { wormholescanUrl } from "@/lib/wormhole/urls";

type EthereumProvider = {
  request(args: {
    method: string;
    params?: unknown[] | object;
  }): Promise<unknown>;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

function shortHash(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

async function ensureCorrectChain(
  provider: EthereumProvider,
  config: ChainRedeemConfig,
) {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: config.chainIdHex }],
    });
    return;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? Number((error as { code?: unknown }).code)
        : null;
    if (code !== 4902) throw error;
  }

  await provider.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: config.chainIdHex,
        chainName: config.chainName,
        nativeCurrency: config.nativeCurrency,
        rpcUrls: [config.rpcUrl],
        blockExplorerUrls: [config.explorerUrl],
      },
    ],
  });
}

async function sendRedeemTransaction(
  payload: BridgeRedeemPayload,
  calldata: `0x${string}`,
) {
  const provider = window.ethereum;
  if (!provider) {
    throw new Error(
      "No injected wallet found. Open this page in a wallet-enabled browser.",
    );
  }

  const chainConfig = getChainRedeemConfig(payload.chainId);
  if (!chainConfig) throw new Error(`Unknown chain: ${payload.chainId}`);

  await ensureCorrectChain(provider, chainConfig);
  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as string[];
  const from = accounts[0];
  if (!from) {
    throw new Error("Wallet did not return an account.");
  }

  return (await provider.request({
    method: "eth_sendTransaction",
    params: [{ from, to: payload.transceiver, data: calldata }],
  })) as string;
}

export function BridgeRedeemTableLink({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-0.5 rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] font-mono text-amber-300 hover:bg-amber-900/60 transition-colors"
      title="Open redeem helper"
    >
      redeem
      <span aria-hidden="true" className="text-amber-500">
        {"↗"}
      </span>
    </Link>
  );
}

export function BridgeRedeemHelper({
  txHash,
  destChainId,
  tokenSymbol,
}: {
  txHash: string;
  destChainId: number;
  tokenSymbol: string;
}) {
  const [payload, setPayload] = useState<BridgeRedeemPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txSent, setTxSent] = useState<string | null>(null);

  const chainName = getChainRedeemConfig(destChainId)?.chainName ?? "Unknown";

  const castCommand = useMemo(() => {
    if (!payload) return null;
    return [
      `cast send ${payload.transceiver}`,
      `  "receiveMessage(bytes)" ${payload.vaaHex}`,
      `  --rpc-url ${payload.rpcUrl}`,
      '  --private-key "$PRIVATE_KEY"',
    ].join(" \\\n");
  }, [payload]);

  async function loadPayload() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        txHash,
        destChainId: String(destChainId),
        tokenSymbol,
      });
      const response = await fetch(`/api/bridge-redeem?${params.toString()}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as
        | BridgeRedeemPayload
        | { error?: string };
      if (!response.ok || !("vaaHex" in body)) {
        const message =
          "error" in body && typeof body.error === "string"
            ? body.error
            : "Failed to fetch Wormhole VAA.";
        throw new Error(message);
      }
      setPayload(body);
      return body;
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : "Failed to fetch Wormhole VAA.";
      setError(message);
      throw caught;
    } finally {
      setLoading(false);
    }
  }

  async function handleSend() {
    try {
      const ready = payload ?? (await loadPayload());
      const calldata = buildReceiveMessageCalldata(ready.vaaHex);
      const hash = await sendRedeemTransaction(ready, calldata);
      setTxSent(hash);
      setError(null);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Redeem transaction failed.";
      setError(message);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4 sm:p-5">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-white">Redeem helper</h2>
        <p className="text-sm text-slate-400">
          Manually submit the signed Wormhole VAA to the{" "}
          <span className="text-slate-300">{chainName}</span> transceiver.
        </p>
      </div>

      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-slate-500">Source tx</dt>
          <dd className="font-mono text-slate-200 break-all">{txHash}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Destination chain</dt>
          <dd className="text-slate-200">{chainName}</dd>
        </div>
      </dl>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={handleSend}
          disabled={loading}
          className="inline-flex items-center justify-center rounded-md bg-amber-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Fetching VAA…" : "Send redeem tx"}
        </button>
        <button
          type="button"
          onClick={() => {
            void loadPayload();
          }}
          disabled={loading}
          className="inline-flex items-center justify-center rounded-md border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Show calldata
        </button>
        <a
          href={wormholescanUrl(txHash)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 transition-colors"
        >
          Trace on Wormholescan
          <span aria-hidden="true" className="text-slate-500">
            {"↗"}
          </span>
        </a>
      </div>

      {error && (
        <p className="rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}

      {txSent && (
        <p className="rounded-md border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200">
          Transaction submitted:{" "}
          <a
            href={`${payload?.explorerUrl ?? ""}/tx/${txSent}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono underline decoration-emerald-500/50 underline-offset-2"
          >
            {shortHash(txSent)}
          </a>
        </p>
      )}

      {payload && (
        <div className="space-y-4 border-t border-slate-800 pt-4">
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-500">Transceiver</dt>
              <dd className="font-mono text-slate-200 break-all">
                {payload.transceiver}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Write contract</dt>
              <dd>
                <a
                  href={`${payload.explorerUrl}/address/${payload.transceiver}#writeContract`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-indigo-300 hover:text-indigo-200"
                >
                  Open on {payload.chainName} explorer
                </a>
              </dd>
            </div>
          </dl>

          {/* Function call — human-readable decoded view */}
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-sm text-slate-400">Function call</p>
              <p className="font-mono text-sm">
                <span className="text-indigo-300">receiveMessage</span>
                <span className="text-slate-500">(</span>
                <span className="text-amber-300">bytes</span>{" "}
                <span className="text-slate-200">vaa</span>
                <span className="text-slate-500">)</span>
              </p>
            </div>
            <div>
              <label
                className="block text-xs text-slate-500 mb-1"
                htmlFor="redeem-vaa"
              >
                vaa
              </label>
              <textarea
                id="redeem-vaa"
                readOnly
                value={payload.vaaHex}
                className="min-h-24 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200"
              />
            </div>
          </div>

          {castCommand && (
            <div className="space-y-1">
              <label
                className="block text-sm text-slate-400"
                htmlFor="redeem-cast-command"
              >
                Foundry fallback
              </label>
              <textarea
                id="redeem-cast-command"
                readOnly
                value={castCommand}
                className="min-h-28 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
