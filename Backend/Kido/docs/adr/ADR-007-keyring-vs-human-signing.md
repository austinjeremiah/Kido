# ADR-007 — Key Ring and device signing are separate mechanisms

- **Status:** ACCEPTED · **Date:** 2026-09-06 (Phases 6/7)

## Context
The Ledger track mentions both protected secrets and human-in-the-loop approval in one breath. They
are easy to conflate, and conflating them produces a weaker system.

## Decision
Two independent modules, two independent phases, two independent test suites.

| | Problem solved | Mechanism |
|---|---|---|
| **Key Ring** (`packages/ledger/src/key-ring.ts`) | a broker credential must not be reachable by the agent | device-provisioned remote key service; headless decrypt |
| **Device signing** (`ContextLockApprovalRegistry` + DMK) | a human must accept a specific elevated action | EIP-712 signature over a capability digest |

## Why keeping them apart matters
They fail differently and are needed at different times. Key Ring is used on the **ALLOW** path,
where no human is involved at all. Device signing is used only on **ESCALATE**. A design that
merged them would either put a human in every transaction — defeating autonomy — or let a decrypt
capability stand in for human consent.

## Interface consequences
`SecretProvider` exposes `performProtectedAction`, never `getSecret`. The agent can cause an
authenticated call; it cannot obtain the credential. That asymmetry is enforced by the shape of the
interface rather than by a check that could be bypassed.
