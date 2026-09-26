# Security

ContextLock is a **testnet research MVP** built for ETHOnline 2026. It has **not been audited**.
Do not use it with real funds.

## The one-sentence claim

> The agent can be compromised without the wallet being compromised.

ContextLock does **not** prevent prompt injection. It limits the financial authority available
*after* injection succeeds.

## Threat model

### Assumed hostile
- **The AI agent.** Fully controllable by an attacker. Holds no key and no standing authority.
- **The relayer.** May withhold, reorder, replay or front-run. `msg.sender` confers nothing.
- **Target contracts.** Allowlisted, but not trusted to behave — may revert, re-enter, burn gas
  or return garbage.
- **The RPC provider.** May fail, rate-limit, or lie.
- **All API input.** Malformed, oversized, hostile.

### Assumed honest (and why that is a real limitation)
- **The capability issuer key.** A hot key in this MVP. Compromise lets an attacker mint
  capabilities — but they still cannot bypass ENS identity, public policy, or the CRE
  authorization. Blast radius is bounded, not zero. Production wants HSM / threshold / ERC-1271.
- **The policy admin.** Can widen policy. Cannot mint authority: `POL-ATK-008` demonstrates that
  a compromised admin still cannot execute without a live CRE authorization.
- **The registry owners.** Can rotate the authorization writer and the approver. This is a
  governance key and its compromise is out of scope for the MVP.
- **The Ethereum chain and its consensus.**

## Protected assets
Treasury funds · the capability-issuer signing key · Ledger-protected broker credentials ·
private policy parameters · ENS administrative authority · the integrity of the audit trail.

## Invariants

These are enforced by the executor and covered by tests. If any can be violated, that is a
vulnerability.

1. A capability authorizes **exactly one transaction** — target, value and `keccak256(calldata)`
   are all bound.
2. **EIP-712 provides no replay protection.** ContextLock supplies an explicit nonce, expiry, and
   live-state checks.
3. A capability is valid only for **one chain and one executor** — bound in both the domain and
   the struct.
4. **Live ENS identity is checked at execution**, not at issuance. A revoked, expired or rebound
   name kills an already-signed, unexpired capability.
5. A **CRE authorization** must exist for the exact request, carry the required verdict, and be
   unexpired.
6. **ESCALATE is not ALLOW.** It requires a human approval bound to the capability digest.
7. **DENY is terminal.** No approval, ordering, or human action makes a denied request executable.
8. **Failure reduces authority.** Every outage, timeout and malformed input fails closed.
9. The agent **cannot obtain any key or secret** — enforced by interface shape, not by refusal.

## Known limitations

| Limitation | Status |
|---|---|
| Not audited | acknowledged |
| Testnet only; every deploy script asserts `chainId == 11155111` | by design |
| Capability issuer is a hot key | accepted, bounded blast radius |
| No emergency pause, no issuer rotation on the executor | known gap |
| Nonce consumption rolls back if the target reverts | FND-005, accepted |
| CRE runs in the **official simulator**, not a live DON or real enclave | `docs/CRE_MODE_BASELINE.md` |
| **No Ledger hardware evidence** — Key Ring never provisioned, no device approval | BLK-002 |
| ENSv2 and CRE Confidential Workflows are both beta | version-pinned, isolated |
| Audit log is not tamper-evident | production gap |
| Broker API has no operator authentication | testnet demo surface |
| Only the zero address is rejected as a burn destination | FND-014 residual |

## What we deliberately do not claim

- That anything ran inside a real TEE. It did not.
- That a physical Ledger approved anything. None was available.
- That Clear Signing was rendered on a device. It was not.
- That prompt injection is solved. It is not — only its financial consequences are bounded.

## Reporting a vulnerability

This is a hackathon project with no production deployment. If you find something:

1. Open a GitHub issue for anything affecting the testnet deployment or the code.
2. For something you believe would be serious in a production adaptation, please describe the
   **class** of issue rather than publishing a working exploit.

There is no bug bounty, and no production system is at risk.

## Verifying the claims yourself

```bash
npm run test:all                    # every non-hardware suite, including the red-team gauntlet
npm run privilege-audit             # proves the agent cannot reach a privileged credential
npm run demo:all                    # six live Sepolia scenes; five are attacks
npm run demo:cre-private-context    # same transaction, different verdict, from private context
```

Every finding, including accepted risks, is in `reports/`. Nothing was closed to make the status
look better.
