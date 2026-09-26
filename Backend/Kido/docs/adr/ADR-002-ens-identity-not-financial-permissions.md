# ADR-002 — ENS carries identity and revocation, not financial permissions

- **Status:** ACCEPTED · **Date:** 2026-09-06 (Phase 3) · **Evidence:** FND-003

## Context
The obvious design is to put spend permissions in ENS: the name already represents the agent, and
ENSv2 has Enhanced Access Control. Doing that would be wrong, and the docs say so.

## Decision
ENS supplies **identity and revocation**. `ContextLockPolicyRegistry` supplies **spend authority**.

## Why
EAC is a per-contract framework — *"Each ENSv2 contract defines its own roles and its own resource
scheme."* The stock `PermissionedRegistry` defines ten roles, verified live: `ROLE_REGISTRAR`,
`ROLE_REGISTER_RESERVED`, `ROLE_SET_PARENT`, `ROLE_UNREGISTER`, `ROLE_RENEW`,
`ROLE_SET_SUBREGISTRY`, `ROLE_SET_RESOLVER`, `ROLE_CAN_TRANSFER_ADMIN`, `ROLE_SET_URI`,
`ROLE_UPGRADE`.

**None of them means "may spend."** Inventing a `SWAP_ROLE` and passing it to the stock registry
would produce a value the registry ignores — a permission that looks enforced and is not.

## Consequence, and why it is a feature
The identity hash commits to the ENS **token id**, which ENSv2 regenerates on `grantRoles` /
`revokeRoles`. So an ENS **permission change is an identity change**, and revoking a role kills
outstanding financial authority — without ContextLock ever pretending ENS understands money.

That is a stronger integration than a fake role would have been: EAC genuinely drives
authorization, through the mechanism it actually has.
