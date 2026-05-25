/**
 * Formatters for transaction-related events (SafeReceived, SafeMultiSigTransaction)
 */

import {
  extractSignersFromSignatures,
  getBlockExplorer,
  getTransactionExecutor,
} from "../utils";
import type { DiscordEmbedField, QuickNodeDecodedLog } from "../types";

export async function formatSafeReceivedEvent(
  log: QuickNodeDecodedLog,
  chainConfig: { decimals: number; symbol: string },
): Promise<DiscordEmbedField[]> {
  const fields: DiscordEmbedField[] = [];

  if (log.sender && typeof log.sender === "string") {
    fields.push({
      name: "Sender",
      value: log.sender,
      inline: false,
    });
  }

  if (log.value !== undefined) {
    try {
      const value =
        typeof log.value === "string"
          ? BigInt(log.value)
          : BigInt(Number(log.value));
      const valueFormatted = Number(value) / 10 ** chainConfig.decimals;
      fields.push({
        name: "Value",
        value: `${valueFormatted.toFixed(6)} ${chainConfig.symbol}`,
        inline: false,
      });
    } catch {
      // Ignore parsing errors
    }
  }

  return fields;
}

export async function formatSafeMultiSigTransactionEvent(
  log: QuickNodeDecodedLog,
  chainConfig: { decimals: number; symbol: string },
  chainName: string,
  txHash?: string,
): Promise<DiscordEmbedField[]> {
  const fields: DiscordEmbedField[] = [];
  const blockExplorer = getBlockExplorer(chainName);

  if (log.to && typeof log.to === "string") {
    fields.push({
      name: "To",
      value: `[${log.to}](${blockExplorer.address(log.to)})`,
      inline: false,
    });
  }

  if (log.value && typeof log.value === "string") {
    try {
      const value = BigInt(log.value);
      const valueFormatted = Number(value) / 10 ** chainConfig.decimals;
      if (valueFormatted > 0) {
        fields.push({
          name: "Value",
          value: `${valueFormatted.toFixed(6)} ${chainConfig.symbol}`,
          inline: false,
        });
      }
    } catch {
      // Ignore parsing errors
    }
  }

  // Extract signers from signatures if txHash is available
  if (txHash && log.signatures && typeof log.signatures === "string") {
    const signers = await extractSignersFromSignatures(log.signatures, txHash);
    if (signers.length > 0) {
      const signerLinks = signers
        .map(
          (addr) =>
            `[${addr.slice(0, 6)}...${addr.slice(-4)}](${blockExplorer.address(addr)})`,
        )
        .join(", ");
      fields.push({
        name: "Signers",
        value: signerLinks,
        inline: true,
      });
    }
  }

  // Get executor address (who actually executed the transaction)
  if (log.transactionHash && typeof log.transactionHash === "string") {
    const executor = await getTransactionExecutor(
      log.transactionHash,
      chainName,
    );
    if (executor) {
      fields.push({
        name: "Executed by",
        value: `[${executor.slice(0, 6)}...${executor.slice(-4)}](${blockExplorer.address(executor)})`,
        inline: true,
      });
    }
  }

  return fields;
}
