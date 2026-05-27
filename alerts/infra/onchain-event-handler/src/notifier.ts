import { NOTIFICATION_COLORS } from "./constants";
import type { NotificationContent, QuickNodeDecodedLog } from "./types";
import {
  decodeEventData,
  getBlockExplorer,
  getMultisigChainInfo,
  getMultisigName,
  getSafeUiUrl,
  isSecurityEvent,
} from "./utils";

/**
 * Format chain-agnostic notification content from a decoded Safe event.
 */
export async function formatNotificationContent(
  eventName: string,
  log: QuickNodeDecodedLog,
  multisigKey: string,
  txHashMap: Map<string, string>,
  signal?: AbortSignal,
): Promise<NotificationContent> {
  const isSecurity = isSecurityEvent(eventName);
  const color = isSecurity
    ? NOTIFICATION_COLORS.ALERT
    : NOTIFICATION_COLORS.EVENT;
  const multisigName = getMultisigName(multisigKey);

  const chainInfo = getMultisigChainInfo(multisigKey);
  if (!chainInfo) {
    throw new Error(`Chain info not found for multisig: ${multisigKey}`);
  }

  const chainDisplay =
    chainInfo.chain.charAt(0).toUpperCase() + chainInfo.chain.slice(1);
  const chainName = chainInfo.chain;

  const txHashForSafe =
    log.txHash && typeof log.txHash === "string"
      ? log.txHash
      : txHashMap.get(log.transactionHash.toLowerCase()) || log.transactionHash;
  const safeUiUrl = getSafeUiUrl(log.address, txHashForSafe, multisigKey);
  const blockExplorer = getBlockExplorer(chainName);

  const fields = [
    {
      name: "Transaction Hash",
      value: `[${log.transactionHash}](${blockExplorer.tx(log.transactionHash)})`,
      inline: false,
    },
    {
      name: "Safe UI Link",
      value: `[Open TX in Safe UI](${safeUiUrl})`,
      inline: false,
    },
    ...(await decodeEventData(
      eventName,
      log,
      txHashForSafe,
      chainName,
      signal,
    )),
  ];

  return {
    title: `${multisigName} [${chainDisplay}]`,
    description: `\`${eventName}\` event detected on ${multisigName} on ${chainDisplay}`,
    color,
    fields,
    // QuickNode decoded logs do not include block time; record dispatch time.
    timestamp: new Date().toISOString(),
  };
}
