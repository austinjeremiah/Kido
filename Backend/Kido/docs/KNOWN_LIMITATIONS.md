# Known limitations

Complete and unflattering. Anything a reviewer could reasonably discover and feel misled by is here
before they find it.

Ordered by how much it should change your confidence, not by how easy it is to explain away.

---

## 1. No physical Ledger device was ever available (BLK-002, OPEN)

The single largest gap.

| | |
|---|---|
| Key Ring provisioned on hardware | **No** |
| A human approved anything on a device | **No** |
| ERC-7730 descriptor rendered on a device screen | **No** |

What exists is the integration software — complete, tested, and protecting an on-chain boundary
that *is* proven live — with a **stand-in key** in place of the device. That key is labelled
`STAND-IN — NOT LEDGER-HELD` in the deployment manifest, the demo output and the UI.

`npm run test:ledger:hardware` **fails with exit 1** and lists seven blocked tests. It does not
skip, and it does not mock. **The Ledger prize is not claimed.**

Closing it needs one device and about an hour. Nothing else blocks it.

## 2. Chainlink ran in the official CLI simulator, not on a live DON, and not in a TEE

| | |
|---|---|
| `OFFICIAL_CLI_SIMULATION` | **YES** — `cre workflow simulate`, CLI v1.32.0, 5 scenes, real Sepolia event triggers |
| `REAL_TEE_EXECUTION` | **NO** — nothing executed in an AWS Nitro enclave |
| `LIVE_CRE_DEPLOYMENT` | **NO** — `cre whoami` reports `Deploy Access: Not enabled` |

The simulator prints its own disclaimer that it is not a real TEE. Registering a TEE handler is not
executing in one. `docs/CRE_MODE_BASELINE.md` is authoritative; if any document, script or UI
disagrees with it, that document is a bug.

What the simulator *does* establish: the workflow logic is correct, it decodes real Sepolia event
data correctly, and its verdict depends on secrets it never emits. What it does **not** establish:
enclave attestation.

Live access to Confidential Workflows is invite-only private beta (FND-001, accepted risk).

## 3. Nothing is audited

No professional audit, no formal verification, no bug bounty. Both ENSv2 and CRE Confidential
Workflows are themselves **beta**.

This is hackathon software. It must not hold real funds.

## 4. The capability issuer is a hot key

The broker signs capabilities with a key held in the operating environment. It is inside the trust
boundary, and it is stated as such in `SECURITY.md`.

The blast radius is bounded — a stolen issuer key can only mint capabilities that survive the
executor's nine validation groups, which independently re-check ENS identity, the CRE verdict, the
nonce, the expiry and the calldata hash on-chain. It cannot mint authority the policy does not
already permit, and it cannot approve an escalation.

Bounded is not zero. An attacker with that key can issue arbitrary *policy-compliant* transactions,
which for a treasury means a steady drain within the autonomous limit.

## 5. No emergency pause and no issuer rotation on the executor

There is no circuit breaker. If the issuer key is compromised, the response is to revoke the
agent's ENS role — which does invalidate outstanding capabilities immediately — and redeploy.

That is a real operational gap, deliberately not papered over with a pause function added late and
untested. A pause is itself an authority, and adding one without designing its own access control
would have traded one problem for a worse one.

## 6. A nonce is consumed on success, not on attempt (FND-005, accepted)

If the target contract reverts, the capability's nonce is rolled back with the transaction and the
capability remains usable. This is intentional — a failed execution should not burn the user's
authority — but it means a capability can be retried, and a target that reverts non-deterministically
gives an attacker repeated attempts within the expiry window.

Mitigated by short expiries. Documented rather than fixed.

## 7. Two Slither High findings, design-inherent (FND-016, accepted)

Both concern external calls in the executor. They are inherent to what a reference monitor *is*: it
must call the target contract, and it must call the approval registry. They are documented with
reasoning rather than suppressed with annotations.

The triage did surface a real gap — a second external call added in Phase 7 that the reentrancy
test never covered. Coverage was added. Seven of twelve zero-value checks were also fixed; the
other five were false positives on values that cannot be zero by construction.

## 8. ContextLock validates permission, not economic wisdom

It answers "is this agent allowed to do this, right now, under this policy". It does not answer
"is this a good trade". A policy that permits a bad transaction will see that transaction execute,
correctly, as designed.

If the CRE workflow returns a wrong verdict, the executor faithfully enforces a wrong verdict.

## 9. Single relayer, no redundancy

One relayer address submits transactions. If it runs out of gas or is censored, nothing executes.
Fail-closed is the correct default for a security control, but it is still a liveness dependency
and there is no failover.

## 10. The policy admin is trusted

Policy mutators are `onlyAdmin`. A malicious or compromised policy admin can widen limits and make
a hostile transaction policy-compliant. The admin key is inside the trust boundary and is named as
such in the threat model — it is not defended against, and no on-chain timelock or multisig guards
it in this build.

## 11. Scope is deliberately narrow

- **Sepolia only.** Every deploy and demo script asserts `chainId == 11155111`. There is no mainnet
  configuration to select by accident.
- **One action kind** (`MOCK_TRANSFER`) against a mock treasury target. The adapter layer is typed
  and there is deliberately **no** generic-call adapter — adding one would reintroduce exactly the
  ambient authority the project removes.
- **One agent identity.** Multi-agent policy composition is not implemented.
- No gas-price policy, no MEV protection, no batching.

## 12. Two findings remain open and cannot be closed here

| | |
|---|---|
| **FND-002** | Ledger Key Ring documentation drift regarding network dependency — an upstream documentation issue. |
| **FND-004** | The Chainlink challenge configuration referenced dated/closed material. |

Both are external. Both are recorded rather than quietly dropped because they affected build
decisions.

## 13. Scanner coverage is a tripwire, not a proof

The privilege audit's check [6] is a **name-occurrence** check with a path allowlist, not dataflow
analysis. A new file under an already-allowed path could read a privileged variable inappropriately
without [6] objecting. The controls that actually enforce the agent boundary are checks [1]–[5] and
[7], which target the agent's reachable surface directly.

Stated because two scanners in this project were reported CLEAN while failing (FND-017, FND-018),
and the correction matters more than the reassurance. They were caught by running the suite from a
clean clone — not by reading the code.

## 14. Test coverage has honest edges

- **7 of 266 tests are network-gated** and skip without `SEPOLIA_RPC_URL`. They report SKIPPED,
  never PASSED, and are named individually in the runner output.
- **1 test is hardware-gated** and reports SKIPPED (BLK-002).
- The 18-intent prompt-injection corpus is representative, not exhaustive. It cannot be — the
  space is open-ended, which is precisely the argument for a structural boundary rather than a
  model-based one.
