// ===========================================================================
// EventHandlersBridgeOnly.ts — Envio entry point for the bridge-only local
// harness (config.multichain.bridge-only.yaml).
//
// The bridge-only config declares ONLY the Wormhole NTT contracts, so its
// generated/ types do not include FPMMFactory/FPMM/SortedOracles/etc. Using
// the normal EventHandlers.ts would crash at load because those side-effect
// imports try to import generated symbols that don't exist for this config.
//
// Keep this in sync with the Wormhole handler imports in EventHandlers.ts.
// ===========================================================================

import { runStartupChecks } from "./startupChecks";

runStartupChecks();

import "./handlers/wormhole/nttManager";
import "./handlers/wormhole/wormholeTransceiver";
