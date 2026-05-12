// ===========================================================================
// EventHandlersBridgeOnly.ts — Envio entry point for the bridge-only local
// harness (config.multichain.bridge-only.yaml).
//
// The bridge-only config declares ONLY the Wormhole NTT contracts, so its
// generated types do not include FPMMFactory/FPMM/SortedOracles/etc. Using the
// normal EventHandlers.ts would register handlers for contracts that do not
// exist in this generated package.
//
// Keep this in sync with the Wormhole handler imports in EventHandlers.ts.
// ===========================================================================

import { runStartupChecks } from "./startupChecks.js";

runStartupChecks();

import "./handlers/wormhole/nttManager.js";
import "./handlers/wormhole/wormholeTransceiver.js";
