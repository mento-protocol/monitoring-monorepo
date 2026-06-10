/*
template: evmAbiFilter
abi: [{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"proposalId","type":"uint256"}],"name":"ProposalCanceled","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"proposalId","type":"uint256"},{"indexed":false,"internalType":"address","name":"proposer","type":"address"},{"indexed":false,"internalType":"address[]","name":"targets","type":"address[]"},{"indexed":false,"internalType":"uint256[]","name":"values","type":"uint256[]"},{"indexed":false,"internalType":"string[]","name":"signatures","type":"string[]"},{"indexed":false,"internalType":"bytes[]","name":"calldatas","type":"bytes[]"},{"indexed":false,"internalType":"uint256","name":"startBlock","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"endBlock","type":"uint256"},{"indexed":false,"internalType":"string","name":"description","type":"string"}],"name":"ProposalCreated","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"proposalId","type":"uint256"}],"name":"ProposalExecuted","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"proposalId","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"eta","type":"uint256"}],"name":"ProposalQueued","type":"event"}]
contracts: 0x47036d78bb3169b4f5560dd77bf93f4412a59852
*/

const contracts = ["0x47036d78bb3169b4f5560dd77bf93f4412a59852"];
// Only the 4 events the app handles — matches the comment header above.
// The JS body is not executed by QuickNode for template-based webhooks.
const abi = `[{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"proposalId","type":"uint256"}],"name":"ProposalCanceled","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"proposalId","type":"uint256"},{"indexed":false,"internalType":"address","name":"proposer","type":"address"},{"indexed":false,"internalType":"address[]","name":"targets","type":"address[]"},{"indexed":false,"internalType":"uint256[]","name":"values","type":"uint256[]"},{"indexed":false,"internalType":"string[]","name":"signatures","type":"string[]"},{"indexed":false,"internalType":"bytes[]","name":"calldatas","type":"bytes[]"},{"indexed":false,"internalType":"uint256","name":"startBlock","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"endBlock","type":"uint256"},{"indexed":false,"internalType":"string","name":"description","type":"string"}],"name":"ProposalCreated","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"proposalId","type":"uint256"}],"name":"ProposalExecuted","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"proposalId","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"eta","type":"uint256"}],"name":"ProposalQueued","type":"event"}]`;

function main(stream) {
  const result = [];

  const hasContracts = contracts.length > 0;
  const contractSet = hasContracts ? new Set(contracts) : null;

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
          result.push({
            transactionHash: receipt.transactionHash,
            ...log,
          });
        }
      }
    }
  }

  return result.length > 0 ? { result } : null;
}
