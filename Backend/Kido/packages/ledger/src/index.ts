/**
 * Ledger Agent Stack integration.
 *
 * Phase 6 (Key Ring) is implemented here. Phase 7 (DMK / Ethereum Signer Kit / Clear Signing)
 * lives in `signer.ts`.
 *
 * Scope discipline: Key Ring and hardware transaction signing are DIFFERENT mechanisms solving
 * DIFFERENT problems, and the build rules require they not be blurred. Key Ring keeps a broker
 * credential away from the agent. Device signing puts a human in the loop before value moves.
 * Neither implies the other.
 */
export * from "./key-ring.js";
export * from "./protected-service.js";
export * from "./secret-provider.js";
export * from "./clear-signing.js";
