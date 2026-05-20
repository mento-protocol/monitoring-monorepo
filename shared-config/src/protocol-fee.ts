// Address that receives all protocol fees across every chain. The same
// address by Mento's deterministic-deploy convention — the contracts package
// publishes it as `YieldSplitAddress` on Celo mainnet and `ProtocolFeeRecipient`
// on every other namespace. Derived from `@mento-protocol/contracts` so we
// don't have to chase address changes through the dashboard + indexer + URLs.

import contractsData from "@mento-protocol/contracts/contracts.json" with { type: "json" };

type RawEntry = { address: string };
type ContractsJson = Record<string, Record<string, Record<string, RawEntry>>>;

const SOURCE = (contractsData as ContractsJson)["42220"]?.mainnet
  ?.YieldSplitAddress;

if (!SOURCE) {
  throw new Error(
    "YieldSplitAddress missing from @mento-protocol/contracts at 42220/mainnet — " +
      "package contract may have been renamed; update shared-config/src/protocol-fee.ts",
  );
}

export const PROTOCOL_FEE_RECIPIENT_ADDRESS =
  SOURCE.address.toLowerCase() as `0x${string}`;
