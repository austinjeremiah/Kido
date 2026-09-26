# ADR-008 — "Simulator" and "live" are different words and stay different

- **Status:** ACCEPTED · **Date:** 2026-09-07 (Phase 4)

## Context
CRE has several distinct states, and blurring them is the single easiest way to overstate this
project.

## Decision
Four labels, used consistently in code, persisted data, and reports:

| Label | Meaning |
|---|---|
| `stub` | a Phase 2 deterministic double; no policy meaning |
| `cre-workflow-local` | the real policy module, run in the broker process — **not** confidential, **not** attested |
| `cre-simulator` | output of the official `cre workflow simulate` |
| `cre-live` | a DON-signed report produced inside an attested enclave |

`EvaluationResult.source` carries one of these. `docs/CRE_MODE_BASELINE.md` is the authority; any
document disagreeing with it is a bug.

## Current state
```
CRE_MODE=official-cli-simulator
REAL_TEE_EXECUTION=NO
OFFICIAL_CLI_SIMULATION=YES
LIVE_CRE_DEPLOYMENT=NO
```

## Why this needed a decision
When the CLI was blocked, the honest label was `sdk-local-tests` — neither live nor simulator. It
would have been easy to call that "simulated" and claim the prize criterion. Instead the gap was
recorded as an open blocker, and the handoff stated plainly that the criterion was **not** met.

When the operator ran `cre login`, the label changed to `simulator` **because the situation
changed**, not because the standard moved.

Registration of a TEE handler is not execution in one. The simulator itself prints *"The simulator
is not a real TEE."* We repeat that rather than paraphrasing it away.
