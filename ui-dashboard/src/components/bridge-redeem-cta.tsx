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
  href?: string | undefined;
};

export type AddToast = (
  message: string,
  type: "success" | "error",
  href?: string,
) => void;

function ToastItem({
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

const RECEIPT_POLL_TIMEOUT_MS = 8_000;
const RECEIPT_POLL_SLEEP_MS = 3_000;
const RECEIPT_POLL_DEADLINE_MS = 90_000;
const REDEEM_PAYLOAD_TIMEOUT_MS = 15_000;

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function timeoutError(): DOMException {
  return new DOMException("Timed out.", "TimeoutError");
}

async function withTimeoutSignal<T>(
  parentSignal: AbortSignal,
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parentSignal.aborted) throw parentSignal.reason;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(timeoutError());
  }, timeoutMs);
  const abort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", abort, { once: true });
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abort);
  }
}

export async function waitForTransaction(
  txHash: string,
  rpcUrl: string,
  signal: AbortSignal,
): Promise<TxReceipt> {
  // Sequential RPC poll — each iteration checks tx receipt and decides
  // whether to keep waiting; parallelism doesn't apply to status polls.
  const deadline = Date.now() + RECEIPT_POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) return null;
    try {
      const requestTimeoutMs = Math.min(
        RECEIPT_POLL_TIMEOUT_MS,
        deadline - Date.now(),
      );
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const response = await withTimeoutSignal(
        signal,
        requestTimeoutMs,
        async (requestSignal) =>
          fetch(rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "eth_getTransactionReceipt",
              params: [txHash],
            }),
            signal: requestSignal,
          }),
      );
      const json = (await response.json()) as { result: TxReceipt };
      if (json.result) return json.result;
    } catch (err) {
      if (signal.aborted) return null;
      void err;
      // Transient network, timeout, or JSON-parse error — retry on next iteration.
    }
    const sleepMs = Math.min(RECEIPT_POLL_SLEEP_MS, deadline - Date.now());
    if (sleepMs <= 0) break;
    try {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await sleep(sleepMs, signal);
    } catch (err) {
      if (signal.aborted) return null;
      throw err;
    }
  }
  return null;
}

type RedeemPhase = "idle" | "fetching" | "sending" | "mining" | "done";

async function fetchRedeemPayload({
  sentTxHash,
  destChainId,
  tokenSymbol,
  signal,
}: {
  sentTxHash: string;
  destChainId: number;
  tokenSymbol: string;
  signal: AbortSignal;
}): Promise<BridgeRedeemPayload> {
  const params = new URLSearchParams({
    txHash: sentTxHash,
    destChainId: String(destChainId),
    tokenSymbol,
  });
  const res = await withTimeoutSignal(
    signal,
    REDEEM_PAYLOAD_TIMEOUT_MS,
    async (requestSignal) =>
      fetch(`/api/bridge-redeem?${params.toString()}`, {
        cache: "no-store",
        signal: requestSignal,
      }),
  );
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
  return body;
}

function bridgeRedeemErrorMessage(error: unknown): string {
  if (isAbortLikeError(error)) return "Redeem request timed out. Try again.";
  return error instanceof Error ? error.message : "Redeem failed.";
}

function useBridgeRedeem({
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
  // react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers
  const [phase, setPhase] = useState<RedeemPhase>("idle");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function handleClick() {
    if (phase !== "idle") return;
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase("fetching");
    try {
      const body = await fetchRedeemPayload({
        sentTxHash,
        destChainId,
        tokenSymbol,
        signal: ac.signal,
      });
      setPhase("sending");
      const txHash = await sendRedeemTransaction(
        body,
        buildReceiveMessageCalldata(body.vaaHex),
      );
      setPhase("mining");
      await finishRedeemPolling(txHash, body, ac.signal, setPhase, addToast);
    } catch (err) {
      if (ac.signal.aborted) return;
      setPhase("idle");
      addToast(bridgeRedeemErrorMessage(err), "error");
    }
  }

  return { phase, handleClick };
}

async function finishRedeemPolling(
  txHash: string,
  body: BridgeRedeemPayload,
  signal: AbortSignal,
  setPhase: (phase: RedeemPhase) => void,
  addToast: AddToast,
) {
  const href = body.explorerUrl
    ? `${body.explorerUrl}/tx/${txHash}`
    : undefined;
  if (signal.aborted) return;
  const receipt = await waitForTransaction(txHash, body.rpcUrl, signal);
  if (!signal.aborted) {
    if (!receipt) {
      setPhase("done");
      addToast(
        `Submitted: ${shortHash(txHash)} — not confirmed after 90 s, check explorer`,
        "success",
        href,
      );
      return;
    }
    if (receipt.status !== "0x1")
      throw new Error("Transaction reverted on-chain.");
    setPhase("done");
    addToast(`Redeem confirmed: ${shortHash(txHash)}`, "success", href);
  }
}

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
  const { phase, handleClick } = useBridgeRedeem({
    sentTxHash,
    destChainId,
    tokenSymbol,
    addToast,
  });

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
