# ContextLock Architecture

Engineer-readable reference. You should not need the PDF to understand the system.

## The problem

An AI agent that manages a treasury needs a key. A key is ambient authority: whoever holds it can
do anything the key can do. Spending caps in a wallet help, but they answer one question — *how
much* — and none of the others: *which agent*, *to whom*, *through what contract*, *under what
market conditions*, *is this still true right now*.

Prompt injection makes this acute. The agent's instructions come from data it reads, and that data
is attacker-controlled. Asking the model to refuse is not a security boundary, because the model is
the thing being attacked.

## The idea

Give the agent **authority, not keys**. Authority is a signed assertion that authorizes **one exact
transaction**, valid for a short window, revocable, and re-checked on-chain by a component the
agent cannot influence.

```
                       ┌──────────────────────┐
                       │   UNTRUSTED AGENT    │  proposes an intent
                       │   holds no key       │  may be fully compromised
                       └──────────┬───────────┘
                                  │ actionKind + typed params
                                  ▼
                       ┌──────────────────────┐
                       │  CONTEXTLOCK BROKER  │  builds exact calldata
                       │  advisory only       │  signs the capability
                       └──────────┬───────────┘
                                  │
            ┌─────────────────────┼─────────────────────┐
            ▼                     ▼                     ▼
      ┌───────────┐        ┌────────────┐        ┌────────────┐
      │  ENSv2    │        │ CHAINLINK  │        │  LEDGER    │
      │  WHO      │        │ CRE        │        │  SECRETS + │
      │           │        │ WHETHER    │        │  HUMAN     │
      │           │        │ NOW        │        │  GATE      │
      └─────┬─────┘        └──────┬─────┘        └──────┬─────┘
            │                     │                     │
            └─────────────────────┼─────────────────────┘
                                  ▼
                    ALLOW      ESCALATE      DENY
                      │            │           │
                      │            ▼           ▼
                      │      human approval  terminal
                      │            │        (no path)
                      └────────────┘
                                  ▼
                    ┌──────────────────────────┐
                    │   EIP-712 CAPABILITY     │  one tx · one nonce · short expiry
                    └────────────┬─────────────┘
                                 ▼
                    ┌──────────────────────────┐
                    │  CONTEXTLOCK EXECUTOR    │  the reference monitor
                    │  re-checks EVERYTHING    │  fails closed
                    └────────────┬─────────────┘
                                 ▼
                           EXACT ACTION
```

## Why three sponsors, and not decoration

Each answers a question the others cannot.

| | Question | Why it must be external |
|---|---|---|
| **ENSv2** | *Which agent is this, and is that still true?* | Identity must be revocable by someone other than the agent. ENS gives a human-readable, hierarchical name whose **owner** can revoke it, and whose revocation the executor observes at execution time. |
| **Chainlink CRE** | *Is this action safe right now?* | Risk thresholds are commercially sensitive and market context changes between issuance and execution. A confidential workflow evaluates private parameters the broker never sees. |
| **Ledger** | *Does a human accept this specific risk?* | Some actions should not be autonomous at all. And a broker credential should never be reachable by the agent that triggers its use. |

## Components

### `ContextLockExecutor` — the reference monitor
The only contract that can turn a capability into a call. Deliberately boring. Nine ordered
validation groups, **all before any external interaction**:

1. schema version
2. chain and executor binding (in the domain *and* the struct — redundancy is deliberate)
3. time window: expiry, clock skew, maximum lifetime
4. nonce unused
5. exact transaction: `keccak256(callData)` and `msg.value`
6. issuer signature (EOA or ERC-1271), malleability rejected
7. **live ENS identity**
8. live public policy: enabled, target, action, hard cap
9. **fresh CRE authorization** bound to a recomputed request hash; ESCALATE additionally requires
   a human approval

Then, and only then: mark the nonce, consume any approval, make the call.

### `ContextLockPolicyRegistry` — public financial authority
Which identity may do what, to whom, up to how much. **Deliberately not in ENS**: ENSv2 EAC roles
are per-contract and the stock registry's roles are all name administration. None of them means
"may spend". ENS supplies identity and revocation; ContextLock supplies spend authority.

