# ADR-005 — Revocation is checked at execution, not at issuance

- **Status:** ACCEPTED · **Date:** 2026-09-06 (Phase 3)

## Context
A signature cannot observe the future. A capability signed at T is still cryptographically valid at
T+10min, even if the agent was revoked at T+1min.

## Decision
The executor reads **live** ENS state and **live** policy state on every execution. No cache exists
anywhere in the path that could outlive a revocation.

## Consequence
"Revocation invalidates outstanding authority" is a real property, not a hope. Proven live: an
unexpired, correctly signed, never-used capability stops working the moment an ENS role is revoked.

## Cost
Extra storage reads and external calls per execution (~212k gas cold, ~72k warm), and a hard
dependency on ENS being readable. The latter is deliberate: if identity cannot be verified,
**nothing executes**. Availability is traded for the guarantee, in the direction that fails safe.

## What this does NOT give
Freshness of *market* context. A signature cannot re-observe the market either. That is handled
separately by a short CRE `approvedUntil` window — a materially stale authorization stops working
because the executor rejects it, not because the signature becomes invalid.
