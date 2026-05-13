import { waitForHttpTestRpc } from "../../src/rpc/http-test-mocks.js";

export async function expectHttpRpcMockFallback(): Promise<void> {
  await waitForHttpTestRpc();
}
