# ADR-004 — Capability structure and the intent/calldata split

- **Status:** ACCEPTED · **Date:** 2026-09-06 (Phase 1)

## Decision
A 15-field EIP-712 struct binding identity, agent, chain, executor, target, value, `calldataHash`,
`intentHash`, `policyHash`, `authorizationId`, `contextCommitment`, `issuedAt`, `expiresAt`, `nonce`.

## Why `intentHash` and `calldataHash` are separate
The intent is the business meaning a human or policy approved. The calldata is what the EVM will
actually do. If only the intent were bound, an agent could preserve the story — "rebalance 500
USDC" — while changing the bytes. Binding both means the narrative and the transaction cannot
diverge.

## Why chain and executor appear twice
They are in the EIP-712 domain *and* in the struct. The redundancy is deliberate: a mistake in
domain construction cannot silently widen scope, because the struct check catches it independently.
Cheap, and it removes a whole class of subtle error.

## Why 15 fields rather than fewer
The struct exceeded the legacy compiler's stack limit in `hashStruct`. The options were to shrink a
security-relevant schema or enable `via_ir`. Shrinking the schema to satisfy a compiler limitation
would have weakened transaction binding, so the pipeline changed instead.

## Cross-language guarantee
16 golden vectors, recomputed independently by Solidity (`abi.encode` + `keccak256`) and TypeScript
(viem's `hashTypedData`). Neither calls the other — calling one from the other would only prove a
function returns its own result. All 16 digests are distinct, so every field is provably bound.
