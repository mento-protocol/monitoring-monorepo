// ===========================================================================
// EventHandlersReserveYield.ts — Envio entry point for the reserve-yield
// Ethereum-only indexer.
//
// This entry point intentionally registers sparse sUSDS/stETH event handlers
// only. It does not register the historical sUSDS onBlock heartbeat, avoiding
// the synthetic-batch replay stall class that made chain 1 unsafe inside the
// primary Celo + Monad indexer.
// ===========================================================================

// Effect registrations used by sUSDS share-price reads.
import "./rpc/effects.js";

// stETH has no block heartbeat; importing it is event-only.
import "./handlers/steth.js";

import { registerSusdsYieldEventHandlers } from "./handlers/susdsEvents.js";

registerSusdsYieldEventHandlers();
