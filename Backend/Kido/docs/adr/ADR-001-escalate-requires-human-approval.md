# ADR-001 — The executor must consult a human-approval registry for ESCALATE

- **Status:** ACCEPTED
- **Date:** 2026-09-06 (Phase 7)
- **Supersedes:** the Phase 1–6 executor behaviour where any verdict other than ALLOW reverted

## Context

Through Phase 6 the executor implemented `verdict != ALLOW → revert AuthorizationNotAllow`. That
was correct for those phases: no human-approval mechanism existed, so ESCALATE genuinely had no
path to execution, and DEMO-007 proved it.

Phase 7 requires the three-state model to be complete:

```
ALLOW    → autonomous execution
ESCALATE → human Ledger approval, then execution
DENY     → impossible
```

The build rules forbid changing the executor "merely to accommodate" a sponsor, and require an ADR,
a compatibility analysis and a full P1–P3 regression when a change is unavoidable. This is that ADR.

## Why a change is genuinely required

Bible executor invariant 10 states: *"For ESCALATE, a valid human approval linked to this capability
must exist; the autonomous path cannot reinterpret ESCALATE as ALLOW."*

That invariant cannot be satisfied off-chain. The executor is the reference monitor — the only
component whose checks an attacker cannot skip. If human approval were enforced only in the broker,
a compromised broker could mint a capability against an ESCALATE authorization and the executor
would have no way to tell it apart from an approved one. The approval must be a fact the executor
itself verifies on-chain.

## Decision

Introduce `ContextLockApprovalRegistry` and give the executor one additional check, reached **only**
when the verdict is ESCALATE.

```
verdict == ALLOW    → execute, no approval consulted   (unchanged)
verdict == ESCALATE → require a live, unexpired, unconsumed approval
                      bound to THIS capability digest, signed by the configured approver
verdict == DENY     → revert, unconditionally           (unchanged)
verdict == NONE     → revert, unconditionally           (unchanged)
```

Key properties, each chosen against a specific attack:

1. **Approval is bound to the capability digest**, which already commits to agent identity, chain,
   executor, target, value, calldataHash, intentHash, policyHash, authorizationId,
   contextCommitment, issuedAt, expiresAt and nonce. So an approval authorizes exactly one
   transaction. Changing the amount, the recipient, the target, or any other field produces a
   different digest and the approval no longer applies. This is what makes human approval
   transaction-specific rather than a general "approve this agent" grant.

2. **DENY has no approval path.** The approval check is inside the ESCALATE branch only. There is
   no ordering of calls, and no approval, that makes a DENY executable. This mirrors the state
   machine, where `DENIED` is provably terminal.

3. **Approvals are one-shot.** Consumed on use, so an approval cannot be replayed for a second
   execution even if the nonce were somehow reusable.

4. **Approvals expire independently** of both the capability and the CRE authorization. Three
   independent clocks must all be live at execution time.

5. **Every other check still applies and still runs first.** ENS identity, policy state, CRE
   freshness, nonce, calldata binding and signature validation are unchanged and are evaluated
   before the approval is consulted. A human approval cannot rescue a revoked identity, a disabled
   policy, a stale authorization or mutated calldata.

## Compatibility analysis

| Concern | Assessment |
|---|---|
| ALLOW path behaviour | **Unchanged.** The approval registry is not consulted at all. |
| DENY path behaviour | **Unchanged.** Still reverts `AuthorizationNotAllow`. |
| ESCALATE path behaviour | **Changed by design** — previously always reverted; now reverts unless a valid bound approval exists. |
| `IContextLockAuthorizationRegistry` | Unchanged. |
| `IAgentIdentityVerifier` | Unchanged. |
| `IContextLockPolicyRegistry` | Unchanged. |
| Capability schema / EIP-712 digest | **Unchanged** — no new field. Golden vectors still valid. |
| Existing P1–P6 tests | All re-run. The one test asserting ESCALATE reverts still passes, because with no approval recorded the behaviour is identical. |
| Deployment | Requires a new executor (constructor takes the registry; state is immutable). Recorded in the manifest; the prior executor stays addressable for Phase 3–6 evidence. |

## Alternatives considered

**A. Enforce approval only in the broker.** Rejected: a compromised broker defeats it entirely, and
the executor exists precisely so broker compromise is survivable.

**B. Have the human's signature substitute for the issuer signature.** Rejected: it conflates two
different authorities. The issuer attests "this capability is well-formed and policy-checked"; the
human attests "I accept this specific elevated action". Collapsing them would mean a human approval
could stand in for a missing policy check.

**C. Encode approval into the CRE verdict — let the DON re-run and emit ALLOW after approval.**
Rejected: it would make ESCALATE indistinguishable from ALLOW on-chain, erasing the audit
distinction between "policy permitted this autonomously" and "a human accepted the risk". It also
adds a round trip that could not work while CRE is unavailable.

**D. Add an approval field to the Capability struct.** Rejected: it changes the EIP-712 schema,
invalidates the golden vectors, and would mean the digest depends on data that does not exist when
the capability is signed.

## Consequences

- A new executor deployment; the manifest records both addresses and which phases each backs.
- Three independent expiry clocks (capability, CRE authorization, approval) — more surface, but
  each is short-lived and each is tested.
- The approver address is configured at deployment. Rotating it requires redeployment, which is a
  limitation recorded in the Phase 7 report rather than solved here.
- The executor gains one external call in one branch. It remains a view-only read before any state
  change or external interaction.
