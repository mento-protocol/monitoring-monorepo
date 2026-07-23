import { startServer } from "./server.js";
import { startPolling } from "./poller.js";
import { startPegPolling } from "./peg/runtime.js";

startServer();
startPolling();
startPegPolling();
