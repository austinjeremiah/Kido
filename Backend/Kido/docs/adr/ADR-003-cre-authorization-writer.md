# ADR-003 — The authorization writer is a restricted contract, not an EOA

- **Status:** ACCEPTED · **Date:** 2026-09-06 (Phase 4)

## Context
Phases 1–2 used a trusted EOA to record verdicts, so the executor could be built before CRE
existed. That EOA was a standing ability to authorize any transaction.

## Decision
`ContextLockCreConsumer` becomes the registry's sole `authorizer`. It accepts reports only from a
configured forwarder and **derives** the authorization id as
`keccak256(requestHash, policyCommitment, evaluatedAt)`.

## Why derived, not supplied
If a caller could choose the id, two different requests could collide onto one authorization, or a
caller could target a slot it expected to be read later. Deriving it removes the choice.

## Trust model, stated plainly
The consumer enforces **provenance** (only the forwarder may call) and **shape** (the payload
decodes to a well-formed verdict). It does **not** re-verify DON signatures — in a live deployment
the Chainlink forwarder has already done that. Inventing a bespoke verification scheme here would
look like security while diverging from the pattern CRE actually uses.

**No live DON has written to this contract.** The forwarder is a configured stand-in, replaceable
via `setForwarder` without redeploying anything else.

## Alternatives rejected
- *Keep the EOA* — a standing mint capability held by one key.
- *Let the executor call CRE directly* — the executor must stay synchronous and boring.
- *Accept a caller-supplied authorization id* — see above.
