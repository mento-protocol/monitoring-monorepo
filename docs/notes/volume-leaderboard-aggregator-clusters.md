# Volume Leaderboard Aggregator Cluster Labels

Use `cluster-<first-16-hex-of-deployer-EOA>` labels for contracts that share a
deployer EOA but have no public project identity. This is meant for observed
Mento volume routers where the factual shared-deployer link is useful, but a
project label would be unsupported.

Current label:

- `cluster-7dc08ec28f299c06` on Celo. Deployer:
  `0x7dc08ec28f299c062d2941de1f9cfb741df8f022`. The cluster covers 16
  contracts deployed via the CREATE3 factory `0xba5Ed099...ba5Ed`.

Do not label single-contract deployers just because they are unknown. One
contract per deployer gives no clustering signal, and without a project
identity the label adds little beyond what a per-`txTo` drill-down would show.

Do not preemptively scan all deployer histories into the aggregator config.
The config should reflect contracts observed driving Mento volume. A periodic
audit of the `unknown` bucket is the right way to expand it.

Do not use blanket `mev-*` labels. MEV is an interpretation of behavior;
shared deployer is the factual signal. Dashboard tooltips can explain that
these are likely one operator running multiple contracts, without presenting
that inference as identity.

Expansion procedure:

1. When a new entry appears in the top-N of
   `AggregatorDailySnapshot.aggregator = "unknown"`, pull the snapshot's
   `lastSeenAggregatorAddress`.
2. Look up the deployer on the relevant explorer.
3. Check whether other contracts in the observed `unknown` bucket share that
   deployer.
4. If at least two observed contracts cluster, add a new
   `cluster-<first-16-hex-of-deployer-EOA>` label.