### `EnsAgentIdentityVerifier` — makes ENS load-bearing
Reads live ENSv2 state at execution. The identity hash commits to registry, labelId, **name owner**,
agent, **token id** and binding version.

Committing to the token id is the interesting part: ENSv2 regenerates it on `grantRoles` /
`revokeRoles`. So an **ENS permission change is itself an identity change**, and revoking a role
kills outstanding authority without ContextLock needing to understand which role changed.

Uses `ownerOf`, never `latestOwnerOf` — the latter keeps returning the historical owner past expiry
and would make an expired name look valid forever.

### `ContextLockGateway` + `ContextLockCreConsumer` — the CRE boundary
The gateway emits `CapabilityRequested` with **full calldata**, so the workflow decodes the real
action rather than trusting a declared amount. The consumer is the only address permitted to write
an authorization, and it **derives** the authorization id rather than accepting one.

### `ContextLockApprovalRegistry` — the human gate
Approvals are EIP-712 signatures over a **capability digest**, which already commits to all fifteen
capability fields. Approving a digest therefore approves exactly one transaction; any mutation
produces a different digest and the approval no longer applies. Single-use, independently expiring,
`onlyExecutor` consumption.

### The confidential workflow
`cre.handlerInTee` on an EVM log trigger. Fetches the private policy and a risk credential via
`runtime.getSecret`, calls a context endpoint **from inside the enclave**, evaluates a deterministic
decision, and crosses back through `usingTheDons()` with only a verdict, reason code, band and
commitments.

**The workflow's source and binary are not secret** — current CRE docs are explicit that the
Workflow DON provides the binary to the enclave. Only the *data* is confidential. ContextLock never
claims otherwise.

## The capability

```solidity
struct Capability {
    uint8   version;              bytes32 agentIdentityHash;
    address agent;                uint256 chainId;
    address executor;             address target;
    uint256 value;                bytes32 calldataHash;
    bytes32 intentHash;           bytes32 policyHash;
    bytes32 authorizationId;      bytes32 contextCommitment;
    uint64  issuedAt;             uint64  expiresAt;
    uint256 nonce;
}
```

**`intentHash` and `calldataHash` are separate on purpose.** The intent is what a human approved;
the calldata is what the EVM will do. Binding only the intent would let an agent preserve the story
while changing the transaction.

### `EvaluationRequest` — what CRE actually rules on

Covers agent identity, agent, chain, executor, target, value, calldataHash, intentHash, policyHash —
but **not** nonce, expiry, authorizationId or contextCommitment. Those describe a *capability*
issued against an approved request, not the request itself.

The executor recomputes this hash from the capability it is asked to execute and compares it to the
stored authorization. An ALLOW granted for one transaction can therefore never be spent on another.

## Two things that are easy to get wrong

**Replay protection.** EIP-712 explicitly does not provide it. ContextLock supplies an on-chain
nonce, an expiry, and live-state checks. A capability with an unused nonce can still be invalid
because it expired, its identity was revoked, its policy was disabled, or its authorization went
stale.

**Nonce semantics.** The nonce is marked used *before* the external call, which defeats reentrancy
within a successful transaction. But if the target reverts, the whole transaction reverts and that
consumption rolls back with it. So a nonce is consumed **on success, not on attempt**. This is
documented (FND-005) and tested rather than claimed away.

## Failure model

Every failure reduces authority.

| Failure | Result |
|---|---|
| ENS unresolvable | no issuance, no execution |
| CRE authorization missing or stale | no execution |
| Database unavailable | no issuance (never untracked authority) |
| Key Ring unreachable | protected action fails; **no plaintext fallback** |
| Ledger unavailable | ESCALATE waits; ALLOW is unaffected |
| RPC outage | typed operational failure, never a policy denial |

The last row matters: an outage must never be recorded as a decision. `503 FAILED` and
`200 DENIED` are different answers.

## What this does not do

Does not solve prompt injection · does not validate economic wisdom (a permitted swap can still be
a bad swap) · does not defend a compromised owner key · does not provide cross-chain authority ·
does not claim MEV protection.
