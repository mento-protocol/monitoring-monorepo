import { startServer } from "./server.js";
import { startPolling } from "./poller.js";
import { startPegPolling } from "./peg/runtime.js";

import { startBridgePolling } from "./bridge/runtime.js";
import { startCapaWithdrawalPolling } from "./capa-withdrawal-poller.js";

startServer();
startPolling();
startPegPolling();
startBridgePolling();
startCapaWithdrawalPolling();
