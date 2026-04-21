"use client";

import { useState, useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  buildReceiveMessageCalldata,
  type BridgeRedeemPayload,
} from "@/lib/bridge-flows/redeem";

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
  payload: BridgeRedeemPayload,
) {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: payload.chainIdHex }],
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
        chainId: payload.chainIdHex,
        chainName: payload.chainName,
        nativeCurrency: payload.nativeCurrency,
        rpcUrls: [payload.rpcUrl],
        blockExplorerUrls: [payload.explorerUrl],
      },
    ],
  });
  // EIP-3085: wallet_addEthereumChain does not auto-switch; switch explicitly.
  await provider.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: payload.chainIdHex }],
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

  await ensureCorrectChain(provider, payload);
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

export type ToastEntry = {
  id: number;
  message: string;
  type: "success" | "error";
  href?: string;
};

export type AddToast = (
  message: string,
  type: "success" | "error",
  href?: string,
) => void;

export function ToastItem({
  entry,
  onDismiss,
}: {
  entry: ToastEntry;
  onDismiss: () => void;
}) {
  const base =
    "pointer-events-auto flex items-start gap-2 max-w-sm w-full rounded-md px-4 py-3 text-sm shadow-lg border";
  const style =
    entry.type === "success"
      ? `${base} border-emerald-900/60 bg-emerald-950/95 text-emerald-200`
      : `${base} border-red-900/60 bg-red-950/95 text-red-200`;
  return (
    <div className={style}>
      <span className="flex-1 break-words">
        {entry.href ? (
          <a
            href={entry.href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-current underline-offset-2"
          >
            {entry.message}
          </a>
        ) : (
          entry.message
        )}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-slate-400 hover:text-slate-200 shrink-0 leading-none text-base"
      >
        ×
      </button>
    </div>
  );
}

const subscribe = () => () => {};

export function ToastPortal({
  toasts,
  onDismiss,
}: {
  toasts: ToastEntry[];
  onDismiss: (id: number) => void;
}) {
  const isClient = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  if (!isClient || toasts.length === 0) return null;
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} entry={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>,
    document.body,
  );
}

type TxReceipt = { status: `0x${string}` } | null;

async function waitForTransaction(
  txHash: string,
  rpcUrl: string,
  signal: AbortSignal,
): Promise<TxReceipt> {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (signal.aborted) return null;
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionReceipt",
        params: [txHash],
      }),
      signal,
    });
    const json = (await response.json()) as { result: TxReceipt };
    if (json.result) return json.result;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return null;
}

type RedeemPhase = "idle" | "fetching" | "sending" | "mining" | "done";

export function BridgeRedeemPill({
  sentTxHash,
  destChainId,
  tokenSymbol,
  addToast,
}: {
  sentTxHash: string;
  destChainId: number;
  tokenSymbol: string;
  addToast: AddToast;
}) {
  const [phase, setPhase] = useState<RedeemPhase>("idle");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function handleClick() {
    if (phase !== "idle") return;
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase("fetching");
    try {
      const params = new URLSearchParams({
        txHash: sentTxHash,
        destChainId: String(destChainId),
        tokenSymbol,
      });
      const res = await fetch(`/api/bridge-redeem?${params.toString()}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      const raw = await res.text();
      let body: BridgeRedeemPayload | { error?: string };
      try {
        body = JSON.parse(raw) as BridgeRedeemPayload | { error?: string };
      } catch {
        throw new Error("Failed to fetch Wormhole VAA.");
      }
      if (!res.ok || !("vaaHex" in body)) {
        throw new Error(
          "error" in body && typeof body.error === "string"
            ? body.error
            : "Failed to fetch Wormhole VAA.",
        );
      }

      setPhase("sending");
      const calldata = buildReceiveMessageCalldata(body.vaaHex);
      const txHash = await sendRedeemTransaction(body, calldata);

      setPhase("mining");
      const receipt = await waitForTransaction(txHash, body.rpcUrl, ac.signal);
      if (ac.signal.aborted) return;
      if (!receipt) throw new Error("Transaction not confirmed after 90 s.");
      if (receipt.status !== "0x1")
        throw new Error("Transaction reverted on-chain.");

      setPhase("done");
      addToast(
        `Redeem confirmed: ${shortHash(txHash)}`,
        "success",
        body.explorerUrl ? `${body.explorerUrl}/tx/${txHash}` : undefined,
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setPhase("idle");
      addToast(err instanceof Error ? err.message : "Redeem failed.", "error");
    }
  }

  const baseClass =
    "inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-mono";

  if (phase === "fetching" || phase === "sending" || phase === "mining") {
    const label =
      phase === "fetching"
        ? "fetching…"
        : phase === "sending"
          ? "sending…"
          : "pending…";
    return (
      <span
        className={`${baseClass} bg-amber-900/40 text-amber-300 cursor-wait`}
      >
        <SpinnerIcon />
        {label}
      </span>
    );
  }
  if (phase === "done") {
    return (
      <span className={`${baseClass} bg-emerald-900/40 text-emerald-300`}>
        ✓ sent
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      className={`${baseClass} bg-amber-900/40 text-amber-300 hover:bg-amber-900/60 transition-colors`}
      title="Manually redeem this stuck transfer"
    >
      redeem
      <span aria-hidden="true" className="text-amber-500">
        {"↗"}
      </span>
    </button>
  );
}

function SpinnerIcon() {
  return (
    <svg
      className="animate-spin h-2.5 w-2.5 mr-0.5"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
