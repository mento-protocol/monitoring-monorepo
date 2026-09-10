import { startServer } from "./server.js";
import { startPolling } from "./poller.js";
import { startPegPolling } from "./peg/runtime.js";

import { startBridgePolling } from "./bridge/runtime.js";

startServer();
startPolling();
startPegPolling();
startBridgePolling();
