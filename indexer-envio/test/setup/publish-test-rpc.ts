// Publish the loopback test-RPC URLs (ENVIO_RPC_URL_<chainId> and
// ENVIO_RPC_FALLBACK_URL_<chainId>) before any test module is imported.
// getRpcClient() memoizes the first client per chain (src/rpc/client.ts),
// so an effect firing before this would otherwise pin a live default
// endpoint (e.g. forno.celo.org) for the rest of the process.
import { waitForHttpTestRpc } from "../../src/rpc/http-test-mocks.js";

await waitForHttpTestRpc();
