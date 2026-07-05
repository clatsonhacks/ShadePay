// @shade/sdk — Shade Protocol client SDK
// Browser-safe. No node: imports. No server-side dependencies.
// Modules:
// cctp — CCTP route builder (buildDepositRoute, buildExitRoute)
// notes — NoteManager + vault crypto re-exports
// intents — IntentClient for the Shade RFQ API
// wallets — FreighterAdapter (Stellar) + EvmSignerAdapter

export * from "./cctp.js";
export * from "./notes.js";
export * from "./intents.js";
export * from "./wallets.js";
export * from "./mpc.js";
export * from "./streams.js";
export * from "./receipts.js";
export * from "./agents.js";
