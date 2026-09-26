# Sponsor prize qualification

**ETHOnline 2026 · ContextLock**

What each sponsor technology actually does in this project, where the code is, and what evidence
exists. Written to be checked, not believed: every claim below names a file or a Sepolia
transaction hash.

**Read this first:** two of the three integrations carry a stated limitation, and both appear
before the claims rather than after them.

| Sponsor | Claim strength | Limitation stated up front |
|---|---|---|
| **ENS** | Full — live and load-bearing | none |
| **Chainlink CRE** | Qualified — official CLI simulator | no TEE execution, no live DON deployment |
| **Ledger** | **Not claimed** | no physical device existed (BLK-002) |

---

## 1. ENS — live, and the project does not work without it

### What it does here

ENS is not a label on this project. It is the **identity and revocation** substrate, and it is the
only mechanism by which an already-signed, still-unexpired capability can be killed.

The executor calls `EnsAgentIdentityVerifier` **during execution**, reads the registry live, and
compares the result to the identity hash bound into the capability at issuance. Nothing is cached.
When the agent's ENSv2 role is revoked, the name's token id regenerates, the identity hash changes,
and every outstanding capability naming the old identity becomes unusable in the same block.

That property — *revocation invalidates outstanding authority* — is the one a spending cap cannot
give you.

### Where

| | |
|---|---|
| On-chain verifier | `contracts/src/identity/EnsAgentIdentityVerifier.sol` |
| Live provider | `apps/broker/src/providers/ens-live.ts` |
| Deployment discovery | `packages/ens/src/deployments.ts` |
| Fork tests | `contracts/test/EnsForkIdentity.t.sol` |
| Live tests | `apps/broker/test/ens-live.test.ts` (5 tests, real Sepolia reads) |

### Evidence

| | |
|---|---|
| Name | `contextlock-20260906-a83dc9.eth` (ENSv2, Sepolia) |
| Registered until | 2027-09-06 |
| Registration tx | `0xbf1eb7294b45fa48ca7fb30ac24f7d540716d23f91fa977ea42245e87eb09705` |
| Identity bind tx | `0x6d36603d6682ae229c0c65a4a419e37c2a79cea03fc484bbbb29fdbdd7b348a5` |
| Verifier | `0xbD44B9A7491A3168F772Ca96433c17a0B18a6149` |
| **Revocation demo** | `0x32d72d1394217f9a033fef1c74a1fb4cea13f59dcaf58d81af5115da1bbf15bc` |

The revocation scene is the one worth running (`npm run demo:ens-revoke`): a capability that is
**correctly signed and not expired** is refused with `IdentityNotCurrent` because the ENS state it
depended on changed after it was issued.

### Honest notes

- Registered on a **fresh test namespace**. No personal or pre-existing ENS name was used or
  modified.
- **FND-008 (HIGH):** three different ENSv2 Sepolia deployments are live and disagree. The one used
  here was selected by probing migrated-name occupancy, and the rejected alternates are recorded in
  `packages/ens/src/deployments.ts` rather than discarded.
- **FND-009:** the stock `PermissionedRegistry` has ten roles, **none financial**, and the name
  owner does not hold `ROLE_UNREGISTER`. Role revocation was used instead — a better lever, because
  it regenerates the token id.
- ENSv2 is **beta**. Not audited.

---

## 2. Chainlink CRE — a real confidential workflow, evidenced in the official simulator

### What it does here

The ALLOW / ESCALATE / DENY decision is made by a `cre.handlerInTee` confidential workflow that
reads private policy thresholds through `runtime.getSecret` and never emits them. The chain
receives a **verdict and a coarse reason code** — never a threshold, never a market input.

The single most useful piece of evidence in this project is that the confidentiality is
*demonstrable* rather than asserted:

