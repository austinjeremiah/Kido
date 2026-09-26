# Project descriptions (P10.6)

Copy-ready text for submission fields. Every version carries the limitations, because a description
that omits them is not a shorter description — it is a different, false one.

---

## Tagline (≤ 80 chars)

```
Capability firewall for autonomous finance: give AI agents authority, not keys.
```

*(79 characters)*

---

## Short description (≤ 280 chars)

```
AI agents managing money need a key — and a key is ambient authority. ContextLock replaces it
with a capability: one signed transaction, short expiry, revocable, re-checked on-chain. ENS is
identity and revocation; a Chainlink confidential workflow decides ALLOW/ESCALATE/DENY.
```

*(277 characters)*

---

## Elevator version (~100 words)

```
ContextLock is a capability firewall for autonomous finance. It assumes the AI agent is already
compromised, so the agent never holds a key — it receives a capability authorizing exactly one
transaction, for a short window, revocable at any time.

An on-chain reference monitor re-checks everything: live ENSv2 identity, a Chainlink confidential
workflow's ALLOW/ESCALATE/DENY verdict, the nonce, the expiry, and the calldata hash. Revoking the
agent's ENS role kills capabilities that are already signed and not yet expired — something a
spending cap cannot do. DENY is structurally terminal: no human approval can override it.
```

---

## Full description

```
THE PROBLEM

To let an AI agent manage a treasury you give it a key, and a key is ambient authority: whoever
holds it can do anything it can do. A spending cap answers one question — how much — and none of
the others: which agent, to whom, through what contract, under what market conditions, and is the
approval that authorized this still valid right now?

Prompt injection makes this urgent. The agent's instructions arrive inside the data it reads, and
that data is attacker-controlled. Asking the model to refuse is not a boundary, because the model
is the thing under attack.

WHAT CONTEXTLOCK DOES

ContextLock replaces the key with a capability: an EIP-712 assertion authorizing exactly one
transaction, for a short window, revocable, and re-checked on-chain by a component the agent cannot
influence.

The agent proposes an intent. It holds no key and never submits a transaction. Three independent
authorities answer three different questions — ENS: who is this agent, and is that still true? A
Chainlink confidential workflow: is this safe right now, under private thresholds? Ledger: holds
secrets the agent cannot reach and gates the high-risk path behind a human.

The result is one of three verdicts, not two. ALLOW executes autonomously. ESCALATE requires a
recorded human approval. DENY is structurally terminal — there is no path from DENY to execution.

The executor is a reference monitor: nine ordered validation groups run before any external call,
and it re-checks all three answers itself rather than trusting what it was handed.

WHAT IS DEMONSTRABLE

Revocation kills outstanding authority. A correctly signed, unexpired capability stops working the
moment the agent's ENSv2 role is revoked, because the token id regenerates and the identity hash no
longer matches. Live on Sepolia.

Confidentiality is falsifiable, not asserted. One Sepolia transaction — same amount, agent, target,
policy version — produces ALLOW, ESCALATE, DENY_SLIPPAGE and DENY_LIQUIDITY depending only on
confidential market context inside the workflow. Nothing publicly observable changes; the verdict
does. One command reproduces it.

Human approval cannot override policy. A genuine, valid approval was recorded on Sepolia for a
DENIED capability, and execution was still refused — the approval was not even read.

Six of nine security properties are inexpressible rather than refused. There is no request the
agent can construct that reaches the question. The secret broker has performProtectedAction and no
getSecret at all.

WHAT IS NOT TRUE

ENS is live on Sepolia and load-bearing.

Chainlink ran in the official CRE CLI simulator, triggered by real Sepolia events. This is NOT a
live DON deployment and nothing ran in a real TEE. Confidential Workflows live access is
invite-only private beta.

Ledger integration is software-complete and tested, but no physical device was available. No Key
Ring was provisioned, no human approved on hardware, and no ERC-7730 descriptor was rendered on a
device screen. The Ledger prize is not claimed. The hardware test suite fails loudly rather than
skipping or mocking.

Nothing is audited. Sepolia testnet only, asserted in code.

266 tests pass. 18 findings are recorded, including four accepted risks and two that remain open.
None was closed to make the status look better.
```

---

## "How it's made" (technical)

```
Solidity 0.8.28 (cancun, via_ir) with Foundry. TypeScript across npm workspaces, with the CRE
workflow as a separate bun project.

The capability is a 15-field EIP-712 struct. It needed via_ir to compile — the alternative was
shrinking a security-relevant schema, which was not acceptable. EIP-712 provides no replay
protection on its own; that comes from an on-chain nonce, an independent approvedUntil, and
live-state re-reads at execution time.

The decision function has exactly ONE implementation. packages/policy/src/index.ts is compiled into
the Chainlink confidential workflow and imported by the broker — the CRE project reaches it through
a symlink. The workflow and the broker cannot disagree about policy because there is nothing to
disagree with.

The capability schema is implemented a SECOND time, independently, in TypeScript
(packages/protocol), and 16 golden vectors assert it agrees with the Solidity. A bug would have to
be made twice, in two languages, identically.

ENS identity is read live at execution — never cached — using ownerOf rather than latestOwnerOf.
Revoking a role regenerates the name's token id, which changes the identity hash, which invalidates
outstanding capabilities. That mechanism was found only after discovering the name owner lacks
ROLE_UNREGISTER, and it is stronger than what was originally planned.

The agent package declares exactly one dependency: viem. It cannot import a signer, cannot reach
broker internals, and references no privileged environment variable. A privilege audit enforces
this in CI, and the audit is verified against a planted canary before any pass is accepted.

Testing: 266 passing across Foundry (fuzz, invariant, golden-vector, red-team), vitest and bun.
Four security scanners — secret, confidential-canary, privilege, npm audit — each proven able to
fail on demand. Two real defects were found by fuzzing and dependency auditing that no hand-written
test would have caught, and two scanner defects were found by running the suite from a clean clone.
```
