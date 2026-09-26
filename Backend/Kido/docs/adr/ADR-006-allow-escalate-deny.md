# ADR-006 — Three verdicts, not two

- **Status:** ACCEPTED · **Date:** 2026-09-06 (Phase 4)

## Decision
`ALLOW` · `ESCALATE` · `DENY`, enforced on-chain.

## Why binary is insufficient
A binary policy forces every threshold to be a cliff. Either the limit is low, and the agent cannot
do useful work autonomously; or it is high, and a compromised agent gets a large budget. ESCALATE
lets the autonomous limit stay genuinely low while keeping larger actions *possible* — with a human
accepting the specific risk.

## The property that matters most
**DENY is terminal.** It is not "ESCALATE with more friction". There is no ordering of calls, and
no human approval, that makes a denied request executable. The approval check lives inside the
`if (verdict == ESCALATE)` branch, and the request state machine gives `DENIED` an empty transition
set — a breadth-first search from it reaches nothing.

Proven live: a genuinely valid human approval was recorded on Sepolia for a DENIED capability, and
execution was still refused. The approval was not even consumed, because the code never reached it.

## Reason codes
Coarse and public (`ESCALATE_AMOUNT`, `DENY_SLIPPAGE`). They never carry a threshold value — a
compromised agent must not be able to binary-search the private limits.
