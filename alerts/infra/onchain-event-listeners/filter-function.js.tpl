${abi_comment}

const contracts = ${jsonencode([for addr in contracts : lower(addr)])};
const abi = ${jsonencode(abi)};

function main(stream) {
  const result = [];

  const hasContracts = contracts.length > 0;
  const contractSet = hasContracts ? new Set(contracts) : null;

  for (const block of stream.data) {
    const filteredReceipts = block.receipts.map(receipt => {
      const logs = contractSet
        ? receipt.logs.filter(log => contractSet.has(log.address.toLowerCase()))
        : receipt.logs;

      return { ...receipt, logs };
    });

    const decodedReceipts = decodeEVMReceipts(filteredReceipts, [abi]);

    for (const receipt of decodedReceipts) {
      if (receipt.decodedLogs && receipt.decodedLogs.length > 0) {
        for (const log of receipt.decodedLogs) {
          result.push({
            transactionHash: receipt.transactionHash,
            ...log
          });
        }
      }
    }
  }

  return result.length > 0 ? { result } : null;
}
