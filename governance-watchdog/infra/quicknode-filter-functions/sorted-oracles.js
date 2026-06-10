/*
template: evmAbiFilter
abi: [{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"token","type":"address"},{"indexed":false,"internalType":"uint256","name":"value","type":"uint256"}],"name":"MedianUpdated","type":"event"}]
contracts: 0xefb84935239dacdecf7c5ba76d8de40b077b7b33
*/

const contracts = ["0xefb84935239dacdecf7c5ba76d8de40b077b7b33"];
// Only MedianUpdated — matches the comment header above which the deploy script reads.
// The evmAbiFilter template uses these templateArgs (abi + contracts); this JS body is
// not executed by QuickNode for template-based webhooks.
const abi = `[{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"token","type":"address"},{"indexed":false,"internalType":"uint256","name":"value","type":"uint256"}],"name":"MedianUpdated","type":"event"}]`;

function main(stream) {
  const result = [];

  const hasContracts = contracts.length > 0;
  const contractSet = hasContracts ? new Set(contracts) : null;

  // Target token address for MedianUpdated events: CELO/cUSD rate feed
  const targetTokenAddress =
    "0x765de816845861e75a25fca122bb6898b8b1282a".toLowerCase();

  for (const block of stream.data) {
    const filteredReceipts = block.receipts.map((receipt) => {
      const logs = contractSet
        ? receipt.logs.filter((log) =>
            contractSet.has(log.address.toLowerCase()),
          )
        : receipt.logs;

      return { ...receipt, logs };
    });

    const decodedReceipts = decodeEVMReceipts(filteredReceipts, [abi]);

    for (const receipt of decodedReceipts) {
      if (receipt.decodedLogs && receipt.decodedLogs.length > 0) {
        for (const log of receipt.decodedLogs) {
          // Only include MedianUpdated events with the specific token address
          if (
            log.name === "MedianUpdated" &&
            log.token.toLowerCase() === targetTokenAddress
          ) {
            result.push({
              transactionHash: receipt.transactionHash,
              ...log,
            });
          }
        }
      }
    }
  }

  return result.length > 0 ? { result } : null;
}