> **The same Sepolia transaction produces four different verdicts.**
>
> Transaction `0x62753fddb9c92d2ff9989c430e2ca47224f992ac3243eb77bea05eda21679843` — identical
> amount, agent, target, policy id and policy version in every scene. Only the confidential market
> context differs.
>
> | Private context | Verdict |
> |---|---|
> | benign | `ALLOW:ALLOW_POLICY_MATCH:LOW` |
> | volatility 5000bps | `ESCALATE:ESCALATE_RISK:HIGH` |
> | slippage 900bps | `DENY:DENY_SLIPPAGE:HIGH` |
> | liquidity floor breached | `DENY:DENY_LIQUIDITY:HIGH` |
>
> Nothing publicly observable changed. The verdict did. The decision therefore depends on data only
> the confidential handler reads. Reproduce: `npm run demo:cre-private-context`.

A confidentiality claim you can only take on trust is not a security property. This one can be
falsified by anyone in one command.

### Where

| | |
|---|---|
| Confidential workflow | `workflows/cre-policy/contextlock-policy/workflow.ts` |
| Official CRE project | `workflows/cre-policy/contextlock-cre/` |
| Decision function | `packages/policy/src/index.ts` |
| On-chain consumer | `contracts/src/ContextLockCreConsumer.sol` |
| Tests | 41 (`bun test`), incl. `redteam.test.ts` |

`contextlock-cre/policy/policy.ts` is a **symlink** to `packages/policy/src/index.ts`. There is one
implementation of the decision function, compiled into the workflow and imported by the broker. The
two cannot drift.

### Evidence

| | |
|---|---|
| CRE CLI | v1.32.0 · SDK 1.19.1 |
| Mode | `official-cli-simulator` |
| Workflow binary hash | `800d0d561132d79476981e6297979ff51a18372b23bd8b0a0e891f32d10800e0` |
| Trigger | real `CapabilityRequested` events on Sepolia |
| Consumer | `0x0eAA86cDA5622A8384c3eC9F47aD129902A8123F` |
| Canary scan | CONF-001 PASS — no confidential value in code, history, artifacts, database, logs or stdout |

### What is **not** claimed

Stated as flatly as possible, because this is where a submission is most tempted to blur:

| | |
|---|---|
| Ran in a TEE | **No.** Nothing executed in an AWS Nitro enclave. |
| Deployed to CRE | **No.** `cre whoami` reports `Deploy Access: Not enabled`. |
| DON-signed report | **No.** |
| Vault DON released secrets | **No.** |
| Official CLI simulation | **Yes** — `cre workflow simulate`, 5 scenes, real Sepolia triggers. |

The simulator prints its own disclaimer — that it is not a real TEE and is meant for debugging —
and that disclaimer is reproduced in `docs/CRE_MODE_BASELINE.md`, which is the authoritative file.
Registering a TEE handler is not executing in one, and this project does not describe it as such
anywhere.

**FND-001 (ACCEPTED_RISK):** CRE Confidential Workflows live access is invite-only private beta.
The simulator is the highest-fidelity path available without an invitation.

### Honest notes

- **FND-012** was a genuine catch: the EVM log trigger delivers a raw protobuf `Log`, not a decoded
  struct. The workflow had assumed the latter and **would have failed identically on the live
  network**. Two permanent regression tests exist so it cannot return.
- **FND-013:** the RPC's `eth_getLogs` 10-block cap silently returned empty results; events are now
  addressed by transaction hash.

---

## 3. Ledger — software complete, hardware evidence absent

### The claim

**None.** Ledger prize qualification is **not claimed**, and this section exists to say so
precisely rather than to imply otherwise at length.

**BLK-002 is OPEN.** No physical Ledger device was available at any point. Therefore:

| | |
|---|---|
| Key Ring provisioned on a device | **No** |
| A human approved anything on hardware | **No** |
| Clear Signing rendered on a device screen | **No** |

`npm run test:ledger:hardware` **fails loudly** with BLK-002. It does not skip, and it does not
mock. No hardware-mocked test is labelled as hardware evidence anywhere in this repository.

### What does exist

