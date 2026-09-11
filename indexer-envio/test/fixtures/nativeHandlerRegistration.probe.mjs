// Spawned by test/handlerRegistrationNative.test.ts under plain Node with
// envio's own loader, the way `envio start` loads handlers:
// `registerAllHandlers` auto-loads `config.handlers` and then imports every
// `handler:` entry from config.yaml. Prints how many handler executions one
// simulated event produced; the test expects exactly one. The test supplies
// the env (start blocks and closed-port RPC URLs).
const { createTestIndexer } = await import("envio");
const indexer = createTestIndexer();
const result = await indexer.process({
  chains: {
    42220: {
      startBlock: 100,
      endBlock: 100,
      simulate: [
        {
          contract: "FPMMFactory",
          event: "FPMMDeployed",
          // Configured Celo FPMMFactory address, so the item routes.
          srcAddress: "0xa849b475FE5a4B5C9C3280152c7a1945b907613b",
          logIndex: 0,
          block: { number: 100, timestamp: 1_700_000_000 },
          params: {
            fpmm: "0x00000000000000000000000000000000000000F0",
            token0: "0x0000000000000000000000000000000000000003",
            token1: "0x0000000000000000000000000000000000000004",
            implementation: "0x00000000000000000000000000000000000000bc",
          },
        },
      ],
    },
  },
});
const eventsProcessed = result.changes.reduce(
  (sum, change) => sum + change.eventsProcessed,
  0,
);
console.log(JSON.stringify({ eventsProcessed }));
process.exit(0);