The integration software is complete and tested, and the on-chain boundary it protects is proven
live — with a **stand-in key** substituting for the device, labelled `STAND-IN — NOT LEDGER-HELD`
in the deployment manifest, the demo output and the UI.

| | |
|---|---|
| Key Ring / secret broker | `packages/ledger/src/key-ring.ts`, `secret-provider.ts` |
| Protected-service boundary | `packages/ledger/src/protected-service.ts` |
| ERC-7730 descriptor | `packages/ledger/erc7730/contextlock-approval.json` |
| Approval registry | `contracts/src/ContextLockApprovalRegistry.sol` |
| Tests | 24 passing, 1 skipped *(hardware-gated, reports SKIPPED)*, 16 `LED-H` contract tests |

The secret broker exposes **no getter**. There is `performProtectedAction`; there is no
`getSecret`. The agent cannot ask for the credential, so it cannot be tricked into leaking it —
the question is inexpressible rather than refused. The privilege audit enforces this.

### The result worth keeping regardless

**DEMO-C, live on Sepolia:** a genuine, valid human approval was recorded for a **DENIED**
capability, and execution was still refused with `AuthorizationNotAllow`. The approval was not even
read — the branch is unreachable from DENY.

| | |
|---|---|
| Approval recorded | `0xc3b7d55d4fc903a935fea084c297f57060674ba71dccb69fa66d961ff0f644da` |
| ALLOW, no approval on record | `0x6b0bc7cbc8df91ed666bea9c59b1c374dc8a366f091932b82d6a2395a4044861` |
| ESCALATE + approval → executed | `0x74b83bfb1b7a7dd81793029202754b36c14fcf0b2d85cb901883e19141148015` |

Human approval **escalates** autonomy. It cannot **override** policy. That boundary is a property
of the executor and holds whether the approving key lives on a device or not — which is why it is
reported here even though the Ledger claim is withdrawn.

### What would close BLK-002

One device, and roughly an hour: provision a Key Ring via `@ledgerhq/wallet-cli ring`, run
`npm run test:ledger:hardware`, and capture a device-screen photograph of the ERC-7730 descriptor
rendering the approval. The software is written and waiting; nothing else blocks it.

**FND-011:** `npx wallet-cli` installs an **unrelated third-party package** whose surface accepts a
raw private key. The scoped `@ledgerhq/wallet-cli` is required, and the code resolves an explicit
`cliPath` rather than trusting `PATH`.

---

## 4. Cross-cutting

### One decision function, two execution sites
`packages/policy/src/index.ts` is compiled into the CRE workflow *and* imported by the broker. A
divergence between "what the workflow decided" and "what the broker thought it decided" is not
possible, because there is only one implementation.

### Independent reimplementation, cross-verified
`packages/protocol/src/capability.ts` implements the EIP-712 capability schema **independently** of
the Solidity, and 16 golden vectors assert the two agree. A bug would have to be made twice, in two
languages, identically.

### Everything fails closed
An unreachable RPC, an unconfigured name, a missing authorization, an expired approval and a
mismatched digest all produce a **refusal**, never a permission. There is no default-allow path in
the executor.

### Testnet only, enforced in code
Every deployment and demo script asserts `chainId == 11155111` before acting. There is no mainnet
configuration to select by accident.

---

## 5. Where to verify

| | |
|---|---|
| Per-phase evidence | `reports/phase-00/` … `reports/phase-09/` |
| All findings, incl. accepted risks | `reports/**/findings/` |
| Open blockers | `reports/**/blockers/` |
| Authoritative CRE status | `docs/CRE_MODE_BASELINE.md` |
| Threat model | `SECURITY.md`, `docs/THREAT_SURFACE.md` |
| Evidence index | `docs/EVIDENCE_INDEX.md` |

Eighteen findings are recorded: **twelve fixed, four accepted risks, two open** (both external
documentation drift the project cannot close on its own). Two blockers were raised: **BLK-001
RESOLVED**, **BLK-002 OPEN**. None was closed to improve the appearance of the status.
